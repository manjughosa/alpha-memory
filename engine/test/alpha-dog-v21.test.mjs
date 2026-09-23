import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlphaDogRuntime } from '../lib/alpha-dog.js'
import { validateAlphaDogSetting } from '../lib/alpha-dog-config.js'
import { buildInitializationRequest, createDeclinedState, initializeAlphaDog, inspectInitialization } from '../lib/alpha-dog/init.js'
import { normalizeRoundTick } from '../lib/alpha-dog/adapter.js'
import { memoryFeedback, memoryPropose, memoryVerify, runFeedbackLoop } from '../lib/alpha-dog/feedback.js'
import { canPromote, compareShadow, modePolicy, promoteMode } from '../lib/alpha-dog/modes.js'

const base = {
  enabled: false,
  interfaces: { Alpha_Dog_On: true, Alpha_Dog_Off: true, cg: false, stg: false },
  schedule: {
    slots: [
      { id: 'light', label: '即时落盘', interval: 15, prompt: 'alpha-dog-light', registryTags: ['即时落盘·15轮'], allowedModes: ['backfill', 'monitor'] },
      { id: 'medium', label: '中档巡检', interval: 21, prompt: 'alpha-dog-medium', registryTags: ['系统巡检·21轮'], allowedModes: ['backfill', 'monitor'] },
      { id: 'heavy', label: '重档巡检', interval: 30, prompt: 'alpha-dog-heavy', registryTags: ['记忆巡检·30轮'], allowedModes: ['interrupt', 'fixed_defer', 'backfill', 'monitor'] },
    ],
    simultaneousOrder: ['medium', 'light', 'heavy'], sequentialWake: true,
  },
  registry: { memoryMappingTableMd: 'targets.md', memoryMappingTableJson: 'targets.json' },
  initialization: { mention: 'on', status: 'configured' },
  model: { name: 'fixture', baseUrl: '', api: 'host', apiKeyRef: '', models: [{ id: 'fixture', input: ['text'], contextWindow: 1000, maxTokens: 100, reasoning: true, thinkingLevelMap: {} }] },
  state: { directory: 'state', mode: 'shadow' },
  governance: { failureThreshold: 3, cooldownMs: 100, maxPending: 10 },
  batchSize: 40,
}

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), 'alpha-dog-v21-'))
  mkdirSync(join(root, 'prompts'), { recursive: true })
  for (const name of ['alpha-dog-light', 'alpha-dog-medium', 'alpha-dog-heavy', 'alpha-dog-batch-report']) writeFileSync(join(root, 'prompts', `${name}.md`), name)
  writeFileSync(join(root, 'targets.json'), JSON.stringify({ files: [] }))
  return root
}

test('adapter normalizes host events and carries no plugin mount surface', async () => {
  const event = normalizeRoundTick({ session: { id: 's1' }, event: { id: 'e1', data: { content: 'hello' }, timestamp: '2026-01-01' } }, 4)
  assert.deepEqual(event, { event: 'round_tick', sessionId: 's1', round: 5, userInput: 'hello', timestamp: '2026-01-01', eventId: 'e1' })
  // 实施规划第 0 节：MCP 不得携带插件安装器 / 挂载逻辑。这些导出必须保持不存在。
  const adapter = await import('../lib/alpha-dog/adapter.js')
  for (const banned of ['createAdapterManifest', 'planAdapterInstall', 'applyAdapterInstall', 'detectHostPlatform']) {
    assert.equal(banned in adapter, false, `${banned} 属于插件挂载面，不得存在`)
  }
  const adaptersDir = new URL('../adapters/', import.meta.url)
  assert.equal(existsSync(fileURLToPath(adaptersDir)), false, 'adapters/ 宿主挂载清单目录不得存在')
})

