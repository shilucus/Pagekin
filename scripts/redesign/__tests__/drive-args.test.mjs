import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { _electron as electron } from 'playwright'
import { appearanceWrite, assertBuilt, captureFailure, driveSessions, finalizeSessionObservations, finishRealSession, harvestModelLog, idleMemory, createIsolatedRoots, isolatedEnvironment, launch, launchArgs, parseArgs,
  releaseSessionRoot, scanRunForSecret, sessionIsClean, writeConsoleLog } from '../drive.mjs'
import { fileStamps } from '../real-model.mjs'
import { BASELINE_SESSIONS, EXTRA_SCENARIOS, SCENARIOS } from '../scenarios.mjs'
import { appendPerformanceFailureDiagnostic } from '../performance-baseline.mjs'

const parents = []
afterEach(() => { for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true }) })
const tempParent = () => { const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-args-')); parents.push(parent); return parent }

it('成功收尾也在性能截止之后采集最后的网络观测', async () => {
  const shared = {}, order = []
  const result = await finalizeSessionObservations({ shared,
    app: { evaluate: async () => { order.push('network'); return [] } },
    context: { finalizePerformanceEvidence: async () => { order.push('performance') } } })
  assert.deepEqual(order, ['performance', 'network'])
  assert.deepEqual(result.errors, [])
  assert.deepEqual(shared.externalRequests, [])
  assert.equal(shared.externalRequestsCoverage, 'observed_before_quit')
})

it('失败收尾仍观察网络，保留性能截止错误和外部请求违规两项证据', async () => {
  const shared = {}, report = { failureStage: 'workflow', success: false, failureDiagnostics: [] }
  const cause = Object.assign(new Error('private-workflow'), { code: 'ECONNRESET' })
  appendPerformanceFailureDiagnostic(report.failureDiagnostics, cause, 'scenario', 'workflow')
  const original = Object.assign(new Error('private-cutoff', { cause }), { performanceBaseline: report, code: 'ETIMEDOUT' })
  const app = { evaluate: vi.fn(async () => ['https://example.invalid']) }
  const result = await finalizeSessionObservations({ app, shared, restartRequests: ['https://restart.invalid'],
    context: { finalizePerformanceEvidence: async () => { throw original } }, networkMessage: 'network violation' })
  assert.equal(result.errors[0], original)
  assert.match(result.errors[1].message, /network violation/u)
  assert.equal(result.performanceBaseline, report)
  assert.deepEqual(shared.externalRequests, ['https://restart.invalid', 'https://example.invalid'])
  assert.equal(shared.externalRequestsCoverage, 'observed_before_quit')
  assert.equal(app.evaluate.mock.calls.length, 1)
  const receipt = JSON.parse(JSON.stringify({ measured: report, ...shared }))
  assert.deepEqual(receipt.measured.failureDiagnostics, [{ source: 'scenario', stage: 'workflow', errorClass: 'Error', code: 'ECONNRESET' }])
  assert.deepEqual(receipt.failureDiagnostics, [
    { source: 'cleanup', stage: 'driver_finalize', errorClass: 'Error', code: 'ETIMEDOUT' },
    { source: 'cleanup', stage: 'network_observation', errorClass: 'AssertionError', code: 'ERR_ASSERTION' },
  ])
  assert.doesNotMatch(JSON.stringify(receipt), /private-workflow|private-cutoff|network violation/u)
})

it('网络日志不可用时不伪造空数组', async () => {
  const shared = {}
  const result = await finalizeSessionObservations({ app: { evaluate: async () => undefined }, shared })
  assert.equal(shared.externalRequests, null)
  assert.equal(shared.externalRequestsCoverage, 'unavailable')
  assert.equal(result.errors.length, 1)
})

it('性能截止挂起有界返回，随后仍采集网络，取消计时器', async () => {
  vi.useFakeTimers()
  try {
    const shared = {}, app = { evaluate: vi.fn(async () => []) }
    const pending = finalizeSessionObservations({ app, shared, timeoutMs: 50,
      context: { finalizePerformanceEvidence: () => new Promise(() => {}) } })
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].message, 'DRIVE_FINAL_OBSERVATION_TIMEOUT')
    assert.deepEqual(shared.externalRequests, [])
    assert.equal(shared.externalRequestsCoverage, 'observed_before_quit')
    assert.equal(vi.getTimerCount(), 0)
  } finally { vi.useRealTimers() }
})

