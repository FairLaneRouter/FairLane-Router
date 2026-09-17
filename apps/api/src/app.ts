import type { ChannelGroup, Logger } from '@fairlane/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { healthRoute, type HealthStore } from './routes/health.ts'
import { createSummaryHub, streamRoute, type SummaryHub } from './routes/stream.ts'
import { createSummaryProvider, summaryRoute, type SummaryStore } from './routes/summary.ts'

export type AppOptions = {
  readonly summary: SummaryStore
  readonly health: HealthStore
  readonly groups: readonly ChannelGroup[]
  readonly staleAfterMs: number
  readonly logger: Logger
  readonly cacheTtlMs?: number
  /** Як часто стрічка питає сховище про зміни. Перекривається в тестах. */
  readonly watchIntervalMs?: number
  readonly pingIntervalMs?: number
  /** Перекривається тільки в тестах. */
  readonly now?: () => Date
}

export type App = {
  readonly app: Hono
  /** Зупиняє опитування сховища: інакше таймер пережив би сам застосунок. */
  close(): void
}

/**
 * Складання застосунку. Маршрути монтуються з повними шляхами (`/v1/…`), а не
 * префіксом: адреса маршруту тоді написана в одному місці — у самому маршруті,
 * і її видно з файлу, який її обслуговує.
 *
 * Провідник зведення і вузол стрічки створюються **тут, по одному на
 * застосунок**. Це те, що робить кеш спільним: HTTP-запит і жива стрічка
 * рахують ті самі числа один раз, а не кожен для себе.
 *
 * `onError` тут навмисно короткий. Єдиний формат помилки на всіх маршрутах —
 * предмет T069; поки його немає, важливо лише те, щоб збій бази не віддавав
 * назовні сторінку Hono замість тіла за контрактом, і щоб причина лягла в лог,
 * а не в відповідь.
 */
export function createApp(options: AppOptions): App {
  const { summary, health, groups, staleAfterMs, logger } = options

  const provider = createSummaryProvider({
    store: summary,
    groups,
    staleAfterMs,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const hub: SummaryHub = createSummaryHub({
    provider,
    watermark: () => summary.watermark(),
    logger,
    ...(options.watchIntervalMs === undefined ? {} : { intervalMs: options.watchIntervalMs }),
  })

  const app = new Hono()

  /**
   * Зведення, стрічка і health публічні за побудовою: без ключа, без
   * персональних даних, з тим самим тілом для будь-кого (FR-014, FR-049).
   * Дозвіл будь-якому джерелу тут нічого не відкриває — читати їх однаково
   * може хто завгодно, — а без нього дашборд на іншому домені не працює
   * взагалі, як не працював би й чужий інтегратор.
   *
   * Маршрути з ключем (M2) під це правило не підпадають: їм потрібен інший
   * дозвіл, і він видаватиметься окремо, разом із самими маршрутами.
   */
  app.use('/v1/summary', cors({ origin: '*' }))
  app.use('/v1/summary/stream', cors({ origin: '*' }))
  app.use('/health', cors({ origin: '*' }))

  app.route('/', summaryRoute({ provider, logger }))
  app.route(
    '/',
    streamRoute({
      provider,
      hub,
      logger,
      ...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
    }),
  )

  app.route(
    '/',
    healthRoute({
      store: health,
      staleAfterMs,
      logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  )

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'Такого маршруту немає', details: {} } }, 404),
  )

  app.onError((cause, c) => {
    logger.error('запит не оброблено', { err: cause, path: c.req.path })

    return c.json({ error: { code: 'INTERNAL', message: 'Внутрішня помилка', details: {} } }, 500)
  })

  return { app, close: () => hub.close() }
}
