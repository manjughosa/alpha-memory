import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function loadWatchdogPrompt(root, prompt) { const path = join(root, 'prompts', `${prompt}.md`); if (!existsSync(path))
    throw new Error(`watchdog prompt missing: ${path}`); return { path, text: readFileSync(path, 'utf8') }; }
export async function invokeWatchdog(invokeModel, request) { const result = await invokeModel(request); if (!result || result.status !== 'ok')
    return result ?? { status: 'error', error: 'empty model response' }; return result; }
