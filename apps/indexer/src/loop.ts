import type { Block, Logger, RpcClient } from '@fairlane/shared'
import { BlockNotAvailableError, SlotSkippedError } from '@fairlane/shared'

/**
 * Слоти вибірки прив'язані до сітки, кратної `sampleEveryN`, а не відлічуються
 * від того слота, на якому індексатор випадково запустився. Через це набір
 * оглянутих слотів однаковий після кожного перезапуску й після кожної
 * прогалини — і стороння людина може перевірити, що ми не вибирали слоти
 * зручні для себе.
 */
export function nextSampleSlot(after: number, sampleEveryN: number): number {
  return (Math.floor(after / sampleEveryN) + 1) * sampleEveryN
}

export type SlotHandler = (block: Block, slot: number) => Promise<void>

/** Слот, який так і не вдалося обробити. Вхід для наглядача прогалин (T030). */
export type SlotFailure = {
  readonly slot: number
  readonly attempts: number
  readonly cause: unknown
}

export type SlotLoopOptions = {
  readonly rpc: RpcClient
  readonly logger: Logger
  readonly onSlot: SlotHandler
  readonly sampleEveryN: number
  /** Перший слот вибірки. За замовчуванням — наступний після поточної голови. */
  readonly startSlot?: number
  /** Пауза, коли всі доступні слоти вибірки вже оглянуті. */
  readonly pollIntervalMs?: number
  /** Наскільки триматись позаду голови, перш ніж просити блок. */
  readonly headMarginSlots?: number
  /** Скільки разів просити блок, поки вузол його не має. */
  readonly attempts?: number
  readonly retryDelayMs?: number
  /** Куди віддавати слот, який не піддався. За замовчуванням — нікуди. */
  readonly onSlotFailed?: (failure: SlotFailure) => Promise<void> | void
  readonly signal?: AbortSignal
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Запас позаду голови. `getSlot` за рівнем `confirmed` віддає слот, блока
 * якого вузол ще не подає в `getBlock`: перший же прогін на mainnet
 * (2026-08-28) втратив так два слоти вибірки з чотирьох — `-32004`, і жодного
 * рядка з них у базі. 32 слоти — це близько 13 секунд, а слот вибірки при
 * кроці 100 приходить раз на 40 секунд, тож затримка збору мізерна проти
 * ціни втрати.
 */
const DEFAULT_HEAD_MARGIN_SLOTS = 32

const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 2000

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

type FetchOptions = {
  readonly rpc: RpcClient
  readonly logger: Logger
  readonly attempts: number
  readonly retryDelayMs: number
  readonly sleep: (ms: number) => Promise<void>
  readonly signal: AbortSignal | undefined
}

/**
 * Повторюється лише читання блока — не обробка. Запис ідемпотентний, але
 * повтор розбору й запису після помилки сховища ховав би несправність бази за
 * успішним рядком у лозі; такий слот чесніше віддати наглядачу прогалин.
 *
 * Пропущений слот повертається одразу: його не існує і не з'явиться, тому
 * кожна повторна спроба була б витраченим запитом до платного RPC.
 */
async function fetchBlock(slot: number, options: FetchOptions): Promise<Block> {
  const { rpc, logger, attempts, retryDelayMs, sleep, signal } = options

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rpc.getBlock(slot)
    } catch (cause) {
      if (cause instanceof SlotSkippedError) throw cause
      if (attempt >= attempts || signal?.aborted === true) throw cause

      const transient = cause instanceof BlockNotAvailableError
      logger.debug('слот не дався, пробуємо ще', { slot, attempt, transient, err: cause })

      // Вузол, який відстав, наздоганяє за секунди; провайдер, що віддав 502,
      // теж. Крок росте, щоб не гатити в обидва випадки з однаковою частотою.
      await sleep(retryDelayMs * attempt)
    }
  }
}

/**
 * Цикл читає **не кожен слот, а кожен `sampleEveryN`-й** (FR-001). Він нічого
 * не розбирає і нічого не зберігає: усе, що він знає, — який слот читати далі
 * і кому віддати блок. Розбір живе в `parse.ts`, запис — у `persist.ts`.
 *
 * Три різні неприємності, і реакція на кожну своя (FR-009):
 *
 * 1. **Слот пропущений у ledger** — штатний стан ланцюга. Такого слота не
 *    існує і ніколи не з'явиться, дочитувати його марно, у прогалини він не
 *    йде.
 * 2. **Блока ще немає у вузла** — слот існує, вузол відстав. Лікується
 *    запасом позаду голови й повтором.
 * 3. **Решта** — обрив мережі, 502 провайдера, недоступна база. Слот лишається
 *    прогалиною і йде до `onSlotFailed`; цикл при цьому не падає ніколи, бо
 *    пропущений слот не наздоганяє себе сам.
 */
export async function runSlotLoop(options: SlotLoopOptions): Promise<void> {
  const { rpc, logger, onSlot, sampleEveryN, signal, onSlotFailed } = options
  const pollIntervalMs = options.pollIntervalMs ?? 2000
  const headMarginSlots = options.headMarginSlots ?? DEFAULT_HEAD_MARGIN_SLOTS
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = options.sleep ?? wait

  const head = await rpc.getSlot()
  let cursor = options.startSlot ?? nextSampleSlot(head, sampleEveryN)

  logger.info('цикл слотів запущено', { head, cursor, sampleEveryN, headMarginSlots })

  while (signal?.aborted !== true) {
    const confirmed = await rpc.getSlot()

    if (cursor + headMarginSlots > confirmed) {
      await sleep(pollIntervalMs)
      continue
    }

    // Відставання рахується до кроку по курсору: після інкремента воно
    // показувало б стан наступної ітерації, а не тієї, що зараз відпрацювала.
    const lag = confirmed - cursor

    try {
      const block = await fetchBlock(cursor, {
        rpc,
        logger,
        attempts,
        retryDelayMs,
        sleep,
        signal,
      })
      await onSlot(block, cursor)
      logger.debug('слот оброблено', { slot: cursor, lag, transactions: block.transactions.length })
    } catch (cause) {
      if (cause instanceof SlotSkippedError) {
        logger.debug('слот пропущений у ledger', { slot: cursor })
      } else {
        // Слот не зникає від того, що ми його не прочитали: він лишається
        // прогалиною, яку дочитає T030. Падати через один слот циклу не можна.
        logger.error('слот не прочитано', { slot: cursor, attempts, err: cause })
        await reportFailure({ slot: cursor, attempts, cause }, onSlotFailed, logger)
      }
    }

    cursor = nextSampleSlot(cursor, sampleEveryN)
  }

  logger.info('цикл слотів зупинено', { cursor })
}

/**
 * Наглядач прогалин теж ходить у базу, а база — рівно те, що могло щойно
 * впасти. Його власна помилка не має права зупинити збір: слот у такому разі
 * лишається невідомим, і це видно у відставанні на health (T036).
 */
async function reportFailure(
  failure: SlotFailure,
  onSlotFailed: SlotLoopOptions['onSlotFailed'],
  logger: Logger,
): Promise<void> {
  if (onSlotFailed === undefined) return

  try {
    await onSlotFailed(failure)
  } catch (cause) {
    logger.error('прогалину не записано', { slot: failure.slot, err: cause })
  }
}
