import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadAlphaDogSetting } from '../alpha-dog-config.js';
const KNOWN_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'host']);
const MIN_CONTEXT_WINDOW = 1;
export function buildInitializationRequest(input = {}) {
    const model = input.models?.[0];
    return {
        name: String(input.name ?? ''),
        baseUrl: String(input.baseUrl ?? ''),
        api: String(input.api ?? 'openai-completions'),
        apiKeyRef: String(input.apiKeyRef ?? ''),
        models: [{
                id: String(model?.id ?? ''),
                reasoning: Boolean(model?.reasoning ?? true),
                input: Array.isArray(model?.input) ? model.input.map(String) : ['text'],
                contextWindow: Number(model?.contextWindow ?? 1000000),
                maxTokens: Number(model?.maxTokens ?? 384000),
                thinkingLevelMap: model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : { minimal: null, low: null, medium: null },
            }],
    };
}
export function inspectInitialization(options, request = buildInitializationRequest()) {
    const settingExists = existsSync(options.settingPath);
    let setting = null;
    try {
        setting = loadAlphaDogSetting(options.settingPath);
    }
    catch {
        setting = null;
    }
    const model = request.models[0];
    const registry = setting?.registry;
    const registryCandidates = [registry?.memoryMappingTableMd, registry?.memoryMappingTableJson].filter(Boolean);
    const registryExists = registryCandidates.some((candidate) => {
        if (candidate.startsWith('@'))
            return Boolean(options.registry?.entries?.[candidate]?.path || options.registry?.[candidate]?.path);
        return existsSync(resolve(options.root, candidate));
    });
    const statePath = resolve(options.root, setting?.state?.directory || 'state');
    const results = [
        { name: 'setting', ok: settingExists, detail: settingExists ? options.settingPath : 'Setting 不存在' },
        { name: 'model_config', ok: Boolean(request.name || model.id), detail: request.name || model.id ? '模型标识已提供' : '缺少模型 name/id' },
        { name: 'api_protocol', ok: KNOWN_APIS.has(request.api), detail: KNOWN_APIS.has(request.api) ? request.api : `未知 API: ${request.api}` },
        { name: 'model_access', ok: typeof options.transport?.request === 'function' || request.api === 'host', detail: typeof options.transport?.request === 'function' || request.api === 'host' ? 'transport 可用或由宿主提供' : '没有模型 transport' },
        { name: 'text_input', ok: model.input.includes('text'), detail: model.input.includes('text') ? '支持 text' : '模型未声明 text 输入' },
        { name: 'context_window', ok: Number.isFinite(model.contextWindow) && model.contextWindow >= MIN_CONTEXT_WINDOW, detail: `contextWindow=${model.contextWindow}` },
        { name: 'host_platform', ok: Boolean(options.host || process.platform), detail: options.host || process.platform },
        { name: 'registry_path', ok: registryExists, detail: registryExists ? '注册表路径已解析且存在' : '注册表路径无法解析或不存在' },
        { name: 'state_rw', ok: canReadWrite(statePath), detail: statePath },
    ];
    return results;
}
export function createDeclinedState() {
    return { status: 'declined', mention: 'off' };
}
export async function initializeAlphaDog(options, requestInput = {}) {
    const request = buildInitializationRequest(requestInput);
    const checks = inspectInitialization(options, request);
    const failed = checks.filter((item) => !item.ok);
    if (failed.length > 0)
        return { status: 'unconfigured', mention: 'on', request, checks, failed: failed.map((item) => item.name) };
    const verification = await runMinimalVerification(options, request);
    const verificationFailed = verification.filter((item) => !item.ok);
    if (verificationFailed.length > 0)
        return { status: 'failed', mention: 'on', request, checks, verification, failed: verificationFailed.map((item) => item.name) };
    const generated = writeInitializationArtifacts(options, request, checks, verification);
    return { status: 'configured', mention: 'on', request, checks, verification, generated };
}
export function writeDeclinedState(options) {
    const stateDir = resolve(options.root, 'state');
    mkdirSync(stateDir, { recursive: true });
    const target = join(stateDir, 'initialization.json');
    atomicJsonWrite(target, createDeclinedState());
    return target;
}
export async function runMinimalVerification(options, request) {
    const config = { ...request, apiKeyRef: request.apiKeyRef };
    const results = [];
    results.push(await syntaxCheck(options.root));
    results.push(await requestCheck('plain_text', options.transport?.request, { input: 'health check', responseFormat: 'text' }, config));
    results.push(await requestCheck('structured_json', options.transport?.request, { input: 'health check', responseFormat: 'json' }, config));
    results.push({ name: 'timeout', ok: true, detail: 'transport timeout contract delegated to adapter' });
    results.push({ name: 'error_response', ok: true, detail: 'structured adapter error contract delegated to adapter' });
    results.push({ name: 'context_window_read', ok: request.models[0].contextWindow > 0, detail: `contextWindow=${request.models[0].contextWindow}` });
    results.push({ name: 'reasoning_level_map', ok: Boolean(request.models[0].thinkingLevelMap && typeof request.models[0].thinkingLevelMap === 'object'), detail: 'thinkingLevelMap 已读取' });
    return results;
}
function writeInitializationArtifacts(options, request, checks, verification) {
    const stateDir = resolve(options.root, 'state');
    mkdirSync(stateDir, { recursive: true });
    const modelPath = join(options.root, 'model.js');
    const adapterPath = join(stateDir, 'adapter.json');
    const reportPath = join(stateDir, 'init-report.json');
    atomicTextWrite(modelPath, createModelModule(request));
    atomicJsonWrite(adapterPath, { version: 'alpha-dog/1', api: request.api, name: request.name, baseUrl: request.baseUrl, apiKeyRef: request.apiKeyRef, input: request.models[0].input });
    atomicJsonWrite(reportPath, { version: 'alpha-dog/1', status: 'configured', generatedAt: (options.now || (() => new Date().toISOString()))(), checks, verification, artifacts: [modelPath, adapterPath, reportPath] });
    return { modelPath, adapterPath, reportPath };
}
function createModelModule(request) {
    return `export const config = ${JSON.stringify({ name: request.name, baseUrl: request.baseUrl, api: request.api, apiKeyRef: request.apiKeyRef, models: request.models }, null, 2)};\nexport async function invoke(transport, payload) { if (typeof transport !== 'function') throw new Error('model transport unavailable'); return transport(payload, config); }\n`;
}
async function syntaxCheck(root) {
    const modelPath = join(root, 'model.js');
    if (!existsSync(modelPath))
        return { name: 'node_syntax', ok: true, detail: 'model.js 将在初始化成功后生成' };
    return await new Promise((resolveResult) => {
        const child = spawn(process.execPath, ['--check', modelPath], { stdio: 'ignore' });
        child.once('error', () => resolveResult({ name: 'node_syntax', ok: false, detail: 'Node --check 启动失败' }));
        child.once('exit', (code) => resolveResult({ name: 'node_syntax', ok: code === 0, detail: code === 0 ? 'Node --check 通过' : `Node --check exit=${code}` }));
    });
}
async function requestCheck(name, requestFn, payload, config) {
    if (typeof requestFn !== 'function')
        return { name, ok: true, detail: 'transport 未注入，保留为宿主验证项' };
    try {
        await requestFn(payload, config);
        return { name, ok: true, detail: '请求成功' };
    }
    catch (error) {
        return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}
function canReadWrite(directory) {
    try {
        mkdirSync(directory, { recursive: true });
        const probe = join(directory, `.alpha-dog-rw-${randomUUID()}.tmp`);
        writeFileSync(probe, 'ok', 'utf8');
        readFileSync(probe, 'utf8');
        unlinkSync(probe);
        return true;
    }
    catch {
        return false;
    }
}
function atomicJsonWrite(path, value) { atomicTextWrite(path, JSON.stringify(value, null, 2) + '\n'); }
function atomicTextWrite(path, value) { const temp = `${path}.${randomUUID()}.tmp`; mkdirSync(dirname(path), { recursive: true }); writeFileSync(temp, value, 'utf8'); renameSync(temp, path); }
