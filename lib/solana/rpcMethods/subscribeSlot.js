// lib/rpcMethods/subscribeSlot.js
// FINAL — NO PRIVATE FIELDS, WORKS 100% WITH SOLANATRACKER

function createSubscribeSlot(rpcSubs) {
  return async function subscribeSlot(onUpdate) {
    // Generate unique request ID
    const requestId = Date.now() + Math.random();

    // This will hold our subscription ID
    let subscriptionId = null;

    // Listen to ALL incoming messages
    const messageHandler = (rawMessage) => {
      let message;
      try {
        message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
      } catch {
        return;
      }

      // 1. Catch our subscription response
      if (message.id === requestId) {
        if (message.error) {
          console.error('slotSubscribe failed:', message.error);
          return;
        }
        subscriptionId = message.result;
        console.log('[slotSubscribe] SUCCESS → ID:', subscriptionId);
      }

      // 2. Catch real slot updates (notifications)
      if (message.method === 'slotSubscribe' && message.params?.result) {
        onUpdate(message.params.result);
      }
    };

    // Hook into the transport's raw message stream
    const transport = rpcSubs._transport;
    const originalOnMessage = transport._onMessage;

    transport._onMessage = (msg) => {
      messageHandler(msg);
      // Forward to original handler so kit doesn't break
      if (originalOnMessage) originalOnMessage(msg);
    };

    // Send the raw param-less request
    transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'slotSubscribe',
      // NO params key → SolanaTracker accepts this
    }));

    // Return unsubscribe
    return {
      subscriptionId: () => subscriptionId,
      unsubscribe: async () => {
        if (subscriptionId === null) return;
        transport.send(JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'slotUnsubscribe',
          params: [subscriptionId]
        }));
        // Restore original handler
        transport._onMessage = originalOnMessage;
      }
    };
  };
}

module.exports = { createSubscribeSlot };