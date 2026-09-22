export type AlphaDogMode = 'legacy' | 'shadow' | 'alpha_dog';
export type ShadowComparison = {
    round: number;
    legacy: unknown;
    alphaDog: unknown;
    differences: string[];
    passed: boolean;
    createdAt: string;
};
export declare function modePolicy(mode: AlphaDogMode): {
    runLegacy: boolean;
    runAlphaDog: boolean;
    formalWrites: boolean;
};
export declare function compareShadow(round: number, legacy: any, alphaDog: any): ShadowComparison;
export declare function canPromote(comparisons: ShadowComparison[], minimum?: number): {
    ok: boolean;
    checked: number;
    failedRounds: number[];
};
export declare function promoteMode(settingPath: string, comparisons: ShadowComparison[]): {
    promoted: boolean;
    gate: {
        ok: boolean;
        checked: number;
        failedRounds: number[];
    };
    mode?: undefined;
} | {
    promoted: boolean;
    gate: {
        ok: boolean;
        checked: number;
        failedRounds: number[];
    };
    mode: string;
};
export declare function appendShadowAudit(path: string, comparison: ShadowComparison): ShadowComparison;
