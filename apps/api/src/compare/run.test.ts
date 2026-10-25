import { createPublicKey, verify } from 'node:crypto'
import {
  buildChannelRegistry,
  type ConfirmRpc,
  DEFAULT_REGISTRY,
  decodeBase58,
  encodeBase58,
  type FetchedTransaction,
  type Recommendation,
  type SendRpc,
  type SignatureStatus,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { type PairPlan, planPair } from './pair.ts'
import { channelSenders, type PairRun, RunError, runPair } from './run.ts'
import { type DemoWallet, loadDemoWallet } from './wallet.ts'

// RFC 8032, 7.1, TEST 1 — the same outside vector the wallet's own tests use.
const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const SEED = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const PUBLIC = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
function testWallet(): DemoWallet {
  const loaded = loadDemoWallet(encodeBase58(Uint8Array.from([...SEED, ...PUBLIC])))
  if (loaded === null) throw new Error('the test wallet did not load')
  return loaded
}
const wallet = testWallet()

const RUN_ID = '0b6f3f5e-3c1a-4c84-9d2e-8f1f2a3b4c5d'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
const REFERENCE_SLOT = 1_000
const START_HEIGHT = 900
const LAST_VALID = START_HEIGHT + 150
const POLL = 1_000

const registry = buildChannelRegistry(DEFAULT_REGISTRY, { jito: 'https://jito.example' })

const advice: Recommendation = {
  groupId: 'jito',
  targetSlots: 4,
  tipLamports: 1_000,
  priorityFeeMicroLamports: 0,
  expectedCost: 6_000,
  landProbability: null,
  dataAgeMs: 2_000,
  isStale: false,
  note: null,
}

function plan(): PairPlan {
  const result = planPair({
    runId: RUN_ID,
    registry,
    recommendation: advice,
    perRunLamports: 2_000_000n,
    pickIndex: () => 0,
  })
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`)
  return result.plan
}

type Role = 'naive' | 'routed'
const CHANNEL: Record<Role, string> = { naive: 'rpc', routed: 'jito' }

/** A landed leg read back: the fee from the payer, the tip as the tip account's gain. */
function landedTx(signature: string, slot: number, fee: number, tip: number, err: unknown = null) {
  const paidTip = err === null ? tip : 0
  return {
    slot,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [wallet.address, TIP_ACCOUNT],
        instructions: [{ programIdIndex: 1 }],
      },
    },
    meta: {
      err,
      fee,
      computeUnitsConsumed: 20_158,
      preBalances: [10_000_000, 5_000],
      postBalances: [10_000_000 - fee - paidTip, 5_000 + paidTip],
    },
  } satisfies FetchedTransaction
}

/** What a test's script can do to the chain between two polls. */
type Chain = {
  readonly txs: Map<string, FetchedTransaction>
  signatureOf(role: Role): string
  seen(role: Role, slot: number, level?: SignatureStatus['confirmationStatus']): void
  land(role: Role, slot: number, fee: number, tip?: number, err?: unknown): void
  failRpc(error: Error | null): void
}

/**
 * A chain that moves one step per sleep: the block height grows by `perTick`,
 * and `script` says what the node has seen by then.
 */
function chain(options: {
  script?: (tick: number, chain: Chain) => void
  perTick?: number
  sendFails?: Partial<Record<Role, Error>>
}) {
  const statuses = new Map<string, SignatureStatus>()
  const txs = new Map<string, FetchedTransaction>()
  const sent: Partial<Record<Role, { signature: string; wire: Uint8Array }>> = {}
  const order: string[] = []
  let height = START_HEIGHT
  let tick = 0
  let clock = 0
  let failing: Error | null = null

  const signatureOf = (role: Role) => {
    const signature = sent[role]?.signature
    if (signature === undefined) throw new Error(`${role} was never sent`)
    return signature
  }

  const self = {
    statuses,
    txs,
    sent,
    order,
    signatureOf,
    seen(role: Role, slot: number, level: SignatureStatus['confirmationStatus'] = 'confirmed') {
      statuses.set(signatureOf(role), { slot, confirmationStatus: level })
    },
    land(role: Role, slot: number, fee: number, tip = 0, err: unknown = null) {
      self.seen(role, slot)
      txs.set(signatureOf(role), landedTx(signatureOf(role), slot, fee, tip, err))
    },
    failRpc(error: Error | null) {
      failing = error
    },
    get ticks() {
      return tick
    },
  }
  const rpc: ConfirmRpc = {
    async getLatestBlockhash() {
      order.push('blockhash')
      return { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID, slot: REFERENCE_SLOT }
    },
    async getBlockHeight() {
      if (failing) throw failing
      return height
    },
    async getSignatureStatuses(signatures) {
      if (failing) throw failing
      return signatures.map((signature) => statuses.get(signature) ?? null)
    },
    async getTransaction(signature) {
      if (failing) throw failing
      return txs.get(signature) ?? null
    },
  }

  const sender = (role: Role): SendRpc => ({
    async sendTransaction(wire) {
      const signature = encodeBase58(wire.subarray(1, 65))
      sent[role] = { signature, wire }
      order.push(`send:${role}`)
      await Promise.resolve()
      order.push(`sent:${role}`)
      const error = options.sendFails?.[role]
      if (error) throw error
      return signature
    },
  })

  const senders = new Map<string, SendRpc>([
    [CHANNEL.naive, sender('naive')],
    [CHANNEL.routed, sender('routed')],
  ])

  const run = (overrides: Partial<Parameters<typeof runPair>[0]> = {}): Promise<PairRun> =>
    runPair({
      plan: plan(),
      wallet,
      rpc,
      senders,
      tipAccounts: registry.tipAccounts,
      pollIntervalMs: POLL,
      deadlineMs: 180_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        tick += 1
        height += options.perTick ?? 2
        options.script?.(tick, self)
      },
      ...overrides,
    })

  return { self, run, rpc, senders }
}

describe('runPair', () => {
  it('lands both legs and reads their costs back from the chain', async () => {
    const { run } = chain({
      script: (tick, c) => {
        if (tick === 2) c.land('naive', REFERENCE_SLOT + 6, 29_293)
        if (tick === 3) c.land('routed', REFERENCE_SLOT + 2, 5_000, 1_000)
      },
    })

    const result = await run()

    expect(result.naive).toMatchObject({
      kind: 'landed',
      slot: REFERENCE_SLOT + 6,
      slotsToLand: 6,
      inWindow: false,
      failed: false,
      feeLamports: 29_293n,
      tipLamports: 0n,
      costLamports: 29_293n,
      sendError: null,
    })
    expect(result.routed).toMatchObject({
      kind: 'landed',
      slotsToLand: 2,
      inWindow: true,
      feeLamports: 5_000n,
      tipLamports: 1_000n,
      costLamports: 6_000n,
    })
    expect(result.spentLamports).toBe(35_293n)
    expect(result).toMatchObject({
      runId: RUN_ID,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID,
      referenceSlot: REFERENCE_SLOT,
    })
  })

  it('counts a landing exactly at the window as in it', async () => {
    const { run } = chain({
      script: (tick, c) => {
        if (tick !== 1) return
        c.land('naive', REFERENCE_SLOT + 4, 29_293)
        c.land('routed', REFERENCE_SLOT + 5, 5_000, 1_000)
      },
    })

    const result = await run()

    expect(result.naive).toMatchObject({ inWindow: true, slotsToLand: 4 })
    expect(result.routed).toMatchObject({ inWindow: false, slotsToLand: 5 })
  })

  it('signs both legs under one blockhash, each with the wallet, as two transactions', async () => {
    const { run, self } = chain({
      script: (tick, c) => {
        if (tick !== 1) return
        c.land('naive', REFERENCE_SLOT + 1, 29_293)
        c.land('routed', REFERENCE_SLOT + 1, 5_000, 1_000)
      },
    })
    await run()

    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(PUBLIC).toString('base64url') },
      format: 'jwk',
    })
    const blockhash = decodeBase58(BLOCKHASH)
    if (blockhash === null) throw new Error('bad blockhash')

    for (const role of ['naive', 'routed'] as const) {
      const wire = self.sent[role]?.wire
      if (wire === undefined) throw new Error(`${role} not sent`)
      expect(wire[0]).toBe(1)
      const message = wire.subarray(65)
      expect(verify(null, message, publicKey, wire.subarray(1, 65))).toBe(true)
      // The blockhash follows the header (3 bytes), the key count and the keys.
      const keys = message[3] ?? 0
      const at = 4 + keys * 32
      expect([...message.subarray(at, at + 32)]).toEqual([...blockhash])
    }
    expect(self.signatureOf('naive')).not.toBe(self.signatureOf('routed'))
  })

  it('starts both sends before awaiting either, after the blockhash', async () => {
    const { run, self } = chain({
      script: (tick, c) => {
        if (tick !== 1) return
        c.land('naive', REFERENCE_SLOT + 1, 29_293)
        c.land('routed', REFERENCE_SLOT + 1, 5_000, 1_000)
      },
    })
    await run()

    expect(self.order.slice(0, 3)).toEqual(['blockhash', 'send:naive', 'send:routed'])
  })

  it('takes a leg unseen past its last valid height as expired — and spent nothing on it', async () => {
    const { run, self } = chain({
      perTick: 50,
      script: (tick, c) => {
        if (tick === 1) c.land('naive', REFERENCE_SLOT + 3, 29_293)
      },
    })

    const result = await run()

    expect(result.routed).toEqual({
      kind: 'expired',
      signature: self.signatureOf('routed'),
      sendError: null,
    })
    expect(result.spentLamports).toBe(29_293n)
    // 900 → 950 → 1000 → 1050 is the last valid height, 1100 is past it.
    expect(self.ticks).toBe(4)
  })

  it('keeps waiting at the last valid height itself', async () => {
    const { run, self } = chain({
      perTick: 75,
      script: (tick, c) => {
        if (tick === 1) c.land('naive', REFERENCE_SLOT + 3, 29_293)
        // Tick 2 reads height 1050 — the last valid one — with the leg still
        // unseen: it can yet land in that block, so the run must not give up.
        if (tick === 3) c.land('routed', REFERENCE_SLOT + 140, 5_000, 1_000)
      },
    })

    const result = await run()

    expect(result.routed.kind).toBe('landed')
    expect(self.ticks).toBe(3)
  })

  it('does not take a processed status for a landing', async () => {
    const { run, self } = chain({
      script: (tick, c) => {
        if (tick === 1) {
          c.land('naive', REFERENCE_SLOT + 1, 29_293)
          c.seen('routed', REFERENCE_SLOT + 1, 'processed')
          c.txs.set(
            c.signatureOf('routed'),
            landedTx(c.signatureOf('routed'), REFERENCE_SLOT + 1, 5_000, 1_000),
          )
        }
        if (tick === 3) c.seen('routed', REFERENCE_SLOT + 1, 'confirmed')
      },
    })

    const result = await run()

    expect(result.routed.kind).toBe('landed')
    expect(self.ticks).toBe(3)
  })

  it('waits for the transaction to be readable once its status says it landed — even past expiry', async () => {
    const { run, self } = chain({
      perTick: 100,
      script: (tick, c) => {
        if (tick === 1) {
          c.land('naive', REFERENCE_SLOT + 1, 29_293)
          c.seen('routed', REFERENCE_SLOT + 2)
        }
        if (tick === 4) {
          c.txs.set(
            c.signatureOf('routed'),
            landedTx(c.signatureOf('routed'), REFERENCE_SLOT + 2, 5_000, 1_000),
          )
        }
      },
    })

    const result = await run()

    expect(result.routed).toMatchObject({ kind: 'landed', costLamports: 6_000n })
    expect(self.ticks).toBe(4)
  })

  it('reads a failed landing as paid fee and no tip', async () => {
    const { run } = chain({
      script: (tick, c) => {
        if (tick !== 1) return
        c.land('naive', REFERENCE_SLOT + 1, 29_293)
        c.land('routed', REFERENCE_SLOT + 1, 5_000, 1_000, {
          InstructionError: [2, 'ComputationalBudgetExceeded'],
        })
      },
    })

    const result = await run()

    expect(result.routed).toMatchObject({
      kind: 'landed',
      failed: true,
      feeLamports: 5_000n,
      tipLamports: 0n,
      costLamports: 5_000n,
    })
  })

  it('still follows a leg whose send failed: the endpoint may have forwarded it anyway', async () => {
    const { run } = chain({
      sendFails: { routed: new Error('HTTP 429') },
      script: (tick, c) => {
        if (tick === 1) c.land('naive', REFERENCE_SLOT + 1, 29_293)
        if (tick === 2) c.land('routed', REFERENCE_SLOT + 3, 5_000, 1_000)
      },
    })

    const result = await run()

    expect(result.routed).toMatchObject({ kind: 'landed', sendError: 'HTTP 429' })
  })

  it('says a failed send that never lands expired, with the send error', async () => {
    const { run } = chain({
      perTick: 200,
      sendFails: { routed: new Error('HTTP 429') },
      script: (tick, c) => {
        if (tick === 1) c.land('naive', REFERENCE_SLOT + 1, 29_293)
      },
    })

    const result = await run()

    expect(result.routed).toMatchObject({ kind: 'expired', sendError: 'HTTP 429' })
  })

  it('notes an endpoint that answers with another signature', async () => {
    const { run, senders } = chain({
      script: (tick, c) => {
        if (tick !== 1) return
        c.land('naive', REFERENCE_SLOT + 1, 29_293)
        c.land('routed', REFERENCE_SLOT + 1, 5_000, 1_000)
      },
    })
    const jito = senders.get('jito')
    if (jito === undefined) throw new Error('no jito sender')
    const lying = new Map(senders)
    lying.set('jito', {
      async sendTransaction(wire) {
        await jito.sendTransaction(wire)
        return 'SomethingElse111'
      },
    })

    const result = await run({ senders: lying })

    expect(result.routed).toMatchObject({
      kind: 'landed',
      sendError: 'the endpoint answered with another signature: SomethingElse111',
    })
  })

  it('stops at the deadline with the end unknown, and settles that leg at its ceiling', async () => {
    const { run, self } = chain({
      script: (tick, c) => {
        if (tick === 1) c.land('naive', REFERENCE_SLOT + 1, 29_293)
        if (tick === 2) c.failRpc(new Error('getBlockHeight: no endpoint answered'))
      },
    })

    const result = await run({ deadlineMs: 10_000 })

    expect(result.routed).toEqual({
      kind: 'unknown',
      signature: self.signatureOf('routed'),
      sendError: null,
      reason: 'getBlockHeight: no endpoint answered',
    })
    expect(result.spentLamports).toBe(29_293n + plan().routed.costLamports)
    expect(self.ticks).toBe(10)
  })

  it('refuses a leg with no sender before reading a blockhash or signing anything', async () => {
    const { run, self } = chain({})
    let signed = 0
    const counting = {
      address: wallet.address,
      sign: (m: Uint8Array) => {
        signed += 1
        return wallet.sign(m)
      },
    }

    await expect(run({ senders: new Map(), wallet: counting })).rejects.toThrow(RunError)
    expect(self.order).toEqual([])
    expect(signed).toBe(0)
  })

  it('sends nothing when the blockhash cannot be read', async () => {
    const { run, rpc, self } = chain({})
    const broken: ConfirmRpc = {
      ...rpc,
      getLatestBlockhash: () => Promise.reject(new Error('down')),
    }

    await expect(run({ rpc: broken })).rejects.toThrow('down')
    expect(self.sent).toEqual({})
  })
})

describe('channelSenders', () => {
  const base: SendRpc = { sendTransaction: async () => 'base' }
  const connected: string[] = []
  const connect = (url: string): SendRpc => {
    connected.push(url)
    return { sendTransaction: async () => url }
  }

  it('sends plain RPC through the base node and the rest through their own endpoints', () => {
    const live = buildChannelRegistry(DEFAULT_REGISTRY, {
      jito: 'https://jito.example',
      nozomi: 'https://nozomi.example/?c=key',
    })
    const senders = channelSenders({
      registry: live,
      endpoints: { jito: 'https://jito.example', nozomi: 'https://nozomi.example/?c=key' },
      base,
      connect,
    })

    expect(senders.get('rpc')).toBe(base)
    expect([...senders.keys()].sort()).toEqual(['jito', 'nozomi', 'rpc'])
    expect(connected).toEqual(['https://jito.example', 'https://nozomi.example/?c=key'])
  })

  it('leaves out a channel whose API is not sendTransaction, and one with no endpoint', () => {
    const live = buildChannelRegistry(DEFAULT_REGISTRY, { bloxroute: 'https://blx.example' })
    const senders = channelSenders({
      registry: live,
      endpoints: { bloxroute: 'https://blx.example' },
      base,
      connect,
    })

    expect([...senders.keys()]).toEqual(['rpc'])
  })
})
