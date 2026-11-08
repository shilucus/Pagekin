import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fetchRoute, guardFetch } from '../real-model.mjs'
import { runScheduledGenerationScenario } from '../scheduled-generation-scenario.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const copy = value => structuredClone(value)

// These fixtures exercise scenario assertions, not Electron, the scheduler or domain writers.
function fixture(options = {}) {
  const projects = [], tasks = new Map(), calls = [], opened = new Set(), prepared = []
  let active, reply, requests = 0, lease = 0, setupFailureInjected = false
  const fake = { chats: [], replyReview(value) { reply = value }, streamProse() {}, gate: {
    waiting: 0, held: false, hold() { this.held = true }, release() {
      if (!this.held) return
      this.held = false; this.waiting = 0
      for (const task of tasks.values()) {
        if (task.task.state !== 'ready' || !task.attempts.length) continue
        const marker = `SCHEDMARK${task.letter}`
        const outline = `Prepare a short chapter execution outline, not prose. ${marker}`
        const prose = reply(`${marker} draft`)
        const prompts = [outline, `${marker} draft`, `[Strict evidence-anchor constraint] ${prose}`]
        const outputs = prompts.map(prompt => reply(prompt))
        requests += 3
        fake.chats.push(...prompts.map(content => ({ messages: [{ content }] })))
        task.steps = ['outline', 'draft', 'compose', 'draft_commit', 'review', 'review_commit'].map(kind => ({ kind,
          effect: { receiptAttemptId: `id-${kind}`, contentHash: hash(kind), receiptKind: kind === 'compose' ? 'composition'
            : ['draft_commit', 'review_commit'].includes(kind) ? kind : 'model' } }))
        task.attempts = Array.from({ length: 3 }, () => ({ status: 'settled', artifactId: 'artifact' }))
        task.chapters = [{ chapterNumber: 1, draftSave: { kind: 'current', receipt: { id: 1, version: 1, content: outputs[1], contentHash: hash(outputs[1]) } },
          review: { success: true, kind: 'review', content: outputs[2], contentHash: hash(outputs[2]), source: { id: 1, version: 1, chapterNumber: 1, content: outputs[1] } } }]
        if (options.wrongReview) task.chapters[0].review.source.id = 9
        task.task.state = 'waiting_review'
      }
      if (options.lateResult) {
        const c = [...tasks.values()].find(task => task.letter === 'C')
        if (c) c.attempts.push({ status: 'settled', artifactId: 'late' })
      }
    },
  } }
  const invoke = async (_page, channel, ...args) => {
    calls.push(channel)
    if (channel === options.setupError && !setupFailureInjected) {
      setupFailureInjected = true
      return options.missingReceipt ? undefined : { success: false, error: 'FICTIONAL_SETUP_FAILED' }
    }
    if (channel === 'project:create') {
      if (options.createError) return { success: false, error: 'FICTIONAL_CREATE_FAILED' }
      const letter = args[0].name.at(-1), project = { letter, projectId: letter, projectPath: `/fictional/${letter}` }
      projects.push(project); return { success: true, ...project }
    }
    if (channel === 'project-runtime:v1:open-view') {
      active = projects.find(project => project.projectPath === args[0])
      opened.add(active.projectPath)
      return { success: true, project: { sessionLease: `lease-${++lease}`, novelConfig: {} } }
    }
    if (['llm:save-model', 'project:update-config'].includes(channel)) return { success: true }
    if (channel === 'db:blueprint-upsert') {
      prepared.push({ letter: active.letter, runtimes: opened.size })
      if (opened.size !== 1) return { success: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' }
      return { success: true }
    }
    if (channel === 'db:close') { opened.delete(args[0]); return { success: true } }
    if (channel === 'db:project-core-get') return { coreOutline: `SCHEDMARK${active.letter} fictional people deliver a letter.` }
    if (channel === 'workflow-batch:v2:start') {
      const letter = active.letter, reference = { projectId: letter, taskId: letter, revision: 1 }
      const task = { letter, task: { projectId: letter, taskId: letter, revision: 1, state: 'ready' },
        steps: Array.from({ length: 6 }, () => ({ effect: null })), attempts: [], chapters: [] }
      if (letter !== 'C' || options.queueDispatch) {
        task.attempts.push({ status: 'dispatch-marked', artifactId: 'artifact' }); fake.gate.waiting++
      }
      tasks.set(letter, task); return { reference, receipt: copy(task) }
    }
    if (channel === 'workflow-batch:v2:read-receipt') return copy(tasks.get(args[0].reference.taskId))
    if (channel === 'workflow-batch:v2:cancel') {
      const task = tasks.get(args[0].reference.taskId); task.task.state = 'cancelled'
      return { receipt: copy(task) }
    }
    if (channel === 'workflow-batch:v2:read-history') return copy(tasks.get(args[0].taskId))
    if (channel === 'workflow-batch:v2:reauthorize') return { reference: null, receipt: copy(tasks.get(args[0].taskId)) }
    throw new Error(`Unexpected channel ${channel}`)
  }
  const context = { app: {}, page: {}, roots: { projects: '/fictional' }, invoke, fake }
  const dependencies = { grantDirectory: async () => ({ grantId: 'fixture' }), requestCount: async () => requests,
    observeQueue: async () => { if (options.earlyHeaderLog) requests++ },
    waitFor: async (check, label) => { const result = await check(); if (!result) throw new Error(`fixture wait ${label}`); return result } }
  return { context, dependencies, calls, tasks, prepared }
}

describe('scheduled generation scenario fixture only', () => {
  it('checks two held requests, zero queued attempts, saved effects and detached history', async () => {
    const f = fixture()
    const result = await runScheduledGenerationScenario(f.context, f.dependencies)
    expect(result).toMatchObject({ simultaneousFakeArrivals: 2, queuedAttempts: 0, queuedEffects: 0,
      guardedFetchAttempts: 6, fakeProviderRequests: 6, completedEffects: [6, 6], detachedHistoryRecovered: true })
    expect(new Set(result.contentHashes).size).toBe(2)
    expect(f.prepared).toEqual(['A', 'B', 'C'].map(letter => ({ letter, runtimes: 1 })))
    expect(f.calls.slice(0, f.calls.indexOf('workflow-batch:v2:start')).filter(channel => channel === 'db:close')).toHaveLength(3)
    expect(f.calls.slice(f.calls.indexOf('workflow-batch:v2:start')).filter(channel => channel === 'db:close')).toHaveLength(3)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(6)
    expect(f.context.fake.gate.waiting).toBe(0)
  })
  it.each(['queueDispatch', 'wrongReview', 'lateResult'])('rejects %s and cleans up', async key => {
    const f = fixture({ [key]: true })
    await expect(runScheduledGenerationScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.context.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(6)
  })
  it('rejects an early response-header log while two arrivals remain held and C has no attempt or effect', async () => {
    const f = fixture({ earlyHeaderLog: true })
    const observeQueue = f.dependencies.observeQueue
    f.dependencies.observeQueue = async () => {
      await observeQueue()
      expect(f.context.fake.gate.waiting).toBe(2)
      expect(f.tasks.get('C').attempts).toHaveLength(0)
      expect(f.tasks.get('C').steps.filter(step => step.effect)).toHaveLength(0)
    }
    await expect(runScheduledGenerationScenario(f.context, f.dependencies))
      .rejects.toThrow('request returned response headers while fake arrivals were held')
    expect(f.context.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(6)
  })
  it.each([
    ['llm:save-model', 'models', 0],
    ['project:update-config', 'A', 1],
    ['db:blueprint-upsert', 'A', 1],
    ['db:close', 'A', 2],
  ])('identifies a failed %s preparation receipt and still cleans up', async (channel, book, closes) => {
    const f = fixture({ setupError: channel })
    await expect(runScheduledGenerationScenario(f.context, f.dependencies))
      .rejects.toThrow(`SCHEDULED_GENERATION_SETUP_FAILED:${channel}:${book}:FICTIONAL_SETUP_FAILED`)
    expect(f.calls).not.toContain('workflow-batch:v2:start')
    expect(f.calls.filter(value => value === 'db:close')).toHaveLength(closes)
    expect(f.context.fake.gate.waiting).toBe(0)
  })
  it('identifies a missing blueprint receipt rather than throwing a property-access error', async () => {
    const f = fixture({ setupError: 'db:blueprint-upsert', missingReceipt: true })
    await expect(runScheduledGenerationScenario(f.context, f.dependencies))
      .rejects.toThrow('SCHEDULED_GENERATION_SETUP_FAILED:db:blueprint-upsert:A:NO_RECEIPT')
    expect(f.calls).not.toContain('workflow-batch:v2:start')
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(1)
  })
  it('preserves the initial creation failure without assuming any task started', async () => {
    const f = fixture({ createError: true })
    await expect(runScheduledGenerationScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_CREATE_FAILED')
    expect(f.calls).not.toContain('workflow-batch:v2:start')
    expect(f.calls).not.toContain('db:close')
  })
})

describe('scheduled generation response-header observation', () => {
  it('keeps the actual guard log empty until a dispatched fetch returns response headers', async () => {
    const headers = Promise.withResolvers()
    const sink = { externalRequests: [], modelRequests: [] }
    const calls = []
    const guarded = guardFetch(input => {
      calls.push(input)
      return headers.promise
    }, fetchRoute, { fakePort: 4567, realOrigin: null }, sink)
    const pending = guarded('https://api.openai.com/v1/chat/completions')
    expect(calls).toEqual(['http://127.0.0.1:4567/v1/chat/completions'])
    expect(sink.modelRequests).toEqual([])
    headers.resolve({ status: 200 })
    await expect(pending).resolves.toEqual({ status: 200 })
    expect(sink.modelRequests).toEqual([{ path: '/v1/chat/completions', status: 200, ms: expect.any(Number) }])
    expect(sink.externalRequests).toEqual([])
  })
})
