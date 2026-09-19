/**
 * Замір SC-001 (T037): «посадка з'являється у публічному зведенні не пізніше
 * ніж через 60 секунд після підтвердження транзакції (p95)».
 *
 * Що саме міряється. Скрипт опитує **розгорнуте** зведення і чекає, доки
 * `lastBlockTime` зміниться на свіжіший. У момент, коли новий час уперше
 * видно, затримка = `now - lastBlockTime`. Це і є повний шлях назовні: крок
 * вибірки індексатора, читання блока, запис, вікно зведення і кеш API. Ми
 * навмисно не заглядаємо ані в базу, ані в `/health` — SC-001 говорить про те,
 * що бачить сторонній читач, а не про те, що вже лежить у сховищі.
 *
 * Чому вимір по слоту дорівнює виміру по транзакції. `block_time` належить
 * блоку, тож усі посадки одного слота стають видимими одночасно і мають рівно
 * одну й ту саму затримку. Розподіл по слотах — це розподіл по посадках із
 * точністю до ваги «скільки посадок у слоті»; ваги тут не застосовуються, і
 * при показі це треба вимовляти.
 *
 * Похибки, які не сховані:
 *   • крок опитування додає до кожного значення до `--poll` мс зверху;
 *   • годинник цієї машини порівнюється з часом, який повідомила мережа;
 *   • у вибірку входять лише слоти вибірки (`SAMPLE_EVERY_N`), тобто одна
 *     точка на ~40 секунд — за півгодини їх близько 45, і p95 на такій
 *     кількості тримається на двох-трьох найгірших значеннях.
 *
 *   node scripts/measure-sc001.ts --url https://api.example --minutes 60
 *   node scripts/measure-sc001.ts --url https://api.example --minutes 60 --json
 *
 * Скрипт самодостатній: жодного імпорту з `packages/shared`. Він перевіряє
 * поведінку розгорнутої системи, тому спиратись на її ж код не має права.
 */

export {}

/** Бюджет критерію. Тут він константа, бо саме його ми й перевіряємо. */
const SC001_BUDGET_MS = 60_000

/** Скільки точок потрібно, щоб p95 узагалі мав роздільну здатність. */
const MIN_SAMPLES_FOR_P95 = 20

type Args = {
  readonly url: string
  readonly minutes: number
  readonly pollMs: number
  readonly window: string
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }

  const url = value('url') ?? process.env.MEASURE_API_URL
  if (!url) {
    throw new Error('Немає адреси API: задайте --url https://… або MEASURE_API_URL')
  }

  return {
    url: url.replace(/\/+$/, ''),
    minutes: Number(value('minutes') ?? 60),
    pollMs: Number(value('poll') ?? 1000),
    // 15 хвилин — найкоротше вікно: свіжий слот потрапляє в нього одразу, а
    // сама відповідь найменша з трьох, тож опитування раз на секунду нікого
    // не навантажує.
    window: value('window') ?? '15m',
    json: argv.includes('--json'),
  }
}

type Probe = {
  readonly lastBlockTime: string | null
  readonly generatedAt: string
  readonly isStale: boolean
  readonly observations: number
  readonly slotsSampled: number
}

/**
 * Відповідь читається вручну, полями. Zod тут не потрібен: скрипт бере п'ять
 * полів із п'ятнадцяти, і будь-яке розходження з контрактом видно одразу —
 * ми впадемо на першому ж запиті, а не намалюємо порожню клітинку.
 */
function readProbe(payload: unknown): Probe {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Зведення не є об\'єктом')
  }

  const body = payload as Record<string, unknown>
  const lastBlockTime = body.lastBlockTime
  const generatedAt = body.generatedAt

  if (lastBlockTime !== null && typeof lastBlockTime !== 'string') {
    throw new Error('Поле lastBlockTime не за контрактом')
  }
  if (typeof generatedAt !== 'string') {
    throw new Error('Поле generatedAt не за контрактом')
  }

  return {
    lastBlockTime,
    generatedAt,
    isStale: body.isStale === true,
    observations: typeof body.observations === 'number' ? body.observations : 0,
    slotsSampled: typeof body.slotsSampled === 'number' ? body.slotsSampled : 0,
  }
}

