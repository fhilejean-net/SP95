import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { magicFormula, slipRatioFromWheelSpeed, tireForces } from '../src/physics/tire.ts';
import {
  DIRT_TRACKS,
  DRIFT_PAD,
  MOUNTAIN_ROADS,
  RALLY_START,
  SPAWN,
  SUMMIT,
  heightAt,
  padEdgeDistance,
  surfaceAt,
} from '../src/world/layout.ts';
import { roadEnds } from '../src/world/terrain.ts';
import { Drivetrain, torqueAtRpm } from '../src/physics/drivetrain.ts';
import {
  GROUP_GROUND,
  GROUP_WORLD,
  Vehicle,
  NEUTRAL_INPUT,
  STOCK_SPEC,
  type VehicleInput,
  type VehicleSpec,
} from '../src/physics/vehicle.ts';
import { CARS } from '../src/game/cars.ts';
import { DEFAULT_SETUP, resolveSpec, type Setup } from '../src/game/tuning.ts';

const TICK = 1 / 120;

async function makeWorld() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TICK;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setFriction(1), ground);
  return world;
}

function simulate(
  world: RAPIER.World,
  car: Vehicle,
  seconds: number,
  input: VehicleInput,
  onTick?: () => void,
) {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps; i++) {
    car.step(TICK, input, world);
    world.step();
    onTick?.();
  }
}

test('magic formula peaks at normalized slip 1 and fades afterwards', () => {
  const peak = magicFormula(1);
  assert.ok(peak > 0.94 && peak <= 1.0001, `peak was ${peak}`);
  assert.ok(magicFormula(2.5) < peak, 'force should fall off after the peak');
  assert.ok(magicFormula(-1) < -0.94, 'negative slip gives negative force');
  assert.equal(magicFormula(0), 0);
});

test('pure lateral slip saturates near the friction limit', () => {
  const out = tireForces({ kappa: 0, alpha: 0.135, fz: 4000, mu: 1.2 });
  assert.ok(Math.abs(out.fx) < 1, `unexpected longitudinal force ${out.fx}`);
  assert.ok(Math.abs(out.fy) > 4200 && Math.abs(out.fy) < 5200, `lateral force ${out.fy}`);
});

test('combined slip keeps the total force inside the friction ellipse', () => {
  const out = tireForces({ kappa: 0.5, alpha: 0.3, fz: 4000, mu: 1.2 });
  const magnitude = Math.hypot(out.fx, out.fy);
  const limit = 1.2 * 4000 * 1.05;
  assert.ok(magnitude <= limit, `force ${magnitude} exceeds ${limit}`);
  assert.ok(magnitude > limit * 0.6, 'combined force should stay close to the limit');
});

test('slip ratio is zero for a free rolling wheel', () => {
  const omega = 20 / 0.34;
  assert.ok(Math.abs(slipRatioFromWheelSpeed(omega, 0.34, 20)) < 1e-9);
  assert.ok(slipRatioFromWheelSpeed(0, 0.34, 20) < -0.5, 'locked wheel has negative slip');
});

test('torque curve stays usable across the rev range', () => {
  for (let rpm = 900; rpm <= 7300; rpm += 200) {
    const t = torqueAtRpm(rpm);
    assert.ok(t > 90 && t <= 420.001, `torque ${t} at ${rpm} rpm`);
  }
});

test('automatic gearbox climbs through the gears', () => {
  const box = new Drivetrain();
  let omega = 0;
  const gearsSeen = new Set<number>();
  let speed = 0;
  for (let i = 0; i < 120 * 10; i++) {
    const out = box.update(TICK, omega, 1, 0, speed);
    gearsSeen.add(out.gear);
    const force = out.axleTorque / 0.34;
    const drag = 0.5 * 1.225 * 0.7 * speed * speed;
    speed += ((force - drag) / 1350) * TICK;
    speed = Math.max(0, speed);
    omega = speed / 0.34;
    assert.ok(Number.isFinite(speed));
  }
  assert.ok(gearsSeen.has(1) && gearsSeen.has(2), `gears seen: ${[...gearsSeen]}`);
  assert.ok(box.gear >= 3, `expected an upshift, still in gear ${box.gear}`);
});

test('rear-wheel-drive car accelerates, tracks straight and stops', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1.2, NEUTRAL_INPUT);

  let timeTo100 = Infinity;
  let topSpeed = 0;
  for (let i = 0; i < 120 * 40; i++) {
    car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
    world.step();
    const kmh = car.telemetryState.speedKmh;
    if (kmh >= 100 && timeTo100 === Infinity) timeTo100 = i * TICK;
    topSpeed = Math.max(topSpeed, kmh);
    assert.ok(Number.isFinite(car.position.x), 'car position went NaN');
  }

  assert.ok(timeTo100 > 4.2 && timeTo100 < 6.2, `0-100 km/h in ${timeTo100.toFixed(2)}s`);
  assert.ok(topSpeed > 200 && topSpeed < 330, `top speed ${topSpeed.toFixed(0)} km/h`);
  assert.ok(Math.abs(car.position.x) < 4, `car drifted ${car.position.x.toFixed(2)}m sideways`);
  assert.ok(car.telemetryState.rpm > 1000, 'engine should be turning');

  const speedBeforeBraking = car.telemetryState.speedKmh;
  simulate(world, car, 2.2, { throttle: 0, brake: 1, steer: 0, handbrake: false });
  assert.ok(
    car.telemetryState.speedKmh < speedBeforeBraking - 60,
    `brakes only shed ${(speedBeforeBraking - car.telemetryState.speedKmh).toFixed(0)} km/h`,
  );
  assert.ok(car.telemetryState.driftAngleDeg < 12, 'hard braking should not spin the car');
  simulate(world, car, 0.6, NEUTRAL_INPUT);
  assert.ok(Number.isFinite(car.position.x), 'car position went NaN after braking');
});

