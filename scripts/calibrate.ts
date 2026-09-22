/**
 * Калібрування джерела (T023, FR-001).
 *
 * Відповідає на три питання, від яких залежить решта індексатора:
 *
 * 1. Скільки важить `getBlock` у режимах `full` і `accounts` — це стеля
 *    трафіку і головна причина, чому частота вибірки саме така.
 * 2. Чи є в дешевшому режимі `accounts` поля, без яких вартість посадки не
 *    рахується: `meta.fee`, `preBalances`/`postBalances`, `accountKeys`.
 * 3. Скільки в слоті насправді успішних невотингових транзакцій — від цього
 *    залежить і розрахунок місткості з PLAN.md, і поріг `MIN_SLOT_REF_SAMPLES`.
 *
 * Скрипт навмисно самодостатній: жодного імпорту з `packages/shared`. Він
 * перевіряє припущення, на яких той код побудований, тому спиратись на нього
 * не має права — інакше вимірював би не мережу, а власну згоду з собою.
 *
 *   node scripts/calibrate.ts --slots 5
 *   node scripts/calibrate.ts --json > calibration.json
 *
 * URL береться з `--rpc` або з `SOLANA_RPC_URL`. У вивід він не потрапляє:
 * ключ доступу зазвичай лежить прямо в ньому.
 */

// Файл — модуль (він же і точка входу): без цього рядка TypeScript не пускає
// await на верхньому рівні.
export {}

const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111'

/** ~2.5 слоти на секунду — оцінка PLAN.md, яку цей скрипт і перевіряє. */
const SLOTS_PER_DAY = 216_000

/** Припущення PLAN.md про наповненість слота, з яким порівнюємо виміряне. */
const ASSUMED_NON_VOTE_PER_SLOT = 700

type Args = {
  readonly rpc: string
  readonly slots: number
  readonly stride: number
  readonly json: boolean
}

type ModeStats = {
  readonly bytes: number
  readonly ms: number
}

type SlotStats = {
  readonly slot: number
  readonly full: ModeStats
  readonly accounts: ModeStats | null
  readonly transactions: number
  readonly vote: number
  readonly nonVote: number
  readonly nonVoteSuccessful: number
  readonly withPriorityFee: number
  readonly accountsModeHasFee: boolean
  readonly accountsModeHasBalances: boolean
  readonly accountsModeHasAccountKeys: boolean
  readonly accountsModeHasSignatures: boolean
  readonly accountsModeHasComputeUnits: boolean
  readonly fullModeHasComputeUnits: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }

  const rpc = value('rpc') ?? process.env.SOLANA_RPC_URL
  if (!rpc) {
    throw new Error('Немає RPC: задайте --rpc URL або SOLANA_RPC_URL')
  }

  return {
    rpc,
    slots: Number(value('slots') ?? 5),
    stride: Number(value('stride') ?? 100),
    json: argv.includes('--json'),
  }
}

/**
 * Розмір міряється по сирому тексту відповіді, а не по розібраному об'єкту:
 * платить провайдер саме за байти на дроті, і саме вони впираються в ліміт
 * безкоштовного тарифу.
 */
