/**
 * Le paddock, aux deux bouts des stands.
 *
 * La dalle s'arrêtait sur du béton vide : à gauche comme à droite des boxes, il
 * n'y avait rien, et l'on pouvait sortir de la carte par les extrémités. Ici
 * chaque bout reçoit son bâtiment — un pavillon d'accueil au nord, un auvent
 * d'équipe avec son camion au sud — plus le stationnement, les jardinières et
 * les drapeaux. Les collisions ferment le pourtour : le paddock devient une
 * cour, pas une plage.
 *
 * Tout est fusionné par matière (une dizaine d'appels de dessin) et calé sur la
 * cote de la dalle : rien ne flotte, rien ne dépasse sur la voie des stands.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import { createConcreteTexture } from './materials.ts';
import { GARAGE_FRONT_X, PIT_APRON_FROM, PIT_APRON_TO } from '../world/pitLayout.ts';

const SOLID_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
/** Cote de la dalle : tout le mobilier se pose dessus. */
const FLOOR = 0.06;
/** Axe du paddock : à l'ouest de la voie des stands (x = -24,2). */
const PADDOCK_X = -45;
const PADDOCK_FENCE_X = -56.4;

export interface PitPaddockBuild {
  triangles: number;
  meshes: number;
}

interface Sink {
  material: THREE.Material;
  geometries: THREE.BufferGeometry[];
}

/** Texte sur toile, pour les enseignes du paddock. */
function signTexture(text: string, background: string, colour = '#f6f3e9'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = colour;
  ctx.font = 'bold 86px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Le stationnement du paddock : des cases peintes à même le béton. Une texture
 * suffit — un jeu de lignes en géométrie coûterait des centaines de boîtes pour
 * un motif qu'on ne voit que de haut.
 */
function parkingTexture(anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(240,236,224,0.85)';
  ctx.lineWidth = 5;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 7; column++) {
      const x = 40 + column * 140;
      const y = 60 + row * 260;
      ctx.strokeRect(x, y, 120, 220);
    }
  }
  ctx.fillStyle = 'rgba(240,236,224,0.55)';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText('PADDOCK', 40, 610);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

