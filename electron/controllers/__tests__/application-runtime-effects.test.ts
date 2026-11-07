import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'

type Handler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)) } }))

const sourceUrl = 'https://github.com/acme/story-skill/blob/main/SKILL.md'
const skillText = `---
name: safe-prose
description: Improve concrete prose.
version: 1.0.0
language: en-US
stage: refinement
---
Revise with concrete action and varied sentence rhythm.`
const response = () => new Response(skillText, { status: 200, headers: { 'content-type': 'text/plain' } })
let root: string, dataRoot: string
let host: typeof import('../../services/project-runtime').projectRuntimeHost
let settleFetch: ((response: Response) => void) | undefined
let pending: Promise<unknown> | undefined

function handler(channel: string): Handler {
  const found = mocks.handlers.get(channel)
  if (!found) throw new Error(`MISSING_FICTIONAL_HANDLER:${channel}`)
  return found
}

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  settleFetch = undefined
  pending = undefined
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-application-effects-'))
  dataRoot = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(root)
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  ;(await import('../app-data-controller')).registerAppDataController()
  host = (await import('../../services/project-runtime')).projectRuntimeHost
})

afterEach(async () => {
  settleFetch?.(response())
  await pending?.catch(() => {})
  await host.requestCloseAll({ timeoutMs: 0 }).catch(() => {})
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(root, { recursive: true, force: true })
})

describe('actual global tool handler and runtime close integration', () => {
  it.each([false, true])('waits for the real Skill install handler after sender loss (has-project=%s)', async hasProject => {
    let runtime: import('../../services/project-runtime').ProjectRuntime | undefined
    if (hasProject) {
      const projectPath = path.join(root, 'fictional-project'), projectId = randomUUID()
      fs.mkdirSync(path.join(projectPath, '.ai-novel'), { recursive: true })
      fs.writeFileSync(path.join(projectPath, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
        projectId, createdAt: '2026-11-07T00:00:00.000Z',
      })))
      ;(await import('../../database')).createProjectDatabase(projectPath)
      runtime = host.commitOpen(host.prepareOpen({ kind: 'manifest', rootPath: projectPath, projectId, storageFormat: 'canonical' }))
    }
    expect(await handler('skills:inspect-github')({}, sourceUrl)).toMatchObject({ success: true })
    const fetch = vi.fn(() => new Promise<Response>(resolve => { settleFetch = resolve }))
    vi.stubGlobal('fetch', fetch)
    let senderGone = false
    pending = handler('skills:install-github')({ sender: { id: 7, isDestroyed: () => senderGone } }, sourceUrl)
    expect(fetch).toHaveBeenCalledOnce()
    senderGone = true
    await expect(host.requestCloseAll({ timeoutMs: 0 })).rejects.toThrow()
    if (runtime) expect(runtime.database.open).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'skills', 'safe-prose', 'SKILL.md'))).toBe(false)
    expect(await handler('skills:inspect-github')({}, sourceUrl)).toEqual({ success: false, error: 'PROJECT_RUNTIME_HOST_CLOSING' })
    expect(fetch).toHaveBeenCalledOnce()
    settleFetch!(response())
    expect(await pending).toMatchObject({ success: true, skill: { name: 'safe-prose' } })
    expect(fs.existsSync(path.join(dataRoot, 'skills', 'safe-prose', 'SKILL.md'))).toBe(true)
    await host.requestCloseAll({ timeoutMs: 0 })
    if (runtime) expect(runtime.database.open).toBe(false)
  })

  it('allows close retry only after a rejected fetch has actually unwound its main handler', async () => {
    let rejectFetch!: (error: Error) => void
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject }))
    vi.stubGlobal('fetch', fetch)
    pending = handler('skills:inspect-github')({}, sourceUrl)
    await expect(host.requestCloseAll({ timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    rejectFetch(new Error('Fictional isolated transport failure'))
    expect(await pending).toMatchObject({ success: false })
    await host.requestCloseAll({ timeoutMs: 0 })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
