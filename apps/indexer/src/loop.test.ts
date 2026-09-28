import type { Block, RpcClient } from '@fairlane/shared'
import { BlockNotAvailableError, createLogger, SlotSkippedError } from '@fairlane/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_HEAD_BACKOFF_MS,
  nextSampleSlot,
  readHead,
  runSlotLoop,
  type SlotFailure,
} from './loop.ts'

const silent = createLogger({ level: 'fatal', sink: () => {} })

const block = (slot: number): Block => ({
  blockhash: `hash-${slot}`,
  parentSlot: slot - 1,
  blockTime: 1_800_000_000,
  transactions: [],
})

type FakeRpc = RpcClient & { readonly requested: number[] }

/**
 * `head` можна задати послідовністю: голова ланцюга рухається, і без цього
 * цикл, що чекає на слот попереду голови, не дочекався б його ніколи.
 */
function fakeRpc(
  head: number | number[],
  failures: Map<number, Error | Error[]> = new Map(),
): FakeRpc {
  const requested: number[] = []
  const heads = Array.isArray(head) ? [...head] : [head]

  return {
    requested,
    getSlot: () => Promise.resolve(heads.length > 1 ? (heads.shift() ?? 0) : (heads[0] ?? 0)),
    getBlock: (slot: number) => {
      requested.push(slot)
      const failure = failures.get(slot)
      // Список означає «падає стільки разів, а далі віддається»: саме так
      // поводиться вузол, який на мить відстав від голови.
      const next = Array.isArray(failure) ? failure.shift() : failure
      return next ? Promise.reject(next) : Promise.resolve(block(slot))
    },
  }
}

/** Зупиняє цикл після того, як він обробив задану кількість слотів. */
function stopAfter(count: number) {
  const controller = new AbortController()
  const seen: number[] = []

  const onSlot = (_block: Block, slot: number): Promise<void> => {
    seen.push(slot)
    if (seen.length >= count) controller.abort()
    return Promise.resolve()
  }

  return { controller, seen, onSlot }
}

describe('nextSampleSlot', () => {
  // Сітка, а не відлік від старту: набір оглянутих слотів має бути однаковим
  // після кожного перезапуску, інакше вибірку не можна перевірити збоку.
  it('snaps to the grid regardless of where it starts', () => {
    expect(nextSampleSlot(0, 100)).toBe(100)
    expect(nextSampleSlot(1, 100)).toBe(100)
    expect(nextSampleSlot(99, 100)).toBe(100)
    expect(nextSampleSlot(437, 100)).toBe(500)
  })

  it('always moves forward, even from a slot already on the grid', () => {
    expect(nextSampleSlot(100, 100)).toBe(200)
    expect(nextSampleSlot(1000, 500)).toBe(1500)
  })
})

