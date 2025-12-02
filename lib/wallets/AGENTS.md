# Wallets domain (AI agents)

This directory hosts wallet-related helpers (registry wrappers, resolution, signing, swap plumbing). Current state:

- `registry.js` wraps the existing warchest registry (BootyBox-backed).
- `resolver.js` exposes a resolver for alias/pubkey lookups without changing BootyBox.
- `state.js` wraps live wallet state helpers; `scanner.js` wraps the raw RPC scanner.
- `getWalletForSwap.js` is a TODO placeholder; implement once swap flow is finalized.

Wallet keys are sensitive. Do **not** log or store them in plaintext; prefer secure key sources when adding implementations. Keep BootyBox usage unchanged (direct import). Use CommonJS modules and add JSDoc for exported functions.
