import type { Block, BlockTransaction, ChannelRegistry } from '@fairlane/shared'
import { buildChannelRegistry, DEFAULT_REGISTRY, VOTE_PROGRAM_ID } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { parseBlock, signatureFraction } from './parse.ts'

const registry: ChannelRegistry = buildChannelRegistry(DEFAULT_REGISTRY)

const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
const NOZOMI_TIP = 'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq'
const SWAP_PROGRAM = 'SwapProgram1111111111111111111111111111111'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'

type Overrides = {
  signature?: string
  accountKeys?: string[]
  loadedWritable?: string[]
  loadedReadonly?: string[]
  instructions?: number[]
  tips?: Readonly<Record<string, number>>
  fee?: number
  computeUnitsConsumed?: number | undefined
  vote?: boolean
  failed?: boolean
}

function tx(o: Overrides = {}): BlockTransaction {
  const tips = o.tips ?? {}
  const staticKeys = o.accountKeys ?? ['payer', ...Object.keys(tips)]
  const accountKeys = o.vote ? [...staticKeys, VOTE_PROGRAM_ID] : staticKeys
  const resolved = [...accountKeys, ...(o.loadedWritable ?? []), ...(o.loadedReadonly ?? [])]

  const preBalances = resolved.map(() => 1_000_000)
  const postBalances = resolved.map((key) => 1_000_000 + (tips[key] ?? 0))

  return {
    transaction: {
      signatures: [o.signature ?? 'sig'],
      message: {
        accountKeys,
        instructions: (o.instructions ?? []).map((programIdIndex) => ({ programIdIndex })),
      },
    },
    meta: {
      err: o.failed === true ? { InstructionError: [0, 'Custom'] } : null,
      fee: o.fee ?? 5000,
      computeUnitsConsumed: 'computeUnitsConsumed' in o ? o.computeUnitsConsumed : 42_000,
      preBalances,
      postBalances,
      ...(o.loadedWritable === undefined && o.loadedReadonly === undefined
        ? {}
        : { loadedAddresses: { writable: o.loadedWritable ?? [], readonly: o.loadedReadonly ?? [] } }),
    },
  }
}

function block(transactions: BlockTransaction[], blockTime: number | null = 1_800_000_000): Block {
  return { blockhash: 'hash', parentSlot: 341_882_102, blockTime, transactions }
}

const SLOT = 341_882_103

/** Вибірка вимкнена: лишається тільки те, що зберігається завжди. */
const keepNothingSampled = { registry, rpcSampleRate: 0 }
const keepEverything = { registry, rpcSampleRate: 1 }

