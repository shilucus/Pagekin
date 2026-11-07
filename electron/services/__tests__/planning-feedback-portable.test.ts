import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import type Sqlite from 'better-sqlite3'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import type { PlanningFeedbackBase } from '../../../src/shared/planning-feedback'
import { PlanningFeedbackRepository } from '../../repositories/planning-feedback-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { PlanningFeedbackService } from '../planning-feedback-service'
import { buildPlanningFeedbackTask } from '../planning-feedback-generation'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { createPortableTransferAuthority, serializePortableTransferAuthority } from '../portable-transfer-authority'
import { writePortableProjectArchive } from '../portable-project-archive'
import type { PortableProjectManifestEntry } from '../portable-project-format'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof Sqlite
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const modelHash = 'a'.repeat(64), skillHash = 'b'.repeat(64), contextHash = 'c'.repeat(64)
const originalNonce = 'private-original-adoption-nonce'

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-feedback-portable-'))
  roots.push(base)
  const root = path.join(base, 'source'), projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-07T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  initProjectDatabase(root)
  getProjectDb()!.prepare("INSERT INTO project_core(id,core_outline,world_setting) VALUES('main','F0 outline','F0 world')").run()
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

function repository(root: string, projectId: string): PlanningFeedbackRepository {
  const guard = readPortableRuntimeFreeze(root)
  return new PlanningFeedbackRepository(getProjectDb()!, { projectId, assertCurrent: () => undefined,
    isFrozen: (table, id) => guard.isFrozen(table, id), assertGenerationCurrent: () => undefined, now: () => 100 })
}

function candidate(db: Sqlite.Database, base: PlanningFeedbackBase, id: string, text: string,
  parent: { id: string; text: string } | null = null): void {
  db.prepare(`INSERT INTO planning_feedback_candidates
    (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,feedback,constraints_json,origin_json,created_at)
    VALUES(?,1,?,?,?,?,?,?,?,?,?,100)`).run(id, base.projectId, base.baseId, parent?.id ?? null,
    parent ? hash(parent.text) : base.valueHash, text, hash(text), 'retain the premise', JSON.stringify(['keep the lead']),
    JSON.stringify({ kind: 'generated', runId: `run-${id}`, attemptId: `attempt-${id}`, artifactId: `artifact-${id}`,
      modelLeaseRevision: modelHash, skillSnapshotHash: skillHash, contextSnapshotHash: contextHash }))
}

