import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlphaDogRuntime, createModelAdapter, selectTargets } from '../lib/alpha-dog.js';
import { AlphaDogGovernance } from '../lib/alpha-dog-governance.js';
import { AtomicMemoryGraph } from '../lib/memory-contract.js';
import { DEFAULT_DOG_SETTING, findUpward, loadAlphaDogSetting, registryPath, resolveAlphaDogModel, resolveDefaultAlphaDogSetting, validateAlphaDogSetting } from '../lib/alpha-dog-config.js';
import {
  ALPHA_DOG_CONFIG_SCHEMA,
  EVENTS,
  capabilityDirectory,
  createEvent,
  createReport,
  createState,
  createWakePlan,
  defaultConfig,
  filterInterface,
  parseRegistryPath,
  planBatches,
  reduceState,
  transition,
  validateConfig,
} from '../lib/alpha-dog/index.js';

test('entry control API remains MCP-facing and setting keeps CG/STG hidden', () => {
  const setting = loadAlphaDogSetting(fileURLToPath(new URL('../alpha-dog.setting.json', import.meta.url)));
  assert.equal(setting.interfaces.Alpha_Dog_On, true);
  assert.equal(setting.interfaces.Alpha_Dog_Off, true);
  // 断言绑「随包发布的默认件」（engine 包根），不绑部署态文件（../../ 在包外，
  // npm 安装树中不存在；旧写法会把测试绑到可变的部署配置上）。
  assert.equal(setting.enabled, false);
  assert.deepEqual(setting.expose, { cg: false, stg: false });
});

test('schema and defaults are runtime-only and contain no secret field', () => {
  const config = defaultConfig({ provider: 'local', model: 'fixture' });
  assert.equal(config.enabled, false);
  assert.equal(validateConfig(config).ok, true);
  assert.equal(Object.hasOwn(ALPHA_DOG_CONFIG_SCHEMA.properties, 'apiKey'), false);
});

test('15 and 21 hide interrupt/fixed_defer while preserving cg/stg', () => {
  for (const schedule of [15, 21]) {
    const directory = capabilityDirectory(schedule);
    assert.deepEqual(directory.tools, ['cg', 'stg']);
    assert.deepEqual(filterInterface(['interrupt', 'fixed_defer', 'backfill', 'monitor'], { schedule }), ['backfill', 'monitor']);
  }
});

test('30 opens all four modes and filtering is deterministic', () => {
  assert.deepEqual(capabilityDirectory(30).modes, ['interrupt', 'fixed_defer', 'backfill', 'monitor']);
  assert.deepEqual(filterInterface(['monitor', 'interrupt', 'fixed_defer', 'backfill'], { schedule: 30 }), ['monitor', 'interrupt', 'fixed_defer', 'backfill']);
});

test('state machine accepts lifecycle and rejects invalid transition', () => {
  assert.equal(transition('off', 'on'), 'idle');
  assert.equal(transition('idle', 'plan'), 'planned');
  assert.throws(() => transition('off', 'wake'), /invalid transition/);
  let state = createState();
  for (const event of [EVENTS.ON, EVENTS.WAKE_PLANNED, EVENTS.WAKE_STARTED, EVENTS.REPORT, EVENTS.WAKE_FINISHED]) {
    state = reduceState(state, createEvent(event, {}, { seq: state.counter }));
  }
  assert.equal(state.state, 'idle');
  assert.equal(state.enabled, true);
});

