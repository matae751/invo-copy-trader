import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrader,
  sizeInitial,
  sizeIncrease,
  limitPrice,
  fillPriceRange,
  MIN_INITIAL_NOTIONAL_USD,
  MAX_INITIAL_NOTIONAL_USD,
  SLIPPAGE_PCT,
  type TraderStats,
} from './sizing.js';

const strong: TraderStats = {
  winRate: 92, wonPositions: 184, lostPositions: 16, currentWinStreak: 14, percentChange: 1200, liquidated: false,
};

// --- Tiers ---

test('strong trader sizes at $78.40', () => {
  const r = classifyTrader(strong);
  assert.equal(r.tier, 'strong');
  assert.equal(r.notionalUsd, 78.4);
});

test('average trader sizes at $50 or $60 by streak', () => {
  assert.deepEqual(
    [classifyTrader({ ...strong, currentWinStreak: 3 }).notionalUsd, classifyTrader({ ...strong, currentWinStreak: 7 }).notionalUsd],
    [50, 60],
  );
  // Long streak but win rate / W/L below strong thresholds
  const r = classifyTrader({ ...strong, winRate: 80, wonPositions: 80, lostPositions: 20 });
  assert.equal(r.tier, 'average');
  assert.equal(r.notionalUsd, 60);
});

test('strong boundaries are inclusive', () => {
  const r = classifyTrader({ ...strong, currentWinStreak: 10, winRate: 85, wonPositions: 50, lostPositions: 10 });
  assert.equal(r.tier, 'strong');
  assert.equal(classifyTrader({ ...strong, currentWinStreak: 9 }).tier, 'average');
});

test('poor or missing performance sizes at $40', () => {
  const cases: (TraderStats | null)[] = [
    null,
    {},
    { ...strong, percentChange: -5 },
    { ...strong, percentChange: 0 },
    { ...strong, currentWinStreak: 0 },
    { ...strong, liquidated: true },
    { ...strong, winRate: 55 },
    { ...strong, wonPositions: 10, lostPositions: 10 },
    { ...strong, currentWinStreak: undefined },
  ];
  for (const c of cases) {
    const r = classifyTrader(c);
    assert.equal(r.tier, 'poor', JSON.stringify(c));
    assert.equal(r.notionalUsd, 40);
  }
});

test('no losses counts as infinite W/L', () => {
  assert.equal(classifyTrader({ ...strong, lostPositions: 0 }).tier, 'strong');
});

// --- Fill price range ---

test('limitPrice matches the original placeMarketOrder formula', () => {
  for (const mid of [142.37, 97123.5, 0.31234, 2.3456, 123.456]) {
    for (const isBuy of [true, false]) {
      const raw = isBuy ? mid * 1.02 : mid * 0.98;
      assert.equal(limitPrice(mid, isBuy), parseFloat(parseFloat(raw.toPrecision(5)).toString()));
    }
  }
  assert.equal(SLIPPAGE_PCT, 0.02);
});

test('fill range covers the rounded limit price even when rounding widens it', () => {
  // 123.456 × 1.02 = 125.92512 → toPrecision(5) = 125.93 (above the raw 2%)
  const buy = fillPriceRange(123.456, true);
  assert.equal(buy.limitPx, 125.93);
  assert.equal(buy.highPx, 125.93);
  // 123.456 × 0.98 = 120.98688 → 120.99 (above raw, so the raw 2% stays the low bound)
  const sell = fillPriceRange(123.456, false);
  assert.equal(sell.limitPx, 120.99);
  assert.ok(Math.abs(sell.lowPx - 123.456 * 0.98) < 1e-9);
});

// --- Initial sizing ---

const assets = [
  { name: 'SOL', mid: 142.37, szDecimals: 2 },
  { name: 'BTC', mid: 97123.5, szDecimals: 5 },
  { name: 'ETH', mid: 3456.78, szDecimals: 4 },
  { name: 'XRP', mid: 2.3456, szDecimals: 0 },
  { name: 'DOGE', mid: 0.31234, szDecimals: 0 },
  { name: 'ROUNDUP', mid: 123.456, szDecimals: 2 },
];

