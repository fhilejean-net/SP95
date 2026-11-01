import * as THREE from 'three';

/**
 * Poussières fines de la nuit. Elles vivent dans le monde, devant la caméra,
 * et ne suivent pas la voiture : quand on roule, elles défilent donc vers
 * l'objectif au lieu de rester collées à la caisse. À vitesse élevée, chaque
 * grain s'étire en une courte traînée, ce qui donne le repère de vitesse que
 * des points immobiles ne peuvent pas donner.
 *
 * Rien ne tombe : la dérive est latérale et lente, et la couleur reste chaude.
 */
export interface AmbientMotes {
  readonly object: THREE.Group;
  update(dt: number, camera: THREE.Camera, motion: THREE.Vector3): void;
}

/** Volume de spawn devant la caméra, en mètres. */
const AHEAD_MIN = 6;
const AHEAD_MAX = 78;
const SIDE = 24;
const UP_MIN = -10;
const UP_MAX = 22;
/** Distance derrière laquelle un grain est recyclé devant la caméra. */
const BEHIND = -11;
/** Distance maximale devant : au-delà, il est hors du brouillard. */
const FAR = 112;
/** Marge latérale et verticale avant recyclage. */
const SIDE_MARGIN = 9;
const UP_MARGIN = 8;

function moteSprite(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,244,218,0.85)');
  gradient.addColorStop(1, 'rgba(255,244,218,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createAmbientMotes(count: number): AmbientMotes {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const drift = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const streaks = new Float32Array(count * 6);

  for (let i = 0; i < count; i++) {
    const p = i * 3;
    drift[p] = (Math.random() - 0.5) * 0.22;
    drift[p + 1] = 0.015 + Math.random() * 0.08;
    drift[p + 2] = (Math.random() - 0.5) * 0.22;
    const warm = 0.64 + Math.random() * 0.36;
    colors[p] = warm;
    colors[p + 1] = warm * (0.9 + Math.random() * 0.08);
    colors[p + 2] = warm * (0.68 + Math.random() * 0.2);
    phase[i] = Math.random() * Math.PI * 2;
  }

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pointGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sprite = moteSprite();
  const pointMaterial = new THREE.PointsMaterial({
    size: 0.075,
    map: sprite,
    vertexColors: true,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.name = 'ambient-mote-points';
  points.frustumCulled = false;

  const streakGeometry = new THREE.BufferGeometry();
  streakGeometry.setAttribute('position', new THREE.BufferAttribute(streaks, 3));
  const streakMaterial = new THREE.LineBasicMaterial({
    color: 0xffddaa,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(streakGeometry, streakMaterial);
  lines.name = 'ambient-mote-streaks';
  lines.frustumCulled = false;

  const object = new THREE.Group();
  object.name = 'ambient-motes';
  object.frustumCulled = false;
  object.add(points, lines);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const lastCamera = new THREE.Vector3();
  let initialized = false;
  let time = 0;

  const spawn = (i: number): void => {
    const p = i * 3;
    const ahead = AHEAD_MIN + Math.random() * (AHEAD_MAX - AHEAD_MIN);
    const side = (Math.random() * 2 - 1) * SIDE;
    const lift = UP_MIN + Math.random() * (UP_MAX - UP_MIN);
    positions[p] = cameraPosition.x + forward.x * ahead + right.x * side + up.x * lift;
    positions[p + 1] = cameraPosition.y + forward.y * ahead + right.y * side + up.y * lift;
    positions[p + 2] = cameraPosition.z + forward.z * ahead + right.z * side + up.z * lift;
  };

  return {
    object,
    update(dt: number, camera: THREE.Camera, motion: THREE.Vector3): void {
      time += dt;
      camera.updateMatrixWorld();
      camera.getWorldDirection(forward);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      cameraPosition.copy(camera.position);

      // Un saut de caméra (téléportation, changement de vue) doit respawn le
      // champ : sinon les grains resteraient groupés à l'ancienne position.
      const jumped = initialized && cameraPosition.distanceToSquared(lastCamera) > 400;
      if (!initialized || jumped) {
        for (let i = 0; i < count; i++) spawn(i);
        initialized = true;
      }
      lastCamera.copy(cameraPosition);

      const speed = Math.hypot(motion.x, motion.z);
      // La traînée est l'image du déplacement relatif pendant ~50 ms. On la
      // borne pour qu'un grain tout proche ne traverse pas tout l'écran.
      const exposure = Math.min(0.075, 0.018 + speed * 0.0016);
      const streakX = -motion.x * exposure;
      const streakZ = -motion.z * exposure;
      const streakLength = Math.hypot(streakX, streakZ);
      const visibleStreak = streakLength > 0.08;

      for (let i = 0; i < count; i++) {
        const p = i * 3;
        positions[p] += drift[p] * dt;
        positions[p + 1] += drift[p + 1] * dt;
        positions[p + 2] += drift[p + 2] * dt;

        // Le grain reste dans le monde ; c'est la caméra qui le dépasse. On ne
        // le recentre donc pas à chaque image, sinon il redevient un nuage
        // solidaire de la voiture.
        const dx = positions[p] - cameraPosition.x;
        const dy = positions[p + 1] - cameraPosition.y;
        const dz = positions[p + 2] - cameraPosition.z;
        const ahead = dx * forward.x + dy * forward.y + dz * forward.z;
        const sideways = dx * right.x + dy * right.y + dz * right.z;
        const vertical = dx * up.x + dy * up.y + dz * up.z;
        if (
          ahead < BEHIND ||
          ahead > FAR ||
          Math.abs(sideways) > SIDE + SIDE_MARGIN ||
          vertical < UP_MIN - UP_MARGIN ||
          vertical > UP_MAX + UP_MARGIN
        ) {
          spawn(i);
        }

        // Micro-dérive pour que le champ ne soit pas une grille figée.
        const sway = Math.sin(time * 0.55 + phase[i]) * 0.012;
        positions[p] += sway * dt;
        positions[p + 2] += sway * 0.6 * dt;

        const q = i * 6;
        streaks[q] = positions[p];
        streaks[q + 1] = positions[p + 1];
        streaks[q + 2] = positions[p + 2];
        streaks[q + 3] = positions[p] + (visibleStreak ? streakX : 0);
        streaks[q + 4] = positions[p + 1];
        streaks[q + 5] = positions[p + 2] + (visibleStreak ? streakZ : 0);
      }

      pointGeometry.getAttribute('position').needsUpdate = true;
      streakGeometry.getAttribute('position').needsUpdate = true;
      // Les traînées n'apparaissent qu'à partir d'une vitesse notable : à
      // l'arrêt, on doit voir de fines poussières, pas des rayures.
      streakMaterial.opacity = Math.min(0.3, Math.max(0, (speed - 3) * 0.012));
      pointMaterial.opacity = speed > 2 ? 0.36 : 0.46;
    },
  };
}