test('production assembly finds the nearest registry and package-root setting', () => {
  const settingPath = fileURLToPath(new URL('../alpha-dog.setting.json', import.meta.url));
  const compiledEntry = new URL('../lib/index.js', import.meta.url).href;
  assert.equal(resolveDefaultAlphaDogSetting(compiledEntry), settingPath);
  assert.equal(loadAlphaDogSetting(settingPath).version, '2.1.0');
  // findUpward 的自证在临时目录内完成：发行仓里没有 agent_registry.json，
  // 断言真实路径是否存在会把测试绑到仓库外的私有文件上。
  const dir = mkdtempSync(join(tmpdir(), 'alpha-dog-registry-'));
  try {
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'agent_registry.json'), '{"entries":{}}');
    assert.equal(findUpward(nested, 'agent_registry.json'), join(dir, 'agent_registry.json'));
    assert.equal(findUpward(dir, 'absent-file.json'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 模型目标必须 provider+model 成对：宿主 dsh-llm 两者皆必填，只给 provider
  // 会抛 INVALID_MODEL_INFO。拿不到就返回 null 让调用方降级，绝不猜 model。
  assert.deepEqual(
    resolveAlphaDogModel({ provider: 'host', name: 'host-default' }, { provider: 'routed-p', model: 'routed-m' }),
    { provider: 'routed-p', model: 'routed-m' },
  );
  assert.equal(resolveAlphaDogModel({ provider: 'host', name: 'host-default' }, null), null);
  assert.equal(resolveAlphaDogModel({ provider: 'host', name: 'host-default' }, { provider: 'routed-p' }), null);
  assert.deepEqual(
    resolveAlphaDogModel({ provider: 'fixture-p', name: 'fixture-m' }, { provider: 'routed-p', model: 'routed-m' }),
    { provider: 'fixture-p', model: 'fixture-m' },
  );
});

test('registry path keeps aliases and stays within root', () => {
  const root = 'C:/alpha-memory';
  const registry = { entries: {
    '@alias': { path: 'mapping.json' },
    '@dotdot-prefix': { path: '..cache/file.json' },
    '@absolute': { path: 'C:/outside.json' },
    '@escape': { path: '../outside.json' },
    '@nested-escape': { path: 'nested/../../outside.json' },
  } };
  assert.equal(registryPath(registry, '@alias', root), 'C:\\alpha-memory\\mapping.json');
  assert.equal(registryPath(registry, '@dotdot-prefix', root), 'C:\\alpha-memory\\..cache\\file.json');
  assert.equal(registryPath(registry, '@absolute', root), null);
  assert.equal(registryPath(registry, '@escape', root), null);
  assert.equal(registryPath(registry, '@nested-escape', root), null);
  assert.deepEqual(parseRegistryPath('@alpha'), { kind: 'alias', alias: 'alpha', path: null });
  assert.equal(parseRegistryPath('registry.json').path, 'registry.json');
  assert.deepEqual(planBatches(['a', 'b', 'c', 'd', 'e'], 2), [
    { batch: 0, entries: ['a', 'b'] },
    { batch: 1, entries: ['c', 'd'] },
    { batch: 2, entries: ['e'] },
  ]);
});

test('wake plan and report are structured and mention-aware', () => {
  const plan = createWakePlan({ roundId: 'r1', schedule: 21, registry: ['a', 'b'], batchSize: 1, mention: 'required', modes: ['interrupt', 'backfill', 'monitor'] });
  assert.deepEqual(plan.modes, ['backfill', 'monitor']);
  assert.deepEqual(plan.batches[1].entries, ['b']);
  const report = createReport({ roundId: 'r1', state: 'idle', plan, completed: ['a'] });
  assert.equal(report.ok, true);
  assert.equal(report.planVersion, 'alpha-dog/1');
});

test('incremental runtime wakes every due slot in configured order', async () => {
  const calls = [];
  const wakes = [];
  const runtime = new AlphaDogRuntime({
    setting: validateAlphaDogSetting(DEFAULT_DOG_SETTING),
    invokeModel: async ({ slot }) => { calls.push(slot); return { ok: true }; },
    onWake: (wake) => wakes.push(wake),
  });
  assert.equal((await runtime.tick()).skipped, true);
  runtime.on();
  for (let round = 0; round < 30; round += 1) await runtime.tick();
  assert.deepEqual(calls, [15, 21, 15, 30]);
  assert.deepEqual(wakes.filter((wake) => wake.round === 30).map((wake) => wake.slot), [15, 30]);
  assert.equal(wakes.find((wake) => wake.slot === 15).modelCalled, true);
  assert.equal(runtime.lastReport.kind, 'report');
  const before = runtime.status().round;
  runtime.on();
  assert.equal(runtime.status().round, before);
  runtime.off();
  assert.equal((await runtime.tick()).skipped, true);
});

test('off invalidates an in-flight wake and does not commit its result', async () => {
  let release;
  const model = new Promise((resolve) => { release = resolve; });
  const wakes = [];
  const runtime = new AlphaDogRuntime({
    setting: validateAlphaDogSetting({ ...DEFAULT_DOG_SETTING, slots: [1], wakeOrder: [1], actions: { 1: ['interrupt'] } }),
    invokeModel: async () => model,
    onWake: (wake) => wakes.push(wake),
  });
  runtime.on();
  const beforeOff = runtime.status().wakeCount;
  const pending = runtime.tick();
  await new Promise((resolve) => setImmediate(resolve));
  runtime.off();
  release({ ok: true });
  const result = await pending;
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'off');
  assert.equal(wakes.length, 0);
  assert.equal(runtime.status().wakeCount, beforeOff);
});

