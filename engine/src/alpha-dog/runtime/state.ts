import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export function loadRuntimeState(path: string, fallback: any) { try { return existsSync(path) ? { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) } : { ...fallback } } catch { return { ...fallback } } }
export function saveRuntimeState(path: string, state: unknown) { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8'); renameSync(temp, path); return path }
