import { app, ipcMain, dialog, type IpcMainInvokeEvent } from 'electron'
import { showOpenDialogInLastDirectory } from '../utils/remembered-dialog'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'
import {
  ProjectData,
  type CreateProjectConfig,
  type ProjectSessionContext,
  type ProjectOpenTarget,
  type ProjectDirectoryGrant,
} from '../../src/shared/ipc-channels'
import { DIR_PROMPTS } from '../../src/shared/project-paths'
import { sameProjectPathKey } from '../../src/shared/project-session-context'
import { PROJECT_RUNTIME_OPEN_VIEW_CHANNEL } from '../../src/shared/project-runtime-contract'
import {
  resolveWritingLanguage,
} from '../../src/shared/writing-language'
import {
  createProjectDatabase,
  getCurrentProjectPath,
  getProjectDb,
} from '../database'
import { projectRuntimeHost, ProjectRuntimePreviousCloseError, type ProjectRuntime, type PreparedRuntimeOpen } from '../services/project-runtime'
import { assertRestoreTargetOutsideRuntimes, withProjectRestoreOperation } from '../services/project-runtime-compatibility'
import { externalFileGrants } from '../services/external-file-grant-service'
import {
  ProjectCoreRepository,
  type ProjectCoreData,
} from '../repositories/project-core-repository'
import { projectAccess, ProjectSessionStaleError } from '../services/project-access'
import { assertExpectedProjectPath, assertRequiredExpectedProjectPath } from '../utils/project-context'
import { sanitizeProjectName } from './project-path'
import { projectStoragePreflightFailure } from '../services/project-storage-preflight'
import { projectPeekService } from '../services/project-peek'
import { probeProjectSqlite } from '../services/sqlite-project-migration'
import { mainText } from '../i18n'
import { adoptTransferredCharacterContinuityOnOpen } from '../services/transferred-character-continuity'
import { FinalizationRepository } from '../repositories/finalization-repository'
import type { FinalizationRepairOnOpen } from '../../src/shared/finalization-repair'
import { REPLACED_FINAL_CLEANUP_STEP_LABELS } from '../../src/shared/finalization-step-error'

