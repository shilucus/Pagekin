import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import type { TrustedProject } from './project-access'
import { SchemaMigrationError } from '../migrations/registry'
import { deactivateProjectData, getCanonicalProjectIdentity, getProjectDatabasePath, getProjectDataRoot, openCanonicalProjectData } from './project-data-locator'
import { readSqliteContentIdentity } from './sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

export interface OpenProjectDatabase {
  readonly projectPath: string
  readonly projectId: string
  readonly projectStorageRoot: string
  readonly database: BetterSqlite3.Database
  /** Per-native-handle identity, not the mutable database/WAL content digest. */
  readonly databaseIdentity: object
}

export interface ProjectRuntime extends OpenProjectDatabase {
  readonly canonicalRoot: string
  readonly executionEpoch: string
  readonly phase: 'opening' | 'open' | 'closing' | 'closed'
}

export interface PreparedRuntimeOpen {
  readonly runtime: ProjectRuntime
  readonly reused: boolean
}

/** The new view is durable and published; only the captured previous close failed. */
export class ProjectRuntimePreviousCloseError extends Error {
  readonly code = 'PROJECT_RUNTIME_PREVIOUS_CLOSE_FAILED'

  constructor(readonly previousRuntime: ProjectRuntime, readonly activeRuntime: ProjectRuntime, cause: unknown) {
    super('PROJECT_RUNTIME_PREVIOUS_CLOSE_FAILED', { cause })
    this.name = 'ProjectRuntimePreviousCloseError'
  }
}

export interface ProjectDatabaseBeforeCloseContext { projectPath: string; database: BetterSqlite3.Database }
const beforeCloseListeners = new Set<(context: ProjectDatabaseBeforeCloseContext) => void>()
const openedHandles = new WeakSet<OpenProjectDatabase>()
const closingHandles = new WeakSet<OpenProjectDatabase>()

function synchronousResult(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {})
    throw new Error('PROJECT_DATABASE_BEFORE_CLOSE_MUST_BE_SYNCHRONOUS')
  }
}

export function onProjectDatabaseBeforeClose(listener: (context: ProjectDatabaseBeforeCloseContext) => void): () => void {
  beforeCloseListeners.add(listener)
  return () => { beforeCloseListeners.delete(listener) }
}

/** Verified handle preparation may upgrade schema, but does not fence import owners. */
export function openVerifiedProjectDatabase(projectPath: string, expectedProjectId?: string): OpenProjectDatabase {
  const identity = getCanonicalProjectIdentity(projectPath)
  if (expectedProjectId !== undefined && identity.projectId !== expectedProjectId) throw new Error('PROJECT_RUNTIME_IDENTITY_MISMATCH')
  let database: BetterSqlite3.Database | undefined
  try {
    const verified = openCanonicalProjectData(identity.canonicalRoot)
    const databasePath = getProjectDatabasePath(identity.canonicalRoot)
    database = new Database(databasePath, { fileMustExist: true })
    // An unused handle has not opened WAL; refusal cannot checkpoint the source.
    const content = readSqliteContentIdentity(databasePath)
    if (content.database !== verified.database || content.wal !== verified.wal) throw new SchemaMigrationError('SOURCE_CHANGED_SINCE_PROBE')
    const current = getCanonicalProjectIdentity(identity.canonicalRoot)
    if (current.projectId !== identity.projectId) throw new Error('PROJECT_RUNTIME_IDENTITY_MISMATCH')
    getProjectDataRoot(identity.canonicalRoot)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    const opened = Object.freeze({ projectPath: identity.canonicalRoot, projectId: identity.projectId,
      projectStorageRoot: identity.projectStorageRoot, database, databaseIdentity: Object.freeze({}) })
    openedHandles.add(opened)
    return opened
  } catch (error) {
    database?.close()
    deactivateProjectData(identity.canonicalRoot)
    throw error
  }
}

export function closeCapturedProjectDatabase(opened: OpenProjectDatabase): void {
  closeOpenedDatabase(opened)
}

function closeOpenedDatabase(opened: OpenProjectDatabase, beforeNativeClose?: () => void): void {
  if (!openedHandles.has(opened)) throw new Error('PROJECT_DATABASE_HANDLE_INVALID')
  if (closingHandles.has(opened)) throw new Error('PROJECT_DATABASE_CLOSE_REENTRANT')
  closingHandles.add(opened)
  try {
    for (const listener of beforeCloseListeners) synchronousResult(listener({ projectPath: opened.projectPath, database: opened.database }))
    beforeNativeClose?.()
    opened.database.close()
    deactivateProjectData(opened.projectPath)
    openedHandles.delete(opened)
  } finally { closingHandles.delete(opened) }
}

