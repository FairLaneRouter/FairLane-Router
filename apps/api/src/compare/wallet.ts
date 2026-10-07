import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto'
import { inspect } from 'node:util'
import { decodeBase58, encodeBase58 } from '@fairlane/shared'
import { z } from 'zod'

/**
 * The project's demo wallet — the only key the system holds (FR-029). It pays
 * for both transactions of a side-by-side run, so a visitor never signs
 * anything (FR-035).
 *
 * Isolation is the point of this module. The secret comes in once, from the
 * environment, and becomes a `KeyObject` held in a closure; the decoded bytes
 * are zeroed right after. What goes out is the address and a `sign(message)` function. No
 * library ever sees the secret: whatever builds the transaction later only
 * hands message bytes in and gets a signature back.
 */
export type DemoWallet = {
  /** Base58 public key, the address the budget is paid from. */
  readonly address: string
  /** Ed25519 signature of a serialized transaction message, 64 bytes. */
  sign(message: Uint8Array): Uint8Array
}

/** Never carries the secret or any part of it — not even as a `cause`. */
export class DemoWalletError extends Error {
  override name = 'DemoWalletError'
}

const SECRET_KEY_BYTES = 64
const SEED_BYTES = 32

// The format solana-keygen writes: a JSON array of the 64 secret-key bytes.
const keygenArray = z.array(z.number().int().min(0).max(255)).length(SECRET_KEY_BYTES)

// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): fixed 16-byte prefix + the seed.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/**
 * Accepts both forms a Solana key is usually exported in: the solana-keygen
 * JSON array, or a base58 string (what wallets export). Both are 64 bytes:
 * the seed, then the public key.
 */
function decodeSecret(secret: string): Uint8Array {
  if (secret.startsWith('[')) {
    let json: unknown
    try {
      json = JSON.parse(secret)
    } catch {
      // JSON.parse quotes a piece of its input in the message; that piece is the key.
      throw new DemoWalletError('DEMO_WALLET_SECRET is not valid JSON')
    }
    const parsed = keygenArray.safeParse(json)
    if (!parsed.success) {
      throw new DemoWalletError(
        `DEMO_WALLET_SECRET must be a JSON array of ${SECRET_KEY_BYTES} bytes`,
      )
    }
    return Uint8Array.from(parsed.data)
  }

  const bytes = decodeBase58(secret)
  if (bytes?.length !== SECRET_KEY_BYTES) {
    throw new DemoWalletError(
      `DEMO_WALLET_SECRET must be a ${SECRET_KEY_BYTES}-byte key, as a base58 string or a JSON byte array`,
    )
  }
  return bytes
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + SEED_BYTES)
  der.set(PKCS8_ED25519_PREFIX)
  der.set(seed, PKCS8_ED25519_PREFIX.length)
  try {
    return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
  } finally {
    der.fill(0)
  }
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new DemoWalletError('Ed25519 public key has no x coordinate')
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
}

/**
 * Builds the wallet from `DEMO_WALLET_SECRET`. Without it there is no demo
 * wallet and the side-by-side run is simply unavailable — `null`, not an
 * error: the board and the advice work without it.
 */
export function loadDemoWallet(secret: string | undefined): DemoWallet | null {
  const trimmed = secret?.trim()
  if (!trimmed) return null

  const bytes = decodeSecret(trimmed)
  try {
    const privateKey = privateKeyFromSeed(bytes.subarray(0, SEED_BYTES))
    const publicKey = rawPublicKey(privateKey)

    // The second half must be the public key of the first: a key pasted from
    // two different exports, or cut short, would otherwise sign as one address
    // while the budget is watched on another.
    if (!publicKey.every((byte, i) => byte === bytes[SEED_BYTES + i])) {
      throw new DemoWalletError(
        'DEMO_WALLET_SECRET: the public half does not match the private half',
      )
    }

    const address = encodeBase58(publicKey)
    const describe = () => ({ address })

    return Object.freeze({
      address,
      sign: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)),
      toJSON: describe,
      toString: () => `DemoWallet(${address})`,
      [inspect.custom]: () => `DemoWallet(${address})`,
    })
  } finally {
    bytes.fill(0)
  }
}