test('initial size stays within [$40, $78.40] at every possible fill price, both sides', () => {
  for (const a of assets) {
    for (const isBuy of [true, false]) {
      const px = fillPriceRange(a.mid, isBuy);
      for (const target of [0, 40, 50, 60, 78.4, 80, 1000]) {
        const r = sizeInitial(target, a.mid, a.szDecimals, isBuy);
        const qty = parseFloat(r.qty);
        const label = `${a.name} ${isBuy ? 'buy' : 'sell'} target ${target}: ${r.qty}`;
        assert.ok(qty * px.lowPx >= MIN_INITIAL_NOTIONAL_USD - 1e-9, `${label} min fill $${qty * px.lowPx}`);
        assert.ok(qty * px.highPx <= MAX_INITIAL_NOTIONAL_USD + 1e-9, `${label} max fill $${qty * px.highPx}`);
        // Hard guarantee from the order's own limit price
        if (isBuy) assert.ok(qty * r.limitPx <= MAX_INITIAL_NOTIONAL_USD + 1e-9, label);
        else assert.ok(qty * r.limitPx >= MIN_INITIAL_NOTIONAL_USD - 1e-9, label);
        // Reported range is within the band
        assert.ok(r.minFillNotionalUsd >= MIN_INITIAL_NOTIONAL_USD && r.maxFillNotionalUsd <= MAX_INITIAL_NOTIONAL_USD, label);
        // qty respects szDecimals
        const decimals = r.qty.includes('.') ? r.qty.split('.')[1].length : 0;
        assert.equal(decimals, a.szDecimals);
      }
    }
  }
});

test('initial size converts USD to coin units within the worst-case band', () => {
  // mid $100, 2% → fills in [$98, $102]; qty band [ceil(40/98), floor(78.4/102)] = [0.41, 0.76]
  assert.deepEqual(sizeInitial(50, 100, 2, true), {
    qty: '0.50', notionalUsd: 50, minFillNotionalUsd: 49, maxFillNotionalUsd: 51, limitPx: 102,
  });
  assert.deepEqual(sizeInitial(78.4, 100, 2, true), {
    qty: '0.76', notionalUsd: 76, minFillNotionalUsd: 74.48, maxFillNotionalUsd: 77.52, limitPx: 102,
  });
  assert.deepEqual(sizeInitial(40, 100, 2, false), {
    qty: '0.41', notionalUsd: 41, minFillNotionalUsd: 40.18, maxFillNotionalUsd: 41.82, limitPx: 98,
  });
});

test('regression: mid-only sizing could fill below $40 or above $78.40', () => {
  // Old: 0.40 @ $100 = $40 at mid, but a sell filling at $98 = $39.20
  assert.equal(sizeInitial(40, 100, 2, false).qty, '0.41');
  // Old: 0.78 @ $100 = $78 at mid, but a buy filling at $102 = $79.56
  assert.equal(sizeInitial(78.4, 100, 2, true).qty, '0.76');
});

test('initial size refuses when one size step cannot land in the worst-case band', () => {
  // szDecimals 0 at $50: 1 coin fills in [$49, $51] — fits
  assert.equal(sizeInitial(50, 50, 0, true).qty, '1');
  // At $39.50: 1 coin may fill < $40, 2 coins may fill > $78.40
  assert.throws(() => sizeInitial(50, 39.5, 0, true), /too coarse/);
  assert.throws(() => sizeInitial(50, 100, 0, true), /too coarse/);
  // At $77.50: fit at mid, but a buy filling at $79.05 exceeds $78.40
  assert.throws(() => sizeInitial(78.4, 77.5, 0, true), /too coarse/);
});

test('initial size rejects bad prices', () => {
  assert.throws(() => sizeInitial(50, 0, 2, true), /Invalid mid/);
  assert.throws(() => sizeInitial(50, NaN, 2, true), /Invalid mid/);
});

// --- Increases ---

test('increase worst-case fill is capped at 80% of current notional', () => {
  // Current $50 → cap $40; floor(40 / 102) = 0.39 → max fill $39.78
  for (const isBuy of [true, false]) {
    const r = sizeIncrease(78.4, 50, 100, 2, isBuy);
    assert.equal(r.capUsd, 40);
    assert.equal(r.qty, '0.39');
    assert.equal(r.maxFillNotionalUsd, 39.78);
    assert.equal(r.limitPx, isBuy ? 102 : 98);
  }
});

test('increase below the cap uses the tier target at worst-case fill', () => {
  // Current $200 → cap $160; target $40 → floor(40 / 102) = 0.39
  const r = sizeIncrease(40, 200, 100, 2, true);
  assert.equal(r.qty, '0.39');
  assert.ok(r.maxFillNotionalUsd <= 40);
});