async function fetchJson(url: string): Promise<unknown> {
  // no-store: посередник, що віддав би збережену відповідь, підмінив би
  // вимірювану величину власним віком кеша.
  const response = await fetch(url, { headers: { 'cache-control': 'no-store' } })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} на ${url} — ${text.slice(0, 200)}`)
  }

  return JSON.parse(text)
}

/** Найближчий ранг — той самий спосіб, яким процентилі рахує сам продукт. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] ?? null
}

type Sample = {
  readonly blockTime: string
  readonly seenAt: string
  readonly delayMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const summaryUrl = `${args.url}/v1/summary?window=${args.window}`
  const samples: Sample[] = []

  // Стан збору читається один раз, на старті, і не для заміру, а щоб замір не
  // видав числа, яким не можна вірити: p95 при зупиненому індексаторі — це
  // p95 його простою, а не затримки конвеєра.
  const health = (await fetchJson(`${args.url}/health`)) as Record<string, unknown>
  if (health.status !== 'ok') {
    process.stderr.write(
      `УВАГА: /health каже "${String(health.status)}" — ${JSON.stringify(health.issues)}\n`,
    )
  }

  const startedAt = Date.now()
  const endsAt = startedAt + args.minutes * 60_000
  let previous: string | null = null
  let polls = 0
  let errors = 0

  if (!args.json) {
    process.stdout.write(`Замір SC-001 · ${summaryUrl}\n`)
    process.stdout.write(`Триває ${args.minutes} хв, опитування раз на ${args.pollMs} мс\n\n`)
  }

  while (Date.now() < endsAt) {
    try {
      const probe = readProbe(await fetchJson(summaryUrl))
      polls += 1

      if (probe.lastBlockTime !== null && probe.lastBlockTime !== previous) {
        const seenAt = Date.now()
        const delayMs = seenAt - Date.parse(probe.lastBlockTime)

        // Перша ж відповідь показує слот, який став видимим колись раніше:
        // ми не бачили моменту його появи і не маємо права рахувати його
        // затримкою. Вона лише задає точку відліку.
        if (previous !== null) {
          samples.push({
            blockTime: probe.lastBlockTime,
            seenAt: new Date(seenAt).toISOString(),
            delayMs,
          })

          if (!args.json) {
            const over = delayMs > SC001_BUDGET_MS ? '  ← понад бюджет' : ''
            process.stdout.write(
              `${new Date(seenAt).toISOString()}  слот від ${probe.lastBlockTime}  ` +
                `${(delayMs / 1000).toFixed(1)} с${over}\n`,
            )
          }
        }

        previous = probe.lastBlockTime
      }
    } catch (cause) {
      errors += 1
      process.stderr.write(`Запит не вдався: ${cause instanceof Error ? cause.message : cause}\n`)
    }

    await sleep(args.pollMs)
  }

  const delays = samples.map((sample) => sample.delayMs).sort((a, b) => a - b)
  const p95 = percentile(delays, 0.95)
  const verdict =
    delays.length < MIN_SAMPLES_FOR_P95
      ? 'недостатньо точок'
      : p95 !== null && p95 <= SC001_BUDGET_MS
        ? 'виконано'
        : 'не виконано'

  const report = {
    criterion: 'SC-001',
    budgetMs: SC001_BUDGET_MS,
    url: summaryUrl,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    minutes: args.minutes,
    pollMs: args.pollMs,
    polls,
    errors,
    samples: delays.length,
    p50Ms: percentile(delays, 0.5),
    p90Ms: percentile(delays, 0.9),
    p95Ms: p95,
    maxMs: delays.at(-1) ?? null,
    overBudget: delays.filter((delay) => delay > SC001_BUDGET_MS).length,
    verdict,
    observations: samples,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} с`)

  process.stdout.write('\n── SC-001 ───────────────────────────────────────────\n')
  process.stdout.write(`точок               ${delays.length} (опитувань ${polls}, збоїв ${errors})\n`)
  process.stdout.write(`p50                 ${seconds(report.p50Ms)}\n`)
  process.stdout.write(`p90                 ${seconds(report.p90Ms)}\n`)
  process.stdout.write(`p95                 ${seconds(p95)}  (бюджет 60.0 с)\n`)
  process.stdout.write(`найгірше            ${seconds(report.maxMs)}\n`)
  process.stdout.write(`понад бюджет        ${report.overBudget}\n`)
  process.stdout.write(`висновок            ${verdict}\n`)

  if (delays.length < MIN_SAMPLES_FOR_P95) {
    process.stdout.write(
      `\nP95 на ${delays.length} точках нічого не доводить: потрібно щонайменше ` +
        `${MIN_SAMPLES_FOR_P95}, тобто прогін від 20 хвилин при кроці вибірки 100 слотів.\n`,
    )
  }
}

if (import.meta.main) {
  await main()
}
