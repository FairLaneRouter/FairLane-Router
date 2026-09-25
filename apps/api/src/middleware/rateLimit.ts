import { hashKeyToken, readBearerToken, type Logger } from '@fairlane/shared'
import type { Context, MiddlewareHandler } from 'hono'
import type { KeyStore } from '../routes/keys.ts'

/**
 * Rate limiting (FR-021, FR-047, FR-049).
 *
 * Three rules, and the order between them is the whole design:
 *
 * 1. The public routes are not limited at all (FR-049). The summary, the feed
 *    and health are the product itself — a dashboard that throttles its own
 *    readers has nothing to show for it.
 * 2. A request that proves a key is limited **per key** at the higher rate.
 * 3. A request without one is limited **per source address** at the stricter
 *    rate, and is not refused (FR-047): trying a recommendation before writing
 *    a line of integration code has to be possible.
 *
 * The counting happens in this process, in memory, and that is exact rather
 * than approximate for one reason: the free Render plan runs a single
 * instance. With two, each would count its own callers and the effective
 * limit would double — a consequence to write down, not a bug to hide.
 */

/** Both limits are stated per minute, so the bucket refills over a minute. */
export const WINDOW_MS = 60_000

/**
 * Paths that no limit touches (FR-049).
 *
 * The list is an exception, not a rule: the middleware is mounted on
 * everything, so a route added later is limited until somebody decides
 * otherwise. The opposite default — limit only what is listed — would make a
 * forgotten line into an open route, and a forgotten line is invisible.
 */
export const UNLIMITED_PATHS: readonly string[] = [
  '/health',
  '/v1/summary',
  '/v1/summary/stream',
  '/v1/history',
]

/**
 * A token bucket rather than a counter per calendar minute. A counter is
 * simpler to explain but lets a caller spend the whole minute in the last
 * second of one window and the whole next one in the first second of the
 * following — twice the rate, at the worst possible moment. The bucket has no
 * edges: it refills continuously, so the average is the stated limit and the
 * burst is the capacity.
 */
export type Bucket = { readonly tokens: number; readonly updatedAt: number }

export type Verdict = {
  readonly allowed: boolean
  /** How long until one token is available. Zero when the verdict allows. */
  readonly retryAfterMs: number
  readonly bucket: Bucket
}

/** Where the bucket stands at `now`, before anything is spent from it. */
export function refill(bucket: Bucket | undefined, capacity: number, now: number): Bucket {
  if (bucket === undefined) return { tokens: capacity, updatedAt: now }

  const elapsed = Math.max(0, now - bucket.updatedAt)
  const gained = (elapsed * capacity) / WINDOW_MS

  return { tokens: Math.min(capacity, bucket.tokens + gained), updatedAt: now }
}

/**
 * The decision itself — pure, so that every case below is a test and not a
 * timing experiment. `spend: false` answers the same question without paying
 * for the answer; the middleware needs that to refuse a caller who is already
 * over the limit **before** it asks the database about their token.
 */
export function take(
  bucket: Bucket | undefined,
  capacity: number,
  now: number,
  spend = true,
): Verdict {
  const filled = refill(bucket, capacity, now)

  if (filled.tokens >= 1) {
    return {
      allowed: true,
      retryAfterMs: 0,
      bucket: spend ? { tokens: filled.tokens - 1, updatedAt: now } : filled,
    }
  }

  return {
    allowed: false,
    retryAfterMs: Math.ceil(((1 - filled.tokens) * WINDOW_MS) / capacity),
    bucket: filled,
  }
}

export type BucketStore = {
  take(id: string, capacity: number, now: number): Verdict
  /** The same verdict without spending a token. */
  peek(id: string, capacity: number, now: number): Verdict
  readonly size: number
}

/**
 * How many buckets are kept before the store starts forgetting. One bucket is
 * a few dozen bytes, so ten thousand of them is noise next to the summary
 * cache — but the keys come from source addresses, which an attacker picks,
 * and a map nobody sweeps is the leak.
 */
export const DEFAULT_MAX_BUCKETS = 10_000

