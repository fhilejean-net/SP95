/**
 * Banc de mesure du comportement en glisse, sans rendu.
 *
 *   npm run physics:probe
 *
 * Le pilote automatique module le gaz et le contre-braquage comme un joueur :
 * un braquage fixe mesurait surtout la capacité de la voiture à faire un
 * donut, pas la tenue d'une glisse.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { NEUTRAL_INPUT, Vehicle, type VehicleInput } from '../src/physics/vehicle.ts';

const TICK = 1 / 120;

async function makeWorld(): Promise<RAPIER.World> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TICK;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setFriction(1), ground);
  return world;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

class Sim {
  readonly world: RAPIER.World;
  readonly car: Vehicle;

  constructor(world: RAPIER.World, car: Vehicle) {
    this.world = world;
    this.car = car;
  }

  static async create(tcs = true): Promise<Sim> {
    const world = await makeWorld();
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
    car.tcsEnabled = tcs;
    return new Sim(world, car);
  }

  tick(input: VehicleInput): void {
    this.car.step(TICK, input, this.world);
    this.world.step();
  }

  run(seconds: number, input: VehicleInput, onTick?: () => void): void {
    const steps = Math.round(seconds / TICK);
    for (let i = 0; i < steps; i++) {
      this.tick(input);
      onTick?.();
    }
  }

  get heading(): number {
    const q = this.car.rotation;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  get kmh(): number {
    return this.car.telemetryState.speedKmh;
  }

  get slip(): number {
    return this.car.telemetryState.slipAngle;
  }
}

interface PedalResult {
  entry: number;
  exit: number;
  angle: number;
  curvature: number;
}

/** Glisse identique dans tous les cas : seul le pédalage change. */
async function pedalTest(pedal: { throttle: number; brake: number }): Promise<PedalResult> {
  const sim = await Sim.create();
  sim.run(1.0, NEUTRAL_INPUT);
  sim.run(5.0, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const entry = sim.kmh;
  sim.run(0.45, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });
  // On laisse la glisse se poser autour de 25° : c'est là qu'on corrige au
  // point de corde, pas braqué à fond à 97 km/h.
  sim.run(0.6, { throttle: 0.6, brake: 0, steer: 0.45, handbrake: false });

  let previousHeading = sim.heading;
  let previousPosition = sim.car.position;
  let turned = 0;
  let travelled = 0;
  sim.run(1.6, { ...pedal, steer: 0.45, handbrake: false }, () => {
    let delta = sim.heading - previousHeading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    turned += Math.abs(delta);
    previousHeading = sim.heading;
    const position = sim.car.position;
    travelled += Math.hypot(position.x - previousPosition.x, position.z - previousPosition.z);
    previousPosition = position;
  });

  return {
    entry,
    exit: sim.kmh,
    angle: sim.car.telemetryState.driftAngleDeg,
    curvature: travelled > 0 ? turned / travelled : 0,
  };
}

interface HeldRow {
  t: number;
  kmh: number;
  angle: number;
  steer: number;
  throttle: number;
  rpm: number;
  gear: number;
  rear: number;
  front: number;
}

/**
 * Pilote automatique de glisse : contre-braquage proportionnel-dérivé sur
 * l'angle visé, gaz modulé pour tenir la vitesse.
 */
function heldDriver(sim: Sim, seconds: number, targetDeg: number, targetKmh: number): HeldRow[] {
  const direction = Math.sign(sim.slip) || -1;
  const target = (direction * targetDeg * Math.PI) / 180;
  let previousSlip = sim.slip;
  const rows: HeldRow[] = [];
  const steps = Math.round(seconds / TICK);
  const every = Math.round(0.25 / TICK);
  for (let i = 1; i <= steps; i++) {
    const slip = sim.slip;
    const rate = (slip - previousSlip) / TICK;
    previousSlip = slip;
    // Sens mesuré : braquer du côté du glissement le réduit.
    const steer = clamp(1.5 * (slip - target) + 0.05 * rate, -1, 1);
    const throttle = clamp(0.55 + (targetKmh - sim.kmh) * 0.05, 0, 1);
    sim.tick({ throttle, brake: 0, steer, handbrake: false });
    if (i % every === 0) {
      const wheels = sim.car.telemetryState.wheels;
      const mean = (drive: boolean) => {
        const set = wheels.filter((w) => w.name.startsWith('F') !== drive);
        return set.reduce((sum, w) => sum + Math.abs(w.slipRatio), 0) / Math.max(1, set.length);
      };
      rows.push({
        t: i * TICK,
        kmh: sim.kmh,
        angle: sim.car.telemetryState.driftAngleDeg,
        steer,
        throttle,
        rpm: sim.car.telemetryState.rpm,
        gear: sim.car.telemetryState.gear,
        rear: mean(true),
        front: mean(false),
      });
    }
  }
  return rows;
}

async function heldDrift(entry: 'handbrake' | 'lift'): Promise<HeldRow[]> {
  const sim = await Sim.create();
  sim.run(1.0, NEUTRAL_INPUT);
  sim.run(5.0, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  if (entry === 'handbrake') {
    // Un joueur donne un coup de frein à main, il ne le tient pas 1,2 s.
    sim.run(0.45, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });
  } else {
    sim.run(0.8, { throttle: 0, brake: 0, steer: 0.7, handbrake: false });
  }
  return heldDriver(sim, 6, 25, 70);
}

interface BurnSample {
  t: number;
  kmh: number;
  angle: number;
  slip: number[];
  rpm: number;
  gear: number;
  yaw: number;
}

