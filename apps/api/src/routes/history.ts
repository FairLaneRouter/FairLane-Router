import type { Database } from '@fairlane/db'
import {
  buildHistory,
  historyHoursSchema,
  historyRange,
  MAX_HISTORY_HOURS,
  type ChannelGroup,
  type History,
  type HourlyPoint,
  type Logger,
} from '@fairlane/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

export type HistoryStore = {
  read(from: Date, to: Date): Promise<readonly HourlyPoint[]>
}

const lamports = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value))

const pointRow = z.object({
  groupId: z.string(),
  hour: z.coerce.date(),
  landings: z.coerce.number().int().nonnegative(),
  observations: z.coerce.number().int().nonnegative(),
  costP50: lamports,
  overpayP50: lamports.nullable(),
  share: z.coerce.number(),
})

/**
 * Історія читається з `group_hourly`, а не з посадок, і це не оптимізація.
 * Потранзакційний рівень живе 48 годин (FR-026), тож доба ще була б у ньому, а
 * місяць для T065 — уже ні. Джерело має бути одне з самого початку: інакше
 * той самий графік показував би різні числа по різні боки дводобової межі.
 *
 * Рядків тут одиниці: групи × години, тобто пів сотні на добу. Ані процентилів,
 * ані ваг рахувати не треба — усе це вже пораховане згорткою (T028) один раз
 * на годину, замість того щоб перераховуватись на кожен запит.
 */
export function createHistoryStore(db: Database): HistoryStore {
  return {
    async read(from, to) {
      const rows = await db.execute(sql`
        select
          group_id as "groupId",
          hour,
          landings_count as "landings",
          observations_count as "observations",
          cost_p50 as "costP50",
          overpay_p50 as "overpayP50",
          share
        from group_hourly
        where hour >= ${from.toISOString()}::timestamptz
          and hour < ${to.toISOString()}::timestamptz
        order by hour
      `)

      return z.array(pointRow).parse([...rows])
    },
  }
}

export const INVALID_HOURS = {
  error: {
    code: 'INVALID_INPUT',
    message: 'Некоректна глибина історії',
    details: { hours: `ціле від 1 до ${MAX_HISTORY_HOURS}` },
  },
} as const

export type HistoryRouteOptions = {
  readonly store: HistoryStore
  readonly groups: readonly ChannelGroup[]
  readonly logger: Logger
  readonly cacheTtlMs?: number
  /** Перекривається тільки в тестах. */
  readonly now?: () => Date
}

/**
 * Годинні агрегати змінюються раз на годину, а не раз на слот, тож кеш тут
 * може бути значно довшим за кеш зведення. Хвилина обрана не за цим — за
 * дочитуванням прогалин: воно переписує агрегат заднім числом (T028 рахує
 * останні три години наново), і хвилина є стелею того, наскільки графік
 * відстане від виправлення.
 */
export const HISTORY_CACHE_TTL_MS = 60_000

type CacheEntry = {
  readonly expiresAt: number
  readonly value: Promise<History>
}

/**
 * `GET /v1/history?hours=24` — зміна медіанного надлишку по групах у часі
 * (FR-013). Публічний, як і зведення (FR-014, FR-049).
 */
export function historyRoute(options: HistoryRouteOptions): Hono {
  const { store, groups, logger } = options
  const ttl = options.cacheTtlMs ?? HISTORY_CACHE_TTL_MS
  const now = options.now ?? (() => new Date())
  const cache = new Map<number, CacheEntry>()

  async function compute(hours: number): Promise<History> {
    const at = now()
    const range = historyRange(at, hours)

    return buildHistory({
      groups,
      points: await store.read(range.from, range.to),
      range,
      hours,
      now: at,
    })
  }

  function cached(hours: number): Promise<History> {
    const entry = cache.get(hours)
    if (entry !== undefined && entry.expiresAt > Date.now()) return entry.value

    const value = compute(hours)
    cache.set(hours, { expiresAt: Date.now() + ttl, value })
    value.catch(() => cache.delete(hours))

    return value
  }

  const app = new Hono()

  app.get('/v1/history', async (c) => {
    const parsed = historyHoursSchema.safeParse(c.req.query('hours'))
    if (!parsed.success) return c.json(INVALID_HOURS, 400)

    const history = await cached(parsed.data)

    logger.debug('історію віддано', {
      hours: history.hours,
      coveredHours: history.coveredHours,
      series: history.series.length,
    })

    c.header('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`)

    return c.json(history)
  })

  return app
}
