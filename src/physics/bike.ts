import RAPIER from '@dimforge/rapier3d-compat';

/** Normale minimale pour qu'un rayon soit un appui au sol, pas une face de mur. */
const GROUND_NORMAL_MIN = 0.55;
/** Vitesse maximale du débattement, en m/s : amortit les marches du trimesh. */
const SUSPENSION_RATE = 5.5;
import { Drivetrain, SPORT_DRIVETRAIN } from './drivetrain.ts';
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
import { slipAngleFromVelocity, slipRatioFromWheelSpeed, tireForces, KAPPA_PEAK } from './tire.ts';
import {
  GROUP_RAGDOLL,
  GROUP_WORLD,
  type SurfaceGrip,
  type VehicleInput,
  type VehicleState,
  type VehicleTelemetry,
  type WheelTelemetry,
} from './vehicle.ts';
import {
  BAVETTE_ANGLE,
  LOOP_ANGLE,
  leanFor,
  wheelieAcceleration,
  type WheelieGeometry,
} from './wheelie.ts';

/** Two wheels in line: the chassis only ever collides with the street furniture. */
const CHASSIS_GROUPS = (GROUP_WORLD << 16) | (GROUP_WORLD | GROUP_RAGDOLL);
const ASPHALT: SurfaceGrip = { kind: 'asphalte', grip: 1, peak: 1, rolling: 1, roughness: 0 };
const MIN_LENGTH = 0.05;
const BUMP_K = 90000;

/**
 * Everything the supermotard is made of. The physics only reads this object,
 * so a different bike would be another spec rather than another step function.
 */
export interface BikeSpec {
  name: string;
  mass: number;
  peakTorque: number;
  peakTorqueRpm: number;
  redlineRpm: number;
  upshiftRpm: number;
  ratios: number[];
  finalDrive: number;
  wheelbase: number;
  wheelRadius: number;
  wheelWidthFront: number;
  wheelWidthRear: number;
  muFront: number;
  muRear: number;
  peakSlipAngle: number;
  looseGrip: number;
  brakeTorque: number;
  maxSteer: number;
  steerRate: number;
  dragArea: number;
  downforceArea: number;
  springK: number;
  springC: number;
  wheelTravel: number;
  /** Barycentre height over the ground, m. */
  cgHeight: number;
  /** Barycentre distance behind the front contact... measured from the rear. */
  cgFromRear: number;
  maxLean: number;
  /** How much of the axle torque lifts the front. */
  wheelieGain: number;
}

interface BikeWheel {
  /** FL is the front wheel, RL the rear: the HUD and smoke code expect these
   *  names, and a bike has one of each. */
  name: 'FL' | 'RL';
  front: boolean;
  mount: Vec3;
  radius: number;
  width: number;
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

export class Bike {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly spec: BikeSpec;
  readonly drivetrain: Drivetrain;

  readonly restLength: number;
  readonly maxLength: number;
  readonly bumpStop: number;

  /** Visual lean, positive to the right, radians. */
  lean = 0;
  /** Chassis pitch about the rear contact, positive nose-up, radians. */
  pitch = 0;
  pitchVelocity = 0;
  yawRate = 0;
  /** Torque the rear tire gets this tick, for the HUD and the sound effects. */
  driveTorque = 0;
  tcsEnabled = false;
  surface: SurfaceGrip = ASPHALT;

  private readonly wheelieGeometry: WheelieGeometry;
  private readonly wheels: BikeWheel[];
  private steerAngle = 0;
  private telemetry: VehicleTelemetry;
  private readonly surfaceAt: (x: number, z: number) => SurfaceGrip;
  /** Cote analytique du sol : elle existe même là où le trimesh a un trou. */
  private readonly floorAt: ((x: number, z: number, reference?: number) => number | null) | null;
  private popCooldown = 0;
  private bailTimer = 0;
  /** Time the rider has held the brake at a standstill: he walks it back. */
  private pushTimer = 0;
  /** True while the bike is being pushed backwards, feet down. */
  pushingBack = false;
  private prevLong = 0;
  /** Smoothed longitudinal acceleration, m/s²: drives the weight transfer. */
  longAccel = 0;
  private readonly wheelInertia = 1.1;
  private readonly maxSpringForce: number;

