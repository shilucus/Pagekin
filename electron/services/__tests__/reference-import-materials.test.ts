import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { buildImportBlueprintTask } from '../../../src/shared/import-blueprint-materials'
import { buildImportInferenceTask, formatImportInferenceSample, getImportInferenceTopics } from '../../../src/shared/import-inference-materials'
import { buildImportStyleMaterial, collectImportStyleSamples } from '../../../src/shared/import-style-materials'
import type { ImportGenerationContext } from '../../../src/shared/import-generation'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import type { WritingLanguage } from '../../../src/shared/writing-language'
import { getProjectDb } from '../../database'
import * as knowledge from '../../knowledge-base'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import * as store from '../../vector-store'
import { captureImportGenerationContext } from '../import-generation-source'
import { projectRuntimeHost } from '../project-runtime'
import { prepareReferenceImportMaterials, type ReferenceImportMaterialInput } from '../reference-import-materials'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const RUN = 'fictional-material-run'
let tempBase = ''
let parent = ''

function book(name: string, language: WritingLanguage = 'en-US', blank = false) {
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  runtime.database.prepare("INSERT INTO project_core(id,project_name,writing_language,words_per_chapter) VALUES('main',?,?,100)").run(`Fictional ${name}`, language)
  const chapters = Array.from({ length: 6 }, (_, index) => {
    const content = blank ? ' \n ' : `Fictional ${name} chapter ${index + 1}: world rules power protagonist conflict enemy viewpoint narration style.`
    return { number: index + 1, title: `Part ${index + 1}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
  })
  ImportRunRepository.prepare({ runId: RUN, purpose: 'reference', sourceFingerprint: hash(`source:${name}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'Fictional.txt', mediaType: 'text/plain', size: chapters.reduce((total, chapter) => total + chapter.contentSize, 0) }], chapters })
  const execution = ImportRunRepository.startOrResume(RUN, 'fictional-material-owner', Date.now(), 120_000).execution
  return { root, runtime, chapters, execution }
}
type Book = ReturnType<typeof book>

function materialInput(value: Book, stage: ImportGenerationContext['slot']['stage']): ReferenceImportMaterialInput {
  // This fixture isolates material preparation; it does not claim a completed import workflow.
  value.runtime.database.prepare('UPDATE import_runs SET stage=? WHERE id=?').run(stage, RUN)
  const slot = { runId: RUN, stage, batchId: stage === 'blueprints' ? createImportRunChapterBatchCheckpointId(value.chapters) : 'done' }
  const context = captureImportGenerationContext(value.runtime.database, slot)
  for (const key of ['infer_novel_config_with_vectors', 'infer_novel_config', 'analyze_writing_style', 'infer_single_chapter_blueprint']) {
    const template = getBuiltinPromptTemplate(key, context.core.writingLanguage)
    if (!template) throw new Error('FICTIONAL_PROMPT_REQUIRED')
    context.prompts[key] = template
  }
  return { runtime: value.runtime, context, execution: value.execution, configuration: null, assertActive: vi.fn() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function holdFirstCapture() {
  const original = knowledge.captureReferenceImportKnowledgeSnapshot
  const started = deferred<void>(), resume = deferred<void>()
  const capture = vi.spyOn(knowledge, 'captureReferenceImportKnowledgeSnapshot').mockImplementationOnce(async input => {
    started.resolve()
    await resume.promise
    return original(input)
  })
  return { started: started.promise, resume: () => resume.resolve(), capture }
}

function verifiedCleanupRoot(): string {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  }
  const root = path.resolve(parent)
  assertChild(tempBase, root)
  if (!path.basename(root).startsWith('pk-im-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  for (let directory = root; ; directory = path.dirname(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()
      || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) throw new Error('FICTIONAL_CLEANUP_LINK')
    if (normalized(directory) === normalized(tempBase)) break
  }
  const realRoot = fs.realpathSync.native(root)
  assertChild(fs.realpathSync.native(tempBase), realRoot)
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), realTarget = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) throw new Error('FICTIONAL_CLEANUP_LINK')
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return root
}