/** Session ownership changes remain separate from schema migration. */
export function fenceProjectSession(db: BetterSqlite3.Database): void {
  db.exec(`
    UPDATE import_runs
    SET execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE status = 'running' AND (execution_owner <> '' OR lease_expires_at <> 0)
  `)
}

interface RuntimeEntry {
  readonly opened: OpenProjectDatabase
  readonly runtime: ProjectRuntime
  phase: ProjectRuntime['phase']
  readonly tickets: Set<PreparedRuntimeOpen>
  retained: boolean
}

const rootKey = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root

/** Main-only resource ownership. Neither a runtime nor its epoch is a grant. */
export class ProjectRuntimeHost {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly tickets = new WeakMap<PreparedRuntimeOpen, RuntimeEntry>()
  private readonly busyPredicates = new Set<(runtime: ProjectRuntime) => boolean>()
  private readonly releaseListeners = new Set<(runtime: ProjectRuntime) => void>()
  private activeView: ProjectRuntime | null = null
  private legacyOperations = 0
  private restoreOperation = false
  private viewCommitInProgress = false
  private compatibilityOpen: { previous: ProjectRuntime | null; ticket: PreparedRuntimeOpen | null } | null = null
  private readonly retainedTickets = new WeakSet<PreparedRuntimeOpen>()

  prepareOpen(project: TrustedProject): PreparedRuntimeOpen {
    this.assertLifecycleAllowed()
    return this.prepareProjectOpen(project)
  }

  /** Explicit retain is process-local resource policy, never execution authority. */
  prepareRetainedOpen(project: TrustedProject): PreparedRuntimeOpen {
    const ticket = this.prepareOpen(project)
    this.retainedTickets.add(ticket)
    return ticket
  }

  assertCompatibilityOpenAvailable(): void {
    this.assertLifecycleAllowed()
    this.compatibilityPrevious()
  }

  /** Hold the single-book transition until its exact ticket commits or aborts. */
  prepareCompatibilityOpen(project: TrustedProject): PreparedRuntimeOpen {
    this.assertLifecycleAllowed()
    const pending = { previous: null as ProjectRuntime | null, ticket: null as PreparedRuntimeOpen | null }
    this.compatibilityOpen = pending
    try {
      pending.previous = this.compatibilityPrevious()
      pending.ticket = this.prepareProjectOpen(project)
      return pending.ticket
    } catch (error) {
      this.compatibilityOpen = null
      throw error
    }
  }

  private prepareProjectOpen(project: TrustedProject): PreparedRuntimeOpen {
    const identity = getCanonicalProjectIdentity(project.rootPath)
    if (project.kind !== 'manifest' || identity.projectId !== project.projectId) throw new Error('PROJECT_RUNTIME_IDENTITY_MISMATCH')
    const key = rootKey(identity.canonicalRoot)
    let entry = this.entries.get(key)
    const reused = !!entry
    if (entry) {
      if (entry.runtime.projectId !== project.projectId) throw new Error('PROJECT_RUNTIME_IDENTITY_MISMATCH')
      this.assertEntry(entry, true)
      getProjectDataRoot(entry.runtime.canonicalRoot)
    } else {
      const opened = openVerifiedProjectDatabase(identity.canonicalRoot, project.projectId)
      const state = { phase: 'opening' as ProjectRuntime['phase'] }
      const runtime: ProjectRuntime = Object.freeze({ ...opened, canonicalRoot: opened.projectPath, executionEpoch: randomUUID(),
        get phase() { return state.phase } })
      entry = { opened, runtime, get phase() { return state.phase }, set phase(value) { state.phase = value }, tickets: new Set(), retained: false }
      this.entries.set(key, entry)
    }
    const ticket = Object.freeze({ runtime: entry.runtime, reused })
    entry.tickets.add(ticket)
    this.tickets.set(ticket, entry)
    return ticket
  }

  commitOpen(ticket: PreparedRuntimeOpen): ProjectRuntime {
    this.assertLifecycleAllowed()
    const entry = this.requireTicket(ticket)
    this.assertEntry(entry, true)
    getProjectDataRoot(entry.runtime.canonicalRoot)
    if (entry.phase === 'opening') fenceProjectSession(entry.opened.database)
    entry.phase = 'open'
    if (this.retainedTickets.has(ticket)) entry.retained = true
    this.consumeTicket(ticket, entry)
    return entry.runtime
  }

