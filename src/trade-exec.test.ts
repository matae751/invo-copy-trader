import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade, UsageError } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry } from './test-fakes.js';

let ids = 0;
type HlOpts = NonNullable<Parameters<typeof fakeHl>[0]>;
function setup(opts: HlOpts & { ledger?: MemoryLedgerStore; failRecordOpen?: boolean } = {}) {
  const { ledger: givenLedger, failRecordOpen, ...hlOpts } = opts;
  const hl = fakeHl(hlOpts);
  const invo = fakeInvo({ failRecordOpen });
  const ledger = givenLedger ?? new MemoryLedgerStore();
  const deps = {
    hl, invo, ledger,
    newId: () => `tx-${++ids}`,
    newCloid: () => `0xcloid${ids}`,
    now: () => new Date('2026-10-02T12:00:00Z'),
  };
  return { hl, invo, ledger, deps, trade: (args: (string | undefined)[]) => runTrade(args as string[], deps) };
}
const meta = (trader: string, trade: string, update = trade) => JSON.stringify(signalMeta(trader, trade, update));

// --- mimicMeta / argument validation: nothing is touched on failure ---

test('missing or invalid mimicMeta is refused before HL, Invo or the ledger are touched', async () => {
  const { sourcePaperTradeBaseShortId, ...noShortId } = signalMeta('alice', 't1');
  const cases: [string, string | undefined, RegExp][] = [
    ['no argument', undefined, /mimicMeta is required/],
    ['empty', '', /mimicMeta is required/],
    ['not JSON', '{oops', /not valid JSON/],
    ['not an object', '"x"', /must be a JSON object/],
    ['old monitor shape', JSON.stringify({ portfolioId: 'p', creatorInvoUserId: 'u', baseId: 'b', baseShortId: 's' }), /old \{baseId, baseShortId\}/],
    ['missing trader baseShortId', JSON.stringify(noShortId), /missing sourcePaperTradeBaseShortId/],
    ['blank trader id', JSON.stringify({ ...signalMeta('alice', 't1'), creatorInvoUserId: '' }), /missing creatorInvoUserId/],
  ];
  for (const [name, arg, err] of cases) {
    const { hl, invo, ledger, trade } = setup();
    await assert.rejects(trade(['SOL', 'long', 'auto', '5', arg]), err, name);
    assert.deepEqual(hl.calls, [], name);
    assert.deepEqual(invo.calls, [], name);
    assert.equal(ledger.saves, 0, name);
  }
});

test('bad leverage is refused before anything is touched; leverage over the asset max before any order', async () => {
  for (const lev of [undefined, 'abc', '0', '2.5']) {
    const { hl, invo, trade } = setup();
    await assert.rejects(trade(['SOL', 'long', 'auto', lev, meta('alice', 't1')]), /leverage must be a whole number/);
    assert.deepEqual([hl.calls, invo.calls], [[], []]);
  }
  const { hl, invo, trade } = setup();
  await assert.rejects(trade(['SOL', 'long', 'auto', '21', meta('alice', 't1')]), /exceeds SOL max of 20x/);
  assert.deepEqual(hl.calls, ['connect', 'getMeta']);
  assert.deepEqual(invo.calls, []);
});

test('bad coin/side is a usage error', async () => {
  const { hl, trade } = setup();
  await assert.rejects(trade([]), UsageError);
  await assert.rejects(trade(['SOL', 'up', 'auto', '5', 'manual']), UsageError);
  assert.deepEqual(hl.calls, []);
});

test('an unreadable ledger is refused before trading', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failLoad = true;
  const { hl, invo, trade } = setup({ ledger });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]), /unreadable/);
  assert.deepEqual([hl.calls, invo.calls], [[], []]);
});

test('an opposite-direction position is refused before leverage or orders', async () => {
  const { hl, trade } = setup({ positions: { SOL: -0.5 } });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]), /existing position is short/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
});

// --- Leverage is per coin: never change it under an existing position ---

test('adding to a position at a different leverage is refused before leverage, ledger or orders change', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, invo, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: { type: 'isolated', value: 3 } }, ledger });
  await assert.rejects(trade(['SOL', 'long', 'auto', '20', meta('bob', 't2')]),
    /Refusing 20x on SOL: the existing SOL position is 3x isolated.*Re-run with 3/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.saves, 0);
});

test('an existing position that is cross, or whose leverage can\'t be read, is refused', async () => {
  for (const lev of [{ type: 'cross', value: 5 }, undefined, { type: 'isolated' }, { type: 'isolated', value: NaN }]) {
    const { hl, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: lev } });
    await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]), /leverage can't be confirmed as isolated/, JSON.stringify(lev));
    assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'), JSON.stringify(lev));
  }
});

