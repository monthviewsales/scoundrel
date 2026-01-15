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

// Standard jsonArtifacts writer (same conventions as autopsy).
const jsonArtifacts = require('../persist/jsonArtifacts');
const { createCommandRun } = require('./aiRun');

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



/**
 * Build the artifact run context for a tx session.
 *
 * @param {Object} params
 * @param {string} params.txid
 * @param {boolean} params.swapMode
 * @param {{ alias?: string, pubkey?: string }|null} params.focusWallet
 * @param {string|null} params.mint
 * @returns {{ runId: string, isDev: boolean, artifacts: { baseDir: string, runId: string, write: Function, loadLatest: Function } }}
 */
function buildTxArtifactRun({ txid, swapMode, focusWallet, mint }) {
  const sanitizeSegment = jsonArtifacts.sanitizeSegment;

  const segments = [];

    if (focusWallet && (focusWallet.alias || focusWallet.pubkey)) {
        segments.push(sanitizeSegment(focusWallet.alias || focusWallet.pubkey));
    }

    if (swapMode && mint) {
        segments.push(sanitizeSegment(mint));
    }

  segments.push(sanitizeSegment(String(txid).slice(0, 16)));

  return createCommandRun({ command: 'tx', segments, logger });
}

/**
 * Persist a tx session payload to the JSON artifact store.
 *
 * @param {Object} params
 * @param {string} params.txid
 * @param {object} params.sessionPayload
 * @param {boolean} params.swapMode
 * @param {{ alias?: string, pubkey?: string }|null} params.focusWallet
 * @param {string|null} params.mint
 * @returns {string} path to the saved artifact
 */
function writeTxSessionArtifacts({ txid, sessionPayload, swapMode, focusWallet, mint }) {
  const run = buildTxArtifactRun({ txid, swapMode, focusWallet, mint });
  if (!run || !run.artifacts || typeof run.artifacts.write !== 'function') {
    throw new Error('jsonArtifacts writer is unavailable for tx session artifacts.');
    }

    // Match autopsy convention: use response/* for outputs.
    const savedPath = run.artifacts.write('response', 'txSession', sessionPayload);
    if (!savedPath) {
        throw new Error('jsonArtifacts writer did not return a saved path.');
    }
    return savedPath;
}

async function loadInkSessionDeps() {
    const ink = await import('ink');
    return { ink };
}

