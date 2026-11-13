/** Persisted, resumable reference-import workflow. */
import type { NovelConfig, ProjectSessionContext } from '../../shared/ipc-channels'
import {
  assertImportRunEffectReceiptMetadata,
  type ImportRunChapterSnapshot,
  type ImportRunSnapshot,
  type ImportRunStage,
  type ImportRunExecutionLease,
} from '../../shared/import-run'
import type { ImportGlobalFactsReceipt } from '../../shared/import-global-facts'
import type { BlueprintRangeCommitReceipt } from '../../../electron/repositories/blueprint-repository'
import type { FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { workflowResourceKey, type StepCallbacks, type WorkflowContext, type WorkflowDefinition, type WorkflowStep } from '../../stores/workflow-store'
import {
  IMPORT_CHAPTER_PAGE_SIZE,
  ImportRunOrchestrator,
  importRecordError,
  type ImportRunOrchestratorDependencies,
} from './import-run-orchestrator'
import { refreshImportDerivedFileTreeBestEffort } from './import-derived-refresh'
import { configFieldsFromCore } from './import-suggestions'
import { promptLanguageText } from '../prompt-language'
import { retryDirectoryCharacterSync } from './directory-character-sync-recovery'
import type { WritingLanguage } from '../../shared/writing-language'
import { countDraftUnits } from '../../shared/draft-units'
import { FINALIZATION_SHARED_WRITE_RESOURCE_KINDS } from '../../shared/workflow-resource-claims'
import type { PerformanceMetric } from '../../shared/performance-baseline'
import { assertReferenceKnowledgeRequest, isReferenceKnowledgeProgress, type ReferenceKnowledgeReference } from '../../shared/reference-knowledge-contract'
import { isReferenceStyleProgress, type ReferenceStyleLog, type ReferenceStyleAckRequest } from '../../shared/reference-style-contract'
import { createMainGenerationTransport } from '../generation/main-generation-transport'
import { createMainOwnedGenerationRuntime, type MainGenerationRunHandle } from '../generation/generation-runtime'
import { routeModelId } from '../model-routing'
import { pinWorkflowModel } from './workflow-main-generation'
import { useWorkflowReasoningStore } from '../../stores/workflow-reasoning-store'
import { isReferenceGlobalCompletionFailureCode, isReferenceGlobalProgress, type ReferenceGlobalLog } from '../../shared/reference-global-contract'
import { isReferenceBlueprintBatchId, isReferenceBlueprintProgress, type ReferenceBlueprintLog } from '../../shared/reference-blueprint-contract'
import { BoundedCompletionFailure } from './bounded-completion'
import { getImportInferenceTopics } from '../../shared/import-inference-materials'
import { globalEventBus } from '../../shared/event-bus'
import { displayedErrorMessage } from '../../i18n/app-errors'

type ReferenceKnowledgeIssuance = { reference: ReferenceKnowledgeReference; execution: ImportRunExecutionLease }

export interface ImportWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  run: ImportRunSnapshot
  /** One frozen renderer execution identity for every step in this workflow. */
  executionOwner: string
  /** Durable manifest chapter numbers; required for author-manuscript writes. */
  authorChapterNumbers?: readonly number[]
  referenceKnowledge?: ReferenceKnowledgeIssuance
}

