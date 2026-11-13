import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkPermitLifetime } from '../network-permit-lifetime'

afterEach(() => { vi.useRealTimers() })

describe('network permit physical lifetime', () => {
  it('keeps logical completion occupied and parks once after the cleanup grace', async () => {
    vi.useFakeTimers()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const controller = new AbortController()
    const lifetime = createNetworkPermitLifetime(permit, controller.signal)
    lifetime.logicalEnd()
    controller.abort()
    lifetime.logicalEnd()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(permit.finish).not.toHaveBeenCalled()
    expect(permit.quarantine).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(permit.quarantine).toHaveBeenCalledOnce()
    expect(permit.finish).not.toHaveBeenCalled()
    lifetime.finish()
    lifetime.finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(permit.finish).toHaveBeenCalledOnce()
    expect(permit.quarantine).toHaveBeenCalledOnce()
  })

  it('clears the grace and abort listener only at physical finish', async () => {
    vi.useFakeTimers()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const lifetime = createNetworkPermitLifetime(permit, controller.signal)
    lifetime.logicalEnd()
    lifetime.finish()
    controller.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
    expect(permit.finish).toHaveBeenCalledOnce()
    expect(permit.quarantine).not.toHaveBeenCalled()
  })

  it('retains a refused quarantine without retrying or replacing physical finish', async () => {
    vi.useFakeTimers()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => false) }
    const lifetime = createNetworkPermitLifetime(permit)
    lifetime.logicalEnd()
    await vi.advanceTimersByTimeAsync(20_000)
    lifetime.logicalEnd()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(permit.quarantine).toHaveBeenCalledOnce()
    expect(permit.finish).not.toHaveBeenCalled()
    lifetime.finish()
    expect(permit.finish).toHaveBeenCalledOnce()
  })

  it('starts the grace for an already aborted signal without releasing admission', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const lifetime = createNetworkPermitLifetime(permit, controller.signal)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(permit.quarantine).toHaveBeenCalledOnce()
    expect(permit.finish).not.toHaveBeenCalled()
    lifetime.finish()
  })
})
