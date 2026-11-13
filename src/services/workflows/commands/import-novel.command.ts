import { displayedErrorMessage, englishWithReason, importGenerationStopMessage } from '../../../i18n/app-errors'
import type { NovelConfig } from '../../../shared/ipc-channels'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../../shared/import-generation'
import type { BeginGenerationRequest } from '../../../shared/generation-owner-contract'
import type { WorkflowContext } from '../../../stores/workflow-store'
/**
 * 导入小说 — Command 集合
 *
 * 两个独立 Command 组成逆向推演生成阶段：
 * 1. InferGlobalSettingsCommand — 向量采样 + AI 推演全局配置/架构/角色
 * 2. InferBlueprintsPerChapterCommand — 按章逐一推演精准蓝图 + 蓝图入向量库 + 拼装轻量全局摘要
 */

import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type LLMCompletion,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import {
  buildImportEndpointCardTask,
  buildImportInferenceTask,
  formatImportInferenceSample,
  getImportInferenceTopics,
  type ImportInferenceTopicKey,
} from '../../../shared/import-inference-materials'
import { buildImportBlueprintTask } from '../../../shared/import-blueprint-materials'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
  workflowMainProcessError,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import type { ChapterBlueprint } from '../directory-workflow'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
import type {
  BlueprintRangeCommitReceipt,
  BlueprintRangeCommitRequest,
} from '../../../../electron/repositories/blueprint-repository'
import {
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'
import {
  importInferenceJsonContract,
  type ImportInferenceResult,
  decodeImportInferenceJson,
  decodeRecoveredImportInference,
  importEndpointRecoveryTargets,
  MAX_IMPORT_INFERENCE_CHARACTER_CARDS,
  parseImportInferenceJsonObject,
} from './import-inference-contract'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import type {
  ImportGlobalFactsReceipt,
  ImportGlobalFactsRequest,
} from '../../../shared/import-global-facts'
import {
  buildStructuredSyntaxRepairTask,
  isRepairableDirectJsonSyntaxFailure,
  preservesStructuredJsonEvidence,
} from '../structured-syntax-repair'

/** 拆分后的章节数据（从 context.data 中传递） */
export interface ImportedChapter {
  number: number
  title: string
  content: string
  wordCount: number
}

/** Import identity comes from the durable orchestrator, never the UI workflow ID. */
export function importGenerationSelection(context: WorkflowContext, stage: ImportGenerationSlot['stage']) {
  const slot = context.data.importGenerationSlot as ImportGenerationSlot | undefined
  if (!slot) return undefined
  if (slot.stage !== stage || !context.data.importRunExecution) throw new Error('IMPORT_GENERATION_EXECUTION_REQUIRED')
  return { importSlot: slot, importExecution: context.data.importRunExecution as NonNullable<BeginGenerationRequest['importExecution']> }
}

/** 导入运行的用途：作者原稿反推停下时的说明与参考小说不同。 */
function importRunPurpose(context: WorkflowContext): 'reference' | 'author-manuscript' {
  return context.data.importRunPurpose === 'author-manuscript' ? 'author-manuscript' : 'reference'
}

export function frozenImportContext(context: WorkflowContext): ImportGenerationContext | undefined {
  if (!context.data.importGenerationSlot) return undefined
  const frozen = context.data.importGenerationContext as ImportGenerationContext | undefined
  const slot = context.data.importGenerationSlot as ImportGenerationSlot
  if (!frozen || frozen.slot.runId !== slot.runId || frozen.slot.stage !== slot.stage || frozen.slot.batchId !== slot.batchId) throw new Error('IMPORT_GENERATION_CONTEXT_REQUIRED')
  return frozen
}

const SHA256_HEX = /^[a-f0-9]{64}$/u
type UiText = (zhCNText: string, enUSText: string) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepJsonEqual(value, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (!deepJsonEqual(leftKeys, rightKeys)) return false
    return leftKeys.every(key => deepJsonEqual(left[key], right[key]))
  }
  return false
}

