import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalWatcher, DEFAULT_CLOSE_RETRY_SEC, type MonitorState, type StateStore, type WatchEntry } from './signal-watcher.js';
import { MIN_SETTLE_AGE_MS } from './pending-orders.js';
import type { FollowedTrader } from './following.js';
import type { CopyEntry } from './copy-ledger.js';
import { copyEntry } from './test-fakes.js';

// --- Fakes: nothing here touches the network or disk ---

class MemoryState implements StateStore {
  state: MonitorState | null = null;
  corrupt = false;
  load() {
    if (this.corrupt) throw new Error('Unexpected token');
    return this.state && structuredClone(this.state);
  }
  save(s: MonitorState) { this.state = structuredClone(s); }
}

let postSeq = 0;
/** The test clock: what the watcher sees as now, and when post() posts are made. */
let clock = 1_000_000;
/** A trade post by `owner` on trade `trade` (baseId base-<trade>, baseShortId short-<trade>), made now. */
function post(owner: string, trade: string, kind: 'open' | 'update' | 'close' = 'open', extra: { post?: object; update?: object } = {}) {
  const id = `post-${++postSeq}`;
  return {
    id,
    repostId: null,
    createdAt: new Date(clock).toISOString(),
    owner: { id: owner, username: owner },
    ...extra.post,
    update: {
      id: `upd-${id}`,
      baseId: `base-${trade}`,
      baseShortId: `short-${trade}`,
      ticker: 'SOL',
      verifiedTrade: true,
      owner: { id: owner, username: owner },
      portfolio: { id: `p-${owner}` },
      isOpen: kind !== 'close',
      closingPrice: kind === 'close' ? 150 : null,
      changes: { isAdded: kind === 'open' },
      ...extra.update,
    },
  };
}

/** Feed newest-first; `lastPostId` pages to older posts (or is ignored, like a broken cursor). */
function fakeInvo(opts: { ignoreCursor?: boolean } = {}) {
  const feed: any[] = [];
  const tradeItems: any[] = [];
  const calls = { getFeed: [] as (string | null)[], getTradeUpdates: [] as WatchEntry[][] };
  return {
    feed, tradeItems, calls,
    publish(...posts: any[]) { feed.unshift(...posts.reverse()); },
    async getFeed(_filter: string, lastPostId: string | null, itemLimit: number) {
      calls.getFeed.push(lastPostId);
      const start = lastPostId && !opts.ignoreCursor ? feed.findIndex(p => p.id === lastPostId) + 1 : 0;
      return { items: feed.slice(start, start + itemLimit) };
    },
    async getTradeUpdates(investments: WatchEntry[]) {
      calls.getTradeUpdates.push(investments);
      return { investments: tradeItems };
    },
  };
}

function fakeRegistry(userIds: string[]) {
  const traders: FollowedTrader[] = userIds.map(u => ({ userId: u, username: u, portfolios: [{ id: `p-${u}` }] }));
  return {
    traders,
    byUserId: new Map(traders.map(t => [t.userId, t])),
    async refreshIfDue() { return null; },
    async refreshOnDemand() { return null; },
    async refreshPortfolios() { return false; },
  };
}

function setup(opts: { following?: string[]; ledger?: CopyEntry[]; state?: MemoryState; invo?: ReturnType<typeof fakeInvo>; pageSize?: number; maxPages?: number } = {}) {
  clock = 1_000_000;
  const invo = opts.invo ?? fakeInvo();
  const state = opts.state ?? new MemoryState();
  const ledgerEntries = opts.ledger ?? [];
  const make = () => new SignalWatcher({
    invo,
    registry: fakeRegistry(opts.following ?? ['alice', 'bob']),
    ledger: { load: () => ledgerEntries },
    state,
    now: () => clock,
    maxCatchUpMs: 300_000,
    pageSize: opts.pageSize ?? 20,
    maxPages: opts.maxPages ?? 5,
  });
  return { invo, state, make, advance: (ms: number) => { clock += ms; } };
}

const signals = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'signal').map(e => e.data as any);
const skipped = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'skipped').map(e => e.data as any);

// --- Restarts ---

