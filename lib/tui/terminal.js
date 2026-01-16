'use strict';

/**
 * Clear the terminal screen and move the cursor to the home position.
 *
 * @returns {void}
 */
function clearScreen() {
  if (!process.stdout || !process.stdout.isTTY) return;
  try {
    process.stdout.write('\x1b[2J\x1b[H');
  } catch (_) {
    // Ignore terminal write failures.
  }
}

/**
 * Prepare the terminal for an Ink TUI session and return a cleanup helper.
 *
 * @returns {Function}
 */
function prepareTuiScreen() {
  clearScreen();
  return () => clearScreen();
}

module.exports = {
  clearScreen,
  prepareTuiScreen,
};
