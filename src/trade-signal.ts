// Parse a monitor signal into what trade.ts / close.ts / tpsl.ts execute.
//
// A copy replicates the trader's trade exactly — coin, direction, leverage,
// entry price, TP/SL, and every later change — so all of those come from the
// signal itself, never from separately typed arguments. Only the size is ours
// (computed from our equity in sizing.ts). Anything missing or malformed is
// refused here, before Hyperliquid is touched: a parameter we'd have to guess
// is a parameter we don't trade on.

import { parseMimicMeta, type MimicMeta } from './mimic-meta.js';
import { parseCloseIdentity, type CloseIdentity, type Side } from './copy-ledger.js';

/** An increase older than this is a trade at a stale price: refused (the monitor skips them too). */
export const MAX_CHANGE_AGE_MS = 300_000;
/**
 * An open signal whose post is older than this is refused by trade.ts itself, so a
 * saved, delayed or replayed signal can't open a trade the trader may have left
 * (the monitor's --max-signal-age filters them first; this holds whatever it was set to).
 */
export const MAX_OPEN_AGE_MS = 300_000;
/** Clock skew tolerated for a post time in the future; more than this is refused as unreadable. */
export const MAX_CLOCK_SKEW_MS = 60_000;

export type TpslKind = 'tp' | 'sl';

export interface OpenSignal {
  kind: 'open';
  coin: string;
  side: Side;
  leverage: number;
  /** The trader's fill price: our order is never worse than this by more than the slippage allowance. */
  entryPrice: number;
  /** The trader's take-profit / stop-loss trigger prices at open (null = none set). */
  tp: number | null;
  sl: number | null;
  /** When the trader opened (their trade's createdAt), if the signal says. */
  traderOpenedAt: string | null;
  /** When the feed post announcing the open was made (signal.postedAt); null if the signal doesn't say. */
  postedAt: string | null;
  mimicMeta: MimicMeta;
}

interface ChangeBase {
  coin: string;
  side: Side | null;
  identity: CloseIdentity;
  /** Unique per trader change (from /dex/trade), recorded so it is applied once. */
  updateId: string;
  updatedAt: string;
}

/** The trader added to the trade: their position grew by `ratio` (change / size before). */
export interface IncreaseSignal extends ChangeBase { kind: 'increase'; ratio: number; investmentId: string }
/** The trader reduced the trade by `fraction` of it (change / size before, at most 1). */
export interface DecreaseSignal extends ChangeBase { kind: 'decrease'; fraction: number }
/** The trader set (or moved) their take-profit or stop-loss. */
export interface TpslSignal extends ChangeBase { kind: 'tpsl'; which: TpslKind; triggerPx: number }
/** The trader closed the trade (closed by them, TP/SL hit or liquidated). */
export interface CloseSignal { kind: 'close'; coin: string; identity: CloseIdentity; reason: string | null }

export type TradeSignal = OpenSignal | IncreaseSignal | DecreaseSignal | TpslSignal | CloseSignal;

/** Does a CLI argument look like a signal (rather than a coin name)? */
export const isSignalArg = (arg: string | undefined) => typeof arg === 'string' && arg.trim().startsWith('{');

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function coinOf(trade: any): string {
  if (!nonEmpty(trade?.coin)) throw new Error('signal has no trade.coin');
  return trade.coin.trim();
}

function sideOf(trade: any, required: boolean): Side | null {
  const s = trade?.side;
  if (s === 'long' || s === 'short') return s;
  if (!required && s === undefined) return null;
  throw new Error(`signal trade.side must be "long" or "short" (got ${JSON.stringify(s ?? null)})`);
}

/** An optional price: absent from the signal is an error (unknown), null means "none set". */
function optionalPrice(trade: any, key: string, label: string): number | null {
  if (!(key in (trade ?? {}))) {
    throw new Error(`signal has no trade.${key} — can't tell whether the trader set a ${label}; re-run the monitor (it includes it)`);
  }
  const v = trade[key];
  if (v === null) return null;
  if (!positive(v)) throw new Error(`signal trade.${key} is not a positive price (got ${JSON.stringify(v)})`);
  return v;
}

function changeBase(sig: any): ChangeBase {
  if (!nonEmpty(sig.updateId)) throw new Error('signal has no updateId');
  if (!nonEmpty(sig.updatedAt) || !Number.isFinite(Date.parse(sig.updatedAt))) throw new Error('signal has no readable updatedAt');
  return {
    coin: coinOf(sig.trade),
    side: sideOf(sig.trade, false),
    identity: parseCloseIdentity(sig.mimicMeta),
    updateId: sig.updateId.trim(),
    updatedAt: sig.updatedAt,
  };
}

