import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNotAvailableError, createRpcClient, RpcError, SlotSkippedError } from './rpc.ts'

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
      maxSupportedTransactionVersion: 0,
    })
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
})
