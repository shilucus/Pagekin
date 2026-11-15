import { describe, expect, it } from 'vitest'
import { isWorkflowBackgroundQualified } from '../workflow-background-qualification'

describe('isWorkflowBackgroundQualified (UI-001 / ADR-0049)', () => {
  it('rejects runs without projectSession', () => {
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: null })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'batch_generate' })).toBe(false)
  })

  it('rejects runs without leaseId in projectSession', () => {
    expect(isWorkflowBackgroundQualified({
      type: 'novel_import',
      projectSession: { projectId: 'p1', leaseId: '', projectPath: 'C:\\p1' },
    })).toBe(false)
  })

  it('keeps import protected even when explicitly marked as qualified', () => {
    const session = { projectId: 'p1', leaseId: 'lease-123', projectPath: 'C:\\p1' }
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: session })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: session, backgroundQualified: true })).toBe(false)
  })

  it('accepts only the admitted whole-reference variant, not a variant marker alone', () => {
    const session = { projectId: 'p1', leaseId: 'lease-123', projectPath: 'C:\\p1' }
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: session,
      backgroundExecution: 'reference-run' })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: session,
      backgroundExecution: 'reference-run', backgroundQualified: true })).toBe(true)
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: null,
      backgroundExecution: 'reference-run', backgroundQualified: true })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'batch_generate', projectSession: session,
      backgroundExecution: 'reference-run', backgroundQualified: true })).toBe(false)
  })

  it('keeps batch generation protected even when explicitly marked as qualified', () => {
    const session = { projectId: 'p1', leaseId: 'lease-123', projectPath: 'C:\\p1' }
    expect(isWorkflowBackgroundQualified({ type: 'batch_generate', projectSession: session })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'batch_generate', projectSession: session, backgroundQualified: true })).toBe(false)
  })

  it('rejects unmigrated workflows without explicit qualification', () => {
    const session = { projectId: 'p1', leaseId: 'lease-123', projectPath: 'C:\\p1' }
    expect(isWorkflowBackgroundQualified({ type: 'new_project_setup', projectSession: session })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'architecture_generation', projectSession: session })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'directory', projectSession: session })).toBe(false)
  })

  it('accepts explicitly marked backgroundQualified runs only with valid session', () => {
    expect(isWorkflowBackgroundQualified({
      type: 'custom_task',
      backgroundQualified: true,
    })).toBe(false)

    const session = { projectId: 'p1', leaseId: 'lease-123', projectPath: 'C:\\p1' }
    expect(isWorkflowBackgroundQualified({
      type: 'custom_task',
      projectSession: session,
      backgroundQualified: true,
    })).toBe(true)
  })
})
