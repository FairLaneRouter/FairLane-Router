# @fairlanerouter/sdk

Which Solana delivery channel lands your transaction cheapest right now, and at
what bid — advice priced from what actually landed on mainnet in the last hour.

The SDK is a thin, typed client for the [FairLane Router](https://github.com/FairLaneRouter/FairLane-Router)
API. It gives **advice only**: it never builds, signs or sends a transaction,
and it depends on no Solana library, so it does not pin one on you.

## Install

```bash
npm install @fairlanerouter/sdk
```

Node 20.3 or later (or any runtime with global `fetch` and `AbortSignal.any`).
ESM only. The single runtime dependency is `zod`.

## Quick start

```ts
import { advise } from '@fairlanerouter/sdk'

const advice = await advise({
  programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  computeUnits: 200_000,
  mode: 'cheap',
})

// {
//   groupId: 'jito',
//   targetSlots: 4,
//   tipLamports: 3236,
//   priorityFeeMicroLamports: 0,
//   expectedCost: 8236,
//   landProbability: null,
//   dataAgeMs: 33760,
//   isStale: false,
//   note: null
// }
```

You then build the transaction yourself: set the compute unit price to
`priorityFeeMicroLamports`, add a tip of `tipLamports` to the service's tip
account, and send it through the recommended group.

## The intent

An intent describes a transaction before it exists. There is no signature, no
payer and no instruction data: advice is priced from recent landings, not from
your transaction.

| Field | Type | Meaning |
|---|---|---|
| `programId` | `string` | Base58 address (32 bytes) of the main program the transaction calls. |
| `computeUnits` | `number` | Integer, `1` … `1_400_000` (`MAX_COMPUTE_UNITS`). |
| `mode` | `'cheap' \| 'fast'` | The bid level: `cheap` bids what the median recent lander paid, `fast` outbids nine landers in ten. |
| `targetSlots` | `number`, optional | Integer, `1` … `150` (`MAX_TARGET_SLOTS`). Default `4` (`DEFAULT_TARGET_SLOTS`) — one leader turn. |

The intent is checked locally with the server's own schema. A malformed one
throws `FairLaneError` with `code: 'INVALID_INPUT'` and the offending `field`
**before any request is made**. Unknown fields are refused rather than dropped,
so a misspelt `targetSlot` cannot silently give you advice about the default
window.

## The advice

| Field | Meaning |
|---|---|
| `groupId` | The channel group to send through: `jito`, `nozomi`, `bloxroute` or `rpc`. |
| `targetSlots` | Echo of the window the advice is for. |
| `tipLamports` | Tip to the service, in lamports. Never below what the service accepts. |
| `priorityFeeMicroLamports` | Compute unit price, in micro-lamports per compute unit. |
| `expectedCost` | Full landing cost in lamports: base fee, priority fee and tip together. |
| `landProbability` | Share expected to land within `targetSlots`, or `null` when there is no basis to estimate it. |
| `dataAgeMs` | Age of the data behind the advice. `null` only in a stale fallback. |
| `isStale` | `true` when the advice is built on data older than the freshness threshold. |
| `note` | `null`, or why the advice is not the cheapest group on the dashboard. |

**Why a group, not a service.** Services that share on-chain accounts cannot be
told apart on-chain, so FairLane compares groups of channels and never guesses
a brand inside a group.

**`landProbability` is `null` for now.** Passive collection sees what landed,
not when it was sent, so it cannot measure how many transactions land within a
window. That comes from FairLane's own paired sends in a later release. Until
then the field is `null` even in fresh advice, rather than a number that only
looks like a probability.

**Stale advice is still advice.** When the collector falls behind, the API
answers `200` with the cheapest sendable group on the data it has, marks it
`isStale: true` and gives its real `dataAgeMs`. Decide for yourself whether to
use it. Only when no sendable group has any recent landings at all does the
call fail, with `STALE_DATA`.

```ts
if (advice.isStale) {
  console.warn(`advice is ${Math.round((advice.dataAgeMs ?? 0) / 1000)} s old`)
}
```

**`note` explains a cheaper group you were not sent to.** FairLane observes more
channels than it can send through. When an observed-only group is cheaper than
the recommended one, the advice says so instead of hiding it:

```ts
if (advice.note?.code === 'CHEAPER_GROUP_NOT_SENDABLE') {
  // advice.note.groupId — the cheaper group; advice.note.message — why it was not chosen
}
```

`NOTE_CODES` lists every note code. Branch on `code`; `message` is for people.

## Options

```ts
await advise(intent, {
  apiKey: process.env.FAIRLANE_API_KEY,
  baseUrl: 'https://fairlane-api.onrender.com',
  timeoutMs: 10_000,
  signal: controller.signal,
  fetch: customFetch,
})
```

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | none | Access key; see [Access keys and limits](#access-keys-and-limits). |
| `baseUrl` | `DEFAULT_BASE_URL` — the public API | Point at your own deployment. A path prefix is kept, a trailing slash is not. |
| `timeoutMs` | `DEFAULT_TIMEOUT_MS` — `10_000` | Advice that arrives later describes a market that has already moved. |
| `signal` | none | Aborting rejects with the signal's own `reason`, not with a `FairLaneError`. |
| `fetch` | global `fetch` | For tests, proxies or runtimes without a global one. |

Fields the server adds later are dropped, never fatal, so an installed SDK keeps
working as the API grows. An answer that breaks the contract is refused with
`UNEXPECTED_RESPONSE` rather than handed on as advice.

## Access keys and limits

`POST /v1/recommend` works without a key, at a stricter limit. A key needs no
account and no personal data — issue one with a single request:

```bash
curl -X POST https://fairlane-api.onrender.com/v1/keys \
  -H 'content-type: application/json' -d '{"label":"my-bot"}'
# {"id":"…","key":"flr_…","createdAt":"…","label":"my-bot"}
```

`label` is optional. **The key is shown once**; the server keeps only its hash.
Store it in an environment variable and pass it as `apiKey`.

| | Limit |
|---|---|
| With a key | 120 requests per minute, per key |
| Without a key | 10 requests per minute, per source address |

Both are token buckets that refill continuously over a minute. Over the limit,
the call throws `RATE_LIMITED` with `retryAfterMs`.

A key is `flr_` followed by 64 hex characters. The SDK refuses anything else
locally with `INVALID_INPUT` and `field: 'apiKey'` — including an empty string
from an unset variable. The server would otherwise treat a malformed key as no
key and quietly serve you at the keyless limit.

To revoke a key, send it to its own id. Usage counters are kept:

```bash
curl -X DELETE https://fairlane-api.onrender.com/v1/keys/<id> \
  -H "authorization: Bearer $FAIRLANE_API_KEY"
```

## Errors

Every failure is a `FairLaneError`. Branch on `code`:

```ts
import { advise, FairLaneError } from '@fairlanerouter/sdk'

try {
  return await advise(intent, { apiKey })
} catch (error) {
  if (!(error instanceof FairLaneError)) throw error

  switch (error.code) {
    case 'RATE_LIMITED':
      await sleep(error.retryAfterMs ?? 1_000)
      return advise(intent, { apiKey })
    case 'INVALID_INPUT':
      throw new Error(`bad ${error.field}: ${error.message}`)
    default:
      return fallbackBid()
  }
}
```

| `code` | `status` | When |
|---|---|---|
| `INVALID_INPUT` | `400` or `null` | The intent or `apiKey` is malformed; `field` names it. `null` — refused locally, no request made. |
| `UNAUTHENTICATED` | `401` | The key is well-formed but unknown or revoked. |
| `RATE_LIMITED` | `429` | Over the limit; wait `retryAfterMs`. |
| `STALE_DATA` | `503` | No sendable group has recent landings to price advice from. |
| `NOT_FOUND` | `404` | Wrong `baseUrl` or path prefix. |
| `INTERNAL` | `500` | Server-side failure. |
| `NETWORK` | `null` | The API could not be reached. |
| `TIMEOUT` | `null` | No complete answer within `timeoutMs`. |
| `UNEXPECTED_RESPONSE` | status or `null` | The answer is not the API's — a proxy's error page, or a body that breaks the contract. |

The `code` type is open: a code the server adds later passes through as is.
`KNOWN_ERROR_CODES` lists the ones this version knows. `error.cause` keeps the
underlying failure where there is one.

## Cold start of the public API

The public API runs on a free plan and sleeps after 15 minutes without
traffic. The first request after a quiet spell can take about a minute — longer
than the default `timeoutMs`, so it fails with `TIMEOUT`. If your calls are
sparse, either give the first one a longer timeout or wake the API first:

```ts
await fetch('https://fairlane-api.onrender.com/health', { signal: AbortSignal.timeout(90_000) })
```

## What this SDK does not do

- It does not sign or send transactions, and holds no keys but your API key.
  Sending through the recommended channel is planned as a separate mode.
- It gives no guarantee of landing. Advice is an estimate from recent landings,
  not an SLA.
- It does not protect against MEV. Only the price of delivery is measured.

How the numbers are computed — the per-slot reference, excluded vote
transactions, channel groups — is in the *Method* view of the dashboard:
<https://fairlanerouter.github.io/FairLane-Router/>.

## License

MIT