  constructor(
    world: RAPIER.World,
    opts: {
      x: number;
      y: number;
      z: number;
      heading: number;
      surfaceAt?: (x: number, z: number) => SurfaceGrip;
      /** Hauteur du sol, en X/Z : filet quand le rayon de roue ne touche rien. */
      floorAt?: (x: number, z: number, reference?: number) => number | null;
    },
    spec: BikeSpec,
  ) {
    this.spec = spec;
    this.surfaceAt = opts.surfaceAt ?? (() => ASPHALT);
    this.floorAt = opts.floorAt ?? null;
    this.wheelieGeometry = {
      cgHeight: spec.cgHeight,
      cgFromRear: spec.cgFromRear,
      wheelbase: spec.wheelbase,
      liftGain: spec.wheelieGain,
    };
    this.drivetrain = new Drivetrain({
      ...SPORT_DRIVETRAIN,
      ratios: spec.ratios,
      reverseRatio: 2.6,
      finalDrive: spec.finalDrive,
      peakTorque: spec.peakTorque,
      peakTorqueRpm: spec.peakTorqueRpm,
      redlineRpm: spec.redlineRpm,
      upshiftRpm: spec.upshiftRpm,
      downshiftRpm: 2400,
      wheelRadius: spec.wheelRadius,
      allowReverse: false,
    });
    const staticCompression = (spec.mass * 9.81) / (2 * spec.springK);
    this.restLength = spec.cgHeight - spec.wheelRadius + staticCompression;
    this.maxLength = this.restLength + spec.wheelTravel;
    this.bumpStop = this.restLength - spec.wheelTravel * 0.7;
    this.maxSpringForce = Math.max(16000, spec.mass * 22);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(opts.x, opts.y, opts.z)
        .setRotation({ x: 0, y: Math.sin(opts.heading / 2), z: 0, w: Math.cos(opts.heading / 2) })
        .setLinearDamping(0)
        .setAngularDamping(0.05)
        .setCcdEnabled(true)
        .setCanSleep(false)
        // A bike does not lie on its side in this game: the roll and the pitch
        // are simulated as the lean and the wheelie, and the body itself only
        // turns around the vertical. That keeps the two contact patches exactly
        // where the rider sees them instead of letting a raycast bike fall over
        // at the first red light.
        .enabledRotations(false, true, false),
    );

    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.3, 0.48, 0.9)
        .setTranslation(0, 0.02, 0)
        .setCollisionGroups(CHASSIS_GROUPS)
        .setMassProperties(
          spec.mass,
          { x: 0, y: 0, z: 0 },
          { x: 60, y: 82, z: 34 },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.05)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0),
      this.body,
    );

    const halfBase = spec.wheelbase / 2;
    this.wheels = [
      {
        name: 'FL',
        front: true,
        mount: vec3(0, 0, -halfBase),
        radius: spec.wheelRadius,
        width: spec.wheelWidthFront,
        steer: 0,
        omega: 0,
        spinAngle: 0,
        contact: false,
        contactPoint: vec3(0, opts.y - spec.wheelRadius, 0),
        contactNormal: vec3(0, 1, 0),
        suspensionLength: this.restLength,
        compression: 0,
        load: 0,
        forceLong: 0,
        forceLat: 0,
        slipAngle: 0,
        slipRatio: 0,
      },
      {
        name: 'RL',
        front: false,
        mount: vec3(0, 0, halfBase),
        radius: spec.wheelRadius,
        width: spec.wheelWidthRear,
        steer: 0,
        omega: 0,
        spinAngle: 0,
        contact: false,
        contactPoint: vec3(0, opts.y - spec.wheelRadius, 0),
        contactNormal: vec3(0, 1, 0),
        suspensionLength: this.restLength,
        compression: 0,
        load: 0,
        forceLong: 0,
        forceLat: 0,
        slipAngle: 0,
        slipRatio: 0,
      },
    ];

    this.telemetry = this.buildTelemetry(vec3(), 0, false);
    // Settle on the springs before the first frame: the body is spawned at the
    // static height, but the solver needs the contact patch to exist.
    this.telemetry.lean = 0;
    this.telemetry.pitch = 0;
    this.telemetry.wheelie = false;
    this.telemetry.bavette = false;
    this.telemetry.looped = false;
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

  /** Steering angle at the fork, radians, positive to the right. */
  get steer(): number {
    return this.steerAngle;
  }

  get isFlipped(): boolean {
    return false;
  }

  get wheelie(): boolean {
    return this.pitch > 0.18 && this.wheels[1].contact;
  }

  get bavette(): boolean {
    return this.pitch > BAVETTE_ANGLE && this.wheels[1].contact;
  }

  /** Slip of the rear tire, used by the tire squeal. */
  rearSlipIntensity(): number {
    return Math.min(1, Math.abs(this.wheels[1].slipAngle) / 0.35);
  }

  /** The clutch-up that starts a wheelie. Returns false when it is too early. */
  popWheelie(): boolean {
    if (this.popCooldown > 0 || this.bailTimer > 0) return false;
    if (!this.wheels[1].contact) return false;
    if (Math.abs(dot(this.body.linvel(), forwardOf(this.rotation))) < 2) return false;
    // A clutch dump, not a launch ramp: it breaks the front loose, then the
    // throttle decides how high the rider takes it. At the top of a wheelie the
    // same button is the push into a bavette: from the angle the throttle
    // holds it needs a real kick, otherwise the tail never reaches the road.
    const bavettePush = this.pitch > 0.45;
    const headroom = 0.35 + 0.65 * clamp(1 - this.pitch / 1.2, 0, 1);
    this.pitchVelocity += (bavettePush ? 3.9 : 0.62) * headroom;
    this.popCooldown = 0.6;
    return true;
  }

  respawn(x: number, y: number, z: number, heading: number): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.drivetrain.reset();
    this.steerAngle = 0;
    this.lean = 0;
    this.pitch = 0;
    this.pitchVelocity = 0;
    this.yawRate = 0;
    this.popCooldown = 0;
    this.bailTimer = 0;
    this.prevLong = 0;
    this.longAccel = 0;
    this.pushTimer = 0;
    this.pushingBack = false;
    for (const wheel of this.wheels) {
      wheel.omega = 0;
      wheel.suspensionLength = this.restLength;
      wheel.contact = false;
      wheel.spinAngle = 0;
    }
  }

  /** Restores a recorded velocity, e.g. when a rewind is released. */
  setVelocity(x: number, y: number, z: number): void {
    this.body.setLinvel({ x, y, z }, true);
  }

  step(dt: number, input: VehicleInput, world: RAPIER.World): void {
    const q = this.rotation;
    const pos = this.position;
    const up = upOf(q);
    const forward = forwardOf(q);
    const linvel = this.body.linvel();
    const velocity = vec3(linvel.x, linvel.y, linvel.z);
    const vLong = dot(velocity, forward);
    const speed = length(velocity);

    // A bike has no anti-squat worth modelling: the rear tire gains the weight
    // the front loses under power, and loses it again under braking. The rigid
    // body cannot pitch (the wheelie is the pitch), so the transfer is applied
    // to the tire loads directly.
    const rawAccel = (vLong - this.prevLong) / Math.max(dt, 1e-4);
    this.longAccel += (rawAccel - this.longAccel) * Math.min(1, dt * 9);
    this.prevLong = vLong;
    const transfer = clamp(
      (this.spec.mass * this.longAccel * this.spec.cgHeight) / this.spec.wheelbase,
      -this.spec.mass * 4.5,
      this.spec.mass * 4.5,
    );

    this.popCooldown = Math.max(0, this.popCooldown - dt);
    this.bailTimer = Math.max(0, this.bailTimer - dt);

    // --- Walk-back reverse --------------------------------------------------
    // A supermotard has no reverse gear, so backing up is the rider pushing:
    // hold the brake at a standstill and the bike rolls back at walking pace
    // with both tires rolling, never with the rear wheel dragging.
    const wantsPush = input.throttle < 0.05 && input.brake > 0.55 && this.bailTimer <= 0;
    this.pushTimer = wantsPush ? this.pushTimer + dt : 0;
    // The standstill is what *engages* the walk-back; once the rider is
    // pushing, the bike keeps rolling until he lets the brake go. Testing the
    // speed every tick made it stutter: push, drift over 0.5 m/s, drop out,
    // stop, push again.
    if (!wantsPush) this.pushingBack = false;
    else if (!this.pushingBack && Math.abs(vLong) < 0.5 && this.pushTimer > 0.35) {
      this.pushingBack = true;
    }
    const brakeInput = this.pushingBack ? 0 : input.brake;

    // --- Steering -----------------------------------------------------------
    // A supermotard has a wide lock, but the faster it goes the less of it the
    // rider uses: the yaw rate itself is capped by grip below.
    const absSpeed = Math.abs(vLong);
    const lock = this.spec.maxSteer / (1 + absSpeed * 0.055);
    const target = clamp(input.steer, -1, 1) * lock;
    const rate = this.spec.steerRate * (1 + absSpeed * 0.02);
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);

    // --- Drivetrain ---------------------------------------------------------
    const rear = this.wheels[1];
    const front = this.wheels[0];
    const groundSpeed = Math.hypot(vLong, dot(velocity, cross(forward, up)));
    const drive = this.drivetrain.update(
      dt,
      rear.omega,
      input.throttle,
      brakeInput,
      vLong,
      groundSpeed,
    );

    // --- Wheelie ------------------------------------------------------------
    // The front tire is only a support while the pitch is small. Past that the
    // raycast would keep pushing the nose up, so it is treated as airborne; the
    // whole weight is carried by the rear spring, exactly like the real thing.
    const frontLifted = this.pitch > 0.12;
    const rearContact = this.wheels[1].contact;
    const steerVisual = -this.steerAngle;
    front.steer = steerVisual;

    const wheelImplusions: { impulse: Vec3; point: Vec3 }[] = [];
    let airborneCount = 0;
    let totalLoad = 0;

    for (let i = 0; i < 2; i++) {
      const wheel = this.wheels[i];
      const mountWorld = add(pos, rotate(q, wheel.mount));
      const ray = new RAPIER.Ray(mountWorld, { x: -up.x, y: -up.y, z: -up.z });
      const hit = world.castRayAndGetNormal(
        ray,
        this.maxLength + wheel.radius,
        true,
        undefined,
        undefined,
        this.collider,
        this.body,
      );
      const lifted = wheel.front && frontLifted;

      // Même filet que la voiture : la grille de collision de la piste a des
      // trous et le châssis de la moto ne collisionne qu'avec les murs. Une
      // roue qui rate le trimesh faisait tomber la moto sous l'asphalte.
      let reach = hit && hit.normal.y >= GROUND_NORMAL_MIN ? hit.timeOfImpact : -1;
      let normal = hit ? vec3(hit.normal.x, hit.normal.y, hit.normal.z) : null;
      // La cote analytique n'accepte un appui que si le sol est *sous* la roue :
      // en bord d'herbe, la surface du modèle remontait au-dessus du pneu et la
      // moto était recalée vers le haut d'un coup.
      if (reach < 0 && !lifted) {
        const floor = this.floorAt ? this.floorAt(mountWorld.x, mountWorld.z, mountWorld.y) : null;
        if (floor !== null) {
          const drop = mountWorld.y - floor;
          if (drop >= 0 && drop <= this.maxLength + wheel.radius) {
            reach = drop;
            normal = { x: 0, y: 1, z: 0 };
          }
        }
      }

      if (reach < 0 || !normal || lifted) {
        wheel.contact = false;
        wheel.load = 0;
        wheel.compression = 0;
        wheel.slipAngle = 0;
        wheel.slipRatio = 0;
        wheel.forceLong = 0;
        wheel.forceLat = 0;
        wheel.suspensionLength += (this.maxLength - wheel.suspensionLength) * Math.min(1, dt * 9);
        wheel.contactPoint = sub(mountWorld, {
          x: up.x * wheel.suspensionLength,
          y: up.y * wheel.suspensionLength,
          z: up.z * wheel.suspensionLength,
        });
        wheel.omega = wheel.front ? vLong / wheel.radius : wheel.omega * Math.exp(-dt * 1.5);
        wheel.spinAngle = (wheel.spinAngle + wheel.omega * dt) % (Math.PI * 2);
        airborneCount++;
        continue;
      }

      wheel.contact = true;
      const contactPoint = {
        x: ray.origin.x + ray.dir.x * reach,
        y: ray.origin.y + ray.dir.y * reach,
        z: ray.origin.z + ray.dir.z * reach,
      };
      wheel.contactPoint = contactPoint;
      wheel.contactNormal = normal;

      // Débattement borné par image : une arête du trimesh qui manque le rayon
      // ne doit pas détendre la suspension d'un coup.
      const wanted = clamp(reach - wheel.radius, MIN_LENGTH, this.maxLength);
      const travel = SUSPENSION_RATE * dt;
      const suspensionLength = clamp(
        wanted,
        wheel.suspensionLength - travel,
        wheel.suspensionLength + travel,
      );
      wheel.suspensionLength = suspensionLength;
      const compression = this.restLength - suspensionLength;
      wheel.compression = compression;

      const arm = sub(mountWorld, pos);
      const pointVel = add(velocity, cross(this.body.angvel(), arm));
      const vAlongUp = dot(pointVel, up);

      let springForce = this.spec.springK * compression + this.spec.springC * -vAlongUp;
      if (compression > this.bumpStop) {
        const over = compression - this.bumpStop;
        springForce += BUMP_K * over;
      }
      springForce = clamp(springForce, 0, this.maxSpringForce);
      // Sur le flanc, les ressorts poussent moins fort : la moto se pose au lieu
      // de rebondir.
      if (up.y <= 0.5) springForce = Math.min(springForce, this.spec.mass * 3.2);

      const wheelForward = rotateAxis(forward, up, wheel.steer);
      const wheelRight = cross(wheelForward, up);
      const contactArm = sub(contactPoint, pos);
      const contactVel = add(velocity, cross(this.body.angvel(), contactArm));
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
      const gripLoad = clamp(
        springForce + (wheel.front ? -transfer : transfer),
        150,
        this.maxSpringForce,
      );

      // Braking is a slip target on both wheels. The front brake does most of
      // the stopping and the rear only stabilises, as on a real bike.
      const brakeShare = wheel.front ? 0.78 : 0.22;
      const brakeTorque = brakeInput * this.spec.brakeTorque * 2.1 * brakeShare;
      let forces;
      if (wheel.front) {
        wheel.omega = cvLong / wheel.radius;
        const kappa = Math.abs(cvLong) < 0.3 ? 0 : -brakeInput * 0.1 * Math.sign(cvLong);
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: gripLoad, mu, peakAngle });
      } else if (this.pushingBack) {
        // The tire rolls the way the push moves it: a walking rider never spins
        // the wheel, so there is no slip ratio to chew up grip.
        wheel.omega = cvLong / wheel.radius;
        wheel.slipRatio = 0;
        forces = tireForces({ kappa: 0, alpha, fz: gripLoad, mu, peakAngle });
      } else {
        const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, cvLong);
        wheel.slipRatio = kappa;
        forces = tireForces({ kappa, alpha, fz: gripLoad, mu, peakAngle });
        // The tire cannot put down more than its friction circle allows. Without
        // this cap the wheel simply lights up: on grass the bike sat at the
        // limiter in first and barely moved, which reads as "no grip".
        const tractionCap = mu * gripLoad * wheel.radius * 1.25;
        const axleTorque =
          drive.axleTorque > 0 ? Math.min(drive.axleTorque, tractionCap) : drive.axleTorque;
        this.integrateRearSpin(
          dt,
          wheel,
          axleTorque,
          brakeTorque,
          cvLong,
          alpha,
          gripLoad,
          mu,
          peakAngle,
        );
      }

      wheel.forceLong = forces.fx;
      wheel.forceLat = forces.fy;
      const tireImpulse = {
        x: (wheelForward.x * forces.fx + wheelRight.x * forces.fy) * dt,
        y: (wheelForward.y * forces.fx + wheelRight.y * forces.fy) * dt,
        z: (wheelForward.z * forces.fx + wheelRight.z * forces.fy) * dt,
      };
      const springImpulse = {
        x: normal.x * springForce * dt,
        y: normal.y * springForce * dt,
        z: normal.z * springForce * dt,
      };
      wheelImplusions.push({ impulse: add(springImpulse, tireImpulse), point: contactPoint });
    }

    // Front brake locks the wheel enough to keep the front planted when the
    // rider is already stopped: without this the bike creeps on a slope.
    this.driveTorque = drive.axleTorque;

    // --- Chassis pitch (wheelie) -------------------------------------------
    // The front support is gone as soon as the pitch passes the lift threshold,
    // so the rear spring carries the whole mass. The pitch itself is not a
    // rigid-body rotation: it is the state the visual and the scoring read.
    const pitchInput = {
      axleTorque: drive.axleTorque * clamp(1 - Math.abs(vLong) / 62, 0.1, 1),
      throttle: input.throttle,
      brake: brakeInput,
      rearContact: this.wheels[1].contact && this.bailTimer <= 0,
      speed: vLong,
      grip: this.rearSurfaceGrip(),
    };
    if (this.wheels[1].contact && this.bailTimer <= 0) {
      const accel = wheelieAcceleration(
        { pitch: this.pitch, pitchVelocity: this.pitchVelocity },
        pitchInput,
        this.wheelieGeometry,
        this.spec.mass,
      );
      this.pitchVelocity += accel * dt;
    } else {
      // In the air, or after a loop-out, the chassis levels itself: there is no
      // contact patch to pivot around, and the rider is busy holding on.
      this.pitchVelocity += (-this.pitch * 9 - this.pitchVelocity * 3.5) * dt;
    }
    this.pitchVelocity = clamp(this.pitchVelocity, -4.5, 4.5);
    this.pitch += this.pitchVelocity * dt;

    if (this.pitch <= 0) {
      this.pitch = 0;
      if (this.pitchVelocity < 0) this.pitchVelocity = 0;
    }

    let looped = false;
    if (this.pitch > LOOP_ANGLE) {
      // Past the point of no return: the tail hits, the front comes down hard
      // and the wheelie (with the points it was carrying) is gone.
      looped = true;
      this.pitch = LOOP_ANGLE;
      this.pitchVelocity = -3.4;
      this.bailTimer = 1.1;
      const v = this.body.linvel();
      this.body.setLinvel({ x: v.x * 0.55, y: v.y, z: v.z * 0.55 }, true);
    }

    // --- Yaw, lean and grip -------------------------------------------------
    // A single-track vehicle turns because it leans; the yaw rate is therefore
    // the one the tires can actually support (v²/R = µg), not the one the
    // handlebar asks for. The lean the player sees is derived from that yaw.
    const rearGround = this.surfaceAt(pos.x, pos.z);
    const looseRear = rearGround.kind !== 'asphalte';
    const muAvg =
      ((this.spec.muFront + this.spec.muRear) / 2) *
      rearGround.grip *
      (looseRear ? this.spec.looseGrip : 1);
    // A bike does not slide: it leans. Leaving a margin under the friction
    // limit keeps the slip angles below the peak, so the bike follows the line
    // the bars ask for instead of drifting wide like a car on cold tires.
    const maxLateral = muAvg * 9.81 * 0.82;
    const yawGeometric = (-vLong * Math.tan(this.steerAngle)) / this.spec.wheelbase;
    const yawLimit = maxLateral / Math.max(Math.abs(vLong), 4);
    let yawTarget = clamp(yawGeometric, -yawLimit, yawLimit);
    // With the front wheel in the air there is no steering contact patch; the
    // rider can still steer the landing, but the bike mostly goes where it was
    // already pointed.
    if (this.pitch > 0.2) yawTarget *= clamp(1 - (this.pitch - 0.2) * 0.9, 0.28, 1);
    if (!this.wheels[0].contact) yawTarget *= 0.6;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * 15);
    this.body.setAngvel({ x: 0, y: this.yawRate, z: 0 }, true);

    const leanTarget = leanFor(vLong, this.yawRate, this.spec.maxLean);
    const leanRate = 3.4;
    this.lean += clamp(leanTarget - this.lean, -leanRate * dt, leanRate * dt);
    if (Math.abs(vLong) < 0.5) this.lean *= Math.exp(-dt * 6);

    // --- Forces -------------------------------------------------------------
    for (const { impulse, point } of wheelImplusions) {
      this.body.applyImpulseAtPoint(impulse, point, true);
    }

    if (speed > 0.4) {
      // Knobby tires do not plough through grass the way a road tire does:
      // three quarters of the rolling resistance is what made the bike stop
      // dead the moment it left the tarmac.
      const looseRoll = rearGround.kind === 'asphalte' ? 1 : 0.55;
      const rolling = 0.012 * totalLoad * rearGround.rolling * looseRoll * Math.sign(vLong);
      this.body.applyImpulse(
        { x: -forward.x * rolling * dt, y: 0, z: -forward.z * rolling * dt },
        true,
      );
    }
    if (this.pushingBack) {
      // 4,5 km/h backwards is a rider walking beside his bike, not a reverse
      // gear: the force fades as the target speed is reached, and letting go of
      // the brake stops it on the spot.
      const error = -1.25 - vLong;
      const push = clamp(error, -1.2, 1.2) * this.spec.mass * 2.4;
      this.body.applyImpulse({ x: forward.x * push * dt, y: 0, z: forward.z * push * dt }, true);
    }
    if (speed > 0.4) {
      const drag = 0.5 * 1.225 * this.spec.dragArea * speed;
      this.body.applyImpulse(
        { x: -velocity.x * drag * dt, y: -velocity.y * drag * dt, z: -velocity.z * drag * dt },
        true,
      );
    }

    // --- Telemetry ----------------------------------------------------------
    const bodySlip = Math.atan2(dot(velocity, cross(forward, up)), Math.max(Math.abs(vLong), 1.2));
    this.surface = rearGround;
    this.telemetry = this.buildTelemetry(velocity, bodySlip, looped);
    this.telemetry.rpm = this.pushingBack ? Math.max(900, this.telemetry.rpm) : drive.rpm;
    this.telemetry.gear = this.pushingBack ? -1 : drive.gear;
    this.telemetry.shifting = drive.shifting;
    this.telemetry.limiter = drive.limiter;
    this.telemetry.throttle = input.throttle;
    this.telemetry.brake = input.brake;
    this.telemetry.handbrake = input.handbrake;
    this.telemetry.airborne = airborneCount === 2;
    this.telemetry.speed = speed;
    this.telemetry.speedKmh = speed * 3.6;
    this.telemetry.lean = this.lean;
    this.telemetry.pitch = this.pitch;
    this.telemetry.wheelie = this.pitch > 0.18 && rearContact;
    this.telemetry.bavette = this.pitch > BAVETTE_ANGLE && rearContact;
    this.telemetry.looped = looped;

    if (input.throttle < 0.03 && input.brake < 0.03 && speed < 0.4 && airborneCount < 2) {
      const current = this.body.linvel();
      this.body.setLinvel({ x: 0, y: current.y, z: 0 }, true);
    }

    this.telemetry.lateralAccel = vLong * this.yawRate;
  }

  /** Grip the rear tire can count on right now, 1 on dry asphalt. */
  private rearSurfaceGrip(): number {
    const point = this.wheels[1].contactPoint;
    const ground = this.surfaceAt(point.x, point.z);
    return ground.grip * (ground.kind === 'asphalte' ? 1 : this.spec.looseGrip);
  }

  /**
   * Rear wheel spin, semi-implicit in the tire stiffness like the car: the
   * reflected engine inertia through first gear is large enough to make an
   * explicit integration chatter at 120 Hz.
   */
  private integrateRearSpin(
    dt: number,
    wheel: BikeWheel,
    driveTorque: number,
    brakeTorque: number,
    vLong: number,
    alpha: number,
    fz: number,
    mu: number,
    peakAngle: number,
  ): void {
    const ratio = Math.abs(this.drivetrain.ratio) * this.spec.finalDrive;
    // A bike flywheel and clutch are a fraction of a car's, and there is only
    // one driven wheel to carry them: too much reflected inertia made the
    // supermotard pull away like a loaded van.
    const inertia = this.wheelInertia + 0.06 * ratio * ratio;
    const substeps = 3;
    const h = dt / substeps;
    const stiffness = (mu * fz) / KAPPA_PEAK;
    const vRef = Math.max(Math.abs(vLong), 2.5);
    for (let s = 0; s < substeps; s++) {
      const kappa = slipRatioFromWheelSpeed(wheel.omega, wheel.radius, vLong);
      const fx = tireForces({ kappa, alpha, fz, mu, peakAngle }).fx;
      const implicit = (stiffness * wheel.radius * wheel.radius * h) / (vRef * inertia);
      const free = wheel.omega + ((driveTorque - fx * wheel.radius) / inertia) * h;
      wheel.omega += (free - wheel.omega) / (1 + implicit);
      const stop = Math.min(Math.abs(wheel.omega), (brakeTorque * h) / inertia);
      wheel.omega -= Math.sign(wheel.omega) * stop;
      if (!Number.isFinite(wheel.omega)) wheel.omega = 0;
      wheel.omega = clamp(wheel.omega, -220, 420);
    }
    wheel.spinAngle = (wheel.spinAngle + wheel.omega * dt) % (Math.PI * 2);
  }

  private buildTelemetry(velocity: Vec3, bodySlip: number, looped: boolean): VehicleTelemetry {
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
      wheels: this.wheels.map((wheel) => this.wheelTelemetry(wheel)),
      lean: this.lean,
      pitch: this.pitch,
      wheelie: this.pitch > 0.18,
      bavette: this.pitch > BAVETTE_ANGLE,
      looped,
    };
  }

  private wheelTelemetry(wheel: BikeWheel): WheelTelemetry {
    const pos = this.position;
    const q = this.rotation;
    return {
      name: wheel.name,
      contact: wheel.contact,
      steer: wheel.steer,
      spinAngle: wheel.spinAngle,
      omega: wheel.omega,
      suspensionLength: wheel.suspensionLength,
      load: wheel.load,
      forceLong: wheel.forceLong,
      forceLat: wheel.forceLat,
      slipAngle: wheel.slipAngle,
      slipRatio: wheel.slipRatio,
      worldPosition: add(pos, rotate(q, wheel.mount)),
      contactNormal: wheel.contactNormal,
      contactPoint: wheel.contactPoint,
    };
  }
}
