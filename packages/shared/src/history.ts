import { z } from 'zod'
import type { ChannelGroup } from './channels.ts'
import { MIN_GROUP_OBSERVATIONS } from './summary.ts'
import { HOUR_MS, startOfHour } from './time.ts'

/** Доба — вікно, якого вимагає FR-013. Воно ж за замовчуванням. */
export const DEFAULT_HISTORY_HOURS = 24

/**
 * Стеля запиту — строк зберігання агрегатів (FR-026: 90 днів). Просити
 * більше немає сенсу: за цією межею рядків не існує, і відповідь мовчки
 * виглядала б як «нічого не було», а не як «ми цього не памʼятаємо».
 */
export const MAX_HISTORY_HOURS = 24 * 90

export const historyHoursSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_HISTORY_HOURS)
  .default(DEFAULT_HISTORY_HOURS)

/** Рядок `group_hourly` у тому вигляді, в якому його віддає сховище. */
export type HourlyPoint = {
  readonly groupId: string
  readonly hour: Date
  /** Зважена вибіркою оцінка обсягу. */
  readonly landings: number
  /** Скільки рядків стоїть за годиною — до цього числа й поріг (FR-012). */
  readonly observations: number
  readonly costP50: bigint
  /** `null` — у цій годині жодна посадка не мала еталона слота (FR-032). */
  readonly overpayP50: bigint | null
  readonly share: number
}

const lamportsNumber = z.number().int()

export const historyPointSchema = z.object({
  hour: z.iso.datetime(),
  landings: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  costP50: lamportsNumber,
  overpayP50: lamportsNumber.nullable(),
  share: z.number().min(0).max(1),
})

export const historySeriesSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  isSendable: z.boolean(),
  /** Від старої години до свіжої. Годин без даних тут немає взагалі. */
  points: z.array(historyPointSchema),
})

export const historySchema = z.object({
  generatedAt: z.iso.datetime(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  hours: z.number().int().positive(),
  /** Скільки годин діапазону мають хоч один рядок — глибина того, що є. */
  coveredHours: z.number().int().nonnegative(),
  /** Поріг, нижче якого година в ряд не потрапляє — щоб його було видно. */
  minObservations: z.number().int().positive(),
  series: z.array(historySeriesSchema),
})

export type HistoryPoint = z.infer<typeof historyPointSchema>
export type HistorySeries = z.infer<typeof historySeriesSchema>
export type History = z.infer<typeof historySchema>

export type HistoryRange = {
  readonly from: Date
  readonly to: Date
}

/**
 * Межі запиту, вирівняні по сітці годин. Верхня межа — початок **поточної**
 * години, і вона виключна: рядка для неї ще немає й не має бути, бо згортка
 * пише лише завершені години. Малювати поточну як нуль означало б щогодини
 * показувати падіння надлишку в підлогу, якого не було.
 */
export function historyRange(now: Date, hours: number): HistoryRange {
  const to = startOfHour(now)

  return { from: new Date(to.getTime() - hours * HOUR_MS), to }
}

export type BuildHistoryOptions = {
  readonly groups: readonly ChannelGroup[]
  readonly points: readonly HourlyPoint[]
  readonly range: HistoryRange
  readonly hours: number
  readonly now: Date
  readonly minObservations?: number
}

function toJsonLamports(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`сума ${value} не вміщається в безпечне ціле JSON`)
  }

  return Number(value)
}

/**
 * Добова динаміка медіанного надлишку по групах (FR-013).
 *
 * Три рішення:
 *
 * 1. **Година без рядка не стає нулем і не стає точкою.** Її просто немає в
 *    ряді. Нуль означав би «надлишку не було», а насправді означає «ми не
 *    дивились» — на графіку ці два твердження виглядають однаково, тому
 *    відрізняти їх мусять дані, а не читач.
 * 2. **Група без жодної точки в ряд не потрапляє.** Порожня лінія в легенді
 *    неможлива до прочитання: вона однаково виглядає і як «канал мовчав», і
 *    як «канал дешевий».
 * 3. **`coveredHours` показується поруч із графіком.** Історія рівно така,
 *    скільки працював індексатор, і сказати це числом чесніше, ніж малювати
 *    добову вісь під однією точкою.
 * 4. **Поріг «недостатньо даних» той самий, що у зведенні** (FR-012), і
 *    застосовується до сирої кількості рядків. Без цього дашборд суперечив би
 *    сам собі в одну й ту саму секунду: таблиця казала б «Nozomi —
 *    недостатньо даних» на двадцяти спостереженнях, а графік поруч малював би
 *    Nozomi лінією на мільйон лампортів.
 */
export function buildHistory(options: BuildHistoryOptions): History {
  const { groups, points, range, hours, now } = options
  const minObservations = options.minObservations ?? MIN_GROUP_OBSERVATIONS

  const byGroup = new Map<string, HistoryPoint[]>()
  const coveredHours = new Set<number>()

  for (const point of points) {
    coveredHours.add(point.hour.getTime())
    if (point.observations < minObservations) continue

    const series = byGroup.get(point.groupId) ?? []
    series.push({
      hour: point.hour.toISOString(),
      landings: point.landings,
      observations: point.observations,
      costP50: toJsonLamports(point.costP50),
      overpayP50: point.overpayP50 === null ? null : toJsonLamports(point.overpayP50),
      share: point.share,
    })
    byGroup.set(point.groupId, series)
  }

  const series = groups
    .filter((group) => byGroup.has(group.id))
    .map((group) => ({
      groupId: group.id,
      name: group.name,
      members: [...group.memberNames],
      isSendable: group.canSend,
      points: [...(byGroup.get(group.id) ?? [])].sort((left, right) =>
        left.hour < right.hour ? -1 : 1,
      ),
    }))

  return {
    generatedAt: now.toISOString(),
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    hours,
    coveredHours: coveredHours.size,
    minObservations,
    series,
  }
}
