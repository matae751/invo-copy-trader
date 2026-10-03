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
      // Live shapes (2026-10-02): changes holds the previous values of what changed.
      // A new trade is exactly { isAdded: false }; a close { isOpen: true, reasonClosed: null }.
      // An update's shape hasn't been seen live; any other changes object is an ambiguous update.
      changes: kind === 'open' ? { isAdded: false } : kind === 'close' ? { isOpen: true, reasonClosed: null } : { entrySize: 2.5 },
      ...extra.update,
    },
  };
}

/**
 * A /dex/trade entry in the live shape (captured 2026-10-02) for `owner`'s trade `trade`.
 * There is no isOpen: a close is an update with updateType "close".
 */
function dexTrade(owner: string, trade: string, updates: { updateType: string; updatedAt?: string; investmentId?: string; details?: object }[]) {
  return {
    creatorAppUserId: owner,
    portfolioId: `p-${owner}`,
    investmentBaseId: `base-${trade}`,
    investmentBaseShortId: `short-${trade}`,
    unmimickedCount: updates.length,
    unseenCount: updates.length,
    updates: updates.map((u, i) => ({
      investmentId: u.investmentId ?? `inv-${trade}-${i}`,
      investmentBaseId: `base-${trade}`,
      isSeen: false,
      updatedAt: u.updatedAt ?? '2026-10-02T14:31:15.806Z',
      updateType: u.updateType,
      isMimicked: false,
      details: u.details ?? {},
    })),
  };
}

/** Feed newest-first; `lastPostId` pages to older posts (or is ignored, like a broken cursor). */
function fakeInvo(opts: { ignoreCursor?: boolean } = {}) {
  const feed: any[] = [];
  /** /dex/trade `data` entries (see dexTrade); `rawTradeResponse` replaces the whole response. */
  const trades: any[] = [];
  const calls = { getFeed: [] as (string | null)[], getTradeUpdates: [] as WatchEntry[][] };
  return {
    feed, trades, calls,
    rawTradeResponse: undefined as unknown,
    publish(...posts: any[]) { feed.unshift(...posts.reverse()); },
    async getFeed(_filter: string, lastPostId: string | null, itemLimit: number) {
      calls.getFeed.push(lastPostId);
      const start = lastPostId && !opts.ignoreCursor ? feed.findIndex(p => p.id === lastPostId) + 1 : 0;
      return { items: feed.slice(start, start + itemLimit) };
    },
    async getTradeUpdates(investments: WatchEntry[]) {
      calls.getTradeUpdates.push(investments);
      return this.rawTradeResponse ?? { success: true, data: trades };
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
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'close', details: { closePrice: 150, reasonClosed: 'user_closed' } }]));

  // Even on a fresh start (closes of our copies are never just indexed)
  const s = signals(await make().poll());
  assert.deepEqual(invo.calls.getTradeUpdates[0].map(w => w.baseShortId), ['short-t1']);
  assert.deepEqual(s.map(x => [x.source, x.action, x.mimicMeta]), [['trade_poll', 'close', {
    portfolioId: 'p-alice', creatorInvoUserId: 'alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1',
  }]]);
});

test('closes of trades we hold no copy of are skipped; each close is emitted once', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'close' }]));
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

