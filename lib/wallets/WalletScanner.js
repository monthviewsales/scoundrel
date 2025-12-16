const { address } = require("@solana/addresses");
const logger = require("../logger");

const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Scans a wallet via raw RPC and returns token holdings, including SOL.
 *
 * @param {import('@solana/kit').SolanaRpc} rpc - Solana RPC client from @solana/kit.
 * @param {string} ownerAddress - Base58 wallet address.
 * @param {number} retries - Number of retry attempts on failure.
 * @returns {Promise<Array>} - Array of token balances with metadata.
 */
async function scanWalletViaRpc(rpc, ownerAddress, retries = 2) {
  const owner =
    typeof ownerAddress === "string" ? ownerAddress : ownerAddress?.toString();
  if (!owner) {
    throw new Error("[WalletScanner] ownerAddress must be a base58 string");
  }
  const ownerAddr = address(owner);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTransient = (err) => {
    const msg = String(err && (err.message || err));
    return (
      /timeout/i.test(msg) ||
      /temporarily\s+unavailable/i.test(msg) ||
      /EAI_AGAIN|ECONNRESET|ENETUNREACH|ECONNABORTED/i.test(msg) ||
      /(502|503|504|520|521|522|523|524|525|526|527)/.test(msg) ||
      /429/.test(msg) ||
      /rate\s*limit/i.test(msg)
    );
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const holdings = [];

      // Fetch SPL token accounts (jsonParsed) at confirmed commitment
      const { value: tokenAccounts } = await rpc
        .getTokenAccountsByOwner(
          ownerAddr,
          { programId: address(TOKEN_PROGRAM_ADDRESS) },
          { encoding: "jsonParsed", commitment: "confirmed" }
        )
        .send();

      for (const { account } of tokenAccounts) {
        const parsed = account?.data?.parsed?.info;
        if (!parsed) continue;

        // uiAmount may be null; prefer uiAmountString then fall back
        const amtStr =
          parsed.tokenAmount?.uiAmountString ??
          (parsed.tokenAmount?.uiAmount != null
            ? String(parsed.tokenAmount.uiAmount)
            : "0");

        const amount = Number.parseFloat(amtStr);
        const decimals = parsed.tokenAmount?.decimals ?? 0;

        if (Number.isFinite(amount) && amount > 0) {
          holdings.push({
            mint: parsed.mint,
            amount,
            decimals,
            symbol: null, // jsonParsed token account doesn't include symbol
            isNative: false,
          });
        }
      }

      // Fetch SOL balance at confirmed commitment
      const { value: lamports } = await rpc
        .getBalance(ownerAddr, { commitment: "confirmed" })
        .send();
      holdings.push({
        mint: "So11111111111111111111111111111111111111112",
        amount: Number(lamports) / 1e9,
        decimals: 9,
        symbol: "SOL",
        isNative: true,
      });

      logger.info(
        `[WalletScanner] Found ${holdings.length} tokens in wallet ${owner}`
      );
      holdings.forEach((h) => {
        logger.debug(
          `[WalletScanner] Token: ${h.mint}, amount: ${h.amount}, native: ${h.isNative}`
        );
      });

      return holdings;
    } catch (err) {
      const msg = String(err && (err.message || err));
      logger.warn(
        `[WalletScanner] Error scanning wallet (attempt ${attempt + 1}): ${msg}`
      );

      if (attempt < retries && isTransient(err)) {
        const delay = Math.min(300 * 2 ** attempt + Math.random() * 150, 2000);
        await sleep(delay);
        continue;
      }
      // Non-transient or retries exhausted
      if (attempt === retries) throw err;
      await sleep(400); // small yield before final retry
    }
  }
}

module.exports = {
  scanWalletViaRpc,
};