test('adding at the existing leverage works; a new position sets its own', async () => {
  const { hl, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: { type: 'isolated', value: 3 } } });
  const add = await trade(['SOL', 'long', 'auto', '3', meta('bob', 't2')]);
  assert.equal(add.status, 'filled');
  assert.deepEqual(hl.leverage, [['SOL', 3]]);

  const fresh = setup();
  assert.equal((await fresh.trade(['ETH', 'long', 'auto', '10', meta('carol', 't3')])).status, 'filled');
  assert.deepEqual(fresh.hl.leverage, [['ETH', 10]]);
  // The next copy in ETH must now match 10x
  await assert.rejects(fresh.trade(['ETH', 'long', 'auto', '5', meta('dave', 't4')]), /existing ETH position is 10x isolated/);
});

// --- Trader (copy) path ---

test('copying a trader sends their mimicMeta, sizes from their stats and records the copy in the ledger', async () => {
  const { hl, invo, ledger, trade } = setup();
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);

  assert.deepEqual(invo.recorded[0].mimicMeta, signalMeta('alice', 't1'));
  assert.ok(invo.calls.includes('getUserPortfolios:alice') && invo.calls.includes('getPortfolioById:p-alice'));
  assert.equal(out.sizing.tier, 'strong');
  assert.equal(out.sizing.statsLookup, 'ok');
  assert.deepEqual(hl.leverage, [['SOL', 5]]);
  assert.equal(hl.orders.length, 1);
  assert.equal(hl.orders[0].isBuy, true);
  assert.equal(hl.orders[0].reduceOnly, false);
  assert.equal(hl.orders[0].szDecimals, 2);
  assert.equal(out.status, 'filled');

  assert.equal(out.manual, false);
  assert.equal(out.sourceBaseShortId, 'short-t1');
  assert.equal(out.positionRecordId, 'rec-1');
  assert.equal(out.filledQty, parseFloat(out.size));
  assert.equal(ledger.entries.length, 1);
  const e = ledger.entries[0];
  assert.deepEqual(
    [e.id, e.coin, e.side, e.qty, e.status, e.positionRecordIds],
    [out.clientTxId, 'SOL', 'long', out.filledQty, 'open', ['rec-1']]);
  assert.deepEqual(e.source, {
    creatorInvoUserId: 'alice', portfolioId: 'p-alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1',
  });
  assert.deepEqual(out.ledger, { entryId: e.id, copyQty: e.qty });
  assert.deepEqual(e.sourceUpdateIds, ['upd-t1']);
});

test('an increase (a new update on the same trader\'s trade) adds to that copy', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { ledger: l, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1', 't1-add')]);
  assert.equal(out.sizing.mode, 'increase');
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].id, 'tx-alice');
  assert.equal(l.entries[0].qty, Number((0.5 + out.filledQty!).toFixed(2)));
  assert.deepEqual(l.entries[0].sourceUpdateIds, ['upd-t1', 'upd-t1-add']);
});

// --- Each trader update is copied once ---

test('the same trader update is never copied twice, even after its copy closed', async () => {
  const { hl, invo, ledger, deps, trade } = setup();
  const first = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(first.status, 'filled');
  const position = hl.positions.SOL;

  for (const label of ['repeat while open', 'repeat after close']) {
    const callsBefore = [hl.calls.length, invo.calls.length, ledger.saves];
    await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]), /Already copied trader update upd-t1/, label);
    assert.deepEqual([hl.calls.length, invo.calls.length, ledger.saves], callsBefore, `${label}: nothing touched`);
    if (label === 'repeat while open') {
      assert.equal(hl.positions.SOL, position);
      assert.equal((await runClose(['SOL', meta('alice', 't1')], deps)).status, 'closed');
    }
  }
  assert.equal(hl.positions.SOL, 0);
});

test('an update that did not fill can be retried', async () => {
  const { hl, ledger, deps } = setup({ fillRatio: 0 });
  assert.equal((await runTrade(['SOL', 'long', 'auto', '5', meta('alice', 't1')], deps)).status, 'not_filled');
  const retry = await runTrade(['SOL', 'long', 'auto', '5', meta('alice', 't1')], { ...deps, hl: fakeHl() });
  assert.equal(retry.status, 'filled');
  assert.equal(ledger.entries.length, 1);
  assert.equal(hl.orders.length, 1);
});

// --- Hyperliquid rejections are not mistaken for success ---

test('a rejected leverage change stops the trade before any order', async () => {
  const { hl, invo, ledger, trade } = setup({ rejectLeverage: true });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]), /Setting SOL to 5x isolated rejected by Hyperliquid: .*Cannot switch leverage type/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.saves, 0);
});

