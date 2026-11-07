import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const outline = '- Original goal: Mara finds a brass key.\n- Action and result: she lifts it from the empty desk.\n- Ending state: she keeps the key; the locked door remains closed.'
const chunks = [
  'Mara stood beside the empty desk and listened to the rain. A brass key lay beneath a folded sheet of paper. ',
  'She lifted the paper, took the key, and brushed the dust from its teeth. Nothing else moved in the quiet room. ',
  'The locked door waited at the far end of the hall. She slipped the key into her pocket and left the door closed for the night.',
]
const prose = chunks.join('')
const coreOutline = 'Mara finds a brass key in a quiet room. The locked door stays closed tonight.'
const skillId = 'builtin:long-form-continuity'
const chapterInfo = Object.freeze({ chapterNumber: 1, title: 'The Brass Key', role: 'opening',
  purpose: 'Mara finds and keeps a brass key.', keyEvents: 'Mara takes the brass key from the empty desk.',
  characters: [], suspenseHook: 'The locked door remains closed.', userGuidance: 'Keep the scene quiet.' })
const targetUnits = 80
const query = [chapterInfo.title, chapterInfo.keyEvents].join(' ')
let promptHelpers

// Bundle the existing helpers in memory. No renderer workflow or replacement prompt policy is executed.
async function loadPromptHelpers() {
  promptHelpers ??= (async () => {
    const { build } = await import('esbuild')
    const result = await build({ absWorkingDir: repository, stdin: { resolveDir: repository, contents: `
      export { ChapterPromptBuilder } from './src/services/prompts/prompt-builder';
      export { getBuiltinPromptTemplate } from './src/services/builtin-prompt-templates';
      export { assembleChapterMaterials } from './src/services/workflows/chapter-materials';
      export { chapterLengthContractText, chapterExecutionContractText } from './src/services/workflows/commands/generate-draft.command';
      export { injectWritingSkillIntoTask } from './src/services/workflows/commands/base-command';
      export { draftShortOutlinePrompt, draftShortOutlineTask, draftShortOutlineBlock } from './src/shared/draft-short-outline';
      export { getBuiltinWritingSkills } from './src/shared/builtin-writing-skills';
      export { parseWorkflowDriverRecipe, WORKFLOW_DRIVER_CHANNELS } from './src/shared/workflow-driver-contract';
      export { countDraftUnits, draftTargetUnitRange } from './src/shared/draft-units';
    ` }, bundle: true, write: false, treeShaking: true, platform: 'node', format: 'cjs',
    packages: 'external', target: 'node24', jsx: 'automatic', logLevel: 'silent' })
    const module = { exports: {} }
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url))
    return module.exports
  })()
  return promptHelpers
}

