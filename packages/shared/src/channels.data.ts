import type { RegistryDefinition } from './channels.ts'

/**
 * Базовий набір каналів спостереження (FR-008). Це **дані**, а не код: додати
 * канал або перенести його в іншу групу можна правкою цього файлу, без зміни
 * жодної функції (FR-007). У M1 довідник живе тут, з T021 переїде в таблиці
 * `channels` і `channel_groups` без зміни форми.
 *
 * Службові акаунти взяті з документації самих сервісів — посилання у
 * `sourceUrl` кожного каналу. Список Jito звірений двічі: зі сторінкою
 * документації і з відповіддю `getTipAccounts` на mainnet.block-engine —
 * вони збіглися повністю. Nozomi і bloXroute мають одне джерело кожен.
 *
 * Помилка в одному символі адреси тут не створює хибної атрибуції: неіснуючий
 * акаунт ні з чим не збігається, і транзакція піде в «неатрибутовано» (FR-039).
 * Довжину кожної адреси перевіряє схема, збіг зі справжнім акаунтом — ні.
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
      tipAccounts: [
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
        'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
        'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
        'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
        '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
      ],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_JITO_ENDPOINT',
      sourceUrl: 'https://docs.jito.wtf/lowlatencytxnsend/',
    },
    {
      id: 'nozomi',
      groupId: 'nozomi',
      name: 'Nozomi',
      tipAccounts: [
        'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq',
        'noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4',
        'noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE',
        'noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo',
        'noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ',
        'nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L',
        'nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z',
        'nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu',
        'noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7',
        'nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP',
        'nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P',
        'nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge',
        'nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3',
        'nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ',
        'nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk',
        'nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne',
        'nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb',
      ],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_NOZOMI_ENDPOINT',
      sourceUrl: 'https://use.temporal.xyz/nozomi/tipping-and-faq',
    },
    {
      id: 'bloxroute',
      groupId: 'bloxroute',
      name: 'bloXroute',
      tipAccounts: [
        '3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd',
        'FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF',
        'bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd',
        'bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp',
        'bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba',
        'bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm',
        'bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2',
        'bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h',
        'bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt',
        'bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5',
        'bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7',
        'bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi',
        'bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe',
        'bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA',
        'bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD',
        'bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV',
        'bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm',
      ],
      isObserved: true,
      isSendable: true,
      endpointEnvKey: 'CHANNEL_BLOXROUTE_ENDPOINT',
      sourceUrl: 'https://docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses',
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

/**
 * Межа методу, яку видно тільки звідси, і яку треба казати вголос при показі.
 *
 * Nozomi і bloXroute видають високооборотним клієнтам **власні** службові
 * акаунти, яких у публічних списках немає. Транзакція через такий акаунт
 * ончейн виглядає як звичайний переказ, і ми зарахуємо її в «неатрибутовано»
 * або, якщо вона платила пріоритетну комісію, у звичайний RPC.
 *
 * Тобто частки цих двох груп у зведенні — **нижня межа**, а не точне число.
 * Помилки в інший бік конструкція не робить: чужа транзакція групі не
 * дістанеться (SC-009), бо зарахування вимагає збігу з відомим акаунтом.
 */
export const KNOWN_ATTRIBUTION_LIMITS = [
  'nozomi: приватні службові акаунти для високооборотних клієнтів не публікуються',
  'bloxroute: те саме — публічний список не є повним',
] as const
