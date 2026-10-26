import { BAVETTE_ANGLE } from '../physics/wheelie.ts';

export interface StuntEvent {
  banked: number;
  lost: boolean;
  multiplier: number;
}

/**
 * Wheelie scoring. Same rhythm as the drift score — a combo that grows while
 * the stunt holds and banks when it ends — but the input is the pitch angle:
 * the higher the front, the faster the points, and a bavette (the tail scraping
 * the road) pays a flat bonus on top.
 */
export class StuntScore {
  total = 0;
  pending = 0;
  multiplier = 1;
  active = false;
  deep = false;
  angle = 0;
  private comboTime = 0;
  private idleTime = 0;

  reset(): void {
    this.total = 0;
    this.pending = 0;
    this.multiplier = 1;
    this.active = false;
    this.deep = false;
    this.angle = 0;
    this.comboTime = 0;
    this.idleTime = 0;
  }

  update(
    dt: number,
    pitch: number,
    speed: number,
    grounded: boolean,
    crashed: boolean,
  ): StuntEvent {
    this.angle = pitch;
    if (crashed) {
      const lost = this.pending > 120;
      this.pending = 0;
      this.comboTime = 0;
      this.multiplier = 1;
      this.active = false;
      this.deep = false;
      this.idleTime = 0;
      return { banked: 0, lost, multiplier: 1 };
    }

    const wheelie = grounded && speed > 4 && pitch > 0.18;

    if (wheelie) {
      this.active = true;
      this.deep = pitch > BAVETTE_ANGLE;
      this.idleTime = 0;
      this.comboTime += dt;
      this.multiplier = 1 + Math.min(7, Math.floor(this.comboTime / 1.4));
      const height = Math.sin(pitch);
      const rate = speed * height * 7.2;
      // A bavette is the point of the game: the tail is on the ground and the
      // points come faster than any ordinary wheelie.
      const bonus = this.deep ? 34 + (pitch - BAVETTE_ANGLE) * 120 : 0;
      this.pending += (rate + bonus) * this.multiplier * dt;
      return { banked: 0, lost: false, multiplier: this.multiplier };
    }

    if (this.active) {
      this.idleTime += dt;
      if (this.idleTime > 0.7) {
        const banked = Math.round(this.pending);
        this.total += banked;
        this.pending = 0;
        this.active = false;
        this.deep = false;
        this.comboTime = 0;
        this.multiplier = 1;
        this.idleTime = 0;
        return { banked, lost: false, multiplier: 1 };
      }
    } else {
      this.deep = false;
    }
    return { banked: 0, lost: false, multiplier: this.multiplier };
  }
}
