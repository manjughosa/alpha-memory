export class AlphaDogCounter {
    value = 0;
    constructor(initial = 0) { this.value = Math.max(0, Math.trunc(initial)); }
    tick() { this.value += 1; return this.value; }
    current() { return this.value; }
    restore(value) { this.value = Math.max(0, Math.trunc(value)); return this.value; }
}
