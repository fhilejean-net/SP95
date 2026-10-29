/**
 * Bandeau publicitaire du circuit : une palissade **continue** posée sur le
 * muret, de chaque côté de la piste, qui suit la courbe du mur au lieu d'être
 * une suite de plaques plates.
 *
 * L'ancienne version posait des plans de 6,4 m tous les 25 à 35 m. Dans un
 * virage de 23 m de rayon, la corde d'un plan de 6,4 m s'enfonce de 22 cm dans
 * le mur, et côté intérieur la ligne d'offset n'a plus que 5 m de rayon : les
 * panneaux se coupaient, se chevauchaient et clignotaient. Ici chaque panneau
 * est découpé en quatre facettes qui épousent le mur, garde 9 cm de dégagement,
 * et les emplacements où la ligne se replie sont laissés vides.
 *
 * Tout est fusionné par marque : cinq textures, cinq appels de dessin, plus le
 * garde-corps. Aucune collision : la palissade est derrière la limite physique.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sampleAtDistance } from '../world/brakingMarkers.ts';
import { offsetFits } from '../world/circuitDecor.ts';
import { TRACK, WALL_OFFSET, WALL_THICK, type TrackSample } from '../world/trackLayout.ts';
import { pitWallGap } from '../world/pitLayout.ts';

/** Longueur d'un panneau, en mètres. */
export const PANEL_LENGTH = 6.4;
/** Facettes par panneau : quatre suffisent pour épouser un virage de 23 m. */
const PANEL_FACETS = 4;
/** Dégagement entre la face du mur et le panneau, en mètres. */
const CLEARANCE = 0.09;
/** Hauteur du bas et du haut du bandeau au-dessus du sol. */
const BOTTOM = 1.24;
const TOP = 2.36;
/** Garde-corps posé au-dessus du bandeau, et son épaisseur. */
const RAIL_HEIGHT = 2.46;
const RAIL_SIDE = 0.09;
/** Section d'un montant, tous les deux panneaux. */
const POST_SIDE = 0.08;

interface Brand {
  name: string;
  tagline: string;
  background: string;
  ink: string;
  accent: string;
}

/** Les marques du circuit, dans l'ordre où elles défilent le long du mur. */
export const BRANDS: Brand[] = [
  { name: 'VELOCE', tagline: 'SCUDERIA · MODENA', background: '#8f1017', ink: '#f6f2e6', accent: '#e8b422' },
  { name: 'NORTHWIND', tagline: 'AIR SYSTEMS', background: '#e9e7df', ink: '#17202c', accent: '#2b57a8' },
  { name: 'APEX OIL', tagline: 'FULL SYNTHETIC', background: '#14161b', ink: '#f4d34a', accent: '#f4d34a' },
  { name: 'KERB+', tagline: 'RACE ENGINEERING', background: '#10241d', ink: '#eaf3ec', accent: '#1d8f6f' },
  { name: 'ORBITA', tagline: 'TYRES · GRIP 0', background: '#1d2a44', ink: '#f2f4f8', accent: '#c2272d' },
];

/**
 * Panneau de sponsor : fond plein, coin de couleur, marque et accroche. Le
 * dessin est net à 6 m de haut et coûte une canvas de 1024 × 160 par marque.
 */
