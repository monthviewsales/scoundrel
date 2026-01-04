[Skip to main content](https://docs.solanatracker.io/raptor/websocket/websockets/stream#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

Websockets

/stream

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

  - [WSS\
    \
    /stream](https://docs.solanatracker.io/raptor/websocket/websockets/stream)

##### Resources

- [Transactions](https://docs.solanatracker.io/raptor/transactions)

Messages

Subscribe to Quote Updates

```
{
  "type": "subscribe",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": 100000000,
  "slippageBps": "50"
}
```

Unsubscribe from Quote Updates

```
{
  "type": "unsubscribe",
  "id": "sub_1767187968856399"
}
```

Ping

```
{
  "type": "ping"
}
```

Quote Update

```
{
  "type": "quote",
  "id": "sub_1767187968856399",
  "timestamp": 1767188116413,
  "data": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amountIn": "100000000",
    "amountOut": "12589134",
    "minAmountOut": "12526188",
    "slippageBps": 50,
    "priceImpact": 0.00000763905067919488,
    "feeAmount": "40000",
    "swapUsdValue": "12.59",
    "contextSlot": 390395145,
    "timeTaken": 0.000677147,
    "routePlan": [\
      {\
        "inputMint": "So11111111111111111111111111111111111111112",\
        "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",\
        "amountIn": "100000000",\
        "amountOut": "12589134",\
        "feeAmount": "40000",\
        "priceImpact": 0.00000763905067919488,\
        "percent": 100,\
        "pool": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",\
        "dex": "Whirlpool",\
        "programId": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"\
      }\
    ]
  }
}
```

Subscription Confirmation

```
{
  "type": "subscribed",
  "id": "sub_1767187968856399"
}
```

Unsubscription Confirmation

```
{
  "type": "unsubscribed",
  "id": "sub_1767187968856399",
  "success": true
}
```

Pong Response

```
{
  "type": "pong",
  "timestamp": 1767188116413
}
```

Error Response

```
{
  "type": "error",
  "error": "Invalid inputMint"
}
```

WSS

wss://raptor-beta.solanatracker.io

/

stream

Connect

Messages

Subscribe to Quote Updates

```
{
  "type": "subscribe",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": 100000000,
  "slippageBps": "50"
}
```

Unsubscribe from Quote Updates

```
{
  "type": "unsubscribe",
  "id": "sub_1767187968856399"
}
```

Ping

```
{
  "type": "ping"
}
```

Quote Update

```
{
  "type": "quote",
  "id": "sub_1767187968856399",
  "timestamp": 1767188116413,
  "data": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amountIn": "100000000",
    "amountOut": "12589134",
    "minAmountOut": "12526188",
    "slippageBps": 50,
    "priceImpact": 0.00000763905067919488,
    "feeAmount": "40000",
    "swapUsdValue": "12.59",
    "contextSlot": 390395145,
    "timeTaken": 0.000677147,
    "routePlan": [\
      {\
        "inputMint": "So11111111111111111111111111111111111111112",\
        "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",\
        "amountIn": "100000000",\
        "amountOut": "12589134",\
        "feeAmount": "40000",\
        "priceImpact": 0.00000763905067919488,\
        "percent": 100,\
        "pool": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",\
        "dex": "Whirlpool",\
        "programId": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"\
      }\
    ]
  }
}
```

Subscription Confirmation

```
{
  "type": "subscribed",
  "id": "sub_1767187968856399"
}
```

Unsubscription Confirmation

```
{
  "type": "unsubscribed",
  "id": "sub_1767187968856399",
  "success": true
}
```

Pong Response

```
{
  "type": "pong",
  "timestamp": 1767188116413
}
```

Error Response

```
{
  "type": "error",
  "error": "Invalid inputMint"
}
```

Send

Subscribe to Quote Updates

type:object

show 8 properties

Subscribe to real-time quote updates for a token pair

Unsubscribe from Quote Updates

type:object

show 2 properties

Unsubscribe from a specific quote subscription

Ping

type:object

show 1 property

Send a ping to keep the connection alive

Receive

Quote Update

type:object

show 4 properties

Real-time quote update for a subscribed token pair

Subscription Confirmation

type:object

show 2 properties

Confirmation that a subscription was successfully created

Unsubscription Confirmation

type:object

show 3 properties

Confirmation that a subscription was removed

Pong Response

type:object

show 2 properties

Response to a ping message

Error Response

type:object

show 4 properties

Error message from the server

Was this page helpful?

YesNo

[Get transaction status\
\
Previous](https://docs.solanatracker.io/raptor/http/get-transaction-status) [Transactions\
\
Next](https://docs.solanatracker.io/raptor/transactions)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
