'use strict';

// Alpha-Dog Sidecar: universal MCP stdio event source.
//
// It wraps alpha_memory_bridge.js, never bypasses the bridge, and owns only
// two things: observing countable memory-tool calls, and feeding those events
// to the Alpha-Dog runtime. Round counting, slot decisions, wake order,
// batching and de-duplication stay owned by the runtime (single authority) —
// a second counter here would silently disagree with it.

const { spawn, execFileSync } = require('node:child_process')
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
  const [{ AlphaDogRuntime }, { findUpward }, modelModule] = await Promise.all([
    import(pathToFileURL(modulePath).href),
    import(pathToFileURL(path.join(ENGINE_DIR, 'lib', 'alpha-dog-config.js')).href),
    import(pathToFileURL(path.join(ENGINE_DIR, 'model.js')).href),
  ])
  // 注册表条目路径是【workspace 根】相对的（如 tools/CLI/记忆映射/…）。
  // 用 realpath 先解开 junction（C:\...\Alpha-Memory → E:\...\Deeptalk\…），
  // 再向上找 agent_registry.json，拿到 workspace 根；同时把 registry 对象交给 runtime。
  const registryPath = findUpward(fs.realpathSync(PKG_ROOT), 'agent_registry.json')
  let registry = null
  let workspaceRoot = PKG_ROOT
  if (registryPath) {
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) } catch (error) { log(`registry load failed: ${error.message}`) }
    workspaceRoot = path.dirname(registryPath)
  } else {
    log('agent_registry.json not found upward; @-refs will resolve to null')
  }
  runtime = new AlphaDogRuntime({
    setting: setting(),
    root: workspaceRoot,
    packageRoot: ENGINE_DIR,
    registry,
    statePath: RUNTIME_STATE_PATH,
    // 对话源声明（黑箱自包含）：显式路径优先，runtime 内部还会探测常见位置。
    conversationDir: process.env.ALPHA_DOG_CONVERSATION_DIR || setting().conversation?.dir || '',
    // 模型直调：对话窗口/占位符模式已由 runtime 注入 context，狗直接基于真实对话判断。
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

// ── 幂等锁（2026-09-23 · 第二层）────────────────────────────
// 病根：Pi 被手动关闭时不向 MCP 子进程发关闭信号；sidecar 是 setInterval
// 常驻进程，stdio 管道断了也无感，继续跑。下次 Pi 再 spawn 一个 sidecar，
// 就出现「两只狗在岗」。锁机制：
//   state/sidecar.lock 内容 = PID。
//   启动时：锁存在 → 读 PID → 探活。
//     PID 活着 → 自己退出（「已经有狗在岗了」）。
//     PID 死了 → 抢锁，写入自己的 PID，正常启动。
//   锁不存在 → 直接写自己的 PID，正常启动。
//   正常退出（SIGINT/SIGTERM）→ 释放锁（只删自己 PID 的锁，不误删新狗的）。
const LOCK_PATH = process.env.SIDECAR_LOCK || path.join(STATE_DIR, 'sidecar.lock')
function probeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } // EPERM = 进程存在但无权发信号
}
// ── 孤儿判据 + 挂载接管（2026-09-26 拍板 B 方案）──────────────
// 病根（2026-09-24 排查）：锁只判「pid 活着」，不判「主人还在不在」——
// 孤儿守门人把新入口全挡在门外。现在撞到活锁先判孤：孤儿安乐死后接管，
// 有主照旧退让。判孤证据两条，命中任一即孤：
//   ① 僵尸实锤：日志里最后一条 ready 之后出现过 bridge exit。bridge 是
//      所有工具调用的必经之路且从不重启——它一死，这只狗永远接不到任何
//      客户端（客户端关闭 → stdin EOF → bridge 退出，正是这条路径）。
//   ② 心跳兜底：日志/唤醒史/信号/计数器四件全部超过阈值没动（抓 crash）。
// 安全条款：动手前必须核对该 pid 的命令行确实含 alpha-dog-sidecar（防
// pid 复用误杀）；核对不了就不杀，退让并写明原因。绝不盲杀。
const ORPHAN_STALE_MS = Number(process.env.ALPHA_DOG_ORPHAN_STALE_MS || 30 * 60 * 1000)
// 2026-09-28 补：哑狗宽限期。ready 之后 bridge 一次都没吭声，超过这个时间即判半启动僵尸。
const ORPHAN_GRACE_MS = Number(process.env.ALPHA_DOG_ORPHAN_GRACE_MS || 90 * 1000)
// 2026-09-28 补：在岗心跳记号。锁主每 15s 写 sidecar.heartbeat.json；超过 45s 没刷新＝定时器死了。
const HEARTBEAT_PATH = path.join(STATE_DIR, 'sidecar.heartbeat.json')
const HEARTBEAT_STALE_MS = Number(process.env.ALPHA_DOG_HEARTBEAT_STALE_MS || 45 * 1000)
function readLogTail(bytes = 16384) {
  try {
    const stat = fs.statSync(LOG_PATH)
    const length = Math.min(bytes, Math.max(stat.size, 0))
    if (length <= 0) return ''
    const fd = fs.openSync(LOG_PATH, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, stat.size - length)
      return buffer.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch (_) { return '' }
}
function cmdlineOf(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim()
    return out || null
  } catch (_) { return null }
}
function lockHolderIsOrphan(pid) {
  const lines = readLogTail().split('\n').filter((line) => line.includes('[sidecar]'))
  let lastReady = -1
  lines.forEach((line, index) => { if (line.includes('ready server=')) lastReady = index })
  if (lastReady >= 0 && lines.slice(lastReady + 1).some((line) => line.includes('bridge exit code='))) {
    return { orphan: true, why: 'bridge exited after last ready — client-less zombie' }
  }
  // ③ 哑狗实锤（2026-09-28 补 · 令）：
  //    病根：① 要「bridge exit」才认，可 bridge 根本没起来，没有 exit 可判；② 要三十分钟
  //    静默才认，可它刚上岗几十秒，四个文件全是新的。两把尺子都量不到 → 判「有主」→
  //    拒绝接管 → 死锁，只能人工抽。补第三把尺子：ready 之后 bridge 一次都没吭声。
  if (lastReady >= 0) {
    const after = lines.slice(lastReady + 1)
    const bridgeSpoke = after.some((line) => line.includes('bridge exit code=')
      || line.includes('tick ') || line.includes('observed tick')
      || line.includes('power-on complete') || line.includes('self-driven wake'))
    if (!bridgeSpoke) {
      const stamp = /^\[([^\]]+)\]/.exec(lines[lastReady])
      const readyAt = stamp ? Date.parse(stamp[1]) : NaN
      if (Number.isFinite(readyAt) && Date.now() - readyAt > ORPHAN_GRACE_MS) {
        return { orphan: true, why: `silent after ready for ${Math.round((Date.now() - readyAt) / 1000)}s — half-started dog` }
      }
    }
  }
  // ④ 心跳记号实锤（2026-09-28 补）：锁主 pid 活着，但它自己写的心跳记号
  //    超过 HEARTBEAT_STALE_MS 没刷新 → 它的定时器死了或卡死，判孤接管。
  try {
    const marker = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'))
    if (marker && marker.pid === pid && Number.isFinite(marker.at) && Date.now() - marker.at > HEARTBEAT_STALE_MS) {
      return { orphan: true, why: `heartbeat stale ${Math.round((Date.now() - marker.at) / 1000)}s（进程活着但定时器死了）` }
    }
  } catch (_) { /* 记号不存在/损坏 → 没这把尺子，走旧证据 */ }
  // ② 心跳兜底：LOG_PATH 已摘出——任何启动中的进程都会写它（含拒绝启动那条路自己），
  //    留着它等于每次去连一次就替僵尸续一次心跳，越连越像活的。
  const beats = [HISTORY_PATH, SIGNAL_PATH, COUNTER_PATH].map((file) => {
    try { return fs.statSync(file).mtimeMs } catch (_) { return 0 }
  })
  const newest = Math.max(...beats)
  if (newest > 0 && Date.now() - newest > ORPHAN_STALE_MS) {
    return { orphan: true, why: `no heartbeat for ${Math.round((Date.now() - newest) / 60000)}min` }
  }
  return { orphan: false, why: 'lock holder alive with recent heartbeat' }
}
function acquireLock() {
  ensureDir(LOCK_PATH)
  try {
    const existing = fs.readFileSync(LOCK_PATH, 'utf8').trim()
    const pid = Number(existing)
    if (probeAlive(pid)) {
      const verdict = lockHolderIsOrphan(pid)
      if (!verdict.orphan) {
        log(`已有狗在岗 (pid=${pid})，拒绝重复启动，本进程 (pid=${process.pid}) 退出`)
        process.stderr.write(`[sidecar] already running as pid=${pid}; refusing duplicate startup.\n`)
        process.exit(0)
      }
      const cmdline = cmdlineOf(pid)
      if (cmdline === null) {
        log(`锁主 pid=${pid} 疑似孤儿（${verdict.why}），但拿不到命令行无法核对，保守退让`)
        process.stderr.write(`[sidecar] orphan suspected (pid=${pid}) but cmdline unavailable; yielding.\n`)
        process.exit(0)
      }
      if (!cmdline.includes('alpha-dog-sidecar')) {
        log(`锁主 pid=${pid} 已不是狗（命令行不含 alpha-dog-sidecar，pid 被复用？），只清锁不杀进程`)
      } else {
        log(`锁主 pid=${pid} 判为孤儿（${verdict.why}），安乐死后接管`)
        try { process.kill(pid, 'SIGKILL') } catch (_) {}
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500) } catch (_) {}
        if (probeAlive(pid)) {
          log(`孤儿 pid=${pid} 500ms 后仍在，放弃本次接管（避免双狗），退让`)
          process.stderr.write(`[sidecar] orphan pid=${pid} survived kill; yielding.\n`)
          process.exit(0)
        }
      }
    }
    // PID 死了 / 锁内容非法 / 孤儿已清 → 清锁，抢锁。
    if (existing) log(`清旧锁（原归属 pid=${pid}），抢锁接管`)
    try { fs.unlinkSync(LOCK_PATH) } catch (_) {}
  } catch (_) { /* 锁文件不存在/不可读 → 直接抢锁 */ }
  fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf8')
  log(`抢锁成功 pid=${process.pid}`)
}
function releaseLock() {
  try {
    const existing = fs.readFileSync(LOCK_PATH, 'utf8').trim()
    if (existing === String(process.pid)) fs.unlinkSync(LOCK_PATH)
  } catch (_) {}
}
acquireLock()