  /** All fallible access/session probes run before the native transaction. */
  assertViewOpenAvailable(ticket: PreparedRuntimeOpen): void {
    this.assertLifecycleAllowed(ticket)
    const entry = this.requireTicket(ticket)
    this.assertEntry(entry, true)
    getProjectDataRoot(entry.runtime.canonicalRoot)
  }

  /** publishSession is the access service's IO-free lease assignment, not a lifecycle hook. */
  commitViewOpen<T>(ticket: PreparedRuntimeOpen, operation: (runtime: ProjectRuntime) => T, publishSession?: () => void): T {
    this.assertViewOpenAvailable(ticket)
    const entry = this.requireTicket(ticket)
    const compatibility = this.compatibilityOpen
    const previous = compatibility?.previous ?? null
    if (previous) {
      const previousEntry = this.requireRuntime(previous)
      this.assertEntry(previousEntry, false)
      this.assertIdle(previousEntry, previous === entry.runtime ? ticket : undefined)
    }
    if (entry.opened.database.inTransaction) throw new Error('PROJECT_RUNTIME_TRANSACTION_ACTIVE')
    if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') {
      throw new Error('PROJECT_RUNTIME_VIEW_OPERATION_MUST_BE_SYNCHRONOUS')
    }
    this.viewCommitInProgress = true
    try {
      const value = entry.opened.database.transaction(() => {
        const result = operation(entry.runtime)
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => {})
          throw new Error('PROJECT_RUNTIME_VIEW_OPERATION_MUST_BE_SYNCHRONOUS')
        }
        this.assertEntry(entry, true)
        if (entry.phase === 'opening') fenceProjectSession(entry.opened.database)
        return result
      }).immediate()
      // These publications must stay IO-free: the native transaction has committed.
      entry.phase = 'open'
      if (this.retainedTickets.has(ticket)) entry.retained = true
      this.consumeTicket(ticket, entry)
      this.activeView = entry.runtime
      publishSession?.()
      if (previous && previous !== entry.runtime) {
        try { this.releaseEntry(this.requireRuntime(previous)) }
        catch (error) { throw new ProjectRuntimePreviousCloseError(previous, entry.runtime, error) }
      }
      return value
    } finally {
      this.viewCommitInProgress = false
      if (compatibility && !entry.tickets.has(ticket)) this.compatibilityOpen = null
    }
  }

  abortOpen(ticket: PreparedRuntimeOpen): void {
    this.assertLifecycleAllowed(ticket)
    const entry = this.requireTicket(ticket)
    try {
      this.consumeTicket(ticket, entry)
      // A reused/committed runtime belongs to the host, not this open request.
      if (entry.phase !== 'opening' || entry.tickets.size > 0) return
      entry.phase = 'closing'
      closeOpenedDatabase(entry.opened)
      entry.phase = 'closed'
      this.entries.delete(rootKey(entry.runtime.canonicalRoot))
    } finally {
      if (this.compatibilityOpen?.ticket === ticket) this.compatibilityOpen = null
    }
  }

  assertOpen(runtime: ProjectRuntime): void {
    if (this.viewCommitInProgress) throw new Error('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
    if (this.compatibilityOpen) throw new Error('PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY')
    const entry = this.requireRuntime(runtime)
    this.assertEntry(entry, false)
    getProjectDataRoot(runtime.canonicalRoot)
  }

  getByRoot(projectPath: string): ProjectRuntime | null {
    const identity = getCanonicalProjectIdentity(projectPath)
    const runtime = this.entries.get(rootKey(identity.canonicalRoot))?.runtime ?? null
    if (runtime && runtime.projectId !== identity.projectId) throw new Error('PROJECT_RUNTIME_IDENTITY_MISMATCH')
    return runtime
  }

  getOpenRuntimes(): readonly ProjectRuntime[] {
    return Object.freeze([...this.entries.values()].map(entry => entry.runtime))
  }

  getActiveView(): ProjectRuntime | null { return this.activeView }

  /** Check before create-side filesystem effects; this grants no project access. */
  assertLifecycleAvailable(): void { this.assertLifecycleAllowed() }

  activateView(runtime: ProjectRuntime | null): void {
    this.assertLifecycleAllowed()
    if (runtime) this.assertOpen(runtime)
    this.activeView = runtime
  }

  releaseIdle(runtime: ProjectRuntime): void {
    this.assertLifecycleAllowed()
    this.releaseEntry(this.requireRuntime(runtime))
  }

  private releaseEntry(entry: RuntimeEntry): void {
    const { runtime } = entry
    // Revoked/changed manifests cannot authorize work, but must not prevent
    // safely releasing the already captured native handle.
    this.assertEntry(entry, false)
    this.assertIdle(entry)
    entry.phase = 'closing'
    // Any flush/KB/native failure quarantines this exact entry in closing.
    closeOpenedDatabase(entry.opened, () => {
      for (const listener of this.releaseListeners) synchronousResult(listener(runtime))
    })
    entry.phase = 'closed'
    this.entries.delete(rootKey(runtime.canonicalRoot))
    if (this.activeView === runtime) this.activeView = null
  }

  registerBusyPredicate(predicate: (runtime: ProjectRuntime) => boolean): () => void {
    this.busyPredicates.add(predicate)
    return () => { this.busyPredicates.delete(predicate) }
  }

  onBeforeRelease(listener: (runtime: ProjectRuntime) => void): () => void {
    this.releaseListeners.add(listener)
    return () => { this.releaseListeners.delete(listener) }
  }

  acquireLegacyOperation(channel: string): () => void {
    void channel
    if (this.viewCommitInProgress) throw new Error('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
    if (this.restoreOperation) throw new Error('PROJECT_RUNTIME_RESTORE_BUSY')
    if (this.compatibilityOpen) throw new Error('PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY')
    if (this.entries.size !== 1 || !this.activeView) throw new Error('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    this.assertOpen(this.activeView)
    if ([...this.entries.values()].some(entry => entry.tickets.size > 0)) throw new Error('PROJECT_RUNTIME_BUSY')
    this.legacyOperations++
    let released = false
    return () => { if (!released) { released = true; this.legacyOperations-- } }
  }

  /** Isolated-copy restore has no current-project requirement or execution grant. */
  acquireRestoreOperation(): () => void {
    this.assertLifecycleAllowed()
    if ([...this.entries.values()].some(entry => entry.phase !== 'open' || entry.tickets.size > 0)) throw new Error('PROJECT_RUNTIME_BUSY')
    this.restoreOperation = true
    let released = false
    return () => { if (!released) { released = true; this.restoreOperation = false } }
  }

  private assertLifecycleAllowed(ticket?: PreparedRuntimeOpen): void {
    if (this.viewCommitInProgress) throw new Error('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
    if (this.legacyOperations > 0) throw new Error('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    if (this.restoreOperation) throw new Error('PROJECT_RUNTIME_RESTORE_BUSY')
    if (this.compatibilityOpen && (!ticket || this.compatibilityOpen.ticket !== ticket)) {
      throw new Error('PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY')
    }
  }

  private assertIdle(entry: RuntimeEntry, allowedTicket?: PreparedRuntimeOpen): void {
    if ([...entry.tickets].some(ticket => ticket !== allowedTicket)
      || [...this.busyPredicates].some(predicate => predicate(entry.runtime))) throw new Error('PROJECT_RUNTIME_BUSY')
  }

  private compatibilityPrevious(): ProjectRuntime | null {
    if (this.entries.size === 0 && !this.activeView) return null
    if (this.entries.size !== 1 || !this.activeView) throw new Error('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
    const entry = this.requireRuntime(this.activeView)
    this.assertEntry(entry, false)
    if (entry.retained) throw new Error('PROJECT_RUNTIME_RETAINED')
    this.assertIdle(entry)
    return entry.runtime
  }

  private requireRuntime(runtime: ProjectRuntime): RuntimeEntry {
    const entry = this.entries.get(rootKey(runtime.canonicalRoot))
    if (!entry || entry.runtime !== runtime) throw new Error('PROJECT_RUNTIME_HANDLE_INVALID')
    return entry
  }

  private assertEntry(entry: RuntimeEntry, allowOpening: boolean): void {
    const { runtime, opened } = entry
    if (runtime.database !== opened.database || runtime.databaseIdentity !== opened.databaseIdentity
      || !openedHandles.has(opened) || !opened.database.open) throw new Error('PROJECT_RUNTIME_DATABASE_CHANGED')
    if (entry.phase !== 'open' && !(allowOpening && entry.phase === 'opening')) throw new Error('PROJECT_RUNTIME_NOT_OPEN')
  }

  private requireTicket(ticket: PreparedRuntimeOpen): RuntimeEntry {
    const entry = this.tickets.get(ticket)
    if (!entry || !entry.tickets.has(ticket) || ticket.runtime !== entry.runtime) throw new Error('PROJECT_RUNTIME_TICKET_INVALID')
    return entry
  }

  private consumeTicket(ticket: PreparedRuntimeOpen, entry: RuntimeEntry): void {
    entry.tickets.delete(ticket)
    this.tickets.delete(ticket)
    this.retainedTickets.delete(ticket)
  }
}

export const projectRuntimeHost = new ProjectRuntimeHost()
