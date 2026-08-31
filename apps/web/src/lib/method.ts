/**
 * Числа, за якими стороння людина перераховує надлишок вручну (SC-010). Вони
 * дублюють константи `@fairlane/shared` навмисно: тягнути пакет у браузерний
 * бандл заради чотирьох цілих означало б привезти з ним Zod і читання конфігу.
 * Від розходження з кодом сторінку боронить `method.test.ts` — він порівнює
 * ці значення з реальними при кожному прогоні гейта.
 */

/** `packages/shared/src/cost.ts` → `BASE_FEE_PER_SIGNATURE`. */
export const BASE_FEE_PER_SIGNATURE = 5000

/** `packages/shared/src/reference.ts` → `SLOT_REF_PERCENTILE`. */
export const SLOT_REF_PERCENTILE = 10

/** `packages/shared/src/reference.ts` → `MIN_SLOT_REF_SAMPLES`. */
export const MIN_SLOT_REF_SAMPLES = 50

/** Потранзакційний рівень зберігання, години (FR-026). */
export const TRANSACTION_LEVEL_HOURS = 48

/** Годинні агрегати, доби (FR-026, FR-043). */
export const AGGREGATE_LEVEL_DAYS = 90
