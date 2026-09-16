import { serve } from '@hono/node-server'
import { createDatabase } from '@fairlane/db'
import {
  buildChannelRegistry,
  createLogger,
  DEFAULT_REGISTRY,
  loadConfig,
  staleAfterMs,
} from '@fairlane/shared'
import { createApp } from './app.ts'
import { createSummaryStore } from './routes/summary.ts'

/**
 * Складання API. Від індексатора воно відрізняється однією річчю, і вона
 * навмисна: довідник каналів тут будується **з ендпоінтами оточення**
 * (`config.channelEndpoints`). Індексатор ендпоінтів не отримує — він пише в
 * БД довідникову ознаку відправки, — а API є тим самим процесом, який
 * відправлятиме (M3), тож його `isSendable` у зведенні означає «цей процес
 * справді має куди надіслати», а не «сервіс колись обіцяв приймати» (FR-040,
 * FR-041).
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, context: { app: 'api' } })
  const { db, close } = createDatabase(config.databaseUrl)
  const registry = buildChannelRegistry(DEFAULT_REGISTRY, config.channelEndpoints)

  const { app, close: stopWatching } = createApp({
    summary: createSummaryStore(db, { rpcSampleRate: config.rpcSampleRate }),
    groups: registry.groups,
    staleAfterMs: staleAfterMs(config.sampleEveryN),
    logger,
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('API слухає', {
      port: info.port,
      sendableGroups: registry.sendableGroups.map((group) => group.id),
    })
  })

  const stop = (signal: string) => {
    logger.info('зупинка на сигналі', { signal })
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
