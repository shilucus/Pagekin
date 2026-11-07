import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { CharacterRosterRepository } from '../repositories/character-roster-repository'
import { NarrativeThreadRepository } from '../repositories/narrative-thread-repository'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { readGenerationSourceFile } from './generation-source-binding'
import { readInstalledWritingSkillBundle } from './writing-skill-package'
import { getBuiltinWritingSkills, readBuiltinWritingSkill } from '../../src/shared/builtin-writing-skills'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import { chapterExecutionContractText, chapterLengthContractText, synopsisForDraftChapter, toWriterChapterInfo, type DraftPromptMaterial } from '../../src/shared/draft-generation-prompts'
import { draftShortOutlinePrompt, draftShortOutlineTask } from '../../src/shared/draft-short-outline'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import { hashAuthorText } from '../../src/shared/source-ref'
import { inspectInstalledWritingSkill } from '../../src/shared/writing-skills'
import { injectWritingSkillPrompt } from '../../src/shared/writing-skill-task'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { getBuiltinPromptTemplate, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { promptLanguageText } from '../../src/services/prompt-language'
import { ChapterPromptBuilder } from '../../src/services/prompts/prompt-builder'
import { normalizeChapterWordsTarget } from '../../src/services/workflows/chapter-creation-parameters'
import { assembleChapterMaterials, type FinalizedMaterialSource, type SelectedCandidateDraft } from '../../src/services/workflows/chapter-materials'

interface BatchSource {
  database: Database.Database
  projectId: string
  epoch: string
  chapterNumber: number
  targetUnits: number
  assertResources: () => void
}

/** Read again for each chapter, before requesting that chapter's main-owned KB snapshot. */
export function readWorkflowBatchChapter(input: BatchSource) {
  input.assertResources()
  const core = ProjectCoreRepository.get(input.database)
  if (!core) throw new Error('GENERATION_BATCH_PROJECT_CORE_MISSING')
  const blueprints = BlueprintRepository.getAll(input.database)
  const blueprint = blueprints.find(item => item.chapterNumber === input.chapterNumber)
  if (!blueprint) throw new Error('GENERATION_BATCH_BLUEPRINT_MISSING')
  const chapterInfo = toWriterChapterInfo({ chapterNumber: blueprint.chapterNumber,
    title: blueprint.title || `第${blueprint.chapterNumber}章`, role: blueprint.role ?? '发展',
    purpose: blueprint.purpose || '', characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
    keyEvents: blueprint.keyEvents || '', suspenseHook: blueprint.suspenseHook || '', userGuidance: blueprint.userGuidance || '' })
  const novelConfig = { writingLanguage: core.writingLanguage, genre: core.genre, subGenre: core.subGenre,
    targetAudience: core.targetAudience, totalChapters: core.totalChapters, wordsPerChapter: core.wordsPerChapter,
    creativeStrategy: core.creativeStrategy, narrativeThreadDormantChapterThreshold: core.narrativeThreadDormantChapterThreshold,
    plotStructure: core.plotStructure, narrativePOV: core.narrativePov, coreOutline: core.coreOutline,
    worldSetting: core.worldSetting, goldenFinger: core.goldenFinger, protagonistProfile: core.protagonistProfile,
    globalGuidance: core.globalGuidance, writingStyle: core.writingStyle, referenceWorks: core.referenceWorks }
  const targetUnits = normalizeChapterWordsTarget(input.targetUnits, core.wordsPerChapter)
  const authorInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(chapterInfo) },
    { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
    { id: 'draft:target-units', text: String(targetUnits) }]
  const query = [chapterInfo.title, chapterInfo.keyEvents, chapterInfo.characters.join(' ')].filter(Boolean).join(' ')
  return { core, blueprints, chapterInfo, novelConfig, targetUnits, authorInputs, query }
}