test('first ever run indexes the feed without emitting; later posts are signals', async () => {
  const { invo, make } = setup();
  invo.publish(post('alice', 't0'));
  const w = make();
  assert.deepEqual(signals(await w.poll()), []);
  invo.publish(post('alice', 't1'));
  const s = signals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.mimicMeta.sourcePaperTradeBaseId, x.catchUp]), [['open', 'base-t1', undefined]]);
});

test('a restart catches up on posts made while stopped (the --wait-for-signal gap)', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-b', 'SOL', 0.3, 'bob', 't2')] });
  invo.publish(post('alice', 't0'));
  await make().poll(); // first run: index
  invo.publish(post('alice', 't1'), post('bob', 't2', 'close'));
  advance(60_000); // the agent took a minute before relaunching

  const s = signals(await make().poll());
  assert.deepEqual(s.map(x => [x.owner.id, x.action, x.catchUp]).sort(), [['alice', 'open', true], ['bob', 'close', true]]);
});

test('after a long stop, missed opens are skipped as too old but missed closes are still emitted', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-b', 'SOL', 0.3, 'bob', 't3')] });
  await make().poll();
  invo.publish(post('alice', 't1'), post('bob', 't2', 'update'), post('bob', 't3', 'close'));
  advance(3_600_000);

  const events = await make().poll();
  assert.deepEqual(signals(events).map(x => [x.owner.id, x.action]), [['bob', 'close']]);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), [
    'open posted 3600s ago — too old to copy',
    'update posted 3600s ago — too old to copy',
  ]);
});

test('a stop longer than --max-catchup skips missed opens even if the posts look recent', async () => {
  const { invo, make, advance } = setup();
  await make().poll();
  advance(400_000);
  invo.publish(post('alice', 't1')); // made just now, but the monitor was down 400s
  assert.deepEqual(skipped(await make().poll()).map(x => x.reason), ['missed while the monitor was stopped (400s) — too old to copy']);
});

// --- Post age ---

test('older posts showing up in the feed (e.g. a newly followed trader) are not copied', async () => {
  const { invo, make, advance } = setup();
  const w = make();
  await w.poll();
  const old = post('alice', 't1'); // made at the start...
  advance(3_600_000);
  invo.publish(old, post('alice', 't2')); // ...but only appears in the feed an hour later
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => x.mimicMeta.sourcePaperTradeBaseId), ['base-t2']);
  assert.deepEqual(skipped(events).map(x => x.reason), ['open posted 3600s ago — too old to copy']);
});

test('opens and updates without a readable createdAt are not copied; closes still are', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't3')] });
  const w = make();
  await w.poll();
  invo.publish(
    post('alice', 't1', 'open', { post: { createdAt: undefined } }),
    post('alice', 't2', 'update', { post: { createdAt: 'yesterday-ish' } }),
    post('alice', 't3', 'close', { post: { createdAt: undefined } }),
  );
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => x.action), ['close']);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), [
    'open post has no createdAt — can\'t tell how old it is, not copying',
    'update post has no createdAt — can\'t tell how old it is, not copying',
  ]);
});

test('posts already handled before a restart are not emitted again', async () => {
  const { invo, make } = setup();
  await make().poll();
  invo.publish(post('alice', 't1'));
  assert.equal(signals(await make().poll()).length, 1);
  assert.equal(signals(await make().poll()).length, 0);
});

test('unreadable state: a notice, then a fresh start', async () => {
  const state = new MemoryState();
  state.corrupt = true;
  const { invo, make } = setup({ state });
  invo.publish(post('alice', 't1'));
  const events = await make().poll();
  assert.ok(events.some(e => e.data.type === 'notice' && /monitor state unreadable/.test(String(e.data.message))));
  assert.deepEqual(signals(events), []);
});

// --- Paging ---

