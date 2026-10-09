export interface GovernanceOptions {
    failureThreshold?: number;
    cooldownMs?: number;
    maxPending?: number;
    now?: () => number;
}
export interface PendingWake {
    id: string;
    slot: number;
    round: number;
    reason: string;
    request: unknown;
    createdAt: string;
}
export declare class AlphaDogGovernance {
    private readonly failureThreshold;
    private readonly cooldownMs;
    private readonly maxPending;
    private readonly now;
    private failures;
    private openedAt;
    private attempts;
    private successes;
    private degraded;
    private readonly pending;
    constructor(options?: GovernanceOptions);
    validateWake(request: any): void;
    invoke(request: any, invokeModel: (request: any) => Promise<any>, isCurrent?: () => boolean): Promise<any>;
    snapshot(): {
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
    drainPending(limit?: number): PendingWake[];
    private isOpen;
    private defer;
}
