import { describe, expect, it } from 'vitest'
import { BASE_FEE_PER_SIGNATURE, computeLandingCost, isVoteTransaction } from './cost'
import type { BlockTransaction } from './rpc'

type Overrides = {
  signatures?: string[]
  accountKeys?: string[]
  preBalances?: number[]
  postBalances?: number[]
  fee?: number
  err?: unknown
  computeUnitsConsumed?: number | undefined
}

function tx(o: Overrides = {}): BlockTransaction {
  const accountKeys = o.accountKeys ?? ['payer']
  return {
    transaction: {
      signatures: o.signatures ?? ['sig'],
      message: { accountKeys },
    },
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? BASE_FEE_PER_SIGNATURE,
      computeUnitsConsumed: 'computeUnitsConsumed' in o ? o.computeUnitsConsumed : 1000,
      preBalances: o.preBalances ?? accountKeys.map(() => 1_000_000),
      postBalances: o.postBalances ?? accountKeys.map(() => 1_000_000),
    },
  }
}

const TIP_ACCOUNT = 'TipAccount1'

describe('computeLandingCost', () => {
  it('splits the network fee into base and priority', () => {
    const cost = computeLandingCost(tx({ fee: 9700 }), new Set())

    expect(cost.baseFee).toBe(5000)
    expect(cost.priorityFee).toBe(4700)
    expect(cost.tipTotal).toBe(0)
    expect(cost.total).toBe(9700)
  })

  it('charges base fee per signature', () => {
    const cost = computeLandingCost(tx({ signatures: ['a', 'b'], fee: 12000 }), new Set())

    expect(cost.baseFee).toBe(10000)
    expect(cost.priorityFee).toBe(2000)
  })

  // Комісія нижча за базову означає, що припущення про 5000 за підпис не тримається
  // (зміна протоколу, збірний рахунок). Мовчазний відʼємний пріоритет отруїв би
  // еталон слота на всьому вікні, тому пріоритет підлягає обрізанню в нуль.
  it('never reports a negative priority fee', () => {
    const cost = computeLandingCost(tx({ fee: 3000 }), new Set())

    expect(cost.priorityFee).toBe(0)
    expect(cost.total).toBe(3000)
  })

  it('counts a transfer into a known service account as a tip', () => {
    const cost = computeLandingCost(
      tx({
        accountKeys: ['payer', TIP_ACCOUNT],
        fee: 5000,
        preBalances: [1_000_000, 0],
        postBalances: [949_000, 46_000],
      }),
      new Set([TIP_ACCOUNT]),
    )

    expect(cost.tipTotal).toBe(46_000)
    expect(cost.tipAccounts).toEqual([TIP_ACCOUNT])
    expect(cost.total).toBe(51_000)
  })

  it('sums tips across several service accounts', () => {
    const cost = computeLandingCost(
      tx({
        accountKeys: ['payer', TIP_ACCOUNT, 'TipAccount2'],
        fee: 5000,
        preBalances: [1_000_000, 0, 10],
        postBalances: [900_000, 46_000, 49_010],
      }),
      new Set([TIP_ACCOUNT, 'TipAccount2']),
    )

    expect(cost.tipTotal).toBe(95_000)
    expect(cost.tipAccounts).toEqual([TIP_ACCOUNT, 'TipAccount2'])
  })

  it('ignores an unknown account that gained lamports', () => {
    const cost = computeLandingCost(
      tx({
        accountKeys: ['payer', 'SomeSwapPool'],
        fee: 5000,
        preBalances: [1_000_000, 0],
        postBalances: [800_000, 195_000],
      }),
      new Set([TIP_ACCOUNT]),
    )

    expect(cost.tipTotal).toBe(0)
  })

  // Службовий акаунт може бути платником у власній транзакції; його баланс тоді
  // падає, і без обрізання в нуль ми відняли б це від чайових інших акаунтів.
  it('ignores a service account whose balance decreased', () => {
    const cost = computeLandingCost(
      tx({
        accountKeys: [TIP_ACCOUNT, 'other'],
        fee: 5000,
        preBalances: [1_000_000, 0],
        postBalances: [900_000, 100_000],
      }),
      new Set([TIP_ACCOUNT]),
    )

    expect(cost.tipTotal).toBe(0)
  })

  it('carries compute units through, and null when the node omitted them', () => {
    expect(computeLandingCost(tx({ computeUnitsConsumed: 42_000 }), new Set()).computeUnits).toBe(
      42_000,
    )
    expect(
      computeLandingCost(tx({ computeUnitsConsumed: undefined }), new Set()).computeUnits,
    ).toBeNull()
  })

  it('is unaffected by a balance array shorter than the account list', () => {
    const cost = computeLandingCost(
      tx({
        accountKeys: ['payer', TIP_ACCOUNT],
        fee: 5000,
        preBalances: [1_000_000],
        postBalances: [949_000],
      }),
      new Set([TIP_ACCOUNT]),
    )

    expect(cost.tipTotal).toBe(0)
  })
})

describe('isVoteTransaction', () => {
  it('recognises a vote by its program', () => {
    expect(
      isVoteTransaction(tx({ accountKeys: ['voter', 'Vote111111111111111111111111111111111111111'] })),
    ).toBe(true)
  })

  it('leaves an ordinary transaction alone', () => {
    expect(isVoteTransaction(tx({ accountKeys: ['payer', 'SomeSwapPool'] }))).toBe(false)
  })
})
