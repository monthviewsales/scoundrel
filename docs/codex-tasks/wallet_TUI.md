# Analysis of Scoundrel wallet‑related CLI code

## Overview of the current CLI structure

Scoundrel’s `index.js` uses the **Commander** library to define CLI subcommands.  Wallet‑related commands include:

| Command | Purpose | Implementation |
| --- | --- | --- |
| **`scoundrel wallet`** | manage wallets in the **warchest** (add, list, remove, set color, configure).  Uses `-s/--solo` to select a single wallet for downstream operations. | Delegates to `lib/cli/walletCli.js` which forwards the arguments to `walletManagement` functions and `walletRegistry`.  CLI interactions rely on **Node’s `readline`** interface. |
| **`scoundrel warchestd`** | run or manage the HUD daemon that shows real‑time balances and session deltas.  The `--hud` flag enables TUI output. | Uses `lib/cli/warchest.js` which spawns the HUD worker process and resolves wallet specifications.  When `--hud` is used, the HUD process calls `warchestInkApp.js` to render an **Ink** interface showing wallet balances, token breakdowns and RPC/chain status. |
| **`scoundrel dossier` / `scoundrel autopsy`** | harvest trades and analyze them for a given wallet.  These commands prompt for a wallet when none is supplied. | Uses `walletsDomain.selection.selectWalletInteractively()` from `lib/wallets/walletSelection.js` to prompt the user for a wallet.  This interactive selection is built on `readline`.

### `walletManagement` functions

The wallet management functions in `lib/wallets/walletManagement.js` implement the CRUD flows:

- **`addWalletInteractive()`** – prompts for a wallet **public key**, whether it’s signing or watch‑only, and an alias.  It assigns a colour using `pickNextColor()` and stores the wallet via `walletRegistry.addWallet()`.  The flow uses `readline` and `chalk` for simple prompting and colourised output【771487830081708†L40-L54】.
- **`listWallets()`** – fetches all wallets from `walletRegistry` and prints their alias, public key, colour, and whether they contain private keys【771487830081708†L55-L63】.
- **`removeWallet(aliasArg)`** – prompts for an alias and removes the corresponding wallet from the registry【771487830081708†L66-L71】.
- **`setWalletColor(aliasArg, colourArg)`** – lets the user choose a colour from a palette; updates the stored colour for the selected alias【771487830081708†L74-L88】.
- **`configureWalletOptions()`** – lists wallets, prompts the user to pick one, and then allows editing its **usage type**, **auto‑attach** flag, **default funding** flag and **strategy ID**【771487830081708†L104-L135】.
- **`soloSelectWallet()`** – interactive wallet picker used by other commands; lists wallets and allows manual entry【771487830081708†L88-L103】.

All of these flows directly print to stdout and are not re‑usable components.  They rely heavily on synchronous `readline` prompts, making it difficult to reuse or extend the UI in other contexts.

### `walletRegistry` and related modules

`walletRegistry.js` provides DB‑backed functions such as `addWallet`, `getWalletByAlias`, `updateWalletColor`, `updateWalletOptions`, `deleteWallet`, etc.【85093078637232†L12-L45】.  `optionsManager.js` normalizes usage‑type values, ensures booleans are stored correctly and sanitizes the strategy ID【225157254057823†L13-L26】.

`walletSelection.js` centralizes the interactive wallet selection logic.  It can prompt for a wallet alias or manual public key entry and attempts to import a default funding wallet if none exists.  The logic uses `readline/promises` and prints numbered lists for the user【778405523207753†L50-L82】.  While functional, it is not easily composable within other UIs.

### Ink HUD

The project already includes an Ink‑based **head‑up display (HUD)** in `lib/hud/warchestInkApp.js`.  This file exports factory functions that build React components using Ink primitives.  Notable functions:

- `createChainStatus()` – displays chain slot and WebSocket freshness【933371302952197†L25-L44】.
- `createRpcLatencyBar()` – shows recent RPC timings【933371302952197†L25-L44】.
- `createSessionStatus()` – shows session ID and runtime【933371302952197†L63-L69】.
- `createRecentActivityList()` – lists recent wallet events【933371302952197†L80-L83】.
- `createWalletCard()` – renders a wallet box with alias, SOL balance, token table and session deltas【933371302952197†L87-L147】.
- `createWarchestApp()` – ties these components together and iterates over all attached wallets【933371302952197†L160-L177】.

