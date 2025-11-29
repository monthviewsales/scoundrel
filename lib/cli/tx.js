'use strict';

/**
 * tx processor for `scoundrel tx`
 *
 * Expected usage from index.js:
 *   const txProcessor = loadProcessor('tx');
 *   await txProcessor({ signature, cmd });
 */

const logger = require('../logger');

function renderTxSummary(summary) {
    if (!summary) {
        // eslint-disable-next-line no-console
        console.log('Transaction not found or expired.');
        return;
    }

    const s = summary;

    // eslint-disable-next-line no-console
    console.log(`Signature:      ${s.signature}`);
    // eslint-disable-next-line no-console
    console.log(`Status:         ${s.status}`);
    if (s.err) {
        // eslint-disable-next-line no-console
        console.log(`  Error:        ${JSON.stringify(s.err)}`);
    }

    // eslint-disable-next-line no-console
    console.log(`Slot:           ${s.slot}`);

    let blockTimeStr = 'N/A';
    if (s.blockTime != null) {
        try {
            const bt = typeof s.blockTime === 'bigint' ? Number(s.blockTime) : Number(s.blockTime);
            if (Number.isFinite(bt) && bt > 0) {
                blockTimeStr = new Date(bt * 1000).toISOString();
            }
        } catch (_) {
            blockTimeStr = String(s.blockTime);
        }
    }
    // eslint-disable-next-line no-console
    console.log(`Block Time:     ${blockTimeStr}`);

    // Network fee
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('Network Fee:');
    // eslint-disable-next-line no-console
    console.log(`  Lamports:     ${s.networkFeeLamports ?? 'N/A'}`);
    // eslint-disable-next-line no-console
    console.log(`  SOL:          ${s.networkFeeSol ?? 'N/A'}`);

    // SOL balance changes
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('SOL Balance Changes:');
    if (!s.solChanges || s.solChanges.length === 0) {
        // eslint-disable-next-line no-console
        console.log('  (none)');
    } else {
        s.solChanges.forEach((c) => {
            // eslint-disable-next-line no-console
            console.log(
                `  ${c.owner}  Δ=${c.deltaLamports} lamports (${c.deltaSol} SOL)`
            );
        });
    }
}

