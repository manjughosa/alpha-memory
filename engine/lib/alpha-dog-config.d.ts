export declare const MODES: readonly ["interrupt", "fixed_defer", "backfill", "monitor"];
export type AlphaDogMode = (typeof MODES)[number];
export declare const DEFAULT_DOG_SETTING: {
    readonly version: "2.1.0";
    readonly enabled: false;
    readonly interfaces: {
        readonly Alpha_Dog_On: true;
        readonly Alpha_Dog_Off: true;
        readonly cg: false;
        readonly stg: false;
    };
    readonly schedule: {
        readonly slots: readonly [{
            readonly id: "light";
            readonly label: "即时落盘";
            readonly interval: 15;
            readonly prompt: "alpha-dog-light";
            readonly registryTags: readonly ["即时落盘·15轮"];
            readonly allowedModes: readonly ["backfill", "monitor"];
        }, {
            readonly id: "medium";
            readonly label: "中档巡检";
            readonly interval: 21;
            readonly prompt: "alpha-dog-medium";
            readonly registryTags: readonly ["系统巡检·21轮"];
            readonly allowedModes: readonly ["backfill", "monitor"];
        }, {
            readonly id: "heavy";
            readonly label: "重档巡检";
            readonly interval: 30;
            readonly prompt: "alpha-dog-heavy";
            readonly registryTags: readonly ["记忆巡检·30轮"];
            readonly allowedModes: readonly ["interrupt", "fixed_defer", "backfill", "monitor"];
        }];
        readonly simultaneousOrder: readonly ["medium", "light", "heavy"];
        readonly sequentialWake: true;
    };
    readonly registry: {
        readonly memoryMappingTableMd: "@memory_mapping_table_md";
        readonly memoryMappingTableJson: "@memory_mapping_table_json";
    };
    readonly initialization: {
        readonly mention: "on";
        readonly status: "unconfigured";
    };
    readonly model: {
        readonly name: "";
        readonly baseUrl: "";
        readonly api: "";
        readonly apiKeyRef: "";
        readonly models: readonly [];
    };
    readonly state: {
        readonly directory: "state";
        readonly mode: "legacy";
    };
    readonly governance: {
        readonly failureThreshold: 3;
        readonly cooldownMs: 300000;
        readonly maxPending: 100;
    };
    readonly batchSize: 8;
    readonly sidecar: {
        readonly enabled: false;
        readonly mode: "wake";
        readonly network: "off";
        readonly countScope: "tool_call";
        readonly entry: "engine/runtime/alpha-dog-sidecar.cjs";
        readonly bridge: "alpha_memory_bridge.js";
        readonly node: "";
        readonly serverName: "alpha-memory";
    };
};
export declare function loadAlphaDogSetting(filePath: string, overrides?: Record<string, unknown>): any;
export declare function findUpward(start: string, name: string): string | null;
export declare function resolveDefaultAlphaDogSetting(compiledEntry: string): string;
export declare function resolveAlphaDogModel(config?: any, routed?: any): {
    provider: any;
    model: any;
} | null;
export declare function registryPath(registry: any, id: string, root: string): string | null;
export declare function validateAlphaDogSetting(input?: Record<string, any>): any;
