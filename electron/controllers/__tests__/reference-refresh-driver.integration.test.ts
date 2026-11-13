import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate } from '../../../src/i18n/core'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { ReferenceKnowledgeReference } from '../../../src/shared/reference-knowledge-contract'

type Handler = (event: { sender: Sender }, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', isPackaged: false }, dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'fictional-global.json', MODELS_CONFIG_PATH: 'fictional-models.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  readJsonFile: (file: string) => file === 'fictional-global.json' ? { defaultEmbeddingModelId: 'fictional' } : [{
    id: 'fictional', provider: 'openai', protocol: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-key',
    modelName: 'fictional-model', embeddingOptions: { chunkSize: 1000, chunkOverlap: 0, batchSize: 1 },
  }] }))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en, getMainLocale: () => 'en-US' }))
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import * as vectorStore from '../../vector-store'
import { registerDatabaseController } from '../db-controller'
import { registerKBController } from '../kb-controller'
import { registerReferenceKnowledgeController } from '../reference-knowledge-controller'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

const RUN = 'fictional-refresh-run'
const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
type Execution = { owner: string; epoch: number; expiresAt: number }
type Issued = { reference: ReferenceKnowledgeReference; execution: Execution }
type RefreshEvent = { kind: 'refresh'; reference: ReferenceKnowledgeReference; execution: Pick<Execution, 'owner' | 'epoch'>; leaseId: string; sequence: number; token: string }
  | { kind: 'progress'; reference: ReferenceKnowledgeReference; execution: Pick<Execution, 'owner' | 'epoch'>; leaseId: string; sequence: number; progress: number }
type Response = { success: true; version: 1; run: unknown; execution: null; replayed: boolean }
  | { success: false; error: string; errorCode: string }
class Sender extends EventEmitter {
  readonly id = 51
  destroyed = false
  events: RefreshEvent[] = []
  evidence: unknown[] = []
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
  send(channel: string, value: unknown) {
    if (channel !== 'reference-knowledge:v1:refresh-progress') return
    this.events.push(value as RefreshEvent)
    this.evidence.push({ run: runRow(), grant: grantRow(), checkpoints: ImportRunRepository.get(RUN)?.completedBatches.refresh })
  }
}
let base = '', parent = '', root = ''
let session: ProjectSessionContext, subject: Sender, issued: Issued
let db: NonNullable<ReturnType<typeof getProjectDb>>
let pending: Promise<Response> | undefined
function verifyCleanup(): string {
  const target = path.resolve(parent)
  if (normal(path.dirname(target)) !== normal(base) || !path.basename(target).startsWith('pk-ref-refresh-')) throw new Error('FIXTURE_CLEANUP_OUTSIDE_BASE')
  for (const directory of [base, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) throw new Error('FIXTURE_CLEANUP_LINK')
  }
  const directories = [target]
  while (directories.length) {
    const directory = directories.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name), actual = fs.realpathSync.native(child)
      const relative = path.relative(target, actual)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || fs.lstatSync(child).isSymbolicLink() || normal(actual) !== normal(child)) throw new Error('FIXTURE_CLEANUP_LINK')
      if (entry.isDirectory()) directories.push(child)
    }
  }
  return target
}
function invoke<T>(channel: string, body: unknown, who = subject, view = session): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender: who }, body, view) as Promise<T>
}
function dbCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender: subject }, ...args, root, session) as Promise<T>
}
const authority = () => ({ owner: issued.execution.owner, epoch: issued.execution.epoch })
function start(): Promise<Response> {
  const flight = invoke<Response>('reference-knowledge:v1:refresh', { reference: issued.reference, execution: authority() })
  pending = flight; void flight.catch(() => undefined)
  return flight
}
async function projection(): Promise<RefreshEvent & { kind: 'refresh' }> {
  const wait = vi.waitFor(() => expect(subject.events.some(event => event.kind === 'refresh')).toBe(true), { timeout: 10_000 })
    .then(() => subject.events.find((event): event is RefreshEvent & { kind: 'refresh' } => event.kind === 'refresh')!)
  if (!pending) throw new Error('MISSING_REFRESH_FLIGHT')
  return Promise.race([wait, pending.then(result => { throw new Error(`REFRESH_BEFORE_PROJECTION:${result.success ? 'SUCCESS' : result.errorCode}`) })])
}
function ack(event: RefreshEvent & { kind: 'refresh' }, decision: 'completed' | 'failed' | 'cancelled' = 'completed', who = subject) {
  return invoke<{ version: 1 }>('reference-knowledge:v1:refresh-ack', { reference: issued.reference, execution: authority(), token: event.token, decision }, who)
}
function runRow() { return db.prepare('SELECT status,stage,execution_owner,execution_epoch,lease_expires_at,cancel_requested,last_error FROM import_runs WHERE id=?').get(RUN) }
function grantRow() { return db.prepare('SELECT state,revision,completed_at FROM reference_import_grants WHERE grant_id=?').get(issued.reference.grantId) }

