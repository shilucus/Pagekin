import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalEventBus } from '../../shared/event-bus'
import { useCharacterStore } from '../../stores/character-store'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import {
  disableProjectBindingsPreservingDrafts,
  disposeProjectService,
  initProjectService,
  onProjectClosed,
  onProjectOpened,
} from '../project-service'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
}))

vi.mock('../ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    invokeWithProjectSession: (_session: unknown, channel: string, ...args: unknown[]) => mocks.invoke(channel, ...args),
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'
const projectBSession = { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath }
const testUnsubscribes: Array<() => void> = []

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const projectEventFailures = [
  {
    name: 'WORKFLOW_COMPLETE',
    start: (session: typeof projectBSession, fail: () => Promise<void>) => {
      vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockImplementation(fail)
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: 'novel_import', projectPath: session.projectPath, projectSession: session, runId: 'run-1',
      })
    },
  },
  {
    name: 'FINALIZE_COMPLETE',
    start: (session: typeof projectBSession, fail: () => Promise<void>) => {
      vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockImplementation(fail)
      vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
      vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
      globalEventBus.emit('FINALIZE_COMPLETE', {
        tabId: 'unrelated-tab', chapterNumber: 1, chapterTitle: '第一章',
        projectPath: session.projectPath, projectSession: session, draftId: 1,
        finalizationId: 'finalization-1', contentHash: 'hash-1', contentRevision: 1,
        snapshotContent: '冻结正文', publicationStatus: 'published',
      })
    },
  },
  {
    name: 'ARCH_POSTPROCESS_UPDATED',
    start: (session: typeof projectBSession, fail: () => Promise<void>) => {
      useWorkflowStore.setState({ activeRuns: [{ id: 'run-1', projectSession: session } as never] })
      vi.spyOn(useCharacterStore.getState(), 'load').mockImplementation(fail)
      globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', { projectPath: session.projectPath, projectSession: session, runId: 'run-1' })
    },
  },
  {
    name: 'CHARACTER_EXTRACT_FAILED',
    start: (session: typeof projectBSession, fail: () => Promise<void>) => {
      useWorkflowStore.setState({ activeRuns: [{ id: 'run-1', projectSession: session } as never] })
      vi.spyOn(useCharacterStore.getState(), 'load').mockImplementation(fail)
      globalEventBus.emit('CHARACTER_EXTRACT_FAILED', { projectPath: session.projectPath, projectSession: session, runId: 'run-1' })
    },
  },
  {
    name: 'REFRESH_RESOURCE',
    start: (session: typeof projectBSession, fail: () => Promise<void>) => {
      vi.spyOn(useCharacterStore.getState(), 'load').mockImplementation(fail)
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['characterCards'], projectPath: session.projectPath, projectSession: session })
    },
  },
] as const

beforeEach(() => {
  mocks.invoke.mockReset()
  useWorkflowStore.setState({ activeRuns: [] })
  useProjectStore.setState({
    currentProject: {
      id: 'B',
      name: 'B',
      path: projectBPath,
      sessionLease: 'lease-B',
      novelConfig: {},
    } as never,
  })
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    draftLedgers: {},
  })
})

