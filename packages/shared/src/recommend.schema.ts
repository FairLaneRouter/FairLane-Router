import { z } from 'zod'
import { isSolanaAddress } from './base58.ts'
import { registryIdSchema } from './channels.ts'

/**
 * The contract of `POST /v1/recommend` (FR-016, FR-017, FR-018, FR-020,
 * FR-041): what an integrator may ask and what they get back.
 *
 * The two halves are deliberately asymmetric. The intent is **strict** — an
 * unknown field is refused, because a misspelt `targetSlot` would otherwise be
 * dropped silently and the caller would get an answer about the default
 * window without ever learning they asked about another one. The
 * recommendation is **lenient** — the SDK (T047) parses it, and a field the
 * server adds later must not break an SDK that is already installed.
 */

/** Urgency modes (FR-016). The pick between them is T042; the schema only names them. */
export const RECOMMEND_MODES = ['cheap', 'fast'] as const

export type RecommendMode = (typeof RECOMMEND_MODES)[number]

export const recommendModeSchema = z.enum(RECOMMEND_MODES, {
  error: `mode must be one of: ${RECOMMEND_MODES.join(', ')}`,
})

/**
 * The runtime's per-transaction compute ceiling. A larger request is not a
 * bigger transaction but one that cannot exist, and a price quoted for it
 * would be a price for nothing.
 */
export const MAX_COMPUTE_UNITS = 1_400_000

/**
 * A recent blockhash stays valid for 150 slots. A transaction not landed by
 * then never lands at all, so a landing probability over a longer window
 * would describe something that cannot happen.
 */
export const MAX_TARGET_SLOTS = 150

/**
 * One full leader turn: a leader holds four consecutive slots. "Lands while
 * the current leader is still producing" is the smallest window that does
 * not depend on which of those four slots the request arrived in.
 */
export const DEFAULT_TARGET_SLOTS = 4

const programIdSchema = z
  .string({ error: 'programId must be a base58 Solana address' })
  .refine(isSolanaAddress, 'programId must be a base58 Solana address of 32 bytes')

const computeUnitsSchema = z
  .int({ error: `computeUnits must be an integer from 1 to ${MAX_COMPUTE_UNITS}` })
  .min(1, `computeUnits must be an integer from 1 to ${MAX_COMPUTE_UNITS}`)
  .max(MAX_COMPUTE_UNITS, `computeUnits must be an integer from 1 to ${MAX_COMPUTE_UNITS}`)

const targetSlotsSchema = z
  .int({ error: `targetSlots must be an integer from 1 to ${MAX_TARGET_SLOTS}` })
  .min(1, `targetSlots must be an integer from 1 to ${MAX_TARGET_SLOTS}`)
  .max(MAX_TARGET_SLOTS, `targetSlots must be an integer from 1 to ${MAX_TARGET_SLOTS}`)

/**
 * An intent — a transaction described before it exists (FR-016). There is no
 * signature, no payer and no instruction data: the recommendation is priced
 * from what landed recently, not from the transaction itself.
 */
export const intentSchema = z.strictObject(
  {
    programId: programIdSchema,
    computeUnits: computeUnitsSchema,
    mode: recommendModeSchema,
    targetSlots: targetSlotsSchema.default(DEFAULT_TARGET_SLOTS),
  },
  { error: 'the request body must be a JSON object' },
)

/** What a caller sends: `targetSlots` may be left out. */
export type IntentInput = z.input<typeof intentSchema>

/** What the recommendation is computed from: every field present. */
export type Intent = z.output<typeof intentSchema>

/**
 * Why the recommendation is not the cheapest group on the dashboard (FR-041).
 * An object with a code, not a sentence: the integrator has to be able to
 * branch on the reason, and the dashboard showing a cheaper group next to our
 * advice would otherwise look like a bug in one of the two.
 */
export const NOTE_CODES = ['CHEAPER_GROUP_NOT_SENDABLE'] as const

export type NoteCode = (typeof NOTE_CODES)[number]

export const recommendationNoteSchema = z.object({
  code: z.enum(NOTE_CODES),
  /** The cheaper group the note is about — never the recommended one. */
  groupId: registryIdSchema,
  message: z.string().min(1),
})

export type RecommendationNote = z.infer<typeof recommendationNoteSchema>

/** Lamports travel as JSON numbers, as in the summary; `int()` keeps them safe integers. */
const lamportsSchema = z.int().nonnegative()

/**
 * A recommendation (FR-016, FR-017, FR-018). Two invariants hold across
 * fields, and both guard against a quiet lie:
 *
 * - **Fresh advice carries its evidence.** With `isStale: false`, neither the
 *   data age nor the landing probability may be `null`. `null` is reserved for
 *   the stale fallback, where there is honestly nothing to measure them by —
 *   and even there it means "unknown", never zero.
 * - **A note never points at the group it recommends.** "A cheaper group
 *   exists but cannot be sent through" about the group we are sending through
 *   would contradict itself.
 */
export const recommendationSchema = z
  .object({
    groupId: registryIdSchema,
    /** Echoed back: the probability is meaningless without the window it is for. */
    targetSlots: targetSlotsSchema,
    tipLamports: lamportsSchema,
    priorityFeeMicroLamports: z.int().nonnegative(),
    /** Full landing cost: base fee, priority fee and tip together. */
    expectedCost: lamportsSchema,
    landProbability: z.number().min(0).max(1).nullable(),
    dataAgeMs: z.int().nonnegative().nullable(),
    isStale: z.boolean(),
    note: recommendationNoteSchema.nullable(),
  })
  .refine((value) => value.isStale || value.dataAgeMs !== null, {
    message: 'dataAgeMs may be null only in a stale fallback',
    path: ['dataAgeMs'],
  })
  .refine((value) => value.isStale || value.landProbability !== null, {
    message: 'landProbability may be null only in a stale fallback',
    path: ['landProbability'],
  })
  .refine((value) => value.note === null || value.note.groupId !== value.groupId, {
    message: 'a note must be about a group other than the recommended one',
    path: ['note', 'groupId'],
  })

export type Recommendation = z.infer<typeof recommendationSchema>

/** The one field a refusal names, and why (FR-020). */
export type InputIssue = {
  readonly field: string
  readonly message: string
}

/**
 * The first issue of a failed parse, reduced to the field it is about.
 *
 * One issue, not all of them: the caller fixes one field and asks again, and
 * a list would carry Zod's internal wording for every nested failure. An
 * unknown key needs its own branch — Zod reports it on the object itself, with
 * an empty path, and the name of the offending field only in `keys`.
 */
export function describeInputIssue(error: z.ZodError): InputIssue {
  const issue = error.issues[0]
  if (issue === undefined) return { field: '', message: 'the request is not valid' }

  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0] ?? ''
    const field = [...issue.path, key].map(String).join('.')

    return { field, message: `${field} is not a field of this request` }
  }

  return { field: issue.path.map(String).join('.'), message: issue.message }
}
