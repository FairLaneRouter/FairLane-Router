import { createPublicKey, verify } from 'node:crypto'
import { inspect } from 'node:util'
import { encodeBase58 } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { DemoWalletError, loadDemoWallet } from './wallet.ts'

// RFC 8032, section 7.1, TEST 1: a published Ed25519 vector, so the test
// checks against an outside answer rather than against this module itself.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const EMPTY_MESSAGE_SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'

const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const SECRET_BYTES = Uint8Array.from([...hex(SEED), ...hex(PUBLIC)])
const AS_JSON = JSON.stringify([...SECRET_BYTES])
const AS_BASE58 = encodeBase58(SECRET_BYTES)
const ADDRESS = encodeBase58(hex(PUBLIC))

/** What must never surface: the whole secret, in either form, or the seed alone. */
const leaks = (text: string) =>
  [AS_BASE58, AS_JSON, SEED, AS_JSON.slice(1, 40), AS_BASE58.slice(0, 20)].some((piece) =>
    text.includes(piece),
  )

function errorOf(secret: string): DemoWalletError {
  try {
    loadDemoWallet(secret)
  } catch (error) {
    if (error instanceof DemoWalletError) return error
    throw error
  }
  throw new Error('expected loadDemoWallet to throw')
}

describe('loadDemoWallet', () => {
  it('is absent, not broken, when the environment has no key', () => {
    expect(loadDemoWallet(undefined)).toBeNull()
    expect(loadDemoWallet('')).toBeNull()
    expect(loadDemoWallet('   ')).toBeNull()
  })

  it('reads the solana-keygen JSON array and the base58 export as the same wallet', () => {
    expect(loadDemoWallet(AS_JSON)?.address).toBe(ADDRESS)
    expect(loadDemoWallet(AS_BASE58)?.address).toBe(ADDRESS)
    expect(loadDemoWallet(`\n${AS_BASE58}\n`)?.address).toBe(ADDRESS)
  })

  it('signs exactly as RFC 8032 says', () => {
    const wallet = loadDemoWallet(AS_JSON)

    expect(Buffer.from(wallet?.sign(new Uint8Array()) ?? []).toString('hex')).toBe(
      EMPTY_MESSAGE_SIGNATURE,
    )
  })

  it('produces signatures that verify against its address', () => {
    const wallet = loadDemoWallet(AS_BASE58)
    const message = new TextEncoder().encode('a serialized transaction message')
    const signature = wallet?.sign(message) ?? new Uint8Array()
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex(PUBLIC)).toString('base64url') },
      format: 'jwk',
    })

    expect(signature).toHaveLength(64)
    expect(verify(null, message, publicKey, signature)).toBe(true)
    expect(verify(null, new TextEncoder().encode('another message'), publicKey, signature)).toBe(
      false,
    )
  })

  it('shows only the address when logged, serialized or inspected', () => {
    const wallet = loadDemoWallet(AS_JSON)

    expect(JSON.parse(JSON.stringify({ wallet }))).toEqual({ wallet: { address: ADDRESS } })
    expect(String(wallet)).toBe(`DemoWallet(${ADDRESS})`)
    expect(inspect(wallet)).toBe(`DemoWallet(${ADDRESS})`)
    expect(Object.keys(wallet ?? {})).toEqual(['address', 'sign', 'toJSON', 'toString'])
    expect(Object.isFrozen(wallet)).toBe(true)
  })

  it('rejects a key whose public half belongs to another key', () => {
    const mixed = Uint8Array.from(SECRET_BYTES)
    mixed[63] = (mixed[63] ?? 0) ^ 1

    expect(errorOf(encodeBase58(mixed)).message).toMatch(/public half does not match/)
  })

  // Control for the cases below: the leak check does fire on a message that quotes the key.
  it('catches a message that quotes part of the secret', () => {
    expect(leaks(`bad key ${AS_BASE58.slice(0, 20)}`)).toBe(true)
    expect(leaks(`Unexpected token in JSON: ${AS_JSON.slice(0, 45)}`)).toBe(true)
  })

  it.each([
    ['a key cut short', JSON.stringify([...SECRET_BYTES.subarray(0, 32)])],
    ['a byte out of range', JSON.stringify([...SECRET_BYTES.subarray(0, 63), 256])],
    ['broken JSON', `${AS_JSON.slice(0, -1)},]`],
    ['a public address instead of a secret', ADDRESS],
    ['characters outside base58', `${AS_BASE58.slice(0, -1)}0`],
  ])('refuses %s without repeating any of the secret', (_case, secret) => {
    const error = errorOf(secret)

    expect(error.message).toMatch(/DEMO_WALLET_SECRET/)
    expect(error.cause).toBeUndefined()
    expect(leaks(`${error.message}\n${error.stack ?? ''}`)).toBe(false)
  })
})
