'use strict';

/**
 * Compatibility shim for the BootyBox package.
 * Re-export the legacy MySQL implementation expected by Scoundrel.
 */
module.exports = require('../db/old.BootyBox.mysql');
