import { z } from 'zod'
import { keyTokenSchema } from '../../shared/src/keyToken.ts'
import {
  describeInputIssue,
  type IntentInput,
  intentSchema,
  type Recommendation,
  recommendationSchema,
} from '../../shared/src/recommend.schema.ts'
import { FairLaneError } from './errors.ts'

/** The public FairLane API. Override `baseUrl` to point at your own deployment. */
export const DEFAULT_BASE_URL = 'https://fairlane-api.onrender.com'

/**
 * Advice is priced for the moment it is asked; an answer that comes later than
 * this is about a market that has already moved.
 */
export const DEFAULT_TIMEOUT_MS = 10_000

export type AdviseOptions = {
  /**
   * A key from `POST /v1/keys`. Without one the call is keyless and gets the
   * stricter rate limit; one that is not shaped like a key is refused locally.
   */
  readonly apiKey?: string | undefined
  /** Defaults to {@link DEFAULT_BASE_URL}. A path prefix is kept, a trailing slash is not. */
  readonly baseUrl?: string | undefined
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined
  /** Aborting it rejects with the signal's own reason, not with a `FairLaneError`. */
  readonly signal?: AbortSignal | undefined
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined
}

/**
 * Which channel group to send a transaction through, at what bid, and how old
 * the data behind that is (FR-019, advice mode).
 *
 * The intent is checked here with the server's own schema, so a malformed one
 * fails at once, with the same field and message the server would give and
 * without a request. The answer is checked too: fields the server adds later
 * are dropped, never fatal, but an answer that breaks the contract is refused
 * rather than handed on as advice.
 *
 * Nothing here signs or sends a transaction, and no Solana library is
 * involved: the SDK imposes none on the integrator.
 *
 * @throws {FairLaneError} on any failure; `code` tells which.
 */
export async function advise(
  intent: IntentInput,
  options: AdviseOptions = {},
): Promise<Recommendation> {
  const parsed = intentSchema.safeParse(intent)

  if (!parsed.success) {
    const issue = describeInputIssue(parsed.error)

    throw new FairLaneError('INVALID_INPUT', issue.message, { status: null, field: issue.field })
  }

  // The server reads a token that is not shaped like a key as no key at all
  // and serves the call at the keyless limit (T040). A typo or an unset
  // variable would then look like working code with a quietly lower limit;
  // here it fails before the request instead.
  if (options.apiKey !== undefined && !keyTokenSchema.safeParse(options.apiKey).success) {
    throw new FairLaneError(
      'INVALID_INPUT',
      'apiKey is not a FairLane key: expected flr_ and 64 hex characters',
      {
        status: null,
        field: 'apiKey',
      },
    )
  }

  const { status, headers, body } = await post('/v1/recommend', parsed.data, options)

  if (status < 200 || status > 299) throw refusal(status, headers, body)

  const advice = recommendationSchema.safeParse(parseJson(body))

  if (!advice.success) {
    throw new FairLaneError(
      'UNEXPECTED_RESPONSE',
      'The FairLane API answered with something that is not advice',
      {
        status,
        cause: advice.error,
      },
    )
  }

  return advice.data
}

type Answer = {
  readonly status: number
  readonly headers: Headers
  readonly body: string
}

async function post(path: string, payload: unknown, options: AdviseOptions): Promise<Answer> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    })

    // Read under the same signal: a body that never finishes is as much a
    // timeout as an answer that never starts.
    return { status: response.status, headers: response.headers, body: await response.text() }
  } catch (cause) {
    if (options.signal?.aborted === true) throw options.signal.reason

    if (timeout.aborted) {
      throw new FairLaneError('TIMEOUT', `The FairLane API did not answer within ${timeoutMs} ms`, {
        status: null,
        cause,
      })
    }

    throw new FairLaneError('NETWORK', 'The FairLane API could not be reached', {
      status: null,
      cause,
    })
  }
}

/** Lenient like the recommendation: only `code` and `message` are relied on. */
const errorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

function refusal(status: number, headers: Headers, body: string): FairLaneError {
  const parsed = errorBodySchema.safeParse(parseJson(body))

  // A proxy in front of the API answers in its own format — an HTML page from
  // the host, say. It is still a failure, just not one the API described.
  if (!parsed.success) {
    return new FairLaneError(
      'UNEXPECTED_RESPONSE',
      `The FairLane API answered ${status} without an error body`,
      {
        status,
      },
    )
  }

  const { code, message, details } = parsed.data.error
  const field = details?.field

  return new FairLaneError(code, message, {
    status,
    field: typeof field === 'string' ? field : undefined,
    retryAfterMs: retryAfterMs(headers, details?.retryAfterSeconds),
  })
}

/** The header first, as HTTP intends; the body's copy for callers behind a proxy that strips it. */
function retryAfterMs(headers: Headers, fromBody: unknown): number | undefined {
  const header = headers.get('retry-after')
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : fromBody

  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
