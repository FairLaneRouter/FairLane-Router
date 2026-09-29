const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const ALPHABET_INDEX = new Map([...ALPHABET].map((char, index) => [char, index] as const))

/** A Solana address in bytes: the whole key, with no checksum in it. */
export const ADDRESS_BYTES = 32

/**
 * Our own decoder instead of a dependency: thirty lines here, where a package
 * would bring its own Buffer and its own idea of errors. Returns `null` on any
 * character outside the alphabet — nothing is thrown, the caller checks the
 * result anyway.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null

  const bytes: number[] = []

  for (const char of value) {
    const digitValue = ALPHABET_INDEX.get(char)
    if (digitValue === undefined) return null

    // Typed explicitly: otherwise carry is inferred from digit and digit from
    // carry, and TypeScript refuses to unwind the cycle.
    let carry: number = digitValue

    for (let i = 0; i < bytes.length; i += 1) {
      const digit = (bytes[i] ?? 0) * 58 + carry
      bytes[i] = digit & 0xff
      carry = digit >> 8
    }

    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  // Leading ones are zero bytes: they carry no weight in base58 and never
  // reach the accumulator above.
  for (const char of value) {
    if (char !== '1') break
    bytes.push(0)
  }

  return Uint8Array.from(bytes.reverse())
}

/**
 * A Solana address has no checksum, so its length is all there is to check.
 * A one-character typo passes, and does no harm: a service account that does
 * not exist matches nothing, and the transaction goes to "unattributed"
 * instead of to somebody else's group.
 */
export function isSolanaAddress(value: string): boolean {
  return decodeBase58(value)?.length === ADDRESS_BYTES
}
