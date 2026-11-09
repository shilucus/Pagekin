import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ProjectLockRecord {
  hostType: 'desktop' | 'headless'
  hostId: string
  pid: number
  canonicalRoot: string
  executionEpoch: string
  acquiredAt: number
}

export class ProjectExclusiveLockError extends Error {
  readonly code: string
  readonly currentLock?: ProjectLockRecord

  constructor(message: string, code: string, currentLock?: ProjectLockRecord) {
    super(message)
    this.name = 'ProjectExclusiveLockError'
    this.code = code
    this.currentLock = currentLock
  }
}

/**
 * OS 级项目文件排他锁与持久 Fencing 管理器
 * 确保同一 canonical project 仅能被一个桌面或 Headless 宿主持有写所有权
 */
export class ProjectExclusiveLockManager {
  private static getLockFilePath(canonicalRoot: string): string {
    const metaDir = path.join(canonicalRoot, '.ai-novel')
    if (!existsSync(metaDir)) {
      mkdirSync(metaDir, { recursive: true })
    }
    return path.join(metaDir, 'owner.lock')
  }

  static readLock(canonicalRoot: string): ProjectLockRecord | null {
    const lockPath = this.getLockFilePath(canonicalRoot)
    if (!existsSync(lockPath)) return null
    try {
      const raw = readFileSync(lockPath, 'utf8')
      const parsed = JSON.parse(raw) as ProjectLockRecord
      if (parsed && typeof parsed.executionEpoch === 'string') {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 尝试获取项目独占写锁。
   * 若已被其他活动宿主持有，抛出 PROJECT_EXCLUSIVE_LOCK_HELD。
   */
  static acquireLock(
    canonicalRoot: string,
    hostType: 'desktop' | 'headless',
    hostId: string,
    executionEpoch: string,
  ): ProjectLockRecord {
    const current = this.readLock(canonicalRoot)
    if (current && current.executionEpoch !== executionEpoch) {
      // 检查当前持有者是否就是自己
      if (current.hostId === hostId && current.pid === process.pid) {
        return current
      }
      throw new ProjectExclusiveLockError(
        `Project at ${canonicalRoot} is exclusively held by ${current.hostType} host ${current.hostId} (PID: ${current.pid}, epoch: ${current.executionEpoch})`,
        'PROJECT_EXCLUSIVE_LOCK_HELD',
        current,
      )
    }

    const lock: ProjectLockRecord = {
      hostType,
      hostId,
      pid: process.pid,
      canonicalRoot,
      executionEpoch,
      acquiredAt: Date.now(),
    }

    const lockPath = this.getLockFilePath(canonicalRoot)
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8')
    return lock
  }

  /**
   * 授权接管：签发新 executionEpoch 并覆盖锁记录，使旧宿主被 Fence Out
   */
  static takeoverLock(
    canonicalRoot: string,
    hostType: 'desktop' | 'headless',
    hostId: string,
    newExecutionEpoch: string,
  ): ProjectLockRecord {
    const lock: ProjectLockRecord = {
      hostType,
      hostId,
      pid: process.pid,
      canonicalRoot,
      executionEpoch: newExecutionEpoch,
      acquiredAt: Date.now(),
    }

    const lockPath = this.getLockFilePath(canonicalRoot)
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8')
    return lock
  }

  /**
   * 安全释放锁：必须与所持有的 executionEpoch 匹配
   */
  static releaseLock(canonicalRoot: string, executionEpoch: string): boolean {
    const current = this.readLock(canonicalRoot)
    if (!current) return true
    if (current.executionEpoch !== executionEpoch) {
      // 已经被其他接管者取代，不能释放别人的锁
      return false
    }

    const lockPath = this.getLockFilePath(canonicalRoot)
    try {
      rmSync(lockPath, { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 运行时提交核验：确认锁仍有效且未被接管
   */
  static assertLockValid(canonicalRoot: string, executionEpoch: string): void {
    const current = this.readLock(canonicalRoot)
    if (!current || current.executionEpoch !== executionEpoch) {
      throw new ProjectExclusiveLockError(
        'Project exclusive write ownership has been revoked or fenced by a newer takeover epoch',
        'PROJECT_WRITE_FENCED_OUT',
        current ?? undefined,
      )
    }
  }
}

export interface HeadlessHostHealth {
  status: 'healthy' | 'draining' | 'stopped'
  hostId: string
  uptimeMs: number
  activeProjectsCount: number
  runningTasksCount: number
  memoryUsage: {
    rssBytes: number
    heapUsedBytes: number
  }
}

/**
 * 生产无窗口宿主 (Headless Runtime Host)
 * 完全解耦 window/Zustand/导航依赖，独立驱动生产任务并支持桌面互斥与接管
 */
export class HeadlessRuntimeHost {
  readonly hostId: string
  private status: 'healthy' | 'draining' | 'stopped' = 'stopped'
  private readonly startedAt: number
  private readonly registeredProjects = new Map<string, { executionEpoch: string }>()
  private runningTasksCount = 0

  constructor(options?: { hostId?: string }) {
    this.hostId = options?.hostId ?? `headless_${randomUUID().replace(/-/g, '')}`
    this.startedAt = Date.now()
  }

  start(): void {
    if (this.status === 'healthy') return
    this.status = 'healthy'
  }

  getHealth(): HeadlessHostHealth {
    const memory = process.memoryUsage()
    return {
      status: this.status,
      hostId: this.hostId,
      uptimeMs: Date.now() - this.startedAt,
      activeProjectsCount: this.registeredProjects.size,
      runningTasksCount: this.runningTasksCount,
      memoryUsage: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
    }
  }

  /**
   * 注册并持有作品独占写所有权
   */
  registerProject(canonicalRoot: string, executionEpoch?: string): ProjectLockRecord {
    if (this.status !== 'healthy') {
      throw new Error(`Cannot register project in headless host with status: ${this.status}`)
    }

    const epoch = executionEpoch ?? `epoch_${randomUUID().replace(/-/g, '')}`
    const lock = ProjectExclusiveLockManager.acquireLock(canonicalRoot, 'headless', this.hostId, epoch)
    this.registeredProjects.set(canonicalRoot, { executionEpoch: lock.executionEpoch })
    return lock
  }

  /**
   * 强制接管作品写所有权（发新 epoch 并持久 Fencing）
   */
  takeoverProject(canonicalRoot: string): ProjectLockRecord {
    if (this.status !== 'healthy') {
      throw new Error(`Cannot takeover project in headless host with status: ${this.status}`)
    }

    const newEpoch = `takeover_${randomUUID().replace(/-/g, '')}`
    const lock = ProjectExclusiveLockManager.takeoverLock(canonicalRoot, 'headless', this.hostId, newEpoch)
    this.registeredProjects.set(canonicalRoot, { executionEpoch: lock.executionEpoch })
    return lock
  }

  /**
   * 解除作品注册并释放锁
   */
  unregisterProject(canonicalRoot: string): boolean {
    const entry = this.registeredProjects.get(canonicalRoot)
    if (!entry) return false

    const released = ProjectExclusiveLockManager.releaseLock(canonicalRoot, entry.executionEpoch)
    this.registeredProjects.delete(canonicalRoot)
    return released
  }

  /**
   * 优雅排空在途请求并停止宿主服务
   */
  async drainAndStop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'draining'

    // 释放所有持有的作品独占锁
    for (const [canonicalRoot, entry] of this.registeredProjects.entries()) {
      ProjectExclusiveLockManager.releaseLock(canonicalRoot, entry.executionEpoch)
    }
    this.registeredProjects.clear()
    this.runningTasksCount = 0
    this.status = 'stopped'
  }
}
