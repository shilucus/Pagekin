import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { PlanningFeedbackDialog, type PlanningFeedbackAdoptionContext, type PlanningFeedbackDialogProps } from '../PlanningFeedbackDialog'
import type { PlanningFeedbackClient } from '../../../../services/planning-feedback-client'
import type { PlanningFeedbackFieldBase } from '../../../../shared/planning-feedback-ipc'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import { PLANNING_FEEDBACK_CORE_COLUMNS, planningFeedbackCoreSnapshot,
  type AdoptPlanningFeedbackCandidate, type PlanningFeedbackAdoption, type PlanningFeedbackCandidate } from '../../../../shared/planning-feedback'
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
let onAdopted: ReturnType<typeof vi.fn<(text: string, context: PlanningFeedbackAdoptionContext) => void>>
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
  onAdopted = vi.fn<(text: string, context: PlanningFeedbackAdoptionContext) => void>()
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
  vi.unstubAllGlobals()
})

async function renderDialog(overrides: Partial<PlanningFeedbackDialogProps> = {}) {
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
      {...overrides}
    />,
  ))
}

async function clickButton(name: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

async function beginAdoption() {
  await renderDialog()
  await clickButton('Adopt this candidate')
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
    expect(onAdopted).toHaveBeenCalledExactlyOnceWith('adopted text', {
      projectSession: session, baseTextAtAdoption: 'original',
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })

  it('passes the click-time base and original frozen session after props change during adoption', async () => {
    await beginAdoption()
    await renderDialog({ baseText: 'newer local buffer', projectSession: reopened })
    await finishAdoption()
    expect(onAdopted).toHaveBeenCalledExactlyOnceWith('adopted text', {
      projectSession: session, baseTextAtAdoption: 'original',
    })
  })

  it('isolates frozen identity, request key and adoption context from a caller object mutated during await', async () => {
    const callerSession = { ...session, extra: 'not part of session identity' }
    let rejectFirst!: (reason: Error) => void
    adopt.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { completeAdoption = resolve; rejectFirst = reject }))
      .mockResolvedValueOnce(undefined)
    await renderDialog({ projectSession: callerSession })
    await clickButton('Adopt this candidate')
    const first = adopt.mock.calls[0][0] as AdoptPlanningFeedbackCandidate

    Object.assign(callerSession, other)
    await renderDialog({ projectSession: callerSession })
    await act(async () => { rejectFirst(new Error('SYNTHETIC_LOST_ACK')); await Promise.resolve() })
    expect(onAdopted).not.toHaveBeenCalled()
    expect(adopt).toHaveBeenCalledTimes(1)
    await clickButton('Adopt this candidate')

    expect(adopt).toHaveBeenCalledTimes(2)
    expect(adopt.mock.calls[1][0]).toEqual(first)
    expect(onAdopted).toHaveBeenCalledExactlyOnceWith(candidate.text, {
      projectSession: session, baseTextAtAdoption: 'original',
    })
    const frozen = onAdopted.mock.calls[0][1].projectSession!
    expect(frozen).not.toBe(callerSession)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.keys(frozen).sort()).toEqual(['leaseId', 'projectId', 'projectPath'])
  })

  it.each(['success', 'failure'] as const)('does not let an old %s acknowledgement close or notify a reopened dialog', async outcome => {
    let rejectAdoption!: (reason: Error) => void
    adopt.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      completeAdoption = resolve
      rejectAdoption = reject
    }))
    function OpenableDialog() {
      const [open, setOpen] = useState(true)
      return <>
        <button onClick={() => setOpen(true)}>Reopen feedback</button>
        <PlanningFeedbackDialog
          isOpen={open} target="premise" label="Premise" baseText="original" projectSession={session}
          client={{ adopt } as unknown as PlanningFeedbackClient}
          initialBaseId="base-1" initialCapturedBaseText="original" initialCandidates={[candidate]}
          onAdopted={onAdopted} onClose={() => { onClose(); setOpen(false) }}
        />
      </>
    }
    await act(async () => root.render(<StrictMode><OpenableDialog /></StrictMode>))
    await clickButton('Adopt this candidate')
    expect(adopt).toHaveBeenCalledTimes(1)
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await clickButton('Reopen feedback')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      if (outcome === 'success') completeAdoption()
      else rejectAdoption(new Error('SYNTHETIC_CLOSED_ACK_FAILURE'))
      await Promise.resolve()
    })
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect([...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Adopt this candidate')?.disabled).toBe(false)
  })

  it('invalidates synchronously before close returns even if the host delays unmount and resolves the acknowledgement immediately', async () => {
    await renderDialog({ onClose: () => { onClose(); completeAdoption() } })
    await clickButton('Adopt this candidate')
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(onAdopted).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
})

