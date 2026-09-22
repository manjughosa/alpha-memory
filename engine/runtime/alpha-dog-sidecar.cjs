#!/usr/bin/env node
'use strict'

// Alpha-Dog Sidecar: universal MCP stdio event source.
//
// It wraps alpha_memory_bridge.js, never bypasses the bridge, and owns only
// two things: observing countable memory-tool calls, and feeding those events
// to the Alpha-Dog runtime. Round counting, slot decisions, wake order,
// batching and de-duplication stay owned by the runtime (single authority) —
// a second counter here would silently disagree with it.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback } }
const ensureDir = (file) => fs.mkdirSync(path.dirname(file), { recursive: true })
function writeJSON(file, value) {
  ensureDir(file)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(temp, file)
}
function appendJSONL(file, value) { ensureDir(file); fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8') }

const SIDECAR_HOME = __dirname
const PKG_ROOT = process.env.ALPHA_MEMORY_HOME || path.resolve(SIDECAR_HOME, '..', '..')
const ENGINE_DIR = path.join(PKG_ROOT, 'engine')
const SETTING_PATH = process.env.ALPHA_DOG_SETTING || [path.join(PKG_ROOT, 'alpha-dog.setting.json'), path.join(ENGINE_DIR, 'alpha-dog.setting.json')].find((file) => fs.existsSync(file)) || path.join(ENGINE_DIR, 'alpha-dog.setting.json')
const STATE_DIR = process.env.STATE_DIR || path.join(ENGINE_DIR, 'state')
const COUNTER_PATH = path.join(STATE_DIR, 'sidecar-counter.json')
const HISTORY_PATH = path.join(STATE_DIR, 'sidecar-wake-history.jsonl')
const SIGNAL_PATH = path.join(STATE_DIR, 'sidecar-wake-signal.json')
const LOG_PATH = path.join(STATE_DIR, 'sidecar.log')
const RUNTIME_STATE_PATH = path.join(STATE_DIR, 'runtime.json')
const REPORT_PATH = path.join(STATE_DIR, 'batch-report.json')
// The bridge owns this control file. The sidecar only reads it; writing it here
// would create a second control authority racing the bridge.
const CONTROL_STATE_PATH = process.env.ALPHA_DOG_CONTROL_STATE || path.join(ENGINE_DIR, 'state', 'mcp-control.json')

const CONFIG = readJSON(SETTING_PATH, { sidecar: {}, schedule: { slots: [], simultaneousOrder: [] }, state: { mode: 'legacy' }, initialization: { status: 'unconfigured' } })

// MCP 入口全部由 alpha-dog.setting.json 的 sidecar 块决定，环境变量只做覆盖。
// 这样换 bridge、换 sidecar 路径、换 server 名都不用改宿主配置里的硬编码路径。
function resolveFromRoot(value, fallback) {
  const candidate = String(value ?? '').trim()
  if (!candidate) return fallback
  return path.isAbsolute(candidate) ? candidate : path.resolve(PKG_ROOT, candidate)
}
const ENTRY = resolveFromRoot(CONFIG.sidecar?.entry, path.join(SIDECAR_HOME, 'alpha-dog-sidecar.cjs'))
const BRIDGE = process.env.ALPHA_MEMORY_BRIDGE || resolveFromRoot(CONFIG.sidecar?.bridge, path.join(PKG_ROOT, 'alpha_memory_bridge.js'))
const NODE_BIN = String(process.env.SIDECAR_NODE || CONFIG.sidecar?.node || '').trim() || process.execPath
const SERVER_NAME = String(CONFIG.sidecar?.serverName || 'alpha-memory').trim() || 'alpha-memory'
const MODE = String(process.env.SIDECAR_MODE || CONFIG.sidecar?.mode || 'wake').toLowerCase()
const NETWORK = String(process.env.SIDECAR_NETWORK || CONFIG.sidecar?.network || 'off').toLowerCase()
const NETWORK_ALLOWED = !['off', '0', 'false'].includes(NETWORK)
const VERBOSE = process.env.SIDECAR_VERBOSE === '1'
const TICK_SCOPE = String(process.env.SIDECAR_TICK_SCOPE || CONFIG.sidecar?.countScope || 'tool_call').toLowerCase()
const FORCE = process.env.SIDECAR_FORCE === '1'
const MEMORY_TOOLS = ['cg', 'stg', 'mdcg_remember', 'mdcg_propose', 'mdcg_review_decide', 'mdcg_forget', 'mdcg_restore', 'mdcg_verify']

// `--print-config` 把 setting 里的 MCP 入口渲染成可直接粘贴的 mcpServers 块。
// 它不启动 bridge、不写状态、不起任何服务：纯粹把配置读出来。
if (process.argv.includes('--print-config')) {
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        command: NODE_BIN,
        args: [ENTRY],
        env: {
          ALPHA_MEMORY_HOME: PKG_ROOT,
          ALPHA_DOG_SETTING: SETTING_PATH,
          SIDECAR_MODE: MODE,
          SIDECAR_NETWORK: NETWORK,
          SIDECAR_TICK_SCOPE: TICK_SCOPE,
        },
      },
    },
  }
  process.stdout.write(JSON.stringify(config, null, 2) + '\n')
  process.exit(0)
}

