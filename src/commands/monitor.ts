import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';
import { FollowedTraderRegistry } from '../followed-registry.js';
import { classifyPost } from '../following.js';
import { mimicMetaFromUpdate } from '../mimic-meta.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

interface WatchEntry {
  baseShortId: string;
  mimicStartedAt: string;
}

const DEFAULT_REFRESH_SEC = 60;

function usage(): never {
  console.error('Usage: monitor [--wait-for-signal] [--refresh=<sec>] [watchEntries]');
  console.error('');
  console.error('Traders are the users your Invo account currently follows — loaded at startup');
  console.error(`and re-fetched every --refresh seconds (default ${DEFAULT_REFRESH_SEC}). Follow/unfollow in the Invo app.`);
  console.error('  Watch entries: \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'  (optional, polls /dex/trade)');
  console.error('');
  console.error('Modes:');
  console.error('  default:             Run forever, print all signals as JSON lines');
  console.error('  --wait-for-signal:   Exit after first signal (for agent auto-notify)');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const waitMode = args.includes('--wait-for-signal');
  const refreshArg = args.find(a => a.startsWith('--refresh='));
  const refreshSec = refreshArg ? Number(refreshArg.slice('--refresh='.length)) : DEFAULT_REFRESH_SEC;
  if (!Number.isFinite(refreshSec) || refreshSec < 10) {
    console.error('--refresh must be a number of seconds >= 10');
    usage();
  }
  const unknown = args.filter(a => !a.startsWith('[') && a !== '--wait-for-signal' && !a.startsWith('--refresh='));
  if (unknown.length) usage();

  // Watch entries (objects) are still accepted. Portfolio ID arrays (strings) are
  // no longer needed — the followed-trader list is the source of truth.
  let watchEntries: WatchEntry[] = [];
  let ignoredPortfolioIds = 0;
  for (const arg of args.filter(a => a.startsWith('['))) {
    const arr = JSON.parse(arg);
    if (!Array.isArray(arr)) usage();
    for (const x of arr) {
      if (typeof x === 'string') ignoredPortfolioIds++;
      else if (x?.baseShortId) watchEntries.push(x);
    }
  }
  if (ignoredPortfolioIds) {
    console.error(JSON.stringify({
      type: 'notice',
      message: `Ignoring ${ignoredPortfolioIds} portfolio ID argument(s) — traders come from your Invo following list`,
    }));
  }
  const isWatchEntries = watchEntries.length > 0;

  // Fails closed: if the following list can't be loaded at startup, exit rather than copy anyone
  const registry = new FollowedTraderRegistry(invo, { refreshIntervalMs: refreshSec * 1000 });
  await registry.refresh();

  const seenPosts = new Set<string>();
  const seenUpdates = new Set<string>();
  let pollCount = 0;
  let isFirstFeedPoll = true;

  const FEED_INTERVAL = 5_000; // 5s for faster signal detection

  const emitFollowing = (type: 'following_loaded' | 'following_changed', extra: object = {}) => {
    console.log(JSON.stringify({
      type,
      count: registry.traders.length,
      ...extra,
      traders: registry.traders.map(t => ({
        userId: t.userId,
        username: t.username,
        portfolioIds: t.portfolios.map(p => p.id),
      })),
    }));
  };

  const refreshFollowing = async (onDemand = false) => {
    try {
      const diff = onDemand ? await registry.refreshOnDemand() : await registry.refreshIfDue();
      if (diff && (diff.added.length || diff.removed.length)) {
        emitFollowing('following_changed', { added: diff.added, removed: diff.removed });
      }
    } catch (e: any) {
      // Keep the last known list; a failed refresh never widens who we copy
      console.error(JSON.stringify({ type: 'error', source: 'following', message: e.message }));
    }
  };

  const poll = async (): Promise<boolean> => {
    pollCount++;
    let signalFound = false;

    await refreshFollowing();

    // Poll /dex/trade if we have watch entries
    if (isWatchEntries) {
      try {
        const data = await invo.getTradeUpdates(watchEntries);
        const items = (data as any).investments ?? (data as any).items ?? [];
        for (const item of items) {
          const key = `${item.baseShortId ?? item.id}_${item.lastUpdate ?? ''}`;
          if (!seenUpdates.has(key)) {
            seenUpdates.add(key);
            console.log(JSON.stringify({ type: 'trade_update', poll: pollCount, data: item }));
            signalFound = true;
          }
        }
      } catch (e: any) {
        console.error(JSON.stringify({ type: 'error', source: 'trade', message: e.message }));
      }
    }

    // Poll feed for trade signals from followed traders
    try {
      const data = await invo.getFeed('following', null, 20);
      const posts = data.items ?? [];
      for (const post of posts) {
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);

        // Skip first poll results (existing posts, not new signals)
        if (isFirstFeedPoll) continue;

        let verdict = classifyPost(post, registry.byUserId);
        if (verdict.kind === 'ignore') continue;

        // Unknown owner or portfolio may mean the list is stale (just followed someone,
        // or they opened a new portfolio) — re-check against fresh data (rate-limited) before rejecting
        if (verdict.kind === 'reject' && verdict.ownerId) {
          if (verdict.reason === 'owner not in following list') {
            await refreshFollowing(true);
            verdict = classifyPost(post, registry.byUserId);
          } else if (verdict.reason === 'portfolio not owned by followed trader') {
            await registry.refreshPortfolios(verdict.ownerId).catch(() => {});
            verdict = classifyPost(post, registry.byUserId);
          }
        }

        if (verdict.kind !== 'accept') {
          if (verdict.kind === 'reject') {
            console.error(JSON.stringify({
              type: 'skipped',
              poll: pollCount,
              postId: post.id,
              reason: verdict.reason,
              ownerId: verdict.ownerId ?? null,
              portfolioId: verdict.portfolioId ?? null,
            }));
          }
          continue;
        }

        const update = post.update;
        const isOpen = update.isOpen === true;

        console.log(JSON.stringify({
          type: 'signal',
          poll: pollCount,
          postId: post.id,
          action: verdict.action,
          owner: {
            id: update.owner.id,
            username: update.owner?.username ?? post.owner?.username,
          },
          followed: {
            userId: verdict.trader.userId,
            username: verdict.trader.username,
          },
          trade: {
            coin: update.ticker,
            name: update.name,
            side: update.directionLong ? 'long' : 'short',
            leverage: update.leverage,
            entryPrice: update.entryPrice,
            closingPrice: update.closingPrice ?? null,
            entrySize: update.entrySize,
            isOpen,
          },
          portfolio: {
            id: update.portfolio?.id,
            title: update.portfolio?.title,
            winRate: update.portfolio?.winRate,
            closedPositions: update.portfolio?.closedPositionsCount,
            openPositions: update.portfolio?.openPositionsCount,
            pnl: update.portfolio?.plSnapshot,
          },
          // Invo's /dex/position/create shape — pass as-is to trade.ts.
          // sourcePaperTradeBaseShortId is the trader's baseShortId (use it for /dex/trade watch entries)
          mimicMeta: mimicMetaFromUpdate(update),
        }));
        signalFound = true;
      }

      if (isFirstFeedPoll) {
        isFirstFeedPoll = false;
      }
    } catch (e: any) {
      console.error(JSON.stringify({ type: 'error', source: 'feed', message: e.message }));
    }

    return signalFound;
  };

  console.log(JSON.stringify({
    type: 'started',
    mode: isWatchEntries ? 'followed+trade_poll' : 'followed',
    waitForSignal: waitMode,
    watchEntries: watchEntries.length,
    followedTraders: registry.traders.length,
    refreshSec,
  }));
  emitFollowing('following_loaded');
  if (registry.traders.length === 0) {
    console.error(JSON.stringify({ type: 'notice', message: 'Your Invo account follows nobody — no signals will be copied until you follow someone' }));
  }

  // First poll: index existing posts so we only react to new ones
  await poll();

  while (true) {
    await new Promise(r => setTimeout(r, FEED_INTERVAL));
    const found = await poll();

    if (waitMode && found) {
      process.exit(0);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
