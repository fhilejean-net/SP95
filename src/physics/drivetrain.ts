/**
 * Engine + gearbox. Kept free of any engine / renderer dependency so the
 * shift logic and torque curve can be unit tested.
 */

export interface DrivetrainConfig {
  idleRpm: number;
  redlineRpm: number;
  upshiftRpm: number;
  downshiftRpm: number;
  /** Forward gear ratios, 1st to 6th. */
  ratios: number[];
  reverseRatio: number;
  finalDrive: number;
  efficiency: number;
  peakTorque: number;
  peakTorqueRpm: number;
}

export const SPORT_DRIVETRAIN: DrivetrainConfig = {
  idleRpm: 900,
  redlineRpm: 7300,
  upshiftRpm: 6700,
  downshiftRpm: 2150,
  ratios: [3.62, 2.19, 1.6, 1.25, 1.03, 0.84],
  reverseRatio: 3.4,
  finalDrive: 3.55,
  efficiency: 0.9,
  peakTorque: 420,
  peakTorqueRpm: 4300,
};

/** Naturally aspirated style torque curve: broad mid-range, soft at redline. */
export function torqueAtRpm(rpm: number, config: DrivetrainConfig = SPORT_DRIVETRAIN): number {
  const x = (rpm - config.peakTorqueRpm) / 2900;
  const curve = 1 - 0.48 * x * x;
  return Math.max(config.peakTorque * 0.26, Math.min(config.peakTorque, config.peakTorque * curve));
}

export interface DrivetrainOutput {
  /** Torque delivered to the driven axle, signed (negative in reverse). */
  axleTorque: number;
  rpm: number;
  gear: number;
  shifting: boolean;
}

export class Drivetrain {
  gear = 1;
  rpm = SPORT_DRIVETRAIN.idleRpm;
  shiftTimer = 0;
  private reverseHold = 0;

  readonly config: DrivetrainConfig;

  constructor(config: DrivetrainConfig = SPORT_DRIVETRAIN) {
    this.config = config;
  }

  get ratio(): number {
    if (this.gear === -1) return -this.config.reverseRatio;
    return this.config.ratios[this.gear - 1];
  }

  reset(): void {
    this.gear = 1;
    this.rpm = this.config.idleRpm;
    this.shiftTimer = 0;
    this.reverseHold = 0;
  }

  /**
   * @param rearOmega average angular velocity of the driven wheels (rad/s)
   * @param throttle forward pedal 0..1
   * @param brake reverse / brake pedal 0..1
   * @param speedMs signed longitudinal speed (positive forward)
   */
  update(
    dt: number,
    rearOmega: number,
    throttle: number,
    brake: number,
    speedMs: number,
  ): DrivetrainOutput {
    const cfg = this.config;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    // Engage reverse by holding the brake at a standstill.
    if (this.gear > 0 && speedMs < 1.2 && brake > 0.35 && throttle < 0.15) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.4) {
        this.gear = -1;
        this.reverseHold = 0;
      }
    } else {
      this.reverseHold = 0;
    }

    // Leave reverse once stopped and asking to go forward.
    if (this.gear === -1 && speedMs > -1 && speedMs < 1.2 && throttle > 0.2) {
      this.gear = 1;
    }

    if (this.gear > 1 && Math.abs(speedMs) < 2.2) {
      // Rolling to a stop: fall back to first, no shift delay needed.
      this.gear = 1;
    }

    const gearRatio = this.ratio;
    const wheelRpm = (Math.abs(rearOmega) * 60) / (2 * Math.PI);
    let rpm = wheelRpm * Math.abs(gearRatio) * cfg.finalDrive;

    // Slipping clutch: at a standstill the driver revs the engine while the
    // clutch bites progressively. Without this a launch only has idle torque.
    const clutchBite = Math.min(1, Math.abs(speedMs) / 2.6);
    const launchRpm = cfg.idleRpm + throttle * 1650 * (1 - clutchBite);
    rpm = Math.max(rpm, launchRpm);
    rpm = Math.min(cfg.redlineRpm + 120, rpm);

    if (this.shiftTimer <= 0 && this.gear > 0) {
      const canShift = Math.abs(speedMs) > 5;
      if (canShift && rpm > cfg.upshiftRpm && this.gear < cfg.ratios.length) {
        this.gear += 1;
        this.shiftTimer = 0.16;
      } else if (
        canShift &&
        this.gear > 1 &&
        (rpm < cfg.downshiftRpm || (throttle > 0.75 && rpm < 2400))
      ) {
        this.gear -= 1;
        this.shiftTimer = 0.14;
      }
    }

    const effectiveThrottle = this.gear === -1 ? brake : throttle;
    const shifting = this.shiftTimer > 0;
    const limiter = rpm > cfg.redlineRpm - 60 ? 0.15 : 1;
    const engineTorque = shifting || effectiveThrottle <= 0.01
      ? 0
      : torqueAtRpm(rpm, cfg) * effectiveThrottle * limiter;

    // Engine braking when off the throttle and in gear.
    const engineBrake = effectiveThrottle <= 0.02 && Math.abs(speedMs) > 1 ? 14 * Math.sign(gearRatio) : 0;

    this.rpm = rpm;

    return {
      axleTorque: (engineTorque - engineBrake) * gearRatio * cfg.finalDrive * cfg.efficiency,
      rpm,
      gear: this.gear,
      shifting,
    };
  }
}
