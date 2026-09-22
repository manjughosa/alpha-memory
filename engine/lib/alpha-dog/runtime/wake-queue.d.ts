export type WakePlan = {
    id: string;
    slot: any;
    round: number;
    batch: any;
    context: any;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};
export declare class AlphaDogWakeQueue {
    private queue;
    enqueue(plan: Omit<WakePlan, 'status'>): WakePlan;
    next(): WakePlan | null;
    complete(id: string, ok?: boolean): WakePlan | null;
    cancelPending(): void;
    /** 恢复最小单位：仅失败项可回到队列；已完成/运行中不动（防重复处理）。 */
    requeue(id: string): WakePlan | null;
    requeueFailed(): number;
    snapshot(): {
        id: string;
        slot: any;
        round: number;
        batch: any;
        context: any;
        status: "queued" | "running" | "completed" | "failed" | "cancelled";
    }[];
}
