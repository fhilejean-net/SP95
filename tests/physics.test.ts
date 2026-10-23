import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { magicFormula, slipRatioFromWheelSpeed, tireForces } from '../src/physics/tire.ts';
import { Drivetrain, torqueAtRpm } from '../src/physics/drivetrain.ts';
import { Vehicle, NEUTRAL_INPUT, STOCK_SPEC, type VehicleInput } from '../src/physics/vehicle.ts';
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
