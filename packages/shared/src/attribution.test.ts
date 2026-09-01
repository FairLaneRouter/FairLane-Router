import { describe, expect, it } from 'vitest'
import { attributeGroup } from './attribution.ts'
import { RPC_GROUP_ID, buildChannelRegistry } from './channels.ts'
import type { LandingCost } from './cost.ts'

const JITO_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
const JITO_ACCOUNT_2 = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'
const NOZOMI_ACCOUNT = 'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq'
const STRANGER = '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NA4bd'

const registry = buildChannelRegistry({
  groups: [
    { id: 'jito', name: 'Jito' },
    { id: 'nozomi', name: 'Nozomi' },
    { id: RPC_GROUP_ID, name: 'Звичайний RPC' },
  ],
  channels: [
    { id: 'jito', groupId: 'jito', name: 'Jito', tipAccounts: [JITO_ACCOUNT] },
    { id: 'jito-relay', groupId: 'jito', name: 'Jito Relay', tipAccounts: [JITO_ACCOUNT_2] },
    { id: 'nozomi', groupId: 'nozomi', name: 'Nozomi', tipAccounts: [NOZOMI_ACCOUNT] },
    { id: 'rpc', groupId: RPC_GROUP_ID, name: 'Звичайний RPC' },
  ],
})

function cost(o: Partial<LandingCost> = {}): LandingCost {
  return {
    baseFee: 5000,
    priorityFee: 0,
    tipTotal: 0,
    tipAccounts: [],
    total: 5000,
    computeUnits: 1000,
    ...o,
  }
}

describe('attributeGroup', () => {
  it('attributes a tip to the group that owns the account', () => {
    const result = attributeGroup(cost({ tipAccounts: [JITO_ACCOUNT], tipTotal: 100_000 }), registry)

    expect(result).toEqual({ groupId: 'jito', basis: 'tip' })
  })

  // FR-004: канали зі спільними службовими акаунтами ончейн нерозрізненні,
  // тому два акаунти однієї групи дають ту саму групу, а не суперечність.
  it('stays inside one group when two of its accounts are tipped', () => {
    const result = attributeGroup(
      cost({ tipAccounts: [JITO_ACCOUNT, JITO_ACCOUNT_2], tipTotal: 100_000 }),
      registry,
    )

    expect(result).toEqual({ groupId: 'jito', basis: 'tip' })
  })

  // Вибрати більший переказ означало б здогадуватись про бренд (FR-038), а
  // SC-009 вимагає нуль хибно зарахованих. Суперечність лишається видимою.
  it('refuses to guess when two groups are tipped at once', () => {
    const result = attributeGroup(
      cost({ tipAccounts: [JITO_ACCOUNT, NOZOMI_ACCOUNT], tipTotal: 100_000 }),
      registry,
    )

    expect(result).toEqual({ groupId: null, basis: 'ambiguous' })
  })

  it('ignores transfers to accounts no group claims', () => {
    const result = attributeGroup(
      cost({ tipAccounts: [STRANGER], tipTotal: 1_000, priorityFee: 4_700 }),
      registry,
    )

    expect(result).toEqual({ groupId: RPC_GROUP_ID, basis: 'priority-fee' })
  })

  it('attributes a priority fee without known tips to plain RPC', () => {
    const result = attributeGroup(cost({ priorityFee: 4_700 }), registry)

    expect(result).toEqual({ groupId: RPC_GROUP_ID, basis: 'priority-fee' })
  })

  it('prefers the tip over the priority fee', () => {
    const result = attributeGroup(
      cost({ tipAccounts: [NOZOMI_ACCOUNT], tipTotal: 50_000, priorityFee: 4_700 }),
      registry,
    )

    expect(result).toEqual({ groupId: 'nozomi', basis: 'tip' })
  })

  // За доставку не заплачено нічого — така посадка не свідчить про ціну каналу.
  it('leaves a transaction with neither tip nor priority fee unattributed', () => {
    const result = attributeGroup(cost(), registry)

    expect(result).toEqual({ groupId: null, basis: 'none' })
  })

  it('never invents a group that is absent from the registry', () => {
    const result = attributeGroup(cost({ tipAccounts: [JITO_ACCOUNT] }), registry)

    expect(registry.groupById(result.groupId ?? '')).not.toBeNull()
  })
})