function requireImportGlobalFactsReceipt(
  candidate: ImportGlobalFactsReceipt | undefined,
  expected: ImportGlobalFactsRequest,
  text: UiText,
): ImportGlobalFactsReceipt {
  const domainRequest = { ...expected }
  delete domainRequest.generationRunHandle
  const normalizedCore = { ...domainRequest.core }
  for (const field of ['genre', 'subGenre', 'targetAudience', 'goldenFinger', 'globalGuidance', 'coreOutline',
    'worldSetting', 'protagonistProfile', 'premise', 'worldbuilding', 'synopsis'] as const) {
    normalizedCore[field] = normalizedCore[field].trim()
  }
  expected = { ...domainRequest, operationId: domainRequest.operationId.trim(), core: normalizedCore }
  const committedNames = new Set(candidate?.roster?.snapshot?.entries
    ?.map(entry => typeof entry.name === 'string' ? entry.name.trim() : '')
    .filter(Boolean))
  if (
    !candidate
    || candidate.operationId !== expected.operationId
    || !SHA256_HEX.test(candidate.payloadHash)
    || typeof candidate.idempotent !== 'boolean'
    || !candidate.core
    || (candidate.characterProposal !== undefined
      ? candidate.roster !== undefined
        || !isRecord(candidate.characterProposal)
        || typeof candidate.characterProposal.proposalBatchId !== 'string'
        || !candidate.characterProposal.proposalBatchId.trim()
        || typeof candidate.characterProposal.sourceHash !== 'string'
        || !SHA256_HEX.test(candidate.characterProposal.sourceHash)
        || !deepJsonEqual(candidate.proposalSource, expected)
        || (candidate.mode === 'fill-empty'
          ? !Array.isArray(candidate.suggestions)
          : !deepJsonEqual(candidate.core, expected.core))
      : candidate.proposalSource !== undefined
        || !candidate.roster?.snapshot
        || candidate.roster.snapshot.status !== 'ready'
        || expected.characterEntries.some(entry => !committedNames.has(entry.name.trim())))
  ) throw new Error(text(
    '导入全局事实提交收据无效或覆盖不完整',
    'The imported global-facts commit receipt is invalid or incomplete.',
  ))
  return candidate
}

