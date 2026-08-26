/**
 * Single source of every figure in the interface.
 * All values are synthetic. All service names are invented.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000
export const SOL_USD = 186.4

/** Tenth percentile of total landing cost among successful non-vote transactions. */
export const REFERENCE_LAMPORTS = 12_400

export const WINDOW_SLOTS_SAMPLED = 214
export const WINDOW_TOTAL_LANDINGS = 30_062

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

export const fmtInt = (n: number): string => n.toLocaleString('en-US')

export const lamportsToSol = (l: number): number => l / LAMPORTS_PER_SOL

export const fmtSol = (l: number, digits = 7): string => lamportsToSol(l).toFixed(digits)

export const fmtUsdFromLamports = (l: number, digits = 4): string =>
  `$${(lamportsToSol(l) * SOL_USD).toFixed(digits)}`

export const fmtUsd = (usd: number, digits = 2): string =>
  `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`

/* ------------------------------------------------------------------ */
/* board groups                                                        */
/* ------------------------------------------------------------------ */

export interface Group {
  id: string
  name: string
  members: string[] | null
  landings: number
  /** null when the group is below the minimum sample count */
  share: number | null
  p10: number | null
  median: number | null
  p90: number | null
  overpay: number | null
  /** yes | no (observed only) | unknown */
  sendable: 'yes' | 'no' | 'unknown'
  enoughData: boolean
}

export const GROUPS: Group[] = [
  {
    id: 'direct',
    name: 'Direct RPC',
    members: null,
    landings: 18_412,
    share: 61.2,
    p10: 12_900,
    median: 21_300,
    p90: 68_400,
    overpay: 8_900,
    sendable: 'yes',
    enoughData: true,
  },
  {
    id: 'northlane',
    name: 'Northlane',
    members: ['Northlane', 'Sender'],
    landings: 8_905,
    share: 29.6,
    p10: 18_700,
    median: 47_800,
    p90: 214_000,
    overpay: 35_400,
    sendable: 'yes',
    enoughData: true,
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    members: null,
    landings: 1_844,
    share: 6.1,
    p10: 1_002_000,
    median: 1_046_200,
    p90: 1_428_000,
    overpay: 1_033_800,
    sendable: 'yes',
    enoughData: true,
  },
  {
    id: 'halyard',
    name: 'Halyard',
    members: null,
    landings: 612,
    share: 2.0,
    p10: 15_100,
    median: 33_500,
    p90: 96_300,
    overpay: 21_100,
    sendable: 'no',
    enoughData: true,
  },
  {
    id: 'unattributed',
    name: 'Unattributed',
    members: null,
    landings: 289,
    share: 1.0,
    p10: null,
    median: 24_000,
    p90: null,
    overpay: 11_600,
    sendable: 'unknown',
    enoughData: true,
  },
  {
    id: 'torrent',
    name: 'Torrent',
    members: null,
    landings: 14,
    share: null,
    p10: null,
    median: null,
    p90: null,
    overpay: null,
    sendable: 'unknown',
    enoughData: false,
  },
]

/* ------------------------------------------------------------------ */
/* window totals                                                       */
/* ------------------------------------------------------------------ */

export const WINDOW_TOTALS = {
  paid: { lamports: 2_774_465_400, sol: '2.7744654', usd: 517.16 },
  atReference: { lamports: 372_768_800, sol: '0.3727688', usd: 69.48 },
  overpay: { lamports: 2_401_696_600, sol: '2.4016966', usd: 447.68 },
  extrapolatedPerDayUsd: 42_977,
}

/* ------------------------------------------------------------------ */
/* recorder tape — median overpay, lamports, last 60 min, 5 min steps  */
/* ------------------------------------------------------------------ */

export interface TapeSeries {
  id: string
  name: string
  /** relative step size used when the tape advances */
  volatility: number
  points: number[]
}

export const TAPE: TapeSeries[] = [
  {
    id: 'direct',
    name: 'Direct RPC',
    volatility: 0.09,
    points: [7_100, 7_800, 8_200, 9_400, 8_800, 8_100, 7_900, 8_600, 9_900, 9_200, 8_700, 8_900],
  },
  {
    id: 'northlane',
    name: 'Northlane',
    volatility: 0.1,
    points: [
      28_400, 30_100, 33_800, 41_200, 38_600, 34_900, 33_100, 35_800, 44_700, 39_300, 36_200,
      35_400,
    ],
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    volatility: 0.006,
    points: [
      1_031_000, 1_029_400, 1_034_700, 1_041_200, 1_038_900, 1_033_100, 1_030_800, 1_032_600,
      1_044_300, 1_039_700, 1_035_200, 1_033_800,
    ],
  },
  {
    id: 'halyard',
    name: 'Halyard',
    volatility: 0.08,
    points: [
      19_800, 20_400, 21_900, 24_300, 23_100, 21_700, 20_900, 21_400, 25_200, 23_600, 22_000,
      21_100,
    ],
  },
]

/* ------------------------------------------------------------------ */
/* screen 2 — side by side                                             */
/* ------------------------------------------------------------------ */

export interface RunPanel {
  label: string
  channel: string
  slot: string
  slotDelay: string
  baseFee: number
  priorityFee: number
  tip: number
  total: number
}

export const RUN_FIXED: RunPanel = {
  label: 'Fixed channel',
  channel: 'Kestrel',
  slot: '341,882,104',
  slotDelay: 'two slots after submission',
  baseFee: 5_000,
  priorityFee: 4_700,
  tip: 1_043_200,
  total: 1_052_900,
}

export const RUN_ROUTED: RunPanel = {
  label: 'Routed',
  channel: 'Direct RPC',
  slot: '341,882,103',
  slotDelay: 'one slot after submission',
  baseFee: 5_000,
  priorityFee: 18_700,
  tip: 0,
  total: 23_700,
}

export const RUN_DIFFERENCE = {
  lamports: 1_029_200,
  sol: '0.0010292',
  usd: 0.1918,
  percent: 97.7,
}

export const BUDGET = {
  remainingSol: '0.0413',
  dailySol: '0.0500',
  runsLeft: 14,
  lastRunTime: '11:42',
}

/* ------------------------------------------------------------------ */
/* screen 3 — who pays the rent                                        */
/* ------------------------------------------------------------------ */

export const APPLICATION = {
  name: 'Marlin Swap',
  days: 30,
  landings: 412_880,
  paidSol: 18.42,
  paidUsd: 3_433.49,
  overpaySol: 11.07,
  overpayUsd: 2_063.45,
}

export interface RentRow {
  id: string
  name: string
  landings: number
  landingShare: number
  paidSol: number
  spendShare: number
}

export const RENT_ROWS: RentRow[] = [
  {
    id: 'direct',
    name: 'Direct RPC',
    landings: 252_900,
    landingShare: 61.3,
    paidSol: 5.39,
    spendShare: 29.3,
  },
  {
    id: 'northlane',
    name: 'Northlane',
    landings: 122_300,
    landingShare: 29.6,
    paidSol: 5.84,
    spendShare: 31.7,
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    landings: 25_300,
    landingShare: 6.1,
    paidSol: 6.61,
    spendShare: 35.9,
  },
  {
    id: 'halyard',
    name: 'Halyard',
    landings: 8_400,
    landingShare: 2.0,
    paidSol: 0.28,
    spendShare: 1.5,
  },
  {
    id: 'unattributed',
    name: 'Unattributed',
    landings: 3_980,
    landingShare: 1.0,
    paidSol: 0.3,
    spendShare: 1.6,
  },
]
