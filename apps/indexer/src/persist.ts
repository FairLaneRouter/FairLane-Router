import { type Database, landings as landingsTable } from '@fairlane/db'
import type { Logger, SlotRef } from '@fairlane/shared'
import type { ParsedLanding } from './parse.ts'

/**
 * Посадка, готова до запису: розбір плюс надлишок. `overpay` порожній рівно
 * тоді, коли у слота немає еталона (FR-032) — нуля тут бути не може, бо нуль
 * означає «заплачено рівно стільки, скільки коштувало сісти».
 */
export type LandingRow = ParsedLanding & {
  readonly overpay: bigint | null
}

export type LandingStore = {
  /** Повертає кількість переданих рядків — стільки ж, скільки записано. */
  save(rows: readonly LandingRow[]): Promise<number>
}

/**
 * Скільки рядків іде одним `INSERT`. У Postgres стеля — 65 535 параметрів на
 * вираз, а колонок тут 14; 500 рядків це 7 000 параметрів, з чотирикратним
 * запасом. За кроком вибірки 100 у слоті виходить близько сотні рядків, тож
 * ділення спрацьовує хіба на дочитуванні прогалини пачкою.
 */
const CHUNK_SIZE = 500

export type LandingStoreOptions = {
  readonly chunkSize?: number
}

/**
 * Повторний прохід тим самим слотом (дочитування прогалини, T030) приносить
 * ті самі підписи, і розбір детермінований — значення в них ті самі. Тому
 * `DO NOTHING`, а не перезапис: перезапис оновив би `created_at`, за яким
 * ходить TTL-чистка (T029), і кожне дочитування продовжувало б життя рядка ще
 * на 48 годин. `DO NOTHING` заодно терпить дубль підпису всередині однієї
 * пачки, на відміну від `DO UPDATE`.
 *
 * Розбіжність між проходами можлива лише від поповнення довідника службових
 * акаунтів, і лікується вона перерахунком вікна, а не сваркою на кожен рядок.
 */
export function createLandingStore(db: Database, options: LandingStoreOptions = {}): LandingStore {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE

  return {
    async save(rows) {
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize).map((row) => ({
          ...row,
          programIds: [...row.programIds],
        }))

        await db
          .insert(landingsTable)
          .values(chunk)
          .onConflictDoNothing({ target: landingsTable.signature })
      }

      return rows.length
    },
  }
}

/**
 * Надлишок — різниця повної вартості посадки й еталона слота (FR-006), і він
 * **буває відʼємним**: сісти дешевше за десятий процентиль не помилка, це ті
 * дев'ять відсотків, що під ним. Обрізання в нуль зробило б середній надлишок
 * систематично завищеним, а сторінка методики обіцяє протилежне.
 *
 * Слот без еталона лишає надлишок порожнім у всіх своїх посадках, а самі
 * посадки зберігаються (FR-032).
 */
export function withOverpay(
  landings: readonly ParsedLanding[],
  ref: SlotRef | null,
): LandingRow[] {
  const reference = ref === null ? null : BigInt(ref.refLamports)

  return landings.map((landing) => ({
    ...landing,
    overpay: reference === null ? null : landing.totalCost - reference,
  }))
}

export type PersistLandingsOptions = {
  readonly store: LandingStore
  readonly logger: Logger
}

/**
 * Запис посадок слота (FR-006, FR-039). Категорія «неатрибутовано» ніяк тут не
 * виділяється й нікуди не відкладається: це рядок із порожнім `group_id` у тій
 * самій таблиці, і саме тому його частку видно поруч зі зведенням, а не окремим
 * звітом. Причину порожнечі зберігає `attribution_basis`.
 */
export async function persistLandings(
  landings: readonly ParsedLanding[],
  ref: SlotRef | null,
  options: PersistLandingsOptions,
): Promise<number> {
  const { store, logger } = options

  if (landings.length === 0) {
    logger.debug('у слоті нема чого зберігати', { slot: ref?.slot ?? null })
    return 0
  }

  const rows = withOverpay(landings, ref)
  const saved = await store.save(rows)

  logger.debug('посадки записано', {
    slot: rows[0]?.slot,
    saved,
    unattributed: rows.filter((row) => row.groupId === null).length,
    withOverpay: ref === null ? 0 : saved,
  })

  return saved
}
