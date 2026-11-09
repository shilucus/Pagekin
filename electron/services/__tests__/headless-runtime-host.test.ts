import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  HeadlessRuntimeHost,
  ProjectExclusiveLockError,
  ProjectExclusiveLockManager,
} from '../headless-runtime-host'

describe('HEADLESS-001: Production Headless Host and Exclusive Desktop Fencing', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'pagekin-headless-test-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('manages independent headless host lifecycle and reports health probe', async () => {
    const host = new HeadlessRuntimeHost({ hostId: 'headless-worker-1' })
    expect(host.getHealth().status).toBe('stopped')

    host.start()
    const health = host.getHealth()
    expect(health.status).toBe('healthy')
    expect(health.hostId).toBe('headless-worker-1')
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(health.activeProjectsCount).toBe(0)
    expect(health.memoryUsage.rssBytes).toBeGreaterThan(0)

    await host.drainAndStop()
    expect(host.getHealth().status).toBe('stopped')
  })

  it('enforces exclusive ownership when desktop and headless compete for the same project', () => {
    // 1. 模拟桌面宿主先获得了项目锁
    const desktopEpoch = 'desktop-epoch-001'
    const desktopLock = ProjectExclusiveLockManager.acquireLock(
      tempRoot,
      'desktop',
      'desktop-main-window',
      desktopEpoch,
    )
    expect(desktopLock.hostType).toBe('desktop')
    expect(desktopLock.executionEpoch).toBe(desktopEpoch)

    // 2. Headless 宿主尝试注册同一作品，被排他性拒绝
    const headlessHost = new HeadlessRuntimeHost({ hostId: 'headless-agent-1' })
    headlessHost.start()

    expect(() => {
      headlessHost.registerProject(tempRoot)
    }).toThrow(ProjectExclusiveLockError)

    try {
      headlessHost.registerProject(tempRoot)
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectExclusiveLockError)
      expect((error as ProjectExclusiveLockError).code).toBe('PROJECT_EXCLUSIVE_LOCK_HELD')
      expect((error as ProjectExclusiveLockError).currentLock?.hostType).toBe('desktop')
      expect((error as ProjectExclusiveLockError).currentLock?.hostId).toBe('desktop-main-window')
    }
  })

  it('fences out legacy owner when takeover occurs with a newer epoch', () => {
    const desktopEpoch = 'desktop-epoch-001'
    ProjectExclusiveLockManager.acquireLock(tempRoot, 'desktop', 'desktop-main', desktopEpoch)

    // 此时旧桌面确认锁有效
    expect(() => ProjectExclusiveLockManager.assertLockValid(tempRoot, desktopEpoch)).not.toThrow()

    // 3. 授权无窗口宿主接管（Takeover）该作品
    const headlessHost = new HeadlessRuntimeHost({ hostId: 'headless-takeover-host' })
    headlessHost.start()
    const newLock = headlessHost.takeoverProject(tempRoot)
    expect(newLock.hostType).toBe('headless')
    expect(newLock.executionEpoch).not.toBe(desktopEpoch)

    // 4. 旧桌面宿主尝试再次提交写操作，在边界被 Fencing Out 拦截
    expect(() => {
      ProjectExclusiveLockManager.assertLockValid(tempRoot, desktopEpoch)
    }).toThrow(ProjectExclusiveLockError)

    try {
      ProjectExclusiveLockManager.assertLockValid(tempRoot, desktopEpoch)
    } catch (error) {
      expect((error as ProjectExclusiveLockError).code).toBe('PROJECT_WRITE_FENCED_OUT')
    }

    // 5. 新宿主验证锁有效
    expect(() => {
      ProjectExclusiveLockManager.assertLockValid(tempRoot, newLock.executionEpoch)
    }).not.toThrow()

    // 6. 旧宿主尝试释放锁被拒绝（不能释放别人的新锁）
    const legacyRelease = ProjectExclusiveLockManager.releaseLock(tempRoot, desktopEpoch)
    expect(legacyRelease).toBe(false)
    expect(ProjectExclusiveLockManager.readLock(tempRoot)?.executionEpoch).toBe(newLock.executionEpoch)

    // 7. 新宿主安全释放锁
    const validRelease = headlessHost.unregisterProject(tempRoot)
    expect(validRelease).toBe(true)
    expect(ProjectExclusiveLockManager.readLock(tempRoot)).toBeNull()
  })
})
