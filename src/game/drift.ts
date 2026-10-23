export interface DriftEvent {
  banked: number;
  lost: boolean;
  multiplier: number;
}

export class DriftScore {
  total = 0;
  pending = 0;
  multiplier = 1;
  active = false;
  private comboTime = 0;
  private idleTime = 0;

  reset(): void {
    this.total = 0;
    this.pending = 0;
    this.multiplier = 1;
    this.active = false;
    this.comboTime = 0;
    this.idleTime = 0;
  }

  update(
    dt: number,
    speed: number,
    slipAngle: number,
    grounded: boolean,
    crashed: boolean,
  ): DriftEvent {
    if (crashed) {
      const lost = this.pending > 150;
      this.pending = 0;
      this.comboTime = 0;
      this.multiplier = 1;
      this.active = false;
      this.idleTime = 0;
      return { banked: 0, lost, multiplier: 1 };
    }

    const drifting = grounded && speed > 7 && Math.abs(slipAngle) > 0.16;

    if (drifting) {
      this.active = true;
      this.idleTime = 0;
      this.comboTime += dt;
      this.multiplier = 1 + Math.min(7, Math.floor(this.comboTime / 1.1));
      const rate = speed * Math.abs(Math.sin(slipAngle)) * 6.5;
      this.pending += rate * this.multiplier * dt;
      return { banked: 0, lost: false, multiplier: this.multiplier };
    }

    if (this.active) {
      this.idleTime += dt;
      if (this.idleTime > 0.75) {
        const banked = Math.round(this.pending);
        this.total += banked;
        this.pending = 0;
        this.active = false;
        this.comboTime = 0;
        this.multiplier = 1;
        this.idleTime = 0;
        return { banked, lost: false, multiplier: 1 };
      }
    }
    return { banked: 0, lost: false, multiplier: this.multiplier };
  }
}
