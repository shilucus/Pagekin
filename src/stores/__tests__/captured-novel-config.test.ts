import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../components/ui/AlertDialog', () => ({ alertError: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invoke,
  invokeWithProjectSession: (_session: unknown, channel: string, ...args: unknown[]) => invoke(channel, ...args),
} }))

const SESSION: ProjectSessionContext = {
  projectId: 'captured-config-a', leaseId: 'captured-lease-a', projectPath: 'C:/fictional/captured-config-a',
}
function project(): ProjectData {
  return { id: SESSION.projectId, sessionLease: SESSION.leaseId, path: SESSION.projectPath, name: 'Fictional capture',
    novelConfig: { genre: 'Mystery', subGenre: '', targetAudience: 'Adults', totalChapters: 20, wordsPerChapter: 3000,
      plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: 'F0', worldSetting: 'World F0', goldenFinger: '', protagonistProfile: '', globalGuidance: '' },
    characterStates: '', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
const handle = { projectId: SESSION.projectId, epoch: SESSION.leaseId, rootActionId: 'capture-root', runId: 'capture-run' }
let restoreProject: ReturnType<typeof useProjectStore.getState>
let restoreEditor: ReturnType<typeof useEditorStore.getState>
beforeEach(() => {
  restoreProject = useProjectStore.getState()
  restoreEditor = useEditorStore.getState()
  invoke.mockReset()
  useProjectStore.setState({ currentProject: project() })
  useEditorStore.setState({ tabs: [{ id: 'config', name: 'Setup', type: 'config', projectKey: SESSION.projectPath }], draftLedgers: {} })
})
afterEach(() => {
  vi.useRealTimers()
  useProjectStore.setState(restoreProject, true)
  useEditorStore.setState(restoreEditor, true)
})
function config() { return useProjectStore.getState().currentProject!.novelConfig }
function dirty() { return useEditorStore.getState().tabs.some(tab => tab.type === 'config' && tab.dirty) }
function token() {
  const captured = useProjectStore.getState().captureNovelConfigRead(SESSION)
  expect(captured).not.toBeNull()
  return captured!
}

describe('captured formal config publication', () => {
  it('freezes only the complete session and rejects a different session', () => {
    const caller = { ...SESSION }
    const captured = useProjectStore.getState().captureNovelConfigRead(caller)!
    caller.leaseId = 'mutated'
    expect(captured.projectSession).toEqual(SESSION)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.projectSession)).toBe(true)
    expect(useProjectStore.getState().captureNovelConfigRead(caller)).toBeNull()
  })

  it('projects one formal field cleanly without a writer or changing unrelated fields', () => {
    const original = config()
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'C1' }, token())).toBe(true)
    expect(config()).toEqual({ ...original, coreOutline: 'C1' })
    expect(dirty()).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps a same-field edit and rebases discard to the captured formal value', () => {
    const captured = token()
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'Unsaved U', worldSetting: 'Unsaved world' }, SESSION)
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'C1' }, captured)).toBe(true)
    expect(config()).toMatchObject({ coreOutline: 'Unsaved U', worldSetting: 'Unsaved world' })
    expect(dirty()).toBe(true)
    useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION)
    expect(config()).toMatchObject({ coreOutline: 'C1', worldSetting: 'World F0' })
    expect(dirty()).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps unrelated edits while updating a clean target', () => {
    const captured = token()
    useProjectStore.getState().updateNovelConfig({ worldSetting: 'Unsaved world' }, SESSION)
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'C1' }, captured)).toBe(true)
    expect(config()).toMatchObject({ coreOutline: 'C1', worldSetting: 'Unsaved world' })
    expect(dirty()).toBe(true)
  })

  it('does not notify or settle a ledger when the captured formal baseline already matches', () => {
    const projectBefore = useProjectStore.getState().currentProject
    const ledgerBefore = useEditorStore.getState().draftLedgers
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'F0' }, token())).toBe(true)
    expect(useProjectStore.getState().currentProject).toBe(projectBefore)
    expect(useEditorStore.getState().draftLedgers).toBe(ledgerBefore)
  })

  it.each(['C2', 'F0'])('rejects a read after a newer formal publication of %s', newer => {
    const captured = token()
    useProjectStore.getState().publishSavedNovelConfig({ coreOutline: newer }, SESSION, 'none')
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    expect(config().coreOutline).toBe(newer)
    expect(dirty()).toBe(false)
  })

  it('rejects a read after author discard without changing its saved baseline', () => {
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'Unsaved U' }, SESSION)
    const captured = token()
    useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION)
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    expect(config().coreOutline).toBe('F0')
    expect(dirty()).toBe(false)
  })

  it.each(['other-book', 'new-lease'])('rejects an old read after %s becomes current', change => {
    const captured = token()
    useProjectStore.setState({ currentProject: { ...project(), id: change === 'other-book' ? 'book-b' : SESSION.projectId,
      sessionLease: 'new-lease', novelConfig: { ...config(), coreOutline: 'New session' } } })
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    expect(config().coreOutline).toBe('New session')
  })

  it('invalidates pre-save reads even for an identical-value save and blocks in-flight reads', async () => {
    const captured = token()
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)
    const saving = useProjectStore.getState().saveProject(SESSION)
    try {
      expect(useProjectStore.getState().captureNovelConfigRead(SESSION)).toBeNull()
      expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    } finally { pending.resolve({ success: true }) }
    await expect(saving).resolves.toBe(true)
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    expect(config().coreOutline).toBe('F0')
    expect(dirty()).toBe(false)
    token()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each(['false-receipt', 'rejection'])('drains the save barrier after %s without reviving an old read', async outcome => {
    const captured = token()
    if (outcome === 'false-receipt') invoke.mockResolvedValueOnce({ success: false })
    else invoke.mockRejectedValueOnce(new Error('Fictional save rejection'))
    await expect(useProjectStore.getState().saveProject(SESSION)).resolves.toBe(false)
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    token()
    expect(config().coreOutline).toBe('F0')
  })

  it('keeps the barrier until all already-started saves have settled', async () => {
    const first = deferred<{ success: boolean }>()
    const second = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = useProjectStore.getState().saveProject(SESSION)
    const b = useProjectStore.getState().saveProject(SESSION)
    try {
      first.resolve({ success: true })
      await a
      expect(useProjectStore.getState().captureNovelConfigRead(SESSION)).toBeNull()
    } finally { second.resolve({ success: true }) }
    await b
    token()
  })

  it('keeps an IPC save fenced after renderer timeout until the actual request settles', async () => {
    vi.useFakeTimers()
    const captured = token()
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)
    const saving = useProjectStore.getState().saveProject(SESSION)
    try {
      await vi.advanceTimersByTimeAsync(15_001)
      await expect(saving).resolves.toBe(false)
      expect(useProjectStore.getState().captureNovelConfigRead(SESSION)).toBeNull()
      expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    } finally {
      pending.resolve({ success: true })
      await pending.promise
    }
    token()
    expect(config().coreOutline).toBe('F0')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps mixed save/generated writers fenced until both physically settle', async () => {
    const saved = deferred<{ success: boolean }>()
    const generated = deferred<void>()
    invoke.mockReturnValueOnce(saved.promise)
    const saving = useProjectStore.getState().saveProject(SESSION)
    const generating = useProjectStore.getState().commitGeneratedNovelConfig({ coreOutline: 'Generated' }, config(), SESSION, handle,
      () => generated.promise)
    try {
      generated.resolve()
      await generating
      expect(useProjectStore.getState().captureNovelConfigRead(SESSION)).toBeNull()
    } finally { saved.resolve({ success: true }) }
    await saving
    token()
  })

  it.each(['other-book', 'new-lease'])('does not let an old writer block or invalidate a read in %s', async change => {
    const captured = token()
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)
    const saving = useProjectStore.getState().saveProject(SESSION)
    const nextSession = { ...SESSION, projectId: change === 'other-book' ? 'book-b' : SESSION.projectId,
      projectPath: change === 'other-book' ? 'C:/fictional/book-b' : SESSION.projectPath, leaseId: 'new-lease' }
    useProjectStore.setState({ currentProject: { ...project(), id: nextSession.projectId, path: nextSession.projectPath, sessionLease: nextSession.leaseId,
      novelConfig: { ...config(), coreOutline: 'New session' } } })
    const nextRead = useProjectStore.getState().captureNovelConfigRead(nextSession)
    try {
      expect(nextRead).not.toBeNull()
      expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    } finally { pending.resolve({ success: true }) }
    await expect(saving).resolves.toBe(false)
    expect(useProjectStore.getState().captureNovelConfigRead(nextSession)).not.toBeNull()
    expect(config().coreOutline).toBe('New session')
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Current formal' }, nextRead!)).toBe(true)
    expect(config().coreOutline).toBe('Current formal')
    expect(dirty()).toBe(false)
  })

  it.each(['success', 'failure'])('fences and drains the guarded generated writer on %s', async outcome => {
    const captured = token()
    const expected = config()
    const pending = deferred<void>()
    const saving = useProjectStore.getState().commitGeneratedNovelConfig({ coreOutline: 'Generated' }, expected, SESSION, handle,
      () => pending.promise)
    const checked = outcome === 'success' ? expect(saving).resolves.toBe(true)
      : expect(saving).rejects.toThrow('Fictional generated rejection')
    try {
      expect(useProjectStore.getState().captureNovelConfigRead(SESSION)).toBeNull()
      expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    } finally {
      if (outcome === 'success') pending.resolve()
      else pending.reject(new Error('Fictional generated rejection'))
    }
    await checked
    expect(useProjectStore.getState().publishCapturedNovelConfig({ coreOutline: 'Old capture' }, captured)).toBe(false)
    expect(config().coreOutline).toBe(outcome === 'success' ? 'Generated' : 'F0')
    token()
  })

  it('drains a generated writer while keeping newer author edits and the committed discard baseline', async () => {
    const expected = config()
    const pending = deferred<void>()
    const saving = useProjectStore.getState().commitGeneratedNovelConfig({ coreOutline: 'Generated' }, expected, SESSION, handle,
      () => pending.promise)
    const checked = expect(saving).rejects.toThrow('GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'Newer U' }, SESSION)
    pending.resolve()
    await checked
    expect(config().coreOutline).toBe('Newer U')
    expect(dirty()).toBe(true)
    token()
    useProjectStore.getState().discardNovelConfigDraft(SESSION.projectPath, SESSION)
    expect(config().coreOutline).toBe('Generated')
    expect(dirty()).toBe(false)
  })
})
