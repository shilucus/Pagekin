/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { initializeLegacyBaselineSchema } from './migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from './migrations/desktop-registry'
import { migrateSchema } from './migrations/runner'
import { SqliteSchemaAdapter } from './migrations/sqlite-schema-adapter'
import { getCanonicalProjectIdentity, getNewProjectDatabasePath } from './services/project-data-locator'
import { projectRuntimeHost } from './services/project-runtime'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

export { openVerifiedProjectDatabase, closeCapturedProjectDatabase, onProjectDatabaseBeforeClose, fenceProjectSession } from './services/project-runtime'
export type { OpenProjectDatabase, ProjectDatabaseBeforeCloseContext } from './services/project-runtime'

/** 初始化项目数据库（打开项目时调用） */
export function createProjectDatabase(projectPath: string, importSourceSecret?: Buffer): void {
  const file = getNewProjectDatabasePath(projectPath)
  const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd)
  const database = new Database(file, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    database.transaction(() => initializeLegacyBaselineSchema(database, importSourceSecret))()
    migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  } finally { database.close() }
}

/** Compatibility activation only: it never closes another captured runtime. */
export function initProjectDatabase(projectPath: string): void {
  const identity = getCanonicalProjectIdentity(projectPath)
  const ticket = projectRuntimeHost.prepareOpen({ kind: 'manifest', projectId: identity.projectId,
    rootPath: identity.canonicalRoot, storageFormat: 'canonical' })
  try {
    const runtime = projectRuntimeHost.commitOpen(ticket)
    projectRuntimeHost.activateView(runtime)
  } catch (error) {
    // commit/activation are synchronous; an unconsumed ticket owns only its preparation.
    if (ticket.runtime.phase === 'opening') projectRuntimeHost.abortOpen(ticket)
    throw error
  }
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  const runtime = projectRuntimeHost.getActiveView()
  if (runtime) projectRuntimeHost.releaseIdle(runtime)
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  const runtime = projectRuntimeHost.getActiveView()
  return runtime?.phase === 'open' && runtime.database.open ? runtime.database : null
}

/** 获取当前已打开项目路径 */
export function getCurrentProjectPath(): string | null {
  const runtime = projectRuntimeHost.getActiveView()
  return runtime?.phase === 'open' && runtime.database.open ? runtime.canonicalRoot : null
}
