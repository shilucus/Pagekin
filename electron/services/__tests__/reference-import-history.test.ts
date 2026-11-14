import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportRunEffectReceipt, ImportRunSnapshot } from '../../../src/shared/import-run'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { ProjectRuntime } from '../project-runtime'
import { assertReferenceImportSkippedHistory } from '../reference-import-history'

const RUN = 'fixture-run'

function range(start: number, end: number): ImportRunEffectReceipt {
  const batchId = `${start}-${end}-${Array.from({ length: end - start + 1 }, () => 'aaaaaaaa').join('.')}`
  return { runId: RUN, stage: 'blueprints', batchId, state: 'committed', kind: 'chapter-blueprint-range',
    payload: { mode: 'replace-range', operationId: `import-blueprints-${RUN}-${start}-${end}`,
      startChapter: start, endChapter: end, blueprints: Array.from({ length: end - start + 1 }, () => ({})),
      generationRunHandle: {} } } as unknown as ImportRunEffectReceipt
}

function harness() {
  const history: ImportRunEffectReceipt[] = []
  let batches: string[] = []
  let unknown = false
  const write = vi.fn(() => { throw new Error('unexpected write') })
  const database = { prepare: vi.fn((sql: string) => ({
    pluck: () => ({ get: () => 1 }),
    get: () => sql.includes("state='unknown'") && unknown ? { found: 1 } : undefined,
    all: () => history.map(receipt => ({ batch_id: receipt.batchId })),
    run: write,
  })) }
  const runtime = { database, projectId: 'fixture', canonicalRoot: 'fixture' } as unknown as ProjectRuntime
  const snapshot = () => ({ purpose: 'reference', status: 'running', stage: 'refresh',
    completedBatches: { blueprints: batches } }) as unknown as ImportRunSnapshot
  vi.spyOn(ImportRunRepository, 'get').mockImplementation(snapshot)
  const getReceipt = vi.spyOn(ImportRunRepository, 'getEffectReceipt').mockImplementation((_runId, stage, batchId) =>
    stage === 'blueprints' ? history.find(receipt => receipt.batchId === batchId) ?? null : null)
  vi.spyOn(BlueprintRepository, 'getCommittedRangeOperation').mockImplementation(operationId => {
    const receipt = history.find(item => (item.payload as { operationId: string }).operationId === operationId)
    if (!receipt) return null
    const payload = receipt.payload as { startChapter: number; endChapter: number }
    const chapterNumbers = Array.from({ length: payload.endChapter - payload.startChapter + 1 }, (_, index) => payload.startChapter + index)
    return { operationId, startChapter: payload.startChapter, endChapter: payload.endChapter,
      chapterNumbers, snapshot: chapterNumbers.map(() => ({})) } as unknown as ReturnType<typeof BlueprintRepository.getCommittedRangeOperation>
  })
  return { runtime, history, getReceipt, write, setBatches: (value: string[]) => { batches = value }, setUnknown: () => { unknown = true } }
}

afterEach(() => vi.restoreAllMocks())

describe('skipped reference history', () => {
  it('rejects missing or corrupt style history without writing', () => {
    const h = harness()
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'style')).toThrow('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    h.getReceipt.mockImplementation(() => { throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID') })
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'style')).toThrow('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    expect(h.write).not.toHaveBeenCalled()
  })

  it('rejects legacy global unknown before reading a receipt', () => {
    const h = harness()
    h.setUnknown()
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'global')).toThrow('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
    expect(h.getReceipt).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })

  it('rejects unknown, invalid, and unlisted blueprint history', () => {
    const h = harness()
    h.setUnknown()
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'blueprints')).toThrow('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
    vi.restoreAllMocks()
    const invalid = harness()
    invalid.history.push({ batchId: 'invalid' } as unknown as ImportRunEffectReceipt)
    expect(() => assertReferenceImportSkippedHistory(invalid.runtime, RUN, 'blueprints')).toThrow('IMPORT_RUN_CHECKPOINT_CORRUPT')
    invalid.history.splice(0, 1, range(1, 1))
    expect(() => assertReferenceImportSkippedHistory(invalid.runtime, RUN, 'blueprints')).toThrow('IMPORT_RUN_EFFECT_LEDGER_MISMATCH')
    invalid.setBatches(['1-1-aaaaaaaa', '2-2-aaaaaaaa'])
    expect(() => assertReferenceImportSkippedHistory(invalid.runtime, RUN, 'blueprints')).toThrow('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    expect(invalid.write).not.toHaveBeenCalled()
  })

  it('rejects overlapping committed blueprint ranges and accepts coherent history', () => {
    const h = harness()
    h.history.push(range(1, 2), range(2, 3))
    h.setBatches(h.history.map(receipt => receipt.batchId))
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'blueprints')).toThrow('IMPORT_RUN_CHECKPOINT_CORRUPT')
    h.history.splice(1, 1, range(3, 3))
    h.setBatches(h.history.map(receipt => receipt.batchId))
    expect(() => assertReferenceImportSkippedHistory(h.runtime, RUN, 'blueprints')).not.toThrow()
    expect(h.write).not.toHaveBeenCalled()
  })
})
