import * as THREE from 'three';
import { ROADS, heightAt, surfaceAt } from './layout.ts';

/**
 * Standing water on the tarmac. The puddles are placed once, along the roads
 * that actually carry asphalt, and are only shown while the road is wet: a dry
 * day has no reason to display them and the draw call is a single instanced
 * mesh either way.
 *
 * No external asset: a flat disc with a very low roughness picks up the sun and
 * reads as water from inside the car.
 */

export interface PuddleSpot {
  x: number;
  y: number;
  z: number;
  sx: number;
  sz: number;
  rot: number;
}

export interface PuddleField {
  setVisible(wet: boolean): void;
  readonly count: number;
}

/** Enough to read as rain everywhere without filling the GPU with discs. */
export const PUDDLE_LIMIT = 380;
/** Distance between two candidate spots along a road, in metres. */
const SPACING = 15;

/**
 * Where the puddles go, independent of Three so a test can walk the result.
 * The layout is deterministic: the same puddle sits on the same corner every
 * run, which keeps screenshots comparable.
 */
export function planPuddles(limit = PUDDLE_LIMIT): PuddleSpot[] {
  let seed = 0x5f95;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const spots: PuddleSpot[] = [];

  for (const road of ROADS) {
    if (spots.length >= limit) break;
    if (road.surface === 'dirt') continue;
    const points = road.points;
    const legs = road.closed ? points.length : points.length - 1;
    for (let i = 0; i < legs && spots.length < limit; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[(i + 1) % points.length];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 4) continue;
      // Offset by less than a full step so consecutive puddles never line up.
      for (let d = random() * SPACING; d < length && spots.length < limit; d += SPACING) {
        if (random() > 0.62) continue;
        const t = d / length;
        const lateral = (random() - 0.5) * road.width * 0.56;
        const nx = -(bz - az) / length;
        const nz = (bx - ax) / length;
        const x = ax + (bx - ax) * t + nx * lateral;
        const z = az + (bz - az) * t + nz * lateral;
        // Only on tarmac: a puddle in the grass would read as a hole.
        if (surfaceAt(x, z).kind !== 'asphalte') continue;
        spots.push({
          x,
          y: heightAt(x, z) + 0.018,
          z,
          sx: 0.5 + random() * 1.25,
          sz: 0.4 + random() * 0.85,
          rot: random() * Math.PI,
        });
      }
    }
  }

  return spots;
}

export function buildPuddles(scene: THREE.Scene): PuddleField {
  const spots = planPuddles();

  const geometry = new THREE.CircleGeometry(1, 16);
  geometry.rotateX(-Math.PI / 2);
  // No environment map in this scene: a metallic puddle would render black.
  // A pale, glossy dielectric instead catches the sun and reads as water.
  const material = new THREE.MeshStandardMaterial({
    color: 0xa9bdcf,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, spots.length));
  mesh.name = 'puddles';
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, spot.rot);
    position.set(spot.x, spot.y, spot.z);
    scale.set(spot.sx, 1, spot.sz);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  // The discs are spread over the whole map: a culling sphere is pointless.
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  return {
    setVisible(wet: boolean): void {
      mesh.visible = wet;
    },
    count: spots.length,
  };
}
