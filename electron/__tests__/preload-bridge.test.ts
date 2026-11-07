import { describe, expect, it, vi } from 'vitest'
import type { AiNovelAPI } from '../../src/shared/desktop-api'
import { PROJECT_RUNTIME_OPEN_VIEW_CHANNEL } from '../../src/shared/project-runtime-contract'
import { RUNTIME_FEEDBACK_CHANNELS } from '../../src/shared/runtime-feedback-contract'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), once: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
}))
vi.mock('electron', () => electron)
await import('../preload')

describe('桌面预加载接口', () => {
  it('仅提供规范接口，事件回调不暴露 Electron 事件对象', async () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
    expect(name).toBe('aiNovelAPI')
    const listener = vi.fn()
    const unsubscribe = bridge.on('project:opened', listener)
    const [, handler] = electron.ipcRenderer.on.mock.calls[0] as [string, (...args: unknown[]) => void]
    const privateEvent = { sender: '不应进入渲染进程' }
    handler(privateEvent, { projectId: '项目甲' })
    expect(listener).toHaveBeenCalledWith({ projectId: '项目甲' })
    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('project:opened', handler)
    electron.ipcRenderer.invoke.mockResolvedValue({ success: true })
    await expect(bridge.invoke('project:open', '合成项目')).resolves.toEqual({ success: true })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('project:open', '合成项目')
  })
  it('原桥逐项转发专用反馈请求和冻结会话，不签发或改写授权', async () => {
    const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
    const request = { target: 'premise' }
    const session = Object.freeze({ projectId: 'fixture-project', leaseId: 'fixture-lease', projectPath: 'C:/fictional-project' })
    const result = { baseId: 'fixture-base' }
    electron.ipcRenderer.invoke.mockResolvedValueOnce(result)
    await expect(bridge.invoke('planning-feedback:v1:capture', request, session)).resolves.toBe(result)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('planning-feedback:v1:capture', request, session)
    expect(request).toEqual({ target: 'premise' })
    expect(Object.keys(session)).toEqual(['projectId', 'leaseId', 'projectPath'])
  })
  it('forwards only the literal retained-view entry without manufacturing a project lease', async () => {
    const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
    const target = { grantId: 'fictional-open-grant' }
    const result = { success: true }
    electron.ipcRenderer.invoke.mockResolvedValueOnce(result)
    await expect(bridge.invoke(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-request', null)).resolves.toBe(result)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-request', null)
    const callsBefore = electron.ipcRenderer.invoke.mock.calls.length
    await expect(bridge.invoke('project-runtime:v2:open-view', target, 'fictional-request', null))
      .rejects.toThrow('PROJECT_RUNTIME_CHANNEL_NOT_ALLOWED')
    await expect(bridge.invoke('project-runtime:v1:dispatch', target))
      .rejects.toThrow('PROJECT_RUNTIME_CHANNEL_NOT_ALLOWED')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(callsBefore)
  })
  it('forwards only closed runtime-feedback literals without manufacturing an execution grant', async () => {
    const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
    const request = Object.freeze({ grantId: 'fictional-reference' })
    for (const channel of RUNTIME_FEEDBACK_CHANNELS) {
      await bridge.invoke(channel, request)
      expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, request)
    }
    const calls = electron.ipcRenderer.invoke.mock.calls.length
    for (const channel of ['runtime-feedback:v2:prepare', 'runtime-feedback:v1:adopt', 'runtime-feedback:v1:execute-any']) {
      await expect(bridge.invoke(channel, request)).rejects.toThrow('RUNTIME_FEEDBACK_CHANNEL_NOT_ALLOWED')
    }
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(calls)
  })
})