test('/dex/trade tp/sl updates on a copied trade become tpsl signals, once each', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  // As on the live WLD trade: a TP and an SL set together
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'tp', investmentId: 'v2', updatedAt: '2026-10-02T19:31:31.448Z', details: { priceTarget: 0.58 } },
    { updateType: 'sl', investmentId: 'v2', updatedAt: '2026-10-02T19:31:31.448Z', details: { stopLoss: 0.516, stopLossBefore: 0.5 } },
  ]));
  const events = await w.poll();
  assert.deepEqual(events.filter(e => e.data.type === 'trade_update').map(e => [e.data.updateType, e.data.baseShortId]), [['tp', 'short-t1'], ['sl', 'short-t1']]);
  const s = signals(events);
  assert.deepEqual(s.map(x => [x.action, x.change.which, x.change.triggerPx, x.trade.coin, x.trade.side, x.entryId]),
    [['tpsl', 'tp', 0.58, 'SOL', 'long', 'tx-a'], ['tpsl', 'sl', 0.516, 'SOL', 'long', 'tx-a']]);
  assert.equal(s[1].change.triggerPxBefore, 0.5);
  assert.deepEqual(s[0].mimicMeta, { portfolioId: 'p-alice', creatorInvoUserId: 'alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1' });
  assert.notEqual(s[0].updateId, s[1].updateId);
  assert.ok(events.filter(e => e.data.type === 'signal').every(e => e.signal), 'they end --wait-for-signal');
  // The same updates aren't reported again
  const again = await w.poll();
  assert.equal(again.filter(e => e.data.type === 'trade_update' || e.data.type === 'signal').length, 0);
});

test('/dex/trade increases and decreases of a copied trade become signals, in the order the trader made them', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  clock = Date.parse('2026-10-02T18:00:00.000Z');
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'decrease', investmentId: 'v3', updatedAt: '2026-10-02T17:59:00.000Z', details: { positionSizeBefore: 0.1, positionSizeAfter: 0.075, positionSizeChange: 0.025 } },
    { updateType: 'increase', investmentId: 'v2', updatedAt: '2026-10-02T17:58:00.000Z', details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } },
  ]));
  const s = signals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.investmentId, x.change.positionSizeBefore, x.change.positionSizeAfter]),
    [['increase', 'v2', 0.05, 0.1], ['decrease', 'v3', 0.1, 0.075]]);
});

test('an increase older than the signal age limit, or a change made before our copy opened, is skipped', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] }); // opened 2026-10-01T00:00Z
  const w = make();
  await w.poll();
  clock = Date.parse('2026-10-02T18:00:00.000Z');
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'increase', investmentId: 'v1', updatedAt: '2026-09-30T12:00:00.000Z', details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } },
    { updateType: 'tp', investmentId: 'v1', updatedAt: '2026-09-30T12:00:00.000Z', details: { priceTarget: 150 } },
    { updateType: 'increase', investmentId: 'v2', updatedAt: '2026-10-02T17:50:00.000Z', details: { positionSizeBefore: 0.1, positionSizeAfter: 0.2, positionSizeChange: 0.1 } },
    { updateType: 'decrease', investmentId: 'v3', updatedAt: '2026-10-02T12:00:00.000Z', details: { positionSizeBefore: 0.2, positionSizeAfter: 0.1, positionSizeChange: 0.1 } },
  ]));
  const events = await w.poll();
  // The TP set before our copy opened still applies (it's the trader's current TP); a stale decrease still applies too
  assert.deepEqual(signals(events).map(x => [x.action, x.investmentId]), [['tpsl', 'v1'], ['decrease', 'v3']]);
  assert.deepEqual(skipped(events).map(x => [x.updateType, x.reason.split(' — ')[0]]),
    [['increase', 'increase made before our copy opened (our size is set from our equity at open)'], ['increase', 'increase made 600s ago']]);
});

test('changes to a trade its trader already closed are skipped; the close wins', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'close', investmentId: 'v3', updatedAt: '2026-10-02T17:59:00.000Z', details: { closePrice: 140, reasonClosed: 'liquidated' } },
    { updateType: 'sl', investmentId: 'v2', updatedAt: '2026-10-02T17:58:00.000Z', details: { stopLoss: 90 } },
  ]));
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => [x.action, x.reasonClosed]), [['close', 'liquidated']]);
  assert.match(skipped(events)[0].reason, /already closed/);
});

test('an unknown /dex/trade change on a copied trade is reported as skipped, never guessed at', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'leverage', details: { leverage: 10 } }]));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  assert.match(skipped(events)[0].reason, /unknown \/dex\/trade updateType "leverage" — not replicated/);
});

