#!/usr/bin/env node
'use strict';

// Simple CLI to inspect one or many Solana transactions using Scoundrel's TxInspector.
//
// Usage:
//   node scripts/txInspectorCli.js <signature>
//   node scripts/txInspectorCli.js --sig <sig1> --sig <sig2>
//
// Outputs a readable inspection summary including:
//   - status (ok / err)
//   - network fee
//   - SOL balance deltas
//
// More advanced labeling (Jito/Pump/Axiom fees, token balance changes, etc.)
// will be layered on top via dedicated helpers in the future.

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/txInspectorCli.js <signature> [additional signatures...]');
  process.exit(1);
}

// Collect signatures from CLI
const signatures = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--sig' && args[i + 1]) {
    signatures.push(args[i + 1]);
    i += 1;
  } else if (!a.startsWith('--')) {
    signatures.push(a);
  }
}

if (signatures.length === 0) {
  console.error('No signatures provided.');
  process.exit(1);
}

// Boot RPC
const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('../lib/solana/rpcMethods');
const { createInspectTransaction } = require('../lib/txInspector/inspectTransaction');
const logger = require('../lib/logger');

async function main() {
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  const inspectTransaction = createInspectTransaction(rpcMethods);

  try {
    // Fetch summaries
    const results = await inspectTransaction(
      signatures.length === 1 ? signatures[0] : signatures,
      { maxSupportedTransactionVersion: 0 }
    );

    // Render output
    if (!Array.isArray(results)) {
      renderSummary(results);
    } else {
      results.forEach((summary) => {
        console.log('──────────────────────────────────────────────────────────');
        renderSummary(summary);
      });
    }
  } catch (err) {
    console.error('Error:', err?.message || err);
  } finally {
    try { await close(); } catch (_) {}
    process.exit(0);
  }
}

/**
 * Pretty print a single InspectTransactionSummary.
 * @param {*} s
 */
function renderSummary(s) {
  if (!s) {
    console.log('Transaction not found or expired.');
    return;
  }

  console.log(`Signature:      ${s.signature}`);
  console.log(`Status:         ${s.status}`);
  if (s.err) console.log(`  Error:        ${JSON.stringify(s.err)}`);

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
  console.log(`Block Time:     ${blockTimeStr}`);

  console.log('');
  console.log('Network Fee:');
  console.log(`  Lamports:     ${s.networkFeeLamports ?? 'N/A'}`);
  console.log(`  SOL:          ${s.networkFeeSol ?? 'N/A'}`);

  console.log('');
  console.log('SOL Balance Changes:');
  if (!s.solChanges || s.solChanges.length === 0) {
    console.log('  (none)');
  } else {
    s.solChanges.forEach((c) => {
      console.log(
        `  ${c.owner}  Δ=${c.deltaLamports} lamports (${c.deltaSol} SOL)`
      );
    });
  }
}

main();
