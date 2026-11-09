import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanningFeedbackDialog } from '../PlanningFeedbackDialog'
import type { PlanningFeedbackClient } from '../../../../services/planning-feedback-client'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import type { PlanningFeedbackCandidate } from '../../../../shared/planning-feedback'
import { getActiveProjectSessionContext, setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../../../ui/Toast', () => ({ toast: mocks }))

const session: ProjectSessionContext = { projectId: 'book-a', leaseId: 'lease-1', projectPath: 'C:/book-a' }
const reopened: ProjectSessionContext = { ...session, leaseId: 'lease-2' }
const other: ProjectSessionContext = { projectId: 'book-b', leaseId: 'lease-b', projectPath: 'C:/book-b' }
const candidate: PlanningFeedbackCandidate = {
  schemaVersion: 1,
  candidateId: 'candidate-1',
  projectId: session.projectId,
  baseId: 'base-1',
  parentCandidateId: null,
  generationParentHash: 'parent-hash',
  text: 'adopted text',
  textHash: 'candidate-hash',
  feedback: 'feedback',
  constraints: [],
  origin: {
    kind: 'generated', runId: 'run-1', attemptId: 'attempt-1', artifactId: 'artifact-1',
    modelLeaseRevision: 'model-1', skillSnapshotHash: 'skill-hash', contextSnapshotHash: 'context-hash',
  },
  createdAt: 1,
}

let container: HTMLDivElement
let root: Root
let completeAdoption: () => void
let adopt: ReturnType<typeof vi.fn>
let onAdopted: ReturnType<typeof vi.fn<(text: string) => void>>
let onClose: ReturnType<typeof vi.fn<() => void>>
const originalLocale = useLocaleStore.getState()
let originalSession: ProjectSessionContext | null

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  originalSession = getActiveProjectSessionContext()
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'en-US' })
  mocks.success.mockReset()
  mocks.error.mockReset()
  mocks.info.mockReset()
  adopt = vi.fn(() => new Promise<void>(resolve => { completeAdoption = resolve }))
  onAdopted = vi.fn<(text: string) => void>()
  onClose = vi.fn<() => void>()
  container = document.createElement('div')
  container.className = 'paper-ink'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setActiveProjectSessionContext(originalSession)
  useLocaleStore.setState(originalLocale)
})

async function beginAdoption() {
  await act(async () => root.render(
    <PlanningFeedbackDialog
      isOpen
      target="premise"
      label="Premise"
      baseText="original"
      projectSession={session}
      client={{ adopt } as unknown as PlanningFeedbackClient}
      initialBaseId="base-1"
      initialCapturedBaseText="original"
      initialCandidates={[candidate]}
      onAdopted={onAdopted}
      onClose={onClose}
    />,
  ))
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('Adopt this candidate'))
  expect(button).toBeDefined()
  await act(async () => button!.click())
  expect(adopt).toHaveBeenCalledTimes(1)
}

async function finishAdoption() {
  await act(async () => { completeAdoption(); await Promise.resolve() })
  expect(adopt).toHaveBeenCalledTimes(1)
}

describe('planning feedback adoption session', () => {
  it('suppresses a successful reply after reopening the same project with a new lease', async () => {
    await beginAdoption()
    setActiveProjectSessionContext(reopened)
    await finishAdoption()
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('suppresses a successful reply after switching A to B and reopening A', async () => {
    await beginAdoption()
    setActiveProjectSessionContext(other)
    setActiveProjectSessionContext(reopened)
    await finishAdoption()
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('delivers a successful reply while the original session remains current', async () => {
    await beginAdoption()
    await finishAdoption()
    expect(onAdopted).toHaveBeenCalledExactlyOnceWith('adopted text')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })
})
