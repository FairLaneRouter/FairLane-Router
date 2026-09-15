import { z } from 'zod'
import type { ChannelGroup } from './channels.ts'

/**
 * Вікна зведення (FR-010). Три і рівно три: 15 хвилин — «що коштує посадка
 * зараз», година — робочий масштаб дашборду, доба — межа потранзакційного
 * рівня, за яку зведення вже не має з чого рахуватись без агрегатів.
 */
export const SUMMARY_WINDOWS = ['15m', '1h', '24h'] as const

export type SummaryWindow = (typeof SUMMARY_WINDOWS)[number]

export const summaryWindowSchema = z.enum(SUMMARY_WINDOWS)

export const SUMMARY_WINDOW_MS: Readonly<Record<SummaryWindow, number>> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
}

/** Вікно за замовчуванням: година — масштаб, у якому всі групи мають числа. */
export const DEFAULT_SUMMARY_WINDOW: SummaryWindow = '1h'

/**
 * Нижче цієї кількості **сирих** спостережень група показується як
 * «недостатньо даних» і не бере участі в ранжуванні (FR-012).
 *
 * Число те саме, що й поріг еталона слота, і з тієї ж причини: зведення
 * показує p10 і p90, а вони мають спиратись щонайменше на п'ять спостережень
 * з кожного краю — при п'ятдесяти їх рівно п'ять. Нижче цього p90 стає
 * найдорожчою транзакцією вибірки, а не дев'яностим процентилем групи.
 *
 * Поріг застосовується до сирої кількості рядків, **не** до зваженої оцінки
 * `landings`. Вибірка звичайного RPC збережена з часткою `RPC_SAMPLE_RATE`, і
 * зважена кількість там у двадцять разів більша за кількість спостережень, на
 * які насправді спираються процентилі. Порівнювати з порогом зважене число
 * означало б оголошувати достатніми дані, яких немає.
 */
export const MIN_GROUP_OBSERVATIONS = 50

/** Середня тривалість слота Solana. Потрібна лише для оцінки віку даних. */
const SLOT_TIME_MS = 400

/**
 * Скільки інтервалів вибірки поспіль має мовчати індексатор, щоб зведення
 * оголосило дані застарілими. Три — це два пропущені слоти вибірки поспіль:
 * один пропуск буває від разової помилки RPC і сам себе лікує дочитуванням
 * (T030), а два підряд означають, що збір справді стоїть.
 */
const STALE_AFTER_INTERVALS = 3

/**
 * Нижня межа порога свіжості. За малих `SAMPLE_EVERY_N` три інтервали
 * вибірки стають секундами, і зведення блимало б «застаріло» від звичайного
 * відставання читача від голови ланцюга (запас 32 слоти, ~13 секунд).
 */
const MIN_STALE_AFTER_MS = 60_000

/**
 * Поріг, після якого зведення позначається застарілим (FR-015). Рахується від
 * кроку вибірки, а не константою: крок — змінна оточення, і при його зміні
 * поріг має рухатись сам, інакше він або мовчить завжди, або кричить завжди.
 */
export function staleAfterMs(sampleEveryN: number): number {
  if (!Number.isInteger(sampleEveryN) || sampleEveryN < 1) {
    throw new RangeError(`sampleEveryN має бути цілим і не менше 1, отримано ${sampleEveryN}`)
  }

  return Math.max(MIN_STALE_AFTER_MS, sampleEveryN * SLOT_TIME_MS * STALE_AFTER_INTERVALS)
}

/**
 * Агрегат по одній групі за вікно — те, що сховище вміє порахувати запитом.
 * `groupId: null` — «неатрибутовано» (FR-039): власним рядком у відповідь не
 * потрапляє, але у знаменник часток входить.
 */
export type GroupAggregate = {
  readonly groupId: string | null
  /** Скільки рядків справді збережено — міра доказовості, не оцінка обсягу. */
  readonly observations: number
  /** Зважена вибіркою оцінка кількості посадок у оглянутих слотах. */
  readonly landings: number
  /** Скільки з них мали еталон слота: медіана надлишку стоїть саме на них. */
  readonly overpayObservations: number
  readonly costP10: bigint | null
  readonly costP50: bigint | null
  readonly costP90: bigint | null
  readonly overpayP50: bigint | null
}

