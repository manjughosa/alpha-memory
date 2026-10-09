import { join } from 'node:path'
import { AlphaDogGovernance } from './alpha-dog-governance.js'
import { memoryPropose, runFeedbackLoop } from './alpha-dog/feedback.js'
import { appendShadowAudit, compareShadow } from './alpha-dog/modes.js'
import { AlphaDogPower, AlphaDogCounter, AlphaDogWakeQueue, createBatches, dueSlots, invokeWatchdog, loadRuntimeState, loadWatchdogPrompt, readRegistry, saveRuntimeState, evaluatePlaceholder, initPlaceholders, movePlaceholder, readConversation } from './alpha-dog/runtime/index.js'

export class AlphaDogRuntime {
  setting: any
  root: string
  packageRoot: string
  registry: any
  invokeModel: (request: any) => Promise<any>
  onWake: (wake: any) => void
  power = new AlphaDogPower()
  counter: AlphaDogCounter
  wakeQueue = new AlphaDogWakeQueue()
  wakeCount = 0
  lastWake: any = null
  lastReport: any = { kind: 'report' }
  tickQueue: Promise<any> = Promise.resolve()
  governance: AlphaDogGovernance
  mappingSnapshot: any[] = []
  mappingError: string | null = null
  /** 每个档口最近一次的筛选统计：筛到 0 条时必须留痕，不能静默空跑。 */
  targetStats: Record<string, any> = {}
  batches: any[] = []
  processedEvents = new Set<string>()
  statePath: string
  shadowAuditPath: string
  persistent: boolean
  initializationHandler: null | (() => unknown)
  preflightMemory: null | ((candidate: any) => Promise<any>)
  writeMemory: null | ((candidate: any, feedback: any) => Promise<any>)
  feedback: any[] = []
  /** 占位符引擎状态（第0轮初始化；存档后挪位；持久化） */
  placeholders: any = { initialized: false, initializedAt: '', slots: {} }
  /** 对话源声明路径（黑箱：不读注册表，显式路径 + 常见位置探测） */
  conversationDir: string = ''
  /** 最近一次对话源读取结果（留痕用） */
  conversationState: any = null

  constructor(options: any = {}) {
    this.setting = options.setting
    this.root = options.root || process.cwd()
    this.packageRoot = options.packageRoot || this.root
    this.registry = options.registry || null
    this.invokeModel = options.invokeModel || (async () => ({ status: 'model-disabled' }))
    this.onWake = options.onWake || (() => {})
    this.governance = options.governance || new AlphaDogGovernance(options.governanceOptions || this.setting?.governance)
    this.statePath = join(this.packageRoot, this.setting?.state?.directory || 'state', 'runtime.json')
    this.shadowAuditPath = join(this.packageRoot, this.setting?.state?.directory || 'state', 'shadow-comparisons.json')
    this.persistent = Boolean(options.packageRoot || options.statePath)
    if (options.statePath) this.statePath = options.statePath
    const restored = this.persistent ? loadRuntimeState(this.statePath, { round: 0, wakeCount: 0, batches: [], processedEvents: [], wakeQueue: [] }) : { round: 0, wakeCount: 0, batches: [], processedEvents: [], wakeQueue: [] }
    this.counter = new AlphaDogCounter(restored.round)
    this.wakeCount = restored.wakeCount
    this.batches = Array.isArray(restored.batches) ? restored.batches : []
    this.processedEvents = new Set(Array.isArray(restored.processedEvents) ? restored.processedEvents : [])
    this.feedback = Array.isArray(restored.feedback) ? restored.feedback : []
    this.targetStats = restored.targetStats && typeof restored.targetStats === 'object' ? restored.targetStats : {}
    this.wakeQueue = new AlphaDogWakeQueue()
    for (const plan of Array.isArray(restored.wakeQueue) ? restored.wakeQueue : []) {
      // 重启后没有在跑的执行者：running 一律回落为 queued（失败项保持 failed，
      // 等待 recoverFailedBatches 显式重试；completed/cancelled 原样保留防重复）。
      if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string') continue
      const status = plan.status === 'running' ? 'queued' : plan.status
      if (!['queued', 'completed', 'failed', 'cancelled'].includes(status)) continue
      this.wakeQueue.enqueue({ id: plan.id, slot: plan.slot, round: plan.round, batch: plan.batch, context: plan.context, status })
    }
    this.initializationHandler = options.initializationHandler || null
    this.preflightMemory = options.preflightMemory || null
    this.writeMemory = options.writeMemory || null
    this.conversationDir = String(options.conversationDir || this.setting?.conversation?.dir || this.setting?.conversationSource?.path || '')
    // 占位符：优先恢复持久化状态；首次启动（无状态）时初始化三档（第 0 轮敲醒语义）。
    if (restored.placeholders && restored.placeholders.initialized === true) {
      this.placeholders = restored.placeholders
    } else {
      this.placeholders = initPlaceholders()
    }
  }

