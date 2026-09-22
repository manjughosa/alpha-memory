export declare class AlphaDogCounter {
    private value;
    constructor(initial?: number);
    tick(): number;
    current(): number;
    restore(value: number): number;
}
