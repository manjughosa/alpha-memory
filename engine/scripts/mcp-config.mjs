#!/usr/bin/env node
// 把 alpha-dog.setting.json 的 sidecar 块（MCP 入口）渲染成可直接粘贴的
// mcpServers 配置块。唯一的实现是 sidecar 自己的 `--print-config`，
// 本脚本只负责定位与转发，避免两处逻辑漂移。
//
// 用法：
//   node scripts/mcp-config.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgRoot = process.env.ALPHA_MEMORY_HOME || resolve(engine, '..')
const settingPath = process.env.ALPHA_DOG_SETTING
  || [join(pkgRoot, 'alpha-dog.setting.json'), join(engine, 'alpha-dog.setting.json')].find((file) => existsSync(file))
  || join(engine, 'alpha-dog.setting.json')

let setting = {}
try {
  setting = JSON.parse(readFileSync(settingPath, 'utf8'))
} catch (error) {
  console.error(`[mcp-config] 读不到 setting：${settingPath} :: ${error.message}`)
  process.exit(2)
}

const entry = String(setting?.sidecar?.entry || 'engine/runtime/alpha-dog-sidecar.cjs')
const sidecarPath = isAbsolute(entry) ? entry : resolve(pkgRoot, entry)
if (!existsSync(sidecarPath)) {
  console.error(`[mcp-config] sidecar 不存在：${sidecarPath}（检查 setting 的 sidecar.entry）`)
  process.exit(2)
}

const result = spawnSync(process.execPath, [sidecarPath, '--print-config'], {
  env: { ...process.env, ALPHA_MEMORY_HOME: pkgRoot, ALPHA_DOG_SETTING: settingPath },
  encoding: 'utf8',
})
if (result.status !== 0) {
  process.stderr.write(result.stderr || '')
  console.error(`[mcp-config] sidecar --print-config 失败，exit=${result.status}`)
  process.exit(result.status ?? 1)
}
process.stdout.write(result.stdout)
if (!result.stdout.endsWith('\n')) process.stdout.write('\n')