/** Те, що описує саме вікно, а не окрему групу (FR-015). */
export type SummaryWindowFacts = {
  readonly slotsSampled: number
  readonly firstBlockTime: Date | null
  readonly lastBlockTime: Date | null
}

const lamportsNumber = z.number().int()

export const summaryGroupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  /** Бренди всередині групи. Ончейн вони нерозрізненні (FR-038). */
  members: z.array(z.string()),
  observations: z.number().int().nonnegative(),
  overpayObservations: z.number().int().nonnegative(),
  landings: z.number().int().nonnegative().nullable(),
  costP10: lamportsNumber.nullable(),
  costP50: lamportsNumber.nullable(),
  costP90: lamportsNumber.nullable(),
  /** Надлишок буває від'ємним: сісти дешевше за p10 слота не помилка. */
  overpayP50: lamportsNumber.nullable(),
  share: z.number().min(0).max(1).nullable(),
  /** Ознака довідника і наявного ендпоінта — «спостерігаємо» ще не «шлемо». */
  isSendable: z.boolean(),
  sufficientData: z.boolean(),
})

export const summaryUnattributedSchema = z.object({
  observations: z.number().int().nonnegative(),
  landings: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
})

export const summarySchema = z.object({
  window: summaryWindowSchema,
  /** Коли зведення обчислене. Через кеш може бути раніше за момент запиту. */
  generatedAt: z.iso.datetime(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  slotsSampled: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  landings: z.number().int().nonnegative(),
  firstBlockTime: z.iso.datetime().nullable(),
  lastBlockTime: z.iso.datetime().nullable(),
  /** Вік найсвіжішої посадки у вікні; `null` — вікно порожнє. */
  dataAgeMs: z.number().int().nonnegative().nullable(),
  isStale: z.boolean(),
  /** Поріг, за яким група оголошена «недостатньо даних» — щоб його було видно. */
  minObservations: z.number().int().positive(),
  groups: z.array(summaryGroupSchema),
  unattributed: summaryUnattributedSchema,
})

export type SummaryGroup = z.infer<typeof summaryGroupSchema>
export type SummaryUnattributed = z.infer<typeof summaryUnattributedSchema>
export type Summary = z.infer<typeof summarySchema>

export class LamportsRangeError extends Error {
  override readonly name = 'LamportsRangeError'
}

/**
 * Межа, на якій лампорти перестають бути `bigint`: у JSON вони йдуть числом,
 * бо таким їх віддає і приймає весь зовнішній світ — зокрема сам JSON-RPC
 * Solana. Перевірка тут не декоративна: за межею безпечного цілого JS
 * `Number()` мовчки округлив би суму, і зведення показало б неправду замість
 * помилки. Реальні вартості посадки на десять порядків менші за цю межу, тож
 * спрацювання означає зіпсовані дані, а не тісний тип.
 */
function toJsonLamports(value: bigint | null): number | null {
  if (value === null) return null

  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new LamportsRangeError(`сума ${value} не вміщається в безпечне ціле JSON`)
  }

  return Number(value)
}

export type BuildSummaryOptions = {
  readonly window: SummaryWindow
  /** Довідник каналів — джерело назв, складу груп і ознаки відправки. */
  readonly groups: readonly ChannelGroup[]
  readonly aggregates: readonly GroupAggregate[]
  readonly facts: SummaryWindowFacts
  readonly now: Date
  readonly staleAfterMs: number
  readonly minObservations?: number
}

const EMPTY_AGGREGATE: GroupAggregate = {
  groupId: null,
  observations: 0,
  landings: 0,
  overpayObservations: 0,
  costP10: null,
  costP50: null,
  costP90: null,
  overpayP50: null,
}

/**
 * Зведення по групах каналів за вікно (FR-010, FR-012, FR-015). Чотири
 * рішення, які тут ухвалюються:
 *
 * 1. **Групі з недостатніми даними чисел не повертається взагалі** — `null`, а
 *    не нуль (FR-012). Нуль у медіані означав би «сісти коштувало нічого», а
 *    не «спостережень мало». Сира кількість `observations` при цьому
 *    показується завжди: саме вона пояснює, чому чисел немає.
 * 2. **Знаменник часток — увесь зважений підсумок вікна**, включно з
 *    «неатрибутовано» і з групами, яким чисел не дали. Тому видимі частки в
 *    сумі дають менше одиниці, і різниця — це рівно те, чого ми не знаємо або
 *    не наважуємось стверджувати. Нормувати частки по видимих групах означало
 *    б роздати невідоме тим, хто випадково потрапив у вибірку.
 * 3. **Група з довідника без жодної посадки все одно є у відповіді** — з
 *    порожніми числами. Мовчазне зникнення групи з таблиці не відрізнити від
 *    «такого каналу не буває», а це різні твердження (FR-041).
 * 4. **Порожнє вікно застаріле.** `dataAgeMs: null` означає «свіжості немає з
 *    чого рахувати», і оголошувати такі дані свіжими не можна.
 */
