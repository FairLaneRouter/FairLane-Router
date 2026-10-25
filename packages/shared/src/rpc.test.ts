import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BlockNotAvailableError,
  createRpcClient,
  endpointLabel,
  MAX_SUPPORTED_TX_VERSION,
  RpcError,
  SlotSkippedError,
} from './rpc.ts'

const block = {
  blockhash: 'Fh1s9…',
  parentSlot: 341882102,
  blockTime: 1756330000,
  transactions: [
    {
      transaction: {
        signatures: ['sig1'],
        message: { accountKeys: ['payer', 'tip1'], instructions: [{ programIdIndex: 1 }] },
      },
      meta: {
        err: null,
        fee: 9700,
        computeUnitsConsumed: 42000,
        preBalances: [1000000, 0],
        postBalances: [947100, 43200],
      },
    },
  ],
}

function respond(result: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  })
}

describe('createRpcClient', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the current slot', async () => {
    const fetch = respond(341882103)
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getSlot()).resolves.toBe(341882103)
  })

  it('parses a block into a typed shape', async () => {
    const fetch = respond(block)
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })
    const parsed = await rpc.getBlock(341882103)

    expect(parsed.blockTime).toBe(1756330000)
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.transactions[0]?.meta.fee).toBe(9700)
    expect(parsed.transactions[0]?.transaction.signatures[0]).toBe('sig1')
  })

  it('asks for the fields the indexer needs and refuses unsupported tx versions', async () => {
    const fetch = respond(block)
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })
    await rpc.getBlock(341882103)

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.method).toBe('getBlock')
    expect(body.params[1]).toMatchObject({
      transactionDetails: 'full',
      rewards: false,
      maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
    })
  })

  // Пін нижчий за версії в мережі зупиняє збір цілком, і сире повідомлення
  // вузла звучить як проблема мережі. Помилка має називати константу.
  it('names the version ceiling when the node refuses the block', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32015,
          message:
            'Transaction version (9) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 9',
        },
      }),
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBlock(341882103)).rejects.toThrow(/MAX_SUPPORTED_TX_VERSION/)
  })

  // Пропущений слот — штатний стан ланцюга, не збій. Плутати їх означає
  // писати кожен skipped slot у прогалини і вічно намагатись його дочитати.
  it('distinguishes a skipped slot from a failure', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32009, message: 'Slot 341882103 was skipped' },
      }),
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBlock(341882103)).rejects.toBeInstanceOf(SlotSkippedError)
  })

  // «Блока ще немає» і «слота не існує» приходять обидва помилкою, а рішення
  // за ними протилежні: перший дочитується обов'язково, другий — ніколи.
  it('distinguishes a block the node does not have yet from a skipped slot', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32004, message: 'Block not available for slot 341882103' },
      }),
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    const failure = await rpc.getBlock(341882103).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(BlockNotAvailableError)
    expect(failure).not.toBeInstanceOf(SlotSkippedError)
  })

  it('raises RpcError with the node code on any other rpc error', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32005, message: 'Node is behind' },
      }),
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBlock(1)).rejects.toMatchObject({ name: 'RpcError', code: -32005 })
  })

  it('rejects a malformed result instead of passing it on', async () => {
    const fetch = respond({ transactions: [{ meta: { fee: 'free' } }] })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBlock(1)).rejects.toBeInstanceOf(RpcError)
  })

  it('returns a balance in lamports as a bigint', async () => {
    const fetch = respond({ context: { slot: 341882103 }, value: 1_234_567_890 })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBalance('Wallet1111')).resolves.toBe(1_234_567_890n)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.method).toBe('getBalance')
    expect(body.params).toEqual(['Wallet1111', { commitment: 'confirmed' }])
  })

  // Past 2^53 JSON.parse has already rounded the number: passing it on as
  // bigint would dress a rounded value up as an exact one.
  it.each([
    ['a balance JSON cannot carry exactly', { context: { slot: 1 }, value: 2 ** 53 }],
    ['a negative balance', { context: { slot: 1 }, value: -1 }],
    ['a fractional balance', { context: { slot: 1 }, value: 1.5 }],
    ['a bare number without the context envelope', 1000],
  ])('rejects %s', async (_, result) => {
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch: respond(result) })

    await expect(rpc.getBalance('Wallet1111')).rejects.toBeInstanceOf(RpcError)
  })

  it('falls back to the second url when the first one fails', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: 7 }) })
    const rpc = createRpcClient({
      url: 'https://rpc.example',
      fallbackUrl: 'https://backup.example',
      fetch,
    })

    await expect(rpc.getSlot()).resolves.toBe(7)
    expect(fetch.mock.calls[1]?.[0]).toBe('https://backup.example')
  })

  it('gives up when every url fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getSlot()).rejects.toBeInstanceOf(RpcError)
  })

  // The key lives in the URL: Helius puts it in the query, others in the path.
  // The error text goes to the log, so it may name the host and nothing more.
  it('keeps the key out of the error when every url fails', async () => {
    const key = 'secret-key-0123456789'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockRejectedValueOnce(new Error(`request to https://backup.example/${key} failed`))
    const rpc = createRpcClient({
      url: `https://mainnet.helius-rpc.com/?api-key=${key}`,
      fallbackUrl: `https://backup.example/${key}`,
      fetch,
    })

    const failure = await rpc.getSlot().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(RpcError)
    expect(String((failure as Error).message)).not.toContain(key)
    expect((failure as Error).message).toContain('mainnet.helius-rpc.com: HTTP 429')
    expect((failure as Error).message).toContain('request to backup.example failed')
  })
})

