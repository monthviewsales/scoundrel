'use strict';

// Thin wrapper around the existing warchest wallet registry.
// BootyBox remains the persistence layer; this module simply re-exports the
// registry helpers for use by wallet resolver/consumers.
const walletRegistry = require('../warchest/walletRegistry');

module.exports = walletRegistry;
