import { describe, expect, it } from 'vitest'
import { acquireImportRunParentFlight, acquireImportStageFlight, assertImportRunParentFlightCurrent,
  assertImportStageUnmanagedMutationAllowed, hasImportStageFlight, type ImportRunParentFlightToken } from '../import-stage-flight'

describe('import whole-run flight', () => {
  it('holds the database/run fence across all stage handoffs until the parent releases', () => {
    const database = {}, otherDatabase = {}, run = 'fictional-run'
    const parent = acquireImportRunParentFlight(database, run)
    for (const stage of ['knowledge', 'global', 'style', 'blueprints', 'refresh'] as const) {
      expect(() => assertImportStageUnmanagedMutationAllowed(database, run)).toThrow('GENERATION_OWNER_BUSY')
      expect(() => acquireImportStageFlight(database, run, stage)).toThrow('GENERATION_OWNER_BUSY')
      const release = acquireImportStageFlight(database, run, stage, parent.token)
      expect(() => parent.release()).toThrow('GENERATION_OWNER_BUSY')
      release(); release()
      expect(hasImportStageFlight(database, run)).toBe(true)
      expect(() => assertImportRunParentFlightCurrent(database, run, parent.token)).not.toThrow()
    }
    expect(() => assertImportStageUnmanagedMutationAllowed(database, 'another')).not.toThrow()
    expect(() => assertImportStageUnmanagedMutationAllowed(otherDatabase, run)).not.toThrow()
    parent.release(); parent.release()
    expect(hasImportStageFlight(database, run)).toBe(false)
    expect(() => assertImportRunParentFlightCurrent(database, run, parent.token)).toThrow('GENERATION_OWNER_BUSY')
  })

  it('rejects fabricated, foreign and stale tokens without disturbing a successor', () => {
    const database = {}, otherDatabase = {}, run = 'fictional-run'
    const parent = acquireImportRunParentFlight(database, run)
    const fake = {} as ImportRunParentFlightToken
    for (const [db, id, token] of [[database, run, fake], [database, 'another', parent.token],
      [otherDatabase, run, parent.token]] as const) {
      expect(() => acquireImportStageFlight(db, id, 'global', token)).toThrow('GENERATION_OWNER_BUSY')
    }
    parent.release()
    const successor = acquireImportRunParentFlight(database, run)
    expect(() => acquireImportStageFlight(database, run, 'global', parent.token)).toThrow('GENERATION_OWNER_BUSY')
    parent.release()
    expect(() => assertImportRunParentFlightCurrent(database, run, successor.token)).not.toThrow()
    successor.release()
  })

  it('does not acquire a parent over a legacy active stage', () => {
    const database = {}, run = 'fictional-run'
    const release = acquireImportStageFlight(database, run, 'knowledge')
    expect(() => acquireImportRunParentFlight(database, run)).toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    release()
    const parent = acquireImportRunParentFlight(database, run)
    parent.release()
  })
})
