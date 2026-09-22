import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)

const project = process.cwd()
const sidecar = join(project, 'runtime', 'alpha-dog-sidecar.cjs')
const bridge = join(project, '..', 'alpha_memory_bridge.js')

test('sidecar renders the MCP entry from setting without starting anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-dog-sidecar-config-'))
  const setting = join(root, 'setting.json')
  writeFileSync(setting, JSON.stringify({
    sidecar: {
      enabled: true, mode: 'observe', network: 'on', countScope: 'all_tools',
      entry: 'engine/runtime/alpha-dog-sidecar.cjs', bridge: 'alpha_memory_bridge.js',
      node: '', serverName: 'alpha-memory-test',
    },
  }))
  const { stdout } = await execFileAsync(process.execPath, [sidecar, '--print-config'], {
    env: { ...process.env, ALPHA_MEMORY_HOME: join(project, '..'), ALPHA_DOG_SETTING: setting },
    encoding: 'utf8',
  })
  const block = JSON.parse(stdout)
  const server = block.mcpServers['alpha-memory-test']
  assert.ok(server, 'serverName from setting must name the mcpServers entry')
  assert.equal(server.args[0], sidecar)
  assert.equal(server.env.SIDECAR_MODE, 'observe')
  assert.equal(server.env.SIDECAR_NETWORK, 'on')
  assert.equal(server.env.SIDECAR_TICK_SCOPE, 'all_tools')
  assert.equal(server.env.ALPHA_MEMORY_HOME, join(project, '..'))
  // 打印配置不得启动 bridge、不得写状态
  assert.equal(existsSync(join(root, 'state')), false)
  rmSync(root, { recursive: true, force: true })
})

test('sidecar refuses a bridge path that does not exist instead of degrading silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-dog-sidecar-missing-'))
  const setting = join(root, 'setting.json')
  writeFileSync(setting, JSON.stringify({ sidecar: { enabled: true, bridge: 'does-not-exist.js' } }))
  let code = null; let stderr = ''
  const child = spawn(process.execPath, [sidecar], {
    env: { ...process.env, ALPHA_MEMORY_HOME: join(project, '..'), ALPHA_DOG_SETTING: setting, STATE_DIR: join(root, 'state'), SIDECAR_FORCE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 2)
  assert.match(stderr, /bridge missing/)
  rmSync(root, { recursive: true, force: true })
})

test('published sidecar runs the real bridge chain and honors On/Off plus wake signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-dog-sidecar-test-'))
  const state = join(root, 'state')
  const setting = join(root, 'setting.json')
  const tokenFile = join(root, 'alpha-token.txt')
  writeFileSync(tokenFile, 'test-only-token\n')
  writeFileSync(setting, JSON.stringify({
    enabled: true,
    interfaces: { Alpha_Dog_On: true, Alpha_Dog_Off: true, cg: false, stg: false },
    schedule: { slots: [{ id: 'light', interval: 2, prompt: 'watchdog-light', registryTags: [], allowedModes: ['backfill', 'monitor'] }], simultaneousOrder: ['light'], sequentialWake: true },
    initialization: { mention: 'off', status: 'configured' },
    state: { directory: 'state', mode: 'shadow' },
    sidecar: { enabled: true, mode: 'wake', network: 'off', countScope: 'tool_call', bridge: 'alpha_memory_bridge.js' },
    batchSize: 8,
  }))

  const child = spawn(process.execPath, [sidecar], {
    env: {
      ...process.env,
      ALPHA_MEMORY_HOME: join(project, '..'),
      ALPHA_DOG_SETTING: setting,
      STATE_DIR: state,
      ALPHA_DOG_CONTROL_STATE: join(state, 'mcp-control.json'),
      ALPHA_MEMORY_BRIDGE: bridge,
      SIDECAR_FORCE: '1',
      MDCG_ROOT: join(root, 'mdcg'),
      MDCG_STATE_ROOT: join(root, 'state-root'),
      MDCG_TOKEN_FILE: tokenFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderr = ''
  const byId = new Map()
  const waiters = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        if (message?.id === undefined) continue
        byId.set(message.id, message)
        const waiter = waiters.get(message.id)
        if (waiter) { waiters.delete(message.id); waiter(message) }
      } catch { /* non-JSON noise on stdout */ }
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  const write = (payload) => child.stdin.write(JSON.stringify(payload) + '\n')
  const awaitResponse = (id, label) => new Promise((resolve, reject) => {
    if (byId.has(id)) return resolve(byId.get(id))
    const timer = setTimeout(() => reject(new Error(`${label} timed out; stderr=${stderr}`)), 8000)
    waiters.set(id, (message) => { clearTimeout(timer); resolve(message) })
  })

  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sidecar-test', version: '1' } } })
    const init = await awaitResponse(1, 'initialize')
    assert.equal(init.result?.serverInfo?.name, 'mdcg-mcp', stderr)

    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = await awaitResponse(2, 'tools/list')
    const names = (tools.result?.tools || []).map((tool) => tool.name)
    assert.ok(names.includes('Alpha_Dog_On'), `Alpha_Dog_On missing in ${names.join(',')}`)
    assert.ok(names.includes('Alpha_Dog_Off'), `Alpha_Dog_Off missing in ${names.join(',')}`)

    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Alpha_Dog_On', arguments: {} } })
    const on = await awaitResponse(3, 'Alpha_Dog_On')
    const onPayload = JSON.parse(on.result.content[0].text)
    assert.equal(onPayload.status, 'on')

    write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cg', arguments: { op: 'info' } } })
    write({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cg', arguments: { op: 'info' } } })
    await awaitResponse(4, 'cg#1')
    await awaitResponse(5, 'cg#2')
    await new Promise((resolve) => setTimeout(resolve, 400))

    const counter = JSON.parse(readFileSync(join(state, 'sidecar-counter.json'), 'utf8'))
    const signal = JSON.parse(readFileSync(join(state, 'sidecar-wake-signal.json'), 'utf8'))
    assert.equal(counter.count, 2, stderr)
    assert.equal(signal.slot, 'light', stderr)
    assert.equal(signal.round, 2, stderr)
    assert.equal(signal.source, 'sidecar', stderr)
    // No model transport is wired in this run, so the wake must be booked as
    // degraded debt rather than reported as a successful wake.
    assert.equal(signal.network, 'disabled', stderr)
    assert.equal(signal.status, 'degraded', stderr)

    write({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'Alpha_Dog_Off', arguments: {} } })
    const off = await awaitResponse(6, 'Alpha_Dog_Off')
    assert.equal(JSON.parse(off.result.content[0].text).status, 'off')

    write({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cg', arguments: { op: 'info' } } })
    await awaitResponse(7, 'cg#3')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const stopped = JSON.parse(readFileSync(join(state, 'sidecar-counter.json'), 'utf8'))
    assert.equal(stopped.count, 2, 'Alpha_Dog_Off must stop counting')

    assert.ok(existsSync(bridge))
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})
