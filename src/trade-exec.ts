// Open (or increase) a position: the logic behind commands/trade.ts.
// Hyperliquid, Invo and the copy ledger are injected so this is testable
// without network access or the HL SDK.

import { randomUUID } from 'crypto';
import type { RecordOpenPayload } from './invo-client.js';
import { classifyTrader, sizeInitial, sizeIncrease, SLIPPAGE_PCT } from './sizing.js';
import { getTraderStats, type TraderStatsClient } from './trader-stats.js';
import { parseMimicMetaArg, MANUAL_TRADE_ARG } from './mimic-meta.js';
import { parseLeverageArg, checkLeverage } from './leverage.js';
import { recordCopyOpen, roundQty, type LedgerStore } from './copy-ledger.js';

export interface HlMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
}

/** The Hyperliquid calls trade/close need, bound to our wallet. */
export interface ExecHl {
  connect(): Promise<unknown>;
  getMeta(): Promise<HlMeta>;
  getAllMids(): Promise<Record<string, string>>;
  getPositions(): Promise<{ coin: string; szi: string }[]>;
  placeMarketOrder(coin: string, isBuy: boolean, size: string, slippagePct: number, midPx: number): Promise<any>;
}

export interface TradeHl extends ExecHl {
  setLeverage(coin: string, leverage: number): Promise<unknown>;
}

export interface TradeInvo extends TraderStatsClient {
  recordOpen(payload: RecordOpenPayload): Promise<any>;
}

export interface TradeDeps {
  hl: TradeHl;
  invo: TradeInvo;
  ledger: LedgerStore;
  newId?: () => string;
  now?: () => Date;
}

export class UsageError extends Error {}

export const TRADE_USAGE =
  `Usage: trade <coin> <long|short> <size (ignored — computed from trader performance)> <leverage> <mimicMetaJson | ${MANUAL_TRADE_ARG}>`;

export async function runTrade(args: string[], deps: TradeDeps) {
  const { hl, invo } = deps;
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  // <size> is kept for argument-position compatibility but ignored: size is computed here
  const [coin, side, ignoredSizeArg, leverageStr, mimicMetaJson] = args;
  if (!coin || (side !== 'long' && side !== 'short')) throw new UsageError(TRADE_USAGE);

  const isBuy = side === 'long';
  const leverage = parseLeverageArg(leverageStr);
  // Validated before touching HL: a copy must carry the trader's trade IDs (incl. their baseShortId).
  // null = explicit manual trade (no mimicMeta sent)
  const mimicMetaArg = parseMimicMetaArg(mimicMetaJson);
  // Read the ledger before trading: a copy we can't record could never be closed by its trader's signal
  const ledgerEntries = deps.ledger.load();

  await hl.connect();

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);
  const { szDecimals, maxLeverage } = meta.universe[assetIndex];
  checkLeverage(leverage, coin, maxLeverage);

  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  // Snapshot position before
  const posBefore = await hl.getPositions();
  const existing = posBefore.find(p => p.coin === coin);
  const qtyBefore = existing ? existing.szi : '0';
  const existingSzi = parseFloat(qtyBefore);

  if (existingSzi !== 0 && (existingSzi > 0) !== isBuy) {
    throw new Error(`Refusing ${side} ${coin}: existing position is ${existingSzi > 0 ? 'long' : 'short'} ${Math.abs(existingSzi)}`);
  }

  // Size: initial copy → $40-$78.40 by tier; increase → tier target capped at 80% of current notional.
  // Bounds hold at the worst-case fill (mid ± SLIPPAGE_PCT), not just at mid.
  // Stats null on any lookup failure → poor tier ($40)
  const statsLookup = await getTraderStats(invo, mimicMetaArg);
  const perf = classifyTrader(statsLookup.stats);
  const isIncrease = existingSzi !== 0;
  const currentNotionalUsd = Math.abs(existingSzi) * mid;
  const sizing = isIncrease
    ? sizeIncrease(perf.notionalUsd, currentNotionalUsd, mid, szDecimals, isBuy, SLIPPAGE_PCT)
    : sizeInitial(perf.notionalUsd, mid, szDecimals, isBuy, SLIPPAGE_PCT);
  const sizeStr = sizing.qty;

  // Set leverage
  await hl.setLeverage(coin, leverage);

  // Place order on HL
  const nonceMs = now().getTime();
  const orderResult = await hl.placeMarketOrder(coin, isBuy, sizeStr, SLIPPAGE_PCT, mid);

  // Snapshot position after
  const posAfter = await hl.getPositions();
  const updated = posAfter.find(p => p.coin === coin);
  const qtyAfter = updated ? updated.szi : '0';

  const clientTxId = newId();

  // Record on Invo (non-fatal if it fails — position is open on HL regardless)
  let invoResult: any = null;
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
  const positionRecordId: string | null = invoResult?.positionRecordId ?? null;

  // Record what actually filled against the trader we copied, so only their close signal closes it
  const filledQty = roundQty(Math.max(0, Math.abs(parseFloat(qtyAfter)) - Math.abs(existingSzi)), szDecimals);
  let ledger: { entryId: string | null; copyQty: number | null; error?: string };
  if (filledQty <= 0) {
    ledger = { entryId: null, copyQty: null, error: 'no fill — nothing recorded' };
  } else {
    try {
      const { entries, entry } = recordCopyOpen(ledgerEntries, {
        id: clientTxId,
        coin,
        side,
        qty: filledQty,
        szDecimals,
        source: mimicMetaArg && {
          creatorInvoUserId: mimicMetaArg.creatorInvoUserId,
          portfolioId: mimicMetaArg.portfolioId,
          sourcePaperTradeBaseId: mimicMetaArg.sourcePaperTradeBaseId,
          sourcePaperTradeBaseShortId: mimicMetaArg.sourcePaperTradeBaseShortId,
        },
        positionRecordId,
        now: now().toISOString(),
      });
      deps.ledger.save(entries);
      ledger = { entryId: entry.id, copyQty: entry.qty };
    } catch (e: any) {
      ledger = { entryId: null, copyQty: null, error: `ledger write failed: ${e.message}` };
    }
  }

  return {
    status: 'filled',
    coin,
    side,
    size: sizeStr,
    leverage,
    sizing: {
      mode: isIncrease ? 'increase' : 'initial',
      tier: perf.tier,
      targetUsd: perf.notionalUsd,
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
    // Invo's record of our copy. /dex/position/create returns no baseShortId of ours.
    positionRecordId,
    filledQty,
    ledger,
    clientTxId,
    qtyBefore,
    qtyAfter,
    hlResult: orderResult,
    invoResult,
  };
}