describe('runSlotLoop', () => {
  it('reads only slots on the sampling grid', async () => {
    const rpc = fakeRpc(1_000)
    const { controller, seen, onSlot } = stopAfter(3)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([100, 200, 300])
  })

  it('starts at the next grid slot after the current head', async () => {
    const rpc = fakeRpc([1_437, 1_600])
    const { controller, seen, onSlot } = stopAfter(1)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([1_500])
  })

  it('waits instead of racing ahead of the confirmed head', async () => {
    const rpc = fakeRpc(250)
    // Порогу в три слоти цикл не досягне: за головою 250 їх лише два, і зупинити
    // його має саме очікування, а не лічильник.
    const { controller, seen, onSlot } = stopAfter(3)
    const sleep = vi.fn(() => {
      // Голова не рухається, тож після двох слотів чекати вже нічого — цикл
      // мав би спати вічно, і цей виклик його зупиняє.
      controller.abort()
      return Promise.resolve()
    })

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep,
    })

    expect(seen).toEqual([100, 200])
    expect(rpc.requested).toEqual([100, 200])
    expect(sleep).toHaveBeenCalled()
  })

  // Пропущений слот — штатний стан ланцюга: його не існує і не з'явиться.
  it('steps over a slot that is skipped in the ledger', async () => {
    const rpc = fakeRpc(1_000, new Map([[200, new SlotSkippedError(200, -32009)]]))
    const { controller, seen, onSlot } = stopAfter(2)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([100, 300])
    expect(rpc.requested).toEqual([100, 200, 300])
  })

  // Один невдалий слот не має гасити збір: він лишається прогалиною для T030.
  it('survives an RPC failure on one slot', async () => {
    const rpc = fakeRpc(1_000, new Map([[200, new Error('502 від провайдера')]]))
    const { controller, seen, onSlot } = stopAfter(2)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([100, 300])
  })

  it('reports the failure with the slot it happened on', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: 'error',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    const rpc = fakeRpc(1_000, new Map([[100, new Error('502 від провайдера')]]))
    const { controller, onSlot } = stopAfter(1)

    await runSlotLoop({
      rpc,
      logger,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      // Єдиний слот вибірки впав, тому onSlot не викличеться ніколи і зупинити
      // цикл нема кому: обриваємо його на першій же паузі.
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
    })

    expect(lines[0]).toMatchObject({ slot: 100, err: { message: '502 від провайдера' } })
  })

  // Перший прогін на mainnet втратив так два слоти вибірки з чотирьох:
  // `getSlot` за рівнем `confirmed` віддає слот, блока якого вузол ще не подає.
  it('keeps a margin behind the confirmed head before asking for a block', async () => {
    const rpc = fakeRpc(231)
    const controller = new AbortController()
    const sleep = vi.fn(() => {
      controller.abort()
      return Promise.resolve()
    })

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      startSlot: 200,
      signal: controller.signal,
      sleep,
    })

    expect(rpc.requested).toEqual([])
    expect(sleep).toHaveBeenCalled()
  })

  it('asks for the block once the head is a full margin past it', async () => {
    const rpc = fakeRpc(232)
    const { controller, seen, onSlot } = stopAfter(1)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 200,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([200])
  })

  // Вузол, який на мить відстав, наздоганяє за секунди — і слот, відданий на
  // другій спробі, це слот, збережений цілком.
  it('asks again while the node does not have the block yet', async () => {
    const rpc = fakeRpc(
      1_000,
      new Map([[100, [new BlockNotAvailableError(100, -32004), new BlockNotAvailableError(100, -32004)]]]),
    )
    const { controller, seen, onSlot } = stopAfter(1)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(rpc.requested).toEqual([100, 100, 100])
    expect(seen).toEqual([100])
  })

  it('hands a slot it never got to the gap watcher', async () => {
    const rpc = fakeRpc(1_000, new Map([[200, new Error('502 від провайдера')]]))
    const { controller, seen, onSlot } = stopAfter(2)
    const failures: SlotFailure[] = []

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
      onSlotFailed: (failure) => {
        failures.push(failure)
      },
    })

    expect(seen).toEqual([100, 300])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ slot: 200, attempts: 3 })
  })

  // Наглядач прогалин теж ходить у базу, а база — рівно те, що могло щойно
  // впасти. Його власна помилка не має права зупинити збір.
  it('keeps collecting when the gap watcher itself fails', async () => {
    const rpc = fakeRpc(1_000, new Map([[200, new Error('502 від провайдера')]]))
    const { controller, seen, onSlot } = stopAfter(2)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
      onSlotFailed: () => Promise.reject(new Error('база недоступна')),
    })

    expect(seen).toEqual([100, 300])
  })

  it('does not retry a slot that is skipped in the ledger', async () => {
    const rpc = fakeRpc(1_000, new Map([[100, new SlotSkippedError(100, -32007)]]))
    const { controller, seen, onSlot } = stopAfter(1)
    const failures: SlotFailure[] = []

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
      onSlotFailed: (failure) => {
        failures.push(failure)
      },
    })

    expect(rpc.requested).toEqual([100, 200])
    expect(seen).toEqual([200])
    expect(failures).toEqual([])
  })

  it('does not start at all when the signal is already aborted', async () => {
    const rpc = fakeRpc(1_000)
    const controller = new AbortController()
    controller.abort()

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot: () => Promise.reject(new Error('не має викликатись')),
      sampleEveryN: 100,
      startSlot: 100,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(rpc.requested).toEqual([])
  })
})

