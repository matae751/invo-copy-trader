// Ledger of positions we opened by copying a trader. Hyperliquid nets every
// fill in a coin into one position, so this is the only record of which trader
// (and which of their trades) each part of that position belongs to. close.ts
// uses it to close exactly the copy a close signal refers to — never another
// trader's copy, a manual trade, or anything it didn't open.
//
// Pure functions + a small store interface, so the logic is testable without
// touching disk, Invo or Hyperliquid.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type Side = 'long' | 'short';

/** The copied trader's trade (from the signal's mimicMeta). null = manual trade. */
export interface CopySource {
  creatorInvoUserId: string;
  portfolioId: string;
  sourcePaperTradeBaseId: string;
  sourcePaperTradeBaseShortId: string;
}

export interface CopyEntry {
  id: string; // clientTxId of the opening trade
  coin: string;
  side: Side;
  /** Coin units of our HL position attributed to this copy. */
  qty: number;
  source: CopySource | null;
  positionRecordIds: string[];
  status: 'open' | 'closed';
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface LedgerStore {
  /** Throws if the ledger exists but can't be read — callers fail closed. */
  load(): CopyEntry[];
  save(entries: CopyEntry[]): void;
}

export function defaultLedgerPath(): string {
  return process.env.COPY_LEDGER_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'copy-ledger.json');
}

export class FileLedgerStore implements LedgerStore {
  constructor(readonly path: string) {}

  load(): CopyEntry[] {
    if (!existsSync(this.path)) return [];
    let data: any;
    try {
      data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e: any) {
      throw new Error(`Copy ledger ${this.path} is unreadable: ${e.message}`);
    }
    if (!Array.isArray(data?.entries)) throw new Error(`Copy ledger ${this.path} is malformed (no entries array)`);
    return data.entries;
  }

  save(entries: CopyEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written ledger
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    renameSync(tmp, this.path);
  }
}

// --- Quantities ---

