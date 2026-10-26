import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { Bike } from '../src/physics/bike.ts';
import { SUPERMOTARD } from '../src/game/bikes.ts';
import { NEUTRAL_INPUT, type VehicleInput } from '../src/physics/vehicle.ts';
import {
  BAVETTE_ANGLE,
  balanceAngle,
  holdTarget,
  leanFor,
  wheelieAcceleration,
  type WheelieGeometry,
} from '../src/physics/wheelie.ts';

const geometry: WheelieGeometry = {
  cgHeight: 0.72,
  cgFromRear: 0.95,
  wheelbase: 1.48,
  liftGain: 0.95,
};
const mass = 210;

const fullGas = {
  axleTorque: 700,
  throttle: 1,
  brake: 0,
  rearContact: true,
  speed: 20,
  grip: 1,
};

test('the wheelie balance point sits where the barycentre leans over the rear contact', () => {
  const balance = balanceAngle(geometry);
  assert.ok(Math.abs(balance - Math.atan2(0.95, 0.72)) < 1e-9);
  assert.ok(balance > 0.88 && balance < 0.97, `${balance.toFixed(3)} rad`);
  // A bavette sits just under it: the tail scrapes before the bike goes over.
  assert.ok(BAVETTE_ANGLE < balance, 'the bavette should be reachable');
  assert.ok(holdTarget(1, 0) < BAVETTE_ANGLE, 'full gas alone should not scrape the tail');
});

test('the front tire holds the nose down, so gas alone does not wheelie', () => {
  const atRest = wheelieAcceleration(
    { pitch: 0, pitchVelocity: 0 },
    fullGas,
    geometry,
    mass,
  );
  assert.ok(atRest <= 1e-6, `a bike at rest must stay down, got ${atRest.toFixed(2)}`);
});

test('the throttle holds the front up, the brake puts it back down', () => {
  const raised = { pitch: 0.85, pitchVelocity: 0 };
  const idle = wheelieAcceleration(raised, { ...fullGas, throttle: 0 }, geometry, mass);
  assert.ok(idle < 0, `no throttle should bring the front down, got ${idle.toFixed(2)}`);

  // Above the angle the throttle asks for, the rider rolls off and the front
  // falls back: that is what makes the balance controllable.
  const overTarget = wheelieAcceleration(raised, fullGas, geometry, mass);
  assert.ok(overTarget < 0, `past the hold angle it should fall back, got ${overTarget.toFixed(2)}`);

  const under = wheelieAcceleration({ pitch: 0.4, pitchVelocity: 0 }, fullGas, geometry, mass);
  assert.ok(under > 0, `gas at 23° should still lift, got ${under.toFixed(2)}`);

  const braking = wheelieAcceleration(
    { pitch: 0.7, pitchVelocity: 0 },
    { ...fullGas, brake: 1 },
    geometry,
    mass,
  );
  assert.ok(braking < -5, `the front brake should drop the bike, got ${braking.toFixed(2)}`);
});

test('past the balance point the throttle cannot save the wheelie', () => {
  const pastBalance = wheelieAcceleration(
    { pitch: 1.0, pitchVelocity: 0 },
    fullGas,
    geometry,
    mass,
  );
  assert.ok(pastBalance > 0, `it should keep going over, got ${pastBalance.toFixed(2)}`);
  // Only the brake brings it back from there.
  const saved = wheelieAcceleration({ pitch: 1.0, pitchVelocity: 0 }, { ...fullGas, brake: 1 }, geometry, mass);
  assert.ok(saved < pastBalance - 10, `the brake should pull it back, got ${saved.toFixed(2)}`);

  // In the air, or with the rear off the ground, no wheelie at all.
  const airborne = wheelieAcceleration(
    { pitch: 0.5, pitchVelocity: 0 },
    { ...fullGas, rearContact: false },
    geometry,
    mass,
  );
  assert.ok(airborne < 0);
});

