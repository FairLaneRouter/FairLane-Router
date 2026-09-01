import type { RegistryDefinition } from './channels.ts'

/**
 * Базовий набір каналів спостереження (FR-008). Це **дані**, а не код: додати
 * канал або перенести його в іншу групу можна правкою цього файлу, без зміни
 * жодної функції (FR-007). У M1 довідник живе тут, з T021 переїде в таблиці
 * `channels` і `channel_groups` без зміни форми.
 *
 * ⚠️ `tipAccounts` порожні навмисно. Службові акаунти визначають, кому
 * зараховуються гроші, тому вони вписуються людиною з документації сервісу, а
 * не з пам'яті: помилковий рядок base58 виглядає як звірена адреса, ніколи ні
 * з чим не збігається і тихо перетворює весь канал на «неатрибутовано».
 * Заповнюючи, ставте поруч `sourceUrl` — сторінку, де сервіс їх публікує.
 * Поки списки порожні, ці групи не отримають жодної транзакції (FR-039), і
 * зведення чесно покаже це часткою «неатрибутовано».
 */
export const DEFAULT_REGISTRY: RegistryDefinition = {
  groups: [
    { id: 'jito', name: 'Jito' },
    { id: 'nozomi', name: 'Nozomi' },
    { id: 'bloxroute', name: 'bloXroute' },
    { id: 'rpc', name: 'Звичайний RPC' },
  ],
  channels: [
    {
      id: 'jito',
      groupId: 'jito',
      name: 'Jito',
      tipAccounts: [],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_JITO_ENDPOINT',
      sourceUrl: null,
    },
    {
      id: 'nozomi',
      groupId: 'nozomi',
      name: 'Nozomi',
      tipAccounts: [],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_NOZOMI_ENDPOINT',
      sourceUrl: null,
    },
    {
      id: 'bloxroute',
      groupId: 'bloxroute',
      name: 'bloXroute',
      tipAccounts: [],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_BLOXROUTE_ENDPOINT',
      sourceUrl: null,
    },
    {
      id: 'rpc',
      groupId: 'rpc',
      name: 'Звичайний RPC',
      tipAccounts: [],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: null,
      sourceUrl: null,
    },
  ],
}
