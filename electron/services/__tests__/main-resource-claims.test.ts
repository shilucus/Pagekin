import { describe, expect, it } from 'vitest'
import type { WorkflowResourceClaims } from '../../../src/shared/workflow-resource-claims'
import { MainResourceClaimRegistry, normalizeMainResourceClaims } from '../main-resource-claims'

describe('main resource claims', () => {
  it('normalizes, sorts and freezes both resource classes without mutating the caller', () => {
    const resourceKeys = [' z ', 'a', '', 'a']
    const claims = normalizeMainResourceClaims({ resourceKeys, readResourceKeys: ['b', ' a ', 'b'] })
    expect(claims).toEqual({ resourceKeys: ['a', 'z'], readResourceKeys: ['a', 'b'] })
    expect(resourceKeys).toEqual([' z ', 'a', '', 'a'])
    expect(Object.isFrozen(claims)).toBe(true)
    expect(Object.isFrozen(claims.resourceKeys)).toBe(true)
    expect(Object.isFrozen(claims.readResourceKeys)).toBe(true)
    expect(normalizeMainResourceClaims()).toEqual({ resourceKeys: undefined, readResourceKeys: undefined })
  })

  it.each([
    [{ readResourceKeys: ['chapter:1'] }, { readResourceKeys: ['chapter:1'] }, true],
    [{ resourceKeys: ['chapter:1'] }, { readResourceKeys: ['chapter:1'] }, false],
    [{ readResourceKeys: ['chapter:1'] }, { resourceKeys: ['chapter:1'] }, false],
    [{ resourceKeys: ['chapter:1'] }, { resourceKeys: ['chapter:1'] }, false],
    [{ resourceKeys: ['chapter:1'] }, { resourceKeys: ['chapter:10'] }, true],
  ] satisfies [WorkflowResourceClaims, WorkflowResourceClaims, boolean][])(
    'reuses exact shared conflict semantics %#', (held, requested, available) => {
      const registry = new MainResourceClaimRegistry()
      const first = registry.tryAcquire('fictional-a', held)!
      const second = registry.tryAcquire('fictional-a', requested)
      expect(second !== null).toBe(available)
      second?.release()
      first.release()
      expect(registry.getStats()).toEqual({ active: 0 })
    },
  )

  it('isolates the same logical key by exact project identity', () => {
    const registry = new MainResourceClaimRegistry()
    const first = registry.tryAcquire('fictional-a', { resourceKeys: ['chapter:1'] })!
    const second = registry.tryAcquire('fictional-ab', { resourceKeys: ['chapter:1'] })!
    expect(second).not.toBeNull()
    first.release()
    expect(registry.tryAcquire('fictional-ab', { readResourceKeys: ['chapter:1'] })).toBeNull()
    second.release()
  })

  it('acquires all keys synchronously or none and duplicate release cannot release another owner', () => {
    const registry = new MainResourceClaimRegistry()
    const first = registry.tryAcquire('fictional-a', { resourceKeys: ['z'] })!
    expect(registry.tryAcquire('fictional-a', { resourceKeys: ['a', 'z'] })).toBeNull()
    const second = registry.tryAcquire('fictional-a', { resourceKeys: ['a'] })!
    expect(second).not.toBeNull()
    expect(registry.getStats()).toEqual({ active: 2 })
    first.release()
    first.release()
    expect(registry.tryAcquire('fictional-a', { resourceKeys: ['a'] })).toBeNull()
    expect(registry.getStats()).toEqual({ active: 1 })
    second.release()
    const all = registry.tryAcquire('fictional-a', { resourceKeys: ['z', 'a'] })!
    all.release()
  })

  it('snapshots claims and exposes counts only', () => {
    const registry = new MainResourceClaimRegistry()
    const keys = ['fictional-private-resource']
    const lease = registry.tryAcquire('fictional-private-project', { resourceKeys: keys })!
    keys[0] = 'changed'
    expect(registry.tryAcquire('fictional-private-project', { resourceKeys: ['fictional-private-resource'] })).toBeNull()
    expect(JSON.stringify(registry.getStats())).toBe('{"active":1}')
    lease.release()
  })

  it('notifies release subscribers once after a real release and supports idempotent unsubscribe', () => {
    const registry = new MainResourceClaimRegistry()
    let releases = 0
    const unsubscribe = registry.onRelease(() => {
      releases += 1
      expect(registry.getStats().active).toBe(0)
    })
    const first = registry.tryAcquire('fictional-a', { resourceKeys: ['chapter:1'] })!
    expect(registry.tryAcquire('fictional-a', { resourceKeys: ['chapter:1'] })).toBeNull()
    expect(releases).toBe(0)
    first.release()
    first.release()
    expect(releases).toBe(1)
    unsubscribe()
    unsubscribe()
    registry.tryAcquire('fictional-a')!.release()
    expect(releases).toBe(1)
  })
})