test('grip and engine authority limit how high the front can be held', () => {
  const grass = wheelieAcceleration(
    { pitch: 0.5, pitchVelocity: 0 },
    { ...fullGas, grip: 0.4 },
    geometry,
    mass,
  );
  const road = wheelieAcceleration({ pitch: 0.5, pitchVelocity: 0 }, fullGas, geometry, mass);
  assert.ok(grass < road, `grass should hold the front lower (${grass.toFixed(2)} vs ${road.toFixed(2)})`);

  const tallGear = wheelieAcceleration(
    { pitch: 0.5, pitchVelocity: 0 },
    { ...fullGas, throttle: 0.1, axleTorque: 90 },
    geometry,
    mass,
  );
  assert.ok(tallGear < 0, 'no torque, no wheelie');
});

test('lean follows the yaw rate and is capped', () => {
  // Positive yaw is a left turn, so the bike leans left (negative).
  assert.ok(leanFor(20, 0.4, 0.9) < 0);
  assert.ok(leanFor(20, -0.4, 0.9) > 0);
  assert.equal(leanFor(0, -1, 0.9), 0);
  assert.ok(Math.abs(leanFor(40, -3, 0.9)) <= 0.9);
});

test('the supermotard pulls away, wheelies on the pop and brakes down', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setTranslation(0, -0.5, 0),
    ground,
  );

  const spec = SUPERMOTARD.spec;
  const bike = new Bike(world, { x: 0, y: spec.cgHeight, z: 0, heading: 0 }, spec);
  const input: VehicleInput = { ...NEUTRAL_INPUT };
  const step = (count: number) => {
    for (let i = 0; i < count; i++) {
      bike.step(1 / 120, input, world);
      world.step();
    }
  };

  step(120);
  assert.ok(bike.telemetryState.wheels.every((wheel) => wheel.contact));

  input.throttle = 1;
  step(360);
  assert.ok(bike.telemetryState.speedKmh > 40, `${bike.telemetryState.speedKmh.toFixed(0)} km/h`);
  assert.ok(bike.telemetryState.gear >= 1);
  // Pinning the throttle in a straight line must not stand the bike up: the
  // front tire is still loaded and carries the nose.
  assert.ok(bike.pitch < 0.05, `straight-line gas wheelied to ${bike.pitch.toFixed(2)}`);

  assert.ok(bike.popWheelie(), 'the clutch-up should be available at speed');
  step(150);
  const raised = bike.pitch;
  // A wheelie is a riding position, not a loop: the pop must settle well
  // under the bavette angle instead of slapping the tail down at once.
  assert.ok(raised > 0.5, `pitch ${raised.toFixed(2)} rad`);
  assert.ok(!bike.telemetryState.wheels[0].contact, 'the front wheel should be in the air');
  assert.equal(bike.telemetryState.wheels.length, 2);
  // It settles instead of running straight over: the rider catches it.
  assert.ok(raised < BAVETTE_ANGLE, `the pop should not scrape the tail (${raised.toFixed(2)})`);

  const settled = raised;
  step(180);
  assert.ok(
    bike.pitch > settled - 0.12 && bike.pitch > 0.5,
    `the throttle should hold the wheelie (${settled.toFixed(2)} -> ${bike.pitch.toFixed(2)})`,
  );
  assert.ok(bike.pitch < BAVETTE_ANGLE - 0.1, `the hold angle must leave room for the bavette (${bike.pitch.toFixed(2)})`);

  input.brake = 1;
  step(90);
  assert.ok(bike.pitch < 0.3, `brake should lower it, ${bike.pitch.toFixed(2)}`);
  input.brake = 0;

  // Steering leans the bike the way the bar points.
  input.throttle = 1;
  step(180);
  input.steer = 0.7;
  step(45);
  assert.ok(bike.lean > 0.3, `lean ${bike.lean.toFixed(2)} rad`);
  assert.ok(bike.lean < spec.maxLean + 1e-6);
  input.steer = 0;
});
