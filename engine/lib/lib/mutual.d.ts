/** 对端守护进程的 Python 模块名（由调用方注入，无默认值）。 */
export declare const GUARDIAN_MODULE_ENV = "MDCG_GUARDIAN_MODULE";
/**
 * 读取对端守护模块名：空串表示**守护功能未启用**。
 * 内核不预置任何外部实现的模块名——未配置就不去猜，也不去拉起。
 */
export declare function guardianModule(): string;
export interface MutualOptions {
    /** 心跳间隔（毫秒），默认 10min */
    heartbeatMs: number;
    /** 失联告警阈值（毫秒），默认 25min */
    warnMs: number;
    /** 失联重启阈值（毫秒），默认 35min */
    deadMs: number;
    /** 任务中豁免倍数，默认 ×2 */
    workingFactor: number;
    /** 拉起冷却（毫秒），默认 60s */
    restartCooldownMs: number;
    /** 互维网络目录，默认 ~/.alpha-memory-net */
    netDir: string;
}
/** 互维网络目录定位 */
export declare function netDir(opts?: MutualOptions): string;
export declare function writeHeartbeat(opts?: MutualOptions, taskRunning?: boolean): void;
export declare function readHeartbeat(which: 'a' | 'web', opts?: MutualOptions): {
    ts: number;
    pid: number;
    task_running: boolean;
    ageMs: number;
} | null;
/** 失联分级判定（纯函数，A 侧 judge_stamp 的 B 侧镜像） */
export declare function judgeStamp(stamp: {
    ageMs: number;
    task_running: boolean;
} | null, opts?: MutualOptions): 'alive' | 'alive_working' | 'warning' | 'dead' | 'no_stamp';
/** 检测对端守护进程是否存在
 * P1 完善（GPT 审查·wmic 兼容）：wmic 在 Win11+ 已被移除——失败时
 * fallback PowerShell Get-CimInstance（Win）；非 Windows 用 ps 查询。
 * 未配置 `MDCG_GUARDIAN_MODULE` 时恒返回 false（功能未启用，不做任何探测）。 */
export declare function guardianRunning(): Promise<boolean>;
/** detached 拉起对端守护进程（幂等：先确认不存在；未配置模块名则 skipped） */
export declare function ensureGuardian(python?: string, opts?: MutualOptions): Promise<'started' | 'already' | 'failed' | 'skipped'>;
export interface VerifyTask {
    id: string;
    type: 'verify' | 'knowledge_sync';
    from: 'A' | 'B';
    to: 'B' | 'A';
    payload: {
        claim: string;
        evidence?: string;
        expected?: string;
        source_ref?: string;
    };
    status: 'pending' | 'processing' | 'done';
    created_at: number;
}
export interface VerifyResult {
    task_id: string;
    verdict: 'pass' | 'fail' | 'needs_revision';
    whitebox: {
        judgment: string;
        best: string;
        d_norm: number;
        record_id: string;
    };
    llm_review: {
        conclusion: string;
        reason: string;
    };
    reasons: string[];
    evidence: string[];
    verifier: 'B';
    at: number;
}
/** 扫描互维目录里 A→B 的 pending 任务 */
export declare function scanTasks(opts?: MutualOptions): VerifyTask[];
/** 白箱通道：智慧之书 base_verify（通过 bridge 调用，或本地注入） */
export declare function whiteboxVerify(claim: string, verifyFn: (c: string) => Promise<{
    judgment: string;
    best: string;
    d_norm: number;
    record_id: string;
}>): Promise<VerifyResult['whitebox']>;
/** 复核通道：DeepSeek 独立复核（在白箱判定之上） */
export declare function llmReview(claim: string, whitebox: VerifyResult['whitebox'], reviewFn: (c: string, w: VerifyResult['whitebox']) => Promise<{
    conclusion: string;
    reason: string;
}>): Promise<VerifyResult['llm_review']>;
/** 综合 verdict（白箱优先） */
export declare function combineVerdict(w: VerifyResult['whitebox'], l: VerifyResult['llm_review']): VerifyResult['verdict'];
export declare function safeTaskId(id: string): boolean;
/** 处理单个任务：双通道验证 → 写回 result */
export declare function processTask(task: VerifyTask, verifyFn: (c: string) => Promise<{
    judgment: string;
    best: string;
    d_norm: number;
    record_id: string;
}>, reviewFn: (c: string, w: VerifyResult['whitebox']) => Promise<{
    conclusion: string;
    reason: string;
}>, opts?: MutualOptions): Promise<VerifyResult | null>;
export declare function log(opts: MutualOptions, msg: string): void;
export declare function writeLastContact(opts?: MutualOptions): void;
export declare function installMutualMaintenance(ctx: {
    logger: {
        info(m: string): void;
    };
    effect(fn: () => () => void, name?: string): void;
}, config?: Partial<MutualOptions>, hooks?: {
    verify?: (c: string) => Promise<{
        judgment: string;
        best: string;
        d_norm: number;
        record_id: string;
    }>;
    review?: (c: string, w: VerifyResult['whitebox']) => Promise<{
        conclusion: string;
        reason: string;
    }>;
}): void;
