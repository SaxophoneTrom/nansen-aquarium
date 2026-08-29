import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHAINS, isRealAddr, normAddr, validateHatchInput } from '../src/validate.js';

const TOKEN = 'test-token';
const EVM = '0x1f9090aae28b8a3dceadf281b0f12828e676c326';
const EVM_CHECKSUMMED = '0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326';
const SOL = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const ok = (body) => validateHatchInput({ token: TOKEN, ...body });

describe('validateHatchInput — chain', () => {
  it('exposes exactly the two shipped chains', () => {
    assert.deepEqual([...CHAINS], ['robinhood', 'solana']);
  });

  for (const chain of ['ethereum', 'Robinhood', 'robinhood ', '', 'solana,robinhood', null, 42, ['solana']]) {
    it(`rejects chain ${JSON.stringify(chain)}`, () => {
      assert.equal(ok({ chain, address: EVM }).ok, false);
    });
  }
});

describe('validateHatchInput — robinhood addresses', () => {
  it('accepts a 40-hex address', () => {
    assert.equal(ok({ chain: 'robinhood', address: EVM }).ok, true);
  });

  it('lowercases checksummed hex', () => {
    const res = ok({ chain: 'robinhood', address: EVM_CHECKSUMMED });
    assert.equal(res.ok, true);
    assert.equal(res.address, EVM);
  });

  it('trims surrounding whitespace', () => {
    const res = ok({ chain: 'robinhood', address: `  ${EVM}\n` });
    assert.equal(res.ok, true);
    assert.equal(res.address, EVM);
  });

  it('rejects 39 and 41 hex digits', () => {
    assert.equal(ok({ chain: 'robinhood', address: `0x${'a'.repeat(39)}` }).ok, false);
    assert.equal(ok({ chain: 'robinhood', address: `0x${'a'.repeat(41)}` }).ok, false);
  });

  it('rejects a missing 0x prefix and non-hex digits', () => {
    assert.equal(ok({ chain: 'robinhood', address: 'a'.repeat(40) }).ok, false);
    assert.equal(ok({ chain: 'robinhood', address: `0x${'g'.repeat(40)}` }).ok, false);
  });

  it('rejects a solana address on the robinhood chain', () => {
    assert.equal(ok({ chain: 'robinhood', address: SOL }).ok, false);
  });
});

describe('validateHatchInput — solana addresses', () => {
  it('accepts base58 and never folds its case', () => {
    const res = ok({ chain: 'solana', address: SOL });
    assert.equal(res.ok, true);
    assert.equal(res.address, SOL);
    assert.notEqual(res.address, SOL.toLowerCase());
  });

  it('accepts the length edges (32 and 44) and rejects 31 and 45', () => {
    assert.equal(ok({ chain: 'solana', address: 'A'.repeat(32) }).ok, true);
    assert.equal(ok({ chain: 'solana', address: 'A'.repeat(44) }).ok, true);
    assert.equal(ok({ chain: 'solana', address: 'A'.repeat(31) }).ok, false);
    assert.equal(ok({ chain: 'solana', address: 'A'.repeat(45) }).ok, false);
  });

  for (const bad of ['0', 'O', 'I', 'l']) {
    it(`rejects base58-excluded character ${bad}`, () => {
      assert.equal(ok({ chain: 'solana', address: bad + 'A'.repeat(40) }).ok, false);
    });
  }

  it('rejects an EVM address on the solana chain', () => {
    assert.equal(ok({ chain: 'solana', address: EVM }).ok, false);
  });

  it('accepts the reserved blank-wallet test address', () => {
    const res = ok({ chain: 'solana', address: 'EggEnigma1111111111111111111111111111111111' });
    assert.equal(res.ok, true);
    assert.equal(res.address, 'EggEnigma1111111111111111111111111111111111');
  });
});

describe('validateHatchInput — deny list', () => {
  it('rejects the EVM zero address in any casing', () => {
    assert.equal(ok({ chain: 'robinhood', address: `0x${'0'.repeat(40)}` }).ok, false);
    assert.equal(ok({ chain: 'robinhood', address: `0X${'0'.repeat(40)}` }).ok, false);
  });

  it('rejects the solana system and incinerator programs', () => {
    assert.equal(ok({ chain: 'solana', address: '11111111111111111111111111111111' }).ok, false);
    assert.equal(ok({ chain: 'solana', address: '1nc1nerator11111111111111111111111111111111' }).ok, false);
  });

  it('isRealAddr matches fetch.mjs for the same list', () => {
    assert.equal(isRealAddr('0x0000000000000000000000000000000000000000'), false);
    assert.equal(isRealAddr('11111111111111111111111111111111'), false);
    assert.equal(isRealAddr('1nc1nerator11111111111111111111111111111111'), false);
    assert.equal(isRealAddr(EVM), true);
    assert.equal(isRealAddr(''), false);
  });
});

describe('validateHatchInput — names and tokens', () => {
  for (const name of ['vitalik.eth', 'toly.sol', 'VITALIK.ETH', 'a.b.eth']) {
    it(`rejects the name ${name}`, () => {
      assert.equal(ok({ chain: 'robinhood', address: name }).ok, false);
      assert.equal(ok({ chain: 'solana', address: name }).ok, false);
    });
  }

  it('rejects a missing, empty or non-string captcha token', () => {
    assert.equal(validateHatchInput({ chain: 'robinhood', address: EVM }).ok, false);
    assert.equal(validateHatchInput({ chain: 'robinhood', address: EVM, token: '' }).ok, false);
    assert.equal(validateHatchInput({ chain: 'robinhood', address: EVM, token: 1 }).ok, false);
  });

  it('rejects an absurdly long captcha token', () => {
    assert.equal(validateHatchInput({ chain: 'robinhood', address: EVM, token: 'x'.repeat(2049) }).ok, false);
    assert.equal(validateHatchInput({ chain: 'robinhood', address: EVM, token: 'x'.repeat(2048) }).ok, true);
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, undefined, 'string', 7, [{ chain: 'robinhood' }]]) {
      assert.equal(validateHatchInput(body).ok, false);
    }
  });

  it('ignores unexpected extra fields rather than trusting them', () => {
    const res = validateHatchInput({
      chain: 'robinhood', address: EVM, token: TOKEN, endpoint: 'smart-money/holdings',
    });
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res).sort(), ['address', 'chain', 'ok', 'token']);
  });
});

describe('normAddr', () => {
  it('lowercases plain hex only', () => {
    assert.equal(normAddr(EVM_CHECKSUMMED), EVM);
    assert.equal(normAddr(SOL), SOL);
    assert.equal(normAddr('  0xAbCd  '), '0xabcd');
    assert.equal(normAddr(null), '');
  });
});
