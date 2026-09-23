import { AlphaDogGovernance } from './alpha-dog-governance.js';
import { AlphaDogPower, AlphaDogCounter, AlphaDogWakeQueue } from './alpha-dog/runtime/index.js';
export declare class AlphaDogRuntime {
    setting: any;
    root: string;
    packageRoot: string;
    registry: any;
    invokeModel: (request: any) => Promise<any>;
    onWake: (wake: any) => void;
    power: AlphaDogPower;
    counter: AlphaDogCounter;
    wakeQueue: AlphaDogWakeQueue;
    wakeCount: number;
    lastWake: any;
    lastReport: any;
    tickQueue: Promise<any>;
    governance: AlphaDogGovernance;
    mappingSnapshot: any[];
    mappingError: string | null;
    /** 每个档口最近一次的筛选统计：筛到 0 条时必须留痕，不能静默空跑。 */
    targetStats: Record<string, any>;
    batches: any[];
    processedEvents: Set<string>;
    statePath: string;
    shadowAuditPath: string;
    persistent: boolean;
    initializationHandler: null | (() => unknown);
    preflightMemory: null | ((candidate: any) => Promise<any>);
    writeMemory: null | ((candidate: any, feedback: any) => Promise<any>);
    feedback: any[];
    /** 占位符引擎状态（第0轮初始化；存档后挪位；持久化） */
    placeholders: any;
    /** 对话源声明路径（黑箱：不读注册表，显式路径 + 常见位置探测） */
    conversationDir: string;
    /** 最近一次对话源读取结果（留痕用） */
    conversationState: any;
    constructor(options?: any);
    /** 第 0 轮初始化：占位符就位 + 首次对话源探测。返回初始化摘要。 */
    initRoundZero(): {
        placeholders: any;
        conversation: import("./alpha-dog/runtime/conversation-source.js").ConversationSourceResult;
    };
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
    tlsSelfCheck(): Promise<{
        ok: boolean;
        mitm: boolean;
        error: string | null;
        hint: string | null;
    }>;
    /** 读取对话源（黑箱探测）。失败返回留痕状态，不抛异常。 */
    readConversationSource(): import("./alpha-dog/runtime/conversation-source.js").ConversationSourceResult;
    on(): {
        initialization: unknown;
        watchdog: string;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    } | {
        watchdog: string;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    };
    /** 上电 + TLS 自检（Agent setup 检查项）。返回带 tlsCheck 的状态。 */
    onWithTlsCheck(): Promise<{
        tlsCheck: {
            ok: boolean;
            mitm: boolean;
            error: string | null;
            hint: string | null;
        };
        initialization: unknown;
        watchdog: string;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    } | {
        tlsCheck: {
            ok: boolean;
            mitm: boolean;
            error: string | null;
            hint: string | null;
        };
        watchdog: string;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    }>;
    off(): {
        watchdog: string;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    };
    /** 失败批次单独恢复：只重排 failed 批次，已完成批次原样保留（不重复处理）。 */
    recoverFailedBatches({ maxAttempts }?: any): string[];
    status(): {
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    };
    tick(context?: any): Promise<{
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
        skipped: boolean;
        reason: string;
    } | {
        skipped: boolean;
        wakes: any[];
        modelCalls: number;
        running: boolean;
        round: number;
        wakeCount: number;
        lastWake: any;
        governance: {
            circuit: string;
            failures: number;
            pending: {
                id: string;
                slot: number;
                round: number;
                reason: string;
                request: unknown;
                createdAt: string;
            }[];
            metrics: {
                attempts: number;
                successes: number;
                degraded: number;
                successRate: number;
            };
        };
        mappingError: string | null;
        targetStats: Record<string, any>;
        queued: number;
        mode: any;
    }>;
    loadTargets(): any;
    persist(): string | null;
}
/** 筛选明细：matched 为本档口命中项，unlabeled 为本次未命中项（用于「为什么空」的诊断）。 */
export declare function matchTargets(entries: any[], tags?: string[], query?: string): {
    matched: any[];
    unlabeled: any[];
};
export declare function selectTargets(entries: any[], query?: string, batchSize?: number): {
    id: any;
    path: any;
    layer: any;
    status: any;
    importance: any;
}[];
export declare function createModelAdapter(setting: any, transport?: any): {
    state: {
        configured: boolean;
        ready: boolean;
        lastError: null;
    };
    config: any;
    invoke(request: any): Promise<any>;
};
