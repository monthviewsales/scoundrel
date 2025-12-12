'use strict';

const fs = require('fs');

module.exports = async function mockDossierRunner(payload) {
  if (process.env.DOSSIER_WORKER_LOG) {
    fs.writeFileSync(process.env.DOSSIER_WORKER_LOG, JSON.stringify(payload, null, 2));
  }

  return {
    wallet: payload.wallet,
    merged: { meta: { wallet: payload.wallet } },
    openAiResult: { version: 'dossier.test', markdown: '# ok' },
  };
};