test('a copy is watched on /dex/trade from when its trader opened, so earlier TP/SL changes are seen', async () => {
  const { invo, make } = setup({ ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), traderOpenedAt: '2026-09-30T23:59:00.000Z' }] });
  await make().poll();
  assert.deepEqual(invo.calls.getTradeUpdates[0], [{ baseShortId: 'short-t1', mimicStartedAt: '2026-09-30T23:59:00.000Z' }]);
});

test('open signals carry the trader\'s TP/SL and open time; a post that doesn\'t say leaves them out', async () => {
  const { invo, make } = setup();
  const w = make();
  await w.poll();
  invo.publish(
    post('alice', 't1', 'open', { update: { priceTarget: 160, stopLoss: null, createdAt: '2026-10-02T19:30:52.339Z', leverage: 10, directionLong: true, entryPrice: 150 } }),
  );
  const [s] = signals(await w.poll());
  assert.deepEqual([s.trade.priceTarget, s.trade.stopLoss, s.trade.openedAt, s.trade.leverage, s.trade.entryPrice], [160, null, '2026-10-02T19:30:52.339Z', 10, 150]);

  invo.publish(post('bob', 't2'));
  const [s2] = signals(await w.poll());
  assert.ok(!('priceTarget' in s2.trade) && !('stopLoss' in s2.trade));
});

test('the live /dex/trade close response (captured 2026-10-02) becomes a close signal for our copy', async () => {
  const owner = '8439473c-be0a-4738-a7f5-6b932d551f0f';
  const copy: CopyEntry = {
    ...copyEntry('tx-eth', 'ETH', 0.01, 'x', 'x'),
    source: {
      creatorInvoUserId: owner,
      portfolioId: '1f70989c-4bc7-4ee2-86a6-5d5aa5642359',
      sourcePaperTradeBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
      sourcePaperTradeBaseShortId: 'QeGEOGIhfF',
    },
  };
  const { invo, make } = setup({ following: [], ledger: [copy] });
  invo.rawTradeResponse = {
    success: true,
    data: [{
      creatorAppUserId: owner,
      portfolioId: '1f70989c-4bc7-4ee2-86a6-5d5aa5642359',
      investmentBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
      investmentBaseShortId: 'QeGEOGIhfF',
      unmimickedCount: 1,
      unseenCount: 1,
      updates: [{
        investmentId: '254923ca-1dff-4b6d-818e-5ab3515db8ac',
        investmentBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
        isSeen: false,
        updatedAt: '2026-10-02T14:31:15.806Z',
        updateType: 'close',
        isMimicked: false,
        details: { closePrice: 2730.7, reasonClosed: 'user_closed' },
      }],
    }],
  };
  const s = signals(await make().poll());
  assert.deepEqual(invo.calls.getTradeUpdates[0].map(w => w.baseShortId), ['QeGEOGIhfF']);
  assert.deepEqual(s.map(x => [x.source, x.action, x.trade.coin, x.trade.closingPrice, x.mimicMeta.sourcePaperTradeBaseId]),
    [['trade_poll', 'close', 'ETH', 2730.7, '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d']]);
});

test('a /dex/trade close for another trader\'s trade with the same short id is not ours', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push({ ...dexTrade('mallory', 't1', [{ updateType: 'close' }]), investmentBaseId: undefined });
  assert.deepEqual(signals(await make().poll()), []);
});

test('a liquidation update also counts as the trade being over', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated' }]));
  assert.deepEqual(signals(await make().poll()).map(x => x.action), ['close']);
});

test('an unrecognised /dex/trade response is reported, not read as "no updates" silently', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  for (const raw of [{ investments: [] }, { success: false, error: 'boom' }]) {
    invo.rawTradeResponse = raw;
    const events = await make().poll();
    assert.ok(events.some(e => e.stream === 'err' && e.data.source === 'trade' && /unrecognised \/dex\/trade response/.test(String(e.data.message))), JSON.stringify(raw));
  }
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
