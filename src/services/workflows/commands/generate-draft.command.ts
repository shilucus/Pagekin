import { appErrorMessage, displayedErrorMessage, englishWithReason } from '../../../i18n/app-errors'
import {
  buildDraftCondensePrompt,
  buildDraftContinuationPrompt,
  chapterExecutionContractText,
  chapterLengthContractText,
  synopsisForDraftChapter,
  toWriterChapterInfo,
  type WriterChapterInfo,
} from '../../../shared/draft-generation-prompts'
import {
  acceptsCondensedDraft,
  hasSubstantialPreviousChapterReuse,
  isAcceptedDraftContinuation,
  isLowProgressDraftContinuation,
  shouldAutoContinueDraft,
  shouldCondenseDraft,
} from '../../../shared/draft-generation-policy'
export { chapterExecutionContractText, chapterLengthContractText, synopsisForDraftChapter } from '../../../shared/draft-generation-prompts'
import { sanitizeDraftText, composeDraftVisibleContinuation, DRAFT_CONDENSE_PURPOSE, DRAFT_VISIBLE_TEXT_VERSION, isDraftVisibleTextVersion, type DraftVisibleTextVersion } from '../../../shared/draft-visible-text'
import { DRAFT_RECONCILE_PURPOSE, draftReconciliationBlock } from '../../../shared/draft-reconciliation'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlinePrompt, draftShortOutlineBlock, draftShortOutlineTask } from '../../../shared/draft-short-outline'
import { isWorkflowCancellation, WorkflowCancelledError } from '../workflow-cancellation'
export { sanitizeDraftText } from '../../../shared/draft-visible-text'
import { createWorkflowMainGenerationRuntime, type WorkflowMainGenerationRequest } from '../workflow-main-generation'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import { formatResourceUri } from '../../../shared/project-paths'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  injectWritingSkillIntoTask,
  keepReceiptFailuresOnCancel,
  type CommandExecuteParams,
  type LLMCompletion,
} from './base-command'
import { routeModelId } from '../../model-routing'
import { useProjectStore } from '../../../stores/project-store'
import { hashAuthorText } from '../../../shared/source-ref'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
  workflowMainProcessError,
} from '../workflow-project-session'
import {
  DIR_PROMPTS
} from '../../../shared/project-paths'
import type { ChapterInfo } from '../chapter-workflow'
import { normalizeChapterWordsTarget } from '../chapter-creation-parameters'
import {
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from '../../generation/generation-runtime'
import {
  throwIfTerminalProviderFailure,
  type GenerationAttemptReceipt,
  type GenerationOutcome,
  type GenerationSession,
} from '../../generation/generation-harness'
import type { WritingLanguage } from '../../../shared/writing-language'
import type { FinalizedContinuityProjection } from '../../../shared/finalized-continuity'
import type { NarrativeThreadView } from '../../../shared/narrative-thread'
import { promptLanguageText } from '../../prompt-language'
import { countDraftUnits, draftTargetUnitRange } from '../../../shared/draft-units'
import type { RecoveryChapterSource } from '../../../shared/recovery-candidate'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../../shared/character-roster'
import {
  assembleChapterMaterials,
  ChapterMaterialCapacityError,
  type ChapterMaterialAssembly,
  type ChapterMaterialReference,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'
import type { DraftSourceDependency } from '../../../shared/draft-source-dependency'
import { pluralEn } from '../../../shared/plural-en'

export { countDraftUnits } from '../../../shared/draft-units'
export { previousChapterEnding } from '../chapter-materials'

const ACTIVE_THREAD_CONTEXT_MAX_CHARS = 1200
const ACTIVE_THREAD_CONTEXT_MAX_ITEMS = 6
const STREAM_PREVIEW_INTERVAL_MS = 250

function exactParagraphs(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.flatMap(value => (
    value.split(/\r?\n\s*\r?\n/u).map(paragraph => paragraph.trim()).filter(Boolean)
  )))
}

function withoutExactParagraphDuplicates(content: string, duplicates: ReadonlySet<string>): string {
  return content
    .split(/\r?\n\s*\r?\n/u)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph && !duplicates.has(paragraph))
    .join('\n\n')
}


const THINKING_TAGS = ['<think>', '</think>'] as const

/**
 * Convert the cumulative raw stream into safe provisional prose. A suffix that
 * could still become a thinking tag is withheld so split tags never flash in
 * the writing panel before the next chunk arrives.
 */
export function visibleDraftStreamText(rawText: string): string {
  const lower = rawText.toLowerCase()
  let safeEnd = rawText.length
  const longestTag = Math.max(...THINKING_TAGS.map(tag => tag.length))
  for (let length = 1; length < longestTag && length <= rawText.length; length += 1) {
    const suffix = lower.slice(-length)
    if (THINKING_TAGS.some(tag => tag.startsWith(suffix))) {
      safeEnd = rawText.length - length
    }
  }
  return sanitizeDraftText(rawText.slice(0, safeEnd))
}

function createDraftStreamPreview(
  replaceText: ((text: string) => void) | undefined,
  composeVisibleText: (rawText: string) => string,
  initialRenderedText = '',
): { push(chunk: string): void; snapshot(): string; stop(): void } {
  let active = true
  let rawText = ''
  let renderedText = initialRenderedText
  let lastRenderedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const render = () => {
    timer = undefined
    if (!active || !replaceText) return
    const nextText = composeVisibleText(rawText)
    if (nextText === renderedText) return
    renderedText = nextText
    lastRenderedAt = Date.now()
    replaceText(nextText)
  }

  return {
    push(chunk) {
      if (!active) return
      rawText += chunk
      if (!replaceText || timer) return
      if (lastRenderedAt === 0) {
        render()
        return
      }
      const delay = Math.max(0, STREAM_PREVIEW_INTERVAL_MS - (Date.now() - lastRenderedAt))
      timer = setTimeout(render, delay)
    },
    snapshot() {
      return composeVisibleText(rawText)
    },
    stop() {
      active = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export const DRAFT_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 9,
  maxRequestedOutputTokens: 32_768,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 20 * 60_000,
})

export interface GenerateDraftCommandDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions, mainRequest?: WorkflowMainGenerationRequest): Promise<GenerationRuntime>
}

export interface GenerateDraftCommandOptions {
  /** Exact saved draft versions selected by this batch; never inferred as finalized history. */
  readonly selectedCandidateDrafts?: readonly SelectedCandidateDraft[]
  readonly resumeHandle?: MainGenerationRunHandle
  readonly batchId?: string
  readonly dependencies?: Partial<GenerateDraftCommandDependencies>
}

const DEFAULT_DEPENDENCIES: GenerateDraftCommandDependencies = {
  createRuntime: (_options, mainRequest) => {
    if (!mainRequest) throw new Error('DRAFT_MAIN_GENERATION_REQUEST_REQUIRED')
    return createWorkflowMainGenerationRuntime(mainRequest)
  },
}

function observeWorkflowCancellation(context: CommandExecuteParams['context']): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (context.cancelled) controller.abort()
  }, 25)
  if (context.cancelled) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => clearInterval(timer),
  }
}

function logDraftAttempt(
  callbacks: CommandExecuteParams['callbacks'],
  context: CommandExecuteParams['context'],
  phase: { zhCN: string; enUS: string },
  receipt: GenerationAttemptReceipt,
): void {
  callbacks.log(workflowUiText(
    context,
    `  ${phase.zhCN}：本次请求输出额度 ${receipt.budget.requestedOutputTokens}` +
      `（单次额度 ${receipt.budget.maxRequestedOutputTokensPerAttempt}，` +
      `累计 ${receipt.budget.cumulativeRequestedOutputTokens}/${receipt.budget.maxRequestedOutputTokens}）`,
    `  ${phase.enUS}: request output allowance ${receipt.budget.requestedOutputTokens} ` +
      `(per-attempt allowance ${receipt.budget.maxRequestedOutputTokensPerAttempt}, ` +
      `cumulative ${receipt.budget.cumulativeRequestedOutputTokens}/${receipt.budget.maxRequestedOutputTokens})`,
  ))
}

function completionFromOutcome(outcome: GenerationOutcome): LLMCompletion {
  return { content: outcome.content, finishReason: outcome.finishReason, receipt: outcome.receipt }
}

function workflowGenerationModelId(context: CommandExecuteParams['context']): string | undefined {
  return context.generationModelId?.trim() || undefined
}

function recoveryFailureCode(error: unknown): string {
  if (isWorkflowCancellation(error)) return 'CANCELLED'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 160)
  }
  return 'GENERATION_FAILED'
}

type DraftCandidate = { text: string; finishReason: 'stop' | 'length' }

function draftTooShortError(
  context: CommandExecuteParams['context'],
  units: number,
  targetUnits: number,
): Error {
  return new Error(workflowUiText(
    context,
    `模型已声明生成结束，但正文仅约 ${units}/${targetUnits} 字，明显未达到章节目标，结果未保存。` +
      '请提高最大输出 Tokens、降低本章目标字数，或改用输出能力更强的模型后重试。',
    `The model reported completion, but the draft is only about ${units}/${targetUnits} units and clearly misses the chapter target, so it was not saved. ` +
      'Increase the maximum output tokens, lower the chapter target, or use a model with greater output capacity and try again.',
  ))
}