test('increase never exceeds the cap at any fill price', () => {
  for (const a of assets) {
    for (const isBuy of [true, false]) {
      const px = fillPriceRange(a.mid, isBuy);
      for (const current of [40, 55.5, 78.4, 150, 1000]) {
        for (const target of [40, 50, 60, 78.4]) {
          const r = sizeIncrease(target, current, a.mid, a.szDecimals, isBuy);
          const maxFill = parseFloat(r.qty) * px.highPx;
          assert.ok(maxFill <= current * 0.8 + 1e-9, `${a.name} current ${current}: $${maxFill}`);
          assert.ok(maxFill <= target + 1e-9);
        }
      }
    }
  }
});

test('increase refuses when the worst-case fill is below the $10 minimum order', () => {
  assert.throws(() => sizeIncrease(78.4, 10, 100, 2, true), /below the \$10 minimum/);
  // cap $10.40 → floor(10.40 / 102) = 0.10 → may fill at $9.80
  assert.throws(() => sizeIncrease(78.4, 13, 100, 2, true), /below the \$10 minimum/);
  assert.throws(() => sizeIncrease(78.4, 0, 100, 2, true), /Invalid current/);
});

test('multiple consecutive increases each respect the 80% cap and the position can exceed $78.40', () => {
  const mid = 100;
  const szDecimals = 2;
  const { highPx } = fillPriceRange(mid, true);
  // Strong trader: initial 0.76 ($76 at mid, ≤ $77.52 at worst fill), then 5 increases
  let qty = parseFloat(sizeInitial(78.4, mid, szDecimals, true).qty);
  assert.equal(qty, 0.76);

  const caps: number[] = [];
  const adds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const current = qty * mid;
    const r = sizeIncrease(78.4, current, mid, szDecimals, true);
    const maxFill = parseFloat(r.qty) * highPx;
    assert.ok(maxFill <= current * 0.8 + 1e-9, `increase ${i + 1}: $${maxFill} > 80% of $${current}`);
    assert.ok(maxFill <= 78.4 + 1e-9);
    caps.push(r.capUsd);
    adds.push(r.qty);
    qty = Math.round((qty + parseFloat(r.qty)) * 100) / 100;
  }

  // $76 → cap $60.80 → +0.59 → $135 → cap $108, target $78.40 → +0.76 per step after that
  assert.deepEqual(adds, ['0.59', '0.76', '0.76', '0.76', '0.76']);
  assert.deepEqual(caps, [60.8, 108, 168.8, 229.6, 290.4]);
  assert.ok(qty * mid > MAX_INITIAL_NOTIONAL_USD);
  assert.equal(qty, 4.39);
});

test('consecutive increases with a poor trader stay cap-limited when the position is small', () => {
  const mid = 2;
  const szDecimals = 0;
  // Fills in [$1.96, $2.04]; initial band [ceil(40/1.96), floor(78.4/2.04)] = [21, 38]
  let qty = parseFloat(sizeInitial(40, mid, szDecimals, true).qty);
  assert.equal(qty, 21);

  // $42 → cap $33.60 → floor(33.6/2.04) = 16 → $74 → cap $59.20, target $40 → floor(40/2.04) = 19 → ...
  const adds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = sizeIncrease(40, qty * mid, mid, szDecimals, true);
    assert.ok(r.maxFillNotionalUsd <= r.capUsd);
    adds.push(r.qty);
    qty += parseFloat(r.qty);
  }
  assert.deepEqual(adds, ['16', '19', '19']);
  assert.equal(qty * mid, 150);
});

test('increases after the price moves use current notional at that time', () => {
  const szDecimals = 2;
  let qty = parseFloat(sizeInitial(40, 100, szDecimals, true).qty); // 0.41
  assert.equal(qty, 0.41);
  // Price drops to $50: position is $20.50 → cap $16.40 → floor(16.4 / 51) = 0.32
  const r1 = sizeIncrease(78.4, qty * 50, 50, szDecimals, true);
  assert.equal(r1.capUsd, 16.4);
  assert.equal(r1.qty, '0.32');
  qty += parseFloat(r1.qty);
  // Price rises to $200: 0.73 → $146 → cap $116.80, target $78.40 wins → floor(78.4 / 204) = 0.38
  const r2 = sizeIncrease(78.4, qty * 200, 200, szDecimals, true);
  assert.equal(r2.capUsd, 116.8);
  assert.equal(r2.qty, '0.38');
});

test('short increases are capped the same way', () => {
  // Short position $100 → cap $80; target $78.40 at worst fill $102 → floor(0.7686) = 0.76
  const r = sizeIncrease(78.4, 100, 100, 2, false);
  assert.equal(r.qty, '0.76');
  assert.equal(r.limitPx, 98);
  assert.ok(r.maxFillNotionalUsd <= 78.4);
});
