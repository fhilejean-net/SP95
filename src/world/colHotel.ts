import * as THREE from 'three';

/**
 * Les bâtiments de la place du col : le vieil hôtel et ses annexes.
 *
 * Le modèle générique de la ville — une façade à grille de fenêtres éclairées —
 * donnait une tour au bord de la route. Ici chaque bâtiment est bâti sur son
 * emprise OSM : murs montés à l'aplomb du relevé, toit à deux pans posé sur
 * l'axe le plus long, ouvertures réparties sur les façades. L'hôtel garde sa
 * silhouette de trois étages sous ardoise, avec lucarnes, balcon, cheminées et
 * volets ; les annexes reprennent les tôles et le crépi des photos.
 */

type Vec3 = [number, number, number];

/** Axes de l'emprise : axe long (u), normale (v), et demi-dimensions. */
interface Axes {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  halfLength: number;
  halfWidth: number;
}

/** Quads posés dans un même tampon : un seul maillage par matière. */
class Facets {
  private positions: number[] = [];
  private indices: number[] = [];

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    const base = this.positions.length / 3;
    this.positions.push(...a, ...b, ...c, ...d);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  triangle(a: Vec3, b: Vec3, c: Vec3): void {
    const base = this.positions.length / 3;
    this.positions.push(...a, ...b, ...c);
    this.indices.push(base, base + 1, base + 2);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** Emprise OSM ramenée à un rectangle orienté sur son plus long côté. */
function footprintAxes(points: number[][]): Axes {
  let longest = 1;
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (length > best) {
      best = length;
      longest = i;
    }
  }
  const [ax, az] = points[longest - 1];
  const [bx, bz] = points[longest];
  const length = Math.hypot(bx - ax, bz - az) || 1;
  const ux = (bx - ax) / length;
  const uz = (bz - az) / length;
  const vx = -uz;
  const vz = ux;
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cz = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  let minAlong = Infinity, maxAlong = -Infinity, minAcross = Infinity, maxAcross = -Infinity;
  for (const [x, z] of points) {
    const dx = x - cx;
    const dz = z - cz;
    const along = dx * ux + dz * uz;
    const across = dx * vx + dz * vz;
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, across);
    maxAcross = Math.max(maxAcross, across);
  }
  const midAlong = (minAlong + maxAlong) / 2;
  const midAcross = (minAcross + maxAcross) / 2;
  return {
    cx: cx + ux * midAlong + vx * midAcross,
    cz: cz + uz * midAlong + vz * midAcross,
    ux,
    uz,
    vx,
    vz,
    halfLength: (maxAlong - minAlong) / 2,
    halfWidth: (maxAcross - minAcross) / 2,
  };
}

/** Point des axes, en coordonnées monde. */
function at(axes: Axes, along: number, across: number, y: number): Vec3 {
  return [
    axes.cx + axes.ux * along + axes.vx * across,
    y,
    axes.cz + axes.uz * along + axes.vz * across,
  ];
}

/** Murs montés sur l'emprise OSM, du sol à l'égout du toit. */
function wallGeometry(points: number[][], base: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, z], index) => (index === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  // Le plan de forme est (x,-z) et la profondeur sort en +y.
  geometry.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1));
  geometry.translate(0, base, 0);
  return geometry;
}

/** Toit à deux pans : faîtage sur l'axe long, débord sur les quatre côtés. */
function gableRoof(axes: Axes, eave: number, rise: number, overhang: number): Facets {
  const facets = new Facets();
  const ridge = eave + rise;
  const length = axes.halfLength + overhang;
  const width = axes.halfWidth + overhang;
  // Versant côté +v.
  facets.quad(
    at(axes, length, width, eave),
    at(axes, -length, width, eave),
    at(axes, -length, 0, ridge),
    at(axes, length, 0, ridge),
  );
  // Versant côté -v.
  facets.quad(
    at(axes, -length, -width, eave),
    at(axes, length, -width, eave),
    at(axes, length, 0, ridge),
    at(axes, -length, 0, ridge),
  );
  return facets;
}

/**
 * Toit à pans posé sur l'emprise réelle : chaque rive monte vers un faîtage
 * qui est le polygone resserré vers son centre. L'emprise de l'hôtel est
 * irrégulière ; un toit à deux pans sur sa boîte englobante débordait de sept
 * mètres dans le vide au-dessus du ravin.
 */