  /** 第 0 轮初始化：占位符就位 + 首次对话源探测。返回初始化摘要。 */
  initRoundZero() {
    if (!this.placeholders?.initialized) this.placeholders = initPlaceholders()
    const source = this.readConversationSource()
    this.persist()
    return { placeholders: this.placeholders, conversation: source }
  }

  /**
   * TLS 中间人自检（Agent setup 初始化检查项之一，zyq 2026-09-23 豁免放行）。
   *
   * 背景：本机网络出口可能被杀软/代理做 HTTPS 中间人（自签根替换真实证书链），
   * 导致模型调用偶发 SELF_SIGNED_CERT_IN_CHAIN。这不是 Alpha-Memory 的缺陷，
   * 是宿主网络环境——发行版不应预装任何一台机器的证书（绑机器 = 平台依赖）。
   * 正确做法：初始化时检测，检测到就提示「当前 Agent 自己安装自己的根证书」。
   *
   * 检测方法：不带任何自定义 CA（process.env.NODE_EXTRA_CA_CERTS 视为外部配置，
   * 本检查故意排除它，以探测「裸环境」是否被中间人）直连模型 baseUrl，
   * 看 TLS 校验是否失败 + 失败原因是否为自签链。
   *
   * @returns { ok, mitm, error?, hint? }
   *   ok=true   裸环境可直通（无中间人，或网络正常）
   *   ok=false + mitm=true  检测到 TLS 中间人 → 返回证书安装指引
   *   ok=false + mitm=false 其他网络错误（DNS/超时等），不误导用户装证书
   */
  async tlsSelfCheck() {
    const baseUrl = String(this.setting?.model?.baseUrl || '').replace(/\/$/, '')
    if (!baseUrl) return { ok: true, mitm: false, error: null, hint: null }
    const saved = process.env.NODE_EXTRA_CA_CERTS
    delete process.env.NODE_EXTRA_CA_CERTS
    let result: { ok: boolean; mitm: boolean; error: string | null; hint: string | null }
    try {
      const response = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(15000) })
      result = { ok: true, mitm: false, error: null, hint: null }
      void response
    } catch (error: any) {
      const msg = String(error?.cause?.code || error?.cause?.message || error?.message || '')
      const certChain = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|DEPTH_ZERO_SELF_SIGNED_CERT/.test(msg)
      if (certChain) {
        result = {
          ok: false,
          mitm: true,
          error: msg,
          hint: '检测到 TLS 中间人（网络出口的杀软/代理在做 HTTPS 扫描）。' +
            '请当前 Agent 完成证书安装（初始化必做项）：1) 找到你的杀软/代理的根证书；' +
            '2) 导出为 PEM；3) 在 mcp.json 的 alpha-memory env 里配置 NODE_EXTRA_CA_CERTS=<该 PEM 路径>；' +
            '4) 重启 MCP。这是宿主网络环境，Alpha-Memory 不代装任何机器的证书。',
        }
      } else {
        result = { ok: false, mitm: false, error: msg, hint: null }
      }
    } finally {
      if (saved) process.env.NODE_EXTRA_CA_CERTS = saved
    }
    return result
  }

  /** 读取对话源（黑箱探测）。失败返回留痕状态，不抛异常。 */
  readConversationSource() {
    // 对话源是 Agent setup 显式配置的外部交互窗口：未配置时绝不静默探测
    // （避免误读本机任意 jsonl 劫持轮次），一律退回计数器语义。
    if (!this.conversationDir || !String(this.conversationDir).trim()) {
      this.conversationState = { ok: false, error: 'conversation.dir not configured (Agent setup)', userTurns: 0, totalTurns: 0, at: new Date().toISOString() }
      return { ok: false, error: 'conversation.dir not configured', turns: [], userTurns: [], mtimeMs: 0 }
    }
    const result = readConversation(this.conversationDir)
    this.conversationState = {
      ok: result.ok,
      error: result.error || null,
      file: result.file || null,
      userTurns: result.userTurns.length,
      totalTurns: result.turns.length,
      mtimeMs: result.mtimeMs,
      at: new Date().toISOString(),
    }
    return result
  }

  on() {
    if (this.setting?.initialization?.status === 'declined') return { ...this.status(), initialization: 'declined', watchdog: 'dormant' }
    if (this.setting?.initialization?.status !== 'configured' && this.initializationHandler) return { ...this.status(), initialization: this.initializationHandler(), watchdog: 'dormant' }
    this.power.on()
    this.persist()
    return { ...this.status(), watchdog: 'dormant' }
  }

  /** 上电 + TLS 自检（Agent setup 检查项）。返回带 tlsCheck 的状态。 */
  async onWithTlsCheck() {
    const tlsCheck = await this.tlsSelfCheck()
    const base = this.on()
    return { ...base, tlsCheck }
  }

  off() {
    this.power.off()
    this.wakeQueue.cancelPending()
    this.persist()
    return { ...this.status(), watchdog: 'dormant' }
  }

  /** 失败批次单独恢复：只重排 failed 批次，已完成批次原样保留（不重复处理）。 */
  recoverFailedBatches({ maxAttempts = 2 }: any = {}) {
    const retried: string[] = []
    const failedItems = this.wakeQueue.snapshot().filter((item: any) => item.status === 'failed')
    for (const item of failedItems) {
      const batch = this.batches.find((b: any) => b.batchId === item?.batch?.batchId)
      if (!batch || batch.status !== 'failed') continue
      const attempts = Number(batch.attempts || 0)
      if (attempts >= maxAttempts) continue
      batch.attempts = attempts + 1
      batch.status = 'pending'
      batch.failed = 0
      if (this.wakeQueue.requeue(item.id)) retried.push(batch.batchId)
    }
    if (retried.length) this.persist()
    return retried
  }

  status() {
    return { running: this.power.snapshot().running, round: this.counter.current(), wakeCount: this.wakeCount, lastWake: this.lastWake, governance: this.governance.snapshot(), mappingError: this.mappingError, targetStats: this.targetStats, queued: this.wakeQueue.snapshot().filter((item) => item.status === 'queued').length, mode: this.setting?.state?.mode || 'legacy' }
  }

  async tick(context: any = {}) {
    const run = async () => {
      if (!this.power.snapshot().running) return { skipped: true, reason: 'off', ...this.status() }
      const eventId = String(context.eventId || context.event?.id || '')
      if (eventId && this.processedEvents.has(eventId)) return { skipped: true, reason: 'duplicate-event', ...this.status() }
      const generation = this.power.snapshot().generation
      // 自驱敲醒（zyq 2026-09-23）：轮次以「真实对话轮」为准 = 对话源里 user 消息的数量。
      // 第 N 条用户消息一写入 jsonl，N % interval === 0 就立即触发档口，不多等一轮。
      // 对话源不可用时退回：外部传的 round → 内部计数器。
      const source = this.readConversationSource()
      const userTurns = source.ok ? source.userTurns : []
      const conversationRound = source.ok && userTurns.length > 0 ? userTurns.length : 0
      const suppliedRound = Number(context.round)
      let round: number
      if (conversationRound > 0) {
        // 对话源是权威：真实对话轮就是 N。counter 只是历史工具计数，
        // 落后或领先都不许吞掉对话源轮次（否则对话 15 轮会被旧 counter 17 吞掉）。
        round = this.counter.restore(conversationRound)
      } else if (Number.isInteger(suppliedRound) && suppliedRound > this.counter.current()) {
        round = this.counter.restore(suppliedRound)
      } else {
        round = this.counter.tick()
      }
      if (eventId) this.processedEvents.add(eventId)
      const slots = dueSlots(round, this.setting.schedule)
      const hasQueued = this.wakeQueue.snapshot().some((item: any) => item.status === 'queued')
      if (slots.length === 0 && !hasQueued) { this.persist(); return { ...this.status(), skipped: false, wakes: [], modelCalls: 0 } }

      const entries = this.loadTargets()
      for (const slot of slots) {
        const { matched: targets, unlabeled } = matchTargets(entries, slot.registryTags, context.query)
        const batches = createBatches(slot, round, targets, this.setting.batchSize, Number(slot.tokenBudget || this.setting.tokenBudget || 0))
        this.batches.push(...batches)
        // 占位符评估：选模式 + 话题边界 + 窗口原文（狗做最终判断的原料）。
        const ph = this.placeholders?.slots?.[slot.interval]
        const evalResult = evaluatePlaceholder(userTurns, ph, round, slot.allowedModes)
        if (this.placeholders?.slots?.[slot.interval]) {
          this.placeholders.slots[slot.interval].lastEval = { at: new Date().toISOString(), topicClosed: evalResult.topicClosed, closedAtRound: evalResult.closedAtRound, mode: evalResult.mode, note: evalResult.note }
        }
        // 筛选结果必须留痕：档口筛出 0 条时状态里要看得见，否则看门狗
        // 会「按时醒、加载说明书、空跑」而不留任何痕迹。
        this.targetStats[slot.id] = {
          round,
          tags: Array.isArray(slot.registryTags) ? [...slot.registryTags] : [],
          total: entries.length,
          matched: targets.length,
          unlabeled: unlabeled.length,
          unlabeledIds: unlabeled.slice(0, 20).map((entry: any) => String(entry.id ?? entry.path)),
        }
        // 注入占位符评估 + 对话窗口到 wake 上下文，让狗有真实原料可判断。
        const wakeContext = {
          ...context,
          mode: evalResult.mode,
          topicClosed: evalResult.topicClosed,
          closedAtRound: evalResult.closedAtRound,
          windowText: evalResult.windowText,
          conversationSource: source.ok ? source.file : null,
          conversationError: source.ok ? null : (source.error || 'unknown'),
        }
        for (const batch of batches.length ? batches : [createEmptyBatch(slot, round)]) {
          this.wakeQueue.enqueue({ id: `${slot.id}:${round}:${batch.batchId}`, slot, round, batch, context: wakeContext })
        }
      }

      const wakes: any[] = []
      let plan = this.wakeQueue.next()
      while (plan) {
        if (!this.power.isCurrent(generation)) return { skipped: true, reason: 'off', ...this.status() }
        const prompt = loadWatchdogPrompt(this.packageRoot, plan.slot.prompt)
        const wakeRound = Number.isInteger(plan.round) ? plan.round : round
        const wake: any = { slot: plan.slot.interval, slotId: plan.slot.id, round: wakeRound, actions: [...plan.slot.allowedModes], batch: plan.batch, targets: plan.batch.entries, prompt: prompt.path, modelCalled: true }
        const request = { slot: plan.slot.interval, round: wakeRound, actions: wake.actions, targets: wake.targets, prompt: prompt.text, context: plan.context, batch: plan.batch }
        wake.model = await this.governance.invoke(request, (payload) => invokeWatchdog(this.invokeModel, payload), () => this.power.isCurrent(generation))
        if (!this.power.isCurrent(generation) || wake.model?.status === 'invalidated') return { skipped: true, reason: 'off', ...this.status() }
        wake.degraded = wake.model?.status === 'degraded'
        if (!wake.degraded && this.preflightMemory && this.writeMemory && context.formalWrites === true) {
          const proposals = extractCandidates(wake.model, plan)
          wake.feedback = []
          for (const proposal of proposals) {
            const result = await runFeedbackLoop({ candidate: proposal, preflight: this.preflightMemory, write: this.writeMemory })
            wake.feedback.push(result)
            this.feedback.push(result)
          }
        } else if (!wake.degraded && context.formalWrites !== true) {
          wake.feedback = extractCandidates(wake.model, plan).map((candidate) => ({ status: 'shadow', candidate }))
          this.feedback.push(...wake.feedback)
        }
        const feedbackFailed = (wake.feedback || []).some((item: any) => item.status === 'failed')
        plan.batch.status = wake.degraded || feedbackFailed ? 'failed' : 'completed'
        plan.batch.processed = plan.batch.status === 'completed' ? plan.batch.entries.length : 0
        plan.batch.failed = plan.batch.status === 'failed' ? Math.max(1, plan.batch.entries.length) : 0
        this.wakeQueue.complete(plan.id, !wake.degraded)
        this.wakeCount += 1
        this.lastWake = wake
        this.onWake(wake)
        wakes.push(wake)
        // 占位符挪位：本档 wake 成功（结题存档完成）→ 占位符挪到话题结束轮；
        // monitor（继续监听）/失败 → 占位符不动，下次继续从同一锚点评估。
        if (!wake.degraded && !feedbackFailed && plan.context?.topicClosed === true) {
          const closedAt = Number.isFinite(Number(plan.context?.closedAtRound)) ? Number(plan.context.closedAtRound) : wakeRound
          this.placeholders = movePlaceholder(this.placeholders, plan.slot.interval, closedAt)
        }
        this.persist()
        plan = this.wakeQueue.next()
      }
      const reportPrompt = loadWatchdogPrompt(this.packageRoot, 'alpha-dog-batch-report')
      this.lastReport = { kind: 'report', round, prompt: reportPrompt.path, summary: { wakes: wakes.length, completed: wakes.filter((wake) => !wake.degraded).length, degraded: wakes.filter((wake) => wake.degraded).length, batches: wakes.map((wake) => wake.batch?.batchId).filter(Boolean) }, wakes }
      if (this.setting?.state?.mode === 'shadow' && context.legacyResult) {
        const alphaDogResult = { round, candidates: wakes.flatMap((wake) => wake.feedback || []), slots: wakes.map((wake) => wake.slotId), feedback: wakes.flatMap((wake) => wake.feedback || []) }
        const comparison = compareShadow(round, context.legacyResult, alphaDogResult)
        if (this.persistent) appendShadowAudit(this.shadowAuditPath, comparison)
        this.lastReport.shadowComparison = comparison
      }
      this.persist()
      return { ...this.status(), skipped: false, wakes, modelCalls: wakes.length }
    }
    const next = this.tickQueue.then(run, run)
    this.tickQueue = next.catch(() => undefined)
    return next
  }

  loadTargets() {
    const result = readRegistry(this.setting, this.registry, this.root, this.mappingSnapshot)
    this.mappingSnapshot = result.entries
    this.mappingError = result.error
    return result.entries
  }

  persist() {
    if (!this.persistent) return null
    return saveRuntimeState(this.statePath, { version: 'alpha-dog/1', running: this.power.snapshot().running, round: this.counter.current(), wakeCount: this.wakeCount, batches: this.batches, feedback: this.feedback.slice(-1000), wakeQueue: this.wakeQueue.snapshot(), processedEvents: [...this.processedEvents].slice(-1000), lastWake: this.lastWake, lastReport: this.lastReport, targetStats: this.targetStats, mappingError: this.mappingError, governance: this.governance.snapshot(), placeholders: this.placeholders, conversationState: this.conversationState, savedAt: new Date().toISOString() })
  }
}

