import { z } from 'zod'

const SLOT_SKIPPED_CODES = new Set([-32007, -32009])

/**
 * `Block not available for slot N`. Вузол ще не має блока — не «його немає», а
 * «його немає **поки що**»: голова за рівнем `confirmed` випереджає те, що
 * вузол уже віддає в `getBlock`. Плутати з пропущеним слотом не можна, бо
 * рішення протилежні: пропущений слот дочитувати марно, цей — обов'язково.
 */
/**
 * Найвища версія транзакції, яку клієнт погоджується розбирати. Не прикраса:
 * вузол **відмовляє цілому блоку**, щойно в ньому трапиться транзакція
 * новішої версії, тож занизьке число зупиняє збір повністю — і виглядає це
 * як недоступний RPC, а не як налаштування. Саме так і сталось: пін `0`
 * пережив появу v1 у mainnet, і кожен слот вибірки падав з `-32015`.
 *
 * Підняття межі безпечне для розбору: форма `transaction.message` у v1 та
 * сама, ключі акаунтів на місці (перевірено на живому блоці — 56 транзакцій
 * v1 із 1200, жодної невідповідності схемі). Ми не інтерпретуємо семантику
 * версій — нам потрібні комісії, баланси й ключі, а вони спільні.
 */
export const MAX_SUPPORTED_TX_VERSION = 1

/** Вузол відмовив блоку через версію транзакції — межу вище треба піднімати. */
const UNSUPPORTED_VERSION_PATTERN = /not supported by the requesting client/i

const BLOCK_NOT_AVAILABLE_CODE = -32004

export class RpcError extends Error {
  override readonly name = 'RpcError'
  readonly code: number | undefined

  constructor(message: string, code?: number, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export class SlotSkippedError extends RpcError {
  override readonly name = 'RpcError'
  readonly slot: number

  constructor(slot: number, code: number) {
    super(`Слот ${slot} пропущений або відсутній у ledger`, code)
    this.slot = slot
  }
}

/** Блока ще немає у вузла. Слот існує, і повторна спроба має сенс. */
export class BlockNotAvailableError extends RpcError {
  override readonly name = 'RpcError'
  readonly slot: number

  constructor(slot: number, code: number) {
    super(`Блок слота ${slot} ще недоступний вузлу`, code)
    this.slot = slot
  }
}

/**
 * Адреси, підтягнуті з таблиць пошуку транзакцією v0. Індексуються ПІСЛЯ
 * статичних ключів повідомлення — див. `resolveAccountKeys`.
 */
const loadedAddressesSchema = z.object({
  writable: z.array(z.string()),
  readonly: z.array(z.string()),
})

/** Із інструкції потрібен лише виконавець: `program_ids` посадки (FR-001). */
const instructionSchema = z.object({
  programIdIndex: z.number().int().nonnegative(),
})

const metaSchema = z.object({
  err: z.unknown().nullable(),
  fee: z.number().int().nonnegative(),
  computeUnitsConsumed: z.number().int().nonnegative().optional(),
  preBalances: z.array(z.number().int().nonnegative()),
  postBalances: z.array(z.number().int().nonnegative()),
  loadedAddresses: loadedAddressesSchema.optional(),
})

const transactionSchema = z.object({
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({
      accountKeys: z.array(z.string()),
      instructions: z.array(instructionSchema),
    }),
  }),
  meta: metaSchema,
})

export const blockSchema = z.object({
  blockhash: z.string(),
  parentSlot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable().optional(),
  transactions: z.array(transactionSchema),
})

export type Block = z.infer<typeof blockSchema>
export type BlockTransaction = z.infer<typeof transactionSchema>

/**
 * Повний список акаунтів транзакції в тому самому порядку, у якому їх індексує
 * сам протокол: статичні ключі повідомлення, далі записувані з таблиць пошуку,
 * далі читані. За цими індексами адресуються і `preBalances`/`postBalances`, і
 * `programIdIndex`, тому брати в транзакції v0 самі лише статичні ключі
 * означає промазати повз частину акаунтів — зокрема повз службовий, на який
 * пішли чайові.
 */
export function resolveAccountKeys(tx: BlockTransaction): readonly string[] {
  const loaded = tx.meta.loadedAddresses
  if (loaded === undefined) return tx.transaction.message.accountKeys

  return [...tx.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly]
}

const envelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export type RpcClientOptions = {
  readonly url: string
  readonly fallbackUrl?: string | undefined
  readonly fetch?: FetchLike
}

export type RpcClient = {
  getSlot(): Promise<number>
  getBlock(slot: number): Promise<Block>
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
  const urls = options.fallbackUrl ? [options.url, options.fallbackUrl] : [options.url]
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  let id = 0

  async function call(method: string, params: unknown[], slot?: number): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    const failures: string[] = []

    for (const url of urls) {
      let payload: unknown
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`)
          continue
        }
        payload = await response.json()
      } catch (cause) {
        failures.push(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`)
        continue
      }

      const envelope = envelopeSchema.safeParse(payload)
      if (!envelope.success) {
        throw new RpcError(`${method}: відповідь не є JSON-RPC конвертом`)
      }

      const error = envelope.data.error
      if (error) {
        // Пропущений слот приходить як помилка, але означає штатний стан ланцюга:
        // такий слот не існує і ніколи не з'явиться, дочитувати його марно.
        if (slot !== undefined && SLOT_SKIPPED_CODES.has(error.code)) {
          throw new SlotSkippedError(slot, error.code)
        }
        if (slot !== undefined && error.code === BLOCK_NOT_AVAILABLE_CODE) {
          throw new BlockNotAvailableError(slot, error.code)
        }
        // Повідомлення вузла тут переписується навмисно: сире «not supported
        // by the requesting client» читається як проблема мережі, тоді як це
        // наша константа, і полагодити її можна одним числом.
        if (UNSUPPORTED_VERSION_PATTERN.test(error.message)) {
          throw new RpcError(
            `${method}: вузол віддає транзакції новіші за MAX_SUPPORTED_TX_VERSION=${MAX_SUPPORTED_TX_VERSION} — ` +
              `підніміть константу в packages/shared/src/rpc.ts (вузол каже: ${error.message})`,
            error.code,
          )
        }

        throw new RpcError(`${method}: ${error.message}`, error.code)
      }

      return envelope.data.result
    }

    throw new RpcError(`${method}: жоден ендпоінт не відповів — ${failures.join('; ')}`)
  }

  return {
    async getSlot() {
      const result = await call('getSlot', [{ commitment: 'confirmed' }])
      const parsed = z.number().int().nonnegative().safeParse(result)
      if (!parsed.success) throw new RpcError('getSlot: результат не є номером слота')
      return parsed.data
    },

    async getBlock(slot) {
      const result = await call(
        'getBlock',
        [
          slot,
          {
            encoding: 'json',
            transactionDetails: 'full',
            rewards: false,
            commitment: 'confirmed',
            maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
          },
        ],
        slot,
      )

      const parsed = blockSchema.safeParse(result)
      if (!parsed.success) {
        throw new RpcError(`getBlock(${slot}): відповідь не відповідає схемі блока`)
      }
      return parsed.data
    },
  }
}
