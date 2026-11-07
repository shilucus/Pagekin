import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { PlanningFeedbackRepository } from '../../repositories/planning-feedback-repository'
import { RuntimeFeedbackGrantRepository } from '../../repositories/runtime-feedback-grant-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { probeProjectSqlite } from '../sqlite-project-migration'

const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-feedback-portable-'))
  roots.push(base)
  const root = path.join(base, 'source'), projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-07T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  initProjectDatabase(root)
  getProjectDb()!.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Author outline')").run()
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

describe('runtime feedback grant portable history', () => {
  it('preserves readable grant history but no operation key or execution authority across two new copies', async () => {
    const f = fixture(), db = getProjectDb()!
    const planning = new PlanningFeedbackRepository(db, { projectId: f.projectId, assertCurrent: () => undefined,
      isFrozen: () => false, assertGenerationCurrent: () => undefined, now: () => 100 })
    const base = planning.captureBase('coreOutline'), generation = new GenerationRunRepository(() => db, () => 100)
    const grantIds = [randomUUID(), randomUUID(), randomUUID()]
    const operationKeys = [randomUUID(), `portable-history:${grantIds[0]}`, 'portable-temporary:0']
    const requestHash = hash(JSON.stringify({ schemaVersion: 1, projectId: f.projectId, target: 'coreOutline',
      baseId: base.baseId, parentCandidateId: null, feedback: 'Retain author promise', constraints: [] }))
    const proof = hash('private-machine-model-skill-source-proof')
    const fingerprint = { chapterBriefHash: proof, authorGuidanceHash: proof, dependencyHash: proof,
      contextSnapshotHash: proof, templateHash: proof, skillSnapshotHash: proof, modelLeaseRevision: proof,
      policyHash: proof, outputContractHash: proof }
    const runIds: string[] = []
    for (const [index, state] of ['active', 'completed', 'revoked'].entries()) {
      const run = generation.open({ projectId: f.projectId, epoch: 'private-original-runtime-epoch',
        operation: 'planning-feedback', uiActionNonce: `private-ui-${index}`, frozenInputHash: proof,
        fingerprint, contextSnapshotId: `private-context-${index}`, sourceRefs: [],
        sourceManifest: { operation: 'planning-feedback' },
        budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
      runIds.push(run.runId)
      const candidateId = state === 'completed' ? 'completed-readable-candidate' : null
      if (candidateId) db.prepare(`INSERT INTO planning_feedback_candidates
        (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,
         feedback,constraints_json,origin_json,created_at) VALUES(?,1,?,?,NULL,?,?,?,?,?,?,100)`)
        .run(candidateId, f.projectId, base.baseId, base.valueHash, 'Readable proposed outline', hash('Readable proposed outline'),
          'Retain author promise', '[]', JSON.stringify({ kind: 'generated', runId: run.runId,
            attemptId: 'historical-attempt', artifactId: 'historical-artifact', modelLeaseRevision: proof,
            skillSnapshotHash: proof, contextSnapshotHash: proof }))
      db.prepare(`INSERT INTO runtime_feedback_grants
        (grant_id,operation_key,project_id,revision,action,target,base_id,parent_candidate_id,run_id,request_hash,state,
         candidate_id,decision_source,created_at,revoked_at)
        VALUES(?,?,?,?,'planning-feedback-candidate','coreOutline',?,NULL,?,?,?,?,'author-action',100,?)`)
        .run(grantIds[index], operationKeys[index], f.projectId, state === 'revoked' ? 2 : 1,
          base.baseId, run.runId, requestHash, state, candidateId, state === 'revoked' ? 200 : null)
    }
    const originalRows = db.prepare('SELECT * FROM runtime_feedback_grants ORDER BY grant_id').all() as Array<Record<string, unknown>>
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (const index of [1, 2]) {
      closeProjectDatabase()
      const sourcePath = path.join(sourceRoot, '.ai-novel', 'project.db'), sourceBytes = fs.readFileSync(sourcePath)
      const attemptParentPath = path.join(f.base, `attempt-${index}`)
      fs.mkdirSync(attemptParentPath)
      const archivePath = path.join(f.base, `generation-${index}.ainovel`)
      const exported = await exportPortableProject({ sourceProjectRoot: sourceRoot,
        projectSession: { projectId: sourceProjectId, projectPath: sourceRoot, leaseId: `lease-${index}` },
        targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => undefined,
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      expect(exported.sourceEvidence.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
      const sourceEvidence = probeProjectSqlite({ databasePath: sourcePath })
      expect(sourceEvidence.assetMigrationDomain?.tableCounts.runtime_feedback_grants).toBe(3)
      expect(sourceEvidence.preGrantsDomain?.tableCounts.runtime_feedback_grants).toBeUndefined()
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes)
      const target = path.join(f.base, `restored-${index}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
      expect(restored.targetProjectId).not.toBe(sourceProjectId)
      expect(restored.targetProjectId).not.toBe(f.projectId)
      initProjectDatabase(target)
      const copied = getProjectDb()!, guard = readPortableRuntimeFreeze(target)
      const grants = new RuntimeFeedbackGrantRepository(copied, { projectId: restored.targetProjectId,
        assertCurrent: () => undefined, isFrozen: id => guard.isFrozen('runtime_feedback_grants', id) })
      const rows = copied.prepare('SELECT * FROM runtime_feedback_grants ORDER BY grant_id').all() as Array<Record<string, unknown>>
      expect(rows).toEqual(originalRows.map(row => ({ ...row, operation_key: `portable-history:${row.grant_id}` })))
      const freezeBytes = fs.readFileSync(path.join(target, '.ai-novel', 'portable-runtime-freeze.json'), 'utf8')
      const frozenRecords = JSON.parse(freezeBytes).records as Array<Record<string, unknown>>
      for (const row of rows) {
        const id = row.grant_id as string
        expect(guard.isFrozen('runtime_feedback_grants', id)).toBe(true)
        expect(grants.get(id)).toMatchObject({ grantId: id, projectId: f.projectId, state: row.state })
        const ref = { grantId: id, revision: row.revision as number, runId: row.run_id as string }
        expect(() => copied.transaction(() => grants.assertActive(ref))()).toThrow('RUNTIME_FEEDBACK_GRANT_HISTORY_FROZEN')
        expect(() => grants.revoke(ref)).toThrow('RUNTIME_FEEDBACK_GRANT_HISTORY_FROZEN')
        expect(() => grants.withCandidateCommit(ref, () => { throw new Error('must-not-execute') }))
          .toThrow('RUNTIME_FEEDBACK_GRANT_HISTORY_FROZEN')
        expect(() => guard.assertMutable('runtime_feedback_grants', id)).toThrow('PORTABLE_RUNTIME_FROZEN')
        expect(frozenRecords.find(record => record.table === 'runtime_feedback_grants' && record.recordId === id))
          .toMatchObject({ projectionId: `history:runtime_feedback_grants:${id}`, terminalState: row.state,
            projection: {}, excludedFields: [],
            nonReplayable: true, originalReceiptVerified: false })
      }
      for (const runId of runIds) expect(guard.isFrozen('generation_runs', runId)).toBe(true)
      const history = new PlanningFeedbackRepository(copied, { projectId: restored.targetProjectId,
        assertCurrent: () => undefined, isFrozen: (table, id) => guard.isFrozen(table, id),
        assertGenerationCurrent: () => undefined, now: () => 100 })
      expect(history.getCandidate('completed-readable-candidate').text).toBe('Readable proposed outline')
      expect(history.candidateState('completed-readable-candidate')).toBe('frozen')
      const portableBytes = Buffer.concat([fs.readFileSync(path.join(target, '.ai-novel', 'project.db')), Buffer.from(freezeBytes)])
      expect(portableBytes.includes(Buffer.from(operationKeys[0]!))).toBe(false)
      expect(portableBytes.includes(Buffer.from(proof))).toBe(false)
      expect(portableBytes.includes(Buffer.from('private-original-runtime-epoch'))).toBe(false)
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
    const restoredDatabase = getProjectDb()!
    closeProjectDatabase()
    expect(restoredDatabase.open).toBe(false)
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT * FROM runtime_feedback_grants ORDER BY grant_id').all()).toEqual(originalRows)
  })

  it.each(['table', 'column'] as const)('refuses an unclassified runtime grant %s before mutation', mode => {
    const f = fixture(), db = getProjectDb()!
    if (mode === 'column') db.exec('ALTER TABLE runtime_feedback_grants ADD COLUMN future_authority TEXT')
    else db.exec('CREATE TABLE future_runtime_authority (secret TEXT)')
    closeProjectDatabase()
    const before = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })
})