/** Position sizes before/after/change from a /dex/trade increase or decrease. */
function sizeChange(change: any): { before: number; after: number; delta: number } {
  const before = change?.positionSizeBefore;
  const after = change?.positionSizeAfter;
  const delta = change?.positionSizeChange;
  if (!positive(before) || typeof after !== 'number' || !Number.isFinite(after) || after < 0 || !positive(delta)) {
    throw new Error(`signal change has no usable positionSizeBefore/After/Change (got ${JSON.stringify(change ?? null)})`);
  }
  // The three must agree, or we don't know which one describes the trade
  if (Math.abs(Math.abs(after - before) - delta) > 1e-6 * Math.max(before, after)) {
    throw new Error(`signal change is inconsistent: |${after} - ${before}| != ${delta}`);
  }
  return { before, after, delta };
}

/** Parse a monitor signal (JSON). Throws on anything that isn't fully specified. */
export function parseTradeSignal(arg: string): TradeSignal {
  let sig: any;
  try {
    sig = JSON.parse(arg);
  } catch {
    throw new Error('signal is not valid JSON');
  }
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) throw new Error('signal must be a JSON object');
  if (sig.type !== undefined && sig.type !== 'signal') throw new Error(`not a signal (type ${JSON.stringify(sig.type)})`);

  switch (sig.action) {
    case 'open': {
      const t = sig.trade;
      if (t?.isOpen === false) throw new Error('open signal for a trade that is not open');
      const lev = t?.leverage;
      if (typeof lev !== 'number' || !Number.isSafeInteger(lev) || lev < 1) {
        throw new Error(`signal trade.leverage must be a whole number >= 1 (got ${JSON.stringify(lev ?? null)}) — Hyperliquid can't set it exactly`);
      }
      if (!positive(t?.entryPrice)) throw new Error(`signal has no trade.entryPrice (got ${JSON.stringify(t?.entryPrice ?? null)})`);
      const openedAt = nonEmpty(t?.openedAt) && Number.isFinite(Date.parse(t.openedAt)) ? t.openedAt : null;
      return {
        kind: 'open',
        coin: coinOf(t),
        side: sideOf(t, true)!,
        leverage: lev,
        entryPrice: t.entryPrice,
        tp: optionalPrice(t, 'priceTarget', 'take-profit'),
        sl: optionalPrice(t, 'stopLoss', 'stop-loss'),
        traderOpenedAt: openedAt,
        postedAt: nonEmpty(sig.postedAt) && Number.isFinite(Date.parse(sig.postedAt)) ? sig.postedAt : null,
        mimicMeta: parseMimicMeta(sig.mimicMeta),
      };
    }
    case 'increase': {
      const base = changeBase(sig);
      const { before, after, delta } = sizeChange(sig.change);
      if (!(after > before)) throw new Error(`increase signal whose position didn't grow (${before} → ${after})`);
      if (!nonEmpty(sig.investmentId)) throw new Error('increase signal has no investmentId');
      return { kind: 'increase', ...base, ratio: delta / before, investmentId: sig.investmentId.trim() };
    }
    case 'decrease': {
      const base = changeBase(sig);
      const { before, after, delta } = sizeChange(sig.change);
      if (!(after < before)) throw new Error(`decrease signal whose position didn't shrink (${before} → ${after})`);
      return { kind: 'decrease', ...base, fraction: Math.min(1, delta / before) };
    }
    case 'tpsl': {
      const base = changeBase(sig);
      const which = sig.change?.which;
      if (which !== 'tp' && which !== 'sl') throw new Error(`tpsl signal change.which must be "tp" or "sl" (got ${JSON.stringify(which ?? null)})`);
      const px = sig.change?.triggerPx;
      if (!positive(px)) {
        // How Invo reports a removed TP/SL hasn't been seen: don't guess that it means "cancel"
        throw new Error(`tpsl signal has no ${which} trigger price (got ${JSON.stringify(px ?? null)}) — not replicated`);
      }
      return { kind: 'tpsl', ...base, which, triggerPx: px };
    }
    case 'close':
      return {
        kind: 'close',
        coin: coinOf(sig.trade),
        identity: parseCloseIdentity(sig.mimicMeta),
        reason: nonEmpty(sig.reasonClosed) ? sig.reasonClosed : null,
      };
    case 'update':
      throw new Error('`update` feed signals are informational: changes to a copied trade arrive as increase / decrease / tpsl signals');
    default:
      throw new Error(`unknown signal action ${JSON.stringify(sig.action ?? null)}`);
  }
}