test('a burst bigger than one page is read across pages back to the last seen post', async () => {
  const { invo, make } = setup({ pageSize: 20, ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.publish(post('alice', 't0'));
  const w = make();
  await w.poll();
  for (let i = 1; i <= 45; i++) invo.publish(post('alice', `t${i}`, i === 1 ? 'open' : 'update'));
  invo.publish(post('alice', 't1', 'close'));
  const s = signals(await w.poll());
  // The close of t1, from 46 posts back, is not lost
  assert.ok(s.some(x => x.action === 'close' && x.mimicMeta.sourcePaperTradeBaseId === 'base-t1'));
  assert.equal(s.length, 45); // t1's open is dropped: that trade is already closed
});

test('more new posts than the page limit: a notice says older ones were not checked', async () => {
  const { invo, make } = setup({ pageSize: 5, maxPages: 2 });
  const w = make();
  await w.poll();
  for (let i = 1; i <= 12; i++) invo.publish(post('alice', `t${i}`));
  const events = await w.poll();
  assert.equal(signals(events).length, 10);
  assert.ok(events.some(e => /more than 10 new feed posts/.test(String(e.data.message))));
});

test('a cursor the API ignores does not loop', async () => {
  const invo = fakeInvo({ ignoreCursor: true });
  const { make } = setup({ invo, pageSize: 3 });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1'), post('alice', 't2'), post('alice', 't3'));
  assert.equal(signals(await w.poll()).length, 3);
  assert.ok(invo.calls.getFeed.length <= 4);
});

// --- Closes of our copies ---

test('a close for a trade we copied is emitted even after the trader was unfollowed', async () => {
  const { invo, make } = setup({ following: ['bob'], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'), post('alice', 't9', 'close'));
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => [x.mimicMeta.sourcePaperTradeBaseId, x.copied, x.owner.id]), [['base-t1', true, 'alice']]);
  assert.deepEqual(skipped(events).map(x => x.reason), ['owner not in following list']);
});

test('every open copy is polled on /dex/trade; a closed one becomes a close signal from the ledger', async () => {
  const ledger = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), { ...copyEntry('tx-b', 'SOL', 0, 'bob', 't2'), status: 'closed' as const }];
  const { invo, make } = setup({ following: [], ledger });
  invo.tradeItems.push({ baseShortId: 'short-t1', isOpen: false, closingPrice: 150, lastUpdate: 'x' });

  // Even on a fresh start (closes of our copies are never just indexed)
  const s = signals(await make().poll());
  assert.deepEqual(invo.calls.getTradeUpdates[0].map(w => w.baseShortId), ['short-t1']);
  assert.deepEqual(s.map(x => [x.source, x.action, x.mimicMeta]), [['trade_poll', 'close', {
    portfolioId: 'p-alice', creatorInvoUserId: 'alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1',
  }]]);
});

test('closes of trades we hold no copy of are skipped; each close is emitted once', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.tradeItems.push({ baseShortId: 'short-t1', isOpen: false, lastUpdate: 'x' });
  const w = make();
  // Fresh start: the /dex/trade close of our copy is emitted
  assert.deepEqual(signals(await w.poll()).map(x => x.source), ['trade_poll']);
  // The same close then arrives on the feed (this poll and later): not emitted again
  invo.publish(post('alice', 't1', 'close'), post('bob', 't5', 'close'));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  assert.deepEqual(skipped(events).map(x => x.reason), ['close of a trade we hold no copy of — remembered in case one is opened']);
});

// --- Closes are remembered: late copies and incomplete closes ---

test('a copy opened just after its trader closed is still closed (close seen first)', async () => {
  const ledger: CopyEntry[] = [];
  const { invo, make } = setup({ ledger });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close')); // trader closes while trade.ts is still running
  assert.deepEqual(signals(await w.poll()), []);
  ledger.push(copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')); // trade.ts finishes
  const s = signals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.copied, x.attempt, x.mimicMeta.sourcePaperTradeBaseId]), [['close', true, 1, 'base-t1']]);
});

test('an open or update of a trade whose close was seen in an earlier poll is not copied', async () => {
  const { invo, make, advance } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  await w.poll();
  advance(10_000);
  invo.publish(post('alice', 't1'), post('alice', 't1', 'update'));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), ['open of a trade that is already closed', 'update of a trade that is already closed']);
});

test('a close that did not complete is re-sent every 90s while the copy is open, then stops', async () => {
  const ledger: CopyEntry[] = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const { invo, make, advance } = setup({ ledger });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  assert.deepEqual(signals(await w.poll()).map(x => [x.attempt, x.retry]), [[1, undefined]]);

  // close.ts didn't fill: the copy is still open
  advance(60_000);
  assert.deepEqual(signals(await w.poll()), []);
  advance(30_000);
  assert.deepEqual(signals(await w.poll()).map(x => [x.attempt, x.retry, x.mimicMeta.sourcePaperTradeBaseId]), [[2, true, 'base-t1']]);

  // Now it closed
  ledger[0] = { ...ledger[0], status: 'closed', qty: 0 };
  advance(90_000);
  assert.deepEqual(signals(await w.poll()), []);
});

