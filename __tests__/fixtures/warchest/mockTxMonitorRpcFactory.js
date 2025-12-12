'use strict';

module.exports = function mockTxMonitorRpcFactory() {
  let delivered = false;
  return {
    rpc: {
      async getTransaction() {
        if (delivered) return null;
        delivered = true;
        return { slot: 9999, err: null };
      },
    },
    rpcSubs: {},
    close: async () => {},
  };
};
