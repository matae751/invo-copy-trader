import { randomUUID, randomBytes } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { classifyTrader, sizeInitial, sizeIncrease, SLIPPAGE_PCT, type TraderStats } from '../sizing.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

function genBaseShortId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = randomBytes(10);
  let id = '';
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

// Look up the copied trader's portfolio stats (same endpoint discover.ts uses).
// Returns null on any failure — classifyTrader treats that as the poor tier ($40).
async function fetchTraderStats(mimicMeta: any): Promise<TraderStats | null> {
  if (!mimicMeta?.creatorInvoUserId || !mimicMeta?.portfolioId) return null;
  try {
    const data = await invo.discoverTraders('user', 1, 50, mimicMeta.creatorInvoUserId);
    return (data.items ?? []).find((p: any) => p.id === mimicMeta.portfolioId) ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // <size> is kept for argument-position compatibility but ignored: size is computed here
  const [coin, side, ignoredSizeArg, leverageStr, mimicMetaJson] = process.argv.slice(2);

  if (!coin || (side !== 'long' && side !== 'short')) {
    console.error('Usage: trade <coin> <long|short> <size (ignored — computed from trader performance)> [leverage] [mimicMetaJson]');
    process.exit(1);
  }

  const isBuy = side === 'long';
  const leverage = parseInt(leverageStr ?? '1', 10);
  const mimicMetaArg = mimicMetaJson ? JSON.parse(mimicMetaJson) : null;

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);
  const { szDecimals } = meta.universe[assetIndex];

  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  // Snapshot position before
  const posBefore = await hl.getPositions(WALLET_ADDRESS);
  const existing = posBefore.find((p: any) => p.coin === coin);
  const qtyBefore = existing ? existing.szi : '0';
  const existingSzi = parseFloat(qtyBefore);

  if (existingSzi !== 0 && (existingSzi > 0) !== isBuy) {
    throw new Error(`Refusing ${side} ${coin}: existing position is ${existingSzi > 0 ? 'long' : 'short'} ${Math.abs(existingSzi)}`);
  }

  // Size: initial copy → $40-$78.40 by tier; increase → tier target capped at 80% of current notional.
  // Bounds hold at the worst-case fill (mid ± SLIPPAGE_PCT), not just at mid.
  const perf = classifyTrader(await fetchTraderStats(mimicMetaArg));
  const isIncrease = existingSzi !== 0;
  const currentNotionalUsd = Math.abs(existingSzi) * mid;
  const sizing = isIncrease
    ? sizeIncrease(perf.notionalUsd, currentNotionalUsd, mid, szDecimals, isBuy, SLIPPAGE_PCT)
    : sizeInitial(perf.notionalUsd, mid, szDecimals, isBuy, SLIPPAGE_PCT);
  const sizeStr = sizing.qty;

  // Set leverage
  await hl.setLeverage(coin, leverage);

  // Place order on HL
  const nonceMs = Date.now();
  const orderResult = await hl.placeMarketOrder(coin, isBuy, sizeStr, SLIPPAGE_PCT, mid);

  // Snapshot position after
  const posAfter = await hl.getPositions(WALLET_ADDRESS);
  const updated = posAfter.find((p: any) => p.coin === coin);
  const qtyAfter = updated ? updated.szi : '0';

  // IDs
  const baseShortId = genBaseShortId();
  const clientTxId = randomUUID();

  // Build mimicMeta (accept from arg or generate random UUIDs)
  const mimicMeta = mimicMetaArg ?? {
    portfolioId: randomUUID(),
    creatorInvoUserId: randomUUID(),
    initialSourcePaperUpdateId: randomUUID(),
    sourcePaperTradeBaseId: randomUUID(),
  };

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
      mimicMeta,
    });
  } catch (e: any) {
    invoResult = { error: e.message };
  }

  console.log(JSON.stringify({
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
      ignoredSizeArg: ignoredSizeArg ?? null,
    },
    baseShortId,
    clientTxId,
    qtyBefore,
    qtyAfter,
    hlResult: orderResult,
    invoResult,
  }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
