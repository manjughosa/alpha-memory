#!/usr/bin/env node
/**
 * kill-dog.cjs · Alpha-Dog 安乐死工具
 * ---------------------------------------------------------------------------
 * 用途：当 sidecar（Alpha-Dog）成了「孤儿守门人」——进程还活着、锁还占着，
 *       但连着它的客户端早就走了 —— 用它把狗干净地送走，并释放 sidecar.lock。
 *
 * 来历：2026-09-24 早上。Pi 端连不上 alpha-memory，报 Connection closed；
 *       根因是 sidecar 的单实例锁只判「pid 是否活着」，不判「主人还在不在」。
 *       那天是人工 taskkill 解决的。这个脚本就是把那次人工动作固化下来。
 *
 * 用法：
 *   node kill-dog.cjs                 # 按锁文件找到那只狗，确认后安乐死，并清锁
 *   node kill-dog.cjs --dry-run       # 只看（打印将要对谁下手），不动手
 *   node kill-dog.cjs --all           # 扫描全机所有 alpha-dog-sidecar 进程，全送走
 *   node kill-dog.cjs --pid 12345     # 指定 pid（仍会校验它是不是狗）
 *   node kill-dog.cjs --force         # 跳过「是不是狗」的校验（危险，仅在你确知 pid 时用）
 *   node kill-dog.cjs --if-orphan     # 只在锁主是孤儿时才动手（僵尸/心跳双判据），否则不动
 *   node kill-dog.cjs --if-orphan --stale-ms 60000  # 心跳阈值临时改 60 秒（测试用；默认 30 分钟）
 *
 * 安全条款（照抄项目惯例）：
 *   1. 默认只杀「命令行里确实含 alpha-dog-sidecar」的进程 —— 防止 pid 复用误杀无关 node。
 *   2. 校验不过就停手并报告，绝不自作主张。
 *   3. 清锁只在「确认那只狗已经不在」之后执行。
 *   4. --dry-run 永远不赦免任何一步检查。
 *
 * 依赖：Node（包内自带）。进程查询优先 PowerShell CIM，回退 wmic，再回退 tasklist。
 *       三层都不可用时，脚本会明确告诉你「依赖缺失」，而不是假装成功。
 * ---------------------------------------------------------------------------
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ── 与 sidecar 完全一致的路径解析（必须一致，否则找不到同一把锁）──────────
const SIDECAR_HOME = __dirname
const PKG_ROOT = process.env.ALPHA_MEMORY_HOME || path.resolve(SIDECAR_HOME, '..', '..')
const ENGINE_DIR = path.join(PKG_ROOT, 'engine')
const STATE_DIR = process.env.STATE_DIR || path.join(ENGINE_DIR, 'state')
const LOCK_PATH = process.env.SIDECAR_LOCK || path.join(STATE_DIR, 'sidecar.lock')

const DOG_MARK = 'alpha-dog-sidecar'

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const DRY_RUN = has('--dry-run')
const FORCE = has('--force')
const ALL = has('--all')
const pidIdx = argv.indexOf('--pid')
const PID_ARG = pidIdx >= 0 ? Number(argv[pidIdx + 1]) : null
const IF_ORPHAN = has('--if-orphan')
const staleIdx = argv.indexOf('--stale-ms')
const STALE_MS = staleIdx >= 0 ? Number(argv[staleIdx + 1]) : 30 * 60 * 1000

// ── 输出 ────────────────────────────────────────────────────────────────
const say = (msg) => process.stdout.write(msg + '\n')
const warn = (msg) => process.stderr.write(msg + '\n')

// ── 进程工具（三层回退）─────────────────────────────────────────────────
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function tryExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  } catch (e) {
    return null
  }
}

/** 取进程命令行；三层回退；全失败返回 null（= 依赖缺失） */
function cmdline(pid) {
  const ps = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])
  if (ps && ps.trim()) return ps.trim()

  const wm = tryExec('wmic', ['process', 'where', `processid=${pid}`, 'get', 'commandline', '/value'])
  if (wm && /CommandLine=/i.test(wm)) return wm.replace(/\r/g, '').split('\n')
    .find((l) => /^CommandLine=/i.test(l))?.slice('CommandLine='.length).trim() || null

  const tl = tryExec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  if (tl && /node\.exe/i.test(tl)) return '(unknown-cmdline:node.exe)'

  return null
}

