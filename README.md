# FairLane Router

What it really costs to land a transaction on Solana through each delivery
service — Jito, Nozomi, bloXroute, plain RPC — measured on-chain, normalised
against the same slot, and put side by side on a public dashboard.

**Status: M1 — transparency core.** The indexer, the API and the *Board* view
run on live mainnet data. The *Side by side*, *Who pays the rent* and *Method*
views still show synthetic data and are labelled as such on screen.
Recommendations, the SDK and paired comparisons are later milestones (see
[Roadmap](#roadmap)).

## Why

Signing a transaction is not enough to get it into a block — it has to be
*delivered* to the current leader. Solana has no single public mempool, so
delivery became a market of its own: plain RPC with a priority fee, Jito with
bundles and tips, Nozomi, bloXroute and other staked-connection services, each
with its own minimum bid.

The user pays for that delivery but cannot see how much, or to whom. The
network fee shows up in the swap receipt; the tip goes out as an ordinary SOL
transfer to the provider's service account and looks like any other transfer.
The choice of channel and bid is made by the wallet or aggregator, which has
no obligation to disclose it. Researchers have called the result *invisible
rent extraction*: the price is real, but there is no common unit and no place
where the numbers stand next to each other.

Comparing raw tips would be wrong, though. A channel with a higher average tip
may simply carry the transactions that objectively needed a higher bid in a
congested slot. What has to be compared is the **overpay**: how much more a
landing cost than the cheapest successful landings in the *same* slot.

## How the numbers are computed

Every number on the dashboard follows from four definitions. The *Method*
page will carry the same text once it moves off synthetic data (T035 → T066).

- **Landing cost** of a transaction, in lamports, as a `bigint`:
  base fee (5 000 per signature) + priority fee (`meta.fee` above base) + tips.
  A tip is the balance increase of a known service account within the same
  transaction — it is not a fee and does not appear in `meta.fee`.
- **Slot reference** = the 10th percentile of landing cost among *successful,
  non-vote* transactions in that slot, computed only when the slot has at
  least 50 such samples. Vote transactions are always excluded — with them the
  reference collapses to almost zero. Slots without a reference simply have no
  overpay; nothing is written and nothing is shown.
- **Overpay** = landing cost − slot reference. It can be negative: landing
  cheaper than the slot's p10 is not an error.
- **Channel group** is the unit of comparison, not the brand. Services that
  share tip accounts are indistinguishable on-chain, and the system does not
  guess the brand inside a group. A transaction paying a known tip account is
  attributed to that group; one with a priority fee and no tip is *plain RPC*;
  anything else is *unattributed* and shown as a separate share rather than
  folded into any group.

Two more rules shape what you see:

- **Insufficient data** is stated, not hidden. A group with fewer than 50 raw
  observations in the selected window shows “insufficient data” instead of a
  number and does not take part in ranking. The threshold applies to the
  actual number of stored rows, never to the sample-weighted estimate.
- **Observing is wider than sending.** A group can be visible in the summary
  and still be unavailable for routing (no endpoint configured). The board
  marks such groups “observed only — cannot route through”.

Data is sampled: the indexer reads every 100th slot in full (`getBlock`) and
stores every landing that paid a tip plus a 5 % sample of plain-RPC landings.
Counts and shares are reweighted accordingly; percentiles are not, because
weights are uniform within a group.

## Architecture

```
            Solana RPC (public tier)
                    │  getBlock, every Nth slot
                    ▼
   apps/indexer ── parse block → landings, attribute group,
                   compute slot reference and overpay,
                   hourly rollup, TTL cleanup, gap healing
                    │
                    ▼
   Supabase Postgres ── landings (48 h) · slot_refs · group_hourly (90 d)
                    │
                    ▼
   apps/api (Hono) ── GET /v1/summary?window=15m|1h|24h
                      GET /v1/summary/stream   (SSE, one event per new slot)
                      GET /v1/history?hours=24 (hourly overpay series)
                      GET /health              (indexer lag and open gaps)
                    │
                    ▼
   apps/web (React + Vite) ── the board
```

No on-chain program, no custody, no user keys. Business logic lives as pure
functions in `packages/shared` and is tested on fixtures of real blocks
without a database or network.

### API notes

- `/v1/summary` returns, per group: raw observations, weighted landings,
  share, cost p10/p50/p90, median overpay, `isSendable`, `sufficientData`;
  plus window facts: `slotsSampled`, `lastBlockTime`, `dataAgeMs`, `isStale`.
- The summary is recomputed once per window for the whole process and cached
  for 5 s; the SSE stream pushes a fresh summary immediately on connect and
  then on every newly processed slot.
- `/health` always answers `200`, even when `status` is `degraded`: it
  reports the pipeline, not the liveness of the API process, and a `503`
  would make the platform restart the wrong process.
- All public routes allow any origin; there is nothing behind them that a
  key would protect.

## Repository layout

```
apps/
  indexer/     long-running collector: loop, parse, reference, persist, rollup, retention, gaps
  api/         Hono server: summary, stream, history, health
  web/         React dashboard (Vite, Tailwind)
packages/
  shared/      pure domain logic + Zod contracts: cost, attribution, reference, summary, channels
  db/          Drizzle schema, migrations, pgbouncer-aware client
  sdk/         placeholder until M2
scripts/
  calibrate.ts       measures getBlock size and slot composition on mainnet
  measure-sc001.ts   landing-to-summary latency on a deployed API
  measure-sc002.ts   first-screen time on a throttled connection (Chrome via CDP)
```

## Running locally

Requirements: Node ≥ 24.2 (entry points rely on `import.meta.main` and Node's
native TypeScript execution), pnpm 9, a Postgres database (Supabase free tier
is enough), an HTTPS Solana RPC endpoint.

```bash
pnpm install
cp .env.example .env            # fill SOLANA_RPC_URL, DATABASE_URL, DATABASE_DIRECT_URL

pnpm --filter @fairlane/db db:migrate    # prefers DATABASE_DIRECT_URL
pnpm --filter @fairlane/indexer start    # collector
pnpm --filter @fairlane/api start        # http://127.0.0.1:3000
pnpm --filter @fairlane/web dev          # http://127.0.0.1:5173

pnpm gate                                # lint + typecheck + test
```

There is no build step for the indexer and the API: Node runs the TypeScript
sources directly, which is why relative imports carry the `.ts` extension.
The web app is built by Vite; `VITE_API_URL` is baked in at build time.

`.env.example` documents every variable. Secrets never live in code; the only
private key the system will ever hold is the project's own demo wallet (M3),
read from `DEMO_WALLET_SECRET` and used in one module.

## Deployment

- **Indexer and API → Railway**, two services from this repository. Each has
  its config as code in `apps/indexer/railway.json` and `apps/api/railway.json`
  (start from the repo root, no build, one replica — two indexers would write
  the same slots twice). `.nvmrc` pins Node 24.
- **Web → GitHub Pages**, built and published by
  `.github/workflows/pages.yml` on every push to `main` that touches the web
  app. One-time setup: *Settings → Pages → Source: GitHub Actions*, and the
  repository variable `VITE_API_URL` (*Settings → Secrets and variables →
  Actions → Variables*) pointing at the API's public URL — the build fails
  loudly without it. The site lives under `/<repository-name>/`; for a custom
  domain set the variable `PAGES_BASE_PATH` to `/`.

## Success criteria and how they are measured

The spec defines twelve measurable criteria. M1 covers five of them; the rest
become measurable only when the system sends its own transactions (M3) or has
accumulated history (M4).

| Criterion | Budget | Measured by |
|---|---|---|
| SC-001 landing visible in the public summary after confirmation (p95) | ≤ 60 s | `scripts/measure-sc001.ts` against the deployed API |
| SC-002 first screen shows data on a 3G connection | < 2 s | `scripts/measure-sc002.ts` (Chrome DevTools “Fast 3G” profile) |
| SC-003 correct channel group | ≥ 99 % | manual check on 100 landings in M1; full 500-landing control set in M3 |
| SC-007 storage at 48 h of landings + 90 d of hourly aggregates | < 400 MB | table sizes after retention runs |
| SC-008 collection stays within the RPC free tier | 30 days | provider usage after 30 days of continuous collection |

Measured values are recorded in the release notes of each tag. A criterion
that is not met is recorded as not met, not removed.

## What this project does not do

- No on-chain program, no custody, no signing on the user's behalf.
- No brand attribution inside a channel group — it is not possible on-chain.
- No MEV protection; only the price of delivery is measured.
- No SLA: a recommendation (M2) is an estimate, not a guarantee.
- No history before collection started, and no provider-internal metrics.

## Roadmap

| Milestone | Delivers |
|---|---|
| **M1** — transparency core (this release) | indexer, database, `GET /v1/summary` + SSE, live board, methodology |
| **M2** — recommendation | `POST /v1/recommend`, self-service access keys with counters, `packages/sdk` in advisory mode |
| **M3** — proof side by side | send mode in the SDK, project demo wallet with a daily budget, paired comparison, split-screen view |
| **M4** — memory | per-address report on two data tiers, daily and monthly overpay dynamics |
