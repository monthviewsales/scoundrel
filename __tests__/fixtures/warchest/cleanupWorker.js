'use strict';

const fs = require('fs');
const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');

let lastPath = null;

createWorkerHarness(
  async (payload, { track }) => {
    lastPath = payload.logPath;
    track({
      close: () => {
        fs.appendFileSync(payload.logPath, 'closed\n');
      },
    });
    track({
      unsubscribe: () => {
        fs.appendFileSync(payload.logPath, 'unsubscribed\n');
      },
    });
    return { ok: true };
  },
  {
    onClose: () => {
      if (lastPath) {
        fs.appendFileSync(lastPath, 'onClose\n');
      }
    },
  },
);
