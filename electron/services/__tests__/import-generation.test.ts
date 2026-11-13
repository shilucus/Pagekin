import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { projectAccess } from '../project-access'
import { createMainGenerationOwner, type MainGenerationOwnerDependencies } from '../main-generation-owner'
import { MainGenerationScheduler } from '../generation-scheduler'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch'], options: Pick<MainGenerationOwnerDependencies, 'scheduling' | 'beforeDispatch'> = {}, useProviderAdapter = false) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/import-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  const project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('fixture project identity missing')
  const projectId = project.projectId
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)

  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,content:'冻结的合成提示词',systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ ...options, database: db, projectPath: root, projectId, epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, ...(useProviderAdapter ? {} : { dispatch:spy }),
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, '.ai-novel', 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  const content='第一章 海港\r\n林岚在港口找到了信。'
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
  const chapter={number:1,title:'海港',content,contentSize:Buffer.byteLength(content),contentFingerprint:hash(content)}
  ImportRunRepository.prepare({runId:'导入任务',purpose:'reference',sourceFingerprint:'a'.repeat(64),locale:'zh-CN',sourceDisplay:[{displayName:'参考小说.txt',mediaType:'text/plain',size:chapter.contentSize}],chapters:[chapter]})
  const execution=ImportRunRepository.startOrResume('导入任务','合成执行器').execution
  const binding=ImportRunRepository.resolveReferenceImportAuthority('导入任务',execution,1)
  const documentId=hash(`reference-import:${binding.stableKey}`)
  db.prepare("INSERT INTO import_reference_documents(document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state) VALUES(?,?,?,?,1,'reference','committed')").run(documentId,hash(binding.stableKey),binding.contentFingerprint,hash('合成块'))
  ImportRunRepository.commitReferenceImportReceipt('导入任务',execution,1,documentId)
  ImportRunRepository.completeBatch('导入任务','knowledge',createImportRunChapterBatchCheckpointId([chapter]),execution)
  ImportRunRepository.advanceStage('导入任务','knowledge','global',execution)
  const slot={runId:'导入任务',stage:'global' as const,batchId:'done'}
  const selection:BeginGenerationRequest={operation:'import-global-facts',uiActionNonce:'首次导入',modelId:model.id,promptKeys:['infer_novel_config_with_vectors','infer_novel_config'],skillStages:['planning'],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'structured-data',importSlot:slot,importExecution:{owner:execution.owner,epoch:execution.epoch}}
  return {get db(){return db},owner,spy,reopenStorage,selection,slot,content,execution,model}
}

import { createHash } from 'node:crypto'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
const task={purpose:'import-global-facts',output:'structured-data' as const,messages:[{role:'user' as const,content:'归纳参考小说事实'}]}
type ImportFixture = ReturnType<typeof fixture>
type ImportOwner = ImportFixture['owner']
type ImportHandle = ReturnType<ImportOwner['begin']>['handle']

function transportDiagnostics(overrides: Partial<GenerationTransportDiagnostics>): GenerationTransportDiagnostics {
  return { startedAt:1, elapsedMs:2, firstResponseMs:1, lastResponseMs:2, lastOutputMs:null,
    phase:'response', visibleEvents:0, reasoningEvents:0, ...overrides }
}

function allocations(f: ImportFixture) {
  return {
    roots:f.db.prepare('SELECT root_action_id,budget_json FROM generation_roots ORDER BY root_action_id').all(),
    runs:f.db.prepare('SELECT run_id,root_action_id,open_key FROM generation_runs ORDER BY run_id').all(),
    attempts:f.db.prepare('SELECT attempt_id,run_id,root_action_id,invocation_nonce FROM generation_attempts ORDER BY attempt_id').all(),
    artifacts:f.db.prepare('SELECT artifact_id,attempt_id,run_id FROM generation_artifacts ORDER BY artifact_id').all(),
  }
}

function assertNoReplacement(f: ImportFixture, owner: ImportOwner, handle: ImportHandle) {
  const before = allocations(f), calls = f.spy.mock.calls.length
  for (const uiActionNonce of [f.selection.uiActionNonce, 'unknown后重新点击', 'unknown后再次换nonce']) {
    let opened: ReturnType<ImportOwner['begin']> | undefined, failure: unknown
    try { opened = owner.begin({ ...f.selection, uiActionNonce }) } catch (error) { failure = error }
    // Both replaying the existing handle and an explicit refusal preserve no-resend.
    if (opened) {
      expect(opened.handle.runId).toBe(handle.runId)
      expect(opened.handle.rootActionId).toBe(handle.rootActionId)
    } else expect(failure).toBeInstanceOf(Error)
    expect(allocations(f)).toEqual(before)
    expect(f.spy).toHaveBeenCalledTimes(calls)
  }
  let restarted: ReturnType<ImportOwner['restart']> | undefined, failure: unknown
  try { restarted = owner.restart(handle, { ...f.selection, uiActionNonce:'unknown后显式restart' }) } catch (error) { failure = error }
  if (restarted) {
    expect(restarted.handle.runId).toBe(handle.runId)
    expect(restarted.handle.rootActionId).toBe(handle.rootActionId)
  } else expect(failure).toBeInstanceOf(Error)
  expect(allocations(f)).toEqual(before)
  expect(f.spy).toHaveBeenCalledTimes(calls)
}

