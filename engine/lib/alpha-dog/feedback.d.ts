export declare const FEEDBACK: readonly ["ACCEPT", "MERGE", "DROP", "DEFER", "CONFLICT"];
export type FeedbackVerdict = (typeof FEEDBACK)[number];
export type MemoryCandidate = {
    id: string;
    content: unknown;
    sources: string[];
    slot: string;
    batchId: string;
    revision: number;
};
export type AlphaFeedback = {
    candidateId: string;
    verdict: FeedbackVerdict;
    reason: string;
    mergeTarget?: string;
    retryAfter?: string;
    conflicts?: string[];
};
export type WriteReceipt = {
    committed: boolean;
    nodeIds: string[];
    auditReceipt: string;
    candidateId: string;
};
export declare function memoryPropose(input: Omit<MemoryCandidate, 'revision'> & {
    revision?: number;
}): MemoryCandidate;
export declare function memoryFeedback(candidate: MemoryCandidate, feedback: AlphaFeedback): {
    action: string;
    candidate: MemoryCandidate;
    mergeTarget?: undefined;
    reason?: undefined;
    retryAfter?: undefined;
    conflicts?: undefined;
} | {
    action: string;
    candidate: {
        revision: number;
        id: string;
        content: unknown;
        sources: string[];
        slot: string;
        batchId: string;
    };
    mergeTarget: string | undefined;
    reason?: undefined;
    retryAfter?: undefined;
    conflicts?: undefined;
} | {
    action: string;
    candidate: MemoryCandidate;
    reason: string;
    mergeTarget?: undefined;
    retryAfter?: undefined;
    conflicts?: undefined;
} | {
    action: string;
    candidate: MemoryCandidate;
    retryAfter: string | undefined;
    reason: string;
    mergeTarget?: undefined;
    conflicts?: undefined;
} | {
    action: string;
    candidate: {
        revision: number;
        id: string;
        content: unknown;
        sources: string[];
        slot: string;
        batchId: string;
    };
    conflicts: string[];
    reason: string;
    mergeTarget?: undefined;
    retryAfter?: undefined;
};
export declare function memoryVerify(candidate: MemoryCandidate, receipt: WriteReceipt): {
    confirmed: boolean;
    candidateId: string;
    nodeIds: string[];
    auditReceipt: string | null;
    reason: string;
};
export declare function runFeedbackLoop(options: {
    candidate: MemoryCandidate;
    preflight: (candidate: MemoryCandidate) => Promise<AlphaFeedback>;
    write: (candidate: MemoryCandidate, feedback: AlphaFeedback) => Promise<WriteReceipt>;
}): Promise<{
    status: string;
    feedback: AlphaFeedback;
    decision: {
        action: string;
        candidate: MemoryCandidate;
        mergeTarget?: undefined;
        reason?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: {
            revision: number;
            id: string;
            content: unknown;
            sources: string[];
            slot: string;
            batchId: string;
        };
        mergeTarget: string | undefined;
        reason?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: MemoryCandidate;
        reason: string;
        mergeTarget?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: MemoryCandidate;
        retryAfter: string | undefined;
        reason: string;
        mergeTarget?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: {
            revision: number;
            id: string;
            content: unknown;
            sources: string[];
            slot: string;
            batchId: string;
        };
        conflicts: string[];
        reason: string;
        mergeTarget?: undefined;
        retryAfter?: undefined;
    };
    confirmed: boolean;
    receipt?: undefined;
    verification?: undefined;
} | {
    status: string;
    feedback: AlphaFeedback;
    decision: {
        action: string;
        candidate: MemoryCandidate;
        mergeTarget?: undefined;
        reason?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: {
            revision: number;
            id: string;
            content: unknown;
            sources: string[];
            slot: string;
            batchId: string;
        };
        mergeTarget: string | undefined;
        reason?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: MemoryCandidate;
        reason: string;
        mergeTarget?: undefined;
        retryAfter?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: MemoryCandidate;
        retryAfter: string | undefined;
        reason: string;
        mergeTarget?: undefined;
        conflicts?: undefined;
    } | {
        action: string;
        candidate: {
            revision: number;
            id: string;
            content: unknown;
            sources: string[];
            slot: string;
            batchId: string;
        };
        conflicts: string[];
        reason: string;
        mergeTarget?: undefined;
        retryAfter?: undefined;
    };
    receipt: WriteReceipt;
    verification: {
        confirmed: boolean;
        candidateId: string;
        nodeIds: string[];
        auditReceipt: string | null;
        reason: string;
    };
    confirmed: boolean;
}>;
