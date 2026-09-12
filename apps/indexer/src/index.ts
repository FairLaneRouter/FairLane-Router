import { createDatabase } from '@fairlane/db'
import {
  buildChannelRegistry,
  createLogger,
  createRpcClient,
  DEFAULT_REGISTRY,
  loadConfig,
  type ChannelRegistry,
  type Logger,
} from '@fairlane/shared'
import { runSlotLoop, type SlotHandler } from './loop.ts'
import { parseBlock } from './parse.ts'
import { createLandingStore, persistLandings, type LandingStore } from './persist.ts'
import { createSlotRefStore, recordSlotRef, type SlotRefStore } from './reference.ts'
import { createRegistryStore, syncRegistry } from './registry.ts'
import { createRetentionStore, runRetention, type RetentionStore } from './retention.ts'
import { createRollupStore, runRollup, type RollupStore } from './rollup.ts'

export type SlotHandlerOptions = {
  readonly registry: ChannelRegistry
  readonly rpcSampleRate: number
  readonly slotRefs: SlotRefStore
  readonly landings: LandingStore
  readonly logger: Logger
}

/**
 * Порядок усередині слота не довільний. Еталон рахується **першим і по всіх**
 * успішних невотингових транзакціях блока — до того, як вибірка `parseBlock`
 * щось відкине (FR-005). Якби він рахувався після розбору, p10 міряв би не
 * слот, а те, що ми вирішили зберегти, і надлишок став би величиною, залежною
 * від налаштувань нашого сховища.
 *
 * Слот без еталона не переривається: його посадки зберігаються з порожнім
 * надлишком (FR-032).
 */
export function createSlotHandler(options: SlotHandlerOptions): SlotHandler {
  const { registry, rpcSampleRate, slotRefs, landings, logger } = options

  return async (block, slot) => {
    const ref = await recordSlotRef(block, slot, {
      store: slotRefs,
      tipAccounts: registry.tipAccounts,
      logger,
    })

    const parsed = parseBlock(block, slot, { registry, rpcSampleRate })

    await persistLandings(parsed.landings, ref, { store: landings, logger })

    logger.debug('слот записано', { slot, ...parsed.stats })
  }
}

export type MaintenanceOptions = {
  readonly rollup: RollupStore
  readonly retention: RetentionStore
  readonly rpcSampleRate: number
  readonly logger: Logger
  readonly now?: Date
}

/**
 * Обслуговування сховища: згортка, потім чистка — і ніколи навпаки (FR-043).
 * Агрегат рахується з потранзакційних записів, поки вони ще є; після їх
 * видалення відновити його вже нема з чого.
 *
 * Помилка згортки скасовує чистку тієї ж ітерації: вони йдуть одним `await`,
 * і виняток не дає дійти до видалення. Це друга лінія після межі, яку чистка
 * тримає сама (`aggregatedThrough`), і потрібні обидві — перша боронить від
 * разового збою, друга від того, що згортка не працює давно й тихо.
 */
export async function runMaintenance(options: MaintenanceOptions): Promise<void> {
  const { rollup, retention, rpcSampleRate, logger, now } = options

  await runRollup({ store: rollup, logger, rpcSampleRate, ...(now ? { now } : {}) })
  await runRetention({ store: retention, logger, ...(now ? { now } : {}) })
}

/** Година: згортка працює завершеними годинами, частіше за них їй нема чого робити. */
export const MAINTENANCE_INTERVAL_MS = 3_600_000

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, context: { app: 'indexer' } })
  const { db, close } = createDatabase(config.databaseUrl)

  // Ендпоінтів індексатору не дають навмисно: у БД лягає довідникова ознака
  // відправки, а не фактична доступність цього процесу (FR-040).
  const registry = buildChannelRegistry(DEFAULT_REGISTRY)

  const controller = new AbortController()
  const stop = (signal: string) => {
    logger.info('зупинка на сигналі', { signal })
    controller.abort()
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  const maintenance = {
    rollup: createRollupStore(db),
    retention: createRetentionStore(db),
    rpcSampleRate: config.rpcSampleRate,
    logger: logger.child({ job: 'maintenance' }),
  }

  // Обслуговування не має права зупинити збір: пропущена згортка наздоганяє
  // себе наступною ітерацією, а пропущений слот не наздоганяє себе ніколи.
  const maintain = () => {
    runMaintenance(maintenance).catch((cause: unknown) => {
      logger.error('обслуговування сховища не вдалося', { err: cause })
    })
  }

  const timer = setInterval(maintain, MAINTENANCE_INTERVAL_MS)
  controller.signal.addEventListener('abort', () => clearInterval(timer))

  try {
    await syncRegistry(registry, { store: createRegistryStore(db), logger })
    maintain()

    await runSlotLoop({
      rpc: createRpcClient({
        url: config.solanaRpcUrl,
        fallbackUrl: config.solanaRpcFallbackUrl,
      }),
      logger,
      onSlot: createSlotHandler({
        registry,
        rpcSampleRate: config.rpcSampleRate,
        slotRefs: createSlotRefStore(db),
        landings: createLandingStore(db),
        logger,
      }),
      sampleEveryN: config.sampleEveryN,
      signal: controller.signal,
    })
  } finally {
    clearInterval(timer)
    await close()
    logger.info('індексатор зупинено')
  }
}

if (import.meta.main) {
  await main()
}