async function call(
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<{ result: unknown; bytes: number; ms: number }> {
  const startedAt = performance.now()

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  const text = await response.text()
  const ms = performance.now() - startedAt

  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status} — ${text.slice(0, 200)}`)
  }

  const payload: unknown = JSON.parse(text)
  const envelope = payload as { result?: unknown; error?: { message?: string } }

  if (envelope.error) {
    throw new Error(`${method}: ${envelope.error.message ?? 'помилка RPC'}`)
  }

  return { result: envelope.result, bytes: Buffer.byteLength(text, 'utf8'), ms }
}

function blockParams(slot: number, details: 'full' | 'accounts') {
  return [
    slot,
    {
      encoding: 'json',
      transactionDetails: details,
      rewards: false,
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 1,
    },
  ]
}

type RawTransaction = {
  transaction?: {
    message?: { accountKeys?: unknown }
    accountKeys?: unknown
    signatures?: unknown
  }
  meta?: {
    err?: unknown
    fee?: unknown
    preBalances?: unknown
    postBalances?: unknown
    computeUnitsConsumed?: unknown
  }
}

/**
 * Форма відповіді різна в двох режимах, і це не дрібниця: у `full` ключі
 * лежать під `transaction.message` рядками, у `accounts` — прямо під
 * `transaction`, об'єктами {pubkey, signer, writable, source}. Індексатор
 * має читати обидві, інакше дешевший режим виглядає непридатним, хоча
 * придатний.
 */
function accountNames(tx: RawTransaction): string[] {
  const keys = tx.transaction?.accountKeys ?? tx.transaction?.message?.accountKeys
  if (!Array.isArray(keys)) return []

  return keys.map((key) =>
    typeof key === 'string' ? key : String((key as { pubkey?: unknown }).pubkey ?? ''),
  )
}

async function measureSlot(url: string, slot: number): Promise<SlotStats> {
  const full = await call(url, 'getBlock', blockParams(slot, 'full'))
  const block = full.result as { transactions?: RawTransaction[] }
  const transactions = block.transactions ?? []

  let vote = 0
  let nonVoteSuccessful = 0
  let withPriorityFee = 0

  for (const tx of transactions) {
    if (accountNames(tx).includes(VOTE_PROGRAM_ID)) {
      vote += 1
      continue
    }

    const failed = tx.meta?.err !== null && tx.meta?.err !== undefined
    if (!failed) nonVoteSuccessful += 1

    const fee = typeof tx.meta?.fee === 'number' ? tx.meta.fee : 0
    const signatures = Array.isArray(tx.transaction?.signatures)
      ? tx.transaction.signatures.length
      : 1
    if (fee > 5000 * signatures) withPriorityFee += 1
  }

  let accounts: ModeStats | null = null
  let sample: RawTransaction | undefined

  try {
    const cheap = await call(url, 'getBlock', blockParams(slot, 'accounts'))
    accounts = { bytes: cheap.bytes, ms: cheap.ms }
    sample = (cheap.result as { transactions?: RawTransaction[] }).transactions?.[0]
  } catch (cause) {
    process.stderr.write(
      `Режим accounts недоступний на слоті ${slot}: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    )
  }

  return {
    slot,
    full: { bytes: full.bytes, ms: full.ms },
    accounts,
    transactions: transactions.length,
    vote,
    nonVote: transactions.length - vote,
    nonVoteSuccessful,
    withPriorityFee,
    accountsModeHasFee: typeof sample?.meta?.fee === 'number',
    accountsModeHasBalances:
      Array.isArray(sample?.meta?.preBalances) && Array.isArray(sample?.meta?.postBalances),
    accountsModeHasAccountKeys: sample !== undefined && accountNames(sample).length > 0,
    accountsModeHasSignatures: Array.isArray(sample?.transaction?.signatures),
    accountsModeHasComputeUnits: typeof sample?.meta?.computeUnitsConsumed === 'number',
    fullModeHasComputeUnits: transactions.some(
      (tx) => typeof tx.meta?.computeUnitsConsumed === 'number',
    ),
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} МБ`

function report(stats: readonly SlotStats[], stride: number): void {
  const readsPerDay = SLOTS_PER_DAY / stride
  const fullBytes = median(stats.map((s) => s.full.bytes))
  const accountsBytes = median(
    stats.flatMap((s) => (s.accounts === null ? [] : [s.accounts.bytes])),
  )
  const nonVote = median(stats.map((s) => s.nonVote))
  const successful = median(stats.map((s) => s.nonVoteSuccessful))

  const lines = [
    '',
    `Слотів виміряно: ${stats.length}, крок ${stride}`,
    '',
    `getBlock full     медіана ${mb(fullBytes)}, ${Math.round(median(stats.map((s) => s.full.ms)))} мс`,
    accountsBytes > 0
      ? `getBlock accounts медіана ${mb(accountsBytes)} — ${(
          (1 - accountsBytes / fullBytes) *
          100
        ).toFixed(0)}% дешевше за full`
      : 'getBlock accounts недоступний',
    '',
    `Транзакцій у слоті      ${median(stats.map((s) => s.transactions))}`,
    `  вотингових            ${median(stats.map((s) => s.vote))}`,
    `  невотингових          ${nonVote}  (PLAN.md припускав ${ASSUMED_NON_VOTE_PER_SLOT})`,
    `  успішних невотингових ${successful}`,
    `  з пріоритетною комісією ${median(stats.map((s) => s.withPriorityFee))}`,
    '',
    'Чи вистачає режиму accounts для вартості посадки:',
    `  meta.fee              ${stats.every((s) => s.accountsModeHasFee) ? 'є' : 'НЕМАЄ'}`,
    `  pre/postBalances      ${stats.every((s) => s.accountsModeHasBalances) ? 'є' : 'НЕМАЄ'}`,
    `  accountKeys           ${stats.every((s) => s.accountsModeHasAccountKeys) ? 'є' : 'НЕМАЄ'}`,
    `  signatures            ${stats.every((s) => s.accountsModeHasSignatures) ? 'є' : 'НЕМАЄ'}`,
    `  computeUnitsConsumed  ${stats.every((s) => s.accountsModeHasComputeUnits) ? 'є' : 'НЕМАЄ'}` +
      `  (у full: ${stats.every((s) => s.fullModeHasComputeUnits) ? 'є' : 'НЕМАЄ'})`,
    '',
    `За кроком ${stride}: ${Math.round(readsPerDay)} читань на добу, ` +
      `${mb(readsPerDay * fullBytes)} трафіку на добу в режимі full`,
    `Оглянуто транзакцій на добу: ${Math.round(readsPerDay * nonVote)} невотингових`,
    '',
  ]

  process.stdout.write(`${lines.join('\n')}\n`)

  if (successful < 50) {
    process.stdout.write(
      `⚠️  Медіана успішних невотингових (${successful}) нижча за MIN_SLOT_REF_SAMPLES = 50:\n` +
        '    з таким порогом частина слотів лишиться без еталона. Поріг у\n' +
        '    packages/shared/src/reference.ts треба переглянути під ці числа.\n\n',
    )
  }

  if (Math.abs(nonVote - ASSUMED_NON_VOTE_PER_SLOT) / ASSUMED_NON_VOTE_PER_SLOT > 0.25) {
    process.stdout.write(
      '⚠️  Наповненість слота розійшлася з припущенням PLAN.md більше ніж на чверть:\n' +
        '    правити треба розрахунок місткості в плані, а не це вимірювання.\n\n',
    )
  }
}

const args = parseArgs(process.argv.slice(2))
const head = await call(args.rpc, 'getSlot', [{ commitment: 'confirmed' }])
const latest = head.result as number

// Крок від найсвіжішого назад: свіжі слоти ще можуть бути неповними в ledger,
// тому відступаємо на кілька сотень і йдемо вглиб.
const stats: SlotStats[] = []
for (let i = 0; i < args.slots; i += 1) {
  const slot = latest - 500 - i * args.stride
  try {
    stats.push(await measureSlot(args.rpc, slot))
  } catch (cause) {
    process.stderr.write(
      `Слот ${slot} пропущено: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

if (stats.length === 0) {
  process.stderr.write('Жодного слота не виміряно\n')
  process.exit(1)
}

if (args.json) {
  process.stdout.write(`${JSON.stringify({ stride: args.stride, stats }, null, 2)}\n`)
} else {
  report(stats, args.stride)
}
