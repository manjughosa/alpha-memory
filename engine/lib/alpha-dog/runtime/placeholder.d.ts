export type PlaceholderMode = 'backfill' | 'monitor' | 'interrupt' | 'fixed_defer';
export type SlotPlaceholder = {
    slot: number;
    /** 占位符指向的对话位置（user 轮序号；0 = 起点） */
    anchorRound: number;
    /** 占位符写入时间 */
    createdAt: string;
    /** 最近一次评估的结论 */
    lastEval?: {
        at: string;
        /** 话题是否在 anchorRound 之后已结束 */
        topicClosed: boolean;
        /** 若已结束，结束于哪个 user 轮 */
        closedAtRound: number;
        mode: PlaceholderMode;
        note?: string;
    };
};
export type PlaceholderState = {
    initialized: boolean;
    initializedAt: string;
    slots: Record<number, SlotPlaceholder>;
};
export declare function initPlaceholders(now?: string): PlaceholderState;
/**
 * 评估某个档口的当前状态，选择执行模式。
 *
 * @param userTurns 从会话源解析出的 user 轮序列（旧 -> 新）
 * @param placeholder 该档口的占位符
 * @param currentRound 当前触发轮
 * @param allowedModes 该档口允许的模式（决定能选哪些）
 * @returns 选择的模式 + 话题边界信息
 */
export declare function evaluatePlaceholder(userTurns: {
    roundHint?: number;
    text: string;
}[], placeholder: SlotPlaceholder | undefined, currentRound: number, allowedModes: string[], now?: string): {
    mode: PlaceholderMode;
    topicClosed: boolean;
    closedAtRound: number;
    windowText: string;
    note?: string;
};
/** 存档后挪占位符：anchorRound 移到话题结束轮。 */
export declare function movePlaceholder(state: PlaceholderState, slot: number, newAnchor: number, now?: string): PlaceholderState;
/**
 * 长窗口双段保留：超限时保留开头（话题起点）+ 结尾（最新状态/结论），
 * 中间显式标注「…中段省略…」。结题存档最需要最近进展，不能只留开头。
 * 上限内原样返回，不标注。
 */
export declare function smartWindow(text: string, limit?: number): string;
