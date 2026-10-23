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

const WHEEL_RADIUS = 0.34;
const REST_LENGTH = 0.4;
const MAX_LENGTH = 0.56;
const BUMP_STOP = 0.185;
const SPRING_K = 34000;
const SPRING_C = 3000;
const BUMP_K = 220000;
const ARB_FRONT = 14000;
const ARB_REAR = 9000;
const WHEEL_INERTIA = 1.6;
/** Reflected engine inertia, multiplied by the squared total gear ratio. */
const ENGINE_INERTIA = 0.22;
const MASS = 1350;

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly drivetrain = new Drivetrain(SPORT_DRIVETRAIN);

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
  ) {
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
          MASS,
          { x: 0, y: -0.12, z: 0 },
          { x: 2280, y: 2420, z: 560 },
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
      radius: WHEEL_RADIUS,
      steer: 0,
      omega: 0,
      spinAngle: 0,
      contact: false,
      contactPoint: vec3(0, opts.y - 0.5, 0),
      contactNormal: vec3(0, 1, 0),
      suspensionLength: REST_LENGTH,
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
      w.suspensionLength = REST_LENGTH;
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
    const speedFactor = 1 / (1 + Math.abs(vLong) * 0.052);
    const maxSteer = 0.6 * speedFactor;
    const target = clamp(input.steer, -1, 1) * maxSteer;
    const rate = Math.abs(target) > Math.abs(this.steerAngle) ? 3.4 : 7.5;
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);

    // --- Drivetrain ---------------------------------------------------------
    const rearOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5;
    const drive = this.drivetrain.update(dt, rearOmega, input.throttle, input.brake, vLong);
    const driveTorquePerWheel = drive.axleTorque * 0.5;
    const serviceBrake = this.drivetrain.gear === -1 ? input.throttle : input.brake;
    const totalRatio = Math.abs(this.drivetrain.ratio) * this.drivetrain.config.finalDrive;
    const rearInertia = drive.shifting
      ? WHEEL_INERTIA
      : WHEEL_INERTIA + ENGINE_INERTIA * totalRatio * totalRatio;

    // --- Wheels -------------------------------------------------------------
    const impulses: { impulse: Vec3; point: Vec3 }[] = [];
    let airborneCount = 0;
    let totalLoad = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      const mountWorld = add(pos, rotate(q, wheel.mount));
      const ray = new RAPIER.Ray(mountWorld, { x: -up.x, y: -up.y, z: -up.z });
      const maxRay = MAX_LENGTH + wheel.radius;
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
        wheel.suspensionLength += (MAX_LENGTH - wheel.suspensionLength) * Math.min(1, dt * 8);
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

      const suspensionLength = clamp(hit.timeOfImpact - wheel.radius, 0.06, MAX_LENGTH);
      wheel.suspensionLength = suspensionLength;
      const compression = REST_LENGTH - suspensionLength;
      wheel.compression = compression;

      const arm = sub(mountWorld, pos);
      const pointVel = add(velocity, cross(angular, arm));
      const vAlongUp = dot(pointVel, up);

      let springForce = SPRING_K * compression + SPRING_C * -vAlongUp;
      if (compression > BUMP_STOP) {
        springForce += BUMP_K * (compression - BUMP_STOP);
      }
      springForce = clamp(springForce, 0, 26000);

      // Wheel frame, steered around the body's up axis.
      const wheelForward = rotateAxis(forward, up, wheel.steer);
      const wheelRight = cross(wheelForward, up);
      const contactArm = sub(contactPoint, pos);
      const contactVel = add(velocity, cross(angular, contactArm));
      const cvLong = dot(contactVel, wheelForward);
      const cvLat = dot(contactVel, wheelRight);

      const alpha = slipAngleFromVelocity(cvLong, cvLat);
      const mu = (wheel.front ? 1.24 : 1.2) * 0.98;
      wheel.slipAngle = alpha;
      wheel.load = springForce;
      totalLoad += springForce;

      let forces;
      if (wheel.front) {
        // The un-driven front axle is modelled as free rolling: this avoids the
        // stiff wheel-spin limit cycle at speed. Braking is a slip target so the
        // combined-slip ellipse still takes lateral grip away under braking.
        wheel.omega = cvLong / wheel.radius;
        const kappa = Math.abs(cvLong) < 0.3 ? 0 : -serviceBrake * 0.085;
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: springForce, mu });
      } else {
        const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, cvLong);
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: springForce, mu });
        // ABS: back off the rear brakes when the wheel starts locking, the way
        // a road-going sports car does. The handbrake bypasses it on purpose.
        const absFactor =
          serviceBrake > 0.15 && Math.abs(kappa) > 0.14 && Math.abs(cvLong) > 2 ? 0.3 : 1;
        const brakeTorque = serviceBrake * 1250 * absFactor + (input.handbrake ? 5000 : 0);
        this.integrateWheelSpin(
          wheel,
          dt,
          driveTorquePerWheel,
          brakeTorque,
          cvLong,
          alpha,
          springForce,
          mu,
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
    this.applyAntiRollBar(0, 1, ARB_FRONT, dt, impulses);
    this.applyAntiRollBar(2, 3, ARB_REAR, dt, impulses);

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
      const drag = 0.5 * 1.225 * 0.33 * 2.15 * speed;
      const dragImpulse = {
        x: -velocity.x * drag * dt,
        y: -velocity.y * drag * dt,
        z: -velocity.z * drag * dt,
      };
      this.body.applyImpulse(dragImpulse, true);
    }
    const downforce = 0.5 * 1.225 * 0.55 * 1.7 * speed * speed;
    this.body.applyImpulse({ x: 0, y: -downforce * dt, z: 0 }, true);

    // --- Telemetry ----------------------------------------------------------
    const bodySlip = Math.atan2(vLat, Math.max(Math.abs(vLong), 1.2));
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
    // while parked. A real car in gear would either creep forward or stall.
    if (input.throttle < 0.03 && speed < 0.45) {
      this.body.setLinvel({ x: 0, y: linvel.y, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
    inertia: number,
  ): void {
    const substeps = 3;
    const h = dt / substeps;
    const stiffness = (mu * fz) / KAPPA_PEAK;
    const vRef = Math.max(Math.abs(vLong), 2.5);
    for (let s = 0; s < substeps; s++) {
      const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, vLong);
      const fx = tireForces({ kappa, alpha, fz, mu }).fx;
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
    const diff = left.compression - right.compression;
    const force = clamp(stiffness * diff, -9000, 9000);
    const upLeft = left.contactNormal;
    const upRight = right.contactNormal;
    impulses.push({
      impulse: { x: -upLeft.x * force * dt, y: -upLeft.y * force * dt, z: -upLeft.z * force * dt },
      point: left.contactPoint,
    });
    impulses.push({
      impulse: { x: upRight.x * force * dt, y: upRight.y * force * dt, z: upRight.z * force * dt },
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
