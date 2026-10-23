import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { magicFormula, slipRatioFromWheelSpeed, tireForces } from '../src/physics/tire.ts';
import { Drivetrain, torqueAtRpm } from '../src/physics/drivetrain.ts';
import { Vehicle, NEUTRAL_INPUT, type VehicleInput } from '../src/physics/vehicle.ts';

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

  assert.ok(timeTo100 > 3 && timeTo100 < 9, `0-100 km/h in ${timeTo100.toFixed(2)}s`);
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
