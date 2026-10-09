import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function modePolicy(mode) {
    if (mode === 'legacy')
        return { runLegacy: true, runAlphaDog: false, formalWrites: false };
    if (mode === 'shadow')
        return { runLegacy: true, runAlphaDog: true, formalWrites: false };
    return { runLegacy: false, runAlphaDog: true, formalWrites: true };
}
export function compareShadow(round, legacy, alphaDog) {
    const differences = [];
    for (const key of ['round', 'candidates', 'slots', 'feedback'])
        if (JSON.stringify(legacy?.[key] ?? null) !== JSON.stringify(alphaDog?.[key] ?? null))
            differences.push(key);
    return { round, legacy, alphaDog, differences, passed: differences.length === 0, createdAt: new Date().toISOString() };
}
export function canPromote(comparisons, minimum = 3) {
    const recent = comparisons.slice(-minimum);
    return { ok: recent.length >= minimum && recent.every((item) => item.passed), checked: recent.length, failedRounds: recent.filter((item) => !item.passed).map((item) => item.round) };
}
export function promoteMode(settingPath, comparisons) {
    const gate = canPromote(comparisons);
    if (!gate.ok)
        return { promoted: false, gate };
    const setting = JSON.parse(readFileSync(settingPath, 'utf8'));
    setting.state = { ...(setting.state || {}), mode: 'alpha_dog' };
    atomicWrite(settingPath, JSON.stringify(setting, null, 2) + '\n');
    return { promoted: true, gate, mode: 'alpha_dog' };
}
export function appendShadowAudit(path, comparison) {
    const items = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const next = Array.isArray(items) ? [...items, comparison] : [comparison];
    atomicWrite(path, JSON.stringify(next, null, 2) + '\n');
    return comparison;
}
function atomicWrite(path, value) { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, value, 'utf8'); renameSync(temp, path); }