function extractCandidates(model: any, plan: any) {
  const raw = model?.candidates || model?.result?.candidates || []
  if (!Array.isArray(raw)) return []
  return raw.map((item: any, index: number) => memoryPropose({
    id: item.id || `${plan.batch.batchId}-candidate-${index + 1}`,
    content: String(item.content || ''),
    sources: Array.isArray(item.sources) ? item.sources : plan.batch.fileIds,
    slot: plan.slot.id,
    batchId: plan.batch.batchId,
  })).filter((item: any) => item.content)
}

// 档口标签是「域·N轮」复合形态（例如 人格核心·30轮 / 哲学·21轮），而档口配置用的是
// 统一标签（即时落盘·15轮 / 系统巡检·21轮 / 记忆巡检·30轮）。真实记忆映射表里
// tags 字段为空，域归属写在 layer：只做精确匹配会把三个档口全部筛成 0 条，
// 看门狗按时醒、加载说明书、然后空跑且不留痕。
//
// 因此匹配规则为「精确优先，后缀兜底」：
//   1. 先按档口标签精确匹配 tags / registryTags / layer（保留原有语义）；
//   2. 若档口标签带 `·N轮` 后缀，则再按同后缀匹配 —— 由各记忆域自己声明巡检节奏。
// 未配置 registryTags 时仍然匹配全部（原有行为不变）。
const SLOT_TAG_SUFFIX = /·\s*\d+\s*轮\s*$/

