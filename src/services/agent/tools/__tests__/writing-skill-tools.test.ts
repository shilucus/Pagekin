import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import type { AgentGlobalToolExecution, AgentToolActionRef } from '../../../../shared/agent-generation'
import { toolRegistry, type AgentExecutionContext } from '../../tool-registry'

const invoke = vi.fn()
const saveWritingSkillBinding = vi.fn()

vi.mock('../../../ipc-client', () => ({ ipc: { invoke } }))
vi.mock('../../writing-skill-bindings', () => ({ saveWritingSkillBinding }))
vi.mock('../../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({
    currentProject: {
      id: 'project-1',
      path: 'C:/novels/project-1',
      sessionLease: 'lease-1',
    },
  }) },
}))

const projectSession: ProjectSessionContext = {
  projectId: 'project-1',
  projectPath: 'C:/novels/project-1',
  leaseId: 'lease-1',
}
const actionRef: AgentToolActionRef = {
  handle: { projectId: projectSession.projectId, epoch: 'fictional-epoch', rootActionId: 'fictional-root', runId: 'fictional-run' },
  attemptId: 'fictional-attempt', toolCallId: 'fictional-tool-call',
}
const execution: AgentGlobalToolExecution = { version: 1, token: 'fictional-main-issued-proof' }
const hostedContext: AgentExecutionContext = { projectSession, selectedModelId: null, uiLocale: 'en-US',
  writingLanguage: 'en-US', agentToolAction: actionRef }

describe('writing skill agent tools', () => {
  beforeEach(() => {
    invoke.mockReset()
    saveWritingSkillBinding.mockReset()
  })

  it('keeps GitHub inspection read-only and returns a candidate summary', async () => {
    invoke.mockResolvedValue({
      success: true,
      inspection: {
        sourceUrl: 'https://github.com/acme/skill',
        resolvedUrl: 'https://raw.githubusercontent.com/acme/skill/main/SKILL.md',
        metadata: { name: 'scene-craft', description: 'Scene craft', language: 'en-US' },
        compatible: true,
        reasons: [],
        suggestedStage: 'drafting',
        utf8Bytes: 120,
      },
    })
    const { inspectWritingSkillTool } = await import('../inspect-writing-skill.tool')
    expect(inspectWritingSkillTool.requiresConfirmation).toBe(false)
    await expect(inspectWritingSkillTool.execute({
      source_url: 'https://github.com/acme/skill',
    })).resolves.toMatchObject({ success: true, content: expect.stringContaining('scene-craft') })
    expect(invoke).toHaveBeenCalledWith('skills:inspect-github', 'https://github.com/acme/skill')
  })

  it('makes installation an explicit confirmation write and only accepts a source URL', async () => {
    invoke
      .mockResolvedValueOnce({ success: true, skill: { name: 'scene-craft', source: 'user' } })
      .mockResolvedValueOnce([])
    const { installWritingSkillTool } = await import('../install-writing-skill.tool')
    expect(installWritingSkillTool.requiresConfirmation).toBe(true)
    expect(installWritingSkillTool.inputSchema.properties).toEqual({
      source_url: expect.objectContaining({ type: 'string' }),
    })
    await expect(installWritingSkillTool.execute({
      source_url: 'https://github.com/acme/skill',
      content: 'forged prompt',
    })).resolves.toMatchObject({ success: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'skills:install-github', 'https://github.com/acme/skill')
  })

  it.each(['inspect', 'install'] as const)('rejects hosted %s without main proof before sending, even with a model-supplied proof', async kind => {
    const tool = kind === 'inspect' ? (await import('../inspect-writing-skill.tool')).inspectWritingSkillTool
      : (await import('../install-writing-skill.tool')).installWritingSkillTool
    const markSideEffectStarted = vi.fn()
    await expect(tool.execute({ source_url: 'https://github.com/acme/skill', globalToolExecution: execution },
      { ...hostedContext, markSideEffectStarted })).rejects.toThrow('GENERATION_AGENT_GLOBAL_EXECUTION_REQUIRED')
    expect(markSideEffectStarted).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['inspect', 'install'] as const)('passes only the context proof as the last %s IPC argument', async kind => {
    const tool = kind === 'inspect' ? (await import('../inspect-writing-skill.tool')).inspectWritingSkillTool
      : (await import('../install-writing-skill.tool')).installWritingSkillTool
    const markSideEffectStarted = vi.fn()
    invoke.mockResolvedValue({ success: false, error: 'fictional main rejection' })
    await tool.execute({ source_url: 'https://github.com/acme/skill', globalToolExecution: { version: 1, token: 'fictional-model-forgery' } },
      { ...hostedContext, globalToolExecution: execution, markSideEffectStarted })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(`skills:${kind}-github`, 'https://github.com/acme/skill', execution)
    if (kind === 'install') {
      expect(markSideEffectStarted).toHaveBeenCalledOnce()
      expect(markSideEffectStarted.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]!)
    } else expect(markSideEffectStarted).not.toHaveBeenCalled()
  })

  it.each(['inspect', 'install'] as const)('checks cancellation before a missing hosted %s proof', async kind => {
    const tool = kind === 'inspect' ? (await import('../inspect-writing-skill.tool')).inspectWritingSkillTool
      : (await import('../install-writing-skill.tool')).installWritingSkillTool
    const controller = new AbortController(), markSideEffectStarted = vi.fn()
    controller.abort()
    const result = tool.execute({ source_url: 'https://github.com/acme/skill' },
      { ...hostedContext, abortSignal: controller.signal, markSideEffectStarted })
    if (kind === 'inspect') await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    else await expect(result).resolves.toMatchObject({ success: false, error: 'Installation was cancelled before commit' })
    expect(markSideEffectStarted).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('binds a compatible installed skill to one confirmed project stage', async () => {
    const { skillRegistry } = await import('../../skill-registry')
    await skillRegistry.loadAll()
    const { bindWritingSkillTool } = await import('../bind-writing-skill.tool')
    expect(bindWritingSkillTool.requiresConfirmation).toBe(true)
    await expect(bindWritingSkillTool.execute({
      skill_id: 'builtin:natural-prose-refinement',
      stage: 'refinement',
    }, { projectSession, selectedModelId: null, uiLocale: 'zh-CN', writingLanguage: 'zh-CN' })).resolves.toMatchObject({ success: true })
    expect(saveWritingSkillBinding).toHaveBeenCalledWith(
      projectSession,
      'refinement',
      'builtin:natural-prose-refinement',
    )
  })

  it('keeps inspection-first and prompt-only safety semantics in the English catalog', async () => {
    const { inspectWritingSkillTool } = await import('../inspect-writing-skill.tool')
    const { installWritingSkillTool } = await import('../install-writing-skill.tool')
    const { bindWritingSkillTool } = await import('../bind-writing-skill.tool')
    toolRegistry.clear()
    toolRegistry.registerAll([inspectWritingSkillTool, installWritingSkillTool, bindWritingSkillTool])

    const prompt = toolRegistry.generateToolPrompt('en-US')
    expect(prompt).toContain('Inspect a public GitHub repository')
    expect(prompt).toContain('must be inspected before installation')
    expect(prompt).toContain('prompt-only')
    expect(prompt).toContain('never executes code')
    expect(prompt).toContain('A public GitHub repo, tree, blob, or raw SKILL.md HTTPS URL')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/)
  })
})
