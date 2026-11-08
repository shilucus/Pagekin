import { afterEach, describe, expect, it, vi } from 'vitest'

const rendererModules = [
  '../../../src/services/ipc-client',
  '../../../src/services/prompt-templates',
  '../../../src/services/prompt-catalog',
  '../../../src/stores/project-store',
  '../../../src/stores/workflow-store',
] as const

afterEach(() => {
  for (const module of rendererModules) vi.doUnmock(module)
  vi.resetModules()
})

describe('captured workflow materials main-process dependency boundary', () => {
  it('loads the captured adapters without renderer IPC, stores or the active-session prompt catalog', async () => {
    vi.resetModules()
    for (const module of rendererModules) {
      vi.doMock(module, () => { throw new Error(`RENDERER_DEPENDENCY_IMPORTED:${module}`) })
    }
    expect(typeof window).toBe('undefined')
    const draft = await import('../workflow-batch-materials')
    const review = await import('../workflow-review-materials')
    const referenceImport = await import('../reference-import-materials')
    expect(typeof draft.readWorkflowBatchChapter).toBe('function')
    expect(typeof draft.prepareWorkflowBatchMaterials).toBe('function')
    expect(typeof review.prepareWorkflowReviewMaterials).toBe('function')
    expect(typeof referenceImport.prepareReferenceImportMaterials).toBe('function')
  })
})
