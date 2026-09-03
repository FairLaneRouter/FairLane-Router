const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const ALPHABET_INDEX = new Map([...ALPHABET].map((char, index) => [char, index] as const))

/** Довжина адреси Solana в байтах — це весь ключ, контрольної суми в ньому немає. */
export const ADDRESS_BYTES = 32

/**
 * Свій декодер замість залежності: тут тридцять рядків, а зовнішній пакет
 * привіз би з собою власну версію Buffer і власні уявлення про помилки.
 * Повертає `null` на будь-якому символі поза алфавітом — кидати нічого не
 * треба, виклик і так перевіряє результат.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null

  const bytes: number[] = []

  for (const char of value) {
    const digitValue = ALPHABET_INDEX.get(char)
    if (digitValue === undefined) return null

    // Тип виписаний явно: без нього carry виводиться через digit, а digit —
    // через carry, і TypeScript відмовляється розкручувати це коло.
    let carry: number = digitValue

    for (let i = 0; i < bytes.length; i += 1) {
      const digit = (bytes[i] ?? 0) * 58 + carry
      bytes[i] = digit & 0xff
      carry = digit >> 8
    }

    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  // Провідні одиниці — це нульові байти: у base58 вони не мають ваги і в
  // накопичувач вище не потрапляють.
  for (const char of value) {
    if (char !== '1') break
    bytes.push(0)
  }

  return Uint8Array.from(bytes.reverse())
}

/**
 * Адреса Solana не має контрольної суми, тому єдине, що взагалі можна
 * перевірити, — довжина. Помилка в одному символі це не спіймає, але й не
 * зашкодить: неіснуючий службовий акаунт ні з чим не збігається, і транзакція
 * піде в «неатрибутовано» замість того, щоб дістатись чужій групі.
 */
export function isSolanaAddress(value: string): boolean {
  return decodeBase58(value)?.length === ADDRESS_BYTES
}
