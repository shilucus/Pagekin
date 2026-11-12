import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { ProjectData, ProjectSessionContext } from '../../../../shared/ipc-channels'
import { assertPlanningFeedbackRequest, type PlanningFeedbackFieldBase } from '../../../../shared/planning-feedback-ipc'
import { PLANNING_FEEDBACK_CORE_COLUMNS, planningFeedbackCoreSnapshot, type PlanningFeedbackCandidate } from '../../../../shared/planning-feedback'
import { getActiveProjectSessionContext, setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useCharacterStore } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { createProjectArchTabId } from '../../../editor/arch-file-refresh-policy'
import { cancelCloseTab, requestCloseTab } from '../../tab-close'
import StageWorkspace from '../../StageWorkspace'

const projection = vi.hoisted(() => ({ premise: '', loadStatus: vi.fn(), refreshRoster: vi.fn() }))
vi.mock('../../../editor/use-architecture-overview', () => ({
  ARCH_FILES: [],
  useArchitectureOverview: () => ({
    loading: false, firstReadEnded: true,
    confirmed: { premise: true, characters: true, worldbuilding: true, synopsis: true },
    archStatus: { premise: true, characters: false, worldbuilding: false, synopsis: false },
    contents: { premise: projection.premise, worldbuilding: '', synopsis: '' },
    worldBuilding: { candidate: null }, synopsis: { candidate: null },
    roster: { presentation: null, refresh: projection.refreshRoster },
    loadStatus: projection.loadStatus, generateDialog: {},
  }),
}))
vi.mock('../../../editor/LegacyRosterRecoveryPanel', () => ({ LegacyRosterRecoveryPanel: () => null }))
vi.mock('../ArchitectureGenerateDialog', () => ({ default: () => null }))
vi.mock('../../use-stage-work', async importOriginal => ({
  ...await importOriginal<typeof import('../../use-stage-work')>(),
  refreshStageWork: vi.fn(),
}))

const SESSION: ProjectSessionContext = { projectId: 'fictional-arch', leaseId: 'fictional-lease', projectPath: 'C:/fictional/arch-baseline' }
const URI = 'ai-novel://core/premise'
const TAB = createProjectArchTabId(SESSION.projectPath, URI)
const OVERVIEW = 'fictional-architecture-overview'
const F0 = 'The original premise.'
const U = 'The author has an unsaved premise.'
const C1 = 'The author adopts this revised premise.'
const PROJECT: ProjectData = {
  id: SESSION.projectId, sessionLease: SESSION.leaseId, path: SESSION.projectPath, name: 'Fictional book',
  novelConfig: { genre: 'Mystery', subGenre: '', targetAudience: 'All ages', totalChapters: 24, wordsPerChapter: 3000,
    coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    plotStructure: 'three_act', narrativePOV: 'third_limited', writingLanguage: 'en-US' },
  characterStates: '', createdAt: '', updatedAt: '',
}

function snapshot<T>(store: StoreApi<T>) {
  const state = store.getState()
  return () => store.setState(state, true)
}
function run(baseId: string) {
  return { handle: { projectId: SESSION.projectId, epoch: SESSION.leaseId, rootActionId: `root-${baseId}`, runId: `run-${baseId}` },
    operation: 'planning-feedback', status: 'running', nonReplayable: false,
    budget: { maxAttempts: 2, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 50, deadlineAt: 1000 }, artifacts: [] }
}
function makeBase(value: string, baseId: string): PlanningFeedbackFieldBase {
  const source = planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)
    .map(key => [key, key === 'premise' ? value : key === 'totalChapters' || key === 'wordsPerChapter' ? 24 : ''])))
  return { schemaVersion: 1, baseId, projectId: SESSION.projectId, target: 'premise', scope: { kind: 'field', field: 'premise' },
    source, sourceRevision: 1, sourceHash: 'a'.repeat(64), value, valueHash: 'b'.repeat(64), createdAt: 1,
    closedAt: null, closedByAdoptionId: null }
}
function makeCandidate(base: PlanningFeedbackFieldBase): PlanningFeedbackCandidate {
  return { schemaVersion: 1, candidateId: `candidate-${base.baseId}`, projectId: SESSION.projectId, baseId: base.baseId,
    parentCandidateId: null, generationParentHash: base.valueHash, text: C1, textHash: 'c'.repeat(64),
    feedback: 'Clarify the premise', constraints: [], createdAt: 2,
    origin: { kind: 'generated', runId: run(base.baseId).handle.runId, attemptId: 'fictional-attempt', artifactId: 'fictional-artifact',
      modelLeaseRevision: 'd'.repeat(64), skillSnapshotHash: 'e'.repeat(64), contextSnapshotHash: 'f'.repeat(64) } }
}