function hipRoof(points: number[][], eave: number, rise: number, overhang: number): Facets {
  const facets = new Facets();
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cz = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const outer: [number, number][] = [];
  const ridge: [number, number][] = [];
  for (const [x, z] of points) {
    const dx = x - cx;
    const dz = z - cz;
    const distance = Math.hypot(dx, dz) || 1;
    outer.push([x + (dx / distance) * overhang, z + (dz / distance) * overhang]);
    ridge.push([cx + dx * 0.6, cz + dz * 0.6]);
  }
  const top = eave + rise;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    facets.quad(
      [outer[i][0], eave, outer[i][1]],
      [outer[j][0], eave, outer[j][1]],
      [ridge[j][0], top, ridge[j][1]],
      [ridge[i][0], top, ridge[i][1]],
    );
    // Le faîtage se ferme en éventail depuis son centre.
    facets.triangle(
      [cx, top, cz],
      [ridge[i][0], top, ridge[i][1]],
      [ridge[j][0], top, ridge[j][1]],
    );
  }
  return facets;
}

/** Pignons : les deux triangles verticaux que le toit laisse ouverts. */
function gableEnds(axes: Axes, eave: number, rise: number): Facets {
  const facets = new Facets();
  const ridge = eave + rise;
  const length = axes.halfLength - 0.05;
  const width = axes.halfWidth;
  facets.triangle(
    at(axes, length, -width, eave),
    at(axes, length, width, eave),
    at(axes, length, 0, ridge),
  );
  facets.triangle(
    at(axes, -length, width, eave),
    at(axes, -length, -width, eave),
    at(axes, -length, 0, ridge),
  );
  return facets;
}

/** Fenêtre : encadrement clair, vitre sombre, deux volets. */
function addWindow(
  glass: Facets,
  frame: Facets,
  shutters: Facets,
  x: number,
  z: number,
  alongX: number,
  alongZ: number,
  outX: number,
  outZ: number,
  y: number,
  width = 0.95,
  height = 1.3,
): void {
  const corner = (side: number, across: number, up: number): Vec3 => [
    x + alongX * side + outX * across,
    y + up,
    z + alongZ * side + outZ * across,
  ];
  const half = width / 2;
  const top = height / 2;
  // Cadre : un rectangle clair un peu plus grand, derrière la vitre.
  frame.quad(corner(-half - 0.1, 0.025, -top - 0.1), corner(half + 0.1, 0.025, -top - 0.1),
    corner(half + 0.1, 0.025, top + 0.1), corner(-half - 0.1, 0.025, top + 0.1));
  glass.quad(corner(-half, 0.04, -top), corner(half, 0.04, -top),
    corner(half, 0.04, top), corner(-half, 0.04, top));
  // Volets pleins, rabattus contre le mur de chaque côté de l'ouverture.
  const shutter = 0.44;
  const outer = half + 0.2;
  for (const side of [-1, 1]) {
    shutters.quad(
      corner(side * outer, 0.05, -top), corner(side * (outer + shutter), 0.05, -top),
      corner(side * (outer + shutter), 0.05, top), corner(side * outer, 0.05, top),
    );
  }
}

