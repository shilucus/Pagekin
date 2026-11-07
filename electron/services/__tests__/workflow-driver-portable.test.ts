import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { WorkflowDriverRepository, type WorkflowDriverTaskRef } from '../../repositories/workflow-driver-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseWorkflowDriverRecipe, type WorkflowDriverState } from '../../../src/shared/workflow-driver-contract'
import { draftShortOutlineBlock, DRAFT_SHORT_OUTLINE_PURPOSE } from '../../../src/shared/draft-short-outline'
import { DRAFT_VISIBLE_TEXT_VERSION } from '../../../src/shared/draft-visible-text'
import { GenerationDraftEffects } from '../generation-draft-effects'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { probeProjectSqlite } from '../sqlite-project-migration'
import type { ProjectRuntime } from '../project-runtime'
import { readWorkflowDriverReceipt } from '../workflow-driver-authority'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const proof = hash('fictional-original-machine-model-source-skill-identity')
const epoch = 'fictional-original-workflow-epoch'
const outline = 'Fictional chapter plan: find the brass key.'
const body = 'The fictional writer found a brass key beside the door and kept it for the next morning.'
const recipe = parseWorkflowDriverRecipe({ schemaVersion: 1, writingLanguage: 'en-US',
  outlineTask: { purpose: DRAFT_SHORT_OUTLINE_PURPOSE, output: 'visible-text', reasoningStage: 'planning',
    messages: [{ role: 'user', content: 'Plan a fictional first chapter.' }] },
  baseDraftTask: { purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting',
    messages: [{ role: 'user', content: 'Write a fictional first chapter.' }] } })

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-driver-portable-'))
  roots.push(base)
  const root = path.join(base, 'source'), projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-07T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