it('pnpm 透传的 -- 与全部参数都能解析', () => {
  const options = parseArgs(['--', '--scenario', 'baseline-all', '--theme', 'dark', '--out', 'shots/x', '--dump-dom', '--console', '--app-root', '../trunk'])
  assert.equal(options.scenario, 'baseline-all')
  assert.equal(options.theme, 'dark')
  assert.equal(options.out, path.resolve('shots/x'))
  assert.equal(options.appRoot, path.resolve('../trunk'))
  assert.equal(options.dumpDom, true)
  assert.equal(options.console, true)
})

it('默认浅色、诊断关闭、输出到 .runtime/redesign-baseline', () => {
  const options = parseArgs(['--scenario', 'settings'])
  assert.equal(options.theme, 'light')
  assert.equal(options.dumpDom, false)
  assert.equal(options.console, false)
  assert.equal(path.basename(path.dirname(options.out)), '.runtime')
  assert.equal(path.basename(options.out), 'redesign-baseline')
})

it.each(['perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit'])('独立注册压力场景 %s，不改变 baseline-all', scenario => {
  assert.equal(parseArgs(['--scenario', scenario]).scenario, scenario)
  assert.equal(Object.hasOwn(SCENARIOS, scenario), false)
  assert.equal(Object.hasOwn(EXTRA_SCENARIOS, scenario), false)
  assert.equal(JSON.stringify(BASELINE_SESSIONS).includes(scenario), false)
})

it('拒绝缺失或未知的场景、主题与参数', () => {
  assert.throws(() => parseArgs([]), /未知或缺少场景/)
  assert.throws(() => parseArgs(['--scenario', 'nope']), /未知或缺少场景 nope/)
  assert.throws(() => parseArgs(['--scenario', 'settings', '--theme', 'paper']), /--theme 只接受 light\|dark/)
  assert.throws(() => parseArgs(['--scenario', '--theme', 'dark']), /--scenario 缺少取值/)
  assert.throws(() => parseArgs(['--scenario', 'settings', '--headless']), /未知参数 --headless/)
})

it('每次运行得到 parent 下全新的隔离根，canonical 留给应用自己创建', () => {
  const parent = tempParent()
  const first = createIsolatedRoots(parent)
  const second = createIsolatedRoots(parent)
  assert.notEqual(first.root, second.root)
  assert.equal(path.dirname(first.root), parent)
  for (const [name, directory] of Object.entries(first)) {
    if (name === 'root') continue
    assert.equal(path.dirname(directory), first.root, `${name} 不在隔离根内`)
    assert.equal(fs.existsSync(directory), name !== 'canonical', `${name} 创建状态不对`)
  }
})

it('子进程环境的全部可写根都指向隔离目录', () => {
  const roots = createIsolatedRoots(tempParent())
  const env = isolatedEnvironment(roots, { PATH: 'p', APPDATA: 'C:/real', ELECTRON_RUN_AS_NODE: '1',
    VITE_DEV_SERVER_URL: 'http://x', AI_NOVEL_SMOKE_OPEN_PROJECT: 'C:/real/project', PAGEKIN_REAL_MODEL_API_KEY: 'runtime-key' })
  for (const name of ['AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    assert.ok(env[name].startsWith(roots.root + path.sep), `${name} 越出隔离根: ${env[name]}`)
  }
  assert.equal(env.PATH, 'p')
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'PAGEKIN_REAL_MODEL_API_KEY']) {
    assert.equal(env[name], undefined)
  }
})