afterEach(() => {
  for (const unsubscribe of testUnsubscribes.splice(0)) unsubscribe()
  disposeProjectService()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

function installDirtyEditorBuffer() {
  const dirtyTab = {
    id: 'dirty-tab', name: '未保存章节', type: 'chapter' as const, projectKey: projectBPath,
    content: '用户未保存正文', savedContent: '磁盘正文', dirty: true,
    chapterNumber: 1, draftStatus: 'draft' as const, projectSessionLease: 'lease-B',
  }
  useEditorStore.setState({ tabs: [dirtyTab], activeTabId: dirtyTab.id, draftLedgers: { config: '{"draft":"pending"}' } })
  return useEditorStore.getState()
}

describe('ProjectService REFRESH_RESOURCE project identity', () => {
  it('refreshes only a verified current-view workflow completion, not its original execution lease', async () => {
    const treeRefresh = vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    initProjectService()
    const payload = { type: 'novel_import', projectPath: projectBPath, runId: 'retained-reference' }
    globalEventBus.emit('WORKFLOW_COMPLETE', {
      ...payload, projectSession: { projectId: 'B', leaseId: 'lease-old', projectPath: projectBPath },
    })
    await Promise.resolve()
    expect(treeRefresh).not.toHaveBeenCalled()
    globalEventBus.emit('WORKFLOW_COMPLETE', {
      ...payload, projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
    })
    await vi.waitFor(() => expect(treeRefresh).toHaveBeenCalledOnce())
    expect(treeRefresh).toHaveBeenCalledWith(projectBPath, undefined, {
      projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
    })
  })

  it('ignores a delayed same-path refresh after the project lease was replaced', async () => {
    const characterLoad = vi.spyOn(useCharacterStore.getState(), 'load')
      .mockResolvedValue()
    const draftLoad = vi.spyOn(useDraftStore.getState(), 'loadAllDrafts')
      .mockResolvedValue()
    const treeRefresh = vi.spyOn(useProjectStore.getState(), 'refreshFileTree')
      .mockResolvedValue()
    initProjectService()

    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['all'],
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-old', projectPath: projectBPath },
    })
    await Promise.resolve()

    expect(characterLoad).not.toHaveBeenCalled()
    expect(draftLoad).not.toHaveBeenCalled()
    expect(treeRefresh).not.toHaveBeenCalled()

    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['all'],
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
    })
    await vi.waitFor(() => {
      expect(treeRefresh).toHaveBeenCalledWith(projectBPath, undefined, {
        projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
      })
    })
    expect(characterLoad).toHaveBeenCalledWith(projectBPath, {
      projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
    })
    expect(draftLoad).toHaveBeenCalledWith(projectBPath, {
      projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
    })
  })

  it('drops opening results and PROJECT_CHANGED after reopening the same path with a new lease', async () => {
    let resolveCharacterLoad: (() => void) | undefined
    let resolveDraftLoad: (() => void) | undefined
    vi.spyOn(useCharacterStore.getState(), 'load').mockImplementation(() => new Promise<void>((resolve) => {
      resolveCharacterLoad = resolve
    }))
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockImplementation(() => new Promise<void>((resolve) => {
      resolveDraftLoad = resolve
    }))
    const changed = vi.fn()
    const unsubscribe = globalEventBus.on('PROJECT_CHANGED', changed)
    const oldSession = { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath }

    const opening = onProjectOpened(oldSession)
    await vi.waitFor(() => {
      expect(useCharacterStore.getState().load).toHaveBeenCalledWith(projectBPath, oldSession)
      expect(useDraftStore.getState().loadAllDrafts).toHaveBeenCalledWith(projectBPath, oldSession)
    })

    useProjectStore.setState({
      currentProject: {
        id: 'B',
        name: 'B reopened',
        path: projectBPath,
        sessionLease: 'lease-B-reopened',
        novelConfig: {},
      } as never,
    })
    resolveCharacterLoad?.()
    resolveDraftLoad?.()

    await expect(opening).resolves.toEqual({ warnings: [] })
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('clears every editable binding when the renderer has no trustworthy project identity', async () => {
    useEditorStore.setState({
      tabs: [{
        id: 'orphan-tab',
        name: 'Orphan',
        type: 'outline',
        projectKey: projectAPath,
        dirty: true,
      }],
      activeTabId: 'orphan-tab',
    })
    const characterReset = vi.spyOn(useCharacterStore.getState(), 'reset')
    const draftReset = vi.spyOn(useDraftStore.getState(), 'reset')

    await onProjectClosed(null)

    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useEditorStore.getState().activeTabId).toBeNull()
    expect(characterReset).toHaveBeenCalledOnce()
    expect(draftReset).toHaveBeenCalledOnce()
  })

  it('preserves tabs and draft ledgers when bindings are disabled after a runtime failure', () => {
    useEditorStore.setState({
      tabs: [{
        id: 'dirty-tab',
        name: '未保存章节',
        type: 'chapter',
        projectKey: projectAPath,
        content: '未保存正文',
        dirty: true,
      }],
      activeTabId: 'dirty-tab',
      draftLedgers: { config: '{"version":1,"projects":[]}' },
    })

    disableProjectBindingsPreservingDrafts(null)

    expect(useEditorStore.getState()).toMatchObject({
      tabs: [expect.objectContaining({ id: 'dirty-tab', dirty: true })],
      activeTabId: 'dirty-tab',
      draftLedgers: { config: '{"version":1,"projects":[]}' },
    })
  })

  it('settles only the matching immutable snapshot without rereading or replacing editor content', async () => {
    vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    useEditorStore.setState({
      tabs: [{
        id: 'draft-7',
        name: '第二章 v1',
        type: 'chapter',
        filePath: 'ai-novel://draft/7',
        projectKey: projectBPath,
        content: '冻结正文',
        savedContent: '旧正文',
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'draft',
        contentRevision: 5,
        projectSessionLease: 'lease-B',
      }],
      activeTabId: 'draft-7',
      draftLedgers: {},
    })
    initProjectService()

    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: 'draft-7',
      chapterNumber: 2,
      chapterTitle: '第二章',
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
      draftId: 7,
      finalizationId: 'finalization-7',
      contentHash: 'hash-7',
      contentRevision: 6,
      snapshotContent: '冻结正文',
      publicationStatus: 'published',
    })

    await vi.waitFor(() => {
      expect(useEditorStore.getState().tabs[0]).toMatchObject({
        content: '冻结正文',
        savedContent: '冻结正文',
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'finalized',
        contentRevision: 5,
        dirty: false,
        finalizationId: 'finalization-7',
        finalizationPublication: 'published',
      })
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('preserves a later editor revision and records a finalization conflict', async () => {
    vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    useEditorStore.setState({
      tabs: [{
        id: 'draft-7',
        name: '第二章 v1',
        type: 'chapter',
        filePath: 'ai-novel://draft/7',
        projectKey: projectBPath,
        content: '用户后续编辑',
        savedContent: '冻结正文',
        dirty: true,
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'draft',
        contentRevision: 6,
        projectSessionLease: 'lease-B',
      }],
      activeTabId: 'draft-7',
      draftLedgers: {},
    })
    initProjectService()

    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: 'draft-7',
      chapterNumber: 2,
      chapterTitle: '第二章',
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
      draftId: 7,
      finalizationId: 'finalization-7',
      contentHash: 'hash-7',
      contentRevision: 5,
      snapshotContent: '冻结正文',
      publicationStatus: 'pending',
    })

    await vi.waitFor(() => {
      expect(useEditorStore.getState().tabs[0]).toMatchObject({
        content: '用户后续编辑',
        savedContent: '冻结正文',
        dirty: true,
        draftStatus: 'draft',
        finalizationId: 'finalization-7',
        finalizationPublication: 'pending',
        finalizationConflict: {
          finalizationId: 'finalization-7',
          publicationStatus: 'pending',
        },
      })
    })
  })
})

