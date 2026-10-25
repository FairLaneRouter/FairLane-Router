import { setTimeout as delay } from 'node:timers/promises'
import {
  type ChannelRegistry,
  type ConfirmRpc,
  channelEndpointKey,
  computeLandingCost,
  encodeBase58,
  type SendRpc,
} from '@fairlane/shared'
import { serializeTransaction } from './message.ts'
import { type PairLeg, type PairPlan, type PairRole, pairMessages } from './pair.ts'
import type { DemoWallet } from './wallet.ts'

/**
 * Sends both legs of a planned pair and follows each to its end (FR-022).
 *
 * The legs go out under one blockhash, in the same instant and the same way —
 * no preflight, no rebroadcast of our own — so what differs between them is
 * still only the channel and the bid. Then each is followed until it is known
 * for certain: it landed, or its blockhash expired and it never can. Stopping
 * at the target window would be quicker, but a leg that lands after it still
 * spends money, and the budget has to be settled with what was really spent;
 * whether a landing made the window is recorded next to it instead.
 *
 * What a leg cost is read back from the chain with the same function the
 * board uses (`computeLandingCost`), not taken from the plan: the plan is the
 * ceiling, the chain is the fact.
 */

/** Channels whose endpoint takes the node's own `sendTransaction`; another API needs its own sender. */
export const JSON_RPC_SEND_CHANNELS: ReadonlySet<string> = new Set(['rpc', 'jito', 'nozomi'])

/** About a slot: often enough to see a landing soon, light on the node the indexer also reads. */
export const POLL_INTERVAL_MS = 1_000

/**
 * A blockhash lives 150 blocks, about a minute; skipped slots stretch that.
 * Past this the run stops waiting and says it does not know, rather than
 * hanging on a node that stopped answering.
 */
export const RUN_DEADLINE_MS = 180_000

export class RunError extends Error {
  override name = 'RunError'
}

export type LegOutcome =
  | {
      readonly kind: 'landed'
      readonly signature: string
      readonly slot: number
      /** Slots from the one the blockhash was read at to the one the leg landed in. */
      readonly slotsToLand: number
      /** Landed within the recommendation's `targetSlots`. */
      readonly inWindow: boolean
      /** Landed with an error: the fee is paid, the instructions — the tip too — are not. */
      readonly failed: boolean
      readonly feeLamports: bigint
      readonly tipLamports: bigint
      /** Fee plus tip, as the chain shows it. */
      readonly costLamports: bigint
      readonly sendError: string | null
    }
  | {
      /** The blockhash expired with the leg unseen: it did not land and never will. */
      readonly kind: 'expired'
      readonly signature: string
      readonly sendError: string | null
    }
  | {
      /** The run's deadline came first; whether the leg landed is not known. */
      readonly kind: 'unknown'
      readonly signature: string
      readonly sendError: string | null
      readonly reason: string
    }

export type PairRun = {
  readonly runId: string
  readonly blockhash: string
  readonly lastValidBlockHeight: number
  /** The slot the blockhash was read at, right before both sends. */
  readonly referenceSlot: number
  readonly naive: LegOutcome
  readonly routed: LegOutcome
  /**
   * What to settle the budget with: the chain's cost of each landed leg,
   * nothing for an expired one, and the planned ceiling for one whose end is
   * not known — the budget errs on the side of having spent more.
   */
  readonly spentLamports: bigint
}

export type RunPairOptions = {
  readonly plan: PairPlan
  readonly wallet: DemoWallet
  /** The base node: blockhash, statuses and the transactions read back. */
  readonly rpc: ConfirmRpc
  /** Channel id → where to send through it (`channelSenders`). */
  readonly senders: ReadonlyMap<string, SendRpc>
  /** `registry.tipAccounts` — what counts as a tip in the cost read back. */
  readonly tipAccounts: ReadonlySet<string>
  readonly pollIntervalMs?: number
  readonly deadlineMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<unknown>
}

export type ChannelSendersOptions = {
  readonly registry: ChannelRegistry
  /** `config.channelEndpoints`. */
  readonly endpoints: Readonly<Record<string, string>>
  /** The base node, for a channel with no endpoint of its own — plain RPC. */
  readonly base: SendRpc
  readonly connect: (url: string) => SendRpc
}

/**
 * Where each sendable channel is sent through. A channel whose API is not the
 * node's `sendTransaction` is left out: a run planned onto it is refused
 * before anything is signed, instead of being sent somewhere that drops it.
 */
