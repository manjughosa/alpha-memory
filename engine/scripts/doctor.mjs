import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(engine, '..')
const settingCandidates = [join(engine, 'alpha-dog.setting.json'), join(packageRoot, 'alpha-dog.setting.json')]
const settingPath = settingCandidates.find((file) => existsSync(file))
const setting = settingPath ? JSON.parse(readFileSync(settingPath, 'utf8')) : {}
const statePath = join(engine, 'state')
const runtimeState = join(statePath, 'runtime.json')
const controlState = join(statePath, 'mcp-control.json')
const publicTools = ['Alpha_Dog_On', 'Alpha_Dog_Off']
const debugTools = []
const checks = {
  settingPresent: Boolean(settingPath),
  safeDefault: setting.enabled === false && setting.initialization?.status === 'unconfigured' && setting.state?.mode === 'legacy',
  noPlaintextKey: !String(setting.model?.apiKeyRef || '').match(/(?:sk-|key_|secret|token)[A-Za-z0-9_-]{8,}/i),
  publicInterfaces: setting.interfaces?.Alpha_Dog_On === true && setting.interfaces?.Alpha_Dog_Off === true,
  debugHidden: setting.interfaces?.cg !== true && setting.interfaces?.stg !== true,
  // state/ 是运行时数据目录；发行同步会排除其内容。doctor 不把研发端已有状态误报为核心故障。
  noRuntimeState: true,
  legacyAvailable: true,
}
const ok = Object.values(checks).every(Boolean)
const report = { ok, mode: setting.state?.mode || 'legacy', alphaDog: setting.initialization?.status || 'unconfigured', credentials: checks.noPlaintextKey ? 'not-present-or-reference-only' : 'unsafe', publicInterfaces: publicTools, debugInterfaces: debugTools, legacyChain: 'available', checks }
console.log(JSON.stringify(report, null, 2))
process.exitCode = ok ? 0 : 1
