import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import * as chapterView from './pages/chapter-view.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FIXTURE_PROSE } from './fake-model.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const require = createRequire(import.meta.url)
export const REFERENCE_IMITATION_SCENARIO = 'f537-reference-imitation-10'
const OBSERVER = '__f537ReferenceImitation'
const TARGET_CHAPTER = 3

export function referenceImitationNovel(roots, chapters = 10) {
  const file = path.join(roots.temp, `reference-imitation-${chapters}.txt`)
  fs.writeFileSync(file, Array.from({ length: chapters }, (_, index) =>
    `第${index + 1}章 雾港${index + 1}\n林岚沿着旧港的石阶往下走，第${index + 1}次对照父亲留下的潮汐表。灯塔的雾钟在远处响了三声。\n`).join('\n'))
  return file
}

export async function startReferenceImitationImport(app, page, file, chapters = 10) {
  assert.ok(await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    return true
  }, file))
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-target-current').click()
  await dialog.getByRole('button', { name: '选择', exact: true }).click()
  await dialog.getByRole('button', { name: `导入当前项目（${chapters} 章）`, disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
}

export function readImitationDb(context, read) {
  const Database = require('better-sqlite3')
  const db = new Database(path.join(context.samplePath, '.ai-novel', 'project.db'),
    { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}

function drafts(db) {
  return db.prepare(`SELECT d.*, c.body AS content_body FROM drafts_all d
    JOIN contents c ON c.id=d.content_id ORDER BY d.id`).all()
}

async function installObserver(app) {
  const installed = await app.evaluate(({ ipcMain }, observerKey) => {
    const handlers = ipcMain._invokeHandlers
    const open = handlers.get('project:open')
    const commit = handlers.get('generation:commit-draft')
    if (typeof open !== 'function' || typeof commit !== 'function') return false
    const originalKey = `${observerKey}Original`
    if (Object.hasOwn(globalThis, observerKey) || Object.hasOwn(globalThis, originalKey)) return false
    const fsViews = ['fs:read-file', 'fs:write-file', 'fs:list-dir', 'fs:mkdir',
      'fs:check-exists', 'fs:read-json', 'fs:write-json']
    // Exact current captured-view DB read classification; not proof of an acquired host claim.
    const databaseViews = ['db:import-run-get', 'db:import-run-effect-receipt-get',
      'db:blueprint-get-all', 'db:blueprint-get', 'db:blueprint-character-sync-list-pending',
      'db:blueprint-character-sync-get', 'db:character-get-all', 'db:character-roster-read',
      'db:draft-list', 'db:draft-list-all', 'db:draft-get-meta', 'db:draft-get-full',
      'db:draft-get-latest', 'db:draft-get-finalized', 'db:recovery-candidate-list',
      'db:revision-list', 'db:review-list', 'db:revision-get-pending', 'db:review-get-full',
      'db:revision-get-full', 'db:review-cycle-get']
    const recoveries = new Set(['generation:find-blueprint-recovery', 'generation:read-context'])
    const observed = new Set([...fsViews, ...databaseViews, ...recoveries])
    const safeErrors = new Set(['PROJECT_RUNTIME_VIEW_OPERATION_BUSY', 'PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT',
      'PROJECT_RUNTIME_BUSY', 'PROJECT_RUNTIME_VIEW_COMMIT_BUSY', 'PROJECT_RUNTIME_LEGACY_OPERATION_BUSY',
      'PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE', 'PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY',
      'PROJECT_RUNTIME_RESTORE_BUSY', 'PROJECT_RUNTIME_HOST_CLOSING', 'PROJECT_RUNTIME_CLOSE_REQUESTED',
      'PROJECT_RUNTIME_NOT_OPEN', 'PROJECT_RUNTIME_DATABASE_CHANGED', 'PROJECT_SESSION_REQUIRED',
      'PROJECT_SESSION_STALE', 'PROJECT_SESSION_ROOT_MISMATCH', 'PROJECT_SESSION_DATABASE_MISMATCH',
      'GENERATION_OWNER_BUSY', 'GENERATION_REQUEST_FAILED', 'GENERATION_PROJECT_SESSION_STALE'])
    const safeCode = value => {
      if (typeof value !== 'string') return null
      const code = value.startsWith('Error: ') ? value.slice(7) : value
      return safeErrors.has(code) ? code : null
    }
    const diagnostics = { pendingDoesNotProveClaim: true, trace: [], pending: [], snapshots: [],
      droppedTrace: 0, droppedPending: 0, droppedSnapshots: 0, droppedSessions: 0, droppedConsole: 0 }
    const state = { openedSession: null, writeCommit: null, diagnostics }
    const pending = new Map(), sessions = new Map(), entries = []
    let sequence = 0, consoleLines = 0
    const opaqueSession = candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || !['projectId', 'leaseId', 'projectPath'].every(key => typeof candidate[key] === 'string' && candidate[key])) return null
      // Private lookup only; the trace projects neither identity strings nor the path.
      const key = JSON.stringify([candidate.projectId, candidate.leaseId, candidate.projectPath])
      if (!sessions.has(key)) {
        if (sessions.size >= 64) { diagnostics.droppedSessions++; return null }
        sessions.set(key, `session-${sessions.size + 1}`)
      }
      return sessions.get(key)
    }
    const emit = record => {
      if (consoleLines >= 256) { diagnostics.droppedConsole++; return }
      consoleLines++
      // Diagnostics cannot change the original handler's outcome if a console sink fails.
      try { console.log(`reference-imitation-ipc:${JSON.stringify(record)}`) } catch { /* In-memory evidence remains. */ }
    }
    const snapshot = () => [...pending.values()].map(entry => ({ ...entry,
      elapsedMs: Math.max(0, Date.now() - entry.startedAt) }))
    const captureSnapshot = (boundary, invocationId = null, channel = null, errorCode = null) => {
      const record = { boundary, invocationId, channel, errorCode, at: Date.now(),
        pendingDoesNotProveClaim: true, pending: snapshot() }
      if (diagnostics.snapshots.length >= 16) { diagnostics.snapshots.shift(); diagnostics.droppedSnapshots++ }
      diagnostics.snapshots.push(record)
      emit({ type: 'snapshot', ...record })
    }
    const recordTrace = record => {
      if (diagnostics.trace.length >= 256) { diagnostics.trace.shift(); diagnostics.droppedTrace++ }
      diagnostics.trace.push(record)
      emit({ type: 'trace', ...record })
    }
    const restore = () => {
      const failures = []
      for (const entry of entries) {
        try {
          if (handlers.get(entry.channel) === entry.wrapper) handlers.set(entry.channel, entry.original)
          else if (handlers.get(entry.channel) !== entry.original) throw new Error('REFERENCE_IMITATION_OBSERVER_HANDLER_CHANGED')
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'REFERENCE_IMITATION_OBSERVER_RESTORE_FAILED')
      delete globalThis[originalKey]
      delete globalThis[observerKey]
    }
    globalThis[originalKey] = { restore, captureSnapshot }
    globalThis[observerKey] = state
    try {
      for (const channel of new Set(['project:open', 'generation:commit-draft', ...observed])) {
        const original = handlers.get(channel)
        if (typeof original !== 'function') continue
        const wrapper = async (event, ...args) => {
          let trace, outcome = 'threw', errorCode = null
          if (observed.has(channel)) {
            trace = { channel, invocationId: ++sequence, session: opaqueSession(args.at(-1)), startedAt: Date.now() }
            if (pending.size < 64) pending.set(trace.invocationId, trace)
            else diagnostics.droppedPending++
            diagnostics.pending = snapshot()
            recordTrace({ ...trace, phase: 'start' })
            if (recoveries.has(channel)) captureSnapshot('recovery-enter', trace.invocationId, channel)
          }
          try {
            const result = await original(event, ...args)
            outcome = 'returned'
            errorCode = safeCode(result?.errorCode) ?? safeCode(result?.error)
            if (channel === 'project:open' && result?.success) state.openedSession = { projectId: result.project.id,
              projectPath: result.project.path, leaseId: result.project.sessionLease }
            if (channel === 'generation:commit-draft') {
              const request = args[0]
              state.writeCommit = { handle: request.handle, chapterNumber: request.chapterNumber, source: request.source,
                success: result?.success === true, id: result?.id, version: result?.version, contentHash: result?.contentHash }
            }
            if (trace && recoveries.has(channel) && (result?.success === false || errorCode))
              captureSnapshot('recovery-failed', trace.invocationId, channel, errorCode)
            return result
          } catch (error) {
            errorCode = safeCode(error?.message)
            if (trace && recoveries.has(channel)) captureSnapshot('recovery-failed', trace.invocationId, channel, errorCode)
            throw error
          } finally {
            if (trace) {
              const endedAt = Date.now()
              pending.delete(trace.invocationId)
              diagnostics.pending = snapshot()
              recordTrace({ ...trace, phase: 'end', endedAt,
                elapsedMs: Math.max(0, endedAt - trace.startedAt), outcome, errorCode })
            }
          }
        }
        entries.push({ channel, original, wrapper })
        handlers.set(channel, wrapper)
      }
    } catch (error) {
      try { restore() } catch {
        emit({ type: 'cleanup', phase: 'install-rollback', errorCode: 'REFERENCE_IMITATION_OBSERVER_INSTALL_ROLLBACK_FAILED' })
      }
      throw error
    }
    return true
  }, OBSERVER)
  assert.equal(installed, true, '项目重开与正文提交真实 IPC handler 已注册')
}

async function removeObserver(app) {
  await app.evaluate((_, observerKey) => {
    globalThis[`${observerKey}Original`]?.restore()
  }, OBSERVER)
}

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const promptText = chat => (chat.messages ?? []).map(message => typeof message.content === 'string'
  ? message.content : JSON.stringify(message.content)).join('\n')

async function waitForChapterRunDone(page, chapterNumber, timeout = 90_000) {
  await page.waitForFunction(number => [...document.querySelectorAll('.run-card')].some(card =>
    card.querySelector('.run-card-title')?.textContent?.trim() === `第 ${number} 章 · 写稿`
      && card.getAttribute('data-state') === 'completed'), chapterNumber, { timeout })
}

export function createReferenceImitationScenario({
  readDb = readImitationDb,
  startImport = startReferenceImitationImport,
  referenceNovel = referenceImitationNovel,
  stageApi = stage,
  blueprintApi = blueprint,
  chapterApi = chapterView,
  runApi = runSheet,
  projectName = STAGE_SAMPLE.name,
} = {}) {
  return {
    model: true,
    shell: 'stage',
    setup: seedStageSample,
    run: async context => {
      const { app, page, roots, fake } = context
      const before = readDb(context, drafts)
      const priorTargetDrafts = before.filter(row => row.chapter_number === TARGET_CHAPTER)
      await installObserver(app)
      const cleanupFailures = []
      let result, runFailed = false
      try {
        fake.replyImport()
        await startImport(app, page, referenceNovel(roots, 10), 10)
        await runApi.waitUntilOpen(page)
        await runApi.waitForRunDone(page, 5 * 60_000)

        const imported = readDb(context, db => ({
          drafts: drafts(db),
          style: db.prepare('SELECT writing_style FROM project_core ORDER BY id LIMIT 1').get()?.writing_style ?? '',
          run: db.prepare("SELECT id, purpose, stage, status FROM import_runs WHERE purpose='reference' ORDER BY rowid DESC LIMIT 1").get(),
          styleReceipt: db.prepare(`SELECT state, effect_receipt_json FROM import_run_receipts
            WHERE run_id=(SELECT id FROM import_runs WHERE purpose='reference' ORDER BY rowid DESC LIMIT 1)
              AND stage='style' ORDER BY batch_id LIMIT 1`).get(),
        }))
        assert.equal(imported.run?.status, 'completed', '参考工作流以领域运行收据完成')
        assert.equal(imported.styleReceipt?.state, 'committed', '文风领域效果收据已提交')
        assert.equal(JSON.parse(imported.styleReceipt.effect_receipt_json)?.writingStyle, imported.style,
          '持久文风与已提交的文风效果收据一致')
        assert.ok(imported.style.trim(), '参考导入保存了非空文风')
        assert.deepEqual(imported.drafts, before, '参考导入没有创建或改写目标作品草稿')

        const priorProseCount = fake.chats.filter(chat => chat.kind === 'prose').length
        await blueprintApi.open(page)
        await blueprintApi.writeNext(page)
        await runApi.waitUntilOpen(page)
        await waitForChapterRunDone(page, TARGET_CHAPTER)
        await chapterApi.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 30_000 })

        const observed = await app.evaluate((_, observerKey) => globalThis[observerKey], OBSERVER)
        const commit = observed?.writeCommit
        assert.ok(commit?.success && commit.source === 'write' && commit.chapterNumber === TARGET_CHAPTER && commit.handle?.runId,
          '正文写作经过生产 generation:commit-draft 并取得领域收据')
        const writeChats = fake.chats.filter(chat => chat.kind === 'prose').slice(priorProseCount)
        assert.ok(writeChats.length > 0, '写作操作产生了真实 provider 请求')
        const consumed = writeChats.some(chat => promptText(chat).includes(imported.style))
        assert.equal(consumed, true, '正文生产提示词实际包含已保存文风')
        const styleHash = hash(imported.style)

        const written = readDb(context, db => drafts(db).filter(row => row.chapter_number === TARGET_CHAPTER))
        assert.deepEqual(written.filter(row => priorTargetDrafts.some(previous => previous.id === row.id)), priorTargetDrafts,
          '正文新建版本时保留原有目标章节草稿')
        const savedDraft = written.find(row => row.id === commit.id && row.version === commit.version)
        assert.ok(savedDraft, '目标第 3 章草稿已持久保存')
        assert.ok(savedDraft.content_body.length > 0, '保存的目标稿有正文')
        assert.notEqual(savedDraft.content_body, imported.style, 'REFERENCE_IMITATION_PROSE_OUTPUT_MISMATCH: 文风分析不能冒充正文')
        assert.equal(savedDraft.content_body, FIXTURE_PROSE, 'REFERENCE_IMITATION_PROSE_OUTPUT_MISMATCH: 正文来自本次 prose 夹具输出')
        assert.equal(commit.contentHash, hash(savedDraft.content_body), 'DRAFT_RECEIPT_CONTENT_HASH_MISMATCH: 保存收据绑定真实稿件正文')

        await stageApi.backToLibrary(page, projectName)
        const projectLoaded = page.waitForEvent('console', { predicate: message =>
          message.text() === `[ProjectService] 项目数据加载完成: ${context.samplePath}`, timeout: 30_000 })
        await Promise.all([projectLoaded, stageApi.openFromLibrary(page, projectName)])
        const reopened = await app.evaluate((_, observerKey) => globalThis[observerKey]?.openedSession, OBSERVER)
        assert.ok(reopened?.leaseId && reopened.projectId && reopened.projectPath, '重开作品取得新的真实项目会话')
        const recovered = await context.invoke(page, 'generation:read-context', { handle: commit.handle }, reopened)
        assert.equal(recovered.draftSave?.kind, 'current', '重开后恢复入口返回当前写稿收据')
        const recoveryReceipt = recovered.draftSave.receipt
        const reopenedDraft = await context.invoke(page, 'db:draft-get-latest', TARGET_CHAPTER, reopened.projectPath, reopened)
        const reopenedBody = readDb(context, db => drafts(db).find(row => row.chapter_number === TARGET_CHAPTER
          && row.id === recoveryReceipt.id && row.version === recoveryReceipt.version))
        assert.deepEqual({ id: reopenedDraft?.id, version: reopenedDraft?.version, body: reopenedBody?.content_body },
          { id: recoveryReceipt.id, version: recoveryReceipt.version, body: recoveryReceipt.content },
          '重开后正文领域稿件与恢复收据一致')
        assert.equal(recoveryReceipt.contentHash, commit.contentHash, '提交和恢复收据的正文 hash 一致')
        assert.equal(hash(reopenedBody.content_body), recoveryReceipt.contentHash, '重开读回的领域稿正文 hash 与恢复收据一致')

        await chapterApi.open(page, TARGET_CHAPTER)
        await chapterApi.title(page).filter({ hasText: /^第\s*3\s*章$/u }).waitFor({ state: 'visible', timeout: 30_000 })
        await chapterApi.prose(page).filter({ hasText: recoveryReceipt.content }).first().waitFor({ state: 'visible', timeout: 30_000 })
        const visibleChapterNumber = Number(/^第\s*(\d+)\s*章$/u.exec(await chapterApi.title(page).innerText())?.[1])
        assert.equal(visibleChapterNumber, TARGET_CHAPTER, '重开后实际展示新写的第 3 章')
        const visibleBodyHash = hash(await chapterApi.prose(page).innerText())
        assert.equal(visibleBodyHash, recoveryReceipt.contentHash, '实际可见正文与重开恢复收据一致')

        result = { importRunId: imported.run.id, styleReceiptState: imported.styleReceipt.state, styleHash,
          styleConsumed: consumed, importDraftsUnchanged: true, chapterNumber: TARGET_CHAPTER,
          savedDraftId: commit.id, savedDraftVersion: commit.version, savedContentHash: commit.contentHash,
          reopenedDraftId: reopenedDraft.id, recoveredReceipt: true, visibleChapterNumber, visibleBodyHash }
      } catch (error) {
        runFailed = true
        throw error
      } finally {
        const recordCleanupFailure = (phase, error) => {
          cleanupFailures.push(error)
          context.diagnostics?.push(`reference-imitation-cleanup:${JSON.stringify({ phase,
            errorCode: phase === 'snapshot' ? 'REFERENCE_IMITATION_OBSERVER_SNAPSHOT_FAILED' : 'REFERENCE_IMITATION_OBSERVER_RESTORE_FAILED' })}`)
        }
        try {
          const diagnostics = await app.evaluate((_, { observerKey, failed }) => {
            globalThis[`${observerKey}Original`]?.captureSnapshot(failed ? 'scenario-failed' : 'scenario-finally')
            return globalThis[observerKey]?.diagnostics
          }, { observerKey: OBSERVER, failed: runFailed })
          if (diagnostics) context.diagnostics?.push(`reference-imitation-ipc:${JSON.stringify(diagnostics)}`)
        } catch (error) { recordCleanupFailure('snapshot', error) }
        try { await removeObserver(app) } catch (error) { recordCleanupFailure('restore', error) }
      }
      // Primary errors already propagate; only an otherwise successful run reaches this cleanup failure.
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'REFERENCE_IMITATION_OBSERVER_CLEANUP_FAILED')
      return result
    },
  }
}

export const REFERENCE_IMITATION_SCENARIOS = {
  [REFERENCE_IMITATION_SCENARIO]: createReferenceImitationScenario(),
}
