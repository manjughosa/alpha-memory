import { execFile } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const bundledPython = resolve(root, '..', 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const execFileAsync = promisify(execFile)

async function clientFor(memoryRoot) {
  const { MdcgClient } = await import(pathToFileURL(resolve(root, 'lib', 'lib', 'mdcg_client.js')).href)
  const client = new MdcgClient({
    python: pythonCommand(),
    root: memoryRoot,
    cwd: root,
    env: { MDCG_LEGACY_ENV_AUTH: '1' },
    timeoutMs: 30_000,
    maxRetryDelayMs: 1_000,
  })
  client.start()
  assert.equal(await client.waitReady(), true)
  return client
}

function pythonCommand() {
  if (process.env.MDCG_TEST_PYTHON) return process.env.MDCG_TEST_PYTHON
  return existsSync(bundledPython) ? bundledPython : (process.platform === 'win32' ? 'python' : 'python3')
}

test('published runtime subpaths import without plugin entrypoint', async () => {
  const runtime = resolve(root, 'lib', 'alpha-dog.js')
  const config = resolve(root, 'lib', 'alpha-dog-config.js')
  assert.equal(existsSync(runtime), true)
  assert.equal(existsSync(config), true)
  const runtimeModule = await import(pathToFileURL(runtime).href)
  const configModule = await import(pathToFileURL(config).href)
  assert.equal(typeof runtimeModule.AlphaDogRuntime, 'function')
  assert.equal(typeof configModule.loadAlphaDogSetting, 'function')
})

test('bridge completes a real MCP handshake', async (t) => {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'alpha-memory-node-smoke-'))
  const client = await clientFor(memoryRoot)
  t.after(() => client.dispose())
  const info = await client.serviceInfo()
  assert.equal(info.ok, true)
  assert.equal(info.surface, 'full')
  assert.ok(Array.isArray(info.tools) && info.tools.includes('cg'))
})

test('npm publish whitelist excludes development artifacts', async () => {
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'npm_execpath is required when tests run through npm')
  const { stdout } = await execFileAsync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  const jsonStart = stdout.search(/\[\s*\{/)
  assert.notEqual(jsonStart, -1, `npm pack did not emit JSON: ${stdout.slice(0, 200)}`)
  const [{ files }] = JSON.parse(stdout.slice(jsonStart))
  const paths = files.map(({ path }) => path.replaceAll('\\', '/'))
  assert.ok(paths.includes('lib/alpha-dog.js'))
  assert.ok(paths.includes('scripts/review_cli.py'))
  assert.ok(paths.includes('alpha-dog.setting.json'))
  assert.ok(paths.includes('md_cg/policy.default.json'))
  assert.equal(paths.some((path) => path === 'node_modules' || path.startsWith('node_modules/')), false)
  assert.equal(paths.some((path) => path === 'test' || path.startsWith('test/')), false)
  assert.equal(paths.some((path) => path === 'lib.next' || path.startsWith('lib.next/')), false)
  // Development backups must never ship: the release sync already excludes them,
  // and `files` includes src wholesale, so npm needs its own negation.
  assert.equal(paths.some((path) => /\.bak-|\.orig$/.test(path)), false)
  assert.ok(paths.includes('runtime/alpha-dog-sidecar.cjs'))
})

test('stg executes all four operations through MCP', async (t) => {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'alpha-memory-stg-'))
  const client = await clientFor(memoryRoot)
  t.after(() => client.dispose())

  await client.write('STG alpha', { node_id: 'stg_alpha', condition_space: { time_window: [10, 20] } })
  await client.write('STG beta', { node_id: 'stg_beta', condition_space: { time_window: [30, 40] } })

  const relation = await client.stg({ op: 'relation', a: 'stg_alpha', b: 'stg_beta' })
  assert.equal(relation.time.relation, 'before')
  const timeline = await client.stg({ op: 'timeline', layer: 'knowledge', limit: 10, desc: false })
  assert.deepEqual(timeline.items.map(({ id }) => id), ['stg_alpha', 'stg_beta'])
  const anchors = await client.stg({ op: 'anchors', time_window: [5, 25], layer: 'knowledge' })
  assert.deepEqual(anchors.items.map(({ id }) => id), ['stg_alpha'])
  const consistency = await client.stg({ op: 'consistency', layer: 'knowledge' })
  assert.equal(consistency.scanned, 2)
  assert.equal(consistency.issues, 0)
})

test('two MCP processes preserve concurrent writes to one root', async (t) => {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'alpha-memory-concurrent-'))
  const clients = await Promise.all([clientFor(memoryRoot), clientFor(memoryRoot)])
  t.after(() => clients.forEach((client) => client.dispose()))

  const writesPerClient = 100
  await Promise.all(clients.map((client, worker) => Promise.all(
    Array.from({ length: writesPerClient }, (_, index) => client.write(
      `concurrent worker ${worker} item ${index}`,
      { node_id: `concurrent_${worker}_${index}` },
    )),
  )))

  const verifier = await clientFor(memoryRoot)
  t.after(() => verifier.dispose())
  const info = await verifier.serviceInfo()
  assert.equal(info.total_nodes, writesPerClient * clients.length)
  for (let worker = 0; worker < clients.length; worker += 1) {
    for (let index = 0; index < writesPerClient; index += 1) {
      const node = await verifier.get(`concurrent_${worker}_${index}`)
      assert.equal(node.id, `concurrent_${worker}_${index}`)
    }
  }

})