function isDog(pid) {
  if (FORCE) return { ok: true, why: '--force 跳过校验' }
  const line = cmdline(pid)
  if (line === null) return { ok: false, why: '依赖缺失：拿不到该进程的命令行（powershell/wmic/tasklist 全不可用），拒绝盲杀' }
  if (line.includes(DOG_MARK)) return { ok: true, why: '命令行命中 alpha-dog-sidecar' }
  return { ok: false, why: `pid ${pid} 不是狗（命令行里没有 ${DOG_MARK}）——多半是 pid 被复用了` }
}

/** 扫描全机所有狗 */
function listDogs() {
  const ps = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${DOG_MARK}*' } | ForEach-Object { "$($_.ProcessId)" }`])
  if (ps !== null) {
    return ps.replace(/\r/g, '').split('\n').map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  }
  const tl = tryExec('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'])
  if (!tl) return null
  const pids = tl.replace(/\r/g, '').split('\n').map((l) => Number((l.split('","')[1] || '').replace(/"/g, '')))
    .filter((n) => Number.isInteger(n) && n > 0)
  return pids.filter((p) => { const c = cmdline(p); return c && c.includes(DOG_MARK) })
}

// ── 锁 ──────────────────────────────────────────────────────────────────
function readLock() {
  try { return fs.readFileSync(LOCK_PATH, 'utf8').trim() } catch (e) { return null }
}
function dropLock(pid) {
  const cur = readLock()
  if (cur === null) return '（锁文件本就不存在）'
  if (pid !== null && cur !== String(pid)) {
    return `（锁里写的是 pid=${cur}，不是本次处理的对象，未动它）`
  }
  if (DRY_RUN) return '（--dry-run：未清锁）'
  try { fs.unlinkSync(LOCK_PATH); return '锁已清除' } catch (e) { return `清锁失败：${e.message}` }
}

// ── 孤儿判据（--if-orphan · 2026-09-26 · 与 sidecar 接管逻辑同源）──────
// 证据① 僵尸实锤：sidecar.log 最后一条 ready 之后有 bridge exit —— 客户端
//        已断（客户端关闭 → stdin EOF → bridge 退出），这只狗永远接不到人。
// 证据② 心跳兜底：日志/唤醒史/信号/计数器四件全部超过 --stale-ms 没动。
const LOG_PATH = path.join(STATE_DIR, 'sidecar.log')
const HISTORY_PATH = path.join(STATE_DIR, 'sidecar-wake-history.jsonl')
const SIGNAL_PATH = path.join(STATE_DIR, 'sidecar-wake-signal.json')
const COUNTER_PATH = path.join(STATE_DIR, 'sidecar-counter.json')
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
  } catch (e) { return '' }
}
function orphanVerdict() {
  const lines = readLogTail().split('\n').filter((line) => line.includes('[sidecar]'))
  let lastReady = -1
  lines.forEach((line, index) => { if (line.includes('ready server=')) lastReady = index })
  if (lastReady >= 0 && lines.slice(lastReady + 1).some((line) => line.includes('bridge exit code='))) {
    return { orphan: true, why: 'bridge exited after last ready — client-less zombie' }
  }
  const beats = [LOG_PATH, HISTORY_PATH, SIGNAL_PATH, COUNTER_PATH].map((file) => {
    try { return fs.statSync(file).mtimeMs } catch (e) { return 0 }
  })
  const newest = Math.max(...beats)
  if (newest > 0 && Date.now() - newest > STALE_MS) {
    return { orphan: true, why: `no heartbeat for ${Math.round((Date.now() - newest) / 60000)}min` }
  }
  return { orphan: false, why: 'lock holder alive with recent heartbeat' }
}

