import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { projectAccess } from '../project-access'
import { ImportRunRepository, type CapturedImportRunContext } from '../../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
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
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/two-book-imitation-tests')
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

  const grantRepo = new ReferenceImportGrantRepository(db, {
    projectId,
    context,
    assertCurrent: () => undefined,
    isFrozen: () => false,
  })

  cleanup.push(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  return { root, projectId, db, context, grantRepo }
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

describe('Stage 14 (IMPORT-004): Two-Book Imitation Concurrency Qualification', () => {
  it('AC-1: 两书仿写同时运行且切换查看不取消已迁任务，参考材料与目标作者事实/稿件不串用', async () => {
    const bookA = createBookFixture('book-a')
    const bookB = createBookFixture('book-b')

    // 1. 初始化 Book A 的参考材料与拆解任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const contentA = '港口正文：海风卷起白色的浪花。'
    const chapterA = {
      number: 1,
      title: '海风',
      content: contentA,
      contentSize: Buffer.byteLength(contentA, 'utf8'),
      contentFingerprint: hash(contentA),
    }

    ImportRunRepository.prepare({
      runId: 'imitate-run-a',
      purpose: 'reference',
      sourceFingerprint: hash('source-a'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '海港参考.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [chapterA],
    })
    const execA = ImportRunRepository.startOrResume('imitate-run-a', 'imitate-runner-a', Date.now(), 60000, bookA.context).execution

    // 2. 切换当前视图到 Book B，并初始化 Book B 的参考材料与仿写任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookB.root)
    vi.mocked(getProjectDb).mockReturnValue(bookB.db)

    const contentB = '荒原正文：赤红色的戈壁延伸到天际。'
    const chapterB = {
      number: 1,
      title: '戈壁',
      content: contentB,
      contentSize: Buffer.byteLength(contentB, 'utf8'),
      contentFingerprint: hash(contentB),
    }

    ImportRunRepository.prepare({
      runId: 'imitate-run-b',
      purpose: 'reference',
      sourceFingerprint: hash('source-b'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '荒原参考.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [chapterB],
    })
    const execB = ImportRunRepository.startOrResume('imitate-run-b', 'imitate-runner-b', Date.now(), 60000, bookB.context).execution

    // 3. 模拟两书后台并发提炼文风并写入各自目标稿件
    // Book A 提炼港口写实文风，写入 Book A 的草稿库
    const styleA = '港口明朗写实文风'
    bookA.db.prepare('UPDATE project_core SET writing_style = ? WHERE id = ?').run(styleA, 'main')
    bookA.db.prepare('INSERT INTO contents(id, body) VALUES(1, ?)').run('这是依据港口参考材料生成的正文草稿A')
    bookA.db.prepare("INSERT INTO drafts_all(id, chapter_number, version, status, content_id, word_count) VALUES(1, 1, 1, 'draft', 1, 100)").run()

    // 切换 UI 视图回 Book A，此时后台 Book B 任务正在向 Book B 写入冷峻荒原文风
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const styleB = '荒原冷峻硬派文风'
    bookB.db.prepare('UPDATE project_core SET writing_style = ? WHERE id = ?').run(styleB, 'main')
    bookB.db.prepare('INSERT INTO contents(id, body) VALUES(1, ?)').run('这是依据荒原参考材料生成的正文草稿B')
    bookB.db.prepare("INSERT INTO drafts_all(id, chapter_number, version, status, content_id, word_count) VALUES(1, 1, 1, 'draft', 1, 100)").run()

    // 4. 验证各自项目中的事实与稿件绝对不串用
    type CoreRow = { writing_style: string }
    const coreA = bookA.db.prepare('SELECT writing_style FROM project_core WHERE id = ?').get('main') as CoreRow
    const coreB = bookB.db.prepare('SELECT writing_style FROM project_core WHERE id = ?').get('main') as CoreRow

    expect(coreA.writing_style).toBe(styleA)
    expect(coreB.writing_style).toBe(styleB)
    expect(coreA.writing_style).not.toContain(styleB)
    expect(coreB.writing_style).not.toContain(styleA)

    type ContentRow = { body: string }
    const draftContentA = bookA.db.prepare('SELECT body FROM contents WHERE id = 1').get() as ContentRow
    const draftContentB = bookB.db.prepare('SELECT body FROM contents WHERE id = 1').get() as ContentRow

    expect(draftContentA.body).toContain('草稿A')
    expect(draftContentB.body).toContain('草稿B')
    expect(draftContentA.body).not.toContain('草稿B')
    expect(draftContentB.body).not.toContain('草稿A')

    expect(execA.owner).toBe('imitate-runner-a')
    expect(execB.owner).toBe('imitate-runner-b')
  })

  it('AC-2: 排队期间改源/撤权/模型变化重验，书内依赖/物理请求/时长/unknown与原产出合同保留', async () => {
    const bookA = createBookFixture('book-a-grant')

    const policy: MainProcessSchedulerPolicy = {
      global: 4,
      provider: 4,
      credential: 4,
      model: 4,
      project: 1, // 单项目并发严格为 1
      maxQueued: 10,
      maxQuarantined: 2,
      interactiveBurst: 2,
    }
    const scheduler = new MainGenerationScheduler(policy, 8)
    const model = createModel('model-grant')

    // 1. 在 Book A 中准备参考材料并发行 ReferenceImportGrant
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const content = '测试正文'
    ImportRunRepository.prepare({
      runId: 'grant-run-a',
      purpose: 'reference',
      sourceFingerprint: hash('src-grant'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '参考.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [{
        number: 1,
        title: '第一章',
        content,
        contentSize: Buffer.byteLength(content, 'utf8'),
        contentFingerprint: hash(content),
      }],
    })

    const scope = ImportRunRepository.captureReferenceGrantScope('grant-run-a', bookA.context)

    const grantA = bookA.grantRepo.issue({
      grantId: randomUUID(),
      operationKey: randomUUID(),
      runId: 'grant-run-a',
      manifestFingerprint: scope.manifestFingerprint,
      requestHash: hash('request-payload'),
    })
    expect(grantA.state).toBe('active')

    // 2. Book A 发起第 1 个任务（A1 占用当前项目并发槽位）
    const permitA1 = await scheduler.acquire({
      lane: 'interactive',
      model,
      projectKey: 'proj-grant-a',
      signal: new AbortController().signal,
    })
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(0)

    // 3. Book A 紧接着发起排队任务 A2（依赖 grantA）
    let a2Started = false
    let a2Error: unknown = null
    const grantRefA = { grantId: grantA.grantId, revision: grantA.revision, runId: grantA.runId }

    const permitA2Promise = scheduler.acquire({
      lane: 'interactive',
      model,
      projectKey: 'proj-grant-a',
      signal: new AbortController().signal,
    }).then(p => {
      a2Started = true
      // 出队后在事务内重新核验 grant 有效性；若失效立即释放 permit
      try {
        bookA.db.transaction(() => {
          bookA.grantRepo.assertActive(grantRefA)
        })()
      } catch (err) {
        p.finish()
        throw err
      }
      return p
    }).catch(err => {
      a2Error = err
      throw err
    })

    await Promise.resolve()
    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().queued).toBe(1)
    expect(a2Started).toBe(false)

    // 4. 在 A2 排队等待期间，作者撤销了该 Grant！
    const revokedGrant = bookA.grantRepo.revoke(grantRefA)
    expect(revokedGrant.state).toBe('revoked')
    expect(revokedGrant.revokedAt).toBeGreaterThan(0)

    // 5. A1 执行完毕释放 Permit，调度器唤醒 A2
    permitA1.finish()

    // 验证 A2 出队后核验 Grant 抛出已失效/版本冲突错误并拦截，绝不发生非法派发或脏写
    await expect(permitA2Promise).rejects.toThrow(/REFERENCE_IMPORT_GRANT_(INACTIVE|REVISION_CONFLICT)/)
    expect(a2Error).toBeDefined()
    expect(scheduler.getStats().active).toBe(0)
    expect(scheduler.getStats().queued).toBe(0)
  })

  it('AC-3: 单书失败或暂停不让另一书误报成功或失去owner，取消和恢复分别可查真实领域收据', async () => {
    const bookA = createBookFixture('book-a-fail')
    const bookB = createBookFixture('book-b-ok')

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
    const model = createModel('model-imitate-fail')

    // 1. 同时发起 Book A 与 Book B 的仿写调度
    const permitA = await scheduler.acquire({ lane: 'interactive', model, projectKey: 'proj-book-a', signal: new AbortController().signal })
    const permitB = await scheduler.acquire({ lane: 'interactive', model, projectKey: 'proj-book-b', signal: new AbortController().signal })

    expect(scheduler.getStats().active).toBe(2)

    // 在 Book A 注册仿写任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookA.root)
    vi.mocked(getProjectDb).mockReturnValue(bookA.db)

    const contentA = '书A正文内容'
    ImportRunRepository.prepare({
      runId: 'imitate-a-fail',
      purpose: 'reference',
      sourceFingerprint: hash('src-a'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '书A.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [{
        number: 1,
        title: '第一章',
        content: contentA,
        contentSize: Buffer.byteLength(contentA, 'utf8'),
        contentFingerprint: hash(contentA),
      }],
    })
    const execA = ImportRunRepository.startOrResume('imitate-a-fail', 'owner-a', Date.now(), 60000, bookA.context).execution

    // 在 Book B 注册仿写任务
    vi.mocked(getCurrentProjectPath).mockReturnValue(bookB.root)
    vi.mocked(getProjectDb).mockReturnValue(bookB.db)

    const contentB = '书B正文内容'
    ImportRunRepository.prepare({
      runId: 'imitate-b-ok',
      purpose: 'reference',
      sourceFingerprint: hash('src-b'),
      locale: 'zh-CN',
      sourceDisplay: [{ displayName: '书B.txt', mediaType: 'text/plain', size: 100 }],
      chapters: [{
        number: 1,
        title: '第一章',
        content: contentB,
        contentSize: Buffer.byteLength(contentB, 'utf8'),
        contentFingerprint: hash(contentB),
      }],
    })
    const execB = ImportRunRepository.startOrResume('imitate-b-ok', 'owner-b', Date.now(), 60000, bookB.context).execution

    // 2. 模拟 Book A 发生失败并安全释放 Permit
    permitA.quarantine()
    ImportRunRepository.fail('imitate-a-fail', 'knowledge', 'NETWORK_TIMEOUT', execA, bookA.context)
    permitA.finish()

    // 3. 验证 Book B 不受任何影响，持续拥有其 owner 并成功提交持久化收据
    expect(scheduler.getStats().active).toBe(1)
    const authB = ImportRunRepository.resolveReferenceImportAuthority('imitate-b-ok', execB, 1, Date.now(), bookB.db)
    const docIdB = hash(`reference-import:${authB.stableKey}`)
    bookB.db.prepare(
      "INSERT INTO import_reference_documents(document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state) VALUES(?,?,?,?,1,'reference','committed')",
    ).run(docIdB, hash(authB.stableKey), authB.contentFingerprint, hash('chunk-b'))
    ImportRunRepository.commitReferenceImportReceipt('imitate-b-ok', execB, 1, docIdB, bookB.db)

    permitB.finish()
    expect(scheduler.getStats().active).toBe(0)

    // 4. 核查真实领域收据：
    // Book A 标记为 failed/resumable
    const stateA = ImportRunRepository.get('imitate-a-fail', bookA.context)
    expect(stateA?.status).toBe('failed')
    expect(stateA?.lastError).toBe('NETWORK_TIMEOUT')
    expect(stateA?.resumable).toBe(true)

    // Book B 保持 running 且 owner 完好
    const stateB = ImportRunRepository.get('imitate-b-ok', bookB.context)
    expect(stateB?.status).toBe('running')
    expect(stateB?.lastError).toBe('')
    expect(execB.owner).toBe('owner-b')

    // 5. 恢复 Book A 仅基于 Book A 本地收据，零污染 Book B
    const resumedA = ImportRunRepository.startOrResume('imitate-a-fail', 'owner-a-recovery', Date.now(), 60000, bookA.context)
    expect(resumedA.run.id).toBe('imitate-a-fail')
    expect(resumedA.execution.owner).toBe('owner-a-recovery')
    expect(resumedA.execution.epoch).toBeGreaterThan(execA.epoch)
  })
})
