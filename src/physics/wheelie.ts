/**
 * Wheelie dynamics, kept as pure math so the balance point and the way the
 * throttle and the brake move it can be unit tested without a physics world.
 *
 * The bike is a pendulum about the rear contact patch: the drive torque lifts
 * the front, gravity pulls it back down, and past the balance angle gravity
 * pulls it over instead. An inverted pendulum at 120 Hz with a keyboard cannot
 * be balanced by a human — a rider balances it with small throttle corrections
 * several times a second — so the model includes that rider: he chases the
 * angle the throttle asks for, with a limited authority and a lag. The limit is
 * what makes it hard: past the balance point no amount of gas brings the front
 * back, only the brake does.
 */

export interface WheelieGeometry {
  /** Barycentre height over the ground, m. */
  cgHeight: number;
  /** Horizontal distance from the rear contact to the barycentre, m. */
  cgFromRear: number;
  /** Distance between the contact patches, m. */
  wheelbase: number;
  /** How much of the axle torque actually rotates the chassis. */
  liftGain: number;
}

export interface WheelieInput {
  /** Torque delivered to the rear axle, Nm (negative in reverse). */
  axleTorque: number;
  /** Throttle pedal, 0..1: it is the angle the rider asks the front to hold. */
  throttle: number;
  /** Front + rear brake pedal, 0..1. */
  brake: number;
  /** Rear tire on the ground. */
  rearContact: boolean;
  /** Forward speed, m/s. */
  speed: number;
  /** Grip of the surface under the rear tire, 1 on dry asphalt. */
  grip?: number;
}

export interface WheelieState {
  pitch: number;
  pitchVelocity: number;
}

/** Past this the rider is on his back: the wheelie is lost. */
export const LOOP_ANGLE = 1.52;

/**
 * From here the tail unit scrapes the tarmac: a bavette. It sits just above the
 * angle a rider can hold on the throttle, so the bavette is something he has to
 * push for with a second clutch-up, and then brake back out of.
 */
export const BAVETTE_ANGLE = 0.9;

/** Where a closed throttle and full gas put the front, radians. */
export const HOLD_LOW = 0.02;
export const HOLD_HIGH = 0.82;

/** Gravity, m/s². */
const G = 9.81;

/** Pitch over which the front tire stops carrying its share of the weight. */
const LIFT_ANGLE = 0.16;

/** Balance stiffness of the rider's corrections, Nm per rad of error. */
const RIDER_GAIN = 5200;
/** How hard the rider reacts to the front already moving, Nm·s/rad. */
const RIDER_DAMPING = 1400;
/** Torque the rider can ask the tire for, Nm. */
const RIDER_MAX = 2600;
/** Axle torque at which the engine can answer the rider fully, Nm. */
const FULL_AUTHORITY = 300;

export function balanceAngle(geometry: WheelieGeometry): number {
  return Math.atan2(geometry.cgFromRear, geometry.cgHeight);
}

/** Moment of inertia about the rear contact, kg·m². */
export function pitchInertia(geometry: WheelieGeometry, mass: number): number {
  const { cgHeight: h, cgFromRear: x } = geometry;
  return mass * (x * x + h * h) + 18;
}

/** Torque gravity applies about the rear contact, positive nose-down, Nm. */
export function gravityTorque(geometry: WheelieGeometry, mass: number, pitch: number): number {
  return mass * G * (geometry.cgFromRear * Math.cos(pitch) - geometry.cgHeight * Math.sin(pitch));
}

/**
 * Static load the front tire carries, in newtons. While it is on the ground it
 * pushes the nose up with `frontLoad * wheelbase`, which is exactly the gravity
 * torque at rest: that is why a bike sitting on two wheels does not wheelie by
 * itself, and why the pop has to unload the front to start one.
 */
export function frontLoad(geometry: WheelieGeometry, mass: number): number {
  return (mass * G * geometry.cgFromRear) / geometry.wheelbase;
}

/**
 * Nose-down torque the chassis actually fights at a given pitch: gravity minus
 * whatever the front tire still pushes up with. Zero at rest, all of it once
 * the front is off the ground.
 */
export function effectiveGravity(
  geometry: WheelieGeometry,
  mass: number,
  pitch: number,
): number {
  const carried = Math.max(0, 1 - pitch / LIFT_ANGLE);
  return gravityTorque(geometry, mass, pitch) - frontLoad(geometry, mass) * geometry.wheelbase * carried;
}

/**
 * Angle the throttle asks for. A closed throttle asks for nothing, full gas
 * asks for a wheelie just under the balance point: that is the angle a rider
 * holds, and the bavette is what happens when he pops it past that.
 */
export function holdTarget(throttle: number, brake: number): number {
  const t = Math.max(0, Math.min(1, (throttle - 0.1) / 0.9));
  const eased = t * t * (3 - 2 * t);
  const target = HOLD_LOW + (HOLD_HIGH - HOLD_LOW) * eased;
  return Math.max(0, target - brake * 1.4);
}

/**
 * Angular acceleration of the chassis, rad/s².
 *
 * Below the angle the throttle asks for the drive lifts, above it the rider
 * rolls off and gravity takes over; the two only balance at `balanceAngle()`
 * with no torque at all. Past that point the gravity term changes sign and the
 * wheelie accelerates away: no amount of throttle can save it, only the brake.
 */
export function wheelieAcceleration(
  state: WheelieState,
  input: WheelieInput,
  geometry: WheelieGeometry,
  mass: number,
): number {
  const { pitch, pitchVelocity } = state;
  const inertia = pitchInertia(geometry, mass);
  const gravity = effectiveGravity(geometry, mass, pitch);

  // No rear contact, or too slow for the front to carry: the chassis just
  // falls back on its own.
  const pivoting = input.rearContact && Math.abs(input.speed) > 1.2;
  if (!pivoting) return (-gravity - RIDER_DAMPING * pitchVelocity) / inertia;

  // What the engine can actually answer with now: a tall gear at low rpm
  // cannot hold the front, and neither can wet grass.
  const authority =
    Math.min(
      1,
      Math.max(input.throttle, Math.max(0, input.axleTorque) / FULL_AUTHORITY) *
        geometry.liftGain,
    ) * Math.min(1, Math.max(0, input.grip ?? 1));

  // While the front tire is loaded it carries the nose: the drive cannot lift
  // it, which is why a bike does not wheelie every time it accelerates. Only
  // the clutch-up (or a wheelie already in progress) breaks that support.
  const engaged = pitch > LIFT_ANGLE || pitchVelocity > 0.3;

  const target = holdTarget(input.throttle, input.brake);
  const hold = Math.max(0, effectiveGravity(geometry, mass, target));
  const wanted = hold + (target - pitch) * RIDER_GAIN;
  const lift = engaged ? Math.max(0, Math.min(RIDER_MAX, wanted)) * authority : 0;

  // The front brake is the tool that puts the bike back down, and it works
  // even when the front wheel is in the air because the caliper bites the disc.
  const braking = input.brake * mass * G * geometry.cgFromRear * 1.7;
  const damping = RIDER_DAMPING * pitchVelocity;
  return (lift - gravity - braking - damping) / inertia;
}

/**
 * Lean angle (positive = right) implied by a turn, purely visual: the bike is
 * held upright by the physics body, so the lean the player sees has to be
 * derived from the yaw rate and the speed it is actually carrying.
 */
export function leanFor(speed: number, yawRate: number, maxLean: number): number {
  if (Math.abs(speed) < 0.6) return 0;
  const target = -Math.atan2(speed * yawRate, G);
  const clamped = Math.max(-maxLean, Math.min(maxLean, target));
  return clamped;
}