export class ImportBlueprintPostCommitSyncError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt, text: UiText) {
    super(
      text(
        `导入蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
          + '但角色候选同步失败；可使用同步操作回执安全重试，无需重新生成蓝图。',
        `Imported blueprints for Chapters ${commitReceipt.startChapter}–${commitReceipt.endChapter} were committed, `
          + 'but character-candidate synchronization failed. Retry with the synchronization receipt without regenerating the blueprints.',
      ),
    )
    this.name = 'ImportBlueprintPostCommitSyncError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

/**
 * 导入的单次调用（global、style）在请求进行中用完活动时长或写入失败时，回执带 ROOT_BUDGET_EXHAUSTED 或 GENERATION_STORAGE_FAILED：
 * 换成对应说明，码只进诊断日志。
 */
export function assertImportCompletionNotStopped(
  completion: Pick<LLMCompletion, 'receipt'>,
  callbacks: Pick<CommandExecuteParams['callbacks'], 'log'>,
  context: CommandExecuteParams['context'],
): void {
  const code = completion.receipt.failureCode
  const stopped = code && importGenerationStopMessage(context.uiLocale, code, true, importRunPurpose(context))
  if (!stopped) return
  callbacks.log(workflowUiText(context, `导入停止原因：${code}`, `Import stop reason: ${code}`))
  throw new Error(stopped)
}

// =================================================================
// 1. 向量采样 + AI 推演全局配置/架构/角色
// =================================================================

export class InferGlobalSettingsCommand extends BaseWorkflowCommand<void> {
  constructor(
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly commitGlobalFacts?: (request: ImportGlobalFactsRequest) => Promise<ImportGlobalFactsReceipt>,
    /** 作者原稿只从作者自己的正文取材，不混入项目里的参考小说。 */
    private readonly excludeReferenceCorpus = false,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), { operation: 'import-global-facts', promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], output: 'structured-data', ...importGenerationSelection(params.context, 'global') })
  }

  private async decodeImportInferenceWithEndpointRecovery(
    rawResult: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<ImportInferenceResult> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const decoded = async <T>(decode: () => T): Promise<T> => {
      try { return decode() } catch (error) { await this.discardRejectedImportOutput(callbacks); throw error }
    }
    try {
      return decodeImportInferenceJson(rawResult)
    } catch (error) {
      if (!(error instanceof StructuredContractDiagnostic)
        || error.code !== 'relationship_endpoint_not_in_characters') {
        await this.discardRejectedImportOutput(callbacks)
        throw error
      }
    }

    const recoveryTargets = await decoded(() => importEndpointRecoveryTargets(rawResult, text))
    const delta = recoveryTargets.length === 0 ? null : await this.requestImportEndpointCards(rawResult, recoveryTargets, callbacks, context)
    const { result, droppedRelationships } = await decoded(() => decodeRecoveredImportInference(rawResult, delta, text))
    if (droppedRelationships.length > 0) {
      const dropped = droppedRelationships.map(item => `${item.source}→${item.target}（${item.relation}）`).join('、')
      const droppedEn = droppedRelationships.map(item => `${item.source}→${item.target} (${item.relation})`).join(', ')
      callbacks.log(text(
        `已丢弃 ${droppedRelationships.length} 条关系，关系对象没有角色卡：${dropped}。这是导入推演的内部限制（最多 ${MAX_IMPORT_INFERENCE_CHARACTER_CARDS} 张角色卡，只补卡一次），不是你的设置。导入完成后可以在「角色名单」里手动补上这些角色和关系。`,
        `Dropped ${droppedRelationships.length} relationship(s) whose target has no character card: ${droppedEn}. This is an internal import-inference limit (at most ${MAX_IMPORT_INFERENCE_CHARACTER_CARDS} character cards and one card-recovery request), not one of your settings. After the import, you can add these characters and relationships on the Cast page.`,
      ))
    }
    return result
  }

  private async requestImportEndpointCards(
    rawResult: string,
    unresolvedTargets: string[],
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<string> {
    const frozen = frozenImportContext(context)
    const writingLanguage = frozen?.core.writingLanguage ?? workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const originalRoot = parseImportInferenceJsonObject(rawResult)
    callbacks.log(text(
      `导入推演关系端点缺少 ${unresolvedTargets.length} 张角色卡，正在执行一次受限补卡校正`,
      `${unresolvedTargets.length} relationship ${unresolvedTargets.length === 1 ? 'endpoint is' : 'endpoints are'} missing a character card; running one bounded correction`,
    ))
    const correctionTask = buildImportEndpointCardTask({ writingLanguage, originalRoot, unresolvedTargets })
    const correction = await this.callLLMResult(
      correctionTask.messages[1].content,
      correctionTask.messages[0].content,
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'import-inference:endpoint-card-recovery',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    assertImportCompletionNotStopped(correction, callbacks, context)
    if (correction.finishReason !== 'stop') throw this.createIncompleteCompletionError(correction.finishReason)
    return correction.content
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const frozen = frozenImportContext(context)
    const writingLanguage = frozen?.core.writingLanguage ?? workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    const isCurrentProject = Boolean(project && sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    ))
    if (!isCurrentProject && !frozen) throw new Error(text('当前项目已切换，导入推演已停止', 'The project changed, so import inference stopped.'))
    const projectSnapshot = project ? Object.freeze({ ...project, novelConfig: Object.freeze({ ...project.novelConfig }) }) : undefined

    const baseConfig: NovelConfig = frozen ? {
      writingLanguage: frozen.core.writingLanguage,
      creativeStrategy: frozen.core.creativeStrategy as NovelConfig['creativeStrategy'],
      narrativeThreadDormantChapterThreshold: frozen.core.narrativeThreadDormantChapterThreshold,
      genre: frozen.core.genre, subGenre: frozen.core.subGenre, targetAudience: frozen.core.targetAudience,
      totalChapters: frozen.core.totalChapters, wordsPerChapter: frozen.core.wordsPerChapter,
      plotStructure: frozen.core.plotStructure as NovelConfig['plotStructure'],
      narrativePOV: frozen.core.narrativePov as NovelConfig['narrativePOV'],
      coreOutline: frozen.core.coreOutline, worldSetting: frozen.core.worldSetting,
      goldenFinger: frozen.core.goldenFinger, protagonistProfile: frozen.core.protagonistProfile,
      globalGuidance: frozen.core.globalGuidance, writingStyle: frozen.core.writingStyle,
      referenceWorks: frozen.core.referenceWorks,
    } : (projectSnapshot?.novelConfig ?? {
      writingLanguage: 'zh-CN', creativeStrategy: 'auto', narrativeThreadDormantChapterThreshold: 5,
      genre: '', subGenre: '', targetAudience: '', totalChapters: 100, wordsPerChapter: 3000,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
      goldenFinger: '', protagonistProfile: '', globalGuidance: '', writingStyle: '', referenceWorks: '',
    })
    const chapters = frozen?.chapters ?? context.data.chapters as ImportedChapter[]
    if (!chapters || chapters.length === 0) throw new Error(text('无章节数据', 'No chapter data is available.'))
    const importRunTotalChapters = frozen?.totalChapters ?? context.data.importRunTotalChapters
    const totalChapters = typeof importRunTotalChapters === 'number'
      && Number.isSafeInteger(importRunTotalChapters)
      && importRunTotalChapters > 0
      ? importRunTotalChapters
      : chapters.length

    callbacks.log(text(
      '通过向量知识库检索关键片段...',
      'Retrieving key passages from the vector knowledge base...',
    ))
    callbacks.setProgress(5)

    // ===== 向量检索采样 =====
    const searchTopics = getImportInferenceTopics(writingLanguage)

    let managedTopics: import('../../../shared/import-generation').ImportQueryMaterialsResponse['topics'] | undefined
    if (frozen && !this.excludeReferenceCorpus) {
      const handle = context.mainGenerationRunHandle
      const execution = context.data.importRunExecution as BeginGenerationRequest['importExecution']
      if (!handle || !execution) throw new Error('GENERATION_IMPORT_EXECUTION_REQUIRED')
      this.assertNotCancelled(context)
      const prepared = await ipc.invokeWithProjectSession(projectSession, 'import-generation:v1:query-materials', {
        handle, execution: { owner: execution.owner, epoch: execution.epoch },
      })
      this.assertNotCancelled(context)
      if (prepared.version !== 1 || prepared.run.handle.projectId !== handle.projectId
        || prepared.run.handle.rootActionId !== handle.rootActionId || prepared.run.handle.runId !== handle.runId
        || prepared.topics.length !== searchTopics.length || prepared.topics.some((topic, index) => topic.key !== searchTopics[index].key)) {
        throw new Error('GENERATION_IMPORT_QUERY_RECEIPT_INVALID')
      }
      context.mainGenerationRunHandle = Object.freeze({ ...prepared.run.handle })
      context.mainGenerationRootHandle = Object.freeze({ ...prepared.run.handle })
      managedTopics = prepared.topics
    }

    const sampledContent: Partial<Record<ImportInferenceTopicKey, string>> = {}
    for (const topic of searchTopics) {
      this.assertNotCancelled(context)
      const label = text(topic.label.zhCN, topic.label.enUS)
      try {
        const managed = managedTopics?.find(item => item.key === topic.key)
        if (managed && managed.results === null) throw new Error('GENERATION_IMPORT_QUERY_SEARCH_UNAVAILABLE')
        const results = managed ? managed.results! : unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
          projectSession,
          this.excludeReferenceCorpus ? 'kb:search-writing-context' : 'kb:search',
          topic.query,
          topic.topK,
          context.projectPath,
        ))
        this.assertNotCancelled(context)
        sampledContent[topic.key] = formatImportInferenceSample(results, writingLanguage)
        callbacks.log(text(
          `  已检索「${label}」— ${results.length} 条结果`,
          `  Retrieved ${results.length} ${results.length === 1 ? 'result' : 'results'} for "${label}"`,
        ))
      } catch {
        sampledContent[topic.key] = formatImportInferenceSample('unavailable', writingLanguage)
        callbacks.log(text(
          `  「${label}」检索失败，将使用降级策略`,
          `  Retrieval failed for "${label}"; using the fallback strategy`,
        ))
      }
    }
    callbacks.setProgress(20)

    // ===== 构建 Prompt =====
    // 优先使用向量增强版 Prompt
    const template = frozen ? (frozen.prompts.infer_novel_config_with_vectors || frozen.prompts.infer_novel_config)
      : await resolvePromptTemplate('infer_novel_config_with_vectors', projectSession, writingLanguage)
        || await resolvePromptTemplate('infer_novel_config', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到推演 Prompt 模板', 'The import-inference prompt template was not found.'))

    const inferenceContract = importInferenceJsonContract(writingLanguage)
    const initialTask = buildImportInferenceTask({ template, writingLanguage, chapters, totalChapters, sampledContent })

    callbacks.log(text(
      '正在调用 AI 推演全局小说配置...',
      'Running AI inference for the global novel configuration...',
    ))
    callbacks.setProgress(25)

    const initial = await this.callLLMResult(
      initialTask.messages[1].content,
      initialTask.messages[0].content,
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'import-inference',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    assertImportCompletionNotStopped(initial, callbacks, context)
    if (initial.finishReason !== 'stop') throw this.createIncompleteCompletionError(initial.finishReason)
    let rawResult = initial.content
    if (isRepairableDirectJsonSyntaxFailure(rawResult)) {
      callbacks.log(text(
        '导入推演 JSON 存在词法错误，正在执行唯一一次完整替代语法修复...',
        'The import-inference JSON has a syntax error; running the single full-replacement syntax repair...',
      ))
      const repairTask = buildStructuredSyntaxRepairTask({
        purpose: 'import-inference',
        output: 'structured-data',
        messages: [],
      }, inferenceContract, rawResult, writingLanguage)
      const repair = await this.callLLMResult(
        repairTask.messages[1].content,
        repairTask.messages[0].content,
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: repairTask.purpose,
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
          ...(repairTask.promptBudget ? { promptBudget: repairTask.promptBudget } : {}),
        },
        context,
      )
      assertImportCompletionNotStopped(repair, callbacks, context)
      if (repair.finishReason !== 'stop') throw this.createIncompleteCompletionError(repair.finishReason)
      if (!preservesStructuredJsonEvidence(rawResult, repair.content)) {
        await this.discardRejectedImportOutput(callbacks)
        throw new Error(text(
          '导入推演 JSON 语法修复改变了候选事实，已拒绝写入',
          'The import-inference JSON syntax repair changed candidate facts, so the write was rejected.',
        ))
      }
      rawResult = repair.content
    }
    this.assertNotCancelled(context)

    callbacks.setProgress(70)
    callbacks.log(text(
      '正在解析 AI 返回结果并写入项目...',
      'Parsing the AI response and committing it to the project...',
    ))

    // ===== 解析 JSON 结果 =====
    // Keep the exact visible candidate even when the legacy name-based contract
    // rejects ambiguity. This is not a formal fact or an adoption authorization.
    context.data.importGlobalInferenceCandidate = rawResult
    const inferResult = await this.decodeImportInferenceWithEndpointRecovery(rawResult, callbacks, context)

    const roster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      context.projectPath,
    )
    if (roster.status !== 'ready' && roster.status !== 'empty') {
      throw new Error(text(
        '角色名单当前不可安全导入；请先完成旧项目修复或处理数据不一致状态',
        'The character roster cannot be imported safely. Repair the legacy project or resolve its inconsistent state first.',
      ))
    }

    const novelConfig = {
      ...baseConfig,
      ...inferResult.novelConfig,
      totalChapters,
      wordsPerChapter: Math.max(1, Math.round(
        (frozen?.totalWords ?? (typeof context.data.importRunTotalWords === 'number'
          ? context.data.importRunTotalWords
          : chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)))
        / totalChapters,
      )),
    }
    if (!frozen && !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text(
      '当前项目已切换，导入配置结果未应用',
      'The project changed, so the imported configuration was not applied.',
    ))
    this.assertNotCancelled(context)

    const operationId = `novel-import-global-${frozen?.slot.runId ?? context.runId}`
    const commitRequest: ImportGlobalFactsRequest = {
        operationId,
        ...(context.mainGenerationRunHandle ? { generationRunHandle: context.mainGenerationRunHandle } : {}),
        expectedRosterRevision: roster.revision,
        core: {
          genre: novelConfig.genre,
          subGenre: novelConfig.subGenre,
          targetAudience: novelConfig.targetAudience,
          totalChapters: novelConfig.totalChapters,
          wordsPerChapter: novelConfig.wordsPerChapter,
          plotStructure: novelConfig.plotStructure,
          narrativePov: novelConfig.narrativePOV,
          goldenFinger: novelConfig.goldenFinger,
          globalGuidance: novelConfig.globalGuidance,
          coreOutline: novelConfig.coreOutline,
          worldSetting: novelConfig.worldSetting,
          protagonistProfile: novelConfig.protagonistProfile,
          premise: inferResult.architectureFiles.premise,
          worldbuilding: inferResult.architectureFiles.worldbuilding,
          synopsis: inferResult.architectureFiles.synopsis,
        },
        characterEntries: inferResult.characterCards,
      }
    let rawCommitReceipt: ImportGlobalFactsReceipt | undefined
    if (this.commitGlobalFacts) {
      rawCommitReceipt = await this.commitGlobalFacts(commitRequest)
    } else {
      const commitResult = await ipc.invokeWithProjectSession(
        projectSession,
        'db:import-global-facts-commit',
        commitRequest,
        context.projectPath,
      )
      if (!commitResult.success) throw workflowMainProcessError(
        context,
        commitResult.error,
        '导入全局事实原子提交失败',
        'The imported global facts could not be committed atomically.',
      )
      rawCommitReceipt = commitResult.receipt
    }
    const commitReceipt = requireImportGlobalFactsReceipt(
      rawCommitReceipt,
      commitRequest,
      text,
    )
    context.data.importGlobalFactsReceipt = commitReceipt

    this.assertNotCancelled(context)
    if (!frozen && !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text(
      '当前项目已切换，导入配置结果未应用',
      'The project changed, so the imported configuration was not applied.',
    ))
    const savedFields = {
      genre: commitReceipt.core.genre,
      subGenre: commitReceipt.core.subGenre,
      targetAudience: commitReceipt.core.targetAudience,
      totalChapters: commitReceipt.core.totalChapters,
      wordsPerChapter: commitReceipt.core.wordsPerChapter,
      plotStructure: commitReceipt.core.plotStructure,
      narrativePOV: commitReceipt.core.narrativePov,
      goldenFinger: commitReceipt.core.goldenFinger,
      globalGuidance: commitReceipt.core.globalGuidance,
      coreOutline: commitReceipt.core.coreOutline,
      worldSetting: commitReceipt.core.worldSetting,
      protagonistProfile: commitReceipt.core.protagonistProfile,
    }
    const authoritativeNovelConfig = { ...baseConfig, ...savedFields }
    // 反推等待期间作者在设定页改过、还没保存的字段保持作者的值；若已切书查看其他作品，不污染当前前台 store。
    const matchesActive = sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )
    if (matchesActive) {
      useProjectStore.getState().publishSavedNovelConfig(savedFields, projectSession, 'unsaved-edits')
    } else {
      callbacks.log(text('当前正在查看其他作品，导入事实已安全保存至目标作品库', 'Viewing another project; imported facts saved safely to the target project database.'))
    }
    const unknown = promptLanguageText(writingLanguage, '未知', 'Unknown')
    const none = promptLanguageText(writingLanguage, '（无）', '(none)')
    context.data.novelConfigSummary = promptLanguageText(
      writingLanguage,
      `类型: ${authoritativeNovelConfig.genre || unknown} | 子类型: ${authoritativeNovelConfig.subGenre || unknown} | 受众: ${authoritativeNovelConfig.targetAudience || unknown}\n`
        + `大纲: ${authoritativeNovelConfig.coreOutline || none}\n`
        + `世界观: ${authoritativeNovelConfig.worldSetting || none}\n`
        + `金手指: ${authoritativeNovelConfig.goldenFinger || none}\n`
        + `主角: ${authoritativeNovelConfig.protagonistProfile || none}`,
      `Genre: ${authoritativeNovelConfig.genre || unknown} | Subgenre: ${authoritativeNovelConfig.subGenre || unknown} | Audience: ${authoritativeNovelConfig.targetAudience || unknown}\n`
        + `Outline: ${authoritativeNovelConfig.coreOutline || none}\n`
        + `World: ${authoritativeNovelConfig.worldSetting || none}\n`
        + `Central advantage: ${authoritativeNovelConfig.goldenFinger || none}\n`
        + `Protagonist: ${authoritativeNovelConfig.protagonistProfile || none}`,
    )
    if (commitReceipt.mode === 'fill-empty') {
      const suggestionCount = commitReceipt.suggestions?.length ?? 0
      callbacks.log(text(
        `空白的设定与架构已补齐，已有内容没有改动；${suggestionCount} 条与现有内容不同的反推结果放进了建议，导入完成后可以在这张运行卡片里采用。角色以提议形式保存，等你采用。`,
        `Empty settings and architecture were filled; existing content was left unchanged. ${suggestionCount} inferred ${suggestionCount === 1 ? 'value differs' : 'values differ'} from what you wrote and ${suggestionCount === 1 ? 'is kept as a suggestion' : 'are kept as suggestions'} you can adopt on this run card once the import finishes. Characters are saved as proposals for you to adopt.`,
      ))
    } else if (commitReceipt.characterProposal) {
      const proposalCount = commitReceipt.proposalSource.characterEntries.length
      callbacks.log(text(
        `小说配置、非角色架构与 ${proposalCount} 条角色提议已原子保存；提议保留待采用，尚未创建角色。`,
        `The novel configuration, non-character architecture, and ${proposalCount} character proposals were saved atomically. Proposals remain pending adoption; no characters were created.`,
      ))
    } else {
      const committedCharacterCount = commitReceipt.roster.snapshot.entries.length
      callbacks.log(text(
        `小说配置、非角色架构与 ${committedCharacterCount} 张角色卡已原子提交`,
        `The novel configuration, non-character architecture, and ${committedCharacterCount} character ${committedCharacterCount === 1 ? 'card was' : 'cards were'} committed atomically`,
      ))
    }

    callbacks.setProgress(90)
    this.notifyRefresh(['fileTree', 'characterCards'], context.projectPath, requireWorkflowProjectSession(context))
  }
}


// =================================================================
// 2. 按章逐一推演精准蓝图（限流并发）
// =================================================================

export class InferBlueprintsPerChapterCommand extends BaseWorkflowCommand<void> {
  private static readonly MAX_CHAPTERS_PER_OPERATION = 50
  private static readonly MAX_ITEMS_PER_BATCH = 5

  constructor(
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly commitBlueprintRange?: (
      request: BlueprintRangeCommitRequest,
    ) => Promise<BlueprintRangeCommitReceipt>,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), { operation: 'import-blueprints', promptKeys: ['infer_single_chapter_blueprint'], skillStages: ['planning'], output: 'structured-data', ...importGenerationSelection(params.context, 'blueprints') })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const frozen = frozenImportContext(context)
    const writingLanguage = frozen?.core.writingLanguage ?? workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    const isCurrentProject = Boolean(project && sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    ))
    if (!isCurrentProject && !frozen) throw new Error(text('当前项目已切换，蓝图推演已停止', 'The project changed, so blueprint inference stopped.'))

    const chapters = frozen?.chapters ?? context.data.chapters as ImportedChapter[]
    const configSummary = (frozen ? JSON.stringify(frozen.core) : context.data.novelConfigSummary as string)
      || promptLanguageText(writingLanguage, '（配置概要不可用）', '(configuration summary unavailable)')
    if (!chapters || chapters.length === 0) throw new Error(text('无章节数据', 'No chapter data is available.'))

    const template = frozen ? frozen.prompts.infer_single_chapter_blueprint
      : await resolvePromptTemplate('infer_single_chapter_blueprint', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到单章蓝图推演 Prompt 模板',
      'The single-chapter blueprint inference prompt template was not found.',
    ))

    if (chapters.length > InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION) {
      throw new Error(text(
        `本次导入需推演 ${chapters.length} 章蓝图，超过单次 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章的安全成本上限；`
          + `请按连续章节分段，每段不超过 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章。`,
        `This import requires ${chapters.length} chapter blueprints, exceeding the safe limit of ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} per operation. `
          + `Import contiguous ranges of at most ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} chapters.`,
      ))
    }
    const orderedChapters = [...chapters].sort((left, right) => left.number - right.number)
    const startChapter = orderedChapters[0]?.number
    const endChapter = orderedChapters.at(-1)?.number
    if (
      startChapter === undefined
      || endChapter === undefined
      || orderedChapters.some((chapter, index) => chapter.number !== startChapter + index)
    ) {
      throw new Error(text(
        '导入蓝图只能按连续章节范围生成；请先补齐缺失章节或拆分为连续范围。',
        'Imported blueprints can be inferred only for a contiguous chapter range. Fill missing chapters or split the import into contiguous ranges.',
      ))
    }

    const estimatedCalls = Math.ceil(chapters.length / InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH)
    callbacks.log(text(
      `开始分批推演蓝图（共 ${chapters.length} 章，预计至多 ${estimatedCalls} 次调用）...`,
      `Inferring blueprints in batches (${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}; at most ${estimatedCalls} model ${estimatedCalls === 1 ? 'call' : 'calls'})...`,
    ))
    callbacks.setProgress(5)

    let activeChapterNumbers: number[] = []
    const contract: StructuredBatchContract<ImportedChapter, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        activeChapterNumbers = items.map(item => item.number)
        const task = buildImportBlueprintTask({ template, writingLanguage, items, validatedPrefix, configSummary })
        callbacks.log(text(
          `  正在推演第 ${activeChapterNumbers[0]}–${activeChapterNumbers.at(-1)} 章...`,
          `  Inferring Chapters ${activeChapterNumbers[0]}–${activeChapterNumbers.at(-1)}...`,
        ))
        callbacks.setProgress(5 + Math.round((validatedPrefix.length / orderedChapters.length) * 80))
        return task
      },
      inputKey: chapter => chapter.number,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseBlueprintSemanticResponseText(content, activeChapterNumbers)
        .map(blueprint => ({
          ...blueprint,
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        })),
      validateItem: validateBlueprintSemanticItem,
    }

    const execution = this.requireGenerationExecution()
    const planningSession = injectWritingSkillIntoSession(execution.session, context, 'planning')
    const batch = await createStructuredBatchExecutor({
      contract,
      session: planningSession,
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: orderedChapters,
      limits: { maxBatchItems: InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH },
      signal: execution.signal,
    })
    if (!batch.ok) {
      if (batch.failure.terminal) throw batch.failure.terminal
      if (batch.failure.code === 'invalid_output') await this.discardRejectedImportOutput(callbacks)
      const { errorCode } = batch.failure
      if (errorCode) callbacks.log(text(`蓝图推演停止原因：${errorCode}`, `Blueprint inference stop reason: ${errorCode}`))
      const reason = (errorCode && importGenerationStopMessage(context.uiLocale, errorCode, batch.failure.code === 'deadline', importRunPurpose(context)))
        || displayedErrorMessage(context.uiLocale, batch.failure.message)
      throw new Error(text(
        `蓝图推演失败：${reason}`,
        englishWithReason(`Blueprint inference failed (${batch.failure.reason}).`, reason),
      ))
    }

    this.assertNotCancelled(context)
    const commitRequest: BlueprintRangeCommitRequest = {
        mode: 'replace-range',
        operationId: `import-blueprints-${frozen?.slot.runId ?? context.runId}-${startChapter}-${endChapter}`,
        ...(context.mainGenerationRunHandle ? { generationRunHandle: context.mainGenerationRunHandle } : {}),
        startChapter,
        endChapter,
        blueprints: [...batch.items],
      }
    let commitReceipt: BlueprintRangeCommitReceipt
    if (this.commitBlueprintRange) {
      commitReceipt = await this.commitBlueprintRange(commitRequest)
    } else {
      const commit = await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-commit-range',
        commitRequest,
        context.projectPath,
      )
      if (!commit.success || !commit.receipt) {
        throw workflowMainProcessError(
          context,
          commit.error,
          '导入蓝图未能作为完整范围一次提交并回读。',
          'The imported blueprints could not be committed and read back as one complete range.',
        )
      }
      commitReceipt = commit.receipt
    }
    if (commitReceipt.snapshot.length !== orderedChapters.length) {
      throw new Error(text(
        '导入蓝图提交回执覆盖不完整。',
        'The imported blueprint commit receipt is incomplete.',
      ))
    }
    context.data.blueprintCommitReceipt = commitReceipt
    try {
      const syncReceipt = await retryDirectoryCharacterSync(
        commitReceipt.characterSyncOperation.operationId,
        context.projectPath,
        projectSession,
        context.uiLocale,
      )
      context.data.blueprintCharacterSyncReceipt = syncReceipt
    } catch {
      throw new ImportBlueprintPostCommitSyncError(commitReceipt, text)
    }

    const committedChapterCount = commitReceipt.snapshot.length
    callbacks.log(text(
      `蓝图推演完成：${committedChapterCount} 章已一次提交`,
      `Blueprint inference complete: ${committedChapterCount} ${committedChapterCount === 1 ? 'chapter was' : 'chapters were'} committed in one operation`,
    ))
    callbacks.setProgress(100)
    if (!isCurrentProject) {
      callbacks.log(text('当前正在查看其他作品，蓝图事实已安全保存至目标作品库', 'Viewing another project; blueprint facts saved safely to the target project database.'))
    }
    this.notifyRefresh(['fileTree', 'blueprints'], context.projectPath, projectSession)
  }
}
