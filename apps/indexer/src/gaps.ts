import { indexerGaps, type Database } from '@fairlane/db'
import { SlotSkippedError, type Logger, type RpcClient } from '@fairlane/shared'
import { eq } from 'drizzle-orm'
import { nextSampleSlot, type SlotHandler } from './loop.ts'

/**
 * Слотів на секунду в Solana. Потрібне тільки для однієї оцінки — чи не старша
 * прогалина за строк зберігання, — і для неї точності вистачає: помилка в
 * кілька відсотків зсуває межу на хвилини при вікні в дві доби.
 */
const SLOTS_PER_SECOND = 2.5

/** Скільки слотів вибірки дочитується за один прохід. */
const DEFAULT_MAX_SLOTS_PER_PASS = 50

/** Скільки прогалин береться за прохід, від найстарішої. */
const DEFAULT_MAX_GAPS_PER_PASS = 5

export type GapReason = 'restart' | 'slot-failed'

export type OpenGap = {
  readonly id: string
  readonly fromSlot: number
  readonly toSlot: number
  readonly reason: string
}

export type GapStore = {
  /** Найсвіжіший слот, який індексатор уже бачив. `null` — база порожня. */
  lastObservedSlot(): Promise<number | null>
  open(gap: { fromSlot: number; toSlot: number; reason: GapReason }): Promise<void>
  listOpen(limit: number): Promise<readonly OpenGap[]>
  /** Просування всередині прогалини: дочитане більше не перечитується. */
  narrow(id: string, fromSlot: number): Promise<void>
  close(id: string): Promise<void>
}

/** Слоти вибірки в межах прогалини — ті самі, що читав би цикл (FR-001). */
export function sampleSlotsInRange(
  fromSlot: number,
  toSlot: number,
  sampleEveryN: number,
): number[] {
  const slots: number[] = []
  const first = fromSlot % sampleEveryN === 0 ? fromSlot : nextSampleSlot(fromSlot, sampleEveryN)

  for (let slot = first; slot <= toSlot; slot += sampleEveryN) slots.push(slot)

  return slots
}

/**
 * Скільки слотів назад іще має сенс дочитувати. Далі за строк зберігання
 * (FR-026) дочитане живе годину-дві й видаляється, а запити до платного RPC
 * витрачені повністю. Така прогалина закривається як невідновна — і саме тому
 * закривається, а не висить у health вічним боргом.
 */
export function gapHorizonSlots(ttlHours: number): number {
  return Math.floor(ttlHours * 3600 * SLOTS_PER_SECOND)
}

/**
 * Розрив від перезапуску. Цикл починає з наступного слота сітки після голови,
 * а не з того, де зупинився: доганяти пропущене всередині циклу означало б
 * відставати від голови тим більше, чим довшим був простій. Пропущене
 * дочитується окремо й у своєму темпі — це і є прогалина (FR-009).
 */
export function detectRestartGap(
  lastObservedSlot: number | null,
  startSlot: number,
  sampleEveryN: number,
): { fromSlot: number; toSlot: number } | null {
  if (lastObservedSlot === null) return null

  const from = lastObservedSlot + 1
  const to = startSlot - 1

  if (from > to) return null
  if (sampleSlotsInRange(from, to, sampleEveryN).length === 0) return null

  return { fromSlot: from, toSlot: to }
}

export function createGapStore(db: Database): GapStore {
  return {
    async lastObservedSlot() {
      // Слот без еталона не пишеться в `slot_refs` (FR-032), а слот без
      // посадок не лишає рядків у `landings`. Найсвіжішим баченим є більший
      // із двох, інакше після тонкого слота прогалина почалась би раніше, ніж
      // насправді, і ми перечитували б уже прочитане.
      const [ref, landing] = await Promise.all([
        db.query.slotRefs.findFirst({
          columns: { slot: true },
          orderBy: (table, { desc }) => desc(table.slot),
        }),
        db.query.landings.findFirst({
          columns: { slot: true },
          orderBy: (table, { desc }) => desc(table.slot),
        }),
      ])

      const slots = [ref?.slot, landing?.slot].filter((slot) => slot !== undefined)

      return slots.length === 0 ? null : Math.max(...slots)
    },

    async open(gap) {
      // Той самий розрив приходить двічі — перезапуском і невдалим слотом.
      // Другий рядок дав би подвійне дочитування й подвійний борг у health.
      const existing = await db.query.indexerGaps.findFirst({
        columns: { id: true },
        where: (table, { and, eq: equals, isNull }) =>
          and(equals(table.fromSlot, gap.fromSlot), isNull(table.healedAt)),
      })

      if (existing) return

      await db.insert(indexerGaps).values(gap)
    },

    async listOpen(limit) {
      return await db.query.indexerGaps.findMany({
        columns: { id: true, fromSlot: true, toSlot: true, reason: true },
        where: (table, { isNull }) => isNull(table.healedAt),
        orderBy: (table, { asc }) => asc(table.fromSlot),
        limit,
      })
    },

    async narrow(id, fromSlot) {
      await db.update(indexerGaps).set({ fromSlot }).where(eq(indexerGaps.id, id))
    },

    async close(id) {
      await db.update(indexerGaps).set({ healedAt: new Date() }).where(eq(indexerGaps.id, id))
    },
  }
}

