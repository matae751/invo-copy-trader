import { validateEnv, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import { runClose } from '../close-exec.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';
import { withFileLock } from '../file-lock.js';

validateEnv();

const ledgerPath = defaultLedgerPath();

// Invo isn't called: it auto-detects HL closes, and /dex/position/close needs our
// own position's baseShortId, which /dex/position/create never returns.
// One trade/close at a time: each reads the ledger, trades, then rewrites it.
withFileLock(`${ledgerPath}.lock`, () => runClose(process.argv.slice(2), {
  hl: {
    connect: () => hl.connect(HL_AGENT_KEY, WALLET_ADDRESS),
    getMeta: hl.getMeta,
    getAllMids: hl.getAllMids,
    getPositions: () => hl.getPositions(WALLET_ADDRESS),
    getOrderFill: cloid => hl.getOrderFill(WALLET_ADDRESS, cloid),
    placeMarketOrder: hl.placeMarketOrder,
  },
  ledger: new FileLedgerStore(ledgerPath),
}))
  .then(out => {
    console.log(JSON.stringify(out));
    if (['refused', 'not_filled', 'unknown'].includes(out.status) || ('ledgerError' in out && out.ledgerError)) process.exitCode = 1;
  })
  .catch(e => { console.error(e.message); process.exit(1); });
