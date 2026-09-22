import { existsSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const tsc = 'node_modules/typescript/bin/tsc'
const config = 'tsconfig.json'
const output = 'lib.next'

for (const required of [tsc, config]) {
  if (!existsSync(required)) {
    console.error(`[build] missing ${required}; run npm install --include=dev in a source checkout`)
    process.exit(1)
  }
}

rmSync(output, { recursive: true, force: true })
const result = spawnSync(process.execPath, [tsc, '-p', config, '--outDir', output], {
  stdio: 'inherit',
})
if (result.status !== 0) {
  rmSync(output, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}

rmSync('lib', { recursive: true, force: true })
renameSync(output, 'lib')