beforeEach(async () => {
  mocks.handlers.clear(); pending = undefined
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('FICTIONAL_NETWORK_FORBIDDEN') }))
  base = fs.realpathSync.native(os.tmpdir()); parent = fs.mkdtempSync(path.join(base, 'pk-ref-refresh-'))
  const project = projectAccess.createProject(parent, 'Fictional refresh')
  createProjectDatabase(project.rootPath, Buffer.alloc(32, 44))
  const lease = projectAccess.beginSession(project)
  root = lease.rootPath; session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
  openCanonicalProjectFixture(root, Buffer.alloc(32, 44)); db = getProjectDb()!; subject = new Sender()
  registerReferenceKnowledgeController(); registerKBController(); registerDatabaseController()
  const content = 'A fictional chapter for the isolated reference import.'
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  ImportRunRepository.prepare({ runId: RUN, purpose: 'reference', sourceFingerprint: hash(RUN), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  issued = await invoke<Issued>('reference-knowledge:v1:prepare', { operationId: randomUUID(), runId: RUN, executionOwner: randomUUID() })
  // Isolate refresh; previous stages are not represented as having executed.
  db.prepare("UPDATE import_runs SET stage='refresh' WHERE id=?").run(RUN)
})
afterEach(async () => {
  try {
    subject?.destroy()
    if (pending) await pending.catch(() => undefined)
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId && normal(item.canonicalRoot) === normal(root))
    if (runtime) await projectRuntimeHost.requestClose(runtime)
    vectorStore.closeConnection(root)
    if (getCurrentProjectPath() && normal(getCurrentProjectPath()!) === normal(root)) closeProjectDatabase()
    if (db?.open) throw new Error('FIXTURE_DATABASE_STILL_OPEN')
    const current = projectAccess.captureCurrentSession()
    if (current?.projectId === session.projectId && current.leaseId === session.leaseId) projectAccess.invalidateCurrentSession()
  } finally {
    vi.unstubAllGlobals(); vi.restoreAllMocks()
    if (parent && !db?.open) removeTemporaryTree(verifyCleanup(), base)
    parent = ''; root = ''
  }
})

