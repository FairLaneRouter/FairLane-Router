import { describe, expect, it } from 'vitest'
import {
  generateKeyToken,
  hashKeyToken,
  issueKeyRequestSchema,
  issuedKeySchema,
  KEY_BYTES,
  KEY_PREFIX,
  KEY_TOKEN_LENGTH,
  keyLabelSchema,
  keyTokenSchema,
} from './keys.ts'

/** Байти, які легко впізнати в токені очима: 00 01 02 … 1f. */
const counting = (size: number) => new Uint8Array(Array.from({ length: size }, (_, i) => i))

const zeros = (size: number) => new Uint8Array(size)

describe('generateKeyToken', () => {
  it('складає токен із префікса й байтів у шістнадцятковому записі', () => {
    expect(generateKeyToken(counting)).toBe(
      'flr_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    )
  })

  it('бере рівно KEY_BYTES байтів', () => {
    const asked: number[] = []

    generateKeyToken((size) => {
      asked.push(size)
      return zeros(size)
    })

    expect(asked).toEqual([KEY_BYTES])
  })

  it('дає токен за схемою і сталої довжини', () => {
    const token = generateKeyToken()

    expect(keyTokenSchema.safeParse(token).success).toBe(true)
    expect(token).toHaveLength(KEY_TOKEN_LENGTH)
    expect(token.startsWith(KEY_PREFIX)).toBe(true)
  })

  it('на системному джерелі не повторюється', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateKeyToken()))

    expect(tokens.size).toBe(64)
  })
})

describe('keyTokenSchema', () => {
  const token = generateKeyToken(counting)

  it.each([
    ['без префікса', token.slice(KEY_PREFIX.length)],
    ['із чужим префіксом', `flx_${token.slice(KEY_PREFIX.length)}`],
    ['коротший на символ', token.slice(0, -1)],
    ['довший на символ', `${token}0`],
    ['у верхньому регістрі', token.toUpperCase()],
    ['із символом поза алфавітом', `${token.slice(0, -1)}g`],
    ['із пробілом на хвості', `${token} `],
  ])('відкидає токен %s', (_case, value) => {
    expect(keyTokenSchema.safeParse(value).success).toBe(false)
  })
})

describe('hashKeyToken', () => {
  it('дає відомий SHA-256 від токена цілком', async () => {
    // Звірено з `node:crypto`: sha256(токен як UTF-8), запис шістнадцятковий.
    await expect(hashKeyToken(generateKeyToken(zeros))).resolves.toBe(
      '6fa004dae1b6768bb6f44f909e8b9221a0ea2f212c1a41897c8ea4948f878be5',
    )
    await expect(hashKeyToken(generateKeyToken(counting))).resolves.toBe(
      'c229007e38529366cb1ead999ed618dbb83b93dc8b480e58590c44c0c1917a63',
    )
  })

  it('рахує хеш від токена з префіксом, а не від самих байтів', async () => {
    const token = generateKeyToken(counting)

    await expect(hashKeyToken(token)).resolves.not.toBe(
      await hashKeyToken(token.slice(KEY_PREFIX.length)),
    )
  })

  it('стабільний і має 64 символи', async () => {
    const token = generateKeyToken()
    const hash = await hashKeyToken(token)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(hashKeyToken(token)).resolves.toBe(hash)
  })
})

describe('issueKeyRequestSchema', () => {
  it('приймає порожнє тіло — ключ видається без жодного поля', () => {
    expect(issueKeyRequestSchema.parse({})).toEqual({})
  })

  it('обрізає пробіли навколо позначки', () => {
    expect(issueKeyRequestSchema.parse({ label: '  бот арбітражу  ' })).toEqual({
      label: 'бот арбітражу',
    })
  })

  it.each([
    ['порожню', ''],
    ['із самих пробілів', '   '],
    ['довшу за 64 символи', 'я'.repeat(65)],
  ])('відкидає позначку %s', (_case, label) => {
    expect(issueKeyRequestSchema.safeParse({ label }).success).toBe(false)
  })

  it('не приймає нічого замість рядка', () => {
    expect(issueKeyRequestSchema.safeParse({ label: 7 }).success).toBe(false)
  })
})

describe('keyLabelSchema', () => {
  it('лишає позначку рівно 64 символи', () => {
    expect(keyLabelSchema.parse('я'.repeat(64))).toHaveLength(64)
  })
})

describe('issuedKeySchema', () => {
  const issued = {
    id: '6f1c0d2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
    key: generateKeyToken(counting),
    createdAt: '2026-09-24T12:00:00.000Z',
    label: null,
  }

  it('приймає видачу без позначки', () => {
    expect(issuedKeySchema.parse(issued)).toEqual(issued)
  })

  it('не приймає видачу, у якій замість токена хеш', () => {
    expect(
      issuedKeySchema.safeParse({ ...issued, key: 'c229007e38529366cb1ead999ed618db' }).success,
    ).toBe(false)
  })
})
