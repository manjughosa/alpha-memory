export declare function loadWatchdogPrompt(root: string, prompt: string): {
    path: string;
    text: string;
};
export declare function invokeWatchdog(invokeModel: (request: any) => Promise<any>, request: any): Promise<any>;