it('baseline-all 的会话恰好覆盖每个场景一次', () => {
  assert.deepEqual(Object.values(BASELINE_SESSIONS).flat().sort(), Object.keys(SCENARIOS).sort())
})

it('runtime routing is an independent extra scenario, not a baseline-all session', () => {
  assert.equal(EXTRA_SCENARIOS['runtime-routing-v1']?.shell, 'stage')
  assert.equal(SCENARIOS['runtime-routing-v1'], undefined)
  assert.equal(parseArgs(['--scenario', 'runtime-routing-v1']).scenario, 'runtime-routing-v1')
})

it('runtime feedback is an independent extra scenario, not a baseline-all session', () => {
  assert.equal(EXTRA_SCENARIOS['runtime-feedback-v1']?.shell, 'stage')
  assert.equal(SCENARIOS['runtime-feedback-v1'], undefined)
  assert.equal(parseArgs(['--scenario', 'runtime-feedback-v1']).scenario, 'runtime-feedback-v1')
})

it('runtime lifecycle is an independent fake-model extra scenario', () => {
  assert.equal(EXTRA_SCENARIOS['runtime-lifecycle-v1']?.shell, 'stage')
  assert.equal(EXTRA_SCENARIOS['runtime-lifecycle-v1']?.model, true)
  assert.equal(SCENARIOS['runtime-lifecycle-v1'], undefined)
  assert.equal(parseArgs(['--scenario', 'runtime-lifecycle-v1']).scenario, 'runtime-lifecycle-v1')
  assert.throws(() => parseArgs(['--scenario', 'runtime-lifecycle-v1', '--real-model']))
})

it.each(['workflow-driver-v1', 'workflow-driver-unknown-v1'])('registers %s only as an isolated fake-model extra', name => {
  assert.equal(EXTRA_SCENARIOS[name]?.shell, 'stage')
  assert.equal(EXTRA_SCENARIOS[name]?.model, true)
  assert.equal(SCENARIOS[name], undefined)
  assert.equal(JSON.stringify(BASELINE_SESSIONS).includes(name), false)
  assert.equal(parseArgs(['--scenario', name]).scenario, name)
  assert.throws(() => parseArgs(['--scenario', name, '--real-model']))
})

it('启动参数固定中文界面，非中文宿主上场景照样按中文找控件', () => {
  const roots = createIsolatedRoots(tempParent())
  const args = launchArgs(roots)
  assert.ok(args.includes('--lang=zh-CN'))
  assert.ok(args.includes(`--user-data-dir=${roots.userData}`))
})

it('外部写入或残留进程时不算干净，隔离目录留着取证', () => {
  const ok = { failedAt: null, sessionErrors: [], residualProcesses: [], externalWrites: [],
    quit: { outcome: 'resolved', forced: false, killStatus: 'not-needed' } }
  assert.equal(sessionIsClean(ok), true)
  assert.equal(sessionIsClean({ ...ok, quit: { ...ok.quit, outcome: 'rejected' } }), false)
  assert.equal(sessionIsClean({ ...ok, quit: { ...ok.quit, outcome: 'timeout' } }), false)
  assert.equal(sessionIsClean({ ...ok, externalWrites: ['C:/Users/x/AppData/Roaming/ai-novel-writer'] }), false)
  assert.equal(sessionIsClean({ ...ok, residualProcesses: [4242] }), false)
  assert.equal(sessionIsClean({ ...ok, externalWrites: undefined }), false)
  assert.equal(sessionIsClean({ ...ok, failedAt: 0 }), false)
})

