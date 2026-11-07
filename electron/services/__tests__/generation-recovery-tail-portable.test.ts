import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { createProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { GenerationRecoveryTailRepository } from '../../repositories/generation-recovery-tail-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { probeProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const prefix = 'Fictional durable visible prefix.\n'
const tail = 'Fictional visible suffix retained for copying.\n'
const proof = hash('fictional-original-machine-model-skill-source-proof')
const epoch = 'fictional-original-runtime-epoch'
const fingerprint = { chapterBriefHash: proof, authorGuidanceHash: proof, dependencyHash: proof,
  contextSnapshotHash: proof, templateHash: proof, skillSnapshotHash: proof, modelLeaseRevision: proof,
  policyHash: proof, outputContractHash: proof }

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-tail-portable-'))
  roots.push(base)
  const root = path.join(base, 'source'), projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-07T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

function seed(databasePath: string, projectId: string, terminal: 'unknown' | 'settled') {
  const db = new Database(databasePath)
  try {
    db.pragma('foreign_keys = ON')
    db.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')").run()
    const runs = new GenerationRunRepository(() => db, () => 100)
    const run = runs.open({ projectId, epoch, operation: 'planning-feedback', uiActionNonce: 'fictional-original-ui-nonce',
      frozenInputHash: proof, fingerprint, contextSnapshotId: 'fictional-original-context', sourceRefs: [],
      sourceManifest: { operation: 'planning-feedback' },
      budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
    const reserved = runs.reserve(run.runId, 'fictional-original-invocation-nonce', proof, 200, 100)
    runs.markDispatched(reserved.attempt.attemptId)
    const artifact = runs.snapshot(reserved.attempt.attemptId, 0, prefix)
    const receipt = runs.settle(reserved.attempt.attemptId,
      terminal === 'unknown' ? null : { trusted: true, actualTokens: 50, policy: {
        estimatorVersion: 'fictional-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion', canBoundTotalLiability: true,
      } }, terminal === 'unknown' ? 'error' : 'stop')
    expect(receipt.attempt.status).toBe(terminal)
    const originalArtifact = db.prepare('SELECT * FROM generation_artifacts').get()
    const input = { attemptId: receipt.attempt.attemptId, artifactId: artifact.artifactId,
      durableRevision: artifact.revision, prefixHash: artifact.textHash, text: tail }
    new GenerationRecoveryTailRepository(db, runs).preserve(input)
    expect(db.prepare('SELECT * FROM generation_artifacts').get()).toEqual(originalArtifact)
    return { input, runId: run.runId, rootId: run.rootActionId,
      row: db.prepare('SELECT * FROM generation_recovery_tails').get() }
  } finally { db.close() }
}

describe('generation recovery tail portable history', () => {
  it.each(['unknown', 'settled'] as const)('keeps an exact %s tail separate from its durable prefix across two new copies', async terminal => {
    const f = fixture(), source = seed(f.databasePath, f.projectId, terminal)
    const originalBytes = fs.readFileSync(f.databasePath)
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (const generation of [1, 2]) {
      const databasePath = path.join(sourceRoot, '.ai-novel', 'project.db')
      const before = fs.readFileSync(databasePath), archivePath = path.join(f.base, `generation-${generation}.ainovel`)
      const attemptParentPath = path.join(f.base, `attempt-${generation}`)
      fs.mkdirSync(attemptParentPath)
      const exported = await exportPortableProject({ sourceProjectRoot: sourceRoot,
        projectSession: { projectId: sourceProjectId, projectPath: sourceRoot, leaseId: `fictional-lease-${generation}` },
        targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => undefined,
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      expect(exported.sourceEvidence.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(fs.readFileSync(databasePath)).toEqual(before)
      const evidence = probeProjectSqlite({ databasePath })
      expect(evidence.assetMigrationDomain?.tableCounts.generation_recovery_tails).toBe(1)
      expect(evidence.preRecoveryTailsDomain?.tableCounts.generation_recovery_tails).toBeUndefined()
      expect(evidence.preGrantsDomain?.tableCounts.generation_recovery_tails).toBeUndefined()
      const targetRoot = path.join(f.base, `copy-${generation}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: targetRoot })
      expect(restored.targetProjectId).not.toBe(sourceProjectId)
      expect(restored.targetProjectId).not.toBe(f.projectId)
      const copiedPath = path.join(targetRoot, '.ai-novel', 'project.db'), db = new Database(copiedPath)
      try {
        const guard = readPortableRuntimeFreeze(targetRoot)
        const runs = new GenerationRunRepository(() => db, () => 100, (table, id) => guard.isFrozen(table, id))
        const history = new GenerationRecoveryTailRepository(db, runs, (table, id) => guard.isFrozen(table, id))
        expect(db.prepare('SELECT * FROM generation_recovery_tails').get()).toEqual(source.row)
        expect(history.list(source.runId)).toEqual([{
          kind: 'preserved-partial', attemptId: source.input.attemptId, artifactId: source.input.artifactId,
          durableRevision: source.input.durableRevision, durableText: prefix, prefixHash: hash(prefix),
          tailText: tail, tailHash: hash(tail), preservedAt: expect.any(String),
        }])
        const artifact = JSON.parse(db.prepare('SELECT artifact_json FROM generation_artifacts WHERE artifact_id=?')
          .pluck().get(source.input.artifactId) as string)
        expect(artifact).toMatchObject({ text: prefix, textHash: hash(prefix), revision: source.input.durableRevision })
        expect(artifact.text).not.toContain(tail)
        const attempt = JSON.parse(db.prepare('SELECT attempt_json FROM generation_attempts WHERE attempt_id=?')
          .pluck().get(source.input.attemptId) as string)
        expect(attempt.status).toBe(terminal)
        expect(runs.listCandidates(source.runId)).toEqual([])
        expect(guard.isFrozen('generation_roots', source.rootId)).toBe(true)
        expect(guard.isFrozen('generation_runs', source.runId)).toBe(true)
        expect(guard.isFrozen('generation_attempts', source.input.attemptId)).toBe(true)
        expect(guard.isFrozen('generation_recovery_tails', source.input.attemptId)).toBe(true)
        expect(() => guard.assertMutable('generation_recovery_tails', source.input.attemptId)).toThrow('PORTABLE_RUNTIME_FROZEN')
        expect(() => history.preserve(source.input)).toThrow('GENERATION_RECOVERY_TAIL_READ_ONLY')
        const freezeBytes = fs.readFileSync(path.join(targetRoot, '.ai-novel', 'portable-runtime-freeze.json'), 'utf8')
        const records = JSON.parse(freezeBytes).records as Array<Record<string, unknown>>
        expect(records.find(record => record.table === 'generation_recovery_tails')).toMatchObject({
          projectionId: `history:generation_recovery_tails:${source.input.attemptId}`,
          recordId: source.input.attemptId, terminalState: 'historical', projection: {}, excludedFields: [],
          nonReplayable: true, originalReceiptVerified: false,
        })
        const bytes = Buffer.concat([fs.readFileSync(copiedPath), Buffer.from(freezeBytes)])
        for (const excluded of [proof, epoch, 'fictional-original-ui-nonce', 'fictional-original-invocation-nonce']) {
          expect(bytes.includes(Buffer.from(excluded))).toBe(false)
        }
      } finally { db.close() }
      sourceRoot = targetRoot
      sourceProjectId = restored.targetProjectId
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(originalBytes)
  })

  it.each(['unknown-column', 'tail-hash', 'prefix-hash'] as const)('rejects %s before sanitizing any source history', mode => {
    const f = fixture()
    seed(f.databasePath, f.projectId, 'unknown')
    const db = new Database(f.databasePath)
    try {
      if (mode === 'unknown-column') db.exec('ALTER TABLE generation_recovery_tails ADD COLUMN future_owner_capability TEXT')
      else db.prepare(`UPDATE generation_recovery_tails SET ${mode === 'tail-hash' ? 'tail_hash' : 'prefix_hash'}=?`).run(hash('wrong content'))
    } finally { db.close() }
    const original = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  })
})
