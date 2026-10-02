// Open (or increase) a position: the logic behind commands/trade.ts.
// Hyperliquid, Invo and the copy ledger are injected so this is testable
// without network access or the HL SDK.

import { randomBytes, randomUUID } from 'crypto';
import type { RecordOpenPayload } from './invo-client.js';
import { classifyTrader, copyRange, sizeInitial, sizeIncrease, tierTargetUsd, SLIPPAGE_PCT } from './sizing.js';
import { getTraderStats, type TraderStatsClient } from './trader-stats.js';
import { parseMimicMetaArg, MANUAL_TRADE_ARG } from './mimic-meta.js';
import { parseLeverageArg, checkLeverage } from './leverage.js';
import {
  beginOpen,
  findCopiedUpdate,
  reconcileWithPosition,
  roundQty,
  settleOrder,
  type CopyEntry,
  type LedgerStore,
} from './copy-ledger.js';
import { assertHlOk, orderFilledQty, orderRejection } from './hl-response.js';
import { settlePendingOrders, type OrderLookup } from './pending-orders.js';

export interface HlMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
}

/** A position as clearinghouseState reports it (fields we use). */
export interface HlPosition {
  coin: string;
  szi: string;
  /** Hyperliquid sets leverage per coin: one value for the whole position. */
  leverage?: { type?: string; value?: number };
}

/** The Hyperliquid calls trade/close need, bound to our wallet. */
export interface ExecHl extends OrderLookup {
  connect(): Promise<unknown>;
  getMeta(): Promise<HlMeta>;
  getAllMids(): Promise<Record<string, string>>;
  getPositions(): Promise<HlPosition[]>;
  /**
   * reduceOnly is required so every caller decides: closes must never open or flip a position.
   * cloid lets the order be looked up (getOrderFill) if its response is lost.
   */
  placeMarketOrder(
    coin: string, isBuy: boolean, size: string, slippagePct: number, midPx: number, szDecimals: number, reduceOnly: boolean, cloid: string,
  ): Promise<any>;
}

export interface TradeHl extends ExecHl {
  setLeverage(coin: string, leverage: number): Promise<unknown>;
  /** The account's current Hyperliquid equity in USD (marginSummary.accountValue). */
  getAccountEquity(): Promise<number>;
}

export interface TradeInvo extends TraderStatsClient {
  recordOpen(payload: RecordOpenPayload): Promise<any>;
}

export interface TradeDeps {
  hl: TradeHl;
  invo: TradeInvo;
  ledger: LedgerStore;
  newId?: () => string;
  newCloid?: () => string;
  now?: () => Date;
}

export class UsageError extends Error {}

export const TRADE_USAGE =
  `Usage: trade <coin> <long|short> <size (ignored — computed from trader performance)> <leverage> <mimicMetaJson | ${MANUAL_TRADE_ARG}>`;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const randomCloid = () => `0x${randomBytes(16).toString('hex')}`;

/**
 * What an order filled: from its response, else looked up on HL by cloid.
 * null when that can't be known yet — the order is left pending for a later run to settle.
 *
 * If our request failed (threw), the order may still reach HL after we look:
 * "no such order" then proves nothing, so it stays pending instead of counting
 * as unfilled. settlePendingOrders only trusts that answer once the order is old.
 */
export async function resolveFill(hl: OrderLookup, orderResult: any, cloid: string, requestFailed: boolean): Promise<number | null> {
  const fromResponse = requestFailed ? null : orderFilledQty(orderResult);
  if (fromResponse !== null) return fromResponse;
  try {
    const f = await hl.getOrderFill(cloid);
    if (f.known) return f.filledQty;
    // HL answered our request, so it has processed the order: unknown = rejected without being stored
    return requestFailed ? null : 0;
  } catch {
    return null;
  }
}

