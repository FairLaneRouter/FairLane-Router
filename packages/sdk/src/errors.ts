/**
 * The codes the API answers with, plus the ones the SDK adds for failures
 * that never reached an answer. Listed for autocompletion and branching; the
 * type stays open, because a server may add a code before the SDK learns it
 * and an installed SDK must pass it on rather than break.
 */
export const KNOWN_ERROR_CODES = [
  // From the API.
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'STALE_DATA',
  'NOT_FOUND',
  'INTERNAL',
  // From the SDK: no answer, or an answer that is not the API's.
  'NETWORK',
  'TIMEOUT',
  'UNEXPECTED_RESPONSE',
] as const

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number]

export type FairLaneErrorCode = KnownErrorCode | (string & {})

export type FairLaneErrorInit = {
  /** HTTP status, or `null` when the request never got an answer or was refused locally. */
  readonly status: number | null
  /** The request field an `INVALID_INPUT` is about, e.g. `computeUnits`. */
  readonly field?: string | undefined
  /** How long to wait before asking again, from a `RATE_LIMITED` answer. */
  readonly retryAfterMs?: number | undefined
  readonly cause?: unknown
}

/**
 * Every failure of the SDK. One class with a code rather than a class per
 * failure: the caller branches on `code`, and a new server code needs no new
 * class to arrive intact.
 */
export class FairLaneError extends Error {
  override readonly name = 'FairLaneError'
  readonly code: FairLaneErrorCode
  readonly status: number | null
  readonly field: string | undefined
  readonly retryAfterMs: number | undefined

  constructor(code: FairLaneErrorCode, message: string, init: FairLaneErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = code
    this.status = init.status
    this.field = init.field
    this.retryAfterMs = init.retryAfterMs
  }
}
