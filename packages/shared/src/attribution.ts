import { RPC_GROUP_ID, type ChannelRegistry } from './channels.ts'
import type { LandingCost } from './cost.ts'

/**
 * Чим саме доведена належність до групи. Причина зберігається разом із
 * результатом, бо `groupId: null` буває з двох різних приводів, і плутати їх
 * не можна: «жодного сліду доставки» — це спостереження, а «сліди двох груп
 * одразу» — це межа методу, яку видно в частці «неатрибутовано» (FR-039).
 */
export type AttributionBasis = 'tip' | 'priority-fee' | 'ambiguous' | 'none'

export type Attribution = {
  /** `null` — «неатрибутовано»: у показники жодної групи не входить (FR-039). */
  readonly groupId: string | null
  readonly basis: AttributionBasis
}

const UNATTRIBUTED = (basis: AttributionBasis): Attribution => ({ groupId: null, basis })

/**
 * Одиниця атрибуції — **група**, не бренд усередині неї (FR-004, FR-038).
 * Порядок рішень:
 *
 * 1. Чайові відомій групі — пряме свідчення, сильніше за все інше.
 * 2. Чайові двом різним групам одразу — свідчення суперечливе. Вибирати
 *    більший переказ означало б здогадуватись, а SC-009 вимагає нуль хибно
 *    зарахованих: така транзакція йде в «неатрибутовано».
 * 3. Без відомих чайових, але з пріоритетною комісією — звичайний RPC.
 * 4. Без чайових і без пріоритетної комісії — за доставку не заплачено нічого,
 *    свідчити про ціну каналу така посадка не може.
 */
export function attributeGroup(cost: LandingCost, registry: ChannelRegistry): Attribution {
  const groupIds = new Set<string>()

  for (const account of cost.tipAccounts) {
    const group = registry.groupByTipAccount(account)
    if (group !== null) groupIds.add(group.id)
  }

  if (groupIds.size === 1) {
    const [groupId] = [...groupIds]
    return groupId === undefined ? UNATTRIBUTED('none') : { groupId, basis: 'tip' }
  }

  if (groupIds.size > 1) return UNATTRIBUTED('ambiguous')

  if (cost.priorityFee > 0) return { groupId: RPC_GROUP_ID, basis: 'priority-fee' }

  return UNATTRIBUTED('none')
}
