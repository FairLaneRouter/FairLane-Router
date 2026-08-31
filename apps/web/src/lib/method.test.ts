import { BASE_FEE_PER_SIGNATURE, MIN_SLOT_REF_SAMPLES, SLOT_REF_PERCENTILE } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import * as page from './method'

/**
 * Сторінка методики обіцяє, що за нею можна перерахувати надлишок руками
 * (SC-010). Розходження її чисел із кодом робить сторінку не застарілою, а
 * неправдивою — тому це помилка збірки, а не привід оновити текст колись.
 */
describe('methodology constants', () => {
  it('matches the base fee the cost calculator uses', () => {
    expect(page.BASE_FEE_PER_SIGNATURE).toBe(BASE_FEE_PER_SIGNATURE)
  })

  it('matches the percentile the indexer takes for the slot reference', () => {
    expect(page.SLOT_REF_PERCENTILE).toBe(SLOT_REF_PERCENTILE)
  })

  it('matches the minimum sample size below which a slot has no reference', () => {
    expect(page.MIN_SLOT_REF_SAMPLES).toBe(MIN_SLOT_REF_SAMPLES)
  })
})
