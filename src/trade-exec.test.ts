import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade, UsageError } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry } from './test-fakes.js';

let ids = 0;
function setup(opts: { positions?: Record<string, number>; ledger?: MemoryLedgerStore; fillRatio?: number; failRecordOpen?: boolean } = {}) {
  const hl = fakeHl({ positions: opts.positions, fillRatio: opts.fillRatio });
  const invo = fakeInvo({ failRecordOpen: opts.failRecordOpen });
  const ledger = opts.ledger ?? new MemoryLedgerStore();
  const deps = { hl, invo, ledger, newId: () => `tx-${++ids}`, now: () => new Date('2026-10-02T12:00:00Z') };
  return { hl, invo, ledger, deps, trade: (args: (string | undefined)[]) => runTrade(args as string[], deps) };
}
const meta = (trader: string, trade: string) => JSON.stringify(signalMeta(trader, trade));

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
});

test('an increase on the same trader\'s trade adds to that copy', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { ledger: l, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.sizing.mode, 'increase');
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].id, 'tx-alice');
  assert.equal(l.entries[0].qty, Number((0.5 + out.filledQty).toFixed(2)));
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

test('a ledger write failure after a fill is reported', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failSave = true;
  const { trade } = setup({ ledger });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.ok(out.filledQty > 0);
  assert.match(out.ledger.error!, /ledger write failed: disk full/);
});

test('no fill records nothing', async () => {
  const { ledger, trade } = setup({ fillRatio: 0 });
  const out = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  assert.equal(out.filledQty, 0);
  assert.equal(ledger.entries.length, 0);
});

// --- End to end with fakes: open two traders' copies, close one ---

test('two traders copied into one coin: each close signal closes only that trader\'s copy', async () => {
  const { hl, ledger, deps, trade } = setup();
  const a = await trade(['SOL', 'long', 'auto', '5', meta('alice', 't1')]);
  const b = await trade(['SOL', 'long', 'auto', '5', meta('bob', 't2')]);
  const total = Number((a.filledQty + b.filledQty).toFixed(2));
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
