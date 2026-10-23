import * as THREE from 'three';

interface Section {
  z: number;
  w: number;
  yBottom: number;
  yTop: number;
  /** Superellipse exponent: 2 is a soft ellipse, 6 is a rounded box. */
  p?: number;
}

function loft(sections: Section[], radial = 18): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];
  for (const s of sections) {
    const p = s.p ?? 3.4;
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const cx = Math.sign(c) * Math.pow(Math.abs(c), 2 / p);
      const sy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p);
      const yMid = (s.yTop + s.yBottom) * 0.5;
      const yHalf = (s.yTop - s.yBottom) * 0.5;
      ring.push(new THREE.Vector3(s.w * cx, yMid + yHalf * sy, s.z));
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (const v of ring) positions.push(v.x, v.y, v.z);
  }

  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + jn;
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + jn;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Caps.
  const frontCenter = positions.length / 3;
  const first = rings[0];
  const fc = first.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / radial);
  positions.push(fc.x, fc.y, fc.z);
  for (let j = 0; j < radial; j++) {
    const jn = (j + 1) % radial;
    indices.push(frontCenter, jn, j);
  }

  const rearCenter = positions.length / 3;
  const last = rings[rings.length - 1];
  const rc = last.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / radial);
  positions.push(rc.x, rc.y, rc.z);
  const offset = (rings.length - 1) * radial;
  for (let j = 0; j < radial; j++) {
    const jn = (j + 1) % radial;
    indices.push(rearCenter, offset + j, offset + jn);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface CarVisual {
  group: THREE.Group;
  wheels: THREE.Group[];
  brakeLights: THREE.Mesh[];
  reverseLight: THREE.Mesh;
  setPaint: (color: number) => void;
  /** Fits the wheels to the tire fitted in the garage. */
  setWheelRadius: (radius: number) => void;
}

const PAINT_COLOR = 0xa51d2d;

export function createCar(paint = PAINT_COLOR): CarVisual {
  const group = new THREE.Group();
  group.name = 'car';

  const paintMaterial = new THREE.MeshPhysicalMaterial({
    color: paint,
    metalness: 0.62,
    roughness: 0.24,
    clearcoat: 1,
    clearcoatRoughness: 0.045,
    envMapIntensity: 1.5,
  });

  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.45, metalness: 0.35 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x101820,
    metalness: 0.2,
    roughness: 0.06,
    transparent: true,
    opacity: 0.82,
    envMapIntensity: 2,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc3c6c9, metalness: 1, roughness: 0.24 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x121213, roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xa9adb2, metalness: 0.95, roughness: 0.28 });

  // --- Main body -----------------------------------------------------------
  const bodySections: Section[] = [
    { z: -2.28, w: 0.6, yBottom: -0.24, yTop: -0.02, p: 3 },
    { z: -2.12, w: 0.83, yBottom: -0.31, yTop: 0.06, p: 4 },
    { z: -1.78, w: 0.9, yBottom: -0.33, yTop: 0.16, p: 4.2 },
    { z: -1.2, w: 0.93, yBottom: -0.34, yTop: 0.24, p: 4.5 },
    { z: -0.5, w: 0.94, yBottom: -0.34, yTop: 0.3, p: 4.5 },
    { z: 0.15, w: 0.94, yBottom: -0.34, yTop: 0.32, p: 4.5 },
    { z: 0.9, w: 0.93, yBottom: -0.34, yTop: 0.3, p: 4.5 },
    { z: 1.65, w: 0.9, yBottom: -0.33, yTop: 0.22, p: 4.2 },
    { z: 2.12, w: 0.82, yBottom: -0.3, yTop: 0.08, p: 3.6 },
    { z: 2.26, w: 0.62, yBottom: -0.26, yTop: 0.0, p: 3 },
  ];

  const body = new THREE.Mesh(loft(bodySections, 20), paintMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // --- Greenhouse ----------------------------------------------------------
  const cabinSections: Section[] = [
    { z: -0.72, w: 0.62, yBottom: 0.26, yTop: 0.3, p: 6 },
    { z: -0.35, w: 0.74, yBottom: 0.26, yTop: 0.46, p: 3.6 },
    { z: 0.05, w: 0.76, yBottom: 0.26, yTop: 0.62, p: 3.4 },
    { z: 0.55, w: 0.74, yBottom: 0.26, yTop: 0.66, p: 3.4 },
    { z: 1.05, w: 0.7, yBottom: 0.26, yTop: 0.5, p: 3.6 },
    { z: 1.42, w: 0.58, yBottom: 0.25, yTop: 0.3, p: 5 },
  ];
  const cabin = new THREE.Mesh(loft(cabinSections, 16), glass);
  cabin.castShadow = true;
  group.add(cabin);

  // Roof panel in body colour.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.85), paintMaterial);
  roof.position.set(0, 0.665, 0.34);
  roof.castShadow = true;
  group.add(roof);

  // Window trim.
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.04, 2.0), carbon);
  trim.position.set(0, 0.27, 0.3);
  group.add(trim);

  // --- Aero and trim -------------------------------------------------------
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.06, 0.55), carbon);
  splitter.position.set(0, -0.35, -2.05);
  splitter.castShadow = true;
  group.add(splitter);

  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.16, 0.55), carbon);
  diffuser.position.set(0, -0.31, 2.06);
  group.add(diffuser);

  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 2.5), carbon);
    skirt.position.set(side * 0.93, -0.34, 0.1);
    group.add(skirt);

    const mirrorArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.06), carbon);
    mirrorArm.position.set(side * 0.96, 0.36, -0.5);
    group.add(mirrorArm);

    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.11, 0.13), paintMaterial);
    mirror.position.set(side * 1.04, 0.38, -0.5);
    mirror.castShadow = true;
    group.add(mirror);
  }

  // Rear wing.
  const wingSupports = new THREE.BoxGeometry(0.07, 0.28, 0.16);
  for (const side of [-1, 1]) {
    const support = new THREE.Mesh(wingSupports, carbon);
    support.position.set(side * 0.55, 0.34, 1.92);
    group.add(support);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.34), carbon);
  wing.position.set(0, 0.49, 1.96);
  wing.rotation.x = -0.08;
  wing.castShadow = true;
  group.add(wing);

  // Exhaust tips.
  for (const side of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.22, 12), chrome);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(side * 0.34, -0.26, 2.22);
    group.add(pipe);
  }

  // Headlights.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xdfe9ff,
    emissive: 0x9fbaff,
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.2,
  });
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.14), headMat);
    head.position.set(side * 0.52, 0.02, -2.15);
    head.rotation.y = side * 0.08;
    group.add(head);
  }

  // Tail lights and reverse light.
  const brakeLights: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x4a0308,
      emissive: 0xd81020,
      emissiveIntensity: 0.6,
      roughness: 0.32,
    });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.06), brakeMat);
    lamp.position.set(side * 0.46, 0.06, 2.27);
    lamp.rotation.y = side * 0.06;
    group.add(lamp);
    brakeLights.push(lamp);
  }
  const reverseMat = new THREE.MeshStandardMaterial({
    color: 0x777777,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.4,
  });
  const reverseLight = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.05), reverseMat);
  reverseLight.position.set(0, -0.04, 2.27);
  group.add(reverseLight);

  // --- Wheels --------------------------------------------------------------
  const wheels: THREE.Group[] = [];
  const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.27, 26);
  tireGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.235, 0.235, 0.29, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.05, 18);
  discGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.035, 0.4, 0.07);
  const discMat = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.7, roughness: 0.5 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xd8841c, metalness: 0.4, roughness: 0.5 });

  const mounts: { x: number; z: number }[] = [
    { x: -0.85, z: -1.32 },
    { x: 0.85, z: -1.32 },
    { x: -0.86, z: 1.3 },
    { x: 0.86, z: 1.3 },
  ];

  for (const mount of mounts) {
    const wheel = new THREE.Group();
    // Spin around the wheel axle first, then apply the steering angle.
    wheel.rotation.order = 'YXZ';
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    tire.receiveShadow = true;
    wheel.add(tire);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.castShadow = true;
    wheel.add(rim);

    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.rotation.x = (i / 5) * Math.PI * 2;
      wheel.add(spoke);
    }

    const disc = new THREE.Mesh(discGeo, discMat);
    wheel.add(disc);

    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.12), caliperMat);
    caliper.position.set(mount.x > 0 ? 0.12 : -0.12, 0.14, 0);
    wheel.add(caliper);

    wheel.position.set(mount.x, -0.18, mount.z);
    group.add(wheel);
    wheels.push(wheel);
  }

  return {
    group,
    wheels,
    brakeLights,
    reverseLight,
    setPaint: (color: number) => {
      paintMaterial.color.setHex(color);
    },
    setWheelRadius: (radius: number) => {
      const scale = radius / 0.34;
      for (const w of wheels) w.scale.setScalar(scale);
    },
  };
}

/** Applies the physics state to the visual car. */
export function updateCarVisual(
  visual: CarVisual,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
  wheelStates: { suspensionLength: number; steer: number; spinAngle: number; contact: boolean }[],
  braking: boolean,
  reversing: boolean,
): void {
  visual.group.position.set(position.x, position.y, position.z);
  visual.group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

  for (let i = 0; i < visual.wheels.length; i++) {
    const wheel = visual.wheels[i];
    const state = wheelStates[i];
    if (!state) continue;
    const mountZ = i < 2 ? -1.32 : 1.3;
    const mountX = i < 2 ? (i === 0 ? -0.85 : 0.85) : i === 2 ? -0.86 : 0.86;
    wheel.position.set(mountX, 0.12 - state.suspensionLength, mountZ);
    wheel.rotation.set(state.spinAngle, state.steer, 0);
  }

  for (const lamp of visual.brakeLights) {
    const mat = lamp.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = braking ? 2.4 : 0.55;
  }
  const reverseMat = visual.reverseLight.material as THREE.MeshStandardMaterial;
  reverseMat.emissiveIntensity = reversing ? 1.6 : 0;
}
