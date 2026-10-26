import RAPIER from '@dimforge/rapier3d-compat';
import { Bike } from '../src/physics/bike.ts';
import { SUPERMOTARD } from '../src/game/bikes.ts';
import { NEUTRAL_INPUT, type VehicleInput } from '../src/physics/vehicle.ts';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 120;
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setTranslation(0, -0.5, 0), groundBody);

const bike = new Bike(
  world,
  { x: 0, y: SUPERMOTARD.spec.cgHeight, z: 0, heading: 0 },
  SUPERMOTARD.spec,
);

const input: VehicleInput = { ...NEUTRAL_INPUT };
const step = (n: number) => {
  for (let i = 0; i < n; i++) {
    bike.step(1 / 120, input, world);
    world.step();
  }
};

const log = (label: string) => {
  const t = bike.telemetryState;
  console.log(
    `${label.padEnd(22)} v=${(t.speedKmh).toFixed(1).padStart(6)} km/h  gear=${t.gear}  rpm=${Math.round(t.rpm)}` +
      `  pitch=${((bike.pitch * 180) / Math.PI).toFixed(1).padStart(5)}°  lean=${((bike.lean * 180) / Math.PI).toFixed(1).padStart(5)}°` +
      `  susp=${t.wheels.map((w) => w.suspensionLength.toFixed(2)).join('/')}  contact=${t.wheels.map((w) => (w.contact ? 'y' : 'n')).join('')}  y=${bike.position.y.toFixed(2)}`,
  );
};

step(180);
log('settled');

// Throttle only: does it launch without a clutch-up?
input.throttle = 1;
step(240);
log('full throttle 2s');

// The pop, then throttle held: a 60 km/h wheelie.
input.throttle = 1;
console.log('pop ->', bike.popWheelie());
for (let i = 0; i < 8; i++) {
  step(15);
  log(`wheelie +${(i + 1) * 0.125}s`);
}

// Roll off: the front should come down.
input.throttle = 0;
for (let i = 0; i < 6; i++) {
  step(20);
  log(`lift off +${(i + 1) * 0.167}s`);
}

// Brake from a raised wheelie.
input.throttle = 1;
bike.pitch = 0.9;
bike.pitchVelocity = 0;
step(10);
log('held at 0.9');
input.brake = 1;
input.throttle = 0;
step(20);
log('brake 0.167s');
step(20);
log('brake 0.333s');
input.brake = 0;

// Lean in a corner at speed.
input.throttle = 1;
step(240);
log('cruise');
input.steer = 0.8;
for (let i = 0; i < 8; i++) {
  step(15);
  log(`turn +${(i + 1) * 0.125}s`);
}
input.steer = 0;

// Loop out.
input.throttle = 1;
bike.pitch = 1.4;
bike.pitchVelocity = 1.5;
step(30);
log('loop');

console.log('sparks?', bike.telemetryState.pitch, bike.telemetryState.looped);
