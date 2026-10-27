/**
 * Street furniture from Kenney's City Kit Roads (CC0, see
 * public/models/kenney-city-roads/License.txt). The city layout stays
 * procedural, but the lamps, signals, signs, crossings and roadworks are real
 * kit models instead of coloured boxes.
 *
 * Everything is drawn with one InstancedMesh per model, so a few hundred pieces
 * of furniture cost about a dozen draw calls, and the pieces the car can hit
 * get a static collider.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { ROADS, SAMPLED_ROADS, heightAt, type RoadDef, type SampledRoad } from './layout.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';

// BASE_URL keeps the kit resolvable both at the dev root and under /SP95/ on
// GitHub Pages.
const KIT = `${import.meta.env.BASE_URL}models/kenney-city-roads`;

const KIT_MODELS = [
  'light-square',
  'light-curved',
  'traffic-light',
  'road-crossing',
  'road-sign-stop',
  'road-sign-warning',
  'road-sign-street',
  'sign-highway-wide',
  'construction-cone',
  'construction-barrier',
  'construction-fence',
  'construction-light',
  'dumpster',
  'electricity-pole',
  'electricity-wires',
] as const;

type KitModel = (typeof KIT_MODELS)[number];

/** Half extents in model units, centered on the model's own height. */
const COLLIDERS: Partial<Record<KitModel, [number, number, number]>> = {
  'light-square': [0.035, 0.3, 0.035],
  'light-curved': [0.035, 0.3, 0.035],
  'traffic-light': [0.05, 0.26, 0.05],
  'road-sign-stop': [0.055, 0.25, 0.07],
  'road-sign-warning': [0.055, 0.25, 0.07],
  'road-sign-street': [0.05, 0.25, 0.07],
  'sign-highway-wide': [0.07, 0.35, 0.3],
  'construction-barrier': [0.07, 0.065, 0.11],
  'construction-fence': [0.04, 0.09, 0.19],
  'construction-light': [0.04, 0.12, 0.04],
  dumpster: [0.14, 0.1, 0.19],
  // The pole's own arm is far wider than the post: a thin box is what the car
  // actually hits.
  'electricity-pole': [0.03, 0.26, 0.03],
};

interface Item {
  model: KitModel;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
}

interface Junction {
  x: number;
  z: number;
  nsWidth: number;
  ewWidth: number;
}

export interface StreetKitSummary {
  models: number;
  instances: number;
  colliders: number;
  /** Tile materials that carry road surface (crossings), for the wet tint. */
  roadMaterials: THREE.MeshStandardMaterial[];
}

interface Template {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walks a sampled road and reports a pose every `spacing` metres. */
function walkRoad(
  road: SampledRoad,
  spacing: number,
  start: number,
  report: (pose: { x: number; z: number; y: number; tx: number; tz: number }) => void,
): void {
  const points = road.points;
  const count = points.length;
  const segments = road.def.closed ? count : count - 1;
  let travelled = 0;
  let next = start;
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[(i + 1) % count];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) continue;
    const tx = dx / length;
    const tz = dz / length;
    while (next <= travelled + length) {
      const t = (next - travelled) / length;
      report({
        x: a.x + dx * t,
        z: a.z + dz * t,
        y: a.y + (b.y - a.y) * t,
        tx,
        tz,
      });
      next += spacing;
    }
    travelled += length;
  }
}

