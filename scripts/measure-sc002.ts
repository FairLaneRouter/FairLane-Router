/**
 * Замір SC-002 (T037): «перший екран дашборду показує дані менш ніж за
 * 2 секунди на з'єднанні 3G».
 *
 * Що вважається «показує дані». Не перше фарбування і не `load`, а момент,
 * коли в таблиці зʼявився перший рядок групи: до нього сторінка каже «reading
 * the window…», і це ще не дані. Момент ловиться `MutationObserver`ом,
 * підсадженим до будь-якого скрипта сторінки, тому в число не входить крок
 * опитування — воно записане самою сторінкою в її ж системі відліку.
 *
 * Чому не Lighthouse і не Playwright. Обидва вміють рівно те, що тут потрібно,
 * і обидва тягнуть у проект або свій браузер, або свій рантайм заради одного
 * числа. Chrome на машині вже є, а протокол до нього — це WebSocket, який у
 * Node вбудований. Нової залежності немає, і ціна цьому — сотня рядків нижче.
 *
 * Профіль з'єднання названо явно, бо «3G» у спеці числа не має. За
 * замовчуванням — `fast3g`, тобто пресет Chrome DevTools «Fast 3G»
 * (1.6 Мбіт/с, 562 мс RTT); `slow3g` — «Slow 3G» (500 Кбіт/с, 2000 мс RTT).
 * Процесор **не** сповільнюється: критерій говорить про з'єднання, і додавати
 * до нього ще й слабкий телефон означало б перевіряти суворіше, ніж написано.
 * Прапорець `--cpu 4` є для тих, хто хоче побачити й це.
 *
 * Кеш вимкнений і чиститься перед кожним прогоном: SC-002 — про першу
 * зустріч зі сторінкою, а не про повернення на неї.
 *
 *   node scripts/measure-sc002.ts --url https://web.example
 *   node scripts/measure-sc002.ts --url https://web.example --profile slow3g --runs 5
 *   node scripts/measure-sc002.ts --url https://web.example --json
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Бюджет критерію. */
const SC002_BUDGET_MS = 2000

/**
 * Пресети Chrome DevTools, числами з самого DevTools: множники 0.9 і 0.8 та
 * 3.75 на затримку — його ж, і саме вони роблять «1.6 Мбіт/с» тим, що людина
 * бачить у списку, а не тим, що написано на тарифі.
 */
const PROFILES = {
  fast3g: {
    label: 'DevTools Fast 3G — 1.6 Мбіт/с, 750 Кбіт/с вгору, 562 мс RTT',
    downloadThroughput: ((1.6 * 1024 * 1024) / 8) * 0.9,
    uploadThroughput: ((750 * 1024) / 8) * 0.9,
    latency: 150 * 3.75,
  },
  slow3g: {
    label: 'DevTools Slow 3G — 500 Кбіт/с, 2000 мс RTT',
    downloadThroughput: ((500 * 1024) / 8) * 0.8,
    uploadThroughput: ((500 * 1024) / 8) * 0.8,
    latency: 2000 * 0.8 * 3.75,
  },
  none: {
    label: 'без обмеження — довідково, не для критерію',
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  },
} as const

type ProfileName = keyof typeof PROFILES

type Args = {
  readonly url: string
  readonly profile: ProfileName
  readonly runs: number
  readonly cpu: number
  readonly timeoutMs: number
  readonly chrome: string | undefined
  readonly json: boolean
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }

  const url = value('url') ?? process.env.MEASURE_WEB_URL
  if (!url) throw new Error('Немає адреси сторінки: задайте --url https://… або MEASURE_WEB_URL')

  const profile = (value('profile') ?? 'fast3g') as ProfileName
  if (!(profile in PROFILES)) {
    throw new Error(`Невідомий профіль «${profile}»: є ${Object.keys(PROFILES).join(', ')}`)
  }

  return {
    url,
    profile,
    runs: Number(value('runs') ?? 3),
    cpu: Number(value('cpu') ?? 1),
    timeoutMs: Number(value('timeout') ?? 30_000),
    chrome: value('chrome') ?? process.env.CHROME_PATH,
    json: argv.includes('--json'),
  }
}

/**
 * Підсаджується до першого скрипта сторінки. Записує два моменти в системі
 * відліку самої сторінки: перше змістовне фарбування і появу першого рядка
 * таблиці. Друге і є «показує дані» — таблиця рендериться лише у стані
 * `ready` (`views/Board.tsx`), тож її перший рядок не може виникнути раніше,
 * ніж прийшла й розібралась відповідь API.
 */
const PROBE_SOURCE = `(() => {
  const probe = { ready: null, fcp: null };
  window.__sc002 = probe;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') probe.fcp = entry.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
  } catch {}

  const seen = () => {
    if (probe.ready !== null) return true;
    if (document.querySelector('table tbody tr') === null) return false;
    probe.ready = performance.now();
    return true;
  };

  const start = () => {
    if (seen()) return;
    const observer = new MutationObserver(() => { if (seen()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})()`

type CdpMessage = {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
  readonly error?: { readonly message?: string }
  readonly sessionId?: string
}

/** Тонкий клієнт CDP: черга обіцянок за `id` і підписка на події. */
class Cdp {
  private readonly socket: WebSocket
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (cause: Error) => void }
  >()
  private nextId = 1

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === undefined) return

      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)

      if (message.error) waiting.reject(new Error(message.error.message ?? 'помилка CDP'))
      else waiting.resolve(message.result ?? {})
    })
  }

  static async connect(endpoint: string): Promise<Cdp> {
    const socket = new WebSocket(endpoint)

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`WebSocket до ${endpoint} не відкрився`)), {
        once: true,
      })
    })

    return new Cdp(socket)
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