export function buildSummary(options: BuildSummaryOptions): Summary {
  const { window, groups, aggregates, facts, now } = options
  const minObservations = options.minObservations ?? MIN_GROUP_OBSERVATIONS
  const from = new Date(now.getTime() - SUMMARY_WINDOW_MS[window])

  const byGroup = new Map<string, GroupAggregate>()
  let unattributed = EMPTY_AGGREGATE
  let totalLandings = 0
  let totalObservations = 0

  for (const aggregate of aggregates) {
    // Підсумок збирається до розбору на групи: рядок групи, якої більше немає
    // в довіднику, власного місця у відповіді не отримає, але зі знаменника
    // не зникає — інакше частки решти виявились би завищеними.
    totalLandings += aggregate.landings
    totalObservations += aggregate.observations

    if (aggregate.groupId === null) {
      unattributed = aggregate
      continue
    }

    byGroup.set(aggregate.groupId, aggregate)
  }

  const rows: SummaryGroup[] = groups
    .filter((group) => group.isObserved)
    .map((group) => {
      const aggregate = byGroup.get(group.id) ?? EMPTY_AGGREGATE
      const sufficientData = aggregate.observations >= minObservations

      return {
        groupId: group.id,
        name: group.name,
        members: [...group.memberNames],
        observations: aggregate.observations,
        overpayObservations: aggregate.overpayObservations,
        landings: sufficientData ? aggregate.landings : null,
        costP10: sufficientData ? toJsonLamports(aggregate.costP10) : null,
        costP50: sufficientData ? toJsonLamports(aggregate.costP50) : null,
        costP90: sufficientData ? toJsonLamports(aggregate.costP90) : null,
        overpayP50: sufficientData ? toJsonLamports(aggregate.overpayP50) : null,
        share:
          sufficientData && totalLandings > 0 ? aggregate.landings / totalLandings : null,
        isSendable: group.canSend,
        sufficientData,
      }
    })

  const dataAge =
    facts.lastBlockTime === null
      ? null
      : Math.max(0, now.getTime() - facts.lastBlockTime.getTime())

  return {
    window,
    generatedAt: now.toISOString(),
    from: from.toISOString(),
    to: now.toISOString(),
    slotsSampled: facts.slotsSampled,
    observations: totalObservations,
    landings: totalLandings,
    firstBlockTime: facts.firstBlockTime?.toISOString() ?? null,
    lastBlockTime: facts.lastBlockTime?.toISOString() ?? null,
    dataAgeMs: dataAge,
    isStale: dataAge === null || dataAge > options.staleAfterMs,
    minObservations,
    groups: rankGroups(rows),
    unattributed: {
      observations: unattributed.observations,
      landings: unattributed.landings,
      share: totalLandings > 0 ? unattributed.landings / totalLandings : 0,
    },
  }
}

/**
 * Порядок у відповіді і є ранжуванням: дешевші попереду. Групи з недостатніми
 * даними в ранжуванні не беруть участі (FR-012) — вони йдуть після всіх,
 * упорядковані за кількістю спостережень, тобто за тим, наскільки близько
 * кожна з них до того, щоб отримати числа.
 */
function rankGroups(rows: readonly SummaryGroup[]): SummaryGroup[] {
  return [...rows].sort((left, right) => {
    if (left.sufficientData !== right.sufficientData) return left.sufficientData ? -1 : 1

    if (left.sufficientData) {
      const cost = (left.costP50 ?? 0) - (right.costP50 ?? 0)
      if (cost !== 0) return cost
    } else if (left.observations !== right.observations) {
      return right.observations - left.observations
    }

    return left.groupId < right.groupId ? -1 : 1
  })
}
