import { type Database, recommendations } from '@fairlane/db'
import {
  type ChannelGroup,
  DEFAULT_SUMMARY_WINDOW,
  describeInputIssue,
  type GroupBidStats,
  intentSchema,
  type Logger,
  priceGroups,
  priorityFeeLamports,
  type RecommendMode,
  recommend,
  SUMMARY_WINDOW_MS,
} from '@fairlane/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { KeyedEnv } from '../middleware/rateLimit.ts'

/** What storage knows about bidding through each group over one window. */
export type BidStatsStore = {
  read(from: Date, to: Date): Promise<readonly GroupBidStats[]>
}

/**
 * The window the advice is priced from: the dashboard's default one. The note
 * of FR-041 exists so the advice never contradicts the dashboard, and that
 * only holds if both look at the same landings. A shorter window would also
 * push small groups under the evidence threshold. "Now" is not lost to the
 * width: freshness is judged per group, from its newest landing.
 */
export const RECOMMEND_WINDOW_MS = SUMMARY_WINDOW_MS[DEFAULT_SUMMARY_WINDOW]

const lamports = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value))

const bidStatsRow = z.object({
  groupId: z.string(),
  observations: z.coerce.number().int().nonnegative(),
  tipP50: lamports,
  tipP90: lamports,
  priceP50: lamports,
  priceP90: lamports,
  lastBlockTime: z.coerce.date(),
})

/**
 * Tips and compute unit prices per group, as percentiles in the database — the
 * same nearest-rank `percentile_disc` as the summary, so every number is one
 * somebody actually paid.
 *
 * The price is `priority_fee × 1e6 / cu_consumed`: storage has no requested
 * limit, and dividing by what was consumed overstates the price — towards
 * landing, the right side for a bid. Rows without consumed units cannot give
 * a price and are left out, from the percentiles and from the evidence count
 * alike. Unattributed rows belong to no group (FR-039).
 *
 * Window bounds go in as ISO strings cast to `timestamptz`, as in the summary
 * store: raw `sql` passes a `Date` to the driver untyped, and it fails there.
 */
export function createBidStatsStore(db: Database): BidStatsStore {
  return {
    async read(from, to) {
      const rows = await db.execute(sql`
        select
          group_id as "groupId",
          count(*)::int as "observations",
          percentile_disc(0.5) within group (order by tip_total) as "tipP50",
          percentile_disc(0.9) within group (order by tip_total) as "tipP90",
          percentile_disc(0.5) within group (order by priority_fee * 1000000 / cu_consumed) as "priceP50",
          percentile_disc(0.9) within group (order by priority_fee * 1000000 / cu_consumed) as "priceP90",
          max(block_time) as "lastBlockTime"
        from landings
        where block_time >= ${from.toISOString()}::timestamptz
          and block_time < ${to.toISOString()}::timestamptz
          and group_id is not null
          and cu_consumed > 0
        group by group_id
      `)

      return z
        .array(bidStatsRow)
        .parse([...rows])
        .map((row) => ({
          groupId: row.groupId,
          observations: row.observations,
          tipLamports: { p50: row.tipP50, p90: row.tipP90 },
          priorityPriceMicroLamports: { p50: row.priceP50, p90: row.priceP90 },
          lastBlockTime: row.lastBlockTime,
        }))
    },
  }
}

/**
 * One piece of advice as it was given, kept to be checked against what
 * actually landed (T046). `landed_signature` stays empty here: it is filled by
 * our own sends (M3), the one place where advice and outcome meet for sure.
 */
export type IssuedRecommendation = {
  /** `null` for a keyless caller (FR-047). */
  readonly keyId: string | null
  readonly mode: RecommendMode
  readonly groupId: string
  readonly tipLamports: bigint
  /**
   * The priority fee in lamports for this intent's compute units — the unit
   * `landings.priority_fee` is kept in, so the two compare without the limit
   * that storage never sees.
   */
  readonly priorityFeeLamports: bigint
  readonly expectedCost: bigint
  readonly dataAgeMs: number
  readonly wasStale: boolean
}

export type RecommendationLog = {
  record(entry: IssuedRecommendation): Promise<void>
}

export function createRecommendationLog(db: Database): RecommendationLog {
  return {
    async record(entry) {
      await db.insert(recommendations).values({
        keyId: entry.keyId,
        mode: entry.mode,
        groupId: entry.groupId,
        tipLamports: entry.tipLamports,
        priorityFee: entry.priorityFeeLamports,
        expectedCost: entry.expectedCost,
        dataAgeMs: entry.dataAgeMs,
        wasStale: entry.wasStale,
      })
    },
  }
}