/** Straight city streets cross on a grid: collect the crossings. */
function cityJunctions(): Junction[] {
  const straight = ROADS.filter(
    (road) => road.kind === 'city' && road.points.length === 2 && !road.surface,
  );
  const vertical = straight.filter((road) => Math.abs(road.points[0][0] - road.points[1][0]) < 0.01);
  const horizontal = straight.filter((road) => Math.abs(road.points[0][1] - road.points[1][1]) < 0.01);
  const junctions: Junction[] = [];
  for (const ns of vertical) {
    const x = ns.points[0][0];
    const zMin = Math.min(ns.points[0][1], ns.points[1][1]);
    const zMax = Math.max(ns.points[0][1], ns.points[1][1]);
    for (const ew of horizontal) {
      const z = ew.points[0][1];
      const xMin = Math.min(ew.points[0][0], ew.points[1][0]);
      const xMax = Math.max(ew.points[0][0], ew.points[1][0]);
      if (x < xMin || x > xMax || z < zMin || z > zMax) continue;
      junctions.push({ x, z, nsWidth: ns.width, ewWidth: ew.width });
    }
  }
  return junctions;
}

function roadWidth(road: RoadDef): number {
  return road.width;
}

function buildItems(): Item[] {
  const rand = mulberry32(2202);
  const items: Item[] = [];
  const junctions = cityJunctions();
  const nearJunction = (x: number, z: number, radius: number): boolean =>
    junctions.some((j) => Math.hypot(x - j.x, z - j.z) < radius);

  // --- Street lamps --------------------------------------------------------
  for (const road of SAMPLED_ROADS) {
    const width = roadWidth(road.def);
    let side = 1;
    let index = 0;
    walkRoad(road, 33, 16, (pose) => {
      const nx = -pose.tz;
      const nz = pose.tx;
      const px = pose.x + nx * side * (width / 2 + 2.3);
      const pz = pose.z + nz * side * (width / 2 + 2.3);
      const yaw = Math.atan2(-(pose.x - px), -(pose.z - pz));
      if (!nearJunction(px, pz, 16)) {
        items.push({
          model: index % 2 === 0 ? 'light-square' : 'light-curved',
          x: px,
          y: heightAt(px, pz) + 0.02,
          z: pz,
          yaw,
          sx: 11,
          sy: 11,
          sz: 11,
        });
        index++;
      }
      side *= -1;
    });
  }

  // --- Junctions: crossings, signals, stop signs ---------------------------
  for (const j of junctions) {
    const nsCrossZ = j.ewWidth / 2 + 4.4;
    const ewCrossX = j.nsWidth / 2 + 4.4;
    for (const direction of [-1, 1]) {
      // Zebra across the north-south street: tile road axis (local X) along Z.
      const crossZ = j.z + direction * nsCrossZ;
      items.push({
        model: 'road-crossing',
        x: j.x,
        y: heightAt(j.x, crossZ) + 0.04,
        z: crossZ,
        yaw: Math.PI / 2,
        sx: 3.6,
        sy: 0.15,
        sz: j.nsWidth,
      });
      // Zebra across the east-west street: tile road axis along X.
      const crossX = j.x + direction * ewCrossX;
      items.push({
        model: 'road-crossing',
        x: crossX,
        y: heightAt(crossX, j.z) + 0.04,
        z: j.z,
        yaw: 0,
        sx: 3.6,
        sy: 0.15,
        sz: j.ewWidth,
      });
    }

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = j.x + sx * (j.nsWidth / 2 + 2.3);
        const pz = j.z + sz * (j.ewWidth / 2 + 2.3);
        // The signal head looks along local -X: aim it back at the junction.
        const yaw = Math.atan2(-sz, sx);
        items.push({
          model: 'traffic-light',
          x: px,
          y: heightAt(px, pz) + 0.02,
          z: pz,
          yaw,
          sx: 8.5,
          sy: 8.5,
          sz: 8.5,
        });
      }
    }

    // Stop signs on two approaches, facing the traffic that reads them.
    const approaches = [
      { x: j.x + j.nsWidth / 2 + 2.0, z: j.z + j.ewWidth / 2 + 9, fx: 0, fz: -1 },
      { x: j.x - j.nsWidth / 2 - 2.0, z: j.z - j.ewWidth / 2 - 9, fx: 0, fz: 1 },
    ];
    for (const approach of approaches) {
      const yaw = Math.atan2(-approach.fz, approach.fx);
      items.push({
        model: 'road-sign-stop',
        x: approach.x,
        y: heightAt(approach.x, approach.z) + 0.02,
        z: approach.z,
        yaw,
        sx: 6,
        sy: 6,
        sz: 6,
      });
    }

    // Street name blades, just outside the signal on the north-east corner.
    const streetX = j.x + j.nsWidth / 2 + 4.4;
    const streetZ = j.z + j.ewWidth / 2 + 4.4;
    items.push({
      model: 'road-sign-street',
      x: streetX,
      y: heightAt(streetX, streetZ) + 0.02,
      z: streetZ,
      yaw: Math.atan2(-(j.z - streetZ), j.x - streetX),
      sx: 7,
      sy: 7,
      sz: 7,
    });
  }

  // --- Warning signs and motorway boards -----------------------------------
  for (const road of SAMPLED_ROADS) {
    if (road.def.kind !== 'rural') continue;
    const width = roadWidth(road.def);
    let index = 0;
    walkRoad(road, 155, 70, (pose) => {
      const nx = -pose.tz;
      const nz = pose.tx;
      const px = pose.x + nx * (width / 2 + 2.8);
      const pz = pose.z + nz * (width / 2 + 2.8);
      // The sign panel faces local +X: turn it towards the oncoming lane.
      const yaw = Math.atan2(pose.tz, -pose.tx);
      const highway = index % 3 === 0;
      const signScale = highway ? 4.5 : 6;
      items.push({
        model: highway ? 'sign-highway-wide' : 'road-sign-warning',
        x: px,
        y: heightAt(px, pz) + 0.02,
        z: pz,
        yaw,
        sx: signScale,
        sy: signScale,
        sz: signScale,
      });
      index++;
    });
  }

  // --- Power lines along the rural roads ----------------------------------
  // One pole every 41 m on the same shoulder, bridged by a single wire span
  // stretched along its own axis to close the gap. The kit's poles are as wide
  // as they are tall, so the post is squashed horizontally to read as a real
  // distribution pole instead of a gantry.
  const POLE_HEIGHT = 14;
  const POLE_WIDTH = 6;
  const CABLE = 4.5;
  // The wire model starts at y = 0.438 at scale 1; lift it back to the arm.
  const CABLE_LIFT = 0.438 * (POLE_HEIGHT - CABLE);
  for (const road of SAMPLED_ROADS) {
    if (road.def.kind !== 'rural') continue;
    const width = roadWidth(road.def);
    const poles: { x: number; y: number; z: number }[] = [];
    walkRoad(road, 41, 23, (pose) => {
      const px = pose.x - pose.tz * (width / 2 + 2.4);
      const pz = pose.z + pose.tx * (width / 2 + 2.4);
      const y = heightAt(px, pz);
      // The arm runs across the road, the way the cables leave it.
      const yaw = Math.atan2(-pose.tx, -pose.tz);
      poles.push({ x: px, y, z: pz });
      items.push({
        model: 'electricity-pole',
        x: px,
        y,
        z: pz,
        yaw,
        sx: POLE_WIDTH,
        sy: POLE_HEIGHT,
        sz: POLE_WIDTH,
      });
    });

    const spans = road.def.closed ? poles.length : poles.length - 1;
    for (let i = 0; i < spans; i++) {
      const a = poles[i];
      const b = poles[(i + 1) % poles.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const gap = Math.hypot(dx, dz);
      if (gap < 8 || gap > 60) continue;
      // The wire model spans -0.285..0.221 in X, not centred: stretch it to the
      // gap and slide it so both ends land on a pole.
      const stretch = gap / 0.506;
      items.push({
        model: 'electricity-wires',
        x: (a.x + b.x) / 2 + (dx / gap) * 0.063 * gap,
        y: (a.y + b.y) / 2 + CABLE_LIFT,
        z: (a.z + b.z) / 2 + (dz / gap) * 0.063 * gap,
        yaw: Math.atan2(-dz, dx),
        sx: stretch,
        sy: CABLE,
        sz: CABLE,
      });
    }
  }

  // --- Roadworks on the shoulder of Rue des Tilleuls ----------------------
  for (let i = 0; i < 9; i++) {
    const x = -132 + i * 4.6;
    items.push({
      model: 'construction-cone',
      x,
      y: heightAt(x, 46.6) + 0.02,
      z: 46.6,
      yaw: rand() * Math.PI,
      sx: 11,
      sy: 11,
      sz: 11,
    });
  }
  for (const x of [-136, -91]) {
    items.push({
      model: 'construction-barrier',
      x,
      y: heightAt(x, 46.8) + 0.02,
      z: 46.8,
      yaw: 0,
      sx: 10,
      sy: 10,
      sz: 10,
    });
  }
  items.push({
    model: 'construction-fence',
    x: -108,
    y: heightAt(-108, 47.6) + 0.02,
    z: 47.6,
    yaw: Math.PI / 2,
    sx: 10,
    sy: 10,
    sz: 10,
  });
  items.push({
    model: 'construction-light',
    x: -138,
    y: heightAt(-138, 47.4) + 0.02,
    z: 47.4,
    yaw: 0,
    sx: 10,
    sy: 10,
    sz: 10,
  });

  // --- Roadworks by the drift pad -----------------------------------------
  for (let i = 0; i < 7; i++) {
    const x = 236 + i * 4.4;
    const z = 190 + Math.sin(i) * 0.8;
    items.push({
      model: 'construction-cone',
      x,
      y: heightAt(x, z) + 0.02,
      z,
      yaw: rand() * Math.PI,
      sx: 11,
      sy: 11,
      sz: 11,
    });
  }
  items.push({
    model: 'construction-barrier',
    x: 232.5,
    y: heightAt(232.5, 190) + 0.02,
    z: 190,
    yaw: 0,
    sx: 10,
    sy: 10,
    sz: 10,
  });
  items.push({
    model: 'construction-light',
    x: 266,
    y: heightAt(266, 190) + 0.02,
    z: 190,
    yaw: 0,
    sx: 10,
    sy: 10,
    sz: 10,
  });

  // --- Dumpsters in the city ----------------------------------------------
  // Kept clear of the junctions: a skip parked in the middle of a crossing is
  // the first thing a player hits.
  const dumpsterSpots: [number, number, number][] = [
    [-250, -120, 0.4],
    [-150, -120, -1.1],
    [-50, -120, 0.9],
    [50, -120, 2.4],
    [-250, 20, 0.2],
    [-150, 20, 1.7],
    [-50, 20, -0.4],
    [50, 20, 2.9],
  ];
  for (const [x, z, yaw] of dumpsterSpots) {
    items.push({
      model: 'dumpster',
      x,
      y: heightAt(x, z) + 0.02,
      z,
      yaw,
      sx: 7,
      sy: 7,
      sz: 7,
    });
  }

  return items;
}

