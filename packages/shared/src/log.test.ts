import { describe, expect, it } from 'vitest'
import { createLogger } from './log'
import type { LogLevel } from './log'

const AT = new Date('2026-08-28T10:00:00.000Z')

function capture(level: LogLevel = 'info') {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => AT,
  })

  return { logger, lines }
}

describe('createLogger', () => {
  it('writes one JSON line per event', () => {
    const { logger, lines } = capture()
    logger.info('слот прочитано', { slot: 42 })

    expect(lines).toEqual([
      { level: 'info', time: '2026-08-28T10:00:00.000Z', msg: 'слот прочитано', slot: 42 },
    ])
  })

  it('drops events below the configured level', () => {
    const { logger, lines } = capture('warn')
    logger.debug('тихо')
    logger.info('теж тихо')
    logger.warn('чутно')
    logger.fatal('чутно')

    expect(lines.map((line) => line.msg)).toEqual(['чутно', 'чутно'])
  })

  it('carries child context into every event', () => {
    const { logger, lines } = capture()
    logger.child({ component: 'indexer' }).child({ slot: 7 }).info('готово')

    expect(lines[0]).toMatchObject({ component: 'indexer', slot: 7, msg: 'готово' })
  })

  it('leaves the parent logger untouched', () => {
    const { logger, lines } = capture()
    logger.child({ component: 'indexer' })
    logger.info('без контексту')

    expect(lines[0]).not.toHaveProperty('component')
  })

  it('lets call fields override the inherited context', () => {
    const { logger, lines } = capture()
    logger.child({ slot: 1 }).info('перекрито', { slot: 2 })

    expect(lines[0]?.slot).toBe(2)
  })

  // Лампорти — bigint, а JSON.stringify на bigint кидає TypeError. Логер, який
  // падає від переданої суми, гасить процес там, де мав бути один рядок.
  it('serialises bigint amounts instead of throwing', () => {
    const { logger, lines } = capture()
    logger.info('надлишок', { overpay: 120_000n })

    expect(lines[0]?.overpay).toBe('120000')
  })

  it('unpacks errors with their cause', () => {
    const { logger, lines } = capture()
    logger.error('розрив', { err: new Error('RPC впав', { cause: new Error('таймаут') }) })

    expect(lines[0]?.err).toMatchObject({
      name: 'Error',
      message: 'RPC впав',
      cause: { message: 'таймаут' },
    })
  })

  it('unpacks sets and maps', () => {
    const { logger, lines } = capture()
    logger.info('довідник', { accounts: new Set(['a', 'b']), counts: new Map([['jito', 3]]) })

    expect(lines[0]?.accounts).toEqual(['a', 'b'])
    expect(lines[0]?.counts).toEqual({ jito: 3 })
  })

  it('keeps the event when the context is circular', () => {
    const { logger, lines } = capture()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    logger.warn('петля', { circular })

    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'петля' })
    expect(lines[0]?.logError).toBeTypeOf('string')
  })
})
