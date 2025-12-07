'use strict';

const chalk = require('chalk');

describe.skip('Adapter parity (MySQL disabled)', () => {
  // eslint-disable-next-line no-console
  console.warn(
    chalk.bgYellow.black(
      '[BootyBox] MySQL parity tests skipped: MySQL support has ended and SQLite is the only supported engine.'
    )
  );

  test('mysql parity', () => {
    // Intentional no-op.
  });
});
