// Followed-trader list: who the authenticated Invo account currently follows,
// resolved to their portfolios, plus the feed-post filter that only lets
// verified trades from those traders through. Read-only — never follows or
// unfollows anyone. Network access goes through an injected client so this
// module is testable without hitting Invo.

import { mimicMetaFromUpdate, missingMimicMetaFields } from './mimic-meta.js';

// Endpoints verified against the Invo web app and live responses:
//   GET  /v1_0/users/get_user                → { user: { id, username, ... } }
//   POST /v1_0/users/get_following           → { page, size, success, error, following: [{ id, username, ... }] }
//   POST /v1_0/portfolios/v2/get_users_portfolios → { portfolios: [{ id, ownerId, title, winRate, ... }] }
// (get_portfolios_pl is not used: it ignores userId and returns other owners' portfolios.)
export interface FollowingClient {
  getCurrentUser(): Promise<any>;
  getFollowing(userId: string, page: number, size: number): Promise<any>;
  getUserPortfolios(userId: string, page: number, size: number): Promise<any>;
}

export const FOLLOWING_PAGE_SIZE = 20; // what the Invo app requests
export const PORTFOLIO_PAGE_SIZE = 20; // likewise
const MAX_FOLLOWING_PAGES = 50;
const MAX_PORTFOLIO_PAGES = 10;

export interface FollowedPortfolio {
  id: string;
  title?: string;
  winRate?: number;
  closedPositions?: number;
  percentChange?: number;
  currentWinStreak?: number;
}

export interface FollowedTrader {
  userId: string;
  username: string;
  portfolios: FollowedPortfolio[];
}

export async function getMyUserId(client: FollowingClient): Promise<string> {
  const data = await client.getCurrentUser();
  const id = data?.user?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error(`Could not determine Invo user id from /users/get_user: ${JSON.stringify(data)?.slice(0, 200)}`);
  }
  return id;
}

/** Every user the account follows, across all pages. Throws on any API error (fail closed). */
export async function fetchFollowing(client: FollowingClient, userId: string): Promise<{ id: string; username: string }[]> {
  const out = new Map<string, { id: string; username: string }>();
  for (let page = 1; page <= MAX_FOLLOWING_PAGES; page++) {
    const data = await client.getFollowing(userId, page, FOLLOWING_PAGE_SIZE);
    if (data?.success === false || data?.error || !Array.isArray(data?.following)) {
      throw new Error(`/users/get_following failed (page ${page}): ${JSON.stringify(data)?.slice(0, 200)}`);
    }
    for (const u of data.following) {
      // Follow requests to private accounts that haven't been accepted are not follows yet
      if (typeof u?.id !== 'string' || u.isPending === true) continue;
      out.set(u.id, { id: u.id, username: u.username ?? '' });
    }
    if (data.following.length < FOLLOWING_PAGE_SIZE) return [...out.values()];
  }
  throw new Error(`/users/get_following returned more than ${MAX_FOLLOWING_PAGES} pages`);
}

/** A trader's portfolios. Only portfolios they own are kept (defensive — the endpoint is per-user). */
export async function fetchPortfolios(client: Pick<FollowingClient, 'getUserPortfolios'>, userId: string): Promise<FollowedPortfolio[]> {
  const out = new Map<string, FollowedPortfolio>();
  for (let page = 1; page <= MAX_PORTFOLIO_PAGES; page++) {
    const data = await client.getUserPortfolios(userId, page, PORTFOLIO_PAGE_SIZE);
    const items = Array.isArray(data?.portfolios) ? data.portfolios : null;
    if (!items) throw new Error(`get_users_portfolios(${userId}) failed: ${JSON.stringify(data)?.slice(0, 200)}`);
    const before = out.size;
    for (const p of items) {
      if (typeof p?.id !== 'string' || p.ownerId !== userId) continue;
      out.set(p.id, {
        id: p.id,
        title: p.title,
        winRate: p.winRate,
        closedPositions: p.closedPositions,
        percentChange: p.percentChange,
        currentWinStreak: p.currentWinStreak,
      });
    }
    // Short page = last page (the app's rule); also stop if a page adds nothing new
    if (items.length < PORTFOLIO_PAGE_SIZE || out.size === before) break;
  }
  return [...out.values()];
}

