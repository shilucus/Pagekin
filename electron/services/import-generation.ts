import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../src/shared/import-generation'
import { GenerationRunRepository, type DurableGenerationRun, type GenerationBudgetReceipt } from '../repositories/generation-run-repository'
import { ImportRunRepository } from '../repositories/import-run-repository'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { captureImportGenerationContext, importGenerationSlotKey } from './import-generation-source'
import { rootBudgetExhausted } from '../../src/shared/generation-contract'
import { ImportQueryRepository } from '../repositories/import-query-repository'
import { importQueryFailure, type ImportQueryPlan } from './import-query-contract'

export function importSlotNonce(slotKey: string, retryOf?: DurableGenerationRun): string {
  return `import:${slotKey}${retryOf ? `:retry:${retryOf.runId}` : ''}`
}

/** Existing import checkpoints own effects; this class only joins their generation runs. */
export class ImportGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository, private readonly projectId: string, private readonly canonicalRoot?: string) {}
  private effectReceipt(slot: ImportGenerationSlot) {
    const context = this.canonicalRoot !== undefined
      && this.db.prepare('SELECT purpose FROM import_runs WHERE id=?').pluck().get(slot.runId) !== 'author-manuscript'
      ? { database: this.db, canonicalRoot: this.canonicalRoot, projectId: this.projectId } : undefined
    return ImportRunRepository.getEffectReceipt(slot.runId, slot.stage, slot.batchId, context)
  }
  private slotRuns(slot: ImportGenerationSlot): DurableGenerationRun[] {
    const key = importGenerationSlotKey(slot)
    const rows = this.db.prepare("SELECT run_id,json_extract(json_extract(open_key,'$[0]'),'$[2]') AS ui_action_nonce FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlotKey')=? ORDER BY rowid").all(key) as { run_id: string; ui_action_nonce: string }[]
    let previous: DurableGenerationRun | undefined
    const runs: DurableGenerationRun[] = []
    for (const row of rows) {
      const run = this.runs.get(row.run_id)
      if (run.binding.projectId !== this.projectId) continue
      if (previous && row.ui_action_nonce !== importSlotNonce(key, previous)) throw new Error('GENERATION_IMPORT_SLOT_AMBIGUOUS')
      previous = run
      runs.push(run)
    }
    return runs
  }
  find(slot: ImportGenerationSlot): DurableGenerationRun | undefined {
    return this.slotRuns(slot).at(-1)
  }
  private rootCanDispatch(rootActionId: string): boolean {
    const budget = this.runs.budget(rootActionId)
    return ['active', 'paused'].includes(budget.root.status) && !budget.blockedCode
      && !rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs, budget.auxiliaryRequestCount)
      && budget.attempts.every(attempt => this.readable(attempt.attemptId, budget))
  }
  private queryPlan(slot: ImportGenerationSlot): ImportQueryPlan | null {
    if (slot.stage !== 'global' || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_query_plans'").get()) return null
    if (this.db.prepare('SELECT purpose FROM import_runs WHERE id=?').pluck().get(slot.runId) !== 'reference') return null
    const queries = new ImportQueryRepository(this.db, { runs: this.runs })
    if (!this.db.inTransaction) queries.preflight(slot.runId)
    const plan = queries.get(slot.runId)
    if (plan?.record.state === 'recovery_unknown') importQueryFailure('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    return plan
  }
  private readable(attemptId: string, budget: GenerationBudgetReceipt): boolean {
    try { this.runs.receipt(attemptId, budget); return true } catch { return false }
  }
  private attemptIds(run: DurableGenerationRun): string[] {
    return this.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=?').pluck().all(run.runId) as string[]
  }
  /** 空白回复没有可提交的内容，结构化批次会拆开重发，所以它不单独拒收运行；只有空白、没有一份可用输出时才拒收。 */
  rejected(run: DurableGenerationRun): boolean {
    const budget = this.runs.budget(run.rootActionId)
    const outputs = this.attemptIds(run).map((attemptId): 'usable' | 'blank' | 'rejected' => {
      const receipt = this.runs.receipt(attemptId, budget)
      const artifact = receipt.artifact
      if (receipt.result?.finishReason !== 'stop') return 'rejected'
      if (!artifact?.text.trim()) return 'blank'
      return this.db.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status<>'discarded'").pluck().get(artifact.artifactId) === 1 ? 'usable' : 'rejected'
    })
    return outputs.includes('rejected') || outputs.includes('blank') && !outputs.includes('usable')
  }
  private hasRemoteUnknown(slot: ImportGenerationSlot): boolean {
    for (const run of this.slotRuns(slot)) {
      const budget = this.runs.budget(run.rootActionId)
      for (const attemptId of this.attemptIds(run)) {
        const receipt = this.runs.receipt(attemptId, budget)
        if (receipt.attempt.status === 'cancelled-before-dispatch') continue
        if (receipt.attempt.status === 'reserved' || receipt.attempt.status === 'dispatch-marked') return true
        if (receipt.attempt.status !== 'settled' && receipt.attempt.status !== 'unknown') return true

        const result = receipt.result
        if (!result || receipt.failureCode === 'GENERATION_STORAGE_FAILED') return true
        if (result.finishReason === 'unknown' || result.finishReason === 'cancelled') return true
        if (result.finishReason === 'stop' || result.finishReason === 'length' || result.finishReason === 'content_filter'
          || receipt.failureCode === 'GENERATION_CONTEXT_LENGTH_EXCEEDED') continue

        const diagnostics = receipt.diagnostics
        if (result.finishReason === 'error' && !receipt.failureCode
          && diagnostics?.phase === 'complete' && diagnostics.endReason === 'completed') continue
        if (receipt.failureCode !== 'GENERATION_PROVIDER_FAILED') return true
        if (diagnostics?.phase === 'stream' && diagnostics.endReason === 'failed'
          && diagnostics.errorCode === 'PROVIDER_STREAM_ERROR') continue
        if (diagnostics?.phase === 'response' && diagnostics.endReason === 'failed'
          && diagnostics.errorCode === 'HTTP_ERROR' && Number.isInteger(diagnostics.httpStatus)
          && diagnostics.httpStatus! >= 100 && diagnostics.httpStatus! <= 599
          && (diagnostics.httpStatus! < 200 || diagnostics.httpStatus! >= 300)) continue

        return true
      }
    }
    return false
  }
  hasAttempts(run: DurableGenerationRun): boolean {
    return this.runs.attemptCount(run.runId) > 0
  }
  retryable(run: DurableGenerationRun): boolean {
    const slot = this.context(run).slot
    if (this.effectReceipt(slot)) return false
    if (this.hasRemoteUnknown(slot)) return false
    const budget = this.runs.budget(run.rootActionId)
    if (budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))) return false
    if (this.rejected(run)) return true
    return this.hasAttempts(run) ? budget.root.status === 'cancelled' : !this.rootCanDispatch(run.rootActionId)
  }
  abandonIfRootStopped(run: DurableGenerationRun): void {
    if (this.rootCanDispatch(run.rootActionId)) return
    const artifactIds = this.db.prepare("SELECT artifact_id FROM generation_artifacts WHERE run_id=? AND status<>'discarded'").pluck().all(run.runId) as string[]
    for (const artifactId of artifactIds) this.runs.discardCandidate(artifactId)
  }
  context(run: DurableGenerationRun): ImportGenerationContext {
    const context = run.binding.sourceManifest.importContext as ImportGenerationContext | undefined
    if (!context || importGenerationSlotKey(context.slot) !== run.binding.sourceManifest.importSlotKey) throw new Error('GENERATION_IMPORT_CONTEXT_REQUIRED')
    return structuredClone(context)
  }
  assertMutable(run: DurableGenerationRun): void {
    if (!run.binding.sourceManifest.importSlot) return
    const slot = this.context(run).slot
    if (this.effectReceipt(slot)) throw new Error('GENERATION_IMPORT_EFFECT_SEALED')
  }
  /** 导入运行要停在这一阶段且仍在进行；作者已请求取消时报取消码，渲染端才能如实显示已取消。 */
  private assertSlotRunning(slot: ImportGenerationSlot): void {
    const state = this.db.prepare('SELECT stage,status,cancel_requested FROM import_runs WHERE id=?').get(slot.runId) as { stage: string; status: string; cancel_requested: number } | undefined
    if (!state || state.stage !== slot.stage || state.status !== 'running') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    if (state.cancel_requested) throw new Error('GENERATION_ACTION_CANCELLED')
  }
  assertExecution(run: DurableGenerationRun, execution?: ImportRunExecutionAuthority): ImportRunExecutionAuthority {
    const slot = this.context(run).slot
    if (!execution) throw new Error('GENERATION_IMPORT_EXECUTION_REQUIRED')
    ImportRunRepository.assertExecutionAuthority(slot.runId, execution, undefined, this.db)
    this.assertSlotRunning(slot)
    const plan = this.queryPlan(slot)
    if (plan && plan.record.root_action_id !== run.rootActionId) importQueryFailure('GENERATION_IMPORT_QUERY_ROOT_CHANGED')
    if (this.hasRemoteUnknown(slot)) throw new Error('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
    return Object.freeze({ owner: execution.owner, epoch: execution.epoch })
  }
  admit(selection: BeginGenerationRequest): { existing?: DurableGenerationRun; retryOf?: DurableGenerationRun; parentRootActionId?: string; modelId?: string; chapterCount?: number } | undefined {
    const slot = selection.importSlot
    if (!slot) {
      if (selection.importExecution || ['import-global-facts', 'import-blueprints'].includes(selection.operation)) throw new Error('GENERATION_IMPORT_SLOT_REQUIRED')
      return undefined
    }
    const existing = this.find(slot)
    const operation = { global: 'import-global-facts', style: 'analyze-writing-style', blueprints: 'import-blueprints' }[slot.stage]
    const promptKeys = slot.stage === 'global' ? ['infer_novel_config_with_vectors', 'infer_novel_config'] : slot.stage === 'style' ? ['analyze_writing_style'] : ['infer_single_chapter_blueprint']
    if (selection.operation !== operation || !selection.importExecution || selection.batchId || selection.batchIntent
      || selection.agentWorkflowRegistrationId || selection.continueDirectoryOperationId
      || !isDeepStrictEqual(selection.promptKeys, promptKeys) || !isDeepStrictEqual(selection.skillStages, slot.stage === 'style' ? [] : ['planning'])
      || selection.output !== (slot.stage === 'style' ? 'visible-text' : 'structured-data')) throw new Error('GENERATION_IMPORT_STAGE_INVALID')
    ImportRunRepository.assertExecutionAuthority(slot.runId, selection.importExecution, undefined, this.db)
    const queryPlan = this.queryPlan(slot)
    if (queryPlan && existing && existing.rootActionId !== queryPlan.record.root_action_id)
      importQueryFailure('GENERATION_IMPORT_QUERY_ROOT_CHANGED')
    const modelOf = (run: DurableGenerationRun) => (run.binding.sourceManifest.modelReceipt as { modelId: string }).modelId
    if (existing && !this.retryable(existing)) {
      if (selection.modelId !== modelOf(existing)) throw new Error('GENERATION_IMPORT_MODEL_CHANGED')
      return { existing }
    }
    this.assertSlotRunning(slot)
    const { totalChapters } = captureImportGenerationContext(this.db, slot)
    const key = importGenerationSlotKey(slot)
    const records = (this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlot.runId')=? ORDER BY rowid").all(slot.runId) as { run_id: string }[])
      .map(row => this.runs.get(row.run_id)).filter(run => run.binding.projectId === this.projectId)
    for (const run of records) {
      const prior = this.context(run).slot
      if (importGenerationSlotKey(prior) === key) continue
      const receipt = this.effectReceipt(prior)
      if (receipt?.state !== 'committed') throw new Error('GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED')
    }
    const latest = records.at(-1)
    if (selection.parentRootActionId && selection.parentRootActionId !== latest?.rootActionId) throw new Error('GENERATION_IMPORT_ROOT_CHANGED')
    if (queryPlan && selection.parentRootActionId && selection.parentRootActionId !== queryPlan.record.root_action_id)
      importQueryFailure('GENERATION_IMPORT_QUERY_ROOT_CHANGED')
    if (queryPlan && !this.rootCanDispatch(queryPlan.record.root_action_id)) throw new Error('ROOT_BUDGET_EXHAUSTED')
    const parentRootActionId = queryPlan?.record.root_action_id ?? selection.parentRootActionId
      ?? (latest && this.rootCanDispatch(latest.rootActionId) ? latest.rootActionId : undefined)
    return { retryOf: existing, parentRootActionId, modelId: latest && modelOf(latest),
      chapterCount: parentRootActionId ? undefined : totalChapters }
  }
}
