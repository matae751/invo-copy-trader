import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { runTrade } from '../trade-exec.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

runTrade(process.argv.slice(2), {
  hl: {
    connect: () => hl.connect(HL_AGENT_KEY, WALLET_ADDRESS),
    getMeta: hl.getMeta,
    getAllMids: hl.getAllMids,
    getPositions: () => hl.getPositions(WALLET_ADDRESS),
    setLeverage: hl.setLeverage,
    placeMarketOrder: hl.placeMarketOrder,
  },
  invo,
  ledger: new FileLedgerStore(defaultLedgerPath()),
})
  .then(out => {
    console.log(JSON.stringify(out));
    // Filled but not recorded: the copy can't be closed by a signal until fixed
    if (out.ledger.error && out.filledQty > 0) process.exitCode = 1;
  })
  .catch(e => { console.error(e.message); process.exit(1); });