test('a rejected order reports not_filled with the reason and records nothing anywhere', async () => {
  const { hl, invo, ledger, trade } = setup({ rejectOrder: true });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'not_filled');
  assert.match(out.orderError!, /Insufficient margin/);
  assert.equal(out.filledQty, 0);
  assert.equal(hl.positions.SOL, undefined);
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(out.invoResult, null);
  assert.equal(ledger.entries.length, 0);
});

// --- Stale ledger entries are reconciled with the live position ---

test('entries for a position that is gone are closed before trading, so later closes work', async () => {
  // Alice's copy was liquidated outside this tool: ledger still says 0.5 open, HL is flat
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, deps, trade } = setup({ ledger });

  const bob = await trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]);
  assert.equal(bob.sizing.mode, 'initial');
  assert.deepEqual(bob.reconciledEntryIds, ['tx-alice']);
  const alice = ledger.entries.find(e => e.id === 'tx-alice')!;
  assert.deepEqual([alice.status, alice.qty], ['closed', 0]);
  assert.match(alice.closeReason!, /no SOL position/);

  // Without reconciliation this was refused ("smaller than the copies tracked")
  const closeBob = await runClose(['SOL', meta('bob', 't2')], deps);
  assert.equal(closeBob.status, 'closed');
  assert.equal(hl.positions.SOL, 0);
});

test('a new update on a stale trade starts a fresh copy instead of merging into the stale one', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { trade } = setup({ ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1', 't1-add')]);
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status, e.qty]),
    [['tx-alice', 'closed', 0], [out.clientTxId, 'open', out.filledQty]]);
});

test('entries on the other side of the live position are reconciled even when the trade is refused', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1', 'long')]);
  const { hl, trade } = setup({ positions: { SOL: -0.3 }, ledger });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]), /existing position is short/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.entries[0].status, 'closed');
});

test('a ledger write failure while reconciling stops the trade before any order', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  ledger.failSave = true;
  const { hl, trade } = setup({ ledger });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]), /disk full/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
});

test('another trader in the same coin gets a separate copy', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { ledger: l, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]);
  assert.deepEqual(l.entries.map(e => [e.id, e.source?.creatorInvoUserId, e.qty]),
    [['tx-alice', 'alice', 0.5], [out.clientTxId, 'bob', out.filledQty]]);
});

// --- Manual path ---

test('`manual` sends no mimicMeta, skips the stats lookup and records an unlinked entry', async () => {
  const { invo, ledger, trade } = setup();
  const out = await trade(['SOL', 'long', 'auto', '5', 'manual']);
  assert.ok(!('mimicMeta' in invo.recorded[0]));
  assert.deepEqual(invo.calls, ['recordOpen']);
  assert.equal(out.sizing.tier, 'poor');
  assert.equal(out.manual, true);
  assert.equal(out.sourceBaseShortId, null);
  assert.equal(ledger.entries[0].source, null);
});

// --- Failures after the order ---

test('an Invo record failure still records the copy (the HL position exists)', async () => {
  const { ledger, trade } = setup({ failRecordOpen: true });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.match(out.invoResult.error, /500/);
  assert.equal(out.positionRecordId, null);
  assert.equal(ledger.entries.length, 1);
  assert.deepEqual(ledger.entries[0].positionRecordIds, []);
});

test('a ledger that can\'t be written stops the trade before any order', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failSave = true;
  const { hl, trade } = setup({ ledger });
  await assert.rejects(trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]), /disk full/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('a ledger write failure after a fill is reported, and the order stays pending to be settled', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failSavesAfter = 1; // the pending write works; recording the fill fails
  const { trade } = setup({ ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'filled');
  assert.ok(out.filledQty! > 0);
  assert.match(out.ledger.error!, /ledger write failed: disk full.*stays pending/);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', out.cloid]]);
});

test('no fill records nothing, on Invo or in the ledger', async () => {
  const { invo, ledger, trade } = setup({ fillRatio: 0 });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'not_filled');
  assert.match(out.orderError!, /could not immediately match/);
  assert.equal(out.filledQty, 0);
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.entries.length, 0);
});

// --- Lost responses and crashes: a fill is never left untracked ---

test('the fill comes from the order, not the position, so other activity in the coin is not counted', async () => {
  // Someone else's 1.0 SOL lands between our snapshot and our fill
  const { ledger, trade } = setup({ beforeOrder: p => { p.SOL = (p.SOL ?? 0) + 1; } });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.filledQty, parseFloat(out.size));
  assert.equal(ledger.entries[0].qty, parseFloat(out.size));
});

