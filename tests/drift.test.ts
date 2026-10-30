import assert from 'node:assert/strict';
import { test } from 'node:test';
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

function headingOf(car: Vehicle): number {
  const q = car.rotation;
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

/**
 * Courbure de la trajectoire pendant une glisse tenue : variation de cap
 * divisée par la distance parcourue. Diviser par la distance évite qu'un
 * demi-tour sur place (courbure énorme, zéro mètre) passe pour un virage serré.
 */
async function driftCurvature(pedal: { throttle: number; brake: number }): Promise<number> {
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  const run = (seconds: number, input: VehicleInput, onTick?: () => void) => {
    const steps = Math.round(seconds / TICK);
    for (let i = 0; i < steps; i++) {
      car.step(TICK, input, world);
      world.step();
      onTick?.();
    }
  };

  run(1, NEUTRAL_INPUT);
  run(5, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  // Même mise en glisse pour les deux cas : seule la pédale change.
  run(1.2, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });

  let previousHeading = headingOf(car);
  let previousPosition = car.position;
  let turned = 0;
  let travelled = 0;
  run(1.6, { ...pedal, steer: 1, handbrake: false }, () => {
    const heading = headingOf(car);
    let delta = heading - previousHeading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    turned += Math.abs(delta);
    previousHeading = heading;
    const position = car.position;
    travelled += Math.hypot(position.x - previousPosition.x, position.z - previousPosition.z);
    previousPosition = position;
  });
  assert.ok(travelled > 1, 'the car stopped instead of sliding');
  return turned / travelled;
}

test('throttle tightens a drift and the brake widens it', async () => {
  // Depuis une même glisse, accélérer doit ramener la voiture vers l'intérieur
  // du virage et freiner l'élargir. C'est le geste de correction au point de
  // corde : sans ce sens, la voiture est injouable en travers.
  const throttle = await driftCurvature({ throttle: 1, brake: 0 });
  const brake = await driftCurvature({ throttle: 0, brake: 1 });

  assert.ok(
    throttle > brake * 1.04,
    `throttle curvature ${throttle.toFixed(4)} is not tighter than braking ${brake.toFixed(4)}`,
  );
});

test('the rear axle keeps pushing through a slide instead of coasting', async () => {
  // Roues arrière qui roulent au lieu de pousser = pneus qui frottent en
  // travers et vitesse qui part en fumée. En glisse, la cible de glissement de
  // l'essieu arrière doit donc s'ouvrir avec l'angle de la caisse.
  const world = await makeWorld();
  const car = new Vehicle(world, { x: 0, y: 0.9, z: 0, heading: 0 });
  const run = (seconds: number, input: VehicleInput) => {
    const steps = Math.round(seconds / TICK);
    for (let i = 0; i < steps; i++) {
      car.step(TICK, input, world);
      world.step();
    }
  };

  run(1, NEUTRAL_INPUT);
  run(5, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  run(1.2, { throttle: 0.8, brake: 0, steer: 1, handbrake: true });
  run(1.0, { throttle: 1, brake: 0, steer: 0.2, handbrake: false });

  const rear = car.telemetryState.wheels.filter((w) => !w.name.startsWith('F'));
  assert.ok(
    car.telemetryState.driftAngleDeg > 10,
    `no slide to hold (${car.telemetryState.driftAngleDeg.toFixed(1)}°)`,
  );
  for (const wheel of rear) {
    assert.ok(
      wheel.slipRatio > 0.12,
      `${wheel.name} is rolling (${wheel.slipRatio.toFixed(3)}) instead of driving the slide`,
    );
  }
});