test('handbrake initiates a controllable drift', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1, NEUTRAL_INPUT);
  simulate(world, car, 5, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const entrySpeed = car.telemetryState.speedKmh;
  assert.ok(entrySpeed > 80, `entry speed ${entrySpeed.toFixed(0)} km/h`);

  let maxDrift = 0;
  simulate(world, car, 1.4, { throttle: 0.75, brake: 0, steer: 1, handbrake: true }, () => {
    maxDrift = Math.max(maxDrift, car.telemetryState.driftAngleDeg);
  });
  assert.ok(maxDrift > 15, `max drift angle ${maxDrift.toFixed(1)}°`);
  assert.ok(maxDrift < 80, `car simply spun out (${maxDrift.toFixed(1)}°)`);

  // Counter-steer should recover grip instead of spinning.
  simulate(world, car, 2.2, { throttle: 0.5, brake: 0, steer: -0.45, handbrake: false });
  assert.ok(
    Math.abs(car.telemetryState.driftAngleDeg) < 25,
    `drift did not recover (${car.telemetryState.driftAngleDeg.toFixed(1)}°)`,
  );
});

test('suspension carries the car at rest instead of sitting on its bump stops', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 3, NEUTRAL_INPUT);
  const wheels = car.telemetryState.wheels;
  const totalLoad = wheels.reduce((sum, w) => sum + w.load, 0);
  const weight = 1350 * 9.81;

  assert.ok(
    Math.abs(totalLoad - weight) < weight * 0.12,
    `springs carry ${(totalLoad / 1000).toFixed(1)} kN for a ${(weight / 1000).toFixed(1)} kN car`,
  );
  for (const w of wheels) {
    assert.ok(w.contact, `${w.name} lost contact while parked`);
    assert.ok(
      w.suspensionLength > 0.25 && w.suspensionLength < 0.42,
      `${w.name} rests at ${w.suspensionLength.toFixed(3)}m of travel`,
    );
  }
  assert.ok(car.position.y > 0.5, `chassis sits ${car.position.y.toFixed(2)}m high, dragging on the road`);
});

test('suspension absorbs a curb and settles back on its springs', async () => {
  const world = await makeWorld();
  // 12 cm kerb across the road, 3 m wide.
  const kerb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.94, -20));
  world.createCollider(RAPIER.ColliderDesc.cuboid(4, 0.06, 1.5).setFriction(1), kerb);
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1.2, NEUTRAL_INPUT);
  simulate(world, car, 2.6, { throttle: 0.5, brake: 0, steer: 0, handbrake: false });
  simulate(world, car, 2.5, NEUTRAL_INPUT);

  const wheels = car.telemetryState.wheels;
  assert.ok(car.position.y > 0.45, `chassis sank to ${car.position.y.toFixed(2)}m after the kerb`);
  for (const w of wheels) {
    assert.ok(w.contact, `${w.name} stayed off the ground after the kerb`);
    assert.ok(
      w.suspensionLength > 0.2,
      `${w.name} is stuck at ${w.suspensionLength.toFixed(3)}m of travel`,
    );
  }
});

test('full lock at motorway speed does not spin the car', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1, NEUTRAL_INPUT);
  let guard = 0;
  while (car.telemetryState.speed < 50 && guard < 120 * 40) {
    simulate(world, car, 0.1, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    guard += 12;
    assert.ok(Number.isFinite(car.position.x), 'car position went NaN while accelerating');
  }
  assert.ok(car.telemetryState.speedKmh > 170, `only reached ${car.telemetryState.speedKmh.toFixed(0)} km/h`);

  let maxDrift = 0;
  simulate(world, car, 1.6, { throttle: 0.4, brake: 0, steer: 1, handbrake: false }, () => {
    maxDrift = Math.max(maxDrift, Math.abs(car.telemetryState.driftAngleDeg));
  });
  assert.ok(maxDrift < 22, `steering at 180 km/h reached a ${maxDrift.toFixed(0)}° slide`);
  assert.ok(Number.isFinite(car.position.x), 'car position went NaN in the corner');
});

test('car rests without jitter or creeping', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 4, NEUTRAL_INPUT);
  const settled = car.position;
  simulate(world, car, 3, NEUTRAL_INPUT);
  const moved = Math.hypot(car.position.x - settled.x, car.position.z - settled.z);
  assert.ok(moved < 0.25, `crept ${moved.toFixed(3)}m while parked`);
  assert.ok(car.telemetryState.speedKmh < 1, `parked speed ${car.telemetryState.speedKmh.toFixed(2)} km/h`);
  assert.ok(settled.y > 0.35 && settled.y < 0.75, `ride height ${settled.y.toFixed(2)}m`);
});