This Ink HUD demonstrates how a React/Ink architecture can produce a rich TUI.  It uses helper functions (e.g., `shortenPubkey`, `fmtNum`, `formatDelta`) to format data and encapsulates each piece of UI into a component.

## Shortcomings of the current wallet CLI

1. **Fragmented user experience:** wallet operations (`add`, `list`, `remove`, `configure`) live in separate functions and each uses its own `readline` flow.  There is no unified navigation or shared styling.
2. **Non‑composable prompts:** interactive logic is tightly coupled to CLI printing; other features (autopsy, dossier) copy these patterns.  It’s hard to reuse wallet pickers in different contexts.
3. **No asynchronous or concurrent UI:** the CLI waits for each input synchronously.  You cannot, for example, view wallet balances while adding another wallet or see validation feedback in real time.
4. **Inconsistent design:** the wallet CLI prints lists and prompts in plain text; the HUD uses Ink and colour.  The two interfaces do not share components or styling.

## Recommendations for a unified Ink‑based wallet TUI

To unify wallet management into a cohesive TUI, reuse the existing Ink patterns from the HUD and design new components for CRUD operations.  The overall goal is to build a **modular React component hierarchy** that can be composed in different CLI commands (e.g., `wallet`, `autopsy`, `dossier`) and still provide a consistent look and feel.

### 1. Build reusable Ink components

| Component | Purpose | Notes |
| --- | --- | --- |
| **`WalletList`** | Displays a list of wallets with alias, public key and type (signing/watch), allowing selection via keyboard.  Could use `ink-select-input` or custom arrow‑key navigation. | Should accept props like `wallets`, `onSelect(alias)` and optionally highlight the default funding wallet.  Reuse the colour palette from `warchestInkApp` via a `colorizer()` helper【933371302952197†L87-L147】. |
| **`WalletCard`** | Show detailed information for a single wallet (balances, tokens, recent events).  This already exists in `warchestInkApp.js` (`createWalletCard()`)【933371302952197†L87-L147】.  Extract it into a separate module and make it accept props such as `editable` (to toggle editing mode). | In management mode, include options like “Edit Options” or “Delete”. |
| **`AddWalletForm`** | Multi‑step form for creating a wallet: prompt for public key (with validation of base58 length and characters【778405523207753†L23-L27】), choose signing/watch status, prompt for alias, optionally pick a colour. | Use Ink’s `TextInput` for typed fields and `SelectInput` for boolean or palette selections.  Show validation errors beneath inputs without leaving the form. |
| **`ColorPicker`** | Presents the available colour palette (`green`, `cyan`, `magenta`, `yellow`, `blue`, `red` etc.) and allows choosing one.  Provide a preview using coloured text and highlight the currently selected colour. | Use this inside `AddWalletForm` or `EditWalletForm`. |
| **`UsageTypeSelector`** | Allows selection among usage types (`funding`, `strategy`, `kol`, `deployer`, `other`) defined in `optionsManager.USAGE_TYPES`【225157254057823†L4-L8】.  Could be part of wallet configuration editing. |
| **`ConfirmPrompt`** | Generic yes/no prompt for deletions or toggles.  Accepts a message and returns a boolean.  Use for confirming removal of a wallet or setting the default funding wallet. |
| **`WalletOptionsForm`** | Edits wallet options: usage type, auto‑attach to HUD (`autoAttachWarchest`), default funding flag, strategy ID.  Pre‑populate current values; use toggles/selects for booleans and text input for strategy ID. | Derive the set of options from `optionsManager.updateWalletOptions()`; ensure boolean toggles are converted to actual booleans【225157254057823†L13-L26】. |
| **`WalletSelector`** | Replace `walletSelection.selectWalletInteractively()` with an Ink component that lists wallets, allows searching/typing to filter, and provides an “Other…” entry for manual address input. | Useful for `dossier` and `autopsy` commands; returns `{walletLabel,walletAddress,walletColor}` like the existing selector【778405523207753†L90-L104】. |

### 2. Structure a wallet management TUI

