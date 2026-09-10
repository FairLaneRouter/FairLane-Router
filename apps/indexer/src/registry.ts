import { channelGroups, channels as channelsTable, type Database } from '@fairlane/db'
import type { ChannelRegistry, Logger } from '@fairlane/shared'

export type ChannelGroupRow = {
  readonly id: string
  readonly name: string
  readonly memberNames: string[]
  readonly isSendable: boolean
}

export type ChannelRow = {
  readonly id: string
  readonly groupId: string
  readonly name: string
  readonly tipAccounts: string[]
  readonly isObserved: boolean
  readonly isSendable: boolean
  /** Назва змінної оточення, ніколи не її значення — ендпоінти є секретами. */
  readonly endpointEnvKey: string | null
  readonly sourceUrl: string | null
}

export type RegistryRows = {
  readonly groups: readonly ChannelGroupRow[]
  readonly channels: readonly ChannelRow[]
}

export type RegistryStore = {
  /** Групи мають лягти першими: `channels.group_id` посилається на них. */
  saveGroups(rows: readonly ChannelGroupRow[]): Promise<void>
  saveChannels(rows: readonly ChannelRow[]): Promise<void>
}

/**
 * Довідник у БД тримає **довідникову** ознаку відправки, а не фактичну
 * доступність. Різниця в тому, що `canSend` залежить від оточення процесу
 * (`CHANNEL_*_ENDPOINT`), а оточення в індексатора й API різне: індексатору
 * ендпоінти каналів не потрібні взагалі. Записаний ним `canSend` означав би
 * «звідси відправити не можна» і виглядав би в API як вимкнений канал.
 *
 * Тому в таблицях лежать дві незалежні ознаки довідника (FR-040), а фактичну
 * доступність рахує той процес, у якого ендпоінти справді є.
 */
export function registryRows(registry: ChannelRegistry): RegistryRows {
  return {
    groups: registry.groups.map((group) => ({
      id: group.id,
      name: group.name,
      memberNames: [...group.memberNames],
      isSendable: registry.channels.some(
        (channel) => channel.groupId === group.id && channel.isSendable,
      ),
    })),
    channels: registry.channels.map((channel) => ({
      id: channel.id,
      groupId: channel.groupId,
      name: channel.name,
      tipAccounts: [...channel.tipAccounts],
      isObserved: channel.isObserved,
      isSendable: channel.isSendable,
      endpointEnvKey: channel.endpointEnvKey,
      sourceUrl: channel.sourceUrl,
    })),
  }
}

/**
 * Рядок на запит, а не пачкою: груп і каналів одиниці, синхронізація
 * трапляється раз на запуск, а поодинокий `INSERT` дозволяє написати
 * `DO UPDATE` конкретними значеннями — без `excluded.*`, а отже й без прямої
 * залежності індексатора на drizzle-orm заради виразів.
 */
export function createRegistryStore(db: Database): RegistryStore {
  return {
    async saveGroups(rows) {
      for (const row of rows) {
        await db
          .insert(channelGroups)
          .values(row)
          .onConflictDoUpdate({
            target: channelGroups.id,
            set: { name: row.name, memberNames: row.memberNames, isSendable: row.isSendable },
          })
      }
    },

    async saveChannels(rows) {
      for (const row of rows) {
        await db
          .insert(channelsTable)
          .values(row)
          .onConflictDoUpdate({
            target: channelsTable.id,
            set: {
              groupId: row.groupId,
              name: row.name,
              tipAccounts: row.tipAccounts,
              isObserved: row.isObserved,
              isSendable: row.isSendable,
              endpointEnvKey: row.endpointEnvKey,
              sourceUrl: row.sourceUrl,
            },
          })
      }
    },
  }
}

export type SyncRegistryOptions = {
  readonly store: RegistryStore
  readonly logger: Logger
}

/**
 * Довідник живе в коді як дані (FR-007), а в БД потрапляє звідси. Без цього
 * `landings.group_id` не має на що посилатись: зовнішній ключ на
 * `channel_groups` валив би перший же запис посадки з чайовими.
 *
 * Виклик ідемпотентний і робиться на кожному запуску індексатора: додати
 * канал або перенести його в іншу групу — це правка `channels.data.ts` і
 * перезапуск, без міграції і без зміни жодної функції.
 */
export async function syncRegistry(
  registry: ChannelRegistry,
  options: SyncRegistryOptions,
): Promise<RegistryRows> {
  const { store, logger } = options
  const rows = registryRows(registry)

  await store.saveGroups(rows.groups)
  await store.saveChannels(rows.channels)

  logger.info('довідник каналів синхронізовано', {
    groups: rows.groups.length,
    channels: rows.channels.length,
    tipAccounts: registry.tipAccounts.size,
  })

  return rows
}