describe('ProjectService stale refresh failures', () => {
  it.each(projectEventFailures)('$name does not report a rejected old-session refresh after switching to the same path with a new lease', async ({ start }) => {
    const failure = deferred<void>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installDirtyEditorBuffer()
    initProjectService()

    start(projectBSession, () => failure.promise)
    const bufferBeforeSwitch = useEditorStore.getState()
    useProjectStore.setState({ currentProject: {
      id: 'B', name: 'B reopened', path: projectBPath, sessionLease: 'lease-B-reopened', novelConfig: {},
    } as never })
    failure.reject(new Error('PROJECT_SESSION_STALE'))

    await expect(failure.promise).rejects.toThrow('PROJECT_SESSION_STALE')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notices).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
    expect(useEditorStore.getState()).toEqual(bufferBeforeSwitch)
  })

  it.each(projectEventFailures)('$name does not report a rejected old-session refresh after switching to another project', async ({ start }) => {
    const failure = deferred<void>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installDirtyEditorBuffer()
    initProjectService()

    start(projectBSession, () => failure.promise)
    const bufferBeforeSwitch = useEditorStore.getState()
    useProjectStore.setState({ currentProject: {
      id: 'A', name: 'A', path: projectAPath, sessionLease: 'lease-A', novelConfig: {},
    } as never })
    failure.reject(new Error('PROJECT_SESSION_STALE'))

    await expect(failure.promise).rejects.toThrow('PROJECT_SESSION_STALE')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notices).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
    expect(useEditorStore.getState()).toEqual(bufferBeforeSwitch)
  })

  it.each(projectEventFailures)('$name still reports a failure while its session remains current', async ({ start }) => {
    const failure = deferred<void>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installDirtyEditorBuffer()
    initProjectService()

    start(projectBSession, () => failure.promise)
    const bufferBeforeFailure = useEditorStore.getState()
    failure.reject(new Error('CURRENT_REFRESH_FAILED'))

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toContain('CURRENT_REFRESH_FAILED')
    expect(consoleError).toHaveBeenCalledOnce()
    expect(useEditorStore.getState()).toEqual(bufferBeforeFailure)
  })

  it('waits for a real project-open identity publication before reporting an old-session refresh rejection', async () => {
    const refreshFailure = deferred<void>()
    const openResponse = deferred<unknown>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const otherProjectBuffer = {
      id: 'other-project-tab', name: '未保存章节', type: 'chapter' as const, projectKey: 'C:\\novels\\C',
      content: '尚未保存的另一作品正文', savedContent: '原正文', dirty: true,
      chapterNumber: 2, draftStatus: 'draft' as const, projectSessionLease: 'lease-C',
    }
    useEditorStore.setState({ tabs: [otherProjectBuffer], activeTabId: otherProjectBuffer.id, draftLedgers: {} })
    const editorBeforeOpen = useEditorStore.getState()
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockImplementation((_path, _epoch, session) => (
      session?.leaseId === projectBSession.leaseId ? refreshFailure.promise : Promise.resolve()
    ))
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'project:open') return openResponse.promise
      return Promise.resolve([])
    })
    initProjectService()

    let opening: Promise<boolean> | undefined
    try {
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: 'novel_import', projectPath: projectBPath, projectSession: projectBSession, runId: 'run-open-gap',
      })
      await vi.waitFor(() => expect(useProjectStore.getState().refreshFileTree).toHaveBeenCalledWith(
        projectBPath, undefined, projectBSession,
      ))
      opening = useProjectStore.getState().openProject(projectAPath)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('project:open', projectAPath, expect.any(String), projectBPath))

      refreshFailure.reject(new Error('old lease refresh failed during project open'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(notices).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()

      const requestToken = mocks.invoke.mock.calls.find(([channel]) => channel === 'project:open')?.[2]
      openResponse.resolve({
        success: true,
        project: { id: 'A', name: 'A', path: projectAPath, sessionLease: 'lease-A', novelConfig: {} },
        requestToken,
        activeProjectPath: projectAPath,
        databaseRestored: true,
        dbReady: true,
      })
      await expect(opening).resolves.toBe(true)
      expect(useProjectStore.getState().currentProject).toMatchObject({ id: 'A', sessionLease: 'lease-A' })
      expect(notices).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
      expect(useEditorStore.getState()).toEqual(editorBeforeOpen)
    } finally {
      refreshFailure.reject(new Error('test cleanup'))
      openResponse.resolve({
        success: true,
        project: { id: 'A', name: 'A', path: projectAPath, sessionLease: 'lease-A', novelConfig: {} },
        requestToken: mocks.invoke.mock.calls.find(([channel]) => channel === 'project:open')?.[2],
        activeProjectPath: projectAPath,
        databaseRestored: true,
        dbReady: true,
      })
      await opening?.catch(() => false)
    }
  })

  it('still reports an old-session refresh rejection after a failed open leaves that session current', async () => {
    const refreshFailure = deferred<void>()
    const openResponse = deferred<unknown>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockImplementation((_path, _epoch, session) => (
      session?.leaseId === projectBSession.leaseId ? refreshFailure.promise : Promise.resolve()
    ))
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'project:open') return openResponse.promise
      return Promise.resolve([])
    })
    initProjectService()

    let opening: Promise<boolean> | undefined
    const refreshError = new Error('current lease refresh failure remains reportable')
    try {
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: 'novel_import', projectPath: projectBPath, projectSession: projectBSession, runId: 'run-failed-open',
      })
      await vi.waitFor(() => expect(useProjectStore.getState().refreshFileTree).toHaveBeenCalledWith(
        projectBPath, undefined, projectBSession,
      ))
      opening = useProjectStore.getState().openProject(projectAPath)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('project:open', projectAPath, expect.any(String), projectBPath))

      refreshFailure.reject(refreshError)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(notices).toEqual([])

      const requestToken = mocks.invoke.mock.calls.find(([channel]) => channel === 'project:open')?.[2]
      openResponse.resolve({ success: false, requestToken, error: 'open refused' })
      await expect(opening).resolves.toBe(false)
      await vi.waitFor(() => expect(notices).toHaveLength(1))
      expect(notices[0]).toContain(refreshError.message)
      const serviceErrors = consoleError.mock.calls.filter(([label, error]) => (
        typeof label === 'string' && label.startsWith('[ProjectService]') && error === refreshError
      ))
      expect(serviceErrors).toHaveLength(1)
      expect(useProjectStore.getState().currentProject).toMatchObject({ id: 'B', sessionLease: 'lease-B' })
    } finally {
      refreshFailure.reject(new Error('test cleanup'))
      openResponse.resolve({
        success: false,
        requestToken: mocks.invoke.mock.calls.find(([channel]) => channel === 'project:open')?.[2],
        error: 'test cleanup',
      })
      await opening?.catch(() => false)
    }
  })

  it('keeps waiting for the newer open when an older overlapping open settles first', async () => {
    const refreshFailure = deferred<void>()
    const openAResponse = deferred<unknown>()
    const openCResponse = deferred<unknown>()
    const notices: string[] = []
    testUnsubscribes.push(globalEventBus.on('SYSTEM_NOTICE', payload => notices.push(payload.message)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockImplementation((_path, _epoch, session) => (
      session?.leaseId === projectBSession.leaseId ? refreshFailure.promise : Promise.resolve()
    ))
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    mocks.invoke.mockImplementation((channel: string, targetPath?: string) => {
      if (channel === 'project:open') return targetPath === projectAPath ? openAResponse.promise : openCResponse.promise
      if (channel === 'project:get-runtime-context') return Promise.resolve({ activeProjectPath: projectBPath, dbReady: true })
      return Promise.resolve([])
    })
    initProjectService()

    let openingA: Promise<boolean> | undefined
    let openingC: Promise<boolean> | undefined
    try {
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: 'novel_import', projectPath: projectBPath, projectSession: projectBSession, runId: 'run-overlapping-open',
      })
      await vi.waitFor(() => expect(useProjectStore.getState().refreshFileTree).toHaveBeenCalledWith(
        projectBPath, undefined, projectBSession,
      ))
      openingA = useProjectStore.getState().openProject(projectAPath)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('project:open', projectAPath, expect.any(String), projectBPath))
      openingC = useProjectStore.getState().openProject('C:\\novels\\C')
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('project:open', 'C:\\novels\\C', expect.any(String), projectBPath))

      refreshFailure.reject(new Error('old lease refresh during overlapping opens'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(notices).toEqual([])

      const tokenA = mocks.invoke.mock.calls.find(([channel, targetPath]) => channel === 'project:open' && targetPath === projectAPath)?.[2]
      openAResponse.resolve({
        success: true,
        project: { id: 'A', name: 'A', path: projectAPath, sessionLease: 'lease-A', novelConfig: {} },
        requestToken: tokenA,
        activeProjectPath: projectAPath,
        databaseRestored: true,
        dbReady: true,
      })
      await expect(openingA).resolves.toBe(false)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(notices).toEqual([])

      const tokenC = mocks.invoke.mock.calls.find(([channel, targetPath]) => channel === 'project:open' && targetPath === 'C:\\novels\\C')?.[2]
      openCResponse.resolve({
        success: true,
        project: { id: 'C', name: 'C', path: 'C:\\novels\\C', sessionLease: 'lease-C', novelConfig: {} },
        requestToken: tokenC,
        activeProjectPath: 'C:\\novels\\C',
        databaseRestored: true,
        dbReady: true,
      })
      await expect(openingC).resolves.toBe(true)
      expect(useProjectStore.getState().currentProject).toMatchObject({ id: 'C', sessionLease: 'lease-C' })
      expect(notices).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      refreshFailure.reject(new Error('test cleanup'))
      const calls = mocks.invoke.mock.calls
      const tokenA = calls.find(([channel, targetPath]) => channel === 'project:open' && targetPath === projectAPath)?.[2]
      const tokenC = calls.find(([channel, targetPath]) => channel === 'project:open' && targetPath === 'C:\\novels\\C')?.[2]
      openAResponse.resolve({
        success: true,
        project: { id: 'A', name: 'A', path: projectAPath, sessionLease: 'lease-A', novelConfig: {} },
        requestToken: tokenA,
        activeProjectPath: projectAPath,
        databaseRestored: true,
        dbReady: true,
      })
      openCResponse.resolve({
        success: true,
        project: { id: 'C', name: 'C', path: 'C:\\novels\\C', sessionLease: 'lease-C', novelConfig: {} },
        requestToken: tokenC,
        activeProjectPath: 'C:\\novels\\C',
        databaseRestored: true,
        dbReady: true,
      })
      await openingA?.catch(() => false)
      await openingC?.catch(() => false)
    }
  })
})

describe('打开作品时的读取警告（#474）', () => {
  it('英文界面也带上登记过的原因，主进程未登记的中文原文只给英文概述', async () => {
    const { useLocaleStore } = await import('../../stores/locale-store')
    const previous = useLocaleStore.getState().locale
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({ lastError: null })
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    const session = { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath }
    try {
      vi.spyOn(useDraftStore.getState(), 'loadAllDrafts')
        .mockRejectedValueOnce(new Error("Error invoking remote method 'db:draft-list': Error: PROJECT_SESSION_STALE"))
        .mockRejectedValueOnce(new Error('草稿表读取失败'))
      const stale = await onProjectOpened(session)
      expect(stale.warnings).toHaveLength(1)
      expect(stale.warnings[0]).toMatch(/^Could not load the draft list\. The project was switched or reopened/u)
      await expect(onProjectOpened(session)).resolves.toEqual({ warnings: ['Could not load the draft list.'] })
    } finally {
      useLocaleStore.setState({ locale: previous })
    }
  })
})
