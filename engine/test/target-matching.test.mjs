import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlphaDogRuntime, matchTargets } from '../lib/alpha-dog.js'
import { validateAlphaDogSetting } from '../lib/alpha-dog-config.js'

// 真实记忆映射表用「域·N轮」复合标签，且域归属写在 layer；档口配置用统一标签。
// 只做精确匹配会把三个档口全筛成 0 条（看门狗按时醒、空跑、不留痕）。
const base = {
  enabled: true,
  interfaces: { Alpha_Dog_On: true, Alpha_Dog_Off: true, cg: false, stg: false },
  schedule: {
    slots: [
      { id: 'light', label: '即时落盘', interval: 15, prompt: 'watchdog-light', registryTags: ['即时落盘·15轮'], allowedModes: ['backfill', 'monitor'] },
      { id: 'medium', label: '中档巡检', interval: 21, prompt: 'watchdog-medium', registryTags: ['系统巡检·21轮'], allowedModes: ['backfill', 'monitor'] },
      { id: 'heavy', label: '重档巡检', interval: 30, prompt: 'watchdog-heavy', registryTags: ['记忆巡检·30轮'], allowedModes: ['interrupt', 'fixed_defer', 'backfill', 'monitor'] },
    ],
    simultaneousOrder: ['medium', 'light', 'heavy'], sequentialWake: true,
  },
  registry: { memoryMappingTableMd: 'targets.md', memoryMappingTableJson: 'targets.json' },
  initialization: { mention: 'on', status: 'configured' },
  model: { name: '', baseUrl: '', api: '', apiKeyRef: '', models: [] },
  state: { directory: 'state', mode: 'shadow' },
  governance: { failureThreshold: 3, cooldownMs: 100, maxPending: 10 },
  batchSize: 40,
}

// 与真实表同构：tags 为空，域归属在 layer。
const table = [
  { id: 1, path: 'a.md', layer: '即时落盘·15轮' },
  { id: 2, path: 'b.md', layer: '哲学·21轮' },
  { id: 3, path: 'c.md', layer: '评级DAG·21轮' },
  { id: 4, path: 'd.md', layer: '人格核心·30轮' },
  { id: 5, path: 'e.md', layer: '日常共生·30轮' },
  { id: 6, path: 'f.md', layer: '情绪, 裂缝, s01, s10, 不是' },
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alpha-dog-targets-'))
  mkdirSync(join(root, 'prompts'), { recursive: true })
  for (const name of ['watchdog-light', 'watchdog-medium', 'watchdog-heavy', 'watchdog-batch-report']) writeFileSync(join(root, 'prompts', `${name}.md`), name)
  writeFileSync(join(root, 'targets.json'), JSON.stringify({ files: table }))
  return root
}

test('slot matching keeps exact tags, adds ·N轮 suffix fallback, and reports unlabeled', () => {
  const setting = validateAlphaDogSetting(base)
  const [light, medium, heavy] = setting.schedule.slots

  // layer 上带同后缀的域应被对应档口吸收
  assert.deepEqual(matchTargets(table, light.registryTags).matched.map((entry) => entry.id), [1])
  assert.deepEqual(matchTargets(table, medium.registryTags).matched.map((entry) => entry.id), [2, 3])
  assert.deepEqual(matchTargets(table, heavy.registryTags).matched.map((entry) => entry.id), [4, 5])

  // 脏行（layer 是关键词串）不属于任何档口，但必须可见，不能静默消失
  const heavyResult = matchTargets(table, heavy.registryTags)
  assert.equal(heavyResult.matched.length + heavyResult.unlabeled.length, table.length)
  assert.ok(heavyResult.unlabeled.some((entry) => entry.id === 6))

  // 原有精确匹配仍然成立（不回归）
  const exact = [{ id: 7, path: 'g.md', tags: ['记忆巡检·30轮'], layer: 'custom' }]
  assert.deepEqual(matchTargets(exact, heavy.registryTags).matched.map((entry) => entry.id), [7])
  assert.deepEqual(matchTargets(exact, medium.registryTags).matched, [])

  // 未配置 registryTags 时仍匹配全部（原有语义）
  assert.equal(matchTargets(table, []).matched.length, table.length)

  // 每个条目只归属一个档口，不会重复处理
  const owners = new Map()
  for (const slot of setting.schedule.slots) {
    for (const entry of matchTargets(table, slot.registryTags).matched) {
      assert.equal(owners.has(entry.id), false, `entry ${entry.id} matched twice`)
      owners.set(entry.id, slot.id)
    }
  }
  assert.equal(owners.size, 5)
})

test('runtime records per-slot target stats so an empty selection is visible', async () => {
  const root = fixture()
  try {
    const setting = validateAlphaDogSetting({ ...base, batchSize: 40 })
    const runtime = new AlphaDogRuntime({ setting, root, packageRoot: root, statePath: join(root, 'state', 'runtime.json'), invokeModel: async () => ({ status: 'ok' }) })
    runtime.counter.restore(29)
    runtime.on()
    const result = await runtime.tick({ eventId: 'r30' })

    const stats = runtime.status().targetStats
    assert.equal(stats.heavy.total, 6)
    assert.equal(stats.heavy.matched, 2)
    assert.equal(stats.heavy.unlabeled, 4)
    assert.deepEqual(stats.heavy.unlabeledIds, ['1', '2', '3', '6'])
    assert.deepEqual(stats.heavy.tags, ['记忆巡检·30轮'])

    const heavyWake = result.wakes.find((wake) => wake.slotId === 'heavy')
    assert.equal(heavyWake.batch.entries.length, 2)
    assert.deepEqual(heavyWake.targets.map((entry) => entry.id), [4, 5])

    // 空筛选仍然入队（保持原有「空批次也建 plan」行为），但 stats 让原因可见。
    // 用不带 ·N轮 后缀的标签来制造真正的空集：带后缀的标签会按后缀命中同轮域。
    const empty = new AlphaDogRuntime({
      setting: validateAlphaDogSetting({ ...base, schedule: { ...base.schedule, slots: [{ ...base.schedule.slots[0], registryTags: ['不存在的档口标签'] }], simultaneousOrder: ['light'] } }),
      root, packageRoot: root, statePath: join(root, 'state', 'empty.json'), invokeModel: async () => ({ status: 'ok' }),
    })
    empty.counter.restore(14)
    empty.on()
    const emptyResult = await empty.tick({ eventId: 'e15' })
    assert.equal(emptyResult.wakes.length, 1)
    assert.equal(empty.status().targetStats.light.matched, 0)
    assert.equal(empty.status().targetStats.light.unlabeled, 6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
