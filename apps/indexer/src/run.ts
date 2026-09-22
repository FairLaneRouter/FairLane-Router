import type { Database } from '@fairlane/db'
import {
  buildChannelRegistry,
  type ChannelRegistry,
  type Config,
  createRpcClient,
  DEFAULT_REGISTRY,
  type Logger,
} from '@fairlane/shared'
import { createGapStore, detectRestartGap, healGaps, type HealGapsOptions } from './gaps.ts'
import { nextSampleSlot, runSlotLoop, type SlotHandler } from './loop.ts'
import { parseBlock } from './parse.ts'
import { createLandingStore, persistLandings, type LandingStore } from './persist.ts'
import { createSlotRefStore, recordSlotRef, type SlotRefStore } from './reference.ts'
import { createRegistryStore, syncRegistry } from './registry.ts'
import {
  createRetentionStore,
  runRetention,
  TRANSACTION_TTL_HOURS,
  type RetentionStore,
} from './retention.ts'
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
  /** Дочитування прогалин. Без нього обслуговування лишається згорткою і чисткою. */
  readonly gaps?: HealGapsOptions
  readonly rollup: RollupStore
  readonly retention: RetentionStore
  readonly rpcSampleRate: number
  readonly logger: Logger
  readonly now?: Date
}

/**
 * Обслуговування сховища: дочитування, згортка, чистка — саме в такому
 * порядку, і жоден із двох переходів не довільний.
 *
 * Дочитане (FR-009) має потрапити в агрегат того ж проходу, інакше година,
 * заповнена заднім числом, згорнеться лише наступного разу — а до наступного
 * разу її посадки може вже не бути.
 *
 * Згортка йде перед чисткою (FR-043): агрегат рахується з потранзакційних
 * записів, поки вони ще є. Помилка згортки скасовує чистку тієї ж ітерації —
 * вони йдуть одним `await`, і виняток не дає дійти до видалення. Це друга
 * лінія після межі, яку чистка тримає сама (`aggregatedThrough`): перша
 * боронить від разового збою, друга від того, що згортка не працює давно й
 * тихо.
 *
 * Невдале дочитування нічого не скасовує: борг зачекає до наступного проходу,
 * а от згортка чекати не може — її вікно вужче за строк зберігання.
 */
export async function runMaintenance(options: MaintenanceOptions): Promise<void> {
  const { gaps, rollup, retention, rpcSampleRate, logger, now } = options

  if (gaps) {
    try {
      await healGaps(gaps)
    } catch (cause) {
      logger.error('прохід прогалинами не вдався', { err: cause })
    }
  }

  await runRollup({ store: rollup, logger, rpcSampleRate, ...(now ? { now } : {}) })
  await runRetention({ store: retention, logger, ...(now ? { now } : {}) })
}

/** Година: згортка працює завершеними годинами, частіше за них їй нема чого робити. */
export const MAINTENANCE_INTERVAL_MS = 3_600_000

export type RunIndexerOptions = {
  readonly config: Config
  readonly logger: Logger
  /** Пул належить тому, хто викликає: індексатор його не закриває. */
  readonly db: Database
  /** Скасування — єдиний спосіб зупинити цикл; він завершується сам. */
  readonly signal: AbortSignal
}

/**
 * Збір як функція, а не як процес. Те саме тіло запускають двоє: власна точка
 * входу індексатора (`index.ts`, двопроцесний запуск) і API з `RUN_INDEXER=true`
 * там, де фонового процесу не дають (Render Free, один web-сервіс). Пул БД і
 * сигнал зупинки приходять ззовні — це і робить два запуски одним кодом.
 *
 * Обіцянка завершується, коли цикл вибірки зупинено сигналом або він упав;
 * помилка не ковтається — хто запускав, той і вирішує, що з нею робити.
 */
export async function runIndexer(options: RunIndexerOptions): Promise<void> {
  const { config, logger, db, signal } = options

  // Ендпоінтів індексатору не дають навмисно: у БД лягає довідникова ознака
  // відправки, а не фактична доступність цього процесу (FR-040).
  const registry = buildChannelRegistry(DEFAULT_REGISTRY)

  const rpc = createRpcClient({
    url: config.solanaRpcUrl,
    fallbackUrl: config.solanaRpcFallbackUrl,
  })

  const onSlot = createSlotHandler({
    registry,
    rpcSampleRate: config.rpcSampleRate,
    slotRefs: createSlotRefStore(db),
    landings: createLandingStore(db),
    logger,
  })

  const gapStore = createGapStore(db)

  const maintenance = {
    gaps: {
      store: gapStore,
      rpc,
      onSlot,
      sampleEveryN: config.sampleEveryN,
      logger: logger.child({ job: 'gaps' }),
      ttlHours: TRANSACTION_TTL_HOURS,
    },
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
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })

  try {
    await syncRegistry(registry, { store: createRegistryStore(db), logger })

    // Цикл починає з наступного слота сітки після голови, а не з місця, де
    // зупинився минулого разу: доганяти простій усередині циклу означало б
    // відставати від голови тим більше, чим довшим той простій був. Пропущене
    // стає прогалиною і дочитується окремо, у своєму темпі (FR-009).
    const startSlot = nextSampleSlot(await rpc.getSlot(), config.sampleEveryN)
    const restart = detectRestartGap(
      await gapStore.lastObservedSlot(),
      startSlot,
      config.sampleEveryN,
    )

    if (restart) {
      logger.info('розрив від перезапуску', { ...restart, startSlot })
      await gapStore.open({ ...restart, reason: 'restart' })
    }

    maintain()

    await runSlotLoop({
      rpc,
      logger,
      onSlot,
      sampleEveryN: config.sampleEveryN,
      startSlot,
      signal,
      onSlotFailed: ({ slot }) => gapStore.open({ fromSlot: slot, toSlot: slot, reason: 'slot-failed' }),
    })
  } finally {
    clearInterval(timer)
  }
}