test('reverse engages at a standstill, drives backwards, then hands back to first', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1, NEUTRAL_INPUT);

  // Hold the brake at a standstill: reverse engages and the car actually moves.
  simulate(world, car, 2.4, { throttle: 0, brake: 1, steer: 0, handbrake: false });
  assert.equal(car.telemetryState.gear, -1, 'brake at a standstill should select reverse');
  assert.ok(
    car.position.z > 1.2,
    `car only reversed ${car.position.z.toFixed(2)}m — the parking hold may be cancelling it`,
  );
  assert.ok(car.telemetryState.speedKmh > 8, `reverse speed ${car.telemetryState.speedKmh.toFixed(1)}`);
  assert.ok(car.telemetryState.speedKmh < 40, 'reverse should stay a manoeuvring gear');

  // Throttle has to brake the reverse motion first, then pull away forwards.
  simulate(world, car, 3.2, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  assert.equal(car.telemetryState.gear, 1, 'throttle should leave reverse');
  const before = car.position.z;
  simulate(world, car, 1.5, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  assert.ok(car.position.z < before - 1, 'car did not drive forwards after reversing');
});

test('a slide can be caught with counter-steer instead of ending in a spin', async () => {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  simulate(world, car, 1, NEUTRAL_INPUT);
  simulate(world, car, 6, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  assert.ok(car.telemetryState.speedKmh > 95, 'entry speed too low');

  let peak = 0;
  simulate(world, car, 0.9, { throttle: 0.8, brake: 0, steer: 1, handbrake: true }, () => {
    peak = Math.max(peak, Math.abs(car.telemetryState.driftAngleDeg));
  });
  assert.ok(peak > 15, `handbrake only produced ${peak.toFixed(0)}° of slide`);

  // A driver reacting to the slide: wheel turns against it, unwound as it returns.
  for (let i = 0; i < 120 * 3; i++) {
    const slip = car.telemetryState.slipAngle;
    const steer = Math.max(-1, Math.min(1, (slip * 180) / Math.PI * 0.05));
    car.step(TICK, { throttle: 0.45, brake: 0, steer, handbrake: false }, world);
    world.step();
  }
  assert.ok(
    Math.abs(car.telemetryState.driftAngleDeg) < 20,
    `slide still at ${car.telemetryState.driftAngleDeg.toFixed(0)}° after counter-steering`,
  );
  assert.ok(
    car.telemetryState.speedKmh > 25,
    `recovery scrubbed all the speed (${car.telemetryState.speedKmh.toFixed(0)} km/h)`,
  );
});

test('the grand-angle kit recovers angles the stock rack cannot', async () => {
  const run = async (maxSteer: number) => {
    const world = await makeWorld();
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, { ...STOCK_SPEC, maxSteer });
    simulate(world, car, 1, NEUTRAL_INPUT);
    simulate(world, car, 6, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    // Build a big angle, then hand over to the driver.
    let built = 0;
    let guard = 0;
    while (Math.abs(built) < 55 && guard < 120 * 4) {
      car.step(TICK, { throttle: 0.8, brake: 0, steer: 1, handbrake: true }, world);
      world.step();
      built = car.telemetryState.driftAngleDeg;
      guard++;
    }
    for (let i = 0; i < 120 * 3; i++) {
      const slip = car.telemetryState.slipAngle;
      const steer = Math.max(-1, Math.min(1, (slip * 180) / Math.PI * 0.05));
      car.step(TICK, { throttle: 0.45, brake: 0, steer, handbrake: false }, world);
      world.step();
    }
    return { end: Math.abs(car.telemetryState.driftAngleDeg), speed: car.telemetryState.speedKmh };
  };

  const stock = await run(STOCK_SPEC.maxSteer);
  const kit = await run(1.15);
  // The stock rack runs out of lock at big angles and the car scrubs to a stop;
  // the kit still steers into the slide and drives out of it.
  assert.ok(
    kit.speed > stock.speed + 12,
    `kit kept ${kit.speed.toFixed(0)} km/h vs ${stock.speed.toFixed(0)}`,
  );
  assert.ok(
    kit.end <= stock.end + 2,
    `kit ended at ${kit.end.toFixed(0)}° vs stock ${stock.end.toFixed(0)}°`,
  );
  assert.ok(kit.end < 15, `kit still sliding at ${kit.end.toFixed(0)}°`);
});

test('setup parts change the car the way the garage claims', async () => {
  const accel = async (setup: Setup) => {
    const world = await makeWorld();
    const spec = resolveSpec(setup);
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, spec);
    simulate(world, car, 1, NEUTRAL_INPUT);
    let timeTo100 = Infinity;
    for (let i = 0; i < 120 * 20; i++) {
      car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
      world.step();
      if (car.telemetryState.speedKmh >= 100 && timeTo100 === Infinity) timeTo100 = i * TICK;
    }
    return timeTo100;
  };

  const stock = await accel({ ...DEFAULT_SETUP });
  const tuned = await accel({ ...DEFAULT_SETUP, engine: 3, exhaust: 2, weight: 2, tires: 1, suspension: 2 });
  assert.ok(tuned < stock - 0.8, `tuned car did 0-100 in ${tuned.toFixed(2)}s vs ${stock.toFixed(2)}s`);

  const stockSpec = resolveSpec(DEFAULT_SETUP);
  const gripSpec = resolveSpec({ ...DEFAULT_SETUP, tires: 1 });
  const driftSpec = resolveSpec({ ...DEFAULT_SETUP, tires: 2 });
  assert.ok(gripSpec.muRear > stockSpec.muRear, 'semi-slicks should grip harder');
  assert.ok(driftSpec.muRear < stockSpec.muRear, 'drift tires should slide more');
  assert.ok(driftSpec.peakSlipAngle > stockSpec.peakSlipAngle, 'drift tires should peak later');
  assert.ok(resolveSpec({ ...DEFAULT_SETUP, suspension: 3 }).wheelTravel > stockSpec.wheelTravel, 'rally suspension needs more travel');
  assert.ok(resolveSpec({ ...DEFAULT_SETUP, steering: 1 }).maxSteer > stockSpec.maxSteer, 'the kit should steer further');
});