function repairDuplicateFinalizationsOnOpen(database: ProjectRuntime['database']): FinalizationRepairOnOpen {
  try {
    return { status: 'checked', ...FinalizationRepository.repairDuplicateFinalizations({
      remove_replaced_knowledge: text(...REPLACED_FINAL_CLEANUP_STEP_LABELS.remove_replaced_knowledge),
      remove_replaced_manuscripts: text(...REPLACED_FINAL_CLEANUP_STEP_LABELS.remove_replaced_manuscripts),
    }, database) }
  } catch (error) {
    console.error('[Project] 遗留重复定稿修复失败:', error)
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 按作者保存的界面语言选文案；没保存过时按系统语言，与渲染层一致。 */
function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

/**
 * 失败后又没能恢复原项目数据库（极少见）：把恢复失败的原因接在首个错误后面一并交出，供反馈定位；
 * 只有一个错误时报错就是它的码，渲染层能按码说明。
 */
function withRollbackFailure(primary: string, rollbackError: unknown): string {
  return rollbackError === undefined
    ? primary
    : `${primary}${text('；回滚失败：', '; rollback failed: ')}${String(rollbackError)}`
}

/**
 * 打开项目时被拒的原因都是错误码，渲染层按 app-errors.ts 登记的文案解释。
 * 旧版项目与「选了上级目录」两种还带 errorCode：渲染层据此分流到导入旧项目，或提示改选项目根。
 */
function projectRootSelectionFailure(error: unknown) {
  if (error instanceof Error && error.message === 'PROJECT_LEGACY_IMPORT_REQUIRED') {
    return { errorCode: 'PROJECT_LEGACY_IMPORT_REQUIRED' as const, error: error.message }
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'PROJECT_ROOT_REQUIRED'
  ) {
    return { errorCode: 'PROJECT_ROOT_REQUIRED' as const, error: 'PROJECT_ROOT_REQUIRED' }
  }
  return null
}

export interface RecentProject {
  name: string
  path: string
  updatedAt: string
  projectId?: string
}

let latestProjectOpenRequestToken: string | null = null
let projectOpenQueue: Promise<void> = Promise.resolve()
const recentPreviewCapabilities = new Map<string, string>()

function revokeRecentPreviewCapabilities(projectPath?: string): void {
  for (const [capabilityId, capabilityPath] of recentPreviewCapabilities) {
    if (projectPath && !sameRecentProjectPath(capabilityPath, projectPath)) continue
    projectPeekService.revokeCapability(capabilityId)
    recentPreviewCapabilities.delete(capabilityId)
  }
}

function serializeProjectOpen<T>(operation: () => Promise<T>): Promise<T> {
  const result = projectOpenQueue.then(operation, operation)
  projectOpenQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function yieldToPendingOpenRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface ProjectDatabaseState {
  databaseRestored: boolean
  dbReady: boolean
  activeProjectPath: string | null
}

type ProjectRollbackBoundary =
  | { kind: 'trusted' }
  | { kind: 'neutral' }
  | { kind: 'untrusted' }

function sameProjectPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return projectAccess.sameCanonicalProjectRoot(left, right)
}

// 最近项目是导航元数据，删除后目录可能已经不存在，不能只依赖 realpath。
// 用主进程 canonical root 优先，失败时退回与渲染端一致的 Windows 词法路径键。
function sameRecentProjectPath(left: string, right: string): boolean {
  return sameProjectPath(left, right) || sameProjectPathKey(left, right)
}

function creativeStrategyCoreUpdate(
  novelConfig: ProjectData['novelConfig'],
): Pick<Partial<ProjectCoreData>, 'creativeStrategy'> {
  return novelConfig.creativeStrategy
    ? { creativeStrategy: novelConfig.creativeStrategy }
    : {}
}

function narrativeThreadSettingsCoreUpdate(
  novelConfig: ProjectData['novelConfig'],
): Pick<Partial<ProjectCoreData>, 'narrativeThreadDormantChapterThreshold'> {
  return novelConfig.narrativeThreadDormantChapterThreshold === undefined
    ? {}
    : { narrativeThreadDormantChapterThreshold: novelConfig.narrativeThreadDormantChapterThreshold }
}

/** 项目配置读写必须显式携带当前会话租约，路径本身不是授权。 */
function assertRequiredProjectSession(
  projectId: string,
  data: Partial<ProjectData>,
  currentProjectPath: string | null,
  context: ProjectSessionContext | undefined,
): ProjectRuntime {
  if (!context) {
    throw new Error('PROJECT_SESSION_REQUIRED')
  }
  if (
    !projectId
    || context.projectId !== projectId
    || (data.id && data.id !== projectId)
    || (data.sessionLease !== undefined && data.sessionLease !== context.leaseId)
  ) {
    throw new Error('PROJECT_SESSION_IDENTITY_MISMATCH')
  }
  const runtime = projectAccess.assertViewContext(context)
  if (
    !sameProjectPath(runtime.canonicalRoot, currentProjectPath)
    || (data.path !== undefined && !sameProjectPath(runtime.canonicalRoot, data.path))
  ) {
    throw new ProjectSessionStaleError('PROJECT_SESSION_ROOT_MISMATCH')
  }
  return runtime
}

function databaseStateFor(expectedProjectPath: string | null): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const dbReady = getProjectDb() !== null
    && sameProjectPath(activeProjectPath, expectedProjectPath)
  return {
    databaseRestored: dbReady,
    dbReady,
    activeProjectPath,
  }
}

function failedDatabaseState(): ProjectDatabaseState {
  // Preparation never replaces the view. A failed target must not close or
  // invalidate a different runtime that still owns the current view.
  return {
    databaseRestored: false,
    dbReady: false,
    activeProjectPath: getCurrentProjectPath(),
  }
}

function neutralDatabaseState(): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const neutral = activeProjectPath === null
    && getProjectDb() === null
    && projectAccess.captureCurrentSession() === null
  return {
    databaseRestored: neutral,
    dbReady: neutral,
    activeProjectPath,
  }
}

function requireReadyDatabase(
  databaseState: ProjectDatabaseState,
  code: 'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE' | 'PROJECT_OPEN_DATABASE_UNAVAILABLE',
): ProjectDatabaseState {
  if (!databaseState.databaseRestored || !databaseState.dbReady) {
    throw new Error(code)
  }
  return databaseState
}

