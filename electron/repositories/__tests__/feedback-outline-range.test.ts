import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { applyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { applyM09PlanningFeedbackRanges } from '../../migrations/m09-planning-feedback-ranges'
import { GenerationRunRepository } from '../generation-run-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { PlanningFeedbackRepository } from '../planning-feedback-repository'
import type { PlanningFeedbackBase, PlanningFeedbackCandidate } from '../../../src/shared/planning-feedback'

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function proof(base: PlanningFeedbackBase, parent: PlanningFeedbackCandidate | null, feedback: string, constraints: readonly string[]) {
  return {
    baseId: base.baseId,
    target: base.target,
    revision: base.sourceRevision,
    sourceHash: base.sourceHash,
    parentCandidateId: parent?.candidateId ?? null,
    parentHash: parent?.textHash ?? base.valueHash,
    feedback,
    constraints,
  }
}

function outlineEntry(chapter: number, text = '正文内容'): string {
  return `## 第${chapter}章：标题${chapter}\n${text}`
}

function outlineBody(from: number, to: number, tag = '正文'): string {
  const parts: string[] = []
  for (let ch = from; ch <= to; ch++) parts.push(outlineEntry(ch, `${tag} ${ch}`))
  return parts.join('\n\n')
}

interface Fixture {
  db: Database.Database
  repo: PlanningFeedbackRepository
  fullSynopsis: string
}

function createOutlineFixture(): Fixture {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise,worldbuilding) VALUES('main','Synthetic book','F0','World F0')")
  db.exec(M01_GENERATION_SQL)
  db.transaction(() => applyM08PlanningFeedback(db))()
  db.transaction(() => applyM09PlanningFeedbackRanges(db))()

  const fullSynopsis = [
    '# 全书总大纲前言\n这是不可变的开卷背景设定。',
    outlineBody(1, 2, '初始章'),
    outlineBody(3, 4, '授权修订章'),
    outlineBody(5, 6, '后置章'),
  ].join('\n\n')

  ProjectCoreRepository.update({ synopsis: fullSynopsis }, db)
  db.prepare("UPDATE project_core SET characters_arch='原始角色设定架构' WHERE id='main'").run()

  const repo = new PlanningFeedbackRepository(db, {
    projectId: 'test-book-p2a',
    assertCurrent: () => {},
    isFrozen: () => false,
    assertGenerationCurrent: () => {},
  })

  return { db, repo, fullSynopsis }
}

function stageCandidate(
  f: Fixture,
  base: PlanningFeedbackBase,
  text: string,
  parent?: PlanningFeedbackCandidate,
): PlanningFeedbackCandidate {
  const repository = new GenerationRunRepository(() => f.db)
  const h = hash('synthetic-frozen-input')
  const fingerprint = {
    chapterBriefHash: h,
    authorGuidanceHash: h,
    dependencyHash: h,
    contextSnapshotHash: h,
    templateHash: h,
    skillSnapshotHash: h,
    modelLeaseRevision: h,
    policyHash: h,
    outputContractHash: h,
  }
  const feedback = '优化节奏与冲突'
  const constraints = ['保留重要线索']
  const run = repository.open({
    projectId: 'test-book-p2a',
    epoch: 'lease-A',
    operation: 'write',
    uiActionNonce: randomUUID(),
    frozenInputHash: h,
    fingerprint,
    contextSnapshotId: 'synthetic-context',
    sourceManifest: {
      syntheticPlanningProof: proof(base, parent ?? null, feedback, constraints),
    },
    sourceRefs: [],
    budget: {
      maxPhysicalRequests: 2,
      maxTokenLiability: 500,
      maxOutputPerRequest: 100,
      maxActiveElapsedMs: 10000,
    },
  })
  const policy = {
    estimatorVersion: 'fixture-v1',
    safetyMarginTokens: 10,
    reasoning: 'included-in-completion' as const,
    canBoundTotalLiability: true,
  }
  const reserved = repository.reserve(run.runId, 'request', h, 200, 100, policy)
  repository.markDispatched(reserved.attempt.attemptId)
  if (text) repository.snapshot(reserved.attempt.attemptId, 0, text)
  const receipt = repository.settle(
    reserved.attempt.attemptId,
    { policy, trusted: true, actualTokens: 50, inputTokens: 25, completionTokens: 25 },
    'stop',
  )
  return f.repo.stageCandidate({
    baseId: base.baseId,
    parentCandidateId: parent?.candidateId ?? null,
    feedback,
    constraints,
    runId: run.runId,
    attemptId: receipt.attempt.attemptId,
    artifactId: receipt.artifact!.artifactId,
  })
}