test('the car climbs a 15% gradient from a standstill', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TICK;
  const angle = Math.atan(0.15);
  const ramp = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setRotation({
      x: Math.sin(angle / 2),
      y: 0,
      z: 0,
      w: Math.cos(angle / 2),
    }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 120).setFriction(1), ramp);

  const car = new Vehicle(world, { x: 0, y: 4, z: 40, heading: 0 });
  simulate(world, car, 1.5, NEUTRAL_INPUT);
  const start = car.position;
  simulate(world, car, 6, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  assert.ok(car.telemetryState.speedKmh > 40, `only reached ${car.telemetryState.speedKmh.toFixed(0)} km/h on the climb`);
  assert.ok(car.position.y > start.y + 2, `car climbed ${(car.position.y - start.y).toFixed(2)}m`);
  assert.ok(car.position.z < start.z - 15, 'car did not make progress up the hill');
});

test('a spinning rear axle does not shift the box mid-slide', () => {
  const box = new Drivetrain();
  // A drift: the rear tires run at 25 m/s while the chassis is doing 15 m/s.
  // Shifting on the wheel speed read that as a 90 km/h car and climbed to
  // fourth, dropping the engine out of its torque and killing the slide.
  for (let i = 0; i < 240; i++) box.update(TICK, 25 / 0.34, 1, 0, 15);
  assert.equal(box.gear, 1, `the box climbed to gear ${box.gear} on wheelspin`);
  assert.ok(box.rpm > 5000, `engine should be spinning with the wheels (${box.rpm.toFixed(0)} rpm)`);
});

test('a spinning axle at a standstill does not shift the box', () => {
  const box = new Drivetrain();
  // Wheels at 90 km/h, chassis at a standstill: no road speed, no upshift.
  for (let i = 0; i < 240; i++) box.update(TICK, 25 / 0.34, 1, 0, 0, 0);
  assert.equal(box.gear, 1, `the box climbed to gear ${box.gear} at a standstill`);
});

test('the rev limiter bounces instead of cutting torque to a crawl', () => {
  const box = new Drivetrain();
  const omega = ((box.config.redlineRpm / 60) * 2 * Math.PI) / (3.62 * 3.55) / 0.34;
  let cuts = 0;
  let full = 0;
  let torqueSum = 0;
  for (let i = 0; i < 240; i++) {
    const out = box.update(TICK, omega, 1, 0, 40);
    if (out.limiter) cuts++;
    else if (out.axleTorque > 0) full++;
    torqueSum += out.axleTorque;
  }
  assert.ok(cuts > 20, `only ${cuts} fuel cuts in two seconds`);
  assert.ok(full > 20, 'the limiter never gave the engine back');
  assert.ok(torqueSum > 0, 'no drive at all on the limiter');
});

test('loose ground really is slower and slipperier than asphalt', async () => {
  // One world each: two cars spawned on the same spot push each other, which
  // measures the collision solver rather than the surface.
  const asphaltWorld = await makeWorld();
  const dirtWorld = await makeWorld();
  const asphalt = new Vehicle(asphaltWorld, { x: 0, y: 0.9, z: 0, heading: 0 }, STOCK_SPEC);
  const dirt = new Vehicle(
    dirtWorld,
    {
      x: 0,
      y: 0.9,
      z: 0,
      heading: 0,
      surfaceAt: () => ({ kind: 'terre', grip: 0.62, peak: 1.3, rolling: 2.6, roughness: 0.7 }),
    },
    STOCK_SPEC,
  );
  for (const [world, car] of [
    [asphaltWorld, asphalt],
    [dirtWorld, dirt],
  ] as const) {
    simulate(world, car, 1, NEUTRAL_INPUT);
    simulate(world, car, 4, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  }
  assert.ok(
    asphalt.telemetryState.speedKmh > dirt.telemetryState.speedKmh + 8,
    `asphalt ${asphalt.telemetryState.speedKmh.toFixed(0)} vs dirt ${dirt.telemetryState.speedKmh.toFixed(0)} km/h`,
  );
  assert.equal(dirt.telemetryState.surface.kind, 'terre');

  // Braking from speed: less grip, longer stop.
  const before = { asphalt: asphalt.telemetryState.speedKmh, dirt: dirt.telemetryState.speedKmh };
  simulate(asphaltWorld, asphalt, 2, { throttle: 0, brake: 1, steer: 0, handbrake: false });
  simulate(dirtWorld, dirt, 2, { throttle: 0, brake: 1, steer: 0, handbrake: false });
  const asphaltDrop = before.asphalt - asphalt.telemetryState.speedKmh;
  const dirtDrop = before.dirt - dirt.telemetryState.speedKmh;
  assert.ok(asphaltDrop > dirtDrop, `asphalt shed ${asphaltDrop.toFixed(0)}, dirt ${dirtDrop.toFixed(0)} km/h`);
});

test('the col is a switchback climb, not a spiral', () => {
  const road = MOUNTAIN_ROADS[0];
  const p = road.points;
  let length = 0;
  let climb = 0;
  let maxGrade = 0;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    if (d < 0.01) continue;
    length += d;
    climb += p[i].y - p[i - 1].y;
    maxGrade = Math.max(maxGrade, Math.abs(p[i].y - p[i - 1].y) / d);
  }
  assert.ok(length > 900, `only ${length.toFixed(0)} m of road`);
  assert.ok(climb > 50, `climbs ${climb.toFixed(1)} m`);
  assert.ok(maxGrade < 0.165, `grade reaches ${(maxGrade * 100).toFixed(1)}%`);

  let hairpins = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const b = p[i];
    const c = p[i + 1];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (cross < 1e-6) continue;
    const radius = (ab * bc * ca) / (2 * cross);
    if (radius < 26) hairpins++;
  }
  assert.ok(hairpins > 24, `only ${hairpins} tight points: that is a spiral, not a col`);
});

