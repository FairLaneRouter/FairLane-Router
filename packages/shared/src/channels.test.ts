import { describe, expect, it } from 'vitest'
import {
  ChannelRegistryError,
  RPC_GROUP_ID,
  buildChannelRegistry,
  channelEndpointKey,
} from './channels'
import { DEFAULT_REGISTRY } from './channels.data'

const ACCOUNT_A = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
const ACCOUNT_B = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'

function definition(overrides: Partial<Parameters<typeof buildChannelRegistry>[0]> = {}) {
  return {
    groups: [
      { id: 'jito', name: 'Jito' },
      { id: 'rpc', name: 'Звичайний RPC' },
    ],
    channels: [
      {
        id: 'jito',
        groupId: 'jito',
        name: 'Jito',
        tipAccounts: [ACCOUNT_A],
        isSendable: true,
        endpointEnvKey: 'CHANNEL_JITO_ENDPOINT',
      },
      { id: 'rpc', groupId: 'rpc', name: 'Звичайний RPC', isSendable: true },
    ],
    ...overrides,
  }
}

describe('channelEndpointKey', () => {
  it('matches the key shape that loadConfig produces', () => {
    expect(channelEndpointKey('CHANNEL_JITO_ENDPOINT')).toBe('jito')
    expect(channelEndpointKey('CHANNEL_BLOXROUTE_ENDPOINT')).toBe('bloxroute')
  })
})

describe('buildChannelRegistry', () => {
  it('builds the shipped default registry', () => {
    const registry = buildChannelRegistry(DEFAULT_REGISTRY)

    expect(registry.groups.map((group) => group.id)).toEqual([
      'jito',
      'nozomi',
      'bloxroute',
      RPC_GROUP_ID,
    ])
  })

  // Поки службові акаунти не звірені з документацією сервісів, розпізнавати
  // нічим — і це має виглядати як «неатрибутовано», а не як робоча атрибуція.
  it('recognises nothing until tip accounts are filled in', () => {
    const registry = buildChannelRegistry(DEFAULT_REGISTRY)

    expect(registry.tipAccounts.size).toBe(0)
    expect(registry.groupByTipAccount(ACCOUNT_A)).toBeNull()
  })

  it('resolves a tip account to its group', () => {
    const registry = buildChannelRegistry(definition())

    expect(registry.groupByTipAccount(ACCOUNT_A)?.id).toBe('jito')
    expect(registry.groupByTipAccount(ACCOUNT_B)).toBeNull()
  })

  it('collects every tip account for the cost calculator', () => {
    const registry = buildChannelRegistry(definition())

    expect([...registry.tipAccounts]).toEqual([ACCOUNT_A])
  })

  // FR-004: спільний службовий акаунт — це і є визначення однієї групи.
  it('allows two channels of one group to share a tip account', () => {
    const source = definition()
    const registry = buildChannelRegistry({
      ...source,
      channels: [
        ...source.channels,
        { id: 'jito-relay', groupId: 'jito', name: 'Jito Relay', tipAccounts: [ACCOUNT_A] },
      ],
    })

    const group = registry.groupById('jito')

    expect(group?.memberNames).toEqual(['Jito', 'Jito Relay'])
    expect(group?.tipAccounts).toEqual([ACCOUNT_A])
  })

  // Той самий акаунт у двох групах робить атрибуцію неоднозначною назавжди.
  // Здогадуватись заборонено (FR-038), тому це помилка довідника.
  it('rejects a tip account claimed by two groups', () => {
    const source = definition()

    expect(() =>
      buildChannelRegistry({
        ...source,
        channels: [
          ...source.channels,
          { id: 'other', groupId: 'rpc', name: 'Other', tipAccounts: [ACCOUNT_A] },
        ],
      }),
    ).toThrow(ChannelRegistryError)
  })

  it('rejects a channel pointing at an unknown group', () => {
    const source = definition()

    expect(() =>
      buildChannelRegistry({
        ...source,
        channels: [{ id: 'ghost', groupId: 'nowhere', name: 'Ghost' }],
      }),
    ).toThrow(/невідому групу/)
  })

  it('rejects duplicate ids', () => {
    const source = definition()

    expect(() =>
      buildChannelRegistry({ ...source, groups: [...source.groups, { id: 'jito', name: 'Again' }] }),
    ).toThrow(/двічі/)
  })

  it('rejects an address that is not base58', () => {
    const source = definition()

    expect(() =>
      buildChannelRegistry({
        ...source,
        channels: [{ id: 'bad', groupId: 'rpc', name: 'Bad', tipAccounts: ['0OIl-not-base58'] }],
      }),
    ).toThrow(ChannelRegistryError)
  })

  it('rejects an endpoint variable that is not a CHANNEL_*_ENDPOINT name', () => {
    const source = definition()

    expect(() =>
      buildChannelRegistry({
        ...source,
        channels: [{ id: 'x', groupId: 'rpc', name: 'X', endpointEnvKey: 'JITO_URL' }],
      }),
    ).toThrow(ChannelRegistryError)
  })
})

describe('sendability', () => {
  // FR-008, FR-040: спостереження ширше за відправку. Оголошений відправним
  // канал без ендпоінта в оточенні лишається тільки для спостереження.
  it('keeps a sendable channel observation-only while its endpoint is missing', () => {
    const registry = buildChannelRegistry(definition())

    expect(registry.groupById('jito')?.canSend).toBe(false)
    expect(registry.groupById('jito')?.isObserved).toBe(true)
    expect(registry.sendableGroups.map((group) => group.id)).toEqual([RPC_GROUP_ID])
  })

  it('enables sending once the endpoint appears in the environment', () => {
    const registry = buildChannelRegistry(definition(), { jito: 'https://jito.example/api' })

    expect(registry.groupById('jito')?.canSend).toBe(true)
    expect(registry.sendableGroups).toHaveLength(2)
  })

  it('ignores an endpoint for a channel the registry does not mark sendable', () => {
    const source = definition()
    const registry = buildChannelRegistry(
      {
        ...source,
        channels: [
          {
            id: 'jito',
            groupId: 'jito',
            name: 'Jito',
            isSendable: false,
            endpointEnvKey: 'CHANNEL_JITO_ENDPOINT',
          },
        ],
      },
      { jito: 'https://jito.example/api' },
    )

    expect(registry.groupById('jito')?.canSend).toBe(false)
  })

  // Звичайний RPC відправляється через базовий вузол, власного ендпоінта
  // в нього немає й не буде.
  it('treats a channel without an endpoint variable as sendable on the base node', () => {
    const registry = buildChannelRegistry(definition())

    expect(registry.groupById(RPC_GROUP_ID)?.canSend).toBe(true)
  })

  it('treats a blank endpoint as no endpoint', () => {
    const registry = buildChannelRegistry(definition(), { jito: '' })

    expect(registry.groupById('jito')?.canSend).toBe(false)
  })
})