function textForLocale(locale: ImportRunSnapshot['locale'], zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

function incompleteAuthorManifestError(run: ImportRunSnapshot): Error {
  return new Error(textForLocale(
    run.locale,
    '作者原稿的持久化章节清单不完整，无法安全启动导入。',
    'The persisted author-manuscript chapter manifest is incomplete, so the import cannot start safely.',
  ))
}

function normalizeAuthorChapterNumbers(
  run: ImportRunSnapshot,
  values: readonly number[] | undefined,
): readonly number[] {
  const chapterNumbers = [...new Set(values ?? [])].sort((left, right) => left - right)
  if (
    chapterNumbers.length !== run.totalChapters
    || chapterNumbers.some(number => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw incompleteAuthorManifestError(run)
  }
  return Object.freeze(chapterNumbers)
}

export async function loadAuthorImportChapterNumbers(
  run: ImportRunSnapshot,
  projectSession: ProjectSessionContext,
  projectPath: string,
): Promise<readonly number[]> {
  const chapterNumbers: number[] = []
  let afterChapterNumber = 0
  let hasMore = true
  while (hasMore) {
    const page = await ipc.invokeWithProjectSession(
      projectSession,
      'db:import-run-list-chapters',
      run.id,
      afterChapterNumber,
      IMPORT_CHAPTER_PAGE_SIZE,
      projectPath,
    )
    if (page.length === 0) {
      hasMore = false
      continue
    }
    chapterNumbers.push(...page.map(chapter => chapter.number))
    const nextAfterChapterNumber = page[page.length - 1]!.number
    if (nextAfterChapterNumber <= afterChapterNumber) throw incompleteAuthorManifestError(run)
    afterChapterNumber = nextAfterChapterNumber
  }
  return normalizeAuthorChapterNumbers(run, chapterNumbers)
}

function importedChapter(chapter: ImportRunChapterSnapshot) {
  return {
    number: chapter.number,
    title: chapter.title,
    content: chapter.content,
    wordCount: countDraftUnits(chapter.content),
  }
}

function currentNovelConfigSummary(writingLanguage: WritingLanguage): string {
  const config = useProjectStore.getState().currentProject?.novelConfig
  if (!config) return promptLanguageText(
    writingLanguage, '（配置概要不可用）', '(configuration summary unavailable)',
  )
  const none = promptLanguageText(writingLanguage, '（无）', '(none)')
  return promptLanguageText(
    writingLanguage,
    `类型: ${config.genre || none}\n大纲: ${config.coreOutline || none}\n世界观: ${config.worldSetting || none}\n主角: ${config.protagonistProfile || none}`,
    `Genre: ${config.genre || none}\nOutline: ${config.coreOutline || none}\nWorld: ${config.worldSetting || none}\nProtagonist: ${config.protagonistProfile || none}`,
  )
}

function styleLog(locale: ImportRunSnapshot['locale'], log: ReferenceStyleLog, count?: number): string {
  switch (log) {
    case 'imported-samples': return textForLocale(locale, `正在分析导入文本样本文风（${count} 段）...`, `Analyzing ${count} imported text ${count === 1 ? 'sample' : 'samples'}...`)
    case 'sampling-finalized': return textForLocale(locale, '正在采样已有章节正文...', 'Sampling existing chapter text...')
    case 'no-finalized': return textForLocale(locale, '无已写章节，无法分析文风', 'No written chapters are available for writing-style analysis.')
    case 'sampled-finalized': return textForLocale(locale, `  已采样 ${count} 章正文`, `  Sampled ${count} ${count === 1 ? 'chapter' : 'chapters'}`)
    case 'read-finalized-failed': return textForLocale(locale, '提取定稿内容失败', 'Failed to read finalized chapter content.')
    case 'empty-samples': return textForLocale(locale, '采样文本为空，跳过文风分析', 'The sample text is empty; skipping writing-style analysis.')
    case 'calling-ai': return textForLocale(locale, '调用 AI 分析文风特征...', 'Running AI writing-style analysis...')
    case 'empty-result': return textForLocale(locale, '文风分析返回空结果', 'Writing-style analysis returned an empty result.')
    case 'saved': return textForLocale(locale, '文风特征已保存到小说配置', 'Writing-style profile saved to the novel configuration')
  }
}

const sameGenerationHandle = (a: MainGenerationRunHandle, b: MainGenerationRunHandle) =>
  a.projectId === b.projectId && a.epoch === b.epoch && a.rootActionId === b.rootActionId && a.runId === b.runId

function globalLog(locale: ImportRunSnapshot['locale'], language: WritingLanguage, value: ReferenceGlobalLog): string {
  const t = (zh: string, en: string) => textForLocale(locale, zh, en)
  switch (value.key) {
    case 'retrieving': return t('通过向量知识库检索关键片段...', 'Retrieving key passages from the vector knowledge base...')
    case 'calling-ai': return t('正在调用 AI 推演全局小说配置...', 'Running AI inference for the global novel configuration...')
    case 'syntax-repair': return t('导入推演 JSON 存在词法错误，正在执行唯一一次完整替代语法修复...', 'The import-inference JSON has a syntax error; running the single full-replacement syntax repair...')
    case 'parsing': return t('正在解析 AI 返回结果并写入项目...', 'Parsing the AI response and committing it to the project...')
    case 'retrieved': {
      const label = getImportInferenceTopics(language).find(topic => topic.key === value.topic)!.label
      return t(`  已检索「${label.zhCN}」— ${value.count} 条结果`, `  Retrieved ${value.count} ${value.count === 1 ? 'result' : 'results'} for "${label.enUS}"`)
    }
    case 'retrieval-fallback': {
      const label = getImportInferenceTopics(language).find(topic => topic.key === value.topic)!.label
      return t(`  「${label.zhCN}」检索失败，将使用降级策略`, `  Retrieval failed for "${label.enUS}"; using the fallback strategy`)
    }
    case 'endpoint-recovery': return t(`导入推演关系端点缺少 ${value.count} 张角色卡，正在执行一次受限补卡校正`, `${value.count} relationship ${value.count === 1 ? 'endpoint is' : 'endpoints are'} missing a character card; running one bounded correction`)
    case 'saved-proposals': return t(`小说配置、非角色架构与 ${value.count} 条角色提议已原子保存；提议保留待采用，尚未创建角色。`, `The novel configuration, non-character architecture, and ${value.count} character proposals were saved atomically. Proposals remain pending adoption; no characters were created.`)
    case 'saved-roster': return t(`小说配置、非角色架构与 ${value.count} 张角色卡已原子提交`, `The novel configuration, non-character architecture, and ${value.count} character ${value.count === 1 ? 'card was' : 'cards were'} committed atomically`)
    case 'skill': return t(`本次 planning 阶段使用已冻结写作 Skill：${value.name}`, `Using the workflow-start-frozen writing skill for planning: ${value.name}`)
    case 'discard-failed': { const reason = displayedErrorMessage(locale, value.code); return t(`丢弃没通过校验的导入输出失败：${reason}`, `Could not discard the rejected import output: ${reason}`) }
    case 'dropped-relationships': {
      const zh = value.relationships.map(item => `${item.source}→${item.target}（${item.relation}）`).join('、')
      const en = value.relationships.map(item => `${item.source}→${item.target} (${item.relation})`).join(', ')
      return t(`已丢弃 ${value.relationships.length} 条关系，关系对象没有角色卡：${zh}。这是导入推演的内部限制（最多 8 张角色卡，只补卡一次），不是你的设置。导入完成后可以在「角色名单」里手动补上这些角色和关系。`, `Dropped ${value.relationships.length} relationship(s) whose target has no character card: ${en}. This is an internal import-inference limit (at most 8 character cards and one card-recovery request), not one of your settings. After the import, you can add these characters and relationships on the Cast page.`)
    }
  }
}

function blueprintLog(locale: ImportRunSnapshot['locale'], value: ReferenceBlueprintLog): string {
  const t = (zh: string, en: string) => textForLocale(locale, zh, en)
  switch (value.key) {
    case 'begin': return t(`开始分批推演蓝图（共 ${value.count} 章，预计至多 ${value.estimatedCalls} 次调用）...`, `Inferring blueprints in batches (${value.count} ${value.count === 1 ? 'chapter' : 'chapters'}; at most ${value.estimatedCalls} model ${value.estimatedCalls === 1 ? 'call' : 'calls'})...`)
    case 'inferring': return t(`  正在推演第 ${value.startChapter}–${value.endChapter} 章...`, `  Inferring Chapters ${value.startChapter}–${value.endChapter}...`)
    case 'complete': return t(`蓝图推演完成：${value.count} 章已一次提交`, `Blueprint inference complete: ${value.count} ${value.count === 1 ? 'chapter was' : 'chapters were'} committed in one operation`)
    case 'stop-reason': return t(`蓝图推演停止原因：${value.code}`, `Blueprint inference stop reason: ${value.code}`)
    case 'discard-failed': { const reason = displayedErrorMessage(locale, value.code); return t(`丢弃没通过校验的导入输出失败：${reason}`, `Could not discard the rejected import output: ${reason}`) }
  }
}

function productionDependencies(
  context: WorkflowContext,
  callbacks: StepCallbacks,
  referenceKnowledge?: ReferenceKnowledgeIssuance,
): ImportRunOrchestratorDependencies {
  const session = context.projectSession
  const projectPath = context.projectPath
  // 主进程没给原因时的兜底说明进运行卡片的步骤详情，按导入运行的语言写（工作流的 uiLocale 就是 run.locale）。
  const required = <T,>(result: { success: boolean; error?: string } & T, zhCNText: string, enUSText: string): T => {
    if (!result.success) throw new Error(result.error || textForLocale(context.uiLocale, zhCNText, enUSText))
    return result
  }
  return {
    getRun: runId => ipc.invokeWithProjectSession(session, 'db:import-run-get', runId, projectPath),
    ...(referenceKnowledge ? {
      executeReferenceGlobal: async (run: ImportRunSnapshot, owner: string) => {
        const captured = context.data.importRunExecution as ImportRunExecutionLease | undefined
        const lease = captured ?? referenceKnowledge.execution
        if (referenceKnowledge.reference.runId !== run.id || referenceKnowledge.reference.projectId !== session.projectId
          || lease.owner !== owner || lease.epoch !== referenceKnowledge.execution.epoch) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
        const execution = { owner: lease.owner, epoch: lease.epoch }
        const modelId = context.generationModelId?.trim() || routeModelId('import-global-facts') || null
        const transport = createMainGenerationTransport(() => session)
        const displayed = new Map<string, string>()
        let runtime: Awaited<ReturnType<typeof createMainOwnedGenerationRuntime>> | undefined
        let unsubscribeReasoning: (() => void) | undefined
        let handle: MainGenerationRunHandle | undefined
        let sequence = 0
        let active = true
        let projectionError: unknown
        let projectedReceipt: import('../../shared/import-run').ImportRunEffectReceipt | undefined
        let queue = Promise.resolve()
        const clearReasoning = () => useWorkflowReasoningStore.getState().clear(context.runId)
        const previousCancellation = context.requestMainGenerationCancellation
        context.requestMainGenerationCancellation = async () => {
          const result = await ipc.invokeWithProjectSession(session, 'db:import-run-request-cancel', run.id, lease, projectPath)
          if (!result.success) throw new Error(result.error || 'IMPORT_RUN_CANCEL_REQUEST_FAILED')
        }
        const projectCommitted = async () => {
          const receipt = await ipc.invokeWithProjectSession(session, 'db:import-run-effect-receipt-get', run.id, 'global', 'done', projectPath)
          if (!receipt || receipt.state !== 'committed' || receipt.stage !== 'global' || receipt.batchId !== 'done'
            || receipt.kind !== 'project-global-facts' || !receipt.effectReceipt) throw new Error('GENERATION_REQUEST_FAILED')
          assertImportRunEffectReceiptMetadata(receipt, run)
          const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
          if (!core) throw new Error(textForLocale(run.locale, '无法读取已保存的导入配置。', 'Could not read committed project configuration.'))
          projectedReceipt = receipt
          context.data.importGlobalFactsReceipt = receipt.effectReceipt
          const fields = configFieldsFromCore(core)
          const unknown = promptLanguageText(context.writingLanguage, '未知', 'Unknown')
          const none = promptLanguageText(context.writingLanguage, '（无）', '(none)')
          context.data.novelConfigSummary = promptLanguageText(context.writingLanguage,
            `类型: ${fields.genre || unknown} | 子类型: ${fields.subGenre || unknown} | 受众: ${fields.targetAudience || unknown}\n大纲: ${fields.coreOutline || none}\n世界观: ${fields.worldSetting || none}\n金手指: ${fields.goldenFinger || none}\n主角: ${fields.protagonistProfile || none}`,
            `Genre: ${fields.genre || unknown} | Subgenre: ${fields.subGenre || unknown} | Audience: ${fields.targetAudience || unknown}\nOutline: ${fields.coreOutline || none}\nWorld: ${fields.worldSetting || none}\nCentral advantage: ${fields.goldenFinger || none}\nProtagonist: ${fields.protagonistProfile || none}`)
          const current = useProjectStore.getState().currentProject
          if (current && sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
            useProjectStore.getState().publishSavedNovelConfig(fields, session, 'unsaved-edits')
          } else callbacks.log(textForLocale(run.locale, '当前正在查看其他作品，导入事实已安全保存至目标作品库', 'Viewing another project; imported facts saved safely to the target project database.'))
          globalEventBus.emit('REFRESH_RESOURCE', { resources: ['fileTree', 'characterCards'], projectPath, projectSession: session })
        }
        const unsubscribeProject = useProjectStore.subscribe(state => {
          if (!sameProjectSessionContext(session, projectSessionContextFromProject(state.currentProject))) clearReasoning()
        })
        const unsubscribe = ipc.on('import-generation:v1:global-progress', event => {
          if (!active || !isReferenceGlobalProgress(event) || event.projectId !== session.projectId || event.leaseId !== session.leaseId
            || event.runId !== run.id || event.execution.owner !== execution.owner || event.execution.epoch !== execution.epoch
            || event.sequence <= sequence) return
          sequence = event.sequence
          queue = queue.then(async () => {
            if (event.kind === 'log') { callbacks.log(globalLog(run.locale, context.writingLanguage, event.value)); return }
            if (event.kind === 'progress') { callbacks.setProgress(event.progress); return }
            if (event.kind === 'prompt-budget') { callbacks.setPromptBudgetReport?.(event.report); return }
            if (event.kind === 'candidate') { context.data.importGlobalInferenceCandidate = event.content; return }
            if (event.kind === 'committed') { await projectCommitted(); return }
            let acknowledged = false
            const ack = (decision: 'accept' | 'cancelled' | 'projection-failed') => ipc.invokeWithProjectSession(
              session, 'import-generation:v1:global-ack', { runId: run.id, execution, token: event.token, decision },
            )
            try {
              if (handle) throw new Error('GENERATION_REQUEST_FAILED')
              handle = Object.freeze({ ...event.handle })
              context.mainGenerationRunHandle = handle
              context.mainGenerationRootHandle = handle
              context.generationModelId = event.modelId
              pinWorkflowModel(context, event.modelId)
              unsubscribeReasoning = transport.subscribeReasoning?.(handle, reasoning => {
                if (!active || context.cancelled || !reasoning.attemptId || !reasoning.text
                  || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
                useWorkflowReasoningStore.getState().append(context.runId, reasoning.attemptId, reasoning.text)
              })
              runtime = await createMainOwnedGenerationRuntime({ runHandle: handle, onSnapshot: snapshot => {
                if (!active) return
                if (snapshot.diagnostics) callbacks.setGenerationActivity?.({ operation: 'import-global-facts', diagnostics: snapshot.diagnostics })
                if (callbacks.replaceText) callbacks.replaceText(snapshot.text)
                else {
                  const previous = displayed.get(snapshot.artifactId) ?? ''
                  if (snapshot.text.startsWith(previous)) callbacks.appendText(snapshot.text.slice(previous.length))
                }
                displayed.set(snapshot.artifactId, snapshot.text)
              } }, transport)
              callbacks.setGenerationActivity?.({ operation: 'import-global-facts' })
              acknowledged = true
              await ack(context.cancelled || context.cancelRequested ? 'cancelled' : 'accept')
            } catch (error) {
              projectionError = error
              if (!acknowledged) await ack(context.cancelled || context.cancelRequested ? 'cancelled' : 'projection-failed')
            }
          }).catch(error => { projectionError = error })
        })
        try {
          const result = await ipc.invokeWithProjectSession(session, 'import-generation:v1:global', { runId: run.id, execution, modelId }).catch(async error => { await queue; throw error })
          await queue
          if (!result || typeof result.success !== 'boolean') throw new Error('GENERATION_REQUEST_FAILED')
          if (!result.success) {
            if (typeof result.error !== 'string' || typeof result.errorCode !== 'string' || !result.errorCode) throw new Error('GENERATION_REQUEST_FAILED')
            if (Object.hasOwn(result, 'completionFailureCode')) {
              if (result.errorCode !== 'GENERATION_REQUEST_FAILED' || !isReferenceGlobalCompletionFailureCode(result.completionFailureCode)) throw new Error('GENERATION_REQUEST_FAILED')
              throw new BoundedCompletionFailure(result.completionFailureCode, result.error)
            }
            if (result.errorCode === 'GENERATION_REQUEST_FAILED') throw new Error(result.error)
            throw Object.assign(new Error(result.error), { code: result.errorCode })
          }
          const completedReplay = result.replayed === true && result.run?.status === 'completed' && result.run.stage === 'completed'
          const validExecution = result.execution === null ? completedReplay : !!result.execution
            && result.execution.owner === execution.owner && result.execution.epoch === execution.epoch
            && Number.isSafeInteger(result.execution.expiresAt) && result.execution.expiresAt > 0
          if (result.version !== 1 || !result.run || result.run.id !== run.id || result.run.rootRunId !== run.rootRunId
            || result.run.purpose !== 'reference' || !['style', 'blueprints', 'refresh', 'completed'].includes(result.run.stage)
            || !validExecution || typeof result.replayed !== 'boolean' || !result.receipt
            || result.receipt.state !== 'committed' || result.receipt.stage !== 'global' || result.receipt.batchId !== 'done'
            || result.receipt.kind !== 'project-global-facts' || !result.receipt.effectReceipt
            || (result.modelId !== null && (typeof result.modelId !== 'string' || !result.modelId.trim()))
            || (handle && (!result.handle || !sameGenerationHandle(handle, result.handle)))
            || (result.handle && (result.handle.projectId !== session.projectId
              || typeof result.handle.epoch !== 'string' || !result.handle.epoch.trim()
              || (!result.replayed && result.handle.epoch !== session.leaseId)
              || typeof result.handle.rootActionId !== 'string' || !result.handle.rootActionId.trim()
              || typeof result.handle.runId !== 'string' || !result.handle.runId.trim()))
            || (!result.replayed && !handle)) throw new Error('GENERATION_REQUEST_FAILED')
          try { assertImportRunEffectReceiptMetadata(result.receipt, run) } catch { throw new Error('GENERATION_REQUEST_FAILED') }
          if (result.execution === null) delete context.data.importRunExecution
          else context.data.importRunExecution = result.execution
          if (projectionError) throw projectionError
          if (runtime) await runtime.read()
          if (!projectedReceipt) await projectCommitted()
          if (JSON.stringify(projectedReceipt) !== JSON.stringify(result.receipt)) throw new Error('GENERATION_REQUEST_FAILED')
        } finally {
          active = false
          unsubscribe()
          unsubscribeReasoning?.()
          unsubscribeProject()
          clearReasoning()
          try { await runtime?.close() } finally { context.requestMainGenerationCancellation = previousCancellation }
        }
      },
      executeReferenceBlueprints: async (run: ImportRunSnapshot, owner: string) => {
        const captured = context.data.importRunExecution as ImportRunExecutionLease | undefined
        const lease = captured ?? referenceKnowledge.execution
        if (referenceKnowledge.reference.runId !== run.id || referenceKnowledge.reference.projectId !== session.projectId
          || lease.owner !== owner || lease.epoch !== referenceKnowledge.execution.epoch) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
        const execution = { owner: lease.owner, epoch: lease.epoch }
        const modelId = context.generationModelId?.trim() || routeModelId('import-blueprints') || null
        const transport = createMainGenerationTransport(() => session)
        const displayed = new Map<string, string>()
        const openedBatches = new Set<string>()
        let runtime: Awaited<ReturnType<typeof createMainOwnedGenerationRuntime>> | undefined
        let unsubscribeReasoning: (() => void) | undefined
        let handle: MainGenerationRunHandle | undefined
        let sequence = 0
        let active = true
        let syncedRangeAwaitingCompletion = false
        let syncedRangeCompleted = false
        let projectionError: unknown
        let queue = Promise.resolve()
        const previousCancellation = context.requestMainGenerationCancellation
        context.requestMainGenerationCancellation = async () => {
          const result = await ipc.invokeWithProjectSession(session, 'db:import-run-request-cancel', run.id, lease, projectPath)
          if (!result.success) throw new Error(result.error || 'IMPORT_RUN_CANCEL_REQUEST_FAILED')
        }
        const readReceipt = async (batchId: string) => {
          const receipt = await ipc.invokeWithProjectSession(session, 'db:import-run-effect-receipt-get', run.id, 'blueprints', batchId, projectPath)
          if (!receipt || receipt.state !== 'committed' || receipt.stage !== 'blueprints' || receipt.batchId !== batchId
            || receipt.kind !== 'chapter-blueprint-range' || !receipt.effectReceipt) throw new Error('GENERATION_REQUEST_FAILED')
          assertImportRunEffectReceiptMetadata(receipt, run)
          const committed = receipt.effectReceipt as BlueprintRangeCommitReceipt
          if (!committed.characterSyncOperation?.operationId || !Array.isArray(committed.snapshot)) throw new Error('GENERATION_REQUEST_FAILED')
          return { receipt, committed }
        }
        const projectSynced = async (batchId: string) => {
          const { committed } = await readReceipt(batchId)
          const operation = await ipc.invokeWithProjectSession(session, 'db:blueprint-character-sync-get', committed.characterSyncOperation.operationId, projectPath)
          if (!operation || operation.status !== 'completed' || !operation.completionReceipt
            || operation.operationId !== committed.characterSyncOperation.operationId
            || operation.completionReceipt.blueprintCommitOperationId !== committed.operationId) throw new Error('GENERATION_REQUEST_FAILED')
          context.data.blueprintCharacterSyncReceipt = operation.completionReceipt
          syncedRangeAwaitingCompletion = true
          syncedRangeCompleted = false
        }
        const refreshSyncedRange = () => {
          syncedRangeAwaitingCompletion = false
          syncedRangeCompleted = false
          const current = useProjectStore.getState().currentProject
          if (!current || !sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
            callbacks.log(textForLocale(run.locale, '当前正在查看其他作品，蓝图事实已安全保存至目标作品库', 'Viewing another project; blueprint facts saved safely to the target project database.'))
          }
          globalEventBus.emit('REFRESH_RESOURCE', { resources: ['fileTree', 'blueprints'], projectPath, projectSession: session })
        }
        const unsubscribeProject = useProjectStore.subscribe(state => {
          if (!sameProjectSessionContext(session, projectSessionContextFromProject(state.currentProject))) useWorkflowReasoningStore.getState().clear(context.runId)
        })
        const unsubscribe = ipc.on('import-generation:v1:blueprints-progress', event => {
          if (!active || !isReferenceBlueprintProgress(event) || event.projectId !== session.projectId || event.leaseId !== session.leaseId
            || event.runId !== run.id || event.execution.owner !== execution.owner || event.execution.epoch !== execution.epoch
            || event.sequence <= sequence) return
          sequence = event.sequence
          queue = queue.then(async () => {
            if (event.kind === 'log') {
              callbacks.log(blueprintLog(run.locale, event.value))
              if (syncedRangeAwaitingCompletion && event.value.key === 'complete') syncedRangeCompleted = true
              return
            }
            if (event.kind === 'progress') {
              callbacks.setProgress(event.progress)
              if (event.progress === 100 && syncedRangeCompleted) refreshSyncedRange()
              return
            }
            if (event.kind === 'prompt-budget') { callbacks.setPromptBudgetReport?.(event.report); return }
            if (event.kind === 'range-committed') { context.data.blueprintCommitReceipt = (await readReceipt(event.batchId)).committed; return }
            if (event.kind === 'range-synced') { await projectSynced(event.batchId); return }
            if (event.kind !== 'opened') return
            let acknowledged = false
            const ack = (decision: 'accept' | 'cancelled' | 'projection-failed') => ipc.invokeWithProjectSession(
              session, 'import-generation:v1:blueprints-ack', { runId: run.id, execution, batchId: event.batchId, token: event.token, decision },
            )
            try {
              if (projectionError || openedBatches.has(event.batchId)) throw new Error('GENERATION_REQUEST_FAILED')
              if (runtime) { await runtime.read(); await runtime.close(); runtime = undefined }
              unsubscribeReasoning?.(); unsubscribeReasoning = undefined
              useWorkflowReasoningStore.getState().clear(context.runId)
              openedBatches.add(event.batchId)
              handle = Object.freeze({ ...event.handle })
              context.mainGenerationRunHandle = handle
              context.mainGenerationRootHandle = handle
              context.generationModelId = event.modelId
              pinWorkflowModel(context, event.modelId)
              unsubscribeReasoning = transport.subscribeReasoning?.(handle, reasoning => {
                if (!active || context.cancelled || !reasoning.attemptId || !reasoning.text
                  || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
                useWorkflowReasoningStore.getState().append(context.runId, reasoning.attemptId, reasoning.text)
              })
              runtime = await createMainOwnedGenerationRuntime({ runHandle: handle, onSnapshot: snapshot => {
                if (!active) return
                if (snapshot.diagnostics) callbacks.setGenerationActivity?.({ operation: 'import-blueprints', diagnostics: snapshot.diagnostics })
                if (callbacks.replaceText) callbacks.replaceText(snapshot.text)
                else {
                  const previous = displayed.get(snapshot.artifactId) ?? ''
                  if (snapshot.text.startsWith(previous)) callbacks.appendText(snapshot.text.slice(previous.length))
                }
                displayed.set(snapshot.artifactId, snapshot.text)
              } }, transport)
              callbacks.setGenerationActivity?.({ operation: 'import-blueprints' })
              acknowledged = true
              await ack(context.cancelled || context.cancelRequested ? 'cancelled' : 'accept')
            } catch (error) {
              projectionError ??= error
              if (!acknowledged) await ack(context.cancelled || context.cancelRequested ? 'cancelled' : 'projection-failed')
            }
          }).catch(error => { projectionError ??= error })
        })
        try {
          const result = await ipc.invokeWithProjectSession(session, 'import-generation:v1:blueprints', { runId: run.id, execution, modelId }).catch(async error => { await queue; throw error })
          await queue
          if (!result || typeof result.success !== 'boolean') throw new Error('GENERATION_REQUEST_FAILED')
          if (!result.success) {
            if (typeof result.error !== 'string' || typeof result.errorCode !== 'string' || !result.errorCode) throw new Error('GENERATION_REQUEST_FAILED')
            if (Object.hasOwn(result, 'postCommitSyncBatchId')) {
              if (result.errorCode !== 'GENERATION_REQUEST_FAILED' || !isReferenceBlueprintBatchId(result.postCommitSyncBatchId)) throw new Error('GENERATION_REQUEST_FAILED')
              const { committed } = await readReceipt(result.postCommitSyncBatchId)
              context.data.blueprintCommitReceipt = committed
              const { ImportBlueprintPostCommitSyncError } = await import('./commands/import-novel.command')
              throw new ImportBlueprintPostCommitSyncError(committed, (zh, en) => textForLocale(run.locale, zh, en))
            }
            if (result.errorCode === 'GENERATION_REQUEST_FAILED') throw new Error(result.error)
            throw Object.assign(new Error(result.error), { code: result.errorCode })
          }
          const completedReplay = result.replayed === true && result.run?.status === 'completed' && result.run.stage === 'completed'
          const validExecution = result.execution === null ? completedReplay : !!result.execution
            && result.execution.owner === execution.owner && result.execution.epoch === execution.epoch
            && Number.isSafeInteger(result.execution.expiresAt) && result.execution.expiresAt > 0
          if (result.version !== 1 || !result.run || result.run.id !== run.id || result.run.rootRunId !== run.rootRunId
            || result.run.purpose !== 'reference' || !['refresh', 'completed'].includes(result.run.stage)
            || !validExecution || typeof result.replayed !== 'boolean' || !result.receipt
            || !isReferenceBlueprintBatchId(result.receipt.batchId)
            || (result.modelId !== null && (typeof result.modelId !== 'string' || !result.modelId.trim()))
            || (handle && (!result.handle || !sameGenerationHandle(handle, result.handle)))
            || (result.handle && (result.handle.projectId !== session.projectId
              || typeof result.handle.epoch !== 'string' || !result.handle.epoch.trim()
              || (!result.replayed && result.handle.epoch !== session.leaseId)
              || typeof result.handle.rootActionId !== 'string' || !result.handle.rootActionId.trim()
              || typeof result.handle.runId !== 'string' || !result.handle.runId.trim()))
            || (!result.replayed && !handle)) throw new Error('GENERATION_REQUEST_FAILED')
          const canonical = await readReceipt(result.receipt.batchId)
          if (JSON.stringify(canonical.receipt) !== JSON.stringify(result.receipt)) throw new Error('GENERATION_REQUEST_FAILED')
          if (result.execution === null) delete context.data.importRunExecution
          else context.data.importRunExecution = result.execution
          if (projectionError) throw projectionError
          if (runtime) await runtime.read()
        } finally {
          active = false
          unsubscribe()
          unsubscribeReasoning?.()
          unsubscribeProject()
          useWorkflowReasoningStore.getState().clear(context.runId)
          try { await runtime?.close() } finally { context.requestMainGenerationCancellation = previousCancellation }
        }
      },
      executeReferenceStyle: async (run: ImportRunSnapshot, owner: string) => {
        const captured = context.data.importRunExecution as ImportRunExecutionLease | undefined
        const lease = captured ?? referenceKnowledge.execution
        if (referenceKnowledge.reference.runId !== run.id || referenceKnowledge.reference.projectId !== session.projectId
          || lease.owner !== owner || lease.epoch !== referenceKnowledge.execution.epoch) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
        const execution = { owner: lease.owner, epoch: lease.epoch }
        const modelId = context.generationModelId?.trim() || routeModelId('analyze-writing-style') || null
        const transport = createMainGenerationTransport(() => session)
        const displayed = new Map<string, string>()
        const projection: { runtime?: Awaited<ReturnType<typeof createMainOwnedGenerationRuntime>> } = {}
        let unsubscribeReasoning: (() => void) | undefined
        let handle: MainGenerationRunHandle | undefined
        let expected: NovelConfig | undefined
        let sequence = 0
        let active = true
        let projectionError: unknown
        let queue = Promise.resolve()
        const clearReasoning = () => useWorkflowReasoningStore.getState().clear(context.runId)
        const previousCancellation = context.requestMainGenerationCancellation
        const requestCancel = async () => {
          const result = await ipc.invokeWithProjectSession(session, 'db:import-run-request-cancel', run.id, lease, projectPath)
          if (!result.success) throw new Error(result.error || 'IMPORT_RUN_CANCEL_REQUEST_FAILED')
        }
        context.requestMainGenerationCancellation = requestCancel
        const ack = async (token: string, phase: ReferenceStyleAckRequest['phase'], decision: ReferenceStyleAckRequest['decision']) =>
          ipc.invokeWithProjectSession(session, 'import-generation:v1:style-ack', { runId: run.id, execution, token, phase, decision })
        const unsubscribeProject = useProjectStore.subscribe(state => {
          if (!sameProjectSessionContext(session, projectSessionContextFromProject(state.currentProject))) clearReasoning()
        })
        const unsubscribe = ipc.on('import-generation:v1:style-progress', event => {
          if (!active || !isReferenceStyleProgress(event) || event.projectId !== session.projectId
            || event.leaseId !== session.leaseId || event.runId !== run.id || event.execution.owner !== execution.owner
            || event.execution.epoch !== execution.epoch || event.sequence <= sequence) return
          sequence = event.sequence
          let openedConfig: NovelConfig | undefined
          let openedError: unknown
          if (event.kind === 'opened') {
            try {
              const project = useProjectStore.getState().currentProject
              if (!project || !sameProjectSessionContext(session, projectSessionContextFromProject(project))) throw new Error('GENERATION_AUTHOR_DRAFT_CHANGED')
              openedConfig = structuredClone(project.novelConfig)
            } catch (error) { openedError = error }
          }
          queue = queue.then(async () => {
            if (event.kind === 'log') { callbacks.log(styleLog(run.locale, event.log, 'count' in event ? event.count : undefined)); return }
            if (event.kind === 'progress') { callbacks.setProgress(event.progress); return }
            if (event.kind === 'prompt-budget') { callbacks.setPromptBudgetReport?.(event.report); return }
            if (event.kind === 'opened') {
              let acknowledged = false
              try {
                if (handle) throw new Error('GENERATION_REQUEST_FAILED')
                handle = Object.freeze({ ...event.handle })
                if (openedError) throw openedError
                expected = openedConfig
                context.mainGenerationRunHandle = handle
                context.mainGenerationRootHandle = handle
                context.generationModelId = event.modelId
                pinWorkflowModel(context, event.modelId)
                unsubscribeReasoning = transport.subscribeReasoning?.(handle, reasoning => {
                  if (!active || context.cancelled || !reasoning.attemptId || !reasoning.text
                    || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
                  useWorkflowReasoningStore.getState().append(context.runId, reasoning.attemptId, reasoning.text)
                })
                projection.runtime = await createMainOwnedGenerationRuntime({ runHandle: handle, onSnapshot: snapshot => {
                  if (!active) return
                  if (snapshot.diagnostics) callbacks.setGenerationActivity?.({ operation: 'analyze-writing-style', diagnostics: snapshot.diagnostics })
                  if (callbacks.replaceText) callbacks.replaceText(snapshot.text)
                  else {
                    const previous = displayed.get(snapshot.artifactId) ?? ''
                    if (snapshot.text.startsWith(previous)) callbacks.appendText(snapshot.text.slice(previous.length))
                  }
                  displayed.set(snapshot.artifactId, snapshot.text)
                } }, transport)
                if (context.cancelled || context.cancelRequested) { acknowledged = true; await ack(event.token, 'opened', 'cancelled'); return }
                callbacks.setGenerationActivity?.({ operation: 'analyze-writing-style' })
                acknowledged = true
                await ack(event.token, 'opened', 'accept')
              } catch (error) {
                projectionError = error
                if (!acknowledged) await ack(event.token, 'opened', context.cancelled || context.cancelRequested ? 'cancelled' : 'projection-failed')
              }
              return
            }
            let acknowledged = false
            try {
              if (!handle || !expected || !sameGenerationHandle(handle, event.handle)) throw new Error('GENERATION_REQUEST_FAILED')
              if (context.cancelled || context.cancelRequested) { await ack(event.token, 'commit', 'cancelled'); return }
              const saved = await useProjectStore.getState().commitGeneratedNovelConfig(
                { writingStyle: event.writingStyle }, expected, session, handle, async () => {
                  acknowledged = true
                  const result = await ack(event.token, 'commit', 'accept')
                  if (result.version !== 1 || typeof result.savedWritingStyle !== 'string' || !result.savedWritingStyle.trim()) throw new Error('GENERATION_REQUEST_FAILED')
                  return { writingStyle: result.savedWritingStyle }
                },
              )
              if (!saved) throw new Error(textForLocale(run.locale, '文风特征保存失败', 'Failed to save the writing-style profile.'))
            } catch (error) {
              projectionError = error
              if (!acknowledged) await ack(event.token, 'commit', context.cancelled || context.cancelRequested ? 'cancelled'
                : error instanceof Error && error.message === 'GENERATION_AUTHOR_DRAFT_CHANGED' ? 'draft-changed' : 'projection-failed')
            }
          }).catch(error => { projectionError = error })
        })
        try {
          const result = await ipc.invokeWithProjectSession(session, 'import-generation:v1:style', { runId: run.id, execution, modelId }).catch(async error => {
            await queue
            throw error
          })
          await queue
          if (!result || typeof result.success !== 'boolean') throw new Error('GENERATION_REQUEST_FAILED')
          if (!result.success) {
            if (typeof result.error !== 'string' || typeof result.errorCode !== 'string' || !result.errorCode) throw new Error('GENERATION_REQUEST_FAILED')
            if (result.errorCode === 'GENERATION_AUTHOR_DRAFT_CHANGED' && projectionError instanceof Error
              && projectionError.message === 'GENERATION_AUTHOR_DRAFT_CHANGED') throw projectionError
            throw Object.assign(new Error(result.error), { code: result.errorCode })
          }
          const completedReplay = result.replayed === true && result.run?.status === 'completed' && result.run.stage === 'completed'
          const validExecution = result.execution === null ? completedReplay
            : !!result.execution && result.execution.owner === execution.owner && result.execution.epoch === execution.epoch
              && Number.isSafeInteger(result.execution.expiresAt) && result.execution.expiresAt > 0
          if (result.version !== 1 || !result.run || result.run.id !== run.id || result.run.rootRunId !== run.rootRunId
            || result.run.purpose !== 'reference' || !['blueprints', 'refresh', 'completed'].includes(result.run.stage)
            || !validExecution
            || typeof result.savedWritingStyle !== 'string' || !result.savedWritingStyle.trim()
            || typeof result.replayed !== 'boolean' || (handle && (!result.handle || !sameGenerationHandle(handle, result.handle)))
            || (result.handle && (result.handle.projectId !== session.projectId
              || typeof result.handle.epoch !== 'string' || !result.handle.epoch.trim()
              || (!result.replayed && result.handle.epoch !== session.leaseId)
              || typeof result.handle.rootActionId !== 'string' || !result.handle.rootActionId.trim()
              || typeof result.handle.runId !== 'string' || !result.handle.runId.trim())) || (!result.replayed && !handle)) {
            throw new Error('GENERATION_REQUEST_FAILED')
          }
          if (result.execution === null) delete context.data.importRunExecution
          else context.data.importRunExecution = result.execution
          if (projectionError) throw projectionError
          if (projection.runtime) await projection.runtime.read()
          if (result.replayed) {
            const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
            if (!core) throw new Error(textForLocale(run.locale, '无法读取已保存的导入配置。', 'Could not read committed project configuration.'))
            const current = useProjectStore.getState().currentProject
            if (current && sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
              useProjectStore.getState().publishSavedNovelConfig(configFieldsFromCore(core), session, 'unsaved-edits')
            } else callbacks.log(textForLocale(run.locale, '导入结果已持久化入库；前台正浏览其他作品，跳过前台界面同步。', 'Import effect persisted to storage; foreground is viewing another project, skipping UI sync.'))
          }
          const current = useProjectStore.getState().currentProject
          if (current && sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
            context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
          }
        } finally {
          active = false
          unsubscribe()
          unsubscribeReasoning?.()
          unsubscribeProject()
          clearReasoning()
          await projection.runtime?.close()
          context.requestMainGenerationCancellation = previousCancellation
        }
      },
      executeReferenceKnowledge: async (run: ImportRunSnapshot, owner: string) => {
        const { reference, execution } = referenceKnowledge
        if (reference.runId !== run.id || reference.projectId !== session.projectId || execution.owner !== owner) {
          throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
        }
        const authority = { owner: execution.owner, epoch: execution.epoch }
        let active = true
        const unsubscribe = ipc.on('reference-knowledge:v1:progress', event => {
          if (!active || !isReferenceKnowledgeProgress(event) || event.reference.projectId !== reference.projectId
            || event.reference.runId !== reference.runId || event.reference.grantId !== reference.grantId
            || event.reference.revision !== reference.revision || event.execution.owner !== authority.owner
            || event.execution.epoch !== authority.epoch) return
          if (event.kind === 'batch') callbacks.setProgress(event.progress)
          else callbacks.log(textForLocale(run.locale,
            `参照章节 ${event.chapterNumber} 已进入知识库${event.idempotent ? '（已存在）' : ''}`,
            `Reference Chapter ${event.chapterNumber} is in the knowledge base${event.idempotent ? ' (already present)' : ''}.`))
        })
        try {
          const result = await ipc.invokeWithProjectSession(session, 'reference-knowledge:v1:execute', { reference, execution: authority })
          if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
          if (!result.success) {
            if (typeof result.error !== 'string' || typeof result.errorCode !== 'string' || !result.errorCode) {
              throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
            }
            throw Object.assign(new Error(result.error), { code: result.errorCode })
          }
          if (!result.run || result.run.id !== run.id || result.run.purpose !== 'reference'
            || result.run.rootRunId !== run.rootRunId || result.run.stage !== 'global'
            || !result.execution || result.execution.owner !== authority.owner || result.execution.epoch !== authority.epoch
            || !Number.isSafeInteger(result.execution.expiresAt) || result.execution.expiresAt <= 0) {
            throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
          }
          context.data.importRunExecution = result.execution
          return { run: result.run, execution: result.execution }
        } finally { active = false; unsubscribe() }
      },
    } : {}),
    startOrResume: async (runId, owner) => {
      const start = referenceKnowledge
        ? await ipc.invokeWithProjectSession(session, 'reference-knowledge:v1:resume', referenceKnowledge.reference)
        : required(
            await ipc.invokeWithProjectSession(session, 'db:import-run-start-resume', runId, owner, projectPath),
            '无法开始或继续这次导入。',
            'Could not start or resume the import run.',
          ).start!
      if (referenceKnowledge && (start.run.id !== runId || start.execution.owner !== owner
        || start.execution.epoch !== referenceKnowledge.execution.epoch)) {
        throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
      }
      context.data.importRunExecution = start.execution
      return start
    },
    renewExecution: async (runId, execution) => {
      const renewed = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-renew-execution', runId, execution, projectPath,
        ),
        '无法延长这次导入的写入时限。',
        'Could not renew the import execution lease.',
      ).execution!
      context.data.importRunExecution = renewed
      return renewed
    },
    getEffectReceipt: (runId, stage, checkpoint) => ipc.invokeWithProjectSession(
      session,
      'db:import-run-effect-receipt-get',
      runId,
      stage,
      checkpoint,
      projectPath,
    ),
    prepareEffectReceipt: async (request, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-prepare',
        request,
        execution,
        projectPath,
      ),
      '无法保存 AI 生成的导入结果。',
      'Could not freeze generated import output.',
    ).receipt!,
    commitEffectReceipt: async (runId, stage, checkpoint, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-commit',
        runId,
        stage,
        checkpoint,
        execution,
        projectPath,
      ),
      '无法提交 AI 生成的导入结果。',
      'Could not commit the generated import output.',
    ).result!,
    replayCommittedEffect: async (receipt, run) => {
      // Re-read through the main-process repository so replay receives the
      // same canonical rehash and schema checks as get/commit, then reject any
      // renderer-side object that differs from that durable receipt.
      const durableReceipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        run.id,
        receipt.stage,
        receipt.batchId,
        projectPath,
      )
      if (!durableReceipt || JSON.stringify(durableReceipt) !== JSON.stringify(receipt)) {
        throw importRecordError(
          run.locale,
          '已提交的导入结果与保存的记录不一致。',
          'Committed import effect receipt does not match durable storage.',
        )
      }
      assertImportRunEffectReceiptMetadata(durableReceipt, run)
      if (durableReceipt.state !== 'committed') {
        throw importRecordError(run.locale, '导入结果还没有提交，不能直接恢复。', 'Prepared import effects cannot be replayed.')
      }
      if (durableReceipt.kind === 'chapter-blueprint-range') {
        const committed = durableReceipt.effectReceipt as BlueprintRangeCommitReceipt | undefined
        if (!committed?.characterSyncOperation?.operationId) {
          throw importRecordError(run.locale, '已保存的章节蓝图导入记录不完整。', 'Committed blueprint import receipt is incomplete.')
        }
        await retryDirectoryCharacterSync(
          committed.characterSyncOperation.operationId,
          projectPath,
          session,
          run.locale,
        )
        return
      }
      if (durableReceipt.kind === 'author-finalized-batch') {
        const authorReceipt = durableReceipt.effectReceipt as FinalizedDraftImportReceipt | undefined
        if (
          !authorReceipt
          || authorReceipt.operationId !== `author-import:${run.id}`
          || authorReceipt.drafts.length !== run.totalChapters
        ) throw importRecordError(run.locale, '已保存的作者原稿导入记录不完整。', 'Committed author-manuscript receipt is incomplete.')
        return
      }
      const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
      if (!core) {
        throw new Error(textForLocale(
          run.locale,
          '无法读取已保存的导入配置。',
          'Could not read committed project configuration.',
        ))
      }
      const current = useProjectStore.getState().currentProject
      if (current && sameProjectSessionContext(
        session,
        projectSessionContextFromProject(current),
      )) {
        useProjectStore.getState().publishSavedNovelConfig(configFieldsFromCore(core), session, 'unsaved-edits')
        context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
      } else {
        callbacks.log(textForLocale(
          run.locale,
          '导入结果已持久化入库；前台正浏览其他作品，跳过前台界面同步。',
          'Import effect persisted to storage; foreground is viewing another project, skipping UI sync.',
        ))
      }
    },
    listChapters: (runId, after, limit) => ipc.invokeWithProjectSession(
      session, 'db:import-run-list-chapters', runId, after, limit, projectPath,
    ),
    listRepresentativeChapters: runId => ipc.invokeWithProjectSession(
      session, 'db:import-run-list-representative-chapters', runId, projectPath,
    ),
    importReference: async (chapter, run, executionAuthority) => {
      if (!referenceKnowledge) throw new Error('KNOWLEDGE_BASE_REFERENCE_ISSUANCE_REQUIRED')
      const result = await ipc.invokeWithProjectSession(
        session,
        'reference-knowledge:v1:import',
        { reference: referenceKnowledge.reference, chapterNumber: chapter.number, execution: executionAuthority },
      )
      // 带上主进程给的码：取消请求之后剩下的章节被拒绝时，取消判定只凭这个码。
      if (!result.success) throw Object.assign(new Error(result.error || textForLocale(
        run.locale,
        `第 ${chapter.number} 章参照文本未能写入知识库`,
        `Reference Chapter ${chapter.number} could not be written to the knowledge base.`,
      )), result.errorCode ? { code: result.errorCode } : {})
      callbacks.log(textForLocale(
        run.locale,
        `参照章节 ${chapter.number} 已进入知识库${result.idempotent ? '（已存在）' : ''}`,
        `Reference Chapter ${chapter.number} is in the knowledge base${result.idempotent ? ' (already present)' : ''}.`,
      ))
    },
    inferGlobal: async (chapters, stats, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'global', batchId: 'done' }
      context.data.importRunPurpose = run.purpose
      context.data.chapters = chapters.map(importedChapter)
      context.data.importRunTotalChapters = stats.totalChapters
      context.data.importRunTotalWords = stats.totalWords
      const { InferGlobalSettingsCommand } = await import('./commands/import-novel.command')
      await new InferGlobalSettingsCommand(undefined, async request => (
        await commit(request)
      ) as ImportGlobalFactsReceipt, run.purpose === 'author-manuscript').execute({ step: {} as never, context, callbacks })
    },
    analyzeStyle: async (chapters, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'style', batchId: 'done' }
      context.data.importRunPurpose = run.purpose
      const { AnalyzeWritingStyleCommand } = await import('./commands/analyze-style.command')
      const style = await new AnalyzeWritingStyleCommand(
        { chapters: chapters.map(importedChapter), fillEmpty: run.purpose === 'author-manuscript' },
        undefined,
        async (writingStyle, generationRunHandle) => {
          const saved = await commit({ writingStyle, ...(generationRunHandle ? { generationRunHandle } : {}) }) as { writingStyle: string }
          return saved.writingStyle
        },
      )
        .execute({ step: {} as never, context, callbacks })
      if (!style.trim()) throw new Error(textForLocale(
        context.uiLocale,
        '未提取到可用文风，无法继续建立仿写约束',
        'No usable writing style was extracted, so imitation guidance cannot be created.',
      ))
    },
    inferBlueprints: async (chapters, checkpoint, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'blueprints', batchId: checkpoint }
      context.data.importRunPurpose = run.purpose
      context.data.chapters = chapters.map(importedChapter)
      const current = useProjectStore.getState().currentProject
      if (!context.data.novelConfigSummary && current && sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
        context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
      }
      const { InferBlueprintsPerChapterCommand } = await import('./commands/import-novel.command')
      await new InferBlueprintsPerChapterCommand(undefined, async request => (
        await commit(request)
      ) as BlueprintRangeCommitReceipt).execute({ step: {} as never, context, callbacks })
    },
    listBlueprintChapterNumbers: async () => new Set(
      (await ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', projectPath))
        .map(blueprint => blueprint.chapterNumber),
    ),
    commitAuthorManuscript: async (run, commit) => {
      if (!run.authorityFingerprint || !run.manifestFingerprint) {
        throw new Error(textForLocale(
          run.locale,
          '作者原稿导入缺少权威状态指纹',
          'The author-manuscript import is missing its authority fingerprint.',
        ))
      }
      await commit({
        operationId: `author-import:${run.id}`,
        runId: run.id,
        authorityFingerprint: run.authorityFingerprint,
        manifestFingerprint: run.manifestFingerprint,
      })
    },
    getAuthorCommitReceipt: async runId => {
      const receipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        runId,
        'author-commit',
        'done',
        projectPath,
      )
      if (!receipt) return null
      if (receipt.state !== 'committed' || receipt.kind !== 'author-finalized-batch') {
        throw importRecordError(
          context.uiLocale,
          '作者原稿定稿还没有保存完成。',
          'Author-manuscript finalization has not been durably committed.',
        )
      }
      return receipt.effectReceipt as FinalizedDraftImportReceipt
    },
    isAuthorDraftReplaced: async draft => {
      const meta = await ipc.invokeWithProjectSession(session, 'db:draft-get-meta', draft.draftId, projectPath)
      return meta?.status === 'superseded'
    },
    publishAuthorChapter: async (chapter, draft, run) => {
      const { retryFinalizationPublication } = await import('../finalization-client')
      const result = await retryFinalizationPublication(draft.finalizationId, session)
      if (!result.success || result.publicationStatus !== 'published') {
        throw new Error(result.error || textForLocale(
          run.locale,
          `第 ${chapter.number} 章实体正文发布失败`,
          `Chapter ${chapter.number} could not be published to the manuscript directory.`,
        ))
      }
      callbacks.log(textForLocale(
        run.locale,
        `第 ${chapter.number} 章实体正文已发布`,
        `Chapter ${chapter.number} was published to the manuscript directory.`,
      ))
    },
    postprocessAuthorChapter: async (chapter, draft, run) => {
      const current = useProjectStore.getState().currentProject
      if (!current || !sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
        throw new Error(textForLocale(
          run.locale,
          '当前项目已切换，无法更新原稿连续性事实',
          'The project changed before manuscript continuity could be updated.',
        ))
      }
      const { RunFinalizePostProcessCommand } = await import('./commands/finalize-chapter.command')
      const status = await new RunFinalizePostProcessCommand({
        project: current,
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        draftContent: chapter.content,
        draftId: draft.draftId,
        finalizedSource: {
          draftId: draft.draftId,
          finalizationId: draft.finalizationId,
          chapterNumber: chapter.number,
          contentHash: draft.contentHash,
        },
        sourceLabel: textForLocale(
          run.locale,
          `第${chapter.number}章作者原稿定稿`,
          `Author manuscript Chapter ${chapter.number} finalization`,
        ),
        stopOnFailure: true,
        onlyFailed: true,
      }).execute({ step: {} as never, context, callbacks })
      if (!status.allCriticalPassed) {
        throw new Error(textForLocale(
          run.locale,
          `第 ${chapter.number} 章连续性后处理未完成`,
          `Continuity post-processing did not complete for Chapter ${chapter.number}.`,
        ))
      }
    },
    refresh: async run => {
      callbacks.log(textForLocale(run.locale, '正在刷新项目数据...', 'Refreshing project data...'))
      await refreshImportDerivedFileTreeBestEffort(
        () => useProjectStore.getState().refreshFileTree(projectPath, undefined, session),
        callbacks,
        (zhCNText, enUSText) => textForLocale(run.locale, zhCNText, enUSText),
      )
      const [{ useCharacterStore }, { useDraftStore }] = await Promise.all([
        import('../../stores/character-store'),
        import('../../stores/draft-store'),
      ])
      await useCharacterStore.getState().loadCharacters(projectPath, session)
      await useDraftStore.getState().loadAllDrafts(projectPath, session)
    },
    completeBatch: async (runId, stage, checkpoint, execution) => {
      const result = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-complete-batch', runId, stage, checkpoint, execution, projectPath,
        ),
        '无法保存导入进度。',
        'Could not save the import checkpoint.',
      )
      return { cancelApplied: result.cancelApplied ?? false, run: result.run! }
    },
    advanceStage: async (runId, completedStage, nextStage, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-advance-stage', runId, completedStage, nextStage, execution, projectPath,
      ),
      '无法推进导入进度。',
      'Could not advance the import checkpoint.',
    ).run!,
    fail: async (runId, stage, error, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-fail', runId, stage, error, execution, projectPath,
      ),
      '无法保存导入失败记录。',
      'Could not save the import failure.',
    ).run!,
    cancelAtBoundary: async (runId, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-cancel-at-boundary', runId, execution, projectPath,
      ),
      '无法保存导入取消状态。',
      'Could not save import cancellation.',
    ).run!,
    complete: async (runId, execution) => {
      const run = required(
      await ipc.invokeWithProjectSession(session, 'db:import-run-complete', runId, execution, projectPath),
      '无法完成这次导入。',
      'Could not complete the import run.',
      ).run!
      if (referenceKnowledge) {
        const result = await ipc.invokeWithProjectSession(session, 'reference-knowledge:v1:complete', referenceKnowledge.reference)
        if (result.state !== 'completed') throw new Error('KNOWLEDGE_BASE_REFERENCE_COMPLETE_FAILED')
      }
      return run
    },
  }
}