test('the rally stage and the roads report the right surface', () => {
  assert.equal(surfaceAt(RALLY_START.x, RALLY_START.z).kind, 'terre');
  assert.equal(surfaceAt(DIRT_TRACKS[0].points[10].x, DIRT_TRACKS[0].points[10].z).kind, 'terre');
  assert.equal(surfaceAt(SPAWN.x, SPAWN.z).kind, 'asphalte');
  assert.equal(surfaceAt(-480, -420).kind, 'asphalte', 'the summit pad should be paved');
  assert.equal(surfaceAt(700, 700).kind, 'herbe');
  assert.ok(surfaceAt(700, 700).grip < surfaceAt(SPAWN.x, SPAWN.z).grip);
});

test('the terrain sits just under the asphalt everywhere on the col', () => {
  const samples = MOUNTAIN_ROADS[0].samples;
  for (let i = 0; i < samples.length; i += 3) {
    const s = samples[i];
    const ground = heightAt(s.x, s.z);
    assert.ok(
      ground < s.y + 0.02 && ground > s.y - 0.3,
      `terrain ${ground.toFixed(2)} vs road ${s.y.toFixed(2)} at ${s.x.toFixed(0)},${s.z.toFixed(0)}`,
    );
  }
});

test('the summit arena is one flat slab, with ground under all of it', () => {
  // The col stacks switchbacks, so a lower leg runs underneath the summit. Its
  // 32 m embankment blend used to pull the ground up to 5 m below the concrete
  // disc: the car drove off the disc and fell through it onto the hillside.
  for (let r = 0; r <= SUMMIT.radius; r += 2.5) {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const x = SUMMIT.cx + Math.cos(a) * r;
      const z = SUMMIT.cz + Math.sin(a) * r;
      const ground = heightAt(x, z);
      assert.ok(
        Math.abs(ground - SUMMIT.y) < 0.02,
        `ground ${ground.toFixed(2)} under the disc at r=${r.toFixed(0)}, road level ${SUMMIT.y.toFixed(2)}`,
      );
    }
  }
});

test('the drift pad sits level with the street that reaches it', () => {
  for (let x = DRIFT_PAD.cx - DRIFT_PAD.halfX; x <= DRIFT_PAD.cx + DRIFT_PAD.halfX; x += 6) {
    for (let z = DRIFT_PAD.cz - DRIFT_PAD.halfZ; z <= DRIFT_PAD.cz + DRIFT_PAD.halfZ; z += 6) {
      assert.ok(padEdgeDistance(x, z) <= 0, 'sample outside the pad');
      const ground = heightAt(x, z);
      assert.ok(
        Math.abs(ground - DRIFT_PAD.y) < 0.25,
        `ground ${ground.toFixed(2)} vs pad ${DRIFT_PAD.y.toFixed(2)} at ${x.toFixed(0)},${z.toFixed(0)}`,
      );
    }
  }
});

test('city streets end on a turning circle instead of a raw cut', () => {
  const ends = roadEnds();
  assert.ok(ends.length >= 12, `only ${ends.length} dead ends treated`);
  for (const end of ends) {
    assert.ok(end.radius > 8, `${end.radius.toFixed(1)} m bulb at ${end.x.toFixed(0)},${end.z.toFixed(0)}`);
    assert.equal(surfaceAt(end.x, end.z).kind, 'asphalte', 'a turning circle has to be paved');
  }
});

test('a stationary burnout stays in first instead of climbing the box', () => {
  const box = new Drivetrain();
  // Wheels spinning hard, car going nowhere: the axle is fast but the chassis is
  // not, so there is nothing to upshift for.
  for (let i = 0; i < 240; i++) box.update(TICK, 30 / 0.34, 1, 0, 0.1, 0.1);
  assert.equal(box.gear, 1, `gearbox climbed to ${box.gear} on the spot`);
});

test('the chassis no longer catches the ground over a crest at speed', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TICK;
  // A road with a crest, laid out like the terrain: a triangle mesh in the
  // ground collision group, so only the tires and a rolled car touch it.
  const crest = (x: number) =>
    x > -40 && x < 240 ? 0.42 * Math.max(0, Math.cos((x - 20) / 14)) ** 2 : 0;
  const step = 1.5;
  const cols = Math.ceil(420 / step);
  const rows = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const x = -60 + i * step;
    const y = crest(x);
    for (let j = 0; j <= rows; j++) positions.push(x, y, -30 + j * 5);
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + 1;
      const c = a + rows + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices))
      .setFriction(0.95)
      .setCollisionGroups((GROUP_GROUND << 16) | 0xffff),
    ground,
  );

  for (const def of CARS) {
    const spec = resolveSpec({ ...DEFAULT_SETUP, suspension: 3, tires: 3 }, def.spec);
    const car = new Vehicle(world, { x: -40, y: 0.9, z: 0, heading: -Math.PI / 2 }, spec);
    simulate(world, car, 1, NEUTRAL_INPUT);
    car.body.setLinvel({ x: 46, y: 0, z: 0 }, true);

    let previous = car.telemetryState.speedKmh;
    let worstDrop = 0;
    let worstX = 0;
    for (let i = 0; i < 120 * 5; i++) {
      car.step(TICK, { throttle: 0, brake: i > 30 ? 1 : 0, steer: 0, handbrake: false }, world);
      world.step();
      const kmh = car.telemetryState.speedKmh;
      if (previous - kmh > worstDrop) {
        worstDrop = previous - kmh;
        worstX = car.position.x;
      }
      previous = kmh;
      assert.ok(Number.isFinite(car.position.x), `${def.id} went NaN on the crest`);
    }
    // Braking from 165 km/h sheds about 0.4 km/h per tick. A belly strike with
    // friction used to take 87 km/h out in a single tick.
    assert.ok(
      worstDrop < 3,
      `${def.id} lost ${worstDrop.toFixed(1)} km/h in one tick at x=${worstX.toFixed(0)}`,
    );
  }
});

