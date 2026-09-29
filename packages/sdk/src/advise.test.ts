import { describe, expect, it } from 'vitest'
import {
  advise,
  DEFAULT_BASE_URL,
  FairLaneError,
  type Intent,
  type Recommendation,
} from './index.ts'

const INTENT: Intent = {
  programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  computeUnits: 200_000,
  mode: 'cheap',
}

const ADVICE: Recommendation = {
  groupId: 'jito',
  targetSlots: 4,
  tipLamports: 1_000,
  priorityFeeMicroLamports: 12_500,
  expectedCost: 8_500,
  landProbability: null,
  dataAgeMs: 4_200,
  isStale: false,
  note: null,
}

const KEY = `flr_${'ab'.repeat(32)}`

type Call = { readonly url: string; readonly init: RequestInit }

/** A `fetch` that records what it was asked and answers from a script. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return answer(call)
  }

  return { fetch: fetch as typeof globalThis.fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

async function failure(promise: Promise<unknown>): Promise<FairLaneError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(FairLaneError)
  return error as FairLaneError
}

describe('advise', () => {
  it('posts the intent with the default window filled in and returns the advice', async () => {
    const { fetch, calls } = fakeFetch(() => json(ADVICE))

    await expect(advise(INTENT, { fetch })).resolves.toEqual(ADVICE)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/recommend`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ...INTENT, targetSlots: 4 })
  })

  it('sends the key as a bearer token, and no authorization header without one', async () => {
    const { fetch, calls } = fakeFetch(() => json(ADVICE))

    await advise(INTENT, { fetch, apiKey: KEY })
    await advise(INTENT, { fetch })

    const headerOf = (call: Call | undefined) =>
      new Headers(call?.init.headers).get('authorization')
    expect(headerOf(calls[0])).toBe(`Bearer ${KEY}`)
    expect(headerOf(calls[1])).toBeNull()
  })

  it.each([
    ['an empty key, as from an unset variable', ''],
    ['a key without its prefix', 'ab'.repeat(32)],
    ['a truncated key', KEY.slice(0, -1)],
  ])('refuses %s locally instead of being served at the keyless limit', async (_, apiKey) => {
    const { fetch, calls } = fakeFetch(() => json(ADVICE))

    const error = await failure(advise(INTENT, { fetch, apiKey }))

    expect(error.code).toBe('INVALID_INPUT')
    expect(error.field).toBe('apiKey')
    expect(calls).toHaveLength(0)
  })

  it('keeps a path prefix of the base URL and drops its trailing slash', async () => {
    const { fetch, calls } = fakeFetch(() => json(ADVICE))

    await advise(INTENT, { fetch, baseUrl: 'https://example.dev/fairlane/' })

    expect(calls[0]?.url).toBe('https://example.dev/fairlane/v1/recommend')
  })

  it('refuses a malformed intent locally, naming the field, without a request', async () => {
    const { fetch, calls } = fakeFetch(() => json(ADVICE))

    const error = await failure(advise({ ...INTENT, computeUnits: 0 }, { fetch }))

    expect(error.code).toBe('INVALID_INPUT')
    expect(error.field).toBe('computeUnits')
    expect(error.status).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('names an unknown field the way the server does', async () => {
    const { fetch } = fakeFetch(() => json(ADVICE))
    const misspelt = { ...INTENT, targetSlot: 2 } as unknown as Intent

    const error = await failure(advise(misspelt, { fetch }))

    expect(error.code).toBe('INVALID_INPUT')
    expect(error.field).toBe('targetSlot')
  })

  it('passes stale fallback advice through as advice, not as a failure', async () => {
    const stale = { ...ADVICE, groupId: 'rpc', dataAgeMs: null, isStale: true }
    const { fetch } = fakeFetch(() => json(stale))

    await expect(advise(INTENT, { fetch })).resolves.toEqual(stale)
  })

  it('drops fields the server adds later instead of failing on them', async () => {
    const { fetch } = fakeFetch(() => json({ ...ADVICE, confidence: 'high' }))

    await expect(advise(INTENT, { fetch })).resolves.toEqual(ADVICE)
  })

  it('refuses an answer that breaks the contract rather than handing it on', async () => {
    // Fresh advice without the age it rests on.
    const { fetch } = fakeFetch(() => json({ ...ADVICE, dataAgeMs: null }))

    const error = await failure(advise(INTENT, { fetch }))

    expect(error.code).toBe('UNEXPECTED_RESPONSE')
    expect(error.status).toBe(200)
  })

  it('carries a refusal code, message and field from the error body', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'mode must be one of: cheap, fast',
            details: { field: 'mode' },
          },
        },
        400,
      ),
    )

    const error = await failure(advise(INTENT, { fetch }))

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'mode must be one of: cheap, fast',
      field: 'mode',
      status: 400,
    })
  })

  it('reports STALE_DATA when no group can be priced', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        {
          error: {
            code: 'STALE_DATA',
            message: 'No sendable group has enough recent landings',
            details: {},
          },
        },
        503,
      ),
    )

    const error = await failure(advise(INTENT, { fetch }))

    expect(error.code).toBe('STALE_DATA')
    expect(error.status).toBe(503)
  })

  it('takes the wait before retrying from Retry-After, and from the body without it', async () => {
    const limited = {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        details: { retryAfterSeconds: 7 },
      },
    }
    const withHeader = fakeFetch(() => json(limited, 429, { 'retry-after': '3' }))
    const withoutHeader = fakeFetch(() => json(limited, 429))

    expect((await failure(advise(INTENT, { fetch: withHeader.fetch }))).retryAfterMs).toBe(3_000)
    expect((await failure(advise(INTENT, { fetch: withoutHeader.fetch }))).retryAfterMs).toBe(7_000)
  })

  it('passes on a code the SDK does not know yet', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 'PAYMENT_REQUIRED', message: 'Top up' } }, 402),
    )

    const error = await failure(advise(INTENT, { fetch }))

    expect(error.code).toBe('PAYMENT_REQUIRED')
    expect(error.status).toBe(402)
  })

  it('reports an answer in some other format, such as a host error page, as unexpected', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }))

    const error = await failure(advise(INTENT, { fetch }))

    expect(error.code).toBe('UNEXPECTED_RESPONSE')
    expect(error.status).toBe(502)
  })

  it('reports a failed connection as NETWORK with the cause attached', async () => {
    const cause = new TypeError('fetch failed')
    const { fetch } = fakeFetch(() => Promise.reject(cause))

    const error = await failure(advise(INTENT, { fetch }))

    expect(error.code).toBe('NETWORK')
    expect(error.status).toBeNull()
    expect(error.cause).toBe(cause)
  })

  it('gives up after the timeout', async () => {
    const { fetch } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )

    const error = await failure(advise(INTENT, { fetch, timeoutMs: 20 }))

    expect(error.code).toBe('TIMEOUT')
  })

  it("rejects with the caller's own reason when the caller aborts", async () => {
    const controller = new AbortController()
    const reason = new Error('user navigated away')
    const { fetch } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )

    const pending = advise(INTENT, { fetch, signal: controller.signal })
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })
})