it('启动失败的取证：截图失败也照样写 DOM 与无障碍树，且不抛错', async () => {
  const parent = tempParent()
  const base = path.join(parent, 'stage-library-light')
  const page = {
    isClosed: () => false,
    screenshot: () => Promise.reject(new Error('Target closed')),
    content: async () => '<html><body>启动卡住</body></html>',
    locator: () => ({ ariaSnapshot: async () => '- text: 启动卡住' }),
  }
  assert.equal(await captureFailure(page, base), undefined)
  assert.equal(fs.readFileSync(`${base}.dom.html`, 'utf8'), '<html><body>启动卡住</body></html>')
  assert.equal(fs.readFileSync(`${base}.aria.yml`, 'utf8'), '- text: 启动卡住')
  assert.equal(await captureFailure(undefined, base), undefined)
})

it('failure evidence returns only this successful screenshot, not a stale file', async () => {
  const base = path.join(tempParent(), 'perf-import-1000-light')
  const screenshot = `${base}.failure.png`
  fs.writeFileSync(screenshot, 'old image')
  const page = { isClosed: () => false, content: async () => '<html></html>',
    locator: () => ({ ariaSnapshot: async () => '' }),
    screenshot: vi.fn(async () => { throw new Error('capture failed') }) }
  assert.equal(await captureFailure(page, base), undefined)
  assert.equal(fs.readFileSync(screenshot, 'utf8'), 'old image')
  page.screenshot.mockImplementationOnce(async ({ path: file }) => { fs.writeFileSync(file, 'current image') })
  assert.equal(await captureFailure(page, base), screenshot)
  assert.equal(fs.readFileSync(screenshot, 'utf8'), 'current image')
  page.isClosed = () => true
  assert.equal(await captureFailure(page, base), undefined)
})

it('launch failure retains the actual saved screenshot before closing without replacing its cause', async () => {
  const appRoot = tempParent(), failureBase = path.join(appRoot, 'launch')
  fs.mkdirSync(path.join(appRoot, 'dist-electron'))
  fs.writeFileSync(path.join(appRoot, 'dist-electron', 'main.js'), '')
  const original = new Error('fixture startup failed'), order = [], failureEvidence = []
  const page = { isClosed: () => false,
    getByRole: () => ({ waitFor: async () => { throw original } }),
    screenshot: async ({ path: file }) => { order.push('capture'); fs.writeFileSync(file, 'fixture image') },
    content: async () => '<html></html>', locator: () => ({ ariaSnapshot: async () => '' }) }
  const app = { evaluate: async () => {}, firstWindow: async () => page, process: () => ({}),
    close: async () => { order.push('close') } }
  const mock = vi.spyOn(electron, 'launch').mockResolvedValueOnce(app)
  try {
    await assert.rejects(launch({ roots: { userData: path.join(appRoot, 'profile') }, appRoot,
      diagnostics: [], failureBase, failureEvidence, performanceBaseline: true }), error => error === original)
  } finally { mock.mockRestore() }
  assert.deepEqual(order, ['capture', 'close'])
  assert.deepEqual(failureEvidence, [`${failureBase}.failure.png`])
  assert.equal(fs.existsSync(failureEvidence[0]), true)
})

it('外观写入跟着被测构建走：head 只有 v3 键，只改主题；trunk 只有旧键，照旧写外壳偏好与 v1、v2', () => {
  const v3 = { schemaVersion: 3, revision: 4, colorTheme: 'light', zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'legacy-import', legacyImportCompleted: true }
  assert.deepEqual(appearanceWrite({ v3: JSON.stringify(v3), previous: JSON.stringify({ schemaVersion: 1 }) }, { theme: 'dark', shell: 'stage' }), {
    key: 'ai-novel-writer-appearance-v3',
    value: { ...v3, colorTheme: 'dark', revision: 5, origin: 'author' },
  })
  assert.throws(() => appearanceWrite({ v3: JSON.stringify(v3), previous: null }, { theme: 'dark', shell: 'writer' }), /只有纸墨外壳/)

  const previous = { schemaVersion: 1, revision: 2, shellPreference: 'unset', colorTheme: 'light', zoom: 1 }
  assert.deepEqual(appearanceWrite({ v3: null, previous: JSON.stringify(previous) }, { theme: 'dark', shell: 'stage' }), {
    key: 'ai-novel-writer-appearance',
    value: { ...previous, schemaVersion: 2, shellPreference: 'stage', colorTheme: 'dark', revision: 3, origin: 'author' },
  })
  assert.deepEqual(appearanceWrite({ v3: null, previous: JSON.stringify(previous) }, { theme: 'light', shell: null }).value,
    { ...previous, revision: 3, origin: 'author' })
  assert.equal(appearanceWrite({ v3: null, previous: null }, { theme: 'light', shell: null }), null)
})

