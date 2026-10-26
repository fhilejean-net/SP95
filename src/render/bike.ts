import * as THREE from 'three';

/**
 * A procedural supermotard: tall single-cylinder, 17-inch wheels, wide bars,
 * high front fender and a rider. It is built in bike space, origin on the
 * ground between the wheels and nose toward -Z, so the physics offsets are the
 * only thing that makes it move.
 *
 * The pose is three nested pivots: the ground line under the rear contact, the
 * lean around the contact patch line, and the wheelie around the rear axle.
 * Rotating the body itself would lift the tires off the road, which is exactly
 * what a bike visual must never do.
 */

export interface BikePose {
  /** Bike lean, positive to the right, radians. */
  lean: number;
  /** Wheelie pitch about the rear contact, positive nose-up. */
  pitch: number;
  steer: number;
  /** Current rear and front suspension lengths, metres. */
  rearSuspension: number;
  frontSuspension: number;
  /** Static suspension length, metres. */
  restLength: number;
  wheelRadius: number;
  /** Ground pitch along the bike and roll across it, radians. */
  slopePitch: number;
  slopeRoll: number;
  /** Smoothed longitudinal acceleration, m/s², for the rider's weight shift. */
  accel: number;
  brake: number;
  time: number;
}

export interface BikeVisual {
  group: THREE.Group;
  /** Front then rear. */
  wheels: THREE.Group[];
  setPose(pose: BikePose): void;
  setSpin(front: number, rear: number): void;
  setBrake(braking: boolean): void;
  /** World position of the number plate: the bavette scrapes there. */
  plateWorldPosition(target: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

const PAINT = 0xf1f2f0;
const ORANGE = 0xe2601a;
const DARK = 0x16181b;

function tube(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments = 10,
): THREE.Mesh {
  const delta = new THREE.Vector3().subVectors(b, a);
  const length = delta.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(a).addScaledVector(delta, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  return mesh;
}

function box(
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function wheel(radius: number, width: number, front: boolean): THREE.Group {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';

  const tireMat = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: front ? 0x202226 : 0x24262a,
    metalness: 0.75,
    roughness: 0.34,
  });
  const hubMat = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.5, roughness: 0.4 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x8e949b, metalness: 0.95, roughness: 0.3 });

  const tire = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.85, radius * 0.155, 10, 30),
    tireMat,
  );
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  tire.receiveShadow = true;
  group.add(tire);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width * 0.62, 24, 1, true),
    rimMat,
  );
  rim.geometry.rotateZ(Math.PI / 2);
  rim.castShadow = true;
  group.add(rim);

  for (let i = 0; i < 10; i++) {
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.018, radius * 1.22, 0.028),
      rimMat,
    );
    spoke.rotation.x = (i / 10) * Math.PI * 2;
    group.add(spoke);
  }

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.075, width * 0.8, 14),
    hubMat,
  );
  hub.geometry.rotateZ(Math.PI / 2);
  group.add(hub);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, 0.012, 22),
    discMat,
  );
  disc.geometry.rotateZ(Math.PI / 2);
  disc.position.x = -width * 0.55;
  group.add(disc);

  const sprocket = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, 0.014, 18),
    discMat,
  );
  if (!front) {
    sprocket.geometry.rotateZ(Math.PI / 2);
    sprocket.position.x = width * 0.55;
    group.add(sprocket);
  }

  return group;
}

/**
 * The rider, in bike space: seat height and bar height are the ones the
 * modelled CRF has, so he sits on the machine instead of floating above it.
 * Kept out of `createBike` because the modelled bike needs exactly this
 * figure on top of a completely different chassis.
 */
