import { type Database, slotRefs } from '@fairlane/db'
import {
  computeSlotRef,
  isSlotRefSample,
  MIN_SLOT_REF_SAMPLES,
  type Block,
  type Logger,
  type SlotRef,
} from '@fairlane/shared'

/** Рядок `slot_refs`. Лампорти вже `bigint` — межа переведення проходить тут. */
export type SlotRefRow = {
  readonly slot: number
  readonly refLamports: bigint
  readonly sampleCount: number
}

/**
 * Вузьке місце запису. Обчислення відокремлене від БД навмисно: так тест
 * еталона не потребує ні Postgres, ні мережі, а `recordSlotRef` перевіряється
 * підставним сховищем.
 */
export type SlotRefStore = {
  save(row: SlotRefRow): Promise<void>
}

/**
 * Той самий слот може прийти вдруге — дочитуванням прогалини (T030) або після
 * перезапуску. Блок при цьому незмінний, тому й еталон незмінний, і сварка
 * первинного ключа тут була б панікою на порожньому місці. Перезапис, а не
 * `DO NOTHING`: якщо між проходами поповнився довідник службових акаунтів,
 * друге обчислення точніше за перше, і саме воно має лишитись.
 */
export function createSlotRefStore(db: Database): SlotRefStore {
  return {
    async save(row) {
      await db
        .insert(slotRefs)
        .values(row)
        .onConflictDoUpdate({
          target: slotRefs.slot,
          set: {
            refLamports: row.refLamports,
            sampleCount: row.sampleCount,
            // Час нашого обчислення, а не БД: сирий `now()` тягнув би пряму
            // залежність індексатора на drizzle-orm заради одного виразу.
            computedAt: new Date(),
          },
        })
    },
  }
}

export type RecordSlotRefOptions = {
  readonly store: SlotRefStore
  readonly tipAccounts: ReadonlySet<string>
  readonly logger: Logger
  /** Перекривається тільки в тестах — поріг FR-032 живе в `packages/shared`. */
  readonly minSamples?: number
}

/**
 * Еталон слота (FR-005) рахується по **всіх** успішних невотингових
 * транзакціях блока — до того, як вибірка `parseBlock` щось відкине. Саме це
 * робить надлишок чесним: проріджування міняє обсяг збережених спостережень,
 * але не величину, відносно якої вони міряються.
 *
 * Слот, у якому таких транзакцій менше за поріг, лишається без еталона і в
 * `slot_refs` не пишеться взагалі (FR-032): нуль у цій колонці означав би
 * «сісти коштувало нічого», і надлишком стала б уся ціна доставки. Його
 * посадки все одно зберігаються — просто з порожнім надлишком.
 */
export async function recordSlotRef(
  block: Block,
  slot: number,
  options: RecordSlotRefOptions,
): Promise<SlotRef | null> {
  const { store, tipAccounts, logger } = options
  const minSamples = options.minSamples ?? MIN_SLOT_REF_SAMPLES

  const ref = computeSlotRef(slot, block.transactions, tipAccounts, { minSamples })

  if (ref === null) {
    // Рідкісний випадок: калібрування дало медіану 435 успішних невотингових
    // при порозі 50. Частий warn тут означає, що змінилась мережа або джерело.
    logger.warn('слот лишається без еталона', {
      slot,
      samples: block.transactions.filter(isSlotRefSample).length,
      minSamples,
    })
    return null
  }

  await store.save({
    slot: ref.slot,
    refLamports: BigInt(ref.refLamports),
    sampleCount: ref.sampleCount,
  })

  logger.debug('еталон слота записано', {
    slot: ref.slot,
    refLamports: ref.refLamports,
    samples: ref.sampleCount,
  })

  return ref
}