function sponsorTexture(brand: Brand): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = brand.background;
  ctx.fillRect(0, 0, 1024, 160);
  // Coin oblique, comme une virgule de logo.
  ctx.fillStyle = brand.accent;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(176, 0);
  ctx.lineTo(104, 160);
  ctx.lineTo(0, 160);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 1020, 156);
  ctx.fillStyle = brand.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 80px system-ui, sans-serif';
  ctx.fillText(brand.name, 208, 64);
  ctx.globalAlpha = 0.78;
  ctx.font = '600 32px system-ui, sans-serif';
  ctx.fillText(brand.tagline, 212, 124);
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Quatre facettes qui suivent le mur entre deux distances. */
function panelGeometry(start: number, side: -1 | 1, lateral: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const right = (sample: TrackSample): { x: number; z: number } => ({ x: -sample.tz, z: sample.tx });
  for (let facet = 0; facet <= PANEL_FACETS; facet++) {
    const distance = start + (facet / PANEL_FACETS) * PANEL_LENGTH;
    const sample = sampleAtDistance(distance);
    const normal = right(sample);
    const x = sample.x + normal.x * lateral * side;
    const z = sample.z + normal.z * lateral * side;
    positions.push(x, BOTTOM, z, x, TOP, z);
    const u = facet / PANEL_FACETS;
    uvs.push(u, 1, u, 0);
  }
  // Le panneau regarde la piste : la normale doit aller vers l'axe, donc
  // contre la normale de droite du côté où il est posé.
  const toward = { x: -right(sampleAtDistance(start + PANEL_LENGTH / 2)).x * side, z: -right(sampleAtDistance(start + PANEL_LENGTH / 2)).z * side };
  for (let facet = 0; facet < PANEL_FACETS; facet++) {
    const base = facet * 2;
    const a = base;
    const b = base + 1;
    const c = base + 2;
    const d = base + 3;
    // Produit vectoriel du premier triangle : s'il regarde à l'opposé de la
    // piste, on retourne l'enroulement du quad.
    const bx = positions[c * 3] - positions[a * 3];
    const bz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = -bz;
    const nz = bx;
    if (nx * toward.x + nz * toward.z >= 0) indices.push(a, c, b, c, d, b);
    else indices.push(a, b, c, c, b, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface SponsorFenceBuild {
  meshes: number;
  triangles: number;
}

/**
 * Bâtit la palissade des deux côtés : cinq maillages de panneaux, un garde-corps
 * et ses montants.
 */
export function buildSponsorFence(
  scene: THREE.Scene,
  anisotropy: number,
  metalMat: THREE.Material,
): SponsorFenceBuild {
  let meshes = 0;
  let triangles = 0;
  // Face intérieure du mur, puis le dégagement du panneau.
  const lateral = WALL_OFFSET - WALL_THICK / 2 - CLEARANCE;
  const textures = BRANDS.map((brand) => {
    const texture = sponsorTexture(brand);
    texture.anisotropy = anisotropy;
    return texture;
  });
  const total = TRACK.length;
  const panels = Math.floor(total / PANEL_LENGTH);
  const railParts: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1] as const) {
    const byBrand: THREE.BufferGeometry[][] = BRANDS.map(() => []);
    for (let panel = 0; panel < panels; panel++) {
      const start = panel * PANEL_LENGTH;
      // Un panneau dont une des extrémités tombe dans une ligne repliée est
      // laissé vide : mieux vaut un trou qu'une plaque qui traverse le mur.
      const fits = [0, PANEL_LENGTH / 2, PANEL_LENGTH].every((offset) =>
        offsetFits(sampleAtDistance(start + offset), lateral * side),
      );
      if (!fits) continue;
      // Devant les raccordements des stands, le muret n'existe plus : un
      // panneau y flotterait en travers de l'ouverture.
      if (
        side === 1 &&
        [0, PANEL_LENGTH / 2, PANEL_LENGTH].some((offset) => {
          const point = sampleAtDistance(start + offset);
          return pitWallGap(point.x, point.z, point.z);
        })
      ) {
        continue;
      }
      byBrand[panel % BRANDS.length].push(panelGeometry(start, side, lateral));
    }
    byBrand.forEach((parts, index) => {
      if (parts.length === 0) return;
      const merged = mergeGeometries(parts);
      parts.forEach((part) => part.dispose());
      if (!merged) return;
      const material = new THREE.MeshStandardMaterial({
        map: textures[index],
        roughness: 0.58,
        metalness: 0.04,
      });
      const mesh = new THREE.Mesh(merged, material);
      mesh.receiveShadow = true;
      mesh.name = `sponsor-${BRANDS[index].name.toLowerCase()}-${side}`;
      scene.add(mesh);
      meshes++;
      triangles += merged.index ? merged.index.count / 3 : 0;
    });

    // Garde-corps continu au-dessus du bandeau, et ses montants.
    const step = 3;
    for (let distance = 0; distance < total; distance += step) {
      const a = sampleAtDistance(distance);
      const b = sampleAtDistance(distance + step);
      const normalA = { x: -a.tz, z: a.tx };
      const normalB = { x: -b.tz, z: b.tx };
      const ax = a.x + normalA.x * lateral * side;
      const az = a.z + normalA.z * lateral * side;
      const bx = b.x + normalB.x * lateral * side;
      const bz = b.z + normalB.z * lateral * side;
      const span = Math.hypot(bx - ax, bz - az);
      if (span < 1e-3) continue;
      if (side === 1 && pitWallGap(a.x, a.z, b.z)) continue;
      const rail = new THREE.BoxGeometry(RAIL_SIDE, RAIL_SIDE, span + 0.02);
      rail.rotateY(Math.atan2(bx - ax, bz - az));
      rail.translate((ax + bx) / 2, RAIL_HEIGHT, (az + bz) / 2);
      railParts.push(rail);
      if (Math.round(distance / step) % 2 === 0) {
        const post = new THREE.BoxGeometry(POST_SIDE, RAIL_HEIGHT - BOTTOM, POST_SIDE);
        post.translate(ax, (RAIL_HEIGHT + BOTTOM) / 2, az);
        railParts.push(post);
      }
    }
  }

  if (railParts.length > 0) {
    const merged = mergeGeometries(railParts);
    railParts.forEach((part) => part.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, metalMat);
      mesh.receiveShadow = true;
      mesh.name = 'sponsor-rails';
      scene.add(mesh);
      meshes++;
      triangles += merged.index ? merged.index.count / 3 : 0;
    }
  }

  return { meshes, triangles };
}
