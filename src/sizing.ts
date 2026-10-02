// Copy-trade position sizing. Pure functions — no network or env access.
//
// Initial copy:  USD notional in [$40, $78.40], picked by the copied trader's
//                performance tier.
// Increase:      the tier notional, capped at 80% of the current USD notional
//                of our position (valued at mid). No cap on total position size.
//
// All limits are enforced at the worst-case fill price, not at mid. Orders are
// IOC limits at mid ± SLIPPAGE_PCT (see limitPrice), so fills are assumed to
// land within [mid × (1 - s), mid × (1 + s)]:
//   - buy max / sell min:  bounded by the order's own limit price (hard guarantee)
//   - buy min / sell max:  assumes price doesn't move > s between the mid fetch
//                          and the fill — a limit order can't bound it. trade-exec
//                          fetches mid last, just before sizing and sending the
//                          order, so that gap is one order round trip

export const MIN_INITIAL_NOTIONAL_USD = 40;
export const MAX_INITIAL_NOTIONAL_USD = 78.4;
export const MAX_INCREASE_FRACTION = 0.8;
export const MIN_ORDER_NOTIONAL_USD = 10; // Hyperliquid minimum order value
export const SLIPPAGE_PCT = 0.02;

const EPS = 1e-9;

// Fields from Invo's get_portfolios_pl (same source discover.ts ranks on).
export interface TraderStats {
  winRate?: number; // percent, 0-100
  wonPositions?: number;
  lostPositions?: number;
  currentWinStreak?: number;
  percentChange?: number; // lifetime P&L %
  liquidated?: boolean;
}

export type Tier = 'strong' | 'average' | 'poor';

export interface TierResult {
  tier: Tier;
  notionalUsd: number;
  reasons: string[];
}

export function classifyTrader(stats: TraderStats | null | undefined): TierResult {
  if (!stats) return { tier: 'poor', notionalUsd: 40, reasons: ['trader stats unavailable'] };

  const winRate = stats.winRate;
  const streak = stats.currentWinStreak;
  const pnl = stats.percentChange;
  const won = stats.wonPositions ?? 0;
  const lost = stats.lostPositions ?? 0;
  const wl = lost > 0 ? won / lost : won > 0 ? Infinity : 0;

  const summary = `streak ${streak ?? '?'}, WR ${winRate ?? '?'}%, W/L ${Number.isFinite(wl) ? wl.toFixed(2) : '∞'}, P&L ${pnl ?? '?'}%`;

  // Poor: anything missing or a negative signal → minimum size
  const poor: string[] = [];
  if (winRate == null || streak == null || pnl == null) poor.push('incomplete stats');
  if (stats.liquidated) poor.push('liquidated');
  if (pnl != null && pnl <= 0) poor.push('non-positive P&L');
  if (streak === 0) poor.push('last closed trade lost');
  if (winRate != null && winRate < 60) poor.push('win rate < 60%');
  if (wl < 1.5) poor.push('W/L < 1.5');
  if (poor.length) return { tier: 'poor', notionalUsd: 40, reasons: [...poor, summary] };

  if (streak! >= 10 && winRate! >= 85 && wl >= 5) {
    return { tier: 'strong', notionalUsd: MAX_INITIAL_NOTIONAL_USD, reasons: [summary] };
  }

  return { tier: 'average', notionalUsd: streak! >= 5 ? 60 : 50, reasons: [summary] };
}

function floorQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(qty * f + EPS) / f;
}

function ceilQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.ceil(qty * f - EPS) / f;
}

function roundQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.round(qty * f) / f;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hyperliquid perps: a price may have at most this many decimals minus the asset's szDecimals. */
export const MAX_PERP_PRICE_DECIMALS = 6;

/**
 * IOC limit price for a market-style order. Used by hl-client, so sizing sees the exact price sent.
 * Hyperliquid accepts at most 5 significant figures AND at most 6 − szDecimals decimals
 * (e.g. 0.55407 is rejected for szDecimals 2). The decimal cut rounds away from mid
 * (buy up, sell down), so it never makes the order less likely to fill.
 */
export function limitPrice(mid: number, isBuy: boolean, szDecimals: number, slippagePct = SLIPPAGE_PCT): number {
  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  const px = parseFloat(rawPx.toPrecision(5));
  const decimals = Math.max(0, MAX_PERP_PRICE_DECIMALS - szDecimals);
  const f = 10 ** decimals;
  // Tolerance so a price already on the grid isn't pushed a tick by float error
  const ticks = isBuy ? Math.ceil(px * f - 1e-6) : Math.floor(px * f + 1e-6);
  if (!(ticks > 0)) {
    throw new Error(`Can't express a ${isBuy ? 'buy' : 'sell'} limit price near ${mid} with ${decimals} decimals (szDecimals ${szDecimals})`);
  }
  return Number((ticks / f).toFixed(decimals));
}

