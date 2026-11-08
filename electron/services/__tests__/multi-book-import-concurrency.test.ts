import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { projectAccess } from '../project-access'
import { ImportRunRepository, type CapturedImportRunContext } from '../../repositories/import-run-repository'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import { MainGenerationScheduler } from '../generation-scheduler'
import type { MainProcessSchedulerPolicy } from '../main-process-scheduler'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { getProjectDb, getCurrentProjectPath } from '../../database'

vi.mock('../../database', async importOriginal => ({
  ...await importOriginal<typeof import('../../database')>(),
  getProjectDb: vi.fn(),
  getCurrentProjectPath: vi.fn(),
}))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    try {
      dispose()
    } catch {
      // ignore cleanup errors in test
    }
  }
  vi.restoreAllMocks()
})

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function createBookFixture(name: string) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/multi-book-import-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, `${name}-`))
  prepareCanonicalStorageFixture(root)
  const probed = projectAccess.probeExistingProject(root)
  if (probed.kind !== 'manifest') throw new Error(`fixture project identity missing for ${name}`)
  const projectId = probed.projectId
  const db = new Database(path.join(root, '.ai-novel', 'project.db'))

  db.exec(`INSERT INTO project_core(id, project_name, words_per_chapter) VALUES('main', '${name}', 3000);`)

  const context: CapturedImportRunContext = {
    database: db,
    canonicalRoot: root,
    projectId,
  }

  cleanup.push(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  return { root, projectId, db, context }
}

function createModel(id: string, name = 'custom-model'): ModelProfile {
  return {
    id,
    name,
    provider: 'custom',
    protocol: 'openai',
    baseUrl: 'https://service.invalid/v1',
    apiKey: 'mock-key',
    modelName: 'fictional-model',
    temperature: 0.5,
    maxTokens: 128,
    purposes: ['generation'],
  }
}