test('a close retry never comes before an unsettled close order can be settled', () => {
  // Otherwise the retry after an `unknown` close is refused as "may still arrive" and the attempt is wasted
  assert.ok(DEFAULT_CLOSE_RETRY_SEC * 1000 > MIN_SETTLE_AGE_MS + 15_000);
});

test('retries survive a restart (--wait-for-signal) and give up with one close_stuck alert', async () => {
  const ledger: CopyEntry[] = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const { invo, state, advance } = setup({ ledger });
  const make = () => new SignalWatcher({
    invo, registry: fakeRegistry(['alice']), ledger: { load: () => ledger }, state,
    now: () => clock, closeRetryMs: 60_000, maxCloseAttempts: 3,
  });
  await make().poll();
  invo.publish(post('alice', 't1', 'close'));
  const attempts: number[] = [];
  for (let i = 0; i < 3; i++) {
    attempts.push(...signals(await make().poll()).map(x => x.attempt)); // a new process each time, like wait mode
    advance(60_000);
  }
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(state.state!.closedTrades![0].attempts, 3);

  const stuck = (await make().poll()).filter(e => e.data.type === 'close_stuck');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].signal, true);
  assert.match(String(stuck[0].data.message), /3 close signals sent, but our SOL copy .* still open — needs the user/);
  advance(60_000);
  const after = await make().poll();
  assert.deepEqual([signals(after), after.filter(e => e.data.type === 'close_stuck')], [[], []]);
});

test('closed trades without a copy are forgotten after the retention period', async () => {
  const { invo, state, make, advance } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  await w.poll();
  assert.equal(state.state!.closedTrades!.length, 1);
  advance(24 * 3600_000 + 1);
  await w.poll();
  assert.equal(state.state!.closedTrades!.length, 0);
});

test('state saved before closes were remembered still loads', async () => {
  const state = new MemoryState();
  state.state = { version: 1, seenPostIds: [], seenTradeUpdates: [], savedAt: 1_000_000 };
  const { invo, make } = setup({ state, ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.publish(post('alice', 't1', 'close'));
  assert.deepEqual(signals(await make().poll()).map(x => x.action), ['close']);
});

test('if the ledger can\'t be read, each newly seen followed-trader close is passed on once', async () => {
  const { invo, advance } = setup();
  let broken = false;
  const w = new SignalWatcher({
    invo, registry: fakeRegistry(['bob']),
    ledger: { load: () => { if (broken) throw new Error('ledger unreadable'); return []; } },
    state: new MemoryState(), now: () => clock,
  });
  await w.poll();
  invo.publish(post('bob', 't4', 'close'));
  assert.deepEqual(signals(await w.poll()), []); // ledger fine, no copy: remembered only
  broken = true;
  invo.publish(post('bob', 't5', 'close'));
  // Only the new close, not every remembered one
  assert.deepEqual(signals(await w.poll()).map(x => x.mimicMeta.sourcePaperTradeBaseId), ['base-t5']);
  advance(120_000);
  assert.deepEqual(signals(await w.poll()), []);
});

test('/dex/trade updates are informational and do not end --wait-for-signal', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.tradeItems.push({ baseShortId: 'short-t1', isOpen: true, lastUpdate: 'y' });
  const events = await w.poll();
  assert.ok(events.some(e => e.data.type === 'trade_update'));
  assert.ok(!events.some(e => e.signal));
});

test('an open and a close of the same trade in one poll: the open is dropped, in either feed order', async () => {
  for (const order of ['open first', 'close first']) {
    const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
    const w = make();
    await w.poll();
    const open = post('alice', 't1');
    const close = post('alice', 't1', 'close');
    if (order === 'open first') invo.publish(open, close); else invo.publish(close, open);
    const events = await w.poll();
    assert.deepEqual(signals(events).map(x => x.action), ['close'], order);
    assert.deepEqual(skipped(events).map(x => x.reason), ['open of a trade that is already closed'], order);
  }
});

test('ambiguous trade changes are emitted as update, never as an open', async () => {
  const { invo, make } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'update'), post('alice', 't2', 'open', { update: { changes: undefined } }));
  assert.deepEqual(signals(await w.poll()).map(x => x.action), ['update', 'update']);
});