// ── 杀 ──────────────────────────────────────────────────────────────────
function slay(pid) {
  if (DRY_RUN) return { ok: true, why: '--dry-run：只演示，不执行' }
  try {
    process.kill(pid, 'SIGKILL')          // Windows 上等价 TerminateProcess
    return { ok: true, why: '已发出终止信号' }
  } catch (e) {
    if (e.code === 'ESRCH') return { ok: true, why: '进程已经不在了（无需处理）' }
    const tk = tryExec('taskkill', ['/PID', String(pid), '/F'])
    if (tk !== null) return { ok: true, why: 'process.kill 失败，taskkill 已接手' }
    return { ok: false, why: `杀不掉：${e.message}` }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function main() {
  say('── Alpha-Dog 安乐死 ─────────────────────────────')
  say(`包根   PKG_ROOT  = ${PKG_ROOT}`)
  say(`状态   STATE_DIR = ${STATE_DIR}`)
  say(`锁     LOCK_PATH = ${LOCK_PATH}`)
  say(`模式   ${DRY_RUN ? 'DRY-RUN（只看不动）' : '实杀'}${FORCE ? ' · FORCE' : ''}${ALL ? ' · ALL' : ''}`)
  say('')

  const targets = []

  if (ALL) {
    const dogs = listDogs()
    if (dogs === null) { warn('❌ 依赖缺失：无法枚举进程，--all 不可用。'); process.exit(2) }
    if (!dogs.length) { say('✅ 全机没有找到任何在岗的狗。'); dropLock(null); return }
    say(`找到 ${dogs.length} 只狗：${dogs.join(', ')}`)
    targets.push(...dogs)
  } else if (Number.isInteger(PID_ARG) && PID_ARG > 0) {
    targets.push(PID_ARG)
  } else {
    const lock = readLock()
    if (lock === null) { say('✅ 锁文件不存在 —— 狗不在岗，无需安乐死。'); return }
    const pid = Number(lock)
    if (!Number.isInteger(pid) || pid <= 0) {
      warn(`⚠️  锁内容非法（"${lock}"）—— 这是一条死锁，直接清除。`)
      say(dropLock(null))
      return
    }
    say(`锁归属 pid = ${pid}`)
    if (!alive(pid)) {
      say('✅ 该 pid 早已不在 —— 陈旧死锁，直接清除。')
      say(dropLock(pid))
      return
    }
    if (IF_ORPHAN) {
      const verdict = orphanVerdict()
      if (!verdict.orphan) {
        say(`🟢 锁主 pid=${pid} 不是孤儿（${verdict.why}）—— --if-orphan 模式不动它。`)
        return
      }
      say(`🔴 孤儿实锤：${verdict.why}`)
    }
    targets.push(pid)
  }

  let failed = 0
  for (const pid of targets) {
    say('')
    say(`→ 目标 pid=${pid}`)
    if (!alive(pid)) { say('   已经不在，跳过。'); continue }

    const judge = isDog(pid)
    if (!judge.ok) { warn(`   ⛔ 拒绝下手：${judge.why}`); failed++; continue }
    say(`   ✔ 校验通过：${judge.why}`)

    const r = slay(pid)
    if (!r.ok) { warn(`   ⛔ ${r.why}`); failed++; continue }
    say(`   ✔ ${r.why}`)
    say(`   ${dropLock(pid)}`)
  }

  say('')
  say(failed ? `⚠️  完成，但有 ${failed} 个目标被拒绝或失败（见上）。` : '✅ 狗已送走。下次客户端拉起时会自动抢锁上任。')
  if (failed) process.exit(1)
}

main()
