'use strict';

function ensureSubscriptionMethod(rpcSubs, method, helperName) {
  if (!rpcSubs || typeof rpcSubs[method] !== 'function') {
    throw new Error(`${helperName}: subscriptions client does not provide ${method}`);
  }
}

async function openSubscription({
  builder,
  subscribeOptions,
  helperName,
  onUpdate,
  onError,
  rpcSubs,
  unsubscribeMethod,
}) {
  if (typeof onUpdate !== 'function') {
    throw new Error(`${helperName}: onUpdate must be a function`);
  }

  if (!builder) {
    throw new Error(`${helperName}: subscription builder missing`);
  }

  let iterator;
  if (typeof builder.subscribe === 'function') {
    iterator = await builder.subscribe(subscribeOptions || {});
  } else if (typeof builder[Symbol.asyncIterator] === 'function') {
    iterator = builder;
  } else {
    throw new Error(`${helperName}: subscription builder missing subscribe()`);
  }

  let subscriptionId = iterator?.subscriptionId ?? builder?.subscriptionId ?? null;
  let active = true;

  const runner = (async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const update of iterator) {
        if (!active) break;
        onUpdate(update);
      }
    } catch (err) {
      if (!active) return;
      if (typeof onError === 'function') {
        onError(err);
      } else {
        throw err;
      }
    }
  })();

  runner.catch((err) => {
    if (!active && err?.name === 'AbortError') return;
    if (typeof onError === 'function') {
      onError(err);
    }
  });

  async function unsubscribe() {
    if (!active) return;
    active = false;
    if (iterator && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch (_) {
        // ignore iterator cleanup errors
      }
    }
    if (
      subscriptionId != null &&
      unsubscribeMethod &&
      rpcSubs &&
      typeof rpcSubs[unsubscribeMethod] === 'function'
    ) {
      await rpcSubs[unsubscribeMethod](subscriptionId);
    }
  }

  return { subscriptionId, unsubscribe };
}

module.exports = {
  ensureSubscriptionMethod,
  openSubscription,
};