async function archive(base: string, root: string, projectId: string, name: string): Promise<string> {
  closeProjectDatabase()
  const attemptParentPath = path.join(base, `attempts-${name}`)
  fs.mkdirSync(attemptParentPath)
  const targetArchivePath = path.join(base, `${name}.ainovel`)
  const receipt = await exportPortableProject({ sourceProjectRoot: root,
    projectSession: { projectId, projectPath: root, leaseId: `lease-${name}` }, targetArchivePath, attemptParentPath,
    assertCurrentContext: () => undefined, assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
  expect(receipt.sourceEvidence.schemaVersion).toBe(9)
  return targetArchivePath
}

describe('planning feedback portable history', () => {
  it('projects a real settled planning ledger and its mixed main proof without retaining request capabilities on either copy', async () => {
    const f = fixture(), db = getProjectDb()!
    const planning = new PlanningFeedbackService({ database: db, projectId: f.projectId, projectPath: f.root,
      assertCurrent: () => undefined, assertGenerationBindingCurrent: () => undefined })
    const base = planning.captureBase('coreOutline')
    const input = { baseId: base.baseId, feedback: 'Keep the main promise', constraints: ['Keep the lead'] }
    const { context } = planning.prepare(input), skill = 'synthetic-planning-skill-proof-only'
    const task = buildPlanningFeedbackTask(context, skill)
    const contextProofHash = hash(JSON.stringify(context)), inputProofHash = hash(JSON.stringify(input)), taskProofHash = hash(JSON.stringify(task))
    const policyHash = hash('synthetic-provider-policy-proof'), frozenInputHash = hash('synthetic-whole-frozen-input')
    const fingerprint = { chapterBriefHash: hash('brief-proof'), authorGuidanceHash: hash('guidance-proof'),
      dependencyHash: hash('dependency-proof'), contextSnapshotHash: contextProofHash, templateHash: hash('template-proof'),
      skillSnapshotHash: skillHash, modelLeaseRevision: modelHash, policyHash, outputContractHash: hash('output-proof') }
    const generation = new GenerationRunRepository(() => db, () => 100)
    const uiNonce = 'synthetic-original-planning-ui-nonce', invocationNonce = 'portable-temporary:0'
    const openRequest = { projectId: f.projectId, epoch: 'synthetic-main-lease', operation: 'planning-feedback',
      uiActionNonce: uiNonce, frozenInputHash, fingerprint, contextSnapshotId: 'synthetic-planning-context', sourceRefs: [],
      sourceManifest: { operation: 'planning-feedback', planningFeedbackInput: input, planningFeedbackInputHash: inputProofHash,
        planningFeedbackContext: context, planningFeedbackContextHash: contextProofHash, planningFeedbackTask: task,
        planningFeedbackTaskHash: taskProofHash, planningFeedbackSkillText: skill },
      budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } }
    const run = generation.open(openRequest)
    const policy = { estimatorVersion: 'fixture-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
    const requestHash = hash(JSON.stringify([task, modelHash, policyHash]))
    const reserved = generation.reserve(run.runId, invocationNonce, requestHash, 200, 100, policy, 'planning-feedback', task)
    generation.markDispatched(reserved.attempt.attemptId)
    const visible = generation.snapshot(reserved.attempt.attemptId, 0, 'Candidate from settled planning ledger')
    const receipt = generation.settle(reserved.attempt.attemptId, { policy, trusted: true, actualTokens: 50,
      inputTokens: 25, completionTokens: 25 }, 'stop')
    expect(receipt.attempt.status).toBe('settled')
    const staged = planning.stage({ ...input, runId: run.runId, attemptId: receipt.attempt.attemptId, artifactId: visible.artifactId })
    expect(planning.getCandidate(staged.candidateId).origin).toMatchObject({ kind: 'generated', runId: run.runId })
    generation.open({ ...openRequest, uiActionNonce: `${uiNonce}-child`, parentRootActionId: run.rootActionId })
    const other = generation.open({ ...openRequest, uiActionNonce: `${uiNonce}-other` })
    const extraAttempts = [run, other].map((extra, index) => {
      const nonce = index === 0 ? `portable-history:${receipt.attempt.attemptId}` : `${invocationNonce}-${index}`
      const pending = generation.reserve(extra.runId, nonce, requestHash, 200, 100, policy, 'planning-feedback', task)
      generation.markDispatched(pending.attempt.attemptId)
      generation.snapshot(pending.attempt.attemptId, 0, `Extra readable candidate ${index}`)
      return generation.settle(pending.attempt.attemptId, index === 0 ? null : { policy, trusted: true, actualTokens: 50 },
        index === 0 ? 'error' : 'stop')
    })
    expect(extraAttempts[0]!.attempt.status).toBe('unknown')
    const budgets = db.prepare('SELECT root_action_id,budget_json FROM generation_roots ORDER BY root_action_id').all()
    const rootKey = db.prepare('SELECT idempotency_key FROM generation_roots WHERE root_action_id=?').pluck().get(run.rootActionId) as string
    const openKey = db.prepare('SELECT open_key FROM generation_runs WHERE run_id=?').pluck().get(run.runId) as string
    let sourceRoot = f.root
    let sourceProjectId: string = f.projectId
    for (const index of [1, 2]) {
      closeProjectDatabase()
      const sourceDatabasePath = path.join(sourceRoot, '.ai-novel', 'project.db'), before = fs.readFileSync(sourceDatabasePath)
      const archivePath = await archive(f.base, sourceRoot, sourceProjectId, `proof-${index}`)
      expect(fs.readFileSync(sourceDatabasePath)).toEqual(before)
      const target = path.join(f.base, `proof-restored-${index}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
      initProjectDatabase(target)
      const copied = getProjectDb()!
      expect(copied.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.runId)).toBe('{}')
      expect(copied.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(receipt.attempt.attemptId)).toBeNull()
      const artifact = JSON.parse(copied.prepare('SELECT artifact_json FROM generation_artifacts WHERE artifact_id=?')
        .pluck().get(visible.artifactId) as string)
      expect(artifact).toEqual({ artifactId: visible.artifactId, attemptId: receipt.attempt.attemptId,
        rootActionId: run.rootActionId, revision: visible.revision, text: visible.text, textHash: visible.textHash })
      expect(repository(target, restored.targetProjectId).getCandidate(staged.candidateId)).toMatchObject({ text: visible.text,
        feedback: input.feedback, constraints: input.constraints, origin: { kind: 'portable-history', sourceKind: 'generated',
          runId: run.runId, attemptId: receipt.attempt.attemptId, artifactId: visible.artifactId } })
      const serialized = JSON.stringify({ roots: copied.prepare('SELECT * FROM generation_roots').all(),
        runs: copied.prepare('SELECT * FROM generation_runs').all(), attempts: copied.prepare('SELECT * FROM generation_attempts').all(),
        artifacts: copied.prepare('SELECT * FROM generation_artifacts').all(), candidates: copied.prepare('SELECT * FROM planning_feedback_candidates').all() })
      for (const excluded of ['planningFeedbackInput', 'planningFeedbackContext', 'planningFeedbackTask', skill,
        ...Object.values(fingerprint), inputProofHash, taskProofHash, frozenInputHash, requestHash, uiNonce, invocationNonce]) {
        expect(serialized).not.toContain(excluded)
      }
      expect(copied.prepare('SELECT idempotency_key FROM generation_roots WHERE root_action_id=?').pluck().get(run.rootActionId)).not.toBe(rootKey)
      expect(copied.prepare('SELECT open_key FROM generation_runs WHERE run_id=?').pluck().get(run.runId)).not.toBe(openKey)
      const roots = copied.prepare('SELECT root_action_id,idempotency_key FROM generation_roots').all() as Array<{ root_action_id: string; idempotency_key: string }>
      const runs = copied.prepare('SELECT run_id,open_key FROM generation_runs').all() as Array<{ run_id: string; open_key: string }>
      const attempts = copied.prepare('SELECT attempt_id,invocation_nonce FROM generation_attempts').all() as Array<{ attempt_id: string; invocation_nonce: string }>
      expect(roots).toHaveLength(2)
      expect(runs).toHaveLength(3)
      expect(attempts).toHaveLength(3)
      expect(new Set(roots.map(row => row.idempotency_key)).size).toBe(2)
      expect(new Set(runs.map(row => row.open_key)).size).toBe(3)
      expect(new Set(attempts.map(row => row.invocation_nonce)).size).toBe(3)
      for (const row of roots) expect(row.idempotency_key).toBe(`portable-history:${row.root_action_id}`)
      for (const row of runs) expect(row.open_key).toBe(`portable-history:${row.run_id}`)
      for (const row of attempts) expect(row.invocation_nonce).toBe(`portable-history:${row.attempt_id}`)
      expect(copied.prepare('SELECT root_action_id,budget_json FROM generation_roots ORDER BY root_action_id').all()).toEqual(budgets)
      expect(JSON.parse(copied.prepare('SELECT attempt_json FROM generation_attempts WHERE attempt_id=?').pluck()
        .get(extraAttempts[0]!.attempt.attemptId) as string).status).toBe('unknown')
      const guard = readPortableRuntimeFreeze(target)
      expect(guard.isFrozen('generation_roots', run.rootActionId)).toBe(true)
      expect(guard.isFrozen('generation_runs', run.runId)).toBe(true)
      expect(guard.isFrozen('generation_attempts', receipt.attempt.attemptId)).toBe(true)
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
  })

  it('moves two real adoption nonces through disjoint temporary keys when one occupies another final history label', async () => {
    const f = fixture(), repo = repository(f.root, f.projectId)
    const firstBase = repo.captureBase('coreOutline')
    candidate(getProjectDb()!, firstBase, 'collision-C1', 'first adopted value')
    const first = repo.adopt({ candidateId: 'collision-C1', idempotencyKey: 'portable-temporary:0',
      decision: 'full', text: 'first adopted value' })
    const secondBase = repo.captureBase('worldSetting')
    candidate(getProjectDb()!, secondBase, 'collision-C2', 'second adopted value')
    const second = repo.adopt({ candidateId: 'collision-C2', idempotencyKey: `portable-history:${first.adoptionId}`,
      decision: 'full', text: 'second adopted value' })
    let sourceRoot = f.root
    let sourceProjectId: string = f.projectId
    for (const index of [1, 2]) {
      closeProjectDatabase()
      const source = path.join(sourceRoot, '.ai-novel', 'project.db'), before = fs.readFileSync(source)
      const archivePath = await archive(f.base, sourceRoot, sourceProjectId, `adoption-collision-${index}`)
      expect(fs.readFileSync(source)).toEqual(before)
      const target = path.join(f.base, `adoption-collision-restored-${index}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
      initProjectDatabase(target)
      const rows = getProjectDb()!.prepare('SELECT adoption_id,idempotency_key,request_hash FROM planning_feedback_adoptions')
        .all() as Array<{ adoption_id: string; idempotency_key: string; request_hash: string }>
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.idempotency_key)).size).toBe(2)
      for (const row of rows) {
        expect(row.idempotency_key).toBe(`portable-history:${row.adoption_id}`)
        expect(row.request_hash).toBe('')
      }
      const history = repository(target, restored.targetProjectId)
      expect(history.listAdoptions(firstBase.baseId)[0]).toMatchObject({ adoptionId: first.adoptionId,
        text: 'first adopted value', decisionSource: 'author-action' })
      expect(history.listAdoptions(secondBase.baseId)[0]).toMatchObject({ adoptionId: second.adoptionId,
        text: 'second adopted value', decisionSource: 'author-action' })
      for (const id of ['collision-C1', 'collision-C2']) expect(history.candidateState(id)).toBe('frozen')
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
  })

  it('restores a schema-8 package with M07 views, migrates empty feedback tables and can export schema 9', async () => {
    const f = fixture()
    closeProjectDatabase()
    const oldDatabasePath = path.join(f.base, 'schema8.db'), db = new Database(oldDatabasePath)
    try {
      db.transaction(() => initializeLegacyBaselineSchema(db))()
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
    } finally { db.close() }
    const databaseBytes = fs.readFileSync(oldDatabasePath)
    const freezeBytes = Buffer.from(JSON.stringify({ version: 1, originProjectId: f.projectId,
      snapshotGeneration: 'schema8-history', nonReplayable: true, requiresRuntimeFreezeGuard: true,
      records: [], avatarReferenceProjections: [] }))
    const source = new Database(oldDatabasePath, { readonly: true })
    let authorityBytes: Buffer
    let receiptId: string
    try {
      const authority = { ...createPortableTransferAuthority({ database: source, originProjectId: f.projectId,
        snapshotGeneration: 'schema8-history', portableDatabaseSha256: hash(databaseBytes) }), sourceSchemaVersion: 8 as const }
      authorityBytes = serializePortableTransferAuthority(authority)
      receiptId = authority.receiptId
    } finally { source.close() }
    const payloads: Array<{ path: string; bytes: Buffer; disposition: PortableProjectManifestEntry['disposition'] }> = [
      { path: 'project.db', bytes: databaseBytes, disposition: 'portable-database' },
      { path: 'portable-runtime-freeze.json', bytes: freezeBytes, disposition: 'history-projection' },
      { path: '.ai-novel/portable-transfer-authority.json', bytes: authorityBytes, disposition: 'transfer-receipt' },
    ]
    const sources = payloads.map((payload, index) => {
      const sourcePath = path.join(f.base, `old-payload-${index}`)
      fs.writeFileSync(sourcePath, payload.bytes)
      return { sourcePath, entry: { path: payload.path, byteSize: payload.bytes.length,
        sha256: hash(payload.bytes), disposition: payload.disposition } }
    })
    const archivePath = path.join(f.base, 'schema8.ainovel'), total = payloads.reduce((sum, item) => sum + item.bytes.length, 0)
    await writePortableProjectArchive({ targetPath: archivePath, sources, manifest: { formatVersion: 1, sourceSchemaVersion: 8,
      originProjectId: f.projectId, snapshotGeneration: 'schema8-history', createdAt: '2026-11-07T00:00:00.000Z',
      declaredUncompressedBytes: total, declaredCompressedBytes: total, entries: sources.map(item => item.entry),
      semanticCounts: {}, omittedItems: [], transferReceiptIds: [receiptId], historyProjectionIds: [] } })
    const target = path.join(f.base, 'schema8-restored')
    const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
    initProjectDatabase(target)
    expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(9)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
    await archive(f.base, target, restored.targetProjectId, 'upgraded-schema8')
  })

  it('preserves readable chains and adoption history, drops mixed proofs, freezes old authority and supports explicit new lineage twice', async () => {
    const f = fixture(), repo = repository(f.root, f.projectId)
    const closed = repo.captureBase('coreOutline')
    candidate(getProjectDb()!, closed, 'C1', 'first candidate')
    candidate(getProjectDb()!, closed, 'C2', 'second candidate', { id: 'C1', text: 'first candidate' })
    const adoption = repo.adopt({ candidateId: 'C2', idempotencyKey: originalNonce, decision: 'full', text: 'second candidate' })
    const open = repo.captureBase('worldSetting')
    candidate(getProjectDb()!, open, 'C3', 'world candidate')
    closeProjectDatabase()
    initProjectDatabase(f.root)
    expect(repository(f.root, f.projectId).listAdoptions(closed.baseId)[0]).toEqual(adoption)
    expect(repository(f.root, f.projectId).candidateState('C3')).toBe('ready')
    const firstArchive = await archive(f.base, f.root, f.projectId, 'first')
    const target = path.join(f.base, 'restored')
    const restored = await restorePortableProject({ archivePath: firstArchive, targetProjectRoot: target })
    expect(restored.targetProjectId).not.toBe(f.projectId)
    initProjectDatabase(target)
    const copied = repository(target, restored.targetProjectId), db = getProjectDb()!
    expect(copied.getCandidate('C2')).toMatchObject({ text: 'second candidate', parentCandidateId: 'C1',
      feedback: 'retain the premise', constraints: ['keep the lead'], origin: { kind: 'portable-history', sourceKind: 'generated' } })
    expect(copied.getBase(open.baseId).value).toBe('F0 world')
    expect(copied.candidateState('C3')).toBe('frozen')
    expect(copied.listAdoptions(closed.baseId)[0]).toMatchObject({ text: 'second candidate', beforeValue: 'F0 outline', decisionSource: 'author-action' })
    expect(db.prepare('SELECT request_hash,idempotency_key FROM planning_feedback_adoptions').get()).toEqual({
      request_hash: '', idempotency_key: `portable-history:${adoption.adoptionId}`,
    })
    const origins = db.prepare('SELECT origin_json FROM planning_feedback_candidates').pluck().all().join('')
    for (const excluded of [modelHash, skillHash, contextHash]) expect(origins).not.toContain(excluded)
    for (const id of ['C2', 'C3']) expect(() => copied.adopt({ candidateId: id, idempotencyKey: originalNonce,
      decision: 'full', text: id === 'C2' ? 'second candidate' : 'world candidate' })).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    const nextBase = copied.captureBase('worldSetting')
    const next = copied.relineageCandidate({ baseId: nextBase.baseId, sourceCandidateId: 'C3', feedback: 'new authorization', constraints: [] })
    expect(next.candidateId).not.toBe('C3')
    copied.adopt({ candidateId: next.candidateId, idempotencyKey: 'fresh-nonce', decision: 'full', text: next.text })
    const secondArchive = await archive(f.base, target, restored.targetProjectId, 'second')
    const twice = path.join(f.base, 'restored-twice')
    const second = await restorePortableProject({ archivePath: secondArchive, targetProjectRoot: twice })
    initProjectDatabase(twice)
    const history = repository(twice, second.targetProjectId)
    expect(history.getCandidate('C2').parentCandidateId).toBe('C1')
    expect(history.candidateState(next.candidateId)).toBe('frozen')
    expect(history.listAdoptions(nextBase.baseId)).toHaveLength(1)
    expect(fs.readFileSync(path.join(twice, '.ai-novel', 'project.db')).includes(Buffer.from(originalNonce))).toBe(false)
  })

  it.each(['origin', 'source'] as const)('rejects an unclassified opaque %s instead of copying or dropping it', mode => {
    const f = fixture(), base = repository(f.root, f.projectId).captureBase('coreOutline')
    candidate(getProjectDb()!, base, 'opaque-candidate', 'readable candidate')
    if (mode === 'origin') getProjectDb()!.prepare('UPDATE planning_feedback_candidates SET origin_json=?')
      .run(JSON.stringify({ kind: 'generated', secretRef: 'not-portable' }))
    else getProjectDb()!.prepare('UPDATE planning_feedback_bases SET source_json=?')
      .run(JSON.stringify({ ...base.source, secretRef: 'not-portable' }))
    closeProjectDatabase()
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_UNSAFE_PROJECTION')
  })
})
