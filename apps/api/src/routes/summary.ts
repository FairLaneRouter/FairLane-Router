import type { Database } from '@fairlane/db'
import {
  buildSummary,
  DEFAULT_SUMMARY_WINDOW,
  sampleWeight,
  SUMMARY_WINDOW_MS,
  summaryWindowSchema,
  type ChannelGroup,
  type GroupAggregate,
  type Logger,
  type Summary,
  type SummaryWindow,
  type SummaryWindowFacts,
} from '@fairlane/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

/** Що сховище вміє порахувати за одне вікно: агрегати по групах і сам обрій. */
export type SummaryReading = {
  readonly aggregates: readonly GroupAggregate[]
  readonly facts: SummaryWindowFacts
}

/**
 * Найсвіжіший запис у сховищі. Ознакою змін узято `created_at`, а не
 * `max(slot)`: дочитування прогалини (T030) додає **старі** слоти заднім
 * числом, і за номером слота така зміна лишилась би непоміченою, хоча вікно
 * від неї змінилось.
 */
export type Watermark = {
  readonly slot: number | null
  readonly writtenAt: Date | null
}

export type SummaryStore = {
  read(from: Date, to: Date): Promise<SummaryReading>
  /** Дешева перевірка «чи щось змінилось» — індексне читання без сканування. */
  watermark(): Promise<Watermark>
}

/**
 * Лампорти приходять із Postgres рядком: `bigint` не вміщається в число JS
 * безпечно, і драйвер чесно віддає текст. Переведення в `bigint` тут —
 * єдина межа, на якій це відбувається.
 */
const lamports = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => BigInt(value))
  .nullable()

const count = z.coerce.number().int().nonnegative()

const aggregateRow = z.object({
  groupId: z.string().nullable(),
  observations: count,
  landings: count,
  overpayObservations: count,
  costP10: lamports,
  costP50: lamports,
  costP90: lamports,
  overpayP50: lamports,
})

const factsRow = z.object({
  slotsSampled: count,
  firstBlockTime: z.coerce.date().nullable(),
  lastBlockTime: z.coerce.date().nullable(),
})

const watermarkRow = z.object({
  slot: z.coerce.number().int().nullable(),
  writtenAt: z.coerce.date().nullable(),
})

export type SummaryStoreOptions = {
  /** Частка збережених транзакцій без чайових — вага рядка вибірки. */
  readonly rpcSampleRate: number
}

/**
 * Зведення рахується **в базі**, а не в пам'яті процесу, і це головне рішення
 * цього модуля. За добу у вікні лежать сотні тисяч рядків: вичитати їх на
 * кожен публічний запит означало б платити мережею й пам'яттю за число, яке
 * Postgres віддає одним рядком на групу.
 *
 * `percentile_disc` — той самий метод найближчого рангу, що й `percentile()`
 * для еталона слота: перше значення, чия накопичена частка досягає порога, без
 * інтерполяції між сусідами. Тому медіана лишається сумою, яку хтось справді
 * заплатив, і її видно в оглядачі блоків (FR-045). NULL він пропускає, тож
 * посадки зі слотів без еталона (FR-032) у медіану надлишку не входять — а
 * скільки їх було, показує окремий `overpayObservations`.
 *
 * **Ваги у процентилі немає навмисно, і це не спрощення.** Вага береться з
 * `is_sampled`, а він усередині групи однаковий за побудовою розбору:
 * транзакції з чайовими зберігаються всі (`is_sampled = false`), решта — з
 * часткою `RPC_SAMPLE_RATE` (`is_sampled = true`), і група визначається тією
 * самою ознакою. За однакових ваг зважений процентиль дорівнює звичайному.
 * Вага потрібна там, де ваги в межах підсумку різні, — у кількостях і
 * частках, і саме там вона й стоїть.
 *
 * Межі вікна йдуть параметром-рядком ISO з явним приведенням до
 * `timestamptz`, а не обʼєктом `Date`: у сирому `sql` drizzle не знає типу
 * колонки й віддає параметр драйверу як є, а `postgres` чекає на цьому місці
 * рядок і падає `ERR_INVALID_ARG_TYPE`. Помилка не з тих, що видно на збірці,
 * — тільки на першому справжньому запиті.
 */