function storedAttempt(f: ImportFixture, runId: string) {
  const row = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid LIMIT 1').get(runId) as { attempt_json:string; usage_receipt_json:string }
  return { attempt:JSON.parse(row.attempt_json), receipt:JSON.parse(row.usage_receipt_json) }
}

function markHistoricalUnknown(f: ImportFixture, runId: string) {
  // Simulate a pre-fix persisted chain, not permission to alter a production receipt.
  f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.result.finishReason',NULL,'$.result.failureCode','NETWORK_ERROR') WHERE run_id=?").run(runId)
}

async function knownLengthRetry(options: Pick<MainGenerationOwnerDependencies, 'scheduling' | 'beforeDispatch'> = {}) {
  let calls = 0
  const f = fixture(async (_request, transport) => {
    transport.onVisible({ kind:'delta', text:'{"genre":"合成"}' })
    return { finishReason:++calls === 1 ? 'length' : 'stop', usage:null }
  }, options)
  const original = f.owner.begin(f.selection).handle
  await f.owner.executeImportGeneration({ execution:f.execution, handle:original, ordinal:0, task })
  await f.owner.whenPhysicalIdle()
  const latest = f.owner.begin({ ...f.selection, uiActionNonce:'已知length后的重试' }).handle
  expect(latest.runId).not.toBe(original.runId)
  expect(latest.rootActionId).toBe(original.rootActionId)
  return { f, original, latest }
}

it('freezes manifest-wide counts together when only one overlapping-import chapter is new', () => {
  const f = fixture()
  f.db.exec('UPDATE import_runs SET manifest_chapter_count=4,manifest_word_count=3200,total_chapters=1')
  f.owner.begin(f.selection)
  const frozen = f.owner.readImportGeneration(f.slot)!.frozenContext
  expect(frozen).toMatchObject({ totalChapters: 4, totalWords: 3200 })
  expect(frozen.chapters).toHaveLength(1)
  expect(f.spy).not.toHaveBeenCalled()
})

