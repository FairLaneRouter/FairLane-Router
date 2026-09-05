import type { Block, Logger, RpcClient } from '@fairlane/shared'
import { SlotSkippedError } from '@fairlane/shared'

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

export type SlotLoopOptions = {
  readonly rpc: RpcClient
  readonly logger: Logger
  readonly onSlot: SlotHandler
  readonly sampleEveryN: number
  /** Перший слот вибірки. За замовчуванням — наступний після поточної голови. */
  readonly startSlot?: number
  /** Пауза, коли всі доступні слоти вибірки вже оглянуті. */
  readonly pollIntervalMs?: number
  readonly signal?: AbortSignal
  readonly sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Цикл читає **не кожен слот, а кожен `sampleEveryN`-й** (FR-001). Він нічого
 * не розбирає і нічого не зберігає: усе, що він знає, — який слот читати далі
 * і кому віддати блок. Розбір живе в `parse.ts`, запис — у `persist.ts`.
 *
 * Пропущений слот — штатний стан ланцюга, а не збій: такого слота не існує і
 * ніколи не з'явиться, тому дочитувати його марно, і в прогалини він не йде.
 */
export async function runSlotLoop(options: SlotLoopOptions): Promise<void> {
  const { rpc, logger, onSlot, sampleEveryN, signal } = options
  const pollIntervalMs = options.pollIntervalMs ?? 2000
  const sleep = options.sleep ?? wait

  const head = await rpc.getSlot()
  let cursor = options.startSlot ?? nextSampleSlot(head, sampleEveryN)

  logger.info('цикл слотів запущено', { head, cursor, sampleEveryN })

  while (signal?.aborted !== true) {
    const confirmed = await rpc.getSlot()

    if (cursor > confirmed) {
      await sleep(pollIntervalMs)
      continue
    }

    // Відставання рахується до кроку по курсору: після інкремента воно
    // показувало б стан наступної ітерації, а не тієї, що зараз відпрацювала.
    const lag = confirmed - cursor

    try {
      const block = await rpc.getBlock(cursor)
      await onSlot(block, cursor)
      logger.debug('слот оброблено', { slot: cursor, lag, transactions: block.transactions.length })
    } catch (cause) {
      if (cause instanceof SlotSkippedError) {
        logger.debug('слот пропущений у ledger', { slot: cursor })
      } else {
        // Слот не зникає від того, що ми його не прочитали: він лишається
        // прогалиною, яку дочитає T030. Падати через один слот циклу не можна.
        logger.error('слот не прочитано', { slot: cursor, err: cause })
      }
    }

    cursor = nextSampleSlot(cursor, sampleEveryN)
  }

  logger.info('цикл слотів зупинено', { cursor })
}