/** Petit toit à deux pans d'une lucarne, faîtage perpendiculaire à la façade. */
function dormerRoof(width: number, depth: number, rise: number): THREE.BufferGeometry {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const positions = [
    -halfWidth, 0, halfDepth, halfWidth, 0, halfDepth, halfWidth, 0, -halfDepth, -halfWidth, 0, -halfDepth,
    0, rise, halfDepth, 0, rise, -halfDepth,
  ];
  const indices = [
    0, 1, 4,
    3, 5, 2,
    0, 4, 5, 0, 5, 3,
    1, 2, 5, 1, 5, 4,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface HotelRoad {
  (x: number, z: number): { distance: number; width: number } | null;
}

/** Le vieil hôtel : trois étages de crépi, ardoise, lucarnes et balcon. */
export function buildColHotel(
  points: number[][],
  base: number,
  height: number,
  roadAt: HotelRoad,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'mollendruz-hotel';
  const axes = footprintAxes(points);
  const plaster = new THREE.MeshStandardMaterial({ color: 0xd9cdb6, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xeadfca, roughness: 0.9, side: THREE.DoubleSide });
  const slate = new THREE.MeshStandardMaterial({ color: 0x3e4246, roughness: 0.9, side: THREE.DoubleSide });
  const stone = new THREE.MeshStandardMaterial({ color: 0x8c8578, roughness: 1 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1d2428, roughness: 0.35, metalness: 0.15, side: THREE.DoubleSide });
  const shutter = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.95, side: THREE.DoubleSide });

  const body = new THREE.Mesh(wallGeometry(points, base, height), plaster);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Soubassement de pierre : le bâtiment est posé au plus bas de son emprise,
  // côté ravin, et ce socle absorbe la pente sous la façade.
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(axes.halfWidth * 2 + 0.1, 0.9, axes.halfLength * 2 + 0.1), stone);
  plinth.position.set(axes.cx, base + 0.25, axes.cz);
  plinth.rotation.y = Math.atan2(axes.ux, axes.uz);
  plinth.receiveShadow = true;
  group.add(plinth);

  const eave = base + height;
  // Pente d'ardoise : 3,6 m de faîtage au-dessus de l'égout, soit environ 45°
  // sur la largeur médiane de l'emprise.
  const rise = Math.max(2.6, Math.min(4.2, height * 0.38));
  const roof = new THREE.Mesh(hipRoof(points, eave, rise, 0.62).build(), slate);
  roof.castShadow = true;
  group.add(roof);

  // Ouvertures sur chaque façade, une rangée par étage.
  const frames = new Facets();
  const glasses = new Facets();
  const shutters = new Facets();
  const rows = height > 7.5 ? [0.22, 0.48, 0.74] : [0.28, 0.65];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 3.4) continue;
    const ux = dx / length;
    const uz = dz / length;
    // Normale tournée vers l'extérieur de l'emprise.
    let nx = uz;
    let nz = -ux;
    if (nx * ((ax + bx) / 2 - axes.cx) + nz * ((az + bz) / 2 - axes.cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const columns = Math.max(1, Math.floor((length - 1.6) / 3.1));
    for (const fraction of rows) {
      const y = base + height * fraction;
      for (let column = 0; column < columns; column++) {
        const along = 1.2 + (length - 2.4) * (columns === 1 ? 0.5 : column / (columns - 1));
        addWindow(glasses, frames, shutters, ax + ux * along, az + uz * along, ux, uz, nx, nz, y,
          Math.min(1.05, length / (columns + 1.4)), 1.32);
      }
    }
  }
  for (const [facets, material] of [
    [frames, trim],
    [glasses, glass],
    [shutters, shutter],
  ] as const) {
    if (facets.empty) continue;
    const mesh = new THREE.Mesh(facets.build(), material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Façade de la route : lucarnes dans le versant, balcon au premier étage.
  let roadEdge = 1;
  let nearest = Infinity;
  for (let i = 1; i < points.length; i++) {
    const hit = roadAt((points[i - 1][0] + points[i][0]) / 2, (points[i - 1][1] + points[i][1]) / 2);
    if (hit && hit.distance < nearest) {
      nearest = hit.distance;
      roadEdge = i;
    }
  }
  const [rax, raz] = points[roadEdge - 1];
  const [rbx, rbz] = points[roadEdge];
  const roadLength = Math.hypot(rbx - rax, rbz - raz);
  const rux = (rbx - rax) / roadLength;
  const ruz = (rbz - raz) / roadLength;
  let rnx = ruz;
  let rnz = -rux;
  if (rnx * ((rax + rbx) / 2 - axes.cx) + rnz * ((raz + rbz) / 2 - axes.cz) < 0) {
    rnx = -rnx;
    rnz = -rnz;
  }
  const yaw = Math.atan2(-ruz, rux);
  for (const fraction of [0.24, 0.5, 0.76]) {
    const along = roadLength * fraction;
    const dormer = new THREE.Group();
    const width = Math.min(1.25, roadLength / 5);
    const bodyDormer = new THREE.Mesh(new THREE.BoxGeometry(width, 1.15, 1.05), plaster);
    bodyDormer.position.set(0, 0.57, 0.1);
    bodyDormer.castShadow = true;
    dormer.add(bodyDormer);
    const cap = new THREE.Mesh(dormerRoof(width + 0.26, 1.3, 0.5), slate);
    cap.position.set(0, 1.15, 0.1);
    cap.castShadow = true;
    dormer.add(cap);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.32, 0.72), glass);
    pane.position.set(0, 0.68, 0.63);
    dormer.add(pane);
    dormer.position.set(
      rax + rux * along + rnx * 0.35,
      eave + rise * 0.18,
      raz + ruz * along + rnz * 0.35,
    );
    dormer.rotation.y = yaw;
    group.add(dormer);
  }

  // Porte cochère sous le balcon : l'entrée que les photos montrent sur la
  // façade de la route.
  const doorGlass = new Facets();
  doorGlass.quad(
    [rax + rux * (roadLength / 2 - 0.7) + rnx * 0.03, base + 2.35, raz + ruz * (roadLength / 2 - 0.7) + rnz * 0.03],
    [rax + rux * (roadLength / 2 + 0.7) + rnx * 0.03, base + 2.35, raz + ruz * (roadLength / 2 + 0.7) + rnz * 0.03],
    [rax + rux * (roadLength / 2 + 0.7) + rnx * 0.03, base + 0.05, raz + ruz * (roadLength / 2 + 0.7) + rnz * 0.03],
    [rax + rux * (roadLength / 2 - 0.7) + rnx * 0.03, base + 0.05, raz + ruz * (roadLength / 2 - 0.7) + rnz * 0.03],
  );
  const door = new THREE.Mesh(doorGlass.build(), new THREE.MeshStandardMaterial({
    color: 0x4a3527, roughness: 0.9, side: THREE.DoubleSide,
  }));
  door.name = 'mollendruz-hotel-door';
  group.add(door);

  const balconyLength = roadLength * 0.42;
  const balcony = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(balconyLength, 0.12, 0.95), stone);
  slab.position.y = 0.06;
  slab.castShadow = true;
  balcony.add(slab);
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x39403f, roughness: 0.55, metalness: 0.5 });
  for (const height of [0.55, 1.0]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(balconyLength, 0.05, 0.05), railMaterial);
    bar.position.set(0, height, 0.42);
    balcony.add(bar);
  }
  for (let x = -balconyLength / 2; x <= balconyLength / 2 + 0.01; x += 0.26) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.0, 0.035), railMaterial);
    post.position.set(x, 0.5, 0.42);
    balcony.add(post);
  }
  balcony.position.set(
    rax + rux * (roadLength / 2) + rnx * 0.5,
    base + height * 0.42,
    raz + ruz * (roadLength / 2) + rnz * 0.5,
  );
  balcony.rotation.y = yaw;
  group.add(balcony);

  // Cheminées sur le faîtage.
  for (const along of [-axes.halfLength * 0.45, axes.halfLength * 0.2]) {
    const [x, , z] = at(axes, along, 0, 0);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.62, rise * 0.75, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x8a8175, roughness: 1 }));
    chimney.position.set(x, eave + rise * 0.62, z);
    chimney.castShadow = true;
    group.add(chimney);
  }

  return group;
}

