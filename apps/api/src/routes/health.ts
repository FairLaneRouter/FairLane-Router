import type { Database } from '@fairlane/db'
import type { Logger } from '@fairlane/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

/**
 * Скільки прогалина може лишатись відкритою, поки це нормально. Обслуговування
 * індексатора — дочитування, згортка, чистка — ходить раз на годину, тож
 * прогалина, що пережила два проходи, вже не лікується сама: або дочитування
 * падає, або процес не працює. Одна година порогом була б хибною тривогою на
 * кожному перезапуску: розрив від перезапуску відкривається одразу, а
 * закривається наступним проходом.
 */
export const GAP_STUCK_AFTER_MS = 7_200_000

export type IndexerState = {
  /** `null` — індексатор не записав жодної посадки. */
  readonly lastSlot: number | null
  readonly lastBlockTime: Date | null
  /** Коли рядок ліг у базу. Відрізняється від `lastBlockTime` на дочитуванні. */
  readonly lastWriteAt: Date | null
  readonly openGaps: number
  readonly oldestOpenGapAt: Date | null
}

export type HealthStore = {
  read(): Promise<IndexerState>
}

const stateRow = z.object({
  lastSlot: z.coerce.number().int().nullable(),
  lastBlockTime: z.coerce.date().nullable(),
  lastWriteAt: z.coerce.date().nullable(),
})

const gapsRow = z.object({
  openGaps: z.coerce.number().int().nonnegative(),
  oldestOpenGapAt: z.coerce.date().nullable(),
})

export function createHealthStore(db: Database): HealthStore {
  return {
    async read() {
      const state = await db.execute(sql`
        select
          max(slot) as "lastSlot",
          max(block_time) as "lastBlockTime",
          max(created_at) as "lastWriteAt"
        from landings
      `)

      // Відкрита прогалина — та, у якої немає `healed_at` (FR-009). Часткового
      // індексу під це немає, але й рядків у таблиці одиниці: вона росте на
      // один рядок за перезапуск, а не за слот.
      const gaps = await db.execute(sql`
        select count(*)::int as "openGaps", min(detected_at) as "oldestOpenGapAt"
        from indexer_gaps
        where healed_at is null
      `)

      return {
        ...stateRow.parse(state[0] ?? {}),
        ...gapsRow.parse(gaps[0] ?? { openGaps: 0, oldestOpenGapAt: null }),
      }
    },
  }
}

export type HealthReport = {
  readonly status: 'ok' | 'degraded'
  /** Що саме не так. Порожній список і є єдиним значенням «все гаразд». */
  readonly issues: readonly string[]
  readonly checkedAt: string
  readonly lastSlot: number | null
  readonly lastBlockTime: string | null
  readonly lastWriteAt: string | null
  /** Скільки часу минуло від найсвіжішої посадки — і є відставанням. */
  readonly lagMs: number | null
  /** Те саме в слотах, оцінкою: відставання ділене на тривалість слота. */
  readonly lagSlots: number | null
  readonly openGaps: number
  readonly oldestOpenGapAt: string | null
}

const SLOT_TIME_MS = 400

export type AssessOptions = {
  readonly state: IndexerState
  readonly now: Date
  /** Той самий поріг, за яким зведення оголошує дані застарілими. */
  readonly staleAfterMs: number
  readonly gapStuckAfterMs?: number
}

/**
 * Стан збору (`GET /health`). Відставання міряється часом від найсвіжішої
 * посадки, а не різницею з головою ланцюга, і це рішення, а не спрощення:
 * питати голову означає ходити до чужого RPC на кожну перевірку. Health, який
 * падає від того, що впав сторонній сервіс, повідомляє не про нас; до того ж
 * платформа опитує його частіше за наш власний крок вибірки, і кредити пішли б
 * на відповідь про те, що ми й так знаємо з `block_time`.
 *
 * Прогалини самі по собі несправністю не є: розрив від перезапуску
 * відкривається щоразу і закривається наступним проходом обслуговування.
 * Несправністю є прогалина, що пережила два проходи.
 */
export function assessIndexer(options: AssessOptions): HealthReport {
  const { state, now, staleAfterMs } = options
  const gapStuckAfterMs = options.gapStuckAfterMs ?? GAP_STUCK_AFTER_MS

  const lagMs =
    state.lastBlockTime === null
      ? null
      : Math.max(0, now.getTime() - state.lastBlockTime.getTime())

  const gapAgeMs =
    state.oldestOpenGapAt === null ? null : now.getTime() - state.oldestOpenGapAt.getTime()

  const issues: string[] = []

  if (state.lastSlot === null) issues.push('жодної посадки у сховищі')
  else if (lagMs !== null && lagMs > staleAfterMs) issues.push('збір відстає від ланцюга')

  if (gapAgeMs !== null && gapAgeMs > gapStuckAfterMs) {
    issues.push('прогалина не закривається два проходи поспіль')
  }

  return {
    status: issues.length === 0 ? 'ok' : 'degraded',
    issues,
    checkedAt: now.toISOString(),
    lastSlot: state.lastSlot,
    lastBlockTime: state.lastBlockTime?.toISOString() ?? null,
    lastWriteAt: state.lastWriteAt?.toISOString() ?? null,
    lagMs,
    lagSlots: lagMs === null ? null : Math.round(lagMs / SLOT_TIME_MS),
    openGaps: state.openGaps,
    oldestOpenGapAt: state.oldestOpenGapAt?.toISOString() ?? null,
  }
}

export type HealthRouteOptions = {
  readonly store: HealthStore
  readonly staleAfterMs: number
  readonly logger: Logger
  /** Перекривається тільки в тестах. */
  readonly now?: () => Date
}

/**
 * `GET /health` — стан індексатора: останній оброблений слот, відставання,
 * відкриті прогалини.
 *
 * Код відповіді **завжди 200**, навіть коли `status: "degraded"`. Маршрут
 * розповідає про конвеєр, а не про живість цього процесу, і 503 тут змусив би
 * платформу перезапускати API через те, що зупинився індексатор — інший
 * процес, якому перезапуск сусіда ніяк не допоможе. Несправність видно полем,
 * і вона не влаштовує перезапускової каруселі.
 */
export function healthRoute(options: HealthRouteOptions): Hono {
  const { store, staleAfterMs, logger } = options
  const now = options.now ?? (() => new Date())
  const app = new Hono()

  app.get('/health', async (c) => {
    const report = assessIndexer({ state: await store.read(), now: now(), staleAfterMs })

    if (report.status !== 'ok') logger.warn('стан збору погіршився', { issues: report.issues })

    // Стан протухає швидше, ніж будь-який посередник встиг би його віддати
    // вдруге, а перевірка платформи має бачити поточний стан, не збережений.
    c.header('Cache-Control', 'no-store')

    return c.json(report)
  })

  return app
}
