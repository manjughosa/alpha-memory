// 占位符引擎（黑箱 · 无状态持久化于 runtime 状态）
//
// 核心机制（zyq 2026-09-23 设计）：
//   - 第 0 轮敲醒时初始化三档占位符，全部指向「起点」（round 0 / 文件头）
//   - 每档到期（15/21/30）时，狗翻自己的占位符 → 读「占位符位置 → 现在」的对话
//   - 判断话题是否结束：
//       · 结束 → 结题存档，占位符挪到当前轮
//       · 未结束 → 方案3：结上一个已结束话题（占位符挪到那个话题的结束轮）
//                 方案4：继续监听几轮，直到话题结束（占位符不动）
//   - 30 轮可选 interrupt（打断）/ fixed_defer（延后5轮提醒）
//
// 模式（与说明书 allowedModes 一一对应）：
//   backfill     = 方案3：结上一个已结束话题（三档通用）
//   monitor      = 方案4：话题未结束则继续监听（三档通用）
//   interrupt    = 仅 30 轮：高风险/关键缺口立即处理
//   fixed_defer  = 仅 30 轮：条件未满足但复核时间明确，延后 5 轮提醒

export type PlaceholderMode = 'backfill' | 'monitor' | 'interrupt' | 'fixed_defer'

export type SlotPlaceholder = {
  slot: number
  /** 占位符指向的对话位置（user 轮序号；0 = 起点） */
  anchorRound: number
  /** 占位符写入时间 */
  createdAt: string
  /** 最近一次评估的结论 */
  lastEval?: {
    at: string
    /** 话题是否在 anchorRound 之后已结束 */
    topicClosed: boolean
    /** 若已结束，结束于哪个 user 轮 */
    closedAtRound: number
    mode: PlaceholderMode
    note?: string
  }
}

export type PlaceholderState = {
  initialized: boolean
  initializedAt: string
  slots: Record<number, SlotPlaceholder>
}

export function initPlaceholders(now = new Date().toISOString()): PlaceholderState {
  return {
    initialized: true,
    initializedAt: now,
    slots: {
      15: { slot: 15, anchorRound: 0, createdAt: now },
      21: { slot: 21, anchorRound: 0, createdAt: now },
      30: { slot: 30, anchorRound: 0, createdAt: now },
    },
  }
}

/**
 * 评估某个档口的当前状态，选择执行模式。
 *
 * @param userTurns 从会话源解析出的 user 轮序列（旧 -> 新）
 * @param placeholder 该档口的占位符
 * @param currentRound 当前触发轮
 * @param allowedModes 该档口允许的模式（决定能选哪些）
 * @returns 选择的模式 + 话题边界信息
 */
export function evaluatePlaceholder(
  userTurns: { roundHint?: number; text: string }[],
  placeholder: SlotPlaceholder | undefined,
  currentRound: number,
  allowedModes: string[],
  now = new Date().toISOString(),
): { mode: PlaceholderMode; topicClosed: boolean; closedAtRound: number; windowText: string; note?: string } {
  const anchor = placeholder?.anchorRound ?? 0
  // 该档口窗口内的 user 轮
  const windowTurns = userTurns.filter((turn) => (turn.roundHint ?? 0) > anchor)
  // 窗口文本：长话题不从头截断（那样会丢掉结尾的最新状态/结论）。
  // 采用「开头 + 结尾」双段保留：前段保话题起点，后段保最近进展，中间显式标注截断。
  const fullWindow = windowTurns.map((turn) => turn.text).join('\n')
  const windowText = smartWindow(fullWindow, 8000)
  const recent = windowTurns.slice(-6)

  // 话题结束启发式（机械层只提供证据，最终判断在狗）：
  //   ① 窗口内没有任何新 user 轮 → 无新话题，无内容可结
  //   ② 最近几轮里存在「新主题引入」信号（如用户转向、长度骤变）→ 视为话题已结束于最近边界
  const noNewTurns = windowTurns.length === 0
  const abruptShift = recent.length >= 2 && detectTopicShift(recent)

  if (noNewTurns) {
    return { mode: 'monitor', topicClosed: false, closedAtRound: anchor, windowText: '', note: '占位符窗口内无新对话，继续监听' }
  }

  // 话题已结束 → 优先 backfill（结题存档）
  if (abruptShift) {
    const closedAt = windowTurns[windowTurns.length - 1].roundHint ?? currentRound
    const mode = allowedModes.includes('backfill') ? 'backfill' : 'monitor'
    return { mode, topicClosed: true, closedAtRound: closedAt, windowText, note: '检测到话题边界，结题存档' }
  }

  // 话题未结束：30 轮可选 interrupt / fixed_defer；三档通用回退 monitor（继续监听）
  if (allowedModes.includes('interrupt') && windowTurns.length >= 30) {
    return { mode: 'interrupt', topicClosed: false, closedAtRound: anchor, windowText, note: '长话题未收尾，30 轮打断评估' }
  }
  if (allowedModes.includes('fixed_defer') && windowTurns.length >= 25) {
    return { mode: 'fixed_defer', topicClosed: false, closedAtRound: anchor, windowText, note: '条件未满足，延后 5 轮提醒' }
  }
  return { mode: 'monitor', topicClosed: false, closedAtRound: anchor, windowText, note: '话题进行中，继续监听' }
}

/** 简单话题边界启发：最后两轮的长度/主题突变。机械证据，最终判断在狗。 */
function detectTopicShift(recent: { text: string }[]): boolean {
  if (recent.length < 2) return false
  const last = recent[recent.length - 1].text
  const prev = recent[recent.length - 2].text
  if (!last || !prev) return false
  const lenRatio = last.length / Math.max(1, prev.length)
  // 长度突变（>3x 或 <1/3）视为话题切换信号；最终判断仍由狗在 prompt 中确认。
  return lenRatio > 3 || lenRatio < 0.33
}

/** 存档后挪占位符：anchorRound 移到话题结束轮。 */
export function movePlaceholder(state: PlaceholderState, slot: number, newAnchor: number, now = new Date().toISOString()): PlaceholderState {
  const entry = state.slots[slot]
  if (!entry) return state
  entry.anchorRound = Math.max(0, Math.trunc(newAnchor))
  entry.createdAt = now
  delete entry.lastEval
  return state
}

/**
 * 长窗口双段保留：超限时保留开头（话题起点）+ 结尾（最新状态/结论），
 * 中间显式标注「…中段省略…」。结题存档最需要最近进展，不能只留开头。
 * 上限内原样返回，不标注。
 */
export function smartWindow(text: string, limit = 8000): string {
  if (text.length <= limit) return text
  const headLen = Math.floor(limit * 0.5)
  const tailLen = limit - headLen
  const marker = `\n…[中段省略 ${text.length - headLen - tailLen} 字符]…\n`
  return text.slice(0, headLen) + marker + text.slice(-tailLen)
}