it('同slot不同nonce加入同run，并冻结实际manifest正文',()=>{
 const f=fixture(),first=f.owner.begin(f.selection),second=f.owner.begin({...f.selection,uiActionNonce:'另一次点击'})
 expect(second.handle).toEqual(first.handle)
 expect(f.owner.readImportGeneration(f.slot)).toMatchObject({modelId:'synthetic',frozenContext:{chapters:[{content:f.content}]}})
 expect(f.spy).not.toHaveBeenCalled()
})
it.each(['stage','authority','hash'] as const)('首次begin拒绝错误%s',kind=>{
 const f=fixture()
 if(kind==='hash') f.db.exec("UPDATE import_run_chapters SET content_snapshot='篡改正文'")
 const request={...f.selection,...(kind==='stage'?{operation:'analyze-writing-style'}:{}),...(kind==='authority'?{importExecution:{owner:'伪执行器',epoch:1}}:{})}
 expect(()=>f.owner.begin(request)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})
it('ordinal0并发只派发一次，持久请求重开仍读原artifact和model',async()=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve})
 const f=fixture(async(_r,o)=>{await pending;o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 const first=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task}),second=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 release();const receipt=await first
 expect(await second).toEqual(receipt);expect(f.spy).toHaveBeenCalledTimes(1)
 const stored=JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get() as string)
 expect(stored.replayTask).toEqual(task)
 const next=f.reopenStorage()
 expect(next.readImportGeneration(f.slot)?.modelId).toBe('synthetic')
 const replay=await next.executeImportGeneration({handle,ordinal:0,task:{...task,messages:[{role:'user',content:'后来改变的请求'}]}})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome).toMatchObject({status:receipt.outcome.status,content:receipt.outcome.content,finishReason:receipt.outcome.finishReason})
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('ordinal gap拒绝，unknown重开不自动重发且预算保留',async()=>{
 const f=fixture(async()=>{throw new Error('合成发送结果未知')}),handle=f.owner.begin(f.selection).handle
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task})).rejects.toThrow('GENERATION_IMPORT_ORDINAL_GAP')
 const receipt=await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 const next=f.reopenStorage()
 const replay=await next.executeImportGeneration({handle,ordinal:0,task})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome.status).toBe(receipt.outcome.status)
 expect(replay.run.ledger?.physicalRequests).toBe(1)
 await expect(next.executeImportGeneration({execution:f.execution,handle,ordinal:1,task})).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
 assertNoReplacement(f,next,handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

const remoteUnknownCases = ['network-null', 'explicit-unknown', 'explicit-cancelled', 'error-without-proof', 'storage-failure'] as const
it.each(remoteUnknownCases.flatMap(kind => [false, true].map(reopen => ({ kind, reopen }))))('远端结果不明 $kind reopen=$reopen 不换nonce、不增root且原ordinal可回放', async ({ kind, reopen }) => {
 const f = fixture(async (_request, options) => {
   if (kind === 'network-null') throw new Error('NETWORK_ERROR')
   options.onVisible({ kind:'delta', text:'{"partial":"未确认"}' })
   if (kind === 'storage-failure') options.onDiagnostics?.(transportDiagnostics({ phase:'complete', endReason:'completed', httpStatus:200 }))
   return { finishReason:kind === 'explicit-unknown' ? 'unknown' : kind === 'explicit-cancelled' ? 'cancelled' : 'error', usage:null }
 })
 if (kind === 'storage-failure') f.db.exec("CREATE TEMP TRIGGER fictional_storage_failure BEFORE UPDATE OF artifact_json ON generation_artifacts BEGIN SELECT RAISE(FAIL,'FICTIONAL_STORAGE_WRITE_FAILED'); END")
 const handle = f.owner.begin(f.selection).handle
 const receipt = await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 await f.owner.whenPhysicalIdle()
 let tailPreserved = false
 const preserveTail = () => {
   f.db.exec('DROP TRIGGER IF EXISTS fictional_storage_failure')
   const before = f.db.prepare('SELECT * FROM generation_artifacts WHERE run_id=?').all(handle.runId)
   f.owner.requestProjectClose()
   tailPreserved = true
   expect(f.owner.read(handle).unsavedTails).toEqual([])
   expect(f.owner.read(handle).recoveryTails).toMatchObject([{ kind:'preserved-partial', tailText:'{"partial":"未确认"}' }])
   expect(f.db.prepare('SELECT * FROM generation_artifacts WHERE run_id=?').all(handle.runId)).toEqual(before)
 }
 try {
   const stored = storedAttempt(f, handle.runId)
   expect(stored.attempt.status).toBe('unknown')
   if (kind === 'network-null') expect(stored.receipt.result).toMatchObject({ finishReason:null, failureCode:'NETWORK_ERROR' })
   if (kind === 'storage-failure') {
     expect(stored.receipt.result.failureCode).toBe('GENERATION_STORAGE_FAILED')
     expect(f.db.prepare('SELECT blocked_code FROM generation_roots').pluck().get()).toBe('GENERATION_STORAGE_FAILED')
     expect(f.owner.read(handle).unsavedTails).toMatchObject([{ text:'{"partial":"未确认"}' }])
     if (reopen) preserveTail()
   }
   const owner = reopen ? f.reopenStorage() : f.owner
   if (kind === 'storage-failure' && reopen) expect(owner.read(handle).recoveryTails).toMatchObject([{ kind:'preserved-partial', tailText:'{"partial":"未确认"}' }])
   const replay = await owner.executeImportGeneration({ handle, ordinal:0, task:{ ...task, messages:[{ role:'user', content:'不得用于重发的新请求' }] } })
   expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
   expect(replay.outcome.status).toBe(receipt.outcome.status)
   expect(replay.run.ledger?.physicalRequests).toBe(1)
   await expect(owner.executeImportGeneration({ execution:f.execution, handle, ordinal:1, task })).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
   assertNoReplacement(f, owner, handle)
   expect(f.spy).toHaveBeenCalledTimes(1)
 } finally {
   // Escrow the actual suffix before close, even when a no-resend assertion fails.
   if (kind === 'storage-failure' && !tailPreserved) preserveTail()
 }
})

it.each([false, true])('实际在途取消后 reopen=%s 保留unknown和原回执，不另起run重发', async reopen => {
 let entered!: () => void
 const started = new Promise<void>(resolve => { entered = resolve })
 const f = fixture(async (_request, options) => {
   entered()
   return new Promise<never>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('合成请求已取消')), { once:true }))
 })
 const handle = f.owner.begin(f.selection).handle
 const pending = f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 await started
 f.owner.cancel(handle)
 const receipt = await pending
 await f.owner.whenPhysicalIdle()
 expect(storedAttempt(f, handle.runId)).toMatchObject({ attempt:{ status:'unknown' }, receipt:{ result:{ failureCode:'GENERATION_CANCELLED', finishReason:null } } })
 const owner = reopen ? f.reopenStorage() : f.owner
 const replay = await owner.executeImportGeneration({ handle, ordinal:0, task })
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome).toMatchObject({ status:receipt.outcome.status, content:receipt.outcome.content, finishReason:receipt.outcome.finishReason })
 expect(replay.run.ledger?.physicalRequests).toBe(1)
 await expect(owner.executeImportGeneration({ execution:f.execution, handle, ordinal:1, task })).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
 assertNoReplacement(f, owner, handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it('recoverInterrupted把无result的已派发历史保留unknown，重开不得创建替代run', async () => {
 const f = fixture(async () => { throw new Error('NETWORK_ERROR') })
 const handle = f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 // Isolated crash snapshot: a physical mark exists, but no terminal provider receipt survived.
 f.db.exec("UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status','dispatch-marked'),usage_receipt_json=json_remove(usage_receipt_json,'$.result')")
 const next = f.reopenStorage()
 expect(storedAttempt(f, handle.runId).attempt.status).toBe('unknown')
 expect(storedAttempt(f, handle.runId).receipt.result).toBeUndefined()
 const replay = await next.executeImportGeneration({ handle, ordinal:0, task })
 expect(replay.run.ledger?.physicalRequests).toBe(1)
 await expect(next.executeImportGeneration({ execution:f.execution, handle, ordinal:1, task })).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
 assertNoReplacement(f, next, handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'corrupt'] as const)('旧retry链早期%s而最新run尚空时，不能从最新run派发或换nonce', async kind => {
 const { f, original, latest } = await knownLengthRetry()
 markHistoricalUnknown(f, original.runId)
 if (kind === 'corrupt') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.artifactIdentity') WHERE run_id=?").run(original.runId)
 const before = allocations(f)
 await expect(f.owner.executeImportGeneration({ execution:f.execution, handle:latest, ordinal:0, task })).rejects.toThrow(kind === 'unknown' ? 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE' : 'ARTIFACT_INTEGRITY_FAILED')
 expect(allocations(f)).toEqual(before)
 assertNoReplacement(f, f.owner, latest)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['invalid-json', 'missing-artifact-identity'] as const)('损坏%s回执不能通过begin或新ordinal绕过', async kind => {
 const f = fixture(async () => { throw new Error('NETWORK_ERROR') })
 const handle = f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 const original = f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get() as string
 try {
   if (kind === 'invalid-json') f.db.exec("UPDATE generation_attempts SET usage_receipt_json='{' ")
   else f.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.artifactIdentity')")
   const before = allocations(f)
   await expect(f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })).rejects.toThrow()
   await expect(f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:1, task })).rejects.toThrow()
   assertNoReplacement(f, f.owner, handle)
   expect(allocations(f)).toEqual(before)
   expect(f.spy).toHaveBeenCalledTimes(1)
 } finally {
   // Keep malformed JSON from hiding the assertion result in fixture close/recovery.
   f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=?').run(original)
 }
})