/**
 * Load the account's current following list and resolve each user's portfolios.
 * The following list itself must load (throws otherwise). A per-trader portfolio
 * lookup failure keeps the trader with no known portfolios — the monitor retries
 * the lookup when that trader posts a signal.
 */
export async function loadFollowedTraders(client: FollowingClient, myUserId?: string): Promise<FollowedTrader[]> {
  const me = myUserId ?? await getMyUserId(client);
  const users = await fetchFollowing(client, me);
  const traders: FollowedTrader[] = [];
  for (const u of users) {
    let portfolios: FollowedPortfolio[] = [];
    try {
      portfolios = await fetchPortfolios(client, u.id);
    } catch { /* resolved lazily on first signal */ }
    traders.push({ userId: u.id, username: u.username, portfolios });
  }
  return traders;
}

export function diffFollowed(prev: FollowedTrader[], next: FollowedTrader[]) {
  const prevIds = new Set(prev.map(t => t.userId));
  const nextIds = new Set(next.map(t => t.userId));
  return {
    added: next.filter(t => !prevIds.has(t.userId)).map(t => ({ userId: t.userId, username: t.username })),
    removed: prev.filter(t => !nextIds.has(t.userId)).map(t => ({ userId: t.userId, username: t.username })),
  };
}

// --- Feed post filtering ---

export type SignalAction = 'open' | 'increase' | 'close';

export type PostVerdict =
  | { kind: 'ignore' } // not a trade post — silently skipped
  | { kind: 'reject'; reason: string; ownerId?: string; portfolioId?: string }
  | { kind: 'accept'; trader: FollowedTrader; portfolio: FollowedPortfolio; action: SignalAction };

/**
 * Decide whether a feed post is a verified trade signal from a trader the
 * account currently follows. Pure — `followed` is the current list.
 */
export function classifyPost(post: any, followed: Map<string, FollowedTrader>): PostVerdict {
  const update = post?.update;
  if (!update || !update.ticker) return { kind: 'ignore' };

  const ownerId: string | undefined = update.owner?.id;
  const portfolioId: string | undefined = update.portfolio?.id;
  const ctx = { ownerId, portfolioId };

  if (update.verifiedTrade !== true) return { kind: 'reject', reason: 'unverified trade', ...ctx };
  if (!ownerId) return { kind: 'reject', reason: 'trade has no owner', ...ctx };
  if (post.repostId != null) return { kind: 'reject', reason: 'repost', ...ctx };
  if (post.owner?.id && post.owner.id !== ownerId) return { kind: 'reject', reason: 'post owner differs from trade owner', ...ctx };

  const trader = followed.get(ownerId);
  if (!trader) return { kind: 'reject', reason: 'owner not in following list', ...ctx };
  if (!portfolioId) return { kind: 'reject', reason: 'trade has no portfolio', ...ctx };
  const portfolio = trader.portfolios.find(p => p.id === portfolioId);
  if (!portfolio) return { kind: 'reject', reason: 'portfolio not owned by followed trader', ...ctx };

  // Same action rules the monitor has always used
  const isClosed = update.isOpen === false && update.closingPrice != null;
  let action: SignalAction;
  if (isClosed) action = 'close';
  else if (update.changes?.isAdded !== false) action = 'open';
  else action = 'increase';

  // Opens/increases are copied with trade.ts, which needs the trader's trade IDs.
  // Closes don't (close.ts works by coin), and dropping one would leave our copy open.
  if (action !== 'close') {
    const missing = missingMimicMetaFields(mimicMetaFromUpdate(update));
    if (missing.length) return { kind: 'reject', reason: `trade is missing ${missing.join(', ')}`, ...ctx };
  }

  return { kind: 'accept', trader, portfolio, action };
}
