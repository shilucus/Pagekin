import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Feature {
  id: string
  status: string
  passes: boolean
  dependsOn: string[]
  requiredEvidenceTypes: string[]
  evidence: { type: string }[]
}

const planRoot = new URL('../../docs/plans/2026-11-07-creation-runtime-modernization/', import.meta.url)
const plan = JSON.parse(readFileSync(new URL('features.json', planRoot), 'utf8')) as {
  schemaVersion: number
  planSource: { path: string; version: string; sha256: string }
  features: Feature[]
}

describe('creation runtime feature completion evidence', () => {
  it('keeps the 35-feature checklist bound to its frozen F2 source', () => {
    expect(plan.schemaVersion).toBe(1)
    expect(plan.features).toHaveLength(35)
    expect(new Set(plan.features.map(feature => feature.id)).size).toBe(35)
    expect(plan.planSource.version).toBe('F2')
    const source = readFileSync(fileURLToPath(new URL(plan.planSource.path, planRoot)))
    expect(createHash('sha256').update(source).digest('hex').toUpperCase()).toBe(plan.planSource.sha256.toUpperCase())
  })

  it.each(plan.features)('$id does not claim completion without declared evidence and dependencies', feature => {
    expect(feature.passes).toBe(feature.status === 'completed')
    if (!feature.passes) return

    // Evidence labels are a necessary record check, not runtime or quality acceptance.
    const recordedTypes = new Set(feature.evidence.map(record => record.type))
    expect(feature.requiredEvidenceTypes.filter(type => !recordedTypes.has(type))).toEqual([])
    for (const dependencyId of feature.dependsOn) {
      const dependency = plan.features.find(candidate => candidate.id === dependencyId)
      expect(dependency, `Missing dependency ${dependencyId}`).toBeDefined()
      expect(dependency?.status, `${feature.id} depends on ${dependencyId}`).toBe('completed')
      expect(dependency?.passes).toBe(true)
    }
  })
})
