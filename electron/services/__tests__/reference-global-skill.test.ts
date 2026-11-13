import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinWritingSkills, readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import { inspectInstalledWritingSkill } from '../../../src/shared/writing-skills'
import { injectWritingSkillPrompt } from '../../../src/shared/writing-skill-task'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { importGenerationFixture, openSlot } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const slot = { runId: '长篇导入', stage: 'global' as const, batchId: 'done' }
const task: GenerationTask = { purpose: 'import-inference', output: 'structured-data', reasoningStage: 'planning',
  messages: [{ role: 'system', content: 'Fictional immutable contract' }, { role: 'user', content: 'Fictional author facts' }] }

describe('main-only reference global planning Skill material', () => {
  it.each(['zh-CN', 'en-US'] as const)('retains exact builtin registration name,localized body and complete %s task without persisting material', language => {
    const f = importGenerationFixture(cleanup, 1)
    f.db.prepare("UPDATE project_core SET writing_language=? WHERE id='main'").run(language)
    fs.writeFileSync(path.join(f.root, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'builtin:long-form-continuity' } }))
    const execution = ImportRunRepository.startOrResume(slot.runId, 'fictional-owner').execution
    const handle = openSlot(f, slot, execution)
    const builtin = getBuiltinWritingSkills().find(skill => skill.metadata.name === 'long-form-continuity')!
    const expected = { name: builtin.metadata.displayName ?? builtin.metadata.name, content: builtin.localizedContent?.[language] ?? builtin.content }
    const material = f.owner.readImportPlanningSkill(handle)
    expect(material).toEqual(expected)
    const inspected = inspectInstalledWritingSkill(readBuiltinWritingSkill('long-form-continuity', language)!, { status: 'none' }, 'long-form-continuity')
    expect(material!.name).not.toBe(inspected.metadata.displayName)
    expect(injectWritingSkillPrompt(task, language, material)).toEqual(injectWritingSkillPrompt(task, language, expected))
    const binding = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId) as string
    expect(binding).not.toContain('importPlanningSkill')
    expect(binding).not.toContain(expected.content)
    expect(f.owner.readImportPlanningSkill(handle)).not.toBe(material)
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('returns unbound null without injecting or choosing a default Skill', () => {
    const f = importGenerationFixture(cleanup, 1)
    const execution = ImportRunRepository.startOrResume(slot.runId, 'fictional-owner').execution
    const handle = openSlot(f, slot, execution)
    expect(f.owner.readImportPlanningSkill(handle)).toBeNull()
    expect(injectWritingSkillPrompt(task, 'zh-CN', f.owner.readImportPlanningSkill(handle))).toEqual({ task })
    expect(f.spy).not.toHaveBeenCalled()
  })
  it.each(['project', 'user'] as const)('retains the directory-name fallback and full task for an unnamed %s Skill without a bundle manifest', scope => {
    const f = importGenerationFixture(cleanup, 1)
    const name = 'fixture-planning'
    const directory = path.join(f.root, 'skills', name)
    fs.mkdirSync(directory, { recursive: true })
    const content = 'Fictional planning guidance without frontmatter.'
    fs.writeFileSync(path.join(directory, 'SKILL.md'), content)
    fs.writeFileSync(path.join(f.root, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: `${scope}:${name}` } }))
    expect(inspectInstalledWritingSkill(content, { status: 'none' }, name).metadata.name).toBe('unnamed-writing-skill')
    const execution = ImportRunRepository.startOrResume(slot.runId, 'fictional-owner').execution
    const handle = openSlot(f, slot, execution)
    const material = f.owner.readImportPlanningSkill(handle)
    expect(material).toEqual({ name, content })
    expect(injectWritingSkillPrompt(task, 'zh-CN', material)).toEqual(injectWritingSkillPrompt(task, 'zh-CN', { name, content }))
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('rejects a changed binding instead of returning a newly selected or unbound Skill', () => {
    const f = importGenerationFixture(cleanup, 1)
    const target = path.join(f.root, 'writing-skills.json')
    fs.writeFileSync(target, JSON.stringify({ version: 1, bindings: { planning: 'builtin:long-form-continuity' } }))
    const execution = ImportRunRepository.startOrResume(slot.runId, 'fictional-owner').execution
    const handle = openSlot(f, slot, execution)
    fs.writeFileSync(target, JSON.stringify({ version: 1, bindings: {} }))
    expect(() => f.owner.readImportPlanningSkill(handle)).toThrow('GENERATION_IMPORT_CONTEXT_CHANGED')
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('rejects missing bound content rather than silently returning null', () => {
    const f = importGenerationFixture(cleanup, 1)
    const directory = path.join(f.root, 'skills', 'fixture-planning')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'SKILL.md')
    fs.writeFileSync(file, '---\nname: fixture-planning\nlanguage: zh-CN\nstage: planning\n---\nFictional planning guidance.')
    fs.writeFileSync(path.join(f.root, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'project:fixture-planning' } }))
    const execution = ImportRunRepository.startOrResume(slot.runId, 'fictional-owner').execution
    const handle = openSlot(f, slot, execution)
    fs.unlinkSync(file)
    expect(() => f.owner.readImportPlanningSkill(handle)).toThrow()
    expect(f.spy).not.toHaveBeenCalled()
  })
})
