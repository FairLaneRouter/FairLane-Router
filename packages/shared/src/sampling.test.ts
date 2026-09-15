import { describe, expect, it } from 'vitest'
import { sampleWeight } from './sampling.ts'

describe('sampleWeight', () => {
  it('takes the weight as the reciprocal of the sampling rate', () => {
    expect(sampleWeight(0.05)).toBe(20)
    expect(sampleWeight(0.25)).toBe(4)
  })

  it('keeps the weight whole so the percentile rank stays exact', () => {
    expect(Number.isInteger(sampleWeight(0.3))).toBe(true)
  })

  // Частка 0 означає «звичайний RPC не зберігати». Рядки з позначкою вибірки
  // тоді лишились від іншої частки, і якою вона була, дані не пам'ятають.
  it('falls back to a weight of one when nothing is being sampled', () => {
    expect(sampleWeight(0)).toBe(1)
    expect(sampleWeight(1)).toBe(1)
  })

  it('rejects a rate outside 0…1', () => {
    expect(() => sampleWeight(1.5)).toThrow(RangeError)
    expect(() => sampleWeight(Number.NaN)).toThrow(RangeError)
  })
})