export function createRider(): THREE.Group {
  const orange = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.3, roughness: 0.4 });
  const jacket = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.75 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2c3547, roughness: 0.9 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.7 });
  const helmetPaint = new THREE.MeshPhysicalMaterial({
    color: 0xf4f4f2,
    roughness: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const visor = new THREE.MeshStandardMaterial({
    color: 0x0b141c,
    metalness: 0.6,
    roughness: 0.08,
  });

  const rider = new THREE.Group();
  rider.position.set(0, 0, 0.12);

  // Legs: hip -> knee -> boot.
  for (const side of [-1, 1]) {
    rider.add(tube(
      new THREE.Vector3(side * 0.12, 1.02, 0.12),
      new THREE.Vector3(side * 0.21, 0.8, -0.02),
      0.075,
      jeans,
    ));
    rider.add(tube(
      new THREE.Vector3(side * 0.21, 0.8, -0.02),
      new THREE.Vector3(side * 0.24, 0.52, 0.14),
      0.062,
      jeans,
    ));
    rider.add(box([0.1, 0.09, 0.24], [side * 0.24, 0.5, 0.19], boot, [0.1, 0, 0]));
    rider.add(tube(
      new THREE.Vector3(side * 0.17, 1.28, 0.04),
      new THREE.Vector3(side * 0.3, 1.11, -0.32),
      0.058,
      jacket,
    ));
    rider.add(box([0.08, 0.07, 0.1], [side * 0.31, 1.1, -0.35], boot));
  }

  // Torso, leaning forward toward the bars.
  rider.add(box([0.34, 0.46, 0.26], [0, 1.18, 0.06], jacket, [0.22, 0, 0]));
  rider.add(box([0.28, 0.06, 0.02], [0, 1.2, -0.08], orange, [0.22, 0, 0]));
  rider.add(box([0.12, 0.34, 0.28], [0, 1.14, 0.24], boot, [0.18, 0, 0]));

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 14), helmetPaint);
  head.position.set(0, 1.52, -0.02);
  head.scale.set(0.95, 1.02, 1.05);
  head.castShadow = true;
  rider.add(head);
  rider.add(box([0.2, 0.09, 0.14], [0, 1.53, -0.13], visor, [0.12, 0, 0]));
  rider.add(box([0.04, 0.06, 0.26], [0, 1.61, 0.0], orange, [0.1, 0, 0]));
  rider.add(tube(new THREE.Vector3(0, 1.4, 0.02), new THREE.Vector3(0, 1.46, 0.0), 0.06, jacket));

  return rider;
}

