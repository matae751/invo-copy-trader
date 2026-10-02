import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileLedgerStore, recordCopyOpen, planCopyClose, floorQty } from './copy-ledger.js';
import { copyEntry } from './test-fakes.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'copy-ledger-test-'));
}

test('file ledger: missing file is empty, saves round-trip, no temp file left behind', () => {
  const dir = tempDir();
  try {
    const store = new FileLedgerStore(join(dir, 'nested', 'ledger.json'));
    assert.deepEqual(store.load(), []);
    const entries = [copyEntry('tx-1', 'SOL', 0.5, 'alice', 't1')];
    store.save(entries);
    assert.deepEqual(store.load(), entries);
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['ledger.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file ledger: corrupt or malformed file throws (fail closed)', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, '{not json');
    assert.throws(() => new FileLedgerStore(path).load(), /unreadable/);
    writeFileSync(path, JSON.stringify({ version: 1 }));
    assert.throws(() => new FileLedgerStore(path).load(), /malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manual fill never merges into a trader\'s copy', () => {
  const start = [copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')];
  const { entries } = recordCopyOpen(start, {
    id: 'tx-m', coin: 'SOL', side: 'long', qty: 0.2, szDecimals: 2, source: null, positionRecordId: null, now: 'now',
  });
  assert.deepEqual(entries.map(e => [e.id, e.qty]), [['tx-alice', 0.5], ['tx-m', 0.2]]);
});

test('close quantity is rounded down to the lot size, never up', () => {
  assert.equal(floorQty(0.129, 2), 0.12);
  assert.equal(floorQty(0.3, 2), 0.3); // no float drift below an exact lot
  const plan = planCopyClose(copyEntry('tx', 'SOL', 0.129, 'alice'), [], 1, 2);
  assert.deepEqual(plan, { kind: 'close', qty: 0.12, isLong: true, full: false });
});