async function runTx({ signature, cmd }) {
    if (!signature) {
        logger.error('[scoundrel] tx requires a transaction signature.');
        process.exit(1);
    }

    // Commander passes the Command instance as `cmd`; normalize to options object.
    const opts = (cmd && typeof cmd.opts === 'function') ? cmd.opts() : (cmd || {});
    const signatures = [signature];

    if (opts.sig) {
        if (Array.isArray(opts.sig)) {
            signatures.push(...opts.sig);
        } else {
            signatures.push(opts.sig);
        }
    }

    const swapMode = !!opts.swap;
    if (swapMode) {
        if (!opts.wallet || !opts.mint) {
            logger.error('[scoundrel] tx swap mode requires both --wallet and --mint.');
            process.exit(1);
        }
    }

    const { createSolanaTrackerRPCClient } = require('../solanaTrackerRPCClient');
    const { createRpcMethods } = require('../solana/rpcMethods');
    const { createInspectTransaction } = require('../txInspector/inspectTransaction');
    const { parseSwapFromTransaction } = require('../txInspector/parseSwapFromTransaction');
    const BootyBox = require('../../packages/BootyBox');

    const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
    const rpcMethods = createRpcMethods(rpc, rpcSubs);
    const inspectTransaction = createInspectTransaction(rpcMethods);

    try {
        const isBatch = signatures.length > 1;
        const result = await inspectTransaction(isBatch ? signatures : signatures[0], {
            maxSupportedTransactionVersion: 0,
        });

        const summaries = Array.isArray(result) ? result : [result];

        // Use a for..of loop so we can await async enrichment per summary.
        // eslint-disable-next-line no-restricted-syntax
        for (let idx = 0; idx < summaries.length; idx += 1) {
            const summary = summaries[idx];

            if (idx > 0) {
                // eslint-disable-next-line no-console
                console.log('\n──────────────────────────────────────────────────────────\n');
            }
            renderTxSummary(summary);

            if (!swapMode) {
                // eslint-disable-next-line no-continue
                continue;
            }

            // eslint-disable-next-line no-console
            console.log('');

            if (!summary || !summary.raw) {
                // eslint-disable-next-line no-console
                console.log(`Swap Details (wallet ${opts.wallet}, mint ${opts.mint}):`);
                // eslint-disable-next-line no-console
                console.log('  (no raw transaction payload available)');
                // eslint-disable-next-line no-continue
                continue;
            }

            // Derive SOL deltas for the focus wallet from the normalized solChanges.
            let solNetSol = 0;
            let solNetLamports = null;
            if (summary && Array.isArray(summary.solChanges)) {
                const change = summary.solChanges.find((c) => c.owner === opts.wallet);
                if (change) {
                    if (typeof change.deltaLamports === 'number' && Number.isFinite(change.deltaLamports)) {
                        solNetLamports = change.deltaLamports;
                    }
                    if (typeof change.deltaSol === 'number' && Number.isFinite(change.deltaSol)) {
                        solNetSol = change.deltaSol;
                    } else if (solNetLamports !== null) {
                        solNetSol = solNetLamports / 1_000_000_000;
                    }
                }
            }

            // Parse swap deltas from the raw transaction for this wallet/mint.
            const swap = parseSwapFromTransaction(summary.raw, {
                mint: opts.mint,
                payerPubkey: opts.wallet,
            });

            let tokenIncrease = 0;
            let tokenDecrease = 0;
            let tokenNet = 0;
            let feeLamports = null;
            let tokenSymbol = null;
            let tokenName = null;

            if (swap) {
                const inc = swap.tokenDelta || 0;
                const dec = swap.tokenDecrease || 0;
                tokenIncrease = inc;
                tokenDecrease = dec;
                tokenNet = inc - dec;

                if (typeof swap.feeLamports === 'number' && Number.isFinite(swap.feeLamports)) {
                    feeLamports = swap.feeLamports;
                }
            }

            // Optionally enrich the header with metadata from BootyBox, if available.
            try {
                // eslint-disable-next-line no-await-in-loop
                const coin = await BootyBox.getCoinByMint(opts.mint);
                if (coin && typeof coin === 'object') {
                    if (coin.symbol) tokenSymbol = coin.symbol;
                    if (coin.name) tokenName = coin.name;
                }
            } catch (err) {
                // Metadata enrichment is best-effort only; ignore failures.
            }

            // Fallback fee from the normalized summary if the swap parser did not provide one.
            if (feeLamports == null && typeof summary.networkFeeLamports === 'number' && Number.isFinite(summary.networkFeeLamports)) {
                feeLamports = summary.networkFeeLamports;
            }

            const hasTokenChange = tokenNet !== 0 || tokenIncrease !== 0 || tokenDecrease !== 0;
            const hasSolChange = solNetLamports !== null && solNetLamports !== 0;
            const hasAny = hasTokenChange || hasSolChange || (typeof feeLamports === 'number' && Number.isFinite(feeLamports));

            let header = `Swap Details (wallet ${opts.wallet}, mint ${opts.mint}`;
            if (tokenSymbol) {
                header += `, symbol ${tokenSymbol}`;
            }
            if (tokenName) {
                header += `, name ${tokenName}`;
            }
            header += '):';
            // eslint-disable-next-line no-console
            console.log(header);

            if (!hasAny) {
                // eslint-disable-next-line no-console
                console.log('  No swap-like balance changes detected for this wallet/mint in this transaction.');
                // eslint-disable-next-line no-continue
                continue;
            }

            // eslint-disable-next-line no-console
            console.log('  Token balance change:');
            // eslint-disable-next-line no-console
            console.log(`    Net change:         ${tokenNet}`);
            // eslint-disable-next-line no-console
            console.log(`    Increase (in):      ${tokenIncrease}`);
            // eslint-disable-next-line no-console
            console.log(`    Decrease (out):     ${tokenDecrease}`);

            // eslint-disable-next-line no-console
            console.log('');
            // eslint-disable-next-line no-console
            console.log('  SOL balance change:');
            // eslint-disable-next-line no-console
            console.log(`    Net change:         ${solNetSol}`);
            if (typeof solNetLamports === 'number' && Number.isFinite(solNetLamports)) {
                // eslint-disable-next-line no-console
                console.log(`    Lamports:           ${solNetLamports}`);
            }
            if (typeof feeLamports === 'number' && Number.isFinite(feeLamports)) {
                // eslint-disable-next-line no-console
                console.log(`    Network fee:        ${feeLamports} lamports`);
            }
        }
    } finally {
        try {
            await close();
        } catch (_) {
            // ignore close errors
        }
    }
}

module.exports = runTx;
module.exports.run = runTx;