test('an all-wheel-drive launch on gravel puts the power down', async () => {
  const gravel = { kind: 'terre', grip: 0.62, peak: 1.3, rolling: 2.6, roughness: 0.72 };
  const launch = async (spec: VehicleSpec) => {
    const world = await makeWorld();
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0, surfaceAt: () => gravel }, spec);
    simulate(world, car, 1, NEUTRAL_INPUT);
    let worstSlip = 0;
    let spinning = 0;
    for (let i = 0; i < 120 * 6; i++) {
      car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
      world.step();
      for (const w of car.telemetryState.wheels) {
        if (w.forceLong === 0 && !w.contact) continue;
        worstSlip = Math.max(worstSlip, Math.abs(w.slipRatio));
      }
      if (car.telemetryState.wheels.some((w) => Math.abs(w.slipRatio) > 0.35)) spinning++;
    }
    return {
      kmh: car.telemetryState.speedKmh,
      worstSlip,
      spinSeconds: spinning * TICK,
    };
  };

  const i20 = CARS.find((c) => c.id === 'i20n')!;
  const rally = resolveSpec({ ...DEFAULT_SETUP, suspension: 3, tires: 3 }, i20.spec);
  const legacy = { ...rally, driveFront: 0, tractionControl: 0 };
  const driven = await launch(rally);
  const spinning = await launch(legacy);

  // The rear-drive, no-assist rally car is the car that could not climb out of
  // its own wheelspin at 5 km/h.
  assert.ok(spinning.worstSlip > 1.5, `the old setup only reached ${spinning.worstSlip.toFixed(1)} slip`);
  assert.ok(driven.worstSlip < 0.45, `driven wheels still slipping at ${driven.worstSlip.toFixed(2)}`);
  assert.ok(driven.spinSeconds < 0.6, `spinning for ${driven.spinSeconds.toFixed(1)}s`);
  assert.ok(driven.kmh > 55, `only ${driven.kmh.toFixed(0)} km/h after 6 s on gravel`);
});

test('the i20 N pulls away from a standstill without lighting up the tires', async () => {
  const world = await makeWorld();
  const i20 = CARS.find((c) => c.id === 'i20n')!;
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, i20.spec);
  simulate(world, car, 1, NEUTRAL_INPUT);
  for (let i = 0; i < 120 * 4; i++) {
    car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
    world.step();
  }
  assert.ok(car.telemetryState.speedKmh > 65, `only ${car.telemetryState.speedKmh.toFixed(0)} km/h after 4 s`);
  for (const w of car.telemetryState.wheels) {
    assert.ok(Math.abs(w.slipRatio) < 0.35, `${w.name} slipping at ${w.slipRatio.toFixed(2)} on asphalt`);
  }
});

test('every car pulls hard from a standstill', async () => {
  const times: Record<string, number> = {};
  for (const def of CARS) {
    const world = await makeWorld();
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, def.spec);
    simulate(world, car, 1, NEUTRAL_INPUT);
    let time = Infinity;
    for (let i = 0; i < 120 * 12; i++) {
      car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
      world.step();
      if (car.telemetryState.speedKmh >= 100 && time === Infinity) time = i * TICK;
    }
    times[def.id] = time;
  }
  // The slipping clutch used to drag the flywheel's reflected inertia through
  // first gear, and every car felt gutless: the Aventador needed 5.5 s.
  assert.ok(times.aventador < 4.6, `Aventador 0-100 in ${times.aventador.toFixed(1)}s`);
  assert.ok(times.i20n < 6.5, `i20 N 0-100 in ${times.i20n.toFixed(1)}s`);
  assert.ok(times.rx7 < 7.5, `RX-7 0-100 in ${times.rx7.toFixed(1)}s`);
});

test('the traction control can be switched off, and the rear tires then spin', async () => {
  async function launch(tcs: boolean): Promise<number> {
    const world = await makeWorld();
    const rx7 = CARS.find((c) => c.id === 'rx7')!;
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, rx7.spec);
    car.tcsEnabled = tcs;
    simulate(world, car, 1, NEUTRAL_INPUT);
    let peak = 0;
    for (let i = 0; i < 120 * 1.5; i++) {
      car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
      world.step();
      for (const w of car.telemetryState.wheels) {
        if (w.name.startsWith('R')) peak = Math.max(peak, Math.abs(w.slipRatio));
      }
    }
    return peak;
  }
  const assisted = await launch(true);
  const free = await launch(false);
  assert.ok(free > assisted * 1.3, `off gave ${free.toFixed(2)} of slip, on ${assisted.toFixed(2)}`);
});

