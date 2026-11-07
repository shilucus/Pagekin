import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import { formatResourceUri } from '../../../shared/project-paths'
import { getActiveProjectSessionContext, setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useCharacterStore } from '../../../stores/character-store'
import { useDraftStore } from '../../../stores/draft-store'
import { editorSaveHandler, saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { openPageTab } from '../../../stores/navigation/page-tabs'
import { isDeleteRecoverySession, useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { chapterProject, createChapterBackend, SESSION } from '../../stage/chapter/__tests__/chapter-fixture'
import { useDraftActions } from '../use-draft-actions'
import { useNovelConfigForm } from '../use-novel-config-form'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function captureStore<T>(store: StoreApi<T>) {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [captureStore(useEditorStore), captureStore(useProjectStore), captureStore(useWorkflowStore),
  captureStore(useCharacterStore), captureStore(useDraftStore), captureStore(useLocaleStore)]
let host: HTMLDivElement
let root: Root
let backend: ReturnType<typeof createChapterBackend>
let filePath: string
let draftActions: ReturnType<typeof useDraftActions>
let configForm: ReturnType<typeof useNovelConfigForm>

export function Editors() {
  const draft = useDraftActions({ tabId: 'chapter', filePath, content: 'saved body', projectKey: SESSION.projectPath })
  const config = useNovelConfigForm(SESSION.projectPath)
  useEffect(() => {
    draftActions = draft
    configForm = config
  }, [draft, config])
  return null
}

beforeEach(async () => {
  backend = createChapterBackend()
  backend.install()
  const draft = backend.addDraft({ status: 'draft', content: 'saved body' })
  filePath = formatResourceUri({ kind: 'draft', id: draft.id })
  useLocaleStore.setState({ locale: 'en-US' })
  useProjectStore.setState({ currentProject: chapterProject(), loading: false })
  setActiveProjectSessionContext(SESSION)
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, addLog: vi.fn() })
  useEditorStore.getState().clearTabs()
  useEditorStore.setState({ draftLedgers: {}, tabs: [
    { id: 'chapter', name: 'Chapter', type: 'chapter', filePath, projectKey: SESSION.projectPath,
      projectSessionLease: SESSION.leaseId, content: 'saved body', savedContent: 'saved body', contentRevision: 0,
      draftId: draft.id, draftStatus: 'draft', dirty: false },
  ], activeTabId: 'chapter' })
  openPageTab('setup')
  expect(useEditorStore.getState().tabs.find(tab => tab.type === 'config')?.projectSessionLease).toBe(SESSION.leaseId)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Editors />))
  await vi.waitFor(() => expect(draftActions.loaded).toBe(true))
  await act(async () => {
    draftActions.onBodyChange('unsaved author body')
    configForm.update('coreOutline', 'unsaved author setup')
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.getState().clearTabs()
  for (const restore of restores) restore()
})

describe('inactive ordinary editors after failed deletion', () => {
  it.each([1, 2])('saves inactive chapter and setup handlers after %i consecutive explicit delete recoveries', async recoveryCount => {
    const restored = { ...SESSION, leaseId: `delete-recovery-exit-save-${recoveryCount}` }
    const base = backend.invoke.getMockImplementation()!
    const writes: Array<{ channel: string; args: unknown[] }> = []
    const deletedSessions: unknown[] = []
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:delete') {
        deletedSessions.push(args.at(-1))
        return { success: false, directoryDeleted: false, databaseRestored: true,
          restoredSession: { ...SESSION, leaseId: `delete-recovery-exit-save-${deletedSessions.length}` }, error: 'fixture directory locked' }
      }
      if (channel === 'project:save' || channel === 'db:draft-update-content') {
        expect(args.at(-1)).toEqual(restored)
        writes.push({ channel, args })
        if (channel === 'project:save') return { success: true }
      }
      return base(channel, ...args)
    })
    const applyOldGeneratedConfig = configForm.applyGeneratedTo(SESSION)
    await act(async () => {
      useEditorStore.setState({ activeTabId: 'elsewhere' })
      root.render(null)
    })
    for (let attempt = 0; attempt < recoveryCount; attempt++) {
      await act(async () => { await useProjectStore.getState().deleteProject(SESSION.projectPath) })
      const dismiss = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'OK')
      expect(dismiss).toBeTruthy()
      await act(async () => dismiss!.click())
    }
    expect(deletedSessions).toEqual([SESSION, ...(recoveryCount === 2 ? [{ ...SESSION, leaseId: 'delete-recovery-exit-save-1' }] : [])])
    expect(getActiveProjectSessionContext()).toEqual(restored)
    expect(isDeleteRecoverySession(SESSION, restored)).toBe(true)
    for (const tab of useEditorStore.getState().tabs) {
      expect(tab.projectSessionLease).toBe(restored.leaseId)
      expect(editorSaveHandler(tab)).toBeTruthy()
    }

    // Ordinary late callbacks and AI callbacks remain frozen. Only the retained
    // exit registration can consume the explicit delete-recovery handoff.
    await act(async () => {
      await draftActions.save('obsolete callback body', true)
      await configForm.save(true)
      applyOldGeneratedConfig({ coreOutline: 'obsolete generated setup' })
    })
    expect(writes).toEqual([])
    expect(useProjectStore.getState().currentProject!.novelConfig.coreOutline).toBe('unsaved author setup')
    await act(async () => { await saveDirtyEditorChangesForExit(SESSION.projectPath) })
    expect(useEditorStore.getState().tabs.map(tab => ({ type: tab.type, dirty: tab.dirty })))
      .toEqual([{ type: 'chapter', dirty: false }, { type: 'config', dirty: false }])
    expect(writes.map(write => write.channel)).toEqual(['db:draft-update-content', 'project:save'])
    expect(writes[0].args[1]).toBe('unsaved author body')
    expect(writes[1].args[1]).toMatchObject({ novelConfig: { coreOutline: 'unsaved author setup' } })
    expect(useEditorStore.getState().tabs.every(tab => !tab.dirty)).toBe(true)
    expect(useEditorStore.getState().activeTabId).toBe('elsewhere')
  })

  it('does not lend an ordinary same-root reopen lease to inactive exit handlers', async () => {
    await act(async () => root.render(null))
    const reopened = { ...chapterProject(), sessionLease: 'ordinary-reopen-not-recovery' }
    await act(async () => {
      useProjectStore.setState({ currentProject: reopened })
      // Even retagging an old tab cannot establish the missing recovery pair.
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, projectSessionLease: reopened.sessionLease })) }))
    })
    backend.invoke.mockClear()
    await expect(saveDirtyEditorChangesForExit(SESSION.projectPath)).rejects.toThrow('New edits were made')
    expect(backend.invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs.every(tab => tab.dirty)).toBe(true)
  })

  it('ends the old inactive handlers lineage when an ordinary reopen separates two delete recoveries', async () => {
    const base = backend.invoke.getMockImplementation()!
    let recoveries = 0
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'project:delete'
      ? { success: false, directoryDeleted: false, databaseRestored: true,
          restoredSession: { ...SESSION, leaseId: `separated-recovery-${++recoveries}` }, error: 'fixture directory locked' }
      : base(channel, ...args))
    await act(async () => root.render(null))
    const recover = async () => {
      await act(async () => { await useProjectStore.getState().deleteProject(SESSION.projectPath) })
      const dismiss = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'OK')
      expect(dismiss).toBeTruthy()
      await act(async () => dismiss!.click())
    }
    await recover()
    await act(async () => {
      const reopened = { ...chapterProject(), sessionLease: 'ordinary-intervening-reopen' }
      useProjectStore.setState({ currentProject: reopened })
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, projectSessionLease: reopened.sessionLease })) }))
    })
    await recover()
    backend.invoke.mockClear()
    await expect(saveDirtyEditorChangesForExit(SESSION.projectPath)).rejects.toThrow('New edits were made')
    expect(backend.invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs.every(tab => tab.dirty)).toBe(true)
  })
})