export function buildPitPaddock(
  scene: THREE.Scene,
  world: RAPIER.World,
  anisotropy: number,
): PitPaddockBuild {
  const concreteTexture = createConcreteTexture();
  concreteTexture.repeat.set(6, 3);
  concreteTexture.anisotropy = anisotropy;
  const concrete = new THREE.MeshStandardMaterial({
    map: concreteTexture,
    color: 0xd8d4ca,
    roughness: 0.9,
    metalness: 0.03,
  });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.62 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa1a9, roughness: 0.4, metalness: 0.72 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x7e9bb2,
    roughness: 0.08,
    metalness: 0.18,
    transparent: true,
    opacity: 0.42,
  });
  const red = new THREE.MeshStandardMaterial({ color: 0xa3141c, roughness: 0.5 });
  const soil = new THREE.MeshStandardMaterial({ color: 0x3b3327, roughness: 0.98 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x4d6b35, roughness: 0.9 });

  const sinks: Sink[] = [
    { material: concrete, geometries: [] },
    { material: white, geometries: [] },
    { material: dark, geometries: [] },
    { material: steel, geometries: [] },
    { material: glass, geometries: [] },
    { material: red, geometries: [] },
    { material: soil, geometries: [] },
    { material: leaf, geometries: [] },
  ];
  const bucket = (material: THREE.Material): THREE.BufferGeometry[] =>
    sinks.find((sink) => sink.material === material)!.geometries;
  const push = (
    material: THREE.Material,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    spin = 0,
  ): void => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    if (spin) geometry.rotateY(spin);
    geometry.translate(x, y, z);
    bucket(material).push(geometry);
  };
  const tube = (
    material: THREE.Material,
    radius: number,
    length: number,
    x: number,
    y: number,
    z: number,
    axis: 'x' | 'y' | 'z' = 'y',
  ): void => {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 12);
    if (axis === 'x') geometry.rotateZ(Math.PI / 2);
    if (axis === 'z') geometry.rotateX(Math.PI / 2);
    geometry.translate(x, y, z);
    bucket(material).push(geometry);
  };

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const solid = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2)
        .setTranslation(x, y, z)
        .setFriction(0.7)
        .setRestitution(0.04)
        .setCollisionGroups(SOLID_GROUP),
      body,
    );
  };

  // --- Pavillon d'accueil, au nord ---------------------------------------
  // Deux niveaux vitrés sur la cour, une entrée abritée, une terrasse sur le
  // toit : c'est le bâtiment qui manquait au bout de la ligne droite.
  const hx = PADDOCK_X;
  const hz = -312;
  push(concrete, 19, 7.2, 16, hx, 3.6, hz);
  // Bandeaux vitrés sur les quatre faces, avec leurs meneaux : le pavillon
  // était un bloc de béton plein et ne lisait comme un bâtiment que de face.
  for (const y of [2.7, 5.3]) {
    push(glass, 0.12, 1.7, 14.4, hx + 9.56, y, hz);
    for (let z = hz - 7; z <= hz + 7; z += 2) {
      push(dark, 0.2, 1.9, 0.16, hx + 9.6, y, z);
    }
    for (const z of [hz - 8.06, hz + 8.06]) {
      push(glass, 16.4, 1.7, 0.12, hx, y, z);
      for (let x = hx - 8; x <= hx + 8; x += 2.2) {
        push(dark, 0.16, 1.9, 0.2, x, y, z + (z > hz ? 0.06 : -0.06));
      }
    }
  }
  // Bandeau d'écurie rouge sur les pignons, sous les vitres du premier étage.
  for (const z of [hz - 8.08, hz + 8.08]) {
    push(red, 16.4, 0.36, 0.1, hx, 4.0, z);
  }
  // Entrée : auvent, marche et portes vitrées.
  push(white, 3.4, 0.28, 6.4, hx + 10.6, 3.5, hz);
  push(glass, 0.12, 2.6, 3.2, hx + 9.6, 1.3, hz);
  for (const dz of [-2.2, 0, 2.2]) {
    push(steel, 0.16, 3.3, 0.16, hx + 11.1, 1.65, hz + dz);
  }
  for (let step = 0; step < 3; step++) {
    push(concrete, 3.6 - step * 0.5, 0.18, 6.2, hx + 9.4 + step * 0.5, 0.09 + step * 0.18, hz);
  }
  // Garde-corps de la terrasse.
  push(steel, 0.08, 1.1, 15, hx + 9.1, 7.75, hz);
  for (let z = hz - 7; z <= hz + 7; z += 2.4) {
    push(steel, 0.07, 1.1, 0.07, hx + 9.1, 7.75, z);
  }
  solid(19, 7.2, 16, hx, 3.6, hz);

  const clubTexture = signTexture('PADDOCK CLUB', '#a3141c');
  const clubMaterial = new THREE.MeshBasicMaterial({ map: clubTexture, side: THREE.DoubleSide });
  const clubSign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.35), clubMaterial);
  clubSign.position.set(hx + 9.65, 6.4, hz);
  clubSign.rotation.y = Math.PI / 2;
  scene.add(clubSign);
  // Le même bandeau sur les pignons, pour qui arrive par la voie des stands.
  for (const z of [hz - 8.12, hz + 8.12]) {
    const sideSign = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.2), clubMaterial);
    sideSign.position.set(hx, 6.5, z);
    sideSign.rotation.y = z > hz ? 0 : Math.PI;
    scene.add(sideSign);
  }

  // --- Stationnement, dans l'axe du pavillon -----------------------------
  const parking = new THREE.Mesh(
    new THREE.PlaneGeometry(27, 17),
    new THREE.MeshBasicMaterial({
      map: parkingTexture(anisotropy),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  parking.rotation.x = -Math.PI / 2;
  parking.position.set(PADDOCK_X - 1, FLOOR + 0.012, -348);
  parking.renderOrder = 2;
  scene.add(parking);

  // --- Auvent d'équipe et camion, au sud --------------------------------
  const tx = -42.5;
  const tz = -505;
  push(steel, 18, 0.32, 12.5, tx, 5.1, tz);
  push(red, 18, 0.4, 0.28, tx, 4.85, tz - 6.3);
  push(red, 0.28, 0.4, 12.5, tx + 9.05, 4.85, tz);
  for (const dx of [-8.6, 8.6]) {
    for (const dz of [-5.8, 5.8]) {
      push(steel, 0.26, 5.1, 0.26, tx + dx, 2.55, tz + dz);
      solid(0.4, 5.1, 0.4, tx + dx, 2.55, tz + dz);
    }
  }

  // Le camion d'équipe : caisse, cabine, roues, bandeau rouge.
  const truckZ = tz + 1;
  push(white, 2.6, 2.9, 7.8, tx, 2.2, truckZ);
  push(red, 2.62, 0.5, 7.8, tx, 3.1, truckZ);
  push(white, 2.5, 2.3, 2.5, tx, 1.9, truckZ - 5.2);
  push(glass, 2.4, 0.8, 0.12, tx, 2.3, truckZ - 6.46);
  push(dark, 2.7, 0.7, 8.2, tx, 0.72, truckZ);
  for (const z of [truckZ - 5.2, truckZ - 3.1, truckZ + 2.9, truckZ + 4.4]) {
    for (const side of [-1, 1]) {
      tube(dark, 0.42, 0.34, tx + side * 1.32, 0.42, z, 'x');
    }
  }
  solid(2.7, 3.4, 10.5, tx, 1.7, truckZ + 1.6);

  // Îlot carburant, sous l'auvent, côté voie.
  const fuelX = -33.6;
  push(concrete, 1.5, 0.22, 4, fuelX, 0.11, tz);
  for (const dz of [-1.1, 1.1]) {
    push(white, 0.8, 1.5, 0.7, fuelX, 1.02, tz + dz);
    push(red, 0.82, 0.22, 0.72, fuelX, 1.8, tz + dz);
    push(dark, 0.16, 0.5, 0.2, fuelX + 0.42, 1.25, tz + dz);
  }
  solid(1.6, 1.9, 4, fuelX, 0.95, tz);

  // Enseigne de l'auvent, tournée vers la voie des stands.
  const teamSign = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 1.1),
    new THREE.MeshBasicMaterial({
      map: signTexture('SP95 RACING', '#111820'),
      side: THREE.DoubleSide,
    }),
  );
  teamSign.position.set(tx + 9.12, 4.4, tz);
  teamSign.rotation.y = Math.PI / 2;
  scene.add(teamSign);

  // --- Jardinières et drapeaux -------------------------------------------
  const planters: number[] = [-370, -286, -484, -530];
  for (const z of planters) {
    push(concrete, 2.6, 0.7, 2.6, PADDOCK_FENCE_X + 2, FLOOR + 0.35, z);
    push(soil, 2.2, 0.08, 2.2, PADDOCK_FENCE_X + 2, FLOOR + 0.73, z);
    push(leaf, 1.1, 1.5, 1.1, PADDOCK_FENCE_X + 2, FLOOR + 1.45, z);
    solid(2.6, 0.8, 2.6, PADDOCK_FENCE_X + 2, FLOOR + 0.4, z);
  }
  for (const [index, z] of [-300, -312, -324].entries()) {
    const poleX = hx + 11.5;
    tube(steel, 0.09, 9, poleX, 4.5, z);
    push(index === 1 ? red : white, 0.06, 1.1, 1.7, poleX + 0.03, 8.2, z + 0.85);
    solid(0.3, 9, 0.3, poleX, 4.5, z);
  }

  // --- Marquage de la voie de service ------------------------------------
  // Un trait jaune discontinu le long du fond : il guide l'œil et sépare la
  // cour de la zone de travail, sans rien coûter en dessins (une seule boîte).
  for (let z = PIT_APRON_FROM + 6; z < PIT_APRON_TO - 6; z += 5) {
    push(white, 0.18, 0.012, 2.4, GARAGE_FRONT_X - 1.9, FLOOR + 0.008, z);
  }
  for (let z = PIT_APRON_FROM + 6; z < PIT_APRON_TO - 6; z += 5) {
    push(red, 0.18, 0.012, 2.4, PADDOCK_FENCE_X + 5.2, FLOOR + 0.008, z);
  }

  // --- Fusion et pose -----------------------------------------------------
  let triangles = 0;
  let meshes = 0;
  for (const sink of sinks) {
    if (sink.geometries.length === 0) continue;
    const merged = mergeGeometries(sink.geometries);
    sink.geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, sink.material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `pit-paddock-${meshes}`;
    scene.add(mesh);
    meshes += 1;
    triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
  }

  return { triangles: Math.round(triangles), meshes };
}