test('a response lost after HL filled the order: the fill is looked up by cloid and recorded', async () => {
  for (const opts of [{ orderThrows: 'after' as const }, { opaqueOrderResponse: true }]) {
    const { hl, ledger, trade } = setup(opts);
    const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
    assert.equal(out.status, 'filled');
    assert.ok(hl.calls.includes(`getOrderFill:${out.cloid}`));
    assert.deepEqual(ledger.entries.map(e => [e.status, e.qty, e.pendingOrder]), [['open', out.filledQty, undefined]]);
  }
});

test('a failed request HL has no record of stays pending: it may still arrive', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'before' });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'unknown');
  assert.match(out.orderError!, /order request failed: ECONNRESET/);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', out.cloid]]);

  // Too soon to conclude it never reached HL: trading the coin is refused, no order
  const hl2 = fakeHl();
  await assert.rejects(runTrade(['SOL', 'long', 'auto', '5', meta('bob', 't2')], { ...deps, hl: hl2 }), /isn't on HL 0s after it was sent — it may still arrive/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));

  // A minute later it is settled as never sent: the copy is dropped and the update can be retried
  const later = { ...deps, hl: fakeHl(), now: () => new Date('2026-10-02T12:01:00Z') };
  const retry = await runTrade(['SOL', 'long', 'auto', '5', meta('alice', 't1')], later);
  assert.equal(retry.status, 'filled');
  assert.deepEqual(retry.settledPendingOrders, [{ entryId: out.clientTxId, kind: 'open', cloid: out.cloid, filledQty: 0 }]);
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status]), [[retry.clientTxId, 'open']]);
});

test('a failed request that did reach HL is found by cloid and recorded', async () => {
  const { ledger, trade } = setup({ orderThrows: 'after' });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'filled');
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty]), [['open', out.filledQty]]);
});

test('the position read failing after the order does not lose the fill', async () => {
  const { ledger, trade } = setup({ failPositionsAfterOrder: true });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.status, 'filled');
  assert.equal(out.qtyAfter, out.size);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty]), [['open', out.filledQty]]);
});

test('fill unknown: the order stays pending, and the next run in the coin settles it first', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'after', failOrderLookup: true });
  const lost = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(lost.status, 'unknown');
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', lost.cloid]]);

  // The same update again: once settled, it's a repeat and refused before any order
  const hl2 = fakeHl({ positions: { SOL: 0.76 }, orderFills: { [lost.cloid]: 0.76 } });
  await assert.rejects(runTrade(['SOL', 'long', 'auto', '5', meta('alice', 't1')], { ...deps, hl: hl2 }), /Already copied trader update upd-t1/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty, e.pendingOrder]), [['open', 0.76, undefined]]);

  // ...and the settled copy closes normally on its trader's signal
  assert.equal((await runClose(['SOL', meta('alice', 't1')], { ...deps, hl: hl2 })).status, 'closed');
});

test('an unsettled order that can\'t be looked up blocks trading in that coin', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'after', failOrderLookup: true });
  await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  const hl2 = fakeHl({ failOrderLookup: true });
  await assert.rejects(runTrade(['SOL', 'long', 'auto', '5', meta('bob', 't2')], { ...deps, hl: hl2 }), /can't settle the open order/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));
  assert.equal(ledger.entries[0].status, 'pending');
});

// --- End to end with fakes: open two traders' copies, close one ---

test('two traders copied into one coin: each close signal closes only that trader\'s copy', async () => {
  const { hl, ledger, deps, trade } = setup();
  const a = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  const b = await trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]);
  const total = Number((a.filledQty! + b.filledQty!).toFixed(2));
  assert.equal(hl.positions.SOL, total);

  // A third trader's close in SOL does nothing
  const other = await runClose(['SOL', meta('carol', 't1')], deps);
  assert.equal(other.status, 'refused');
  assert.equal(hl.positions.SOL, total);

  const closeA = await runClose(['SOL', meta('alice', 't1')], deps);
  assert.equal(closeA.status, 'closed');
  assert.equal(hl.positions.SOL, b.filledQty);

  // Alice's close again: her copy is already closed
  assert.equal((await runClose(['SOL', meta('alice', 't1')], deps)).status, 'refused');
  assert.equal(hl.positions.SOL, b.filledQty);

  const closeB = await runClose(['SOL', meta('bob', 't2')], deps);
  assert.equal(closeB.status, 'closed');
  assert.equal(hl.positions.SOL, 0);
  assert.deepEqual(ledger.entries.map(e => e.status), ['closed', 'closed']);
});