function sampleOf(sim: Sim, t: number): BurnSample {
  const rear = sim.car.telemetryState.wheels.filter((w) => !w.name.startsWith('F'));
  return {
    t,
    kmh: sim.kmh,
    angle: sim.car.telemetryState.driftAngleDeg,
    slip: rear.map((w) => w.slipRatio),
    rpm: sim.car.telemetryState.rpm,
    gear: sim.car.telemetryState.gear,
    yaw: sim.car.body.angvel().y,
  };
}

async function burnout(tcs: boolean): Promise<{ samples: BurnSample[]; after: BurnSample }> {
  const sim = await Sim.create(tcs);
  sim.run(0.8, NEUTRAL_INPUT);
  const samples: BurnSample[] = [];
  for (let i = 1; i <= 12; i++) {
    sim.run(0.25, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    samples.push(sampleOf(sim, i * 0.25));
  }
  sim.run(0.6, { throttle: 0.35, brake: 0, steer: 0, handbrake: false });
  return { samples, after: sampleOf(sim, 3.6) };
}

/** Gaz en plein virage : le moment où le patinage surprend le joueur. */
async function cornerBurn(tcs: boolean): Promise<BurnSample[]> {
  const sim = await Sim.create(tcs);
  sim.run(0.8, NEUTRAL_INPUT);
  sim.run(3.2, { throttle: 0.6, brake: 0, steer: 0, handbrake: false });
  const rows: BurnSample[] = [];
  for (let i = 1; i <= 20; i++) {
    sim.run(0.1, { throttle: 1, brake: 0, steer: 0.55, handbrake: false });
    rows.push(sampleOf(sim, i * 0.1));
  }
  return rows;
}

const n = (value: number, digits = 1) => value.toFixed(digits);
const quick = process.argv.includes('--quick');

console.log('=== Glisse : ce que fait chaque pédale sur la trajectoire ===');
console.log('cas        | entrée | sortie | angle  | rayon  | courbure');
const cases: { label: string; pedal: { throttle: number; brake: number } }[] = [
  { label: 'frein 1.0', pedal: { throttle: 0, brake: 1 } },
  { label: 'frein 0.5', pedal: { throttle: 0, brake: 0.5 } },
  { label: 'roue libre', pedal: { throttle: 0, brake: 0 } },
  { label: 'gaz 0.3', pedal: { throttle: 0.3, brake: 0 } },
  { label: 'gaz 0.6', pedal: { throttle: 0.6, brake: 0 } },
  { label: 'gaz 1.0', pedal: { throttle: 1, brake: 0 } },
];
for (const c of cases) {
  const r = await pedalTest(c.pedal);
  const radius = r.curvature > 1e-4 ? `${n(1 / r.curvature)} m` : 'ligne';
  console.log(
    `${c.label.padEnd(10)} | ${n(r.entry, 0).padStart(6)} | ${n(r.exit, 0).padStart(6)} | ${n(r.angle).padStart(5)}° | ${radius.padStart(6)} | ${n(r.curvature, 4)}`,
  );
}

for (const entry of ['handbrake', 'lift'] as const) {
  const rows = await heldDrift(entry);
  const settled = rows.filter((r) => r.t > 2);
  const mean = (pick: (r: HeldRow) => number) =>
    settled.reduce((sum, r) => sum + pick(r), 0) / Math.max(1, settled.length);
  console.log(
    `\nGlisse tenue (${entry === 'handbrake' ? 'frein à main' : 'lever de pied'}) : ` +
      `angle ${n(mean((r) => r.angle))}° · ${n(mean((r) => r.kmh), 0)} km/h de moyenne · ` +
      `entrée ${n(rows[0].kmh, 0)} km/h`,
  );
  console.log('   t   | km/h | angle | braquage | gaz  | régime | rap. | gliss. AR/AV');
  for (const r of rows.filter((_, i) => i % 2 === 0)) {
    console.log(
      `${n(r.t, 2).padStart(5)}s | ${n(r.kmh, 0).padStart(4)} | ${n(r.angle).padStart(5)}° | ${n(r.steer, 2).padStart(8)} | ${n(r.throttle, 2)} | ${String(Math.round(r.rpm)).padStart(6)} | ${String(r.gear).padStart(4)} | ${n(r.rear, 2)}/${n(r.front, 2)}`,
    );
  }
}

if (!quick) {
  for (const tcs of [true, false]) {
    const rows = await cornerBurn(tcs);
    console.log(`\n=== Gaz à fond en virage, antipatinage ${tcs ? 'ON' : 'OFF'} ===`);
    console.log('   t   | km/h | angle | glissement AR | lacet');
    for (const r of rows.filter((_, i) => i % 2 === 1)) {
      console.log(
        `${n(r.t).padStart(5)}s | ${n(r.kmh, 0).padStart(4)} | ${n(r.angle).padStart(5)}° | ${r.slip.map((v) => n(v, 2)).join('/').padStart(9)} | ${n(r.yaw, 3)}`,
      );
    }
  }

  for (const tcs of [true, false]) {
    const { samples, after } = await burnout(tcs);
    console.log(`\n=== Départ plein gaz, antipatinage ${tcs ? 'ON' : 'OFF'} ===`);
    console.log('  t   | km/h | glissement AR | régime | rapport | lacet');
    for (const s of samples.filter((_, i) => i % 3 === 2)) {
      console.log(
        `${n(s.t).padStart(5)}s | ${n(s.kmh, 0).padStart(4)} | ${s.slip.map((v) => n(v, 2)).join('/').padStart(9)} | ${String(s.rpm).padStart(6)} | ${String(s.gear).padStart(7)} | ${n(s.yaw, 3)}`,
      );
    }
    console.log(
      `relâché : ${n(after.kmh, 0)} km/h · angle ${n(after.angle)}° · lacet ${n(after.yaw, 3)} rad/s · glissement ${after.slip.map((v) => n(v, 2)).join('/')}`,
    );
  }
}