type ImportWorkflowStage = Exclude<ImportRunStage, 'parsing' | 'prepared' | 'completed'>

/** Executor wall time includes admission/checkpoint reads, not proof of a new stage effect. */
function importStageObservation(stage: ImportWorkflowStage): (() => void) | undefined {
  try {
    const sink = (globalThis as Record<symbol, unknown>)[Symbol.for('pagekin.performance-baseline.renderer')] as {
      now(): number
      record(name: Extract<PerformanceMetric, `workflow.import.${string}`>, value: number): void
    } | undefined
    if (!sink || typeof sink.now !== 'function' || typeof sink.record !== 'function') return undefined
    const started = sink.now()
    if (!Number.isFinite(started) || started < 0) return undefined
    return () => {
      try {
        const ended = sink.now()
        if (Number.isFinite(ended) && ended >= 0) sink.record(`workflow.import.${stage}.ms`, Math.max(0, ended - started))
      } catch { /* Stage diagnostics cannot change workflow outcomes. */ }
    }
  } catch { return undefined }
}

function createImportStep(
  run: ImportRunSnapshot,
  executionOwner: string,
  stage: ImportWorkflowStage,
  name: [string, string],
  description: [string, string],
  referenceKnowledge?: ReferenceKnowledgeIssuance,
) {
  return {
    name: textForLocale(run.locale, ...name),
    description: textForLocale(run.locale, ...description),
    executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
      const observe = importStageObservation(stage)
      try {
        await new ImportRunOrchestrator(productionDependencies(context, callbacks, referenceKnowledge))
          .executeStage(run.id, stage, executionOwner, context, callbacks)
      } finally { observe?.() }
    },
  }
}

