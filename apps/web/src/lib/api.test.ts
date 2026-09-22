import { describe, expect, it } from 'vitest'
import { ApiError, apiBase, parseSummary, summaryUrl } from './api'
import { fmtAge, fmtLamports, fmtShare } from './format'

const payload = {
  window: '1h',
  generatedAt: '2026-08-28T18:03:30.022Z',
  from: '2026-08-28T17:03:30.022Z',
  to: '2026-08-28T18:03:30.022Z',
  slotsSampled: 62,
  observations: 5109,
  landings: 34_423,
  firstBlockTime: '2026-08-28T17:03:03.000Z',
  lastBlockTime: '2026-08-28T18:02:40.000Z',
  dataAgeMs: 50_022,
  isStale: false,
  minObservations: 50,
  groups: [
    {
      groupId: 'rpc',
      name: 'Plain RPC',
      members: ['Plain RPC'],
      observations: 381,
      overpayObservations: 381,
      landings: 7620,
      costP10: 5001,
      costP50: 5690,
      costP90: 51_049,
      overpayP50: 690,
      share: 0.6397984886649875,
      isSendable: true,
      sufficientData: true,
    },
  ],
  unattributed: { observations: 152, landings: 3040, share: 0.2552 },
}

describe('apiBase', () => {
  it('takes the address from the build environment', () => {
    expect(apiBase({ VITE_API_URL: 'https://api.example.dev/' })).toBe('https://api.example.dev')
  })

  // Порожнє значення означає той самий домен, що й сторінка: так виглядає
  // розгортання за одним проксі.
  it('reads an empty address as the page own origin', () => {
    expect(apiBase({ VITE_API_URL: '' })).toBe('')
  })

  it('falls back to the neighbouring process only in development', () => {
    expect(apiBase({ DEV: true })).toBe('http://127.0.0.1:3000')
    expect(apiBase({})).toBe('')
  })
})

describe('summaryUrl', () => {
  it('asks for the window, and for the stream when told to', () => {
    expect(summaryUrl('https://api.example.dev', '15m')).toBe(
      'https://api.example.dev/v1/summary?window=15m',
    )
    expect(summaryUrl('', '24h', true)).toBe('/v1/summary/stream?window=24h')
  })
})

describe('parseSummary', () => {
  it('accepts the body the API actually returns', () => {
    expect(parseSummary(payload).groups[0]?.costP50).toBe(5690)
  })

  // Розходження контракту інакше виглядало б в інтерфейсі як порожня
  // клітинка, а не як помилка.
  it('refuses a body that lost a field, naming the field', () => {
    const { slotsSampled: _dropped, ...broken } = payload

    expect(() => parseSummary(broken)).toThrow(ApiError)
    expect(() => parseSummary(broken)).toThrow(/slotsSampled/)
  })

  it('refuses a body that is not an object at all', () => {
    expect(() => parseSummary('service unavailable')).toThrow(ApiError)
  })
})

describe('formats', () => {
  it('shows an absent figure as a dash, never as a zero', () => {
    expect(fmtLamports(null)).toBe('—')
    expect(fmtShare(null)).toBe('—')
    expect(fmtLamports(0)).toBe('0')
  })

  it('keeps the sign of a negative overpay', () => {
    expect(fmtLamports(-1_200)).toBe('-1,200')
  })

  it('says the age in the unit a reader can act on', () => {
    expect(fmtAge(null)).toBe('no data')
    expect(fmtAge(400)).toBe('just now')
    expect(fmtAge(43_000)).toBe('43s ago')
    expect(fmtAge(255_000)).toBe('4 min ago')
    expect(fmtAge(7_200_000)).toBe('2 h ago')
  })
})