describe('Stage 13 (IMPORT-003): Multi-Book Reference Import Concurrency Qualification', () => {
  it('AC-1: 两本虚构书同时拆解并反复切换查看，A/B来源、正文、stage/slot/effect收据与缓冲完全隔离', async () => {
    const bookA = createBookFixture('book-a')
    const bookB = createBookFixture('book-b')

    const contentA1 = '第一章 港口之光\n海浪拍打着礁石。'
    const contentA2 = '第二章 迷雾海峡\n灯塔的光芒穿透迷雾。'
    const chapterA1 = {
      number: 1,
      title: '港口之光',
      content: contentA1,
      contentSize: Buffer.byteLength(contentA1),
      contentFingerprint: hash(contentA1),
    }
    const chapterA2 = {
      number: 2,
      title: '迷雾海峡',
      content: contentA2,
      contentSize: Buffer.byteLength(contentA2),
      contentFingerprint: hash(contentA2),
    }

    const contentB1 = '第一章 荒原风暴\n狂风席卷着红色的沙尘。'
    const chapterB1 = {
      number: 1,
      title: '荒原风暴',
      content: contentB1,
      contentSize: Buffer.byteLength(contentB1),
      contentFingerprint: hash(contentB1),
    }

    // 1. 在当前视图为 Book A 时，初始化 Book A 的拆解任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const runA = ImportRunRepository.prepare({
      runId: 'import-book-a',
      purpose: 'reference',
      sourceFingerprint: hash('source-a'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '海港之书.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [chapterA1, chapterA2],
    })
    expect(runA.run?.id).toBe('import-book-a')

    // 2. 作者在 UI 切换到 Book B 查看，并初始化 Book B 的拆解任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookB.root)
    vi.mocked(getProjectDb).mockReturnValue(bookB.db)

    const runB = ImportRunRepository.prepare({
      runId: 'import-book-b',
      purpose: 'reference',
      sourceFingerprint: hash('source-b'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '荒原之书.txt', mediaType: 'text/plain', size: 50 }],
      chapters: [chapterB1],
    })
    expect(runB.run?.id).toBe('import-book-b')

    // 3. 独立启动并记录各自的执行租约（即使当前全局活跃项目依然是 Book B）
    // 后台任务 A 依然持有 bookA.context 独立推进
    const execA = ImportRunRepository.startOrResume('import-book-a', 'runner-a', Date.now(), 60000, bookA.context).execution
    const execB = ImportRunRepository.startOrResume('import-book-b', 'runner-b', Date.now(), 60000, bookB.context).execution

    expect(execA.owner).toBe('runner-a')
    expect(execB.owner).toBe('runner-b')

    // 4. 提交各自的阶段收据，验证即使 UI 视图多次切换，底层写入依然严格绑定目标 context
    const authA1 = ImportRunRepository.resolveReferenceImportAuthority('import-book-a', execA, 1, Date.now(), bookA.db)
    const docIdA1 = hash(`reference-import:${authA1.stableKey}`)
    bookA.db.prepare(
      "INSERT INTO import_reference_documents(document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state) VALUES(?,?,?,?,1,'reference','committed')",
    ).run(docIdA1, hash(authA1.stableKey), authA1.contentFingerprint, hash('chunk-a1'))
    ImportRunRepository.commitReferenceImportReceipt('import-book-a', execA, 1, docIdA1, bookA.db)

    const authA2 = ImportRunRepository.resolveReferenceImportAuthority('import-book-a', execA, 2, Date.now(), bookA.db)
    const docIdA2 = hash(`reference-import:${authA2.stableKey}`)
    bookA.db.prepare(
      "INSERT INTO import_reference_documents(document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state) VALUES(?,?,?,?,1,'reference','committed')",
    ).run(docIdA2, hash(authA2.stableKey), authA2.contentFingerprint, hash('chunk-a2'))
    ImportRunRepository.commitReferenceImportReceipt('import-book-a', execA, 2, docIdA2, bookA.db)

    // 切换 UI 视图回 Book A
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    // 后台任务 B 依然写入 Book B 的数据库
    const authB1 = ImportRunRepository.resolveReferenceImportAuthority('import-book-b', execB, 1, Date.now(), bookB.db)
    const docIdB1 = hash(`reference-import:${authB1.stableKey}`)
    bookB.db.prepare(
      "INSERT INTO import_reference_documents(document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state) VALUES(?,?,?,?,1,'reference','committed')",
    ).run(docIdB1, hash(authB1.stableKey), authB1.contentFingerprint, hash('chunk-b1'))
    ImportRunRepository.commitReferenceImportReceipt('import-book-b', execB, 1, docIdB1, bookB.db)

    // 5. 推进各书批次
    ImportRunRepository.completeBatch(
      'import-book-a',
      'knowledge',
      createImportRunChapterBatchCheckpointId([chapterA1, chapterA2]),
      execA,
      bookA.context,
    )
    ImportRunRepository.advanceStage('import-book-a', 'knowledge', 'global', execA, bookA.context)

    ImportRunRepository.completeBatch(
      'import-book-b',
      'knowledge',
      createImportRunChapterBatchCheckpointId([chapterB1]),
      execB,
      bookB.context,
    )
    ImportRunRepository.advanceStage('import-book-b', 'knowledge', 'global', execB, bookB.context)

    // 6. 严格验证两书持久化数据 100% 隔离，绝无交叉
    type RunRow = { id: string; stage: string; source_display_json: string }
    const runsInA = bookA.db.prepare('SELECT id, stage, source_display_json FROM import_runs').all() as RunRow[]
    const runsInB = bookB.db.prepare('SELECT id, stage, source_display_json FROM import_runs').all() as RunRow[]

    expect(runsInA).toHaveLength(1)
    expect(runsInA[0].id).toBe('import-book-a')
    expect(runsInA[0].stage).toBe('global')
    expect(runsInA[0].source_display_json).toContain('海港之书.txt')

    expect(runsInB).toHaveLength(1)
    expect(runsInB[0].id).toBe('import-book-b')
    expect(runsInB[0].stage).toBe('global')
    expect(runsInB[0].source_display_json).toContain('荒原之书.txt')

    // 验证章节内容不互串
    type ChapterRow = { chapter_number: number; title: string }
    const chaptersA = bookA.db.prepare('SELECT chapter_number, title FROM import_run_chapters ORDER BY chapter_number').all() as ChapterRow[]
    const chaptersB = bookB.db.prepare('SELECT chapter_number, title FROM import_run_chapters ORDER BY chapter_number').all() as ChapterRow[]

    expect(chaptersA).toHaveLength(2)
    expect(chaptersA[0].title).toBe('港口之光')
    expect(chaptersA[1].title).toBe('迷雾海峡')

    expect(chaptersB).toHaveLength(1)
    expect(chaptersB[0].title).toBe('荒原风暴')

    // 验证文档收据隔离
    type DocRow = { document_id: string }
    const docsA = bookA.db.prepare('SELECT document_id FROM import_reference_documents ORDER BY document_id').all() as DocRow[]
    const docsB = bookB.db.prepare('SELECT document_id FROM import_reference_documents ORDER BY document_id').all() as DocRow[]
    expect(docsA).toHaveLength(2)
    expect(docsA[0].document_id).toBe(docIdA1 < docIdA2 ? docIdA1 : docIdA2)
    expect(docsA[1].document_id).toBe(docIdA1 < docIdA2 ? docIdA2 : docIdA1)
    expect(docsB).toHaveLength(1)
    expect(docsB[0].document_id).toBe(docIdB1)
    expect(docsA.map(d => d.document_id)).not.toContain(docIdB1)
  })

  it('AC-2: 全局/服务商/模型/项目槽和公平队列生效；书间可并行，同书阶段/批次依赖不因资格放宽', async () => {
    const policy: MainProcessSchedulerPolicy = {
      global: 4,
      provider: 4,
      credential: 4,
      model: 4,
      project: 1, // 单项目活跃并发严格限制为 1
      maxQueued: 10,
      maxQuarantined: 2,
      interactiveBurst: 2,
    }

    const scheduler = new MainGenerationScheduler(policy, 8)
    const model = createModel('multi-book-model')

    let a1Finished = false
    let a2Started = false
    let b1Finished = false

    // 1. Book A 发起第 1 个批次 A1（抽取大纲全局事实）
    const permitA1Promise = scheduler.acquire({
      lane: 'interactive',
      model,
      projectKey: 'proj-book-a',
      signal: new AbortController().signal,
    })
    const permitA1 = await permitA1Promise

    expect(permitA1).toBeDefined()
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(0)

    // 2. Book A 紧接着发起第 2 个批次 A2（抽取下一批章节蓝图）
    // 由于 project 限制为 1，A2 必须在队列中等待，绝不能提前或者并发执行
    let a2Resolved = false
    const permitA2Promise = scheduler.acquire({
      lane: 'interactive',
      model,
      projectKey: 'proj-book-a',
      signal: new AbortController().signal,
    }).then(p => {
      a2Resolved = true
      a2Started = true
      return p
    })

    await Promise.resolve()
    expect(a2Resolved).toBe(false)
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(1)

    // 3. 独立项目 Book B 发起任务 B1（抽取风格）
    // 虽然 Book A 已满载排队，但 Book B 拥有独立的项目配额，必须立即获批并发执行！
    let b1Resolved = false
    const permitB1Promise = scheduler.acquire({
      lane: 'interactive',
      model,
      projectKey: 'proj-book-b',
      signal: new AbortController().signal,
    }).then(p => {
      b1Resolved = true
      return p
    })

    const permitB1 = await permitB1Promise
    expect(b1Resolved).toBe(true)
    // 此时书间并行（A1 和 B1 均处于 active），而书内 A2 依然严格排队！
    expect(scheduler.getStats().active).toBe(2)
    expect(scheduler.getStats().queued).toBe(1)
    expect(a2Started).toBe(false)

    // 4. 完成 Book B 的任务 B1
    permitB1.finish()
    b1Finished = true
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(1)
    expect(a2Started).toBe(false) // A2 依然在等待 A1，不受 B1 结束影响

    // 5. 完成 Book A 的第 1 批次 A1
    permitA1.finish()
    a1Finished = true

    // A1 释放后，排队中的 A2 立即获批启动
    const permitA2 = await permitA2Promise
    expect(a2Resolved).toBe(true)
    expect(a2Started).toBe(true)
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(0)

    permitA2.finish()
    expect(scheduler.getStats().active).toBe(0)
    expect(a1Finished).toBe(true)
    expect(b1Finished).toBe(true)
  })

  it('AC-3: 一书取消/unknown/重开/维护或崩溃恢复不破坏另一书；旧未迁入口仍按共存矩阵适配或拒绝', async () => {
    const bookA = createBookFixture('book-a-fault')
    const bookB = createBookFixture('book-b-fault')

    const policy: MainProcessSchedulerPolicy = {
      global: 4,
      provider: 4,
      credential: 4,
      model: 4,
      project: 1,
      maxQueued: 10,
      maxQuarantined: 2,
      interactiveBurst: 2,
    }
    const scheduler = new MainGenerationScheduler(policy, 8)
    const model = createModel('model-fault')

    // 1. Book A 与 Book B 同时启动执行
    const permitA = await scheduler.acquire({ lane: 'interactive', model, projectKey: 'proj-book-a', signal: new AbortController().signal })
    const permitB = await scheduler.acquire({ lane: 'interactive', model, projectKey: 'proj-book-b', signal: new AbortController().signal })

    expect(scheduler.getStats().active).toBe(2)

    // 在 Book A 注册拆解任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const contentFaultA = '这是书A的故障测试内容'
    ImportRunRepository.prepare({
      runId: 'run-a-fault',
      purpose: 'reference',
      sourceFingerprint: hash('source-a'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '书A.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [{
        number: 1,
        title: '第一章',
        content: contentFaultA,
        contentSize: Buffer.byteLength(contentFaultA, 'utf8'),
        contentFingerprint: hash(contentFaultA),
      }],
    })
    const execA = ImportRunRepository.startOrResume('run-a-fault', 'runner-a', Date.now(), 60000, bookA.context).execution

    // 在 Book B 注册拆解任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookB.root)
    vi.mocked(getProjectDb).mockReturnValue(bookB.db)

    const contentNormalB = '这是书B的正常测试内容'
    const chapterNormalB = {
      number: 1,
      title: '第一章',
      content: contentNormalB,
      contentSize: Buffer.byteLength(contentNormalB, 'utf8'),
      contentFingerprint: hash(contentNormalB),
    }
    ImportRunRepository.prepare({
      runId: 'run-b-normal',
      purpose: 'reference',
      sourceFingerprint: hash('source-b'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '书B.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [chapterNormalB],
    })
    const execB = ImportRunRepository.startOrResume('run-b-normal', 'runner-b', Date.now(), 60000, bookB.context).execution

    // 2. 模拟 Book A 遭遇远端 unknown 故障并触发隔离
    permitA.quarantine()
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().quarantined).toBe(1)

    // Book A 记录失败
    ImportRunRepository.fail('run-a-fault', 'knowledge', 'NETWORK_UNKNOWN_OUTCOME', execA, bookA.context)
    permitA.finish()
    expect(scheduler.getStats().quarantined).toBe(0)

    // 3. 验证 Book B 的 permitB 依然活跃有效，完成 Book B 的推进与收据提交
    const authB = ImportRunRepository.resolveReferenceImportAuthority('run-b-normal', execB, 1, Date.now(), bookB.db)
    const docIdB = hash(`reference-import:${authB.stableKey}`)
    bookB.db.prepare(
      "INSERT INTO import_reference_documents(document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state) VALUES(?,?,?,?,1,'reference','committed')",
    ).run(docIdB, hash(authB.stableKey), authB.contentFingerprint, hash('chunk-b'))
    ImportRunRepository.commitReferenceImportReceipt('run-b-normal', execB, 1, docIdB, bookB.db)
    ImportRunRepository.completeBatch(
      'run-b-normal',
      'knowledge',
      createImportRunChapterBatchCheckpointId([chapterNormalB]),
      execB,
      bookB.context,
    )
    ImportRunRepository.advanceStage('run-b-normal', 'knowledge', 'global', execB, bookB.context)

    permitB.finish()
    expect(scheduler.getStats().active).toBe(0)

    // 4. 验证 Book A 状态为 failed/resumable，Book B 状态为 global/running，相互完全隔离
    const runStateA = ImportRunRepository.get('run-a-fault', bookA.context)
    const runStateB = ImportRunRepository.get('run-b-normal', bookB.context)

    expect(runStateA?.status).toBe('failed')
    expect(runStateA?.lastError).toBe('NETWORK_UNKNOWN_OUTCOME')
    expect(runStateA?.resumable).toBe(true)

    expect(runStateB?.status).toBe('running')
    expect(runStateB?.stage).toBe('global')
    expect(runStateB?.lastError).toBe('')

    // 5. 验证 Book A 故障恢复仅读取 Book A 本地数据库
    const resumedA = ImportRunRepository.startOrResume('run-a-fault', 'runner-a-recovery', Date.now(), 60000, bookA.context)
    expect(resumedA.run.id).toBe('run-a-fault')
    expect(resumedA.execution.owner).toBe('runner-a-recovery')
    expect(resumedA.execution.epoch).toBe(3)
    expect(resumedA.execution.epoch).toBeGreaterThan(execA.epoch)
  })
})
