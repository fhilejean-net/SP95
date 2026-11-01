import * as THREE from 'three';

/**
 * Poussières fines de la nuit : de petits grains qui flottent autour de la
 * voiture, éclairés par les phares. Rien ne tombe — ce n'est pas de la neige —
 * et le nuage suit la caisse pour rester dense là où le joueur regarde.
 */
export interface AmbientMotes {
  readonly object: THREE.Points;
  update(dt: number, center: THREE.Vector3): void;
}

/** Demi-taille du volume autour de la voiture, en mètres. */
const HALF_X = 34;
const HALF_Y = 11;
const HALF_Z = 34;

function moteSprite(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,244,218,0.8)');
  gradient.addColorStop(1, 'rgba(255,244,218,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createAmbientMotes(count: number): AmbientMotes {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const velocity = new Float32Array(count * 3);
  const phase = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const p = i * 3;
    positions[p] = (Math.random() * 2 - 1) * HALF_X;
    positions[p + 1] = (Math.random() * 2 - 1) * HALF_Y;
    positions[p + 2] = (Math.random() * 2 - 1) * HALF_Z;
    // Presque immobile : un courant d'air latéral et une dérive lente vers le
    // haut. Des vitesses plus franches lisaient comme des flocons.
    velocity[p] = (Math.random() - 0.5) * 0.32;
    velocity[p + 1] = 0.02 + Math.random() * 0.1;
    velocity[p + 2] = (Math.random() - 0.5) * 0.32;
    const warm = 0.62 + Math.random() * 0.38;
    colors[p] = warm;
    colors[p + 1] = warm * (0.88 + Math.random() * 0.1);
    colors[p + 2] = warm * (0.62 + Math.random() * 0.25);
    phase[i] = Math.random() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sprite = moteSprite();
  const material = new THREE.PointsMaterial({
    size: 0.085,
    map: sprite,
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const object = new THREE.Points(geometry, material);
  object.name = 'ambient-motes';
  object.frustumCulled = false;

  let time = 0;

  return {
    object,
    update(dt: number, center: THREE.Vector3): void {
      time += dt;
      const x0 = center.x - HALF_X;
      const x1 = center.x + HALF_X;
      const z0 = center.z - HALF_Z;
      const z1 = center.z + HALF_Z;
      const y0 = center.y - 2;
      const y1 = center.y + HALF_Y * 2;
      for (let i = 0; i < count; i++) {
        const p = i * 3;
        const sway = Math.sin(time * 0.7 + phase[i]) * 0.04;
        positions[p] += (velocity[p] + sway) * dt;
        positions[p + 1] += velocity[p + 1] * dt;
        positions[p + 2] += (velocity[p + 2] + sway * 0.7) * dt;
        // Le nuage se recentre par enroulement : la densité reste constante
        // autour de la voiture sans jamais laisser un vide devant elle.
        if (positions[p] < x0) positions[p] = x1;
        else if (positions[p] > x1) positions[p] = x0;
        if (positions[p + 2] < z0) positions[p + 2] = z1;
        else if (positions[p + 2] > z1) positions[p + 2] = z0;
        if (positions[p + 1] < y0) positions[p + 1] = y1;
        else if (positions[p + 1] > y1) positions[p + 1] = y0;
      }
      geometry.getAttribute('position').needsUpdate = true;
    },
  };
}
