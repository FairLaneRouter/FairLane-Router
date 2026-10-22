import { encodeBase58 } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  compactU16,
  compileLegMessage,
  type LegMessageInput,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  serializeTransaction,
  TransactionBuildError,
} from './message.ts'

const PAYER = '8f3pvbjMNurWLc3kCypQGo5VWNrCumF3KdhQrYm8Ptk5'
const TIP_ACCOUNT = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

const base: LegMessageInput = {
  payer: PAYER,
  recentBlockhash: BLOCKHASH,
  computeUnitLimit: 24_000,
  priorityPriceMicroLamports: 1_012_195n,
  memo: 'fairlane:test',
  tip: null,
}

/** Reads a legacy message back, as the runtime would: the test's own decoder. */
function decode(bytes: Uint8Array) {
  let at = 0
  const byte = () => {
    const value = bytes[at]
    if (value === undefined) throw new Error('message ends early')
    at += 1
    return value
  }
  const shortVec = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const next = byte()
      value |= (next & 0x7f) << shift
      if ((next & 0x80) === 0) return value
    }
  }
  const take = (length: number) => {
    const out = bytes.slice(at, at + length)
    at += length
    return out
  }

  const header = [byte(), byte(), byte()]
  const keys = Array.from({ length: shortVec() }, () => encodeBase58(take(32)))
  const blockhash = encodeBase58(take(32))
  const instructions = Array.from({ length: shortVec() }, () => {
    const program = keys[byte()]
    const accounts = Array.from({ length: shortVec() }, () => keys[byte()])
    const data = take(shortVec())
    return { program, accounts, data }
  })
  return { header, keys, blockhash, instructions, rest: bytes.length - at }
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)

describe('compactU16', () => {
  it.each([
    [0, [0x00]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x01]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x80, 0x80, 0x01]],
    [0xffff, [0xff, 0xff, 0x03]],
  ])('encodes %i the way the runtime reads it', (value, bytes) => {
    expect(compactU16(value)).toEqual(bytes)
  })

  it.each([-1, 0x10000, 1.5])('refuses %d', (value) => {
    expect(() => compactU16(value)).toThrow(TransactionBuildError)
  })
})

