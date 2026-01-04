[Skip to main content](https://docs.solanatracker.io/raptor/http/get-transaction-status#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

API Reference

Get transaction status

Search docs...

Ctrl K

- [API Status](https://status.solanatracker.io/)
- [Discord](https://discord.gg/JH2e9rR9fc)
- [Changelog](https://docs.solanatracker.io/changelog)

##### Getting Started

- [Overview](https://docs.solanatracker.io/raptor/overview)

##### API Reference

- API Reference

  - [GET\
    \
    Get swap quote](https://docs.solanatracker.io/raptor/http/get-swap-quote)
  - [POST\
    \
    Build swap transaction](https://docs.solanatracker.io/raptor/http/build-swap-transaction)
  - [POST\
    \
    Build swap instructions](https://docs.solanatracker.io/raptor/http/build-swap-instructions)
  - [POST\
    \
    Quote and swap in one request](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request)
  - [POST\
    \
    Send transaction via Yellowstone Jet TPU](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu)
  - [GET\
    \
    Get transaction status](https://docs.solanatracker.io/raptor/http/get-transaction-status)

##### Websocket

- Websockets


##### Resources

- [Transactions](https://docs.solanatracker.io/raptor/transactions)

Get transaction status

cURL

Copy

```
curl --request GET \
  --url https://raptor-beta.solanatracker.io/transaction/{signature}
```

200

404

503

Copy

```
{
  "signature": "<string>",
  "status": "pending",
  "sent_at": 123,
  "slot": 123,
  "confirmed_at": 123,
  "latency_ms": 123,
  "error": "<string>",
  "transaction_base64": "<string>",
  "transaction": {},
  "events": [\
    {\
      "name": "<string>",\
      "data": "<string>",\
      "parsed": {}\
    }\
  ]
}
```

GET

/

transaction

/

{signature}

Try it

Get transaction status

cURL

Copy

```
curl --request GET \
  --url https://raptor-beta.solanatracker.io/transaction/{signature}
```

200

404

503

Copy

```
{
  "signature": "<string>",
  "status": "pending",
  "sent_at": 123,
  "slot": 123,
  "confirmed_at": 123,
  "latency_ms": 123,
  "error": "<string>",
  "transaction_base64": "<string>",
  "transaction": {},
  "events": [\
    {\
      "name": "<string>",\
      "data": "<string>",\
      "parsed": {}\
    }\
  ]
}
```

#### Path Parameters

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#parameter-signature)

signature

string

required

Transaction signature (base58)

#### Response

200

application/json

Transaction status

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-signature)

signature

string

required

Transaction signature (base58)

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-status)

status

enum<string>

required

Transaction status

Available options:

`pending`,

`confirmed`,

`failed`,

`expired`

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-sent-at)

sent_at

integer

required

Unix timestamp (ms) when transaction was sent

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-slot)

slot

integer

Slot where transaction was confirmed

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-confirmed-at)

confirmed_at

integer

Unix timestamp (ms) when transaction was confirmed

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-latency-ms)

latency_ms

integer

Time from send to confirm in milliseconds

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-error)

error

string

Error message if failed

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-transaction-base64)

transaction_base64

string

Raw transaction (base64 encoded)

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-transaction)

transaction

object

Full parsed transaction with metadata

[​](https://docs.solanatracker.io/raptor/http/get-transaction-status#response-events)

events

object[]

Parsed Raptor program events

Showchild attributes

Was this page helpful?

YesNo

[Send transaction via Yellowstone Jet TPU\
\
Previous](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu) [/stream\
\
Next](https://docs.solanatracker.io/raptor/websocket/websockets/stream)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