/** Lowest and highest price an order is assumed to fill at. */
export function fillPriceRange(mid: number, isBuy: boolean, szDecimals: number, slippagePct = SLIPPAGE_PCT) {
  const limitPx = limitPrice(mid, isBuy, szDecimals, slippagePct);
  // Rounding can push the limit slightly past mid × (1 ± s); take the wider side
  return isBuy
    ? { limitPx, lowPx: mid * (1 - slippagePct), highPx: Math.max(limitPx, mid * (1 + slippagePct)) }
    : { limitPx, lowPx: Math.min(limitPx, mid * (1 - slippagePct)), highPx: mid * (1 + slippagePct) };
}

export interface SizeResult {
  qty: string; // coin units, formatted to szDecimals
  notionalUsd: number; // qty × mid
  minFillNotionalUsd: number; // qty × lowest assumed fill price
  maxFillNotionalUsd: number; // qty × highest assumed fill price
  limitPx: number; // the price the order must be sent with
}

function result(qty: number, mid: number, szDecimals: number, px: ReturnType<typeof fillPriceRange>): SizeResult {
  return {
    qty: qty.toFixed(szDecimals),
    notionalUsd: round2(qty * mid),
    // Round outward so the reported range never understates the worst case
    minFillNotionalUsd: Math.floor(qty * px.lowPx * 100 + EPS) / 100,
    maxFillNotionalUsd: Math.ceil(qty * px.highPx * 100 - EPS) / 100,
    limitPx: px.limitPx,
  };
}

function assertPrice(mid: number, szDecimals: number) {
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error(`Invalid mid price: ${mid}`);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) throw new Error(`Invalid szDecimals: ${szDecimals}`);
}

/**
 * Size a new copied position. Any fill in the assumed range lands within
 * [$40, $78.40], or this throws.
 */
export function sizeInitial(
  targetUsd: number,
  mid: number,
  szDecimals: number,
  isBuy: boolean,
  slippagePct = SLIPPAGE_PCT,
): SizeResult {
  assertPrice(mid, szDecimals);
  const px = fillPriceRange(mid, isBuy, szDecimals, slippagePct);
  const lo = ceilQty(MIN_INITIAL_NOTIONAL_USD / px.lowPx, szDecimals);
  const hi = floorQty(MAX_INITIAL_NOTIONAL_USD / px.highPx, szDecimals);
  if (lo > hi || hi <= 0) {
    throw new Error(
      `Cannot size within $${MIN_INITIAL_NOTIONAL_USD}-$${MAX_INITIAL_NOTIONAL_USD} at worst-case fill: ` +
      `one size step (${10 ** -szDecimals} @ $${mid}, ±${slippagePct * 100}%) is too coarse`,
    );
  }
  const target = Math.min(Math.max(targetUsd, MIN_INITIAL_NOTIONAL_USD), MAX_INITIAL_NOTIONAL_USD);
  const qty = Math.min(Math.max(roundQty(target / mid, szDecimals), lo), hi);
  return result(qty, mid, szDecimals, px);
}

export interface IncreaseResult extends SizeResult {
  capUsd: number; // 80% of current position notional
}

/**
 * Size an add to an existing position: min(targetUsd, 80% of current notional),
 * with the worst-case fill held under that amount. Rounded down.
 */
export function sizeIncrease(
  targetUsd: number,
  currentNotionalUsd: number,
  mid: number,
  szDecimals: number,
  isBuy: boolean,
  slippagePct = SLIPPAGE_PCT,
): IncreaseResult {
  assertPrice(mid, szDecimals);
  if (!(currentNotionalUsd > 0)) throw new Error(`Invalid current position notional: ${currentNotionalUsd}`);
  const px = fillPriceRange(mid, isBuy, szDecimals, slippagePct);
  const capUsd = currentNotionalUsd * MAX_INCREASE_FRACTION;
  const addUsd = Math.min(targetUsd, capUsd);
  const qty = floorQty(addUsd / px.highPx, szDecimals);
  if (qty * px.lowPx < MIN_ORDER_NOTIONAL_USD - EPS) {
    throw new Error(
      `Increase too small: $${(qty * px.lowPx).toFixed(2)} at worst-case fill is below the ` +
      `$${MIN_ORDER_NOTIONAL_USD} minimum order (cap $${capUsd.toFixed(2)})`,
    );
  }
  return { ...result(qty, mid, szDecimals, px), capUsd: round2(capUsd) };
}
