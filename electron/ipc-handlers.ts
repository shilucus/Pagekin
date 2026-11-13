import { assertGlobalDataReady } from './services/app-data-locator'

import { registerConfigController } from './controllers/config-controller'
import { registerProjectController } from './controllers/project-controller'
import { registerProjectArchiveController } from './controllers/project-archive-controller'
import { registerCloudBackupController } from './controllers/cloud-backup-controller'
import { registerFSController } from './controllers/fs-controller'
import { registerLLMController } from './controllers/llm-controller'
import { registerGenerationController } from './controllers/generation-controller'
import { registerDatabaseController } from './controllers/db-controller'
import { registerKBController } from './controllers/kb-controller'
import { registerReferenceKnowledgeController } from './controllers/reference-knowledge-controller'
import { registerImportController } from './controllers/import-controller'
import { registerWindowController } from './controllers/window-controller'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import { registerModelProviderResourceController } from './controllers/model-provider-resource-controller'
import { registerFinalizationController } from './controllers/finalization-controller'
import { registerChapterLifecycleController } from './controllers/chapter-lifecycle-controller'
import { registerExternalFileGrantController } from './controllers/external-file-grant-controller'
import { registerAppDataController } from './controllers/app-data-controller'
import { registerCharacterAvatarController } from './controllers/character-avatar-controller'
import { CharacterAssetService } from './services/character-asset-service'
import { projectAccess } from './services/project-access'
import { CloudProjectBindingStore } from './services/cloud-project-binding-store'
import { projectRuntimeHost } from './services/project-runtime'
import { isKnowledgeSourceBusy } from './services/knowledge-source-gate'
import { closeConnection } from './vector-store'
import { createMainNetworkScheduler } from './services/generation-scheduler'

let runtimeKnowledgeLifecycleInstalled = false

/**
 * 注册所有 IPC 通道 — 在主进程启动时调用
 * (采用多控制器路由模式，解耦各个模块的庞大逻辑)
 */
export function registerIPCHandlers() {
  assertGlobalDataReady()
  if (!runtimeKnowledgeLifecycleInstalled) {
    projectRuntimeHost.registerBusyPredicate(runtime => isKnowledgeSourceBusy(runtime.projectStorageRoot))
    projectRuntimeHost.onBeforeRelease(runtime => closeConnection(runtime.canonicalRoot))
    runtimeKnowledgeLifecycleInstalled = true
  }

  // 挂载控制器路由
  registerWindowController()
  registerOfficialHomepageController()
  registerModelProviderResourceController()
  registerConfigController()
  registerAppDataController()
  const cloudProjectBindings = new CloudProjectBindingStore()
  registerProjectController({
    removeDeletedProjectBinding: projectId => { cloudProjectBindings.removeDeletedProject(projectId) },
  })
  registerProjectArchiveController()
  registerCloudBackupController()
  registerFSController()
  registerExternalFileGrantController()
  const networkScheduler = createMainNetworkScheduler()
  registerGenerationController(registerLLMController({ scheduler: networkScheduler }))
  registerDatabaseController()
  registerCharacterAvatarController({
    resolveService(_event, context) {
      let runtime
      try {
        runtime = projectAccess.assertViewContext(context)
        projectRuntimeHost.assertWorkAvailable(runtime)
      } catch { return null }
      const service = new CharacterAssetService({ projectId: context.projectId, sessionLease: context.leaseId,
        storageRoot: runtime.projectStorageRoot, database: runtime.database })
      service.recordReclaimableOrphans()
      return service
    },
  })
  registerFinalizationController()
  registerChapterLifecycleController()
  registerKBController(undefined, networkScheduler)
  registerReferenceKnowledgeController(networkScheduler)
  registerImportController()

  console.log('[AI Novel IPC] 所有 Controller 已注册完成')
}
