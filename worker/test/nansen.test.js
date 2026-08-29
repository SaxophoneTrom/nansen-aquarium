import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BLANK_TEST_ADDRESSES, mockPnlSummary, pickMockRow, toHatchPayload } from '../src/nansen.js';
import { CHAINS, validateHatchInput } from '../src/validate.js';

const FETCHED_AT = '2026-08-28T12:00:00.000Z';

// The exact shape docs/nansen-api/samples/profiler_pnl_summary_robinhood_v2.json
// captured from the live endpoint — including the two fields that must never
// reach a visitor.
const RICH_ROW = {
  pagination: { page: 1, per_page: 1, is_last_page: true },
  top5_tokens: [
    {
      realized_pnl: 119369.28874793624,
      realized_roi: 0.0022598247837369257,
      token_address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      token_symbol: 'USDG',
      chain: 'robinhood',
    },
    {
      realized_pnl: 88.1, realized_roi: 0.01, token_address: '0xdead', token_symbol: 'NVDA', chain: 'robinhood',
    },
  ],
  traded_token_count: 2,
  traded_times: 13,
  realized_pnl_usd: 119369.28874793624,
  realized_pnl_percent: 0.0022598247837369257,
  win_rate: 1.0,
};

const BLANK_ROW = {
  pagination: { page: 1, per_page: 1, is_last_page: true },
  top5_tokens: [],
  traded_token_count: 0,
  traded_times: 0,
  realized_pnl_usd: 0,
  realized_pnl_percent: 0,
  win_rate: 0,
};

const shape = (raw, over = {}) => toHatchPayload({
  chain: 'robinhood', address: '0xabc', raw, fetchedAt: FETCHED_AT, ...over,
});

const EXPECTED_KEYS = [
  'address', 'cached', 'chain', 'fetched_at', 'has_history', 'realized_pnl_percent',
  'realized_pnl_usd', 'top_tokens', 'traded_times', 'traded_token_count', 'win_rate',
];

describe('toHatchPayload — whitelist', () => {
  it('returns exactly the design-doc fields and nothing else', () => {
    assert.deepEqual(Object.keys(shape(RICH_ROW)).sort(), EXPECTED_KEYS);
  });

  it('carries the numbers through untouched', () => {
    const out = shape(RICH_ROW);
    assert.equal(out.has_history, true);
    assert.equal(out.win_rate, 1.0);
    assert.equal(out.realized_pnl_usd, 119369.28874793624);
    assert.equal(out.realized_pnl_percent, 0.0022598247837369257);
    assert.equal(out.traded_times, 13);
    assert.equal(out.traded_token_count, 2);
    assert.equal(out.fetched_at, FETCHED_AT);
    assert.equal(out.cached, false);
  });

  it('reduces top5_tokens to symbols — no token_address, no roi', () => {
    assert.deepEqual(shape(RICH_ROW).top_tokens, ['USDG', 'NVDA']);
  });

  it('leaks neither pagination nor any token_address into the serialized body', () => {
    const wire = JSON.stringify(shape(RICH_ROW));
    assert.ok(!wire.includes('pagination'));
    assert.ok(!wire.includes('token_address'));
    assert.ok(!wire.includes('0x5fc5360d0400a0fd4f2af552add042d716f1d168'));
    assert.ok(!wire.includes('realized_roi'));
    assert.ok(!wire.includes('address_label'));
  });

  it('drops fields the upstream might add later', () => {
    const out = shape({ ...RICH_ROW, address_label: 'Smart Money', wallet_tags: ['x'] });
    assert.deepEqual(Object.keys(out).sort(), EXPECTED_KEYS);
  });

  it('caps top_tokens at five symbols and skips blank ones', () => {
    const many = {
      ...RICH_ROW,
      top5_tokens: [
        { token_symbol: 'A' }, { token_symbol: '' }, { token_symbol: 'B' }, { token_symbol: null },
        { token_symbol: 'C' }, { token_symbol: 'D' }, { token_symbol: 'E' }, { token_symbol: 'F' },
      ],
    };
    assert.deepEqual(shape(many).top_tokens, ['A', 'B', 'C', 'D', 'E']);
  });

  it('stamps cached when asked', () => {
    assert.equal(shape(RICH_ROW, { cached: true }).cached, true);
  });
});

