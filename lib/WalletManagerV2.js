

'use strict';

/**
 * WalletManagerV2
 *
 * This class is designed to run inside the HUD / daemon layer.
 * It does NOT own live balances or RPC subscriptions itself.
 *
 * Instead, it is fed log notifications (from logsSubscribe) and
 * turns relevant transactions into canonical trade events, which
 * it then persists via BootyBox into sc_trades and sc_positions.
 */

const logger = require('./logger');

/**
 * @typedef {Object} ScTradeEvent
 * @property {string} txid
 * @property {number|string} walletId
 * @property {string} walletAlias
 * @property {string} coinMint
 * @property {'buy'|'sell'} side
 * @property {number} executedAt            Unix epoch millis
 * @property {number} tokenAmount           Absolute token amount
 * @property {number} solAmount             Signed SOL delta (wallet POV)
 * @property {string|null} [tradeUuid]
 * @property {string|null} [strategyId]
 * @property {string|null} [strategyName]
 * @property {number|null} [priceSolPerToken]
 * @property {number|null} [priceUsdPerToken]
 * @property {number|null} [solUsdPrice]
 * @property {number|null} [feesSol]
 * @property {number|null} [feesUsd]
 * @property {number|null} [slippagePct]
 * @property {number|null} [priceImpactPct]
 * @property {string|null} [program]
 * @property {Object|null} [evaluationPayload]
 * @property {Object|null} [decisionPayload]
 * @property {string|null} [decisionLabel]
 * @property {string|null} [decisionReason]
 */

/**
 * @typedef {Object} StrategyDecisionContext
 * @property {string|null} [tradeUuid]
 * @property {string|null} [strategyId]
 * @property {string|null} [strategyName]
 * @property {Object|null} [evaluationPayload]
 * @property {Object|null} [decisionPayload]
 * @property {string|null} [decisionLabel]
 * @property {string|null} [decisionReason]
 */

/**
 * @typedef {Object} WalletManagerV2Options
 * @property {import('@solana/kit').RpcClient} rpc          - SolanaTracker Kit RPC client
 * @property {number|string} walletId                       - Internal wallet id (DB id)
 * @property {string} walletAlias                           - Human-friendly name
 * @property {string} walletPubkey                          - Base58 wallet public key
 * @property {Object} txInsightService                      - Must expose recoverPriceFromTransactionv2(txid)
 * @property {Object} tokenPriceService                     - Optional, for SOL/USD prices etc.
 * @property {Object} bootyBox                              - BootyBox adapter instance
 * @property {Object} strategyContextProvider               - Provider for AI/strategy decision context
 */

class WalletManagerV2 {
  /**
   * @param {WalletManagerV2Options} opts
   */
  constructor(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('WalletManagerV2 requires an options object');
    }

    const {
      rpc,
      walletId,
      walletAlias,
      walletPubkey,
      txInsightService,
      tokenPriceService,
      bootyBox,
      strategyContextProvider,
    } = opts;

    if (!rpc) throw new Error('WalletManagerV2: rpc client is required');
    if (walletId == null) throw new Error('WalletManagerV2: walletId is required');
    if (!walletAlias) throw new Error('WalletManagerV2: walletAlias is required');
    if (!walletPubkey) throw new Error('WalletManagerV2: walletPubkey is required');
    if (!txInsightService || typeof txInsightService.recoverPriceFromTransactionv2 !== 'function') {
      throw new Error('WalletManagerV2: txInsightService.recoverPriceFromTransactionv2 is required');
    }
    if (!bootyBox) {
      throw new Error('WalletManagerV2: bootyBox adapter instance is required');
    }

    this.rpc = rpc;
    this.walletId = walletId;
    this.walletAlias = walletAlias;
    this.walletPubkey = walletPubkey;
    this.txInsightService = txInsightService;
    this.tokenPriceService = tokenPriceService || null;
    this.bootyBox = bootyBox;
    this.strategyContextProvider = strategyContextProvider || null;

    /** @type {Set<string>} */
    this._inFlightSignatures = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Handle a single logsSubscribe notification.
   *
   * NOTE: This method is intentionally conservative. It does not assume the
   * shape of the notification beyond standard Solana RPC fields. The HUD
   * worker is expected to pre-filter obvious noise (non-trade logs, unrelated
   * programs) before calling this.
   *
   * @param {Object} notification - logs subscription notification
   */
  async handleLogNotification(notification) {
    if (!notification || typeof notification !== 'object') {
      return;
    }

    // Solana RPC style: { value: { signature, logs, err }, context: { slot } }
    const value = notification.value || notification.result || notification;
    const signature = value && (value.signature || value.txid || value.txId);

    if (!signature || typeof signature !== 'string') {
      return;
    }

    // Best-effort filter: if the tx is known to have failed, skip.
    if (value.err) {
      logger.debug(
        '[WalletManagerV2] Skipping failed transaction signature %s',
        signature,
      );
      return;
    }

    // De-duplicate concurrent processing of the same signature.
    if (this._inFlightSignatures.has(signature)) {
      return;
    }

    this._inFlightSignatures.add(signature);

    try {
      await this.processSignature(signature);
    } catch (err) {
      logger.error(
        '[WalletManagerV2] Error processing signature %s: %s',
        signature,
        err && err.message ? err.message : err,
      );
    } finally {
      this._inFlightSignatures.delete(signature);
    }
  }

