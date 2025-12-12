"use strict";

const { EventEmitter } = require("events");

/**
 * Create a simple HUD store backed by an EventEmitter.
 *
 * @param {Function} snapshotProvider function that returns the latest HUD snapshot
 * @returns {{getSnapshot: Function, subscribe: Function, emitChange: Function, removeAllListeners: Function}}
 */
function createHudStore(snapshotProvider) {
  if (typeof snapshotProvider !== "function") {
    throw new Error("createHudStore requires a snapshot provider function");
  }

  const emitter = new EventEmitter();

  const takeSnapshot = () => {
    const snapshot = snapshotProvider();
    if (!snapshot || typeof snapshot !== "object") return snapshot;

    return {
      ...snapshot,
      state: snapshot.state && typeof snapshot.state === "object"
        ? { ...snapshot.state }
        : snapshot.state,
    };
  };

  const getSnapshot = () => takeSnapshot();

  function subscribe(listener) {
    emitter.on("change", listener);
    return () => emitter.off("change", listener);
  }

  function emitChange() {
    emitter.emit("change", takeSnapshot());
  }

  function removeAllListeners() {
    emitter.removeAllListeners();
  }

  return { getSnapshot, subscribe, emitChange, removeAllListeners };
}

module.exports = { createHudStore };
