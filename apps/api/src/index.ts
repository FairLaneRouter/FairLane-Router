import { serve } from '@hono/node-server'
import { createDatabase } from '@fairlane/db'
import { runIndexer } from '@fairlane/indexer/run'
import {
  buildChannelRegistry,
  createLogger,
  DEFAULT_REGISTRY,
  loadConfig,
  staleAfterMs,
} from '@fairlane/shared'
import { createApp } from './app.ts'
import { createHealthStore } from './routes/health.ts'
import { createHistoryStore } from './routes/history.ts'
import { createKeyStore } from './routes/keys.ts'
import { createSummaryStore } from './routes/summary.ts'

/**
 * Складання API. Від індексатора воно відрізняється однією річчю, і вона
 * навмисна: довідник каналів тут будується **з ендпоінтами оточення**
 * (`config.channelEndpoints`). Індексатор ендпоінтів не отримує — він пише в
 * БД довідникову ознаку відправки, — а API є тим самим процесом, який
 * відправлятиме (M3), тож його `isSendable` у зведенні означає «цей процес
 * справді має куди надіслати», а не «сервіс колись обіцяв приймати» (FR-040,
 * FR-041).
 *
 * `RUN_INDEXER=true` піднімає збір **у цьому ж процесі**, на спільному пулі.
 * Це не архітектурне рішення, а поступка хостингу: на безкоштовному тарифі
 * Render фонових процесів немає, є один web-сервіс. Розділення лишається
 * типовим запуском — індексатор має власну точку входу, і API без прапорця
 * про нього не знає. Падіння збору API не валить: `/health` покаже
 * відставання, а платформа перезапустить процес за healthcheck лише тоді,
 * коли впаде сам HTTP.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, context: { app: 'api' } })
  const { db, close } = createDatabase(config.databaseUrl)
  const registry = buildChannelRegistry(DEFAULT_REGISTRY, config.channelEndpoints)

  const { app, close: stopWatching } = createApp({
    summary: createSummaryStore(db, { rpcSampleRate: config.rpcSampleRate }),
    health: createHealthStore(db),
    history: createHistoryStore(db),
    keys: createKeyStore(db),
    groups: registry.groups,
    staleAfterMs: staleAfterMs(config.sampleEveryN),
    logger,
  })

  const indexer = new AbortController()

  if (config.runIndexer) {
    runIndexer({
      config,
      logger: createLogger({ level: config.logLevel, context: { app: 'indexer' } }),
      db,
      signal: indexer.signal,
    }).then(
      () => logger.info('збір усередині API зупинено'),
      (cause: unknown) => logger.error('збір усередині API впав', { err: cause }),
    )
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('API слухає', {
      port: info.port,
      sendableGroups: registry.sendableGroups.map((group) => group.id),
      indexerInProcess: config.runIndexer,
    })
  })

  // Спершу збір, потім HTTP, потім пул: слот, який саме пишеться, має
  // дописатись до того, як з'єднання з базою закриються.
  const stop = (signal: string) => {
    logger.info('зупинка на сигналі', { signal })
    indexer.abort()
    stopWatching()
    server.close(() => {
      void close().then(() => logger.info('API зупинено'))
    })
  }

  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
}

if (import.meta.main) {
  await main()
}