function slotTagMatchers(tags: string[] = []) {
  const exact = new Set<string>()
  const suffixes = new Set<string>()
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag ?? '').trim()
    if (!value) continue
    exact.add(value)
    const match = value.match(SLOT_TAG_SUFFIX)
    if (match) suffixes.add(match[0].replace(/\s+/g, ''))
  }
  return { exact, suffixes }
}

function entryTagValues(entry: any): string[] {
  const values: string[] = []
  for (const field of [entry?.tags, entry?.registryTags]) {
    if (Array.isArray(field)) for (const value of field) if (value !== undefined && value !== null && String(value).trim() !== '') values.push(String(value).trim())
  }
  if (entry?.layer !== undefined && entry?.layer !== null && String(entry.layer).trim() !== '') values.push(String(entry.layer).trim())
  return values
}

function matchesSlotTags(entry: any, matchers: { exact: Set<string>; suffixes: Set<string> }, tagCount: number) {
  if (tagCount === 0) return true
  const values = entryTagValues(entry)
  if (values.some((value) => matchers.exact.has(value))) return true
  if (matchers.suffixes.size === 0) return false
  return values.some((value) => {
    const normalized = value.replace(/\s+/g, '')
    for (const suffix of matchers.suffixes) if (normalized.endsWith(suffix)) return true
    return false
  })
}

