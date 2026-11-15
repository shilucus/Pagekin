import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { projectAccess } from '../services/project-access'
import { projectRuntimeHost, type ProjectRuntime, type ProjectRuntimeCloseAllOptions } from '../services/project-runtime'

interface WindowRuntimeClose {
  requestCloseAll(options?: ProjectRuntimeCloseAllOptions): Promise<void>
  finishWindowClose(): void
  getActiveView(): ProjectRuntime | null
  runAfterViewOperationsDrained<T>(runtime: ProjectRuntime | null, operation: () => T): Promise<T>
}

interface WindowCloseGuardState {
  approved: boolean
  quitRequested: boolean
  pendingRequestId: string | null
  requestSequence: number
  settling: boolean
  closeStarted: boolean
  retryable: boolean
  rendererGone: boolean
  runtime: WindowRuntimeClose
}

const closeGuardStates = new WeakMap<BrowserWindow, WindowCloseGuardState>()
let windowRuntime: WindowRuntimeClose = projectRuntimeHost

function reportCloseFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  console.error('[window] runtime close failed', {
    code: /^[A-Z][A-Z_]+$/.test(message) ? message : 'PROJECT_RUNTIME_CLOSE_FAILED',
  })
}

async function finishClose(win: BrowserWindow, state: WindowCloseGuardState): Promise<boolean> {
  if (state.settling) return false
  state.settling = true
  try {
    const runtime = state.runtime.getActiveView()
    const session = projectAccess.captureCurrentSession()
    const requestId = state.pendingRequestId
    try {
      state.closeStarted = true
      await state.runtime.requestCloseAll({ shutdown: state.quitRequested })
    } catch (error) {
      state.closeStarted = false
      if (!(error instanceof Error) || error.message !== 'PROJECT_RUNTIME_VIEW_OPERATION_BUSY') throw error
      let closeOperation!: Promise<void>
      await state.runtime.runAfterViewOperationsDrained(runtime, () => {
        if (win.isDestroyed() || closeGuardStates.get(win) !== state || state.pendingRequestId !== requestId || !state.settling || state.approved) {
          throw new Error('PROJECT_RUNTIME_CLOSE_INTENT_STALE')
        }
        if (session) projectAccess.assertCurrentSession(session)
        else if (projectAccess.captureCurrentSession()) throw new Error('PROJECT_SESSION_STALE')
        state.closeStarted = true
        closeOperation = state.runtime.requestCloseAll({ shutdown: state.quitRequested })
      })
      await closeOperation
    }
    state.pendingRequestId = null
    state.approved = true
    if (state.quitRequested) app.quit()
    else win.close()
    return true
  } catch (error) {
    state.retryable = true
    reportCloseFailure(error)
    return false
  } finally { state.closeStarted = false; state.settling = false }
}

function getSenderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function installWindowCloseGuard(win: BrowserWindow): void {
  const state: WindowCloseGuardState = {
    approved: false,
    quitRequested: false,
    pendingRequestId: null,
    requestSequence: 0,
    settling: false,
    closeStarted: false,
    retryable: false,
    rendererGone: false,
    runtime: windowRuntime,
  }
  closeGuardStates.set(win, state)
  const noteQuitRequest = () => { state.quitRequested = true }
  app.on('before-quit', noteQuitRequest)
  win.webContents.on('render-process-gone', () => {
    state.rendererGone = true
    if (state.pendingRequestId && !state.settling) void finishClose(win, state)
  })
  win.webContents.on('did-finish-load', () => { state.rendererGone = false })
  win.on('closed', () => {
    app.off('before-quit', noteQuitRequest)
    if (!state.quitRequested) {
      try { state.runtime.finishWindowClose() } catch (error) { reportCloseFailure(error) }
    }
  })
  win.on('close', (event) => {
    if (state.approved) return
    event.preventDefault()
    if (state.settling) return
    if (state.rendererGone || win.webContents.isDestroyed() || win.webContents.isLoadingMainFrame()) {
      void finishClose(win, state)
      return
    }
    if (state.pendingRequestId && !state.retryable) return
    state.retryable = false
    if (!state.pendingRequestId) state.pendingRequestId = `${win.id}:${++state.requestSequence}`
    win.webContents.send('window:close-requested', { requestId: state.pendingRequestId })
  })
}

export function registerWindowController(runtime: WindowRuntimeClose = projectRuntimeHost) {
  windowRuntime = runtime
  let appApproved = false
  let appSettlement: Promise<void> | undefined
  app.on('before-quit', event => {
    if (appApproved) return
    const windows = BrowserWindow.getAllWindows()
    if (windows.length) {
      for (const win of windows) {
        const state = closeGuardStates.get(win)
        if (!state) continue
        state.quitRequested = true
        // Upgrade an in-flight ordinary window close before it can release its seal.
        if (state.closeStarted || state.approved) void runtime.requestCloseAll({ shutdown: true }).catch(reportCloseFailure)
      }
      return
    }
    event.preventDefault()
    if (appSettlement) return
    appSettlement = runtime.requestCloseAll({ shutdown: true }).then(() => {
      appApproved = true
      app.quit()
    }, reportCloseFailure).finally(() => { appSettlement = undefined })
  })
  ipcMain.handle('window:minimize', async (event) => {
    const win = getSenderWindow(event)
    win?.minimize()
    return { success: !!win }
  })

  ipcMain.handle('window:toggle-maximize', async (event) => {
    const win = getSenderWindow(event)
    if (!win) return { success: false }

    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }

    return { success: true, maximized: win.isMaximized() }
  })

  ipcMain.handle('window:close', async (event) => {
    const win = getSenderWindow(event)
    win?.close()
    return { success: !!win }
  })

  ipcMain.handle('window:resolve-close', async (event, requestId: unknown, decision: unknown) => {
    const win = getSenderWindow(event)
    const state = win ? closeGuardStates.get(win) : undefined
    if (
      !win
      || !state
      || typeof requestId !== 'string'
      || state.pendingRequestId !== requestId
      || state.settling
      || (decision !== 'proceed' && decision !== 'cancel')
    ) return { success: false }

    if (decision === 'cancel') {
      state.pendingRequestId = null
      state.retryable = false
      state.quitRequested = false
      return { success: true }
    }

    return { success: await finishClose(win, state) }
  })
}
