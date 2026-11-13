import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ llm: vi.fn((options: { scheduler?: unknown } = {}) => ({ ...options })),
  generation: vi.fn(), kb: vi.fn(), reference: vi.fn() }))
vi.mock('../../services/app-data-locator', () => ({ assertGlobalDataReady: vi.fn() }))
vi.mock('../llm-controller', () => ({ registerLLMController: mocks.llm }))
vi.mock('../generation-controller', () => ({ registerGenerationController: mocks.generation }))
vi.mock('../kb-controller', () => ({ registerKBController: mocks.kb }))
vi.mock('../reference-knowledge-controller', () => ({ registerReferenceKnowledgeController: mocks.reference }))
vi.mock('../config-controller', () => ({ registerConfigController: vi.fn() }))
vi.mock('../project-controller', () => ({ registerProjectController: vi.fn() }))
vi.mock('../project-archive-controller', () => ({ registerProjectArchiveController: vi.fn() }))
vi.mock('../cloud-backup-controller', () => ({ registerCloudBackupController: vi.fn() }))
vi.mock('../fs-controller', () => ({ registerFSController: vi.fn() }))
vi.mock('../db-controller', () => ({ registerDatabaseController: vi.fn() }))
vi.mock('../import-controller', () => ({ registerImportController: vi.fn() }))
vi.mock('../window-controller', () => ({ registerWindowController: vi.fn() }))
vi.mock('../official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../model-provider-resource-controller', () => ({ registerModelProviderResourceController: vi.fn() }))
vi.mock('../finalization-controller', () => ({ registerFinalizationController: vi.fn() }))
vi.mock('../chapter-lifecycle-controller', () => ({ registerChapterLifecycleController: vi.fn() }))
vi.mock('../external-file-grant-controller', () => ({ registerExternalFileGrantController: vi.fn() }))
vi.mock('../app-data-controller', () => ({ registerAppDataController: vi.fn() }))
vi.mock('../character-avatar-controller', () => ({ registerCharacterAvatarController: vi.fn() }))
vi.mock('../../services/character-asset-service', () => ({ CharacterAssetService: class {} }))
vi.mock('../../services/project-access', () => ({ projectAccess: {} }))
vi.mock('../../services/cloud-project-binding-store', () => ({ CloudProjectBindingStore: class {} }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: {
  registerBusyPredicate: vi.fn(), onBeforeRelease: vi.fn(),
} }))
vi.mock('../../services/knowledge-source-gate', () => ({ isKnowledgeSourceBusy: vi.fn() }))
vi.mock('../../vector-store', () => ({ closeConnection: vi.fn() }))

import { registerIPCHandlers } from '../../ipc-handlers'
import * as scheduling from '../../services/generation-scheduler'

it('composes one real broker into generation, direct LLM, KB and reference entry points', () => {
  const create = vi.spyOn(scheduling, 'createMainNetworkScheduler')
  try {
    registerIPCHandlers()
    expect(create).toHaveBeenCalledOnce()
    expect(mocks.llm).toHaveBeenCalledOnce()
    expect(mocks.generation).toHaveBeenCalledOnce()
    expect(mocks.kb).toHaveBeenCalledOnce()
    expect(mocks.reference).toHaveBeenCalledOnce()
    const direct = mocks.llm.mock.calls[0][0]
    expect(direct?.scheduler).toBeDefined()
    const scheduler = direct!.scheduler
    expect(scheduler).toBe(create.mock.results[0].value)
    expect(mocks.llm.mock.results[0].value.scheduler).toBe(scheduler)
    expect(mocks.generation).toHaveBeenCalledWith(mocks.llm.mock.results[0].value)
    expect(mocks.kb).toHaveBeenCalledWith(undefined, scheduler)
    expect(mocks.reference).toHaveBeenCalledWith(scheduler)
    expect(scheduler).toEqual(expect.objectContaining({ acquireNetwork: expect.any(Function), acquireEmbedding: expect.any(Function) }))
  } finally {
    create.mock.results[0]?.value?.close()
    create.mockRestore()
  }
})
