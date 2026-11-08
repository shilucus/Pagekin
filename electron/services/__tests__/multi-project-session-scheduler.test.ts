import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import {
  MainGenerationScheduler,
} from '../generation-scheduler'
import type { MainProcessSchedulerPolicy } from '../main-process-scheduler'

const strictMultiProjectPolicy: MainProcessSchedulerPolicy = {
  global: 4,
  provider: 4,
  credential: 4,
  model: 2,
  project: 1, // 严格限制单项目活跃并发为 1
  maxQueued: 10,
  maxQuarantined: 2,
  interactiveBurst: 2,
}

function createModel(id: string, name = 'custom-model'): ModelProfile {
  return {
    id,
    name,
    provider: 'custom',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret-key-123',
    modelName: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2000,
    purposes: ['generation'],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SCHED-002 Multi-Project Session Scheduler Concurrency & Queue Isolation', () => {
  it('AC-2: 各项目拥有独立活动并发预算，一书达到上限排队时绝不阻塞另一本书 (Multi-Project Isolation)', async () => {
    const scheduler = new MainGenerationScheduler(strictMultiProjectPolicy, 8)
    const model = createModel('prof-1')

    // 1. 项目 A 发起第一个请求，获得许可并占用项目 A 的唯一并发配额
    const permitA1 = await scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    })
    expect(permitA1).toBeDefined()

    // 2. 项目 A 发起第二个请求，由于超过单项目并发上限 (project: 1)，该请求进入排队，不会立即 resolve
    let a2Resolved = false
    const promiseA2 = scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    }).then(p => {
      a2Resolved = true
      return p
    })

    // 等待微任务刷新，确认 A2 确实在排队等待中
    await Promise.resolve()
    expect(a2Resolved).toBe(false)
    expect(scheduler.getStats().queued).toBe(1)
    expect(scheduler.getStats().active).toBe(1)

    // 3. 此时独立的项目 B 发起请求，由于 projectKey 不同，不受项目 A 排队阻塞，应立即成功获得许可
    let b1Resolved = false
    const promiseB1 = scheduler.acquire({
      projectKey: 'project-book-b',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    }).then(p => {
      b1Resolved = true
      return p
    })

    // 项目 B 的许可应立即被分配
    const permitB1 = await promiseB1
    expect(b1Resolved).toBe(true)
    expect(permitB1).toBeDefined()
    expect(scheduler.getStats().active).toBe(2) // A1 和 B1 同时活跃
    expect(scheduler.getStats().queued).toBe(1) // A2 仍在排队

    // 4. 清理并释放许可
    permitB1.finish()
    expect(scheduler.getStats().active).toBe(1)

    permitA1.finish() // 释放 A1 后，A2 应当从队列出列获得许可
    const permitA2 = await promiseA2
    expect(a2Resolved).toBe(true)
    expect(scheduler.getStats().queued).toBe(0)
    expect(scheduler.getStats().active).toBe(1)

    permitA2.finish()
    expect(scheduler.getStats().active).toBe(0)
    scheduler.close()
  })

  it('AC-3: 取消信号 (AbortSignal) 触发排队出列并立即回收本地并发预算', async () => {
    const scheduler = new MainGenerationScheduler(strictMultiProjectPolicy, 8)
    const model = createModel('prof-2')

    // 占用项目 A 活跃配额
    const permitA1 = await scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    })

    // 第二个请求附带可取消信号
    const controller = new AbortController()
    const promiseA2 = scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: controller.signal,
    })

    expect(scheduler.getStats().queued).toBe(1)

    // 触发取消
    controller.abort()

    // 应当拒绝并抛出 SCHEDULER_CANCELLED
    await expect(promiseA2).rejects.toThrow('SCHEDULER_CANCELLED')

    // 排队计数与预算立即回收
    expect(scheduler.getStats().queued).toBe(0)

    permitA1.finish()
    expect(scheduler.getStats().active).toBe(0)
    scheduler.close()
  })

  it('AC-3: 远端未知/不可恢复故障调用 quarantine 放入有界隔离区，防止无限重发与无限补槽', async () => {
    const scheduler = new MainGenerationScheduler(strictMultiProjectPolicy, 8)
    const model = createModel('prof-3')

    const permit = await scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    })

    expect(scheduler.getStats().active).toBe(1)
    expect(scheduler.getStats().quarantined).toBe(0)

    // 模拟远端故障时将凭据有界隔离
    permit.quarantine()

    // 确认隔离计数增加，且活跃计数已安全回收
    expect(scheduler.getStats().active).toBe(0)
    expect(scheduler.getStats().quarantined).toBe(1)

    // 在隔离期内的凭据不允许盲目 reset，防止并发重入引发更多未知请求
    expect(() => scheduler.resetCredential(model)).toThrow('SCHEDULER_CREDENTIAL_BUSY')

    // 确认本地连接确认终止后，调用 finish 结束隔离
    permit.finish()
    expect(scheduler.getStats().quarantined).toBe(0)

    // 此时可以安全重置并恢复该凭据状态
    scheduler.resetCredential(model)
    expect(scheduler.getStats().blockedCredentials).toBe(0)

    scheduler.close()
  })

  it('AC-1: 关闭项目或调度器注销时拒绝所有排队任务，零跨会话遗留', async () => {
    const scheduler = new MainGenerationScheduler(strictMultiProjectPolicy, 8)
    const model = createModel('prof-4')

    const permit = await scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    })

    const queuedPromise = scheduler.acquire({
      projectKey: 'project-book-a',
      model,
      lane: 'interactive',
      signal: new AbortController().signal,
    })

    expect(scheduler.getStats().queued).toBe(1)

    // 关闭调度器
    scheduler.close()

    // 排队任务立即被拒绝，不能跨会话悬挂
    await expect(queuedPromise).rejects.toThrow('SCHEDULER_CLOSED')
    expect(scheduler.getStats().queued).toBe(0)

    permit.finish()
  })
})
