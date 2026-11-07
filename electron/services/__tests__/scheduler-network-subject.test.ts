import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { SchedulerNetworkSubjectRegistry } from '../scheduler-network-subject'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'one', name: 'test', provider: 'custom', protocol: 'openai',
    baseUrl: 'https://example.test/v1', apiKey: 'fake-secret-key', modelName: 'remote-model',
    temperature: 0.7, maxTokens: 100, purposes: ['generation'], ...overrides,
  }
}

describe('SchedulerNetworkSubjectRegistry', () => {
  it('groups protocol aliases by origin, credential and remote model', () => {
    const registry = new SchedulerNetworkSubjectRegistry(20)
    const a = registry.capture(profile())
    const b = registry.capture(profile({ id: 'two', provider: 'openai', baseUrl: 'https://EXAMPLE.test:443/other?q=1#part', modelName: 'other' }))
    const c = registry.capture(profile({ protocol: 'gemini', apiKey: '\t fake-secret-key  ' }))
    expect(b.subject.provider).toBe(a.subject.provider)
    expect(b.subject.credential).toBe(a.subject.credential)
    expect(b.subject.model).not.toBe(a.subject.model)
    expect(c.subject.credential).toBe(a.subject.credential)
    expect(c.subject.model).toBe(a.subject.model)
    expect(registry.capture(profile({ protocol: 'anthropic' })).subject.model).toBe(a.subject.model)
    expect(registry.capture(profile({ protocol: 'gemini', modelName: 'other-model' })).subject.model)
      .not.toBe(c.subject.model)
    expect(registry.capture(profile({ modelName: ' remote-model' })).subject.model).not.toBe(a.subject.model)
    expect(registry.capture(profile({ apiKey: 'fake-rotated-key' })).subject.credential).not.toBe(a.subject.credential)
    const other = registry.capture(profile({ baseUrl: 'https://other.test' }))
    expect(other.subject.provider).not.toBe(a.subject.provider)
    expect(other.subject.credential).not.toBe(a.subject.credential)
    expect(other.subject.model).not.toBe(a.subject.model)
    expect(registry.capture(profile({ apiKey: '' })).subject.credential)
      .toBe(registry.capture(profile({ id: 'anonymous', apiKey: '' })).subject.credential)
  })

  it('enforces capacity atomically and reclaims only after the last release', () => {
    const registry = new SchedulerNetworkSubjectRegistry(3)
    const a = registry.capture(profile())
    const b = registry.capture(profile({ id: 'alias' }))
    expect(registry.stats()).toEqual({ subjects: 3, leases: 2 })
    expect(() => registry.capture(profile({ apiKey: 'new-key', modelName: 'new-model' })))
      .toThrow('SCHEDULER_SUBJECT_CAPACITY_EXCEEDED')
    expect(registry.stats()).toEqual({ subjects: 3, leases: 2 })
    a.release()
    a.release()
    expect(registry.stats()).toEqual({ subjects: 3, leases: 1 })
    const c = registry.capture(profile())
    expect(c.subject).toEqual(b.subject)
    b.release()
    c.release()
    expect(registry.stats()).toEqual({ subjects: 0, leases: 0 })
    expect(registry.capture(profile()).subject).not.toEqual(a.subject)
  })

  it('recognizes only live objects issued by this registry', () => {
    const registry = new SchedulerNetworkSubjectRegistry(3)
    const a = registry.capture(profile())
    const b = registry.capture(profile())
    registry.assertActive(a.subject)
    expect(() => registry.assertActive({ ...a.subject })).toThrow('SCHEDULER_SUBJECT_INVALID')
    expect(() => new SchedulerNetworkSubjectRegistry(3).assertActive(a.subject)).toThrow('SCHEDULER_SUBJECT_INVALID')
    a.release()
    expect(() => registry.assertActive(a.subject)).toThrow('SCHEDULER_SUBJECT_INVALID')
    expect(() => registry.assertActive(b.subject)).not.toThrow()
  })

  it('retains the grouping beyond capture release until the scheduler releases it', () => {
    const registry = new SchedulerNetworkSubjectRegistry(3)
    const a = registry.capture(profile())
    expect(() => registry.retain({ ...a.subject })).toThrow('SCHEDULER_SUBJECT_INVALID')
    const release = registry.retain(a.subject)
    a.release()
    expect(() => registry.retain(a.subject)).toThrow('SCHEDULER_SUBJECT_INVALID')
    const b = registry.capture(profile({ id: 'alias' }))
    expect(b.subject).toEqual(a.subject)
    b.release()
    expect(registry.stats()).toEqual({ subjects: 3, leases: 1 })
    release()
    release()
    expect(registry.stats()).toEqual({ subjects: 0, leases: 0 })
    expect(registry.capture(profile()).subject).not.toEqual(a.subject)
  })

  it('does not expose inputs in output, errors or counts and does not mutate the snapshot', () => {
    const registry = new SchedulerNetworkSubjectRegistry(3)
    const model = profile()
    const before = structuredClone(model)
    const lease = registry.capture(model)
    expect(model).toEqual(before)
    expect(Object.isFrozen(lease.subject)).toBe(true)
    const output = JSON.stringify([lease, registry, registry.stats()])
    expect(output).not.toContain(model.apiKey)
    expect(output).not.toContain(model.baseUrl)
    expect(output).not.toContain(model.modelName)
    for (const baseUrl of ['bad-secret-url', 'https://user:secret@example.test', 'file:///secret']) {
      try {
        registry.capture(profile({ baseUrl }))
        throw new Error('expected rejection')
      } catch (error) {
        expect(String(error)).toBe('Error: SCHEDULER_SUBJECT_ENDPOINT_INVALID')
      }
    }
    expect(() => new SchedulerNetworkSubjectRegistry(Infinity)).toThrow('SCHEDULER_SUBJECT_CAPACITY_INVALID')
  })
})
