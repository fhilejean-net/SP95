/**
 * Banc de mesure du comportement en glisse, sans rendu.
 *
 *   node scripts/probe-drift.ts
 *
 * Trois questions, trois mesures :
 *  - l'accélérateur resserre-t-il la trajectoire, le frein l'élargit-il ?
 *    (courbure = variation de cap / distance parcourue pendant la glisse)
 *  - combien de km/h une glisse tenue coûte-t-elle ?
 *  - le patinage s'installe-t-il, et à quel point la voiture est-elle
 *    secouée quand les roues raccrochent ?
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

class Sim {
  world!: RAPIER.World;
  car!: Vehicle;

  async init(): Promise<void> {
    this.world = await makeWorld();
    this.car = new Vehicle(this.world, { x: 0, y: 0.9, z: 0, heading: 0 });
  }

  step(seconds: number, input: VehicleInput, onTick?: () => void): void {
    const steps = Math.round(seconds / TICK);
    for (let i = 0; i < steps; i++) {
      this.car.step(TICK, input, this.world);
      this.world.step();
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

  get yawRate(): number {
    return this.car.body.angvel().y;
  }
}

interface DriftResult {
  entry: number;
  exit: number;
  angle: number;
  curvature: number;
  yawRate: number;
}

/** Glisse identique dans tous les cas : seul le pédalage change. */
async function drift(
  pedal: { throttle: number; brake: number },
  tcs = true,
): Promise<DriftResult> {
  const sim = new Sim();
  await sim.init();
  sim.car.tcsEnabled = tcs;
  sim.step(1.0, NEUTRAL_INPUT);
  sim.step(5.0, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const entry = sim.kmh;

  // Mise en glisse : frein à main + braquage, comme un vrai point de corde.
  sim.step(1.2, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });

  const input: VehicleInput = { ...pedal, steer: 1, handbrake: false };
  let previous = sim.heading;
  let turned = 0;
  let travelled = 0;
  let previousPos = sim.car.position;
  sim.step(2.0, input, () => {
    const now = sim.heading;
    let delta = now - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    turned += Math.abs(delta);
    previous = now;
    const pos = sim.car.position;
    travelled += Math.hypot(pos.x - previousPos.x, pos.z - previousPos.z);
    previousPos = pos;
  });

  return {
    entry,
    exit: sim.kmh,
    angle: sim.car.telemetryState.driftAngleDeg,
    // Rayon = 1 / courbure. Plus la courbure est grande, plus la trajectoire
    // se referme vers l'intérieur.
    curvature: travelled > 0 ? turned / travelled : 0,
    yawRate: sim.yawRate,
  };
}

interface HeldRow {
  kmh: number;
  angle: number;
  steer: number;
}

/**
 * Glisse tenue 6 s par un pilote automatique : il contre-braque pour garder
 * l'angle autour de 20°, exactement ce que fait un joueur. Braquer à fond sans
 * corriger fait tourner sur place — ce n'est pas une mesure de la glisse.
 */
async function retention(): Promise<HeldRow[]> {
  const sim = new Sim();
  await sim.init();
  sim.step(1.0, NEUTRAL_INPUT);
  sim.step(6.0, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  sim.step(1.2, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });

  const direction = Math.sign(sim.car.telemetryState.slipAngle) || 1;
  const target = direction * 0.35;
  let steer = 1;
  const rows: HeldRow[] = [{ kmh: sim.kmh, angle: sim.car.telemetryState.driftAngleDeg, steer }];
  for (let i = 0; i < 12; i++) {
    sim.step(0.5, { throttle: 1, brake: 0, steer, handbrake: false }, () => {
      const slip = sim.car.telemetryState.slipAngle;
      steer = Math.max(-1, Math.min(1, steer + (slip - target) * 6 * TICK));
    });
    rows.push({ kmh: sim.kmh, angle: sim.car.telemetryState.driftAngleDeg, steer });
  }
  return rows;
}