export function createImportWorkflow(params: ImportWorkflowParams): WorkflowDefinition {
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(params.projectSession, projectSessionContextFromProject(project))) {
    throw new Error(textForLocale(
      params.run.locale,
      '当前项目已切换，无法启动导入工作流',
      'The project changed, so the import workflow cannot start.',
    ))
  }
  const session = Object.freeze({ ...params.projectSession })
  let referenceKnowledge: ReferenceKnowledgeIssuance | undefined
  if (params.run.purpose === 'reference') {
    const issuance = params.referenceKnowledge
    if (!issuance) throw new Error('KNOWLEDGE_BASE_REFERENCE_ISSUANCE_REQUIRED')
    assertReferenceKnowledgeRequest('reference-knowledge:v1:resume', issuance.reference)
    assertReferenceKnowledgeRequest('reference-knowledge:v1:import', {
      reference: issuance.reference, chapterNumber: 1,
      execution: { owner: issuance.execution?.owner, epoch: issuance.execution?.epoch },
    })
    if (issuance.reference.projectId !== session.projectId || issuance.reference.runId !== params.run.id
      || issuance.execution.owner !== params.executionOwner || !Number.isFinite(issuance.execution.expiresAt)) {
      throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
    }
    referenceKnowledge = Object.freeze({
      reference: Object.freeze({ ...issuance.reference }), execution: Object.freeze({ ...issuance.execution }),
    })
  }
  const importStep = (run: ImportRunSnapshot, owner: string, stage: ImportWorkflowStage,
    name: [string, string], description: [string, string]) =>
    createImportStep(run, owner, stage, name, description, referenceKnowledge)
  const count = params.run.totalChapters
  const chapterCountEn = `${count} ${count === 1 ? 'chapter' : 'chapters'}`
  const contextReadResourceKeys = [
    workflowResourceKey('novel-config'),
    workflowResourceKey('architecture'),
    workflowResourceKey('blueprints'),
  ]
  const durableCancelHooks: Pick<WorkflowDefinition, 'onCancelRequested'> = {
    onCancelRequested: async context => {
      if (referenceKnowledge) {
        await ipc.invoke('reference-knowledge:v1:revoke', referenceKnowledge.reference)
        return
      }
      const execution = context.data.importRunExecution as ImportRunExecutionLease | undefined
      if (!execution) return
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-request-cancel',
        params.run.id,
        execution,
        params.projectPath,
      )
      if (!result.success) throw new Error(result.error || textForLocale(
        params.run.locale,
        '无法保存导入取消请求',
        'Could not persist the import cancellation request.',
      ))
    },
  }
  if (params.run.purpose === 'author-manuscript') {
    const authorChapterNumbers = normalizeAuthorChapterNumbers(
      params.run,
      params.authorChapterNumbers,
    )
    const inference = params.run.authorInference === true
    const inferenceSteps = inference ? [
      importStep(params.run, params.executionOwner, 'global',
        ['反推设定、架构与角色', 'Infer settings, architecture, and characters'],
        ['只补空白的设定与架构，已有内容不动；不同的反推结果留作建议，角色以提议保存', 'Fill only empty settings and architecture; differing results become suggestions and characters become proposals.']),
      importStep(params.run, params.executionOwner, 'style',
        ['反推文风', 'Infer writing style'],
        ['文风为空才写入，已有文风留作建议', 'Write the style only when it is empty; otherwise keep it as a suggestion.']),
      importStep(params.run, params.executionOwner, 'blueprints',
        ['为没有蓝图的章反推蓝图', 'Infer blueprints for chapters without one'],
        ['已有蓝图的章不调用模型、不改动', 'Chapters that already have a blueprint are left untouched.']),
    ] : []
    return {
      runId: params.run.id,
      type: 'novel_import',
      title: textForLocale(
        params.run.locale,
        `导入作者原稿（${count} 章）`,
        `Import author manuscript (${chapterCountEn})`,
      ),
      projectPath: params.projectPath,
      projectSession: session,
      uiLocale: params.run.locale,
      resourceKeys: [
        ...authorChapterNumbers.map(chapterNumber => workflowResourceKey('chapter', chapterNumber)),
        ...FINALIZATION_SHARED_WRITE_RESOURCE_KINDS.map(kind => workflowResourceKey(kind)),
        ...(inference ? contextReadResourceKeys : []),
      ],
      readResourceKeys: inference ? [] : contextReadResourceKeys,
      ...durableCancelHooks,
      steps: [
        importStep(params.run, params.executionOwner, 'author-commit',
          ['提交权威定稿快照', 'Commit authoritative finalized snapshots'],
          ['以单个 SQLite 事务提交不可变定稿与发布 outbox', 'Atomically commit immutable finalized snapshots and publication outbox records.']),
        importStep(params.run, params.executionOwner, 'author-publish',
          ['发布实体正文', 'Publish manuscript files'],
          ['按持久检查点发布正文文件；失败后可安全重试', 'Publish manuscript files with durable checkpoints and safe retries.']),
        importStep(params.run, params.executionOwner, 'author-postprocess',
          ['更新连续性事实', 'Update continuity facts'],
          ['从权威定稿更新章节事实与角色状态，不导入参照语料', 'Update chapter facts and character state from authoritative text without importing reference prose.']),
        ...inferenceSteps,
        importStep(params.run, params.executionOwner, 'refresh',
          ['刷新项目状态', 'Refresh project state'],
          ['刷新正文树、角色卡与定稿状态', 'Refresh the manuscript tree, character cards, and finalized status.']),
      ],
      onComplete: {
        mode: 'silent',
        message: textForLocale(
          params.run.locale,
          '作者原稿已作为权威定稿导入，可以从下一章继续创作。',
          'The manuscript is now authoritative finalized text. You can continue from the next chapter.',
        ),
      },
    }
  }
  return {
    runId: params.run.id,
    type: 'novel_import',
    title: textForLocale(
      params.run.locale,
      `小说拆解与仿写（${count} 章）`,
      `Novel analysis and style study (${chapterCountEn})`,
    ),
    projectPath: params.projectPath,
    projectSession: session,
    uiLocale: params.run.locale,
    resourceKeys: [
      workflowResourceKey('novel-config'),
      workflowResourceKey('architecture'),
      workflowResourceKey('character-roster'),
      workflowResourceKey('blueprints'),
    ],
    ...durableCancelHooks,
    steps: [
      importStep(params.run, params.executionOwner, 'knowledge',
        ['导入参照文本与构建知识库', 'Import reference text and build the knowledge base'],
        [`按有界批次导入 ${count} 章参照文本，不写入草稿或正文`, `Import ${chapterCountEn} of reference text in bounded batches without creating drafts or manuscript text`]),
      importStep(params.run, params.executionOwner, 'global',
        ['AI 推演全局配置与架构', 'AI infers global configuration and architecture'],
        ['从有界样本推演小说配置、故事架构与角色卡', 'Infer the novel configuration, architecture, and character cards from bounded samples.']),
      importStep(params.run, params.executionOwner, 'style',
        ['AI 拆解文风与仿写指南', 'AI analyzes writing style and imitation guidance'],
        ['从有界样本提取文风与仿写约束', 'Extract a style profile and imitation guidance from bounded samples.']),
      importStep(params.run, params.executionOwner, 'blueprints',
        ['AI 分批推演章节蓝图', 'AI infers chapter blueprints in batches'],
        [`以最多 5 章一批生成 ${count} 章蓝图`, `Infer ${chapterCountEn} of blueprints in batches of at most five.`]),
      importStep(params.run, params.executionOwner, 'refresh',
        ['刷新项目状态', 'Refresh project state'],
        ['刷新项目树、角色卡与蓝图', 'Refresh the project tree, character cards, and blueprints.']),
    ],
    onComplete: {
      mode: 'silent',
      message: textForLocale(
        params.run.locale,
        '小说拆解与仿写准备完成，全部结构化数据已生成，可以开始续写。',
        'Novel analysis and style study is ready. You can start writing.',
      ),
    },
  }
}

export function estimateImportCost(_totalWords: number, chapterCount: number): {
  globalTokens: number
  blueprintTokens: number
  estimatedTokens: number
  estimatedMinutes: number
} {
  const globalTokens = 15_000
  const blueprintTokens = 4_000 * chapterCount
  return {
    globalTokens,
    blueprintTokens,
    estimatedTokens: globalTokens + blueprintTokens,
    estimatedMinutes: Math.ceil((1 + Math.ceil(chapterCount / 5)) * 12 / 60),
  }
}
