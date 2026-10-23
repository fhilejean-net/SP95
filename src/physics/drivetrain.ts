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
  /** Driven wheel radius, m: turns the wheel speed into a road speed. */
  wheelRadius: number;
}

export const SPORT_DRIVETRAIN: DrivetrainConfig = {
  idleRpm: 900,
  redlineRpm: 7300,
  upshiftRpm: 6800,
  downshiftRpm: 2150,
  ratios: [3.62, 2.19, 1.6, 1.25, 1.03, 0.84],
  reverseRatio: 2.6,
  finalDrive: 3.55,
  efficiency: 0.9,
  peakTorque: 420,
  peakTorqueRpm: 3900,
  wheelRadius: 0.34,
};

/** Rev limiter: fuel cut windows. A 140 ms cycle is the classic bounce. */
const LIMITER_CYCLE = 0.14;
const LIMITER_CUT = 0.055;
/** Minimum time in a gear before the next shift: stops hunting. */
const MIN_GEAR_TIME = 0.45;

/** Naturally aspirated style torque curve: broad mid-range, soft at redline. */
export function torqueAtRpm(rpm: number, config: DrivetrainConfig = SPORT_DRIVETRAIN): number {
  const x = (rpm - config.peakTorqueRpm) / 3200;
  const curve = 1 - 0.38 * x * x;
  return Math.max(config.peakTorque * 0.26, Math.min(config.peakTorque, config.peakTorque * curve));
}

export interface DrivetrainOutput {
  /** Torque delivered to the driven axle, signed (negative in reverse). */
  axleTorque: number;
  rpm: number;
  gear: number;
  shifting: boolean;
  /** True on the fuel-cut half of a rev limiter cycle, for the exhaust bang. */
  limiter: boolean;
}

export class Drivetrain {
  gear = 1;
  rpm = SPORT_DRIVETRAIN.idleRpm;
  shiftTimer = 0;
  private reverseHold = 0;
  private gearTimer = 0;
  private limiterPhase = 0;

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
    this.gearTimer = 0;
    this.limiterPhase = 0;
  }

  /**
   * @param rearOmega average angular velocity of the driven wheels (rad/s)
   * @param throttle forward pedal 0..1
   * @param brake reverse / brake pedal 0..1
   * @param speedMs signed longitudinal speed (positive forward)
   * @param groundSpeed unsigned speed over the ground, defaults to speedMs.
   *        A stationary burnout spins the rear axle flat out while the car goes
   *        nowhere; without this the gearbox would climb to sixth on the spot.
   */
  update(
    dt: number,
    rearOmega: number,
    throttle: number,
    brake: number,
    speedMs: number,
    groundSpeed = Math.abs(speedMs),
  ): DrivetrainOutput {
    const cfg = this.config;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.gearTimer += dt;
    // What the gearbox actually sees: the road speed implied by the driven
    // wheels. In a drift the rear axle runs far faster than the body, and a
    // gearbox has no idea the car is sideways -- deciding shifts on the chassis
    // speed left the car pinned on the limiter in first while it slid.
    const wheelSpeed = Math.abs(rearOmega) * cfg.wheelRadius;

    // Reverse is a gear you engage at a standstill, like holding the pedal on an
    // automatic: it never engages while the car is still rolling.
    if (this.gear > 0) {
      if (Math.abs(speedMs) < 0.9 && brake > 0.35 && throttle < 0.12) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.35) {
          this.gear = -1;
          this.reverseHold = 0;
          this.shiftTimer = 0;
        }
      } else {
        this.reverseHold = 0;
      }
    } else {
      // Leaving reverse is immediate once the driver asks for forward: the car
      // brakes on its way down, then first gear takes over as soon as it has
      // stopped rolling backwards. Waiting for an exact speed left the car
      // stuck in reverse while the throttle acted as a brake.
      this.reverseHold = 0;
      if (throttle > 0.12 && speedMs > -1.4) {
        this.gear = 1;
        this.shiftTimer = 0.12;
      }
    }

    if (this.gear > 1 && wheelSpeed < 1.2 && Math.abs(speedMs) < 1.2) {
      // Rolling to a stop: fall back to first, no shift delay needed.
      this.gear = 1;
      this.gearTimer = 0;
    }

    const gearRatio = this.ratio;
    const wheelRpm = (Math.abs(rearOmega) * 60) / (2 * Math.PI);
    let rpm = wheelRpm * Math.abs(gearRatio) * cfg.finalDrive;

    // Slipping clutch: from a standstill the driver keeps the engine near its
    // torque peak while the clutch slips, and the bite closes progressively as
    // road speed builds. Without this the engine falls back to idle after a few
    // metres and the launch has no torque.
    const pedal = this.gear === -1 ? brake : throttle;
    const slip = Math.max(0, 1 - Math.abs(speedMs) / 9);
    const launchRpm = cfg.idleRpm + pedal * 2900 * slip;
    rpm = Math.max(rpm, launchRpm);
    rpm = Math.min(cfg.redlineRpm + 120, rpm);

    if (this.shiftTimer <= 0 && this.gear > 0 && this.gearTimer > MIN_GEAR_TIME) {
      // The driven axle is turning, so the car is moving even if the chassis is
      // sliding and its longitudinal speed reads close to zero.
      const rolling = wheelSpeed > 2.5 && groundSpeed > 1.5;
      if (rolling && rpm > cfg.upshiftRpm && this.gear < cfg.ratios.length) {
        this.gear += 1;
        this.shiftTimer = 0.16;
        this.gearTimer = 0;
      } else if (
        rolling &&
        this.gear > 1 &&
        (rpm < cfg.downshiftRpm || (throttle > 0.75 && rpm < 2400))
      ) {
        this.gear -= 1;
        this.shiftTimer = 0.14;
        this.gearTimer = 0;
      }
    }

    const effectiveThrottle = this.gear === -1 ? brake : throttle;
    const shifting = this.shiftTimer > 0;
    // The limiter bounces: fuel is cut for ~40% of a 140 ms cycle, so the car
    // still pulls instead of sitting on a flat 15% torque cut forever.
    const overRev = rpm >= cfg.redlineRpm - 40;
    if (overRev) this.limiterPhase = (this.limiterPhase + dt) % LIMITER_CYCLE;
    else this.limiterPhase = 0;
    const limiterCut = overRev && this.limiterPhase < LIMITER_CUT;
    const limiter = limiterCut ? 0 : 1;
    // Reverse is for manoeuvring: past a walking-pace-plus crawl the drive is
    // cut, otherwise the car reverses at motorway speed.
    const reverseCut = this.gear === -1 && speedMs < -7.5;
    const engineTorque = shifting || effectiveThrottle <= 0.01 || reverseCut
      ? 0
      : torqueAtRpm(rpm, cfg) * effectiveThrottle * limiter;

    // Engine braking opposes the wheel's rotation, so its sign follows the
    // direction of travel and the gear, not the gear alone (which would drive
    // the car backwards in reverse).
    const engineBrake =
      effectiveThrottle <= 0.02 && Math.abs(speedMs) > 1
        ? 14 * Math.sign(speedMs * gearRatio)
        : 0;

    this.rpm = rpm;

    return {
      axleTorque: (engineTorque - engineBrake) * gearRatio * cfg.finalDrive * cfg.efficiency,
      rpm,
      gear: this.gear,
      shifting,
      limiter: limiterCut,
    };
  }
}
