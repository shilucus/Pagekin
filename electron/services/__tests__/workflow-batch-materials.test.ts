import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectDb } from '../../database'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { MATERIAL_DECISION_MAX_INPUT_UNITS } from '../../../src/shared/generation-owner-contract'
import type { GenerationKnowledgeSnapshot } from '../../../src/shared/generation-knowledge'
import { prepareWorkflowBatchMaterials, readWorkflowBatchChapter, type WorkflowBatchMaterialInput } from '../workflow-batch-materials'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture() {
  const base = path.resolve('.runtime/.cache/wbm')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'case-'))
  const projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global')
  fs.mkdirSync(projectStorageRoot); fs.mkdirSync(globalDataRoot)
  const database = new Database(':memory:')
  initializeLegacyBaselineSchema(database)
  migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  database.exec(`INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','Synthetic','Keep author facts');
    INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'First','Open the door'),(2,'Second','Find the key');`)
  const emptyKnowledge = (query: string): GenerationKnowledgeSnapshot => ({ version: 1, state: 'empty', storageState: 'absent',
    query, topK: 5, canonicalRevision: null, documentsRevision: null, items: [] })
  const source = { database, projectId: 'synthetic-project', epoch: 'epoch-a', chapterNumber: 1, targetUnits: 1000,
    assertResources: vi.fn(), projectStorageRoot, globalDataRoot, assertSourcesCurrent: vi.fn() }
  const input = (chapterNumber = 1): WorkflowBatchMaterialInput => {
    const current = { ...source, chapterNumber }
    return { ...current, knowledgeSnapshot: emptyKnowledge(readWorkflowBatchChapter(current).query) }
  }
  cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { database, projectStorageRoot, globalDataRoot, input, source }
}

