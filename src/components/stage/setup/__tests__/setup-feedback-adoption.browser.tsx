import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { StoreApi } from 'zustand'
import type { NovelConfig, ProjectData, ProjectSessionContext } from '../../../../shared/ipc-channels'
import {
  assertPlanningFeedbackRequest,
  type PlanningFeedbackFieldBase,
} from '../../../../shared/planning-feedback-ipc'
import {
  PLANNING_FEEDBACK_CORE_COLUMNS,
  planningFeedbackCoreSnapshot,
  type PlanningFeedbackCandidate,
} from '../../../../shared/planning-feedback'
import {
  getActiveProjectSessionContext,
  setActiveProjectSessionContext,
} from '../../../../shared/project-session-context'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageSetup from '../StageSetup'

const SESSION: ProjectSessionContext = { projectId: 'setup-feedback-a', leaseId: 'lease-a', projectPath: 'C:/fictional/setup-feedback-a' }
const REOPENED: ProjectSessionContext = { ...SESSION, leaseId: 'lease-a-reopened' }
const OTHER: ProjectSessionContext = { projectId: 'setup-feedback-b', leaseId: 'lease-b', projectPath: 'C:/fictional/setup-feedback-b' }
const FIELDS = [
  ['coreOutline', 'Core outline'], ['writingStyle', 'Writing style'], ['protagonistProfile', 'Protagonist'],
  ['worldSetting', 'World'], ['goldenFinger', 'Core hook'], ['globalGuidance', 'Global guidance'],
] as const
type FeedbackField = typeof FIELDS[number][0]
const CONFIG: NovelConfig = {
  genre: 'Mystery', subGenre: '', targetAudience: 'All ages', totalChapters: 24, wordsPerChapter: 3000,
  coreOutline: 'Original outline', worldSetting: 'Original world', goldenFinger: 'Original hook',
  protagonistProfile: 'Original protagonist', globalGuidance: 'Original guidance', writingStyle: 'Original style',
  referenceWorks: 'Original references', plotStructure: 'three_act', narrativePOV: 'third_limited', writingLanguage: 'en-US',
}
const CANDIDATE_TEXT = 'The author-approved revision.'
function view(baseId: string) {
  return { handle: { projectId: SESSION.projectId, epoch: SESSION.leaseId, rootActionId: `root-${baseId}`, runId: `run-${baseId}` },
    operation: 'planning-feedback', status: 'running', nonReplayable: false,
    budget: { maxAttempts: 2, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 50, deadlineAt: 1000 }, artifacts: [] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function snapshot<T>(store: StoreApi<T>) {
  const state = store.getState()
  return () => store.setState(state, true)
}

function project(session: ProjectSessionContext, config: NovelConfig = CONFIG): ProjectData {
  return { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, name: 'Fictional setup',
    novelConfig: { ...config }, characterStates: '', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
}

function base(field: FeedbackField, config: NovelConfig, baseId: string): PlanningFeedbackFieldBase {
  const source = planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS).map(key => {
    const value = key === 'narrativePov' ? config.narrativePOV : config[key as keyof NovelConfig]
    return [key, typeof value === 'string' || typeof value === 'number' ? value : '']
  })))
  return { schemaVersion: 1, baseId, projectId: SESSION.projectId, target: field,
    scope: { kind: 'field', field }, source, sourceRevision: 1, sourceHash: 'a'.repeat(64),
    value: config[field] ?? '', valueHash: 'b'.repeat(64), createdAt: 1, closedAt: null, closedByAdoptionId: null }
}

function candidate(text: string, baseId: string): PlanningFeedbackCandidate {
  return { schemaVersion: 1, candidateId: `candidate-${baseId}`, projectId: SESSION.projectId, baseId,
    parentCandidateId: null, generationParentHash: 'b'.repeat(64), text, textHash: 'c'.repeat(64),
    feedback: 'Keep the opening precise', constraints: [], createdAt: 2,
    origin: { kind: 'generated', runId: view(baseId).handle.runId, attemptId: 'feedback-attempt', artifactId: 'feedback-artifact',
      modelLeaseRevision: 'd'.repeat(64), skillSnapshotHash: 'e'.repeat(64), contextSnapshotHash: 'f'.repeat(64) } }
}