it('空闲内存取各次采样全部进程合计的中位数，按进程类型分列，单位 KB', () => {
  const sample = (browser, renderer, gpu) => [
    { type: 'Browser', memory: { workingSetSize: browser, privateBytes: browser - 10 } },
    { type: 'Tab', memory: { workingSetSize: renderer, privateBytes: renderer - 10 } },
    { type: 'GPU', memory: { workingSetSize: gpu, privateBytes: gpu - 10 } },
  ]
  assert.deepEqual(idleMemory([sample(100, 300, 50), sample(110, 290, 60), sample(90, 400, 40)]), {
    samples: 3,
    workingSetKB: 460,
    privateKB: 430,
    byType: { Browser: 100, Tab: 300, GPU: 50 },
  })
  assert.throws(() => idleMemory([]), /没有采样/)
})

it('generation-only real model mode is restricted to the feedback adoption scenario', () => {
  assert.equal(parseArgs(['--scenario', 'real-feedback-adopt', '--real-model']).realModel, true)
  assert.equal(parseArgs(['--scenario', 'real-feedback-adopt', '--real-model', '--max-real-requests', '2']).maxRealRequests, 2)
  assert.equal(parseArgs(['--scenario', 'settings']).realModel, false)
  assert.throws(() => parseArgs(['--scenario', 'real-feedback-adopt']), /real-feedback-adopt 是真实模型场景，要带 --real-model/)
  assert.throws(() => parseArgs(['--scenario', 'real-main', '--real-model']), /只支持 real-feedback-adopt/)
  assert.throws(() => parseArgs(['--scenario', 'real-refs', '--real-model']), /需要其他模型能力，已禁用/)
  assert.throws(() => parseArgs(['--scenario', 'finalize', '--real-model']), /--real-model 只用于 real-feedback-adopt/)
  assert.throws(() => parseArgs(['--scenario', 'real-feedback-adopt', '--real-model', '--api-key', 'sk-x']), /未知参数 --api-key/)
  assert.throws(() => parseArgs(['--scenario', 'real-feedback-adopt', '--real-model', '--max-real-requests', '0']), /必须是正整数/)
})

it('allows only the exact multiround feedback scene with an explicit two-request budget', () => {
  const name = 'real-feedback-multiround'
  assert.equal(parseArgs(['--scenario', name, '--real-model', '--max-real-requests', '2']).maxRealRequests, 2)
  assert.equal(parseArgs(['--scenario', 'real-feedback-adopt', '--real-model']).maxRealRequests, 1)
  assert.equal(JSON.stringify(BASELINE_SESSIONS).includes(name), false)
  assert.throws(() => parseArgs(['--scenario', name]), /要带 --real-model/)
  for (const budget of [undefined, '1', '3']) {
    assert.throws(() => parseArgs(['--scenario', name, '--real-model',
      ...(budget === undefined ? [] : ['--max-real-requests', budget])]), /real-feedback-multiround.*--max-real-requests 2/)
  }
  assert.throws(() => parseArgs(['--scenario', `${name}-other`, '--real-model', '--max-real-requests', '2']), /未知或缺少场景/)
  assert.throws(() => parseArgs(['--scenario', 'settings', '--real-model', '--max-real-requests', '2']), /--real-model 只用于/)
})

