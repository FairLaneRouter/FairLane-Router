import type { BlockTransaction } from './rpc'

export const BASE_FEE_PER_SIGNATURE = 5000

export const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111'

export type LandingCost = {
  readonly baseFee: number
  readonly priorityFee: number
  readonly tipTotal: number
  readonly tipAccounts: readonly string[]
  readonly total: number
  readonly computeUnits: number | null
}

export function isVoteTransaction(tx: BlockTransaction): boolean {
  return tx.transaction.message.accountKeys.includes(VOTE_PROGRAM_ID)
}

/**
 * Чайові не є комісією і в meta.fee не входять — вони приходять звичайним
 * переказом на службовий акаунт, тому єдиний спосіб їх побачити це приріст
 * балансу такого акаунта в межах тієї самої транзакції.
 */
function sumTips(
  tx: BlockTransaction,
  tipAccounts: ReadonlySet<string>,
): { total: number; accounts: string[] } {
  const { accountKeys } = tx.transaction.message
  const { preBalances, postBalances } = tx.meta
  const accounts: string[] = []
  let total = 0

  for (const [index, account] of accountKeys.entries()) {
    if (!tipAccounts.has(account)) continue

    const before = preBalances[index]
    const after = postBalances[index]
    if (before === undefined || after === undefined) continue

    const gained = after - before
    if (gained <= 0) continue

    total += gained
    accounts.push(account)
  }

  return { total, accounts }
}

export function computeLandingCost(
  tx: BlockTransaction,
  tipAccounts: ReadonlySet<string>,
): LandingCost {
  const signatureCount = tx.transaction.signatures.length
  const expectedBase = BASE_FEE_PER_SIGNATURE * signatureCount

  // Комісія, менша за базову, означає, що припущення 5000/підпис не тримається.
  // Відʼємний пріоритет отруїв би еталон слота, тому обрізаємо в нуль і лишаємо
  // базовою те, що фактично сплачено.
  const baseFee = Math.min(expectedBase, tx.meta.fee)
  const priorityFee = Math.max(0, tx.meta.fee - expectedBase)

  const tips = sumTips(tx, tipAccounts)

  return {
    baseFee,
    priorityFee,
    tipTotal: tips.total,
    tipAccounts: tips.accounts,
    total: tx.meta.fee + tips.total,
    computeUnits: tx.meta.computeUnitsConsumed ?? null,
  }
}
