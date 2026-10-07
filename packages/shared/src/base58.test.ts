import { describe, expect, it } from 'vitest'
import { ADDRESS_BYTES, decodeBase58, encodeBase58, isSolanaAddress } from './base58.ts'
import { VOTE_PROGRAM_ID } from './cost.ts'

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

describe('decodeBase58', () => {
  it('decodes the all-ones system program id into 32 zero bytes', () => {
    const bytes = decodeBase58(SYSTEM_PROGRAM_ID)

    expect(bytes).toHaveLength(ADDRESS_BYTES)
    expect(bytes?.every((byte) => byte === 0)).toBe(true)
  })

  it('decodes known program ids to 32 bytes', () => {
    expect(decodeBase58(TOKEN_PROGRAM_ID)).toHaveLength(ADDRESS_BYTES)
    expect(decodeBase58(VOTE_PROGRAM_ID)).toHaveLength(ADDRESS_BYTES)
  })

  it('decodes small numbers the way base58 defines them', () => {
    expect([...(decodeBase58('1') ?? [])]).toEqual([0])
    expect([...(decodeBase58('2') ?? [])]).toEqual([1])
    expect([...(decodeBase58('21') ?? [])]).toEqual([58])
  })

  // 0, O, I і l виключені з алфавіту саме тому, що їх плутають очима.
  it('rejects characters outside the base58 alphabet', () => {
    expect(decodeBase58('0OIl')).toBeNull()
    expect(decodeBase58('not+base58')).toBeNull()
    expect(decodeBase58('')).toBeNull()
  })
})

describe('isSolanaAddress', () => {
  it('accepts a real address', () => {
    expect(isSolanaAddress(TOKEN_PROGRAM_ID)).toBe(true)
  })

  it('rejects a value that decodes to the wrong length', () => {
    expect(isSolanaAddress('2')).toBe(false)
    expect(isSolanaAddress(`${TOKEN_PROGRAM_ID}extra`)).toBe(false)
  })
})

describe('encodeBase58', () => {
  it('turns 32 zero bytes back into the system program id', () => {
    expect(encodeBase58(new Uint8Array(ADDRESS_BYTES))).toBe(SYSTEM_PROGRAM_ID)
  })

  it('encodes small numbers the way base58 defines them', () => {
    expect(encodeBase58(Uint8Array.of(0))).toBe('1')
    expect(encodeBase58(Uint8Array.of(1))).toBe('2')
    expect(encodeBase58(Uint8Array.of(58))).toBe('21')
    expect(encodeBase58(new Uint8Array())).toBe('')
  })

  it('round-trips known addresses and keeps leading zero bytes', () => {
    for (const address of [TOKEN_PROGRAM_ID, VOTE_PROGRAM_ID, SYSTEM_PROGRAM_ID]) {
      const bytes = decodeBase58(address)
      expect(bytes && encodeBase58(bytes)).toBe(address)
    }
    const padded = Uint8Array.of(0, 0, 7, 255, 1)
    expect(decodeBase58(encodeBase58(padded))).toEqual(padded)
  })
})