let host: HTMLDivElement
let root: Root
let restores: (() => void)[]
let originalSession: ProjectSessionContext | null
let originalAPI: PropertyDescriptor | undefined
let target: FeedbackField
let failureAt: 'capture' | 'begin' | 'stage' | null
let adoption: ReturnType<typeof deferred<unknown>>
let committed: NovelConfig
let capturedBase: PlanningFeedbackFieldBase
let captureCount: number
let commitBeforeAck: boolean
let candidateText: string
let acknowledgeNextAdoption: boolean
let committedReceipt: { idempotencyKey: string; text: string } | null
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let publish: MockInstance<ReturnType<typeof useProjectStore.getState>['publishSavedNovelConfig']>

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  restores = [snapshot(useEditorStore), snapshot(useLayoutStore), snapshot(useLLMStore), snapshot(useLocaleStore),
    snapshot(useProjectStore), snapshot(useWorkflowStore)]
  originalSession = getActiveProjectSessionContext()
  originalAPI = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
  target = 'coreOutline'
  failureAt = null
  adoption = deferred<unknown>()
  committed = { ...CONFIG }
  captureCount = 0
  commitBeforeAck = false
  candidateText = CANDIDATE_TEXT
  acknowledgeNextAdoption = false
  committedReceipt = null
  setActiveProjectSessionContext(SESSION)
  useLocaleStore.setState({ locale: 'en-US' })
  useProjectStore.setState({ currentProject: project(SESSION) })
  useEditorStore.setState({ draftLedgers: {}, tabs: [{ id: 'config', name: 'Setup', type: 'config', projectKey: SESSION.projectPath, dirty: false }], activeTabId: 'config' })
  useWorkflowStore.setState({ activeRuns: [] })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: 'fictional-model', stageModelIds: {} })
  publish = vi.spyOn(useProjectStore.getState(), 'publishSavedNovelConfig')
  invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const request = args[0]
    const session = args.at(-1)
    expect(session).toEqual(SESSION)
    switch (channel) {
      case 'planning-feedback:v1:capture': {
        assertPlanningFeedbackRequest(channel, request)
        const selected = FIELDS.find(([field]) => field === request.target)
        if (!selected) throw new Error('Unexpected setup target')
        target = selected[0]
        if (failureAt === 'capture') throw new Error('PLANNING_FEEDBACK_SOURCE_CONFLICT')
        capturedBase = base(target, committed, `feedback-base-${++captureCount}`)
        return capturedBase
      }
      case 'planning-feedback:v1:read-history':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.baseId).toBe(capturedBase.baseId)
        return { base: capturedBase, candidates: [], adoptions: [] }
      case 'planning-feedback:v1:begin':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.input.baseId).toBe(capturedBase.baseId)
        if (failureAt === 'begin') throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
        return view(capturedBase.baseId)
      case 'planning-feedback:v1:execute':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.handle).toEqual(view(capturedBase.baseId).handle)
        return { run: { ...view(capturedBase.baseId), status: 'completed' }, outcome: { status: 'completed',
          content: candidateText, finishReason: 'stop', receipt: { finishReason: 'stop', visibleArtifact: {
            artifactId: 'feedback-artifact', attemptId: 'feedback-attempt', revision: 1, textHash: 'c'.repeat(64),
          } } } }
      case 'planning-feedback:v1:stage':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.baseId).toBe(capturedBase.baseId)
        expect(request.runId).toBe(view(capturedBase.baseId).handle.runId)
        if (failureAt === 'stage') throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
        return candidate(candidateText, capturedBase.baseId)
      case 'planning-feedback:v1:adopt': {
        assertPlanningFeedbackRequest(channel, request)
        expect(request.candidateId).toBe(`candidate-${capturedBase.baseId}`)
        if (acknowledgeNextAdoption) {
          acknowledgeNextAdoption = false
          committed = { ...committed, [target]: request.text }
          return { adoptionId: 'feedback-adoption-2' }
        }
        if (commitBeforeAck) {
          committed = { ...committed, [target]: request.text }
          committedReceipt = { idempotencyKey: request.idempotencyKey, text: request.text }
        }
        const receipt = await adoption.promise
        if (!commitBeforeAck) committed = { ...committed, [target]: request.text }
        return receipt
      }
      case 'project:save': {
        const saved = args[1] as ProjectData
        committed = { ...saved.novelConfig }
        return { success: true }
      }
      default: throw new Error(`Unexpected setup write or call: ${channel}`)
    }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke } })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px;'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  for (const restore of restores) restore()
  setActiveProjectSessionContext(originalSession)
  if (originalAPI) Object.defineProperty(window, 'aiNovelAPI', originalAPI)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

