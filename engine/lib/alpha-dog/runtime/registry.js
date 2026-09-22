import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registryPath } from '../../alpha-dog-config.js';
export function resolveRegistryCandidates(setting, registry, root) { const configured = [setting.registry?.memoryMappingTableJson, setting.registry?.memoryMappingTableMd, setting.targets?.json, setting.targets?.md]; const resolved = configured.map((candidate) => String(candidate || '').startsWith('@') ? registryPath(registry, candidate, root) : candidate ? resolve(root, candidate) : null).filter(Boolean); return [...new Set([...resolved, resolve(root, 'targets.json'), resolve(root, 'targets.md')])]; }
export function readRegistry(setting, registry, root, snapshot = []) { let error = null; for (const path of resolveRegistryCandidates(setting, registry, root)) {
    try {
        if (!existsSync(path))
            continue;
        const text = readFileSync(path, 'utf8');
        const entries = path.toLowerCase().endsWith('.json') ? normalizeJson(JSON.parse(text)) : parseMarkdown(text);
        return { entries, error: null };
    }
    catch (cause) {
        error = cause;
    }
} return { entries: snapshot, error: error instanceof Error ? error.message : error ? String(error) : null }; }
function normalizeJson(value) { const entries = Array.isArray(value) ? value : Array.isArray(value?.files) ? value.files : []; return entries.filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim() !== ''); }
function parseMarkdown(text) { return text.split(/\r?\n/).flatMap((line) => { const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean); if (cells.length < 8 || !/^\d+$/.test(cells[0]))
    return []; return [{ id: Number(cells[0]), path: cells[1], firstLine: cells[2], keywords: cells[3].split(/[,，]/), layer: cells[4], importance: Number(cells[5]), tags: cells[6].split(/[,，]/), status: cells[7] }]; }); }