function recoveryChapterSource(chapter: ChapterInfo): RecoveryChapterSource {
  return {
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    role: chapter.role,
    purpose: chapter.purpose,
    keyEvents: chapter.keyEvents,
    characters: [...chapter.characters],
    suspenseHook: chapter.suspenseHook ?? '',
    userGuidance: chapter.userGuidance ?? '',
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Join a visible continuation without allowing a repeated prompt tail to count as new prose. */
export function appendVisibleDraftContinuation(draft: string, continuation: string,
  version: DraftVisibleTextVersion = DRAFT_VISIBLE_TEXT_VERSION): string {
  return composeDraftVisibleContinuation(draft, continuation, version)
}

/**
 * 拼进日志与失败说明的原因：只看 message，裸码（含 IPC 前缀）按界面语言说明。不看 error.code，
 * 因为带码的错误（workflowMainProcessError）message 里已经写好了概述，按码替换会丢掉它。
 */
function shownReason(context: Pick<CommandExecuteParams['context'], 'uiLocale'>, error: unknown): string {
  return displayedErrorMessage(context.uiLocale, error instanceof Error ? error.message : error)
}

export class GenerateDraftCommand extends BaseWorkflowCommand {
  private readonly dependencies: GenerateDraftCommandDependencies
  private readonly selectedCandidateDrafts: readonly SelectedCandidateDraft[]
  private readonly resumeHandle?: MainGenerationRunHandle
  private readonly batchId?: string

  constructor(
    private chapterInfo: ChapterInfo,
    options: GenerateDraftCommandOptions = {},
  ) {
    super()
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
    this.resumeHandle = options.resumeHandle ? Object.freeze({ ...options.resumeHandle }) : undefined
    this.batchId = options.batchId
    this.selectedCandidateDrafts = Object.freeze([...(options.selectedCandidateDrafts ?? [])])
  }

  async execute({ step, context, callbacks }: CommandExecuteParams): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const expectedProjectPath = this.chapterInfo.projectPath
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error(uiText(
        '当前项目已切换，章节生成已停止',
        'The project changed, so chapter generation was stopped.',
      ))
    }
    const novelConfig = Object.freeze({ ...project.novelConfig })
    const writingLanguage = workflowWritingLanguage(context)
    const defaultMain = this.dependencies.createRuntime === DEFAULT_DEPENDENCIES.createRuntime
    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
    const writerChapterInfo = toWriterChapterInfo(this.chapterInfo)
    const targetChars = normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter)
    const knowledgeQueryHint = this.chapterInfo.knowledgeQueryHint?.trim() ?? ''
    const searchQuery = [knowledgeQueryHint, this.chapterInfo.title, this.chapterInfo.keyEvents,
      this.chapterInfo.characters.join(' ')].filter(Boolean).join(' ')
    const authorInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
      { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
      { id: 'draft:target-units', text: String(targetChars) }]
    const earlyRecovery = defaultMain && this.resumeHandle
      ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: this.resumeHandle }) : null
    if (earlyRecovery?.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
    if (earlyRecovery?.draftSave.kind === 'current') {
      const saved = earlyRecovery.draftSave.receipt
      if (earlyRecovery.operation !== 'chapter-draft' || earlyRecovery.chapterNumber !== this.chapterInfo.chapterNumber
        || saved.contentHash !== await sha256Hex(saved.content)) throw new Error('GENERATION_DRAFT_RECOVERY_SCOPE_INVALID')
      this.assertNotCancelled(context)
      context.mainGenerationRunHandle = this.resumeHandle
      return this.publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
        cleanDraftText: saved.content, id: saved.id, nextVersion: saved.version, mergedGuidance: '',
        targetChars: Number(earlyRecovery.authorInputs.find(input => input.id === 'draft:target-units')?.text) })
    }
    if (defaultMain) context.generationModelId = workflowGenerationModelId(context) || routeModelId('chapter-draft') || undefined
    const prepared = defaultMain && !this.resumeHandle
      ? await ipc.invokeWithProjectSession(projectSession, 'generation:prepare-draft-context', {
        chapterNumber: this.chapterInfo.chapterNumber, modelId: context.generationModelId!,
        promptKeys: [templateKey], skillStages: ['drafting'], authorInputs, query: searchQuery,
        selectedDraftIds: [...new Set(this.selectedCandidateDrafts.filter(item => item.chapterNumber < this.chapterInfo.chapterNumber).map(item => item.draftId))],
        ...(this.batchId ? { batchId: this.batchId } : {}),
      }).catch(error => {
        const code = error instanceof Error ? /(?:^|:\s)(KNOWLEDGE_BASE_NATIVE_UNAVAILABLE|LEGACY_VECTOR_MIGRATION_BLOCKED)$/u.exec(error.message)?.[1] : undefined
        if (code) throw Object.assign(new Error(appErrorMessage(context.uiLocale ?? 'zh-CN', { code })), { code })
        throw error
      }) : null
    const knowledgeSnapshot = prepared?.knowledgeSnapshot ?? earlyRecovery?.knowledgeSnapshot
    // Recovery uses the original main snapshot, including retrieval hints outside the writer prompt.
    if (defaultMain && (!knowledgeSnapshot || prepared && knowledgeSnapshot.query !== searchQuery))
      throw new Error('GENERATION_DRAFT_KNOWLEDGE_SNAPSHOT_REQUIRED')
    const sourceDraft = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-latest',
      this.chapterInfo.chapterNumber,
      expectedProjectPath,
    )

    callbacks.log(uiText(
      '拼装章节上下文 (强类型注入中)...',
      'Building chapter context...',
    ))

    const { coreOutline, worldSetting, goldenFinger, protagonistProfile } = novelConfig
    const authoredConfigFacts = [coreOutline, worldSetting, goldenFinger, protagonistProfile]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    const architecture = await this.readArchitecture(
      expectedProjectPath,
      projectSession,
      this.chapterInfo.chapterNumber,
      authoredConfigFacts,
    )
    const projectPrompts = await this.readProjectPrompts(
      expectedProjectPath,
      projectSession,
      writingLanguage,
    )
    const mergedGuidance = [
      novelConfig.globalGuidance?.trim() || '',
      projectPrompts,
    ].filter(Boolean).join('\n\n')

    const characterProfiles = await this.readCharacterProfiles(
      expectedProjectPath,
      projectSession,
      writingLanguage,
      this.chapterInfo.characters,
    )
    let futureBlueprintsStr = promptLanguageText(
      writingLanguage,
      '（无后续蓝图）',
      '(no future chapter blueprints)',
    )
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const allBlueprints = await loadDirectoryBlueprints(expectedProjectPath, projectSession)
      const futureBlueprintsArr = allBlueprints.filter(
        b => b.chapterNumber > this.chapterInfo.chapterNumber && b.chapterNumber <= this.chapterInfo.chapterNumber + 5
      )
      if (futureBlueprintsArr.length > 0) {
        futureBlueprintsStr = futureBlueprintsArr.map(b => promptLanguageText(
          writingLanguage,
          `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`,
          `Chapter ${b.chapterNumber}: ${b.title} — ${b.keyEvents}`,
        )).join('\n')
      }
    } catch { /* 忽略 */ }

    const template = await resolvePromptTemplate(templateKey, projectSession, writingLanguage)
    if (!template) throw new Error(uiText(
      `未找到模板: ${templateKey}`,
      `Template not found: ${templateKey}`,
    ))

    // ==========================================
    // Prompt 构建——按「稳定前缀 → 可变后缀」排列
    // 以最大化 LLM 上下文缓存命中率
    // ==========================================
    const writingStyle = novelConfig.writingStyle?.trim() || ''
    const promptOnlyConfigKeys = new Set([
      'globalGuidance',
      'writingStyle',
      'coreOutline',
      'worldSetting',
      'goldenFinger',
      'protagonistProfile',
    ])
    const novelConfigFacts = Object.fromEntries(
      Object.entries(novelConfig).filter(([key]) => !promptOnlyConfigKeys.has(key)),
    )
    const novelConfigFactsJson = JSON.stringify(novelConfigFacts, null, 2)
    let knowledgeReferences: ChapterMaterialReference[] = []
    try {
      callbacks.log(uiText(
        '  检索知识库相关片段...',
        '  Searching the knowledge base for relevant passages...',
      ))
      if (knowledgeQueryHint) {
        callbacks.log(uiText(
          `  追加用户检索关键词：${knowledgeQueryHint}`,
          `  Added author search keywords: ${knowledgeQueryHint}`,
        ))
      }
      const results = defaultMain ? knowledgeSnapshot!.items : unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
        projectSession,
        'kb:search-writing-context',
        searchQuery,
        5,
        expectedProjectPath,
      ))
      if (results.length > 0) {
        knowledgeReferences = results.map((result: { fileName: string; score: number; text: string }, index: number) => ({
          text: result.text,
          rendered: promptLanguageText(
            writingLanguage,
            `[${index + 1}] (${result.fileName}, 相关度 ${(result.score * 100).toFixed(0)}%)\n${result.text}`,
            `[${index + 1}] (${result.fileName}, relevance ${(result.score * 100).toFixed(0)}%)\n${result.text}`,
          ),
          deduplicateAgainstFinalized: true,
        }))
      } else {
        const emptyContext = promptLanguageText(writingLanguage, '（知识库中无相关内容）', '(no relevant knowledge-base context)')
        knowledgeReferences = [{ text: emptyContext, rendered: emptyContext }]
      }
    } catch {
      const unavailableContext = promptLanguageText(writingLanguage, '（知识库检索不可用）', '(knowledge-base search unavailable)')
      knowledgeReferences = [{ text: unavailableContext, rendered: unavailableContext }]
    }
    const chapterLengthContract = chapterLengthContractText(writingLanguage, targetChars)
    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(writingStyle)
      .withNovelConfig(novelConfigFactsJson)
      .withWordNumber(targetChars)
      // ---- 章节公共区（首章与后续章都必须完整注入）----
      .withChapterInfo(writerChapterInfo)
      .withCharacterStates('')
      .withFutureBlueprints('')
      .withFilteredContext('')
      .withUserGuidance(this.chapterInfo.userGuidance?.trim() || promptLanguageText(
        writingLanguage,
        '（无微操指导）',
        '(no author guidance)',
      ))

    let finalizedSources: FinalizedMaterialSource[] = []
    let activeThreadContext = ''
    if (!isFirstChapter) {
      const finalized = await this.readFinalizedMaterials(
        expectedProjectPath,
        this.chapterInfo.chapterNumber,
        projectSession,
        this.chapterInfo.characters,
      )
      finalizedSources = finalized.sources
      callbacks.log(uiText(
        `  已定位定稿连续性原文（${finalized.locatedFactCandidates} 条候选）`,
        `  Located finalized continuity excerpts (${finalized.locatedFactCandidates} ${pluralEn(finalized.locatedFactCandidates, 'candidate')})`,
      ))
      const activeThreads = await this.readActiveNarrativeThreads(
        expectedProjectPath,
        projectSession,
        writingLanguage,
      )
      callbacks.log(uiText(
        `  已加载相关活跃叙事线索（${activeThreads.count} 条）`,
        `  Loaded relevant active narrative threads (${activeThreads.count})`,
      ))
      activeThreadContext = activeThreads.text
      promptBuilder
        // Old summaries, currentState and previous-ending slots stay empty. One
        // source-labelled material package is appended below.
        .withGlobalSummary('')
        .withPreviousEnding('')
        .withShortSummary('')
    }

    if (defaultMain && earlyRecovery?.selectedDraftIds.length && !earlyRecovery.selectedDrafts)
      throw new Error('GENERATION_DRAFT_SOURCE_CHANGED')
    const explicitlyRequiredDraftIds = new Set(this.selectedCandidateDrafts
      .filter(candidate => candidate.required === true).map(candidate => candidate.draftId))
    const selectedCandidateDrafts = (defaultMain ? prepared?.selectedDrafts ?? earlyRecovery?.selectedDrafts ?? [] : this.selectedCandidateDrafts)
      .filter(candidate => candidate.chapterNumber < this.chapterInfo.chapterNumber)
      .map(candidate => explicitlyRequiredDraftIds.has(candidate.draftId) && candidate.required !== true
        ? { ...candidate, required: true }
        : candidate)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
    const previousChapterNumber = this.chapterInfo.chapterNumber - 1
    const hasRequiredPreviousCandidate = selectedCandidateDrafts.some(candidate => (
      candidate.chapterNumber === previousChapterNumber && Boolean(candidate.content.trim())
    ))
    const requiredFinalizedSource = finalizedSources.find(source => (
      source.chapterNumber === previousChapterNumber
      && source.sourceStatus !== 'invalid'
      && Boolean(source.content.trim())
    ))
    if (!isFirstChapter && !hasRequiredPreviousCandidate && !requiredFinalizedSource) {
      throw new Error(uiText(
        `无法固定第 ${previousChapterNumber} 章的必需定稿来源，已停止生成。请修复或重新定稿该章后再试。`,
        `The required finalized source for Chapter ${previousChapterNumber} could not be fixed, so generation stopped. Repair or re-finalize that chapter and try again.`,
      ))
    }
    let chapterMaterials: ChapterMaterialAssembly
    try {
      chapterMaterials = await assembleChapterMaterials({
        identity: { projectId: projectSession.projectId, epoch: projectSession.leaseId },
        writingLanguage,
        budgetChars: 8_000,
        authorProjectFacts: authoredConfigFacts,
        characterProfiles,
        futurePlans: futureBlueprintsStr,
        references: [
          ...(activeThreadContext ? [{ text: activeThreadContext, rendered: activeThreadContext }] : []),
          ...knowledgeReferences,
        ],
        finalized: finalizedSources,
        candidates: selectedCandidateDrafts,
        relevanceTerms: [
          this.chapterInfo.title,
          this.chapterInfo.keyEvents,
          ...this.chapterInfo.characters,
        ],
      })
    } catch (error) {
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      callbacks.log(uiText(
        `  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`,
      ))
      throw new Error(uiText(
        '本章必需材料（作者资料、角色档案、后续计划、上一章正文）超出上下文容量，已停止生成。请精简这些内容后重试。',
        'The required material for this chapter (author facts, character profiles, future plans, previous chapter prose) exceeds the context capacity, so generation stopped. Trim it and try again.',
      ))
    }
    const admittedCandidateSourceIds = new Set(chapterMaterials.selection.included
      .map(material => material.ref.sourceId)
      .filter(sourceId => sourceId.startsWith('candidate:')))
    if (selectedCandidateDrafts.length > 0 && admittedCandidateSourceIds.size === 0) {
      throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED')
    }
    if (selectedCandidateDrafts.length === 0 && requiredFinalizedSource
      && !chapterMaterials.selection.included.some(material => material.ref.sourceId === `finalized:${requiredFinalizedSource.draftId}`)) {
      throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED')
    }
    if (chapterMaterials.omissions.length > 0) {
      callbacks.log(uiText(
        `  可选材料覆盖缺口：${chapterMaterials.omissions.length} 项`,
        `  Optional material coverage gaps: ${chapterMaterials.omissions.length}`,
      ))
    }
    // 仅历史恢复沿用已记录的对账块；新 run 直接使用作者材料与定稿事实。
    const chapterExecutionContract = chapterExecutionContractText(writingLanguage, writerChapterInfo)
    const systemRole = `${promptBuilder.getSystemRole()}\n\n${chapterExecutionContract.rules}`
    const composeInitialPrompt = (reconciliationBlock: string) => [chapterMaterials.text, promptBuilder.build(),
      reconciliationBlock, chapterExecutionContract.authorItems, chapterLengthContract]
      .filter(Boolean)
      .join('\n\n')
    const prompt = composeInitialPrompt('')
    const outlinePrompt = draftShortOutlinePrompt(writingLanguage, prompt)
    const withSkill = (content: string) => injectWritingSkillIntoTask({ purpose: 'chapter-draft', output: 'visible-text',
      messages: [{ role: 'user', content }] }, context, 'drafting').task.messages[0]!.content
    const materialDecision = { ...chapterMaterials.decision, promptHash: await hashAuthorText(withSkill(prompt)),
      ...(!this.resumeHandle ? { shortOutlinePromptHash: await hashAuthorText(withSkill(outlinePrompt)) } : {}) }
    const previousEnding = chapterMaterials.previousEnding

    callbacks.log(uiText(
      '调用 AI 生成章节草稿...',
      'Calling AI to generate the chapter draft...',
    ))
    let mainOwned = false
    let alreadySaved = false
    let draftPersisted = false
    let recoverableDraftCandidate = ''
    const priorSave = this.resumeHandle
      ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: this.resumeHandle })
      : null
    if (priorSave?.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
    let planning = true
    const workflowStepId = step && typeof step === 'object' && 'id' in step && typeof step.id === 'string'
      ? step.id
      : 'generate-draft'
    try {
      this.assertNotCancelled(context)
      const cancellation = observeWorkflowCancellation(context)
      let runtime: GenerationRuntime | null = null
      let cleanDraftText: string
      let acknowledgedPreview = ''
      let replacingPreview = false
      let compositionVersion: DraftVisibleTextVersion = DRAFT_VISIBLE_TEXT_VERSION
      // 对账输出不是正文：对账请求进行期间不把它的快照显示到写作面板。
      const mainCallbacks = { ...callbacks,
        appendText: (text: string) => { if (!planning) callbacks.appendText(text) },
        ...(callbacks.replaceText ? { replaceText: (text: string) => {
          if (!planning) callbacks.replaceText?.(replacingPreview ? text : composeDraftVisibleContinuation(acknowledgedPreview, text, compositionVersion))
        } } : {}),
      }
      try {
        const generationModelId = workflowGenerationModelId(context)
        if (priorSave?.draftSave.kind === 'current') {
          if (priorSave.operation !== 'chapter-draft' || priorSave.chapterNumber !== this.chapterInfo.chapterNumber)
            throw new Error('GENERATION_DRAFT_RECOVERY_SCOPE_INVALID')
          mainOwned = true
          alreadySaved = true
          context.mainGenerationRunHandle = this.resumeHandle
          cleanDraftText = priorSave.draftSave.receipt.content
        } else {
        runtime = await this.dependencies.createRuntime({
          budget: DRAFT_GENERATION_BUDGET,
          ...(generationModelId ? { modelId: generationModelId } : {}),
        }, { context, callbacks: mainCallbacks, selection: {
          operation: 'chapter-draft', chapterNumber: this.chapterInfo.chapterNumber,
          ...(prepared ? { preparationId: prepared.preparationId } : {}),
          ...(this.batchId ? { batchId: this.batchId } : {}),
          promptKeys: [templateKey], skillStages: ['drafting'], output: 'visible-text',
          selectedDraftIds: [...new Set(selectedCandidateDrafts.map(item => item.draftId))],
          selectedFinalizedDraftIds: [...new Set(chapterMaterials.consumedFinalizedSources.map(item => item.draftId))],
          selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => this.chapterInfo.chapterNumber + index),
          // S10B 步骤 3：本次准入的脱敏收据随冻结上下文一起进主进程，并被恢复指纹绑定。
          materialDecision,
          authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
            { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
            { id: 'draft:target-units', text: String(targetChars) }],
          ...(this.resumeHandle ? { resumeHandle: this.resumeHandle } : {}),
        } })
        mainOwned = (runtime as { mainOwned?: boolean }).mainOwned === true
        cleanDraftText = await runtime.execute(async ({ session }) => {
          let recovery = mainOwned && this.resumeHandle
            ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: context.mainGenerationRunHandle! })
            : null
          if (recovery?.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
          if (this.resumeHandle && !mainOwned) throw new Error('GENERATION_DRAFT_LEGACY_RESUME_REFUSED')
          let reconciliationArtifactIds = new Set([...(recovery?.draftReconciliation?.artifactIds ?? []), ...(recovery?.draftShortOutline?.artifactIds ?? [])])
          const retryOutline = recovery?.draftShortOutline?.retry?.kind === 'available'
          const outlinedOnly = !!recovery?.draftShortOutline?.completedOutput && !recovery.composition
            && recovery.attemptedPurposes.every(purpose => purpose === DRAFT_SHORT_OUTLINE_PURPOSE)
          // 对账已完成而首稿尚未发出（如进程在两者之间中断）：沿用记录的对账结果直接生成首稿。
          const reconciledOnly = !!recovery && !recovery.composition && recovery.draftSave.kind === 'absent' && recovery.attemptedPurposes.length > 0
            && recovery.attemptedPurposes.every(purpose => purpose === DRAFT_RECONCILE_PURPOSE)
          const failedBatchView = recovery && this.batchId && recovery.batchId === this.batchId
            && !recovery.composition && recovery.draftSave.kind === 'absent' && recovery.lastCompositionFinishReason === null
            && recovery.attemptedPurposes.at(-1) === 'chapter-draft'
            ? await ipc.invokeWithProjectSession(projectSession, 'generation:read', this.resumeHandle!) : null
          const lastAttempt = failedBatchView?.budgetDiagnostics?.at(-1)
          const retryFailedBatch = !!failedBatchView && failedBatchView.status === 'running' && !failedBatchView.nonReplayable
            && failedBatchView.handle.runId === this.resumeHandle?.runId && (failedBatchView.ledger?.physicalRequests ?? 0) > 0
            && !failedBatchView.ledger?.blockedCode && lastAttempt?.finishReason === null
            && (lastAttempt.failureCode === 'GENERATION_PROVIDER_FAILED' || lastAttempt.failureCode === 'NETWORK_ERROR')
            && ![...failedBatchView.artifacts, ...(failedBatchView.candidates ?? [])].some(artifact => !reconciliationArtifactIds.has(artifact.artifactId) && artifact.text.trim())
            && !failedBatchView.unsavedTails?.some(tail => tail.text.trim())
          if (recovery && (recovery.operation !== 'chapter-draft'
            || recovery.chapterNumber !== this.chapterInfo.chapterNumber
            || !retryOutline && !retryFailedBatch && !reconciledOnly && !outlinedOnly && (!recovery.composition || !isDraftVisibleTextVersion(recovery.composition.algorithm)
              || !['stop', 'length'].includes(recovery.lastCompositionFinishReason ?? ''))))
            throw new Error('GENERATION_DRAFT_RECOVERY_EVIDENCE_REQUIRED')
          if (recovery?.composition && isDraftVisibleTextVersion(recovery.composition.algorithm))
            compositionVersion = recovery.composition.algorithm
          const expectedInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
            { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
            { id: 'draft:target-units', text: String(targetChars) }]
          const recoveredAuthorInputs = recovery?.authorInputs
          if (recoveredAuthorInputs && expectedInputs.some(input => recoveredAuthorInputs.find(item => item.id === input.id)?.text !== input.text))
            throw new Error('GENERATION_DRAFT_RECOVERY_AUTHOR_INPUT_CHANGED')
          const sameIds = (a: readonly number[], b: readonly number[]) => JSON.stringify([...new Set(a)].sort((a, b) => a - b)) === JSON.stringify([...new Set(b)].sort((a, b) => a - b))
          if (recovery && (!sameIds(recovery.selectedDraftIds, selectedCandidateDrafts.map(item => item.draftId))
            || !sameIds(recovery.selectedFinalizedDraftIds, chapterMaterials.consumedFinalizedSources.map(item => item.draftId))
            || !sameIds(recovery.selectedBlueprintChapterNumbers, Array.from({ length: 6 }, (_, index) => this.chapterInfo.chapterNumber + index))))
            throw new Error('GENERATION_DRAFT_RECOVERY_SOURCE_SELECTION_CHANGED')
          let acknowledgedIds: string[] = [...(recovery?.composition?.artifactIds ?? [])]
          acknowledgedPreview = recovery?.composition?.text ?? ''
          const acknowledge = async (outcome: GenerationOutcome, text: string) => {
            if (!mainOwned || !text || !['stop', 'length'].includes(outcome.finishReason)) return
            const handle = context.mainGenerationRunHandle
            const artifact = outcome.receipt.visibleArtifact
            if (!handle || !artifact) throw new Error('GENERATION_COMPOSITION_ARTIFACT_REQUIRED')
            if (reconciliationArtifactIds.has(artifact.artifactId)) throw new Error('GENERATION_COMPOSITION_SOURCE_INVALID')
            const hash = await sha256Hex(text)
            const expectedIds = [...acknowledgedIds, artifact.artifactId]
            const receipt = await ipc.invokeWithProjectSession(projectSession, 'generation:compose-visible',
              handle, expectedIds, hash, compositionVersion)
            if (receipt.text !== text || receipt.textHash !== hash || receipt.algorithm !== compositionVersion
              || JSON.stringify(receipt.artifactIds) !== JSON.stringify(expectedIds))
              throw new Error('GENERATION_COMPOSITION_RECEIPT_MISMATCH')
            acknowledgedIds = [...receipt.artifactIds]
            acknowledgedPreview = receipt.text
          }
          const draftingSession = injectWritingSkillIntoSession(keepReceiptFailuresOnCancel(session, context), context, 'drafting')
          if (context.writingSkills?.drafting) {
            callbacks.log(uiText(
              `本次 drafting 阶段使用已冻结写作 Skill：${context.writingSkills.drafting.name}`,
              `Using the workflow-start-frozen writing skill for drafting: ${context.writingSkills.drafting.name}`,
            ))
          }
          const recordedReconciliation = recovery?.draftReconciliation?.completedOutput
          let shortOutline = recovery?.draftShortOutline?.completedOutput ?? ''
          let outlined: GenerationOutcome | undefined
          if (!recovery) {
            callbacks.log(uiText('生成短细纲...', 'Generating a short chapter outline...'))
            outlined = await draftingSession.complete(draftShortOutlineTask(writingLanguage, outlinePrompt), { signal: cancellation.signal })
            logDraftAttempt(callbacks, context, { zhCN: '短细纲', enUS: 'Short outline' }, outlined.receipt)
            if (outlined.status === 'completed' && outlined.finishReason === 'stop' && outlined.content.trim()) {
              shortOutline = outlined.content
            } else if (mainOwned) {
              recovery = await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: context.mainGenerationRunHandle! })
              if (recovery.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
            }
          }
          if (recovery?.draftShortOutline?.retry?.kind === 'available') {
            this.assertNotCancelled(context)
            callbacks.log(uiText('重新生成短细纲...', 'Retrying the short chapter outline...'))
            const retried = await ipc.invokeWithProjectSession(projectSession, 'generation:retry-draft-short-outline', {
              handle: context.mainGenerationRunHandle!, failedAttemptId: recovery.draftShortOutline.retry.failedAttemptId,
            })
            outlined = retried.outcome
            logDraftAttempt(callbacks, context, { zhCN: '短细纲', enUS: 'Short outline' }, outlined.receipt)
            throwIfTerminalProviderFailure(outlined.receipt)
            if (outlined.status === 'completed' && outlined.finishReason === 'stop' && outlined.content.trim()) {
              recovery = await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: context.mainGenerationRunHandle! })
              if (recovery.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
              shortOutline = recovery.draftShortOutline?.completedOutput ?? ''
              if (shortOutline !== outlined.content || !outlined.receipt.visibleArtifact
                || !recovery.draftShortOutline?.artifactIds.includes(outlined.receipt.visibleArtifact.artifactId))
                throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
              reconciliationArtifactIds = new Set([...(recovery.draftReconciliation?.artifactIds ?? []), ...recovery.draftShortOutline.artifactIds])
            }
          }
          if (outlined && (outlined.status !== 'completed' || outlined.finishReason !== 'stop' || !outlined.content.trim())) {
            // 作者取消时请求会被截断着返回，主进程不把取消码交给渲染端；带失败码的是真实失败，照常报短细纲失败。
            // 重试结果直接来自 IPC，不经过 keepReceiptFailuresOnCancel，所以这里自己分辨。
            if (!outlined.receipt.failureCode) this.assertNotCancelled(context)
            const reason = outlined.finishReason === 'length'
              ? uiText('模型输出被截断', 'the model output was truncated')
              : !outlined.content.trim() ? uiText('模型未返回可见内容', 'the model returned no visible content')
                : uiText('模型未正常完成输出', 'the model did not complete the output normally')
            const diagnostic = `(GENERATION_DRAFT_SHORT_OUTLINE_FAILED; status=${outlined.status}; finishReason=${outlined.finishReason})`
            throw new Error(uiText(`短细纲生成失败：${reason}。正文尚未开始。${diagnostic}`,
              `The short chapter outline failed: ${reason}. Drafting has not started. ${diagnostic}`))
          }
          if (recovery?.draftShortOutline && !shortOutline) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
          const reconciliationBlock = [recordedReconciliation ? draftReconciliationBlock(writingLanguage, recordedReconciliation) : '',
            shortOutline ? draftShortOutlineBlock(writingLanguage, shortOutline) : ''].filter(Boolean).join('\n\n')
          const initialPrompt = shortOutline ? `${prompt}\n\n${draftShortOutlineBlock(writingLanguage, shortOutline)}`
            : composeInitialPrompt(reconciliationBlock)
          const originalDraftTask = recovery?.draftShortOutline?.initialDraftTask
          if (recovery?.draftShortOutline && (recovery.draftShortOutline.promptHash !== await hashAuthorText(withSkill(outlinePrompt))
            || recovery.attemptedPurposes.includes('chapter-draft') && !originalDraftTask
            || originalDraftTask && (originalDraftTask.messages.find(message => message.role === 'user')?.content !== withSkill(initialPrompt)
              || originalDraftTask.messages.find(message => message.role === 'system')?.content !== systemRole)))
            throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_IDENTITY_CHANGED')
          planning = false
          this.assertNotCancelled(context)
          callbacks.setProgress(10)
          const preview = createDraftStreamPreview(
            callbacks.replaceText,
            visibleDraftStreamText,
          )
          let initialVisibleDraft: string
          let initialFinishReason: LLMCompletion['finishReason']
          let initialFailureCode: GenerationAttemptReceipt['failureCode']
          let initialReasoning = true
          if (recovery?.composition) {
            initialVisibleDraft = recovery.composition!.text
            initialFinishReason = recovery.lastCompositionFinishReason as 'stop' | 'length'
            preview.stop()
          } else {
            let initialOutcome: GenerationOutcome
            try {
              initialOutcome = await draftingSession.complete({
                purpose: 'chapter-draft',
                budgetDemand: { kind: 'draft-units', writingLanguage, requestedUnits: targetChars, segmentable: false },
                reasoningStage: 'drafting',
                output: 'visible-text',
                messages: [
                  { role: 'system', content: systemRole },
                  { role: 'user', content: initialPrompt },
                ],
              }, {
                signal: cancellation.signal,
                ...(!mainOwned ? { onChunk: (chunk: string) => {
                  if (context.cancelled) return
                  preview.push(chunk)
                } } : {}),
              })
            } catch (error) {
              recoverableDraftCandidate = preview.snapshot()
              throw error
            } finally {
              preview.stop()
            }
            const initialCompletion = completionFromOutcome(initialOutcome)
            logDraftAttempt(
              callbacks,
              context,
              { zhCN: '初始生成', enUS: 'Initial generation' },
              initialOutcome.receipt,
            )
            callbacks.log(uiText(
              `  初始生成响应结束：finishReason=${initialCompletion.finishReason}`,
              `  Initial generation response ended: finishReason=${initialCompletion.finishReason}`,
            ))
            initialVisibleDraft = sanitizeDraftText(this.stripThinkingTags(initialCompletion.content), compositionVersion)
            initialFinishReason = initialCompletion.finishReason
            initialFailureCode = initialOutcome.receipt.failureCode
            initialReasoning = initialOutcome.receipt.capabilities.reasoning === true
            await acknowledge(initialOutcome, initialVisibleDraft)
            }
          recoverableDraftCandidate = initialVisibleDraft
          callbacks.log(uiText(
            `  初始生成可见单位：visibleUnits=${countDraftUnits(initialVisibleDraft)}`,
            `  Initial generation visible units: visibleUnits=${countDraftUnits(initialVisibleDraft)}`,
          ))
          callbacks.replaceText?.(initialVisibleDraft)
          callbacks.setProgress(90)
          this.assertNotCancelled(context)
          const completedDraft = await this.extendDraftIfNeeded({
            session: draftingSession,
            compositionVersion,
            mainOwned,
            acknowledge,
            signal: cancellation.signal,
            initialDraft: initialVisibleDraft,
            initialFinishReason,
            initialFailureCode,
            initialRounds: recovery?.attemptedPurposes.filter(purpose => purpose === 'chapter-draft-continuation' || purpose === 'chapter-draft-no-progress-recovery').length,
            noProgressRecoveryUsed: recovery?.attemptedPurposes.includes('chapter-draft-no-progress-recovery'),
            targetChars,
            callbacks,
            context,
            systemRole,
            chapterInfo: writerChapterInfo,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            chapterMaterials: chapterMaterials.text,
            reconciliation: reconciliationBlock,
            writingLanguage,
            reasoning: initialReasoning,
            onRecoverableCandidate: candidate => { recoverableDraftCandidate = candidate },
          })
          recoverableDraftCandidate = completedDraft.text
          replacingPreview = true
          const lengthCheckedDraft = await this.condenseDraftIfNeeded({
            session: draftingSession,
            compositionVersion,
            acknowledge,
            signal: cancellation.signal,
            candidate: completedDraft,
            alreadyAttempted: recovery?.attemptedPurposes.includes(DRAFT_CONDENSE_PURPOSE) === true,
            targetChars,
            callbacks,
            context,
            systemRole,
            chapterInfo: writerChapterInfo,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            chapterMaterials: chapterMaterials.text,
            reconciliation: reconciliationBlock,
            writingLanguage,
          })
          recoverableDraftCandidate = lengthCheckedDraft
          return lengthCheckedDraft
        })
        }
      } catch (error) {
        if (context.cancelled && isWorkflowCancellation(error)) throw new WorkflowCancelledError(uiText('工作流已取消', 'Workflow was cancelled.'))
        throw error
      } finally {
        cancellation.dispose()
        if (runtime) {
          try { await runtime.close() } catch { /* execute close failure already fails before persistence */ }
        }
      }
      this.assertNotCancelled(context)
      if (!alreadySaved) {
        const units = countDraftUnits(cleanDraftText)
        const range = draftTargetUnitRange(targetChars)
        if (units < range.minimum) throw draftTooShortError(context, units, targetChars)
      }
      if (!alreadySaved && hasSubstantialPreviousChapterReuse(previousEnding, cleanDraftText, writingLanguage)) {
        throw new Error(uiText(
          '新章节开头与上一章结尾存在大段重演，结果未保存。请重新生成，并让本章从上一章已完成事件之后继续。',
          'The new chapter substantially replays the previous ending, so it was not saved. Regenerate it and continue after the events already completed in the previous chapter.',
        ))
      }

      // 落于数据库
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) {
        throw new Error(uiText(
          '当前项目已切换，已拒绝保存章节草稿',
          'The project changed, so saving the chapter draft was refused.',
        ))
      }
      this.assertNotCancelled(context)
      if (mainOwned && !alreadySaved
        && JSON.stringify(useProjectStore.getState().currentProject?.novelConfig) !== JSON.stringify(novelConfig))
        throw new Error('GENERATION_DRAFT_AUTHOR_CONFIG_CHANGED')
      const createResult = mainOwned ? await (async () => {
        const handle = context.mainGenerationRunHandle
        if (!handle) throw new Error('GENERATION_COMPOSITION_HANDLE_REQUIRED')
        const saved = await ipc.invokeWithProjectSession(projectSession, 'generation:commit-draft', {
          handle, chapterNumber: this.chapterInfo.chapterNumber, source: 'write',
          ...(this.batchId ? { batchId: this.batchId } : {}),
          expectedCompositionHash: await sha256Hex(cleanDraftText),
        })
        if (saved.content !== cleanDraftText || saved.contentHash !== await sha256Hex(cleanDraftText))
          throw new Error('GENERATION_DRAFT_COMMIT_RECEIPT_MISMATCH')
        return saved
      })() : await (async () => {
        const nextVersion: number = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-next-version',
          this.chapterInfo.chapterNumber,
          expectedProjectPath,
        )
        this.assertNotCancelled(context)
        const finalizedDependencies: DraftSourceDependency[] = await Promise.all(
          chapterMaterials.consumedFinalizedSources.map(async source => source.sourceIdentity?.kind === 'finalized'
            ? {
                kind: 'finalized' as const,
                draftId: source.draftId,
                chapterNumber: source.chapterNumber,
                finalizationId: source.sourceIdentity.finalizationId,
                contentHash: source.sourceIdentity.contentHash,
              }
            : {
                kind: 'legacy-finalized' as const,
                draftId: source.draftId,
                chapterNumber: source.chapterNumber,
                contentHash: await sha256Hex(source.content),
              }),
        )
        const finalizedDraftIds = new Set(finalizedDependencies.map(dependency => dependency.draftId))
        const candidateDependencies: DraftSourceDependency[] = await Promise.all(
          selectedCandidateDrafts
            .filter(candidate => admittedCandidateSourceIds.has(`candidate:${candidate.draftId}`)
              && !finalizedDraftIds.has(candidate.draftId))
            .map(async candidate => ({
              draftId: candidate.draftId,
              contentHash: await sha256Hex(candidate.content),
            })),
        )
        const saved = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
          chapterNumber: this.chapterInfo.chapterNumber,
          version: nextVersion,
          source: 'write',
          content: cleanDraftText,
          wordCount: countDraftUnits(cleanDraftText),
          sourceDependencies: [...candidateDependencies, ...finalizedDependencies],
        }, expectedProjectPath)
          return { ...saved, version: nextVersion }
      })()
      const nextVersion = createResult.version
      if (!createResult.success || !createResult.id) {
        throw workflowMainProcessError(context, 'error' in createResult ? createResult.error : undefined, '章节草稿保存失败', 'Failed to save the chapter draft.')
      }
      this.assertNotCancelled(context)
      draftPersisted = true
      return this.publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
        cleanDraftText, id: createResult.id, nextVersion, mergedGuidance, targetChars })
    } catch (error) {
      if (!mainOwned && !draftPersisted && recoverableDraftCandidate) {
        callbacks.replaceText?.(recoverableDraftCandidate)
        const failureCode = recoveryFailureCode(error)
        const failureReason = error instanceof Error ? error.message : String(error)
        try {
          const result = await ipc.invokeWithProjectSession(
            projectSession,
            'db:recovery-candidate-record',
            {
              runId: context.runId,
              stepId: workflowStepId,
              chapterNumber: this.chapterInfo.chapterNumber,
              chapterTitle: this.chapterInfo.title,
              source: recoveryChapterSource(this.chapterInfo),
              sourceDraft: sourceDraft ? { id: sourceDraft.id, version: sourceDraft.version } : null,
              visibleText: recoverableDraftCandidate,
              failureCode,
              failureReason,
            },
            expectedProjectPath,
          )
          if (!result.success || !result.candidate) {
            throw workflowMainProcessError(context, result.error, '存储层拒绝写入', 'Storage rejected the write.')
          }
          callbacks.log(uiText(
            '生成未能安全完成；已收到的可见正文已保存为项目恢复候选，未进入草稿库。',
            'Generation could not complete safely. The visible prose was saved as a project recovery candidate and was not added to the draft library.',
          ))
        } catch (persistenceError) {
          // failureReason 原样进恢复记录供定位；给作者看的说明按界面语言解释登记过的码。
          const failureDetail = shownReason(context, error)
          const persistenceDetail = shownReason(context, persistenceError)
          callbacks.log(uiText(
            `恢复候选保存失败；可见正文仍保留在当前步骤中：${persistenceDetail}`,
            englishWithReason('Saving the recovery candidate failed. The visible prose remains in the current step', persistenceDetail, ': '),
          ))
          throw new Error(uiText(
            `${failureDetail}；恢复候选保存失败：${persistenceDetail}`,
            englishWithReason(`${failureDetail}; saving the recovery candidate failed`, persistenceDetail, ': '),
          ))
        }
      } else if (!mainOwned && !draftPersisted) {
        callbacks.replaceText?.('')
      }
      throw error
    }
  }

  private async publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
    cleanDraftText, id, nextVersion, mergedGuidance, targetChars }: {
    context: CommandExecuteParams['context']; callbacks: CommandExecuteParams['callbacks']
    projectSession: ProjectSessionContext; expectedProjectPath: string
    cleanDraftText: string; id: number; nextVersion: number; mergedGuidance: string; targetChars: number
  }): Promise<string> {
    const uiText = (zh: string, en: string) => workflowUiText(context, zh, en)
    callbacks.replaceText?.(cleanDraftText)

    const pseudoPath = formatResourceUri({ kind: 'draft', id })

    context.data.draft = cleanDraftText
    context.data.draftContent = cleanDraftText
    context.data.draftPath = pseudoPath
    context.data.draftId = id
    context.data.draftVersion = nextVersion
    context.data.chapterNumber = this.chapterInfo.chapterNumber
    context.data.chapterInfo = this.chapterInfo
    context.data.mergedGuidance = mergedGuidance
    context.data.shortSummary = ''

    await useProjectStore.getState().refreshFileTree(expectedProjectPath, undefined, projectSession)
    try {
      const { useDraftStore } = await import('../../../stores/draft-store')
      await useDraftStore.getState().loadAllDrafts(expectedProjectPath, projectSession)
    } catch { /* 忽略 */ }

    try {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) throw new Error(uiText(
        '当前项目已切换，已拒绝打开旧草稿',
        'The project changed, so opening the old draft was refused.',
      ))
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: pseudoPath,
        name: uiText(
        `第${this.chapterInfo.chapterNumber}章 ${this.chapterInfo.title} v${nextVersion}`,
        `Chapter ${this.chapterInfo.chapterNumber} ${this.chapterInfo.title} v${nextVersion}`,
        ),
        type: 'chapter',
        filePath: pseudoPath,
        content: cleanDraftText,
        savedContent: cleanDraftText,
        projectKey: expectedProjectPath,
      })
    } catch { /* 忽略 */ }

    callbacks.log(uiText(
      `草稿已自动入库保存为版本 v${nextVersion}（${countDraftUnits(cleanDraftText)} 字）`,
      `Draft saved automatically as version v${nextVersion} (${countDraftUnits(cleanDraftText)} ${pluralEn(countDraftUnits(cleanDraftText), 'unit')})`,
    ))
    const units = countDraftUnits(cleanDraftText), { maximum } = draftTargetUnitRange(targetChars)
    if (units > maximum) callbacks.log(uiText(
      `第${this.chapterInfo.chapterNumber}章字数超过约定`,
      `Chapter ${this.chapterInfo.chapterNumber} exceeds the agreed length.`,
    ))
    return cleanDraftText
  }

  private async extendDraftIfNeeded(params: {
    session: GenerationSession
    compositionVersion: DraftVisibleTextVersion
    mainOwned?: boolean
    acknowledge?: (outcome: GenerationOutcome, text: string) => Promise<void>
    signal: AbortSignal
    initialDraft: string
    initialRounds?: number
    noProgressRecoveryUsed?: boolean
    initialFinishReason: LLMCompletion['finishReason']
    initialFailureCode?: GenerationAttemptReceipt['failureCode']
    targetChars: number
    callbacks: CommandExecuteParams['callbacks']
    context: CommandExecuteParams['context']
    systemRole: string
    chapterInfo: WriterChapterInfo
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    chapterMaterials: string
    reconciliation?: string
    writingLanguage: WritingLanguage
    reasoning: boolean
    onRecoverableCandidate(candidate: string): void
  }): Promise<DraftCandidate> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(
      params.context,
      zhCNText,
      enUSText,
    )
    let draft = params.initialDraft
    let rounds = params.initialRounds ?? 0
    let lastFinishReason = params.initialFinishReason
    let lastFailureCode = params.initialFailureCode
    let noProgressRecoveryUsed = params.noProgressRecoveryUsed ?? false
    let recoveryPending = false

    if (
      params.reasoning
      && lastFinishReason === 'length'
      && countDraftUnits(draft) < 100
    ) {
      throw new Error(
        uiText(
          '模型的输出预算主要消耗在推理阶段，尚未产生足够正文。无法安全续接隐藏推理过程；' +
            '请关闭模型思考模式、提高最大输出 Tokens，或改用更适合正文创作的非推理模型。',
          'The model spent most of its output budget on reasoning and did not produce enough prose. Hidden reasoning cannot be continued safely. ' +
            'Disable reasoning mode, increase the maximum output tokens, or use a non-reasoning model better suited to drafting.',
        ),
      )
    }

    while (shouldAutoContinueDraft(draft, params.targetChars, rounds, lastFinishReason)) {
      if (params.context.cancelled) break
      rounds += 1
      const currentChars = countDraftUnits(draft)
      params.callbacks.log(uiText(
        `  自动续写第 ${rounds} 段：当前约 ${currentChars}/${params.targetChars} 字`,
        `  Auto-continuation ${rounds}: currently about ${currentChars}/${params.targetChars} units`,
      ))

      const { prompt: continuationPrompt, allowance } = buildDraftContinuationPrompt({
        ...params,
        draft,
        recoveryPending,
      })

      const preview = createDraftStreamPreview(
        params.callbacks.replaceText,
        rawText => appendVisibleDraftContinuation(draft, visibleDraftStreamText(rawText)),
        draft,
      )
      let outcome: GenerationOutcome
      try {
        outcome = await params.session.complete({
          purpose: recoveryPending
            ? 'chapter-draft-no-progress-recovery'
            : 'chapter-draft-continuation',
          reasoningStage: 'drafting',
          output: 'visible-text',
          budgetDemand: { kind: 'draft-units', writingLanguage: params.writingLanguage, requestedUnits: Math.max(1, allowance), segmentable: false },
          messages: [
            { role: 'system', content: params.systemRole },
            { role: 'user', content: continuationPrompt },
          ],
        }, {
          signal: params.signal,
          ...(!params.mainOwned ? { onChunk: (chunk: string) => {
            if (params.context.cancelled) return
            preview.push(chunk)
          } } : {}),
        })
      } catch (error) {
        params.onRecoverableCandidate(preview.snapshot())
        throw error
      } finally {
        preview.stop()
      }
      const addition = completionFromOutcome(outcome)
      lastFailureCode = outcome.receipt.failureCode
      logDraftAttempt(
        params.callbacks,
        params.context,
        { zhCN: `自动续写第 ${rounds} 段`, enUS: `Auto-continuation ${rounds}` },
        outcome.receipt,
      )
      params.callbacks.log(uiText(
        `  自动续写第 ${rounds} 段响应结束：finishReason=${addition.finishReason}`,
        `  Auto-continuation ${rounds} response ended: finishReason=${addition.finishReason}`,
      ))
      this.assertNotCancelled(params.context)
      const beforeChars = countDraftUnits(draft)
      const visibleAddition = sanitizeDraftText(this.stripThinkingTags(addition.content), params.compositionVersion)
      const candidateDraft = appendVisibleDraftContinuation(
        draft,
        visibleAddition,
        params.compositionVersion,
      )
      const mergedDelta = countDraftUnits(candidateDraft) - beforeChars
      const accepted = isAcceptedDraftContinuation(addition.finishReason, mergedDelta)
      params.callbacks.log(uiText(
        `  自动续写可见单位：visibleUnitsBefore=${beforeChars} `
          + `candidateVisibleUnits=${countDraftUnits(visibleAddition)} `
          + `mergedDelta=${mergedDelta} accepted=${accepted}`,
        `  Auto-continuation visible units: visibleUnitsBefore=${beforeChars} `
          + `candidateVisibleUnits=${countDraftUnits(visibleAddition)} `
          + `mergedDelta=${mergedDelta} accepted=${accepted}`,
      ))
      if (isLowProgressDraftContinuation(addition.finishReason, mergedDelta)) {
        params.callbacks.replaceText?.(draft)
        if (noProgressRecoveryUsed) {
          throw new Error(uiText(
            '唯一一次无进展恢复请求仍未增加足够的新正文，结果未保存。请缩短章节目标后重试。',
            'The single no-progress recovery request still did not add enough new prose, so the result was not saved. Shorten the chapter target and try again.',
          ))
        }
        noProgressRecoveryUsed = true
        recoveryPending = true
        lastFinishReason = addition.finishReason
        params.callbacks.log(uiText(
          '  本轮低增量截断内容已丢弃，将使用剩余预算执行一次无进展恢复请求',
          '  Discarded this low-progress truncated continuation; using the remaining budget for one no-progress recovery request',
        ))
        continue
      }
      await params.acknowledge?.(outcome, candidateDraft)
      draft = candidateDraft
      params.onRecoverableCandidate(draft)
      params.callbacks.replaceText?.(draft)
      lastFinishReason = addition.finishReason
      recoveryPending = false
      if (mergedDelta < 300) break
    }

    this.assertNotCancelled(params.context)
    if (lastFinishReason === 'length'
      && countDraftUnits(draft) > draftTargetUnitRange(params.targetChars).maximum) return { text: draft, finishReason: lastFinishReason }
    if (lastFinishReason !== 'stop') {
      const error = this.createIncompleteCompletionError(lastFinishReason)
      if (lastFailureCode === 'GENERATION_PROVIDER_FAILED' || lastFailureCode === 'NETWORK_ERROR')
        Object.assign(error, { code: lastFailureCode })
      error.message = uiText(error.message, (() => {
        switch (lastFinishReason) {
          case 'length':
            return 'AI output reached the model maximum length and is incomplete. Increase the maximum output tokens or shorten the task, then try again.'
          case 'content_filter':
            return 'AI output was stopped by content restrictions, so the result was not saved.'
          case 'cancelled':
            return 'AI generation was cancelled, so the result was not saved.'
          default:
            return 'AI generation did not complete normally, so the result was not saved.'
        }
      })())
      throw error
    }

    const lowerBound = draftTargetUnitRange(params.targetChars).minimum
    const draftUnits = countDraftUnits(draft)
    if (draftUnits < lowerBound) throw draftTooShortError(params.context, draftUnits, params.targetChars)

    return { text: draft, finishReason: lastFinishReason }
  }

  private async condenseDraftIfNeeded(params: {
    session: GenerationSession
    compositionVersion: DraftVisibleTextVersion
    acknowledge: (outcome: GenerationOutcome, text: string) => Promise<void>
    signal: AbortSignal
    candidate: DraftCandidate
    alreadyAttempted: boolean
    targetChars: number
    callbacks: CommandExecuteParams['callbacks']
    context: CommandExecuteParams['context']
    systemRole: string
    chapterInfo: WriterChapterInfo
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    chapterMaterials: string
    reconciliation?: string
    writingLanguage: WritingLanguage
  }): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(params.context, zhCNText, enUSText)
    const range = draftTargetUnitRange(params.targetChars)
    const original = () => {
      this.assertNotCancelled(params.context)
      if (params.candidate.finishReason !== 'stop') throw this.createIncompleteCompletionError(params.candidate.finishReason)
      params.callbacks.replaceText?.(params.candidate.text)
      return params.candidate.text
    }
    const originalUnits = countDraftUnits(params.candidate.text)
    if (!shouldCondenseDraft(originalUnits, params.targetChars, params.alreadyAttempted)) return original()
    params.callbacks.log(uiText(
      `  正文约 ${originalUnits} 字，超出参考上限 ${range.maximum} 字，执行唯一一次压缩修订`,
      `  Draft is about ${originalUnits} units, above the reference maximum of ${range.maximum}; running the single condense revision`,
    ))
    const { prompt: condensePrompt } = buildDraftCondensePrompt(params)
    let outcome: GenerationOutcome
    try {
      outcome = await params.session.complete({
        purpose: DRAFT_CONDENSE_PURPOSE,
        reasoningStage: 'drafting',
        output: 'visible-text',
        budgetDemand: { kind: 'draft-units', writingLanguage: params.writingLanguage, requestedUnits: params.targetChars, segmentable: false },
        messages: [
          { role: 'system', content: params.systemRole },
          { role: 'user', content: condensePrompt },
        ],
      }, { signal: params.signal })
    } catch (error) {
      if (params.context.cancelled || params.signal.aborted) throw error
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'GENERATION_PROVIDER_FAILED' && code !== 'NETWORK_ERROR' && code !== 'GENERATION_CONTEXT_LENGTH_EXCEEDED') throw error
      const detail = shownReason(params.context, error)
      params.callbacks.log(uiText(
        `  压缩修订未完成，保留原稿：${detail}`,
        englishWithReason('  Condense revision did not complete; keeping the original draft', detail, ': '),
      ))
      return original()
    }
    this.assertNotCancelled(params.context)
    if (outcome.finishReason === 'cancelled') throw this.createIncompleteCompletionError('cancelled')
    logDraftAttempt(params.callbacks, params.context, { zhCN: '压缩修订', enUS: 'Condense revision' }, outcome.receipt)
    const condensed = sanitizeDraftText(this.stripThinkingTags(outcome.content), params.compositionVersion)
    const units = countDraftUnits(condensed)
    const accepted = acceptsCondensedDraft(outcome.finishReason, units, params.targetChars)
    params.callbacks.log(uiText(
      `  压缩修订响应结束：finishReason=${outcome.finishReason} visibleUnits=${units} accepted=${accepted}`,
      `  Condense revision response ended: finishReason=${outcome.finishReason} visibleUnits=${units} accepted=${accepted}`,
    ))
    if (!accepted) return original()
    await params.acknowledge(outcome, condensed)
    params.callbacks.replaceText?.(condensed)
    return condensed
  }

  // --- 抽取自原文件的辅助方法 ---
  private async readArchitecture(
    projectPath: string,
    projectSession: ProjectSessionContext,
    chapterNumber: number,
    authoredConfigFacts: readonly string[],
  ): Promise<string> {
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
    const duplicates = exactParagraphs(authoredConfigFacts)
    const parts: string[] = []
    if (core?.premise) parts.push(withoutExactParagraphDuplicates(core.premise, duplicates))
    if (core?.worldbuilding) parts.push(withoutExactParagraphDuplicates(core.worldbuilding, duplicates))
    if (core?.synopsis) {
      parts.push(withoutExactParagraphDuplicates(
        synopsisForDraftChapter(core.synopsis, chapterNumber),
        duplicates,
      ))
    }
    return parts.filter(Boolean).join('\n\n---\n\n')
  }

  private async readProjectPrompts(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
  ): Promise<string> {
    try {
      const files = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:list-dir',
        `${projectPath}/${DIR_PROMPTS}`,
        projectPath,
      )
      const mdFiles = files.filter((f: { isDir: boolean; name: string }) => !f.isDir && f.name.endsWith('.md'))
      if (mdFiles.length === 0) return ''
      const parts: string[] = []
      for (const f of mdFiles) {
        const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-file', f.path, projectPath)
        if (result.success && result.content.trim()) {
          parts.push(promptLanguageText(
            writingLanguage,
            `## 项目专属指导（${f.name.replace(/\.md$/, '')}）\n${result.content.trim()}`,
            `## Project-specific guidance (${f.name.replace(/\.md$/, '')})\n${result.content.trim()}`,
          ))
        }
      }
      return parts.join('\n\n')
    } catch { return '' }
  }

  private async readCharacterProfiles(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
    relevantCharacterNames: readonly string[],
  ): Promise<string> {
    try {
      const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath)
      if (roster.status !== 'ready' && roster.status !== 'empty') {
        return promptLanguageText(
          writingLanguage,
          '（角色资料来源未知或待修复；未作为作者事实注入）',
          '(character-profile provenance is unknown or needs repair; it was not injected as author fact)',
        )
      }
      const profiles: string[] = []
      const relevantNames = new Set(relevantCharacterNames.map(name => name.trim()).filter(Boolean))
      const selected = new Set<typeof roster.entries[number]>()
      for (const name of relevantNames) {
        const named = roster.entries.filter(card => card.name === name)
        const renamed = roster.entries.filter(card => card.name !== name && card.characterId
          && roster.aliases?.some(alias => alias.name === name && alias.characterId === card.characterId))
        // 旧名被另一角色复用时无法判断蓝图指谁，宁可不注入也不注入错的档案或中断写稿。
        if (renamed.length === 0) for (const card of named) selected.add(card)
        else if (named.length === 0 && renamed.length === 1) selected.add(renamed[0])
      }
      for (const card of selected) {
        const facts = [
          card.gender && `gender: ${card.gender}`,
          card.age && `age: ${card.age}`,
          card.appearance && `appearance: ${card.appearance}`,
          card.personality && `personality: ${card.personality}`,
          card.background && `background: ${card.background}`,
          card.abilities && `abilities: ${card.abilities}`,
          card.motivation && `motivation: ${card.motivation}`,
          card.arc && `arc: ${card.arc}`,
          card.notes && `notes: ${card.notes}`,
        ].filter(Boolean)
        for (const relationship of card.relationships ?? []) {
          const target = relationship.target?.trim()
          const relation = relationship.relation?.trim()
          if (target && relation) facts.push(`relationship: ${target} (${relation})`)
        }
        const legacyRelationshipNotes = card.legacyRelationshipNotes?.trim()
        if (legacyRelationshipNotes) {
          facts.push(promptLanguageText(
            writingLanguage,
            `relationship（legacy 来源未知）: ${legacyRelationshipNotes}`,
            `relationship (legacy provenance unknown): ${legacyRelationshipNotes}`,
          ))
        }
        for (const field of CHARACTER_STATE_TEXT_FIELDS) {
          const provenance = card.currentState?.provenance?.[field]
          const value = card.currentState?.[field]?.trim()
          if (provenance?.kind === 'author' && value) {
            facts.push(`${field}@chapter${provenance.chapterNumber}: ${value}`)
          }
        }
        profiles.push(`${card.name} (${card.role || 'unknown'})${facts.length ? ` | ${facts.join(' | ')}` : ''}`)
      }
      return profiles.length > 0 ? profiles.join('\n') : ''
    } catch {
      return promptLanguageText(
        writingLanguage,
        '（角色资料读取失败；未把旧 currentState 或 characters_arch 当作作者事实）',
        '(character profiles unavailable; legacy currentState and characters_arch were not treated as author facts)',
      )
    }
  }

  private async readFinalizedMaterials(
    projectPath: string,
    currentChapter: number,
    projectSession: ProjectSessionContext,
    currentEntities: readonly string[],
  ): Promise<{ sources: FinalizedMaterialSource[]; locatedFactCandidates: number }> {
    const FULL_WINDOW = 5
    let finalizedContinuity: FinalizedContinuityProjection[] = []
    try {
      finalizedContinuity = await ipc.invokeWithProjectSession(
        projectSession,
        'db:continuity-list-before',
        currentChapter,
        projectPath,
      )
    } catch { /* Optional derived index may be unavailable; finalized prose still loads below. */ }

    const selected = finalizedContinuity.flatMap(projection => {
      const isRecent = projection.chapterNumber >= currentChapter - FULL_WINDOW
      const factEvidence = (projection.facts ?? []).filter(fact => {
        const entityRelevant = fact.entities.some(entity => currentEntities.includes(entity))
          || currentEntities.some(entity => (
            fact.statement.includes(entity) || fact.evidence.includes(entity)
          ))
        return isRecent || entityRelevant
      }).map(fact => fact.evidence).filter(Boolean)
      const candidateEvidence = (projection.characterStateCandidates ?? [])
        .filter(candidate => isRecent || currentEntities.includes(candidate.characterName))
        .map(candidate => candidate.value || candidate.characterName)
        .filter(Boolean)
      const evidence = [...new Set([...factEvidence, ...candidateEvidence])]
      return evidence.length > 0 ? [{ projection, evidence }] : []
    }).sort((left, right) => right.projection.chapterNumber - left.projection.chapterNumber).slice(0, 12)

    const sources: FinalizedMaterialSource[] = []
    for (const { projection, evidence } of selected) {
      try {
        const sourceDraftId = projection.sourceStatus === 'stale' && projection.currentFinalizedDraftId
          ? projection.currentFinalizedDraftId : projection.draftId
        const sourceRead = await ipc.invokeWithProjectSession(
          projectSession,
          'db:continuity-read-source',
          sourceDraftId,
          projectPath,
        )
        const content = sourceRead.status === 'valid'
          ? sourceRead.snapshot.content
          : sourceRead.status === 'legacy'
            ? sourceRead.content
            : ''
        if (projection.chapterNumber === currentChapter - 1 && !content.trim()) continue
        sources.push({
          chapterNumber: projection.chapterNumber,
          draftId: sourceDraftId,
          title: sourceRead.status === 'valid' ? sourceRead.snapshot.chapterTitle : sourceRead.status === 'legacy' ? sourceRead.chapterTitle : projection.chapterTitle,
          content,
          evidence,
          includeEnding: projection.chapterNumber === currentChapter - 1,
          sourceStatus: sourceRead.status === 'invalid'
            ? 'invalid'
            : sourceRead.status === 'legacy'
              ? 'legacy'
              : projection.sourceStatus ?? 'current',
          ...(sourceRead.status === 'valid'
            ? {
                sourceIdentity: {
                  kind: 'finalized' as const,
                  finalizationId: sourceRead.snapshot.source.finalizationId,
                  contentHash: sourceRead.snapshot.source.contentHash,
                },
              }
            : sourceRead.status === 'legacy'
              ? { sourceIdentity: { kind: 'legacy-finalized' as const } }
              : {}),
        })
      } catch {
        if (projection.chapterNumber === currentChapter - 1) continue
        sources.push({
          chapterNumber: projection.chapterNumber,
          draftId: projection.draftId,
          title: projection.chapterTitle,
          content: '',
          evidence,
          includeEnding: projection.chapterNumber === currentChapter - 1,
          sourceStatus: 'invalid',
        })
      }
    }

    if (!sources.some(source => (
      source.chapterNumber === currentChapter - 1
      && source.sourceStatus !== 'invalid'
      && Boolean(source.content.trim())
    ))) {
      try {
        const meta = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-finalized',
          currentChapter - 1,
          projectPath,
        )
        if (meta) {
          try {
            const sourceRead = await ipc.invokeWithProjectSession(
              projectSession,
              'db:continuity-read-source',
              meta.id,
              projectPath,
            )
            sources.push({
              chapterNumber: currentChapter - 1,
              draftId: meta.id,
              title: sourceRead.status === 'valid'
                ? sourceRead.snapshot.chapterTitle
                : sourceRead.status === 'legacy'
                  ? sourceRead.chapterTitle
                  : meta.chapterTitle ?? '',
              content: sourceRead.status === 'valid'
                ? sourceRead.snapshot.content
                : sourceRead.status === 'legacy'
                  ? sourceRead.content
                  : '',
              evidence: [],
              includeEnding: true,
              sourceStatus: sourceRead.status === 'valid' ? 'current' : sourceRead.status,
              ...(sourceRead.status === 'valid'
                ? {
                    sourceIdentity: {
                      kind: 'finalized' as const,
                      finalizationId: sourceRead.snapshot.source.finalizationId,
                      contentHash: sourceRead.snapshot.source.contentHash,
                    },
                  }
                : sourceRead.status === 'legacy'
                  ? { sourceIdentity: { kind: 'legacy-finalized' as const } }
                  : {}),
            })
          } catch {
            sources.push({
              chapterNumber: currentChapter - 1,
              draftId: meta.id,
              title: meta.chapterTitle ?? '',
              content: '',
              evidence: [],
              includeEnding: true,
              sourceStatus: 'invalid',
            })
          }
        }
      } catch { /* Existing guard owns absence; do not invent a source identity. */ }
    }
    return { sources, locatedFactCandidates: selected.reduce((sum, item) => sum + item.evidence.length, 0) }
  }

  private async readActiveNarrativeThreads(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
  ): Promise<{ text: string; count: number }> {
    let threads: NarrativeThreadView[] = []
    try {
      threads = await ipc.invokeWithProjectSession(
        projectSession,
        'db:narrative-thread-list-relevant',
        {
          chapterNumber: this.chapterInfo.chapterNumber,
          title: this.chapterInfo.title,
          keyEvents: this.chapterInfo.keyEvents,
          characters: [...this.chapterInfo.characters],
        },
        projectPath,
      )
    } catch {
      return { text: '', count: 0 }
    }

    const header = promptLanguageText(
      writingLanguage,
      '【当前相关活跃叙事线索】',
      '[Relevant active narrative threads]',
    )
    const lines: string[] = []
    let usedChars = header.length + 1
    for (const thread of threads.slice(0, ACTIVE_THREAD_CONTEXT_MAX_ITEMS)) {
      const source = thread.events.at(-1)
      const line = promptLanguageText(
        writingLanguage,
        `- ${thread.title} [${thread.status}]（目标第${thread.targetStartChapter}–${thread.targetEndChapter}章；作者意图：${thread.authorIntent}${source ? `；来源第${source.chapterNumber}章：${source.evidence}` : ''}）`,
        `- ${thread.title} [${thread.status}] (target Chapters ${thread.targetStartChapter}–${thread.targetEndChapter}; author intent: ${thread.authorIntent}${source ? `; source Chapter ${source.chapterNumber}: ${source.evidence}` : ''})`,
      )
      const nextLength = line.length + (lines.length > 0 ? 1 : 0)
      if (usedChars + nextLength > ACTIVE_THREAD_CONTEXT_MAX_CHARS) break
      lines.push(line)
      usedChars += nextLength
    }
    if (lines.length === 0) return { text: '', count: 0 }
    return {
      text: `${header}\n${lines.join('\n')}`,
      count: lines.length,
    }
  }
}
