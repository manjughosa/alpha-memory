export type RoundTickEvent = {
    event: 'round_tick';
    sessionId: string;
    round: number;
    userInput: string;
    timestamp: string;
    eventId: string;
};
export declare function normalizeRoundTick(input: any, previousRound?: number): RoundTickEvent;
