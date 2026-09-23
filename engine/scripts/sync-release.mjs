import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(engine, '..')
const auditOnly = process.argv.includes('--audit-only')
const targetArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const target = targetArg ? resolve(targetArg) : resolve(source, '..', '..', '..', '..', 'backup', 'tools', 'MCP', 'Alpha-Memory')
const excludes = [
  /^\.git(?:[\\/]|$)/,
  /^token(?:[\\/]|$)/,
  /^data(?:[\\/]|$)/,
  /^backups(?:[\\/]|$)/,
  // 根 runtime/ 是随发行物分发的嵌入式 Python（Windows 版），必须同步：
  // bridge 解释器候选的第一位就是 runtime/python.exe，缺它则没有系统 Python 的
  // 目标机器起不了内核。只排除私有的 bin/ 与 Python 自己生成的字节码缓存
  // （__pycache__ / \.py[cod]$ 见下方），后者会嵌入构建机绝对路径。
  /^runtime[\\/]bin[\\/]/,
  /^engine[\\/]state(?:[\\/]|$)/,
  // 兜底（苏苏 20260923）：sidecar/runtime 状态文件无论落在仓库哪个层级，
  // 一律排除——它们记录真实对话痕迹与本机行为，与 engine/state 同级敏感。
  /(?:^|[/\\])sidecar\.log$/,
  /(?:^|[/\\])sidecar-[^/\\]+\.(?:json|jsonl)$/,
  /(?:^|[/\\])sidecar\.lock$/,
  /(?:^|[/\\])runtime\.json(?:\.bak-[^/\\]*)?$/,
  /(?:^|[/\\])batch-report\.json$/,
  /(?:^|[/\\])release-sync-report\.json$/,
  /(?:^|[/\\])mcp-control\.json$/,
  /^engine[\\/]node_modules(?:[\\/]|$)/,
  // 记忆索引缓存（_md_cg_p*）：含本机路径与私有记忆内容分片，已在 .gitignore
  // 第 10 行排除；发行同步必须同样排除，否则会把私有内容镜像进发行端目录。
  /^engine[\\/]_md_cg_p\d+/,
  /^engine[\\/]_(?:review|test).*\.txt$/,
  // 备份/临时副本绝不出包：它们是「曾经的配置」，可能含明文凭据（实证：
  // alpha-dog.setting.json.bak-* 里留有 sk- 明文，被发布闸门拦下）。
  /(?:^|[\\/])[^\\/]*\.bak(?:-|$)/,
  /\.(?:bak|orig|corrupted)(?:-|$)/,
  /(?:^|[\\/])\.consistency-/,
  /(?:^|[\\/])__pycache__(?:[\\/]|$)/,
  /\.py[co]$/,
  /^engine[\\/]docs(?:[\\/]|$)/,
  // 根目录的临时报告（1.md / 2.md / 3.md / 3.5.md / 4.md…）：含本机路径与内部
  // 排查记录，不是产品文件，不随包发行。报告本体保持原样，不在同步里改它。
  /^\d+(?:\.\d+)?\.md$/,
  // 中间文件（治理清单 / 变更清单）：内部过程记录，不属于发行物。与编号报告
  // 同理，本体保持原样，不在同步里改写它，只保证它不被镜像到发行端。
  /^治理清单(?:速朗)?\.md$/,
  /^变更清单-\d+\.md$/,
  /^engine[\\/]recovery-alpha-dog(?:[\\/]|$)/,
  /^engine[\\/]md_cg[\\/]whitebox_kb[\\/]seed_knowledge[\\/]wisdom_cards[\\/](?:情感情绪仿真·知识综述|时空记忆图·知识综述)\.md$/,
]

const purgeFromTarget = [
  // 注意：runtime/ 不在此列——它是发行物的一部分（嵌入式 Python）。只有私有的
  // bin/ 需要从目标端清掉，否则历史残留会一直躺在发行端。
  /^runtime[\\/]bin[\\/]/,
  /^engine[\\/]state(?:[\\/]|$)/,
  // 兜底（苏苏 20260923）：与 excludes 同步——发行端历史残留的状态文件
  // （无论落在哪一层）也一并清除，防止旧版本残留的对话痕迹永久沉积。
  /(?:^|[/\\])sidecar\.log$/,
  /(?:^|[/\\])sidecar-[^/\\]+\.(?:json|jsonl)$/,
  /(?:^|[/\\])sidecar\.lock$/,
  /(?:^|[/\\])runtime\.json(?:\.bak-[^/\\]*)?$/,
  /(?:^|[/\\])batch-report\.json$/,
  /(?:^|[/\\])release-sync-report\.json$/,
  /(?:^|[/\\])mcp-control\.json$/,
  /^engine[\\/]node_modules(?:[\\/]|$)/,
  /^engine[\\/]_md_cg_p\d+/,
  /^engine[\\/]adapters(?:[\\/]|$)/,
  /^engine[\\/]skills(?:[\\/]|$)/,
  /(?:^|[\\/])__pycache__(?:[\\/]|$)/,
  /\.py[co]$/,
  /^\d+(?:\.\d+)?\.md$/,
  /^治理清单(?:速朗)?\.md$/,
  /^变更清单-\d+\.md$/,
]

