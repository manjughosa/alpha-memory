export type ConversationTurn = {
    kind: 'user' | 'assistant' | 'tool';
    text: string;
    at: string;
    roundHint?: number;
};
export type ConversationSourceResult = {
    ok: boolean;
    error?: string;
    file?: string;
    turns: ConversationTurn[];
    userTurns: ConversationTurn[];
    /** 源文件最后修改时间（新鲜度判断用） */
    mtimeMs: number;
};
export declare function resolveConversationCandidates(declared: string, probeRoots?: string[]): string[];
/** 读最新写入的会话文件（按 mtime 排序，取最新）并解析为对话流。 */
export declare function readConversation(declared: string, probeRoots?: string[], maxFileBytes?: number): ConversationSourceResult;
