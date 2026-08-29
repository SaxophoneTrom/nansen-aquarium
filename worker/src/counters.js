import { DurableObject } from 'cloudflare:workers';

/**
 * The one place that knows how much has been spent today.
 *
 * Per-IP daily counts and the global daily budget both live in a single Durable
 * Object instance (`idFromName("global")`), so every increment is serialized and
 * the budget is exact. KV would be cheaper to reach but is eventually
 * consistent, and "eventually" is not a property you want in a spend limit — a
 * burst from twenty colocations would each read the same stale number and every
 * one of them would think there was room left.
 *
 * Storage is SQLite-backed (`new_sqlite_classes` in wrangler.jsonc). That is not
 * a preference: the Workers free plan only allows SQLite Durable Objects.
 */
export class CountersDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS counts ('
      + ' day TEXT NOT NULL,'
      + ' key TEXT NOT NULL,'
      + ' n INTEGER NOT NULL,'
      + ' PRIMARY KEY (day, key)'
      + ')',
    );
    this.lastDay = null;
  }

  /**
   * Check both quotas and, only if both have room, spend one unit of each.
   *
   * The two checks have to happen together and in this order. A visitor who has
   * used up their own daily allowance must not also burn a slot of the global
   * budget on the way to being refused — otherwise one determined user could
   * exhaust the nursery for everybody while never getting a fish themselves.
   * And when the budget is gone, nothing is charged at all: no credit was spent,
   * so no counter moves.
   *
   * @param {{ ip: string, ipLimit: number, budgetLimit: number }} args
   * @returns {{ ok: true } | { ok: false, reason: 'ip_daily' | 'budget' }}
   */
  charge({ ip, ipLimit, budgetLimit }) {
    // UTC day is decided here rather than by the caller: one clock, one boundary,
    // no chance of two edge locations disagreeing about which day it is.
    const day = new Date().toISOString().slice(0, 10);

    // Opportunistic sweep — only on the first call of a new day, which this
    // object notices in memory. A cold start repeats it once; that is fine.
    if (this.lastDay !== day) {
      this.sql.exec('DELETE FROM counts WHERE day <> ?', day);
      this.lastDay = day;
    }

    const ipKey = `ip:${ip}`;
    if (this.#read(day, ipKey) >= ipLimit) return { ok: false, reason: 'ip_daily' };
    if (this.#read(day, 'budget') >= budgetLimit) return { ok: false, reason: 'budget' };

    this.#bump(day, ipKey);
    this.#bump(day, 'budget');
    return { ok: true };
  }

  #read(day, key) {
    const row = this.sql.exec('SELECT n FROM counts WHERE day = ? AND key = ?', day, key).toArray()[0];
    return row ? Number(row.n) : 0;
  }

  #bump(day, key) {
    this.sql.exec(
      'INSERT INTO counts (day, key, n) VALUES (?, ?, 1)'
      + ' ON CONFLICT (day, key) DO UPDATE SET n = n + 1',
      day,
      key,
    );
  }
}