export function createSummaryStore(db: Database, options: SummaryStoreOptions): SummaryStore {
  const weight = sampleWeight(options.rpcSampleRate)

  return {
    async read(from, to) {
      const aggregates = await db.execute(sql`
        select
          group_id as "groupId",
          count(*)::int as "observations",
          sum(case when is_sampled then ${weight} else 1 end)::bigint as "landings",
          count(overpay)::int as "overpayObservations",
          percentile_disc(0.1) within group (order by total_cost) as "costP10",
          percentile_disc(0.5) within group (order by total_cost) as "costP50",
          percentile_disc(0.9) within group (order by total_cost) as "costP90",
          percentile_disc(0.5) within group (order by overpay) as "overpayP50"
        from landings
        where block_time >= ${from.toISOString()}::timestamptz
          and block_time < ${to.toISOString()}::timestamptz
        group by group_id
      `)

      // Окремий запит, бо `count(distinct …)` віконною функцією в Postgres не
      // буває, а обрій вікна потрібен цілим — по всіх групах одразу.
      const facts = await db.execute(sql`
        select
          count(distinct slot)::int as "slotsSampled",
          min(block_time) as "firstBlockTime",
          max(block_time) as "lastBlockTime"
        from landings
        where block_time >= ${from.toISOString()}::timestamptz
          and block_time < ${to.toISOString()}::timestamptz
      `)

      return {
        aggregates: z.array(aggregateRow).parse([...aggregates]),
        facts: factsRow.parse(facts[0] ?? { slotsSampled: 0 }),
      }
    },

    async watermark() {
      // `max()` по індексованій колонці Postgres бере зворотним індексним
      // читанням — три буфери й нуль звернень до купи, скільки б рядків у
      // таблиці не лежало. Саме тому цей запит можна робити раз на кілька
      // секунд, а повне зведення — ні.
      const rows = await db.execute(sql`
        select max(slot) as "slot", max(created_at) as "writtenAt" from landings
      `)

      return watermarkRow.parse(rows[0] ?? { slot: null, writtenAt: null })
    },
  }
}

/**
 * Скільки живе обчислене зведення. Маршрут публічний і без ключа (FR-014,
 * FR-049), тобто беззахисний перед повторами: без кешу кожен запит за вікном
 * «24 год» — це прохід по сотнях тисяч рядків на безкоштовному тарифі.
 *
 * П'ять секунд — це менше, ніж дає новий слот вибірки (крок 100 ≈ 40 секунд),
 * тож жодне спостереження через кеш не затримується. У бюджет SC-001 (60
 * секунд від підтвердження до появи у зведенні) п'ять секунд входять із
 * запасом, а `generatedAt` показує момент обчислення, не момент запиту — щоб
 * затримку було видно, а не приховано.
 */
export const SUMMARY_CACHE_TTL_MS = 5_000

type CacheEntry = {
  readonly expiresAt: number
  readonly value: Promise<Summary>
}

/**
 * Обчислення зведення з кешем — один на весь застосунок. Обидва маршрути
 * ходять сюди: HTTP-запит (T031) і жива стрічка (T032). Якби кеш належав
 * маршруту, підписники стрічки платили б за власне обчислення тих самих
 * чисел, і два маршрути показували б різні числа в одну й ту саму секунду.
 */
export type SummaryProvider = {
  /** Кешоване зведення. Обчислює лише тоді, коли кеш прострочений. */
  get(window: SummaryWindow): Promise<Summary>
  /** Перерахунок повз кеш — коли вже відомо, що у сховищі щось змінилось. */
  refresh(window: SummaryWindow): Promise<Summary>
  readonly ttlMs: number
}