async function runTxSessionTui({ title, txid, payload, canPersistSwap, onPersistSwap }) {
    const { ink } = await loadInkSessionDeps();
    const { render, Box, Text, useApp, useInput } = ink;
    const React = require('react');
    const h = React.createElement;

    const menu = [
        { key: 'save', label: 'Save JSON artifact' },
        ...(canPersistSwap ? [{ key: 'persist', label: 'Upsert swap into BootyBox (persist)' }] : []),
        { key: 'exit', label: 'Exit' },
    ];

    return new Promise((resolve, reject) => {
        function App() {
            const { exit } = useApp();
            const [cursor, setCursor] = React.useState(0);
            const [status, setStatus] = React.useState('');
            const [busy, setBusy] = React.useState(false);

            function done(result) {
                try {
                    resolve(result);
                } finally {
                    exit();
                }
            }

            async function handleSelect(idx) {
                const item = menu[idx];
                if (!item) return;

                if (item.key === 'exit') {
                    done({ action: 'exit' });
                    return;
                }

                if (item.key === 'save') {
                    setBusy(true);
                    setStatus('Saving artifact…');
                    try {
                        const filePath = writeTxSessionArtifacts({
                            txid,
                            sessionPayload: payload,
                            swapMode: !!payload?.swapMode,
                            focusWallet: payload?.focusWallet || null,
                            mint: payload?.mint || null,
                        });
                        setStatus(`Saved: ${filePath}`);
                    } catch (e) {
                        setStatus(`Save failed: ${e?.message || String(e)}`);
                    } finally {
                        setBusy(false);
                    }
                    return;
                }

                if (item.key === 'persist') {
                    if (!onPersistSwap) {
                        setStatus('Persist not available.');
                        return;
                    }
                    setBusy(true);
                    setStatus('Upserting swap…');
                    try {
                        await onPersistSwap();
                        setStatus('Upsert complete.');
                    } catch (e) {
                        setStatus(`Upsert failed: ${e?.message || String(e)}`);
                    } finally {
                        setBusy(false);
                    }
                    return;
                }
            }

            useInput((input, key) => {
                if (busy) return;

                if (key.escape || input === 'q') {
                    done({ action: 'exit' });
                    return;
                }

                if (key.upArrow) {
                    setCursor((c) => Math.max(c - 1, 0));
                } else if (key.downArrow) {
                    setCursor((c) => Math.min(c + 1, menu.length - 1));
                } else if (key.return) {
                    void handleSelect(cursor);
                }
            });

            return h(
                Box,
                { flexDirection: 'column' },
                h(Text, { bold: true }, title || 'Transaction session'),
                h(Text, { dimColor: true }, `Tx: ${txid}`),
                h(
                    Box,
                    { flexDirection: 'column', marginTop: 1 },
                    menu.map((opt, idx) => {
                        const active = idx === cursor;
                        return h(Text, { key: opt.key, color: active ? 'cyan' : undefined }, `${active ? '› ' : '  '}${opt.label}`);
                    })
                ),
                status ? h(Box, { marginTop: 1 }, h(Text, { color: 'yellow' }, status)) : null,
                h(Text, { dimColor: true }, '↑/↓ select • Enter choose • q/Esc exit')
            );
        }

        try {
            const { waitUntilExit } = render(h(App));
            waitUntilExit().catch(reject);
        } catch (e) {
            reject(e);
        }
    });
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
        const errMsg = '[scoundrel] tx requires a transaction signature.';
        logger.error(errMsg);
        if (cmd && cmd.tui) {
            throw new Error(errMsg);
        }
        process.exit(1);
    }

    // Commander passes the Command instance as `cmd`; normalize to options object.
    const opts = (cmd && typeof cmd.opts === 'function') ? cmd.opts() : (cmd || {});
    const isTui = !!opts.tui;
    const signatures = [signature];

    if (opts.sig) {
        if (Array.isArray(opts.sig)) {
            signatures.push(...opts.sig);
        } else {
            signatures.push(opts.sig);
        }
    }

    const swapMode = !!opts.swap;
    const sessionMode = !!opts.session;
    let persistMode = !!opts.persist;
    let focusWalletAlias = null;
    let focusWalletPubkey = null;
    let focusWalletId = null;

    if (swapMode) {
        if (!opts.wallet || !opts.mint) {
            const errMsg = '[scoundrel] tx swap mode requires both --wallet and --mint.';
            logger.error(errMsg);
            if (isTui) {
                throw new Error(errMsg);
            }
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
            if (isTui) {
                throw new Error(msg);
            }
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

        const sessionPayload = {
            txids: signatures.slice(),
            inspectedAt: new Date().toISOString(),
            swapMode,
            persistRequested: persistMode,
            focusWallet: swapMode ? { alias: focusWalletAlias || opts.wallet, pubkey: focusWalletPubkey || opts.wallet, id: focusWalletId || null } : null,
            mint: swapMode ? opts.mint : null,
            results: [],
        };

        // Use a for..of loop so we can await async enrichment per summary.
        // eslint-disable-next-line no-restricted-syntax
        for (let idx = 0; idx < summaries.length; idx += 1) {
            const summary = summaries[idx];

            if (idx > 0) {
                // eslint-disable-next-line no-console
                console.log('\n──────────────────────────────────────────────────────────\n');
            }
            renderTxSummary(summary);

            const sessionRow = { signature: (summary && summary.signature) ? summary.signature : (signatures[idx] || signatures[0]), summary };
            sessionPayload.results.push(sessionRow);

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

                sessionRow.swapFailed = true;
                sessionRow.swapErrorSummary = errSummary;

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

                // Optional: persist a fee-only trade so PnL can see the loss.
                // NOTE: BootyBox.recordScTradeEvent is the single-writer and will also update sc_positions.
                // For CLI usage we default to read-only; require --persist to write.
                if (persistMode && focusWalletId && typeof BootyBox.recordScTradeEvent === 'function') {
                    // Derive executedAt from blockTime if possible, otherwise now.
                    let executedAt = null;
                    if (summary.blockTime != null) {
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
            sessionRow.swapInsight = insight || null;

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
            if (!persistMode) {
                // eslint-disable-next-line no-console
                console.log('  (read-only) Tip: add --persist to record this swap to BootyBox.');
            }

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

            // Optional: persist the trade event into sc_trades via BootyBox.
            // NOTE: BootyBox.recordScTradeEvent is the single-writer and will also update sc_positions.
            // For CLI usage we default to read-only; require --persist to write.
            if (persistMode && focusWalletId && typeof BootyBox.recordScTradeEvent === 'function') {
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

        // Optional interactive review session.
        if (sessionMode) {
            // In session mode we do not change the printed output; we simply offer post-run actions.
            const canPersistSwap = swapMode && !!focusWalletId && typeof BootyBox.recordScTradeEvent === 'function';

            const persistAction = async () => {
                if (!canPersistSwap) {
                    throw new Error('Persist is unavailable (missing walletId or BootyBox writer).');
                }
                // Re-run only the persistence side-effects for swap results by temporarily enabling persistMode.
                // We intentionally avoid re-inspecting the chain; instead we persist from captured insights.
                const rows = sessionPayload.results || [];
                // eslint-disable-next-line no-restricted-syntax
                for (const row of rows) {
                    if (!row || !row.swapInsight) continue;
                    const insight = row.swapInsight;
                    const normalizedSide = (insight.side === 'buy' || insight.side === 'sell')
                        ? insight.side
                        : (insight.tokenDeltaNet > 0 ? 'buy' : (insight.tokenDeltaNet < 0 ? 'sell' : null));

                    let executedAt = insight.executedAt;
                    const summary = row.summary;
                    if (!executedAt && summary && summary.blockTime != null) {
                        try {
                            const bt = typeof summary.blockTime === 'bigint' ? Number(summary.blockTime) : Number(summary.blockTime);
                            if (Number.isFinite(bt) && bt > 0) executedAt = bt * 1000;
                        } catch (_) {
                            // ignore
                        }
                    }
                    if (!executedAt) executedAt = Date.now();

                    const feeLamports = Number.isFinite(insight.feeLamports)
                        ? insight.feeLamports
                        : (Number.isFinite(summary?.networkFeeLamports) ? summary.networkFeeLamports : null);

                    const tradeEvent = {
                        txid: row.signature,
                        walletId: focusWalletId,
                        walletAlias: focusWalletAlias || opts.wallet,
                        coinMint: insight.mint || opts.mint,
                        side: normalizedSide,
                        executedAt,
                        tokenAmount: Math.abs(insight.tokenDeltaNet || 0),
                        solAmount: Math.abs(insight.solDeltaNet || 0),
                        tradeUuid: null,
                        strategyId: null,
                        strategyName: null,
                        priceSolPerToken: insight.priceSolPerToken || null,
                        priceUsdPerToken: null,
                        solUsdPrice: null,
                        feesSol: Number.isFinite(insight.feeSol)
                            ? insight.feeSol
                            : (typeof feeLamports === 'number' && Number.isFinite(feeLamports) ? feeLamports / 1_000_000_000 : null),
                        feesUsd: null,
                        slippagePct: null,
                        priceImpactPct: null,
                        program: null,
                        evaluationPayload: null,
                        decisionPayload: null,
                        decisionLabel: null,
                        decisionReason: null,
                    };

                    // eslint-disable-next-line no-await-in-loop
                    await BootyBox.recordScTradeEvent(tradeEvent);
                }

                persistMode = true;
                sessionPayload.persistRequested = true;
                sessionPayload.persistCompletedAt = new Date().toISOString();
            };

            try {
                // Only attempt Ink session in real terminals. In non-TTY environments, skip silently.
                const isTty = !!process.stdout.isTTY && !!process.stdin.isTTY;
                if (isTty) {
                    // eslint-disable-next-line no-unused-vars
                    const sessionResult = await runTxSessionTui({
                        title: 'Transaction review session',
                        txid: signatures[0],
                        payload: sessionPayload,
                        canPersistSwap,
                        onPersistSwap: canPersistSwap ? persistAction : null,
                    });
                }
            } catch (e) {
                logger.warn(`[tx.cli] session TUI failed: ${e?.message || String(e)}`);
            }
        }
        return sessionPayload;
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
module.exports.buildTxArtifactRun = buildTxArtifactRun;
module.exports.writeTxSessionArtifacts = writeTxSessionArtifacts;
