[Skip to main content](https://docs.solanatracker.io/raptor/overview#content-area)

[Solana Tracker home page![light logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/light.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=13a31281caa924bed5d18163f04b77df)![dark logo](https://mintcdn.com/solanatracker/etMhdoCkQA74VFGN/logo/dark.png?fit=max&auto=format&n=etMhdoCkQA74VFGN&q=85&s=28068b1bba9d77dd689c30e7c006245a)](https://docs.solanatracker.io/)

[Getting Started](https://docs.solanatracker.io/) [Data API](https://docs.solanatracker.io/data-api/search/token-search) [Datastream](https://docs.solanatracker.io/datastream/websockets/latesttokens) [Raptor Swap API](https://docs.solanatracker.io/raptor/overview) [Solana RPC](https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe) [Yellowstone gRPC](https://docs.solanatracker.io/yellowstone-grpc)

Search...

Navigation

Getting Started

Overview

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

- [Endpoints](https://docs.solanatracker.io/raptor/overview#endpoints)
- [Swap](https://docs.solanatracker.io/raptor/overview#swap)
- [Analytics](https://docs.solanatracker.io/raptor/overview#analytics)
- [WebSocket](https://docs.solanatracker.io/raptor/overview#websocket)
- [Supported DEXs](https://docs.solanatracker.io/raptor/overview#supported-dexs)
- [Raydium](https://docs.solanatracker.io/raptor/overview#raydium)
- [Meteora](https://docs.solanatracker.io/raptor/overview#meteora)
- [Orca](https://docs.solanatracker.io/raptor/overview#orca)
- [Bonding Curves](https://docs.solanatracker.io/raptor/overview#bonding-curves)
- [PropAMM](https://docs.solanatracker.io/raptor/overview#propamm)
- [Other](https://docs.solanatracker.io/raptor/overview#other)
- [Routing](https://docs.solanatracker.io/raptor/overview#routing)
- [Multi-Hop](https://docs.solanatracker.io/raptor/overview#multi-hop)
- [Slippage](https://docs.solanatracker.io/raptor/overview#slippage)
- [Platform Fees](https://docs.solanatracker.io/raptor/overview#platform-fees)
- [Priority Fees](https://docs.solanatracker.io/raptor/overview#priority-fees)
- [Dynamic Calculation](https://docs.solanatracker.io/raptor/overview#dynamic-calculation)
- [Priority Levels](https://docs.solanatracker.io/raptor/overview#priority-levels)
- [Transaction Management](https://docs.solanatracker.io/raptor/overview#transaction-management)
- [Yellowstone Jet TPU](https://docs.solanatracker.io/raptor/overview#yellowstone-jet-tpu)
- [Tracking](https://docs.solanatracker.io/raptor/overview#tracking)
- [Rate Limiting](https://docs.solanatracker.io/raptor/overview#rate-limiting)
- [CLI Flags](https://docs.solanatracker.io/raptor/overview#cli-flags)
- [Help & Version](https://docs.solanatracker.io/raptor/overview#help-%26-version)
- [Pool Indexer](https://docs.solanatracker.io/raptor/overview#pool-indexer)
- [DEX Filtering](https://docs.solanatracker.io/raptor/overview#dex-filtering)
- [Performance](https://docs.solanatracker.io/raptor/overview#performance)
- [Feature Toggles](https://docs.solanatracker.io/raptor/overview#feature-toggles)
- [Yellowstone Jet TPU](https://docs.solanatracker.io/raptor/overview#yellowstone-jet-tpu-2)
- [Environment Variables](https://docs.solanatracker.io/raptor/overview#environment-variables)
- [CLI Flag Equivalents](https://docs.solanatracker.io/raptor/overview#cli-flag-equivalents)
- [Additional Variables](https://docs.solanatracker.io/raptor/overview#additional-variables)

**Private Beta** — Join [Discord](https://discord.gg/Gfnwee4T6S) to request access.

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#endpoints)  Endpoints

### [​](https://docs.solanatracker.io/raptor/overview\#swap)  Swap

| Endpoint | Description |
| --- | --- |
| `GET /quote` | Get swap quotes with multi-hop routing, dynamic slippage, DEX filtering, pool filtering, and platform fee support |
| `POST /swap` | Build complete swap transactions with priority fee calculation and compute budget optimization |
| `POST /swap-instructions` | Build swap instructions only (without transaction wrapper) |
| `POST /quote-and-swap` | Combined quote and swap in single request (optional feature) |
| `POST /send-transaction` | Send transactions via Yellowstone Jet TPU with automatic resending and confirmation tracking |
| `GET /transaction/:signature` | Track sent transaction status, latency, and parsed events |

### [​](https://docs.solanatracker.io/raptor/overview\#analytics)  Analytics

| Endpoint | Description |
| --- | --- |
| `GET /health` | Health check with detailed status (pools, cache, Yellowstone connection) |

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#websocket)  WebSocket

| Feature | Details |
| --- | --- |
| `/stream` | Real-time quote streaming with subscription management |
| Slot-based updates | Automatic quote recalculation on pool state changes |

* * *

Program ID - Mainnet: RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87

## [​](https://docs.solanatracker.io/raptor/overview\#supported-dexs)  Supported DEXs

### [​](https://docs.solanatracker.io/raptor/overview\#raydium)  Raydium

- Raydium AMM
- Raydium CLMM
- Raydium CPMM
- Raydium LaunchLab/Launchpad

### [​](https://docs.solanatracker.io/raptor/overview\#meteora)  Meteora

- Meteora DLMM
- Meteora Dynamic AMM
- Meteora DAMM (Dynamic AMM V2)
- Meteora Curve
- Meteora DBC (Dynamic Bonding Curve)

### [​](https://docs.solanatracker.io/raptor/overview\#orca)  Orca

- Whirlpool (legacy)
- Whirlpool V2

### [​](https://docs.solanatracker.io/raptor/overview\#bonding-curves)  Bonding Curves

- Pump.fun
- Pumpswap
- Heaven (Buy/Sell)
- MoonIt (Buy/Sell)
- Boopfun (Buy/Sell)

### [​](https://docs.solanatracker.io/raptor/overview\#propamm)  PropAMM

- Humidifi
- Tessera
- Solfi V1/V2

### [​](https://docs.solanatracker.io/raptor/overview\#other)  Other

- FluxBeam
- PancakeSwap V3

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#routing)  Routing

### [​](https://docs.solanatracker.io/raptor/overview\#multi-hop)  Multi-Hop

- Up to 4-hop routes for optimal pricing
- Route-aware slippage calculation (accounts for multi-hop risk)
- DEX-specific routing preferences
- Pool filtering by address lists
- Circular arbitrage option

### [​](https://docs.solanatracker.io/raptor/overview\#slippage)  Slippage

- Dynamic slippage based on volatility and route complexity
- Route-aware multi-hop slippage adjustment
- Manual slippage override (numeric or "dynamic")
- Minimum output amount calculation with slippage protection

### [​](https://docs.solanatracker.io/raptor/overview\#platform-fees)  Platform Fees

- Fee taken from input OR output tokens
- Configurable fee basis points (up to 10%)
- Fee wallet specification
- Extra charge on positive slippage
- Automatic fee adjustment in quotes and swaps

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#priority-fees)  Priority Fees

### [​](https://docs.solanatracker.io/raptor/overview\#dynamic-calculation)  Dynamic Calculation

- Route-specific priority fee calculation
- DEX-specific fee adjustments
- Recent fee data tracking (slots tracked, total fees)
- Maximum fee caps and overrides

### [​](https://docs.solanatracker.io/raptor/overview\#priority-levels)  Priority Levels

| Level | Use Case |
| --- | --- |
| `Min` / `Low` | Cost-saving |
| `Auto` / `Medium` | Recommended default |
| `High` / `VeryHigh` | Speed priority |
| `Turbo` / `UnsafeMax` | Maximum speed |

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#transaction-management)  Transaction Management

### [​](https://docs.solanatracker.io/raptor/overview\#yellowstone-jet-tpu)  Yellowstone Jet TPU

- Transaction sending
- Automatic resending with slot alignment
- Multiple identity support (4 default, configurable)

### [​](https://docs.solanatracker.io/raptor/overview\#tracking)  Tracking

- Real-time status monitoring (`pending` / `confirmed` / `failed` / `expired`)
- Latency measurement (send to confirm)
- Parsed Raptor program events
- Raw transaction storage
- Automatic cleanup

### [​](https://docs.solanatracker.io/raptor/overview\#rate-limiting)  Rate Limiting

- Configurable RPS (uses almost no RPC calls generally)

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#cli-flags)  CLI Flags

### [​](https://docs.solanatracker.io/raptor/overview\#help-&-version)  Help & Version

Copy

```
-h, --help       Show help message
-v, --version    Show version information
```

### [​](https://docs.solanatracker.io/raptor/overview\#pool-indexer)  Pool Indexer

Copy

```
--no-pool-indexer          Disable pool indexer client (Yellowstone only)
```

### [​](https://docs.solanatracker.io/raptor/overview\#dex-filtering)  DEX Filtering

Copy

```
--include-dexes <DEXES>    Only include these DEXes (comma-separated)
--exclude-dexes <DEXES>    Exclude these DEXes (comma-separated)
```

### [​](https://docs.solanatracker.io/raptor/overview\#performance)  Performance

Copy

```
--workers <N>              Number of worker threads (default: CPU cores)
```

### [​](https://docs.solanatracker.io/raptor/overview\#feature-toggles)  Feature Toggles

Copy

```
--enable-arbitrage         Enable circular arbitrage (same input/output mint)
-s, --enable-quote-and-swap    Enable the /quote-and-swap endpoint
--rpc-rate-limit <N>       Limit RPC calls to N per second (default: unlimited)
--enable-yellowstone-jet   Enable Yellowstone Jet TPU sender for /send-transaction
--enable-websocket         Enable WebSocket streaming quotes at /stream
```

### [​](https://docs.solanatracker.io/raptor/overview\#yellowstone-jet-tpu-2)  Yellowstone Jet TPU

Copy

```
--jet-identity <PATH>      Path to identity keypair for Jet TPU (optional)
--jet-identities <N>       Number of random identities for Jet (default: 4)
```

* * *

## [​](https://docs.solanatracker.io/raptor/overview\#environment-variables)  Environment Variables

### [​](https://docs.solanatracker.io/raptor/overview\#cli-flag-equivalents)  CLI Flag Equivalents

| Variable | Flag |
| --- | --- |
| `NO_POOL_INDEXER` | `--no-pool-indexer` |
| `INCLUDE_DEXES` | `--include-dexes` |
| `EXCLUDE_DEXES` | `--exclude-dexes` |
| `WORKER_THREADS` | `--workers` |
| `ENABLE_ARBITRAGE` | `--enable-arbitrage` |
| `ENABLE_QUOTE_AND_SWAP` | `--enable-quote-and-swap` |
| `RPC_RATE_LIMIT` | `--rpc-rate-limit` |
| `ENABLE_YELLOWSTONE_JET` | `--enable-yellowstone-jet` |
| `JET_IDENTITY` | `--jet-identity` |
| `JET_NUM_IDENTITIES` | `--jet-identities` |
| `ENABLE_WEBSOCKET` | `--enable-websocket` |

### [​](https://docs.solanatracker.io/raptor/overview\#additional-variables)  Additional Variables

| Variable | Description |
| --- | --- |
| `RPC_URL` | Solana RPC endpoint |
| `YELLOWSTONE_ENDPOINT` | Yellowstone gRPC endpoint |
| `YELLOWSTONE_TOKEN` | Yellowstone auth token (optional) |
| `BIND_ADDR` | Server bind address (default: `0.0.0.0:8080`) |

Was this page helpful?

YesNo

[Get swap quote\
\
Next](https://docs.solanatracker.io/raptor/http/get-swap-quote)

Ctrl+I

Sources

⌘K

Assistant

Responses are generated using AI and may contain mistakes.
