export declare class AlphaDogPower {
    private _running;
    private _generation;
    on(): {
        running: boolean;
        generation: number;
    };
    off(): {
        running: boolean;
        generation: number;
    };
    isCurrent(generation: number): boolean;
    snapshot(): {
        running: boolean;
        generation: number;
    };
}
