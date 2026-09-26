import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  DEFAULT_TARGET_SLOTS,
  describeInputIssue,
  intentSchema,
  MAX_COMPUTE_UNITS,
  MAX_TARGET_SLOTS,
  type Recommendation,
  recommendationSchema,
} from './recommend.schema.ts'

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const intent = { programId: TOKEN_PROGRAM, computeUnits: 200_000, mode: 'cheap' }

/** The issue a refused body is reported by — what the route will put in `details`. */
function issueOf(schema: z.ZodType, body: unknown) {
  const parsed = schema.safeParse(body)
  if (parsed.success) throw new Error('expected the body to be refused')

  return describeInputIssue(parsed.error)
}

describe('intentSchema', () => {
  it('accepts an intent and fills in the default window', () => {
    expect(intentSchema.parse(intent)).toEqual({ ...intent, targetSlots: DEFAULT_TARGET_SLOTS })
  })

  it('keeps an explicit window', () => {
    expect(intentSchema.parse({ ...intent, mode: 'fast', targetSlots: 2 }).targetSlots).toBe(2)
  })

  it.each([
    ['one', 1],
    ['the ceiling', MAX_COMPUTE_UNITS],
  ])('accepts computeUnits at %s', (_, computeUnits) => {
    expect(intentSchema.safeParse({ ...intent, computeUnits }).success).toBe(true)
  })

  it.each([
    ['zero', 0],
    ['above the ceiling', MAX_COMPUTE_UNITS + 1],
    ['a fraction', 1.5],
    ['a numeric string', '200000'],
    ['negative', -1],
  ])('refuses computeUnits as %s and names the field', (_, computeUnits) => {
    expect(issueOf(intentSchema, { ...intent, computeUnits })).toEqual({
      field: 'computeUnits',
      message: `computeUnits must be an integer from 1 to ${MAX_COMPUTE_UNITS}`,
    })
  })

  it.each([
    ['zero', 0],
    ['past the blockhash lifetime', MAX_TARGET_SLOTS + 1],
    ['a fraction', 2.5],
  ])('refuses targetSlots as %s', (_, targetSlots) => {
    expect(issueOf(intentSchema, { ...intent, targetSlots }).field).toBe('targetSlots')
  })

  it('accepts targetSlots up to the blockhash lifetime', () => {
    expect(intentSchema.safeParse({ ...intent, targetSlots: MAX_TARGET_SLOTS }).success).toBe(true)
  })

  it.each([
    ['base58 of the wrong length', '1111'],
    ['a character outside base58', `${TOKEN_PROGRAM.slice(0, -1)}0`],
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses programId as %s', (_, programId) => {
    expect(issueOf(intentSchema, { ...intent, programId }).field).toBe('programId')
  })

  it('refuses an unknown mode and lists the known ones', () => {
    expect(issueOf(intentSchema, { ...intent, mode: 'urgent' })).toEqual({
      field: 'mode',
      message: 'mode must be one of: cheap, fast',
    })
  })

  it.each(['programId', 'computeUnits', 'mode'])('names %s when it is missing', (field) => {
    const body: Record<string, unknown> = { ...intent }
    delete body[field]

    expect(issueOf(intentSchema, body).field).toBe(field)
  })

  it('refuses a misspelt field instead of answering about the default window', () => {
    expect(issueOf(intentSchema, { ...intent, targetSlot: 2 })).toEqual({
      field: 'targetSlot',
      message: 'targetSlot is not a field of this request',
    })
  })

  it.each([
    ['null', null],
    ['an array', [intent]],
    ['a string', 'cheap'],
  ])('refuses %s as the body', (_, body) => {
    expect(issueOf(intentSchema, body)).toEqual({
      field: '',
      message: 'the request body must be a JSON object',
    })
  })
})

const fresh: Recommendation = {
  groupId: 'rpc',
  targetSlots: 4,
  tipLamports: 0,
  priorityFeeMicroLamports: 12_500,
  expectedCost: 7_500,
  landProbability: 0.93,
  dataAgeMs: 4_200,
  isStale: false,
  note: null,
}

describe('recommendationSchema', () => {
  it('accepts fresh advice', () => {
    expect(recommendationSchema.parse(fresh)).toEqual(fresh)
  })

  it('ignores a field it does not know, so an installed SDK survives a newer server', () => {
    expect(recommendationSchema.parse({ ...fresh, id: 'later' })).toEqual(fresh)
  })

  it('accepts a stale fallback with nothing to measure it by', () => {
    const fallback = { ...fresh, isStale: true, dataAgeMs: null, landProbability: null }

    expect(recommendationSchema.safeParse(fallback).success).toBe(true)
  })

  it.each(['dataAgeMs', 'landProbability'])('refuses fresh advice without %s', (field) => {
    expect(issueOf(recommendationSchema, { ...fresh, [field]: null }).field).toBe(field)
  })

  it('accepts a note about another group', () => {
    const note = {
      code: 'CHEAPER_GROUP_NOT_SENDABLE',
      groupId: 'nozomi',
      message: 'Nozomi is cheaper but observed only; it cannot be sent through',
    }

    expect(recommendationSchema.parse({ ...fresh, note }).note).toEqual(note)
  })

  it('refuses a note about the recommended group itself', () => {
    const note = { code: 'CHEAPER_GROUP_NOT_SENDABLE', groupId: 'rpc', message: 'x' }

    expect(issueOf(recommendationSchema, { ...fresh, note }).field).toBe('note.groupId')
  })

  it('refuses a note code it does not define', () => {
    const note = { code: 'SOMETHING_ELSE', groupId: 'nozomi', message: 'x' }

    expect(issueOf(recommendationSchema, { ...fresh, note }).field).toBe('note.code')
  })

  it.each([
    ['a negative tip', { tipLamports: -1 }, 'tipLamports'],
    ['a fractional cost', { expectedCost: 7_500.5 }, 'expectedCost'],
    ['a cost past the safe integer', { expectedCost: Number.MAX_SAFE_INTEGER + 1 }, 'expectedCost'],
    ['a probability above one', { landProbability: 1.01 }, 'landProbability'],
    ['a negative data age', { dataAgeMs: -1 }, 'dataAgeMs'],
  ])('refuses %s', (_, patch, field) => {
    expect(issueOf(recommendationSchema, { ...fresh, ...patch }).field).toBe(field)
  })
})

describe('describeInputIssue', () => {
  it('names the full path of a nested field', () => {
    expect(issueOf(recommendationSchema, { ...fresh, note: { code: 'X' } }).field).toMatch(
      /^note\./,
    )
  })
})
