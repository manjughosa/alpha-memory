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
    constructor(options?: any);
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
