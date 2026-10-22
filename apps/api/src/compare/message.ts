import { ADDRESS_BYTES, decodeBase58 } from '@fairlane/shared'

/**
 * The bytes of one leg of a side-by-side run, written by hand instead of with
 * a Solana library: the transaction is always the same four instructions, and
 * the wallet signs whatever bytes it is handed (`DemoWallet.sign`), so a
 * library would only add a dependency between the two.
 *
 * The format is the legacy message — no address lookup tables, nothing a
 * version prefix would be needed for. One signer, the demo wallet, which pays
 * for everything.
 */

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111'
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/** A packet is 1232 bytes; a memo past this would crowd the rest out for nothing. */
export const MAX_MEMO_BYTES = 128

const SIGNATURE_BYTES = 64
const U32_MAX = 0xffff_ffff
const U64_MAX = (1n << 64n) - 1n

// Instruction tags: ComputeBudgetInstruction is a one-byte enum, SystemInstruction a u32.
const SET_COMPUTE_UNIT_LIMIT = 2
const SET_COMPUTE_UNIT_PRICE = 3
const SYSTEM_TRANSFER = 2

export class TransactionBuildError extends Error {
  override name = 'TransactionBuildError'
}

export type LegMessageInput = {
  /** The demo wallet: the only signer and the fee payer. */
  readonly payer: string
  readonly recentBlockhash: string
  readonly computeUnitLimit: number
  readonly priorityPriceMicroLamports: bigint
  /** Makes the twins two transactions: the same instructions would be the same signature. */
  readonly memo: string
  /** `null` for a group that takes no tip — plain RPC. */
  readonly tip: { readonly account: string; readonly lamports: bigint } | null
}

function address(value: string, field: string): Uint8Array {
  const bytes = decodeBase58(value)
  if (bytes?.length !== ADDRESS_BYTES) {
    throw new TransactionBuildError(`${field} is not a base58 address of ${ADDRESS_BYTES} bytes`)
  }
  return bytes
}

/** Solana's compact-u16: seven bits a byte, low first, the high bit says "more follows". */
export function compactU16(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new TransactionBuildError(`${value} does not fit a compact-u16`)
  }
  const out: number[] = []
  let rest = value
  for (;;) {
    const low = rest & 0x7f
    rest >>= 7
    if (rest === 0) {
      out.push(low)
      return out
    }
    out.push(low | 0x80)
  }
}

function u32(value: number, field: string): number[] {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new TransactionBuildError(`${field} must be an integer from 0 to ${U32_MAX}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return [...out]
}

function u64(value: bigint, field: string): number[] {
  if (value < 0n || value > U64_MAX) {
    throw new TransactionBuildError(`${field} must fit an unsigned 64-bit integer`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return [...out]
}

type Instruction = {
  readonly program: number
  readonly accounts: readonly number[]
  readonly data: readonly number[]
}

/**
 * Compiles one leg: compute unit limit, compute unit price, the memo and, for
 * a group that takes tips, the tip transfer — in the same transaction, which
 * is how Jito wants it.
 *
 * Account order is the one the runtime reads the header by: signers first,
 * then writable non-signers, then read-only non-signers. Here that is the
 * payer, the tip account, then the programs.
 */
export function compileLegMessage(input: LegMessageInput): Uint8Array {
  const payer = address(input.payer, 'payer')
  const blockhash = address(input.recentBlockhash, 'recentBlockhash')
  const memo = new TextEncoder().encode(input.memo)
  if (memo.length === 0 || memo.length > MAX_MEMO_BYTES) {
    throw new TransactionBuildError(`memo must be 1 to ${MAX_MEMO_BYTES} bytes of UTF-8`)
  }

  const keys: Uint8Array[] = [payer]
  let tipIndex = -1
  if (input.tip !== null) {
    if (input.tip.lamports <= 0n) throw new TransactionBuildError('a tip must be above zero')
    const tip = address(input.tip.account, 'tip.account')
    // A tip account equal to the payer or to a program would be a duplicate
    // key, and the message would no longer say what this function means.
    if (input.tip.account === input.payer) {
      throw new TransactionBuildError('the tip account cannot be the payer')
    }
    if (
      [SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID].includes(input.tip.account)
    ) {
      throw new TransactionBuildError('the tip account cannot be a program')
    }
    tipIndex = keys.push(tip) - 1
  }

  const computeBudget = keys.push(address(COMPUTE_BUDGET_PROGRAM_ID, 'program')) - 1
  const memoProgram = keys.push(address(MEMO_PROGRAM_ID, 'program')) - 1
  const system = input.tip === null ? -1 : keys.push(address(SYSTEM_PROGRAM_ID, 'program')) - 1
  const readonlyUnsigned = input.tip === null ? 2 : 3

  const instructions: Instruction[] = [
    {
      program: computeBudget,
      accounts: [],
      data: [SET_COMPUTE_UNIT_LIMIT, ...u32(input.computeUnitLimit, 'computeUnitLimit')],
    },
    {
      program: computeBudget,
      accounts: [],
      data: [
        SET_COMPUTE_UNIT_PRICE,
        ...u64(input.priorityPriceMicroLamports, 'priorityPriceMicroLamports'),
      ],
    },
    // No accounts: the memo program then checks no signers, it only logs.
    { program: memoProgram, accounts: [], data: [...memo] },
  ]
  if (input.tip !== null) {
    instructions.push({
      program: system,
      accounts: [0, tipIndex],
      data: [...u32(SYSTEM_TRANSFER, 'instruction'), ...u64(input.tip.lamports, 'tip.lamports')],
    })
  }

  const bytes: number[] = [1, 0, readonlyUnsigned, ...compactU16(keys.length)]
  for (const key of keys) bytes.push(...key)
  bytes.push(...blockhash, ...compactU16(instructions.length))
  for (const instruction of instructions) {
    bytes.push(
      instruction.program,
      ...compactU16(instruction.accounts.length),
      ...instruction.accounts,
      ...compactU16(instruction.data.length),
      ...instruction.data,
    )
  }

  return Uint8Array.from(bytes)
}

/** The wire form `sendTransaction` takes: one signature, then the message it signs. */
export function serializeTransaction(message: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new TransactionBuildError(`a signature is ${SIGNATURE_BYTES} bytes`)
  }
  const out = new Uint8Array(1 + SIGNATURE_BYTES + message.length)
  out[0] = 1
  out.set(signature, 1)
  out.set(message, 1 + SIGNATURE_BYTES)
  return out
}
