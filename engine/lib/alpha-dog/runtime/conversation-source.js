// 对话源（黑箱自包含 · 零注册表 · 零平台依赖）
//
// Alpha-Dog 是独立黑箱：不读注册表、不依赖任何宿主配置。
// 会话日志通过「显式声明路径」或「常见位置探测」定位，纯文件读取。
// 找不到 → 返回 { ok: false }，由上层记 degraded，绝不静默空转。
//
// 支持格式：PI 原生会话 JSONL（type: session/user/assistant/toolResult/...）
//           每一行是一个 JSON 对象；本模块只提取 role 为 user 的输入内容，
//           并按出现顺序组装成「对话记录流」（旧 -> 新）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function resolveConversationCandidates(declared, probeRoots = []) {
    const candidates = [];
    if (declared && declared.trim()) {
        const abs = resolve(declared);
        if (existsSync(abs)) {
            if (statSync(abs).isDirectory()) {
                candidates.push(...listJsonl(abs));
            }
            else {
                candidates.push(abs);
            }
        }
    }
    const roots = probeRoots.length ? probeRoots : defaultProbeRoots();
    for (const root of roots) {
        for (const file of listJsonl(root))
            candidates.push(file);
    }
    // 去重（保留声明优先）
    return [...new Set(candidates)];
}
function defaultProbeRoots() {
    const home = typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE : process.env.HOME || '';
    // 零本机路径：宿主根可被 PI_AGENT_HOME 覆盖；常见布局是 <宿主根>/agent/sessions
    // 或 <home>/.pi-agent/agent/sessions。任何写死的盘符路径都不进公开仓库。
    const hostRoot = String(process.env.PI_AGENT_HOME || '').trim();
    const roots = [
        process.env.ALPHA_DOG_CONVERSATION_DIR || '',
        join(home, '.pi', 'agent', 'sessions'),
        hostRoot ? join(hostRoot, 'agent', 'sessions') : '',
        join(home, '.pi-agent', 'agent', 'sessions'),
    ].filter(Boolean);
    return roots;
}
function listJsonl(dir) {
    try {
        if (!existsSync(dir))
            return [];
        return readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter((entry) => typeof entry === 'string' && entry.endsWith('.jsonl'))
            .map((entry) => join(dir, entry))
            .filter((file) => existsSync(file) && statSync(file).isFile());
    }
    catch {
        return [];
    }
}
/** 读最新写入的会话文件（按 mtime 排序，取最新）并解析为对话流。 */
export function readConversation(declared, probeRoots = [], maxFileBytes = 16 * 1024 * 1024) {
    const candidates = resolveConversationCandidates(declared, probeRoots);
    if (candidates.length === 0) {
        return { ok: false, error: 'no conversation jsonl found (declared path or probe roots)', turns: [], userTurns: [], mtimeMs: 0 };
    }
    const ordered = [...candidates].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const file = ordered[0];
    try {
        if (statSync(file).size > maxFileBytes) {
            return { ok: false, error: `conversation file too large: ${statSync(file).size} bytes`, turns: [], userTurns: [], mtimeMs: statSync(file).mtimeMs, file };
        }
        const raw = readFileSync(file, 'utf8');
        const turns = [];
        const userTurns = [];
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            let obj = null;
            try {
                obj = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!obj || typeof obj !== 'object')
                continue;
            const type = String(obj.type || obj.role || '');
            const ts = String(obj.timestamp || obj.time || '');
            // PI 原生会话：{ type:'message', message:{ role:'user', content:[{type:'text',text}] } }
            const nested = obj.message && typeof obj.message === 'object' ? obj.message : null;
            const role = nested ? String(nested.role || '') : '';
            const effectiveType = role || type;
            let text = '';
            if (effectiveType === 'user') {
                text = extractText(nested || obj);
                if (text) {
                    const turn = { kind: 'user', text, at: ts || String(nested?.timestamp || ''), roundHint: userTurns.length + 1 };
                    turns.push(turn);
                    userTurns.push(turn);
                }
            }
            else if (effectiveType === 'assistant') {
                text = extractText(nested || obj);
                if (text)
                    turns.push({ kind: 'assistant', text, at: ts || String(nested?.timestamp || '') });
            }
            else if (effectiveType === 'toolResult' || effectiveType === 'tool_result' || effectiveType === 'tool') {
                text = extractText(nested || obj);
                if (text)
                    turns.push({ kind: 'tool', text, at: ts || String(nested?.timestamp || '') });
            }
        }
        return { ok: true, file, turns, userTurns, mtimeMs: statSync(file).mtimeMs };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), turns: [], userTurns: [], mtimeMs: statSync(file).mtimeMs, file };
    }
}
function extractText(obj) {
    if (typeof obj.text === 'string' && obj.text.trim())
        return obj.text.trim();
    if (typeof obj.content === 'string' && obj.content.trim())
        return obj.content.trim();
    if (Array.isArray(obj.content)) {
        return obj.content
            .map((item) => (typeof item === 'string' ? item : item?.text ? item.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (typeof obj.message?.content === 'string')
        return obj.message.content.trim();
    return '';
}
