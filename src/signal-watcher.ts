// The monitor's polling loop, without the process around it: Invo, the
// followed-trader registry, the copy ledger and the saved state are injected,
// so it is testable without network or disk.
//
// What it guarantees, beyond filtering (following.ts classifyPost):
//  - Seen posts are saved between runs. A restart (e.g. after --wait-for-signal
//    exits) catches up on posts made while it was stopped instead of treating
//    them as old: closes always; opens/updates only if the gap was short
//    (maxCatchUpMs), since copying a stale entry is a trade at a stale price.
//  - The feed is paged back to the last post already seen, so a burst of more
//    than one page between polls isn't lost.
//  - Every open copy in the ledger is watched on /dex/trade, so its close is
//    seen even if the trader is unfollowed (their posts leave the feed).
//  - A close for a trade we copied gets through even from someone no longer
//    followed; close.ts only acts on it if the ledger matches.
//  - Every close seen is remembered (closedTrades, saved with the state). Each
//    poll, a close signal is sent for every remembered trade we still hold an
//    open copy of — so a copy opened just after its trader closed is still
//    closed, and a close that didn't complete (not filled, partial, unknown,
//    refused for a passing reason) is re-sent every closeRetryMs (90s), up to
//    maxCloseAttempts; then one close_stuck alert asks for the user.
//  - Opens/updates are only emitted if the post itself is recent (createdAt):
//    a newly followed trader's older posts appearing in the feed are not new trades.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyPost, type FollowedTrader } from './following.js';
import { mimicMetaFromUpdate } from './mimic-meta.js';
import type { CopyEntry } from './copy-ledger.js';

export interface WatchEntry {
  baseShortId: string;
  mimicStartedAt: string;
}

/** A trade its trader has closed, remembered so our copy of it keeps being closed until it is. */
export interface ClosedTrade {
  ownerId: string;
  baseId?: string;
  baseShortId?: string;
  coin?: string;
  closingPrice?: number | null;
  source: 'feed' | 'trade_poll';
  postId?: string;
  catchUp?: boolean;
  seenAt: number;
  /** Close signals sent for it so far, and when the last one was. */
  attempts: number;
  lastEmittedAt: number | null;
  gaveUp?: boolean;
}

export interface MonitorState {
  version: 1;
  seenPostIds: string[];
  seenTradeUpdates: string[];
  /** Absent in state saved before closes were remembered. */
  closedTrades?: ClosedTrade[];
  savedAt: number;
}

export interface StateStore {
  /** null when there is no saved state; throws if it can't be read. */
  load(): MonitorState | null;
  save(state: MonitorState): void;
}

export function defaultMonitorStatePath(): string {
  return process.env.MONITOR_STATE_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'monitor-state.json');
}

export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  load(): MonitorState | null {
    if (!existsSync(this.path)) return null;
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!Array.isArray(data?.seenPostIds) || !Array.isArray(data?.seenTradeUpdates) || typeof data?.savedAt !== 'number' ||
        (data.closedTrades !== undefined && !Array.isArray(data.closedTrades))) {
      throw new Error(`monitor state ${this.path} is malformed`);
    }
    return data;
  }

  save(state: MonitorState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path);
  }
}

export interface WatcherInvo {
  getFeed(filter: string, lastPostId: string | null, itemLimit: number): Promise<any>;
  getTradeUpdates(investments: WatchEntry[]): Promise<any>;
}

export interface WatcherRegistry {
  traders: FollowedTrader[];
  byUserId: Map<string, FollowedTrader>;
  refreshIfDue(): Promise<{ added: object[]; removed: object[] } | null>;
  refreshOnDemand(): Promise<{ added: object[]; removed: object[] } | null>;
  refreshPortfolios(userId: string): Promise<boolean>;
}

