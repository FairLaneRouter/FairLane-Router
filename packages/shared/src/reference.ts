import { computeLandingCost, isVoteTransaction } from './cost.ts'
import type { BlockTransaction } from './rpc.ts'

/** Процентиль повної вартості посадки, який береться за еталон слота (FR-005). */
export const SLOT_REF_PERCENTILE = 10

/**
 * Нижче цієї кількості успішних невотингових транзакцій слот лишається без
 * еталона (FR-032). Десятий процентиль по десятку спостережень — це просто
 * найдешевша з них, і випадкова аномально дешева посадка стає «нормою слота»
 * для всіх інших. Значення можна перекрити на виклику, коли калібрування
 * джерела (T023) покаже фактичний розподіл наповненості слотів.
 */
export const MIN_SLOT_REF_SAMPLES = 50

export type SlotRef = {
  readonly slot: number
  readonly refLamports: number
  readonly sampleCount: number
}

export type SlotRefOptions = {
  readonly minSamples?: number
}

/**
 * Метод найближчого рангу, без інтерполяції між сусідами: результат завжди є
 * сумою, яку хтось справді заплатив, і його видно в оглядачі блоків. Середнє
 * двох сусідів дало б дробові лампорти, яких у ланцюзі немає, і зробило б
 * ручну перевірку обчислення (FR-045) неможливою.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new RangeError('percentile: порожня вибірка не має процентиля')
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile: p має бути в межах 0…100, отримано ${p}`)
  }

  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const value = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]

  // Індекс обрізаний до меж масиву вище; гілка недосяжна і потрібна лише типам.
  if (value === undefined) throw new RangeError('percentile: індекс поза межами вибірки')

  return value
}

export function isTransactionSuccessful(tx: BlockTransaction): boolean {
  return tx.meta.err === null || tx.meta.err === undefined
}

/**
 * Вибірка еталона — успішні невотингові транзакції слота (FR-005, FR-031).
 * Вотингові платять лише базову комісію і становлять більшість блока: з ними
 * еталон падає майже в нуль, і надлишком помилково стає вся ціна доставки.
 */
export function isSlotRefSample(tx: BlockTransaction): boolean {
  return isTransactionSuccessful(tx) && !isVoteTransaction(tx)
}

/**
 * Еталон рахується по **всіх** невотингових транзакціях слота, до відкидання
 * вибіркою збереження, — інакше `p10` міряв би не слот, а те, що ми вирішили
 * зберегти. Слот без еталона повертає `null` і в БД не пишеться взагалі: його
 * посадки зберігаються, але надлишку в них немає (FR-032).
 */
export function computeSlotRef(
  slot: number,
  transactions: readonly BlockTransaction[],
  tipAccounts: ReadonlySet<string>,
  options: SlotRefOptions = {},
): SlotRef | null {
  const minSamples = options.minSamples ?? MIN_SLOT_REF_SAMPLES
  const totals: number[] = []

  for (const tx of transactions) {
    if (!isSlotRefSample(tx)) continue
    totals.push(computeLandingCost(tx, tipAccounts).total)
  }

  if (totals.length < minSamples) return null

  return {
    slot,
    refLamports: percentile(totals, SLOT_REF_PERCENTILE),
    sampleCount: totals.length,
  }
}