let host: HTMLDivElement
let root: Root
let restores: (() => void)[]
let originalSession: ProjectSessionContext | null
let originalAPI: PropertyDescriptor | undefined
let formal: string
let captured: PlanningFeedbackFieldBase
let captureCount: number
let finishAck: (receipt: unknown) => void
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  restores = [snapshot(useCharacterStore), snapshot(useEditorStore), snapshot(useLayoutStore), snapshot(useLLMStore),
    snapshot(useLocaleStore), snapshot(useStageStore), snapshot(useProjectStore), snapshot(useWorkflowStore)]
  originalSession = getActiveProjectSessionContext()
  originalAPI = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
  formal = F0
  captureCount = 0
  projection.premise = F0
  projection.loadStatus.mockReset()
  projection.refreshRoster.mockReset()
  setActiveProjectSessionContext(SESSION)
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({ currentProject: PROJECT })
  useLayoutStore.setState({ settingsOpen: false })
  useStageStore.setState({ sheet: null, closingTabId: null })
  useWorkflowStore.setState({ activeRuns: [] })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: 'fictional-model', stageModelIds: {} })
  useEditorStore.setState({ tabs: [
    { id: TAB, name: 'Premise', type: 'arch-file', projectKey: SESSION.projectPath, filePath: URI, content: F0, savedContent: F0, dirty: false },
    { id: OVERVIEW, name: 'Architecture', type: 'world-building', projectKey: SESSION.projectPath },
  ], activeTabId: TAB, draftLedgers: {} })
  const ack = new Promise<unknown>(resolve => { finishAck = resolve })
  invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    expect(args.at(-1)).toEqual(SESSION)
    const request = args[0]
    switch (channel) {
      case 'planning-feedback:v1:capture':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.target).toBe('premise')
        captured = makeBase(formal, `base-${++captureCount}`)
        return captured
      case 'planning-feedback:v1:read-history':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.baseId).toBe(captured.baseId)
        return { base: captured, candidates: [], adoptions: [] }
      case 'planning-feedback:v1:begin':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.input.baseId).toBe(captured.baseId)
        return run(captured.baseId)
      case 'planning-feedback:v1:execute':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.handle).toEqual(run(captured.baseId).handle)
        return { run: { ...run(captured.baseId), status: 'completed' }, outcome: { status: 'completed', content: C1,
          finishReason: 'stop', receipt: { finishReason: 'stop', visibleArtifact: { artifactId: 'fictional-artifact',
            attemptId: 'fictional-attempt', revision: 1, textHash: 'c'.repeat(64) } } } }
      case 'planning-feedback:v1:stage':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.baseId).toBe(captured.baseId)
        expect(request.runId).toBe(run(captured.baseId).handle.runId)
        return makeCandidate(captured)
      case 'planning-feedback:v1:adopt':
        assertPlanningFeedbackRequest(channel, request)
        expect(request.candidateId).toBe(`candidate-${captured.baseId}`)
        expect(formal).toBe(captured.value)
        expect(request.text).toBe(C1)
        formal = request.text
        return ack
      default: throw new Error(`Unexpected fictional bridge call: ${channel}`)
    }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}) } })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  useEditorStore.getState().closeTab(TAB)
  host.remove()
  vi.restoreAllMocks()
  for (const restore of restores) restore()
  setActiveProjectSessionContext(originalSession)
  if (originalAPI) Object.defineProperty(window, 'aiNovelAPI', originalAPI)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

function tab() { return useEditorStore.getState().tabs.find(item => item.id === TAB)! }
function editor() { return EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)! }
async function edit(value: string) {
  const view = editor()
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }))
}
async function click(name: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name)
  expect(button, name).toBeDefined()
  await act(async () => button!.click())
}

describe('architecture feedback editor saved baseline', () => {
  it('preserves a dirty unmounted document and uses C1 for later editing and close protection', async () => {
    await act(async () => root.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).not.toBeNull())
    await edit(U)
    expect(tab()).toMatchObject({ content: U, savedContent: F0, dirty: true })
    const revision = tab().contentRevision

    await act(async () => useEditorStore.getState().setActiveTab(OVERVIEW))
    expect(host.querySelector('.cm-editor')).toBeNull()
    const premise = host.querySelector('[data-section="premise"]')!
    await click('Revise', premise)
    await vi.waitFor(() => expect(host.querySelector('.pf-textarea')).not.toBeNull())
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'planning-feedback:v1:read-history')).toBe(true))
    expect(captured).toMatchObject({ baseId: 'base-1', value: F0 })
    const feedback = host.querySelector<HTMLTextAreaElement>('.pf-textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(feedback, 'Clarify the premise')
      feedback.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Generate candidate')
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Adopt this candidate' && !button.disabled)).toBe(true))
    await click('Adopt this candidate')
    expect(formal).toBe(C1)
    expect(tab()).toMatchObject({ content: U, savedContent: F0, dirty: true, contentRevision: revision })
    await act(async () => { finishAck({ adoptionId: 'fictional-adoption' }); await Promise.resolve() })
    await vi.waitFor(() => expect(tab()).toMatchObject({ content: U, savedContent: C1, dirty: true, contentRevision: revision }))
    expect(host.querySelector('.cm-editor')).toBeNull()

    await act(async () => useEditorStore.getState().setActiveTab(TAB))
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).not.toBeNull())
    expect(editor().state.doc.toString()).toBe(U)
    await edit(F0)
    expect(tab()).toMatchObject({ content: F0, savedContent: C1, dirty: true })
    act(() => requestCloseTab(TAB))
    expect(useStageStore.getState().closingTabId).toBe(TAB)
    await vi.waitFor(() => expect(document.body.textContent).toContain('Discard unsaved changes?'))
    expect(tab()).toBeDefined()
    act(() => cancelCloseTab())
    await edit(C1)
    expect(tab()).toMatchObject({ content: C1, savedContent: C1, dirty: false })
    expect(formal).toBe(C1)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v1:capture', 'planning-feedback:v1:read-history',
      'planning-feedback:v1:begin', 'planning-feedback:v1:execute', 'planning-feedback:v1:stage', 'planning-feedback:v1:adopt'])
  })
})