export interface WatcherOptions {
  invo: WatcherInvo;
  registry: WatcherRegistry;
  ledger: { load(): CopyEntry[] };
  state: StateStore;
  /** Extra /dex/trade watch entries from the command line. */
  watchEntries?: WatchEntry[];
  now?: () => number;
  /** Opens/updates missed while stopped are emitted only if the gap was at most this long. */
  maxCatchUpMs?: number;
  /** Opens/updates are emitted only if the post is at most this old. */
  maxSignalAgeMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** How many seen ids to keep. */
  maxSeen?: number;
  /** Re-send a close for a copy that is still open after this long. */
  closeRetryMs?: number;
  /** Close signals per trade before giving up with a close_stuck alert. */
  maxCloseAttempts?: number;
  /** How long a closed trade is remembered (for a copy that appears late). */
  closedTradeRetentionMs?: number;
}

export interface WatchEvent {
  stream: 'out' | 'err';
  data: Record<string, unknown>;
  /** A signal or trade update: ends --wait-for-signal. */
  signal?: boolean;
}

export const DEFAULT_MAX_CATCHUP_SEC = 300;
export const DEFAULT_MAX_SIGNAL_AGE_SEC = 300;
/**
 * Longer than MIN_SETTLE_AGE_MS (60s): a retry after an `unknown` close must find the
 * earlier order old enough to settle, or close.ts refuses it and the attempt is wasted.
 */
export const DEFAULT_CLOSE_RETRY_SEC = 90;
export const DEFAULT_MAX_CLOSE_ATTEMPTS = 10;
export const DEFAULT_CLOSED_TRADE_RETENTION_SEC = 24 * 3600;

interface TradeIds {
  ownerId: string;
  baseId?: string;
  baseShortId?: string;
}

/** Same trader, same trade: by baseId when both have one, else by baseShortId. */
export function sameTrade(a: TradeIds, b: TradeIds): boolean {
  if (a.ownerId !== b.ownerId) return false;
  if (a.baseId && b.baseId) return a.baseId === b.baseId;
  return !!a.baseShortId && a.baseShortId === b.baseShortId;
}

/**
 * Does a /dex/trade entry belong to this copy? Same trader (when the entry names
 * one) and same trade, by baseId or baseShortId.
 */
function isCopyOf(c: CopyEntry, t: Partial<TradeIds>): boolean {
  const src = c.source!;
  if (t.ownerId && t.ownerId !== src.creatorInvoUserId) return false;
  if (t.baseId && src.sourcePaperTradeBaseId) return t.baseId === src.sourcePaperTradeBaseId;
  return !!t.baseShortId && t.baseShortId === src.sourcePaperTradeBaseShortId;
}

/**
 * A /dex/trade update that means the trade is over: updateType "close" (seen
 * live), or one naming a liquidation (not seen yet — either way the position is
 * gone, and close.ts only acts on a copy it matches).
 */
export function isCloseUpdate(u: any): boolean {
  const type = typeof u?.updateType === 'string' ? u.updateType.toLowerCase() : '';
  return type === 'close' || type.includes('liquidat');
}

const copyIds = (c: CopyEntry): TradeIds => ({
  ownerId: c.source!.creatorInvoUserId,
  baseId: c.source!.sourcePaperTradeBaseId || undefined,
  baseShortId: c.source!.sourcePaperTradeBaseShortId || undefined,
});

