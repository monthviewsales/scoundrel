# Wallets domain (AI agents)

Inherits root `AGENTS.md`; local rules add/override.

This directory hosts wallet-related helpers (registry wrappers, resolution, signing, swap plumbing, CLI UX). Current state:

- `walletRegistry.js` / `registry.js` wrap the BootyBox-backed warchest registry.
- `walletSelection.js` centralizes interactive prompts, default funding import logic, and color handling for CLI flows.
- `walletManagement.js` exposes CLI-friendly orchestration helpers (`add`, `list`, `options`, `set-color`, `solo`).
- `kolManager.js` keeps research/dossier wallets synced into the registry as `usage_type='kol'`.
- `resolver.js` exposes a resolver for alias/pubkey lookups without changing BootyBox.
- `state.js` wraps live wallet state helpers; `scanner.js` wraps the raw RPC scanner.
- `getWalletForSwap.js` resolves private keys (via `secretProvider.js`) and builds Solana signer objects for swap/trade code.

Wallet keys are sensitive. Do **not** log or store them in plaintext; prefer secure key sources when adding implementations. Keep BootyBox usage unchanged (direct import). Use CommonJS modules and add JSDoc for exported functions. When writing CLI helpers, reuse the shared selection/management modules so UX stays consistent across commands.