it.each([
 { label:'phase', override:{ phase:'stream' as const } },
 { label:'endReason', override:{ endReason:'cancelled' as const } },
 { label:'errorCode', override:{ errorCode:'UND_ERR_SOCKET' } },
 { label:'httpStatus', override:{ httpStatus:200 } },
])('HTTP失败证明缺少正确$label时仍是unknown，不得新nonce重发', async ({ override }) => {
 const f = fixture(async (_request, options) => {
   options.onDiagnostics?.(transportDiagnostics({ phase:'response', endReason:'failed', errorCode:'HTTP_ERROR', httpStatus:429, ...override }))
   throw new Error('合成不完整HTTP证明')
 })
 const handle = f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 expect(storedAttempt(f, handle.runId).receipt.result.finishReason).toBeNull()
 assertNoReplacement(f, f.owner, handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each([
 { finishReason:'unknown', proof:'http', httpStatus:400 },
 { finishReason:'cancelled', proof:'http', httpStatus:429 },
 { finishReason:'unknown', proof:'stream', httpStatus:200 },
 { finishReason:'cancelled', proof:'stream', httpStatus:200 },
] as const)('显式$finishReason与完整$proof失败诊断冲突时不能新nonce重发', async ({ finishReason, proof, httpStatus }) => {
 const f = fixture(async (_request, options) => {
   options.onDiagnostics?.(transportDiagnostics({ phase:proof === 'http' ? 'response' : 'stream', endReason:'failed',
     errorCode:proof === 'http' ? 'HTTP_ERROR' : 'PROVIDER_STREAM_ERROR', httpStatus }))
   return { finishReason, usage:null }
 })
 const handle = f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 await f.owner.whenPhysicalIdle()
 expect(storedAttempt(f, handle.runId)).toMatchObject({ attempt:{ status:'unknown' }, receipt:{ result:{ finishReason,
   diagnostics:{ endReason:'failed', errorCode:proof === 'http' ? 'HTTP_ERROR' : 'PROVIDER_STREAM_ERROR', httpStatus } } } })
 assertNoReplacement(f, f.owner, handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'active-time'] as const)('实际OpenAI HTTP400 body等待期间%s不能被旧HTTP失败诊断当作可重发证明', async kind => {
 let releaseBody!: () => void, providerSignal: AbortSignal | null | undefined
 const body = new Promise<void>(resolve => { releaseBody = resolve })
 const text = vi.fn(async () => {
   await body
   if (providerSignal?.aborted) throw new DOMException('fictional body aborted', 'AbortError')
   return '{"error":{"message":"fictional HTTP rejection"}}'
 })
 const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
   providerSignal = init?.signal
   return { ok:false, status:400, text, body:{ cancel:vi.fn() } }
 })
 const f = fixture(undefined, {}, true), handle = f.owner.begin(f.selection).handle
 if (kind === 'active-time') {
   const limit = f.owner.read(handle).ledger!.policy.maxActiveElapsedMs
   // Consume existing root time in the isolated fixture; do not assign a different policy.
   f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(limit - 1000, handle.rootActionId)
   vi.useFakeTimers()
 }
 vi.stubGlobal('fetch', fetch)
 const pending = f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
   .then(receipt => ({ receipt }), (error:unknown) => ({ error }))
 try {
   await vi.waitFor(() => expect(text).toHaveBeenCalledOnce(), { interval:10, timeout:200 })
   expect(f.owner.hasPhysicalInFlight()).toBe(true)
   if (kind === 'cancel') f.owner.cancel(handle)
   else await vi.advanceTimersByTimeAsync(1001)
   const result = await pending
   if ('error' in result) throw result.error
   vi.useRealTimers()
   const failureCode = kind === 'cancel' ? 'GENERATION_CANCELLED' : 'ROOT_BUDGET_EXHAUSTED'
   expect(storedAttempt(f, handle.runId)).toMatchObject({ attempt:{ status:'unknown' }, receipt:{ result:{ finishReason:null,
     failureCode, diagnostics:{ phase:'response', endReason:'failed', errorCode:'HTTP_ERROR', httpStatus:400 } } } })
   expect(result.receipt.run.ledger?.physicalRequests).toBe(1)
   expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(handle.rootActionId))
     .toBe(kind === 'active-time' ? 'ROOT_BUDGET_EXHAUSTED' : null)
   expect(f.owner.hasPhysicalInFlight()).toBe(true)
   assertNoReplacement(f, f.owner, handle)
   expect(fetch).toHaveBeenCalledTimes(1)
 } finally {
   releaseBody()
   try { await pending; await f.owner.whenPhysicalIdle() }
   finally { vi.useRealTimers(); vi.unstubAllGlobals() }
 }
 assertNoReplacement(f, f.owner, handle)
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(f.owner.hasPhysicalInFlight()).toBe(false)
})

const knownRetryCases = ['length', 'blank-stop', 'http-429', 'http-400', 'context', 'provider-stream', 'completed-error'] as const
it.each(knownRetryCases)('已知终态%s即使usage未知仍可重试，共享原root且请求累计', async kind => {
 let calls = 0
 const f = fixture(async (_request, options) => {
   if (++calls > 1) {
     options.onVisible({ kind:'delta', text:'{"genre":"恢复的合成结果"}' })
     return { finishReason:'stop', usage:null }
   }
   if (kind === 'http-429' || kind === 'http-400') {
     options.onDiagnostics?.(transportDiagnostics({ phase:'response', endReason:'failed', errorCode:'HTTP_ERROR', httpStatus:kind === 'http-429' ? 429 : 400 }))
     throw new Error('合成HTTP拒绝')
   }
   if (kind === 'context') throw new Error('GENERATION_CONTEXT_LENGTH_EXCEEDED')
   if (kind === 'provider-stream') {
     options.onDiagnostics?.(transportDiagnostics({ phase:'stream', endReason:'failed', errorCode:'PROVIDER_STREAM_ERROR', httpStatus:200 }))
     throw new Error('合成provider流内显式错误')
   }
   if (kind !== 'blank-stop') options.onVisible({ kind:'delta', text:'{"partial":"合成结果"}' })
   if (kind === 'completed-error') options.onDiagnostics?.(transportDiagnostics({ phase:'complete', endReason:'completed', httpStatus:200 }))
   return { finishReason:kind === 'length' ? 'length' : kind === 'completed-error' ? 'error' : 'stop', usage:null }
 })
 const original = f.owner.begin(f.selection).handle
 const first = await f.owner.executeImportGeneration({ execution:f.execution, handle:original, ordinal:0, task })
 const stored = storedAttempt(f, original.runId)
 expect(stored.attempt.status).toBe('unknown')
 if (kind === 'http-429' || kind === 'http-400') expect(stored.receipt.result).toMatchObject({ finishReason:null,
   diagnostics:{ phase:'response', endReason:'failed', errorCode:'HTTP_ERROR', httpStatus:kind === 'http-429' ? 429 : 400 } })
 if (kind === 'context') expect(stored.receipt.result.failureCode).toBe('GENERATION_CONTEXT_LENGTH_EXCEEDED')
 if (kind === 'provider-stream') expect(stored.receipt.result).toMatchObject({ finishReason:null,
   diagnostics:{ phase:'stream', endReason:'failed', errorCode:'PROVIDER_STREAM_ERROR' } })
 if (kind === 'completed-error') {
   expect(stored.receipt.result).toMatchObject({ finishReason:'error', diagnostics:{ phase:'complete', endReason:'completed' } })
   expect(stored.receipt.result.failureCode).toBeUndefined()
 }
 expect(first.run.ledger?.physicalRequests).toBe(1)
 const policy = f.db.prepare('SELECT budget_json FROM generation_roots').pluck().get()
 const retry = f.owner.begin({ ...f.selection, uiActionNonce:'已知终态再次尝试' }).handle
 expect(retry.runId).not.toBe(original.runId)
 expect(retry.rootActionId).toBe(original.rootActionId)
 const second = await f.owner.executeImportGeneration({ execution:f.execution, handle:retry, ordinal:0, task })
 expect(second.outcome.status).toBe('completed')
 expect(second.run.ledger?.physicalRequests).toBe(2)
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
 expect(f.db.prepare('SELECT budget_json FROM generation_roots').pluck().get()).toBe(policy)
 expect(f.spy).toHaveBeenCalledTimes(2)
})

it('usage未知但stop有正文时仍加入原run，允许下一ordinal而非把usage unknown误作远端unknown', async () => {
 const f = fixture(async (_request, options) => { options.onVisible({ kind:'delta', text:'{"genre":"合成结果"}' }); return { finishReason:'stop', usage:null } })
 const handle = f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:0, task })
 expect(storedAttempt(f, handle.runId)).toMatchObject({ attempt:{ status:'unknown' }, receipt:{ result:{ finishReason:'stop', usage:{ trusted:false } } } })
 expect(f.owner.begin({ ...f.selection, uiActionNonce:'stop后重新加入' }).handle).toEqual(handle)
 const next = await f.owner.executeImportGeneration({ execution:f.execution, handle, ordinal:1, task })
 expect(next.outcome.status).toBe('completed')
 expect(next.run.ledger?.physicalRequests).toBe(2)
 expect(f.spy).toHaveBeenCalledTimes(2)
})

