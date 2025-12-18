'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function clearRequireCache(matcher) {
  for (const k of Object.keys(require.cache)) {
    if (matcher(k)) delete require.cache[k];
  }
}

describe('trade_uuid resolver: closed_at=0 open runs are discoverable', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoundrel-bootybox-'));
    dbPath = path.join(tmpDir, 'bootybox.test.db');

    process.env.BOOTYBOX_SQLITE_PATH = dbPath;

    // IMPORTANT: ensure a fresh init against this sqlite file
    clearRequireCache((k) => k.includes(`${path.sep}db${path.sep}src${path.sep}adapters${path.sep}sqlite`));
    clearRequireCache((k) => k.endsWith(`${path.sep}db${path.sep}src${path.sep}adapters${path.sep}sqlite${path.sep}context.js`));
    clearRequireCache((k) => k.endsWith(`${path.sep}db${path.sep}src${path.sep}adapters${path.sep}sqliteSchema.js`));
  });

  afterEach(() => {
    // Attempt to close db cleanly (if adapter exposes it)
    try {
      const ctx = require('../src/adapters/sqlite/context');
      if (typeof ctx.closeDb === 'function') ctx.closeDb();
    } catch (_) {}

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('sell without trade_uuid reuses open run UUID when sc_positions.closed_at=0', () => {
    // 1) Load sqlite adapter AFTER env is set + cache cleared
    // Adjust this require if your sqlite adapter entry differs.
    const sqliteAdapter = require('../src/adapters/sqlite');

    // Depending on your exports, recordScTradeEvent might be:
    // - sqliteAdapter.recordScTradeEvent
    // - sqliteAdapter.trading.recordScTradeEvent
    // - require('../src/adapters/sqlite/trading/recordScTradeEvent')
    const recordScTradeEvent =
      sqliteAdapter?.recordScTradeEvent ||
      sqliteAdapter?.trading?.recordScTradeEvent ||
      require('../src/adapters/sqlite/trading/recordScTradeEvent');

    if (typeof recordScTradeEvent !== 'function') {
      throw new Error(
        [
          'Could not resolve recordScTradeEvent() for this test.',
          'This unit test verifies that sells without an explicit trade_uuid reuse the OPEN position-run UUID',
          'even when sc_positions.closed_at uses 0 (not NULL) to represent an open run.',
          'Fix: update the require/export path here so the test can invoke recordScTradeEvent.',
        ].join(' '),
      );
    }

    const { db } = require('../src/adapters/sqlite/context');

    const walletId = 1;
    const walletAlias = 'test';
    const mint = 'FxTestMint11111111111111111111111111111111111';

    const buyTxid = 'BUY_TXID_1';
    const sellTxid = 'SELL_TXID_1';
    const t0 = Date.now();

    // BUY without trade_uuid → must mint a UUID + create open position (closed_at=0)
    recordScTradeEvent({
      txid: buyTxid,
      walletId,
      walletAlias,
      coinMint: mint,
      side: 'buy',
      executedAt: t0,
      tokenAmount: 1000,
      solAmount: -0.01,
      program: 'test',
      // intentionally no tradeUuid / trade_uuid
    });

    const buyRow = db.prepare('SELECT txid, side, trade_uuid FROM sc_trades WHERE txid = ?').get(buyTxid);
    expect(buyRow).toBeTruthy();
    expect(buyRow.side).toBe('buy');
    expect(typeof buyRow.trade_uuid).toBe('string');
    expect(buyRow.trade_uuid.length).toBeGreaterThan(10);

    const openPos = db.prepare(`
      SELECT trade_uuid, closed_at
      FROM sc_positions
      WHERE wallet_id = ? AND coin_mint = ?
        AND (closed_at IS NULL OR closed_at = 0)
      ORDER BY open_at DESC
      LIMIT 1
    `).get(walletId, mint);

    expect(openPos).toBeTruthy();
    expect(openPos.trade_uuid).toBe(buyRow.trade_uuid);

    // If this fails, the app's definition of "open run" is inconsistent.
    // In this codebase, applyScTradeEventToPositions commonly defaults closed_at to 0 for open rows.
    // All resolvers (context.js) must treat closed_at=0 as OPEN, or later trades missing trade_uuid
    // can mint a fresh UUID and split a single campaign across multiple trade_uuid values.
    expect(
      openPos.closed_at === 0 || openPos.closed_at === null,
    ).toBe(true);

    // SELL without trade_uuid → must resolve SAME open UUID (not mint a new one)
    recordScTradeEvent({
      txid: sellTxid,
      walletId,
      walletAlias,
      coinMint: mint,
      side: 'sell',
      executedAt: t0 + 1000,
      tokenAmount: 10,
      solAmount: 0.0002,
      program: 'test',
      // intentionally no tradeUuid / trade_uuid
    });

    const sellRow = db.prepare('SELECT txid, side, trade_uuid FROM sc_trades WHERE txid = ?').get(sellTxid);
    expect(sellRow).toBeTruthy();
    expect(sellRow.side).toBe('sell');

    // Core invariant: a sell missing trade_uuid must resolve the currently-open position-run UUID.
    // If this fails, your resolver/cache likely treated closed_at=0 rows as CLOSED and minted a new UUID,
    // splitting one campaign across multiple trade_uuid values.
    expect(sellRow.trade_uuid).toBe(buyRow.trade_uuid);

    // Prove campaign didn’t split in sc_trades
    const uuids = db.prepare(`
      SELECT trade_uuid, COUNT(*) AS n
      FROM sc_trades
      WHERE wallet_id = ? AND coin_mint = ?
      GROUP BY trade_uuid
    `).all(walletId, mint);

    expect(uuids.length).toBe(1);
    expect(uuids[0].trade_uuid).toBe(buyRow.trade_uuid);
    expect(uuids[0].n).toBe(2);

    // Helpful debugging output if the invariant above ever regresses.
    // (Jest will show this in the failure diff.)
    if (uuids.length !== 1 || uuids[0].n !== 2) {
      // eslint-disable-next-line no-console
      console.error('[DEBUG] sc_trades grouped by trade_uuid:', uuids);
    }
  });
});