test('initialization returns request, decline state and writes three artifacts on success', async () => {
  const root = projectFixture()
  try {
    const settingPath = join(root, 'alpha-dog.setting.json')
    writeFileSync(settingPath, JSON.stringify(base))
    const request = buildInitializationRequest({ name: 'fixture', api: 'host', models: [{ id: 'fixture', reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100, thinkingLevelMap: {} }] })
    assert.equal(inspectInitialization({ settingPath, root, host: 'pi', transport: { request: async () => ({}) } }, request).every((item) => item.ok), true)
    assert.deepEqual(createDeclinedState(), { status: 'declined', mention: 'off' })
    const result = await initializeAlphaDog({ settingPath, root, host: 'pi', transport: { request: async () => ({ status: 'ok' }) } }, request)
    assert.equal(result.status, 'configured')
    assert.equal(readFileSync(join(root, 'model.js'), 'utf8').includes('apiKeyRef'), true)
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'adapter.json'))).apiKeyRef, '')
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'init-report.json'))).status, 'configured')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('round 210 creates distinct wakes in 21 -> 15 -> 30 order and duplicate event is ignored', async () => {
  const root = projectFixture()
  try {
    const entries = Array.from({ length: 85 }, (_, i) => ({ id: i + 1, path: `${i + 1}.md`, importance: 85 - i, tags: ['即时落盘·15轮', '系统巡检·21轮', '记忆巡检·30轮'] }))
    writeFileSync(join(root, 'targets.json'), JSON.stringify({ files: entries }))
    const calls = []
    const runtime = new AlphaDogRuntime({ setting: validateAlphaDogSetting(base), root, packageRoot: root, statePath: join(root, 'state', 'runtime.json'), invokeModel: async (request) => { calls.push(request); return { status: 'ok' } } })
    runtime.counter.restore(209)
    runtime.on()
    const result = await runtime.tick({ eventId: 'e210' })
    assert.deepEqual(result.wakes.map((wake) => wake.slotId), ['medium', 'medium', 'medium', 'light', 'light', 'light', 'heavy', 'heavy', 'heavy'])
    assert.deepEqual(result.wakes.filter((wake) => wake.slotId === 'medium')[0].actions, ['backfill', 'monitor'])
    assert.deepEqual(result.wakes.filter((wake) => wake.slotId === 'heavy')[0].actions, ['interrupt', 'fixed_defer', 'backfill', 'monitor'])
    assert.equal(calls.length, 9)
    assert.equal((await runtime.tick({ eventId: 'e210' })).reason, 'duplicate-event')
    assert.equal(runtime.status().round, 210)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('explicit round_tick preserves client round without double increment', async () => {
  const root = projectFixture()
  try {
    const runtime = new AlphaDogRuntime({ setting: validateAlphaDogSetting(base), root, packageRoot: root, statePath: join(root, 'state', 'runtime.json') })
    runtime.on()
    const result = await runtime.tick({ eventId: 'client-round-15', round: 15 })
    assert.equal(result.round, 15)
    assert.equal(runtime.status().round, 15)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ordinary round has zero model calls and off persists without catch-up', async () => {
  const root = projectFixture()
  try {
    let calls = 0
    const runtime = new AlphaDogRuntime({ setting: validateAlphaDogSetting(base), root, packageRoot: root, statePath: join(root, 'state', 'runtime.json'), invokeModel: async () => { calls += 1; return { status: 'ok' } } })
    runtime.on()
    const result = await runtime.tick({ eventId: 'e1' })
    assert.equal(result.modelCalls, 0)
    runtime.off()
    await runtime.tick({ eventId: 'e2' })
    assert.equal(runtime.status().round, 1)
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime feeds model candidates through Alpha and persists confirmed receipt', async () => {
  const root = projectFixture()
  try {
    const local = structuredClone(base)
    local.schedule.slots = [{ id: 'light', label: '即时落盘', interval: 1, prompt: 'alpha-dog-light', registryTags: [], allowedModes: ['backfill', 'monitor'] }]
    local.schedule.simultaneousOrder = ['light']
    let writes = 0
    const runtime = new AlphaDogRuntime({
      setting: validateAlphaDogSetting(local), root, packageRoot: root, statePath: join(root, 'state', 'runtime.json'),
      invokeModel: async () => ({ candidates: [{ id: 'c1', content: 'verified candidate', sources: ['s1'] }] }),
      preflightMemory: async () => ({ candidateId: 'c1', verdict: 'ACCEPT', reason: 'ok' }),
      writeMemory: async () => { writes += 1; return { candidateId: 'c1', committed: true, nodeIds: ['n1'], auditReceipt: 'a1' } },
    })
    runtime.on()
    const result = await runtime.tick({ eventId: 'feedback-1', formalWrites: true })
    assert.equal(writes, 1)
    assert.equal(result.wakes[0].feedback[0].status, 'completed')
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'runtime.json'))).feedback[0].verification.confirmed, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('feedback loop is fail-closed without structured receipt', async () => {
  const candidate = memoryPropose({ id: 'c1', content: 'x', sources: ['s1'], slot: 'light', batchId: 'b1' })
  assert.equal(memoryFeedback(candidate, { candidateId: 'c1', verdict: 'DEFER', reason: 'later' }).action, 'defer')
  assert.equal(memoryVerify(candidate, { candidateId: 'c1', committed: false, nodeIds: [], auditReceipt: '' }).confirmed, false)
  const failed = await runFeedbackLoop({ candidate, preflight: async () => ({ candidateId: 'c1', verdict: 'ACCEPT', reason: 'ok' }), write: async () => ({ candidateId: 'c1', committed: true, nodeIds: [], auditReceipt: '' }) })
  assert.equal(failed.status, 'failed')
  const completed = await runFeedbackLoop({ candidate, preflight: async () => ({ candidateId: 'c1', verdict: 'ACCEPT', reason: 'ok' }), write: async () => ({ candidateId: 'c1', committed: true, nodeIds: ['n1'], auditReceipt: 'a1' }) })
  assert.equal(completed.status, 'completed')
  const merged = await runFeedbackLoop({ candidate, preflight: async () => ({ candidateId: 'c1', verdict: 'MERGE', reason: 'duplicate', mergeTarget: 'n0' }), write: async (next) => ({ candidateId: next.id, committed: true, nodeIds: ['n0'], auditReceipt: 'a2' }) })
  assert.equal(merged.status, 'completed')
})

test('shadow gate blocks promotion until repeated exact comparisons pass', () => {
  assert.deepEqual(modePolicy('shadow'), { runLegacy: true, runAlphaDog: true, formalWrites: false })
  const passed = [1, 2, 3].map((round) => compareShadow(round, { round, candidates: [], slots: [], feedback: [] }, { round, candidates: [], slots: [], feedback: [] }))
  assert.equal(canPromote(passed).ok, true)
  const root = projectFixture()
  try {
    const path = join(root, 'alpha-dog.setting.json')
    writeFileSync(path, JSON.stringify(base))
    assert.equal(promoteMode(path, passed).promoted, true)
    assert.equal(JSON.parse(readFileSync(path)).state.mode, 'alpha_dog')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
