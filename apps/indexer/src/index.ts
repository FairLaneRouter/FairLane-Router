import { createDatabase } from '@fairlane/db'
import { createLogger, loadConfig } from '@fairlane/shared'
import { runIndexer } from './run.ts'

// Складання й обслуговування живуть у `run.ts`; звідси їх реекспортовано,
// щоб точка входу лишалась тим місцем, де їх шукають.
export {
  createSlotHandler,
  MAINTENANCE_INTERVAL_MS,
  type MaintenanceOptions,
  runMaintenance,
  type SlotHandlerOptions,
} from './run.ts'

/**
 * Двопроцесний запуск: індексатор окремим процесом зі своїм пулом. Той самий
 * збір усередині API вмикає `RUN_INDEXER=true` (`apps/api/src/index.ts`) —
 * там, де окремого процесу не дають.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, context: { app: 'indexer' } })
  const { db, close } = createDatabase(config.databaseUrl)

  const controller = new AbortController()
  const stop = (signal: string) => {
    logger.info('зупинка на сигналі', { signal })
    controller.abort()
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    await runIndexer({ config, logger, db, signal: controller.signal })
  } finally {
    await close()
    logger.info('індексатор зупинено')
  }
}

if (import.meta.main) {
  await main()
}
