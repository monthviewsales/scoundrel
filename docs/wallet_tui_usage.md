# Wallet TUI usage

The `scoundrel wallet` command now launches an **Ink** TUI by default. Use the arrow keys to navigate and enter to select.

- `scoundrel wallet` → opens the wallet manager menu (add, list, colour, options, remove).
- `scoundrel wallet --solo` → jumps directly to the solo wallet picker.
- `scoundrel wallet --no-tui` → falls back to the legacy readline prompts for automation.

Autopsy also supports the Ink prompt for picking a wallet and mint. Non-interactive flags are available:

- `scoundrel autopsy --wallet <alias|address> --mint <mint>` to skip the TUI.
- `scoundrel autopsy --no-tui` keeps TUI disabled when passing flags from automation.
