[Skip to main content](https://docs.solanatracker.io/raptor/http/build-swap-instructions#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

API Reference

Build swap instructions

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

Build swap instructions

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/swap-instructions \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "userPublicKey": "<string>",\n  "quoteResponse": {\n    "inputMint": "<string>",\n    "outputMint": "<string>",\n    "amountIn": "<string>",\n    "amountOut": "<string>",\n    "minAmountOut": "<string>",\n    "feeAmount": "<string>",\n    "priceImpact": 123,\n    "slippageBps": 123,\n    "routePlan": [\\n      {\\n        "programId": "<string>",\\n        "dex": "<string>",\\n        "pool": "<string>",\\n        "inputMint": "<string>",\\n        "outputMint": "<string>",\\n        "amountIn": "<string>",\\n        "amountOut": "<string>",\\n        "feeAmount": "<string>",\\n        "priceImpact": 123,\\n        "percent": 123\\n      }\\n    ],\n    "contextSlot": 123,\n    "timeTaken": 123,\n    "swapUsdValue": "<string>",\n    "priorityFee": {\n      "recommended": 123,\n      "level": "<string>",\n      "levels": {\n        "min": 123,\n        "low": 123,\n        "medium": 123,\n        "high": 123,\n        "veryHigh": 123,\n        "unsafeMax": 123\n      }\n    },\n    "platformFee": {\n      "feeBps": 123,\n      "feeAccount": "<string>"\n    }\n  },\n  "wrapUnwrapSol": true,\n  "txVersion": "v0",\n  "computeUnitPriceMicroLamports": 123,\n  "computeUnitLimit": 123,\n  "priorityFee": "<string>",\n  "maxPriorityFee": 123,\n  "tipAccount": "<string>",\n  "tipLamports": 123,\n  "feeAccount": "<string>",\n  "feeBps": 123,\n  "feeFromInput": false,\n  "chargeBps": 123\n}\n'
```

200

Copy

```
{
  "tokenLedgerInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "computeBudgetInstructions": [\
    {\
      "programId": "<string>",\
      "accounts": [\
        {\
          "pubkey": "<string>",\
          "isSigner": true,\
          "isWritable": true\
        }\
      ],\
      "data": "<string>"\
    }\
  ],
  "setupInstructions": [\
    {\
      "programId": "<string>",\
      "accounts": [\
        {\
          "pubkey": "<string>",\
          "isSigner": true,\
          "isWritable": true\
        }\
      ],\
      "data": "<string>"\
    }\
  ],
  "swapInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "cleanupInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "addressLookupTableAddresses": [\
    "<string>"\
  ]
}
```

POST

/

swap-instructions

Try it

Build swap instructions

cURL

Copy

```
curl --request POST \
  --url https://raptor-beta.solanatracker.io/swap-instructions \
  --header 'Content-Type: application/json' \
  --data '\n{\n  "userPublicKey": "<string>",\n  "quoteResponse": {\n    "inputMint": "<string>",\n    "outputMint": "<string>",\n    "amountIn": "<string>",\n    "amountOut": "<string>",\n    "minAmountOut": "<string>",\n    "feeAmount": "<string>",\n    "priceImpact": 123,\n    "slippageBps": 123,\n    "routePlan": [\\n      {\\n        "programId": "<string>",\\n        "dex": "<string>",\\n        "pool": "<string>",\\n        "inputMint": "<string>",\\n        "outputMint": "<string>",\\n        "amountIn": "<string>",\\n        "amountOut": "<string>",\\n        "feeAmount": "<string>",\\n        "priceImpact": 123,\\n        "percent": 123\\n      }\\n    ],\n    "contextSlot": 123,\n    "timeTaken": 123,\n    "swapUsdValue": "<string>",\n    "priorityFee": {\n      "recommended": 123,\n      "level": "<string>",\n      "levels": {\n        "min": 123,\n        "low": 123,\n        "medium": 123,\n        "high": 123,\n        "veryHigh": 123,\n        "unsafeMax": 123\n      }\n    },\n    "platformFee": {\n      "feeBps": 123,\n      "feeAccount": "<string>"\n    }\n  },\n  "wrapUnwrapSol": true,\n  "txVersion": "v0",\n  "computeUnitPriceMicroLamports": 123,\n  "computeUnitLimit": 123,\n  "priorityFee": "<string>",\n  "maxPriorityFee": 123,\n  "tipAccount": "<string>",\n  "tipLamports": 123,\n  "feeAccount": "<string>",\n  "feeBps": 123,\n  "feeFromInput": false,\n  "chargeBps": 123\n}\n'
```

200

Copy

```
{
  "tokenLedgerInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "computeBudgetInstructions": [\
    {\
      "programId": "<string>",\
      "accounts": [\
        {\
          "pubkey": "<string>",\
          "isSigner": true,\
          "isWritable": true\
        }\
      ],\
      "data": "<string>"\
    }\
  ],
  "setupInstructions": [\
    {\
      "programId": "<string>",\
      "accounts": [\
        {\
          "pubkey": "<string>",\
          "isSigner": true,\
          "isWritable": true\
        }\
      ],\
      "data": "<string>"\
    }\
  ],
  "swapInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "cleanupInstruction": {
    "programId": "<string>",
    "accounts": [\
      {\
        "pubkey": "<string>",\
        "isSigner": true,\
        "isWritable": true\
      }\
    ],
    "data": "<string>"
  },
  "addressLookupTableAddresses": [\
    "<string>"\
  ]
}
```

#### Body

application/json

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-user-public-key)

userPublicKey

string

required

User's wallet public key

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-quote-response)

quoteResponse

object

required

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-wrap-unwrap-sol)

wrapUnwrapSol

boolean

default:true

Automatically wrap/unwrap SOL

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-tx-version)

txVersion

enum<string>

default:v0

Transaction version

Available options:

`legacy`,

`v0`

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-compute-unit-price-micro-lamports)

computeUnitPriceMicroLamports

integer

Priority fee in microlamports

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-compute-unit-limit)

computeUnitLimit

integer

Compute unit limit

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-priority-fee)

priorityFee

string

Priority fee mode or microlamports

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-max-priority-fee)

maxPriorityFee

integer

Maximum priority fee cap

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-tip-account)

tipAccount

string

Tip account pubkey

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-tip-lamports)

tipLamports

integer

Tip amount in lamports

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-fee-account)

feeAccount

string

Platform fee recipient

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-fee-bps)

feeBps

integer

Platform fee in basis points

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-fee-from-input)

feeFromInput

boolean

default:false

Take fee from input

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#body-charge-bps)

chargeBps

integer

Extra charge on positive slippage

#### Response

200 - application/json

Successful instruction build

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-token-ledger-instruction)

tokenLedgerInstruction

object

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-compute-budget-instructions)

computeBudgetInstructions

object[]

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-setup-instructions)

setupInstructions

object[]

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-swap-instruction)

swapInstruction

object

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-cleanup-instruction)

cleanupInstruction

object

Showchild attributes

[​](https://docs.solanatracker.io/raptor/http/build-swap-instructions#response-address-lookup-table-addresses)

addressLookupTableAddresses

string[]

Was this page helpful?

YesNo

[Build swap transaction\
\
Previous](https://docs.solanatracker.io/raptor/http/build-swap-transaction) [Quote and swap in one request\
\
Next](https://docs.solanatracker.io/raptor/http/quote-and-swap-in-one-request)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
