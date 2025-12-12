'use strict';

/**
 * tx processor for `scoundrel tx`
 *
 * Expected usage from index.js:
 *   const txProcessor = loadProcessor('tx');
 *   await txProcessor({ signature, cmd });
 */


const logger = require('../logger');
const wallets = require('../wallets');

function jsonSafeStringify(value) {
    return JSON.stringify(
        value,
        (key, val) => (typeof val === 'bigint' ? val.toString() : val),
    );
}

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
        let errStr;
        if (typeof s.err === 'string') {
            errStr = s.err;
        } else {
            try {
                errStr = JSON.stringify(
                    s.err,
                    (key, val) => (typeof val === 'bigint' ? val.toString() : val),
                );
            } catch (_) {
                // Fallback: best-effort stringification
                errStr = String(s.err);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`  Error:        ${errStr}`);
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

function getWalletResolver() {
    if (
        wallets &&
        wallets.resolver &&
        typeof wallets.resolver.createWalletResolver === 'function'
    ) {
        return wallets.resolver.createWalletResolver();
    }
    return null;
}

async function resolveWithResolver(resolver, input) {
    if (!resolver || !input) return null;
    try {
        const resolved = await resolver.resolveAliasOrAddress(input);
        return resolved && resolved.wallet ? resolved.wallet : null;
    } catch (err) {
        if (logger && logger.debug) {
            logger.debug('[tx.cli] wallet resolver failed:', err?.message || err);
        }
        return null;
    }
}

async function determineFocusWallet(initialIdentifier) {
    const resolver = getWalletResolver();
    if (!resolver) {
        throw new Error('wallet resolver is unavailable; ensure BootyBox is initialised');
    }

    const firstPass = await resolveWithResolver(resolver, initialIdentifier);
    if (firstPass) return firstPass;

    const selector =
        wallets &&
        wallets.selection &&
        typeof wallets.selection.selectWalletInteractively === 'function'
            ? wallets.selection.selectWalletInteractively
            : null;

    if (!selector) {
        throw new Error('interactive wallet selection is unavailable');
    }

    const selection = await selector({
        promptLabel: 'Select a wallet for tx swap context (or import one):',
        allowOther: true,
    });

    if (!selection || !selection.walletAddress) {
        throw new Error('No wallet selected for tx swap context.');
    }

    const aliasCandidate =
        selection.walletLabel && selection.walletLabel !== 'other'
            ? selection.walletLabel
            : null;

    let finalRecord = null;
    if (aliasCandidate) {
        finalRecord = await resolveWithResolver(resolver, aliasCandidate);
    }
    if (!finalRecord) {
        finalRecord = await resolveWithResolver(resolver, selection.walletAddress);
    }

    if (finalRecord) {
        return finalRecord;
    }

    return {
        alias: selection.walletLabel || selection.walletAddress,
        pubkey: selection.walletAddress,
    };
}

async function runTx({ signature, cmd }) {
    logger.debug(`[tx.cli] runTx starting for signature=${signature}`);
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
    let focusWalletAlias = null;
    let focusWalletPubkey = null;
    let focusWalletId = null;

    if (swapMode) {
        if (!opts.wallet || !opts.mint) {
            logger.error('[scoundrel] tx swap mode requires both --wallet and --mint.');
            process.exit(1);
        }

        const assignWalletFromRecord = (record) => {
            if (!record) return;
            focusWalletAlias = record.alias || opts.wallet;
            focusWalletPubkey = record.pubkey;
            if (Object.prototype.hasOwnProperty.call(record, 'walletId')) {
                focusWalletId = record.walletId;
            } else if (Object.prototype.hasOwnProperty.call(record, 'wallet_id')) {
                focusWalletId = record.wallet_id;
            } else if (Object.prototype.hasOwnProperty.call(record, 'id')) {
                focusWalletId = record.id;
            }
        };

        try {
            const walletRecord = await determineFocusWallet(opts.wallet);
            assignWalletFromRecord(walletRecord);
        } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.error(`[scoundrel] Failed to resolve wallet context: ${msg}`);
            process.exit(1);
        }
    }

    const { createSolanaTrackerRPCClient } = require('../solanaTrackerRPCClient');
    const { createRpcMethods } = require('../solana/rpcMethods');
    const { createInspectTransaction } = require('../txInspector/inspectTransaction');
    const {
        recoverSwapInsightFromTransaction,
        decodeRpcTransactionError,
    } = require('../services/txInsightService');
    const BootyBox = require('../../db');

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

            const signatureForSummary = (summary && summary.signature)
                ? summary.signature
                : signatures[idx] || signatures[0];

            // If the transaction itself failed (e.g. slippage exceeded), report that explicitly
            // and, for our own wallets, record a fee-only trade so PnL can account for the loss.
            if (summary && summary.status && summary.status !== 'ok') {
                const walletLabel = focusWalletAlias || opts.wallet;
                // eslint-disable-next-line no-console
                console.log(`Swap Details (wallet ${walletLabel}, mint ${opts.mint}):`);

                let errSummary = 'unknown error';
                if (summary && summary.err) {
                    try {
                        const decoded = decodeRpcTransactionError(summary.err);
                        if (decoded && decoded.code && decoded.message) {
                            errSummary = `${decoded.code}: ${decoded.message}`;
                        } else {
                            errSummary = jsonSafeStringify(summary.err);
                        }
                    } catch (_) {
                        try {
                            errSummary = jsonSafeStringify(summary.err);
                        } catch (_) {
                            errSummary = String(summary.err);
                        }
                    }
                }
                logger.debug(`[tx.cli] failed-transaction branch for ${signatureForSummary}: ${errSummary}`);
                // eslint-disable-next-line no-console
                console.log(`  Swap FAILED: ${errSummary}`);

                if (summary.networkFeeLamports != null || summary.networkFeeSol != null) {
                    const feeLamportsRaw = summary.networkFeeLamports;
                    const feeSolRaw = summary.networkFeeSol;
                    // eslint-disable-next-line no-console
                    console.log('  Note: No token balance change detected; only network fee was paid.');
                    if (feeLamportsRaw != null || feeSolRaw != null) {
                        // eslint-disable-next-line no-console
                        console.log(
                            `  Network fee: ${feeLamportsRaw ?? 'N/A'} lamports (${feeSolRaw ?? 'N/A'} SOL)`,
                        );
                    }
                }

                // For our own tracked wallets, upsert a fee-only trade so PnL can see the loss.
                if (focusWalletId && typeof BootyBox.recordScTradeEvent === 'function') {
                    // Derive executedAt from blockTime if possible, otherwise now.
                    let executedAt = null;
                    if (summary.blockTime !=null) {
                        try {
                            const bt = typeof summary.blockTime === 'bigint'
                                ? Number(summary.blockTime)
                                : Number(summary.blockTime);
                            if (Number.isFinite(bt) && bt > 0) {
                                executedAt = bt * 1000;
                            }
                        } catch (_) {
                            // ignore
                        }
                    }
                    if (!executedAt) {
                        executedAt = Date.now();
                    }

                    const feeLamportsRaw = summary.networkFeeLamports;
                    const feeSolRaw = summary.networkFeeSol;
                    const feeSolValue = Number.isFinite(feeSolRaw)
                        ? feeSolRaw
                        : (typeof feeLamportsRaw === 'number' && Number.isFinite(feeLamportsRaw)
                            ? feeLamportsRaw / 1_000_000_000
                            : null);

                    const tradeEvent = {
                        txid: signatureForSummary,
                        walletId: focusWalletId,
                        walletAlias: walletLabel,
                        coinMint: opts.mint,
                        side: null,
                        executedAt,
                        tokenAmount: 0,
                        solAmount: 0,
                        tradeUuid: null,
                        strategyId: null,
                        strategyName: null,
                        priceSolPerToken: null,
                        priceUsdPerToken: null,
                        solUsdPrice: null,
                        feesSol: feeSolValue,
                        feesUsd: null,
                        slippagePct: null,
                        priceImpactPct: null,
                        program: null,
                        evaluationPayload: null,
                        decisionPayload: null,
                        decisionLabel: 'failed_swap',
                        decisionReason: errSummary,
                    };

                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await BootyBox.recordScTradeEvent(tradeEvent);
                        logger.info(
                            `[scoundrel] Upserted fee-only sc_trades row for failed tx ${signatureForSummary} (walletId=${focusWalletId}).`,
                        );
                    } catch (err) {
                        logger.warn(
                            `[scoundrel] Failed to upsert fee-only sc_trades row for failed tx ${signatureForSummary}: ${err.message}`,
                        );
                    }
                }

                // eslint-disable-next-line no-continue
                continue;
            }

            if (!summary || !summary.raw) {
                const walletLabel = focusWalletAlias || opts.wallet;
                // eslint-disable-next-line no-console
                console.log(`Swap Details (wallet ${walletLabel}, mint ${opts.mint}):`);
                // eslint-disable-next-line no-console
                console.log('  (no raw transaction payload available)');
                // eslint-disable-next-line no-continue
                continue;
            }

            // Use txInsightService as the single source of truth for swap semantics.

            const walletAddressForInsight = focusWalletPubkey || opts.wallet;

            // eslint-disable-next-line no-await-in-loop
            const insight = await recoverSwapInsightFromTransaction(signatureForSummary, summary.raw, {
                walletAddress: walletAddressForInsight,
            });

            let tokenSymbol = null;
            let tokenName = null;

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

            const walletLabel = focusWalletAlias || opts.wallet;
            let header = `Swap Details (wallet ${walletLabel}, mint ${opts.mint}`;
            if (tokenSymbol) {
                header += `, symbol ${tokenSymbol}`;
            }
            if (tokenName) {
                header += `, name ${tokenName}`;
            }
            if (insight && insight.mint && insight.mint !== opts.mint) {
                header += `, detected mint ${insight.mint}`;
            }
            header += '):';
            // eslint-disable-next-line no-console
            console.log(header);

            if (!insight) {
                // eslint-disable-next-line no-console
                console.log('  No swap-like balance changes detected for this wallet in this transaction.');
                // eslint-disable-next-line no-continue
                continue;
            }

            const {
                side,
                tokenDeltaNet,
                tokenDeltaIn,
                tokenDeltaOut,
                solDeltaNet,
                solDeltaIn,
                solDeltaOut,
                priceSolPerToken,
                feeLamports: feeLamportsFromInsight,
                feeSol,
            } = insight;

            const tokenNet = tokenDeltaNet || 0;
            const tokenIncrease = tokenDeltaIn || 0;
            const tokenDecrease = tokenDeltaOut || 0;

            const solNetSol = solDeltaNet || 0;
            const solNetLamports = Number.isFinite(solDeltaNet)
                ? Math.round(solDeltaNet * 1_000_000_000)
                : null;

            const feeLamports = Number.isFinite(feeLamportsFromInsight)
                ? feeLamportsFromInsight
                : (Number.isFinite(summary.networkFeeLamports) ? summary.networkFeeLamports : null);

            const hasTokenChange = tokenNet !== 0 || tokenIncrease !== 0 || tokenDecrease !== 0;
            const hasSolChange = solNetSol !== 0;
            const hasAny = hasTokenChange || hasSolChange || (typeof feeLamports === 'number' && Number.isFinite(feeLamports));

            if (!hasAny) {
                // eslint-disable-next-line no-console
                console.log('  No swap-like balance changes detected for this wallet in this transaction.');
                // eslint-disable-next-line no-continue
                continue;
            }

            // If this is one of our tracked wallets (focusWalletId is set) and we're in swap mode,
            // upsert the trade event into sc_trades via BootyBox. We intentionally do not touch
            // positions here; only the daemon (HUD) is allowed to mutate sc_positions.
            if (focusWalletId && typeof BootyBox.recordScTradeEvent === 'function') {
                const normalizedSide = (side === 'buy' || side === 'sell') ? side : (tokenNet > 0 ? 'buy' : (tokenNet < 0 ? 'sell' : null));

                // Derive an executedAt timestamp: prefer insight.executedAt, then summary.blockTime.
                let executedAt = insight.executedAt;
                if (!executedAt && summary && summary.blockTime != null) {
                    try {
                        const bt = typeof summary.blockTime === 'bigint'
                            ? Number(summary.blockTime)
                            : Number(summary.blockTime);
                        if (Number.isFinite(bt) && bt > 0) {
                            executedAt = bt * 1000;
                        }
                    } catch (_) {
                        // fall back to now if needed
                    }
                }
                if (!executedAt) {
                    executedAt = Date.now();
                }

                // Build a ScTradeEvent-like payload compatible with BootyBox.recordScTradeEvent.
                const tradeEvent = {
                    txid: signatureForSummary,
                    walletId: focusWalletId,
                    walletAlias: focusWalletAlias || opts.wallet,
                    coinMint: insight.mint || opts.mint,
                    side: normalizedSide,
                    executedAt,
                    tokenAmount: Math.abs(tokenNet),
                    solAmount: Math.abs(solNetSol),
                    tradeUuid: null,
                    strategyId: null,
                    strategyName: null,
                    priceSolPerToken: priceSolPerToken || null,
                    priceUsdPerToken: null,
                    solUsdPrice: null,
                    feesSol: Number.isFinite(feeSol) ? feeSol : (typeof feeLamports === 'number' && Number.isFinite(feeLamports) ? feeLamports / 1_000_000_000 : null),
                    feesUsd: null,
                    slippagePct: null,
                    priceImpactPct: null,
                    program: null,
                    evaluationPayload: null,
                    decisionPayload: null,
                    decisionLabel: null,
                    decisionReason: null,
                };

                try {
                    // eslint-disable-next-line no-await-in-loop
                    await BootyBox.recordScTradeEvent(tradeEvent);
                    logger.info(
                        `[scoundrel] Upserted sc_trades via BootyBox for ${signatureForSummary} (walletId=${focusWalletId}, side=${normalizedSide}).`,
                    );
                } catch (err) {
                    logger.warn(
                        `[scoundrel] Failed to upsert sc_trades for ${signatureForSummary}: ${err.message}`,
                    );
                }
            }

            // eslint-disable-next-line no-console
            console.log('  Direction (wallet POV):');
            // eslint-disable-next-line no-console
            console.log(`    Side:               ${side}`);

            if (Number.isFinite(priceSolPerToken)) {
                // eslint-disable-next-line no-console
                console.log(`    Price:              ${priceSolPerToken} SOL per token`);
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
            // eslint-disable-next-line no-console
            console.log(`    Received (in):      ${solDeltaIn || 0}`);
            // eslint-disable-next-line no-console
            console.log(`    Spent (out):        ${solDeltaOut || 0}`);
            if (Number.isFinite(solNetLamports)) {
                // eslint-disable-next-line no-console
                console.log(`    Lamports (approx):  ${solNetLamports}`);
            }
            if (typeof feeLamports === 'number' && Number.isFinite(feeLamports)) {
                // eslint-disable-next-line no-console
                console.log(`    Network fee:        ${feeLamports} lamports${Number.isFinite(feeSol) ? ` (~${feeSol} SOL)` : ''}`);
            }
        }
    } catch (err) {
        // Ensure we see the real error that is causing the tx command to fail.
        // eslint-disable-next-line no-console
        console.error('[tx.cli] runTx internal error:', err);
        logger.error('[tx.cli] runTx internal error:', err && (err.stack || err.message || err));
        throw err;
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