function log(...args) {
  const line = `[${new Date().toISOString()}] [sidecar] ${args.join(' ')}\n`
  try { ensureDir(LOG_PATH); fs.appendFileSync(LOG_PATH, line) } catch (error) { process.stderr.write(`[sidecar] log failure: ${error.message}\n`) }
  if (VERBOSE) process.stderr.write(line)
}
function setting() { return CONFIG }
function mode() { return String(setting().state?.mode || 'legacy') }
function control() { return readJSON(CONTROL_STATE_PATH, { running: false, watchdog: 'dormant' }) }
function isRunning() { return control().running === true }
function sidecarEnabled() { return CONFIG.sidecar?.enabled !== false || FORCE }

let runtime = null
let runtimeReady = false
const internalPending = new Map()
let internalSequence = 900000
async function callBridgeTool(name, args = {}) {
  if (!bridge?.stdin?.writable) throw new Error('Alpha bridge unavailable')
  const id = ++internalSequence
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { internalPending.delete(id); reject(new Error(`bridge tool timeout: ${name}`)) }, 30000)
    internalPending.set(id, { resolve, reject, timer, name })
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
}
function alphaPreflight(candidate) {
  return callBridgeTool('cg', { op: 'read', query: String(candidate.content), k: 3 }).then((raw) => {
    const results = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : []
    const exact = results.find((item) => String(item?.content || item?.text || '').trim() === String(candidate.content).trim())
    return exact
      ? { candidateId: candidate.id, verdict: 'MERGE', reason: 'existing exact memory', mergeTarget: exact.id }
      : { candidateId: candidate.id, verdict: 'ACCEPT', reason: 'preflight passed' }
  }).catch((error) => ({ candidateId: candidate.id, verdict: 'DEFER', reason: error.message }))
}
async function alphaWrite(candidate, feedback) {
  const raw = await callBridgeTool('mdcg_remember', { content: String(candidate.content), gated: true, layer: 'contextual', tags: ['alpha-dog', candidate.slot], derived_from: candidate.sources, merge_into: feedback.mergeTarget })
  const nodeId = raw?.id || raw?.node_id || raw?.merged_into || feedback.mergeTarget
  const committed = raw?.committed === true || raw?.ok === true || (raw?.verdict === 'ACCEPT' && Boolean(raw?.written)) || (raw?.verdict === 'MERGE' && Boolean(nodeId))
  const auditReceipt = raw?.auditReceipt || raw?.audit_receipt || raw?.audit_id || raw?.receipt || (committed ? `mdcg:${raw?.verdict || 'WRITE'}:${nodeId}` : '')
  return { candidateId: candidate.id, committed, nodeIds: nodeId ? [nodeId] : [], auditReceipt }
}
async function loadRuntime() {
  if (runtimeReady) return runtime
  const modulePath = path.join(ENGINE_DIR, 'lib', 'alpha-dog.js')
  if (!fs.existsSync(modulePath)) throw new Error(`Alpha-Dog runtime missing: ${modulePath}`)
  const [{ AlphaDogRuntime }, modelModule] = await Promise.all([
    import(pathToFileURL(modulePath).href),
    import(pathToFileURL(path.join(ENGINE_DIR, 'model.js')).href),
  ])
  runtime = new AlphaDogRuntime({
    setting: setting(),
    root: PKG_ROOT,
    packageRoot: ENGINE_DIR,
    statePath: RUNTIME_STATE_PATH,
    invokeModel: async (request) => {
      if (!NETWORK_ALLOWED) return { status: 'network-disabled', request }
      return modelModule.openAICompletionsTransport(request, setting().model || {})
    },
    preflightMemory: alphaPreflight,
    writeMemory: alphaWrite,
  })
  runtimeReady = true
  return runtime
}

