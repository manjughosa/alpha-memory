import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const MODES = ['interrupt', 'fixed_defer', 'backfill', 'monitor'];
export const DEFAULT_DOG_SETTING = {
    version: '2.1.0',
    enabled: false,
    interfaces: { Alpha_Dog_On: true, Alpha_Dog_Off: true, cg: false, stg: false },
    schedule: {
        slots: [
            { id: 'light', label: '即时落盘', interval: 15, prompt: 'alpha-dog-light', registryTags: ['即时落盘·15轮'], allowedModes: ['backfill', 'monitor'] },
            { id: 'medium', label: '中档巡检', interval: 21, prompt: 'alpha-dog-medium', registryTags: ['系统巡检·21轮'], allowedModes: ['backfill', 'monitor'] },
            { id: 'heavy', label: '重档巡检', interval: 30, prompt: 'alpha-dog-heavy', registryTags: ['记忆巡检·30轮'], allowedModes: [...MODES] },
        ],
        simultaneousOrder: ['medium', 'light', 'heavy'],
        sequentialWake: true,
    },
    registry: { memoryMappingTableMd: '@memory_mapping_table_md', memoryMappingTableJson: '@memory_mapping_table_json' },
    initialization: { mention: 'on', status: 'unconfigured' },
    model: { name: '', baseUrl: '', api: '', apiKeyRef: '', models: [] },
    state: { directory: 'state', mode: 'legacy' },
    governance: { failureThreshold: 3, cooldownMs: 300000, maxPending: 100 },
    batchSize: 8,
    sidecar: { enabled: false, mode: 'wake', network: 'off', countScope: 'tool_call', entry: 'engine/runtime/alpha-dog-sidecar.cjs', bridge: 'alpha_memory_bridge.js', node: '', serverName: 'alpha-memory' },
};
export function loadAlphaDogSetting(filePath, overrides = {}) {
    const source = filePath ? (isAbsolute(filePath) ? filePath : resolve(filePath)) : null;
    let file = {};
    let loadError = null;
    if (source) {
        try {
            file = JSON.parse(readFileSync(source, 'utf8'));
        }
        catch (error) {
            loadError = error instanceof Error ? error.message : String(error);
        }
    }
    try {
        const setting = validateAlphaDogSetting(deepMerge(DEFAULT_DOG_SETTING, normalizeLegacySetting(deepMerge(file, overrides))));
        if (loadError)
            setting.loadError = loadError;
        return setting;
    }
    catch (error) {
        const setting = validateAlphaDogSetting(DEFAULT_DOG_SETTING);
        setting.loadError = error instanceof Error ? error.message : String(error);
        return setting;
    }
}
export function findUpward(start, name) {
    let current = resolve(start);
    while (true) {
        const candidate = resolve(current, name);
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
export function resolveDefaultAlphaDogSetting(compiledEntry) {
    const current = compiledEntry.startsWith('file:') ? fileURLToPath(compiledEntry) : compiledEntry;
    return resolve(dirname(current), '..', 'alpha-dog.setting.json');
}
export function resolveAlphaDogModel(config = {}, routed = null) {
    if (config?.provider && config?.name && config.provider !== 'host')
        return { provider: config.provider, model: config.name };
    if (routed?.provider && routed?.model)
        return { provider: routed.provider, model: routed.model };
    return null;
}
export function registryPath(registry, id, root) {
    const entry = registry?.entries?.[id] || registry?.[id];
    if (!entry?.path || typeof entry.path !== 'string' || isAbsolute(entry.path))
        return null;
    const rootPath = resolve(root);
    const targetPath = resolve(rootPath, entry.path);
    const rel = relative(rootPath, targetPath);
    const outsideRoot = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    return outsideRoot ? null : targetPath;
}
export function validateAlphaDogSetting(input = {}) {
    const setting = deepMerge(DEFAULT_DOG_SETTING, normalizeLegacySetting(input));
    if (!setting.interfaces?.Alpha_Dog_On || !setting.interfaces?.Alpha_Dog_Off)
        throw new TypeError('Alpha_Dog_On/Off 必须默认暴露');
    if (!Array.isArray(setting.schedule?.slots) || setting.schedule.slots.length === 0)
        throw new TypeError('alpha-dog.schedule.slots 必须是非空数组');
    const seen = new Set();
    for (const slot of setting.schedule.slots) {
        if (!slot || typeof slot.id !== 'string' || !Number.isInteger(slot.interval) || slot.interval < 1)
            throw new TypeError('schedule slot 无效');
        if (seen.has(slot.interval))
            throw new TypeError(`重复档口: ${slot.interval}`);
        seen.add(slot.interval);
        if (!Array.isArray(slot.allowedModes) || slot.allowedModes.some((mode) => !MODES.includes(mode)))
            throw new TypeError(`档口 ${slot.id} 的 allowedModes 无效`);
        slot.registryTags = Array.isArray(slot.registryTags) ? [...slot.registryTags] : [];
    }
    setting.schedule.simultaneousOrder = [...setting.schedule.simultaneousOrder].filter((id) => setting.schedule.slots.some((slot) => slot.id === id));
    for (const slot of setting.schedule.slots)
        if (!setting.schedule.simultaneousOrder.includes(slot.id))
            setting.schedule.simultaneousOrder.push(slot.id);
    setting.schedule.sequentialWake = Boolean(setting.schedule.sequentialWake);
    setting.batchSize = Number(setting.batchSize);
    if (!Number.isInteger(setting.batchSize) || setting.batchSize < 1)
        throw new RangeError('alpha-dog.batchSize 必须是正整数');
    for (const key of ['failureThreshold', 'cooldownMs', 'maxPending']) {
        setting.governance[key] = Number(setting.governance[key]);
        if (!Number.isInteger(setting.governance[key]) || setting.governance[key] < 1)
            throw new RangeError(`governance.${key} 必须是正整数`);
    }
    if (!['on', 'off'].includes(setting.initialization.mention))
        throw new TypeError('initialization.mention 必须为 on/off');
    if (!['unconfigured', 'configured', 'declined'].includes(setting.initialization.status))
        throw new TypeError('initialization.status 无效');
    if (!['legacy', 'shadow', 'alpha_dog'].includes(setting.state.mode))
        throw new TypeError('state.mode 无效');
    if (!setting.sidecar || typeof setting.sidecar !== 'object')
        throw new TypeError('sidecar 必须是对象');
    if (typeof setting.sidecar.enabled !== 'boolean')
        throw new TypeError('sidecar.enabled 必须为布尔值');
    if (!['observe', 'signal', 'wake'].includes(setting.sidecar.mode))
        throw new TypeError('sidecar.mode 无效');
    if (!['on', 'off'].includes(setting.sidecar.network))
        throw new TypeError('sidecar.network 无效');
    if (!['tool_call', 'all_tools'].includes(setting.sidecar.countScope))
        throw new TypeError('sidecar.countScope 无效');
    if (typeof setting.sidecar.bridge !== 'string' || setting.sidecar.bridge.trim() === '')
        throw new TypeError('sidecar.bridge 无效');
    if (typeof setting.sidecar.entry !== 'string' || setting.sidecar.entry.trim() === '')
        throw new TypeError('sidecar.entry 无效');
    if (typeof setting.sidecar.node !== 'string')
        throw new TypeError('sidecar.node 必须为字符串');
    if (typeof setting.sidecar.serverName !== 'string' || setting.sidecar.serverName.trim() === '')
        throw new TypeError('sidecar.serverName 无效');
    return withLegacyCompatibility(setting);
}
function normalizeLegacySetting(input) {
    if (Array.isArray(input.slots)) {
        input.schedule = {
            slots: input.slots.map((interval) => {
                const id = interval === 15 ? 'light' : interval === 21 ? 'medium' : interval === 30 ? 'heavy' : `slot-${interval}`;
                const allowedModes = input.actions?.[interval] || (interval === 30 ? [...MODES] : ['backfill', 'monitor']);
                const prompt = allowedModes.includes('interrupt') || allowedModes.includes('fixed_defer') ? 'alpha-dog-heavy' : interval === 21 ? 'alpha-dog-medium' : 'alpha-dog-light';
                return { id, label: `${interval}轮`, interval, prompt, registryTags: [], allowedModes };
            }),
            simultaneousOrder: (input.wakeOrder || input.slots).map((interval) => interval === 15 ? 'light' : interval === 21 ? 'medium' : interval === 30 ? 'heavy' : `slot-${interval}`),
            sequentialWake: true,
        };
    }
    if (input.expose && !input.interfaces)
        input.interfaces = { Alpha_Dog_On: true, Alpha_Dog_Off: true, ...input.expose };
    if (input.targets && !input.registry)
        input.registry = { memoryMappingTableMd: `@${input.targets.md}`, memoryMappingTableJson: `@${input.targets.json}` };
    if (!input.initialization)
        input.initialization = { mention: 'on', status: 'unconfigured' };
    if (!input.state)
        input.state = { directory: 'state', mode: 'legacy' };
    return input;
}
function withLegacyCompatibility(setting) {
    const slots = setting.schedule.slots.map((slot) => slot.interval);
    const actions = {};
    for (const slot of setting.schedule.slots)
        actions[slot.interval] = [...slot.allowedModes];
    return { ...setting, slots, wakeOrder: setting.schedule.simultaneousOrder.map((id) => setting.schedule.slots.find((slot) => slot.id === id).interval), expose: { cg: Boolean(setting.interfaces.cg), stg: Boolean(setting.interfaces.stg) }, targets: { md: setting.registry.memoryMappingTableMd, json: setting.registry.memoryMappingTableJson }, actions };
}
function deepMerge(base, extra) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra || {}))
        result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' ? deepMerge(base[key], value) : value;
    return result;
}