function profiles(database: Database.Database, language: WritingLanguage, names: readonly string[]): string {
  const roster = CharacterRosterRepository.readCaptured(database)
  if (roster.status !== 'ready' && roster.status !== 'empty') return promptLanguageText(language,
    '（角色资料来源未知或待修复；未作为作者事实注入）', '(character-profile provenance is unknown or needs repair; it was not injected as author fact)')
  const selected = new Set<typeof roster.entries[number]>()
  for (const name of new Set(names.map(value => value.trim()).filter(Boolean))) {
    const named = roster.entries.filter(card => card.name === name)
    const renamed = roster.entries.filter(card => card.name !== name && card.characterId
      && roster.aliases?.some(alias => alias.name === name && alias.characterId === card.characterId))
    if (!renamed.length) for (const card of named) selected.add(card)
    else if (!named.length && renamed.length === 1) selected.add(renamed[0]!)
  }
  return [...selected].map(card => {
    const facts = [card.gender && `gender: ${card.gender}`, card.age && `age: ${card.age}`,
      card.appearance && `appearance: ${card.appearance}`, card.personality && `personality: ${card.personality}`,
      card.background && `background: ${card.background}`, card.abilities && `abilities: ${card.abilities}`,
      card.motivation && `motivation: ${card.motivation}`, card.arc && `arc: ${card.arc}`, card.notes && `notes: ${card.notes}`].filter(Boolean)
    for (const relationship of card.relationships ?? []) {
      const target = relationship.target?.trim(), relation = relationship.relation?.trim()
      if (target && relation) facts.push(`relationship: ${target} (${relation})`)
    }
    if (card.legacyRelationshipNotes?.trim()) facts.push(promptLanguageText(language,
      `relationship（legacy 来源未知）: ${card.legacyRelationshipNotes.trim()}`,
      `relationship (legacy provenance unknown): ${card.legacyRelationshipNotes.trim()}`))
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      const provenance = card.currentState?.provenance?.[field], value = card.currentState?.[field]?.trim()
      if (provenance?.kind === 'author' && value) facts.push(`${field}@chapter${provenance.chapterNumber}: ${value}`)
    }
    return `${card.name} (${card.role || 'unknown'})${facts.length ? ` | ${facts.join(' | ')}` : ''}`
  }).join('\n')
}

function finalizedMaterials(database: Database.Database, chapter: number, entities: readonly string[]): FinalizedMaterialSource[] {
  const selected = SummaryRepository.listFinalizedContinuityBefore(chapter, database).flatMap(projection => {
    const recent = projection.chapterNumber >= chapter - 5
    const facts = (projection.facts ?? []).filter(fact => recent || fact.entities.some(entity => entities.includes(entity))
      || entities.some(entity => fact.statement.includes(entity) || fact.evidence.includes(entity))).map(fact => fact.evidence).filter(Boolean)
    const candidates = (projection.characterStateCandidates ?? []).filter(item => recent || entities.includes(item.characterName))
      .map(item => item.value || item.characterName).filter(Boolean)
    const evidence = [...new Set([...facts, ...candidates])]
    return evidence.length ? [{ projection, evidence }] : []
  }).sort((a, b) => b.projection.chapterNumber - a.projection.chapterNumber).slice(0, 12)
  const sources: FinalizedMaterialSource[] = []
  const add = (draftId: number, number: number, title: string, evidence: string[], status?: FinalizedMaterialSource['sourceStatus']) => {
    const read = SummaryRepository.readFinalizedSource(draftId, database)
    const content = read.status === 'valid' ? read.snapshot.content : read.status === 'legacy' ? read.content : ''
    if (number === chapter - 1 && !content.trim()) return
    sources.push({ chapterNumber: number, draftId, title: read.status === 'valid' ? read.snapshot.chapterTitle : read.status === 'legacy' ? read.chapterTitle : title,
      content, evidence, includeEnding: number === chapter - 1,
      sourceStatus: read.status === 'invalid' ? 'invalid' : read.status === 'legacy' ? 'legacy' : status ?? 'current',
      ...(read.status === 'valid' ? { sourceIdentity: { kind: 'finalized' as const, finalizationId: read.snapshot.source.finalizationId, contentHash: read.snapshot.source.contentHash } }
        : read.status === 'legacy' ? { sourceIdentity: { kind: 'legacy-finalized' as const } } : {}) })
  }
  for (const { projection, evidence } of selected) {
    const id = projection.sourceStatus === 'stale' && projection.currentFinalizedDraftId ? projection.currentFinalizedDraftId : projection.draftId
    add(id, projection.chapterNumber, projection.chapterTitle, evidence, projection.sourceStatus)
  }
  if (!sources.some(source => source.includeEnding && source.sourceStatus !== 'invalid' && source.content.trim())) {
    const row = database.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC LIMIT 1").get(chapter - 1) as { id: number } | undefined
    if (row) add(row.id, chapter - 1, '', [])
  }
  return sources
}

