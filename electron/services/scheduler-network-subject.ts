import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import type { ModelProfile } from '../../src/shared/ipc-channels'

export interface SchedulerNetworkSubject {
  readonly provider: string
  readonly credential: string
  readonly model: string
}

export interface SchedulerNetworkSubjectLease {
  readonly subject: SchedulerNetworkSubject
  release(): void
}

interface Entry {
  readonly ref: string
  references: number
}

/** Main-process-only grouping. This is not an authorization or source proof. */
export class SchedulerNetworkSubjectRegistry {
  readonly #key = randomBytes(32)
  readonly #entries = new Map<string, Entry>()
  readonly #issued = new WeakMap<SchedulerNetworkSubject, { keys: string[]; entries: Entry[] }>()
  readonly #maxSubjects: number
  #leases = 0

  constructor(maxSubjects: number) {
    if (!Number.isSafeInteger(maxSubjects) || maxSubjects <= 0) {
      throw new Error('SCHEDULER_SUBJECT_CAPACITY_INVALID')
    }
    this.#maxSubjects = maxSubjects
  }

  capture(model: ModelProfile): SchedulerNetworkSubjectLease {
    let endpoint: URL
    try {
      endpoint = new URL(model.baseUrl.trim())
    } catch {
      throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
    }
    // Fetch rejects URL credentials on some adapters; another adapter strips them.
    // Do not silently treat those differing requests as one credential identity.
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
      throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
    }
    const origin = endpoint.origin
    // Header processing strips HTTP whitespace at the edges. Coalescing leading
    // whitespace also conservatively groups Bearer and direct-key adapters.
    const credential = model.apiKey.replace(/^[\t ]+|[\t ]+$/gu, '')
    const digest = (parts: string[]) => createHmac('sha256', this.#key)
      .update(JSON.stringify(parts)).digest('hex')
    const keys = [
      digest(['provider', origin]),
      digest(['credential', origin, credential]),
      digest(['model', origin, model.modelName]),
    ]
    const missing = keys.filter(key => !this.#entries.has(key)).length
    if (this.#entries.size + missing > this.#maxSubjects) {
      throw new Error('SCHEDULER_SUBJECT_CAPACITY_EXCEEDED')
    }

    const entries = keys.map(key => this.#entries.get(key) ?? { ref: randomUUID(), references: 0 })
    entries.forEach((entry, index) => {
      entry.references += 1
      this.#entries.set(keys[index], entry)
    })
    this.#leases += 1
    const subject = Object.freeze({ provider: entries[0].ref, credential: entries[1].ref, model: entries[2].ref })
    this.#issued.set(subject, { keys, entries })
    let released = false
    return Object.freeze({
      subject,
      release: () => {
        if (released) return
        released = true
        this.#issued.delete(subject)
        entries.forEach((entry, index) => {
          entry.references -= 1
          if (entry.references === 0) this.#entries.delete(keys[index])
        })
        this.#leases -= 1
      },
    })
  }

  assertActive(subject: SchedulerNetworkSubject): void {
    if (!this.#issued.has(subject)) throw new Error('SCHEDULER_SUBJECT_INVALID')
  }

  /** The scheduler holds this independently until the physical request ends. */
  retain(subject: SchedulerNetworkSubject): () => void {
    const issued = this.#issued.get(subject)
    if (!issued) throw new Error('SCHEDULER_SUBJECT_INVALID')
    issued.entries.forEach(entry => { entry.references += 1 })
    this.#leases += 1
    let released = false
    return () => {
      if (released) return
      released = true
      issued.entries.forEach((entry, index) => {
        entry.references -= 1
        if (entry.references === 0) this.#entries.delete(issued.keys[index])
      })
      this.#leases -= 1
    }
  }

  /** Counts only; identifiers and secret-derived indexes stay private. */
  stats(): Readonly<{ subjects: number; leases: number }> {
    return Object.freeze({ subjects: this.#entries.size, leases: this.#leases })
  }
}
