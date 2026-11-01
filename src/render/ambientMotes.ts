import * as THREE from 'three';

/**
 * Neige de la nuit : de fins flocons lâchés devant la caméra, dans un disque
 * étroit autour de l'axe de visée. Ils tombent, dérivent avec le vent et
 * restent immobiles dans le monde : c'est la voiture qui les dépasse, donc ils
 * naissent au centre du champ et filent vers les bords à mesure qu'on avance.
 *
 * Rien de lumineux : une neige réelle ne brille pas. Le sprite est blanc froid,
 * sans mélange additif, et l'opacité reste basse pour ne pas masquer la route.
 */
export interface AmbientMotes {
  readonly object: THREE.Group;
  update(dt: number, camera: THREE.Camera, motion: THREE.Vector3): void;
}

/** Fenêtre de naissance devant la caméra, en mètres. */
const SPAWN_NEAR = 7;
const SPAWN_FAR = 44;
/** Rayon du disque de naissance : les flocons apparaissent au centre. */
const SPAWN_RADIUS = 3.6;
/** Volume au-delà duquel un flocon est recyclé. */
const REAR = -5;
const FAR = 62;
const SIDE = 42;
const BELOW = -12;
const ABOVE = 20;
/** Gravité et vitesse de chute limite : la traînée de l'air en découle. */
const GRAVITY = 9.81;
const FALL_MIN = 0.55;
const FALL_MAX = 1.15;
/** Vent faible, en mètres par seconde. */
const WIND_X = 0.45;
const WIND_Z = -0.3;
/** Taille et opacité : une neige fine, pas un écran blanc. */
const FLAKE_SIZE = 0.065;
const FLAKE_OPACITY = 0.34;

function flakeSprite(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.55, 'rgba(244,249,255,0.55)');
  gradient.addColorStop(1, 'rgba(235,244,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createAmbientMotes(count: number): AmbientMotes {
  const positions = new Float32Array(count * 3);
  const velocity = new Float32Array(count * 3);
  /** Vitesse limite de chaque flocon : tous ne tombent pas à la même allure. */
  const fall = new Float32Array(count);
  const sway = new Float32Array(count);
  const phase = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    fall[i] = FALL_MIN + Math.random() * (FALL_MAX - FALL_MIN);
    sway[i] = 0.25 + Math.random() * 0.5;
    phase[i] = Math.random() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size: FLAKE_SIZE,
    map: flakeSprite(),
    color: 0xeaf2ff,
    transparent: true,
    opacity: FLAKE_OPACITY,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'ambient-mote-points';
  points.frustumCulled = false;

  const object = new THREE.Group();
  object.name = 'ambient-motes';
  object.frustumCulled = false;
  object.add(points);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const lastCamera = new THREE.Vector3();
  let initialized = false;
  let time = 0;

  const spawn = (i: number): void => {
    const p = i * 3;
    const ahead = SPAWN_NEAR + Math.random() * (SPAWN_FAR - SPAWN_NEAR);
    // Disque uniforme autour de l'axe : sqrt évite de tasser les flocons au
    // centre du cercle et donne la répartition d'une chute régulière.
    const angle = Math.random() * Math.PI * 2;
    const radius = SPAWN_RADIUS * Math.sqrt(Math.random());
    const side = Math.cos(angle) * radius;
    const lift = Math.sin(angle) * radius;
    positions[p] = cameraPosition.x + forward.x * ahead + right.x * side + up.x * lift;
    positions[p + 1] = cameraPosition.y + forward.y * ahead + right.y * side + up.y * lift;
    positions[p + 2] = cameraPosition.z + forward.z * ahead + right.z * side + up.z * lift;
    // Un flocon lâché part au repos : la gravité et le vent font le reste.
    velocity[p] = 0;
    velocity[p + 1] = 0;
    velocity[p + 2] = 0;
  };

  return {
    object,
    update(dt: number, camera: THREE.Camera, _motion: THREE.Vector3): void {
      time += dt;
      camera.updateMatrixWorld();
      camera.getWorldDirection(forward);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      cameraPosition.copy(camera.position);

      // Un saut de caméra (téléportation, changement de vue) respawn le champ :
      // sinon les flocons resteraient groupés à l'ancienne position.
      const jumped = initialized && cameraPosition.distanceToSquared(lastCamera) > 400;
      if (!initialized || jumped) {
        for (let i = 0; i < count; i++) spawn(i);
        initialized = true;
      }
      lastCamera.copy(cameraPosition);

      for (let i = 0; i < count; i++) {
        const p = i * 3;
        // Chute dans l'air : traînée linéaire calibrée sur la vitesse limite du
        // flocon, donc chaque grain tombe à son propre rythme.
        const drag = GRAVITY / fall[i];
        velocity[p + 1] += (-GRAVITY - drag * velocity[p + 1]) * dt;
        velocity[p] += drag * (WIND_X - velocity[p]) * dt;
        velocity[p + 2] += drag * (WIND_Z - velocity[p + 2]) * dt;
        positions[p] += velocity[p] * dt;
        positions[p + 1] += velocity[p + 1] * dt;
        positions[p + 2] += velocity[p + 2] * dt;

        // Flottement latéral très faible : deux flocons ne tombent jamais
        // exactement de la même façon.
        const flutter = Math.sin(time * 1.1 + phase[i]) * sway[i] * dt;
        positions[p] += flutter * right.x;
        positions[p + 1] += flutter * right.y;
        positions[p + 2] += flutter * right.z;

        const dx = positions[p] - cameraPosition.x;
        const dy = positions[p + 1] - cameraPosition.y;
        const dz = positions[p + 2] - cameraPosition.z;
        const ahead = dx * forward.x + dy * forward.y + dz * forward.z;
        const sideways = dx * right.x + dy * right.y + dz * right.z;
        const vertical = dx * up.x + dy * up.y + dz * up.z;
        if (
          ahead < REAR ||
          ahead > FAR ||
          Math.abs(sideways) > SIDE ||
          vertical < BELOW ||
          vertical > ABOVE
        ) {
          spawn(i);
        }
      }

      geometry.getAttribute('position').needsUpdate = true;
    },
  };
}