function threadContext(database: Database.Database, chapter: ReturnType<typeof readWorkflowBatchChapter>['chapterInfo'], language: WritingLanguage): string {
  const threads = NarrativeThreadRepository.listRelevantActive({ chapterNumber: chapter.chapterNumber, title: chapter.title,
    keyEvents: chapter.keyEvents, characters: [...chapter.characters] }, database)
  const header = promptLanguageText(language, '【当前相关活跃叙事线索】', '[Relevant active narrative threads]')
  const lines: string[] = []
  let used = header.length + 1
  for (const thread of threads.slice(0, 6)) {
    const source = thread.events.at(-1)
    const line = promptLanguageText(language,
      `- ${thread.title} [${thread.status}]（目标第${thread.targetStartChapter}–${thread.targetEndChapter}章；作者意图：${thread.authorIntent}${source ? `；来源第${source.chapterNumber}章：${source.evidence}` : ''}）`,
      `- ${thread.title} [${thread.status}] (target Chapters ${thread.targetStartChapter}–${thread.targetEndChapter}; author intent: ${thread.authorIntent}${source ? `; source Chapter ${source.chapterNumber}: ${source.evidence}` : ''})`)
    const next = line.length + (lines.length ? 1 : 0)
    if (used + next > 1200) break
    lines.push(line); used += next
  }
  return lines.length ? `${header}\n${lines.join('\n')}` : ''
}

export function applyWorkflowBatchWritingSkill(task: GenerationTask, language: WritingLanguage, skill: { name: string; content: string } | null): GenerationTask {
  return injectWritingSkillPrompt(task, language, skill).task
}

export interface WorkflowBatchMaterialInput extends BatchSource {
  projectStorageRoot: string
  globalDataRoot: string
  knowledgeSnapshot: GenerationKnowledgeSnapshot
  predecessor?: { draftId: number; chapterNumber: number; version: number; contentHash: string }
  /** Rebuild and compare the owner's captured binding, including KB, after asynchronous hashing. */
  assertSourcesCurrent: () => void
}

