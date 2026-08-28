import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Дві різні числові домовленості, і плутати їх не можна:
 *
 * - **гроші** — `bigint` у лампортах, ніколи не число з плаваючою комою;
 * - **слоти** — теж 8 байтів у Postgres, але в JS лишаються `number`, бо саме
 *   так їх віддає JSON-RPC і приймає `packages/shared`. Номер слота Solana
 *   вичерпає безпечне ціле JS приблизно за пів мільйона років.
 */
const lamports = (name: string) => bigint(name, { mode: 'bigint' })
const slotNumber = (name: string) => bigint(name, { mode: 'number' })

/**
 * `.default(0n)` валить `drizzle-kit generate`: знімок схеми йде через
 * `JSON.stringify`, а той на `bigint` кидає TypeError. Сирий SQL дає ту саму
 * колонку і той самий DEFAULT 0, лише повз серіалізацію.
 */
const ZERO_LAMPORTS = sql`0`

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const recommendationMode = pgEnum('recommendation_mode', ['cheap', 'fast'])

export const comparisonStatus = pgEnum('comparison_status', [
  'pending',
  'complete',
  'partial',
  'failed',
])

/**
 * Чим доведена належність до групи (FR-039). `null` у `groupId` буває з двох
 * різних приводів — «жодного сліду доставки» і «сліди двох груп одразу», — і
 * без цієї колонки вони злилися б в одну частку «неатрибутовано».
 */
export const attributionBasis = pgEnum('attribution_basis', [
  'tip',
  'priority-fee',
  'ambiguous',
  'none',
])

export const channelGroups = pgTable('channel_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  memberNames: text('member_names').array().notNull(),
  isSendable: boolean('is_sendable').notNull().default(false),
  createdAt,
})

export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  groupId: text('group_id')
    .notNull()
    .references(() => channelGroups.id),
  name: text('name').notNull(),
  tipAccounts: text('tip_accounts').array().notNull(),
  isObserved: boolean('is_observed').notNull().default(true),
  isSendable: boolean('is_sendable').notNull().default(false),
  /** Назва змінної оточення, ніколи не її значення — ендпоінти є секретами. */
  endpointEnvKey: text('endpoint_env_key'),
  sourceUrl: text('source_url'),
  createdAt,
})

/** Еталон слота. Слот без достатньої вибірки не пишеться взагалі (FR-032). */
export const slotRefs = pgTable('slot_refs', {
  slot: slotNumber('slot').primaryKey(),
  refLamports: lamports('ref_lamports').notNull(),
  sampleCount: integer('sample_count').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Потранзакційний рівень зберігання, TTL 48 год (FR-026). */
export const landings = pgTable(
  'landings',
  {
    signature: text('signature').primaryKey(),
    slot: slotNumber('slot').notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    baseFee: lamports('base_fee').notNull(),
    priorityFee: lamports('priority_fee').notNull(),
    tipTotal: lamports('tip_total').notNull(),
    totalCost: lamports('total_cost').notNull(),
    cuConsumed: integer('cu_consumed'),
    /** `null` — «неатрибутовано»: у показники жодної групи не входить (FR-039). */
    groupId: text('group_id').references(() => channelGroups.id),
    attributionBasis: attributionBasis('attribution_basis').notNull(),
    /** `null`, якщо у слота немає еталона — нуля тут бути не може (FR-032). */
    overpay: lamports('overpay'),
    feePayer: text('fee_payer').notNull(),
    programIds: text('program_ids').array().notNull(),
    /** Транзакції звичайного RPC зберігаються вибірково (`RPC_SAMPLE_RATE`). */
    isSampled: boolean('is_sampled').notNull().default(false),
    createdAt,
  },
  (table) => [
    index('landings_slot_idx').on(table.slot),
    index('landings_group_time_idx').on(table.groupId, table.blockTime),
    index('landings_payer_time_idx').on(table.feePayer, table.blockTime),
    // TTL-чистка (T029) ходить саме цим порядком.
    index('landings_created_at_idx').on(table.createdAt),
  ],
)

/** Годинні агрегати, TTL 90 днів (FR-026, FR-043). Пишуться з M1 (T028). */
export const groupHourly = pgTable(
  'group_hourly',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => channelGroups.id),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    landingsCount: integer('landings_count').notNull(),
    costP10: lamports('cost_p10').notNull(),
    costP50: lamports('cost_p50').notNull(),
    costP90: lamports('cost_p90').notNull(),
    overpayP50: lamports('overpay_p50'),
    /** Частки, а не гроші: 0…1, тому дробові тут доречні. */
    share: doublePrecision('share').notNull(),
    unattributedShare: doublePrecision('unattributed_share').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.hour] }),
    index('group_hourly_hour_idx').on(table.hour),
  ],
)

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Тільки хеш: сам ключ показується один раз при видачі (FR-046). */
  keyHash: text('key_hash').notNull().unique(),
  label: text('label'),
  createdAt,
  /** Відкликання не стирає лічильників використання (FR-048). */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const keyUsage = pgTable(
  'key_usage',
  {
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    requests: integer('requests').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.hour] })],
)

/** Видані поради — зберігаються, щоб порівняти пораду з фактом (T046). */
export const recommendations = pgTable('recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').references(() => apiKeys.id),
  createdAt,
  mode: recommendationMode('mode').notNull(),
  groupId: text('group_id')
    .notNull()
    .references(() => channelGroups.id),
  tipLamports: lamports('tip_lamports').notNull(),
  priorityFee: lamports('priority_fee').notNull(),
  expectedCost: lamports('expected_cost').notNull(),
  dataAgeMs: integer('data_age_ms').notNull(),
  wasStale: boolean('was_stale').notNull().default(false),
  landedSignature: text('landed_signature'),
})

export const comparisons = pgTable('comparisons', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt,
  status: comparisonStatus('status').notNull().default('pending'),
  naiveSignature: text('naive_signature'),
  routedSignature: text('routed_signature'),
  naiveCost: lamports('naive_cost'),
  routedCost: lamports('routed_cost'),
  /** «Не сіла» — окремий результат, а не нульова вартість (FR-024). */
  naiveLanded: boolean('naive_landed'),
  routedLanded: boolean('routed_landed'),
  spendLamports: lamports('spend_lamports').notNull().default(ZERO_LAMPORTS),
})

/** Прогалини індексатора: відкрита — та, у якої `healedAt` порожній (FR-009). */
export const indexerGaps = pgTable(
  'indexer_gaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromSlot: slotNumber('from_slot').notNull(),
    toSlot: slotNumber('to_slot').notNull(),
    reason: text('reason').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    healedAt: timestamp('healed_at', { withTimezone: true }),
  },
  (table) => [index('indexer_gaps_open_idx').on(table.healedAt, table.fromSlot)],
)

/**
 * Денний бюджет демо-гаманця (FR-036). Рядок на добу; списання атомарне —
 * `UPDATE … WHERE spent + ? <= limit RETURNING` (T050), тому лічильники живуть
 * в одному рядку, а не в двох таблицях.
 */
export const demoBudget = pgTable('demo_budget', {
  day: text('day').primaryKey(),
  spentLamports: lamports('spent_lamports').notNull().default(ZERO_LAMPORTS),
  runsCount: integer('runs_count').notNull().default(0),
})