describe('toHatchPayload — blank guard', () => {
  it('turns a row of zeroes into no history at all', () => {
    const out = shape(BLANK_ROW);
    assert.equal(out.has_history, false);
    for (const k of ['win_rate', 'realized_pnl_usd', 'realized_pnl_percent', 'traded_times', 'traded_token_count']) {
      assert.equal(out[k], null, `${k} should be null`);
    }
    assert.deepEqual(out.top_tokens, []);
  });

  it('keeps a genuinely flat trader who did trade', () => {
    // Zero PnL but real activity is a fact, not an absence — both counters have
    // to be zero before the row is treated as a blank page.
    const flat = { ...BLANK_ROW, traded_times: 4, traded_token_count: 1, win_rate: 0 };
    const out = shape(flat);
    assert.equal(out.has_history, true);
    assert.equal(out.win_rate, 0);
    assert.equal(out.realized_pnl_usd, 0);
  });

  it('treats a missing upstream row as no history', () => {
    const out = shape(null);
    assert.equal(out.has_history, false);
    assert.equal(out.win_rate, null);
  });

  it('nulls a non-finite or non-numeric stat rather than passing it on', () => {
    const out = shape({ ...RICH_ROW, win_rate: null, realized_pnl_usd: 'NaN' });
    assert.equal(out.has_history, true);
    assert.equal(out.win_rate, null);
    assert.equal(out.realized_pnl_usd, null);
  });
});

describe('mock backend', () => {
  it('is deterministic per address', () => {
    const addr = '0x1f9090aae28b8a3dceadf281b0f12828e676c326';
    assert.deepEqual(pickMockRow('robinhood', addr), pickMockRow('robinhood', addr));
  });

  it('spreads addresses across every profile', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const addr = `0x${i.toString(16).padStart(40, '0')}`;
      seen.add(pickMockRow('robinhood', addr).traded_times);
    }
    assert.ok(seen.size >= 5, `expected at least 5 distinct profiles, saw ${seen.size}`);
  });

  it('answers in the real upstream shape', () => {
    const row = pickMockRow('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    assert.deepEqual(
      Object.keys(row).sort(),
      ['pagination', 'realized_pnl_percent', 'realized_pnl_usd', 'top5_tokens',
        'traded_times', 'traded_token_count', 'win_rate'],
    );
    for (const t of row.top5_tokens) {
      assert.deepEqual(Object.keys(t).sort(), ['chain', 'realized_pnl', 'realized_roi', 'token_address', 'token_symbol']);
    }
  });

  it('every profile survives the whitelist with history intact', () => {
    const rows = new Map();
    for (let i = 0; i < 200; i += 1) {
      const address = `0x${i.toString(16).padStart(40, '0')}`;
      rows.set(pickMockRow('robinhood', address).traded_times, address);
    }
    for (const [, address] of rows) {
      const out = toHatchPayload({
        chain: 'robinhood', address, raw: pickMockRow('robinhood', address), fetchedAt: FETCHED_AT,
      });
      assert.equal(out.has_history, true, `${address} should read as a real trader`);
      assert.deepEqual(Object.keys(out).sort(), EXPECTED_KEYS);
      assert.ok(out.top_tokens.length > 0);
    }
  });

  it('reserves a blank-wallet address for every shipped chain', () => {
    assert.deepEqual(Object.keys(BLANK_TEST_ADDRESSES).sort(), [...CHAINS].sort());
  });

  it('hands the reserved test addresses to the blank guard', async () => {
    for (const [chain, address] of Object.entries(BLANK_TEST_ADDRESSES)) {
      assert.equal(validateHatchInput({ chain, address, token: 't' }).ok, true, `${address} must validate`);
      const row = await mockPnlSummary(chain, address);
      const out = toHatchPayload({ chain, address, raw: row, fetchedAt: FETCHED_AT });
      assert.equal(out.has_history, false, `${chain} test address should have no history`);
      assert.equal(out.traded_times, null);
      assert.deepEqual(out.top_tokens, []);
    }
  });

  it('keeps every other address on a chain out of the blank guard', () => {
    // robinhood and base reserve the same spelling, so the lookup being keyed
    // by chain is what stops one tank's ordinary wallets from reading blank.
    for (const chain of CHAINS) {
      const address = chain === 'solana'
        ? 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
        : '0x1f9090aae28b8a3dceadf281b0f12828e676c326';
      const out = toHatchPayload({ chain, address, raw: pickMockRow(chain, address), fetchedAt: FETCHED_AT });
      assert.equal(out.has_history, true, `${chain} should read this wallet as a real trader`);
    }
  });
});
