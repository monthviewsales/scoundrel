'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMetaBlock,
  buildTokenSummary,
  buildMarketOverview,
  buildFinalPayload,
  pruneNullishPayload,
} = require('../lib/analysis/payloadBuilders');
const { buildOhlcvContext } = require('../lib/analysis/ohlcvContext');
const {
  buildPriceRangeArtifact,
  buildAthPriceArtifact,
} = require('../lib/analysis/apiArtifacts');

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

describe('payload builders (targetscan)', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'payload-builders', 'targetscan');
  const rawDir = path.join(fixtureDir, 'raw');
  const manifest = readJson(path.join(fixtureDir, 'manifest.json'));
  const expectedPrompt = readJson(path.join(fixtureDir, manifest.promptFile));
  const response = readJson(path.join(fixtureDir, manifest.responseFile));
  const expectedFinal = readJson(path.join(fixtureDir, manifest.finalFile));

  it('builds targetscan prompt sections from raw data', () => {
    const tokenInfo = readJson(
      path.join(rawDir, manifest.tokenInfoFile.replace(/^raw[\\/]/, '')),
    ).tokenInfo;

    const token = pruneNullishPayload({
      summary: buildTokenSummary(tokenInfo),
      market: buildMarketOverview(tokenInfo),
    });

    expect(token).toEqual(expectedPrompt.token);

    const meta = pruneNullishPayload({
      meta: buildMetaBlock({
        command: expectedPrompt.meta.command,
        mode: expectedPrompt.meta.mode,
        runId: expectedPrompt.meta.runId,
        scoundrelVersion: expectedPrompt.meta.scoundrelVersion,
        createdAt: expectedPrompt.meta.createdAt,
        fetchedAt: expectedPrompt.meta.fetchedAt,
        mint: expectedPrompt.meta.mint,
      }),
    }).meta;

    expect(meta).toEqual(expectedPrompt.meta);

    const priceRangeRaw = readJson(
      path.join(rawDir, manifest.priceRangeFile.replace(/^raw[\\/]/, '')),
    );
    const priceRange = pruneNullishPayload({
      priceRange: buildPriceRangeArtifact({
        mint: priceRangeRaw.request.mint,
        timeFrom: priceRangeRaw.request.timeFrom,
        timeTo: priceRangeRaw.request.timeTo,
        response: priceRangeRaw.response,
        fetchedAt: priceRangeRaw.fetchedAt,
      }),
    }).priceRange;

    expect(priceRange).toEqual(expectedPrompt.analytics.priceRange);

    const athRaw = readJson(
      path.join(rawDir, manifest.athPriceFile.replace(/^raw[\\/]/, '')),
    );
    const athPrice = pruneNullishPayload({
      athPrice: buildAthPriceArtifact({
        mint: athRaw.mint,
        response: athRaw.response,
        fetchedAt: athRaw.fetchedAt,
      }),
    }).athPrice;

    expect(athPrice).toEqual(expectedPrompt.analytics.athPrice);

    const ohlcvPayload = readJson(
      path.join(rawDir, manifest.ohlcvFile.replace(/^raw[\\/]/, '')),
    );
    const candles = readOhlcvRows(ohlcvPayload);
    const ohlcv = buildOhlcvContext({
      granularity: '1m',
      startTimestamp: ohlcvPayload.request.timeFrom * 1000,
      endTimestamp: ohlcvPayload.request.timeTo * 1000,
      candles,
      summaryWindows: ['5m', '10m', '20m'],
    });

    const prunedOhlcv = pruneNullishPayload({ ohlcv }).ohlcv;
    expect(prunedOhlcv).toEqual(expectedPrompt.analytics.ohlcv);

    const devscanRaw = readJson(
      path.join(rawDir, manifest.devscanMetadataFile.replace(/^raw[\\/]/, '')),
    );
    const devscan = pruneNullishPayload({ devscan: devscanRaw }).devscan;

    expect(devscan).toEqual(expectedPrompt.devscan);
  });

  it('builds final payload by appending the response', () => {
    const finalPayload = buildFinalPayload({ prompt: expectedPrompt, response });
    expect(finalPayload).toEqual(expectedFinal);
  });
});
