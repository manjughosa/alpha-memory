declare const MODES: readonly ["interrupt", "fixed_defer", "backfill", "monitor"];
declare const SCHEDULES: readonly [15, 21, 30];
declare const LEGACY_TOOLS: readonly ["cg", "stg"];
declare const EVENTS: Readonly<{
    ON: "alpha_dog.on";
    OFF: "alpha_dog.off";
    WAKE_PLANNED: "alpha_dog.wake_planned";
    WAKE_STARTED: "alpha_dog.wake_started";
    WAKE_FINISHED: "alpha_dog.wake_finished";
    STATE_CHANGED: "alpha_dog.state_changed";
    REPORT: "alpha_dog.report";
}>;
export declare const ALPHA_DOG_CONFIG_SCHEMA: Readonly<{
    type: "object";
    additionalProperties: false;
    properties: {
        enabled: {
            type: string;
            default: boolean;
        };
        schedule: {
            type: string;
            enum: (15 | 21 | 30)[];
            default: number;
        };
        modes: {
            type: string;
            items: {
                type: string;
                enum: ("interrupt" | "fixed_defer" | "backfill" | "monitor")[];
            };
            default: string[];
        };
        provider: {
            type: string;
            default: string;
        };
        model: {
            type: string;
            default: string;
        };
        mention: {
            type: string;
            enum: string[];
            default: string;
        };
        batchSize: {
            type: string;
            minimum: number;
            default: number;
        };
        counter: {
            type: string;
            minimum: number;
            default: number;
        };
        registry: {
            type: string;
            default: string;
        };
    };
}>;
export declare function defaultConfig(overrides?: any): any;
export declare function validateConfig(input?: any): {
    ok: boolean;
    config: any;
    errors: string[];
};
export declare function capabilityDirectory(schedule: number, { legacy }?: {
    legacy?: boolean | undefined;
}): {
    schedule: number;
    tools: ("cg" | "stg")[];
    modes: string[];
    hidden: string[];
    open: boolean;
};
export declare function filterInterface(items: any[], { schedule, requestedModes, legacy }?: {
    schedule?: number | undefined;
    requestedModes?: readonly ["interrupt", "fixed_defer", "backfill", "monitor"] | undefined;
    legacy?: boolean | undefined;
}): any[];
export declare function transition(state: string, action: string): string;
export declare function createState(overrides?: any): any;
export declare function createEvent(type: string, payload?: {}, { eventId, roundId, seq }?: {
    eventId?: string | undefined;
    roundId?: string | undefined;
    seq?: number | undefined;
}): {
    version: string;
    kind: string;
    id: string;
    type: string;
    roundId: string;
    seq: number;
    ts: string;
    payload: {};
};
export declare function reduceState(current: any, event: any): any;
export declare function applyControl(current: any, command: string, meta?: {}): any;
export declare function planBatches(registry: any[], batchSize?: number): {
    batch: number;
    entries: any[];
}[];
export declare function parseRegistryPath(value: string, _opts?: {}): {
    kind: string;
    alias: string;
    path: null;
} | {
    kind: string;
    path: string;
    alias?: undefined;
};
export declare function createWakePlan({ roundId, schedule, registry, batchSize, mention, modes }?: {
    schedule?: number | undefined;
    registry?: never[] | undefined;
    batchSize?: number | undefined;
    mention?: string | undefined;
    modes?: string[] | undefined;
}): {
    version: string;
    kind: string;
    roundId: string;
    schedule: number;
    mention: string;
    modes: any[];
    order: string;
    batches: {
        batch: number;
        entries: any[];
    }[];
};
export declare function createReport({ roundId, state, plan, completed, errors }?: {
    completed?: never[] | undefined;
    errors?: never[] | undefined;
}): {
    version: string;
    roundId: string;
    state: any;
    planVersion: any;
    completed: never[];
    errors: never[];
    ok: boolean;
};
export { EVENTS, MODES, SCHEDULES, LEGACY_TOOLS };
