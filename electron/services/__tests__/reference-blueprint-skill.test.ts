import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinWritingSkills } from '../../../src/shared/builtin-writing-skills'
import { injectWritingSkillPrompt } from '../../../src/shared/writing-skill-task'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { blueprintSlot, importGenerationFixture, openSlot } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const cleanup: (() => void)[] = []
const runId = '\u957f\u7bc7\u5bfc\u5165'
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const task: GenerationTask = { purpose: 'chapter-blueprint-directory', output: 'structured-data', reasoningStage: 'planning',
  messages: [{ role: 'system', content: 'Fictional immutable contract' }, { role: 'user', content: 'Fictional frozen chapter' }] }

describe('main-only reference blueprint planning Skill material', () => {
  it.each(['zh-CN', 'en-US'] as const)('retains the same localized %s Skill task without persisting transient material', language => {
    const f = importGenerationFixture(cleanup, 1)
    f.db.prepare('UPDATE project_core SET writing_language=? WHERE id=\'main\'').run(language)
    f.db.prepare("UPDATE import_runs SET stage='blueprints' WHERE id=?").run(runId)
    fs.writeFileSync(path.join(f.root, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'builtin:long-form-continuity' } }))
    const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner').execution
    const handle = openSlot(f, blueprintSlot(runId, f.chapters), execution)
    const builtin = getBuiltinWritingSkills().find(skill => skill.metadata.name === 'long-form-continuity')!
    const expected = { name: builtin.metadata.displayName ?? builtin.metadata.name, content: builtin.localizedContent?.[language] ?? builtin.content }
    const material = f.owner.readImportPlanningSkill(handle)
    expect(material).toEqual(expected)
    expect(injectWritingSkillPrompt(task, language, material)).toEqual(injectWritingSkillPrompt(task, language, expected))
    const binding = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId) as string
    expect(binding).not.toContain('importPlanningSkill')
    expect(binding).not.toContain(expected.content)
    expect(f.owner.readImportPlanningSkill(handle)).not.toBe(material)
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('does not choose a default Skill for an unbound blueprint slot', () => {
    const f = importGenerationFixture(cleanup, 1)
    f.db.prepare("UPDATE import_runs SET stage='blueprints' WHERE id=?").run(runId)
    const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner').execution
    const handle = openSlot(f, blueprintSlot(runId, f.chapters), execution)
    expect(f.owner.readImportPlanningSkill(handle)).toBeNull()
    expect(injectWritingSkillPrompt(task, 'zh-CN', f.owner.readImportPlanningSkill(handle))).toEqual({ task })
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('rejects a changed blueprint Skill binding instead of switching prompt content', () => {
    const f = importGenerationFixture(cleanup, 1)
    f.db.prepare("UPDATE import_runs SET stage='blueprints' WHERE id=?").run(runId)
    const target = path.join(f.root, 'writing-skills.json')
    fs.writeFileSync(target, JSON.stringify({ version: 1, bindings: { planning: 'builtin:long-form-continuity' } }))
    const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner').execution
    const handle = openSlot(f, blueprintSlot(runId, f.chapters), execution)
    fs.writeFileSync(target, JSON.stringify({ version: 1, bindings: {} }))
    expect(() => f.owner.readImportPlanningSkill(handle)).toThrow('GENERATION_IMPORT_CONTEXT_CHANGED')
    expect(f.spy).not.toHaveBeenCalled()
  })
})
