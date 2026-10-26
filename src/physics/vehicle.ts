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

/**
 * What the wheels are rolling on. The physics only needs multipliers, so the
 * world can describe asphalt, gravel, grass or rock without the tire model
 * knowing anything about the map.
 */
export interface SurfaceGrip {
  kind: string;
  /** Multiplier on the tire friction coefficient. */
  grip: number;
  /** Multiplier on the peak slip angle: loose ground slides earlier, but over a
   *  wider window, so it is forgiving instead of snappy. */
  peak: number;
  /** Multiplier on rolling resistance. */
  rolling: number;
  /** 0..1, how much the ground rumbles (audio, camera). */
  roughness: number;
}

const ASPHALT: SurfaceGrip = { kind: 'asphalte', grip: 1, peak: 1, rolling: 1, roughness: 0 };

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
  /** Ground normal under the contact patch: the bike follows it visually. */
  contactNormal?: Vec3;
  contactPoint?: Vec3;
}

export interface VehicleTelemetry {
  speed: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  shifting: boolean;
  /** Rev limiter is cutting fuel this tick. */
  limiter: boolean;
  /** Ground under the car. */
  surface: SurfaceGrip;
  throttle: number;
  brake: number;
  handbrake: boolean;
  slipAngle: number;
  driftAngleDeg: number;
  lateralAccel: number;
  airborne: boolean;
  wheels: WheelTelemetry[];
  /** Filled in by the bike; a car leaves these undefined. */
  lean?: number;
  pitch?: number;
  wheelie?: boolean;
  bavette?: boolean;
  looped?: boolean;
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
  /**
   * Grip multiplier on anything that is not asphalt. A gravel tire is worse on
   * tarmac and much better in the dirt; without this, fitting the "tout-terrain"
   * set simply lowered the friction everywhere and made the rally car useless.
   */
  looseGrip: number;
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
  /** Distance between the axles, m. */
  wheelbase: number;
  /** Distance between the left and right wheel centres, m. */
  track: number;
  /** Collider half extents: across, up, along. */
  bodyHalf: { x: number; y: number; z: number };
  /** Share of the drive torque sent to the front axle, 0..1. */
  driveFront: number;
  /**
   * Traction control, 0..1. It caps the axle torque at the grip the driven
   * tires actually have, which is what stops first gear from sitting on the
   * limiter with the wheels in the air. 0 leaves the throttle entirely to the
   * driver, 1 never lets the tires spin past their peak.
   */
  tractionControl: number;
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
  looseGrip: 1,
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
  wheelbase: 2.62,
  track: 1.712,
  bodyHalf: { x: 0.88, y: 0.42, z: 2.05 },
  driveFront: 0,
  tractionControl: 0.5,
};

/**
 * The chassis box is a shell for walls, buildings and other cars, not a floor
 * pan. It used to collide with the terrain, and that was the "invisible wall":
 * at speed the nose dips into the ground on a crest, and a box resolving that
 * penetration against a trimesh kills every bit of speed in a single tick. The
 * wheels carry the car -- they are raycasts, not bodies -- so the body only has
 * to collide with the ground once the car is on its side or its roof.
 *
 * Collision groups: bit 0 is the ground, bit 1 everything else. Membership is
 * the high half, the filter the low half.
 */
export const GROUP_GROUND = 0x0001;
export const GROUP_WORLD = 0x0002;
const CHASSIS_UPRIGHT = (GROUP_WORLD << 16) | GROUP_WORLD;
const CHASSIS_ROLLED = (GROUP_WORLD << 16) | (GROUP_WORLD | GROUP_GROUND);
/** Above ~53° of roll the body is what lands, not the tires. */
const ROLLED_UP_DOT = 0.6;
/**
 * Lifting the shell also buys clearance over kerbs, and makes the collision box
 * match the body a driver sees rather than the floor pan.
 */
const CHASSIS_LIFT = 0.12;

