import { groupHourly, type Database } from '@fairlane/db'
import { HOUR_MS, sampleWeight, startOfHour, type Logger } from '@fairlane/shared'

/**
 * Посадка в тому вигляді, в якому її бачить згортка. Полів рівно чотири:
 * решта колонок `landings` існує заради потранзакційного рівня і в годинний
 * агрегат не входить (FR-043).
 */
export type HourlyLanding = {
  /** `null` — «неатрибутовано»: власного рядка не отримує (FR-039). */
  readonly groupId: string | null
  readonly totalCost: bigint
  /** `null`, якщо у слота не було еталона — у процентиль надлишку не входить. */
  readonly overpay: bigint | null
  /** Рядок пройшов вибірку і представляє `1 / RPC_SAMPLE_RATE` подібних до себе. */
  readonly isSampled: boolean
}

/** Рядок `group_hourly`. Гроші — `bigint`, частки — 0…1. */
export type GroupHourlyRow = {
  readonly groupId: string
  readonly hour: Date
  /** Зважена вибіркою оцінка обсягу. Мірою доказовості вона не є. */
  readonly landingsCount: number
  /** Скільки рядків стоїть за агрегатом насправді — саме до цього числа
   *  застосовується поріг «недостатньо даних» (FR-012). */
  readonly observationsCount: number
  readonly costP10: bigint
  readonly costP50: bigint
  readonly costP90: bigint
  readonly overpayP50: bigint | null
  readonly share: number
  readonly unattributedShare: number
}

export type RollupStore = {
  /** Посадки години за `block_time`: проміжок `[hour, hour + 1 год)`. */
  loadHour(hour: Date): Promise<readonly HourlyLanding[]>
  save(rows: readonly GroupHourlyRow[]): Promise<void>
}

/**
 * Останні `count` **завершених** годин, від старої до свіжої. Поточна не
 * входить: згортати її означало б записати агрегат по неповних даних, а
 * наступний запуск мовчки замінив би його іншим.
 */
export function completeHours(now: Date, count: number): Date[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`кількість годин має бути цілою і не менше 1, отримано ${count}`)
  }

  const current = startOfHour(now).getTime()

  return Array.from({ length: count }, (_, index) => new Date(current - (count - index) * HOUR_MS))
}

type WeightedSample = {
  readonly value: bigint
  readonly weight: number
}

/**
 * Зважений процентиль методом найближчого рангу — той самий метод, що й
 * `percentile()` для еталона слота, і при однакових вагах він дає точно той
 * самий результат. Без інтерполяції між сусідами: значення лишається сумою,
 * яку хтось справді заплатив, і його видно в оглядачі блоків (FR-045).
 */
function weightedPercentile(sorted: readonly WeightedSample[], p: number): bigint {
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0)
  const threshold = Math.ceil((p * total) / 100)
  let cumulative = 0

  for (const sample of sorted) {
    cumulative += sample.weight
    if (cumulative >= threshold) return sample.value
  }

  const last = sorted.at(-1)
  // Недосяжно: поріг не перевищує суми ваг. Гілка потрібна лише типам.
  if (last === undefined) throw new RangeError('процентиль порожньої вибірки')

  return last.value
}

function byValue(a: WeightedSample, b: WeightedSample): number {
  if (a.value < b.value) return -1
  return a.value > b.value ? 1 : 0
}

type Bucket = {
  weight: number
  rows: number
  readonly costs: WeightedSample[]
  readonly overpays: WeightedSample[]
}

export type RollupHourOptions = {
  readonly rpcSampleRate: number
}

/**
 * Годинний агрегат по групах каналів (FR-043). Три рішення, які тут
 * ухвалюються:
 *
 * 1. **Усі величини зважені вибіркою.** `landings_count` — оцінка того,
 *    скільки посадок було в оглянутих слотах, а не скільки рядків ми
 *    зберегли: інакше `share` не дорівнював би частці від `landings_count`, і
 *    звіт поверх агрегатів (T060) віддавав би два розбіжні числа. Ціна
 *    рішення: для групи `rpc` кількість **не є мірою доказовості** —
 *    процентилі там стоять приблизно на вдвадцятеро меншій кількості
 *    спостережень.
 * 2. **«Неатрибутовано» власного рядка не має**, бо `group_hourly.group_id`
 *    порожнім не буває. Його частка лежить у кожному рядку години поруч із
 *    частками груп — саме там, де її неможливо не побачити (FR-039).
 * 3. **Група без посадок рядка не отримує.** Нуль у процентилі вартості
 *    означав би «сісти коштувало нічого», а не «спостережень немає».
 */