function filterTargets(entries: any[], tags: string[] = [], query = '') {
  const needle = String(query || '').trim().toLowerCase()
  const matchers = slotTagMatchers(tags)
  const tagCount = Array.isArray(tags) ? tags.length : 0
  return entries.filter((entry) => {
    const tagMatch = matchesSlotTags(entry, matchers, tagCount)
    const queryMatch = !needle || [entry.path, entry.firstLine, entry.layer, ...(entry.keywords || [])].join(' ').toLowerCase().includes(needle)
    return tagMatch && queryMatch
  })
}

/** 筛选明细：matched 为本档口命中项，unlabeled 为本次未命中项（用于「为什么空」的诊断）。 */
export function matchTargets(entries: any[], tags: string[] = [], query = '') {
  const matched = filterTargets(entries, tags, query)
  const matchedKeys = new Set(matched.map((entry: any) => String(entry?.id ?? entry?.path)))
  const unlabeled = entries.filter((entry: any) => !matchedKeys.has(String(entry?.id ?? entry?.path)))
  return { matched, unlabeled }
}

function createEmptyBatch(slot: any, round: number) { return { batchId: `${slot.id}-${round}-01`, slot: slot.id, fileIds: [], entries: [], status: 'pending', processed: 0, failed: 0, nextBatch: null } }

export function selectTargets(entries: any[], query = '', batchSize = 8) { return filterTargets(entries, [], query).slice(0, batchSize).map((entry) => ({ id: entry.id, path: entry.path, layer: entry.layer, status: entry.status, importance: entry.importance })) }
export function createModelAdapter(setting: any, transport: any = {}) { const model = setting.model || {}; const configured = Boolean((model.provider && model.name) || (model.name && model.api)); return { state: { configured, ready: false, lastError: null }, config: { ...model, apiKeyRef: model.apiKeyRef || '' }, async invoke(request: any) { if (!this.state.configured) return { status: 'not-configured', request }; if (typeof transport.invoke !== 'function') return { status: 'adapter-skeleton', request }; return transport.invoke(request, this.config) } } }
