require("dotenv").config({ quiet: true });
const { registry, getWalletForSwap } = require('./lib/wallets');

(async () => {
  const row = await registry.getWalletByAlias('warlord');
  console.log('row:', row);
  const wallet = await getWalletForSwap(row);
  console.log({
    alias: wallet.alias,
    pubkeyDB: row.pubkey,
    signerAddress: String(wallet.signer.address),
  });
})();