export function rollupHour(
  hour: Date,
  landings: readonly HourlyLanding[],
  options: RollupHourOptions,
): GroupHourlyRow[] {
  const weightOfSampled = sampleWeight(options.rpcSampleRate)
  const buckets = new Map<string, Bucket>()
  let totalWeight = 0
  let unattributedWeight = 0

  for (const landing of landings) {
    const weight = landing.isSampled ? weightOfSampled : 1
    totalWeight += weight

    if (landing.groupId === null) {
      unattributedWeight += weight
      continue
    }

    const bucket = buckets.get(landing.groupId) ?? { weight: 0, rows: 0, costs: [], overpays: [] }
    bucket.weight += weight
    bucket.rows += 1
    bucket.costs.push({ value: landing.totalCost, weight })
    if (landing.overpay !== null) bucket.overpays.push({ value: landing.overpay, weight })
    buckets.set(landing.groupId, bucket)
  }

  if (totalWeight === 0) return []

  const unattributedShare = unattributedWeight / totalWeight

  return [...buckets.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([groupId, bucket]) => {
      const costs = [...bucket.costs].sort(byValue)
      const overpays = [...bucket.overpays].sort(byValue)

      return {
        groupId,
        hour,
        landingsCount: bucket.weight,
        observationsCount: bucket.rows,
        costP10: weightedPercentile(costs, 10),
        costP50: weightedPercentile(costs, 50),
        costP90: weightedPercentile(costs, 90),
        overpayP50: overpays.length === 0 ? null : weightedPercentile(overpays, 50),
        share: bucket.weight / totalWeight,
        unattributedShare,
      }
    })
}

/**
 * Читання йде через `db.query`, а не через `select().where()`, бо порівняння
 * приходять аргументом зворотного виклику — і `apps/indexer` не набуває прямої
 * залежності на `drizzle-orm` заради двох виразів.
 *
 * Запис — рядок на запит: груп одиниці, а поодинокий `INSERT` дозволяє
 * написати `DO UPDATE` конкретними значеннями, без `excluded.*`. Перезапис, а
 * не `DO NOTHING`: дочитування прогалини (T030) додає посадки заднім числом, і
 * тоді правильне саме **друге** обчислення, а не перше.
 */
export function createRollupStore(db: Database): RollupStore {
  return {
    async loadHour(hour) {
      const until = new Date(hour.getTime() + HOUR_MS)

      return await db.query.landings.findMany({
        columns: { groupId: true, totalCost: true, overpay: true, isSampled: true },
        where: (table, { and, gte, lt }) =>
          and(gte(table.blockTime, hour), lt(table.blockTime, until)),
      })
    },

    async save(rows) {
      for (const row of rows) {
        await db
          .insert(groupHourly)
          .values(row)
          .onConflictDoUpdate({
            target: [groupHourly.groupId, groupHourly.hour],
            set: {
              landingsCount: row.landingsCount,
              observationsCount: row.observationsCount,
              costP10: row.costP10,
              costP50: row.costP50,
              costP90: row.costP90,
              overpayP50: row.overpayP50,
              share: row.share,
              unattributedShare: row.unattributedShare,
            },
          })
      }
    },
  }
}

export type RunRollupOptions = {
  readonly store: RollupStore
  readonly logger: Logger
  readonly rpcSampleRate: number
  /**
   * Скільки завершених годин перераховувати на кожному запуску. Перерахунок, а
   * не журнал зробленого: він самозагоюється після простою і підбирає посадки,
   * дочитані в прогалину (T030). Прогалина, старша за це вікно, лишає агрегат
   * заниженим, і розширення вікна — єдиний важіль проти цього.
   */
  readonly lookbackHours?: number
  /** Перекривається тільки в тестах. */
  readonly now?: Date
}

export type RollupSummary = {
  readonly hours: number
  readonly rows: number
  readonly landings: number
}

const DEFAULT_LOOKBACK_HOURS = 3

/**
 * Щогодинна згортка (FR-043). Викликається **до** TTL-чистки (T029): агрегат
 * рахується з потранзакційних записів, поки вони ще є, а після їх видалення
 * відновити його вже нема з чого.
 */
export async function runRollup(options: RunRollupOptions): Promise<RollupSummary> {
  const { store, logger, rpcSampleRate } = options
  const lookback = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS
  const hours = completeHours(options.now ?? new Date(), lookback)

  let rows = 0
  let landings = 0

  for (const hour of hours) {
    const observed = await store.loadHour(hour)

    if (observed.length === 0) {
      logger.debug('годину пропущено: посадок немає', { hour: hour.toISOString() })
      continue
    }

    const aggregated = rollupHour(hour, observed, { rpcSampleRate })

    if (aggregated.length === 0) {
      // Жодної атрибутованої посадки за цілу годину. Частка «неатрибутовано»
      // тут дорівнює одиниці, але покласти її нема куди: рядок агрегату існує
      // тільки при групі.
      logger.warn('година без жодної атрибутованої посадки', {
        hour: hour.toISOString(),
        observed: observed.length,
      })
      continue
    }

    await store.save(aggregated)

    rows += aggregated.length
    landings += observed.length

    logger.debug('годину згорнуто', {
      hour: hour.toISOString(),
      groups: aggregated.length,
      observed: observed.length,
      unattributedShare: aggregated[0]?.unattributedShare,
    })
  }

  logger.info('згортку завершено', { hours: hours.length, rows, landings })

  return { hours: hours.length, rows, landings }
}