/**
 * How long read statistics live — the summary's TTL, for the summary's
 * reason: shorter than one sampling step, so no landing is held back. The
 * statistics do not depend on the intent, so every caller in those seconds
 * shares one query and pricing is arithmetic in memory (SC-004).
 */
export const BID_STATS_CACHE_TTL_MS = 5_000

/** The refusal when no sendable group has evidence to price advice from. */
export const NO_ADVICE = {
  error: {
    code: 'STALE_DATA',
    message: 'No sendable group has enough recent landings to price advice from',
    details: {},
  },
} as const

export type RecommendRouteOptions = {
  readonly store: BidStatsStore
  readonly log: RecommendationLog
  readonly groups: readonly ChannelGroup[]
  readonly staleAfterMs: number
  readonly logger: Logger
  readonly cacheTtlMs?: number
  /** Overridden in tests only. */
  readonly now?: () => Date
}

/**
 * `POST /v1/recommend` — which group to send an intent through, at what bid,
 * and how old the data behind it is (FR-016, FR-017, FR-018, FR-041).
 *
 * A key is optional: the limiter in front of every route already gives a
 * keyless caller the stricter allowance (FR-047) and refuses an unknown or
 * revoked key, so the route itself never looks at one.
 *
 * `programId` is validated but does not change the price yet: statistics are
 * per group, not per program.
 */
export function recommendRoute(options: RecommendRouteOptions): Hono<KeyedEnv> {
  const { store, log, groups, staleAfterMs, logger } = options
  const ttlMs = options.cacheTtlMs ?? BID_STATS_CACHE_TTL_MS
  const now = options.now ?? (() => new Date())
  const app = new Hono<KeyedEnv>()

  let cached: {
    readonly expiresAt: number
    readonly value: Promise<readonly GroupBidStats[]>
  } | null = null

  // The promise is cached, not its result, so concurrent requests wait on one
  // query; a failed one is dropped at once rather than served for the TTL.
  function readStats(at: Date): Promise<readonly GroupBidStats[]> {
    if (cached !== null && cached.expiresAt > Date.now()) return cached.value

    const value = store.read(new Date(at.getTime() - RECOMMEND_WINDOW_MS), at)
    const entry = { expiresAt: Date.now() + ttlMs, value }
    cached = entry
    value.catch(() => {
      if (cached === entry) cached = null
    })

    return value
  }

  app.post('/v1/recommend', async (c) => {
    // Unlike key issuance, an empty or broken body is not a valid request here:
    // it is reported as such rather than read as "no fields".
    const body: unknown = await c.req.json().catch(() => undefined)
    const parsed = intentSchema.safeParse(body)

    if (!parsed.success) {
      const issue = describeInputIssue(parsed.error)

      return c.json(
        {
          error: { code: 'INVALID_INPUT', message: issue.message, details: { field: issue.field } },
        },
        400,
      )
    }

    const intent = parsed.data
    const at = now()
    const stats = await readStats(at)
    const ranked = priceGroups({ intent, groups, stats })
    const advice = recommend({ intent, ranked, now: at, staleAfterMs })

    // Advice depends on the body and is priced for this moment: nobody may keep it.
    c.header('Cache-Control', 'no-store')

    if (advice === null) {
      logger.warn('no advice: no sendable group has evidence', { groups: stats.length })

      return c.json(NO_ADVICE, 503)
    }

    // Not awaited, like the key counters: the advice is already priced, and a
    // write on every call would be paid for by SC-004 on every call. A lost row
    // costs one sample of the check; a failed write is logged, never answered.
    if (advice.dataAgeMs !== null) {
      log
        .record({
          keyId: c.get('keyId') ?? null,
          mode: intent.mode,
          groupId: advice.groupId,
          tipLamports: BigInt(advice.tipLamports),
          priorityFeeLamports: priorityFeeLamports(
            BigInt(advice.priorityFeeMicroLamports),
            intent.computeUnits,
          ),
          expectedCost: BigInt(advice.expectedCost),
          dataAgeMs: advice.dataAgeMs,
          wasStale: advice.isStale,
        })
        .catch((cause: unknown) => {
          logger.error('advice not recorded', { groupId: advice.groupId, err: cause })
        })
    }

    logger.debug('advice given', {
      mode: intent.mode,
      groupId: advice.groupId,
      isStale: advice.isStale,
      noted: advice.note !== null,
    })

    return c.json(advice)
  })

  return app
}
