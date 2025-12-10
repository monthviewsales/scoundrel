'use strict';

const fs = require('fs');

module.exports = async function mockAutopsyRunner(payload) {
  if (process.env.AUTOPSY_WORKER_LOG) {
    fs.writeFileSync(
      process.env.AUTOPSY_WORKER_LOG,
      JSON.stringify({ payload, clientClosed: payload?.client?.closed || false }, null, 2),
    );
  }

  return {
    payload: { ...payload, client: undefined },
    ai: { version: 'autopsy.test', verdict: 'ok' },
    artifactPath: '/tmp/mock-autopsy.json',
  };
};