export type SummaryProviderOptions = {
  readonly store: SummaryStore
  readonly groups: readonly ChannelGroup[]
  readonly staleAfterMs: number
  readonly cacheTtlMs?: number
  /** Перекривається тільки в тестах. */
  readonly now?: () => Date
}

export function createSummaryProvider(options: SummaryProviderOptions): SummaryProvider {
  const { store, groups, staleAfterMs } = options
  const ttlMs = options.cacheTtlMs ?? SUMMARY_CACHE_TTL_MS
  const now = options.now ?? (() => new Date())
  const cache = new Map<SummaryWindow, CacheEntry>()

  async function compute(window: SummaryWindow): Promise<Summary> {
    const at = now()
    const reading = await store.read(new Date(at.getTime() - SUMMARY_WINDOW_MS[window]), at)

    return buildSummary({
      window,
      groups,
      aggregates: reading.aggregates,
      facts: reading.facts,
      now: at,
      staleAfterMs,
    })
  }

  /**
   * Кеш тримає саму обіцянку, а не результат: паралельні запити за тим самим
   * вікном тоді чекають на один запит до бази замість того, щоб послати
   * стільки ж однакових. Невдалу обіцянку з кешу видно одразу — інакше
   * помилка бази жила б у кеші повні п'ять секунд.
   */
  function fill(window: SummaryWindow): Promise<Summary> {
    const value = compute(window)
    cache.set(window, { expiresAt: Date.now() + ttlMs, value })
    value.catch(() => cache.delete(window))

    return value
  }

  return {
    ttlMs,

    get(window) {
      const entry = cache.get(window)
      if (entry !== undefined && entry.expiresAt > Date.now()) return entry.value

      return fill(window)
    },

    // Кеш тут не питається навмисно. Стрічка перераховує лише тоді, коли обрій
    // сховища вже зрушив, і віддати їй кешоване число означало б надіслати
    // подію «є новий слот» із даними, у яких того слота ще немає.
    refresh: (window) => fill(window),
  }
}

const windowQuerySchema = summaryWindowSchema.default(DEFAULT_SUMMARY_WINDOW)

/** Тіло відмови за контрактом плану — спільне для обох маршрутів зведення. */
export const INVALID_WINDOW = {
  error: {
    code: 'INVALID_INPUT',
    message: 'Unknown summary window',
    details: { window: summaryWindowSchema.options },
  },
} as const

export type WindowChoice =
  | { readonly ok: true; readonly window: SummaryWindow }
  | { readonly ok: false }

/** Розбір `?window=` з підстановкою вікна за замовчуванням (FR-020). */
export function chooseWindow(raw: string | undefined): WindowChoice {
  const parsed = windowQuerySchema.safeParse(raw)

  return parsed.success ? { ok: true, window: parsed.data } : { ok: false }
}

export type SummaryRouteOptions = {
  readonly provider: SummaryProvider
  readonly logger: Logger
}

/**
 * `GET /v1/summary?window=15m|1h|24h` — публічне зведення по групах каналів
 * (FR-010, FR-012, FR-014, FR-015). Ключа не потребує за жодних умов
 * (FR-049).
 */
export function summaryRoute(options: SummaryRouteOptions): Hono {
  const { provider, logger } = options
  const app = new Hono()

  app.get('/v1/summary', async (c) => {
    const choice = chooseWindow(c.req.query('window'))
    if (!choice.ok) return c.json(INVALID_WINDOW, 400)

    const summary = await provider.get(choice.window)

    logger.debug('зведення віддано', {
      window: summary.window,
      observations: summary.observations,
      isStale: summary.isStale,
    })

    // Кеш посередників тримається того ж строку, що й наш власний: зведення
    // однакове для всіх, ключа не потребує і персональних даних не містить.
    c.header('Cache-Control', `public, max-age=${Math.floor(provider.ttlMs / 1000)}`)

    return c.json(summary)
  })

  return app
}
