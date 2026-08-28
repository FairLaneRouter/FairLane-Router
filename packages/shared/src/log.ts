export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
}

export type LogFields = Readonly<Record<string, unknown>>

export type Logger = {
  /** Похідний логер із доданим контекстом; батьківський не змінюється. */
  child(fields: LogFields): Logger
  fatal(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  trace(message: string, fields?: LogFields): void
}

export type LoggerOptions = {
  readonly level: LogLevel
  readonly context?: LogFields
  readonly sink?: (line: string) => void
  readonly now?: () => Date
}

function describeError(error: Error): LogFields {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : { cause: error.cause instanceof Error ? describeError(error.cause) : error.cause }),
  }
}

/**
 * Лампорти — `bigint`, а `JSON.stringify` на `bigint` кидає TypeError. Логер,
 * який падає від того, що йому передали суму, гасить процес у місці, де мала
 * бути одна рядкова подія, тому серіалізація тут навмисно всеїдна.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return describeError(value)
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

function serialise(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, replacer)
  } catch (cause) {
    // Циклічне посилання в контексті не має коштувати нам самої події.
    return JSON.stringify({
      level: entry.level,
      time: entry.time,
      msg: entry.msg,
      logError: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const context = options.context ?? {}
  const threshold = SEVERITY[options.level]

  function write(level: LogLevel, message: string, fields?: LogFields): void {
    if (SEVERITY[level] < threshold) return

    // Порядок навмисний: рівень і час попереду, контекст під ним, поля виклику
    // останні — вузьке місце перекриває широке, а не навпаки.
    sink(serialise({ level, time: now().toISOString(), msg: message, ...context, ...fields }))
  }

  return {
    child: (fields) => createLogger({ ...options, context: { ...context, ...fields } }),
    fatal: (message, fields) => write('fatal', message, fields),
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
    trace: (message, fields) => write('trace', message, fields),
  }
}
