import { z } from 'zod'

/**
 * The shape of an access key token (FR-021, FR-046).
 *
 * A module of its own because the public SDK ships it: the SDK checks a key's
 * shape before sending it, and must not carry key issuance and hashing along
 * with one regular expression.
 */

/** The prefix inside the token. It tells a log reader whose key this is, and that it is not an address. */
export const KEY_PREFIX = 'flr_'

/** 256 bits of randomness. Fewer, and the token becomes guessable by brute force on our own limit. */
export const KEY_BYTES = 32

/** The whole token: the prefix plus two hex characters per byte. */
export const KEY_TOKEN_LENGTH = KEY_PREFIX.length + KEY_BYTES * 2

const keyTokenPattern = new RegExp(`^${KEY_PREFIX}[0-9a-f]{${KEY_BYTES * 2}}$`)

/**
 * The token's shape. Not a security measure — a wrong token is not found by
 * its hash anyway — but what tells "not the right key" from "not a key at
 * all", so the two get different answers (T040).
 */
export const keyTokenSchema = z.string().regex(keyTokenPattern)
