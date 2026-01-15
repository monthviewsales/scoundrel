'use strict';

const EventEmitter = require('events');

/**
 * Create a simple event bus for TUI flows.
 *
 * @returns {{ emit: Function, on: Function, off: Function, clear: Function }}
 */
function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    emit: (event) => emitter.emit('event', event),
    on: (handler) => {
      emitter.on('event', handler);
      return () => emitter.off('event', handler);
    },
    off: (handler) => emitter.off('event', handler),
    clear: () => emitter.removeAllListeners(),
  };
}

module.exports = {
  createEventBus,
};
