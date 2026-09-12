import { groupHourly, landings, slotRefs, type Database } from '@fairlane/db'
import type { Logger } from '@fairlane/shared'
import { lt } from 'drizzle-orm'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * Потранзакційний рівень: окрема посадка з усіма її витратами (FR-026). Разом
 * із нею живе й еталон її слота — без еталона надлишок неможливо перерахувати
 * вручну, а саме це обіцяє сторінка методики в межах 48 годин (FR-045).
 */
export const TRANSACTION_TTL_HOURS = 48

/** Агрегатний рівень: годинні зведення по групах каналів (FR-026, FR-043). */
export const AGGREGATE_TTL_DAYS = 90

export type RetentionCutoffs = {
  /** Спільна межа для `landings` і `slot_refs` — рівень зберігання один. */
  readonly transactional: Date
  readonly aggregate: Date
}

export type RetentionTtl = {
  readonly transactionTtlHours?: number
  readonly aggregateTtlDays?: number
}

export function retentionCutoffs(now: Date, ttl: RetentionTtl = {}): RetentionCutoffs {
  const transactionHours = ttl.transactionTtlHours ?? TRANSACTION_TTL_HOURS
  const aggregateDays = ttl.aggregateTtlDays ?? AGGREGATE_TTL_DAYS

  if (transactionHours <= 0 || aggregateDays <= 0) {
    throw new RangeError('строк зберігання має бути додатним')
  }

  return {
    transactional: new Date(now.getTime() - transactionHours * HOUR_MS),
    aggregate: new Date(now.getTime() - aggregateDays * DAY_MS),
  }
}

export type RetentionStore = {
  /**
   * Найсвіжіша година, що вже потрапила в агрегати. `null` — згортка не
   * записала жодної години, і потранзакційний рівень чистити ще нема за чим.
   */
  aggregatedThrough(): Promise<Date | null>
  /** Посадки старші за межу — за `created_at`, часом запису, не блока. */
  deleteLandings(before: Date): Promise<number>
  deleteSlotRefs(before: Date): Promise<number>
  deleteAggregates(before: Date): Promise<number>
}

/**
 * Видалення одним виразом на рівень: за крок вибірки 100 і годинний запуск це
 * близько десяти тисяч рядків, і дробити тут нема чого. Обидва запити ходять
 * індексами — `landings_created_at_idx` і `group_hourly_hour_idx`.
 */
export function createRetentionStore(db: Database): RetentionStore {
  return {
    async aggregatedThrough() {
      const newest = await db.query.groupHourly.findFirst({
        columns: { hour: true },
        orderBy: (table, { desc }) => desc(table.hour),
      })

      return newest?.hour ?? null
    },

    async deleteLandings(before) {
      const result = await db.delete(landings).where(lt(landings.createdAt, before))
      return result.count
    },

    async deleteSlotRefs(before) {
      const result = await db.delete(slotRefs).where(lt(slotRefs.computedAt, before))
      return result.count
    },

    async deleteAggregates(before) {
      const result = await db.delete(groupHourly).where(lt(groupHourly.hour, before))
      return result.count
    },
  }
}

export type RunRetentionOptions = RetentionTtl & {
  readonly store: RetentionStore
  readonly logger: Logger
  /** Перекривається тільки в тестах. */
  readonly now?: Date
}

export type RetentionReport = {
  readonly landings: number
  readonly slotRefs: number
  readonly aggregates: number
  /** Межа, за якою потранзакційний рівень справді чистився. */
  readonly transactional: Date | null
  readonly aggregate: Date
  /** Межу підтягнула згортка, а не строк зберігання. */
  readonly heldByRollup: boolean
}

/**
 * TTL-чистка обох рівнів (FR-026). Викликається **після** згортки (T028): вона
 * рахує агрегат із потранзакційних записів, поки ті ще є, і після видалення
 * відновити агрегат уже нема з чого.
 *
 * Порядку виклику мало, тому межа потранзакційного рівня додатково обрізається
 * найсвіжішою згорнутою годиною. Якщо згортка мовчки не працює — упала,
 * процес перезапускався в циклі, база була недоступна, — строк зберігання
 * однаково настане, і чистка вимела б місяці спостережень, яких у 90-денній
 * історії так ніколи й не з'явилось. Затримане видалення видно у витраті
 * сховища (SC-007) і в `warn`; тиха втрата даних не видна ніяк, і M4 виявив би
 * її вже порожнім графіком.
 *
 * Обрізання консервативне навмисно: `landings.created_at` — час запису, а
 * година агрегату — час блока, і на дочитуванні прогалини (T030) перший більший
 * за другий. Різниця працює на бік збереження, а не видалення.
 */
export async function runRetention(options: RunRetentionOptions): Promise<RetentionReport> {
  const { store, logger } = options
  const cutoffs = retentionCutoffs(options.now ?? new Date(), options)

  const aggregates = await store.deleteAggregates(cutoffs.aggregate)
  const aggregatedThrough = await store.aggregatedThrough()

  if (aggregatedThrough === null) {
    logger.warn('потранзакційний рівень не чистився: жодної згорнутої години', {
      cutoff: cutoffs.transactional.toISOString(),
    })

    return {
      landings: 0,
      slotRefs: 0,
      aggregates,
      transactional: null,
      aggregate: cutoffs.aggregate,
      heldByRollup: true,
    }
  }

  const heldByRollup = aggregatedThrough < cutoffs.transactional
  const cutoff = heldByRollup ? aggregatedThrough : cutoffs.transactional

  if (heldByRollup) {
    logger.warn('межу чистки підтягнуто до згортки — вона відстає', {
      ttlCutoff: cutoffs.transactional.toISOString(),
      aggregatedThrough: aggregatedThrough.toISOString(),
      behindHours: Math.round((cutoffs.transactional.getTime() - aggregatedThrough.getTime()) / HOUR_MS),
    })
  }

  const deletedLandings = await store.deleteLandings(cutoff)
  const deletedSlotRefs = await store.deleteSlotRefs(cutoff)

  logger.info('чистку завершено', {
    landings: deletedLandings,
    slotRefs: deletedSlotRefs,
    aggregates,
    cutoff: cutoff.toISOString(),
    heldByRollup,
  })

  return {
    landings: deletedLandings,
    slotRefs: deletedSlotRefs,
    aggregates,
    transactional: cutoff,
    aggregate: cutoffs.aggregate,
    heldByRollup,
  }
}