interface BurnSample {
  t: number;
  kmh: number;
  slip: number[];
  omega: number[];
  rpm: number;
  gear: number;
  yaw: number;
}

/** Départ plein gaz : le patinage s'installe-t-il et la voiture part-elle en crabe ? */
async function burnout(tcs: boolean): Promise<{ samples: BurnSample[]; after: BurnSample }> {
  const sim = new Sim();
  await sim.init();
  sim.car.tcsEnabled = tcs;
  sim.step(0.8, NEUTRAL_INPUT);
  const sample = (t: number): BurnSample => {
    const rear = sim.car.telemetryState.wheels.filter((w) => !w.name.startsWith('F'));
    return {
      t,
      kmh: Math.round(sim.kmh * 10) / 10,
      slip: rear.map((w) => Math.round(w.slipRatio * 100) / 100),
      omega: rear.map((w) => Math.round(w.omega)),
      rpm: Math.round(sim.car.telemetryState.rpm),
      gear: sim.car.telemetryState.gear,
      yaw: Math.round(sim.yawRate * 1000) / 1000,
    };
  };
  const samples: BurnSample[] = [];
  for (let i = 1; i <= 12; i++) {
    sim.step(0.25, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    samples.push(sample(i * 0.25));
  }
  // On relâche : c'est là que la voiture se mettait « violemment de travers ».
  sim.step(0.6, { throttle: 0.35, brake: 0, steer: 0, handbrake: false });
  return { samples, after: sample(3.6) };
}

const fmt = (n: number, digits = 1) => n.toFixed(digits).padStart(6);

const cases: { label: string; pedal: { throttle: number; brake: number } }[] = [
  { label: 'frein 1.0', pedal: { throttle: 0, brake: 1 } },
  { label: 'frein 0.5', pedal: { throttle: 0, brake: 0.5 } },
  { label: 'roue libre', pedal: { throttle: 0, brake: 0 } },
  { label: 'gaz 0.3', pedal: { throttle: 0.3, brake: 0 } },
  { label: 'gaz 0.6', pedal: { throttle: 0.6, brake: 0 } },
  { label: 'gaz 1.0', pedal: { throttle: 1, brake: 0 } },
];

console.log('=== Glisse : ce que fait chaque pédale sur la trajectoire ===');
console.log('cas        | entrée | sortie | angle  | rayon  | courbure | lacet');
for (const c of cases) {
  const r = await drift(c.pedal);
  const radius = r.curvature > 1e-4 ? `${(1 / r.curvature).toFixed(1)} m` : 'ligne';
  console.log(
    `${c.label.padEnd(10)} | ${fmt(r.entry, 0)} | ${fmt(r.exit, 0)} | ${fmt(r.angle)}° | ${radius.padStart(6)} | ${fmt(r.curvature, 4)} | ${fmt(r.yawRate, 3)}`,
  );
}

console.log('\n=== Même glisse, antipatinage coupé ===');
for (const c of [cases[2], cases[5]]) {
  const r = await drift(c.pedal, false);
  console.log(
    `${c.label.padEnd(10)} | sortie ${fmt(r.exit, 0)} km/h | angle ${fmt(r.angle)}° | rayon ${(1 / r.curvature).toFixed(1)} m | lacet ${fmt(r.yawRate, 3)}`,
  );
}

/** Entrée par lever de pied, sans frein à main : la façon dont un pilote ouvre une glisse. */
async function liftEntry(): Promise<HeldRow[]> {
  const sim = new Sim();
  await sim.init();
  sim.step(1.0, NEUTRAL_INPUT);
  sim.step(5.0, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  sim.step(0.8, { throttle: 0, brake: 0, steer: 0.7, handbrake: false });
  const direction = Math.sign(sim.car.telemetryState.slipAngle) || 1;
  const target = direction * 0.35;
  let steer = 0.7;
  const rows: HeldRow[] = [{ kmh: sim.kmh, angle: sim.car.telemetryState.driftAngleDeg, steer }];
  for (let i = 0; i < 12; i++) {
    sim.step(0.5, { throttle: 1, brake: 0, steer, handbrake: false }, () => {
      steer = Math.max(-1, Math.min(1, steer + (sim.car.telemetryState.slipAngle - target) * 6 * TICK));
    });
    rows.push({ kmh: sim.kmh, angle: sim.car.telemetryState.driftAngleDeg, steer });
  }
  return rows;
}

const ret = await retention();
console.log('\n=== Glisse tenue au gaz plein, contre-braquage automatique, pas de 0,5 s ===');
console.log('  t   | km/h | angle | braquage');
ret.forEach((r, i) =>
  console.log(`${(i * 0.5).toFixed(1)}s | ${fmt(r.kmh, 0)} | ${fmt(r.angle)}° | ${fmt(r.steer, 2)}`),
);
console.log(
  `perte totale : ${(ret[0].kmh - ret[ret.length - 1].kmh).toFixed(0)} km/h en 6 s`,
);

const lift = await liftEntry();
console.log('\n=== Même glisse ouverte au lever de pied ===');
console.log('  t   | km/h | angle | braquage');
lift.forEach((r, i) =>
  console.log(`${(i * 0.5).toFixed(1)}s | ${fmt(r.kmh, 0)} | ${fmt(r.angle)}° | ${fmt(r.steer, 2)}`),
);
console.log(
  `perte totale : ${(lift[0].kmh - lift[lift.length - 1].kmh).toFixed(0)} km/h en 6 s`,
);

/**
 * Gaz en plein virage : c'est là que le patinage surprend le joueur, et que
 * le raccrochage envoyait la voiture de travers.
 */
async function cornerBurn(tcs: boolean): Promise<void> {
  const sim = new Sim();
  await sim.init();
  sim.car.tcsEnabled = tcs;
  sim.step(0.8, NEUTRAL_INPUT);
  sim.step(3.2, { throttle: 0.6, brake: 0, steer: 0, handbrake: false });
  console.log(`\n=== Gaz à fond en virage (${Math.round(sim.kmh)} km/h), antipatinage ${tcs ? 'ON' : 'OFF'} ===`);
  console.log('   t   | km/h | angle | glissement AR | lacet');
  for (let i = 1; i <= 25; i++) {
    const lifting = i > 15;
    sim.step(0.1, {
      throttle: lifting ? 0.35 : 1,
      brake: 0,
      steer: 0.55,
      handbrake: false,
    });
    const rear = sim.car.telemetryState.wheels.filter((w) => !w.name.startsWith('F'));
    if (i % 2 === 0 || Math.abs(sim.yawRate) > 0.5) {
      console.log(
        `${(i * 0.1).toFixed(1)}s${lifting ? '*' : ' '} | ${fmt(sim.kmh, 0)} | ${fmt(sim.car.telemetryState.driftAngleDeg)}° | ${rear.map((w) => w.slipRatio.toFixed(2)).join('/').padStart(9)} | ${fmt(sim.yawRate, 3)}`,
      );
    }
  }
}

for (const tcs of [true, false]) await cornerBurn(tcs);

for (const tcs of [true, false]) {
  const { samples, after } = await burnout(tcs);
  console.log(`\n=== Départ plein gaz, antipatinage ${tcs ? 'ON' : 'OFF'} ===`);
  console.log('  t   | km/h | glissement AR | tr/min AR | régime | rapport | lacet');
  for (const s of samples.filter((_, i) => i % 2 === 1)) {
    console.log(
      `${s.t.toFixed(2)}s | ${fmt(s.kmh, 0)} | ${s.slip.map((v) => v.toFixed(2)).join('/').padStart(9)} | ${s.omega.map((v) => String(v).padStart(3)).join('/')} | ${String(s.rpm).padStart(6)} | ${String(s.gear).padStart(7)} | ${fmt(s.yaw, 3)}`,
    );
  }
  console.log(
    `relâché à 0,35 : ${after.kmh.toFixed(0)} km/h · lacet ${after.yaw.toFixed(3)} rad/s · glissement ${after.slip.join('/')}`,
  );
}