export type HealGapsOptions = {
  readonly store: GapStore
  readonly rpc: RpcClient
  /** Той самий обробник, що й у циклі: розбір і запис не мають двох версій. */
  readonly onSlot: SlotHandler
  readonly sampleEveryN: number
  readonly logger: Logger
  readonly ttlHours: number
  readonly maxSlotsPerPass?: number
  readonly maxGapsPerPass?: number
}

export type HealReport = {
  readonly slots: number
  readonly closed: number
  readonly abandoned: number
  readonly remaining: number
}

/**
 * Дочитування прогалин (FR-009). Проходить від найстарішої, у межах бюджету
 * слотів на прохід: борг віддається рівномірно й ніколи не займає процес
 * настільки, щоб той відстав від голови — свіжий слот не наздоганяє себе сам,
 * а прогалина чекає скільки завгодно.
 *
 * Дочитування безпечне саме тому, що розбір детермінований, а запис посадок іде
 * `DO NOTHING`: другий прохід тим самим слотом дає ті самі рядки й не оновлює
 * `created_at`, за яким ходить TTL-чистка.
 *
 * Слот, який не дався, зупиняє свою прогалину на собі: наступний прохід почне
 * з нього. Вічним цей борг не стає — прогалина, що вийшла за строк зберігання,
 * закривається як невідновна.
 */
export async function healGaps(options: HealGapsOptions): Promise<HealReport> {
  const { store, rpc, onSlot, sampleEveryN, logger, ttlHours } = options
  const maxSlots = options.maxSlotsPerPass ?? DEFAULT_MAX_SLOTS_PER_PASS
  const maxGaps = options.maxGapsPerPass ?? DEFAULT_MAX_GAPS_PER_PASS

  const gaps = await store.listOpen(maxGaps)

  if (gaps.length === 0) return { slots: 0, closed: 0, abandoned: 0, remaining: 0 }

  const head = await rpc.getSlot()
  const horizon = head - gapHorizonSlots(ttlHours)

  let budget = maxSlots
  let read = 0
  let closed = 0
  let abandoned = 0

  for (const gap of gaps) {
    if (budget <= 0) break

    if (gap.toSlot < horizon) {
      // Дочитане тут прожило б годину-дві й пішло під TTL. Мовчати про це не
      // можна: прогалина закрита не тому, що заповнена.
      logger.warn('прогалина закрита як невідновна: старша за строк зберігання', {
        gap: gap.id,
        fromSlot: gap.fromSlot,
        toSlot: gap.toSlot,
        horizon,
      })
      await store.close(gap.id)
      abandoned += 1
      continue
    }

    const slots = sampleSlotsInRange(Math.max(gap.fromSlot, horizon), gap.toSlot, sampleEveryN)
    let done = 0
    let failed = false

    for (const slot of slots) {
      if (budget <= 0) break

      try {
        await onSlot(await rpc.getBlock(slot), slot)
        read += 1
      } catch (cause) {
        if (!(cause instanceof SlotSkippedError)) {
          logger.error('слот прогалини не дочитано', { gap: gap.id, slot, err: cause })
          failed = true
          break
        }
        // Такого слота не існує і не з'явиться: для прогалини він закритий.
        logger.debug('слот прогалини пропущений у ledger', { gap: gap.id, slot })
      }

      budget -= 1
      done += 1
    }

    // `done` показує на слот, якого не дочитали, — на невдалий або на перший
    // за межею бюджету. Прогалина звужується до нього, і наступний прохід
    // почне саме з нього.
    const next = slots[done]

    if (next === undefined) {
      await store.close(gap.id)
      closed += 1
      logger.info('прогалину дочитано', { gap: gap.id, slots: slots.length })
      continue
    }

    await store.narrow(gap.id, next)
    if (failed) budget = 0
  }

  logger.info('прохід прогалинами завершено', {
    slots: read,
    closed,
    abandoned,
    open: gaps.length - closed - abandoned,
  })

  return { slots: read, closed, abandoned, remaining: gaps.length - closed - abandoned }
}
