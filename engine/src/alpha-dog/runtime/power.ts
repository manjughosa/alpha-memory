export class AlphaDogPower {
  private _running = false
  private _generation = 0
  on() { this._running = true; return this.snapshot() }
  off() { this._running = false; this._generation += 1; return this.snapshot() }
  isCurrent(generation: number) { return this._running && generation === this._generation }
  snapshot() { return { running: this._running, generation: this._generation } }
}
