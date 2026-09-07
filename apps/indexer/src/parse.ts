import {
  attributeGroup,
  computeLandingCost,
  isTransactionSuccessful,
  isVoteTransaction,
  resolveAccountKeys,
  type AttributionBasis,
  type Block,
  type BlockTransaction,
  type ChannelRegistry,
} from '@fairlane/shared'

/**
 * Посадка, готова до запису в `landings`. Надлишку тут немає навмисно: він
 * рахується від еталона слота, а еталон — предмет T026, і рядок доживає до
 * нього без нього (FR-032, слот без еталона лишає надлишок порожнім).
 *
 * Гроші вже `bigint`: далі по дорозі лише БД, а колонки лампортів — 8-байтові
 * цілі. Межа переведення одна, і вона тут.
 */
export type ParsedLanding = {
  readonly signature: string
  readonly slot: number
  readonly blockTime: Date | null
  readonly baseFee: bigint
  readonly priorityFee: bigint
  readonly tipTotal: bigint
  readonly totalCost: bigint
  readonly cuConsumed: number | null
  /** `null` — «неатрибутовано»: у показники жодної групи не входить (FR-039). */
  readonly groupId: string | null
  readonly attributionBasis: AttributionBasis
  readonly feePayer: string
  readonly programIds: readonly string[]
  /**
   * Рядок пройшов імовірнісну вибірку і представляє `1 / rpcSampleRate`
   * подібних до себе. Згортка (T028) зобовʼязана це врахувати: інакше частка
   * звичайного RPC у зведенні виявиться вдвадцятеро меншою за справжню.
   */
  readonly isSampled: boolean
}

/** Що саме зробив розбір зі слотом — рядок у лог і вхід для наглядача прогалин. */
export type ParseStats = {
  readonly transactions: number
  readonly voting: number
  /** Невотингові, що завершились помилкою, — у посадки не йдуть. */
  readonly failed: number
  /** Успішні невотингові: усе, що могло стати посадкою. */
  readonly candidates: number
  readonly stored: number
  readonly droppedBySampling: number
  /** Транзакція без жодного акаунта — платника немає, зберігати нічого. */
  readonly malformed: number
}

export type ParsedBlock = {
  readonly slot: number
  readonly blockTime: Date | null
  readonly landings: readonly ParsedLanding[]
  readonly stats: ParseStats
}

export type ParseBlockOptions = {
  readonly registry: ChannelRegistry
  /** Частка транзакцій без чайових, яка зберігається (`RPC_SAMPLE_RATE`). */
  readonly rpcSampleRate: number
  /** Підміняється в тестах; у роботі — детермінований хеш підпису. */
  readonly shouldSample?: (signature: string, rate: number) => boolean
}

const FNV_OFFSET_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619

/**
 * Рівномірна частка 0…1 з підпису транзакції. Детермінована навмисно:
 * `Math.random()` дав би при дочитуванні прогалини (T030) інший набір
 * збережених рядків, ніж перший прохід, і та сама транзакція то зʼявлялась би
 * у вибірці, то зникала з неї. З хешем підпису повторний розбір того самого
 * блока дає той самий результат — і збіг можна перевірити збоку.
 */
export function signatureFraction(signature: string): number {
  let hash = FNV_OFFSET_BASIS

  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return (hash >>> 0) / 2 ** 32
}

function sampleBySignature(signature: string, rate: number): boolean {
  if (rate <= 0) return false
  if (rate >= 1) return true

  return signatureFraction(signature) < rate
}

/**
 * Тільки інструкції верхнього рівня. Вкладені (`innerInstructions`) — це вже
 * розгортка CPI: обсяг більший у рази, а на питання «що це була за
 * транзакція» відповідає й зовнішній список.
 */