type ObserveAsset = (root: string, relative: string, optional?: boolean) => Buffer | null
interface WorkflowAssetRoots { projectStorageRoot: string; globalDataRoot: string; writingLanguage: WritingLanguage }
function readWorkflowPromptAndSkill(input: WorkflowAssetRoots,
  key: 'first_chapter_draft' | 'next_chapter_draft' | 'consistency_check', stage: 'drafting' | 'review', observe: ObserveAsset) {
  const language = input.writingLanguage
  let template: PromptTemplate | undefined
  for (const root of [input.projectStorageRoot, input.globalDataRoot]) {
    for (const relative of [`prompts/${key}.${language}.json`, ...(language === 'zh-CN' ? [`prompts/${key}.json`] : [])]) {
      const bytes = observe(root, relative, true)
      if (!template && bytes) {
        const parsed = JSON.parse(bytes.toString('utf8')) as PromptTemplate
        if (parsed.key !== key || (parsed.writingLanguage ?? 'zh-CN') !== language) throw new Error('GENERATION_PROMPT_INVALID')
        template = parsed
      }
    }
    if (template) break
  }
  template ??= getBuiltinPromptTemplate(key, language)
  if (!template) throw new Error('GENERATION_BUILTIN_PROMPT_MISSING')
  const bindingsBytes = observe(input.projectStorageRoot, 'writing-skills.json', true)
  let bindings: { version?: unknown; bindings?: Record<string, unknown> } | null
  try {
    bindings = bindingsBytes ? JSON.parse(bindingsBytes.toString('utf8')) as { version?: unknown; bindings?: Record<string, unknown> } : { version: 1, bindings: {} }
  } catch {
    throw new Error('GENERATION_SKILL_BINDINGS_INVALID')
  }
  if (!bindings || bindings.version !== 1 || !bindings.bindings || typeof bindings.bindings !== 'object' || Array.isArray(bindings.bindings)) throw new Error('GENERATION_SKILL_BINDINGS_INVALID')
  const id = bindings.bindings[stage]
  let skill: { name: string; content: string } | null = null
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^(builtin|user|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('GENERATION_SKILL_ID_INVALID')
    const [scope, name] = id.split(':') as [string, string]
    if (name === '.' || name === '..') throw new Error('GENERATION_SKILL_ID_INVALID')
    const raw = scope === 'builtin' ? readBuiltinWritingSkill(name, language)
      : observe(scope === 'project' ? input.projectStorageRoot : input.globalDataRoot, `skills/${name}/SKILL.md`)!.toString('utf8')
    if (!raw) throw new Error('GENERATION_SKILL_MISSING')
    const bundle = scope === 'user' ? readInstalledWritingSkillBundle(relative => observe(input.globalDataRoot, `skills/${name}/${relative}`, true)) : { status: 'none' as const }
    if (bundle.status === 'damaged') throw new Error('GENERATION_SKILL_BUNDLE_DAMAGED')
    const inspected = inspectInstalledWritingSkill(raw, bundle, name)
    if (scope !== 'builtin' && !inspected.compatible || !['bilingual', language].includes(inspected.metadata.language)) throw new Error('GENERATION_SKILL_INCOMPATIBLE')
    const builtinMetadata = scope === 'builtin' ? getBuiltinWritingSkills().find(item => item.metadata.name === name)?.metadata : undefined
    skill = { name: builtinMetadata?.displayName ?? builtinMetadata?.name ?? inspected.metadata.displayName ?? inspected.metadata.name, content: inspected.content }
  }
  return { template, skill }
}

/** Captured main-only review assets, with the same priority and safety rules as drafting. */
export function readWorkflowReviewAssets(input: WorkflowAssetRoots & {
  assertResources(): void; assertSourcesCurrent(): void
}) {
  input.assertResources()
  const observed: Array<{ root: string; relative: string; bytes: Buffer | null }> = []
  const assets = readWorkflowPromptAndSkill(input, 'consistency_check', 'review', (root, relative, optional = false) => {
    const bytes = readGenerationSourceFile(root, relative, optional)
    observed.push({ root, relative, bytes }); return bytes
  })
  const assertUnchanged = () => {
    input.assertResources()
    for (const item of observed) if (!isDeepStrictEqual(item.bytes, readGenerationSourceFile(item.root, item.relative, true))) throw new Error('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT')
    const checked: unknown = input.assertSourcesCurrent()
    if (checked && typeof (checked as { then?: unknown }).then === 'function') throw new Error('GENERATION_SOURCE_GUARD_ASYNC')
    input.assertResources()
  }
  assertUnchanged()
  return { ...assets, assertUnchanged }
}