export function createBucketStore(maxBuckets = DEFAULT_MAX_BUCKETS): BucketStore {
  const buckets = new Map<string, Bucket>()

  /**
   * A bucket untouched for a whole window has refilled completely, whatever
   * its capacity was, and a full bucket is indistinguishable from a caller who
   * has never been here — so dropping it forgets nothing.
   *
   * Only if that is not enough — every bucket is younger than a window, which
   * means the limits are doing their job right now — does the oldest get
   * evicted, and the caller behind it gets their allowance back early. Under
   * that kind of load an early allowance is cheaper than unbounded memory.
   */
  const sweep = (now: number) => {
    for (const [id, bucket] of buckets) {
      if (now - bucket.updatedAt >= WINDOW_MS) buckets.delete(id)
    }

    if (buckets.size <= maxBuckets) return

    const oldestFirst = [...buckets].sort((a, b) => a[1].updatedAt - b[1].updatedAt)

    for (const [id] of oldestFirst.slice(0, buckets.size - maxBuckets)) buckets.delete(id)
  }

  const decide = (id: string, capacity: number, now: number, spend: boolean): Verdict => {
    const verdict = take(buckets.get(id), capacity, now, spend)

    buckets.set(id, verdict.bucket)

    if (buckets.size > maxBuckets) sweep(now)

    return verdict
  }

  return {
    take: (id, capacity, now) => decide(id, capacity, now, true),
    peek: (id, capacity, now) => decide(id, capacity, now, false),
    get size() {
      return buckets.size
    },
  }
}

/** The refusal when the limit is reached. `retryAfter` is in seconds. */
export const limitedBody = (retryAfterMs: number) =>
  ({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Use a key for a higher limit.',
      details: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    },
  }) as const

/** The refusal when a key was presented and it is not one of ours. */
export const UNKNOWN_KEY = {
  error: { code: 'UNAUTHENTICATED', message: 'The key presented is not valid', details: {} },
} as const

/**
 * The refusal when the key was ours and its owner switched it off (FR-048).
 *
 * Told apart from an unknown key on purpose. The only caller who can tell the
 * difference is one holding a real revoked token, and they already know it was
 * real; what they do not know is why it stopped working, and a single answer
 * for both cases would send them looking for a typo.
 */
export const REVOKED_KEY = {
  error: { code: 'UNAUTHENTICATED', message: 'The key presented has been revoked', details: {} },
} as const

export type RateLimitOptions = {
  readonly store: KeyStore
  readonly logger: Logger
  readonly withKeyPerMin: number
  readonly noKeyPerMin: number
  /** Overridden in tests only. */
  readonly now?: () => number
  /** Overridden in tests only. */
  readonly addressOf?: (c: Context) => string
  readonly maxBuckets?: number
}

/**
 * An entry of `x-forwarded-for` without the port, and without the brackets an
 * IPv6 address wears when it carries one. A proxy that writes `ip:port` there
 * would otherwise hand the same caller a new bucket per connection.
 */
function withoutPort(hop: string): string {
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(hop)
  if (bracketed?.[1] !== undefined) return bracketed[1]

  // A bare IPv6 address has several colons and no port; only strip one.
  const parts = hop.split(':')

  return parts.length === 2 && parts[1] !== undefined && /^\d+$/.test(parts[1])
    ? (parts[0] ?? hop)
    : hop
}

/**
 * Addresses that cannot belong to a caller from the internet: loopback,
 * the private ranges of RFC 1918, link-local, carrier-grade NAT, and the IPv6
 * equivalents. Our own infrastructure lives there; a caller does not.
 */
const INTERNAL = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
]

const isInternal = (hop: string) => INTERNAL.some((range) => range.test(hop))

/**
 * How many entries of `x-forwarded-for` our own infrastructure appends after
 * the caller's address.
 *
 * Measured on Render, 2026-09-25, and not guessed: reading the **last** entry
 * gave one client with one stable address three to four buckets instead of
 * one, which means the chain does not end at the caller. Reading the last
 * *routable* entry changed nothing, which means what follows the caller is
 * public — a proxy address of the platform, not a private hop. One step back
 * from the end is therefore where the caller is.
 *
 * If Render ever puts another proxy in front, this number is where that shows
 * up, and the way to find it out again is in the scratchpad: drain the bucket,
 * wait a minute, count what gets served. Ten means one bucket.
 */
export const TRUSTED_PROXY_HOPS = 1