it('recoverInterrupted仅取消尚未派发reservation，缺result仍允许重试且不消耗物理额', async () => {
 const f = fixture(), handle = f.owner.begin(f.selection).handle
 const repository = new GenerationRunRepository(() => f.db)
 const run = repository.get(handle.runId)
 const requestHash = createHash('sha256').update(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash])).digest('hex')
 repository.reserve(handle.runId, 'import:0', requestHash, 2048, 1024, undefined, task.purpose, task)
 expect(storedAttempt(f, handle.runId).attempt.status).toBe('reserved')
 const next = f.reopenStorage()
 expect(storedAttempt(f, handle.runId).attempt.status).toBe('cancelled-before-dispatch')
 expect(storedAttempt(f, handle.runId).receipt.result).toBeUndefined()
 expect(next.read(handle).ledger?.physicalRequests).toBe(0)
 const retry = next.begin({ ...f.selection, uiActionNonce:'明确未发出后的重试' }).handle
 expect(retry.runId).not.toBe(handle.runId)
 expect(retry.rootActionId).toBe(handle.rootActionId)
 const result = await next.executeImportGeneration({ execution:f.execution, handle:retry, ordinal:0, task })
 expect(result.outcome.status).toBe('completed')
 expect(result.run.ledger?.physicalRequests).toBe(1)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it('排队后旧retry链变unknown必须在await后围栏拒绝，零新增attempt', async () => {
 const queue = new MainGenerationScheduler({ global:1, provider:1, credential:1, model:1, project:1,
   maxQueued:8, maxQuarantined:2, interactiveBurst:1 }, 32)
 const { f, original, latest } = await knownLengthRetry({ scheduling:{ admission:queue, projectKey:'fictional-import', quarantineAfterMs:50 } })
 cleanup.unshift(() => queue.close())
 const held = await queue.acquire({ projectKey:'fictional-blocker', model:f.model, lane:'interactive', signal:new AbortController().signal })
 const pending = f.owner.executeImportGeneration({ execution:f.execution, handle:latest, ordinal:0, task }).then(value => ({ value }), (error:unknown) => ({ error }))
 let before: ReturnType<typeof allocations> | undefined
 try {
   await vi.waitFor(() => expect(queue.getStats().queued).toBe(1))
   markHistoricalUnknown(f, original.runId)
   before = allocations(f)
 } finally {
   held.finish()
   await pending
   await f.owner.whenPhysicalIdle()
 }
 const result = await pending
 expect(result).toMatchObject({ error:{ message:'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE' } })
 expect(allocations(f)).toEqual(before)
 expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(latest.rootActionId)).toBeNull()
 expect(f.spy).toHaveBeenCalledTimes(1)
 expect(queue.getStats()).toMatchObject({ occupied:0, queued:0 })
})

