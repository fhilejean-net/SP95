/**
 * Le rendu de l'aire de gymkhana : la dalle, son raccordement, le marquage de
 * drift (deux cercles et un huit) et les plots. Trois maillages seulement, et
 * aucune collision : le sol physique est déjà plat sous la dalle.
 */
import * as THREE from 'three';
import { createAsphaltTexture } from './materials.ts';
import { DRIFT_ACCESS, DRIFT_PAD } from '../world/driftPad.ts';

/** Cote du revêtement, identique à la piste. */
const PAD_Y = 0.026;

export interface DriftPadBuild {
  triangles: number;
  meshes: number;
}

/** Peinture blanche à plat, décalée pour ne pas clignoter avec l'asphalte. */
function paintMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xe9e5d8,
    roughness: 0.72,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

export function buildDriftPad(scene: THREE.Scene, anisotropy: number): DriftPadBuild {
  const asphalt = createAsphaltTexture();
  asphalt.repeat.set(26, 20);
  asphalt.anisotropy = anisotropy;
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphalt,
    color: 0x8f8f8c,
    roughness: 0.95,
    metalness: 0.02,
  });

  let triangles = 0;
  let meshes = 0;

  // --- La dalle et son raccordement --------------------------------------
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(DRIFT_PAD.halfX * 2, DRIFT_PAD.halfZ * 2, 1, 1),
    asphaltMat,
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(DRIFT_PAD.cx, PAD_Y, DRIFT_PAD.cz);
  pad.receiveShadow = true;
  pad.name = 'drift-pad';
  scene.add(pad);
  meshes += 1;
  triangles += 2;

  const access = new THREE.Mesh(
    new THREE.PlaneGeometry(DRIFT_ACCESS.toX - DRIFT_ACCESS.fromX + 1, DRIFT_ACCESS.z1 - DRIFT_ACCESS.z0),
    asphaltMat,
  );
  access.rotation.x = -Math.PI / 2;
  access.position.set(
    (DRIFT_ACCESS.fromX + DRIFT_ACCESS.toX) / 2,
    PAD_Y,
    (DRIFT_ACCESS.z0 + DRIFT_ACCESS.z1) / 2,
  );
  access.receiveShadow = true;
  access.name = 'drift-access';
  scene.add(access);
  meshes += 1;
  triangles += 2;

  // --- Marquage : deux cercles, un huit et une ligne de départ -----------
  const paint = paintMaterial();
  const rings: THREE.BufferGeometry[] = [];
  const ring = (radius: number, inner: number, x: number, z: number): void => {
    const geometry = new THREE.RingGeometry(radius, inner, 96, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, PAD_Y + 0.004, z);
    rings.push(geometry);
  };
  // Le grand cercle des donuts, et les deux lobes du huit.
  ring(26, 25.4, DRIFT_PAD.cx, DRIFT_PAD.cz);
  ring(15, 14.4, DRIFT_PAD.cx - 24, DRIFT_PAD.cz + 6);
  ring(15, 14.4, DRIFT_PAD.cx + 24, DRIFT_PAD.cz + 6);
  // Les deux axes du huit, en pointillés.
  for (let i = -6; i <= 6; i++) {
    const band = new THREE.PlaneGeometry(2.4, 0.5);
    band.rotateX(-Math.PI / 2);
    band.translate(DRIFT_PAD.cx + i * 4.4, PAD_Y + 0.004, DRIFT_PAD.cz - 20);
    rings.push(band);
  }
  const padPaint = new THREE.Mesh(mergeAll(rings), paint);
  padPaint.name = 'drift-paint';
  scene.add(padPaint);
  rings.forEach((geometry) => geometry.dispose());
  meshes += 1;
  triangles += 96 * 6 + 3 * 2;

  return { triangles, meshes };
}

/** Fusionne des géométries sans dépendre de BufferGeometryUtils côté monde. */
function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  let positionCount = 0;
  let indexCount = 0;
  for (const geometry of geometries) {
    positionCount += geometry.attributes.position.count;
    indexCount += geometry.index ? geometry.index.count : geometry.attributes.position.count;
  }
  const positions = new Float32Array(positionCount * 3);
  const normals = new Float32Array(positionCount * 3);
  const indices = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const geometry of geometries) {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute;
    positions.set(position.array as Float32Array, vertexOffset * 3);
    normals.set(normal.array as Float32Array, vertexOffset * 3);
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) {
        indices[indexOffset + i] = geometry.index.getX(i) + vertexOffset;
      }
      indexOffset += geometry.index.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += position.count;
    }
    vertexOffset += position.count;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
