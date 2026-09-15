import type { ChannelGroup, Logger } from '@fairlane/shared'
import { Hono } from 'hono'
import { summaryRoute, type SummaryStore } from './routes/summary.ts'

export type AppOptions = {
  readonly summary: SummaryStore
  readonly groups: readonly ChannelGroup[]
  readonly staleAfterMs: number
  readonly logger: Logger
  readonly cacheTtlMs?: number
  /** Перекривається тільки в тестах. */
  readonly now?: () => Date
}

/**
 * Складання застосунку. Маршрути монтуються з повними шляхами (`/v1/…`), а не
 * префіксом: адреса маршруту тоді написана в одному місці — у самому маршруті,
 * і її видно з файлу, який її обслуговує.
 *
 * `onError` тут навмисно короткий. Єдиний формат помилки на всіх маршрутах —
 * предмет T069; поки його немає, важливо лише те, щоб збій бази не віддавав
 * назовні сторінку Hono замість тіла за контрактом, і щоб причина лягла в лог,
 * а не в відповідь.
 */
export function createApp(options: AppOptions): Hono {
  const { summary, groups, staleAfterMs, logger } = options

  const app = new Hono()

  app.route(
    '/',
    summaryRoute({
      store: summary,
      groups,
      staleAfterMs,
      logger,
      ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  )

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'Такого маршруту немає', details: {} } }, 404),
  )

  app.onError((cause, c) => {
    logger.error('запит не оброблено', { err: cause, path: c.req.path })

    return c.json(
      { error: { code: 'INTERNAL', message: 'Внутрішня помилка', details: {} } },
      500,
    )
  })

  return app
}
