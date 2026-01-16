'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildTokenSummary,
  buildMarketOverview,
  buildTokenSnapshotSummary,
  pruneNullishPayload,
} = require('../lib/analysis/payloadBuilders');
const { buildOhlcvContext } = require('../lib/analysis/ohlcvContext');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readOhlcvRows(payload) {
  const resp = payload?.response;
  const rawRows = Array.isArray(resp?.oclhv)
    ? resp.oclhv
    : Array.isArray(resp?.candles)
      ? resp.candles
      : Array.isArray(resp?.data)
        ? resp.data
        : Array.isArray(resp)
          ? resp
          : [];

  return rawRows.map((row) => ({
    t: row.time,
    o: row.open,
    c: row.close,
    l: row.low,
    h: row.high,
    v: row.volume,
  }));
}

describe('payload builders (autopsy)', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'payload-builders', 'autopsy');
  const rawDir = path.join(fixtureDir, 'raw');
  const expected = readJson(path.join(fixtureDir, 'expected-prompt.json'));
  const manifest = readJson(path.join(fixtureDir, 'manifest.json'));

  it('derives token summary and market overview from tokenInfo', () => {
    const tokenInfo = readJson(path.join(rawDir, manifest.tokenInfoFile.replace(/^raw[\\/]/, ''))).tokenInfo;
    const tokenSummary = pruneNullishPayload({ token: buildTokenSummary(tokenInfo) }).token;
    const marketOverview = pruneNullishPayload({ overview: buildMarketOverview(tokenInfo) }).overview;

    expect(tokenSummary).toEqual(expected.campaign.token);
    expect(marketOverview).toEqual(expected.campaign.marketContext.overview);
  });

  it('builds snapshot summaries and OHLCV context to match prompt output', () => {
    const snapshotStart = readJson(path.join(rawDir, manifest.snapshotStartFile.replace(/^raw[\\/]/, '')));
    const snapshotEnd = readJson(path.join(rawDir, manifest.snapshotEndFile.replace(/^raw[\\/]/, '')));
    const ohlcvPayload = readJson(path.join(rawDir, manifest.ohlcvFile.replace(/^raw[\\/]/, '')));

    const startSummary = pruneNullishPayload({ snapshot: buildTokenSnapshotSummary(snapshotStart.response) }).snapshot;
    const endSummary = pruneNullishPayload({ snapshot: buildTokenSnapshotSummary(snapshotEnd.response) }).snapshot;

    const expectedSnapshot = expected.campaign.marketContext.ochlvWindow.marketSnapshot;
    const marketSnapshot = {
      startTimestamp: expectedSnapshot.startTimestamp,
      endTimestamp: expectedSnapshot.endTimestamp,
      start: startSummary,
      end: endSummary,
    };

    const candles = readOhlcvRows(ohlcvPayload);
    const ohlcv = buildOhlcvContext({
      granularity: '1m',
      startTimestamp: ohlcvPayload.request.timeFrom * 1000,
      endTimestamp: ohlcvPayload.request.timeTo * 1000,
      candles,
      marketSnapshot,
    });

    const prunedOhlcv = pruneNullishPayload({ ohlcv }).ohlcv;
    expect(prunedOhlcv).toEqual(expected.campaign.marketContext.ochlvWindow);
  });
});