/**
 * Leverage is per coin on Hyperliquid: setting it for this copy would change it
 * for everything already held in the coin (other traders' copies, manual
 * trades). So adding to a position needs the same leverage, isolated; anything
 * else — including leverage we can't read — is refused before anything changes.
 */
export function checkExistingLeverage(coin: string, position: HlPosition, leverage: number): void {
  const lev = position.leverage;
  const value = lev?.value;
  if (lev?.type !== 'isolated' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Refusing to add to ${coin}: the existing position's leverage can't be confirmed as isolated ` +
      `(got ${JSON.stringify(lev ?? null)}) — changing it would affect everything held in ${coin}`,
    );
  }
  if (value !== leverage) {
    throw new Error(
      `Refusing ${leverage}x on ${coin}: the existing ${coin} position is ${value}x isolated, and leverage applies to the ` +
      `whole position (other copies included). Re-run with ${value} to add at the existing leverage, if the user agrees`,
    );
  }
}

function refuseRepeat(entry: CopyEntry, updateId: string): never {
  throw new Error(`Already copied trader update ${updateId} (ledger entry ${entry.id}, ${entry.status}) — refusing to trade it again`);
}

export async function runTrade(args: string[], deps: TradeDeps) {
  const { hl, invo } = deps;
  const newId = deps.newId ?? randomUUID;
  const newCloid = deps.newCloid ?? randomCloid;
  const now = deps.now ?? (() => new Date());

  // <size> is kept for argument-position compatibility but ignored: size is computed here
  const [coin, side, ignoredSizeArg, leverageStr, mimicMetaJson] = args;
  if (!coin || (side !== 'long' && side !== 'short')) throw new UsageError(TRADE_USAGE);

  const isBuy = side === 'long';
  const leverage = parseLeverageArg(leverageStr);
  // Validated before touching HL: a copy must carry the trader's trade IDs (incl. their baseShortId).
  // null = explicit manual trade (no mimicMeta sent)
  const mimicMetaArg = parseMimicMetaArg(mimicMetaJson);
  const updateId = mimicMetaArg?.initialSourcePaperUpdateId ?? null;
  // Read the ledger before trading: a copy we can't record could never be closed by its trader's signal
  let ledgerEntries = deps.ledger.load();
  // Each trader update is copied once: a repeated signal (re-run, retry, duplicate post) must not add again.
  // An update whose order is still unsettled is re-checked once that's settled (below).
  const copied = updateId ? findCopiedUpdate(ledgerEntries, updateId) : undefined;
  if (copied && !copied.pendingOrder) refuseRepeat(copied, updateId!);

  await hl.connect();

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);
  const { szDecimals, maxLeverage } = meta.universe[assetIndex];
  checkLeverage(leverage, coin, maxLeverage);

  // An earlier run's order in this coin that was never recorded is settled first (throws if it can't be)
  const pending = await settlePendingOrders(hl, deps.ledger, ledgerEntries, coin, szDecimals, now().toISOString());
  ledgerEntries = pending.entries;
  const copiedAfterSettle = updateId ? findCopiedUpdate(ledgerEntries, updateId) : undefined;
  if (copiedAfterSettle) refuseRepeat(copiedAfterSettle, updateId!);

  // Snapshot position before
  const posBefore = await hl.getPositions();
  const existing = posBefore.find(p => p.coin === coin);
  const qtyBefore = existing ? existing.szi : '0';
  const existingSzi = parseFloat(qtyBefore);

  // Entries the live position shows are gone (flat / other side) are closed first, so
  // they can't block later closes or absorb this fill. Saved now, before any order.
  const reconcile = reconcileWithPosition(ledgerEntries, coin, existingSzi, szDecimals, now().toISOString());
  if (reconcile.reconciled.length) {
    deps.ledger.save(reconcile.entries);
    ledgerEntries = reconcile.entries;
  }

  if (existingSzi !== 0 && (existingSzi > 0) !== isBuy) {
    throw new Error(`Refusing ${side} ${coin}: existing position is ${existingSzi > 0 ? 'long' : 'short'} ${Math.abs(existingSzi)}`);
  }
  if (existingSzi !== 0) checkExistingLeverage(coin, existing!, leverage);

  // Trader's tier, as a % of equity. Stats null on any lookup failure → poor tier (5%)
  const statsLookup = await getTraderStats(invo, mimicMetaArg);
  const perf = classifyTrader(statsLookup.stats);

  // Set leverage. HL reports a rejection (e.g. can't switch an open cross position to
  // isolated) in the response body; never place the order at a leverage we didn't set.
  // (With a position open, checkExistingLeverage above means this changes nothing.)
  assertHlOk(await hl.setLeverage(coin, leverage), `Setting ${coin} to ${leverage}x isolated`);

  // Equity and price last: the stats lookup and leverage change above are network calls
  // (up to 20s each), and the size must track the balance and price as they are when the
  // order goes out. Only a local ledger write sits between these reads and the order.
  const range = copyRange(await hl.getAccountEquity()); // throws if unusable or too small
  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  // Size: initial copy → the tier's % of equity, clamped to 5–10% of equity;
  // increase → the tier's % of equity (≤ 10%), capped at 80% of current notional.
  // Bounds hold at the worst-case fill (mid ± SLIPPAGE_PCT), not just at mid.
  const isIncrease = existingSzi !== 0;
  const currentNotionalUsd = Math.abs(existingSzi) * mid;
  const targetUsd = Math.min(tierTargetUsd(range.equityUsd, perf.equityPct), range.maxUsd);
  const sizing = isIncrease
    ? sizeIncrease(targetUsd, currentNotionalUsd, mid, szDecimals, isBuy, SLIPPAGE_PCT)
    : sizeInitial(targetUsd, range, mid, szDecimals, isBuy, SLIPPAGE_PCT);
  const sizeStr = sizing.qty;

  const clientTxId = newId();
  const cloid = newCloid();

  // Write the order to the ledger before sending it: if this process dies after
  // the order fills, the next run settles it by cloid instead of losing the fill.
  const begun = beginOpen(ledgerEntries, {
    id: clientTxId,
    coin,
    side,
    source: mimicMetaArg && {
      creatorInvoUserId: mimicMetaArg.creatorInvoUserId,
      portfolioId: mimicMetaArg.portfolioId,
      sourcePaperTradeBaseId: mimicMetaArg.sourcePaperTradeBaseId,
      sourcePaperTradeBaseShortId: mimicMetaArg.sourcePaperTradeBaseShortId,
    },
    sourceUpdateId: updateId,
    cloid,
    requestedQty: parseFloat(sizeStr),
    now: now().toISOString(),
  });
  deps.ledger.save(begun.entries);

  // Place order on HL
  const nonceMs = now().getTime();
  let orderResult: any = null;
  let orderError: string | null = null;
  let requestFailed = false;
  try {
    orderResult = await hl.placeMarketOrder(coin, isBuy, sizeStr, SLIPPAGE_PCT, mid, szDecimals, false, cloid);
    orderError = orderRejection(orderResult);
  } catch (e: any) {
    // May or may not have reached HL — resolveFill looks it up by cloid
    requestFailed = true;
    orderError = `order request failed: ${e.message}`;
  }
  const filled = await resolveFill(hl, orderResult, cloid, requestFailed);

  const base = {
    coin,
    side,
    size: sizeStr,
    leverage,
    sizing: {
      mode: isIncrease ? 'increase' : 'initial',
      tier: perf.tier,
      equityUsd: round2(range.equityUsd),
      tierPct: perf.equityPct,
      // Initial copies are clamped to [minUsd, maxUsd]; increases use targetUsd under the 80% cap
      minUsd: round2(range.minUsd),
      maxUsd: round2(range.maxUsd),
      targetUsd: round2(targetUsd),
      notionalUsd: sizing.notionalUsd,
      minFillNotionalUsd: sizing.minFillNotionalUsd,
      maxFillNotionalUsd: sizing.maxFillNotionalUsd,
      mid,
      limitPx: sizing.limitPx,
      ...('capUsd' in sizing && { currentNotionalUsd: Math.round(currentNotionalUsd * 100) / 100, capUsd: sizing.capUsd }),
      reasons: perf.reasons,
      statsLookup: statsLookup.status,
      ignoredSizeArg: ignoredSizeArg ?? null,
    },
    manual: mimicMetaArg === null,
    // Trader's baseShortId (for /dex/trade watch entries) — null for a manual trade
    sourceBaseShortId: mimicMetaArg?.sourcePaperTradeBaseShortId ?? null,
    clientTxId,
    cloid,
    qtyBefore,
    hlResult: orderResult,
    ...(orderError && { orderError }),
    ...(pending.settled.length && { settledPendingOrders: pending.settled }),
    ...(reconcile.reconciled.length && { reconciledEntryIds: reconcile.reconciled }),
  };

  if (filled === null) {
    // Neither the response nor HL says what happened. The ledger keeps the order
    // pending; the next trade/close in this coin settles it before doing anything.
    return {
      status: 'unknown' as const,
      ...base,
      filledQty: null,
      positionRecordId: null,
      ledger: { entryId: begun.entryId, copyQty: null, error: `order ${cloid} unsettled — the next ${coin} trade/close settles it` },
      qtyAfter: null,
      invoResult: null,
    };
  }

  // Fill comes from the order itself, so other activity in the coin can't be counted as this copy
  const filledQty = roundQty(filled, szDecimals);

  // Snapshot position after (informational; also sent to Invo)
  let qtyAfter: string;
  try {
    qtyAfter = (await hl.getPositions()).find(p => p.coin === coin)?.szi ?? '0';
  } catch {
    qtyAfter = String(roundQty(existingSzi + (isBuy ? filledQty : -filledQty), szDecimals));
  }

  // Record on Invo (non-fatal if it fails — position is open on HL regardless).
  // Nothing filled → nothing to record.
  let invoResult: any = null;
  if (filledQty > 0) {
    try {
      invoResult = await invo.recordOpen({
        clientTxId,
        coin,
        assetIndex,
        entry: {
          side: isBuy ? 'long' : 'short',
          marginMode: 'isolated',
          leverage,
          tpPx: null,
          slPx: null,
        },
        submission: {
          hlOrder: orderResult,
          nonceMs,
          hlResponse: orderResult,
        },
        summary: {
          qtyBefore,
          qtyAfter,
          intendedLeverage: leverage,
        },
        ...(mimicMetaArg && { mimicMeta: mimicMetaArg }),
      });
    } catch (e: any) {
      invoResult = { error: e.message };
    }
  }
  const positionRecordId: string | null = invoResult?.positionRecordId ?? null;

  // Settle the pending order: record what filled against the trader we copied,
  // so only their close signal closes it
  let ledger: { entryId: string | null; copyQty: number | null; error?: string };
  try {
    const entries = settleOrder(begun.entries, begun.entryId, filledQty, szDecimals, now().toISOString(), positionRecordId);
    deps.ledger.save(entries);
    const entry = entries.find(e => e.id === begun.entryId);
    ledger = filledQty > 0
      ? { entryId: begun.entryId, copyQty: entry!.qty }
      : { entryId: null, copyQty: null, error: 'no fill — nothing recorded' };
  } catch (e: any) {
    ledger = { entryId: begun.entryId, copyQty: null, error: `ledger write failed: ${e.message} — the order stays pending; the next ${coin} trade/close settles it` };
  }

  return {
    status: filledQty > 0 ? ('filled' as const) : ('not_filled' as const),
    ...base,
    filledQty,
    // Invo's record of our copy. /dex/position/create returns no baseShortId of ours.
    positionRecordId,
    ledger,
    qtyAfter,
    invoResult,
  };
}
