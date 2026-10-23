import RAPIER from '@dimforge/rapier3d-compat';
import {
  add,
  clamp,
  cross,
  dot,
  forwardOf,
  length,
  rotate,
  rotateAxis,
  sub,
  upOf,
  vec3,
  type Quat,
  type Vec3,
} from './math.ts';
import { Drivetrain, SPORT_DRIVETRAIN } from './drivetrain.ts';
import {
  KAPPA_PEAK,
  lateralGrip,
  slipAngleFromVelocity,
  slipRatioFromWheelSpeed,
  tireForces,
} from './tire.ts';

export interface VehicleInput {
  /** Forward pedal, 0..1 (analog on a gamepad). */
  throttle: number;
  /** Back / brake pedal, 0..1. Above a standstill it engages reverse. */
  brake: number;
  /** -1 full left, +1 full right. */
  steer: number;
  handbrake: boolean;
}

export const NEUTRAL_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

interface Wheel {
  name: 'FL' | 'FR' | 'RL' | 'RR';
  mount: Vec3;
  front: boolean;
  radius: number;
  steer: number;
  omega: number;
  spinAngle: number;
  contact: boolean;
  contactPoint: Vec3;
  contactNormal: Vec3;
  suspensionLength: number;
  compression: number;
  load: number;
  forceLong: number;
  forceLat: number;
  slipAngle: number;
  slipRatio: number;
}

export interface WheelTelemetry {
  name: Wheel['name'];
  contact: boolean;
  steer: number;
  spinAngle: number;
  omega: number;
  suspensionLength: number;
  load: number;
  forceLong: number;
  forceLat: number;
  slipAngle: number;
  slipRatio: number;
  worldPosition: Vec3;
}

export interface VehicleTelemetry {
  speed: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  shifting: boolean;
  throttle: number;
  brake: number;
  handbrake: boolean;
  slipAngle: number;
  driftAngleDeg: number;
  lateralAccel: number;
  airborne: boolean;
  wheels: WheelTelemetry[];
}

export interface VehicleState {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
}

/**
 * Everything the setup (engine, exhaust, weight, suspension, tires, steering)
 * changes about the car. The physics reads only this object, so a part swap is a
 * rebuild of the vehicle with another spec rather than a pile of multipliers
 * scattered through the step function.
 */
export interface VehicleSpec {
  name: string;
  /** Kerb weight, kg. */
  mass: number;
  peakTorque: number;
  peakTorqueRpm: number;
  redlineRpm: number;
  upshiftRpm: number;
  finalDrive: number;
  /** Cd x A, m². */
  dragArea: number;
  /** Cl x A, m² (downforce). */
  downforceArea: number;
  muFront: number;
  muRear: number;
  /** Slip angle (rad) at which the tires peak: wide for drift tires. */
  peakSlipAngle: number;
  springK: number;
  springC: number;
  arbFront: number;
  arbRear: number;
  /** Static distance between the wheel mount and the hub, m. */
  rideHeight: number;
  wheelRadius: number;
  wheelTravel: number;
  /** Service brake torque at full pedal, Nm. */
  brakeTorque: number;
  /** Physical steering lock, radians. */
  maxSteer: number;
  /** Rack speed at walking pace, rad/s. */
  steerRate: number;
}

export const STOCK_SPEC: VehicleSpec = {
  name: 'Série',
  mass: 1350,
  peakTorque: 420,
  peakTorqueRpm: 3900,
  redlineRpm: 7300,
  upshiftRpm: 6800,
  finalDrive: 3.55,
  dragArea: 0.71,
  downforceArea: 0.935,
  muFront: 1.24,
  muRear: 1.2,
  peakSlipAngle: 0.135,
  springK: 34000,
  springC: 3800,
  arbFront: 14000,
  arbRear: 9000,
  rideHeight: 0.363,
  wheelRadius: 0.34,
  wheelTravel: 0.14,
  brakeTorque: 1250,
  maxSteer: 0.72,
  steerRate: 3.0,
};