function button(name: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item =>
    (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
  if (!result) throw new Error(`Missing setup button: ${name}`)
  return result
}

async function click(name: string) {
  await act(async () => button(name).click())
}

async function openFeedback(field: FeedbackField = 'coreOutline') {
  await act(async () => root.render(<StageSetup projectKey={SESSION.projectPath} />))
  const label = FIELDS.find(([key]) => key === field)![1]
  if (field !== 'coreOutline') await click(label)
  const histories = channels().filter(channel => channel === 'planning-feedback:v1:read-history').length
  await click(`Revise \u201c${label}\u201d with feedback`)
  await vi.waitFor(() => expect(channels().filter(channel => channel === 'planning-feedback:v1:read-history')).toHaveLength(histories + 1))
}

async function generate() {
  const feedback = host.querySelector<HTMLTextAreaElement>('.pf-textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(feedback, 'Keep the opening precise')
    feedback.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Generate candidate')
}

async function beginAdoption(field: FeedbackField = 'coreOutline') {
  await openFeedback(field)
  await generate()
  await vi.waitFor(() => expect(button('Adopt this candidate').disabled).toBe(false))
  await click('Adopt this candidate')
  expect(invoke.mock.calls.filter(([channel]) => channel === 'planning-feedback:v1:adopt')).toHaveLength(1)
  expect(publish).not.toHaveBeenCalled()
  expect(committed[field]).toBe(commitBeforeAck ? CANDIDATE_TEXT : CONFIG[field])
}

async function acknowledge() {
  await act(async () => { adoption.resolve({ adoptionId: 'feedback-adoption' }); await adoption.promise })
}

function config() { return useProjectStore.getState().currentProject!.novelConfig }
function dirty() { return useEditorStore.getState().tabs.some(tab => tab.type === 'config' && tab.dirty) }
function channels() { return invoke.mock.calls.map(([channel]) => channel) }

function expectOnlyFeedbackCalls() {
  expect(channels()).toEqual(['planning-feedback:v1:capture', 'planning-feedback:v1:read-history',
    'planning-feedback:v1:begin', 'planning-feedback:v1:execute', 'planning-feedback:v1:stage', 'planning-feedback:v1:adopt'])
  for (const [, , session] of invoke.mock.calls) expect(session).toEqual(SESSION)
}

describe('setup feedback acknowledged saved baseline', () => {
  it.each(FIELDS)('publishes only committed %s and leaves a clean setup clean', async field => {
    await beginAdoption(field)
    await acknowledge()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith({ [field]: CANDIDATE_TEXT }, SESSION, 'none'))
    expect(config()).toEqual({ ...CONFIG, [field]: CANDIDATE_TEXT })
    expect(committed).toEqual(config())
    expect(dirty()).toBe(false)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expectOnlyFeedbackCalls()
  })

  it('preserves other dirty fields and discards them to the adopted saved baseline', async () => {
    useProjectStore.getState().updateNovelConfig({ referenceWorks: 'New unsaved references' }, SESSION)
    await beginAdoption()
    await acknowledge()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(config()).toEqual({ ...CONFIG, coreOutline: CANDIDATE_TEXT, referenceWorks: 'New unsaved references' })
    expect(dirty()).toBe(true)
    act(() => useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION))
    expect(config()).toEqual({ ...CONFIG, coreOutline: CANDIDATE_TEXT })
    expect(dirty()).toBe(false)
    expectOnlyFeedbackCalls()
  })

  it.each(['A newer author outline', '', '   '] as const)('keeps newer same-field input %j while advancing discard to C1', async newer => {
    await beginAdoption()
    act(() => useProjectStore.getState().updateNovelConfig({ coreOutline: newer }, SESSION))
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    await acknowledge()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith({ coreOutline: CANDIDATE_TEXT }, SESSION, 'current'))
    expect(config().coreOutline).toBe(newer)
    expect(committed.coreOutline).toBe(CANDIDATE_TEXT)
    expect(dirty()).toBe(true)
    act(() => useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION))
    expect(config().coreOutline).toBe(CANDIDATE_TEXT)
    expect(dirty()).toBe(false)
    expectOnlyFeedbackCalls()
  })

  it('preserves an optional field cleared to undefined while adoption is pending', async () => {
    await beginAdoption('writingStyle')
    act(() => useProjectStore.getState().updateNovelConfig({ writingStyle: undefined }, SESSION))
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    await acknowledge()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith({ writingStyle: CANDIDATE_TEXT }, SESSION, 'current'))
    expect(config().writingStyle).toBeUndefined()
    expect(dirty()).toBe(true)
    act(() => useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION))
    expect(config().writingStyle).toBe(CANDIDATE_TEXT)
    expect(dirty()).toBe(false)
    expectOnlyFeedbackCalls()
  })

  it.each(['capture', 'begin', 'stage'] as const)('never publishes after %s fails', async phase => {
    failureAt = phase
    if (phase === 'capture') {
      await act(async () => root.render(<StageSetup projectKey={SESSION.projectPath} />))
      await click('Revise \u201cCore outline\u201d with feedback')
      await vi.waitFor(() => expect(host.querySelector('.pf-dialog')).not.toBeNull())
    } else {
      await openFeedback()
      await generate()
    }
    expect(publish).not.toHaveBeenCalled()
    expect(config()).toEqual(CONFIG)
    expect(committed).toEqual(CONFIG)
    expect(dirty()).toBe(false)
    expect(channels()).not.toContain('planning-feedback:v1:adopt')
    expect(channels().every(channel => channel.startsWith('planning-feedback:v1:'))).toBe(true)
  })

  it('never publishes after the adoption commit is rejected', async () => {
    await beginAdoption()
    await act(async () => { adoption.reject(new Error('PLANNING_FEEDBACK_SOURCE_CONFLICT')); await Promise.resolve() })
    await vi.waitFor(() => expect(button('Adopt this candidate').disabled).toBe(false))
    expect(publish).not.toHaveBeenCalled()
    expect(config()).toEqual(CONFIG)
    expect(committed).toEqual(CONFIG)
    expect(dirty()).toBe(false)
    expectOnlyFeedbackCalls()
  })

  it('does not publish a committed old-instance ACK over a later manual save or close the reopened dialog', async () => {
    commitBeforeAck = true
    await beginAdoption()
    expect(committed.coreOutline).toBe(CANDIDATE_TEXT)
    const receipt = committedReceipt
    expect(receipt).toMatchObject({ text: CANDIDATE_TEXT, idempotencyKey: expect.any(String) })
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    const manual = 'Manually saved after C1'
    act(() => useProjectStore.getState().updateNovelConfig({ coreOutline: manual }, SESSION))
    let saved = false
    await act(async () => { saved = await useProjectStore.getState().saveProject(SESSION) })
    expect(saved).toBe(true)
    expect(committed.coreOutline).toBe(manual)
    expect(committedReceipt).toEqual(receipt)
    expect(dirty()).toBe(false)
    await openFeedback()
    expect(capturedBase).toMatchObject({ baseId: 'feedback-base-2', value: manual })
    const reopenedDialog = host.querySelector('[role="dialog"]')
    expect(reopenedDialog).not.toBeNull()
    await acknowledge()
    expect(publish).not.toHaveBeenCalled()
    expect(committedReceipt).toEqual(receipt)
    expect(config().coreOutline).toBe(manual)
    expect(committed.coreOutline).toBe(manual)
    expect(dirty()).toBe(false)
    expect(host.querySelector('[role="dialog"]')).toBe(reopenedDialog)
    act(() => useProjectStore.getState().updateNovelConfig({ coreOutline: 'New unsaved edit' }, SESSION))
    expect(dirty()).toBe(true)
    act(() => useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION))
    expect(config().coreOutline).toBe(manual)
    expect(dirty()).toBe(false)
    expect(channels()).toEqual(['planning-feedback:v1:capture', 'planning-feedback:v1:read-history',
      'planning-feedback:v1:begin', 'planning-feedback:v1:execute', 'planning-feedback:v1:stage', 'planning-feedback:v1:adopt',
      'project:save', 'planning-feedback:v1:capture', 'planning-feedback:v1:read-history'])
  })

  it('does not let a committed old-instance ACK roll back a newer dialog adoption', async () => {
    commitBeforeAck = true
    await beginAdoption()
    const firstReceipt = committedReceipt
    expect(firstReceipt).toMatchObject({ text: CANDIDATE_TEXT, idempotencyKey: expect.any(String) })
    expect(committed.coreOutline).toBe(CANDIDATE_TEXT)
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    act(() => useProjectStore.getState().updateNovelConfig({ coreOutline: CANDIDATE_TEXT }, SESSION))
    let saved = false
    await act(async () => { saved = await useProjectStore.getState().saveProject(SESSION) })
    expect(saved).toBe(true)
    expect(config().coreOutline).toBe(CANDIDATE_TEXT)
    expect(committed.coreOutline).toBe(CANDIDATE_TEXT)
    expect(dirty()).toBe(false)
    const secondText = 'A later author-approved revision.'
    candidateText = secondText
    await openFeedback()
    expect(capturedBase).toMatchObject({ baseId: 'feedback-base-2', value: CANDIDATE_TEXT })
    await generate()
    await vi.waitFor(() => expect(button('Adopt this candidate').disabled).toBe(false))
    acknowledgeNextAdoption = true
    await click('Adopt this candidate')
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith({ coreOutline: secondText }, SESSION, 'none'))
    expect(committed.coreOutline).toBe(secondText)
    expect(config().coreOutline).toBe(secondText)
    expect(dirty()).toBe(false)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'planning-feedback:v1:adopt')).toHaveLength(2)

    await acknowledge()
    expect(committedReceipt).toEqual(firstReceipt)
    expect(committed.coreOutline).toBe(secondText)
    expect(config().coreOutline).toBe(secondText)
    expect(publish).toHaveBeenCalledTimes(1)
    act(() => useProjectStore.getState().updateNovelConfig({ coreOutline: 'New unsaved edit' }, SESSION))
    act(() => useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION))
    expect(config().coreOutline).toBe(secondText)
    expect(dirty()).toBe(false)
  })

  it.each([OTHER, REOPENED])('ignores a late adoption ACK after session $leaseId becomes current', async nextSession => {
    await beginAdoption()
    act(() => {
      setActiveProjectSessionContext(nextSession)
      useProjectStore.setState({ currentProject: project(nextSession, { ...CONFIG, coreOutline: 'Current session outline' }) })
    })
    await acknowledge()
    expect(publish).not.toHaveBeenCalled()
    expect(config().coreOutline).toBe('Current session outline')
    expect(useProjectStore.getState().currentProject?.sessionLease).toBe(nextSession.leaseId)
    expect(dirty()).toBe(false)
    expectOnlyFeedbackCalls()
  })
})
