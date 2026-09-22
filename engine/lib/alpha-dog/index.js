// @ts-nocheck
const MODES = Object.freeze(['interrupt', 'fixed_defer', 'backfill', 'monitor']);
const SCHEDULES = Object.freeze([15, 21, 30]);
const LEGACY_TOOLS = Object.freeze(['cg', 'stg']);
const EVENTS = Object.freeze({ ON: 'alpha_dog.on', OFF: 'alpha_dog.off', WAKE_PLANNED: 'alpha_dog.wake_planned', WAKE_STARTED: 'alpha_dog.wake_started', WAKE_FINISHED: 'alpha_dog.wake_finished', STATE_CHANGED: 'alpha_dog.state_changed', REPORT: 'alpha_dog.report' });
const TRANSITIONS = { off: { on: 'idle' }, idle: { plan: 'planned', off: 'off' }, planned: { wake: 'waking', off: 'off', replan: 'planned' }, waking: { report: 'reporting', error: 'error', off: 'off' }, reporting: { complete: 'idle', error: 'error', off: 'off' }, error: { reset: 'idle', off: 'off' } };
export const ALPHA_DOG_CONFIG_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean', default: false }, schedule: { type: 'integer', enum: [...SCHEDULES], default: 21 }, modes: { type: 'array', items: { type: 'string', enum: [...MODES] }, default: ['backfill', 'monitor'] }, provider: { type: 'string', default: 'host' }, model: { type: 'string', default: 'host-default' }, mention: { type: 'string', enum: ['ignore', 'observe', 'required'], default: 'observe' }, batchSize: { type: 'integer', minimum: 1, default: 4 }, counter: { type: 'integer', minimum: 0, default: 0 }, registry: { type: 'string', default: '' } } });
export function defaultConfig(overrides = {}) { return { enabled: false, schedule: 21, modes: ['backfill', 'monitor'], provider: 'host', model: 'host-default', mention: 'observe', batchSize: 4, counter: 0, registry: '', ...overrides }; }
export function validateConfig(input = {}) { const config = defaultConfig(input); const errors = []; if (!Number.isInteger(config.schedule) || config.schedule < 1)
    errors.push('schedule must be a positive integer'); if (!Array.isArray(config.modes) || config.modes.some((m) => !MODES.includes(m)))
    errors.push('modes contains an unsupported mode'); if (!['ignore', 'observe', 'required'].includes(config.mention))
    errors.push('mention must be ignore, observe, or required'); if (!Number.isInteger(config.batchSize) || config.batchSize < 1)
    errors.push('batchSize must be a positive integer'); if (!Number.isInteger(config.counter) || config.counter < 0)
    errors.push('counter must be a non-negative integer'); if (!config.provider?.trim())
    errors.push('provider is required'); if (!config.model?.trim())
    errors.push('model is required'); return { ok: errors.length === 0, config, errors }; }
export function capabilityDirectory(schedule, { legacy = true } = {}) { if (!Number.isInteger(schedule) || schedule < 1)
    throw new RangeError('unsupported schedule'); const common = legacy ? [...LEGACY_TOOLS] : []; const heavy = schedule === 30; return { schedule, tools: common, modes: heavy ? [...MODES] : ['backfill', 'monitor'], hidden: heavy ? [] : ['interrupt', 'fixed_defer'], open: heavy }; }
export function filterInterface(items, { schedule = 21, requestedModes = MODES, legacy = true } = {}) { const allowed = new Set(capabilityDirectory(schedule, { legacy }).modes); return items.filter((item) => allowed.has(typeof item === 'string' ? item : item.mode) && requestedModes.includes(typeof item === 'string' ? item : item.mode)); }
export function transition(state, action) { const next = TRANSITIONS[state]?.[action]; if (!next)
    throw new Error(`invalid transition: ${state} + ${action}`); return next; }
export function createState(overrides = {}) { return { state: 'off', enabled: false, counter: 0, mention: 'observe', lastEventId: null, ...overrides }; }
export function createEvent(type, payload = {}, { eventId = `${type}:${Date.now()}`, roundId = 'round-unknown', seq = 0 } = {}) { if (!Object.values(EVENTS).includes(type))
    throw new RangeError(`unknown event: ${type}`); return { version: 'alpha-dog/1', kind: 'event', id: eventId, type, roundId, seq, ts: new Date().toISOString(), payload }; }
export function reduceState(current, event) { const state = current ?? createState(); if (event?.id && state.lastEventId === event.id)
    return state; const action = { [EVENTS.ON]: 'on', [EVENTS.WAKE_PLANNED]: 'plan', [EVENTS.WAKE_STARTED]: 'wake', [EVENTS.REPORT]: 'report', [EVENTS.WAKE_FINISHED]: 'complete', [EVENTS.OFF]: 'off' }[event.type]; const counter = Number.isInteger(event?.seq) ? Math.max(state.counter, event.seq) : state.counter; if (!action)
    return { ...state, counter, lastEventId: event.id ?? null }; const next = transition(state.state, action); return { ...state, state: next, enabled: next !== 'off', counter, lastEventId: event.id ?? null }; }
export function applyControl(current, command, meta = {}) { return reduceState(current, createEvent(command === 'Alpha_Dog_On' ? EVENTS.ON : EVENTS.OFF, { command }, meta)); }
export function planBatches(registry, batchSize = 4) { return Array.from({ length: Math.ceil(registry.length / batchSize) }, (_, i) => ({ batch: i, entries: registry.slice(i * batchSize, (i + 1) * batchSize) })); }
export function parseRegistryPath(value, _opts = {}) { return value.startsWith('@') ? { kind: 'alias', alias: value.slice(1), path: null } : { kind: 'path', path: value }; }
export function createWakePlan({ roundId, schedule = 21, registry = [], batchSize = 4, mention = 'observe', modes = ['backfill', 'monitor'] } = {}) { const checked = validateConfig({ schedule, batchSize, mention, modes }); if (!checked.ok)
    throw new Error(checked.errors.join('; ')); return { version: 'alpha-dog/1', kind: 'wake_plan', roundId: String(roundId ?? 'round-unknown'), schedule, mention, modes: filterInterface(modes, { schedule, requestedModes: modes }), order: 'registry_then_batch_then_entry', batches: planBatches(registry, batchSize) }; }
export function createReport({ roundId, state, plan, completed = [], errors = [] } = {}) { return { version: 'alpha-dog/1', roundId: String(roundId ?? 'round-unknown'), state, planVersion: plan?.version ?? 'alpha-dog/1', completed: [...completed], errors: [...errors], ok: errors.length === 0 }; }
export { EVENTS, MODES, SCHEDULES, LEGACY_TOOLS };
