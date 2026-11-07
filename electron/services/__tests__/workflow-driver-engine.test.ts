import { describe, expect, it, vi } from 'vitest'
import { runWorkflowDriver, type WorkflowDriverEngineOptions } from '../workflow-driver-engine'

describe('workflow driver receipt reconciliation', () => {
  it('does not dispatch an already bound model step with an unresolved receipt', async () => {
    const execute = vi.fn()
    const input = { kind: 'model', task: { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [] } }
    const ref = { taskId: 'task', revision: 1, runId: 'run' }
    const options = {
      database: { transaction: (fn: () => void) => ({ immediate: fn }) },
      repository: {
        assertActive: vi.fn(),
        readSteps: () => [{ stepId: 'outline', taskId: 'task', ordinal: 0, kind: 'outline', input }],
        acknowledgeFromReceipt: () => { throw new Error('WORKFLOW_DRIVER_RECEIPT_NOT_COMMITTED') },
      },
      runs: {}, owner: { executeWorkflowDriver: execute },
      handle: { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' },
      ref, assertActive: vi.fn(), withKnowledge: vi.fn(),
    } as unknown as WorkflowDriverEngineOptions
    await expect(runWorkflowDriver(options)).rejects.toThrow('WORKFLOW_DRIVER_RECEIPT_NOT_COMMITTED')
    expect(execute).not.toHaveBeenCalled()
  })
  it('checks active authority before reading or issuing the next effect', async () => {
    const acknowledge = vi.fn(), execute = vi.fn()
    const options = {
      database: { transaction: (fn: () => void) => ({ immediate: fn }) },
      repository: { readSteps: () => [{ stepId: 'outline', input: null }], acknowledgeFromReceipt: acknowledge },
      runs: {}, owner: { executeWorkflowDriver: execute },
      handle: { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' },
      ref: { taskId: 'task', revision: 1, runId: 'run' },
      assertActive: () => { throw new Error('WORKFLOW_DRIVER_REVOKED') }, withKnowledge: vi.fn(),
    } as unknown as WorkflowDriverEngineOptions
    await expect(runWorkflowDriver(options)).rejects.toThrow('WORKFLOW_DRIVER_REVOKED')
    expect(acknowledge).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