test('the walls stop the chassis, and the same walls in the ground group do not', async () => {
  // Le châssis est membre de GROUP_WORLD et ne filtre que sur GROUP_WORLD. Les
  // murs du circuit portent donc (WORLD << 16) | WORLD ; quand tout le modèle
  // était dans le groupe du sol, on les traversait sans rien sentir.
  const world = await makeWorld();
  // Sans gravité ni sol sous les boîtes, la seule chose qui peut les arrêter est
  // le mur : le test ne mesure que le couplage des groupes de collision.
  world.gravity = { x: 0, y: 0, z: 0 };
  const chassisGroups = (GROUP_WORLD << 16) | GROUP_WORLD;

  // Chaque essai a sa file : une boîte lancée vers +z, un mur à z = +4, une
  // file par variante de groupe.
  const run = (x: number, groups: number): number => {
    const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 3, 4));
    world.createCollider(RAPIER.ColliderDesc.cuboid(6, 1, 0.2).setCollisionGroups(groups), wall);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 3, -4).setLinvel(0, 0, 6),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.9, 0.5, 2.2).setCollisionGroups(chassisGroups),
      body,
    );
    world.timestep = 1 / 60;
    for (let i = 0; i < 120; i++) world.step();
    return body.translation().z;
  };

  const structures = run(0, chassisGroups);
  const rawGround = run(20, GROUP_GROUND);
  const groundPair = run(40, (GROUP_GROUND << 16) | GROUP_GROUND);
  console.log(`murs : structures z=${structures.toFixed(1)}, sol brut z=${rawGround.toFixed(1)}, sol apparié z=${groundPair.toFixed(1)}`);

  assert.ok(structures < 3, `the chassis went through the wall, to z=${structures.toFixed(1)}`);
});

test('the ABS keeps the wheels rolling under full braking, and cutting it locks them', async () => {
  // Braking from 100 km/h with the pedal to the floor. On, the assist trims the
  // torque as the slip crosses the tire's peak, so the wheels keep rolling and
  // the car stops in a shorter distance. Off, the wheels lock and slide.
  async function stop(abs: boolean): Promise<{
    distance: number;
    lock: number;
    stalls: number;
    time: number;
  }> {
    const world = await makeWorld();
    const rx7 = CARS.find((c) => c.id === 'rx7')!;
    const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, rx7.spec);
    car.absEnabled = abs;
    simulate(world, car, 1, NEUTRAL_INPUT);
    for (let i = 0; i < 120 * 20 && car.telemetryState.speedKmh < 100; i++) {
      car.step(TICK, { throttle: 1, brake: 0, steer: 0, handbrake: false }, world);
      world.step();
    }
    assert.ok(car.telemetryState.speedKmh > 90, `only reached ${car.telemetryState.speedKmh.toFixed(0)} km/h`);
    let distance = 0;
    let time = 0;
    let lock = 0;
    // Un tour de roue arrêté alors que la voiture roule encore : c'est la
    // définition d'une roue bloquée, et c'est ce que l'ABS doit empêcher.
    let stalls = 0;
    while (car.telemetryState.speedKmh > 3 && time < 15) {
      car.step(TICK, { throttle: 0, brake: 1, steer: 0, handbrake: false }, world);
      world.step();
      distance += (car.telemetryState.speedKmh / 3.6) * TICK;
      time += TICK;
      // Le glissement ne compte qu'au-dessus de 20 km/h : à l'arrêt, un pas de
      // calcul ne peut pas descendre plus bas qu'un tour de roue.
      for (const w of car.telemetryState.wheels) {
        if (car.telemetryState.speedKmh <= 20) continue;
        lock = Math.max(lock, Math.abs(w.slipRatio));
        if (Math.abs(w.omega) < 1) stalls++;
      }
    }
    return { distance, lock, stalls, time };
  }

  const assisted = await stop(true);
  const locked = await stop(false);
  const detail = (r: { lock: number; stalls: number; distance: number }): string =>
    `peak slip ${r.lock.toFixed(2)}, ${r.stalls} tours de roue bloqués, ` +
    `${r.distance.toFixed(1)} m`;
  assert.ok(
    assisted.stalls === 0,
    `with the ABS a wheel stopped turning while the car was still rolling: ${detail(assisted)}`,
  );
  assert.ok(
    locked.stalls > 20,
    `without it no wheel ever locked: ${detail(locked)}`,
  );
  assert.ok(assisted.lock < 0.5, `with the ABS the tires slid too far: ${detail(assisted)}`);
  assert.ok(
    assisted.distance < locked.distance,
    `ABS stopped in ${assisted.distance.toFixed(1)} m, locked in ${locked.distance.toFixed(1)} m`,
  );
});

test('full throttle while turning drives the car forward instead of crabbing', async () => {
  // The "crab": the unloaded inside front tire spun, the combined slip took the
  // whole front axle's lateral grip, and the car slid diagonally at 5 km/h with
  // the wheel turned. A player meets this at a junction, from a standstill.
  const world = await makeWorld();
  const aventador = CARS.find((c) => c.id === 'aventador')!;
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 }, aventador.spec);
  simulate(world, car, 1, NEUTRAL_INPUT);
  const yawBefore = 2 * Math.atan2(car.rotation.y, car.rotation.w);
  let maxFrontSpin = 0;
  simulate(
    world,
    car,
    3,
    { throttle: 1, brake: 0, steer: 0.5, handbrake: false },
    () => {
      // FL and FR come first in the telemetry.
      for (const w of car.telemetryState.wheels.slice(0, 2)) {
        maxFrontSpin = Math.max(maxFrontSpin, Math.abs(w.slipRatio));
      }
    },
  );
  const yawAfter = 2 * Math.atan2(car.rotation.y, car.rotation.w);
  const turned = Math.abs(((yawAfter - yawBefore) * 180) / Math.PI);
  assert.ok(
    car.telemetryState.speedKmh > 60,
    `only ${car.telemetryState.speedKmh.toFixed(0)} km/h after 3 s: the car is crabbing`,
  );
  assert.ok(turned > 40, `the car only rotated ${turned.toFixed(0)}° with the wheel turned`);
  assert.ok(maxFrontSpin < 0.5, `a front tire spun at ${maxFrontSpin.toFixed(2)}`);
});