1. **Main menu** – Present options: *Add wallet*, *List wallets*, *Edit wallet*, *Remove wallet*, *Set wallet colour*, *Configure options*, *Exit*.  Use `ink-select-input` for navigation.  You can fetch the list of wallets once at mount via `walletRegistry.getAllWallets()`【85093078637232†L12-L45】 and keep it in component state.
2. **Add wallet** – Render `AddWalletForm`.  On completion, call `walletRegistry.addWallet(...)` with the collected data.  Show success message and return to main menu.
3. **List wallets** – Render `WalletList` with details.  Allow pressing `Enter` on a wallet to view its `WalletCard` (with balances and tokens) and further actions: *Edit*, *Set colour*, *Remove*, *Back*.  For `Back`, return to the list.
4. **Edit wallet** – Use `WalletOptionsForm` to edit usage type, auto‑attach, default funding and strategy ID.  When saved, call `optionsManager.updateWalletOptions()`【225157254057823†L13-L26】.
5. **Remove wallet** – Use `ConfirmPrompt` to confirm; call `walletRegistry.deleteWallet(alias)`【85093078637232†L42-L45】 on acceptance.
6. **Set colour** – Present `ColorPicker` and update the wallet via `walletRegistry.updateWalletColor()`【85093078637232†L38-L40】.

### 3. Integrate with existing commands

- Replace calls to `walletManagement` in `walletCli.js` with a single call to render the new wallet management TUI.  The CLI entry can look like:

  ```js
  const { render } = require('ink');
  const { WalletManagerApp } = require('../wallets/inkWalletManager');
  async function run(argv) {
    render(<WalletManagerApp args={argv} />);
  }
  ```

  This ensures that running `scoundrel wallet` launches the Ink interface.  You can still support non‑interactive flags (`--solo`) by passing props to `WalletManagerApp` that cause it to run in selection mode only.

- For commands such as `dossier` or `autopsy` that need a wallet selection, import the `WalletSelector` component and render it in the CLI context.  When the user picks a wallet or enters a manual address, resolve it and pass it to the underlying function.

- For `warchestd hud`, you already have `warchestInkApp.js`.  Consider extracting the shared components (colour formatting, token tables, chain status bars) into a shared `lib/ui` folder so both HUD and wallet manager can import them.  For example, move `colorizer()`, `fmtNum()`, `shortenPubkey()` etc. into `lib/ui/utils.js` and import them in both places.

### 4. Implementation tips

- **State management:** you can manage local component state using `useState` and update the `wallets` list after each CRUD operation.  For long‑running operations (e.g., DB persistence), show a spinner or status text.
- **Input validation:** check the public key length and characters as currently done in `promptForPubkey()`【778405523207753†L23-L27】.  Show inline error messages and disable the “Next” button until the input is valid.
- **Async operations:** use `useEffect` for side effects like fetching wallets or saving updates.  Provide user feedback (e.g., “Saving…” or error messages) but avoid blocking the entire UI.
- **Key handling:** Ink’s `useInput` hook lets you listen for keystrokes.  Use it to implement global shortcuts like `q` to exit or `←/→` to change pages in token lists.
- **Reusable modules:** export your new components from a folder like `lib/ui/inkWallet` so they can be imported by other features (e.g., `autopsy`, `dossier` selectors).  This fosters reuse and reduces fragmentation.
- **Testing:** the project already depends on `ink-testing-library`.  Write tests for the new components to ensure that keyboard navigation, input validation and state updates behave as expected.

### 5. Benefits of the proposed design

- **Consistent user experience:** every wallet‑related operation appears in a unified TUI with consistent colours and interaction patterns.
- **Reusability:** components like `WalletList`, `WalletCard`, and `WalletSelector` can be used in multiple commands, reducing duplication.
- **Extensibility:** new features (e.g., exporting wallets, importing from a seed phrase) can be added by creating additional forms and linking them into the main menu.
- **Improved accessibility:** users can navigate with arrow keys and get real‑time feedback instead of answering sequential prompts.

## Conclusion

The current CLI handles wallet operations via scattered `readline` prompts and plain text output, while the HUD uses Ink to produce a rich TUI.  To simplify and unify wallet work, build a dedicated **Ink‑based wallet manager** with reusable components for listing, adding, editing and removing wallets.  This approach mirrors the structure of `warchestInkApp` but focuses on CRUD flows and configuration editing.  By extracting shared utilities and adopting a component‑driven architecture, Scoundrel will gain a cohesive user interface for wallet management and enable more advanced interactive features in the future.