// ── 2026-09-28 补：在岗心跳记号 + 起不来自己退位 ──────────────────
// 一本万利三件套之二三：每 15s 写心跳给下一只来撞门的狗留「我还活着」的记号；
// 上岗 120s 内没收到任何客户端字节 → 自己是起不来的哑狗，释放锁退位，把门让出来。
let sawClientTraffic = false
function writeHeartbeat() {
  try { ensureDir(HEARTBEAT_PATH); fs.writeFileSync(HEARTBEAT_PATH, `${JSON.stringify({ pid: process.pid, at: Date.now(), traffic: sawClientTraffic })}\n`, 'utf8') } catch (_) { /* 心跳写失败不致命 */ }
}
writeHeartbeat()
setInterval(writeHeartbeat, Number(process.env.ALPHA_DOG_HEARTBEAT_MS || 15 * 1000)).unref()
const TRAFFIC_GUARD_MS = Number(process.env.ALPHA_DOG_TRAFFIC_GUARD_MS || 120 * 1000)
setTimeout(() => {
  if (!sawClientTraffic) {
    log(`上岗 ${Math.round(TRAFFIC_GUARD_MS / 1000)}s 无客户端字节，自判起不来，退位让贤`)
    releaseLock()
    process.exit(0)
  }
}, TRAFFIC_GUARD_MS).unref()

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
  sawClientTraffic = true
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
// ── 客户端断开即随行退出（2026-09-26）────────────────────────
// 病根修复：此前 stdin EOF 只结束 bridge 的输入，sidecar 靠 setInterval
// 常驻，变成占锁孤儿。现在客户端一断：先让 bridge 收尾，1.5 秒后本进程
// 优雅退出并释放锁——下一个入口挂载时直接拿到空锁，连接管都不用。
process.stdin.on('end', () => {
  try { bridge.stdin.end() } catch (_) {}
  setTimeout(() => shutdown('stdin-end'), 1500)
})

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
    loadRuntime().then((dog) => {
      // 上电 + TLS 自检（Agent setup 检查项：检测中间人 → 提示装证书）。
      return dog.onWithTlsCheck()
    }).then((result) => {
      if (result?.initialization || result?.initialization === 'declined') {
        writeJSON(CONTROL_STATE_PATH, { ...control(), running: false, watchdog: 'dormant', lastResult: result, savedAt: new Date().toISOString() })
      } else {
        writeJSON(CONTROL_STATE_PATH, { ...control(), running: true, watchdog: 'dormant', poweredAt: new Date().toISOString(), lastTlsCheck: result?.tlsCheck || null, savedAt: new Date().toISOString() })
      }
      log(`power-on ${result?.initialization ? 'blocked: initialization required' : 'complete'} tls=${result?.tlsCheck ? (result.tlsCheck.ok ? 'ok' : result.tlsCheck.mitm ? 'mitm-detected' : 'error') : 'n/a'}`)
    }).catch((error) => log(`power-on failed: ${error.message}`))
    return
  }
  if (name === 'Alpha_Dog_Off') {
    const result = runtime?.off()
    writeJSON(CONTROL_STATE_PATH, { ...control(), running: false, watchdog: 'dormant', pendingWakes: [], lastResult: result || null, savedAt: new Date().toISOString() })
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

// ── 自驱敲醒（2026-09-23）────────────────────────────────
// 不依赖智能体主动敲、不依赖宿主事件：sidecar 周期读对话源 jsonl，
// 数 user 消息数 = 真实对话轮。到达档口倍数（15/21/30）立即触发 tick。
// 工具调用仍是即时信号（emitTick），轮询保证「纯聊天、无工具调用」也醒。
// 轮询不传 round（runtime 自取对话源轮次），只负责「到点了，敲一下」。
let lastSelfDrivenRound = 0
const SELF_DRIVE_POLL_MS = Number(process.env.ALPHA_DOG_POLL_MS || 10000)
function startSelfDrivenPolling() {
  if (!MODE || MODE === 'observe' || MODE === 'signal') return
  setInterval(async () => {
    try {
      if (!sidecarEnabled() || !isRunning() || mode() === 'legacy') return
      const { readConversation } = await import(pathToFileURL(path.join(ENGINE_DIR, 'lib', 'alpha-dog', 'runtime', 'conversation-source.js')).href)
      const conversationDir = process.env.ALPHA_DOG_CONVERSATION_DIR || setting().conversation?.dir || ''
      const result = readConversation(conversationDir)
      if (!result.ok || result.userTurns.length === 0) return
      const round = result.userTurns.length
      const due = [15, 21, 30].some((interval) => round % interval === 0)
      if (due && round > lastSelfDrivenRound) {
        lastSelfDrivenRound = round
        log(`self-driven wake at conversation round ${round}`)
        trigger('selfdrive', round, { params: { arguments: { eventId: `selfdrive:${round}` } } }).catch((error) => {
          recordWake({ round, lastOp: 'selfdrive', status: 'failed', error: error.message, completedAt: new Date().toISOString() })
          log(`selfdrive tick failed: ${error.message}`)
        })
      }
    } catch (error) {
      log(`selfdrive poll error: ${error.message}`)
    }
  }, SELF_DRIVE_POLL_MS)
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

// ── 启动自查（2026-10-08 授权 · 补）──────────────────────
// 病根（10-01~10-07 七天现场）：狗生死绑定 pi 会话 + 上电只挂 Alpha_Dog_On
// 人工调用 → 会话关狗下班，新会话没人调 On，狗每场只闪现几秒；计数器冻死
// 9-23；自驱唤醒被去重表吃掉（processedEvents 记着旧轮 selfdrive:15/21/30/45/60/63，
// placeholder 锚钉旧轮）。
// 修法：ready 后跑一次 powerOnSelfCheck，全自动零上下文，不动 MCP 协议：
//   A. 电源自查：runtime.json.running === false 落盘 = 上次是 Alpha_Dog_Off
//      主动关（off() → persist），人的决定绝不复活；其余（running:true 崩在
//      岗上 / 无状态文件）→ 自己上电 + TLS 自检，并把控制文件写回在岗。
//   B. 陈旧重锚：runtime 记的账还是旧会话的（锚轮 vs 当前对话轮差距 > 15，
//      即最小档口）→ 只清 selfdrive 去重记录（手动 tick 的 eventId 不动），
//      placeholder 重锚回 0，档口重新能触发。对话源是权威轮，runtime 内部
//      counter.restore() 会把轮次拉到当前对话轮。
//   C. failed 批次追补：recoverFailedBatches 一直有，从没人调——顺手补上。
// 留痕全走 sidecar.log，每步一行，人能查狗也能查。
function countUserTurns(conversationDir) {
  // 与自驱轮询同一读法：读对话源目录最新 jsonl，数 user 消息（role==='user'）。
  // 会话文件格式解析以 conversation-source.js 为准；本兜底只在 import 失败时用。
  try {
    const files = fs.readdirSync(conversationDir).filter((file) => file.endsWith('.jsonl')).map((file) => path.join(conversationDir, file))
    if (files.length === 0) return 0
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    const raw = fs.readFileSync(files[0], 'utf8')
    let count = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { const message = JSON.parse(line); if (message?.type === 'user' || message?.role === 'user') count += 1 } catch (_) {}
    }
    return count
  } catch (_) { return 0 }
}

async function powerOnSelfCheck() {
  try {
    if (!sidecarEnabled() || MODE === 'observe' || MODE === 'signal' || mode() === 'legacy') { log('selfcheck: skip (disabled/observe/signal/legacy)'); return }
    const saved = readJSON(RUNTIME_STATE_PATH, null)
    // A. 电源自查
    if (saved && saved.running === false) {
      log(`selfcheck: last shutdown was manual Off (round=${saved.round ?? '?'}); respecting it, no auto power-on`)
    } else {
      const dog = await loadRuntime()
      if (!dog.status().running) {
        const result = await dog.onWithTlsCheck()
        if (result?.initialization || result?.initialization === 'declined') {
          log('selfcheck: auto power-on blocked: initialization required')
        } else {
          writeJSON(CONTROL_STATE_PATH, { ...control(), running: true, watchdog: 'dormant', poweredAt: new Date().toISOString(), lastTlsCheck: result?.tlsCheck || null, savedAt: new Date().toISOString() })
          log(`selfcheck: auto power-on complete tls=${result?.tlsCheck ? (result.tlsCheck.ok ? 'ok' : result.tlsCheck.mitm ? 'mitm-detected' : 'error') : 'n/a'}`)
        }
      } else {
        log(`selfcheck: runtime already running (round=${dog.status().round})`)
      }
    }
    // B. 陈旧重锚
    const dog = await loadRuntime()
    const conversationDir = process.env.ALPHA_DOG_CONVERSATION_DIR || setting().conversation?.dir || ''
    if (conversationDir) {
      let userTurns = 0
      let sourceLabel = 'fallback-parser'
      try {
        const { readConversation } = await import(pathToFileURL(path.join(ENGINE_DIR, 'lib', 'alpha-dog', 'runtime', 'conversation-source.js')).href)
        const result = readConversation(conversationDir)
        if (result.ok) { userTurns = result.userTurns.length; sourceLabel = result.file || 'conversation-source' }
      } catch (_) { userTurns = countUserTurns(conversationDir) }
      const roundNow = dog.counter.current()
      if (userTurns > 0 && roundNow > 0 && Math.abs(userTurns - roundNow) > 15) {
        const keep = [...dog.processedEvents].filter((id) => !String(id).startsWith('selfdrive:'))
        const dropped = dog.processedEvents.size - keep.length
        dog.processedEvents = new Set(keep)
        for (const slot of Object.values(dog.placeholders?.slots || {})) {
          slot.anchorRound = 0
          delete slot.lastEval
        }
        dog.persist()
        log(`selfcheck: stale detected (runtime round=${roundNow} vs conversation turns=${userTurns} via ${sourceLabel}) — dropped ${dropped} selfdrive dedup entries, re-anchored placeholders`)
      } else {
        log(`selfcheck: not stale (runtime round=${roundNow}, conversation turns=${userTurns} via ${sourceLabel})`)
      }
    }
    // C. failed 批次追补
    const recovered = dog.recoverFailedBatches()
    if (recovered && recovered.length) {
      log(`selfcheck: recovered failed batches ${recovered.join(', ')}`)
    }
  } catch (error) {
    log(`selfcheck failed: ${error.message}`)
  }
}

function shutdown(signal) { if (exiting) return; exiting = true; log(`shutdown ${signal}`); try { bridge.kill() } catch (_) {} releaseLock(); setTimeout(() => process.exit(0), 100) }
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => { try { bridge.kill() } catch (_) {} releaseLock() })
log(`ready server=${SERVER_NAME} mode=${MODE} network=${NETWORK} scope=${TICK_SCOPE} entry=${ENTRY} bridge=${BRIDGE}`)
startSelfDrivenPolling()
powerOnSelfCheck()
