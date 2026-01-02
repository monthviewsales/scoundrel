[Skip to main content](https://docs.solanatracker.io/raptor/http/get-swap-quote#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

API Reference

Get swap quote

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

Get swap quote

cURL

Copy

```
curl --request GET \
  --url 'https://raptor-beta.solanatracker.io/quote?slippageBps=50&maxHops=4'
```

200

400

503

Copy

```
{
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
}
```

GET

/

quote

Try it

Get swap quote

cURL

Copy

```
curl --request GET \
  --url 'https://raptor-beta.solanatracker.io/quote?slippageBps=50&maxHops=4'
```

200

400

503

Copy

```
{
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
}
```

#### Query Parameters

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-input-mint)

inputMint

string

required

Input token mint address

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-output-mint)

outputMint

string

required

Output token mint address

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-amount)

amount

integer

required

Input amount in lamports

Required range: `x >= 1`

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-slippage-bps)

slippageBps

string

default:50

Slippage in basis points or 'dynamic'

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-dexes)

dexes

string

Comma-separated list of DEXes to include

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-pools)

pools

string

Comma-separated list of specific pool addresses

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-max-hops)

maxHops

integer

default:4

Maximum routing hops

Required range: `1 <= x <= 4`

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-fee-bps)

feeBps

integer

default:0

Platform fee in basis points

Required range: `0 <= x <= 1000`

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-fee-from-input)

feeFromInput

boolean

default:false

Take fee from input amount

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-charge-bps)

chargeBps

integer

default:0

Extra charge on positive slippage

Required range: `x >= 0`

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#parameter-fee-account)

feeAccount

string

Fee recipient wallet address

#### Response

200

application/json

Successful quote response

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-input-mint)

inputMint

string

required

Input token mint address

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-output-mint)

outputMint

string

required

Output token mint address

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-amount-in)

amountIn

string

required

Input amount in lamports

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-amount-out)

amountOut

string

required

Expected output amount in lamports

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-min-amount-out)

minAmountOut

string

required

Minimum output amount after slippage

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-fee-amount)

feeAmount

string

required

Total fees paid in lamports

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-price-impact)

priceImpact

number

required

Price impact percentage

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-slippage-bps)

slippageBps

integer

required

Slippage used in basis points

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-route-plan)

routePlan

object[]

required

Array of routing steps

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-context-slot)

contextSlot

integer

required

Solana slot when quote was generated

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-time-taken)

timeTaken

number

required

Time taken to generate quote in seconds

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-swap-usd-value)

swapUsdValue

string

USD value of the input amount

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-priority-fee)

priorityFee

object

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/get-swap-quote#response-platform-fee)

platformFee

object

Showchild attributes

Was this page helpful?

YesNo

[Overview\
\
Previous](https://docs.solanatracker.io/raptor/overview) [Build swap transaction\
\
Next](https://docs.solanatracker.io/raptor/http/build-swap-transaction)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
