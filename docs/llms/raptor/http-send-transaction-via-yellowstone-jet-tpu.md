[Skip to main content](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

API Reference

Send transaction via Yellowstone Jet TPU

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

Send transaction via Yellowstone Jet TPU

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/send-transaction \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "transaction": "<string>"\n}\n'
```

200

400

503

Copy

```
{
  "signature": "<string>",
  "signature_base64": "<string>",
  "success": true
}
```

POST

/

send-transaction

Try it

Send transaction via Yellowstone Jet TPU

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/send-transaction \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "transaction": "<string>"\n}\n'
```

200

400

503

Copy

```
{
  "signature": "<string>",
  "signature_base64": "<string>",
  "success": true
}
```

#### Body

application/json

[​](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu#body-transaction)

transaction

string

required

Base64-encoded VersionedTransaction bytes

#### Response

200

application/json

Transaction accepted for sending

[​](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu#response-signature)

signature

string

required

Transaction signature (base58)

[​](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu#response-signature-base64)

signature_base64

string

required

Transaction signature (base64)

[​](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu#response-success)

success

boolean

required

Always true if request accepted

Was this page helpful?

YesNo

[Quote and swap in one request\
\
Previous](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request) [Get transaction status\
\
Next](https://docs.solanatracker.io/raptor/http/get-transaction-status)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
