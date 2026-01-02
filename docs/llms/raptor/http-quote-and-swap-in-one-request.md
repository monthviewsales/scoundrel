[Skip to main content](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

API Reference

Quote and swap in one request

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

Quote and swap in one request

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/quote-and-swap \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "userPublicKey": "<string>",\n  "inputMint": "<string>",\n  "outputMint": "<string>",\n  "amount": 123,\n  "slippageBps": "<string>",\n  "dexes": "<string>",\n  "maxHops": 123,\n  "wrapUnwrapSol": true,\n  "txVersion": "v0",\n  "priorityFee": "<string>",\n  "feeAccount": "<string>",\n  "feeBps": 123,\n  "feeFromInput": false\n}\n'
```

200

Copy

```
{
  "quote": {
    "inputMint": "<string>",
    "outputMint": "<string>",
    "amountIn": "<string>",
    "amountOut": "<string>",
    "minAmountOut": "<string>",
    "feeAmount": "<string>",
    "priceImpact": 123,
    "slippageBps": 123,
    "routePlan": [\
      {\
        "programId": "<string>",\
        "dex": "<string>",\
        "pool": "<string>",\
        "inputMint": "<string>",\
        "outputMint": "<string>",\
        "amountIn": "<string>",\
        "amountOut": "<string>",\
        "feeAmount": "<string>",\
        "priceImpact": 123,\
        "percent": 123\
      }\
    ],
    "contextSlot": 123,
    "timeTaken": 123,
    "swapUsdValue": "<string>",
    "priorityFee": {
      "recommended": 123,
      "level": "<string>",
      "levels": {
        "min": 123,
        "low": 123,
        "medium": 123,
        "high": 123,
        "veryHigh": 123,
        "unsafeMax": 123
      }
    },
    "platformFee": {
      "feeBps": 123,
      "feeAccount": "<string>"
    }
  },
  "swapTransaction": "<string>",
  "lastValidBlockHeight": 123
}
```

POST

/

quote-and-swap

Try it

Quote and swap in one request

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/quote-and-swap \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "userPublicKey": "<string>",\n  "inputMint": "<string>",\n  "outputMint": "<string>",\n  "amount": 123,\n  "slippageBps": "<string>",\n  "dexes": "<string>",\n  "maxHops": 123,\n  "wrapUnwrapSol": true,\n  "txVersion": "v0",\n  "priorityFee": "<string>",\n  "feeAccount": "<string>",\n  "feeBps": 123,\n  "feeFromInput": false\n}\n'
```

200

Copy

```
{
  "quote": {
    "inputMint": "<string>",
    "outputMint": "<string>",
    "amountIn": "<string>",
    "amountOut": "<string>",
    "minAmountOut": "<string>",
    "feeAmount": "<string>",
    "priceImpact": 123,
    "slippageBps": 123,
    "routePlan": [\
      {\
        "programId": "<string>",\
        "dex": "<string>",\
        "pool": "<string>",\
        "inputMint": "<string>",\
        "outputMint": "<string>",\
        "amountIn": "<string>",\
        "amountOut": "<string>",\
        "feeAmount": "<string>",\
        "priceImpact": 123,\
        "percent": 123\
      }\
    ],
    "contextSlot": 123,
    "timeTaken": 123,
    "swapUsdValue": "<string>",
    "priorityFee": {
      "recommended": 123,
      "level": "<string>",
      "levels": {
        "min": 123,
        "low": 123,
        "medium": 123,
        "high": 123,
        "veryHigh": 123,
        "unsafeMax": 123
      }
    },
    "platformFee": {
      "feeBps": 123,
      "feeAccount": "<string>"
    }
  },
  "swapTransaction": "<string>",
  "lastValidBlockHeight": 123
}
```

#### Body

application/json

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-user-public-key)

userPublicKey

string

required

User's wallet public key

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-input-mint)

inputMint

string

required

Input token mint

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-output-mint)

outputMint

string

required

Output token mint

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-amount)

amount

integer

required

Input amount in lamports

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-slippage-bps)

slippageBps

string

Slippage in basis points or 'dynamic'

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-dexes)

dexes

string

Comma-separated DEX filter

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-max-hops)

maxHops

integer

Maximum routing hops

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-wrap-unwrap-sol)

wrapUnwrapSol

boolean

default:true

Automatically wrap/unwrap SOL

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-tx-version)

txVersion

enum<string>

default:v0

Transaction version

Available options:

`legacy`,

`v0`

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-priority-fee)

priorityFee

string

Priority fee mode or microlamports

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-fee-account)

feeAccount

string

Platform fee recipient

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-fee-bps)

feeBps

integer

Platform fee in basis points

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#body-fee-from-input)

feeFromInput

boolean

default:false

Take fee from input

#### Response

200 - application/json

Successful quote and transaction build

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#response-quote)

quote

object

required

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#response-swap-transaction)

swapTransaction

string

required

Base64-encoded transaction

[​](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request#response-last-valid-block-height)

lastValidBlockHeight

integer

Block height until transaction is valid

Was this page helpful?

YesNo

[Build swap instructions\
\
Previous](https://docs.solanatracker.io/raptor/http/build-swap-instructions) [Send transaction via Yellowstone Jet TPU\
\
Next](https://docs.solanatracker.io/raptor/http/send-transaction-via-yellowstone-jet-tpu)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