function captureProjectRollbackBoundary(): ProjectRollbackBoundary {
  const databaseRoot = getCurrentProjectPath()
  const database = getProjectDb()
  const capturedSession = projectAccess.captureCurrentSession()
  if (!databaseRoot && !database && !capturedSession) return { kind: 'neutral' }
  if (!databaseRoot || !database || !capturedSession) return { kind: 'untrusted' }

  try {
    const activeSession = projectAccess.assertCurrentSession(capturedSession)
    const runtime = projectAccess.assertViewContext({ projectId: activeSession.projectId,
      leaseId: activeSession.leaseId, projectPath: activeSession.rootPath })
    if (
      !sameProjectPath(activeSession.rootPath, capturedSession.rootPath)
      || !sameProjectPath(activeSession.rootPath, databaseRoot)
      || runtime.database !== database
    ) {
      return { kind: 'untrusted' }
    }

    return { kind: 'trusted' }
  } catch {
    return { kind: 'untrusted' }
  }
}

function databaseStateForRollbackBoundary(): ProjectDatabaseState {
  const session = projectAccess.captureCurrentSession()
  if (!session) return getCurrentProjectPath() === null && getProjectDb() === null
    ? neutralDatabaseState() : failedDatabaseState()
  try {
    const runtime = projectAccess.assertViewContext({ projectId: session.projectId,
      leaseId: session.leaseId, projectPath: session.rootPath })
    return databaseStateFor(runtime.canonicalRoot)
  } catch { return failedDatabaseState() }
}

function restoreProjectRollbackBoundary(): ProjectDatabaseState {
  // Nothing was switched during preparation. A newer committed view wins;
  // an older open request never restores a captured lease or view.
  return databaseStateForRollbackBoundary()
}

function loadRecentProjects(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

/** 最近项目导航元数据的唯一写入口。 */
export function registerRecentProject(project: RecentProject): void {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => !sameRecentProjectPath(p.path, project.path))
  filtered.unshift(project)
  const trimmed = filtered.slice(0, 20)
  writeJsonFile(RECENT_PROJECTS_PATH, trimmed)
}

function removeRecentProject(projectPath: string) {
  const filtered = loadRecentProjects().filter((p) => !sameRecentProjectPath(p.path, projectPath))
  writeJsonFile(RECENT_PROJECTS_PATH, filtered)
}

export interface ProjectControllerOptions {
  /** Called only after the project directory is confirmed absent. */
  removeDeletedProjectBinding?(projectId: string): void
}