export type AnnexKind = 'shed' | 'hangar' | 'annex';

const ANNEX_STYLE: Record<AnnexKind, { walls: number; roof: number }> = {
  // Appentis galvanisé, toit de tôle rouge.
  shed: { walls: 0x8b9195, roof: 0x7c3f36 },
  // Grand hangar rouillé, tôle ondulée.
  hangar: { walls: 0x9a8d7e, roof: 0x67594d },
  // Petit bâtiment de ferme crépi, ardoise.
  annex: { walls: 0xd0c5b2, roof: 0x4b4d50 },
};

/** Annexe : murs sur l'emprise OSM et toit à deux pans. */
export function buildColAnnex(
  points: number[][],
  base: number,
  height: number,
  kind: AnnexKind,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `mollendruz-annex-${kind}`;
  const style = ANNEX_STYLE[kind];
  const walls = new THREE.Mesh(
    wallGeometry(points, base, height),
    new THREE.MeshStandardMaterial({ color: style.walls, roughness: 0.92 }),
  );
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);
  const axes = footprintAxes(points);
  const rise = Math.max(0.7, Math.min(2.1, axes.halfWidth * 0.7));
  const roofMaterial = new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.85, side: THREE.DoubleSide });
  const roof = new THREE.Mesh(gableRoof(axes, base + height, rise, 0.35).build(), roofMaterial);
  roof.castShadow = true;
  group.add(roof);
  const gables = new THREE.Mesh(gableEnds(axes, base + height, rise).build(), walls.material);
  gables.castShadow = true;
  group.add(gables);
  return group;
}
