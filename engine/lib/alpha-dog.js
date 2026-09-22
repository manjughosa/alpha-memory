import { join } from 'node:path';
import { AlphaDogGovernance } from './alpha-dog-governance.js';
import { memoryPropose, runFeedbackLoop } from './alpha-dog/feedback.js';
import { appendShadowAudit, compareShadow } from './alpha-dog/modes.js';
import { AlphaDogPower, AlphaDogCounter, AlphaDogWakeQueue, createBatches, dueSlots, invokeWatchdog, loadRuntimeState, loadWatchdogPrompt, readRegistry, saveRuntimeState } from './alpha-dog/runtime/index.js';
export class AlphaDogRuntime {
    setting;
    root;
    packageRoot;
    registry;
    invokeModel;
    onWake;
    power = new AlphaDogPower();
    counter;
    wakeQueue = new AlphaDogWakeQueue();
    wakeCount = 0;
    lastWake = null;
    lastReport = { kind: 'report' };
    tickQueue = Promise.resolve();
    governance;
    mappingSnapshot = [];
    mappingError = null;
    /** 每个档口最近一次的筛选统计：筛到 0 条时必须留痕，不能静默空跑。 */
    targetStats = {};
    batches = [];
    processedEvents = new Set();
    statePath;
    shadowAuditPath;
    persistent;
    initializationHandler;
    preflightMemory;
    writeMemory;
    feedback = [];
    constructor(options = {}) {
        this.setting = options.setting;
        this.root = options.root || process.cwd();
        this.packageRoot = options.packageRoot || this.root;
        this.registry = options.registry || null;
        this.invokeModel = options.invokeModel || (async () => ({ status: 'model-disabled' }));
        this.onWake = options.onWake || (() => { });
        this.governance = options.governance || new AlphaDogGovernance(options.governanceOptions || this.setting?.governance);
        this.statePath = join(this.packageRoot, this.setting?.state?.directory || 'state', 'runtime.json');
        this.shadowAuditPath = join(this.packageRoot, this.setting?.state?.directory || 'state', 'shadow-comparisons.json');
        this.persistent = Boolean(options.packageRoot || options.statePath);
        if (options.statePath)
            this.statePath = options.statePath;
        const restored = this.persistent ? loadRuntimeState(this.statePath, { round: 0, wakeCount: 0, batches: [], processedEvents: [] }) : { round: 0, wakeCount: 0, batches: [], processedEvents: [] };
        this.counter = new AlphaDogCounter(restored.round);
        this.wakeCount = restored.wakeCount;
        this.batches = Array.isArray(restored.batches) ? restored.batches : [];
        this.processedEvents = new Set(Array.isArray(restored.processedEvents) ? restored.processedEvents : []);
        this.feedback = Array.isArray(restored.feedback) ? restored.feedback : [];
        this.targetStats = restored.targetStats && typeof restored.targetStats === 'object' ? restored.targetStats : {};
        this.initializationHandler = options.initializationHandler || null;
        this.preflightMemory = options.preflightMemory || null;
        this.writeMemory = options.writeMemory || null;
    }
    on() {
        if (this.setting?.initialization?.status === 'declined')
            return { ...this.status(), initialization: 'declined', watchdog: 'dormant' };
        if (this.setting?.initialization?.status !== 'configured' && this.initializationHandler)
            return { ...this.status(), initialization: this.initializationHandler(), watchdog: 'dormant' };
        this.power.on();
        this.persist();
        return { ...this.status(), watchdog: 'dormant' };
    }
    off() {
        this.power.off();
        this.wakeQueue.cancelPending();
        this.persist();
        return { ...this.status(), watchdog: 'dormant' };
    }
    /** 失败批次单独恢复：只重排 failed 批次，已完成批次原样保留（不重复处理）。 */
    recoverFailedBatches({ maxAttempts = 2 } = {}) {
        const retried = [];
        const failedItems = this.wakeQueue.snapshot().filter((item) => item.status === 'failed');
        for (const item of failedItems) {
            const batch = this.batches.find((b) => b.batchId === item?.batch?.batchId);
            if (!batch || batch.status !== 'failed')
                continue;
            const attempts = Number(batch.attempts || 0);
            if (attempts >= maxAttempts)
                continue;
            batch.attempts = attempts + 1;
            batch.status = 'pending';
            batch.failed = 0;
            if (this.wakeQueue.requeue(item.id))
                retried.push(batch.batchId);
        }
        if (retried.length)
            this.persist();
        return retried;
    }
    status() {
        return { running: this.power.snapshot().running, round: this.counter.current(), wakeCount: this.wakeCount, lastWake: this.lastWake, governance: this.governance.snapshot(), mappingError: this.mappingError, targetStats: this.targetStats, queued: this.wakeQueue.snapshot().filter((item) => item.status === 'queued').length, mode: this.setting?.state?.mode || 'legacy' };
    }
    async tick(context = {}) {
        const run = async () => {
            if (!this.power.snapshot().running)
                return { skipped: true, reason: 'off', ...this.status() };
            const eventId = String(context.eventId || context.event?.id || '');
            if (eventId && this.processedEvents.has(eventId))
                return { skipped: true, reason: 'duplicate-event', ...this.status() };
            const generation = this.power.snapshot().generation;
            const suppliedRound = Number(context.round);
            const round = Number.isInteger(suppliedRound) && suppliedRound > this.counter.current() ? this.counter.restore(suppliedRound) : this.counter.tick();
            if (eventId)
                this.processedEvents.add(eventId);
            const slots = dueSlots(round, this.setting.schedule);
            const hasQueued = this.wakeQueue.snapshot().some((item) => item.status === 'queued');
            if (slots.length === 0 && !hasQueued) {
                this.persist();
                return { ...this.status(), skipped: false, wakes: [], modelCalls: 0 };
            }
            const entries = this.loadTargets();
            for (const slot of slots) {
                const { matched: targets, unlabeled } = matchTargets(entries, slot.registryTags, context.query);
                const batches = createBatches(slot, round, targets, this.setting.batchSize, Number(slot.tokenBudget || this.setting.tokenBudget || 0));
                this.batches.push(...batches);
                // 筛选结果必须留痕：档口筛出 0 条时状态里要看得见，否则看门狗
                // 会「按时醒、加载说明书、空跑」而不留任何痕迹。
                this.targetStats[slot.id] = {
                    round,
                    tags: Array.isArray(slot.registryTags) ? [...slot.registryTags] : [],
                    total: entries.length,
                    matched: targets.length,
                    unlabeled: unlabeled.length,
                    unlabeledIds: unlabeled.slice(0, 20).map((entry) => String(entry.id ?? entry.path)),
                };
                for (const batch of batches.length ? batches : [createEmptyBatch(slot, round)]) {
                    this.wakeQueue.enqueue({ id: `${slot.id}:${round}:${batch.batchId}`, slot, round, batch, context });
                }
            }
            const wakes = [];
            let plan = this.wakeQueue.next();
            while (plan) {
                if (!this.power.isCurrent(generation))
                    return { skipped: true, reason: 'off', ...this.status() };
                const prompt = loadWatchdogPrompt(this.packageRoot, plan.slot.prompt);
                const wakeRound = Number.isInteger(plan.round) ? plan.round : round;
                const wake = { slot: plan.slot.interval, slotId: plan.slot.id, round: wakeRound, actions: [...plan.slot.allowedModes], batch: plan.batch, targets: plan.batch.entries, prompt: prompt.path, modelCalled: true };
                const request = { slot: plan.slot.interval, round: wakeRound, actions: wake.actions, targets: wake.targets, prompt: prompt.text, context: plan.context, batch: plan.batch };
                wake.model = await this.governance.invoke(request, (payload) => invokeWatchdog(this.invokeModel, payload), () => this.power.isCurrent(generation));
                if (!this.power.isCurrent(generation) || wake.model?.status === 'invalidated')
                    return { skipped: true, reason: 'off', ...this.status() };
                wake.degraded = wake.model?.status === 'degraded';
                if (!wake.degraded && this.preflightMemory && this.writeMemory && context.formalWrites === true) {
                    const proposals = extractCandidates(wake.model, plan);
                    wake.feedback = [];
                    for (const proposal of proposals) {
                        const result = await runFeedbackLoop({ candidate: proposal, preflight: this.preflightMemory, write: this.writeMemory });
                        wake.feedback.push(result);
                        this.feedback.push(result);
                    }
                }
                else if (!wake.degraded && context.formalWrites !== true) {
                    wake.feedback = extractCandidates(wake.model, plan).map((candidate) => ({ status: 'shadow', candidate }));
                    this.feedback.push(...wake.feedback);
                }
                const feedbackFailed = (wake.feedback || []).some((item) => item.status === 'failed');
                plan.batch.status = wake.degraded || feedbackFailed ? 'failed' : 'completed';
                plan.batch.processed = plan.batch.status === 'completed' ? plan.batch.entries.length : 0;
                plan.batch.failed = plan.batch.status === 'failed' ? Math.max(1, plan.batch.entries.length) : 0;
                this.wakeQueue.complete(plan.id, !wake.degraded);
                this.wakeCount += 1;
                this.lastWake = wake;
                this.onWake(wake);
                wakes.push(wake);
                this.persist();
                plan = this.wakeQueue.next();
            }
            const reportPrompt = loadWatchdogPrompt(this.packageRoot, 'watchdog-batch-report');
            this.lastReport = { kind: 'report', round, prompt: reportPrompt.path, summary: { wakes: wakes.length, completed: wakes.filter((wake) => !wake.degraded).length, degraded: wakes.filter((wake) => wake.degraded).length, batches: wakes.map((wake) => wake.batch?.batchId).filter(Boolean) }, wakes };
            if (this.setting?.state?.mode === 'shadow' && context.legacyResult) {
                const alphaDogResult = { round, candidates: wakes.flatMap((wake) => wake.feedback || []), slots: wakes.map((wake) => wake.slotId), feedback: wakes.flatMap((wake) => wake.feedback || []) };
                const comparison = compareShadow(round, context.legacyResult, alphaDogResult);
                if (this.persistent)
                    appendShadowAudit(this.shadowAuditPath, comparison);
                this.lastReport.shadowComparison = comparison;
            }
            this.persist();
            return { ...this.status(), skipped: false, wakes, modelCalls: wakes.length };
        };
        const next = this.tickQueue.then(run, run);
        this.tickQueue = next.catch(() => undefined);
        return next;
    }
    loadTargets() {
        const result = readRegistry(this.setting, this.registry, this.root, this.mappingSnapshot);
        this.mappingSnapshot = result.entries;
        this.mappingError = result.error;
        return result.entries;
    }
    persist() {
        if (!this.persistent)
            return null;
        return saveRuntimeState(this.statePath, { version: 'alpha-dog/1', running: this.power.snapshot().running, round: this.counter.current(), wakeCount: this.wakeCount, batches: this.batches, feedback: this.feedback.slice(-1000), wakeQueue: this.wakeQueue.snapshot(), processedEvents: [...this.processedEvents].slice(-1000), lastWake: this.lastWake, lastReport: this.lastReport, targetStats: this.targetStats, governance: this.governance.snapshot(), savedAt: new Date().toISOString() });
    }
}
function extractCandidates(model, plan) {
    const raw = model?.candidates || model?.result?.candidates || [];
    if (!Array.isArray(raw))
        return [];
    return raw.map((item, index) => memoryPropose({
        id: item.id || `${plan.batch.batchId}-candidate-${index + 1}`,
        content: String(item.content || ''),
        sources: Array.isArray(item.sources) ? item.sources : plan.batch.fileIds,
        slot: plan.slot.id,
        batchId: plan.batch.batchId,
    })).filter((item) => item.content);
}
// 档口标签是「域·N轮」复合形态（例如 人格核心·30轮 / 哲学·21轮），而档口配置用的是
// 统一标签（即时落盘·15轮 / 系统巡检·21轮 / 记忆巡检·30轮）。真实记忆映射表里
// tags 字段为空，域归属写在 layer：只做精确匹配会把三个档口全部筛成 0 条，
// 看门狗按时醒、加载说明书、然后空跑且不留痕。
//
// 因此匹配规则为「精确优先，后缀兜底」：
//   1. 先按档口标签精确匹配 tags / registryTags / layer（保留原有语义）；
//   2. 若档口标签带 `·N轮` 后缀，则再按同后缀匹配 —— 由各记忆域自己声明巡检节奏。
// 未配置 registryTags 时仍然匹配全部（原有行为不变）。
const SLOT_TAG_SUFFIX = /·\s*\d+\s*轮\s*$/;
function slotTagMatchers(tags = []) {
    const exact = new Set();
    const suffixes = new Set();
    for (const tag of Array.isArray(tags) ? tags : []) {
        const value = String(tag ?? '').trim();
        if (!value)
            continue;
        exact.add(value);
        const match = value.match(SLOT_TAG_SUFFIX);
        if (match)
            suffixes.add(match[0].replace(/\s+/g, ''));
    }
    return { exact, suffixes };
}
function entryTagValues(entry) {
    const values = [];
    for (const field of [entry?.tags, entry?.registryTags]) {
        if (Array.isArray(field))
            for (const value of field)
                if (value !== undefined && value !== null && String(value).trim() !== '')
                    values.push(String(value).trim());
    }
    if (entry?.layer !== undefined && entry?.layer !== null && String(entry.layer).trim() !== '')
        values.push(String(entry.layer).trim());
    return values;
}
function matchesSlotTags(entry, matchers, tagCount) {
    if (tagCount === 0)
        return true;
    const values = entryTagValues(entry);
    if (values.some((value) => matchers.exact.has(value)))
        return true;
    if (matchers.suffixes.size === 0)
        return false;
    return values.some((value) => {
        const normalized = value.replace(/\s+/g, '');
        for (const suffix of matchers.suffixes)
            if (normalized.endsWith(suffix))
                return true;
        return false;
    });
}
function filterTargets(entries, tags = [], query = '') {
    const needle = String(query || '').trim().toLowerCase();
    const matchers = slotTagMatchers(tags);
    const tagCount = Array.isArray(tags) ? tags.length : 0;
    return entries.filter((entry) => {
        const tagMatch = matchesSlotTags(entry, matchers, tagCount);
        const queryMatch = !needle || [entry.path, entry.firstLine, entry.layer, ...(entry.keywords || [])].join(' ').toLowerCase().includes(needle);
        return tagMatch && queryMatch;
    });
}
/** 筛选明细：matched 为本档口命中项，unlabeled 为本次未命中项（用于「为什么空」的诊断）。 */
export function matchTargets(entries, tags = [], query = '') {
    const matched = filterTargets(entries, tags, query);
    const matchedKeys = new Set(matched.map((entry) => String(entry?.id ?? entry?.path)));
    const unlabeled = entries.filter((entry) => !matchedKeys.has(String(entry?.id ?? entry?.path)));
    return { matched, unlabeled };
}
function createEmptyBatch(slot, round) { return { batchId: `${slot.id}-${round}-01`, slot: slot.id, fileIds: [], entries: [], status: 'pending', processed: 0, failed: 0, nextBatch: null }; }
export function selectTargets(entries, query = '', batchSize = 8) { return filterTargets(entries, [], query).slice(0, batchSize).map((entry) => ({ id: entry.id, path: entry.path, layer: entry.layer, status: entry.status, importance: entry.importance })); }
export function createModelAdapter(setting, transport = {}) { const model = setting.model || {}; const configured = Boolean((model.provider && model.name) || (model.name && model.api)); return { state: { configured, ready: false, lastError: null }, config: { ...model, apiKeyRef: model.apiKeyRef || '' }, async invoke(request) { if (!this.state.configured)
        return { status: 'not-configured', request }; if (typeof transport.invoke !== 'function')
        return { status: 'adapter-skeleton', request }; return transport.invoke(request, this.config); } }; }
