export interface GovernanceOptions {
  failureThreshold?: number
  cooldownMs?: number
  maxPending?: number
  now?: () => number
}

export interface PendingWake {
  id: string
  slot: number
  round: number
  reason: string
  request: unknown
  createdAt: string
}

export class AlphaDogGovernance {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly maxPending: number
  private readonly now: () => number
  private failures = 0
  private openedAt = 0
  private attempts = 0
  private successes = 0
  private degraded = 0
  private readonly pending: PendingWake[] = []

  constructor(options: GovernanceOptions = {}) {
    this.failureThreshold = positiveInteger(options.failureThreshold, 3, 'failureThreshold')
    this.cooldownMs = positiveInteger(options.cooldownMs, 300_000, 'cooldownMs')
    this.maxPending = positiveInteger(options.maxPending, 100, 'maxPending')
    this.now = options.now ?? Date.now
  }

  validateWake(request: any): void {
    if (!Number.isInteger(request?.slot) || request.slot < 1) throw new TypeError('wake.slot 必须是正整数')
    if (!Array.isArray(request.actions) || request.actions.length === 0) throw new TypeError('wake.actions 必须是非空数组')
    if (!Array.isArray(request.targets)) throw new TypeError('wake.targets 必须是数组')
    for (const target of request.targets) {
      if (!target || typeof target.path !== 'string' || target.path.trim() === '') throw new TypeError('wake.target.path 必须是非空字符串')
    }
  }

  async invoke(request: any, invokeModel: (request: any) => Promise<any>, isCurrent: () => boolean = () => true): Promise<any> {
    this.validateWake(request)
    if (!isCurrent()) return { status: 'invalidated' }
    this.attempts += 1
    if (this.isOpen()) return isCurrent() ? this.defer(request, 'circuit-open') : { status: 'invalidated' }
    try {
      const result = await invokeModel(request)
      if (!isCurrent()) return { status: 'invalidated' }
      const status = result?.status
      // 只有明确 'ok' 才算成功。宿主会把 adapter 异常转成 finish 事件（不抛出），
      // 上层据此返回 'error'；若把非 ok 状态当成功，永久失败会被伪装成正常唤醒，
      // 熔断永远不触发。
      if (status && status !== 'ok') return this.defer(request, String(status))
      this.failures = 0
      this.openedAt = 0
      this.successes += 1
      return result
    } catch (error) {
      if (!isCurrent()) return { status: 'invalidated' }
      this.failures += 1
      if (this.failures >= this.failureThreshold) this.openedAt = this.now()
      return this.defer(request, error instanceof Error ? error.message : String(error))
    }
  }

  snapshot() {
    return {
      circuit: this.isOpen() ? 'open' : this.openedAt > 0 ? 'half-open' : 'closed',
      failures: this.failures,
      pending: this.pending.map((item) => ({ ...item })),
      metrics: {
        attempts: this.attempts,
        successes: this.successes,
        degraded: this.degraded,
        successRate: this.attempts === 0 ? 1 : this.successes / this.attempts,
      },
    }
  }

  drainPending(limit = this.maxPending): PendingWake[] {
    const count = Math.max(0, Math.min(this.pending.length, Math.trunc(limit)))
    return this.pending.splice(0, count)
  }

  private isOpen(): boolean {
    if (this.openedAt === 0) return false
    if (this.now() - this.openedAt < this.cooldownMs) return true
    this.openedAt = 0
    return false
  }

  private defer(request: any, reason: string) {
    this.degraded += 1
    const entry: PendingWake = {
      id: `${request.round}:${request.slot}:${this.now()}`,
      slot: request.slot,
      round: request.round,
      reason,
      request,
      createdAt: new Date(this.now()).toISOString(),
    }
    this.pending.push(entry)
    if (this.pending.length > this.maxPending) this.pending.splice(0, this.pending.length - this.maxPending)
    return { status: 'degraded', mode: 'mechanical', reason, pendingId: entry.id }
  }
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new RangeError(`${name} 必须是正整数`)
  return parsed
}