beforeEach(() => {
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-im-'))
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('FICTIONAL_MATERIAL_NETWORK_FORBIDDEN') }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    store.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('captured reference import stage materials', () => {
  it.each(['zh-CN', 'en-US'] as const)('prepares original global task and four original-hit proofs in %s with B current', async language => {
    const a = book('a', language)
    const chapter = a.chapters[0]!
    const authority = ImportRunRepository.resolveReferenceImportAuthority(RUN, a.execution, chapter.number)
    const imported = await knowledge.importReferenceText(chapter.content, 'Fictional.txt', authority.stableKey, chapter.number, RUN,
      a.execution, a.root, 'openai', { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' },
      knowledge.captureReferenceImportResources(a.runtime))
    expect(imported.success).toBe(true)
    const input = materialInput(a, 'global'), b = book('b', language)
    const beforeB = hash(b.runtime.database.serialize())
    const capture = vi.spyOn(knowledge, 'captureReferenceImportKnowledgeSnapshot')
    const result = await prepareReferenceImportMaterials(input)
    const topics = getImportInferenceTopics(language)
    expect(capture.mock.calls.map(([request]) => [request.query, request.topK])).toEqual(topics.map(topic => [topic.query, 5]))
    expect(result.knowledge).toHaveLength(4)
    for (const snapshot of result.knowledge) {
      expect(snapshot.runtimeEpoch).toBe(a.runtime.executionEpoch)
      for (const item of snapshot.items) expect(item.corpusKind).toBe('reference')
    }
    if (language === 'en-US') expect(result.knowledge.every(snapshot => snapshot.results.some(hit => hit.text.includes('Fictional a')))).toBe(true)
    const sampledContent = Object.fromEntries(topics.map((topic, index) => [topic.key, formatImportInferenceSample(result.knowledge[index]!.results, language)]))
    expect(result.task).toEqual(buildImportInferenceTask({ template: input.context.prompts.infer_novel_config_with_vectors!, writingLanguage: language,
      chapters: input.context.chapters, totalChapters: 6, sampledContent }))
    expect(result.state).toBe('ready')
    await result.verifySources()
    expect(capture).toHaveBeenCalledTimes(4)
    expect(hash(b.runtime.database.serialize())).toBe(beforeB)
    expect(getProjectDb()).toBe(b.runtime.database)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en-US'] as const)('prepares captured style and blueprint sub-batches in %s without renderer data', async language => {
    const a = book('a', language), styleInput = materialInput(a, 'style'), b = book('b', language)
    const beforeB = hash(b.runtime.database.serialize())
    const style = await prepareReferenceImportMaterials(styleInput)
    expect(style.task).toEqual(buildImportStyleMaterial(styleInput.context.prompts.analyze_writing_style!,
      collectImportStyleSamples({ chapters: styleInput.context.chapters }, language), language).task)
    expect(style.knowledge).toEqual([])
    await style.verifySources()
    const input = materialInput(a, 'blueprints')
    input.blueprintBatch = { chapterNumbers: [2, 3], validatedPrefix: [{ chapterNumber: 1, title: 'Verified', keyEvents: 'The courier arrived.' }] }
    const blueprints = await prepareReferenceImportMaterials(input)
    expect(blueprints.task).toEqual(buildImportBlueprintTask({ template: input.context.prompts.infer_single_chapter_blueprint!, writingLanguage: language,
      items: input.context.chapters.filter(chapter => [2, 3].includes(chapter.number)), validatedPrefix: input.blueprintBatch.validatedPrefix,
      configSummary: JSON.stringify(input.context.core) }))
    await blueprints.verifySources()
    expect(hash(b.runtime.database.serialize())).toBe(beforeB)
    expect(getProjectDb()).toBe(b.runtime.database)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not call empty imported style material a successful stage or invent a finalized fallback source', async () => {
    const a = book('a', 'en-US', true)
    const result = await prepareReferenceImportMaterials(materialInput(a, 'style'))
    expect(result).toMatchObject({ state: 'style-finalized-samples-required', task: null, knowledge: [] })
    expect(a.runtime.database.prepare('SELECT stage FROM import_runs WHERE id=?').pluck().get(RUN)).toBe('style')
  })

  it.each([[1, 3], [0], [7], [1, 2, 3, 4, 5, 6], [2, 2]].map(chapterNumbers => ({ chapterNumbers })))('rejects a blueprint batch outside the frozen contiguous five-item contract: $chapterNumbers', async ({ chapterNumbers }) => {
    const input = materialInput(book('a'), 'blueprints')
    input.blueprintBatch = { chapterNumbers, validatedPrefix: [] }
    await expect(prepareReferenceImportMaterials(input)).rejects.toThrow('GENERATION_IMPORT_BLUEPRINT_BATCH_INVALID')
  })

  it('refuses foreign frozen context despite colliding run IDs and execution owners', async () => {
    const a = book('a'), input = materialInput(a, 'style'), b = book('b')
    input.context = materialInput(b, 'style').context
    await expect(prepareReferenceImportMaterials(input)).rejects.toThrow('GENERATION_IMPORT_CONTEXT_CHANGED')
  })

  it.each(['core', 'content', 'cancel', 'lease', 'stage', 'grant'] as const)('rechecks %s changes after the original asynchronous search, without an unavailable fallback', async changed => {
    const a = book('a'), input = materialInput(a, 'global'), pending = holdFirstCapture()
    let active = true
    input.assertActive = () => { if (!active) throw new Error('FICTIONAL_GRANT_REVOKED') }
    const result = prepareReferenceImportMaterials(input)
    await pending.started
    if (changed === 'core') a.runtime.database.exec("UPDATE project_core SET genre='Changed'")
    if (changed === 'content') a.runtime.database.exec("UPDATE import_run_chapters SET content_snapshot='Changed' WHERE chapter_number=1")
    if (changed === 'cancel') ImportRunRepository.requestCancel(RUN, a.execution, a.runtime)
    if (changed === 'lease') a.runtime.database.exec("UPDATE import_runs SET execution_owner='another-owner',execution_epoch=execution_epoch+1")
    if (changed === 'stage') a.runtime.database.exec("UPDATE import_runs SET stage='style'")
    if (changed === 'grant') active = false
    pending.resume()
    const code = { core: 'GENERATION_IMPORT_CONTEXT_CHANGED', content: 'GENERATION_IMPORT_CONTENT_CHANGED', cancel: 'GENERATION_ACTION_CANCELLED',
      lease: 'IMPORT_RUN_EXECUTION_STALE', stage: 'GENERATION_IMPORT_EXECUTION_STALE', grant: 'FICTIONAL_GRANT_REVOKED' }[changed]
    await expect(result).rejects.toThrow(code)
    expect(pending.capture).toHaveBeenCalledTimes(1)
  })

  it('freezes runtime/context/lease inputs before awaits and retains private proofs rather than caller-mutated proof copies', async () => {
    const a = book('a'), input = materialInput(a, 'global'), pending = holdFirstCapture()
    const resultPromise = prepareReferenceImportMaterials(input)
    await pending.started
    const b = book('b')
    input.runtime = b.runtime
    input.context.chapters[0]!.content = 'Caller changed its copy'
    input.execution = { owner: 'foreign-owner', epoch: 999 }
    pending.resume()
    const result = await resultPromise
    expect(result.task?.messages[1]?.content).toContain('Fictional a')
    result.knowledge[0]!.query = 'Caller changed its proof copy'
    await expect(result.verifySources()).resolves.toBeUndefined()
    expect(getProjectDb()).toBe(b.runtime.database)
  })

  it('revalidates current context and grant on later verification, not only preparation', async () => {
    const a = book('a'), input = materialInput(a, 'style')
    let active = true
    input.assertActive = () => { if (!active) throw new Error('FICTIONAL_GRANT_REVOKED') }
    const result = await prepareReferenceImportMaterials(input)
    active = false
    await expect(result.verifySources()).rejects.toThrow('FICTIONAL_GRANT_REVOKED')
    active = true
    a.runtime.database.exec("UPDATE project_core SET genre='Changed'")
    await expect(result.verifySources()).rejects.toThrow('GENERATION_IMPORT_CONTEXT_CHANGED')
  })

  it('rejects an asynchronous guard instead of treating its unresolved result as permission', async () => {
    const input = materialInput(book('a'), 'style')
    input.assertActive = () => Promise.resolve()
    await expect(prepareReferenceImportMaterials(input)).rejects.toThrow('GENERATION_SOURCE_GUARD_ASYNC')
  })

  it('holds captured work over the actual asynchronous preparation and lets close drain after failure', async () => {
    const a = book('a'), input = materialInput(a, 'global'), pending = holdFirstCapture()
    const result = prepareReferenceImportMaterials(input)
    await pending.started
    const close = projectRuntimeHost.requestClose(a.runtime, { timeoutMs: 5_000 })
    expect(a.runtime.database.open).toBe(true)
    pending.resume()
    await expect(result).rejects.toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    await close
    expect(a.runtime.database.open).toBe(false)
  })
})