it('没构建的应用根直接报错，不去启动 Electron', () => {
  const root = tempParent()
  assert.throws(() => assertBuilt(root), /dist-electron[\\/]main\.js 不存在/)
  fs.mkdirSync(path.join(root, 'dist-electron'))
  fs.writeFileSync(path.join(root, 'dist-electron', 'main.js'), '')
  assertBuilt(root)
})

it('真实模式删模型配置失败时记进会话错误，隔离目录留着，收尾的密钥扫描照样查到并删掉', () => {
  const root = tempParent()
  const config = path.join(root, 'canonical', 'generations', 'g1', 'models.json')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, '{"apiKey":"sk-test-secret"}')
  const shared = { isolationRoot: root }
  const sessionErrors = []
  finishRealSession({ shared, sessionErrors, modelLog: [{ path: '/v1/embeddings', status: 200, ms: 3 }], canonical: path.join(root, 'canonical'),
    remove: () => 'EBUSY' })
  assert.deepEqual(sessionErrors, [`删不掉模型配置 ${config}：EBUSY`])
  assert.equal(shared.modelRequests, 1)
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [] }), false)

  const out = tempParent()
  const outBefore = fileStamps(out)
  const results = [{ ...shared, error: sessionErrors.join('\n') }]
  scanRunForSecret(results, out, outBefore, 'sk-test-secret')
  assert.deepEqual(results[0].keyScan.hits, [config])
  assert.equal(fs.existsSync(config), false)
})

it('诊断日志写不进去时只记进会话错误，不打断后面的退出与凭据清理', () => {
  const sessionErrors = []
  writeConsoleLog(path.join(tempParent(), 'missing', 'x.console.log'), ['line'], sessionErrors)
  assert.equal(sessionErrors.length, 1)
  assert.match(sessionErrors[0], /ENOENT/)
  const file = path.join(tempParent(), 'ok.console.log')
  writeConsoleLog(file, ['a', 'b'], sessionErrors)
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n')
})

it('收尾读不回模型请求记录时会话判失败，请求数不会悄悄少算', async () => {
  const modelLog = [{ path: '/v1/chat/completions', status: 200, ms: 5 }]
  const sessionErrors = []
  await harvestModelLog({ evaluate: async () => { throw new Error('Target page, context or browser has been closed') } }, modelLog, sessionErrors)
  assert.equal(sessionErrors.length, 1)
  assert.match(sessionErrors[0], /has been closed/)
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [] }), false)

  const readable = []
  await harvestModelLog({ evaluate: async () => [{ path: '/v1/embeddings', status: 200, ms: 3 }] }, modelLog, readable)
  assert.deepEqual(readable, [])
  assert.equal(modelLog.length, 2)
})

it('诊断里带出密钥时写盘前就遮掉，诊断照样留下，会话判失败', () => {
  const sessionErrors = []
  const file = path.join(tempParent(), 'real.console.log')
  writeConsoleLog(file, ['[main:stderr] 401 Authorization: Bearer sk-test-secret', '[renderer:log] {"apiKey":"sk-test-secret"}', 'other'],
    sessionErrors, 'sk-test-secret')
  const written = fs.readFileSync(file, 'utf8')
  assert.equal(written.includes('sk-test-secret'), false, '写进产出目录的诊断不含密钥')
  assert.match(written, /401 Authorization: Bearer \[已遮蔽\]/)
  assert.match(written, /other/)
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [] }), false, '诊断里出现过密钥，会话不算干净')

  const cleanErrors = []
  writeConsoleLog(file, ['no secret here'], cleanErrors, 'sk-test-secret')
  assert.deepEqual(cleanErrors, [])
  assert.equal(fs.readFileSync(file, 'utf8'), 'no secret here\n')
})

