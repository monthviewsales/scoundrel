[Skip to main content](https://docs.solanatracker.io/raptor/transactions#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

Resources

Transactions

Search docs...

Ctrl K

- [API Status](https://status.solanatracker.io/)
- [Discord](https://discord.gg/JH2e9rR9fc)
- [Changelog](https://docs.solanatracker.io/changelog)

##### Getting Started

- [Overview](https://docs.solanatracker.io/raptor/overview)

##### API Reference

- API Reference


##### Websocket

- Websockets


##### Resources

- [Transactions](https://docs.solanatracker.io/raptor/transactions)

On this page

- [What This Does](https://docs.solanatracker.io/raptor/transactions#what-this-does)
- [Send a Transaction](https://docs.solanatracker.io/raptor/transactions#send-a-transaction)
- [Track a Transaction](https://docs.solanatracker.io/raptor/transactions#track-a-transaction)
- [Status Values](https://docs.solanatracker.io/raptor/transactions#status-values)
- [Raptor Events](https://docs.solanatracker.io/raptor/transactions#raptor-events)
- [Examples](https://docs.solanatracker.io/raptor/transactions#examples)
- [Send a Transaction](https://docs.solanatracker.io/raptor/transactions#send-a-transaction-2)
- [Poll for Confirmation](https://docs.solanatracker.io/raptor/transactions#poll-for-confirmation)
- [Read Swap Results](https://docs.solanatracker.io/raptor/transactions#read-swap-results)
- [Errors](https://docs.solanatracker.io/raptor/transactions#errors)

## [​](https://docs.solanatracker.io/raptor/transactions\#what-this-does)  What This Does

- Sends transactions with low latency
- Tracks confirmation status in real time
- Automatically retries unconfirmed transactions
- Returns parsed transaction data and Raptor events
- Measures send → confirm latency

* * *

## [​](https://docs.solanatracker.io/raptor/transactions\#send-a-transaction)  Send a Transaction

Send a signed Solana transaction.**Endpoint**`POST /send-transaction`**Request Body**

Copy

```
{
  "transaction": "base64-encoded-transaction"
}
```

**Response**

Copy

```
{
  "signature": "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  "signature_base64": "RXNzaWduYXR1cmU=",
  "success": true
}
```

**Notes**

- Returns immediately after accepting the transaction
- Sending and retrying happens in the background
- Transactions are retried for up to **30 seconds** or until confirmed

* * *

## [​](https://docs.solanatracker.io/raptor/transactions\#track-a-transaction)  Track a Transaction

Check the status of a transaction sent via `/send-transaction`.**Endpoints**

- `GET /transaction/{signature}`

The signature can be **base58 or base64**.**Response (example)**

Copy

```
{
  "signature": "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  "status": "confirmed",
  "slot": 250123456,
  "sent_at": 1703123456789,
  "confirmed_at": 1703123456795,
  "latency_ms": 6,
  "transaction": { ... },
  "events": [ ... ]
}
```

### [​](https://docs.solanatracker.io/raptor/transactions\#status-values)  Status Values

- `pending` – sent but not confirmed
- `confirmed` – finalized on-chain
- `failed` – transaction error
- `expired` – not confirmed before timeout

* * *

## [​](https://docs.solanatracker.io/raptor/transactions\#raptor-events)  Raptor Events

If the transaction interacts with the **Raptor program**, events are automatically parsed and returned.**Supported Events**

- `SwapEvent`
- `SwapCompleteEvent`
- `PlaceOrderEvent`
- `FillOrderEvent`
- `CancelOrderEvent`
- `UpdateOrderEvent`

**Event Format**

Copy

```
{
  "name": "SwapEvent",
  "data": "base64-encoded-data",
  "parsed": {
    "dex": 1,
    "amountIn": 1000000,
    "amountOut": 999000
  }
}
```

* * *

## [​](https://docs.solanatracker.io/raptor/transactions\#examples)  Examples

### [​](https://docs.solanatracker.io/raptor/transactions\#send-a-transaction-2)  Send a Transaction

Copy

```
const response = await fetch('/send-transaction', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ transaction: signedTx })
});

const result = await response.json();
console.log(result.signature);
```

### [​](https://docs.solanatracker.io/raptor/transactions\#poll-for-confirmation)  Poll for Confirmation

Copy

```
async function waitForConfirmation(signature) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`/transaction/${signature}`);
    const tx = await res.json();

    if (tx.status === 'confirmed' || tx.status === 'failed') {
      return tx;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('Timeout');
}
```

### [​](https://docs.solanatracker.io/raptor/transactions\#read-swap-results)  Read Swap Results

Copy

```
const tx = await fetch(`/transaction/${signature}`).then(r => r.json());

for (const event of tx.events ?? []) {
  if (event.name === 'SwapEvent') {
    console.log(event.parsed.amountIn, '→', event.parsed.amountOut);
  }
}
```

* * *

## [​](https://docs.solanatracker.io/raptor/transactions\#errors)  Errors

| Code | Meaning |
| --- | --- |
| 400 | Invalid transaction |
| 404 | Transaction not tracked |
| 503 | Sender or tracking disabled |

Copy

```
{
  "error": "Transaction not found",
  "code": 404
}
```

Was this page helpful?

YesNo

[/stream\
\
Previous](https://docs.solanatracker.io/raptor/websocket/websockets/stream)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
