import { afterEach, describe, expect, it, vi } from 'vitest'

import { chunkText, generateEmbeddings } from '../embedding'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedding request controls', () => {
  it('keeps every chunk within the requested character limit, including one very long sentence', () => {
    const source = '春'.repeat(721)
    const chunks = chunkText(source, 200, 20)

    expect(chunks).toHaveLength(4)
    expect(chunks.every(chunk => chunk.length <= 200)).toBe(true)
    expect(chunks).toEqual([
      source.slice(0, 200),
      source.slice(180, 380),
      source.slice(360, 560),
      source.slice(540),
    ])
  })

  it('splits one long sentence without loss when overlap is zero', () => {
    const source = '春'.repeat(250)
    const chunks = chunkText(source, 100, 0)

    expect(chunks).toEqual([source.slice(0, 100), source.slice(100, 200), source.slice(200)])
    expect(chunks.join('')).toBe(source)
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true)
  })

  it('does not repeat the previous sentence when sentence chunks flush at zero overlap', () => {
    const first = `${'甲'.repeat(60)}。`
    const second = `${'乙'.repeat(60)}。`

    expect(chunkText(`${first}${second}`, 100, 0)).toEqual([first, second])
  })

  it('does not repeat the previous paragraph when paragraph chunks flush at zero overlap', () => {
    const first = '甲'.repeat(60)
    const second = '乙'.repeat(60)

    expect(chunkText(`${first}\n\n${second}`, 100, 0)).toEqual([first, second])
  })

  it('retains the configured positive overlap at sentence and paragraph boundaries', () => {
    const firstSentence = `${'甲'.repeat(60)}。`
    const secondSentence = `${'乙'.repeat(60)}。`
    const firstParagraph = '丙'.repeat(60)
    const secondParagraph = '丁'.repeat(60)

    expect(chunkText(`${firstSentence}${secondSentence}`, 100, 10)).toEqual([
      firstSentence,
      `${firstSentence.slice(-10)}${secondSentence}`,
    ])
    expect(chunkText(`${firstParagraph}\n\n${secondParagraph}`, 100, 10)).toEqual([
      firstParagraph,
      `${firstParagraph.slice(-10)}\n\n${secondParagraph}`,
    ])
  })

  it('uses the configured batch size for OpenAI-compatible embedding requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1], index: 0 }, { embedding: [0.2], index: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.3], index: 0 }, { embedding: [0.4], index: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5], index: 0 }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await generateEmbeddings(
      ['一', '二', '三', '四', '五'],
      'openai',
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local', modelName: 'bge-small-zh' },
      2,
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).input).toEqual(['一', '二'])
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).input).toEqual(['五'])
  })
})