function collectProgramIds(tx: BlockTransaction, accountKeys: readonly string[]): string[] {
  const programIds: string[] = []
  const seen = new Set<string>()

  for (const instruction of tx.transaction.message.instructions) {
    const programId = accountKeys[instruction.programIdIndex]
    if (programId === undefined || seen.has(programId)) continue

    seen.add(programId)
    programIds.push(programId)
  }

  return programIds
}

/**
 * Розбір блока в посадки (FR-001, FR-003). Три рішення, які тут ухвалюються:
 *
 * 1. **Посадка — успішна невотингова транзакція.** Вотингові виключені за
 *    FR-031, а невдалі — тому, що в `landings` немає колонки результату: рядок
 *    там означає «стільки коштувало сісти», і невдала спроба, змішана з
 *    вдалими, зсунула б статистику групи, не будучи від неї відрізненною.
 * 2. **Усе з чайовими зберігається, решта — вибірково** (`RPC_SAMPLE_RATE`,
 *    PLAN → «Вибірка»). Транзакції з чайовими — меншість, і саме вони несуть
 *    сенс продукту; звичайний RPC потрібен лише як фон, і зберігати його
 *    цілком означає вичерпати 500 МБ тарифу за кілька діб.
 * 3. **Суперечливі теж зберігаються повністю** — `basis: 'ambiguous'` це
 *    вимір межі методу (SC-009), а не сміття: проріджена вибірка зробила б
 *    частку «неатрибутовано» неспівставною з частками груп.
 *
 * Еталон слота рахується окремо і по **всіх** невотингових транзакціях, до
 * відкидання вибіркою (T026) — тому проріджування тут на нього не впливає.
 */
export function parseBlock(block: Block, slot: number, options: ParseBlockOptions): ParsedBlock {
  const { registry, rpcSampleRate } = options

  if (!Number.isFinite(rpcSampleRate) || rpcSampleRate < 0 || rpcSampleRate > 1) {
    throw new RangeError(`rpcSampleRate має бути в межах 0…1, отримано ${rpcSampleRate}`)
  }

  const shouldSample = options.shouldSample ?? sampleBySignature
  const blockTime =
    block.blockTime === null || block.blockTime === undefined
      ? null
      : new Date(block.blockTime * 1000)

  const landings: ParsedLanding[] = []
  let voting = 0
  let failed = 0
  let candidates = 0
  let droppedBySampling = 0
  let malformed = 0

  for (const tx of block.transactions) {
    if (isVoteTransaction(tx)) {
      voting += 1
      continue
    }

    if (!isTransactionSuccessful(tx)) {
      failed += 1
      continue
    }

    candidates += 1

    const accountKeys = resolveAccountKeys(tx)
    const feePayer = accountKeys[0]
    const signature = tx.transaction.signatures[0]

    // Платник — нульовий акаунт повідомлення, і він же перший підписант.
    // Транзакції без них не буває; якщо джерело таку віддало, вона зіпсована.
    if (feePayer === undefined || signature === undefined) {
      malformed += 1
      continue
    }

    const cost = computeLandingCost(tx, registry.tipAccounts)
    const attribution = attributeGroup(cost, registry)

    const isTipped = attribution.basis === 'tip' || attribution.basis === 'ambiguous'
    const isSampled = !isTipped

    if (isSampled && !shouldSample(signature, rpcSampleRate)) {
      droppedBySampling += 1
      continue
    }

    landings.push({
      signature,
      slot,
      blockTime,
      baseFee: BigInt(cost.baseFee),
      priorityFee: BigInt(cost.priorityFee),
      tipTotal: BigInt(cost.tipTotal),
      totalCost: BigInt(cost.total),
      cuConsumed: cost.computeUnits,
      groupId: attribution.groupId,
      attributionBasis: attribution.basis,
      feePayer,
      programIds: collectProgramIds(tx, accountKeys),
      isSampled,
    })
  }

  return {
    slot,
    blockTime,
    landings,
    stats: {
      transactions: block.transactions.length,
      voting,
      failed,
      candidates,
      stored: landings.length,
      droppedBySampling,
      malformed,
    },
  }
}
