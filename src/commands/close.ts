import { validateEnv, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import { runClose } from '../close-exec.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';

validateEnv();

// Invo isn't called: it auto-detects HL closes, and /dex/position/close needs our
// own position's baseShortId, which /dex/position/create never returns.
runClose(process.argv.slice(2), {
  hl: {
    connect: () => hl.connect(HL_AGENT_KEY, WALLET_ADDRESS),
    getMeta: hl.getMeta,
    getAllMids: hl.getAllMids,
    getPositions: () => hl.getPositions(WALLET_ADDRESS),
    placeMarketOrder: hl.placeMarketOrder,
  },
  ledger: new FileLedgerStore(defaultLedgerPath()),
})
  .then(out => {
    console.log(JSON.stringify(out));
    if (out.status === 'refused' || out.status === 'not_filled' || ('ledgerError' in out && out.ledgerError)) process.exitCode = 1;
  })
  .catch(e => { console.error(e.message); process.exit(1); });
