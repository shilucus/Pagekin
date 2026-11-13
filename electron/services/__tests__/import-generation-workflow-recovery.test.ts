import { afterEach, expect, it, vi } from 'vitest'
import { fenceProjectSession, getCurrentProjectPath } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { importGenerationFixture, openSlot } from './import-generation-fixture'
import { createWorkflowMainGenerationRuntime } from '../../../src/services/workflows/workflow-main-generation'
import { createMainGenerationTransport } from '../../../src/services/generation/main-generation-transport'
import { useProjectStore } from '../../../src/stores/project-store'
import type { WorkflowContext } from '../../../src/stores/workflow-store'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ImportGenerationChannels } from '../../../src/shared/import-generation'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const cleanup: (() => void)[] = []
const originalProject = useProjectStore.getState()
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  useProjectStore.setState(originalProject, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['same-owner', 'recovered-owner'] as const)('actual workflow reuses an unknown import receipt without begin or resend: %s', async recovery => {
  const f = importGenerationFixture(cleanup, 1, async () => { throw new Error('NETWORK_ERROR') })
  const slot = { runId: '长篇导入', stage: 'global' as const, batchId: 'done' }
  let execution = ImportRunRepository.startOrResume(slot.runId, '合成执行器').execution
  const handle = openSlot(f, slot, execution)
  const task = { purpose: 'import-global', output: 'structured-data' as const, messages: [{ role: 'user' as const, content: '推演参考小说' }] }
  const original = await f.owner.executeImportGeneration({ handle, execution, ordinal: 0, task })
  expect(original.outcome.status).toBe('incomplete')
  let owner = f.owner
  if (recovery === 'recovered-owner') {
    owner.suspendForProjectClose()
    fenceProjectSession(f.db)
    owner = f.openOwner('epoch-2')
    execution = ImportRunRepository.startOrResume(slot.runId, '恢复执行器').execution
  }
  const counts = () => ['generation_roots', 'generation_runs', 'generation_attempts'].map(table => f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get())
  const before = counts()
  const session = { projectId: handle.projectId, leaseId: recovery === 'same-owner' ? handle.epoch : 'epoch-2', projectPath: getCurrentProjectPath()! }
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '合成作品', novelConfig: {} } as never })
  const invoke = vi.fn(async (channel: string, request: unknown, captured: unknown) => {
    expect(captured).toEqual(session)
    if (channel === 'import-generation:read') {
      const input = request as ImportGenerationChannels['import-generation:read']['args'][0]
      return owner.readImportGeneration(input.slot, input.runId)
    }
    if (channel === 'import-generation:execute') return owner.executeImportGeneration(request as ImportGenerationChannels['import-generation:execute']['args'][0])
    if (channel === 'generation:read') return owner.read(request as MainGenerationRunHandle)
    if (channel === 'generation:begin') return owner.begin(request as BeginGenerationRequest)
    throw new Error(`Unexpected workflow channel: ${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  const context: WorkflowContext = { runId: `recovery-${recovery}`, projectPath: session.projectPath, projectSession: session,
    generationModelId: 'synthetic', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', cancelled: false, data: { importRunExecution: execution } }
  const runtime = await createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() },
    selection: { operation: 'import-global-facts', importSlot: slot, importExecution: execution,
      promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], output: 'structured-data' } },
  createMainGenerationTransport(() => session))
  try {
    await runtime.execute(async ({ session: generation }) => {
      const replay = await generation.complete({ ...task, messages: [{ role: 'user', content: '后来重建的模板不得替换原请求' }] })
      expect(replay).toMatchObject({ status: original.outcome.status, finishReason: original.outcome.finishReason,
        receipt: { visibleArtifact: original.outcome.receipt.visibleArtifact, failureCode: 'NETWORK_ERROR' } })
      await expect(generation.complete(task)).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
    })
    expect(context.mainGenerationRunHandle).toEqual(handle)
    expect(context.mainGenerationRootHandle).toEqual(handle)
    expect(context.generationModelId).toBe('synthetic')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')).toEqual([])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'import-generation:execute').map(([, request]) => (request as { ordinal: number }).ordinal)).toEqual([0, 1])
    expect(counts()).toEqual(before)
    expect(f.spy).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.close()
  }
})
