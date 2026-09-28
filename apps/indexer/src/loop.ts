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
  /**
   * The shortest pause while waiting for the next sample slot; the pause
   * itself is sized to the slots still missing (`headWaitMs`).
   */
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

/** A slot's nominal length. The chain drifts from it; the next read of the head corrects that. */
export const NOMINAL_SLOT_MS = 400

/** The longest wait for the chain to reach the next sample slot. */
export const MAX_HEAD_WAIT_MS = 60_000

/**
 * How long to wait for the head to cover `slotsMissing` more slots.
 *
 * The loop used to ask for the head every two seconds while waiting, about
 * twenty reads per sample slot at a step of 100 — 93 % of all RPC credits
 * spent (2026-09-28: ~41 000 a day against a free quota of 1 M a month).
 * Sleeping for the missing slots makes it one read, and at most a couple
 * more when the chain runs slower than nominal: a short remainder waits the
 * floor, never less.
 */
export function headWaitMs(slotsMissing: number, floorMs: number): number {
  return Math.min(Math.max(slotsMissing * NOMINAL_SLOT_MS, floorMs), MAX_HEAD_WAIT_MS)
}

/**
 * The longest pause between attempts to read the head. A provider that
 * answers "max usage reached" stays that way for hours; asking every two
 * seconds would only burn requests, while once a minute still resumes
 * collection within a minute of the quota coming back.
 */
export const MAX_HEAD_BACKOFF_MS = 60_000

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

export type ReadHeadOptions = {
  readonly rpc: RpcClient
  readonly logger: Logger
  /** The first pause; each failure in a row doubles it, up to `MAX_HEAD_BACKOFF_MS`. */
  readonly retryDelayMs: number
  readonly signal?: AbortSignal | undefined
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * The confirmed head, asked for until the provider gives it — `null` only
 * when the signal stops the wait.
 *
 * The head is the one read that has no slot to leave behind as a gap, so a
 * failure here used to escape the loop and end collection for good, while
 * the API around it kept answering: on 2026-09-28 an exhausted RPC quota
 * stopped collection for ten hours, and nothing restarted it. Now the wait
 * lasts as long as the outage does, and the lag on `/health` shows it.
 */
export async function readHead(options: ReadHeadOptions): Promise<number | null> {
  const { rpc, logger, retryDelayMs, signal } = options
  const sleep = options.sleep ?? wait

  for (let failures = 0; signal?.aborted !== true; failures += 1) {
    try {
      return await rpc.getSlot()
    } catch (cause) {
      const delayMs = Math.min(retryDelayMs * 2 ** failures, MAX_HEAD_BACKOFF_MS)
      logger.warn('head not read, waiting', { failures: failures + 1, delayMs, err: cause })
      await sleep(delayMs)
    }
  }

  return null
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

  const head = (): Promise<number | null> =>
    readHead({ rpc, logger, retryDelayMs: pollIntervalMs, signal, sleep })

  let cursor = options.startSlot
  if (cursor === undefined) {
    const start = await head()
    if (start === null) return
    cursor = nextSampleSlot(start, sampleEveryN)
  }

  logger.info('цикл слотів запущено', { cursor, sampleEveryN, headMarginSlots })

  while (signal?.aborted !== true) {
    const confirmed = await head()
    if (confirmed === null) break

    const slotsMissing = cursor + headMarginSlots - confirmed
    if (slotsMissing > 0) {
      await sleep(headWaitMs(slotsMissing, pollIntervalMs))
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