function seed(databasePath: string, projectId: string, state: WorkflowDriverState) {
  const db = new Database(databasePath)
  try {
    db.pragma('foreign_keys=ON')
    db.prepare("INSERT OR IGNORE INTO project_core(id,core_outline) VALUES('main','Fictional author outline')").run()
    db.prepare("UPDATE project_core SET writing_language='en-US' WHERE id='main'").run()
    const runs = new GenerationRunRepository(() => db, () => 100)
    const run = runs.open({ projectId, epoch, operation: 'chapter-draft', uiActionNonce: randomUUID(), frozenInputHash: proof,
      fingerprint: { chapterBriefHash: proof, authorGuidanceHash: proof, dependencyHash: proof, contextSnapshotHash: proof,
        templateHash: proof, skillSnapshotHash: proof, modelLeaseRevision: proof, policyHash: proof, outputContractHash: proof },
      contextSnapshotId: 'fictional-original-workflow-context', sourceRefs: [], sourceManifest: { operation: 'chapter-draft',
        chapterNumber: 1, outputContract: 'visible-text', freezeWritingLanguage: true, writingLanguage: 'en-US',
        authorInputs: [{ id: 'draft:target-units', text: '1' }],
        materialDecision: { version: 1, verdict: 'admitted', shortOutlinePromptHash: hash(recipe.outlineTask.messages[0]!.content),
          promptHash: hash(recipe.baseDraftTask.messages[0]!.content) } },
      budget: { maxPhysicalRequests: 4, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
    const history = new WorkflowDriverRepository(db, { projectId, assertCurrent: () => undefined, isFrozen: () => false, now: () => 100 })
    const operationKey = randomUUID(), requestHash = hash(randomUUID())
    const task = history.issue({ taskId: randomUUID(), operationKey, requestHash, runId: run.runId, recipe })
    const ref: WorkflowDriverTaskRef = { taskId: task.taskId, revision: task.revision, runId: task.runId }
    const steps = history.readSteps(task.taskId), outlineStep = steps[0]!, draftStep = steps[1]!
    if (state !== 'ready') {
      history.bindInput(ref, outlineStep.stepId, { kind: 'model', task: recipe.outlineTask })
      const requestHash = hash(JSON.stringify([recipe.outlineTask, proof, proof]))
      const reserved = runs.reserve(run.runId, outlineStep.invocationNonce!, requestHash, 200, 100,
        undefined, recipe.outlineTask.purpose, recipe.outlineTask)
      runs.markDispatched(reserved.attempt.attemptId)
      runs.snapshot(reserved.attempt.attemptId, 0, outline)
      runs.settle(reserved.attempt.attemptId, state === 'blocked' ? null : { trusted: true, actualTokens: 10, policy: {
        estimatorVersion: 'fictional-v1', safetyMarginTokens: 0, reasoning: 'included-in-completion', canBoundTotalLiability: true,
      } }, state === 'blocked' ? 'error' : 'stop')
      if (state === 'blocked') history.block(ref, 'GENERATION_RESULT_UNKNOWN')
      else {
        history.acknowledgeFromReceipt(ref, outlineStep.stepId)
        if (state === 'paused') history.pause(ref)
        else if (state === 'cancelled') history.cancel(ref)
        else {
          const task = { ...recipe.baseDraftTask, messages: recipe.baseDraftTask.messages.map(message => message.role === 'user'
            ? { ...message, content: `${message.content}\n\n${draftShortOutlineBlock('en-US', outline)}` } : { ...message }) }
          history.bindInput(ref, draftStep.stepId, { kind: 'model', task })
          const reserved = runs.reserve(run.runId, draftStep.invocationNonce!, hash(JSON.stringify([task, proof, proof])),
            200, 100, undefined, task.purpose, task)
          runs.markDispatched(reserved.attempt.attemptId)
          const artifact = runs.snapshot(reserved.attempt.attemptId, 0, body)
          runs.settle(reserved.attempt.attemptId, { trusted: true, actualTokens: 10, policy: {
            estimatorVersion: 'fictional-v1', safetyMarginTokens: 0, reasoning: 'included-in-completion', canBoundTotalLiability: true,
          } }, 'stop')
          history.acknowledgeFromReceipt(ref, draftStep.stepId)
          history.bindInput(ref, steps[2]!.stepId, { kind: 'compose', artifactIds: [artifact.artifactId],
            algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: hash(body) })
          history.withEffectCommit(ref, steps[2]!.stepId, () => runs.composeVisible(run.runId, [artifact.artifactId], hash(body), DRAFT_VISIBLE_TEXT_VERSION))
          history.bindInput(ref, steps[3]!.stepId, { kind: 'commit', chapterNumber: 1, expectedCompositionHash: hash(body) })
          history.withEffectCommit(ref, steps[3]!.stepId, () => new GenerationDraftEffects(db, runs).commit({
            handle: { projectId, epoch, rootActionId: run.rootActionId, runId: run.runId },
            chapterNumber: 1, source: 'write', expectedCompositionHash: hash(body),
          }, () => undefined))
        }
      }
    }
    expect(history.get(task.taskId)?.state).toBe(state)
    const receipts = runs.readRunView(run.runId).attempts.map(item => item.receipt)
    return { ref, task: history.get(task.taskId)!, steps: history.readSteps(task.taskId), effects: history.readEffects(task.taskId),
      attempts: receipts.map(receipt => ({ attemptId: receipt.attempt.attemptId, status: receipt.attempt.status,
        artifactId: receipt.artifact?.artifactId ?? null })),
      historicalArtifacts: receipts.flatMap(({ artifact }) => artifact ? [{ attemptId: artifact.attemptId,
        artifactId: artifact.artifactId, revision: artifact.revision, text: artifact.text, textHash: artifact.textHash }] : []),
      composition: runs.readVisibleComposition(run.runId),
      excluded: [operationKey, requestHash, ...steps.flatMap(step => step.invocationNonce ? [step.invocationNonce] : [])] }
  } finally { db.close() }
}

describe('workflow driver portable history (synthetic native receipts)', () => {
  it.each(['ready', 'paused', 'blocked', 'cancelled', 'waiting_review'] as const)('retains %s history through two new copies without old step execution', async state => {
    const f = fixture(), source = seed(f.databasePath, f.projectId, state), original = fs.readFileSync(f.databasePath)
    let sourceRoot = f.root, projectId: string = f.projectId
    for (const generation of [1, 2]) {
      const databasePath = path.join(sourceRoot, '.ai-novel', 'project.db'), before = fs.readFileSync(databasePath)
      const attemptParentPath = path.join(f.base, `attempt-${generation}`), archivePath = path.join(f.base, `copy-${generation}.ainovel`)
      fs.mkdirSync(attemptParentPath)
      const exported = await exportPortableProject({ sourceProjectRoot: sourceRoot,
        projectSession: { projectId, projectPath: sourceRoot, leaseId: `fictional-lease-${generation}` },
        targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => undefined,
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      expect(exported.sourceEvidence.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(fs.readFileSync(databasePath)).toEqual(before)
      const evidence = probeProjectSqlite({ databasePath })
      expect(evidence.assetMigrationDomain?.tableCounts.workflow_tasks).toBe(1)
      expect(evidence.preWorkflowDriverDomain?.tableCounts.workflow_tasks).toBeUndefined()
      expect(evidence.preRecoveryTailsDomain?.tableCounts.workflow_tasks).toBeUndefined()
      const targetRoot = path.join(f.base, `restored-${generation}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: targetRoot })
      expect(restored.targetProjectId).not.toBe(projectId)
      expect(restored.targetProjectId).not.toBe(f.projectId)
      const copiedPath = path.join(targetRoot, '.ai-novel', 'project.db'), db = new Database(copiedPath)
      try {
        const guard = readPortableRuntimeFreeze(targetRoot)
        const history = new WorkflowDriverRepository(db, { projectId: restored.targetProjectId, assertCurrent: () => undefined,
          isFrozen: (table, id) => guard.isFrozen(table, id), now: () => 100 })
        expect(history.get(source.ref.taskId)).toEqual({ ...source.task, operationKey: `portable-history:${source.ref.taskId}`, requestHash: null })
        expect(history.readSteps(source.ref.taskId)).toEqual(source.steps.map(step => ({ ...step, invocationNonce: null })))
        expect(history.readEffects(source.ref.taskId)).toEqual(source.effects)
        expect(guard.isFrozen('workflow_tasks', source.ref.taskId)).toBe(true)
        for (const step of source.steps) expect(guard.isFrozen('workflow_steps', step.stepId)).toBe(true)
        for (const effect of source.effects) expect(guard.isFrozen('workflow_effects', effect.stepId)).toBe(true)
        const runtime: ProjectRuntime = { projectPath: targetRoot, projectId: restored.targetProjectId,
          projectStorageRoot: path.join(targetRoot, '.ai-novel'), database: db, databaseIdentity: Object.freeze({}),
          canonicalRoot: targetRoot, executionEpoch: `fictional-restored-runtime-${generation}`, phase: 'open' }
        const assertCapturedResources = vi.fn(() => { expect(runtime.database).toBe(db); expect(db.open).toBe(true) })
        const freezePath = path.join(targetRoot, '.ai-novel', 'portable-runtime-freeze.json')
        const beforeRead = fs.readFileSync(copiedPath), freezeBeforeRead = fs.readFileSync(freezePath)
        const changesBeforeRead = db.prepare('SELECT total_changes()').pluck().get()
        const readView = vi.spyOn(GenerationRunRepository.prototype, 'readRunView')
        const reserve = vi.spyOn(GenerationRunRepository.prototype, 'reserve')
        const dispatch = vi.spyOn(GenerationRunRepository.prototype, 'markDispatched')
        const compose = vi.spyOn(GenerationRunRepository.prototype, 'composeVisible')
        const commit = vi.spyOn(GenerationDraftEffects.prototype, 'commit')
        try {
          const receipt = readWorkflowDriverReceipt(runtime, source.ref.taskId, assertCapturedResources)
          expect(receipt).toEqual({
            task: { taskId: source.task.taskId, projectId: source.task.projectId, template: source.task.template,
              runId: source.task.runId, revision: source.task.revision, state, blockedCode: source.task.blockedCode,
              createdAt: source.task.createdAt, updatedAt: source.task.updatedAt },
            steps: source.steps.map(step => ({ stepId: step.stepId, commandId: step.commandId, ordinal: step.ordinal,
              kind: step.kind, inputHash: step.inputHash, effect: source.effects.find(effect => effect.stepId === step.stepId) ?? null })),
            attempts: source.attempts, historicalArtifacts: source.historicalArtifacts, composition: source.composition,
            draftSave: state === 'waiting_review' ? { kind: 'changed' } : { kind: 'absent' },
            ...(state === 'waiting_review' ? { draftSaveProof: 'unavailable' } : {}), nonReplayable: true,
          })
          if (state === 'blocked') {
            expect(receipt.attempts).toMatchObject([{ status: 'unknown' }])
            expect(receipt.historicalArtifacts).toMatchObject([{ text: outline, textHash: hash(outline) }])
            expect(receipt.steps.every(step => step.effect === null)).toBe(true)
            expect(receipt.composition).toBeNull()
          } else if (state === 'waiting_review') {
            expect(receipt.historicalArtifacts?.map(artifact => artifact.text)).toEqual([outline, body])
            expect(receipt.composition?.text).toBe(body)
            expect(receipt.draftSave).not.toHaveProperty('receipt')
          }
          expect(readWorkflowDriverReceipt(runtime, source.ref.taskId, assertCapturedResources)).toEqual(receipt)
          expect(assertCapturedResources).toHaveBeenCalled()
          for (const operation of [readView, reserve, dispatch, compose, commit]) expect(operation).not.toHaveBeenCalled()
          expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRead)
          expect(fs.readFileSync(copiedPath)).toEqual(beforeRead)
          expect(fs.readFileSync(freezePath)).toEqual(freezeBeforeRead)
        } finally {
          for (const operation of [readView, reserve, dispatch, compose, commit]) operation.mockRestore()
        }
        expect(() => db.transaction(() => history.assertActive(source.ref)).immediate()).toThrow('WORKFLOW_DRIVER_HISTORY_FROZEN')
        expect(() => history.resume(source.ref)).toThrow('WORKFLOW_DRIVER_HISTORY_FROZEN')
        expect(() => history.acknowledgeFromReceipt(source.ref, source.steps[0]!.stepId)).toThrow('WORKFLOW_DRIVER_HISTORY_FROZEN')
        const effect = vi.fn()
        expect(() => history.withEffectCommit(source.ref, source.steps[3]!.stepId, effect)).toThrow('WORKFLOW_DRIVER_HISTORY_FROZEN')
        expect(effect).not.toHaveBeenCalled()
        if (state === 'waiting_review') expect(db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id').pluck().get()).toBe(body)
        const freezeBytes = fs.readFileSync(path.join(targetRoot, '.ai-novel', 'portable-runtime-freeze.json'))
        const records = JSON.parse(freezeBytes.toString()).records as Array<{ table: string; projection: Record<string, unknown> }>
        expect(records.find(record => record.table === 'workflow_tasks')?.projection.recipe_json).toEqual(recipe)
        const bytes = Buffer.concat([fs.readFileSync(copiedPath), freezeBytes])
        for (const excluded of [proof, epoch, ...source.excluded, ...source.excluded.map(hash)]) expect(bytes.includes(Buffer.from(excluded))).toBe(false)
      } finally { db.close() }
      sourceRoot = targetRoot
      projectId = restored.targetProjectId
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  })

  it.each(['future-column', 'unknown-recipe', 'unknown-input', 'recipe-hash', 'input-hash'] as const)('rejects %s without changing the original history', mode => {
    const f = fixture(), source = seed(f.databasePath, f.projectId, 'waiting_review'), db = new Database(f.databasePath)
    try {
      if (mode === 'future-column') db.exec('ALTER TABLE workflow_steps ADD COLUMN future_execution_capability TEXT')
      else if (mode === 'recipe-hash') db.prepare('UPDATE workflow_tasks SET recipe_hash=?').run(hash('wrong recipe'))
      else if (mode === 'input-hash') db.prepare('UPDATE workflow_steps SET input_hash=? WHERE step_id=?').run(hash('wrong input'), source.steps[0]!.stepId)
      else if (mode === 'unknown-recipe') {
        const value = { ...recipe, outlineTask: { ...recipe.outlineTask, handle: { epoch: 'forbidden' } } }, json = JSON.stringify(value)
        db.prepare('UPDATE workflow_tasks SET recipe_json=?,recipe_hash=?').run(json, hash(json))
      } else {
        const value = { kind: 'model', task: { ...recipe.outlineTask, messages: [{ role: 'user', content: 'Fictional text', credential: 'forbidden' }] } }
        const json = JSON.stringify(value)
        db.prepare('UPDATE workflow_steps SET input_json=?,input_hash=? WHERE step_id=?').run(json, hash(json), source.steps[0]!.stepId)
      }
    } finally { db.close() }
    const before = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })

  it('vacates old task keys before assigning stable history labels that collide with those keys', () => {
    const f = fixture(), first = seed(f.databasePath, f.projectId, 'ready'), second = seed(f.databasePath, f.projectId, 'ready')
    const db = new Database(f.databasePath)
    try {
      db.prepare('UPDATE workflow_tasks SET operation_key=? WHERE task_id=?').run(`portable-history:${second.ref.taskId}`, first.ref.taskId)
    } finally { db.close() }
    sanitizePortableDatabase(f.databasePath)
    const copied = new Database(f.databasePath, { readonly: true })
    try {
      expect(copied.prepare('SELECT task_id,operation_key,request_hash FROM workflow_tasks ORDER BY rowid').all()).toEqual([
        { task_id: first.ref.taskId, operation_key: `portable-history:${first.ref.taskId}`, request_hash: null },
        { task_id: second.ref.taskId, operation_key: `portable-history:${second.ref.taskId}`, request_hash: null },
      ])
      expect(copied.prepare('SELECT DISTINCT invocation_nonce FROM workflow_steps').pluck().all()).toEqual([null])
    } finally { copied.close() }
  })
})
