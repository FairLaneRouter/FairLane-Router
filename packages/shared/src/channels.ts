import { z } from 'zod'

/**
 * Канал, до якого потрапляє транзакція без чайових жодній відомій групі, але з
 * ненульовою пріоритетною комісією. Група існує в довіднику як усі інші —
 * просто не має службових акаунтів, бо їх немає в природі.
 */
export const RPC_GROUP_ID = 'rpc'

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const ENDPOINT_ENV_KEY = /^CHANNEL_[A-Z0-9]+(?:_[A-Z0-9]+)*_ENDPOINT$/

const addressSchema = z.string().regex(BASE58_ADDRESS, 'не схоже на адресу Solana')
const idSchema = z.string().regex(/^[a-z0-9-]+$/, 'ідентифікатор — тільки [a-z0-9-]')

export const groupDefinitionSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
})

export const channelDefinitionSchema = z.object({
  id: idSchema,
  groupId: idSchema,
  name: z.string().min(1),
  /**
   * Порожній список означає «розпізнавати нічим». Це не помилка конфігурації:
   * так виглядає і звичайний RPC, і канал, чиї акаунти ще не звірені з
   * документацією сервісу.
   */
  tipAccounts: z.array(addressSchema).default([]),
  isObserved: z.boolean().default(true),
  isSendable: z.boolean().default(false),
  /** Назва змінної оточення, ніколи не її значення — ендпоінти є секретами. */
  endpointEnvKey: z.string().regex(ENDPOINT_ENV_KEY).nullable().default(null),
  /** Звідки взяті службові акаунти. Порожньо = не звірено з першоджерелом. */
  sourceUrl: z.url().nullable().default(null),
})

export const registryDefinitionSchema = z.object({
  groups: z.array(groupDefinitionSchema).min(1),
  channels: z.array(channelDefinitionSchema).min(1),
})

export type GroupDefinition = z.infer<typeof groupDefinitionSchema>
export type ChannelDefinition = z.infer<typeof channelDefinitionSchema>
export type RegistryDefinition = z.infer<typeof registryDefinitionSchema>

export type Channel = ChannelDefinition & {
  /** Ознака довідника (FR-040) разом із наявним ендпоінтом в оточенні. */
  readonly canSend: boolean
}

export type ChannelGroup = {
  readonly id: string
  readonly name: string
  readonly memberNames: readonly string[]
  readonly tipAccounts: readonly string[]
  readonly isObserved: boolean
  /** Група відправна, щойно відправним є хоч один її канал. */
  readonly canSend: boolean
}

export type ChannelRegistry = {
  readonly groups: readonly ChannelGroup[]
  readonly channels: readonly Channel[]
  /** Усі службові акаунти довідника — вхід для `computeLandingCost`. */
  readonly tipAccounts: ReadonlySet<string>
  readonly sendableGroups: readonly ChannelGroup[]
  groupById(id: string): ChannelGroup | null
  groupByTipAccount(account: string): ChannelGroup | null
}

export class ChannelRegistryError extends Error {
  override readonly name = 'ChannelRegistryError'
}

/** `CHANNEL_JITO_ENDPOINT` → `jito`, як їх складає `loadConfig`. */
export function channelEndpointKey(envKey: string): string {
  return envKey.replace(/^CHANNEL_/, '').replace(/_ENDPOINT$/, '').toLowerCase()
}

/**
 * Один службовий акаунт може належати кільком каналам — саме це й означає, що
 * вони ончейн нерозрізненні й утворюють одну групу (FR-004). Той самий акаунт
 * у двох різних групах робить атрибуцію неоднозначною назавжди, тому це
 * помилка довідника, а не випадок, який варто вирішувати евристикою (FR-038).
 */
function indexTipAccounts(channels: readonly ChannelDefinition[]): Map<string, string> {
  const owner = new Map<string, string>()

  for (const channel of channels) {
    for (const account of channel.tipAccounts) {
      const claimed = owner.get(account)
      if (claimed !== undefined && claimed !== channel.groupId) {
        throw new ChannelRegistryError(
          `Службовий акаунт ${account} заявлений групами ${claimed} і ${channel.groupId}`,
        )
      }
      owner.set(account, channel.groupId)
    }
  }

  return owner
}

export function buildChannelRegistry(
  definition: unknown,
  endpoints: Readonly<Record<string, string>> = {},
): ChannelRegistry {
  const parsed = registryDefinitionSchema.safeParse(definition)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ChannelRegistryError(`Некоректний довідник каналів — ${detail}`)
  }

  const seenChannelIds = new Set<string>()
  const groupsById = new Map<string, GroupDefinition>()

  for (const group of parsed.data.groups) {
    if (groupsById.has(group.id)) {
      throw new ChannelRegistryError(`Група ${group.id} оголошена двічі`)
    }
    groupsById.set(group.id, group)
  }

  const channels: Channel[] = parsed.data.channels.map((channel) => {
    if (seenChannelIds.has(channel.id)) {
      throw new ChannelRegistryError(`Канал ${channel.id} оголошений двічі`)
    }
    seenChannelIds.add(channel.id)

    if (!groupsById.has(channel.groupId)) {
      throw new ChannelRegistryError(
        `Канал ${channel.id} посилається на невідому групу ${channel.groupId}`,
      )
    }

    // Канал без власної змінної оточення відправляється через базовий вузол із
    // `SOLANA_RPC_URL` — це звичайний RPC, у якого окремого ендпоінта немає й
    // не буде. Для решти відсутній ендпоінт означає «поки лише спостереження».
    const hasEndpoint =
      channel.endpointEnvKey === null ||
      (endpoints[channelEndpointKey(channel.endpointEnvKey)] ?? '') !== ''

    return { ...channel, canSend: channel.isSendable && hasEndpoint }
  })

  const owner = indexTipAccounts(parsed.data.channels)

  const groups: ChannelGroup[] = parsed.data.groups.map((group) => {
    const members = channels.filter((channel) => channel.groupId === group.id)

    return {
      id: group.id,
      name: group.name,
      memberNames: members.map((channel) => channel.name),
      tipAccounts: [...new Set(members.flatMap((channel) => channel.tipAccounts))],
      isObserved: members.some((channel) => channel.isObserved),
      canSend: members.some((channel) => channel.canSend),
    }
  })

  const byId = new Map(groups.map((group) => [group.id, group]))

  return {
    groups,
    channels,
    tipAccounts: new Set(owner.keys()),
    sendableGroups: groups.filter((group) => group.canSend),
    groupById: (id) => byId.get(id) ?? null,
    groupByTipAccount: (account) => {
      const groupId = owner.get(account)
      return groupId === undefined ? null : (byId.get(groupId) ?? null)
    },
  }
}
