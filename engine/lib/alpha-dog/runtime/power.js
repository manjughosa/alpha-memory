export class AlphaDogPower {
    _running = false;
    _generation = 0;
    on() { this._running = true; return this.snapshot(); }
    off() { this._running = false; this._generation += 1; return this.snapshot(); }
    isCurrent(generation) { return this._running && generation === this._generation; }
    snapshot() { return { running: this._running, generation: this._generation }; }
}