/** An RPC whose `getSlot` fails the given number of times first, then answers `head`. */
function flakyHead(failures: number, head = 1_000): RpcClient & { readonly asked: () => number } {
  let asked = 0

  return {
    asked: () => asked,
    getSlot: () => {
      asked += 1
      return asked <= failures
        ? Promise.reject(new Error('429 max usage reached'))
        : Promise.resolve(head)
    },
    getBlock: (slot: number) => Promise.resolve(block(slot)),
  }
}

describe('readHead', () => {
  it('keeps asking until the provider answers', async () => {
    const rpc = flakyHead(3)

    const head = await readHead({
      rpc,
      logger: silent,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
    })

    expect(head).toBe(1_000)
    expect(rpc.asked()).toBe(4)
  })

  it('doubles the pause after each failure, up to the ceiling', async () => {
    const pauses: number[] = []

    await readHead({
      rpc: flakyHead(10),
      logger: silent,
      retryDelayMs: 2_000,
      sleep: (ms) => {
        pauses.push(ms)
        return Promise.resolve()
      },
    })

    expect(pauses.slice(0, 6)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, MAX_HEAD_BACKOFF_MS])
    expect(Math.max(...pauses)).toBe(MAX_HEAD_BACKOFF_MS)
  })

  it('gives up only when the signal stops it', async () => {
    const controller = new AbortController()
    let pauses = 0

    const head = await readHead({
      rpc: flakyHead(Number.POSITIVE_INFINITY),
      logger: silent,
      retryDelayMs: 10,
      signal: controller.signal,
      sleep: () => {
        pauses += 1
        if (pauses === 5) controller.abort()
        return Promise.resolve()
      },
    })

    expect(head).toBeNull()
  })
})

describe('runSlotLoop when the head cannot be read', () => {
  // 2026-09-28: the provider answered "max usage reached", the loop's own
  // `getSlot` threw, and collection ended for ten hours with the API still up.
  it('outlives a head that fails mid-run and resumes where it was', async () => {
    let asked = 0
    const rpc: RpcClient = {
      getSlot: () => {
        asked += 1
        return asked >= 2 && asked <= 4
          ? Promise.reject(new Error('429 max usage reached'))
          : Promise.resolve(1_000)
      },
      getBlock: (slot: number) => Promise.resolve(block(slot)),
    }
    const { controller, seen, onSlot } = stopAfter(3)

    await expect(
      runSlotLoop({
        rpc,
        logger: silent,
        onSlot,
        sampleEveryN: 100,
        startSlot: 100,
        signal: controller.signal,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined()

    expect(seen).toEqual([100, 200, 300])
    expect(asked).toBeGreaterThan(4)
  })

  it('waits for the head at start instead of failing to start', async () => {
    // Two failures, then a head of 1 050 to start from; after that the chain
    // has moved to 1 200, so the first grid slot, 1 100, can be read.
    let asked = 0
    const rpc: RpcClient = {
      getSlot: () => {
        asked += 1
        if (asked <= 2) return Promise.reject(new Error('429 max usage reached'))
        return Promise.resolve(asked === 3 ? 1_050 : 1_200)
      },
      getBlock: (slot: number) => Promise.resolve(block(slot)),
    }
    const { controller, seen, onSlot } = stopAfter(1)

    await runSlotLoop({
      rpc,
      logger: silent,
      onSlot,
      sampleEveryN: 100,
      headMarginSlots: 0,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    })

    expect(seen).toEqual([1_100])
  })
})