async function loadTemplate(loader: GLTFLoader, model: KitModel): Promise<Template> {
  const gltf = await loader.loadAsync(`${KIT}/${model}.glb`);
  gltf.scene.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  // Collected through an array: TypeScript cannot follow assignments made in
  // the traverse callback.
  const materials: THREE.MeshStandardMaterial[] = [];
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // The kit is flat-shaded with a palette texture: tangents only bloat the
    // merge, and some primitives of a model do not carry them at all.
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position' && attribute !== 'normal' && attribute !== 'uv') {
        geometry.deleteAttribute(attribute);
      }
    }
    if (!geometry.getAttribute('uv')) {
      const uv = new Float32Array((geometry.getAttribute('position').count ?? 0) * 2);
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    geometries.push(geometry);
    if (materials.length === 0 && mesh.material) {
      materials.push(
        (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial,
      );
    }
  });
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error(`${model}: geometry merge failed`);
  const material = materials[0];
  if (!material) throw new Error(`${model}: no material`);

  material.metalness = 0;
  material.roughness = 0.82;
  const map = material.map;
  if (model === 'road-crossing') {
    // The tile is a decal sitting a few millimetres over the road ribbon: bias
    // its depth so the zebra wins instead of fighting the asphalt for pixels.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -4;
    material.polygonOffsetUnits = -4;
    // The kit's tarmac is far lighter than the road texture: tone it down so
    // the crossing reads as paint on the street and not as a white slab.
    material.color.setHex(0x9aa0a8);
  }
  if (map) {
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.anisotropy = 4;
  }
  return { geometry: merged, material };
}

