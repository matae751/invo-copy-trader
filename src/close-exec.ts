// Close a copied position: the logic behind commands/close.ts.
//
// A close signal closes only the copy it refers to — the ledger entry for the
// same trader's same trade in that coin — and only that copy's quantity, so
// other traders' copies and manual trades in the same coin are untouched.
// Anything that can't be matched is refused before Hyperliquid is touched.
// `manual` (explicit user request only) closes the whole coin position.

import { SLIPPAGE_PCT } from './sizing.js';
import {
  parseCloseIdentity,
  findCopyToClose,
  planCopyClose,
  applyCopyClose,
  closeAllInCoin,
  floorQty,
  qtyEpsilon,
  roundQty,
  type CloseIdentity,
  type CopyEntry,
  type LedgerStore,
} from './copy-ledger.js';
import { UsageError, type ExecHl } from './trade-exec.js';

export const MANUAL_CLOSE_ARG = 'manual';
export const CLOSE_USAGE = `Usage: close <coin> <close signal mimicMeta JSON | ${MANUAL_CLOSE_ARG}>`;

export interface CloseDeps {
  hl: ExecHl;
  ledger: LedgerStore;
  now?: () => Date;
}

export type CloseResult =
  | { status: 'refused'; coin: string; reason: string; entryId?: string }
  | {
      status: 'closed' | 'partial' | 'not_filled';
      coin: string;
      mode: 'signal' | 'manual';
      entryId: string | null;
      trader: string | null;
      requestedQty: number;
      closedQty: number;
      copyQtyLeft: number | null;
      qtyBefore: string;
      qtyAfter: string;
      hlResult: any;
      ledgerError?: string;
    };

const refuse = (coin: string, reason: string, entryId?: string): CloseResult =>
  ({ status: 'refused', coin, reason, ...(entryId && { entryId }) });

/** Coin's signed position size (0 when flat). */
async function positionSzi(hl: ExecHl, coin: string): Promise<{ szi: number; raw: string }> {
  const pos = (await hl.getPositions()).find(p => p.coin === coin);
  return { szi: pos ? parseFloat(pos.szi) : 0, raw: pos ? pos.szi : '0' };
}

async function szDecimalsFor(hl: ExecHl, coin: string): Promise<number> {
  const asset = (await hl.getMeta()).universe.find(a => a.name === coin);
  if (!asset) throw new Error(`Unknown coin: ${coin}`);
  return asset.szDecimals;
}

async function midFor(hl: ExecHl, coin: string): Promise<number> {
  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);
  return mid;
}

/** How much the position shrank (never negative). */
const reducedBy = (before: number, after: number, szDecimals: number) =>
  Math.max(0, roundQty(Math.abs(before) - (Math.sign(after) === Math.sign(before) ? Math.abs(after) : 0), szDecimals));