describe('registered foreground reference refresh with native storage', () => {
  it('waits for projection, checkpoints before 100, then completes the run before its original grant', async () => {
    const originalComplete = ImportRunRepository.complete
    const afterRunComplete: unknown[] = []
    const complete = vi.spyOn(ImportRunRepository, 'complete').mockImplementation((...args) => {
      const result = originalComplete.apply(ImportRunRepository, args)
      afterRunComplete.push({ run: runRow(), grant: grantRow() })
      return result
    })
    const flight = start(), event = await projection()
    expect(event).toMatchObject({ reference: issued.reference, execution: authority(), leaseId: session.leaseId, sequence: expect.any(Number), token: expect.any(String) })
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(runRow()).toMatchObject({ status: 'running', stage: 'refresh', execution_owner: issued.execution.owner })
    expect(grantRow()).toMatchObject({ state: 'active' }); expect(complete).not.toHaveBeenCalled()
    await expect(ack(event)).resolves.toEqual({ version: 1 })
    expect(await flight).toMatchObject({ success: true, version: 1, execution: null, replayed: false })
    expect(subject.events.map(item => item.kind)).toEqual(['refresh', 'progress'])
    expect(subject.events[1]).toMatchObject({ progress: 100, sequence: event.sequence + 1 })
    expect(subject.evidence[1]).toMatchObject({ run: { status: 'running', stage: 'refresh' }, grant: { state: 'active' }, checkpoints: ['done'] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(afterRunComplete).toMatchObject([{ run: { status: 'completed', execution_owner: '' }, grant: { state: 'active' } }])
    expect(runRow()).toMatchObject({ status: 'completed', stage: 'completed', execution_owner: '', execution_epoch: issued.execution.epoch + 1, lease_expires_at: 0 })
    expect(grantRow()).toMatchObject({ state: 'completed' }); expect(fetch).not.toHaveBeenCalled()
  })
  it('replays a real refresh checkpoint without projecting again', async () => {
    ImportRunRepository.completeBatch(RUN, 'refresh', 'done', issued.execution)
    expect(await start()).toMatchObject({ success: true, execution: null })
    expect(subject.events.map(event => event.kind)).toEqual(['progress'])
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh).toEqual(['done'])
    expect(grantRow()).toMatchObject({ state: 'completed' })
  })
  it('retains a completed run after a real grant update failure and retries only the original grant', async () => {
    db.exec("CREATE TRIGGER fictional_grant_failure BEFORE UPDATE OF state ON reference_import_grants WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional grant failure'); END")
    const complete = vi.spyOn(ImportRunRepository, 'complete')
    const flight = start(), event = await projection()
    await ack(event); expect(await flight).toMatchObject({ success: false })
    const completed = runRow(), checkpoint = ImportRunRepository.get(RUN)?.completedBatches.refresh, events = [...subject.events]
    expect(completed).toMatchObject({ status: 'completed', stage: 'completed', execution_owner: '', execution_epoch: issued.execution.epoch + 1, lease_expires_at: 0 })
    expect(grantRow()).toMatchObject({ state: 'active', revision: issued.reference.revision })
    db.exec('DROP TRIGGER fictional_grant_failure')
    const grant = grantRow(), request = { reference: issued.reference, execution: authority() }
    const fullRun = db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)
    const fullGrant = db.prepare('SELECT * FROM reference_import_grants WHERE grant_id=?').get(issued.reference.grantId)
    expect(await invoke<Response>('reference-knowledge:v1:refresh', request, new Sender())).toMatchObject({ success: false })
    expect(await invoke<Response>('reference-knowledge:v1:refresh', { ...request, execution: { ...authority(), epoch: authority().epoch + 1 } })).toMatchObject({ success: false })
    expect(runRow()).toEqual(completed); expect(grantRow()).toEqual(grant)
    expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)).toEqual(fullRun)
    expect(db.prepare('SELECT * FROM reference_import_grants WHERE grant_id=?').get(issued.reference.grantId)).toEqual(fullGrant)
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh).toEqual(checkpoint); expect(subject.events).toEqual(events)
    expect(await start()).toMatchObject({ success: true, execution: null, replayed: true })
    expect(runRow()).toEqual(completed); expect(ImportRunRepository.get(RUN)?.completedBatches.refresh).toEqual(checkpoint)
    expect(subject.events).toEqual(events); expect(complete).toHaveBeenCalledTimes(1)
    expect(grantRow()).toMatchObject({ state: 'completed' })
  })
  it('does not write the run, grant or checkpoint when replaying completed history', async () => {
    const first = start(), event = await projection()
    await ack(event); expect(await first).toMatchObject({ success: true })
    const beforeRun = runRow(), beforeGrant = grantRow(), beforeEvents = [...subject.events]
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution'), complete = vi.spyOn(ImportRunRepository, 'complete')
    db.exec("CREATE TRIGGER fictional_readonly_run BEFORE UPDATE ON import_runs BEGIN SELECT RAISE(ABORT,'unexpected run write'); END")
    db.exec("CREATE TRIGGER fictional_readonly_grant BEFORE UPDATE ON reference_import_grants BEGIN SELECT RAISE(ABORT,'unexpected grant write'); END")
    expect(await start()).toMatchObject({ success: true, execution: null, replayed: true })
    expect(runRow()).toEqual(beforeRun); expect(grantRow()).toEqual(beforeGrant); expect(subject.events).toEqual(beforeEvents)
    expect(renew).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled()
    expect(await invoke<Response>('reference-knowledge:v1:refresh', { reference: { ...issued.reference, revision: issued.reference.revision + 1 }, execution: authority() })).toMatchObject({ success: false })
    expect(runRow()).toEqual(beforeRun); expect(grantRow()).toEqual(beforeGrant); expect(subject.events).toEqual(beforeEvents)
    // Change the actual bound manifest in the isolated fixture after removing only the test's write sentinel.
    db.exec('DROP TRIGGER fictional_readonly_run')
    const original = db.prepare('SELECT manifest_fingerprint FROM import_runs WHERE id=?').pluck().get(RUN)
    db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(createHash('sha256').update('fictional changed manifest').digest('hex'), RUN)
    const changed = db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)
    const changedCheckpoint = ImportRunRepository.get(RUN)?.completedBatches.refresh
    try {
      expect(await start()).toMatchObject({ success: false })
      expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)).toEqual(changed)
      expect(ImportRunRepository.get(RUN)?.completedBatches.refresh).toEqual(changedCheckpoint)
      expect(grantRow()).toEqual(beforeGrant); expect(subject.events).toEqual(beforeEvents)
      expect(renew).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled()
    } finally { db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(original, RUN) }
  })
  it.each(['revoke', 'destroy'] as const)('cannot supplement a failed grant completion after %s', async kind => {
    db.exec("CREATE TRIGGER fictional_grant_failure BEFORE UPDATE OF state ON reference_import_grants WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional grant failure'); END")
    const flight = start(), event = await projection()
    await ack(event); expect(await flight).toMatchObject({ success: false })
    const completed = runRow()
    expect(completed).toMatchObject({ status: 'completed', execution_owner: '', lease_expires_at: 0 })
    expect(grantRow()).toMatchObject({ state: 'active' })
    db.exec('DROP TRIGGER fictional_grant_failure')
    if (kind === 'revoke') {
      const revoke = mocks.handlers.get('reference-knowledge:v1:revoke')!
      await revoke({ sender: subject }, issued.reference)
    } else subject.destroy()
    expect(grantRow()).toMatchObject({ state: 'revoked' })
    expect(await start()).toMatchObject({ success: false })
    expect(runRow()).toEqual(completed)
    expect(grantRow()).toMatchObject({ state: 'revoked' })
  })
  it('rejects foreign senders and invalid ACK tokens without finishing the live projection', async () => {
    const flight = start(), event = await projection(), stranger = new Sender()
    await expect(invoke('reference-knowledge:v1:refresh-ack', { reference: issued.reference, execution: authority(), token: 'fictional-invalid', decision: 'completed' })).rejects.toThrow()
    await expect(ack(event, 'completed', stranger)).rejects.toThrow()
    await expect(invoke('reference-knowledge:v1:refresh-ack', { reference: issued.reference, execution: { ...authority(), epoch: authority().epoch + 1 }, token: event.token, decision: 'completed' })).rejects.toThrow()
    await expect(invoke('reference-knowledge:v1:refresh-ack', { reference: issued.reference, execution: authority(), token: event.token, decision: 'completed' }, subject, { ...session, leaseId: randomUUID() })).rejects.toThrow()
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(await Promise.all([ack(event), ack(event)])).toEqual([{ version: 1 }, { version: 1 }])
    expect(await flight).toMatchObject({ success: true })
  })
  it('rejects stale execution without projecting or changing durable facts', async () => {
    const before = runRow(), grant = grantRow()
    const result = await invoke<Response>('reference-knowledge:v1:refresh', { reference: issued.reference, execution: { ...authority(), epoch: authority().epoch + 1 } })
    expect(result).toMatchObject({ success: false })
    expect(subject.events).toEqual([]); expect(runRow()).toEqual(before); expect(grantRow()).toEqual(grant)
  })
  it('accepts request cancellation while fencing legacy completion writers', async () => {
    const flight = start(), event = await projection()
    const code = 'GENERATION_OWNER_BUSY'
    const fenced = { success: false, errorCode: code, error: translate('en-US', 'error.importRunCheckFailed', { code }) }
    expect(await dbCall('db:import-run-complete-batch', RUN, 'refresh', 'done', issued.execution)).toMatchObject(fenced)
    expect(await dbCall('db:import-run-complete', RUN, issued.execution)).toMatchObject(fenced)
    const completeGrant = vi.spyOn(ReferenceImportGrantRepository.prototype, 'complete')
    await expect(invoke('reference-knowledge:v1:complete', issued.reference)).rejects.toThrow(
      translate('en-US', 'error.importRunCheckFailed', { code: 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED' }),
    )
    expect(completeGrant).not.toHaveBeenCalled()
    expect(grantRow()).toMatchObject({ state: 'active' })
    expect(await dbCall('db:import-run-get', RUN)).toMatchObject({ id: RUN, status: 'running' })
    expect(await dbCall('db:import-run-request-cancel', RUN, issued.execution)).toMatchObject({ success: true })
    await ack(event); expect(await flight).toMatchObject({ success: false })
    expect(runRow()).toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0, cancel_requested: 1 })
    expect(grantRow()).toMatchObject({ state: 'active' })
  })
  it('cannot change a successor after its execution is taken over', async () => {
    const flight = start(), event = await projection()
    db.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, RUN)
    const successor = ImportRunRepository.startOrResume(RUN, 'fictional-successor', Date.now(), 60_000).execution
    const before = runRow()
    expect(before).toMatchObject({ status: 'running', execution_owner: successor.owner, execution_epoch: successor.epoch })
    await ack(event).catch(() => undefined); expect(await flight).toMatchObject({ success: false })
    expect(runRow()).toEqual(before); expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
  })
  it('renews the actual same-owner lease while projection remains unacknowledged', async () => {
    const original = ImportRunRepository.renewExecution
    const renewals: Execution[] = []
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution').mockImplementation((id, lease, now, _leaseMs, context) => {
      const actual = original.call(ImportRunRepository, id, lease, now, 200, context)
      renewals.push(actual); return actual
    })
    const flight = start(), event = await projection()
    expect(renewals.length).toBeGreaterThan(0)
    const firstExpiry = renewals[0]!.expiresAt
    await vi.waitFor(() => {
      expect(Date.now()).toBeGreaterThan(firstExpiry)
      expect(renewals.length).toBeGreaterThanOrEqual(3)
    }, { timeout: 4_000, interval: 20 })
    expect(renewals.every(lease => lease.owner === issued.execution.owner && lease.epoch === issued.execution.epoch)).toBe(true)
    expect(runRow()).toMatchObject({ status: 'running', execution_owner: issued.execution.owner, execution_epoch: issued.execution.epoch })
    expect((runRow() as { lease_expires_at: number }).lease_expires_at).toBeGreaterThan(Date.now())
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    renew.mockRestore()
    await ack(event); expect(await flight).toMatchObject({ success: true })
  }, 60_000)
  it('retains projection failure over a later cancellation and leaves no refresh checkpoint', async () => {
    const flight = start(), event = await projection()
    await ack(event, 'failed')
    await dbCall('db:import-run-request-cancel', RUN, issued.execution)
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_REFRESH_PROJECTION_FAILED' })
    expect(runRow()).toMatchObject({ status: 'failed', execution_owner: '', lease_expires_at: 0 })
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(grantRow()).toMatchObject({ state: 'active' })
  })
  it('preserves an observed heartbeat source failure over later sender destruction during projection', async () => {
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    const originalRenew = ImportRunRepository.renewExecution
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution').mockImplementation((id, lease, now, _leaseMs, context) =>
      originalRenew.call(ImportRunRepository, id, lease, now, 200, context))
    const flight = start(); await projection()
    const originalManifest = db.prepare('SELECT manifest_fingerprint FROM import_runs WHERE id=?').pluck().get(RUN)
    const originalAssert = ReferenceImportGrantRepository.prototype.assertActive
    let observedFailure = false
    const guard = vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockImplementation(function (this: ReferenceImportGrantRepository, ref) {
      try { return originalAssert.call(this, ref) }
      catch (error) {
        observedFailure = error instanceof Error && error.message === 'REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH'
        throw error
      }
    })
    db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(createHash('sha256').update('fictional changed source').digest('hex'), RUN)
    try {
      await vi.waitFor(() => expect(observedFailure).toBe(true), { timeout: 4_000, interval: 10 })
      subject.destroy()
      expect(await flight).toMatchObject({ success: false, errorCode: 'REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH' })
      expect(runRow()).toMatchObject({ status: 'failed', execution_owner: '', lease_expires_at: 0 })
      expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    } finally {
      subject.destroy()
      await flight.catch(() => undefined)
      guard.mockRestore(); renew.mockRestore()
      db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(originalManifest, RUN)
      await projectRuntimeHost.requestClose(runtime)
      expect(db.open).toBe(false)
    }
  }, 60_000)
  it('rejects a changed reference manifest binding without completing the run or grant', async () => {
    const original = db.prepare('SELECT manifest_fingerprint FROM import_runs WHERE id=?').pluck().get(RUN)
    db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(createHash('sha256').update('other fictional manifest').digest('hex'), RUN)
    try {
      const result = await start()
      expect(result).toMatchObject({ success: false, errorCode: 'REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH' })
      expect(subject.events).toEqual([])
      expect(grantRow()).toMatchObject({ state: 'active' })
      expect(runRow()).not.toMatchObject({ status: 'completed' })
    } finally { db.prepare('UPDATE import_runs SET manifest_fingerprint=? WHERE id=?').run(original, RUN) }
  })
  it('rejects extra fields and a foreign view without admitting projection', async () => {
    const body = { reference: issued.reference, execution: authority() }
    const before = runRow()
    await expect(invoke('reference-knowledge:v1:refresh', { ...body, extra: true })).rejects.toThrow()
    const foreign = { ...session, leaseId: randomUUID() }
    expect(await invoke<Response>('reference-knowledge:v1:refresh', body, subject, foreign)).toMatchObject({ success: false })
    expect(subject.events).toEqual([]); expect(runRow()).toEqual(before)
  })
  it('persists cancellation when the live sender rejects the required refresh event', async () => {
    const send = subject.send.bind(subject)
    const attempted = vi.spyOn(subject, 'send').mockImplementation((channel, payload) => {
      if (channel === 'reference-knowledge:v1:refresh-progress' && (payload as RefreshEvent).kind === 'refresh') {
        throw new Error('fictional projection transport failure')
      }
      send(channel, payload)
    })
    expect(await start()).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(attempted).toHaveBeenCalledWith('reference-knowledge:v1:refresh-progress', expect.objectContaining({ kind: 'refresh' }))
    expect(subject.isDestroyed()).toBe(false)
    expect(runRow()).toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0, cancel_requested: 1 })
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(grantRow()).toMatchObject({ state: 'active' })
  })
  it('persists cancellation on a cancelled ACK without a prior cancellation request', async () => {
    const flight = start(), event = await projection()
    expect(runRow()).toMatchObject({ status: 'running', cancel_requested: 0 })
    await expect(ack(event, 'cancelled')).resolves.toEqual({ version: 1 })
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(subject.isDestroyed()).toBe(false)
    expect(runRow()).toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0, cancel_requested: 1 })
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(grantRow()).toMatchObject({ state: 'active' })
  })
  it('stops an impossible pending ACK on sender destruction without a checkpoint', async () => {
    const flight = start(); await projection(); subject.destroy()
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    expect(runRow()).toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0 })
  })
  it('stops the pending projection on close but waits for an actual retained runtime work claim', async () => {
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    const flight = start(); await projection()
    const release = projectRuntimeHost.acquireWork(runtime)
    let closed = false
    const closing = projectRuntimeHost.requestClose(runtime).then(() => { closed = true })
    try {
      expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
      expect(closed).toBe(false)
      expect(projectRuntimeHost.getOpenRuntimes()).toContain(runtime)
      expect(db.open).toBe(true)
      expect(runRow()).toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0 })
      expect(ImportRunRepository.get(RUN)?.completedBatches.refresh ?? []).toEqual([])
    } finally { release(); await closing }
    expect(closed).toBe(true)
  }, 60_000)
})
