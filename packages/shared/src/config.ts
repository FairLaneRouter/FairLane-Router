import { z } from 'zod'

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value)

// Дефолт живе всередині, а не на z.preprocess: порожній рядок стає undefined
// вже ПІСЛЯ того, як зовнішній .default() вирішив, що значення задане.
const numeric = <T extends z.ZodType<number>>(schema: T) =>
  z.preprocess((value) => {
    const cleaned = blankToUndefined(value)
    return typeof cleaned === 'string' ? Number(cleaned) : cleaned
  }, schema)

const optionalText = z.preprocess(blankToUndefined, z.string().min(1).optional())

const envSchema = z.object({
  SOLANA_RPC_URL: z.url({ protocol: /^https$/ }),
  SOLANA_RPC_FALLBACK_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^https$/ }).optional(),
  ),
  DATABASE_URL: z.string().min(1),
  // Пряме з'єднання повз пулер — тільки для міграцій (packages/db/src/migrate.ts).
  DATABASE_DIRECT_URL: z.preprocess(blankToUndefined, z.string().min(1).optional()),

  SAMPLE_EVERY_N: numeric(z.number().int().min(1).default(100)),
  RPC_SAMPLE_RATE: numeric(z.number().min(0).max(1).default(0.05)),

  PORT: numeric(z.number().int().min(1).max(65535).default(3000)),
  // Індексатор усередині процесу API. Потрібен лише там, де фонового процесу
  // немає (Render Free); у двопроцесному запуску лишається вимкненим.
  RUN_INDEXER: z.preprocess(
    blankToUndefined,
    z.enum(['true', 'false']).default('false'),
  ),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
  RATE_LIMIT_WITH_KEY_PER_MIN: numeric(z.number().int().min(1).default(120)),
  RATE_LIMIT_NO_KEY_PER_MIN: numeric(z.number().int().min(1).default(10)),

  DEMO_WALLET_SECRET: optionalText,
  DEMO_DAILY_BUDGET_LAMPORTS: numeric(z.number().int().min(0).default(50_000_000)),
  DEMO_PER_RUN_LAMPORTS: numeric(z.number().int().min(0).default(2_000_000)),
})

const ENDPOINT_PATTERN = /^CHANNEL_(.+)_ENDPOINT$/

export type Config = {
  readonly solanaRpcUrl: string
  readonly solanaRpcFallbackUrl: string | undefined
  readonly databaseUrl: string
  readonly databaseDirectUrl: string | undefined
  readonly sampleEveryN: number
  readonly rpcSampleRate: number
  readonly port: number
  readonly runIndexer: boolean
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  readonly rateLimitWithKeyPerMin: number
  readonly rateLimitNoKeyPerMin: number
  readonly demoWalletSecret: string | undefined
  readonly demoDailyBudgetLamports: number
  readonly demoPerRunLamports: number
  readonly channelEndpoints: Readonly<Record<string, string>>
}

function collectChannelEndpoints(env: Record<string, string | undefined>): Record<string, string> {
  const endpoints: Record<string, string> = {}

  for (const [name, value] of Object.entries(env)) {
    const match = ENDPOINT_PATTERN.exec(name)
    if (match?.[1] && value) endpoints[match[1].toLowerCase()] = value
  }

  return endpoints
}

/**
 * Секрети не мають витікати в логи через випадковий JSON.stringify(config) —
 * саме так вони найчастіше і потрапляють у трейси помилок.
 */
function hideSecrets(config: Config): Config {
  const redacted = { ...config, demoWalletSecret: config.demoWalletSecret ? '[redacted]' : undefined }

  return Object.defineProperties(config, {
    toJSON: { value: () => redacted, enumerable: false },
    toString: { value: () => JSON.stringify(redacted), enumerable: false },
  })
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Некоректне оточення — ${detail}`)
  }

  const e = parsed.data

  return hideSecrets({
    solanaRpcUrl: e.SOLANA_RPC_URL,
    solanaRpcFallbackUrl: e.SOLANA_RPC_FALLBACK_URL,
    databaseUrl: e.DATABASE_URL,
    databaseDirectUrl: e.DATABASE_DIRECT_URL,
    sampleEveryN: e.SAMPLE_EVERY_N,
    rpcSampleRate: e.RPC_SAMPLE_RATE,
    port: e.PORT,
    runIndexer: e.RUN_INDEXER === 'true',
    logLevel: e.LOG_LEVEL,
    rateLimitWithKeyPerMin: e.RATE_LIMIT_WITH_KEY_PER_MIN,
    rateLimitNoKeyPerMin: e.RATE_LIMIT_NO_KEY_PER_MIN,
    demoWalletSecret: e.DEMO_WALLET_SECRET,
    demoDailyBudgetLamports: e.DEMO_DAILY_BUDGET_LAMPORTS,
    demoPerRunLamports: e.DEMO_PER_RUN_LAMPORTS,
    channelEndpoints: collectChannelEndpoints(env),
  })
}