describe('compileLegMessage', () => {
  it('without a tip: payer, then the two programs, read-only', () => {
    const message = decode(compileLegMessage(base))

    expect(message.header).toEqual([1, 0, 2])
    expect(message.keys).toEqual([PAYER, COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID])
    expect(message.blockhash).toBe(BLOCKHASH)
    expect(message.instructions.map((instruction) => instruction.program)).toEqual([
      COMPUTE_BUDGET_PROGRAM_ID,
      COMPUTE_BUDGET_PROGRAM_ID,
      MEMO_PROGRAM_ID,
    ])
    expect(message.rest).toBe(0)
  })

  it('sets the limit and the price in the compute budget instructions', () => {
    const [limit, price] = decode(compileLegMessage(base)).instructions
    if (limit === undefined || price === undefined) throw new Error('missing instructions')

    expect(limit.data.length).toBe(5)
    expect(limit.data[0]).toBe(2)
    expect(view(limit.data).getUint32(1, true)).toBe(24_000)
    expect(price.data.length).toBe(9)
    expect(price.data[0]).toBe(3)
    expect(view(price.data).getBigUint64(1, true)).toBe(1_012_195n)
  })

  it('carries the memo as UTF-8 with no accounts — nothing for the memo program to check', () => {
    const memo = decode(compileLegMessage({ ...base, memo: 'fairlane:ї' })).instructions[2]

    expect(memo?.accounts).toEqual([])
    expect(new TextDecoder().decode(memo?.data)).toBe('fairlane:ї')
  })

  it('with a tip: the tip account writable, the system program last, a transfer from the payer', () => {
    const message = decode(
      compileLegMessage({ ...base, tip: { account: TIP_ACCOUNT, lamports: 1_000n } }),
    )

    expect(message.header).toEqual([1, 0, 3])
    expect(message.keys).toEqual([
      PAYER,
      TIP_ACCOUNT,
      COMPUTE_BUDGET_PROGRAM_ID,
      MEMO_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
    ])

    const transfer = message.instructions[3]
    expect(transfer?.program).toBe(SYSTEM_PROGRAM_ID)
    expect(transfer?.accounts).toEqual([PAYER, TIP_ACCOUNT])
    if (transfer === undefined) throw new Error('missing transfer')
    expect(transfer.data.length).toBe(12)
    expect(view(transfer.data).getUint32(0, true)).toBe(2)
    expect(view(transfer.data).getBigUint64(4, true)).toBe(1_000n)
  })

  // Pinned from the build that mainnet accepted on 2026-10-22: getFeeForMessage
  // priced it to the lamport and simulateTransaction ran it (blockhash differs).
  it('stays byte for byte the message mainnet accepted', () => {
    const bytes = compileLegMessage({ ...base, tip: { account: TIP_ACCOUNT, lamports: 1_000n } })

    expect(Buffer.from(bytes).toString('hex')).toBe(
      [
        '010003', // one signer, writable; three read-only programs
        '05',
        '71c1132d6d4249be557f5b3008d041a2a9616ba0723b6698a575bfce1923a58e', // payer
        'f187ec87d1f745cb3a03384a26a69eda0ca2d1aa0f41e42416377e91ff5b5d31', // tip account
        '0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000', // compute budget
        '054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d', // memo
        '0000000000000000000000000000000000000000000000000000000000000000', // system
        'cc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b9', // blockhash
        '04',
        '02' + '00' + '05' + '02c05d0000', // limit 24 000
        '02' + '00' + '09' + '03e3710f0000000000', // price 1 012 195
        '03' + '00' + '0d' + '666169726c616e653a74657374', // "fairlane:test"
        '04' + '020001' + '0c' + '02000000e803000000000000', // transfer 1 000
      ].join(''),
    )
  })

  it('refuses a memo that is empty or longer than the cap', () => {
    expect(() => compileLegMessage({ ...base, memo: '' })).toThrow(TransactionBuildError)
    expect(() => compileLegMessage({ ...base, memo: 'x'.repeat(MAX_MEMO_BYTES) })).not.toThrow()
    expect(() => compileLegMessage({ ...base, memo: 'x'.repeat(MAX_MEMO_BYTES + 1) })).toThrow(
      TransactionBuildError,
    )
  })

  it('refuses addresses that are not 32 bytes', () => {
    expect(() => compileLegMessage({ ...base, payer: 'abc' })).toThrow(/payer/)
    expect(() => compileLegMessage({ ...base, recentBlockhash: '0OIl' })).toThrow(/recentBlockhash/)
  })

  it('refuses numbers outside their fields', () => {
    expect(() => compileLegMessage({ ...base, computeUnitLimit: -1 })).toThrow(/computeUnitLimit/)
    expect(() => compileLegMessage({ ...base, computeUnitLimit: 2 ** 32 })).toThrow(
      /computeUnitLimit/,
    )
    expect(() => compileLegMessage({ ...base, priorityPriceMicroLamports: 1n << 64n })).toThrow(
      /priorityPriceMicroLamports/,
    )
    expect(() => compileLegMessage({ ...base, priorityPriceMicroLamports: -1n })).toThrow(
      /priorityPriceMicroLamports/,
    )
  })

  it('refuses a tip of zero, to the payer, or to a program', () => {
    const tip = (account: string, lamports = 1_000n) => ({ ...base, tip: { account, lamports } })

    expect(() => compileLegMessage(tip(TIP_ACCOUNT, 0n))).toThrow(/above zero/)
    expect(() => compileLegMessage(tip(PAYER))).toThrow(/payer/)
    expect(() => compileLegMessage(tip(SYSTEM_PROGRAM_ID))).toThrow(/program/)
    expect(() => compileLegMessage(tip(MEMO_PROGRAM_ID))).toThrow(/program/)
  })
})

describe('serializeTransaction', () => {
  it('puts one signature before the message', () => {
    const message = compileLegMessage(base)
    const signature = new Uint8Array(64).fill(7)
    const wire = serializeTransaction(message, signature)

    expect(wire[0]).toBe(1)
    expect(wire.slice(1, 65)).toEqual(signature)
    expect(wire.slice(65)).toEqual(message)
  })

  it('refuses a signature that is not 64 bytes', () => {
    expect(() => serializeTransaction(compileLegMessage(base), new Uint8Array(63))).toThrow(
      TransactionBuildError,
    )
  })
})
