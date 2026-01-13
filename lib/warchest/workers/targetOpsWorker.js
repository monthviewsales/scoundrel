#!/usr/bin/env node
"use strict";

const baseLogger = require("../../logger");
const { createWorkerHarness } = require("./harness");
const { createWorkerLogger } = require("./workerLogger");
const { createTargetOpsController } = require("./targetOps/controller");

const targetOpsLogger = createWorkerLogger({
  workerName: "targetOpsWorker",
  scope: "targetOps",
  baseLogger,
  includeCallsite: true,
});

/**
 * Start TargetOps via IPC harness.
 * @returns {void}
 */
function startHarness() {
  let controller = null;

  process.on("unhandledRejection", (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    targetOpsLogger.error(`[targetOps] unhandledRejection: ${message}`);
    if (reason && reason.stack) targetOpsLogger.error(reason.stack);
  });

  process.on("uncaughtException", (err) => {
    const message = err && err.message ? err.message : String(err);
    targetOpsLogger.error(`[targetOps] uncaughtException: ${message}`);
    if (err && err.stack) targetOpsLogger.error(err.stack);
  });

  createWorkerHarness(
    async (payload, { env }) => {
      targetOpsLogger.debug(
        `[targetOps] IPC payload received = ${
          Object.keys(payload || {}).join(",") || "none"
        }`
      );

      controller = createTargetOpsController(payload, { env }, targetOpsLogger);
      return controller.start();
    },
    {
      exitOnComplete: false,
      workerName: "targetOps",
      logger: targetOpsLogger,
      onClose: async () => {
        if (controller && typeof controller.stop === "function") {
          await controller.stop("terminated");
        }
      },
    }
  );

  process.on("message", (msg) => {
    if (!msg || msg.type !== "stop") return;
    if (controller && typeof controller.stop === "function") {
      controller.stop("stop-request");
    }
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  startHarness,
  createTargetOpsController,
};