export function registerProjectController(options: ProjectControllerOptions = {}) {
  const issueDirectoryGrant = (event: Electron.IpcMainInvokeEvent, directoryPath: string,
    operation: 'project-create' | 'project-open' | 'legacy-import') => {
    const grant = externalFileGrants.issueDirectory({
      webContentsId: event.sender.id, directoryPath, operations: [operation], ttlMs: 10 * 60 * 1_000,
    })
    event.sender.once('destroyed', () => externalFileGrants.revokeWebContents(event.sender.id))
    return { grantId: grant.grantId, displayName: path.basename(directoryPath) }
  }
  ipcMain.handle('dialog:select-legacy-project', async (event) => {
    const result = await showOpenDialogInLastDirectory('legacy-project', {
      title: text('选择旧版小说项目文件夹', 'Choose the legacy novel project folder'),
      properties: ['openDirectory'],
    })
    return result.canceled || !result.filePaths[0] ? null
      : issueDirectoryGrant(event, result.filePaths[0], 'legacy-import')
  })

  ipcMain.handle('project:import-legacy-copy', async (
    event: { sender: { id: number } },
    sourceGrantId: string,
    targetGrantId: string,
  ) => {
    if (typeof sourceGrantId !== 'string' || typeof targetGrantId !== 'string') {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_PATH_INVALID' }
    }
    return withProjectRestoreOperation(async () => {
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: [text('取消', 'Cancel'), text('开始导入', 'Start import')],
      defaultId: 0,
      cancelId: 0,
      message: text(
        '请先保存并关闭旧版程序，以及正在同步或编辑这个项目的程序。',
        'First save and close the legacy app and any program that is syncing or editing this project.',
      ),
      detail: text(
        '导入期间不要重新打开或修改旧项目。应用将创建独立的新项目副本；旧项目保留，此后两份项目的修改不会自动同步。',
        'Do not reopen or change the legacy project during the import. The app creates an independent new copy; the legacy project is kept, and later changes to either copy do not sync.',
      ),
    })
    if (confirmation.response !== 1) return { state: 'cancelled' as const }
    // 副本位置只来自 dialog:select-project-restore-target 签发、绑定本窗口的一次性授权。
    let targetRoot: string
    let sourceRoot: string
    try {
      sourceRoot = externalFileGrants.resolveDirectoryPath({
        grantId: sourceGrantId, webContentsId: event.sender.id, operation: 'legacy-import',
      })
      targetRoot = externalFileGrants.resolveExactPath({
        grantId: targetGrantId,
        webContentsId: event.sender.id,
        operation: 'create',
      })
      assertRestoreTargetOutsideRuntimes(targetRoot)
    } catch {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_PATH_INVALID' }
    }
    let result: Awaited<ReturnType<typeof import('../services/legacy-project-copy-import').importLegacyProjectCopy>>
    try {
      const { importLegacyProjectCopy } = await import('../services/legacy-project-copy-import')
      result = await importLegacyProjectCopy({ sourceRoot, targetRoot })
    } catch {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_IO_FAILED' }
    }
    if (result.state === 'ready') {
      try {
        registerRecentProject({ name: path.basename(sourceRoot), path: result.targetRoot, projectId: result.projectId, updatedAt: new Date().toISOString() })
      } catch {
        return { ...result, warning: 'LEGACY_IMPORT_RECENT_LIST_FAILED' }
      }
    }
    return result
    })
  })

  ipcMain.handle('project:get-runtime-context', async () => {
    const activeProjectPath = getCurrentProjectPath()
    const database = getProjectDb()
    return {
      activeProjectPath,
      dbReady: activeProjectPath === null ? database === null : database !== null,
    }
  })

  ipcMain.handle('project:smoke-open-request', async () => {
    const projectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
    const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
    return projectPath && markerPath ? { projectPath, markerPath } : null
  })

  ipcMain.handle('project:smoke-open-confirm', async (_event, projectPath: string) => {
    try {
      const requestedProjectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
      const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
      const currentProjectPath = getCurrentProjectPath()
      if (
        !requestedProjectPath
        || !markerPath
        || !currentProjectPath
        || path.resolve(projectPath) !== path.resolve(requestedProjectPath)
        || path.resolve(currentProjectPath) !== path.resolve(requestedProjectPath)
      ) {
        // i18n-exempt: 只供打包烟测脚本确认项目已打开，不进界面
        return { success: false, error: '烟测项目未在应用中成功打开' }
      }
      fs.writeFileSync(markerPath, JSON.stringify({
        projectPath: path.resolve(currentProjectPath),
        openedAt: new Date().toISOString(),
      }), 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 创建新项目
  ipcMain.handle('project:create', async (
    event,
    config: CreateProjectConfig,
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      await yieldToPendingOpenRequests()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary()
        return {
          success: false,
          projectId: '',
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      let prepared: PreparedRuntimeOpen | undefined
      try {
        if (rollbackBoundary.kind === 'untrusted') throw new Error('PROJECT_ROLLBACK_UNTRUSTED')
        projectRuntimeHost.assertLifecycleAvailable()
        const projectName = sanitizeProjectName(config.name)
        const parentPath = externalFileGrants.resolveDirectoryPath({
          grantId: config.parentGrantId, webContentsId: event.sender.id, operation: 'project-create',
        })
        const createdProject = projectAccess.createProject(parentPath, projectName)
        const projectId = createdProject.projectId
        const projectDir = createdProject.rootPath

        fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })
        createProjectDatabase(projectDir)
        prepared = projectRuntimeHost.prepareOpen(createdProject)
        const database = prepared.runtime.database
        ProjectCoreRepository.init(projectName, resolveWritingLanguage(config.writingLanguage), database)
        ProjectCoreRepository.update({
          genre: config.genre,
          targetAudience: config.targetAudience,
        }, database)

        projectRuntimeHost.abortOpen(prepared)
        prepared = undefined

        const updatedAt = new Date().toISOString()
        if (!isLatestRequest()) {
          let databaseState: ProjectDatabaseState
          try {
            databaseState = requireReadyDatabase(
              restoreProjectRollbackBoundary(),
              'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
            )
          } catch (restoreError) {
            databaseState = failedDatabaseState()
            return {
              success: false,
              projectId: '',
              requestToken,
              stale: true,
              ...databaseState,
              error: String(restoreError),
            }
          }
          return {
            success: false,
            projectId: '',
            requestToken,
            stale: true,
            ...databaseState,
          }
        }

        registerRecentProject({
          name: projectName,
          path: projectDir,
          projectId,
          updatedAt,
        })
        // Creation only persists the new target; the current view never changes.
        const databaseState = requireReadyDatabase(
          restoreProjectRollbackBoundary(),
          'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
        )
        return {
          success: true,
          projectId,
          projectPath: projectDir,
          requestToken,
          ...databaseState,
        }
      } catch (error) {
        let rollbackError: unknown
        if (prepared) {
          try { projectRuntimeHost.abortOpen(prepared) } catch (abortError) { rollbackError = abortError }
          prepared = undefined
        }
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            restoreProjectRollbackBoundary(),
            'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
          )
        } catch (restoreError) {
          rollbackError = restoreError
          databaseState = failedDatabaseState()
        }
        return {
          success: false,
          projectId: '',
          requestToken,
          ...databaseState,
          ...(projectStoragePreflightFailure(error) ?? {}),
          error: withRollbackFailure(String(error), rollbackError),
        }
      }
    })
  })

  // Both entrypoints share grant/probe validation and the latest-request queue.
  const createOpenHandler = (retained: boolean) => async (
    event: IpcMainInvokeEvent,
    target: ProjectOpenTarget,
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      // 让已经发出的后续打开请求先登记身份，避免旧请求抢先切换全局数据库。
      await yieldToPendingOpenRequests()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary()
        return {
          success: false,
          project: null,
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      let legacyImportSource: ProjectDirectoryGrant | undefined
      let prepared: PreparedRuntimeOpen | undefined
      const superseded = new Error('PROJECT_OPEN_SUPERSEDED')
      try {
        if (rollbackBoundary.kind === 'untrusted') throw new Error('PROJECT_ROLLBACK_UNTRUSTED')
        if (!retained) projectRuntimeHost.assertCompatibilityOpenAvailable()
        const recent = typeof target === 'string'
          ? loadRecentProjects().find(project => project.path === target) : undefined
        const smokePath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
        // Persisted recent entries are main-owned project references, not arbitrary path authority.
        const projectPath = typeof target === 'string'
          ? recent?.path ?? (smokePath && target === smokePath ? smokePath : null)
          : externalFileGrants.resolveDirectoryPath({
            grantId: target?.grantId, webContentsId: event.sender.id, operation: 'project-open',
          })
        if (!projectPath) throw new Error('PROJECT_OPEN_GRANT_REQUIRED')
        const probedProject = projectAccess.probeExistingProject(projectPath)
        if (probedProject.kind === 'legacy' || probedProject.storageFormat === 'legacy') {
          if (recent?.projectId && (probedProject.kind !== 'manifest' || recent.projectId !== probedProject.projectId)) {
            throw new Error('PROJECT_OPEN_RECENT_IDENTITY_CHANGED')
          }
          if (fs.existsSync(path.join(probedProject.rootPath, '.ai-novel-migration'))) {
            throw new Error('PROJECT_MIGRATION_RECOVERY_REQUIRED')
          }
          const sqlite = probeProjectSqlite({ databasePath: path.join(probedProject.rootPath, '.vela', 'vela.db') })
          if (sqlite.schemaVersion !== 0) throw new Error('LEGACY_IMPORT_UNSUPPORTED_SOURCE')
          legacyImportSource = issueDirectoryGrant(event, probedProject.rootPath, 'legacy-import')
          throw new Error('PROJECT_LEGACY_IMPORT_REQUIRED')
        }
        const trustedProject = projectAccess.adoptLegacyProject(probedProject)
        const resolvedProjectPath = trustedProject.rootPath
        if (recent?.projectId && recent.projectId !== trustedProject.projectId) {
          throw new Error('PROJECT_OPEN_RECENT_IDENTITY_CHANGED')
        }
        prepared = retained ? projectRuntimeHost.prepareRetainedOpen(trustedProject)
          : projectRuntimeHost.prepareCompatibilityOpen(trustedProject)
        const ticket = prepared
        const opened = projectAccess.commitViewSession(ticket, runtime => {
          const openedDatabase = runtime.database
          if (!ticket.reused) adoptTransferredCharacterContinuityOnOpen({ database: openedDatabase,
            projectRoot: resolvedProjectPath, projectId: trustedProject.projectId })

          // 从数据库读取配置
          const coreData = ProjectCoreRepository.get(openedDatabase)
          if (!coreData) {
            // 如果是从空目录新建并打开，尝试初始化
            const folderName = path.basename(resolvedProjectPath)
            ProjectCoreRepository.init(folderName, undefined, openedDatabase)
          }

          // 组装返回给前端的数据结构
          const updatedCoreData = ProjectCoreRepository.get(openedDatabase)!
          const projectData: ProjectData = {
            id: trustedProject.projectId,
            name: updatedCoreData.projectName,
            path: resolvedProjectPath,
            novelConfig: {
              writingLanguage: updatedCoreData.writingLanguage,
              genre: updatedCoreData.genre,
              subGenre: updatedCoreData.subGenre,
              targetAudience: updatedCoreData.targetAudience,
              totalChapters: updatedCoreData.totalChapters,
              wordsPerChapter: updatedCoreData.wordsPerChapter,
              creativeStrategy: updatedCoreData.creativeStrategy,
              narrativeThreadDormantChapterThreshold: updatedCoreData.narrativeThreadDormantChapterThreshold,
              plotStructure: updatedCoreData.plotStructure as 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform',
              narrativePOV: updatedCoreData.narrativePov as 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov',
              coreOutline: updatedCoreData.coreOutline,
              worldSetting: updatedCoreData.worldSetting,
              goldenFinger: updatedCoreData.goldenFinger,
              protagonistProfile: updatedCoreData.protagonistProfile,
              globalGuidance: updatedCoreData.globalGuidance,
              writingStyle: updatedCoreData.writingStyle,
              referenceWorks: updatedCoreData.referenceWorks,
            },
            characterStates: updatedCoreData.characterStates,
            createdAt: new Date().toISOString(), // 数据库中实际上有，但这里先提供时间值避免前端报错
            updatedAt: new Date().toISOString(),
          }

          // A superseded preparation owns only its ticket, never the view lease.
          if (!isLatestRequest()) throw superseded

          registerRecentProject({
            name: projectData.name,
            path: resolvedProjectPath,
            updatedAt: projectData.updatedAt,
            projectId: trustedProject.projectId,
          })

          const finalizationRepair = repairDuplicateFinalizationsOnOpen(openedDatabase)
          revokeRecentPreviewCapabilities()
          if (!isLatestRequest()) throw superseded
          return { projectData, finalizationRepair }
        })
        prepared = undefined
        opened.value.projectData.sessionLease = opened.session.leaseId
        return {
          success: true,
          project: opened.value.projectData,
          requestToken,
          databaseRestored: true,
          dbReady: true,
          activeProjectPath: ticket.runtime.canonicalRoot,
          finalizationRepair: opened.value.finalizationRepair,
        }
      } catch (error) {
        if (error instanceof ProjectRuntimePreviousCloseError) {
          // B and its fresh lease are already durable/published; this ticket cannot be aborted.
          prepared = undefined
          return {
            success: false,
            project: null,
            requestToken,
            databaseRestored: false,
            dbReady: getProjectDb() !== null,
            activeProjectPath: getCurrentProjectPath(),
            error: String(error),
          }
        }
        let rollbackError: unknown
        if (prepared) {
          try { projectRuntimeHost.abortOpen(prepared) } catch (abortError) { rollbackError = abortError }
          prepared = undefined
        }
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            restoreProjectRollbackBoundary(),
            'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
          )
        } catch (restoreError) {
          rollbackError = restoreError
          databaseState = failedDatabaseState()
        }
        const selectionFailure = projectStoragePreflightFailure(error) ?? projectRootSelectionFailure(error)
        const errorMessage = withRollbackFailure(selectionFailure?.error ?? String(error), rollbackError)
        return {
          success: false,
          project: null,
          requestToken,
          ...databaseState,
          ...(error === superseded ? { stale: true } : {}),
          ...(selectionFailure ?? {}),
          ...(legacyImportSource ? { legacyImportSource } : {}),
          ...(error !== superseded || rollbackError !== undefined ? { error: errorMessage } : {}),
        }
      }
    })
  }
  ipcMain.handle('project:open', createOpenHandler(false))
  ipcMain.handle(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, createOpenHandler(true))

  // 保存/更新项目配置
  // 注意：这个接口前端可能还传入许多小说配置字段，需要映射到数据库。
  ipcMain.handle('project:save', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      if (!data.path) return { success: false, error: 'PROJECT_CONTEXT_REQUIRED' }
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      assertExpectedProjectPath(data.path, expectedProjectPath)
      const runtime = assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)

      const coreUpdate: Parameters<typeof ProjectCoreRepository.update>[0] = {}
      if (data.novelConfig) {
        if (data.novelConfig.writingLanguage !== undefined) {
          coreUpdate.writingLanguage = resolveWritingLanguage(data.novelConfig.writingLanguage)
        }
        Object.assign(coreUpdate, {
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...creativeStrategyCoreUpdate(data.novelConfig),
          ...narrativeThreadSettingsCoreUpdate(data.novelConfig),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        })
      }

      if (data.name) {
        coreUpdate.projectName = data.name
      }

      if (data.characterStates !== undefined) {
        coreUpdate.characterStates = data.characterStates
      }

      const db = runtime.database
      db.transaction(() => {
        ProjectCoreRepository.update(coreUpdate, db)
      })()

      // 最近项目是导航便利数据，不属于项目核心提交。写入失败不能把已经
      // 已提交的数据库保存即使被误报为失败，也不能让渲染进程保留过期草稿。
      try {
        registerRecentProject({
          name: data.name ?? ProjectCoreRepository.get(db)?.projectName ?? 'Unknown',
          path: data.path,
          projectId: _projectId,
          updatedAt: new Date().toISOString(),
        })
        return { success: true, recentProjectUpdated: true }
      } catch (recentProjectError) {
        console.warn('[Project] 项目核心数据已保存，但最近项目列表更新失败:', recentProjectError)
        return {
          success: true,
          recentProjectUpdated: false,
          warning: 'PROJECT_RECENT_LIST_UPDATE_FAILED',
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 项目配置更新遵循相同规则。
  ipcMain.handle('project:update-config', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const runtime = assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)
      if (data.novelConfig) {
        ProjectCoreRepository.update({
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...creativeStrategyCoreUpdate(data.novelConfig),
          ...narrativeThreadSettingsCoreUpdate(data.novelConfig),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        }, runtime.database)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('project:recent-list', async () => {
    revokeRecentPreviewCapabilities()
    return loadRecentProjects().map(project => {
      const capability = projectPeekService.issueCapability(project.path)
      if (!capability) return project
      recentPreviewCapabilities.set(capability.capabilityId, project.path)
      return {
        ...project,
        previewCapabilityId: capability.capabilityId,
        projectId: capability.projectId,
      }
    })
  })

  ipcMain.handle('project:peek-overview', async (_event, capabilityId: string) => {
    if (!recentPreviewCapabilities.has(capabilityId)) return { state: 'unavailable' as const }
    return projectPeekService.peek(capabilityId)
  })

  ipcMain.handle('project:overview-current', async (_event, context?: ProjectSessionContext) => {
    try {
      const runtime = projectAccess.assertViewContext(context)
      return projectPeekService.readCurrent(runtime.projectId, runtime.database)
    } catch {
      return { state: 'unavailable' as const }
    }
  })

  ipcMain.handle('project:recent-remove', async (_event, projectPath: string) => {
    try {
      removeRecentProject(projectPath)
      revokeRecentPreviewCapabilities(projectPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(
    'project:delete',
    async (
      _event,
      projectPath: string,
      _legacyProjectId: string,
      _legacySessionLease: string,
      context?: ProjectSessionContext,
    ) => {
    let runtime: ProjectRuntime | undefined
    let resolvedPath: string
    let releaseRestore: (() => void) | undefined
    try {
      runtime = projectAccess.assertViewContext(context)
      resolvedPath = projectAccess.authorizeDeletion({
        projectId: runtime.projectId,
        leaseId: context!.leaseId,
      }, projectPath)
      const live = projectRuntimeHost.getOpenRuntimes()
      if (live.length !== 1 || live[0] !== runtime) throw new Error('PROJECT_RUNTIME_MAINTENANCE_UNAVAILABLE')
      projectRuntimeHost.assertLifecycleAvailable()
      projectRuntimeHost.releaseIdle(runtime)
      releaseRestore = projectRuntimeHost.acquireRestoreOperation()
    } catch (error) {
      const databaseRestored = runtime
        ? runtime.phase === 'open' && projectRuntimeHost.getActiveView() === runtime && getProjectDb() === runtime.database
        : getProjectDb() !== null
      return {
        success: false,
        directoryDeleted: false,
        databaseRestored,
        error: String(error),
      }
    }

    let deletionError: unknown
    try {
      await removeDirectoryWithWindowsRetry(resolvedPath)
    } catch (error) {
      deletionError = error
    } finally {
      releaseRestore()
    }

    const directoryDeleted = !fs.existsSync(resolvedPath)
    if (!directoryDeleted) {
      let prepared: PreparedRuntimeOpen | undefined
      let committed: ProjectRuntime | undefined
      try {
        // The restore interlock is released first. Never replace a winner
        // that obtained the view before this synchronous recovery starts.
        if (projectRuntimeHost.getActiveView() !== null) throw new Error('PROJECT_SESSION_STALE')
        prepared = projectRuntimeHost.prepareOpen({ kind: 'manifest', projectId: runtime.projectId,
          rootPath: runtime.canonicalRoot, storageFormat: 'canonical' })
        committed = projectRuntimeHost.commitOpen(prepared)
        prepared = undefined
        const restored = projectAccess.beginViewSession(committed)
        return { success: false, directoryDeleted: false, databaseRestored: true,
          restoredSession: { projectId: restored.projectId, leaseId: restored.leaseId, projectPath: restored.rootPath },
          error: deletionError ? String(deletionError) : 'PROJECT_DELETE_FAILED' }
      } catch (restoreError) {
        let cleanupError: unknown
        try {
          if (prepared) projectRuntimeHost.abortOpen(prepared)
          else if (committed) projectRuntimeHost.releaseIdle(committed)
        } catch (error) { cleanupError = error }
        if (projectRuntimeHost.getActiveView() === null) projectAccess.invalidateCurrentSession()
        return { success: false, directoryDeleted: false, databaseRestored: false,
          error: withRollbackFailure(withRollbackFailure(deletionError ? String(deletionError) : 'PROJECT_DELETE_FAILED', restoreError), cleanupError) }
      }
    }

    if (projectRuntimeHost.getActiveView() === null) projectAccess.invalidateCurrentSession()
    let bindingCleanupWarning: string | undefined
    try { options.removeDeletedProjectBinding?.(runtime.projectId) } catch {
      bindingCleanupWarning = text('项目目录已删除，但本机云备份绑定暂未清理',
        'The project folder was deleted, but its local cloud backup binding was not cleaned up yet')
    }
    const warnings = [deletionError
      ? text(`项目目录已删除：${String(deletionError)}`, `The project folder was deleted: ${String(deletionError)}`)
      : undefined, bindingCleanupWarning]
    try { removeRecentProject(resolvedPath) } catch (error) {
      warnings.push(text(`项目目录已删除，但最近项目列表更新失败：${String(error)}`,
        `The project folder was deleted, but the recent project list could not be updated: ${String(error)}`))
    }
    const warning = warnings.filter(Boolean).join(text('；', '; '))
    return { success: true, directoryDeleted: true, databaseRestored: false, ...(warning ? { warning } : {}) }
    },
  )

  ipcMain.handle('dialog:select-folder', async (event, purpose: 'project-create' | 'project-open') => {
    if (purpose !== 'project-create' && purpose !== 'project-open') throw new Error('PROJECT_DIRECTORY_GRANT_PURPOSE_INVALID')
    const result = await showOpenDialogInLastDirectory(purpose, {
      properties: ['openDirectory', 'createDirectory'],
      title: purpose === 'project-create'
        ? text('选择项目保存位置', 'Choose where to save the project')
        : text('选择项目目录', 'Choose the project folder'),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return issueDirectoryGrant(event, result.filePaths[0], purpose)
  })
}