test('concurrent ticks are serialized and cannot duplicate a round wake', async () => {
  const wakes = [];
  const runtime = new AlphaDogRuntime({
    setting: validateAlphaDogSetting({ ...DEFAULT_DOG_SETTING, slots: [2], wakeOrder: [2], actions: { 2: ['interrupt'] } }),
    invokeModel: async () => ({ ok: true }),
    onWake: (wake) => wakes.push(wake),
  });
  runtime.on();
  await Promise.all([runtime.tick(), runtime.tick()]);
  assert.equal(runtime.status().round, 2);
  assert.deepEqual(wakes.map((wake) => wake.round), [2]);
});

test('custom positive schedules remain configurable', () => {
  const setting = validateAlphaDogSetting({
    ...DEFAULT_DOG_SETTING,
    slots: [10, 20, 50],
    wakeOrder: [20, 10, 50],
    actions: {
      10: ['backfill', 'monitor'],
      20: ['backfill', 'monitor'],
      50: ['interrupt', 'fixed_defer', 'backfill', 'monitor'],
    },
  });
  assert.deepEqual(setting.slots, [10, 20, 50]);
  assert.deepEqual(setting.wakeOrder, [20, 10, 50]);
});

test('runtime resolves target list path into entries', () => {
  // 目标清单在临时目录内自造：发行仓不含私有目标清单，测试不得依赖仓库外的文件。
  const dir = mkdtempSync(join(tmpdir(), 'alpha-dog-targets-'));
  try {
    writeFileSync(join(dir, 'targets.json'), JSON.stringify({
      files: [{ id: 1, path: 'a.md', layer: 'knowledge', importance: 0.5, status: 'ok' }],
    }));
    const runtime = new AlphaDogRuntime({
      setting: validateAlphaDogSetting(DEFAULT_DOG_SETTING),
      root: dir,
    });
    const entries = runtime.loadTargets();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'a.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental runtime filters target entries into bounded batches', () => {
  assert.deepEqual(selectTargets([{ id: 1, path: 'a.md', keywords: ['Alpha'] }, { id: 2, path: 'b.md', keywords: ['Beta'] }], 'alpha', 1).map((entry) => entry.id), [1]);
  const adapter = createModelAdapter(validateAlphaDogSetting({ ...DEFAULT_DOG_SETTING, model: { provider: 'fixture', name: 'fixture' } }));
  assert.equal(adapter.config.apiKeyRef, '');
});

test('config rejects unsupported schedule and provider/model blanks', () => {
  assert.equal(validateConfig({ schedule: 0 }).ok, false);
  assert.equal(validateConfig({ provider: '', model: '' }).ok, false);
});

test('P0 governance degrades, queues pending work, opens the circuit, and recovers after cooldown', async () => {
  let now = 1_000;
  let calls = 0;
  const governance = new AlphaDogGovernance({ failureThreshold: 2, cooldownMs: 50, maxPending: 2, now: () => now });
  const failing = async () => { calls += 1; throw new Error('bridge-down'); };
  const request = { slot: 15, round: 15, actions: ['monitor'], targets: [{ path: 'a.md' }] };
  assert.equal((await governance.invoke(request, failing)).status, 'degraded');
  assert.equal((await governance.invoke({ ...request, round: 30 }, failing)).reason, 'bridge-down');
  assert.equal((await governance.invoke({ ...request, round: 45 }, failing)).reason, 'circuit-open');
  assert.equal(calls, 2);
  assert.equal(governance.snapshot().pending.length, 2);
  assert.equal(governance.snapshot().circuit, 'open');
  now += 51;
  const recovered = await governance.invoke({ ...request, round: 60 }, async () => ({ status: 'ok' }));
  assert.equal(recovered.status, 'ok');
  assert.equal(governance.snapshot().circuit, 'closed');
  assert.equal(governance.snapshot().metrics.successes, 1);
});

test('P0 runtime keeps scheduling alive in mechanical mode and invalidates off results', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runtime = new AlphaDogRuntime({
    setting: validateAlphaDogSetting({ ...DEFAULT_DOG_SETTING, slots: [1], wakeOrder: [1], actions: { 1: ['monitor'] }, model: { provider: '', name: '' } }),
    invokeModel: () => pending,
  });
  runtime.on();
  const tick = runtime.tick({ query: '' });
  runtime.off();
  release({ status: 'ok' });
  assert.equal((await tick).reason, 'off');
  assert.equal(runtime.status().governance.pending.length, 0);

  const degraded = new AlphaDogRuntime({
    setting: validateAlphaDogSetting({ ...DEFAULT_DOG_SETTING, slots: [1], wakeOrder: [1], actions: { 1: ['monitor'] }, model: { provider: '', name: '' } }),
    invokeModel: async () => ({ status: 'not-configured' }),
  });
  degraded.on();
  const result = await degraded.tick();
  assert.equal(result.wakes[0].degraded, true);
  assert.equal(degraded.status().governance.pending.length, 1);
});

test('P0 mapping failures reuse the last valid snapshot', () => {
  const runtime = new AlphaDogRuntime({ setting: validateAlphaDogSetting(DEFAULT_DOG_SETTING) });
  runtime.mappingSnapshot = [{ id: 1, path: 'snapshot.md' }];
  runtime.setting.mapping = { json: 'missing.json', md: '' };
  assert.deepEqual(runtime.loadTargets(), [{ id: 1, path: 'snapshot.md' }]);
});

test('P1 atomic memory contract matches official entity relation observation discipline', () => {
  const events = [];
  const graph = new AtomicMemoryGraph({ relationTypes: ['depends_on'], onResourceUpdated: (event) => events.push(event) });
  assert.deepEqual(graph.createEntities([
    { name: 'Alpha', entityType: 'project', observations: ['uses atomic facts', 'uses atomic facts'] },
    { name: 'Dog', entityType: 'runtime', observations: [] },
    { name: 'Alpha', entityType: 'ignored', observations: ['duplicate entity'] },
  ]).map((item) => item.name), ['Alpha', 'Dog']);
  assert.throws(() => graph.createRelations([{ from: 'Alpha', to: 'Missing', relationType: 'depends_on' }]), /endpoint missing/);
  assert.throws(() => graph.createRelations([{ from: 'Alpha', to: 'Dog', relationType: 'free text' }]), /unsupported relationType/);
  graph.createRelations([{ from: 'Alpha', to: 'Dog', relationType: 'depends_on' }, { from: 'Alpha', to: 'Dog', relationType: 'depends_on' }]);
  graph.addObservations([{ entityName: 'Dog', contents: ['runs maintenance', 'runs maintenance'] }]);
  assert.throws(() => graph.addObservations([{ entityName: 'Missing', contents: ['x'] }]), /entity not found/);
  assert.equal(graph.readGraph().resource, 'memory://knowledge-graph');
  assert.equal(graph.searchNodes('maintenance').entities[0].name, 'Dog');
  assert.equal(graph.searchNodes('maintenance').relations.length, 1);
  assert.equal(graph.openNodes(['Alpha']).relations.length, 1);
  const beforeAtomicFailure = graph.readGraph();
  assert.throws(() => graph.addObservations([
    { entityName: 'Alpha', contents: ['must not commit'] },
    { entityName: 'Missing', contents: ['invalid'] },
  ]), /entity not found/);
  assert.deepEqual(graph.readGraph(), beforeAtomicFailure);
  assert.throws(() => graph.deleteObservations([
    { entityName: 'Alpha', observations: ['uses atomic facts'] },
    { entityName: 'Missing', observations: ['invalid'] },
  ]), /entity not found/);
  assert.deepEqual(graph.readGraph(), beforeAtomicFailure);
  assert.throws(() => graph.deleteRelations([
    { from: 'Alpha', to: 'Dog', relationType: 'depends_on' },
    { from: 'Alpha', to: 'Dog', relationType: 'free text' },
  ]), /unsupported relationType/);
  assert.deepEqual(graph.readGraph(), beforeAtomicFailure);
  const removed = graph.deleteEntities(['Dog', 'Missing']);
  assert.deepEqual(removed, { deleted: ['Dog'], notFound: ['Missing'] });
  assert.equal(graph.readGraph().relations.length, 0);
  assert.ok(events.every((event) => event.uri === 'memory://knowledge-graph'));
  assert.deepEqual(events.map((event) => event.operation), ['create_entities', 'create_relations', 'add_observations', 'delete_entities']);
});

test('failed batch can be recovered alone without reprocessing completed batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-dog-recovery-'));
  try {
    writeFileSync(join(dir, 'targets.json'), JSON.stringify({
      files: [
        { id: 1, path: 'a.md', tags: ['即时落盘·15轮'], importance: 1 },
        { id: 2, path: 'b.md', tags: ['即时落盘·15轮'], importance: 0.9 },
      ],
    }));
    let failFirst = true;
    const runtime = new AlphaDogRuntime({
      setting: validateAlphaDogSetting(DEFAULT_DOG_SETTING),
      root: dir,
      packageRoot: fileURLToPath(new URL('..', import.meta.url)),
      statePath: join(dir, 'runtime.json'),
      governanceOptions: { failureThreshold: 9, cooldownMs: 50, maxPending: 100 },
      invokeModel: async (request) => (failFirst && request.round === 15 && request.batch?.batchId === 'light-15-01'
        ? { status: 'error', error: 'injected' }
        : { status: 'ok', candidates: [] }),
    });
    runtime.on();
    for (let i = 1; i <= 15; i += 1) await runtime.tick({ eventId: `rec-${i}` });
    const failed = runtime.batches.filter((batch) => batch.status === 'failed');
    assert.equal(failed.length, 1);
    const completedBefore = runtime.batches.filter((batch) => batch.status === 'completed').map((batch) => batch.batchId);
    failFirst = false;
    assert.deepEqual(runtime.recoverFailedBatches(), [failed[0].batchId]);
    assert.equal(failed[0].attempts, 1);
    // 有排队项时 tick 必须继续排空（否则恢复项永不执行）
    await runtime.tick({ eventId: 'rec-recover-1' });
    assert.equal(runtime.batches.find((batch) => batch.batchId === failed[0].batchId).status, 'completed');
    const completedAfter = runtime.batches.filter((batch) => batch.status === 'completed').map((batch) => batch.batchId);
    assert.deepEqual(completedAfter, [...completedBefore, failed[0].batchId]);
    assert.equal(new Set(completedAfter).size, completedAfter.length);
    // 无失败项时恢复为空；已完成批次不受恢复影响
    assert.deepEqual(runtime.recoverFailedBatches(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