describe('feedback-outline-range (FEEDBACK-003)', () => {
  let f: Fixture

  beforeEach(() => {
    f = createOutlineFixture()
  })

  afterEach(() => {
    f.db.close()
  })

  it('修订大纲3-4章只影响授权范围，第1-2章、第5-6章及前言字节完全不变（AC-1）', () => {
    const base = f.repo.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    expect(base.value).toBe(outlineBody(3, 4, '授权修订章'))

    const cand1 = stageCandidate(f, base, outlineBody(3, 4, '第一轮优化'))
    const cand2 = stageCandidate(f, base, outlineBody(3, 4, '第二轮精修'), cand1)
    expect(cand2.parentCandidateId).toBe(cand1.candidateId)

    const before = ProjectCoreRepository.get(f.db)!

    const adoption = f.repo.adopt({
      candidateId: cand2.candidateId,
      idempotencyKey: 'adopt-c2-range-3-4',
      decision: 'full',
      text: cand2.text,
    })

    const after = ProjectCoreRepository.get(f.db)!

    // 验证授权范围 3-4 章被精确替换为第二轮候选文本
    expect(after.synopsis).toContain(cand2.text)

    // 验证范围外前言、第 1-2 章、第 5-6 章 100% 字节不变
    expect(after.synopsis).toContain('# 全书总大纲前言\n这是不可变的开卷背景设定。')
    expect(after.synopsis).toContain(outlineBody(1, 2, '初始章'))
    expect(after.synopsis).toContain(outlineBody(5, 6, '后置章'))

    // 验证核心设定的其他字段未受影响
    expect(after.charactersArch).toBe(before.charactersArch)
    expect(adoption.committedRevision).toBe(base.sourceRevision + 1)
  })

  it('手改后章号重复、缺失或越界时零正式写入，不污染大纲（AC-2）', () => {
    const base = f.repo.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const cand = stageCandidate(f, base, outlineBody(3, 4, '候选稿'))
    const beforeSynopsis = ProjectCoreRepository.get(f.db)!.synopsis

    // 1. 章号缺失（只改了第 3 章，漏掉了第 4 章）
    expect(() =>
      f.repo.adopt({
        candidateId: cand.candidateId,
        idempotencyKey: 'err-missing-ch',
        decision: 'edited',
        text: outlineEntry(3, '缺少第4章正文'),
      }),
    ).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')

    // 2. 章号重复（出现了两个第 3 章）
    expect(() =>
      f.repo.adopt({
        candidateId: cand.candidateId,
        idempotencyKey: 'err-duplicate-ch',
        decision: 'edited',
        text: `${outlineEntry(3, '第一处第3章')}\n\n${outlineEntry(3, '重复第3章')}`,
      }),
    ).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')

    // 3. 章号越界（授权范围为 3-4，手改填入了第 5 章）
    expect(() =>
      f.repo.adopt({
        candidateId: cand.candidateId,
        idempotencyKey: 'err-out-of-range',
        decision: 'edited',
        text: `${outlineEntry(3, '正常3')}\n\n${outlineEntry(5, '越界的第5章')}`,
      }),
    ).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')

    // 验证数据库零正式写入，大纲完全未变
    expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe(beforeSynopsis)
    expect(f.repo.listAdoptions(base.baseId)).toHaveLength(0)
  })

  it('部分采用（只采纳第3章）时未选章节（第4章）不被删除且保持原底稿（AC-3）', () => {
    const base = f.repo.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const cand = stageCandidate(f, base, outlineBody(3, 4, '二轮候选'))
    const beforeSynopsis = ProjectCoreRepository.get(f.db)!.synopsis

    const partialText = outlineEntry(3, '仅采纳第3章全新情节')
    const receipt = f.repo.adopt({
      candidateId: cand.candidateId,
      idempotencyKey: 'adopt-partial-ch3',
      decision: 'partial',
      adoptedRange: { from: 3, to: 3 },
      text: partialText,
    })

    expect(receipt.adoptedScope).toEqual({ kind: 'plot-outline-range', from: 3, to: 3 })

    const afterSynopsis = ProjectCoreRepository.get(f.db)!.synopsis
    expect(afterSynopsis).not.toBe(beforeSynopsis)

    // 验证第 3 章被替换为新文本
    expect(afterSynopsis).toContain(partialText)

    // 验证第 4 章未被采纳，依然保持原有授权修订章的底稿内容
    expect(afterSynopsis).toContain(outlineEntry(4, '授权修订章 4'))

    // 验证其他章与前言完全保持原样
    expect(afterSynopsis).toContain(outlineBody(1, 2, '初始章'))
    expect(afterSynopsis).toContain(outlineBody(5, 6, '后置章'))
  })

  it('二轮未采用放弃时正式底稿零污染，底稿冲突时安全拦截（AC-3）', () => {
    const base = f.repo.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const cand1 = stageCandidate(f, base, outlineBody(3, 4, '第一轮候选'))
    const cand2 = stageCandidate(f, base, outlineBody(3, 4, '第二轮候选（未采用）'), cand1)
    const beforeSynopsis = ProjectCoreRepository.get(f.db)!.synopsis

    // 模拟作者放弃第二轮候选，不调用 adopt
    expect(f.repo.candidateState(cand2.candidateId)).toBe('ready')
    expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe(beforeSynopsis)

    // 模拟底稿被外部并发修改
    ProjectCoreRepository.update({ synopsis: beforeSynopsis + '\n\n## 追加外部章' }, f.db)

    // 尝试提交旧基线的第二轮候选 -> 触发 CAS 冲突拒绝
    expect(() =>
      f.repo.adopt({
        candidateId: cand2.candidateId,
        idempotencyKey: 'conflict-adopt',
        decision: 'full',
        text: cand2.text,
      }),
    ).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })
})
