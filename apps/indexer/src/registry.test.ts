import { buildChannelRegistry, createLogger, DEFAULT_REGISTRY } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import {
  registryRows,
  syncRegistry,
  type ChannelGroupRow,
  type ChannelRow,
  type RegistryStore,
} from './registry.ts'

const silent = createLogger({ level: 'fatal', sink: () => {} })

function fakeStore(): RegistryStore & { readonly calls: string[]; groups: ChannelGroupRow[]; channels: ChannelRow[] } {
  const store = {
    calls: [] as string[],
    groups: [] as ChannelGroupRow[],
    channels: [] as ChannelRow[],
    saveGroups: (rows: readonly ChannelGroupRow[]) => {
      store.calls.push('groups')
      store.groups = [...rows]
      return Promise.resolve()
    },
    saveChannels: (rows: readonly ChannelRow[]) => {
      store.calls.push('channels')
      store.channels = [...rows]
      return Promise.resolve()
    },
  }

  return store
}

describe('registryRows', () => {
  it('turns the code registry into rows of both tables', () => {
    const rows = registryRows(buildChannelRegistry(DEFAULT_REGISTRY))

    expect(rows.groups.map((group) => group.id)).toEqual(['jito', 'nozomi', 'bloxroute', 'rpc'])
    expect(rows.groups.find((group) => group.id === 'jito')?.memberNames).toEqual(['Jito'])
    expect(rows.channels).toHaveLength(4)
  })

  it('carries the tip accounts of a channel', () => {
    const rows = registryRows(buildChannelRegistry(DEFAULT_REGISTRY))
    const jito = rows.channels.find((channel) => channel.id === 'jito')

    expect(jito?.tipAccounts).toContain('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5')
    expect(jito?.groupId).toBe('jito')
  })

  // Ендпоінти каналів — секрети. У БД їде назва змінної оточення, і сторонній
  // читач таблиці бачить, чим канал вмикається, а не чим до нього достукатись.
  it('stores the name of the endpoint variable, never its value', () => {
    const rows = registryRows(
      buildChannelRegistry(DEFAULT_REGISTRY, { jito: 'https://secret.example/token' }),
    )
    const jito = rows.channels.find((channel) => channel.id === 'jito')

    expect(jito?.endpointEnvKey).toBe('CHANNEL_JITO_ENDPOINT')
    expect(JSON.stringify(rows)).not.toContain('secret.example')
  })

  // `canSend` залежить від оточення процесу, а індексатору ендпоінти каналів
  // не потрібні взагалі: записаний ним `canSend` виглядав би в API як
  // вимкнений канал. У таблицях лежить ознака довідника, стала для всіх.
  it('records the registry flag, not the endpoint-dependent one', () => {
    const withoutEndpoints = registryRows(buildChannelRegistry(DEFAULT_REGISTRY))
    const withEndpoints = registryRows(
      buildChannelRegistry(DEFAULT_REGISTRY, { jito: 'https://secret.example/token' }),
    )

    expect(withoutEndpoints.channels).toEqual(withEndpoints.channels)
    expect(withoutEndpoints.groups).toEqual(withEndpoints.groups)
    expect(withoutEndpoints.channels.find((channel) => channel.id === 'jito')?.isSendable).toBe(true)
  })
})

describe('syncRegistry', () => {
  // `channels.group_id` посилається на `channel_groups`: у зворотному порядку
  // перший же канал упав би на зовнішньому ключі.
  it('writes groups before channels', async () => {
    const store = fakeStore()

    await syncRegistry(buildChannelRegistry(DEFAULT_REGISTRY), { store, logger: silent })

    expect(store.calls).toEqual(['groups', 'channels'])
    expect(store.groups).toHaveLength(4)
    expect(store.channels).toHaveLength(4)
  })

  it('lets a storage failure through to the caller', async () => {
    const failing: RegistryStore = {
      saveGroups: () => Promise.reject(new Error('немає зʼєднання')),
      saveChannels: () => Promise.resolve(),
    }

    await expect(
      syncRegistry(buildChannelRegistry(DEFAULT_REGISTRY), { store: failing, logger: silent }),
    ).rejects.toThrow('немає зʼєднання')
  })
})