test('the rally car steers on gravel at speed instead of plowing', async () => {
  const gravel = { kind: 'terre', grip: 0.62, peak: 1.3, rolling: 2.6, roughness: 0.72 };
  const world = await makeWorld();
  const i20 = CARS.find((c) => c.id === 'i20n')!;
  const spec = resolveSpec({ ...DEFAULT_SETUP, suspension: 3, tires: 3 }, i20.spec);
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0, surfaceAt: () => gravel }, spec);
  simulate(world, car, 1, NEUTRAL_INPUT);
  simulate(world, car, 3, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const entry = car.telemetryState.speedKmh;

  let peakAngle = 0;
  let minFront = Infinity;
  simulate(
    world,
    car,
    4,
    { throttle: 1, brake: 0, steer: 0.5, handbrake: false },
    () => {
      peakAngle = Math.max(peakAngle, Math.abs(car.telemetryState.driftAngleDeg));
      for (const w of car.telemetryState.wheels.slice(0, 2)) {
        minFront = Math.min(minFront, w.forceLat);
      }
    },
  );
  assert.ok(entry > 40, `entry speed ${entry.toFixed(0)} km/h`);
  assert.ok(
    car.telemetryState.speedKmh > 55,
    `the car fell to ${car.telemetryState.speedKmh.toFixed(0)} km/h in the corner`,
  );
  assert.ok(peakAngle < 45, `the car slid to ${peakAngle.toFixed(0)}° instead of turning`);
  assert.ok(minFront > -300, `a front tire pushed back at ${minFront.toFixed(0)} N`);
});

test('the all-terrain tires are the ones that grip in the dirt', () => {
  const i20 = CARS.find((c) => c.id === 'i20n')!;
  const road = resolveSpec({ ...DEFAULT_SETUP, tires: 0 }, i20.spec);
  const rally = resolveSpec({ ...DEFAULT_SETUP, tires: 3 }, i20.spec);
  const loose = { kind: 'terre', grip: 0.62, peak: 1.3, rolling: 2.6, roughness: 0.72 };
  const effective = (spec: typeof road) => spec.muRear * loose.grip * spec.looseGrip;
  assert.ok(rally.looseGrip > road.looseGrip, 'the rally set has no grip bonus in the dirt');
  assert.ok(
    effective(rally) > effective(road) * 1.15,
    `rally ${effective(rally).toFixed(2)} vs road ${effective(road).toFixed(2)}`,
  );
});

test('a car that ends up under the track is put back on the surface', async () => {
  // Atterrissage sur deux roues : les rayons des roues ne portent plus rien et
  // le châssis, qui ne collisionne qu'avec les murs, passait sous l'asphalte.
  const world = await makeWorld();
  world.timestep = 1 / 60;
  const slab = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 0.3, 60).setCollisionGroups((GROUP_GROUND << 16) | GROUP_GROUND),
    slab,
  );
  const rx7 = CARS.find((c) => c.id === 'rx7')!;
  const car = new Vehicle(world, { x: 0, y: -1, z: 0, heading: 0, floorAt: () => 0 }, rx7.spec);
  for (let i = 0; i < 30; i++) {
    car.step(TICK, NEUTRAL_INPUT, world);
    world.step();
  }
  assert.ok(car.position.y > 0.2, `the car stayed under the track (y=${car.position.y.toFixed(2)})`);
});

test('a landing behaves the same at 0, 60, 120 and 200 km/h', async () => {
  // Le cas rapporté : la voiture retombe sur deux roues, aucun rayon ne porte et
  // elle finissait sous la piste. On rejoue exactement ça à quatre vitesses,
  // avec 20° de roulis : la hauteur finale doit rester la même.
  const rx7 = CARS.find((c) => c.id === 'rx7')!;
  const land = async (kmh: number): Promise<number> => {
    const world = await makeWorld();
    world.timestep = 1 / 60;
    const slab = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(600, 0.3, 600).setCollisionGroups((GROUP_GROUND << 16) | GROUP_GROUND),
      slab,
    );
    // La plaque est à 0,3 m : `floorAt` renvoie sa surface.
    const car = new Vehicle(world, { x: 0, y: 2.4, z: 0, heading: 0, floorAt: () => 0.3 }, rx7.spec);
    car.body.setLinvel({ x: 0, y: -5, z: -(kmh / 3.6) }, true);
    const half = 0.35 / 2;
    car.body.setRotation({ x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }, true);
    for (let i = 0; i < 240; i++) {
      car.step(TICK, NEUTRAL_INPUT, world);
      world.step();
    }
    return car.position.y;
  };
  const rest = await land(0);
  for (const kmh of [60, 120, 200]) {
    const y = await land(kmh);
    assert.ok(y > 0.55, `at ${kmh} km/h the car ended under the track (y=${y.toFixed(2)})`);
    assert.ok(y < rest + 1.5, `at ${kmh} km/h the car jumped (y=${y.toFixed(2)})`);
  }
});