export async function runClose(args: string[], deps: CloseDeps): Promise<CloseResult> {
  const [coin, identityArg] = args;
  if (!coin) throw new UsageError(CLOSE_USAGE);
  const now = deps.now ?? (() => new Date());

  if (identityArg === MANUAL_CLOSE_ARG) return manualClose(coin, deps, now);

  // --- Everything below is checked before Hyperliquid is touched ---
  if (!identityArg?.trim()) {
    return refuse(coin, `no close identity: pass the close signal's mimicMeta (or '${MANUAL_CLOSE_ARG}' on explicit user request)`);
  }
  let identity: CloseIdentity;
  try {
    identity = parseCloseIdentity(JSON.parse(identityArg));
  } catch (e: any) {
    return refuse(coin, e instanceof SyntaxError ? 'close identity is not valid JSON' : e.message);
  }

  let entries: CopyEntry[];
  try {
    entries = deps.ledger.load();
  } catch (e: any) {
    return refuse(coin, e.message);
  }
  const match = findCopyToClose(entries, coin, identity);
  if (match.kind === 'refuse') return refuse(coin, match.reason);
  const entry = match.entry;

  // --- Matched: check the live position agrees with the ledger, then close only this copy ---
  await deps.hl.connect();
  const szDecimals = await szDecimalsFor(deps.hl, coin);
  const before = await positionSzi(deps.hl, coin);
  const plan = planCopyClose(entry, entries, before.szi, szDecimals);
  if (plan.kind === 'refuse') return refuse(coin, plan.reason, entry.id);

  const mid = await midFor(deps.hl, coin);
  const hlResult = await deps.hl.placeMarketOrder(coin, !plan.isLong, plan.qty.toFixed(szDecimals), SLIPPAGE_PCT, mid);
  const after = await positionSzi(deps.hl, coin);
  // Never credit this copy with more than was asked of it
  const closedQty = Math.min(plan.qty, reducedBy(before.szi, after.szi, szDecimals));
  // This copy was the whole position and it's now flat: nothing of it is left, even if the
  // position had shrunk below the ledger's qty beforehand
  const flat = Math.abs(after.szi) < qtyEpsilon(szDecimals);
  const ledgerQty = plan.full && flat ? entry.qty : closedQty;

  let ledgerError: string | undefined;
  let copyQtyLeft: number | null = entry.qty;
  if (ledgerQty > 0) {
    try {
      const next = applyCopyClose(entries, entry.id, ledgerQty, szDecimals, now().toISOString());
      deps.ledger.save(next);
      copyQtyLeft = next.find(e => e.id === entry.id)!.qty;
    } catch (e: any) {
      ledgerError = `ledger write failed: ${e.message}`;
      copyQtyLeft = null;
    }
  }

  return {
    status: closedQty <= 0 ? 'not_filled' : closedQty < plan.qty - qtyEpsilon(szDecimals) ? 'partial' : 'closed',
    coin,
    mode: 'signal',
    entryId: entry.id,
    trader: entry.source!.creatorInvoUserId,
    requestedQty: plan.qty,
    closedQty,
    copyQtyLeft,
    qtyBefore: before.raw,
    qtyAfter: after.raw,
    hlResult,
    ...(ledgerError && { ledgerError }),
  };
}

/** Explicit user request: flatten the whole coin position, whoever it belongs to. */
async function manualClose(coin: string, deps: CloseDeps, now: () => Date): Promise<CloseResult> {
  let entries: CopyEntry[];
  try {
    entries = deps.ledger.load();
  } catch (e: any) {
    return refuse(coin, e.message);
  }

  await deps.hl.connect();
  const szDecimals = await szDecimalsFor(deps.hl, coin);
  const before = await positionSzi(deps.hl, coin);
  const qty = floorQty(Math.abs(before.szi), szDecimals);
  if (qty < qtyEpsilon(szDecimals)) return refuse(coin, `no open ${coin} position on Hyperliquid`);

  const mid = await midFor(deps.hl, coin);
  const hlResult = await deps.hl.placeMarketOrder(coin, !(before.szi > 0), qty.toFixed(szDecimals), SLIPPAGE_PCT, mid);
  const after = await positionSzi(deps.hl, coin);
  const closedQty = reducedBy(before.szi, after.szi, szDecimals);
  const flat = Math.abs(after.szi) < qtyEpsilon(szDecimals);

  let ledgerError: string | undefined;
  if (flat) {
    try {
      deps.ledger.save(closeAllInCoin(entries, coin, now().toISOString()));
    } catch (e: any) {
      ledgerError = `ledger write failed: ${e.message}`;
    }
  }

  return {
    status: closedQty <= 0 ? 'not_filled' : flat ? 'closed' : 'partial',
    coin,
    mode: 'manual',
    entryId: null,
    trader: null,
    requestedQty: qty,
    closedQty,
    copyQtyLeft: null,
    qtyBefore: before.raw,
    qtyAfter: after.raw,
    hlResult,
    ...(ledgerError && { ledgerError }),
  };
}