export function createBike(): BikeVisual {
  const group = new THREE.Group();
  group.name = 'bike';

  const paint = new THREE.MeshPhysicalMaterial({
    color: PAINT,
    metalness: 0.1,
    roughness: 0.32,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.2,
  });
  const orange = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.3, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.55, metalness: 0.4 });
  const engineMat = new THREE.MeshStandardMaterial({ color: 0x35383c, metalness: 0.8, roughness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.9, roughness: 0.28 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.95 });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x520508,
    emissive: 0xd3121b,
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });

  const radius = 0.31;
  const halfBase = 0.74;

  // Ground line under the rear contact; the body origin sits above it.
  const pose = new THREE.Group();
  const leanPivot = new THREE.Group();
  const pitchPivot = new THREE.Group();
  pitchPivot.position.z = halfBase;
  const bike = new THREE.Group();
  bike.position.z = -halfBase;
  group.add(pose);
  pose.add(leanPivot);
  leanPivot.add(pitchPivot);
  pitchPivot.add(bike);

  // --- Frame and engine ---------------------------------------------------
  const engine = box([0.36, 0.42, 0.52], [0, 0.5, 0.02], engineMat, [0.06, 0, 0]);
  bike.add(engine);
  for (let i = 0; i < 3; i++) {
    bike.add(box([0.4, 0.025, 0.3], [0, 0.63 + i * 0.045, -0.02], engineMat));
  }
  bike.add(box([0.2, 0.16, 0.2], [0, 0.7, -0.22], dark, [0.2, 0, 0]));

  // Trellis frame: two tubes from the steering head down to the swingarm pivot.
  for (const side of [-1, 1]) {
    bike.add(
      tube(
        new THREE.Vector3(side * 0.14, 0.95, -0.48),
        new THREE.Vector3(side * 0.17, 0.58, 0.16),
        0.022,
        orange,
      ),
    );
    bike.add(
      tube(
        new THREE.Vector3(side * 0.1, 0.9, -0.44),
        new THREE.Vector3(side * 0.1, 0.42, 0.18),
        0.016,
        dark,
      ),
    );
    bike.add(
      tube(
        new THREE.Vector3(side * 0.1, 0.42, 0.18),
        new THREE.Vector3(side * 0.1, 0.33, 0.72),
        0.032,
        engineMat,
      ),
    );
  }
  bike.add(tube(new THREE.Vector3(-0.1, 0.42, 0.18), new THREE.Vector3(0.1, 0.42, 0.18), 0.03, engineMat));

  // --- Tank, seat and tail ------------------------------------------------
  const tank = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), paint);
  tank.scale.set(0.23, 0.17, 0.4);
  tank.position.set(0, 0.86, -0.12);
  tank.castShadow = true;
  bike.add(tank);

  for (const side of [-1, 1]) {
    const shroud = box([0.055, 0.3, 0.4], [side * 0.2, 0.78, -0.24], orange, [0, 0, side * 0.18]);
    bike.add(shroud);
    const stripe = box([0.06, 0.06, 0.36], [side * 0.205, 0.86, -0.24], paint, [0, 0, side * 0.18]);
    bike.add(stripe);
  }

  bike.add(box([0.26, 0.09, 0.66], [0, 0.955, 0.32], dark));
  const tail = box([0.22, 0.12, 0.36], [0, 0.965, 0.65], paint, [-0.08, 0, 0]);
  bike.add(tail);
  bike.add(box([0.2, 0.05, 0.28], [0, 1.02, 0.62], orange, [-0.08, 0, 0]));

  // Number plate and tail light: the plate is what grounds out on a bavette.
  const plateNode = new THREE.Object3D();
  plateNode.position.set(0, 0.64, 1.08);
  bike.add(plateNode);
  const plate = box([0.17, 0.2, 0.025], [0, 0, 0], paint);
  plateNode.add(plate);
  plateNode.add(box([0.07, 0.045, 0.02], [0, 0.13, 0.005], tailMat));
  // The tail tidy that carries the plate: it is what scrapes on a bavette.
  bike.add(
    tube(
      new THREE.Vector3(0, 0.96, 0.76),
      new THREE.Vector3(0, 0.7, 1.02),
      0.018,
      dark,
    ),
  );

  // Rear fender and shock.
  bike.add(box([0.2, 0.06, 0.34], [0, 0.78, 0.7], dark, [0.08, 0, 0]));
  bike.add(
    tube(
      new THREE.Vector3(0.02, 0.86, 0.42),
      new THREE.Vector3(0.02, 0.45, 0.22),
      0.035,
      gold,
    ),
  );

  // --- Exhaust ------------------------------------------------------------
  const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 0.52, 14), engineMat);
  canister.rotation.x = Math.PI / 2;
  canister.position.set(0.18, 0.62, 0.45);
  canister.castShadow = true;
  bike.add(canister);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.06, 14), gold);
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0.18, 0.62, 0.72);
  bike.add(tip);
  bike.add(
    tube(
      new THREE.Vector3(0.06, 0.42, -0.16),
      new THREE.Vector3(0.16, 0.6, 0.24),
      0.035,
      engineMat,
    ),
  );

  // --- Front end ----------------------------------------------------------
  for (const side of [-1, 1]) {
    bike.add(
      tube(
        new THREE.Vector3(side * 0.085, 1.0, -0.46),
        new THREE.Vector3(side * 0.085, 0.62, -0.63),
        0.032,
        gold,
      ),
    );
    bike.add(
      tube(
        new THREE.Vector3(side * 0.085, 0.64, -0.62),
        new THREE.Vector3(side * 0.085, 0.34, -0.73),
        0.045,
        dark,
      ),
    );
  }
  bike.add(box([0.28, 0.035, 0.1], [0, 0.98, -0.47], engineMat));
  bike.add(box([0.26, 0.035, 0.09], [0, 0.87, -0.5], engineMat));

  // High front fender: a supermotard signature.
  bike.add(box([0.2, 0.035, 0.46], [0, 0.71, -0.71], paint, [-0.16, 0, 0]));
  bike.add(box([0.17, 0.03, 0.16], [0, 0.665, -0.93], paint, [-0.55, 0, 0]));

  // Headlight mask and lamp.
  bike.add(box([0.23, 0.29, 0.16], [0, 0.93, -0.55], paint, [0.16, 0, 0]));
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xf7f3e6,
    emissive: 0xfff0c4,
    emissiveIntensity: 1.2,
    roughness: 0.15,
  });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), lampMat);
  lamp.scale.z = 0.45;
  lamp.position.set(0, 0.95, -0.64);
  bike.add(lamp);

  // Handlebar turns with the steering.
  const barGroup = new THREE.Group();
  barGroup.position.set(0, 1.08, -0.4);
  bike.add(barGroup);
  barGroup.add(tube(new THREE.Vector3(-0.36, 0, 0), new THREE.Vector3(0.36, 0, 0), 0.016, dark));
  for (const side of [-1, 1]) {
    barGroup.add(tube(
      new THREE.Vector3(side * 0.24, 0, 0),
      new THREE.Vector3(side * 0.36, 0, 0.01),
      0.028,
      dark,
    ));
    barGroup.add(tube(
      new THREE.Vector3(side * 0.36, 0, 0),
      new THREE.Vector3(side * 0.47, 0.01, 0.02),
      0.032,
      tyreMat,
    ));
  }

  // --- Footpegs -----------------------------------------------------------
  for (const side of [-1, 1]) {
    bike.add(box([0.18, 0.03, 0.06], [side * 0.24, 0.48, 0.16], engineMat));
  }

  // --- Wheels -------------------------------------------------------------
  const front = wheel(radius, 0.12, true);
  front.position.set(0, 0, -halfBase);
  front.position.y = radius;
  bike.add(front);
  const rear = wheel(radius, 0.16, false);
  rear.position.set(0, radius, halfBase);
  bike.add(rear);

  // Calipers do not rotate with the wheel.
  const caliper = new THREE.MeshStandardMaterial({ color: ORANGE, metalness: 0.35, roughness: 0.5 });
  bike.add(box([0.05, 0.16, 0.11], [-0.12, radius + 0.12, -halfBase], caliper, [0, 0, 0.2]));
  bike.add(box([0.05, 0.12, 0.1], [0.12, radius + 0.05, halfBase], engineMat));

  // --- Rider --------------------------------------------------------------
  bike.add(createRider());

  // --- Pose ---------------------------------------------------------------
  let currentRadius = radius;

  return {
    group,
    wheels: [front, rear],
    setPose(state: BikePose) {
      if (state.wheelRadius !== currentRadius) {
        currentRadius = state.wheelRadius;
      }
      // The rear contact is the anchor: place the local ground where the ray
      // found it, so neither the lean nor the wheelie can lift the rear tire.
      pose.position.y = -(state.rearSuspension + currentRadius);
      leanPivot.rotation.z = -(state.lean + state.slopeRoll);
      pitchPivot.rotation.x = state.pitch + state.slopePitch;
      barGroup.rotation.y = -state.steer;
      front.rotation.y = -state.steer;
    },
    setSpin(frontSpin, rearSpin) {
      front.rotation.x = -frontSpin;
      rear.rotation.x = -rearSpin;
    },
    setBrake(braking) {
      tailMat.emissiveIntensity = braking ? 2.4 : 0.55;
    },
    plateWorldPosition(target) {
      plateNode.getWorldPosition(target);
      return target;
    },
    dispose() {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) material?.dispose();
      });
    },
  };
}