/**
 * Порт беремо нульовий і читаємо справжній із stderr: фіксований порт рано чи
 * пізно зустрічає вже відкритий DevTools і мовчки міряє чужу вкладку.
 */
async function launchChrome(
  binary: string,
  userDataDir: string,
): Promise<{ process: ChildProcess; endpoint: string }> {
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ])

  const endpoint = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('Chrome не назвав адресу DevTools за 20 с')), 20_000)

    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const match = /ws:\/\/[^\s]+/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })

    child.once('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
  })

  return { process: child, endpoint }
}

function findChrome(explicit: string | undefined): string {
  if (explicit) return explicit

  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))

  if (!found) {
    throw new Error(
      'Chrome не знайдено: задайте --chrome "C:\\...\\chrome.exe" або CHROME_PATH',
    )
  }

  return found
}

type RunResult = {
  readonly readyMs: number | null
  readonly fcpMs: number | null
  readonly requests: number
  readonly transferBytes: number
  readonly slowest: readonly { name: string; ms: number; bytes: number }[]
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function measureOnce(cdp: Cdp, args: Args): Promise<RunResult> {
  const profile = PROFILES[args.profile]
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string
  }
  const { sessionId } = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string }

  try {
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.clearBrowserCache', {}, sessionId)
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.cpu }, sessionId)
    await cdp.send(
      'Network.emulateNetworkConditions',
      {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.downloadThroughput,
        uploadThroughput: profile.uploadThroughput,
      },
      sessionId,
    )
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE }, sessionId)
    await cdp.send('Page.navigate', { url: args.url }, sessionId)

    const deadline = Date.now() + args.timeoutMs
    let readyMs: number | null = null

    while (Date.now() < deadline) {
      const evaluated = (await cdp.send(
        'Runtime.evaluate',
        { expression: 'window.__sc002 ? window.__sc002.ready : null', returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown } }

      const value = evaluated.result?.value
      if (typeof value === 'number') {
        readyMs = value
        break
      }

      await sleep(200)
    }

    const collected = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: `JSON.stringify({
          fcp: window.__sc002 ? window.__sc002.fcp : null,
          resources: performance.getEntriesByType('resource').map((entry) => ({
            name: entry.name,
            ms: entry.responseEnd,
            bytes: entry.transferSize || entry.encodedBodySize || 0,
          })),
        })`,
        returnByValue: true,
      },
      sessionId,
    )) as { result?: { value?: unknown } }

    const payload = JSON.parse(String(collected.result?.value ?? '{}')) as {
      fcp?: number | null
      resources?: { name: string; ms: number; bytes: number }[]
    }
    const resources = payload.resources ?? []

    return {
      readyMs,
      fcpMs: payload.fcp ?? null,
      requests: resources.length,
      transferBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
      slowest: [...resources].sort((a, b) => b.ms - a.ms).slice(0, 5),
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId })
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const binary = findChrome(args.chrome)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fairlane-sc002-'))
  const { process: chrome, endpoint } = await launchChrome(binary, userDataDir)
  const cdp = await Cdp.connect(endpoint)
  const runs: RunResult[] = []

  try {
    for (let index = 0; index < args.runs; index += 1) {
      const run = await measureOnce(cdp, args)
      runs.push(run)

      if (!args.json) {
        const value = run.readyMs === null ? 'не дочекались' : `${(run.readyMs / 1000).toFixed(2)} с`
        process.stdout.write(
          `прогін ${index + 1}: дані ${value}, FCP ` +
            `${run.fcpMs === null ? '—' : `${(run.fcpMs / 1000).toFixed(2)} с`}, ` +
            `${run.requests} запитів, ${(run.transferBytes / 1024).toFixed(1)} КБ\n`,
        )
      }
    }
  } finally {
    cdp.close()
    chrome.kill()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  const ready = runs.map((run) => run.readyMs).filter((value): value is number => value !== null)
  const medianMs = median(ready)
  const verdict =
    ready.length < runs.length
      ? 'не виконано — сторінка не показала даних'
      : medianMs !== null && medianMs < SC002_BUDGET_MS
        ? 'виконано'
        : 'не виконано'

  const report = {
    criterion: 'SC-002',
    budgetMs: SC002_BUDGET_MS,
    url: args.url,
    profile: args.profile,
    profileLabel: PROFILES[args.profile].label,
    cpuThrottling: args.cpu,
    measuredAt: new Date().toISOString(),
    runs: runs.map((run) => ({
      readyMs: run.readyMs,
      fcpMs: run.fcpMs,
      requests: run.requests,
      transferBytes: run.transferBytes,
      slowest: run.slowest,
    })),
    medianMs,
    worstMs: ready.length === 0 ? null : Math.max(...ready),
    verdict,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)} с`)

  process.stdout.write('\n── SC-002 ───────────────────────────────────────────\n')
  process.stdout.write(`профіль             ${PROFILES[args.profile].label}\n`)
  process.stdout.write(`процесор            ×${args.cpu}\n`)
  process.stdout.write(`медіана ${args.runs} прогонів   ${seconds(medianMs)}  (бюджет 2.00 с)\n`)
  process.stdout.write(`найгірший           ${seconds(report.worstMs)}\n`)
  process.stdout.write(`висновок            ${verdict}\n`)

  const slowest = runs.at(-1)?.slowest ?? []
  if (slowest.length > 0) {
    process.stdout.write('\nнайдовші ресурси останнього прогону:\n')
    for (const resource of slowest) {
      process.stdout.write(
        `  ${(resource.ms / 1000).toFixed(2)} с  ${(resource.bytes / 1024).toFixed(1)} КБ  ` +
          `${resource.name.slice(0, 90)}\n`,
      )
    }
  }
}

if (import.meta.main) {
  await main()
}