export async function prepareWorkflowBatchMaterials(input: WorkflowBatchMaterialInput) {
  const chapter = readWorkflowBatchChapter(input), { core, chapterInfo, novelConfig, targetUnits } = chapter
  const language = core.writingLanguage
  if (input.knowledgeSnapshot.query !== chapter.query) throw new Error('GENERATION_DRAFT_KNOWLEDGE_SNAPSHOT_REQUIRED')
  const observed: Array<{ root: string; relative: string; bytes: Buffer | null }> = []
  const observe = (root: string, relative: string, optional = false) => {
    const bytes = readGenerationSourceFile(root, relative, optional)
    observed.push({ root, relative, bytes }); return bytes
  }
  const guidanceNames = () => {
    const directory = path.join(input.projectStorageRoot, 'prompts')
    if (!fs.existsSync(directory)) return []
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('GENERATION_ASSET_UNSAFE')
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => !entry.isDirectory() && !entry.name.startsWith('.') && entry.name.endsWith('.md'))
      .map(entry => entry.name).sort((left, right) => left.localeCompare(right, 'zh-CN'))
  }
  const names = guidanceNames()
  const projectGuidance = names.flatMap(name => {
    const text = observe(input.projectStorageRoot, `prompts/${name}`)!.toString('utf8').trim()
    return text ? [promptLanguageText(language, `## 项目专属指导（${name.replace(/\.md$/, '')}）\n${text}`,
      `## Project-specific guidance (${name.replace(/\.md$/, '')})\n${text}`)] : []
  }).join('\n\n')
  const key = input.chapterNumber === 1 ? 'first_chapter_draft' : 'next_chapter_draft'
  const { template, skill } = readWorkflowPromptAndSkill({ ...input, writingLanguage: language }, key, 'drafting', observe)
  const facts = [core.coreOutline, core.worldSetting, core.goldenFinger, core.protagonistProfile].filter(value => Boolean(value.trim()))
  const duplicates = new Set(facts.flatMap(value => value.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(Boolean)))
  const architecture = [core.premise, core.worldbuilding, synopsisForDraftChapter(core.synopsis, input.chapterNumber)].map(value => value.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(part => part && !duplicates.has(part)).join('\n\n')).filter(Boolean).join('\n\n---\n\n')
  const future = chapter.blueprints.filter(item => item.chapterNumber > input.chapterNumber && item.chapterNumber <= input.chapterNumber + 5)
    .map(item => promptLanguageText(language, `第${item.chapterNumber}章 ${item.title}：${item.keyEvents}`, `Chapter ${item.chapterNumber}: ${item.title} — ${item.keyEvents}`)).join('\n')
    || promptLanguageText(language, '（无后续蓝图）', '(no future chapter blueprints)')
  const candidates: SelectedCandidateDraft[] = []
  if (input.predecessor) {
    const expected = input.predecessor
    const row = input.database.prepare('SELECT d.id,d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(expected.draftId) as { id: number; chapter_number: number; version: number; body: string } | undefined
    if (!row || expected.chapterNumber !== input.chapterNumber - 1 || row.chapter_number !== expected.chapterNumber || row.version !== expected.version || await hashAuthorText(row.body) !== expected.contentHash) throw new Error('GENERATION_BATCH_PREDECESSOR_CHANGED')
    input.assertResources()
    candidates.push({ chapterNumber: row.chapter_number, draftId: row.id, version: row.version, content: row.body, required: true })
  }
  const finalized = input.chapterNumber === 1 ? [] : finalizedMaterials(input.database, input.chapterNumber, chapterInfo.characters)
  if (input.chapterNumber > 1 && !candidates.length && !finalized.some(source => source.includeEnding && source.sourceStatus !== 'invalid' && source.content.trim())) throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_MISSING')
  const thread = input.chapterNumber === 1 ? '' : threadContext(input.database, chapterInfo, language)
  const references = input.knowledgeSnapshot.items.length ? input.knowledgeSnapshot.items.map((item, index) => ({ text: item.text,
    rendered: promptLanguageText(language, `[${index + 1}] (${item.fileName}, 相关度 ${(item.score * 100).toFixed(0)}%)\n${item.text}`,
      `[${index + 1}] (${item.fileName}, relevance ${(item.score * 100).toFixed(0)}%)\n${item.text}`), deduplicateAgainstFinalized: true }))
    : [{ text: promptLanguageText(language, '（知识库中无相关内容）', '(no relevant knowledge-base context)'), rendered: promptLanguageText(language, '（知识库中无相关内容）', '(no relevant knowledge-base context)') }]
  const materials = await assembleChapterMaterials({ identity: { projectId: input.projectId, epoch: input.epoch }, writingLanguage: language,
    budgetChars: 8000, authorProjectFacts: facts, characterProfiles: profiles(input.database, language, chapterInfo.characters), futurePlans: future,
    references: [...(thread ? [{ text: thread, rendered: thread }] : []), ...references], finalized, candidates,
    relevanceTerms: [chapterInfo.title, chapterInfo.keyEvents, ...chapterInfo.characters] })
  if (input.chapterNumber > 1 && !materials.selection.included.some(item => item.ref.sourceId === (candidates.length ? `candidate:${candidates[0]!.draftId}` : `finalized:${finalized.find(source => source.includeEnding && source.sourceStatus !== 'invalid' && source.content.trim())!.draftId}`))) throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED')
  const promptOnly = new Set(['globalGuidance', 'writingStyle', 'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile'])
  const configFacts = Object.fromEntries(Object.entries(novelConfig).filter(([key]) => !promptOnly.has(key)))
  const globalGuidance = [novelConfig.globalGuidance.trim(), projectGuidance].filter(Boolean).join('\n\n')
  const novelConfigFacts = JSON.stringify(configFacts, null, 2)
  const writingStyle = novelConfig.writingStyle.trim()
  const promptMaterial: DraftPromptMaterial = { chapterInfo, globalGuidance, writingStyle, novelConfigFacts, chapterMaterials: materials.text }
  const builder = new ChapterPromptBuilder(template, language).withArchitecture(architecture)
    .withGlobalGuidance(globalGuidance)
    .withWritingStyle(writingStyle).withNovelConfig(novelConfigFacts).withWordNumber(targetUnits)
    .withChapterInfo(chapterInfo).withCharacterStates('').withFutureBlueprints('').withFilteredContext('')
    .withUserGuidance(chapterInfo.userGuidance?.trim() || promptLanguageText(language, '（无微操指导）', '(no author guidance)'))
  if (input.chapterNumber > 1) builder.withGlobalSummary('').withPreviousEnding('').withShortSummary('')
  const contract = chapterExecutionContractText(language, chapterInfo)
  const systemRole = `${builder.getSystemRole()}\n\n${contract.rules}`
  const prompt = [materials.text, builder.build(), contract.authorItems, chapterLengthContractText(language, targetUnits)].filter(Boolean).join('\n\n')
  const outline = applyWorkflowBatchWritingSkill(draftShortOutlineTask(language, draftShortOutlinePrompt(language, prompt)), language, skill)
  const draft = applyWorkflowBatchWritingSkill({ purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting',
    budgetDemand: { kind: 'draft-units', writingLanguage: language, requestedUnits: targetUnits, segmentable: false },
    messages: [{ role: 'system', content: systemRole }, { role: 'user', content: prompt }] }, language, skill)
  const materialDecision = { ...materials.decision, promptHash: await hashAuthorText(draft.messages.find(message => message.role === 'user')!.content),
    shortOutlinePromptHash: await hashAuthorText(outline.messages.find(message => message.role === 'user')!.content) }
  input.assertResources()
  for (const item of observed) if (!isDeepStrictEqual(item.bytes, readGenerationSourceFile(item.root, item.relative, true))) throw new Error('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT')
  if (!isDeepStrictEqual(names, guidanceNames())) throw new Error('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT')
  const sourceCheck: unknown = input.assertSourcesCurrent()
  if (sourceCheck && typeof (sourceCheck as { then?: unknown }).then === 'function') throw new Error('GENERATION_SOURCE_GUARD_ASYNC')
  input.assertResources()
  return { chapterInfo, authorInputs: chapter.authorInputs, query: chapter.query, materialDecision, outlineTask: outline, baseDraftTask: draft,
    previousEnding: materials.previousEnding, promptMaterial, systemPrompt: systemRole, writingLanguage: language, targetUnits, writingSkill: skill }
}
