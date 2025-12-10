'use strict';

const fs = require('fs');

module.exports = function mockAutopsyClientFactory() {
  const logPath = process.env.AUTOPSY_CLIENT_LOG;
  return {
    closed: false,
    async close() {
      this.closed = true;
      if (logPath) {
        fs.writeFileSync(logPath, 'closed', 'utf8');
      }
    },
  };
};
