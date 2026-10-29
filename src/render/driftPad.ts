/**
 * L'aire de gymkhana : une vraie aire de drift, posée au centre du circuit.
 *
 * La première version était une dalle grise avec deux anneaux pâles : à l'écran
 * elle lisait comme un parking vide. Ici la dalle a un *tracé* — skidpad, huit,
 * slalom, ligne de départ — peint dans une seule texture, puis un décor bâti :
 * portique d'entrée, murets de pneus, vibreurs, projecteurs, tour de contrôle,
 * tribune et panneaux. Tout est fusionné ou instancié : une douzaine d'appels
 * de dessin pour toute l'aire.
 *
 * Le sol physique reste plat : `insideDriftPad` dit à la physique que la dalle
 * et son raccordement sont de l'asphalte, et rien n'est posé dessus.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import { createAsphaltTexture } from './materials.ts';
import { DRIFT_ACCESS, DRIFT_PAD } from '../world/driftPad.ts';

/** Cote du revêtement, au-dessus de l'herbe. */
const PAD_Y = 0.028;
/** Cote des peintures, un cheveu au-dessus. */
const PAINT_Y = PAD_Y + 0.006;
/** Même groupe de collision que les murs et les props. */
const SOLID_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
/** Encre du marquage. */
const INK = '#f2efe4';

export interface DriftPadBuild {
  triangles: number;
  meshes: number;
}

/** Points régulièrement espacés sur le pourtour de la dalle. */
function perimeterSpots(inset: number, step: number): { x: number; z: number; yaw: number }[] {
  const spots: { x: number; z: number; yaw: number }[] = [];
  const x0 = DRIFT_PAD.cx - DRIFT_PAD.halfX + inset;
  const x1 = DRIFT_PAD.cx + DRIFT_PAD.halfX - inset;
  const z0 = DRIFT_PAD.cz - DRIFT_PAD.halfZ + inset;
  const z1 = DRIFT_PAD.cz + DRIFT_PAD.halfZ - inset;
  for (let x = x0; x <= x1; x += step) {
    spots.push({ x, z: z0, yaw: 0 });
    spots.push({ x, z: z1, yaw: 0 });
  }
  for (let z = z0; z <= z1; z += step) {
    spots.push({ x: x1, z, yaw: Math.PI / 2 });
    // Le raccordement traverse le bord ouest : le muret s'y ouvre.
    if (z > DRIFT_ACCESS.z0 - 2 && z < DRIFT_ACCESS.z1 + 2) continue;
    spots.push({ x: x0, z, yaw: Math.PI / 2 });
  }
  return spots;
}

/**
 * Le tracé complet, peint dans une seule texture de 2048 × 1600 (16 px/m).
 * Le canvas est dessiné dans le repère du monde vu de dessus : x vers la
 * droite, z vers le bas. La texture est ensuite posée à plat sur la dalle.
 */