const counter = readJSON(COUNTER_PATH, { count: 0, byTool: {}, startedAt: new Date().toISOString() })
if (!counter.startedAt) counter.startedAt = new Date().toISOString()
writeJSON(COUNTER_PATH, counter)

if (!fs.existsSync(BRIDGE)) {
  process.stderr.write(`[sidecar] bridge missing: ${BRIDGE}\n`)
  process.exit(2)
}
const bridge = spawn(NODE_BIN, [BRIDGE], {
  env: { ...process.env, ALPHA_MEMORY_HOME: PKG_ROOT, ALPHA_DOG_SETTING: SETTING_PATH, ALPHA_DOG_CONTROL_STATE: CONTROL_STATE_PATH },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let exiting = false
bridge.stderr.on('data', (chunk) => process.stderr.write(chunk))
let bridgeOutput = ''
bridge.stdout.setEncoding('utf8')
bridge.stdout.on('data', (chunk) => {
  bridgeOutput += chunk
  let index
  while ((index = bridgeOutput.indexOf('\n')) >= 0) {
    const line = bridgeOutput.slice(0, index).replace(/\r$/, '')
    bridgeOutput = bridgeOutput.slice(index + 1)
    if (!line.trim()) continue
    let message = null
    try { message = JSON.parse(line) } catch (_) {}
    const pending = message && internalPending.get(message.id)
    if (pending) {
      clearTimeout(pending.timer)
      internalPending.delete(message.id)
      if (message.error || message.result?.isError) pending.reject(new Error(message.error?.message || `bridge tool failed: ${pending.name}`))
      else {
        const text = (message.result?.content || []).filter((item) => item.type === 'text').map((item) => item.text || '').join('')
        try { pending.resolve(JSON.parse(text)) } catch (_) { pending.resolve(text) }
      }
      continue
    }
    process.stdout.write(line + '\n')
  }
})
bridge.on('error', (error) => { log(`bridge error: ${error.message}`); process.exitCode = 2 })
bridge.on('exit', (code) => { log(`bridge exit code=${code}`); if (!exiting) process.exitCode = code || 0 })

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let index
  while ((index = input.indexOf('\n')) >= 0) {
    const raw = input.slice(0, index).replace(/\r$/, '')
    input = input.slice(index + 1)
    if (!raw.trim()) continue
    let consumed = false
    try { const message = JSON.parse(raw); if (message?.jsonrpc === '2.0') consumed = observe(message) === true } catch (_) { /* transparent passthrough */ }
    if (!consumed) bridge.stdin.write(raw + '\n')
  }
})
process.stdin.on('end', () => { try { bridge.stdin.end() } catch (_) {} })

function observe(message) {
  // 客户端可发送未注册的 JSON-RPC notification `alpha-dog/round_tick`。
  // 它不是 MCP tool，不出现在 tools/list，保持内部能力不对外注册的协议边界。
  if (message.method === 'alpha-dog/round_tick') {
    emitExternalRoundTick(message.params || {}).catch((error) => log(`round_tick failed: ${error.message}`))
    return true
  }
  if (message.method !== 'tools/call') return false
  const name = message.params?.name
  if (name === 'Alpha_Dog_On') {
    loadRuntime().then((dog) => dog.on()).catch((error) => log(`power-on failed: ${error.message}`))
    log('observed Alpha_Dog_On')
    return
  }
  if (name === 'Alpha_Dog_Off') {
    if (runtime) runtime.off()
    log('observed Alpha_Dog_Off; counting stopped')
    return
  }
  if (!MEMORY_TOOLS.includes(name)) return
  if (TICK_SCOPE !== 'all_tools' && !['cg', 'stg'].includes(name)) return
  // The bridge answers On/Off asynchronously and owns the control file. A client
  // may pipeline On with a tool call in one chunk, so re-check gates after the
  // authoritative write has landed.
  setTimeout(() => emitTick(name, message), 25)
}

