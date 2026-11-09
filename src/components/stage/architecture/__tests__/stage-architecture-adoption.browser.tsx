import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StageArchitecture from '../StageArchitecture'
import { createProjectArchTabId } from '../../../editor/arch-file-refresh-policy'
import { useEditorStore, type EditorTab } from '../../../../stores/editor-store'
import { useProjectStore } from '../../../../stores/project-store'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'

const mocks = vi.hoisted(() => ({
  adopt: vi.fn<() => Promise<void>>(),
  writeCoreContent: vi.fn(),
  loadStatus: vi.fn(),
  refreshRoster: vi.fn(),
}))

vi.mock('../../../../services/resource-protocol', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../services/resource-protocol')>(),
  writeCoreContent: mocks.writeCoreContent,
}))
vi.mock('../../../editor/use-architecture-overview', () => ({
  ARCH_FILES: [],
  useArchitectureOverview: () => ({
    loading: false,
    firstReadEnded: true,
    confirmed: { premise: true, characters: true, worldbuilding: true, synopsis: true },
    contents: { premise: 'original', worldbuilding: '', synopsis: '' },
    roster: { refresh: mocks.refreshRoster },
    loadStatus: mocks.loadStatus,
    generateDialog: {},
  }),
}))
vi.mock('../../use-stage-work', () => ({ refreshStageWork: vi.fn() }))
vi.mock('../ArchitectureGenerateDialog', () => ({ default: () => null }))
vi.mock('../ArchitectureSection', () => ({
  default: ({ sectionKey, onFeedback }: { sectionKey: string; onFeedback: (key: 'premise') => void }) => (
    sectionKey === 'premise' ? <button onClick={() => onFeedback('premise')}>open feedback</button> : null
  ),
}))
vi.mock('../../feedback/PlanningFeedbackDialog', () => ({
  PlanningFeedbackDialog: ({ isOpen, onAdopted }: { isOpen: boolean; onAdopted: (text: string) => void }) => (
    isOpen ? <button onClick={() => { void mocks.adopt().then(() => onAdopted('adopted')) }}>adopt</button> : null
  ),
}))

const session = { projectId: 'book-a', leaseId: 'lease-a', projectPath: 'C:/book-a' }
const otherSession = { projectId: 'book-b', leaseId: 'lease-b', projectPath: 'C:/book-b' }
const tabId = createProjectArchTabId(session.projectPath, 'ai-novel://core/premise')
let container: HTMLDivElement
let root: Root
let completeAdoption: () => void
const originalEditorState = useEditorStore.getState()
const originalProjectState = useProjectStore.getState()

function setSession(value: typeof session) {
  useProjectStore.setState({ currentProject: { id: value.projectId, path: value.projectPath, sessionLease: value.leaseId } as never })
  setActiveProjectSessionContext(value)
}

function setTab(tab?: Partial<EditorTab>) {
  useEditorStore.setState({ tabs: tab ? [{
    id: tabId, name: 'premise', type: 'arch-file', projectKey: session.projectPath,
    content: 'original', savedContent: 'original', dirty: false, ...tab,
  }] : [], activeTabId: tab ? tabId : null })
}

function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  button.click()
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setSession(session)
  setTab()
  mocks.adopt.mockReset().mockImplementation(() => new Promise<void>(resolve => { completeAdoption = resolve }))
  mocks.writeCoreContent.mockReset()
  mocks.loadStatus.mockReset()
  mocks.refreshRoster.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useEditorStore.setState(originalEditorState)
  useProjectStore.setState(originalProjectState)
  setActiveProjectSessionContext(null)
})

async function beginAdoption() {
  await act(async () => root.render(<StageArchitecture projectKey={session.projectPath} />))
  await act(async () => click('open feedback'))
  await act(async () => click('adopt'))
  expect(mocks.adopt).toHaveBeenCalledTimes(1)
}

async function finishAdoption() {
  await act(async () => { completeAdoption(); await Promise.resolve() })
  expect(mocks.writeCoreContent).not.toHaveBeenCalled()
}

describe('architecture feedback adoption', () => {
  it('refreshes a clean tab after the existing adoption succeeds', async () => {
    setTab({})
    await beginAdoption()
    await finishAdoption()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'adopted', savedContent: 'adopted', dirty: false })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)
  })

  it('preserves an existing dirty buffer', async () => {
    setTab({ content: 'existing edit', dirty: true })
    await beginAdoption()
    await finishAdoption()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'existing edit', savedContent: 'original', dirty: true })
  })

  it('preserves input made while adoption is pending', async () => {
    setTab({})
    await beginAdoption()
    act(() => useEditorStore.getState().updateTabContent(tabId, 'new edit'))
    await finishAdoption()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'new edit', savedContent: 'original', dirty: true })
  })

  it('does not refresh a tab after switching projects', async () => {
    setTab({})
    await beginAdoption()
    act(() => setSession(otherSession))
    await finishAdoption()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'original', savedContent: 'original', dirty: false })
    expect(mocks.loadStatus).not.toHaveBeenCalled()
  })

  it('refreshes the overview without creating a tab', async () => {
    await beginAdoption()
    await finishAdoption()
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)
  })
})