/**
 * The source address, for callers who have no key.
 *
 * Counting backwards from the end, never forwards from the start, is what
 * makes the address unforgeable: whatever a caller writes into the header
 * themselves stays to the **left** of what our own edge appends, so no
 * invented value can become the one we count by. Reading the first entry
 * would hand every caller a fresh allowance for every value they care to
 * invent.
 *
 * Two things are stepped over before counting. Entries that cannot belong to
 * anybody on the internet — loopback, RFC 1918, link-local, carrier-grade NAT
 * and their IPv6 equivalents — are certainly ours, however many of them there
 * are. Then `TRUSTED_PROXY_HOPS` routable ones are stepped over as well,
 * because the platform's own proxy addresses are routable and measurement
 * says there is one of them.
 *
 * If that lands before the start of the chain, the first entry is used. That
 * is the local and single-proxy case; in production the chain is never that
 * short, because a caller can only make it longer.
 */
export function addressFromHeaders(c: Context): string {
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => withoutPort(hop.trim()))
    .filter((hop) => hop.length > 0)

  if (hops.length === 0) return 'unknown'

  // Trailing hops of our own, whatever their number.
  let end = hops.length
  while (end > 1 && isInternal(hops[end - 1] ?? '')) end -= 1

  const index = Math.max(0, end - 1 - TRUSTED_PROXY_HOPS)

  return hops[index] ?? 'unknown'
}

/**
 * A revoked key still speaks on the route that revokes it, and nowhere else.
 *
 * Revocation is idempotent by design (T039): the second `DELETE` answers with
 * the original time of revocation, which is the only way its owner can learn
 * that the first one worked. Refusing a revoked token here would turn that
 * answer into a 401 and make the guarantee unobservable.
 */
function isRevocation(c: Context): boolean {
  return c.req.method === 'DELETE' && c.req.path.startsWith('/v1/keys/')
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { store, logger, withKeyPerMin, noKeyPerMin } = options
  const buckets = createBucketStore(options.maxBuckets)
  const clock = options.now ?? Date.now
  const addressOf = options.addressOf ?? addressFromHeaders

  const refuse = (c: Context, verdict: Verdict) => {
    c.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)))

    return c.json(limitedBody(verdict.retryAfterMs), 429)
  }

  return async (c, next) => {
    if (UNLIMITED_PATHS.includes(c.req.path)) return next()

    const now = clock()
    const token = readBearerToken(c.req.header('authorization'))
    const address = `ip:${addressOf(c)}`

    // No key, or something that is not one: the address pays the stricter
    // rate, and the request goes through (FR-047). A malformed token is not
    // worth a database lookup, so it costs exactly what no token costs.
    if (token === undefined) {
      const verdict = buckets.take(address, noKeyPerMin, now)

      return verdict.allowed ? next() : refuse(c, verdict)
    }

    // Asked without spending: a caller feeding the route invented tokens must
    // not get one database lookup per attempt, and a caller with a real key
    // must not spend from the address bucket at all — behind one NAT they
    // would otherwise limit each other.
    const peeked = buckets.peek(address, noKeyPerMin, now)
    if (!peeked.allowed) return refuse(c, peeked)

    const key = await store.findByHash(await hashKeyToken(token))

    if (key === undefined) {
      buckets.take(address, noKeyPerMin, now)

      return c.json(UNKNOWN_KEY, 401)
    }

    if (key.revokedAt !== null && !isRevocation(c)) {
      buckets.take(address, noKeyPerMin, now)

      return c.json(REVOKED_KEY, 401)
    }

    const verdict = buckets.take(`key:${key.id}`, withKeyPerMin, now)
    if (!verdict.allowed) return refuse(c, verdict)

    // The id, for routes that need to know whose request this is (T046).
    c.set('keyId', key.id)

    if (key.revokedAt === null) {
      // Not awaited: the counter measures volume for billing that does not
      // exist yet, and a write on every keyed request would be paid for by
      // SC-004 on every keyed request. A crash loses a handful of increments;
      // waiting for the database loses milliseconds on all of them.
      //
      // A revoked key gets no increment at all: FR-048 promises its counters
      // are **kept**, not that they keep growing.
      store
        .recordUsage(key.id, new Date(now))
        .catch((cause: unknown) => logger.warn('лічильник звернень не оновлено', { err: cause }))
    }

    return next()
  }
}
