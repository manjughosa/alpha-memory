export declare function createBatches(slot: any, round: number, entries: any[], batchSize: number, tokenBudget?: number): {
    batchId: string;
    slot: any;
    fileIds: string[];
    entries: any[];
    estimatedTokens: any;
    status: string;
    processed: number;
    failed: number;
    nextBatch: string | null;
}[];