describe('main workflow batch material assembly', () => {
  it('uses project, then global, then builtin prompt with exact selected template body', async () => {
    const f = fixture(), builtin = getBuiltinPromptTemplate('first_chapter_draft', 'zh-CN')!
    const folder = (root: string) => { const target = path.join(root, 'prompts'); fs.mkdirSync(target, { recursive: true }); return target }
    const global = path.join(folder(f.globalDataRoot), 'first_chapter_draft.zh-CN.json')
    const project = path.join(folder(f.projectStorageRoot), 'first_chapter_draft.zh-CN.json')
    fs.writeFileSync(global, JSON.stringify({ ...builtin, content: 'GLOBAL {{chapter_info}}' }))
    fs.writeFileSync(project, JSON.stringify({ ...builtin, content: 'PROJECT {{chapter_info}}' }))
    const projectResult = await prepareWorkflowBatchMaterials(f.input())
    expect(projectResult.baseDraftTask.messages[1]!.content).toContain(`PROJECT ${JSON.stringify(projectResult.chapterInfo, null, 2)}`)
    expect(projectResult.baseDraftTask.messages[1]!.content).not.toContain('GLOBAL ')
    fs.unlinkSync(project)
    const globalResult = await prepareWorkflowBatchMaterials(f.input())
    expect(globalResult.baseDraftTask.messages[1]!.content).toContain(`GLOBAL ${JSON.stringify(globalResult.chapterInfo, null, 2)}`)
    fs.unlinkSync(global)
    const builtinResult = await prepareWorkflowBatchMaterials(f.input())
    expect(builtinResult.baseDraftTask.messages[1]!.content).not.toContain('GLOBAL ')
    expect(builtinResult.baseDraftTask.messages[1]!.content).not.toContain('PROJECT ')
    expect(builtinResult.materialDecision.promptHash).toBe(createHash('sha256').update(builtinResult.baseDraftTask.messages[1]!.content).digest('hex'))
    expect(f.source.assertSourcesCurrent).toHaveBeenCalledTimes(3)
  })

  it('requires an adjacent predecessor matching the captured database version and exact body', async () => {
    const f = fixture(), body = 'Synthetic preceding prose.'
    f.database.prepare('INSERT INTO contents(id,body) VALUES(9001,?)').run(body)
    f.database.exec("INSERT INTO drafts_all(id,chapter_number,version,status,source,content_id,word_count) VALUES(9001,1,1,'draft','write',9001,3)")
    const predecessor = { draftId: 9001, chapterNumber: 1, version: 1, contentHash: createHash('sha256').update(body).digest('hex') }
    const result = await prepareWorkflowBatchMaterials({ ...f.input(2), predecessor })
    expect(result.materialDecision.included).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'candidate:9001', required: true })]))
    expect(result.baseDraftTask.messages[1]!.content).toContain(body)
    await expect(prepareWorkflowBatchMaterials({ ...f.input(2), predecessor: { ...predecessor, version: 2 } })).rejects.toThrow('GENERATION_BATCH_PREDECESSOR_CHANGED')
    await expect(prepareWorkflowBatchMaterials({ ...f.input(2), predecessor: { ...predecessor, chapterNumber: 2 } })).rejects.toThrow('GENERATION_BATCH_PREDECESSOR_CHANGED')
    f.database.prepare('UPDATE contents SET body=? WHERE id=9001').run('Changed')
    await expect(prepareWorkflowBatchMaterials({ ...f.input(2), predecessor })).rejects.toThrow('GENERATION_BATCH_PREDECESSOR_CHANGED')
  })

  it('uses visible project guidance in the filesystem UI order without reading hidden files', async () => {
    const f = fixture(), directory = path.join(f.projectStorageRoot, 'prompts')
    fs.mkdirSync(directory)
    const names = ['中.md', 'Z.md', 'A.md', '阿.md']
    for (const name of names) fs.writeFileSync(path.join(directory, name), `guidance-${name}`)
    const hidden = path.join(directory, '.private.md')
    fs.writeFileSync(hidden, 'DO NOT READ THIS')
    const read = vi.spyOn(fs, 'readFileSync')
    try {
      const result = await prepareWorkflowBatchMaterials(f.input())
      const guidance = result.promptMaterial.globalGuidance
      const expected = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
        .map(name => `## 项目专属指导（${name.replace(/\.md$/, '')}）\nguidance-${name}`).join('\n\n')
      expect(guidance).toBe(`Keep author facts\n\n${expected}`)
      expect(result.baseDraftTask.messages[1]!.content).not.toContain('DO NOT READ THIS')
      expect(read.mock.calls.some(([file]) => String(file) === hidden)).toBe(false)
    } finally {
      read.mockRestore()
    }
  })

  it('rejects stale KB query and resource or source invalidation', async () => {
    const f = fixture(), input = f.input()
    await expect(prepareWorkflowBatchMaterials({ ...input, knowledgeSnapshot: { ...input.knowledgeSnapshot, query: 'other chapter' } }))
      .rejects.toThrow('GENERATION_DRAFT_KNOWLEDGE_SNAPSHOT_REQUIRED')
    await expect(prepareWorkflowBatchMaterials({ ...input, assertSourcesCurrent: () => { throw new Error('GENERATION_SOURCE_CHANGED') } }))
      .rejects.toThrow('GENERATION_SOURCE_CHANGED')
    await expect(prepareWorkflowBatchMaterials({ ...input, assertSourcesCurrent: () => Promise.resolve() }))
      .rejects.toThrow('GENERATION_SOURCE_GUARD_ASYNC')
    await expect(prepareWorkflowBatchMaterials({ ...input, assertResources: () => { throw new Error('GENERATION_OWNER_CLOSED') } }))
      .rejects.toThrow('GENERATION_OWNER_CLOSED')
  })

  it('does not consult the active project database after a view switch', async () => {
    const f = fixture(), other = new Database(f.database.serialize())
    try {
      other.exec("UPDATE project_core SET global_guidance='B ONLY' WHERE id='main'; UPDATE blueprints SET title='B CHAPTER' WHERE chapter_number=1")
      vi.mocked(getProjectDb).mockReturnValue(other)
      const result = await prepareWorkflowBatchMaterials(f.input())
      expect(result.chapterInfo.title).toBe('First')
      expect(result.promptMaterial.globalGuidance).toBe('Keep author facts')
      expect(result.baseDraftTask.messages[1]!.content).not.toContain('B ONLY')
    } finally {
      vi.mocked(getProjectDb).mockReset()
      other.close()
    }
  })

  it('detects actual source and guidance mutations while asynchronous hashing is suspended', async () => {
    for (const kind of ['source', 'file', 'collection'] as const) {
      const f = fixture(), directory = path.join(f.projectStorageRoot, 'prompts')
      fs.mkdirSync(directory)
      const guidance = path.join(directory, 'A.md')
      fs.writeFileSync(guidance, 'original guidance')
      const input = f.input()
      const originalCore = f.database.prepare("SELECT global_guidance FROM project_core WHERE id='main'").get()
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { entered = resolve })
      const digest = crypto.subtle.digest.bind(crypto.subtle)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        entered(); await gate; return digest(algorithm, data)
      })
      try {
        const work = prepareWorkflowBatchMaterials({ ...input, assertSourcesCurrent: () => {
          const current = f.database.prepare("SELECT global_guidance FROM project_core WHERE id='main'").get()
          if (JSON.stringify(current) !== JSON.stringify(originalCore)) throw new Error('GENERATION_SOURCE_CHANGED')
        } })
        await started
        if (kind === 'source') f.database.exec("UPDATE project_core SET global_guidance='changed' WHERE id='main'")
        else if (kind === 'file') fs.writeFileSync(guidance, 'changed guidance')
        else fs.writeFileSync(path.join(directory, 'B.md'), 'new guidance')
        release()
        await expect(work).rejects.toThrow(kind === 'source' ? 'GENERATION_SOURCE_CHANGED' : 'GENERATION_ASSET_CHANGED_DURING_SNAPSHOT')
      } finally {
        release()
        spy.mockRestore()
      }
    }
  })

  it('reports malformed skill bindings using the source admission error code', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.projectStorageRoot, 'writing-skills.json'), '{bad json')
    await expect(prepareWorkflowBatchMaterials(f.input())).rejects.toThrow('GENERATION_SKILL_BINDINGS_INVALID')
  })

  it('uses the renderer registry display name and body for a bound builtin writing skill', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.projectStorageRoot, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { drafting: 'builtin:long-form-continuity' } }))
    const result = await prepareWorkflowBatchMaterials(f.input())
    expect(result.writingSkill).toEqual({ name: '长篇连续性与场景推进', content: '以作者已经确认的事实为最高依据。持续核对因果链、角色状态和未回收的叙事线索。每个场景围绕角色的主动选择、选择的代价，以及故事状态发生的具体变化展开。' })
    expect(result.baseDraftTask.messages[1]!.content).toContain('【补充写作 Skill：长篇连续性与场景推进】')
    expect(result.outlineTask.messages[0]!.content).toContain('【补充写作 Skill：长篇连续性与场景推进】')
  })

  it('keeps English KB references and author material in their original language and enforces required capacity', async () => {
    const f = fixture()
    f.database.exec("UPDATE project_core SET writing_language='en-US', core_outline='Author fact' WHERE id='main'")
    const input = f.input()
    const result = await prepareWorkflowBatchMaterials(input)
    expect(result.writingLanguage).toBe('en-US')
    expect(result.promptMaterial.chapterMaterials).toContain('Author fact')
    expect(result.promptMaterial.chapterMaterials).toContain('(no relevant knowledge-base context)')
    expect(result.promptMaterial.chapterMaterials).toContain('Chapter 2: Second')
    f.database.prepare("UPDATE project_core SET core_outline=? WHERE id='main'").run('a'.repeat(MATERIAL_DECISION_MAX_INPUT_UNITS + 1))
    await expect(prepareWorkflowBatchMaterials(f.input())).rejects.toMatchObject({
      name: 'ChapterMaterialCapacityError',
      code: 'CHAPTER_MATERIAL_CAPACITY_CONFLICT',
      decision: { decision: 'capacity-conflict', blockingSourceId: 'author:required', blockingReason: 'budget' },
    })
  })
})
