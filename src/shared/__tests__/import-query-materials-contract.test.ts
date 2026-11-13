import { expect, it } from 'vitest'
import { assertImportQueryMaterialsRequest, isImportGenerationChannel } from '../import-generation'

const request = { handle: { projectId: 'fixture-project', epoch: 'fixture-lease', rootActionId: 'fixture-root', runId: 'fixture-run' },
  execution: { owner: 'fixture-owner', epoch: 1 } }

it('allows only the main-issued handle and exact current import execution authority', () => {
  expect(() => assertImportQueryMaterialsRequest(structuredClone(request))).not.toThrow()
  expect(isImportGenerationChannel('import-generation:v1:query-materials')).toBe(true)
  expect(isImportGenerationChannel('import-generation:v2:query-materials')).toBe(false)
})

it.each([
  null, [], { ...request, query: 'renderer-selected query' }, { ...request, budget: 4 },
  { ...request, handle: { ...request.handle, projectPath: 'C:/other-project' } },
  { ...request, handle: { ...request.handle, runId: '' } },
  { ...request, execution: { ...request.execution, epoch: 0 } },
  { ...request, execution: { ...request.execution, epoch: 1.5 } },
  { ...request, execution: { ...request.execution, revision: 1 } },
  { ...request, execution: undefined },
])('rejects an invalid or authority-expanding query request %#', value => {
  expect(() => assertImportQueryMaterialsRequest(value)).toThrow('GENERATION_IMPORT_QUERY_INVALID')
})
