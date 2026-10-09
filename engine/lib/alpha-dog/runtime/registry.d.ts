export declare function resolveRegistryCandidates(setting: any, registry: any, root: string): string[];
export declare function readRegistry(setting: any, registry: any, root: string, snapshot?: any[]): {
    entries: any;
    error: null;
} | {
    entries: any[];
    error: string;
};
