import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const valid = {
  SOLANA_RPC_URL: 'https://rpc.example/?api-key=k',
  DATABASE_URL: 'postgresql://u:p@host:6543/postgres',
}

describe('loadConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadConfig(valid)

    expect(config.solanaRpcUrl).toBe(valid.SOLANA_RPC_URL)
    expect(config.sampleEveryN).toBe(100)
    expect(config.rpcSampleRate).toBe(0.05)
    expect(config.port).toBe(3000)
    expect(config.logLevel).toBe('info')
  })

  it('names the offending variable when one is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/SOLANA_RPC_URL/)
  })

  it('rejects a non-https RPC url', () => {
    expect(() => loadConfig({ ...valid, SOLANA_RPC_URL: 'http://rpc.example' })).toThrow(
      /SOLANA_RPC_URL/,
    )
  })

  it('parses numeric variables from strings', () => {
    const config = loadConfig({ ...valid, SAMPLE_EVERY_N: '25', PORT: '8080' })

    expect(config.sampleEveryN).toBe(25)
    expect(config.port).toBe(8080)
  })

  it('keeps the in-process indexer off unless asked for literally', () => {
    expect(loadConfig(valid).runIndexer).toBe(false)
    expect(loadConfig({ ...valid, RUN_INDEXER: '' }).runIndexer).toBe(false)
    expect(loadConfig({ ...valid, RUN_INDEXER: 'true' }).runIndexer).toBe(true)
    expect(() => loadConfig({ ...valid, RUN_INDEXER: '1' })).toThrow(/RUN_INDEXER/)
  })

  it('rejects a sampling stride below one', () => {
    expect(() => loadConfig({ ...valid, SAMPLE_EVERY_N: '0' })).toThrow(/SAMPLE_EVERY_N/)
  })

  it('rejects a sample rate outside 0..1', () => {
    expect(() => loadConfig({ ...valid, RPC_SAMPLE_RATE: '1.5' })).toThrow(/RPC_SAMPLE_RATE/)
  })

  // Порожній рядок у Railway/Vercel означає «змінна не задана», а не «задана порожньою»:
  // обидві платформи не вміють видаляти змінну, лише очистити її значення.
  it('treats an empty string as absent', () => {
    const config = loadConfig({ ...valid, SAMPLE_EVERY_N: '', CHANNEL_JITO_ENDPOINT: '' })

    expect(config.sampleEveryN).toBe(100)
    expect(config.channelEndpoints).toEqual({})
  })

  it('collects channel endpoints that carry a value', () => {
    const config = loadConfig({
      ...valid,
      CHANNEL_JITO_ENDPOINT: 'https://jito.example/api',
      CHANNEL_NOZOMI_ENDPOINT: '',
    })

    expect(config.channelEndpoints).toEqual({ jito: 'https://jito.example/api' })
  })

  it('keeps the demo wallet secret out of the string form of the config', () => {
    const config = loadConfig({ ...valid, DEMO_WALLET_SECRET: 'a-real-looking-secret' })

    expect(config.demoWalletSecret).toBe('a-real-looking-secret')
    expect(JSON.stringify(config)).not.toContain('a-real-looking-secret')
    expect(String(config)).not.toContain('a-real-looking-secret')
  })
})