function markingsTexture(anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1600;
  const ctx = canvas.getContext('2d')!;
  const spanX = DRIFT_PAD.halfX * 2;
  const spanZ = DRIFT_PAD.halfZ * 2;
  const sx = canvas.width / spanX;
  const sz = canvas.height / spanZ;
  const px = (x: number): number => (x - (DRIFT_PAD.cx - DRIFT_PAD.halfX)) * sx;
  const pz = (z: number): number => (z - (DRIFT_PAD.cz - DRIFT_PAD.halfZ)) * sz;
  const metre = (value: number): number => value * (sx + sz) / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // --- Gomme : les arcs laissés par les sessions précédentes ---------------
  ctx.strokeStyle = 'rgba(22,23,26,0.16)';
  ctx.lineCap = 'round';
  for (const [radius, from, to, width] of [
    [38, 0.2, 2.4, 4.2],
    [34.5, 3.6, 5.1, 3.4],
    [31, 1.1, 3.9, 4.6],
    [24, 2.2, 4.4, 2.8],
    [17, 5.4, 7.2, 2.2],
  ] as const) {
    ctx.lineWidth = metre(width);
    ctx.beginPath();
    ctx.arc(px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz), metre(radius), from, to);
    ctx.stroke();
  }
  ctx.lineWidth = metre(3);
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(px(DRIFT_PAD.cx + 40), pz(DRIFT_PAD.cz + 30), metre(6 + i * 2.4), 3.1 + i * 0.3, 4.4 + i * 0.3);
    ctx.stroke();
  }

  // --- Skidpad : deux cercles de bord et une ligne médiane pointillée ------
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = metre(0.5);
  for (const radius of [30, 40]) {
    ctx.beginPath();
    ctx.arc(px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz), metre(radius), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([metre(2.4), metre(2.2)]);
  ctx.lineWidth = metre(0.28);
  ctx.beginPath();
  ctx.arc(px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz), metre(35), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- Huit : deux lobes qui se croisent -----------------------------------
  for (const [dx, dz] of [[-19, 21], [19, 21]] as const) {
    ctx.beginPath();
    ctx.arc(px(DRIFT_PAD.cx + dx), pz(DRIFT_PAD.cz + dz), metre(16), 0, Math.PI * 2);
    ctx.stroke();
  }
  // Les deux axes du croisement, en traits pleins courts.
  ctx.lineWidth = metre(0.3);
  ctx.beginPath();
  ctx.moveTo(px(DRIFT_PAD.cx - 3), pz(DRIFT_PAD.cz + 21));
  ctx.lineTo(px(DRIFT_PAD.cx + 3), pz(DRIFT_PAD.cz + 21));
  ctx.stroke();

  // --- Slalom : les emplacements des plots --------------------------------
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = INK;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(px(DRIFT_PAD.cx - 28 + i * 8), pz(DRIFT_PAD.cz - 34), metre(0.9), 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Ligne de départ du tracé, à l'entrée de la dalle -------------------
  const bandX = 58;
  const squares = 10;
  const bandHalf = (DRIFT_ACCESS.z1 - DRIFT_ACCESS.z0) / 2;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < squares; column++) {
      const z = DRIFT_ACCESS.z0 + (column / squares) * bandHalf * 2;
      ctx.fillStyle = (row + column) % 2 === 0 ? INK : 'rgba(20,21,24,0.9)';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(px(bandX) + row * metre(1), pz(z), metre(1), (bandHalf * 2 * sz) / squares);
    }
  }

  // --- Liseré de pourtour, à l'intérieur des pneus ------------------------
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = metre(0.3);
  ctx.strokeRect(
    px(DRIFT_PAD.cx - DRIFT_PAD.halfX + 3),
    pz(DRIFT_PAD.cz - DRIFT_PAD.halfZ + 3),
    metre(DRIFT_PAD.halfX * 2 - 6),
    metre(DRIFT_PAD.halfZ * 2 - 6),
  );

  // --- Flèches de sens autour du skidpad ----------------------------------
  for (const angle of [0.4, 1.9, 3.5, 5.1]) {
    const cx = px(DRIFT_PAD.cx) + Math.cos(angle) * metre(46);
    const cz = pz(DRIFT_PAD.cz) + Math.sin(angle) * metre(46);
    ctx.save();
    ctx.translate(cx, cz);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = INK;
    ctx.globalAlpha = 0.82;
    ctx.beginPath();
    ctx.moveTo(0, -metre(2.4));
    ctx.lineTo(metre(1.5), metre(1.4));
    ctx.lineTo(-metre(1.5), metre(1.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // --- Inscriptions, discrètes : le tracé reste le sujet ------------------
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(metre(4.6))}px system-ui, sans-serif`;
  ctx.fillText('SP95', px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz + 45));
  ctx.font = `bold ${Math.round(metre(1.9))}px system-ui, sans-serif`;
  ctx.fillText('DRIFT PARK', px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz - 44));
  ctx.font = `bold ${Math.round(metre(1.1))}px system-ui, sans-serif`;
  ctx.fillText('DONUT · HUIT · SLALOM', px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz - 40.5));
  // Croix du centre du skidpad : elle aide à viser le point de rotation.
  ctx.lineWidth = metre(0.35);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(px(DRIFT_PAD.cx - 3), pz(DRIFT_PAD.cz));
  ctx.lineTo(px(DRIFT_PAD.cx + 3), pz(DRIFT_PAD.cz));
  ctx.moveTo(px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz - 3));
  ctx.lineTo(px(DRIFT_PAD.cx), pz(DRIFT_PAD.cz + 3));
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Bandeau de toile : fond plein, texte centré, damier aux extrémités. */
function bannerTexture(text: string, background: string, checkers = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (checkers) {
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 8; column++) {
        ctx.fillStyle = (row + column) % 2 === 0 ? '#f4f1e8' : '#15161a';
        ctx.fillRect(column * 20, row * 20, 20, 20);
        ctx.fillRect(canvas.width - 160 + column * 20, row * 20, 20, 20);
      }
    }
  }
  ctx.fillStyle = '#f6f3e9';
  ctx.font = 'bold 88px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Atlas des panneaux publicitaires, six marques dans une texture. */
function boardsTexture(anisotropy: number): THREE.CanvasTexture {
  const labels = ['SP95', 'APEX OIL', 'NORTHWIND', 'VELOCE', 'SPRINT', 'DRIFT'];
  const cells = labels.length;
  const canvas = document.createElement('canvas');
  canvas.width = 512 * cells;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  labels.forEach((label, index) => {
    const x = index * 512;
    ctx.fillStyle = index % 2 === 0 ? '#111820' : '#a3141c';
    ctx.fillRect(x, 0, 512, 160);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x + 12, 12, 488, 4);
    ctx.fillStyle = '#f4f1e8';
    ctx.font = `bold ${label.length > 8 ? 54 : 66}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 256, 84);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Boîte simple, ajoutée à la scène. */
function addBox(
  scene: THREE.Scene,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
  yaw = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

/** Collider fixe, avec le même groupe que le reste du décor. */
function solid(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  x: number,
  y: number,
  z: number,
  halfX: number,
  halfY: number,
  halfZ: number,
  yaw = 0,
): void {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setTranslation(x, y, z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
      .setFriction(0.7)
      .setRestitution(0.08)
      .setCollisionGroups(SOLID_GROUP),
    body,
  );
}

export function buildDriftPad(scene: THREE.Scene, world: RAPIER.World, anisotropy: number): DriftPadBuild {
  let meshes = 0;
  let triangles = 0;
  const count = (geometry: THREE.BufferGeometry): number => {
    const tris = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    triangles += tris;
    return tris;
  };

  // --- La dalle et son raccordement --------------------------------------
  const asphalt = createAsphaltTexture();
  asphalt.repeat.set(21, 17);
  asphalt.anisotropy = anisotropy;
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphalt,
    color: 0xb4b4ac,
    roughness: 0.96,
    metalness: 0.02,
  });

  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(DRIFT_PAD.halfX * 2, DRIFT_PAD.halfZ * 2),
    asphaltMat,
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(DRIFT_PAD.cx, PAD_Y, DRIFT_PAD.cz);
  pad.receiveShadow = true;
  pad.name = 'drift-pad';
  scene.add(pad);
  meshes += 1;
  count(pad.geometry);

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
  count(access.geometry);

  // --- Le tracé peint -----------------------------------------------------
  const markings = new THREE.Mesh(
    new THREE.PlaneGeometry(DRIFT_PAD.halfX * 2, DRIFT_PAD.halfZ * 2),
    new THREE.MeshStandardMaterial({
      map: markingsTexture(anisotropy),
      transparent: true,
      depthWrite: false,
      roughness: 0.8,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  markings.rotation.x = -Math.PI / 2;
  markings.position.set(DRIFT_PAD.cx, PAINT_Y, DRIFT_PAD.cz);
  markings.name = 'drift-markings';
  markings.renderOrder = 2;
  scene.add(markings);
  meshes += 1;
  count(markings.geometry);

  // Pointillés du raccordement : on entre dans l'aire par une allée lisible.
  const dashes: THREE.BufferGeometry[] = [];
  const midZ = (DRIFT_ACCESS.z0 + DRIFT_ACCESS.z1) / 2;
  for (let x = DRIFT_ACCESS.fromX + 2; x < DRIFT_ACCESS.toX - 1; x += 6) {
    const dash = new THREE.PlaneGeometry(3.2, 0.24);
    dash.rotateX(-Math.PI / 2);
    dash.translate(x, PAINT_Y, midZ);
    dashes.push(dash);
  }
  const dashesMesh = mergeGeometries(dashes);
  dashes.forEach((dash) => dash.dispose());
  if (dashesMesh) {
    const mesh = new THREE.Mesh(
      dashesMesh,
      new THREE.MeshStandardMaterial({
        color: 0xece9dd,
        roughness: 0.75,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    mesh.name = 'drift-access-dashes';
    scene.add(mesh);
    meshes += 1;
    count(dashesMesh);
  }

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // --- Vibreurs de pourtour ----------------------------------------------
  const kerbSpots = perimeterSpots(0.45, 2.2);
  const kerbs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.2, 0.14, 0.55),
    new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.02 }),
    kerbSpots.length,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const colour = new THREE.Color();
  kerbSpots.forEach((spot, index) => {
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw);
    position.set(spot.x, 0.1, spot.z);
    matrix.compose(position, quaternion, scale);
    kerbs.setMatrixAt(index, matrix);
    kerbs.setColorAt(index, colour.set(index % 2 === 0 ? 0xb32328 : 0xe8e3d5));
  });
  kerbs.receiveShadow = true;
  kerbs.name = 'drift-kerbs';
  scene.add(kerbs);
  meshes += 1;
  triangles += kerbSpots.length * 12;

  // --- Murets de pneus, avec leurs collisions ----------------------------
  const tyreSpots = perimeterSpots(1.35, 1.15);
  const tyres = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.34, 12),
    new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.95 }),
    tyreSpots.length * 3,
  );
  let tyre = 0;
  for (const spot of tyreSpots) {
    for (let level = 0; level < 3; level++) {
      matrix.makeTranslation(spot.x, 0.17 + level * 0.35, spot.z);
      tyres.setMatrixAt(tyre++, matrix);
    }
  }
  tyres.count = tyre;
  tyres.receiveShadow = true;
  tyres.name = 'drift-tyre-wall';
  scene.add(tyres);
  meshes += 1;
  triangles += tyre * 12;
  // Une caisse de collision tous les quatre mètres : la voiture bute sur le
  // muret au lieu de le traverser, sans payer cent colliders par mètre.
  const wallColliders = perimeterSpots(1.35, 4.2);
  for (const spot of wallColliders) {
    solid(world, body, spot.x, 0.52, spot.z, 0.7, 0.52, 0.7, spot.yaw);
  }

  // --- Portique d'entrée --------------------------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa1a9, roughness: 0.42, metalness: 0.72 });
  const gateX = 58;
  const gateZ = (DRIFT_ACCESS.z0 + DRIFT_ACCESS.z1) / 2;
  const gateHalf = (DRIFT_ACCESS.z1 - DRIFT_ACCESS.z0) / 2 + 0.9;
  for (const side of [-1, 1]) {
    addBox(scene, 0.75, 7.4, 0.75, gateX, 3.7, gateZ + side * gateHalf, steel);
    solid(world, body, gateX, 3.7, gateZ + side * gateHalf, 0.42, 3.7, 0.42);
  }
  addBox(scene, 0.5, 0.5, gateHalf * 2 + 1.5, gateX, 7.15, gateZ, steel);
  // Deux faces distinctes : un seul plan retourné afficherait le texte en
  // miroir depuis l'une des deux approches.
  const bannerMaterial = new THREE.MeshBasicMaterial({
    map: bannerTexture('SP95  ·  DRIFT PARK', '#a3141c'),
  });
  const bannerGeometry = new THREE.PlaneGeometry(gateHalf * 2 - 0.6, 2.7);
  const frontBanner = new THREE.Mesh(bannerGeometry, bannerMaterial);
  frontBanner.position.set(gateX - 0.04, 5.6, gateZ);
  frontBanner.rotation.y = -Math.PI / 2;
  frontBanner.name = 'drift-gate-front';
  scene.add(frontBanner);
  const backBanner = new THREE.Mesh(bannerGeometry, bannerMaterial);
  backBanner.position.set(gateX + 0.04, 5.6, gateZ);
  backBanner.rotation.y = Math.PI / 2;
  backBanner.name = 'drift-gate-back';
  scene.add(backBanner);
  meshes += 2;
  count(bannerGeometry);

  // --- Projecteurs aux quatre coins --------------------------------------
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7f2de,
    emissive: 0xfff0cf,
    emissiveIntensity: 1.1,
    roughness: 0.5,
  });
  const mastParts: THREE.BufferGeometry[] = [];
  const lampParts: THREE.BufferGeometry[] = [];
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      const x = DRIFT_PAD.cx + dx * (DRIFT_PAD.halfX + 6);
      const z = DRIFT_PAD.cz + dz * (DRIFT_PAD.halfZ + 6);
      const pole = new THREE.CylinderGeometry(0.22, 0.32, 11.5, 8);
      pole.translate(x, 5.75, z);
      mastParts.push(pole);
      const frame = new THREE.BoxGeometry(2.6, 0.5, 0.7);
      frame.rotateX(-0.35);
      frame.translate(x, 11.2, z);
      mastParts.push(frame);
      for (const offset of [-0.9, 0, 0.9]) {
        const panel = new THREE.BoxGeometry(0.6, 0.28, 0.12);
        panel.rotateX(-0.35);
        panel.translate(x + offset, 11.16, z + 0.42);
        lampParts.push(panel);
      }
      solid(world, body, x, 0.6, z, 0.5, 0.6, 0.5);
    }
  }
  const masts = mergeGeometries(mastParts);
  mastParts.forEach((part) => part.dispose());
  if (masts) {
    const mesh = new THREE.Mesh(masts, steel);
    mesh.name = 'drift-masts';
    scene.add(mesh);
    meshes += 1;
    count(masts);
  }
  const lamps = mergeGeometries(lampParts);
  lampParts.forEach((part) => part.dispose());
  if (lamps) {
    const mesh = new THREE.Mesh(lamps, lampMaterial);
    mesh.name = 'drift-lamps';
    scene.add(mesh);
    meshes += 1;
    count(lamps);
  }

  const concrete = new THREE.MeshStandardMaterial({ color: 0xd6d2c7, roughness: 0.88, metalness: 0.03 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.68 });

  // --- Zone d'assistance, à l'abri d'un auvent ---------------------------
  // Une aire de drift vit aussi par ses pneus et son outillage : l'auvent
  // donne un point d'ancrage au bord de la dalle, hors du tracé du skidpad.
  const serviceX = 74;
  const serviceZ = -452;
  addBox(scene, 13, 0.32, 7.5, serviceX, 3.5, serviceZ, steel);
  addBox(scene, 13, 0.1, 0.35, serviceX, 3.32, serviceZ - 3.7, dark);
  for (const [dx, dz] of [[-6, -3.2], [6, -3.2], [-6, 3.2], [6, 3.2]] as const) {
    addBox(scene, 0.22, 3.5, 0.22, serviceX + dx, 1.75, serviceZ + dz, steel);
    solid(world, body, serviceX + dx, 1.75, serviceZ + dz, 0.16, 1.75, 0.16);
  }
  const serviceSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 0.82),
    new THREE.MeshBasicMaterial({
      map: bannerTexture('ASSISTANCE PNEUS', '#12303f', false),
      side: THREE.DoubleSide,
    }),
  );
  serviceSign.position.set(serviceX, 3.18, serviceZ - 3.72);
  serviceSign.rotation.y = Math.PI;
  scene.add(serviceSign);
  meshes += 1;

  // --- Tour de contrôle, à l'est de la dalle ------------------------------
  const towerX = DRIFT_PAD.cx + DRIFT_PAD.halfX + 14;
  const towerZ = DRIFT_PAD.cz - DRIFT_PAD.halfZ + 10;
  const glass = new THREE.MeshStandardMaterial({
    color: 0x7694ad,
    roughness: 0.08,
    metalness: 0.15,
    transparent: true,
    opacity: 0.45,
  });
  addBox(scene, 6.4, 0.6, 6.4, towerX, 0.3, towerZ, concrete);
  addBox(scene, 2.2, 5.2, 2.2, towerX, 3.2, towerZ, concrete);
  addBox(scene, 5.4, 0.45, 5.4, towerX, 4.1, towerZ, concrete);
  addBox(scene, 4.9, 2.6, 4.9, towerX, 5.6, towerZ, glass);
  for (const [dx, dz] of [[-2.35, -2.35], [2.35, -2.35], [-2.35, 2.35], [2.35, 2.35]] as const) {
    addBox(scene, 0.16, 2.7, 0.16, towerX + dx, 5.6, towerZ + dz, dark);
  }
  addBox(scene, 6.2, 0.4, 6.2, towerX, 7.1, towerZ, dark);
  addBox(scene, 6.5, 0.12, 6.5, towerX, 7.36, towerZ, concrete);
  const controlSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 1.1),
    new THREE.MeshBasicMaterial({
      map: bannerTexture('DRIFT CONTROL', '#111820', false),
      side: THREE.DoubleSide,
    }),
  );
  controlSign.position.set(towerX - 2.5, 6.4, towerZ);
  controlSign.rotation.y = -Math.PI / 2;
  scene.add(controlSign);
  meshes += 1;
  solid(world, body, towerX, 3.7, towerZ, 3.2, 3.7, 3.2);

  // --- Tribune, au sud de la dalle ---------------------------------------
  const standX = DRIFT_PAD.cx;
  const standFront = DRIFT_PAD.cz + DRIFT_PAD.halfZ + 15;
  const standLength = 30;
  const rows = 5;
  const stepDepth = 1.8;
  for (let row = 0; row < rows; row++) {
    const height = 0.55 + row * 0.55;
    addBox(
      scene,
      standLength,
      height,
      stepDepth,
      standX,
      height / 2,
      standFront + (row + 0.5) * stepDepth,
      concrete,
    );
  }
  const seats = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.5, 0.32, 0.52),
    new THREE.MeshStandardMaterial({ roughness: 0.7 }),
    rows * 15,
  );
  let seat = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < 15; column++) {
      matrix.makeTranslation(
        standX - standLength / 2 + 1 + column * 2,
        0.55 + row * 0.55 + 0.16,
        standFront + (row + 1) * stepDepth - 0.55,
      );
      seats.setMatrixAt(seat, matrix);
      seats.setColorAt(seat, colour.set(row % 3 === 0 ? 0xb02026 : 0xd8d6cd));
      seat++;
    }
  }
  seats.receiveShadow = true;
  scene.add(seats);
  meshes += 1;
  // Auvent en porte-à-faux sur l'arrière : un toit plein cachait les gradins
  // depuis la piste et faisait ressembler la tribune à un hangar.
  addBox(scene, standLength + 4, 0.35, 5.2, standX, 5.5, standFront + rows * stepDepth - 1.4, dark);
  for (const side of [-1, 1]) {
    addBox(scene, 0.35, 5.5, 0.35, standX + side * (standLength / 2 + 1.4), 2.75, standFront + rows * stepDepth - 0.5, steel);
  }
  // Bandeau de façade, lisible depuis la piste. Le plan est retourné pour
  // regarder au nord : on retourne aussi ses UV, sinon le texte sort en miroir.
  const standBannerGeometry = new THREE.PlaneGeometry(standLength - 1, 1.3);
  const standUv = standBannerGeometry.attributes.uv as THREE.BufferAttribute;
  for (let index = 0; index < standUv.count; index++) standUv.setX(index, 1 - standUv.getX(index));
  const standBanner = new THREE.Mesh(
    standBannerGeometry,
    new THREE.MeshBasicMaterial({
      map: bannerTexture('SP95  DRIFT  CHALLENGE', '#12303f'),
      side: THREE.DoubleSide,
    }),
  );
  standBanner.position.set(standX, 0.95, standFront - 0.06);
  standBanner.rotation.y = Math.PI;
  scene.add(standBanner);
  meshes += 1;
  solid(world, body, standX, 2.8, standFront + (rows * stepDepth) / 2, standLength / 2 + 2, 2.8, (rows * stepDepth) / 2 + 1.5);

  // --- Panneaux publicitaires, à l'est -----------------------------------
  const boardTexture = boardsTexture(anisotropy);
  const boardGeometry: THREE.BufferGeometry[] = [];
  const boardCount = 6;
  for (let index = 0; index < boardCount; index++) {
    const z = DRIFT_PAD.cz - 42 + index * 14;
    const plane = new THREE.PlaneGeometry(8, 2.4);
    plane.rotateY(-Math.PI / 2);
    plane.translate(DRIFT_PAD.cx + DRIFT_PAD.halfX + 4, 1.9, z);
    const u0 = index / boardCount;
    const uv = plane.attributes.uv as THREE.BufferAttribute;
    for (let vertex = 0; vertex < uv.count; vertex++) {
      uv.setX(vertex, u0 + uv.getX(vertex) / boardCount);
    }
    boardGeometry.push(plane);
    addBox(scene, 0.18, 3.2, 0.18, DRIFT_PAD.cx + DRIFT_PAD.halfX + 4, 1.6, z - 3.6, dark);
    addBox(scene, 0.18, 3.2, 0.18, DRIFT_PAD.cx + DRIFT_PAD.halfX + 4, 1.6, z + 3.6, dark);
  }
  const boards = mergeGeometries(boardGeometry);
  boardGeometry.forEach((geometry) => geometry.dispose());
  if (boards) {
    const mesh = new THREE.Mesh(
      boards,
      new THREE.MeshBasicMaterial({ map: boardTexture }),
    );
    mesh.name = 'drift-boards';
    scene.add(mesh);
    meshes += 1;
    count(boards);
  }

  return { triangles: Math.round(triangles), meshes };
}