export function channelSenders(options: ChannelSendersOptions): ReadonlyMap<string, SendRpc> {
  const senders = new Map<string, SendRpc>()
  for (const channel of options.registry.channels) {
    if (!channel.canSend || !JSON_RPC_SEND_CHANNELS.has(channel.id)) continue
    if (channel.endpointEnvKey === null) {
      senders.set(channel.id, options.base)
      continue
    }
    const url = options.endpoints[channelEndpointKey(channel.endpointEnvKey)]
    if (url) senders.set(channel.id, options.connect(url))
  }
  return senders
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

type Signed = { readonly signature: string; readonly wire: Uint8Array }

type LegState = {
  readonly leg: PairLeg
  readonly signed: Signed
  readonly sendError: string | null
  /** The node has seen it at `confirmed` or above; only reading it back is left. */
  seenAt: number | null
  outcome: LegOutcome | null
}

async function send(sender: SendRpc, signed: Signed): Promise<string | null> {
  try {
    const answered = await sender.sendTransaction(signed.wire)
    return answered === signed.signature
      ? null
      : `the endpoint answered with another signature: ${answered}`
  } catch (cause) {
    return describe(cause)
  }
}

function spentBy(state: LegState): bigint {
  const outcome = state.outcome
  if (outcome?.kind === 'landed') return outcome.costLamports
  if (outcome?.kind === 'expired') return 0n
  return state.leg.costLamports
}

/**
 * Runs the pair. Throws — with nothing sent — when a leg has no sender or
 * the blockhash cannot be read; once the legs are out it always returns,
 * with every leg's end or the admission that it is not known.
 */
export async function runPair(options: RunPairOptions): Promise<PairRun> {
  const { plan, wallet, rpc, tipAccounts } = options
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const deadlineMs = options.deadlineMs ?? RUN_DEADLINE_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay

  const roles: readonly PairRole[] = ['naive', 'routed']
  const senderOf = (leg: PairLeg) => {
    const sender = options.senders.get(leg.channelId)
    if (sender === undefined) throw new RunError(`no sender for channel ${leg.channelId}`)
    return sender
  }
  const naiveSender = senderOf(plan.naive)
  const routedSender = senderOf(plan.routed)

  const latest = await rpc.getLatestBlockhash()
  const started = now()
  const messages = pairMessages(plan, wallet.address, latest.blockhash)
  const sign = (role: PairRole): Signed => {
    const signature = wallet.sign(messages[role])
    return {
      signature: encodeBase58(signature),
      wire: serializeTransaction(messages[role], signature),
    }
  }
  const signed = { naive: sign('naive'), routed: sign('routed') }

  // Both started before either is awaited: neither leg gets a head start.
  const [naiveError, routedError] = await Promise.all([
    send(naiveSender, signed.naive),
    send(routedSender, signed.routed),
  ])

  const states: Record<PairRole, LegState> = {
    naive: {
      leg: plan.naive,
      signed: signed.naive,
      sendError: naiveError,
      seenAt: null,
      outcome: null,
    },
    routed: {
      leg: plan.routed,
      signed: signed.routed,
      sendError: routedError,
      seenAt: null,
      outcome: null,
    },
  }
  const targetSlots = plan.recommendation.targetSlots
  let lastFailure = 'the run deadline passed before the leg was seen'

  for (;;) {
    const pending = roles.map((role) => states[role]).filter((state) => state.outcome === null)
    if (pending.length === 0) break

    if (now() - started >= deadlineMs) {
      for (const state of pending) {
        state.outcome = {
          kind: 'unknown',
          signature: state.signed.signature,
          sendError: state.sendError,
          reason: lastFailure,
        }
      }
      break
    }

    await sleep(pollIntervalMs)

    try {
      // Height first, statuses after: a leg absent from statuses read after
      // the blockhash was already past its last valid height cannot appear later.
      const height = await rpc.getBlockHeight()
      const unseen = pending.filter((state) => state.seenAt === null)
      const statuses =
        unseen.length === 0
          ? []
          : await rpc.getSignatureStatuses(unseen.map((state) => state.signed.signature))
      for (const [i, state] of unseen.entries()) {
        const status = statuses[i]
        // `processed` may still be on a fork that is dropped; it is not a landing yet.
        const level = status?.confirmationStatus
        if (status != null && (level === 'confirmed' || level === 'finalized')) {
          state.seenAt = status.slot
        }
      }

      for (const state of pending) {
        if (state.seenAt === null) {
          if (height > latest.lastValidBlockHeight) {
            state.outcome = {
              kind: 'expired',
              signature: state.signed.signature,
              sendError: state.sendError,
            }
          }
          continue
        }

        const tx = await rpc.getTransaction(state.signed.signature)
        if (tx === null) continue
        const cost = computeLandingCost(tx, tipAccounts)
        const slotsToLand = tx.slot - latest.slot
        state.outcome = {
          kind: 'landed',
          signature: state.signed.signature,
          slot: tx.slot,
          slotsToLand,
          inWindow: slotsToLand <= targetSlots,
          failed: tx.meta.err !== null,
          feeLamports: BigInt(tx.meta.fee),
          tipLamports: BigInt(cost.tipTotal),
          costLamports: BigInt(cost.total),
          sendError: state.sendError,
        }
      }
    } catch (cause) {
      lastFailure = describe(cause)
    }
  }

  const done = (state: LegState): LegOutcome => {
    if (state.outcome === null) throw new RunError('a leg was left without an outcome')
    return state.outcome
  }

  return {
    runId: plan.runId,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    referenceSlot: latest.slot,
    naive: done(states.naive),
    routed: done(states.routed),
    spentLamports: spentBy(states.naive) + spentBy(states.routed),
  }
}
