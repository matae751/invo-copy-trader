import { Hyperliquid } from 'hyperliquid';
import { limitPrice } from './sizing.js';
import { timeoutSignal, withTimeout } from './timeout.js';

const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };

// SDK expects "SOL-PERP" format; REST API uses "SOL"
function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;

export async function connect(agentKey: string, walletAddress: string): Promise<Hyperliquid> {
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    enableWs: false,
  });
  await withTimeout(sdk.connect(), 'Hyperliquid connect');
  return sdk;
}

export function getSdk(): Hyperliquid {
  if (!sdk) throw new Error('HL SDK not connected. Call connect() first.');
  return sdk;
}

export async function getMeta() {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'meta' }),
  });
  return (await resp.json()) as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
}

export async function getAllMids(): Promise<Record<string, string>> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'allMids' }),
  });
  return await resp.json();
}

/** Open positions, as clearinghouseState reports them (incl. coin, szi, leverage: { type, value }). */
export async function getPositions(wallet: string): Promise<{ coin: string; szi: string; leverage?: { type?: string; value?: number } }[]> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
  });
  const data = await resp.json();
  return data.assetPositions
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return withTimeout(s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage), `updateLeverage ${coin}`);
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct: number,
  midPx: number, // the price the size was computed from
  szDecimals: number, // the asset's, so the limit price meets HL's decimal rule
  reduceOnly: boolean, // closes pass true: the order can only shrink the position, never flip it
  cloid?: string, // client order id, so the order can be looked up if we lose its response
) {
  if (!(midPx > 0)) throw new Error(`No mid price for ${coin}`);

  // Same function sizing.ts bounds fills against
  const limitPx = limitPrice(midPx, isBuy, szDecimals, slippagePct).toString();

  const s = getSdk();
  return withTimeout(s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: parseFloat(limitPx),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: reduceOnly,
    grouping: 'na',
    builder: INVO_BUILDER,
    ...(cloid && { cloid }),
  }), `placeOrder ${coin}`);
}

/**
 * How much an order filled, looked up by its client order id (info `orderStatus`).
 * known: false when HL has no such order — it never reached the exchange.
 * Throws on anything it can't read, so callers fail closed.
 */
export async function getOrderFill(wallet: string, cloid: string): Promise<{ known: boolean; filledQty: number }> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'orderStatus', user: wallet, oid: cloid }),
  });
  if (!resp.ok) throw new Error(`orderStatus ${cloid}: HTTP ${resp.status}`);
  const data: any = await resp.json();
  if (data?.status === 'unknownOid') return { known: false, filledQty: 0 };
  // { status: 'order', order: { order: { origSz, sz (unfilled remainder), ... }, status } }
  const origSz = parseFloat(data?.order?.order?.origSz);
  const left = parseFloat(data?.order?.order?.sz);
  if (data?.status !== 'order' || !Number.isFinite(origSz) || !Number.isFinite(left)) {
    throw new Error(`orderStatus ${cloid}: unrecognised response ${JSON.stringify(data)?.slice(0, 200)}`);
  }
  return { known: true, filledQty: Math.max(0, origSz - left) };
}

export { INVO_BUILDER };