  /**
   * Process a confirmed transaction signature into a ScTradeEvent and persist
   * it via BootyBox. This does not assume that every transaction is a trade;
   * if txInsightService cannot derive a valid token/SOL delta, the call is
   * treated as a no-op.
   *
   * @param {string} signature
   * @returns {Promise<void>}
   */
  async processSignature(signature) {
    // 1) Use txInsightService to derive token/SOL deltas and pricing.
    const info = await this.txInsightService.recoverPriceFromTransactionv2(signature);

    if (!info || typeof info !== 'object') {
      logger.debug(
        '[WalletManagerV2] Tx %s did not yield insight; skipping.',
        signature,
      );
      return;
    }

    const { mint, tokenDelta, solDelta } = info;

    if (!mint || typeof mint !== 'string') {
      logger.debug(
        '[WalletManagerV2] Tx %s has no discernible mint; skipping.',
        signature,
      );
      return;
    }

    if (!Number.isFinite(tokenDelta) || tokenDelta === 0) {
      logger.debug(
        '[WalletManagerV2] Tx %s has zero tokenDelta; treating as non-trade.',
        signature,
      );
      return;
    }

    const side = tokenDelta > 0 ? 'buy' : 'sell';
    const tokenAmount = Math.abs(Number(tokenDelta));
    const solAmount = Number.isFinite(Number(solDelta)) ? Number(solDelta) : 0;

    // 2) Enrich with pricing if available.
    const priceSolPerToken = Number.isFinite(Number(info.priceSolPerToken))
      ? Number(info.priceSolPerToken)
      : null;

    let solUsdPrice = null;
    let priceUsdPerToken = null;

    if (this.tokenPriceService && typeof this.tokenPriceService.getCurrentSolPrice === 'function') {
      try {
        solUsdPrice = await this.tokenPriceService.getCurrentSolPrice();
        if (Number.isFinite(solUsdPrice) && priceSolPerToken != null) {
          priceUsdPerToken = priceSolPerToken * solUsdPrice;
        }
      } catch (err) {
        logger.warn(
          '[WalletManagerV2] Failed to fetch current SOL price for tx %s: %s',
          signature,
          err && err.message ? err.message : err,
        );
      }
    }

    const feesSol = Number.isFinite(Number(info.feesSol)) ? Number(info.feesSol) : null;
    const feesUsd =
      solUsdPrice != null && feesSol != null
        ? feesSol * solUsdPrice
        : null;

    const slippagePct = Number.isFinite(Number(info.slippagePct))
      ? Number(info.slippagePct)
      : null;

    const priceImpactPct = Number.isFinite(Number(info.priceImpactPct))
      ? Number(info.priceImpactPct)
      : null;

    const program = typeof info.program === 'string' ? info.program : null;

    // 3) Attach strategy / WarlordAI decision context if available.
    /** @type {StrategyDecisionContext|null} */
    let decisionContext = null;

    if (this.strategyContextProvider &&
        typeof this.strategyContextProvider.getDecisionContext === 'function') {
      try {
        decisionContext = await this.strategyContextProvider.getDecisionContext({
          walletId: this.walletId,
          walletAlias: this.walletAlias,
          walletPubkey: this.walletPubkey,
          mint,
          txid: signature,
          side,
        });
      } catch (err) {
        logger.warn(
          '[WalletManagerV2] Error fetching decision context for %s: %s',
          signature,
          err && err.message ? err.message : err,
        );
      }
    }

    const executedAt = Number.isFinite(Number(info.executedAt))
      ? Number(info.executedAt)
      : Date.now();

    /** @type {ScTradeEvent} */
    const tradeEvent = {
      txid: signature,
      walletId: this.walletId,
      walletAlias: this.walletAlias,
      coinMint: mint,
      side,
      executedAt,
      tokenAmount,
      solAmount,
      tradeUuid: decisionContext && decisionContext.tradeUuid ? decisionContext.tradeUuid : null,
      strategyId: decisionContext && decisionContext.strategyId ? decisionContext.strategyId : null,
      strategyName: decisionContext && decisionContext.strategyName ? decisionContext.strategyName : null,
      priceSolPerToken,
      priceUsdPerToken,
      solUsdPrice,
      feesSol,
      feesUsd,
      slippagePct,
      priceImpactPct,
      program,
      evaluationPayload: decisionContext ? decisionContext.evaluationPayload || null : null,
      decisionPayload: decisionContext ? decisionContext.decisionPayload || null : null,
      decisionLabel: decisionContext ? decisionContext.decisionLabel || null : null,
      decisionReason: decisionContext ? decisionContext.decisionReason || null : null,
    };

    // 4) Persist via BootyBox. These helpers are expected to be implemented
    // against the sc_trades and sc_positions tables.
    if (typeof this.bootyBox.recordScTradeEvent !== 'function') {
      logger.warn(
        '[WalletManagerV2] bootyBox.recordScTradeEvent is not implemented; trade event will not be persisted.',
      );
    } else {
      await this.bootyBox.recordScTradeEvent(tradeEvent);
    }

    if (typeof this.bootyBox.applyScTradeEventToPositions !== 'function') {
      logger.warn(
        '[WalletManagerV2] bootyBox.applyScTradeEventToPositions is not implemented; positions will not be updated.',
      );
    } else {
      await this.bootyBox.applyScTradeEventToPositions(tradeEvent);
    }
  }
}

module.exports = WalletManagerV2;