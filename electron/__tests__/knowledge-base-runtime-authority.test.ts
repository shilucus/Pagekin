import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'

const mocks = vi.hoisted(() => ({ embedding: vi.fn(), afterRead: vi.fn() }))
vi.mock('../embedding', async importOriginal => ({
  ...await importOriginal<typeof import('../embedding')>(),
  generateEmbeddings: mocks.embedding,
}))
vi.mock('../services/generation-knowledge-source', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/generation-knowledge-source')>()
  return { ...actual, captureGenerationKnowledge: async (...args: Parameters<typeof actual.captureGenerationKnowledge>) => {
    const snapshot = await actual.captureGenerationKnowledge(...args)
    return mocks.afterRead(snapshot)
  } }
})

import { captureWritingKnowledgeSnapshot } from '../knowledge-base'
import { closeProjectDatabase } from '../database'
import { closeConnection } from '../vector-store'

const model = { provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fictional', modelName: 'fixture' }
let projectPath = ''

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })
beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'kb-runtime-authority-'))
  openCanonicalProjectFixture(projectPath)
  mocks.embedding.mockReset().mockResolvedValue([[0.1, 0.2]])
  mocks.afterRead.mockReset().mockImplementation(async (snapshot: GenerationKnowledgeSnapshot) => snapshot)
})
afterEach(() => {
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

it('does not dispatch embedding when the lease expires at the migration await', async () => {
  let current = true
  const pending = captureWritingKnowledgeSnapshot('fiction', projectPath, { protocol: 'openai', model }, [], () => {
    if (!current) throw new Error('PROJECT_SESSION_STALE')
  })
  current = false
  await expect(pending).rejects.toThrow('PROJECT_SESSION_STALE')
  expect(mocks.embedding).not.toHaveBeenCalled()
  expect(mocks.afterRead).not.toHaveBeenCalled()
})

it('does not return a completed snapshot after the lease expires during its read', async () => {
  let current = true, notifyRead!: () => void, releaseRead!: () => void
  const read = new Promise<void>(resolve => { notifyRead = resolve })
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  mocks.afterRead.mockImplementationOnce(async (snapshot: GenerationKnowledgeSnapshot) => {
    notifyRead()
    await gate
    return snapshot
  })
  const pending = captureWritingKnowledgeSnapshot('fiction', projectPath, null, [], () => {
    if (!current) throw new Error('PROJECT_SESSION_STALE')
  })
  const rejected = expect(pending).rejects.toThrow('PROJECT_SESSION_STALE')
  await read
  current = false
  releaseRead()
  await rejected
  expect(mocks.afterRead).toHaveBeenCalledTimes(1)
})

it('returns the real snapshot while the captured lease remains current', async () => {
  const assertCurrent = vi.fn()
  const snapshot = await captureWritingKnowledgeSnapshot('fiction', projectPath, { protocol: 'openai', model }, [], assertCurrent)
  expect(snapshot).toMatchObject({ version: 1, query: 'fiction', items: [] })
  expect(mocks.embedding).toHaveBeenCalledTimes(1)
  expect(mocks.afterRead).toHaveBeenCalledTimes(1)
  expect(assertCurrent.mock.calls.length).toBeGreaterThan(1)
})