const MIN_LENGTH = 0.06;
/** First-stage bump stop: firm, but it lets the body settle instead of jamming. */
const BUMP_K = 90000;
/** Second stage, only reached in a real impact. */
const BUMP_K_HARD = 1_600_000;
/**
 * Reflected engine inertia, multiplied by the squared total gear ratio. It is
 * carried by the rear axle: a flywheel that keeps the back end from snapping
 * round the instant it loses grip, and the torque the tires have to fight when
 * they spin up.
 */
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
  private readonly surfaceAt: (x: number, z: number) => SurfaceGrip;
  /** Ground under the car, for telemetry and audio. */
  surface: SurfaceGrip = ASPHALT;
  private flippedTimer = 0;
  private rolled = false;
  private prevSpeed = 0;
  /** Signed longitudinal acceleration estimate, m/s². */
  accelLong = 0;
  accelLat = 0;
  /** What the traction control let through this tick, Nm. */
  driveTorque = 0;
  /**
   * Master switch for the assist. Off leaves the throttle entirely to the
   * driver, which is the only way to hold a drift: a per-wheel cap keeps
   * pulling the rear back under the car the moment it spins up.
   */
  tcsEnabled = true;

  constructor(
    world: RAPIER.World,
    opts: {
      x: number;
      y: number;
      z: number;
      heading: number;
      color?: number;
      /** Ground lookup, in world X/Z. Defaults to dry asphalt everywhere. */
      surfaceAt?: (x: number, z: number) => SurfaceGrip;
    },
    spec: VehicleSpec = STOCK_SPEC,
  ) {
    this.spec = spec;
    this.surfaceAt = opts.surfaceAt ?? (() => ASPHALT);
    this.drivetrain = new Drivetrain({
      ...SPORT_DRIVETRAIN,
      peakTorque: spec.peakTorque,
      peakTorqueRpm: spec.peakTorqueRpm,
      redlineRpm: spec.redlineRpm,
      upshiftRpm: spec.upshiftRpm,
      finalDrive: spec.finalDrive,
      wheelRadius: spec.wheelRadius,
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
      RAPIER.ColliderDesc.cuboid(spec.bodyHalf.x, spec.bodyHalf.y, spec.bodyHalf.z)
        .setTranslation(0, 0.02 + CHASSIS_LIFT, 0)
        .setCollisionGroups(CHASSIS_UPRIGHT)
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
        .setFriction(0.05)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0),
      this.body,
    );

    const halfTrack = spec.track / 2;
    const halfBase = spec.wheelbase / 2;
    const mount: { name: Wheel['name']; x: number; z: number; front: boolean }[] = [
      { name: 'FL', x: -halfTrack, z: -halfBase, front: true },
      { name: 'FR', x: halfTrack, z: -halfBase, front: true },
      { name: 'RL', x: -halfTrack, z: halfBase, front: false },
      { name: 'RR', x: halfTrack, z: halfBase, front: false },
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
    const driveFront = clamp(this.spec.driveFront, 0, 1);
    // The gearbox reads the driven wheels, weighted by the torque split: an
    // all-wheel-drive car sees all four, a rear-drive car only the back axle.
    let drivenOmega = 0;
    let drivenWeight = 0;
    for (const w of this.wheels) {
      const share = w.front ? driveFront : 1 - driveFront;
      drivenOmega += w.omega * share;
      drivenWeight += share;
    }
    drivenOmega /= Math.max(drivenWeight, 1e-3);
    const groundSpeed = Math.hypot(vLong, vLat);
    const drive = this.drivetrain.update(
      dt,
      drivenOmega,
      input.throttle,
      input.brake,
      vLong,
      groundSpeed,
    );

    // --- Traction control ---------------------------------------------------
    // One wheel at a time, not one axle at a time. With an open differential
    // the unloaded inside wheel is always the first to light up, and a single
    // spinning tire takes the whole axle's lateral grip with it: that is why an
    // all-wheel-drive car used to plow through a corner while the front inside
    // tire was at twice its slip peak. Capping each wheel against its own
    // contact patch leaves the other three driving and steering.
    const tc = this.tcsEnabled ? clamp(this.spec.tractionControl, 0, 1) : 0;
    // Only the handbrake turns the assist off. It used to cut out once the car
    // was sliding more than 20°, and that was exactly backwards on gravel: the
    // first hint of angle let all four wheels light up, the front tires lost
    // the lateral grip that was holding the line, and the slide fed itself.
    const tcActive = tc > 0 && !input.handbrake;
    // Allowed wheelspin grows as the assist is turned down. It does *not* grow
    // with the slide angle: letting the wheels spin harder once the car is
    // already sideways takes lateral grip off the rear and feeds the spin.
    const targetSlip = 0.11 + (1 - tc) * 0.22;
    this.driveTorque = 0;
    // In reverse the brake pedal is the reverse throttle, so the throttle pedal
    // is what slows the car down on its way back to first gear.
    const serviceBrake = this.drivetrain.gear === -1 ? input.throttle : input.brake;
    const totalRatio = Math.abs(this.drivetrain.ratio) * this.drivetrain.config.finalDrive;
    // The front axle is coupled by a clutch pack, not a spool: it carries its
    // own wheel inertia and a fraction of the engine's, so it spins up quickly
    // instead of dragging against the car through a 15:1 first gear.
    // Only a locked clutch drags the flywheel around with the wheels. Through
    // first gear the reflected inertia is worth about a tonne of extra mass, so
    // charging it to the wheels during a launch was what made every car feel
    // gutless below 40 km/h.
    const reflected = drive.shifting
      ? 0
      : ENGINE_INERTIA * totalRatio * totalRatio * (1 - drive.clutchSlip);
    // The flywheel is shared by both wheels of an axle: charging the whole
    // reflected inertia to each wheel doubled the rotating mass the car had to
    // drag, which is why first gear still felt flat after the launch fix.
    const frontInertia = this.wheelInertia + reflected * driveFront * 0.5;
    const rearInertia = this.wheelInertia + reflected * (1 - driveFront) * 0.5;

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
      const ground = this.surfaceAt(contactPoint.x, contactPoint.z);
      const loose = ground.kind !== 'asphalte';
      const mu =
        (wheel.front ? this.spec.muFront : this.spec.muRear) *
        ground.grip *
        (loose ? this.spec.looseGrip : 1);
      const peakAngle = this.spec.peakSlipAngle * ground.peak;
      wheel.slipAngle = alpha;
      wheel.load = springForce;
      totalLoad += springForce;

      // How much of the engine's torque this corner can actually put down. The
      // cap is the force the tire makes at the target slip, so it moves with
      // the load transfer instead of assuming a static quarter of the weight.
      const share = wheel.front ? driveFront : 1 - driveFront;
      let wheelDrive = 0;
      if (share > 0.01) {
        wheelDrive = drive.axleTorque * share * 0.5;
        if (tcActive) {
          const atTarget = tireForces({
            kappa: targetSlip,
            alpha: 0,
            fz: springForce,
            mu,
            peakAngle,
          });
          const cap = Math.abs(atTarget.fx) * wheel.radius * 1.05;
          wheelDrive = clamp(wheelDrive, -cap, cap);
          // Proportional trim above the target: spinning harder gets less
          // torque, but never none, so the wheel keeps pulling instead of
          // gripping, spinning and gripping again every few ticks.
          const over = Math.abs(wheel.slipRatio) - targetSlip;
          if (over > 0) wheelDrive *= clamp(1 - over * 6, 0.25, 1);
        }
        this.driveTorque += wheelDrive;
      }

      let forces;
      if (share <= 0.01) {
        // The un-driven axle is modelled as free rolling: this avoids the stiff
        // wheel-spin limit cycle at speed. Braking is a slip target so the
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
        // ABS: back off the brakes when the wheel starts locking, the way a
        // road-going sports car does. The handbrake bypasses it on purpose, and
        // only the rear axle has one.
        const absFactor =
          serviceBrake > 0.15 && Math.abs(kappa) > 0.14 && Math.abs(cvLong) > 2 ? 0.3 : 1;
        const brakeTorque =
          serviceBrake * this.spec.brakeTorque * absFactor +
          (input.handbrake && !wheel.front ? 1800 : 0);
        this.integrateWheelSpin(
          wheel,
          dt,
          wheelDrive,
          brakeTorque,
          cvLong,
          alpha,
          springForce,
          mu,
          peakAngle,
          wheel.front ? frontInertia : rearInertia,
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
      // Loose ground drags at the wheels far more than tarmac does.
      const rolling = 0.0135 * totalLoad * this.surface.rolling * Math.sign(vLong);
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
    this.surface = this.surfaceAt(pos.x, pos.z);
    this.telemetry.surface = this.surface;
    this.telemetry.rpm = drive.rpm;
    this.telemetry.gear = drive.gear;
    this.telemetry.shifting = drive.shifting;
    this.telemetry.limiter = drive.limiter;
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
    // On its side or its roof the tires cannot hold anything up, so the shell
    // takes the ground back. Upright, the wheels are the only contact.
    const rolled = upDot < ROLLED_UP_DOT;
    if (rolled !== this.rolled) {
      this.rolled = rolled;
      this.collider.setCollisionGroups(rolled ? CHASSIS_ROLLED : CHASSIS_UPRIGHT);
    }
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
      limiter: false,
      surface: ASPHALT,
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