export async function buildWorkflowDriverScenarioRequest({ session, prepared, novelConfig, operationKey = randomUUID() }) {
  const helpers = await loadPromptHelpers()
  const { ChapterPromptBuilder, getBuiltinPromptTemplate, assembleChapterMaterials, chapterLengthContractText,
    chapterExecutionContractText, injectWritingSkillIntoTask, draftShortOutlinePrompt, draftShortOutlineTask,
    getBuiltinWritingSkills, parseWorkflowDriverRecipe } = helpers
  assert.equal(prepared.knowledgeSnapshot.query, query, 'prepared knowledge query changed')
  assert.deepEqual(prepared.selectedDrafts, [], 'first chapter unexpectedly selected predecessor drafts')
  const skill = getBuiltinWritingSkills().find(item => `builtin:${item.metadata.name}` === skillId)
  assert.ok(skill, 'fixture builtin skill missing')
  const content = skill.localizedContent?.['en-US'] ?? skill.content
  const context = { writingLanguage: 'en-US', writingSkills: { drafting: {
    skillId, name: skill.metadata.displayName ?? skill.metadata.name, stage: 'drafting', source: 'builtin',
    writingLanguage: 'en-US', content, utf8Bytes: Buffer.byteLength(content),
  } } }
  const authoredFacts = [novelConfig.coreOutline, novelConfig.worldSetting, novelConfig.goldenFinger, novelConfig.protagonistProfile].filter(Boolean)
  const materials = await assembleChapterMaterials({ identity: { projectId: session.projectId, epoch: session.leaseId },
    writingLanguage: 'en-US', budgetChars: 8000, authorProjectFacts: authoredFacts, characterProfiles: '',
    futurePlans: '(no future chapter blueprints)', references: prepared.knowledgeSnapshot.items.map(item => ({
      text: item.text, rendered: item.text, deduplicateAgainstFinalized: true,
    })), finalized: [], candidates: [], relevanceTerms: [chapterInfo.title, chapterInfo.keyEvents] })
  const promptOnly = new Set(['coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile', 'globalGuidance', 'writingStyle'])
  const builder = new ChapterPromptBuilder(getBuiltinPromptTemplate('first_chapter_draft', 'en-US'), 'en-US')
    .withArchitecture(authoredFacts.join('\n\n')).withGlobalGuidance(novelConfig.globalGuidance || '')
    .withWritingStyle(novelConfig.writingStyle || '').withNovelConfig(Object.fromEntries(Object.entries(novelConfig).filter(([key]) => !promptOnly.has(key))))
    .withWordNumber(targetUnits).withChapterInfo(chapterInfo).withCharacterStates('').withFutureBlueprints('')
    .withFilteredContext('').withUserGuidance(chapterInfo.userGuidance)
  const contract = chapterExecutionContractText('en-US', chapterInfo)
  const prompt = [materials.text, builder.build(), contract.authorItems, chapterLengthContractText('en-US', targetUnits)].filter(Boolean).join('\n\n')
  const outlineTask = injectWritingSkillIntoTask(draftShortOutlineTask('en-US', draftShortOutlinePrompt('en-US', prompt)), context, 'drafting').task
  const baseDraftTask = injectWritingSkillIntoTask({ purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting',
    budgetDemand: { kind: 'draft-units', writingLanguage: 'en-US', requestedUnits: targetUnits, segmentable: true },
    messages: [{ role: 'system', content: `${builder.getSystemRole()}\n\n${contract.rules}` }, { role: 'user', content: prompt }] }, context, 'drafting').task
  const authorInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(chapterInfo) },
    { id: 'draft:author-config', text: JSON.stringify(novelConfig) }, { id: 'draft:target-units', text: String(targetUnits) }]
  return { operationKey, selection: { operation: 'chapter-draft', uiActionNonce: randomUUID(), modelId: FAKE_MODEL.id,
    chapterNumber: 1, selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
    promptKeys: ['first_chapter_draft'], skillStages: ['drafting'], output: 'visible-text', preparationId: prepared.preparationId,
    authorInputs, materialDecision: { ...materials.decision,
      promptHash: hash(baseDraftTask.messages.find(message => message.role === 'user').content),
      shortOutlinePromptHash: hash(outlineTask.messages.find(message => message.role === 'user').content) } },
  recipe: parseWorkflowDriverRecipe({ schemaVersion: 1, writingLanguage: 'en-US', outlineTask, baseDraftTask }) }
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`WORKFLOW_DRIVER_SCENARIO_TIMEOUT:${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function waitGate(gate, waiting) { await waitFor(() => Boolean(gate.waiting) === waiting, 'fake-gate') }
async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('WORKFLOW_DRIVER_SCENARIO_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}
async function afterDrain(operation) {
  return waitFor(async () => {
    try { return await operation() }
    catch (error) {
      if (!/WORKFLOW_DRIVER_TASK_BUSY/u.test(String(error?.message ?? error))) throw error
      return false
    }
  }, 'physical-drain')
}

async function runScenario(context, dependencies, unknown) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const awaitGate = dependencies.awaitGate ?? waitGate
  const prepareRequest = dependencies.prepareRequest ?? buildWorkflowDriverScenarioRequest
  const opened = new Map()
  const records = []
  let result, outcome
  async function open(project) {
    const openedView = await invoke(page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(openedView?.success, true, 'fictional project open failed')
    opened.set(project.projectPath, project)
    const session = { projectId: project.projectId, projectPath: project.projectPath, leaseId: openedView.project.sessionLease }
    return { session, project: openedView.project }
  }
  async function create(name) {
    const grant = await grantDirectory(app, page, roots.projects)
    const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name,
      genre: 'Fictional mystery', targetAudience: 'Fictional adults', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(created?.success, true, `fictional project creation failed: ${created?.error ?? 'no receipt'}`)
    return { projectId: created.projectId, projectPath: created.projectPath }
  }
  async function readHistory(project, session, taskId) {
    const receipt = await invoke(page, 'workflow-driver:v1:read-history', { taskId }, session)
    assert.equal(receipt.task.projectId, project.projectId)
    assert.equal(receipt.task.taskId, taskId)
    return receipt
  }
  async function cleanup() {
    const failures = []
    try { fake?.gate?.release() } catch (error) { failures.push(error) }
    try { if (fake?.gate) await awaitGate(fake.gate, false) } catch (error) { failures.push(error) }
    for (const record of records) {
      try {
        const { session } = await open(record.project)
        const receipt = await readHistory(record.project, session, record.taskId)
        if (!['cancelled', 'waiting_review'].includes(receipt.task.state)) {
          const cancelled = await invoke(page, 'workflow-driver:v1:cancel', {
            reference: { ...record.reference, revision: receipt.task.revision },
          })
          assert.equal(cancelled.receipt.task.state, 'cancelled', 'cleanup did not cancel unfinished task')
        }
      } catch (error) { failures.push(error) }
    }
    for (const project of [...opened.values()]) {
      try {
        const { session } = await open(project)
        const closed = await invoke(page, 'db:close', project.projectPath, session)
        assert.equal(closed?.success, true, 'fictional runtime close failed')
        opened.delete(project.projectPath)
      } catch (error) { failures.push(error) }
    }
    try { fake?.replyReview?.(null); fake?.streamProse?.(null) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_DRIVER_SCENARIO_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate && fake?.streamProse && fake?.replyReview, 'WORKFLOW_DRIVER_SCENARIO_FAKE_REQUIRED')
    fake.replyReview(prompt => prompt.includes('Prepare a short chapter execution outline, not prose.') ? outline : null)
    fake.streamProse({ chunks, intervalMs: 80 })
    const initial = await requestCount(app), chatStart = fake.chats.length
    const a = await create(unknown ? 'Driver U A' : 'Driver A'), b = await create(unknown ? 'Driver U B' : 'Driver B')
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    const aView = await open(a), sessionA = aView.session
    const novelConfig = { ...aView.project.novelConfig, writingLanguage: 'en-US', wordsPerChapter: targetUnits,
      coreOutline, worldSetting: 'A fictional quiet house.', goldenFinger: '', protagonistProfile: 'Mara is a fictional visitor.',
      globalGuidance: 'Keep all author facts unchanged.', writingStyle: 'Use concrete action and restrained description.' }
    assert.equal((await invoke(page, 'project:update-config', a.projectId, { novelConfig }, a.projectPath, sessionA)).success, true)
    assert.equal((await invoke(page, 'db:blueprint-upsert', chapterInfo, a.projectPath, sessionA)).success, true)
    const binding = await invoke(page, 'fs:write-file', path.join(a.projectPath, '.ai-novel', 'writing-skills.json'),
      JSON.stringify({ version: 1, bindings: { drafting: skillId } }), a.projectPath, sessionA)
    assert.equal(binding.success, true, 'fictional writing skill binding failed')
    const authorInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(chapterInfo) },
      { id: 'draft:author-config', text: JSON.stringify(novelConfig) }, { id: 'draft:target-units', text: String(targetUnits) }]
    const prepare = { request: { chapterNumber: 1, modelId: FAKE_MODEL.id, promptKeys: ['first_chapter_draft'],
      skillStages: ['drafting'], authorInputs, query, selectedDraftIds: [] } }
    const prepared = await invoke(page, 'workflow-driver:v1:prepare-context', prepare, sessionA)
    const request = await prepareRequest({ session: sessionA, prepared, novelConfig })
    fake.gate.hold()
    result = await invoke(page, 'workflow-driver:v1:start', request, sessionA)
    assert.ok(result.reference, 'workflow start returned no execution reference')
    const taskId = result.receipt.task.taskId
    records.push({ project: a, taskId, reference: result.reference })
    assert.equal(result.receipt.task.state, 'ready')
    const identity = result.receipt.steps.map(({ stepId, commandId, kind, ordinal }) => ({ stepId, commandId, kind, ordinal }))
    assert.deepEqual(identity.map(step => step.kind), ['outline', 'draft', 'compose', 'commit'])
    await awaitGate(fake.gate, true)
    const { session: sessionB } = await open(b)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional B remains independent.' }, b.projectPath, sessionB)).success, true)
    await assert.rejects(invoke(page, 'workflow-driver:v1:prepare-context', prepare, sessionA))
    await assert.rejects(invoke(page, 'workflow-driver:v1:read-receipt', { reference: { ...result.reference, projectId: b.projectId } }))
    const detached = await invoke(page, 'workflow-driver:v1:read-receipt', { reference: result.reference })
    assert.equal(detached.task.taskId, taskId)
    assert.equal(detached.steps.filter(step => step.effect).length, 0)
    // The fetch log counts received headers; the held server has not returned any.
    assert.equal(detached.attempts.length, 1, 'held workflow must have exactly one durable attempt')
    assert.equal(detached.attempts[0].status, 'dispatch-marked')
    assert.equal(fake.gate.waiting, 1, 'held workflow must have exactly one received request')
    if (unknown) {
      result = await invoke(page, 'workflow-driver:v1:pause', { reference: result.reference })
      assert.equal(result.receipt.task.state, 'paused')
      assert.ok(result.reference)
      fake.gate.release()
      await awaitGate(fake.gate, false)
      const paused = await waitFor(async () => {
        const receipt = await invoke(page, 'workflow-driver:v1:read-receipt', { reference: result.reference })
        return receipt.attempts[0]?.status === 'unknown' ? receipt : false
      }, 'unknown-receipt')
      assert.equal(paused.attempts.length, 1)
      assert.equal(paused.steps.filter(step => step.effect).length, 0)
      assert.equal(paused.composition, null)
      assert.equal(paused.draftSave.kind, 'absent')
      assert.deepEqual(await invoke(page, 'workflow-driver:v1:read-receipt', { reference: result.reference }), paused)
      const { session: freshA } = await open(a)
      const recovered = await afterDrain(() => invoke(page, 'workflow-driver:v1:reauthorize', { taskId }, freshA))
      assert.ok(recovered.reference)
      result = await invoke(page, 'workflow-driver:v1:resume', { reference: recovered.reference })
      const blocked = await waitFor(async () => {
        const receipt = await readHistory(a, freshA, taskId)
        return receipt.task.state === 'blocked' ? receipt : false
      }, 'blocked-unknown-resume')
      assert.equal(blocked.task.blockedCode, 'WORKFLOW_DRIVER_RECEIPT_NOT_COMMITTED')
      assert.equal(blocked.attempts.length, 1)
      assert.equal(blocked.attempts[0].status, 'unknown')
      assert.equal(blocked.steps.filter(step => step.effect).length, 0)
      assert.equal(await requestCount(app), initial + 1, 'unknown attempt was redispatched')
      const finalGrant = await afterDrain(() => invoke(page, 'workflow-driver:v1:reauthorize', { taskId }, freshA))
      assert.ok(finalGrant.reference)
      result = await invoke(page, 'workflow-driver:v1:cancel', { reference: finalGrant.reference })
      assert.equal(result.receipt.task.state, 'cancelled')
      assert.equal(result.receipt.draftSave.kind, 'absent')
      assert.equal(await requestCount(app), initial + 1, 'cancel redispatched the unknown attempt')
      outcome = { receipt: { scenario: 'workflow-driver-unknown-v1', source: 'isolated-electron-registered-ipc-main-owner',
        guardedFetchAttempts: 1, pausedInFlight: true, unknownNotReplayed: true, resumedFromReceipts: true,
        cancelled: true, taskId, attempts: blocked.attempts, steps: identity, viewDetach: 'open-B-detaches-A-not-runtime-close',
        notCovered: ['real-model-quality', 'process-restart', 'native-platform-qualification'] } }
    } else {
      fake.gate.release()
      await awaitGate(fake.gate, false)
      const completedWhileB = await waitFor(async () => {
        const receipt = await invoke(page, 'workflow-driver:v1:read-receipt', { reference: result.reference })
        assert.notEqual(receipt.task.state, 'blocked', `workflow blocked: ${receipt.task.blockedCode}`)
        return receipt.task.state === 'waiting_review' ? receipt : false
      }, 'waiting-review')
      assert.equal((await invoke(page, 'db:project-core-get', b.projectPath, sessionB)).coreOutline, 'Fictional B remains independent.')
      assert.equal(completedWhileB.steps.filter(step => step.effect).length, 4, 'registration is not completion evidence')
      assert.deepEqual(completedWhileB.steps.map(step => step.effect.receiptKind), ['model', 'model', 'composition', 'draft_commit'])
      assert.equal(completedWhileB.attempts.length, 2)
      assert.ok(completedWhileB.attempts.every(attempt => attempt.status === 'settled' && attempt.artifactId))
      assert.equal(completedWhileB.draftSave.kind, 'current')
      assert.equal(completedWhileB.draftSave.receipt.content, prose)
      assert.equal(completedWhileB.composition.text, prose)
      assert.equal(completedWhileB.composition.textHash, hash(prose))
      assert.equal(completedWhileB.draftSave.receipt.contentHash, hash(prose))
      assert.equal(await requestCount(app), initial + 2, 'workflow did not use exactly outline and draft requests')
      const helpers = await loadPromptHelpers()
      assert.ok(helpers.countDraftUnits(prose) >= helpers.draftTargetUnitRange(targetUnits).minimum)
      const chats = fake.chats.slice(chatStart)
      assert.equal(chats.length, 2)
      assert.equal(chats[0].messages.find(message => message.role === 'user').content, request.recipe.outlineTask.messages[0].content)
      const draftUser = request.recipe.baseDraftTask.messages.find(message => message.role === 'user').content
      assert.equal(chats[1].messages.find(message => message.role === 'user').content, `${draftUser}\n\n${helpers.draftShortOutlineBlock('en-US', outline)}`)
      assert.ok(fake.streamLog.length, 'background draft never streamed')
      const { session: freshA } = await open(a)
      assert.notEqual(freshA.leaseId, sessionA.leaseId)
      const resubscribed = await invoke(page, 'workflow-driver:v1:read-receipt', { reference: result.reference })
      assert.deepEqual(resubscribed, completedWhileB, 'reattachment did not return the captured task receipt')
      assert.deepEqual(await readHistory(a, freshA, taskId), completedWhileB)
      assert.deepEqual(resubscribed.steps.map(({ stepId, commandId, kind, ordinal }) => ({ stepId, commandId, kind, ordinal })), identity)
      assert.deepEqual((await invoke(page, 'workflow-driver:v1:reauthorize', { taskId }, freshA)), { reference: null, receipt: completedWhileB })
      assert.equal(await requestCount(app), initial + 2, 'reading completed history sent another request')
      outcome = { receipt: { scenario: 'workflow-driver-v1', source: 'isolated-electron-registered-ipc-main-owner',
        guardedFetchAttempts: 2, completedSteps: 4, state: 'waiting_review', taskId, runId: completedWhileB.task.runId,
        steps: identity, draftId: completedWhileB.draftSave.receipt.id, contentHash: hash(prose),
        detachedWorkContinued: true, resubscribedFromReceipt: true, otherProjectPreserved: true,
        materialDecisionBound: true, shortOutlineBound: true, writingSkillBound: skillId, wordContractSatisfied: true,
        viewDetach: 'open-B-detaches-A-not-runtime-close',
        notCovered: ['real-model-quality', 'full-production-workflow-002', 'process-restart', 'native-platform-qualification'] } }
    }
  } catch (error) { outcome = { error } }
  try { await cleanup() }
  catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], 'WORKFLOW_DRIVER_SCENARIO_AND_CLEANUP_FAILED')
    throw error
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export const runWorkflowDriverScenario = (context, dependencies = {}) => runScenario(context, dependencies, false)
export const runWorkflowDriverUnknownScenario = (context, dependencies = {}) => runScenario(context, dependencies, true)
export const WORKFLOW_DRIVER_SCENARIOS = {
  'workflow-driver-v1': { model: true, shell: 'stage', timeout: 120_000, run: runWorkflowDriverScenario },
  'workflow-driver-unknown-v1': { model: true, shell: 'stage', timeout: 120_000, run: runWorkflowDriverUnknownScenario },
}
