/**
 * Rendu des panneaux de freinage calculés par `src/world/brakingMarkers.ts` :
 * une planche par valeur (150, 100, 50), toutes les faces d'une valeur dans un
 * seul maillage, et les poteaux en un second. Les deux sens de chevrons sont
 * rangés dans un atlas UV, pour conserver quatre appels de dessin au total.
 *
 * Les panneaux n'ont aucune collision : ils sont dans le dégagement, derrière
 * le vibreur, et une voiture sortie large doit les traverser plutôt que de
 * s'arrêter net sur une planche invisible.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BRAKING_DISTANCES, type BrakingDistance, type BrakingMarker } from '../world/brakingMarkers.ts';

const BOARD_WIDTH = 2.4;
const BOARD_HEIGHT = 0.75;
/** Hauteur du centre de la planche au-dessus du sol, en mètres. */
const BOARD_CENTER_Y = 1.12;
const POST_HEIGHT = 1.5;
const POST_SIDE = 0.11;
/** La planche est posée devant son poteau, pas dans son épaisseur. */
const BOARD_OFFSET = 0.07;

/**
 * Palette : la plus longue annonce est la plus discrète, la plus courte est la
 * plus vive. 50 m en rouge sombre se lit sans jamais crier plus loin.
 */
const STYLE: Record<BrakingDistance, { background: string; ink: string; chevron: string; band: string }> = {
  150: { background: '#e6e3d9', ink: '#15171b', chevron: '#15171b', band: '#2b57a8' },
  100: { background: '#e6e3d9', ink: '#15171b', chevron: '#15171b', band: '#e2a119' },
  50: { background: '#9d1620', ink: '#f5f1e6', chevron: '#9d1620', band: '#f5f1e6' },
};

/** Peint une moitié de l'atlas, sans jamais refléter valeur ni unité. */
export function paintMarker(
  ctx: CanvasRenderingContext2D,
  value: BrakingDistance,
  direction: -1 | 1,
  xOffset: number,
): void {
  const style = STYLE[value];
  ctx.save();
  ctx.translate(xOffset, 0);
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, 512, 160);
  ctx.fillStyle = style.band;
  // Une encoche sépare les chevrons de la valeur, évitant que les UV miroirs
  // ne coupent le panneau à mi-caractère.
  ctx.fillRect(0, 0, 74, 160);
  // Deux chevrons : > annonce un droite, < un gauche. Seuls les chevrons
  // sont réfléchis; le nombre et le « m » gardent toujours leur sens de lecture.
  ctx.save();
  if (direction < 0) {
    ctx.translate(74, 0);
    ctx.scale(-1, 1);
  }
  ctx.strokeStyle = style.chevron;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  for (const offset of [22, 46]) {
    ctx.beginPath();
    ctx.moveTo(offset, 56);
    ctx.lineTo(offset + 16, 80);
    ctx.lineTo(offset, 104);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 154);
  ctx.fillStyle = style.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 96px system-ui, sans-serif';
  ctx.fillText(String(value), 288, 84);
  ctx.font = 'bold 46px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('m', 402, 96);
  ctx.restore();
}

/** Atlas des deux sens : chaque panneau sélectionne sa moitié par ses UV. */
function markerTexture(value: BrakingDistance, anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  paintMarker(ctx, value, -1, 0);
  paintMarker(ctx, value, 1, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Limite les UV d'une planche à la moitié d'atlas du sens annoncé. */
export function setBoardDirectionUv(geometry: THREE.BufferGeometry, direction: -1 | 1): void {
  const uv = geometry.getAttribute('uv');
  const start = direction < 0 ? 0 : 0.5;
  const inset = 3 / 1024;
  for (let i = 0; i < uv.count; i++) {
    // L'atlas a deux pixels de marge à la couture pour empêcher le filtrage
    // bilinéaire d'échantillonner le panneau voisin.
    const localU = THREE.MathUtils.clamp(uv.getX(i), inset, 1 - inset);
    uv.setX(i, start + inset + localU * (0.5 - 2 * inset));
  }
  uv.needsUpdate = true;
}

export interface BrakingBoardBuild {
  meshes: number;
  triangles: number;
}

/** Ajoute les panneaux à la scène et renvoie ce qu'ils coûtent. */
export function buildBrakingBoards(
  scene: THREE.Scene,
  markers: BrakingMarker[],
  anisotropy: number,
): BrakingBoardBuild {
  let meshes = 0;
  let triangles = 0;
  const posts: THREE.BufferGeometry[] = [];

  for (const value of BRAKING_DISTANCES) {
    const placed = markers.filter((marker) => marker.value === value);
    if (placed.length === 0) continue;
    const faces: THREE.BufferGeometry[] = [];
    for (const marker of placed) {
      // La planche naît face à +Z : on la tourne vers la voiture qui arrive,
      // puis on sélectionne l'atlas gauche/droite avant de fusionner les faces.
      const face = new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT);
      setBoardDirectionUv(face, marker.direction);
      face.rotateY(Math.atan2(marker.fx, marker.fz));
      face.translate(
        marker.x + marker.fx * BOARD_OFFSET,
        BOARD_CENTER_Y,
        marker.z + marker.fz * BOARD_OFFSET,
      );
      faces.push(face);

      const post = new THREE.BoxGeometry(POST_SIDE, POST_HEIGHT, POST_SIDE);
      post.translate(marker.x, POST_HEIGHT / 2, marker.z);
      posts.push(post);
    }
    const merged = mergeGeometries(faces);
    faces.forEach((face) => face.dispose());
    if (!merged) continue;
    const material = new THREE.MeshStandardMaterial({
      map: markerTexture(value, anisotropy),
      roughness: 0.62,
      metalness: 0.03,
    });
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    mesh.name = `braking-${value}`;
    scene.add(mesh);
    meshes++;
    triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
  }

  if (posts.length > 0) {
    const merged = mergeGeometries(posts);
    posts.forEach((post) => post.dispose());
    if (merged) {
      const material = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.35 });
      const mesh = new THREE.Mesh(merged, material);
      mesh.receiveShadow = true;
      mesh.name = 'braking-posts';
      scene.add(mesh);
      meshes++;
      triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
    }
  }

  return { meshes, triangles };
}