describe('planning feedback adoption request identity', () => {
  it('runs capture/history effects and replays a lost acknowledgement only after another author click', async () => {
    const base: PlanningFeedbackFieldBase = {
      schemaVersion: 1, baseId: candidate.baseId, projectId: session.projectId, target: 'premise', scope: { kind: 'field', field: 'premise' },
      source: planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)
        .map(key => [key, key === 'totalChapters' || key === 'wordsPerChapter' ? 10 : 'original']))),
      sourceRevision: 1, sourceHash: 'a'.repeat(64), value: 'original', valueHash: 'b'.repeat(64), createdAt: 1,
      closedAt: null, closedByAdoptionId: null,
    }
    const receipts = new Map<string, PlanningFeedbackAdoption>()
    let formalText = 'original', effectCount = 0
    const invoke = vi.fn(async (channel: string, request: unknown) => {
      if (channel === 'planning-feedback:v1:capture') return base
      if (channel === 'planning-feedback:v1:read-history') return { base, candidates: [{ candidate, state: 'ready' }], adoptions: [] }
      if (channel !== 'planning-feedback:v1:adopt') throw new Error('UNEXPECTED_SYNTHETIC_CHANNEL')
      const input = request as AdoptPlanningFeedbackCandidate
      const previous = receipts.get(input.idempotencyKey)
      if (previous) return previous
      const receipt: PlanningFeedbackAdoption = {
        schemaVersion: 1, adoptionId: 'adoption-1', projectId: session.projectId, baseId: candidate.baseId,
        candidateId: input.candidateId, idempotencyKey: input.idempotencyKey, requestHash: 'c'.repeat(64),
        target: 'premise', adoptedScope: base.scope, decision: input.decision, decisionSource: 'author-action',
        text: input.text, textHash: 'd'.repeat(64), beforeValue: formalText, beforeHash: 'b'.repeat(64),
        sourceRevision: 1, committedRevision: 2, createdAt: 2,
      }
      receipts.set(input.idempotencyKey, receipt)
      formalText = input.text
      effectCount++
      throw new Error('SYNTHETIC_LOST_ACK')
    })
    vi.stubGlobal('aiNovelAPI', { invoke })
    await renderDialog({ client: undefined, initialBaseId: undefined, initialCapturedBaseText: undefined, initialCandidates: undefined })
    await vi.waitFor(() => expect(document.querySelector('[role="tablist"]')).not.toBeNull())
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v1:capture', 'planning-feedback:v1:read-history'])

    await clickButton('Adopt this candidate')
    expect(effectCount).toBe(1)
    expect(formalText).toBe(candidate.text)
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    const first = invoke.mock.calls.find(([channel]) => channel.endsWith(':adopt'))![1]
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(invoke.mock.calls.filter(([channel]) => channel.endsWith(':adopt'))).toHaveLength(1)

    await clickButton('Adopt this candidate')
    const adoptionCalls = invoke.mock.calls.filter(([channel]) => channel.endsWith(':adopt'))
    expect(adoptionCalls).toHaveLength(2)
    expect(adoptionCalls[1][1]).toEqual(first)
    expect(effectCount).toBe(1)
    expect(receipts.size).toBe(1)
    expect(onAdopted).toHaveBeenCalledExactlyOnceWith(candidate.text, { projectSession: session, baseTextAtAdoption: 'original' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses separate keys for changed decision, edited text and candidate, and retains earlier failed request keys', async () => {
    const nextCandidate = { ...candidate, candidateId: 'candidate-2', parentCandidateId: candidate.candidateId, text: 'second candidate' }
    adopt.mockRejectedValue(new Error('SYNTHETIC_NO_ACK'))
    await renderDialog({ initialCandidates: [candidate, nextCandidate] })
    await clickButton('Adopt this candidate')
    const original = adopt.mock.calls[0][0] as AdoptPlanningFeedbackCandidate

    await clickButton('Edit candidate')
    await clickButton('Adopt edited version')
    const edited = adopt.mock.calls[1][0] as AdoptPlanningFeedbackCandidate
    expect(edited).toMatchObject({ candidateId: original.candidateId, text: original.text, decision: 'edited' })
    expect(edited.idempotencyKey).not.toBe(original.idempotencyKey)

    const textarea = document.querySelector<HTMLTextAreaElement>('.pf-diff-box textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'author edited candidate')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickButton('Adopt edited version')
    const changed = adopt.mock.calls[2][0] as AdoptPlanningFeedbackCandidate
    expect(changed.text).toBe('author edited candidate')
    expect(new Set([original.idempotencyKey, edited.idempotencyKey, changed.idempotencyKey]).size).toBe(3)

    await clickButton('Round 2 (C2)')
    await clickButton('Adopt edited version')
    const next = adopt.mock.calls[3][0] as AdoptPlanningFeedbackCandidate
    expect(next).toMatchObject({ candidateId: nextCandidate.candidateId, text: nextCandidate.text, decision: 'edited' })
    expect(new Set([original.idempotencyKey, edited.idempotencyKey, changed.idempotencyKey, next.idempotencyKey]).size).toBe(4)

    await clickButton('Round 1 (C1)')
    await clickButton('Adopt edited version')
    expect(adopt.mock.calls[4][0]).toEqual(edited)
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not retain a failed request key across closed dialog instances', async () => {
    adopt.mockRejectedValue(new Error('SYNTHETIC_NO_ACK'))
    await renderDialog()
    await clickButton('Adopt this candidate')
    const first = adopt.mock.calls[0][0] as AdoptPlanningFeedbackCandidate
    await renderDialog({ isOpen: false })
    await renderDialog()
    await clickButton('Adopt this candidate')
    const second = adopt.mock.calls[1][0] as AdoptPlanningFeedbackCandidate
    expect(second).toMatchObject({ candidateId: first.candidateId, decision: first.decision, text: first.text })
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  })
})