/** When the post was made (ms), from post.createdAt (ISO string or epoch ms); null if absent/unreadable. */
export function postTime(post: any): number | null {
  const v = post?.createdAt;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

export class SignalWatcher {
  private seenPosts = new Set<string>();
  private seenTrade = new Set<string>();
  private closed: ClosedTrade[] = [];
  /** Closed trades first seen in the current poll. */
  private closedThisPoll = new Set<ClosedTrade>();
  private started = false;
  pollCount = 0;

  constructor(private o: WatcherOptions) {}

  private get now() { return (this.o.now ?? Date.now)(); }

  async poll(): Promise<WatchEvent[]> {
    const events: WatchEvent[] = [];
    const out = (data: Record<string, unknown>, signal = false) => events.push({ stream: 'out', data, ...(signal && { signal }) });
    const err = (data: Record<string, unknown>) => events.push({ stream: 'err', data });
    this.pollCount++;
    this.closedThisPoll.clear();

    // --- First poll of this process: pick up where the last run left off ---
    const first = !this.started;
    let fresh = false; // no saved state: index what's there, emit nothing old
    let gapMs = 0;
    if (first) {
      this.started = true;
      let saved: MonitorState | null = null;
      try {
        saved = this.o.state.load();
      } catch (e: any) {
        err({ type: 'notice', message: `monitor state unreadable (${e.message}) — starting fresh; posts made while stopped are not checked` });
      }
      fresh = saved === null;
      if (saved) {
        saved.seenPostIds.forEach(id => this.seenPosts.add(id));
        saved.seenTradeUpdates.forEach(k => this.seenTrade.add(k));
        this.closed = saved.closedTrades ?? [];
        gapMs = Math.max(0, this.now - saved.savedAt);
      }
    }
    const maxCatchUpMs = this.o.maxCatchUpMs ?? DEFAULT_MAX_CATCHUP_SEC * 1000;

    await this.refreshFollowing(events);

    // Our open copies: watched on /dex/trade, and their closes always let through
    let copies: CopyEntry[] = [];
    let ledgerReadable = true;
    try {
      copies = this.o.ledger.load().filter(e => e.source && (e.status === 'open' || e.status === 'pending'));
    } catch (e: any) {
      ledgerReadable = false;
      err({ type: 'error', source: 'ledger', message: `${e.message} — every followed trader's close is passed on; closes from unfollowed traders can't be recognised` });
    }
    const isCopied = (ownerId: string, baseId?: string, baseShortId?: string) =>
      copies.some(c => sameTrade({ ownerId, baseId, baseShortId }, copyIds(c)));

    await this.pollTradeUpdates(copies, fresh, first && !fresh, out, err);
    await this.pollFeed({ first, fresh, gapMs, maxCatchUpMs, isCopied, ledgerReadable }, out, err);
    this.emitCloses(copies, ledgerReadable, out);

    try {
      const keep = this.o.maxSeen ?? 2000;
      this.o.state.save({
        version: 1,
        seenPostIds: [...this.seenPosts].slice(-keep),
        seenTradeUpdates: [...this.seenTrade].slice(-keep),
        closedTrades: this.closed,
        savedAt: this.now,
      });
    } catch (e: any) {
      err({ type: 'error', source: 'state', message: `monitor state not saved: ${e.message}` });
    }
    return events;
  }

  private async refreshFollowing(events: WatchEvent[], onDemand = false) {
    try {
      const diff = onDemand ? await this.o.registry.refreshOnDemand() : await this.o.registry.refreshIfDue();
      if (diff && (diff.added.length || diff.removed.length)) {
        events.push({ stream: 'out', data: { type: 'following_changed', ...followingSummary(this.o.registry.traders), added: diff.added, removed: diff.removed } });
      }
    } catch (e: any) {
      // Keep the last known list; a failed refresh never widens who we copy
      events.push({ stream: 'err', data: { type: 'error', source: 'following', message: e.message } });
    }
  }

  /** /dex/trade for command-line entries plus every open copy in the ledger. */
  private async pollTradeUpdates(
    copies: CopyEntry[],
    fresh: boolean,
    catchUp: boolean,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    const watch = new Map<string, WatchEntry>();
    for (const w of this.o.watchEntries ?? []) watch.set(w.baseShortId, w);
    for (const c of copies) {
      const id = c.source!.sourcePaperTradeBaseShortId;
      if (id && !watch.has(id)) watch.set(id, { baseShortId: id, mimicStartedAt: c.openedAt });
    }
    if (!watch.size) return;

    // Response (seen live 2026-10-02):
    //   { success, data: [ { creatorAppUserId, portfolioId, investmentBaseId, investmentBaseShortId,
    //       unmimickedCount, unseenCount,
    //       updates: [ { investmentId, investmentBaseId, updateType, updatedAt, isSeen, isMimicked, details } ] } ] }
    // updateType seen: "close" (details: closePrice, reasonClosed), "tp", "sl". There is no isOpen field.
    let trades: any[];
    try {
      const res = await this.o.invo.getTradeUpdates([...watch.values()]);
      if (res?.success === false || !Array.isArray(res?.data)) {
        err({ type: 'error', source: 'trade', message: `unrecognised /dex/trade response: ${JSON.stringify(res)?.slice(0, 200)}` });
        return;
      }
      trades = res.data;
    } catch (e: any) {
      err({ type: 'error', source: 'trade', message: e.message });
      return;
    }

    for (const t of trades) {
      const ids = {
        ownerId: typeof t?.creatorAppUserId === 'string' ? t.creatorAppUserId : undefined,
        baseId: t?.investmentBaseId || undefined,
        baseShortId: t?.investmentBaseShortId || undefined,
      };
      const copy = copies.find(c => isCopyOf(c, ids));
      for (const u of Array.isArray(t?.updates) ? t.updates : []) {
        const updateKey = `${ids.baseShortId ?? ids.baseId}_${u?.investmentId ?? ''}_${u?.updateType ?? ''}_${u?.updatedAt ?? ''}`;
        if (this.seenTrade.has(updateKey)) continue;
        this.seenTrade.add(updateKey);
        // Informational only (not a signal). On a fresh start, existing updates are just indexed.
        if (!fresh) {
          out({
            type: 'trade_update', poll: this.pollCount,
            baseShortId: ids.baseShortId ?? null, ownerId: ids.ownerId ?? null,
            updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null, details: u?.details ?? null,
          });
        }

        if (!isCloseUpdate(u) || !copy) continue;
        // Sent by emitCloses (and re-sent while the copy stays open) — even on a fresh start
        this.rememberClose({ ...copyIds(copy), coin: copy.coin, closingPrice: u.details?.closePrice ?? null, source: 'trade_poll', catchUp });
      }
    }
  }

  /** Remember a trader's close (once per trade). */
  private rememberClose(c: Omit<ClosedTrade, 'seenAt' | 'attempts' | 'lastEmittedAt'>) {
    if (this.closed.some(r => sameTrade(r, c))) return;
    const rec: ClosedTrade = { ...c, seenAt: this.now, attempts: 0, lastEmittedAt: null };
    this.closed.push(rec);
    this.closedThisPoll.add(rec);
  }

  private closedTradeFor(ids: TradeIds) {
    return this.closed.find(r => sameTrade(r, ids));
  }

  /**
   * Send a close signal for every remembered closed trade we still hold an open
   * copy of — again every closeRetryMs while it stays open, up to maxCloseAttempts.
   * If the ledger can't be read, each close first seen this poll is sent once (close.ts checks it).
   */
  private emitCloses(
    copies: CopyEntry[],
    ledgerReadable: boolean,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
  ) {
    const retryMs = this.o.closeRetryMs ?? DEFAULT_CLOSE_RETRY_SEC * 1000;
    const maxAttempts = this.o.maxCloseAttempts ?? DEFAULT_MAX_CLOSE_ATTEMPTS;
    const retentionMs = this.o.closedTradeRetentionMs ?? DEFAULT_CLOSED_TRADE_RETENTION_SEC * 1000;

    for (const rec of this.closed) {
      const copy = copies.find(c => sameTrade(rec, copyIds(c)));
      if (ledgerReadable ? !copy : rec.attempts > 0 || !this.closedThisPoll.has(rec)) continue;

      if (rec.attempts >= maxAttempts) {
        if (!rec.gaveUp) {
          rec.gaveUp = true;
          out({
            type: 'close_stuck',
            poll: this.pollCount,
            message: `${rec.attempts} close signals sent, but our ${copy!.coin} copy of trader ${rec.ownerId}'s trade is still open — needs the user`,
            entryId: copy!.id,
            owner: { id: rec.ownerId },
            trade: { coin: copy!.coin, side: copy!.side },
          }, true);
        }
        continue;
      }
      if (rec.lastEmittedAt !== null && this.now - rec.lastEmittedAt < retryMs) continue;

      rec.attempts++;
      rec.lastEmittedAt = this.now;
      const src = copy?.source;
      out({
        type: 'signal',
        source: rec.source,
        poll: this.pollCount,
        ...(rec.postId && { postId: rec.postId }),
        action: 'close',
        copied: !!copy,
        attempt: rec.attempts,
        ...(rec.attempts > 1 && { retry: true }),
        ...(rec.catchUp && rec.attempts === 1 && { catchUp: true }),
        owner: { id: rec.ownerId },
        trade: { coin: copy?.coin ?? rec.coin, ...(copy && { side: copy.side }), isOpen: false, closingPrice: rec.closingPrice ?? null },
        // Identifies the copy for close.ts — from our ledger entry when we have one
        mimicMeta: src
          ? {
              portfolioId: src.portfolioId,
              creatorInvoUserId: src.creatorInvoUserId,
              sourcePaperTradeBaseId: src.sourcePaperTradeBaseId,
              sourcePaperTradeBaseShortId: src.sourcePaperTradeBaseShortId,
            }
          : { creatorInvoUserId: rec.ownerId, sourcePaperTradeBaseId: rec.baseId, sourcePaperTradeBaseShortId: rec.baseShortId },
      }, true);
    }

    // Forget closed trades after the retention period, unless a copy of one is still being retried
    this.closed = this.closed.filter(r =>
      this.now - r.seenAt <= retentionMs || (!r.gaveUp && copies.some(c => sameTrade(r, copyIds(c)))));
  }

  /** Feed posts newer than the last one seen, across pages. */
  private async fetchNewPosts(fresh: boolean, err: (d: Record<string, unknown>) => void): Promise<any[]> {
    const pageSize = this.o.pageSize ?? 20;
    const maxPages = this.o.maxPages ?? 5;
    const found = new Map<string, any>();
    let lastPostId: string | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.o.invo.getFeed('following', lastPostId, pageSize);
      const posts: any[] = (data?.items ?? []).filter((p: any) => typeof p?.id === 'string');
      const unseen = posts.filter(p => !this.seenPosts.has(p.id) && !found.has(p.id));
      unseen.forEach(p => found.set(p.id, p));
      // Done once a page reaches posts we've seen, is short, or adds nothing (cursor ignored).
      // A fresh start only indexes the first page.
      if (fresh || unseen.length < posts.length || posts.length < pageSize || unseen.length === 0) break;
      if (page === maxPages) {
        err({ type: 'notice', message: `more than ${maxPages * pageSize} new feed posts since the last poll — older ones were not checked` });
        break;
      }
      lastPostId = posts[posts.length - 1].id;
    }
    return [...found.values()];
  }

  private async pollFeed(
    ctx: { first: boolean; fresh: boolean; gapMs: number; maxCatchUpMs: number; isCopied: Parameters<typeof classifyPost>[2]; ledgerReadable: boolean },
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    let posts: any[];
    try {
      posts = await this.fetchNewPosts(ctx.fresh, err);
    } catch (e: any) {
      err({ type: 'error', source: 'feed', message: e.message });
      return;
    }
    posts.forEach(p => this.seenPosts.add(p.id));
    if (ctx.fresh) return; // first ever run: existing posts are not new signals

    const catchUp = ctx.first; // posts made while this monitor wasn't running
    const accepted: { post: any; verdict: Extract<ReturnType<typeof classifyPost>, { kind: 'accept' }> }[] = [];
    for (const post of posts) {
      let verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
      if (verdict.kind === 'ignore') continue;

      // Unknown owner or portfolio may mean the list is stale (just followed someone,
      // or they opened a new portfolio) — re-check against fresh data (rate-limited) before rejecting
      if (verdict.kind === 'reject' && verdict.ownerId) {
        if (verdict.reason === 'owner not in following list') {
          const events: WatchEvent[] = [];
          await this.refreshFollowing(events, true);
          events.forEach(e => (e.stream === 'out' ? out(e.data) : err(e.data)));
          verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
        } else if (verdict.reason === 'portfolio not owned by followed trader') {
          await this.o.registry.refreshPortfolios(verdict.ownerId).catch(() => {});
          verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
        }
      }

      if (verdict.kind === 'reject') {
        err({ type: 'skipped', poll: this.pollCount, postId: post.id, reason: verdict.reason, ownerId: verdict.ownerId ?? null, portfolioId: verdict.portfolioId ?? null });
        continue;
      }
      if (verdict.kind === 'accept') accepted.push({ post, verdict });
    }

    // Remember every close first, so a close wins over an open/update of the same trade
    // seen this poll (whatever order the feed lists them in) or in any earlier one.
    // Close signals themselves are sent by emitCloses, once we hold a copy of the trade.
    for (const { post, verdict } of accepted) {
      if (verdict.action !== 'close') continue;
      const u = post.update;
      this.rememberClose({
        ownerId: u.owner.id,
        baseId: u.baseId || undefined,
        baseShortId: u.baseShortId || undefined,
        coin: u.ticker,
        closingPrice: u.closingPrice ?? null,
        source: 'feed',
        postId: post.id,
        catchUp,
      });
    }
    const maxAgeMs = this.o.maxSignalAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_SEC * 1000;

    for (const { post, verdict } of accepted) {
      const update = post.update;
      const ids: TradeIds = { ownerId: update.owner.id, baseId: update.baseId || undefined, baseShortId: update.baseShortId || undefined };
      const skip = (reason: string) =>
        err({ type: 'skipped', poll: this.pollCount, postId: post.id, reason, ownerId: update.owner?.id ?? null, portfolioId: update.portfolio?.id ?? null });

      if (verdict.action === 'close') {
        if (!verdict.copied && ctx.ledgerReadable) skip('close of a trade we hold no copy of — remembered in case one is opened');
        continue; // sent by emitCloses
      } else {
        if (this.closedTradeFor(ids)) { skip(`${verdict.action} of a trade that is already closed`); continue; }
        const at = postTime(post);
        if (at === null) { skip(`${verdict.action} post has no createdAt — can't tell how old it is, not copying`); continue; }
        if (this.now - at > maxAgeMs) {
          skip(`${verdict.action} posted ${Math.round((this.now - at) / 1000)}s ago — too old to copy`);
          continue;
        }
        if (catchUp && ctx.gapMs > ctx.maxCatchUpMs) {
          skip(`missed while the monitor was stopped (${Math.round(ctx.gapMs / 1000)}s) — too old to copy`);
          continue;
        }
      }

      out({
        type: 'signal',
        source: 'feed',
        poll: this.pollCount,
        postId: post.id,
        action: verdict.action,
        ...(verdict.copied && { copied: true }),
        ...(catchUp && { catchUp: true }),
        owner: {
          id: update.owner.id,
          username: update.owner?.username ?? post.owner?.username,
        },
        followed: verdict.trader && { userId: verdict.trader.userId, username: verdict.trader.username },
        trade: {
          coin: update.ticker,
          name: update.name,
          side: update.directionLong ? 'long' : 'short',
          leverage: update.leverage,
          entryPrice: update.entryPrice,
          closingPrice: update.closingPrice ?? null,
          entrySize: update.entrySize,
          isOpen: update.isOpen === true,
        },
        portfolio: {
          id: update.portfolio?.id,
          title: update.portfolio?.title,
          winRate: update.portfolio?.winRate,
          closedPositions: update.portfolio?.closedPositionsCount,
          openPositions: update.portfolio?.openPositionsCount,
          pnl: update.portfolio?.plSnapshot,
        },
        // Invo's /dex/position/create shape — pass as-is to trade.ts / close.ts.
        // sourcePaperTradeBaseShortId is the trader's baseShortId (use it for /dex/trade watch entries)
        mimicMeta: mimicMetaFromUpdate(update),
      }, true);
    }
  }
}

export function followingSummary(traders: FollowedTrader[]) {
  return {
    count: traders.length,
    traders: traders.map(t => ({ userId: t.userId, username: t.username, portfolioIds: t.portfolios.map(p => p.id) })),
  };
}
