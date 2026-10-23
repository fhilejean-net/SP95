/**
 * Simplified Pacejka "magic formula" tire model with a combined-slip friction
 * ellipse. Everything here is pure math so it can be unit tested in Node.
 *
 * Slip conventions:
 *  - kappa (longitudinal slip ratio) > 0 when the wheel spins faster than the
 *    ground speed (drive / wheelspin), < 0 when it turns slower (braking).
 *  - alpha (slip angle) > 0 when the contact patch travels toward the wheel's
 *    right-hand side. The resulting lateral force then points left.
 */

export interface TireCurve {
  /** Stiffness factor: how quickly force builds with slip. */
  B: number;
  /** Shape factor: > 1 gives a peak then a gentle fall-off. */
  C: number;
  /** Curvature factor. */
  E: number;
}

/** Normalized slip at which the tire reaches peak grip. */
export const KAPPA_PEAK = 0.11;
export const ALPHA_PEAK = 0.135;

const COMBINED_CURVE: TireCurve = { B: 10, C: 1.5, E: 0.97 };

/** Returns a force coefficient in [0, ~1], peaking at x = 1. */
export function magicFormula(x: number, curve: TireCurve = COMBINED_CURVE): number {
  const bx = curve.B * Math.abs(x);
  const value = Math.sin(curve.C * Math.atan(bx - curve.E * (bx - Math.atan(bx))));
  return value * Math.sign(x || 1);
}

export function slipAngleFromVelocity(vLong: number, vLat: number): number {
  // Reference speed keeps the angle meaningful at a standstill without the
  // singularity of dividing by ~0.
  const vRef = Math.max(Math.abs(vLong), 1.2);
  return Math.atan2(vLat, vRef);
}

export function slipRatioFromWheelSpeed(
  wheelAngularVelocity: number,
  radius: number,
  vLong: number,
): number {
  const vRef = Math.max(Math.abs(vLong), 2.5);
  return (wheelAngularVelocity * radius - vLong) / vRef;
}

/**
 * Load sensitivity: a tire that is pushed harder offers a lower friction
 * coefficient. Without it, cars behave like they run on rails and weight
 * transfer has no effect.
 */
export function loadSensitivity(mu: number, fz: number): number {
  const factor = 1 - 0.000045 * Math.max(0, fz - 3800);
  return mu * Math.min(1.05, Math.max(0.62, factor));
}

export interface TireInput {
  kappa: number;
  alpha: number;
  /** Normal load in newtons. */
  fz: number;
  /** Base friction coefficient of the surface/tire pair. */
  mu: number;
}

export interface TireOutput {
  /** Longitudinal force, positive toward the wheel's forward direction. */
  fx: number;
  /** Lateral force, positive toward the wheel's right-hand direction. */
  fy: number;
  /** Normalized combined slip magnitude. */
  slip: number;
  /** Normalized longitudinal slip. */
  sx: number;
  /** Normalized lateral slip. */
  sy: number;
}

export function tireForces(input: TireInput): TireOutput {
  const { kappa, alpha, fz, mu } = input;

  if (fz <= 1) {
    return { fx: 0, fy: 0, slip: 0, sx: 0, sy: 0 };
  }

  const sx = kappa / KAPPA_PEAK;
  const sy = Math.tan(Math.max(-1.45, Math.min(1.45, alpha))) / Math.tan(ALPHA_PEAK);
  const rho = Math.hypot(sx, sy);

  if (rho < 1e-5) {
    return { fx: 0, fy: 0, slip: 0, sx, sy };
  }

  const maxForce = loadSensitivity(mu, fz) * fz;
  const force = maxForce * magicFormula(rho);

  return {
    fx: (force * sx) / rho,
    fy: (-force * sy) / rho,
    slip: rho,
    sx,
    sy,
  };
}

/** Peak lateral grip available at a given load (used by the HUD / audio). */
export function lateralGrip(mu: number, fz: number): number {
  return loadSensitivity(mu, fz) * fz;
}
