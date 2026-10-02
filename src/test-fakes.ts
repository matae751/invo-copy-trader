// In-memory stand-ins for Hyperliquid, Invo and the copy ledger, shared by
// trade-exec / close-exec tests. Nothing here touches the network or disk.

import type { CopyEntry, LedgerStore } from './copy-ledger.js';
import type { HlMeta, TradeHl, TradeInvo } from './trade-exec.js';

export class MemoryLedgerStore implements LedgerStore {
  entries: CopyEntry[];
  saves = 0;
  failLoad = false;
  failSave = false;

  constructor(initial: CopyEntry[] = []) {
    this.entries = structuredClone(initial);
  }
  load(): CopyEntry[] {
    if (this.failLoad) throw new Error('Copy ledger is unreadable: boom');
    return structuredClone(this.entries);
  }
  save(entries: CopyEntry[]): void {
    if (this.failSave) throw new Error('disk full');
    this.saves++;
    this.entries = structuredClone(entries);
  }
}

export const UNIVERSE: HlMeta['universe'] = [
  { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
  { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
  { name: 'SOL', szDecimals: 2, maxLeverage: 20 },
];

/** Fake HL: positions are signed coin sizes; orders fill `fillRatio` of their size. */
export function fakeHl(opts: { positions?: Record<string, number>; mids?: Record<string, number>; fillRatio?: number } = {}) {
  const positions: Record<string, number> = { ...opts.positions };
  const mids = { SOL: 100, BTC: 60000, ETH: 3000, ...opts.mids };
  const calls: string[] = [];
  const orders: { coin: string; isBuy: boolean; size: string; slippagePct: number; midPx: number }[] = [];
  const leverage: [string, number][] = [];

  const hl: TradeHl & { calls: string[]; orders: typeof orders; leverage: typeof leverage; positions: typeof positions } = {
    calls, orders, leverage, positions,
    async connect() { calls.push('connect'); },
    async getMeta() { calls.push('getMeta'); return { universe: UNIVERSE }; },
    async getAllMids() { calls.push('getAllMids'); return Object.fromEntries(Object.entries(mids).map(([k, v]) => [k, String(v)])); },
    async getPositions() {
      calls.push('getPositions');
      return Object.entries(positions).filter(([, v]) => v !== 0).map(([coin, v]) => ({ coin, szi: String(v) }));
    },
    async setLeverage(coin, lev) { calls.push('setLeverage'); leverage.push([coin, lev]); },
    async placeMarketOrder(coin, isBuy, size, slippagePct, midPx) {
      calls.push('placeMarketOrder');
      orders.push({ coin, isBuy, size, slippagePct, midPx });
      const filled = parseFloat(size) * (opts.fillRatio ?? 1);
      positions[coin] = Number(((positions[coin] ?? 0) + (isBuy ? filled : -filled)).toFixed(8));
      return { status: 'ok', response: { type: 'order' } };
    },
  };
  return hl;
}

/** Fake Invo: trader stats lookups + recordOpen. */
export function fakeInvo(opts: { failRecordOpen?: boolean } = {}) {
  const calls: string[] = [];
  const recorded: any[] = [];
  let n = 0;
  const invo: TradeInvo & { calls: string[]; recorded: any[] } = {
    calls, recorded,
    async getUserPortfolios(userId) {
      calls.push(`getUserPortfolios:${userId}`);
      return { portfolios: [{ id: `p-${userId}`, ownerId: userId }] };
    },
    async getPortfolioById(portfolioId) {
      calls.push(`getPortfolioById:${portfolioId}`);
      const ownerId = portfolioId.replace(/^p-/, '');
      return {
        success: true, error: null,
        portfolio: { id: portfolioId, ownerId, winRate: 92, wonPositions: 184, lostPositions: 16, currentWinStreak: 14, percentChange: 1200, liquidated: false },
      };
    },
    async recordOpen(payload) {
      calls.push('recordOpen');
      recorded.push(structuredClone(payload));
      if (opts.failRecordOpen) throw new Error('Invo /dex/position/create 500');
      return { positionRecordId: `rec-${++n}`, eventId: `evt-${n}`, cloids: [], oids: [] };
    },
  };
  return invo;
}

/** A signal's mimicMeta for `trader`'s trade `trade` (portfolio p-<trader>). */
export const signalMeta = (trader: string, trade: string) => ({
  portfolioId: `p-${trader}`,
  creatorInvoUserId: trader,
  initialSourcePaperUpdateId: `upd-${trade}`,
  sourcePaperTradeBaseId: `base-${trade}`,
  sourcePaperTradeBaseShortId: `short-${trade}`,
});

/** A ledger entry copying `trader`'s trade `trade` (null trader = manual). */
export function copyEntry(id: string, coin: string, qty: number, trader: string | null, trade = id, side: 'long' | 'short' = 'long'): CopyEntry {
  const m = trader ? signalMeta(trader, trade) : null;
  return {
    id, coin, side, qty,
    source: m && {
      creatorInvoUserId: m.creatorInvoUserId,
      portfolioId: m.portfolioId,
      sourcePaperTradeBaseId: m.sourcePaperTradeBaseId,
      sourcePaperTradeBaseShortId: m.sourcePaperTradeBaseShortId,
    },
    positionRecordIds: [],
    status: 'open',
    openedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}