/**
 * Loads the kit, drops the furniture along the roads and adds colliders for the
 * pieces the car can hit. A model that fails to load is skipped: street
 * furniture is decoration and must never keep the game from starting.
 */
export async function buildStreetKit(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
): Promise<StreetKitSummary> {
  const loader = new GLTFLoader();
  const templates = new Map<KitModel, Template>();
  const results = await Promise.allSettled(
    KIT_MODELS.map(async (model) => ({ model, template: await loadTemplate(loader, model) })),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') templates.set(result.value.model, result.value.template);
    else console.warn('[streetkit]', result.reason);
  }

  const items = buildItems().filter((item) => templates.has(item.model));
  const byModel = new Map<KitModel, Item[]>();
  for (const item of items) {
    const list = byModel.get(item.model);
    if (list) list.push(item);
    else byModel.set(item.model, [item]);
  }

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (const [model, list] of byModel) {
    const template = templates.get(model);
    if (!template) continue;
    const mesh = new THREE.InstancedMesh(template.geometry, template.material, list.length);
    mesh.name = `streetkit-${model}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      position.set(item.x, item.y, item.z);
      quaternion.setFromAxisAngle(up, item.yaw);
      scale.set(item.sx, item.sy, item.sz);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }

  // --- Lamp heads ---------------------------------------------------------
  // The kit's lamps are all post: give each one a lit head where its arm ends,
  // so the streets have a warm line of light instead of bare poles.
  const heads: { x: number; y: number; z: number }[] = [];
  for (const item of items) {
    if (item.model !== 'light-square' && item.model !== 'light-curved') continue;
    // Head offset in model units: the arm runs along local -Z.
    const headY = item.model === 'light-square' ? 0.57 : 0.635;
    const headZ = item.model === 'light-square' ? -0.19 : -0.185;
    heads.push({
      x: item.x + Math.sin(item.yaw) * headZ * item.sz,
      y: item.y + headY * item.sy,
      z: item.z + Math.cos(item.yaw) * headZ * item.sz,
    });
  }
  if (heads.length > 0) {
    const glow = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.28, 8, 6),
      mats.lampGlow,
      heads.length,
    );
    glow.name = 'streetkit-lamp-heads';
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      position.set(head.x, head.y, head.z);
      quaternion.identity();
      scale.set(1, 1, 1);
      matrix.compose(position, quaternion, scale);
      glow.setMatrixAt(i, matrix);
    }
    glow.instanceMatrix.needsUpdate = true;
    glow.computeBoundingSphere();
    scene.add(glow);
  }

  let colliders = 0;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const item of items) {
    const extents = COLLIDERS[item.model];
    if (!extents) continue;
    const half = {
      x: extents[0] * item.sx,
      y: extents[1] * item.sy,
      z: extents[2] * item.sz,
    };
    quaternion.setFromAxisAngle(up, item.yaw);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(item.x, item.y + half.y, item.z)
        .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
        .setFriction(0.6),
      body,
    );
    colliders++;
  }

  const roadMaterials: THREE.MeshStandardMaterial[] = [];
  for (const [model, template] of templates) {
    if (model.includes('road')) roadMaterials.push(template.material);
  }

  return { models: templates.size, instances: items.length, colliders, roadMaterials };
}