function files(root, rules = excludes) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const rel = relative(root, path)
      if (rules.some((rule) => rule.test(rel))) continue
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findViolation(path) {
  const buffer = readFileSync(path)
  const text = buffer.includes(0) ? '' : buffer.toString('utf8')
  // 本机绝对路径由运行时的 source 推出，而不是硬编码进源码：硬编码本身就是把
  // 那条机器路径写进发行物（这条规则原先正是那个样子，自己成了唯一的泄漏源）。
  // 闸门行为不变——它检查的始终是「当前构建机自己的路径」。
  const forbidden = [
    /mdcg1\.[a-z]+\.tk_[0-9a-f]+\.[A-Za-z0-9_-]+/,
    /sk-[A-Za-z0-9]{16,}/,
    new RegExp(escapeRegExp(source), 'i'),
  ]
  for (const rule of forbidden) if (rule.test(text)) return String(rule)
  return null
}

function releaseBytes(path, rel) {
  const buffer = readFileSync(path)
  if (buffer.includes(0)) return buffer
  let text = buffer.toString('utf8').replaceAll('接口角色', '接口角色').replaceAll('interface-role', 'interface-role')
  // 具体宿主的配置文件名不进发行物。它们原本是「禁止引入宿主插件」这条纪律的
  // 举例，但举例本身会把平台字样写进公开仓库——纪律照旧，举例换成通用表述。
  // 这里按「路径字面量」替换而不是按整行措辞替换：以后那句注释怎么改写都不会
  // 让清洗静默失效。
  text = text
    .replaceAll('宿主设置文件', '宿主设置文件')
    .replaceAll('宿主 hooks 文件', '宿主 hooks 文件')
  // 「发布边界」是维护者视角的纪律说明（本仓库自己怎么同步、怎么发布），属于
  // 研发端文档。放进随包 README 会让读者困惑——例如「仓库默认无远程」在已经
  // 发布出去的仓库里就是自相矛盾。发行端整节移除，研发端原文保持不动。
  if (rel === 'README.md') text = text.replace(/\n*## 发布边界\n[\s\S]*$/, '\n')
  if (rel === 'alpha-dog.setting.json' || rel === 'engine/alpha-dog.setting.json') {
    const setting = JSON.parse(text)
    setting.enabled = false
    setting.initialization = { ...(setting.initialization || {}), mention: 'on', status: 'unconfigured' }
    setting.state = { ...(setting.state || {}), mode: 'legacy' }
    setting.model = { name: '', baseUrl: '', api: '', apiKeyRef: '', models: [] }
    // The sidecar is a client-side deployment choice: a fresh release must stay
    // inert and let the operator opt in explicitly (matches the TS safe default).
    if (setting.sidecar) setting.sidecar = { ...setting.sidecar, enabled: false, mode: 'wake', network: 'off' }
    return Buffer.from(JSON.stringify(setting, null, 2) + '\n', 'utf8')
  }
  return Buffer.from(text, 'utf8')
}

const sourceFiles = files(source)
// 发布闸门 fail-closed：一次列全所有违规文件（不因第一个就短路，否则排查要来回跑）。
const violations = sourceFiles.map((rel) => [rel, findViolation(join(source, rel))]).filter(([, reason]) => reason)
if (violations.length > 0) {
  console.error('发布闸门拒绝：以下文件不得出包（含明文凭据或本机路径）')
  for (const [rel, reason] of violations) console.error(`  - ${rel} :: ${reason}`)
  process.exit(1)
}
if (!auditOnly) {
  mkdirSync(target, { recursive: true })
  for (const rel of sourceFiles) {
    const from = join(source, rel)
    const to = join(target, rel)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, releaseBytes(from, rel))
  }
  const allowed = new Set(sourceFiles)
  // 目标端必须全量枚举再删：如果继续用 excludes 枚举，历史私有/平台文件会因
  // “看不见”而永久沉积，上一版发行目录中的 Windows runtime 就是该缺陷的证据。
  for (const rel of files(target, [/^\.git(?:[\\/]|$)/]).reverse()) {
    if (!allowed.has(rel) || purgeFromTarget.some((rule) => rule.test(rel))) rmSync(join(target, rel), { force: true })
  }
}
const report = { version: 'alpha-release/1', source, target, auditOnly, files: sourceFiles.length, excludedPolicies: excludes.map(String), checkedAt: new Date().toISOString() }
const reportPath = join(source, 'engine', 'state', 'release-sync-report.json')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