describe('parseBlock', () => {
  it('stores a tipped landing even when sampling keeps nothing', () => {
    const parsed = parseBlock(
      block([tx({ signature: 'tipped', tips: { [JITO_TIP]: 200_000 }, fee: 9700 })]),
      SLOT,
      keepNothingSampled,
    )

    expect(parsed.landings).toHaveLength(1)
    const landing = parsed.landings[0]
    expect(landing?.groupId).toBe('jito')
    expect(landing?.attributionBasis).toBe('tip')
    expect(landing?.isSampled).toBe(false)
    expect(landing?.signature).toBe('tipped')
    expect(landing?.slot).toBe(SLOT)
  })

  // Гроші йдуть у колонки лампортів, а `bigint` і `number` у драйвері Postgres
  // дають різні типи параметра. Межа переведення одна, і вона в розборі.
  it('reports money as bigint lamports, tips included in the total', () => {
    const parsed = parseBlock(
      block([tx({ tips: { [JITO_TIP]: 200_000 }, fee: 9700 })]),
      SLOT,
      keepNothingSampled,
    )

    const landing = parsed.landings[0]
    expect(landing?.baseFee).toBe(5000n)
    expect(landing?.priorityFee).toBe(4700n)
    expect(landing?.tipTotal).toBe(200_000n)
    expect(landing?.totalCost).toBe(209_700n)
    expect(landing?.cuConsumed).toBe(42_000)
  })

  it('keeps a transaction that tipped two groups as unattributed evidence', () => {
    const parsed = parseBlock(
      block([tx({ tips: { [JITO_TIP]: 100_000, [NOZOMI_TIP]: 100_000 } })]),
      SLOT,
      keepNothingSampled,
    )

    expect(parsed.landings).toHaveLength(1)
    expect(parsed.landings[0]?.groupId).toBeNull()
    expect(parsed.landings[0]?.attributionBasis).toBe('ambiguous')
    expect(parsed.landings[0]?.isSampled).toBe(false)
  })

  it('marks a sampled plain-RPC landing and attributes it to the rpc group', () => {
    const parsed = parseBlock(block([tx({ fee: 9700 })]), SLOT, keepEverything)

    expect(parsed.landings[0]?.groupId).toBe('rpc')
    expect(parsed.landings[0]?.attributionBasis).toBe('priority-fee')
    expect(parsed.landings[0]?.isSampled).toBe(true)
  })

  it('drops untipped transactions when sampling keeps nothing', () => {
    const parsed = parseBlock(
      block([tx({ signature: 'a', fee: 9700 }), tx({ signature: 'b' })]),
      SLOT,
      keepNothingSampled,
    )

    expect(parsed.landings).toHaveLength(0)
    expect(parsed.stats.droppedBySampling).toBe(2)
    expect(parsed.stats.candidates).toBe(2)
  })

  it('leaves voting and failed transactions out of landings but counts them', () => {
    const parsed = parseBlock(
      block([
        tx({ signature: 'vote', vote: true }),
        tx({ signature: 'boom', failed: true, tips: { [JITO_TIP]: 100_000 } }),
        tx({ signature: 'ok', tips: { [JITO_TIP]: 100_000 } }),
      ]),
      SLOT,
      keepEverything,
    )

    expect(parsed.landings.map((landing) => landing.signature)).toEqual(['ok'])
    expect(parsed.stats).toEqual({
      transactions: 3,
      voting: 1,
      failed: 1,
      candidates: 1,
      stored: 1,
      droppedBySampling: 0,
      malformed: 0,
    })
  })

  it('takes the fee payer from the first account and dedupes top-level programs', () => {
    const parsed = parseBlock(
      block([
        tx({
          accountKeys: ['payer', SWAP_PROGRAM, SYSTEM_PROGRAM],
          instructions: [1, 2, 1],
        }),
      ]),
      SLOT,
      keepEverything,
    )

    expect(parsed.landings[0]?.feePayer).toBe('payer')
    expect(parsed.landings[0]?.programIds).toEqual([SWAP_PROGRAM, SYSTEM_PROGRAM])
  })

  // Транзакція v0 адресує підтягнуті таблицею акаунти індексами ПІСЛЯ
  // статичних ключів. Без цього виконавцем інструкції виявився б чужий акаунт.
  it('resolves program ids that come from an address lookup table', () => {
    const parsed = parseBlock(
      block([
        tx({
          accountKeys: ['payer'],
          loadedWritable: ['PoolAccount11111111111111111111111111111111'],
          loadedReadonly: [SWAP_PROGRAM],
          instructions: [2],
        }),
      ]),
      SLOT,
      keepEverything,
    )

    expect(parsed.landings[0]?.programIds).toEqual([SWAP_PROGRAM])
  })

  it('ignores an instruction whose program index is out of range', () => {
    const parsed = parseBlock(
      block([tx({ accountKeys: ['payer', SWAP_PROGRAM], instructions: [1, 9] })]),
      SLOT,
      keepEverything,
    )

    expect(parsed.landings[0]?.programIds).toEqual([SWAP_PROGRAM])
  })

  it('converts blockTime to a date and tolerates its absence', () => {
    const withTime = parseBlock(block([tx()]), SLOT, keepEverything)
    const withoutTime = parseBlock(block([tx()], null), SLOT, keepEverything)

    expect(withTime.blockTime).toEqual(new Date(1_800_000_000_000))
    expect(withTime.landings[0]?.blockTime).toEqual(new Date(1_800_000_000_000))
    expect(withoutTime.blockTime).toBeNull()
    expect(withoutTime.landings[0]?.blockTime).toBeNull()
  })

  it('counts a transaction without accounts as malformed instead of storing it', () => {
    const parsed = parseBlock(block([tx({ accountKeys: [] })]), SLOT, keepEverything)

    expect(parsed.landings).toHaveLength(0)
    expect(parsed.stats.malformed).toBe(1)
  })

  it('rejects a sampling rate outside 0…1', () => {
    expect(() => parseBlock(block([]), SLOT, { registry, rpcSampleRate: 1.5 })).toThrow(RangeError)
  })

  it('lets the caller decide sampling', () => {
    const parsed = parseBlock(
      block([tx({ signature: 'yes' }), tx({ signature: 'no' })]),
      SLOT,
      { registry, rpcSampleRate: 0.05, shouldSample: (signature) => signature === 'yes' },
    )

    expect(parsed.landings.map((landing) => landing.signature)).toEqual(['yes'])
  })
})

describe('signatureFraction', () => {
  const signatures = Array.from({ length: 2000 }, (_, index) => `signature-${index}`)

  // Дочитування прогалини (T030) розбирає ті самі блоки вдруге. З
  // `Math.random()` набір збережених рядків щоразу був би іншим.
  it('is stable for the same signature', () => {
    expect(signatureFraction('sig')).toBe(signatureFraction('sig'))
    expect(signatureFraction('sig')).not.toBe(signatureFraction('sig2'))
  })

  it('stays inside 0…1', () => {
    for (const signature of signatures) {
      const fraction = signatureFraction(signature)
      expect(fraction).toBeGreaterThanOrEqual(0)
      expect(fraction).toBeLessThan(1)
    }
  })

  // Обсяг сховища тримається саме на цьому: 5% має означати близько 5%,
  // інакше розрахунок місткості з PLAN.md розходиться з дійсністю.
  it('keeps about the requested share of a large set', () => {
    const kept = signatures.filter((signature) => signatureFraction(signature) < 0.05)

    expect(kept.length / signatures.length).toBeGreaterThan(0.03)
    expect(kept.length / signatures.length).toBeLessThan(0.07)
  })
})
