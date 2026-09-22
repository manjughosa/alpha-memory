export type CheckResult = {
    name: string;
    ok: boolean;
    detail: string;
};
export type InitializationRequest = {
    name: string;
    baseUrl: string;
    api: string;
    apiKeyRef: string;
    models: Array<{
        id: string;
        reasoning: boolean;
        input: string[];
        contextWindow: number;
        maxTokens: number;
        thinkingLevelMap: Record<string, unknown>;
    }>;
};
export type InitOptions = {
    settingPath: string;
    root: string;
    host?: string;
    registry?: any;
    transport?: {
        request?: (payload: unknown, config: Record<string, unknown>) => Promise<unknown>;
        readContextWindow?: (config: Record<string, unknown>) => Promise<number>;
    };
    now?: () => string;
};
export declare function buildInitializationRequest(input?: Partial<InitializationRequest>): InitializationRequest;
export declare function inspectInitialization(options: InitOptions, request?: InitializationRequest): CheckResult[];
export declare function createDeclinedState(): {
    status: 'declined';
    mention: 'off';
};
export declare function initializeAlphaDog(options: InitOptions, requestInput?: Partial<InitializationRequest>): Promise<{
    status: "unconfigured";
    mention: "on";
    request: InitializationRequest;
    checks: CheckResult[];
    failed: string[];
    verification?: undefined;
    generated?: undefined;
} | {
    status: "failed";
    mention: "on";
    request: InitializationRequest;
    checks: CheckResult[];
    verification: CheckResult[];
    failed: string[];
    generated?: undefined;
} | {
    status: "configured";
    mention: "on";
    request: InitializationRequest;
    checks: CheckResult[];
    verification: CheckResult[];
    generated: {
        modelPath: string;
        adapterPath: string;
        reportPath: string;
    };
    failed?: undefined;
}>;
export declare function writeDeclinedState(options: InitOptions): string;
export declare function runMinimalVerification(options: InitOptions, request: InitializationRequest): Promise<CheckResult[]>;