const MIN_LENGTH = 0.06;
/** First-stage bump stop: firm, but it lets the body settle instead of jamming. */
const BUMP_K = 90000;
/** Second stage, only reached in a real impact. */
const BUMP_K_HARD = 1_600_000;
/** Reflected engine inertia, multiplied by the squared total gear ratio. */
const ENGINE_INERTIA = 0.22;

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly spec: VehicleSpec;
  readonly drivetrain: Drivetrain;

  /** Spring free length: static compression is folded in so ride height holds. */
  readonly restLength: number;
  readonly maxLength: number;
  readonly bumpStop: number;

  private readonly wheelInertia: number;
  private readonly maxSpringForce: number;

  private wheels: Wheel[];
  private steerAngle = 0;
  private telemetry: VehicleTelemetry;
  private flippedTimer = 0;
  private prevSpeed = 0;
  /** Signed longitudinal acceleration estimate, m/s². */
  accelLong = 0;
  accelLat = 0;

  constructor(
    world: RAPIER.World,
    opts: { x: number; y: number; z: number; heading: number; color?: number },
    spec: VehicleSpec = STOCK_SPEC,
  ) {
    this.spec = spec;
    this.drivetrain = new Drivetrain({
      ...SPORT_DRIVETRAIN,
      peakTorque: spec.peakTorque,
      peakTorqueRpm: spec.peakTorqueRpm,
      redlineRpm: spec.redlineRpm,
      upshiftRpm: spec.upshiftRpm,
      finalDrive: spec.finalDrive,
    });
    this.restLength = spec.rideHeight + (spec.mass * 9.81) / (4 * spec.springK);
    this.maxLength = this.restLength + spec.wheelTravel;
    this.bumpStop = this.restLength - 0.22;
    this.wheelInertia = 1.6 * Math.pow(spec.wheelRadius / 0.34, 2);
    this.maxSpringForce = Math.max(30000, spec.mass * 33);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(opts.x, opts.y, opts.z)
        .setRotation({
          x: 0,
          y: Math.sin(opts.heading / 2),
          z: 0,
          w: Math.cos(opts.heading / 2),
        })
        // Aerodynamic drag is modelled explicitly; Rapier's linear damping
        // would add thousands of newtons at speed and cap the top end.
        .setLinearDamping(0.0)
        .setAngularDamping(0.18)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );

    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.88, 0.42, 2.05)
        .setTranslation(0, 0.02, 0)
        .setMassProperties(
          spec.mass,
          { x: 0, y: -0.12, z: 0 },
          {
            x: 2280 * (spec.mass / 1350),
            y: 2420 * (spec.mass / 1350),
            z: 560 * (spec.mass / 1350),
          },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.45)
        .setRestitution(0.12),
      this.body,
    );

    const mount: { name: Wheel['name']; x: number; z: number; front: boolean }[] = [
      { name: 'FL', x: -0.85, z: -1.32, front: true },
      { name: 'FR', x: 0.85, z: -1.32, front: true },
      { name: 'RL', x: -0.86, z: 1.3, front: false },
      { name: 'RR', x: 0.86, z: 1.3, front: false },
    ];

    this.wheels = mount.map((m) => ({
      name: m.name,
      mount: vec3(m.x, 0.12, m.z),
      front: m.front,
      radius: spec.wheelRadius,
      steer: 0,
      omega: 0,
      spinAngle: 0,
      contact: false,
      contactPoint: vec3(0, opts.y - 0.5, 0),
      contactNormal: vec3(0, 1, 0),
      suspensionLength: this.restLength,
      compression: 0,
      load: 0,
      forceLong: 0,
      forceLat: 0,
      slipAngle: 0,
      slipRatio: 0,
    }));

    this.telemetry = this.buildTelemetry(vec3(), 0);
  }

  get position(): Vec3 {
    const t = this.body.translation();
    return vec3(t.x, t.y, t.z);
  }

  get rotation(): Quat {
    const r = this.body.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  get state(): VehicleState {
    const v = this.body.linvel();
    return {
      position: this.position,
      rotation: this.rotation,
      velocity: vec3(v.x, v.y, v.z),
    };
  }

  get telemetryState(): VehicleTelemetry {
    return this.telemetry;
  }

  get isFlipped(): boolean {
    return this.flippedTimer > 1.4;
  }

  respawn(x: number, y: number, z: number, heading: number): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(
      { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) },
      true,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.drivetrain.reset();
    for (const w of this.wheels) {
      w.omega = 0;
      w.suspensionLength = this.restLength;
    }
    this.steerAngle = 0;
    this.flippedTimer = 0;
  }

  /** Called once per fixed physics tick. */
  step(dt: number, input: VehicleInput, world: RAPIER.World): void {
    const q = this.rotation;
    const pos = this.position;
    const up = upOf(q);
    const forward = forwardOf(q);
    const right = cross(forward, up);
    const linvel = this.body.linvel();
    const angvel = this.body.angvel();
    const velocity = vec3(linvel.x, linvel.y, linvel.z);
    const angular = vec3(angvel.x, angvel.y, angvel.z);
    const vLong = dot(velocity, forward);
    const vLat = dot(velocity, right);
    const speed = length(velocity);

    // --- Steering -----------------------------------------------------------
    // The lock is physical: a driver can grab a fistful of opposite lock at any
    // speed, and that is exactly how a slide is caught. Only normal, into-the-
    // corner input is trimmed with speed, so the car is not twitchy on a straight.
    const absSpeed = Math.abs(vLong);
    const bodySlip = Math.atan2(vLat, Math.max(absSpeed, 1.2));
    const countering = Math.abs(bodySlip) > 0.05 && input.steer * bodySlip > 0.05;
    const lock = countering
      ? this.spec.maxSteer
      : Math.max(0.16, this.spec.maxSteer / (1 + absSpeed * 0.052));
    const target = clamp(input.steer, -1, 1) * lock;
    // A rack takes time to travel, and it is slower the faster you go. Counter-
    // steering is the exception: hands fly across the wheel to catch a slide.
    const steerRate = countering
      ? this.spec.steerRate * 2.6
      : this.spec.steerRate / (1 + absSpeed * 0.05);
    const rate = Math.abs(target) > Math.abs(this.steerAngle) ? steerRate : 8.5;
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);

    // --- Drivetrain ---------------------------------------------------------
    const rearOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5;
    const drive = this.drivetrain.update(dt, rearOmega, input.throttle, input.brake, vLong);
    const driveTorquePerWheel = drive.axleTorque * 0.5;
    // In reverse the brake pedal is the reverse throttle, so the throttle pedal
    // is what slows the car down on its way back to first gear.
    const serviceBrake = this.drivetrain.gear === -1 ? input.throttle : input.brake;
    const totalRatio = Math.abs(this.drivetrain.ratio) * this.drivetrain.config.finalDrive;
    const rearInertia = drive.shifting
      ? this.wheelInertia
      : this.wheelInertia + ENGINE_INERTIA * totalRatio * totalRatio;

    // --- Wheels -------------------------------------------------------------
    const impulses: { impulse: Vec3; point: Vec3 }[] = [];
    let airborneCount = 0;
    let totalLoad = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      const mountWorld = add(pos, rotate(q, wheel.mount));
      const ray = new RAPIER.Ray(mountWorld, { x: -up.x, y: -up.y, z: -up.z });
      const maxRay = this.maxLength + wheel.radius;
      const hit = world.castRayAndGetNormal(
        ray,
        maxRay,
        true,
        undefined,
        undefined,
        this.collider,
        this.body,
      );

      wheel.steer = wheel.front ? -this.steerAngle : 0;

      if (!hit) {
        wheel.contact = false;
        wheel.load = 0;
        wheel.compression = 0;
        wheel.slipAngle = 0;
        wheel.slipRatio = 0;
        wheel.suspensionLength += (this.maxLength - wheel.suspensionLength) * Math.min(1, dt * 8);
        wheel.contactPoint = sub(mountWorld, { x: up.x * wheel.suspensionLength, y: up.y * wheel.suspensionLength, z: up.z * wheel.suspensionLength });
        wheel.spinAngle = (wheel.spinAngle + wheel.omega * dt) % (Math.PI * 2);
        airborneCount++;
        continue;
      }

      wheel.contact = true;
      const contactPoint = {
        x: ray.origin.x + ray.dir.x * hit.timeOfImpact,
        y: ray.origin.y + ray.dir.y * hit.timeOfImpact,
        z: ray.origin.z + ray.dir.z * hit.timeOfImpact,
      };
      const normal = vec3(hit.normal.x, hit.normal.y, hit.normal.z);
      wheel.contactPoint = contactPoint;
      wheel.contactNormal = normal;

      const suspensionLength = clamp(hit.timeOfImpact - wheel.radius, MIN_LENGTH, this.maxLength);
      wheel.suspensionLength = suspensionLength;
      const compression = this.restLength - suspensionLength;
      wheel.compression = compression;

      const arm = sub(mountWorld, pos);
      const pointVel = add(velocity, cross(angular, arm));
      const vAlongUp = dot(pointVel, up);

      let springForce = this.spec.springK * compression + this.spec.springC * -vAlongUp;
      if (compression > this.bumpStop) {
        const over = compression - this.bumpStop;
        springForce += BUMP_K * over + BUMP_K_HARD * over * over;
      }
      springForce = clamp(springForce, 0, this.maxSpringForce);

      // Wheel frame, steered around the body's up axis.
      const wheelForward = rotateAxis(forward, up, wheel.steer);
      const wheelRight = cross(wheelForward, up);
      const contactArm = sub(contactPoint, pos);
      const contactVel = add(velocity, cross(angular, contactArm));
      const cvLong = dot(contactVel, wheelForward);
      const cvLat = dot(contactVel, wheelRight);

      const alpha = slipAngleFromVelocity(cvLong, cvLat);
      const mu = wheel.front ? this.spec.muFront : this.spec.muRear;
      const peakAngle = this.spec.peakSlipAngle;
      wheel.slipAngle = alpha;
      wheel.load = springForce;
      totalLoad += springForce;

      let forces;
      if (wheel.front) {
        // The un-driven front axle is modelled as free rolling: this avoids the
        // stiff wheel-spin limit cycle at speed. Braking is a slip target so the
        // combined-slip ellipse still takes lateral grip away under braking.
        wheel.omega = cvLong / wheel.radius;
        // The slip target has to follow the direction of travel: a fixed negative
        // value pushed the car backwards while it was reversing, which is what
        // made the car impossible to stop and never let it roll forward again.
        const kappa =
          Math.abs(cvLong) < 0.3
            ? 0
            : -serviceBrake * 0.085 * Math.sign(cvLong);
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: springForce, mu, peakAngle });
      } else {
        const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, cvLong);
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: springForce, mu, peakAngle });
        // ABS: back off the rear brakes when the wheel starts locking, the way
        // a road-going sports car does. The handbrake bypasses it on purpose.
        const absFactor =
          serviceBrake > 0.15 && Math.abs(kappa) > 0.14 && Math.abs(cvLong) > 2 ? 0.3 : 1;
        const brakeTorque =
          serviceBrake * this.spec.brakeTorque * absFactor + (input.handbrake ? 2200 : 0);
        this.integrateWheelSpin(
          wheel,
          dt,
          driveTorquePerWheel,
          brakeTorque,
          cvLong,
          alpha,
          springForce,
          mu,
          peakAngle,
          rearInertia,
        );
      }

      wheel.forceLong = forces.fx;
      wheel.forceLat = forces.fy;
      const tireImpulse = {
        x: (wheelForward.x * forces.fx + wheelRight.x * forces.fy) * dt,
        y: (wheelForward.y * forces.fx + wheelRight.y * forces.fy) * dt,
        z: (wheelForward.z * forces.fx + wheelRight.z * forces.fy) * dt,
      };

      // Suspension + tire forces at the contact patch.
      const suspensionImpulse = { x: normal.x * springForce * dt, y: normal.y * springForce * dt, z: normal.z * springForce * dt };
      impulses.push({
        impulse: add(suspensionImpulse, tireImpulse),
        point: contactPoint,
      });

    }

    // --- Anti-roll bars -----------------------------------------------------
    this.applyAntiRollBar(0, 1, this.spec.arbFront, dt, impulses);
    this.applyAntiRollBar(2, 3, this.spec.arbRear, dt, impulses);

    for (const { impulse, point } of impulses) {
      this.body.applyImpulseAtPoint(impulse, point, true);
    }

    // --- Aerodynamics and rolling resistance --------------------------------
    if (speed > 0.5) {
      const rolling = 0.0135 * totalLoad * Math.sign(vLong);
      this.body.applyImpulse(
        { x: -forward.x * rolling * dt, y: 0, z: -forward.z * rolling * dt },
        true,
      );
    }
    if (speed > 0.5) {
      const drag = 0.5 * 1.225 * this.spec.dragArea * speed;
      const dragImpulse = {
        x: -velocity.x * drag * dt,
        y: -velocity.y * drag * dt,
        z: -velocity.z * drag * dt,
      };
      this.body.applyImpulse(dragImpulse, true);
    }
    const downforce = 0.5 * 1.225 * this.spec.downforceArea * speed * speed;
    this.body.applyImpulse({ x: 0, y: -downforce * dt, z: 0 }, true);

    // --- Telemetry ----------------------------------------------------------
    this.accelLong = (vLong - this.prevSpeed) / Math.max(dt, 1e-4);
    this.accelLat = vLat;
    this.prevSpeed = vLong;

    this.telemetry = this.buildTelemetry(velocity, bodySlip);
    this.telemetry.rpm = drive.rpm;
    this.telemetry.gear = drive.gear;
    this.telemetry.shifting = drive.shifting;
    this.telemetry.throttle = input.throttle;
    this.telemetry.brake = input.brake;
    this.telemetry.handbrake = input.handbrake;
    this.telemetry.airborne = airborneCount === 4;
    this.telemetry.speed = speed;
    this.telemetry.speedKmh = speed * 3.6;

    // --- Parking hold -------------------------------------------------------
    // Tire forces are noisy at ~0 m/s; without this the car slowly creeps
    // while parked. Only the horizontal velocity is cancelled: the vertical
    // one carries the suspension, so it must be read *after* the impulses were
    // applied (using the stale value here would pin the body on its bump stops).
    // It must not run while a pedal is down, or it cancels every attempt to pull
    // away from a standstill, reverse included.
    if (input.throttle < 0.03 && input.brake < 0.03 && speed < 0.45 && airborneCount < 4) {
      const current = this.body.linvel();
      this.body.setLinvel({ x: 0, y: current.y, z: 0 }, true);
    }

    // --- Upside-down recovery ----------------------------------------------
    const upDot = dot(up, vec3(0, 1, 0));
    this.flippedTimer = upDot < 0.25 ? this.flippedTimer + dt : 0;
  }

  /**
   * Wheel spin is stiff: a 1.6 kg·m² wheel with a 0.34 m radius can be
   * accelerated by thousands of rad/s² when the tire saturates. Integrating it
   * explicitly at 120 Hz makes the tire chatter, so the longitudinal tire
   * stiffness is handled semi-implicitly, which stays stable at any inertia.
   */
  private integrateWheelSpin(
    wheel: Wheel,
    dt: number,
    driveTorque: number,
    brakeTorque: number,
    vLong: number,
    alpha: number,
    fz: number,
    mu: number,
    peakAngle: number,
    inertia: number,
  ): void {
    const substeps = 3;
    const h = dt / substeps;
    const stiffness = (mu * fz) / KAPPA_PEAK;
    const vRef = Math.max(Math.abs(vLong), 2.5);
    for (let s = 0; s < substeps; s++) {
      const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, vLong);
      const fx = tireForces({ kappa, alpha, fz, mu, peakAngle }).fx;
      const implicit = (stiffness * wheel.radius * wheel.radius * h) / (vRef * inertia);
      const free = wheel.omega + ((driveTorque - fx * wheel.radius) / inertia) * h;
      // Damp the increment only: the implicit term must not drag the wheel
      // toward a standstill, only absorb the tire stiffness overshoot.
      wheel.omega += (free - wheel.omega) / (1 + implicit);
      const stop = Math.min(Math.abs(wheel.omega), (brakeTorque * h) / inertia);
      wheel.omega -= Math.sign(wheel.omega) * stop;
      if (!Number.isFinite(wheel.omega)) wheel.omega = 0;
      wheel.omega = clamp(wheel.omega, -260, 400);
    }
    wheel.spinAngle = (wheel.spinAngle + wheel.omega * dt) % (Math.PI * 2);
  }

  private applyAntiRollBar(
    leftIndex: number,
    rightIndex: number,
    stiffness: number,
    dt: number,
    impulses: { impulse: Vec3; point: Vec3 }[],
  ): void {
    const left = this.wheels[leftIndex];
    const right = this.wheels[rightIndex];
    if (!left.contact || !right.contact) return;
    // A stiffer spring on the compressed side, a softer one on the drooping
    // side: the bar must *resist* the roll, so the compressed corner gets
    // pushed back up and the unloaded corner is pulled down.
    const diff = left.compression - right.compression;
    const force = clamp(stiffness * diff, -9000, 9000);
    const upLeft = left.contactNormal;
    const upRight = right.contactNormal;
    impulses.push({
      impulse: { x: upLeft.x * force * dt, y: upLeft.y * force * dt, z: upLeft.z * force * dt },
      point: left.contactPoint,
    });
    impulses.push({
      impulse: { x: -upRight.x * force * dt, y: -upRight.y * force * dt, z: -upRight.z * force * dt },
      point: right.contactPoint,
    });
  }

  private buildTelemetry(velocity: Vec3, bodySlip: number): VehicleTelemetry {
    const speed = length(velocity);
    return {
      speed,
      speedKmh: speed * 3.6,
      rpm: this.drivetrain.rpm,
      gear: this.drivetrain.gear,
      shifting: false,
      throttle: 0,
      brake: 0,
      handbrake: false,
      slipAngle: bodySlip,
      driftAngleDeg: (Math.abs(bodySlip) * 180) / Math.PI,
      lateralAccel: 0,
      airborne: false,
      wheels: this.wheels.map((w) => {
        const pos = this.position;
        const q = this.rotation;
        return {
          name: w.name,
          contact: w.contact,
          steer: w.steer,
          spinAngle: w.spinAngle,
          omega: w.omega,
          suspensionLength: w.suspensionLength,
          load: w.load,
          forceLong: w.forceLong,
          forceLat: w.forceLat,
          slipAngle: w.slipAngle,
          slipRatio: w.slipRatio,
          worldPosition: add(pos, rotate(q, w.mount)),
        };
      }),
    };
  }

  /** Grip level at the rear axle, useful for the tire squeal audio. */
  rearSlipIntensity(): number {
    let sum = 0;
    for (const w of this.wheels) {
      if (!w.contact) continue;
      sum += Math.min(1, Math.abs(w.slipAngle) / 0.35);
    }
    return sum / 4;
  }
}

export { lateralGrip };