it('含密钥的文件有一个删不掉时记下路径与原因，其余照删，结果里不含密钥', () => {
  const out = tempParent()
  const outBefore = fileStamps(out)
  const stuck = path.join(out, 'stuck.log')
  const other = path.join(out, 'other.log')
  for (const file of [stuck, other]) fs.writeFileSync(file, 'sk-test-secret')
  const results = [{ isolationRoot: path.join(out, 'gone') }]
  scanRunForSecret(results, out, outBefore, 'sk-test-secret', file => {
    if (file === stuck) return 'EBUSY'
    fs.rmSync(file)
    return null
  })
  assert.deepEqual(results[0].keyScan.removeFailures, [{ file: stuck, reason: 'EBUSY' }])
  assert.equal(fs.existsSync(other), false)
  assert.equal(JSON.stringify(results).includes('sk-test-secret'), false)
})

it('干净会话的隔离目录删不掉时记进会话错误，不抛；不干净的会话不删', () => {
  const sessionErrors = []
  const removed = []
  releaseSessionRoot('C:/iso/a', true, sessionErrors, () => 'EPERM')
  releaseSessionRoot('C:/iso/b', false, sessionErrors, root => { removed.push(root); return null })
  assert.deepEqual(sessionErrors, ['删不掉隔离目录 C:/iso/a：EPERM'])
  assert.deepEqual(removed, [])
})

it('会话里任一步抛错（含收尾清理），结果 JSON 照样写出、密钥扫描照样执行、退出码为失败', async () => {
  const out = tempParent()
  const root = path.join(tempParent(), 'iso')
  const leaked = path.join(root, 'canonical', 'models.json')
  const stdout = []
  const write = process.stdout.write
  process.stdout.write = chunk => { stdout.push(String(chunk)); return true }
  let exitCode
  try {
    exitCode = await driveSessions({
      sessions: [['real-x', ['real-x']]],
      options: { out, theme: 'light', scenario: 'real-x' },
      realKey: 'sk-test-secret',
      makeRoots: () => ({ root }),
      run: async () => {
        fs.mkdirSync(path.dirname(leaked), { recursive: true })
        fs.writeFileSync(leaked, '{"apiKey":"sk-test-secret"}')
        throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' })
      },
    })
  } finally { process.stdout.write = write }
  assert.equal(exitCode, 1)
  const written = fs.readFileSync(path.join(out, 'real-x-light.json'), 'utf8')
  assert.equal(written.includes('sk-test-secret'), false)
  const [result] = JSON.parse(written)
  assert.match(result.error, /EBUSY/)
  assert.deepEqual(result.keyScan.hits, [leaked])
  assert.equal(fs.existsSync(leaked), false)
  assert.equal(stdout.join('').includes('"keyScan"'), true)
})

it('本次产出里有目录遍历不了时记进 keyScan.unreadable，退出码为失败', async () => {
  const out = tempParent()
  const sub = path.join(out, 'locked-dir')
  const readdir = fs.readdirSync
  const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
    if (String(target) === sub) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return readdir(target, ...rest)
  })
  const write = process.stdout.write
  process.stdout.write = () => true
  let exitCode
  try {
    exitCode = await driveSessions({
      sessions: [['real-x', ['real-x']]],
      options: { out, theme: 'light', scenario: 'real-x' },
      realKey: 'sk-test-secret',
      makeRoots: () => ({ root: path.join(out, 'no-root') }),
      run: async (sessionName, names, options) => {
        fs.mkdirSync(sub)
        fs.writeFileSync(path.join(sub, 'leak.log'), 'sk-test-secret')
        return names.map(scenario => ({ scenario, theme: options.theme, isolationRoot: path.join(out, 'no-root'), residualProcesses: [], externalWrites: [] }))
      },
    })
  } finally {
    process.stdout.write = write
    spy.mockRestore()
  }
  assert.equal(exitCode, 1)
  const [result] = JSON.parse(fs.readFileSync(path.join(out, 'real-x-light.json'), 'utf8'))
  assert.deepEqual(result.keyScan.unreadable, [{ file: sub, reason: 'EACCES' }])
})
