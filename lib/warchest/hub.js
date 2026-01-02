'use strict';

const { createHubCoordinator } = require('./hubCoordinator');

let coordinator = null;

/**
 * Return the singleton hub coordinator.
 *
 * @param {Object} [options]
 * @returns {ReturnType<typeof createHubCoordinator>}
 */
function getHubCoordinator(options) {
  if (!coordinator) {
    coordinator = createHubCoordinator(options);
  }
  return coordinator;
}

/**
 * Close the singleton hub coordinator and release resources.
 *
 * @returns {void}
 */
function closeHubCoordinator() {
  if (coordinator) {
    coordinator.close();
    coordinator = null;
  }
}

module.exports = { getHubCoordinator, closeHubCoordinator };