it('无scheduler时native reserve/mark前再验旧retry链unknown，零新增attempt', async () => {
 const hooks: { mutate?: () => void } = {}
 const { f, original, latest } = await knownLengthRetry({ beforeDispatch:() => hooks.mutate?.() })
 hooks.mutate = () => markHistoricalUnknown(f, original.runId)
 const before = allocations(f)
 await expect(f.owner.executeImportGeneration({ execution:f.execution, handle:latest, ordinal:0, task })).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
 expect(allocations(f)).toEqual(before)
 expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(latest.rootActionId)).toBeNull()
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['stage','authority'] as const)('已有slot不能用错误%s冒充合法加入',kind=>{
 const f=fixture();f.owner.begin(f.selection)
 const forged={...f.selection,uiActionNonce:'伪加入',...(kind==='stage'?{operation:'analyze-writing-style'}:{importExecution:{owner:'伪执行器',epoch:1}})}
 expect(()=>f.owner.begin(forged)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it('持久replayTask被篡改时拒绝回读，不新增派发',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 f.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.replayTask.purpose','篡改请求')")
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})).rejects.toThrow('GENERATION_IMPORT_TASK_INVALID')
 expect(f.spy).toHaveBeenCalledTimes(1)
})

async function globalEffect(kind: 'unproven' | 'inference' | 'endpoint' | 'forged' | 'dropped' | 'rejected-delta' = 'unproven') {
 const core={genre:'现实',subGenre:'冒险',targetAudience:'通用',totalChapters:1,wordsPerChapter:900,plotStructure:'three_act',narrativePov:'third_limited',goldenFinger:'无',globalGuidance:'克制',premise:'海港来信',coreOutline:'寻找来信者',worldSetting:'海港',protagonistProfile:'林岚',worldbuilding:'海港街巷',synopsis:'找到信件'}
 const card = {name:'林岚',role:'protagonist',gender:'未知',age:'18',appearance:'朴素',personality:'谨慎',background:'港口居民',abilities:'观察',motivation:'寻信',relationships:[] as { target: string; relation: string }[],arc:'成长',notes:'待确认'}
 const generated = ['林岚','苏绾','顾岩'].map((name, index) => ({ ...card, name, role: index ? 'supporting' : 'protagonist',
   currentState: { location:'海港',powerLevel:'普通',physicalState:'正常',mentalState:'警觉',keyItems:'信件',recentEvents:'寻信',updatedAtChapter:0 } }))
 if (kind !== 'unproven' && kind !== 'inference' && kind !== 'forged') generated[0].relationships = [{ target:'苏绾', relation:'同乡' }, { target:'掌柜', relation:'雇主' }]
 const delta = { ...generated[1], name:'掌柜' }
 const original = JSON.stringify({ novelConfig:{ ...core, narrativePOV:core.narrativePov }, architectureFiles:{ premise:core.premise,worldbuilding:core.worldbuilding,synopsis:core.synopsis }, characterCards:generated })
 let output = kind === 'unproven' ? '{"facts":"合成"}' : original
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:output});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task:kind === 'unproven' ? task : { ...task, purpose:'import-inference' }})
 if (kind === 'endpoint' || kind === 'rejected-delta') {
   output = JSON.stringify({ characterCards: kind === 'endpoint' ? [delta] : [delta, { ...delta, name:'任意新增' }] })
   await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task:{ ...task, purpose:'import-inference:endpoint-card-recovery' }})
 }
 const characterEntries = kind === 'unproven' ? [card] : structuredClone(kind === 'endpoint' ? [...generated,delta] : generated)
 if (kind === 'dropped' || kind === 'rejected-delta') characterEntries[0].relationships = [{ target:'苏绾', relation:'同乡' }]
 if (kind === 'forged') characterEntries[0].notes = 'renderer伪造的字段'
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'global',batchId:'done',effectKey:'global-facts',kind:'project-global-facts',payload:{operationId:"novel-import-global-导入任务",expectedRosterRevision:0,core,characterEntries,generationRunHandle:handle}},f.execution)
 const committed=ImportRunRepository.commitEffectReceipt(f.slot.runId,'global','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)
 expect(committed.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT genre FROM project_core').pluck().get()).toBe('现实')
 ImportRunRepository.advanceStage(f.slot.runId,'global','style',f.execution)
 const styleSlot={...f.slot,stage:'style' as const}
 const style=f.owner.begin({...f.selection,operation:'analyze-writing-style',promptKeys:['analyze_writing_style'],skillStages:[],output:'visible-text',modelId:'后来不同模型',importSlot:styleSlot})
 expect(style.handle.rootActionId).toBe(handle.rootActionId)
 expect(f.owner.readImportGeneration(styleSlot)?.modelId).toBe('synthetic')
 await f.owner.executeImportGeneration({execution:f.execution,handle:style.handle,ordinal:0,task:{...task,output:'visible-text'}})
 return Object.assign(f,{style,styleSlot})
}
it('已完成global与style各自usage未知仍共享root，不能把其他slot的unknown usage误判为远端unknown', async () => {
 const f = await globalEffect()
 const attempts = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as { attempt_json:string; usage_receipt_json:string }[]
 expect(attempts).toHaveLength(2)
 for (const row of attempts) {
   expect(JSON.parse(row.attempt_json).status).toBe('unknown')
   expect(JSON.parse(row.usage_receipt_json).result).toMatchObject({ finishReason:'stop', usage:{ trusted:false } })
 }
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
 expect(f.owner.read(f.style.handle).ledger?.physicalRequests).toBe(2)
 expect(f.owner.begin({ ...f.selection, operation:'analyze-writing-style', promptKeys:['analyze_writing_style'],
   skillStages:[], output:'visible-text', importSlot:f.styleSlot, uiActionNonce:'style重新加入' }).handle).toEqual(f.style.handle)
 expect(f.spy).toHaveBeenCalledTimes(2)
})

it.each(['inference', 'endpoint', 'dropped', 'rejected-delta'] as const)('导入角色提议从持久%s产物恢复来源并经作者批准采用', async kind => {
 const f = await globalEffect(kind)
 const stored = f.db.prepare("SELECT proposal_id,raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").get() as { proposal_id: string; raw_value: string }
 const envelope = JSON.parse(stored.raw_value); envelope.proof.provenance = null
 const legacy = JSON.stringify(envelope)
 f.db.prepare('UPDATE character_identity_proposals SET raw_value=?,source_hash=? WHERE proposal_id=?').run(legacy, createHash('sha256').update(legacy).digest('hex'), stored.proposal_id)
 const [summary] = f.owner.characterProposals.listPendingFinalized()
 expect(summary.importOperationId).toBe('novel-import-global-导入任务')
 const batch = f.owner.characterProposals.readPendingFinalized(summary.proposalBatchId)
 expect(batch.source.kind).toBe('import')
 const approved = f.owner.characterProposals.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
   operationId: '作者采用导入角色', selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' })) })
 expect(approved.created).toHaveLength(kind === 'endpoint' ? 4 : 3)
 expect(f.db.prepare('SELECT name,static_provenance FROM characters WHERE retired=0').get()).toMatchObject({ name: '林岚', static_provenance: expect.stringContaining('generated') })
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([])
})
it('待处理的导入角色提议带上导入用途与角色人数，供界面写成作者看得懂的标题', async () => {
 const f = await globalEffect('inference')
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([expect.objectContaining({
   importOperationId: 'novel-import-global-导入任务', importPurpose: 'reference', itemCount: 3 })])
 f.db.prepare("UPDATE import_runs SET purpose='author-manuscript' WHERE id='导入任务'").run()
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([expect.objectContaining({ importPurpose: 'author-manuscript', itemCount: 3 })])
})
it.each(['unproven', 'forged'] as const)('拒绝把%s导入payload当作生成角色来源', async kind => {
 const f = await globalEffect(kind)
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([])
 const id = f.db.prepare('SELECT proposal_id FROM character_identity_proposals').pluck().get() as string
 const batch = f.owner.characterProposals.read(id)
 expect(() => f.owner.characterProposals.approve({ proposalBatchId:id, expectedRevision:batch.revision, operationId:'伪造来源采用',
   selections:batch.items.map(item => ({ selectionKey:item.selectionKey, action:'create' })) })).toThrow('CHARACTER_PROPOSAL_PROVENANCE_REQUIRED')
 expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
})
it('真实global effect后style继承原root/model，prepared旧epoch重开直接guard提交',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'克制而具体',generationRunHandle:handle}},f.execution)
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task:{...task,output:'visible-text'}})).rejects.toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const artifact=f.owner.read(handle).artifacts[0]!
 expect(()=>f.owner.discardCandidate(handle,artifact.artifactId)).toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const next=f.reopenStorage()
 const saved=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),next.assertImportGenerationSources)
 expect(saved.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('克制而具体')
 f.db.exec("UPDATE project_core SET writing_style='作者后来修改'")
 const replay=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),()=>{throw new Error('ACK不得重验来源')})
 expect(replay.receipt).toEqual(saved.receipt)
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者后来修改')
 expect(f.spy).toHaveBeenCalledTimes(2)
})
it('prepared style在来源改变后拒绝提交且不污染作者值',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'模型文风',generationRunHandle:handle}},f.execution)
 f.db.exec("UPDATE project_core SET writing_style='作者新文风'")
 expect(()=>ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)).toThrow()
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者新文风')
 expect(ImportRunRepository.getEffectReceipt(f.slot.runId,'style','done')?.state).toBe('prepared')
})

it('拒绝与导入stage不符的模板和输出合同',()=>{
 const f=fixture()
 expect(()=>f.owner.begin({...f.selection,promptKeys:['analyze_writing_style']})).toThrow()
 expect(()=>f.owner.begin({...f.selection,output:'visible-text'})).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it.each(['missing','expired'] as const)('新ordinal拒绝%s导入执行权限，零派发',async kind=>{
 const f=fixture(),handle=f.owner.begin(f.selection).handle
 if(kind==='expired') f.db.exec('UPDATE import_runs SET lease_expires_at=0')
 await expect(f.owner.executeImportGeneration({handle,ordinal:0,task,...(kind==='expired'?{execution:f.execution}:{})})).rejects.toThrow()
 expect(f.spy).not.toHaveBeenCalled()
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
})