async function emitExternalRoundTick(event) {
  if (!sidecarEnabled()) return { skipped: true, reason: 'disabled' }
  if (!isRunning()) return { skipped: true, reason: 'off' }
  if (mode() === 'legacy') return { skipped: true, reason: 'legacy' }
  const sequence = Number.isInteger(event.round) && event.round > 0 ? event.round : counter.count + 1
  counter.count = Math.max(counter.count, sequence)
  counter.byTool.round_tick = (counter.byTool.round_tick || 0) + 1
  writeJSON(COUNTER_PATH, counter)
  return trigger('round_tick', sequence, { params: { arguments: event } })
}

function emitTick(name, message) {
  if (!sidecarEnabled()) { log('skip disabled'); return }
  if (!isRunning()) { log('skip off after control settle'); return }
  if (mode() === 'legacy') { log('skip legacy'); return }
  counter.count += 1
  counter.byTool[name] = (counter.byTool[name] || 0) + 1
  writeJSON(COUNTER_PATH, counter)
  if (MODE === 'observe' || MODE === 'signal') { log(`observed tick ${counter.count} (${name})`); return }
  const sequence = counter.count
  trigger(name, sequence, message).catch((error) => {
    recordWake({ round: sequence, lastOp: name, status: 'failed', error: error.message, completedAt: new Date().toISOString() })
    log(`tick failed: ${error.message}`)
  })
}

async function trigger(name, sequence, message) {
  const dog = await loadRuntime()
  if (!dog.status().running) dog.on()
  const incoming = message.params?.arguments || {}
  const result = await dog.tick({
    eventId: incoming.eventId || `sidecar:${name}:${sequence}`,
    round: sequence,
    sessionId: incoming.sessionId || '',
    formalWrites: mode() === 'alpha_dog',
    userInput: incoming.userInput || incoming.query || incoming.content || '',
    source: name === 'round_tick' ? 'client-round-tick' : 'sidecar-tool-fallback',
    networkAllowed: NETWORK_ALLOWED,
  })
  const wakes = Array.isArray(result.wakes) ? result.wakes : []
  if (wakes.length === 0) { log(`tick ${sequence} planned no wake (${result.skipped ? `skipped:${result.reason}` : 'not-due'})`); return result }
  for (const wake of wakes) {
    recordWake({
      slot: wake.slotId,
      interval: wake.slot,
      round: wake.round,
      batch: wake.batch?.batchId || null,
      targetCount: Array.isArray(wake.targets) ? wake.targets.length : 0,
      modelStatus: wake.model?.status || null,
      // A degraded wake means the model call failed and governance booked it as
      // pending debt. It must never be reported as a successful wake.
      status: wake.degraded ? 'degraded' : 'done',
      network: NETWORK_ALLOWED ? 'allowed' : 'disabled',
      lastOp: name,
      eventKind: TICK_SCOPE,
      completedAt: new Date().toISOString(),
    })
  }
  writeJSON(REPORT_PATH, result.lastReport || { kind: 'report', round: sequence, wakes })
  return result
}

function recordWake(record) {
  const enriched = { ...record, triggeredAt: record.triggeredAt || new Date().toISOString(), source: 'sidecar' }
  if (!record.triggeredAt) writeJSON(SIGNAL_PATH, enriched)
  appendJSONL(HISTORY_PATH, enriched)
  return enriched
}

function shutdown(signal) { if (exiting) return; exiting = true; log(`shutdown ${signal}`); try { bridge.kill() } catch (_) {} setTimeout(() => process.exit(0), 100) }
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => { try { bridge.kill() } catch (_) {} })
log(`ready server=${SERVER_NAME} mode=${MODE} network=${NETWORK} scope=${TICK_SCOPE} entry=${ENTRY} bridge=${BRIDGE}`)