describe('endpointLabel', () => {
  it('names an endpoint by its host, without path or query', () => {
    expect(endpointLabel('https://mainnet.helius-rpc.com/?api-key=abc')).toBe(
      'mainnet.helius-rpc.com',
    )
    expect(endpointLabel('https://solana-mainnet.g.alchemy.com/v2/abc')).toBe(
      'solana-mainnet.g.alchemy.com',
    )
  })

  it('does not echo a value that is not a URL', () => {
    expect(endpointLabel('not a url with abc')).toBe('rpc endpoint')
  })
})

describe('createRpcClient — sending and confirming', () => {
  const bodyOf = (fetch: ReturnType<typeof respond>) =>
    JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))

  it('sends the wire bytes as base64, without preflight', async () => {
    const fetch = respond('5ig1')
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.sendTransaction(Uint8Array.from([1, 2, 250, 255]))).resolves.toBe('5ig1')
    expect(bodyOf(fetch)).toMatchObject({
      method: 'sendTransaction',
      params: [
        Buffer.from([1, 2, 250, 255]).toString('base64'),
        { encoding: 'base64', skipPreflight: true },
      ],
    })
  })

  it('rejects a send answered with something other than a signature', async () => {
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch: respond({ bundle: 1 }) })

    await expect(rpc.sendTransaction(Uint8Array.from([1]))).rejects.toBeInstanceOf(RpcError)
  })

  it('reads the latest blockhash at confirmed, with the slot it was read at', async () => {
    const fetch = respond({
      context: { slot: 412 },
      value: { blockhash: 'Hash111', lastValidBlockHeight: 560 },
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getLatestBlockhash()).resolves.toEqual({
      blockhash: 'Hash111',
      lastValidBlockHeight: 560,
      slot: 412,
    })
    expect(bodyOf(fetch).params).toEqual([{ commitment: 'confirmed' }])
  })

  it('reads the block height at confirmed', async () => {
    const fetch = respond(560)
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getBlockHeight()).resolves.toBe(560)
    expect(bodyOf(fetch)).toMatchObject({
      method: 'getBlockHeight',
      params: [{ commitment: 'confirmed' }],
    })
  })

  it('returns one status per signature, null for one not seen', async () => {
    const fetch = respond({
      context: { slot: 9 },
      value: [
        { slot: 7, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
        null,
        { slot: 8, confirmations: null, err: null, status: { Ok: null } },
      ],
    })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getSignatureStatuses(['a', 'b', 'c'])).resolves.toEqual([
      { slot: 7, confirmationStatus: 'confirmed' },
      null,
      { slot: 8, confirmationStatus: null },
    ])
    expect(bodyOf(fetch).params).toEqual([['a', 'b', 'c'], { searchTransactionHistory: false }])
  })

  it('rejects statuses that do not line up with the signatures asked for', async () => {
    const fetch = respond({ context: { slot: 9 }, value: [null] })
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch })

    await expect(rpc.getSignatureStatuses(['a', 'b'])).rejects.toBeInstanceOf(RpcError)
  })

  it('reads a transaction back with its slot, or null while the node lacks it', async () => {
    const tx = { slot: 77, ...block.transactions[0] }
    const rpc = createRpcClient({ url: 'https://rpc.example', fetch: respond(tx) })
    const missing = createRpcClient({ url: 'https://rpc.example', fetch: respond(null) })

    await expect(rpc.getTransaction('sig1')).resolves.toMatchObject({
      slot: 77,
      meta: { fee: 9700 },
    })
    await expect(missing.getTransaction('sig1')).resolves.toBeNull()
  })

  it('passes a timeout signal only when one is asked for', async () => {
    const timed = respond(1)
    const plain = respond(1)
    await createRpcClient({
      url: 'https://rpc.example',
      fetch: timed,
      timeoutMs: 5_000,
    }).getBlockHeight()
    await createRpcClient({ url: 'https://rpc.example', fetch: plain }).getBlockHeight()

    expect(timed.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(plain.mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })
})