/** Half a lot: anything smaller is zero at this asset's precision. */
export const qtyEpsilon = (szDecimals: number) => 0.5 * 10 ** -szDecimals;
export const roundQty = (x: number, szDecimals: number) => Number(x.toFixed(szDecimals));
/** Round down to the lot size, so a close never exceeds what we hold. */
export const floorQty = (x: number, szDecimals: number) =>
  Math.floor(x * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;

// --- Opening ---

export interface CopyOpen {
  id: string;
  coin: string;
  side: Side;
  qty: number; // filled coin units
  szDecimals: number;
  source: CopySource | null;
  positionRecordId: string | null;
  now: string;
}

/**
 * Record a fill. A further fill on the same trader's same trade (an increase)
 * adds to that copy; anything else — another trader, another trade of theirs,
 * a manual trade — is its own entry.
 */
export function recordCopyOpen(entries: CopyEntry[], open: CopyOpen): { entries: CopyEntry[]; entry: CopyEntry } {
  const existing = open.source
    ? entries.find(e =>
        e.status === 'open' &&
        e.coin === open.coin &&
        e.side === open.side &&
        e.source?.creatorInvoUserId === open.source!.creatorInvoUserId &&
        e.source?.sourcePaperTradeBaseId === open.source!.sourcePaperTradeBaseId)
    : undefined;

  if (existing) {
    const entry: CopyEntry = {
      ...existing,
      qty: roundQty(existing.qty + open.qty, open.szDecimals),
      positionRecordIds: open.positionRecordId ? [...existing.positionRecordIds, open.positionRecordId] : existing.positionRecordIds,
      updatedAt: open.now,
    };
    return { entries: entries.map(e => (e.id === existing.id ? entry : e)), entry };
  }

  const entry: CopyEntry = {
    id: open.id,
    coin: open.coin,
    side: open.side,
    qty: roundQty(open.qty, open.szDecimals),
    source: open.source,
    positionRecordIds: open.positionRecordId ? [open.positionRecordId] : [],
    status: 'open',
    openedAt: open.now,
    updatedAt: open.now,
  };
  return { entries: [...entries, entry], entry };
}

// --- Closing ---

/** Who a close signal is from: the trader plus at least one ID of their trade. */
export interface CloseIdentity {
  creatorInvoUserId: string;
  sourcePaperTradeBaseId?: string;
  sourcePaperTradeBaseShortId?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** From a close signal's mimicMeta. Throws unless the trader and their trade are identified. */
export function parseCloseIdentity(raw: unknown): CloseIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('close identity must be the signal\'s mimicMeta object');
  const o = raw as Record<string, unknown>;
  if (!nonEmpty(o.creatorInvoUserId)) throw new Error('close signal has no trader id (creatorInvoUserId)');
  const baseId = nonEmpty(o.sourcePaperTradeBaseId) ? o.sourcePaperTradeBaseId.trim() : undefined;
  const baseShortId = nonEmpty(o.sourcePaperTradeBaseShortId) ? o.sourcePaperTradeBaseShortId.trim() : undefined;
  if (!baseId && !baseShortId) throw new Error('close signal has no trade id (sourcePaperTradeBaseId / sourcePaperTradeBaseShortId)');
  return { creatorInvoUserId: o.creatorInvoUserId.trim(), sourcePaperTradeBaseId: baseId, sourcePaperTradeBaseShortId: baseShortId };
}

export type CopyMatch = { kind: 'match'; entry: CopyEntry } | { kind: 'refuse'; reason: string };

/**
 * The open copy a close signal refers to: same coin, same trader, same trade.
 * Every trade ID the signal carries must agree. Manual entries never match.
 */
export function findCopyToClose(entries: CopyEntry[], coin: string, id: CloseIdentity): CopyMatch {
  const matches = entries.filter(e =>
    e.status === 'open' &&
    e.coin === coin &&
    e.source !== null &&
    e.source.creatorInvoUserId === id.creatorInvoUserId &&
    (id.sourcePaperTradeBaseId === undefined || e.source.sourcePaperTradeBaseId === id.sourcePaperTradeBaseId) &&
    (id.sourcePaperTradeBaseShortId === undefined || e.source.sourcePaperTradeBaseShortId === id.sourcePaperTradeBaseShortId));

  if (matches.length === 1) return { kind: 'match', entry: matches[0] };
  if (matches.length > 1) return { kind: 'refuse', reason: `${matches.length} open ${coin} copies match this signal — ledger is ambiguous, close manually` };
  return { kind: 'refuse', reason: `no open ${coin} copy of trader ${id.creatorInvoUserId}'s trade ${id.sourcePaperTradeBaseId ?? id.sourcePaperTradeBaseShortId} in the ledger` };
}

export type ClosePlan =
  | { kind: 'close'; qty: number; isLong: boolean; full: boolean }
  | { kind: 'refuse'; reason: string };

/**
 * How much of the HL position to close for `entry`: its own quantity, never
 * other copies'. Refuses when the position doesn't match what the ledger says.
 */
export function planCopyClose(entry: CopyEntry, entries: CopyEntry[], positionSzi: number, szDecimals: number): ClosePlan {
  const eps = qtyEpsilon(szDecimals);
  const posQty = Math.abs(positionSzi);
  if (!Number.isFinite(positionSzi) || posQty < eps) {
    return { kind: 'refuse', reason: `no open ${entry.coin} position on Hyperliquid (ledger expected ${entry.qty})` };
  }
  const isLong = positionSzi > 0;
  if ((entry.side === 'long') !== isLong) {
    return { kind: 'refuse', reason: `${entry.coin} position is ${isLong ? 'long' : 'short'} but the copy is ${entry.side}` };
  }

  const othersQty = entries
    .filter(e => e.status === 'open' && e.coin === entry.coin && e.id !== entry.id)
    .reduce((sum, e) => sum + e.qty, 0);
  if (othersQty > eps && posQty < entry.qty + othersQty - eps) {
    // Something reduced the position outside the ledger; we can't tell whose share is gone
    return {
      kind: 'refuse',
      reason: `${entry.coin} position (${posQty}) is smaller than the copies tracked in it (${roundQty(entry.qty + othersQty, szDecimals)}) — close manually`,
    };
  }

  const qty = floorQty(Math.min(entry.qty, posQty), szDecimals);
  if (qty < eps) return { kind: 'refuse', reason: `copy quantity ${entry.qty} rounds to zero at ${szDecimals} decimals` };
  return { kind: 'close', qty, isLong, full: qty >= posQty - eps };
}

/** Take `closedQty` off the entry; it is closed once nothing is left. */
export function applyCopyClose(entries: CopyEntry[], entryId: string, closedQty: number, szDecimals: number, now: string): CopyEntry[] {
  return entries.map(e => {
    if (e.id !== entryId) return e;
    const left = roundQty(e.qty - closedQty, szDecimals);
    if (left < qtyEpsilon(szDecimals)) return { ...e, qty: 0, status: 'closed', updatedAt: now, closedAt: now };
    return { ...e, qty: left, updatedAt: now };
  });
}

/** After an explicit manual full close: every open entry in the coin is gone. */
export function closeAllInCoin(entries: CopyEntry[], coin: string, now: string): CopyEntry[] {
  return entries.map(e =>
    e.status === 'open' && e.coin === coin ? { ...e, qty: 0, status: 'closed', updatedAt: now, closedAt: now } : e);
}
