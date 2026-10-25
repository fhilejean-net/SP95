import * as THREE from 'three';

/**
 * Tire smoke and dust.
 *
 * A pool of billboarded points drawn in a single call: one puff texture made on
 * a canvas, per-particle size, alpha and tint, updated on the CPU. Emission is
 * driven by the tire slip in the physics telemetry, so smoke appears exactly
 * when a wheel spins up or slides, and not when the car is merely moving.
 */

export interface TireSmoke {
  readonly object: THREE.Points;
  /** Particles alive right now. */
  readonly live: number;
  /** Particles emitted since the page loaded. */
  readonly emitted: number;
  /**
   * @param intensity 0..1, scales size and opacity.
   */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    intensity: number,
    tint: THREE.Color,
  ): void;
  /** @param pixelsPerMeter pixels of viewport per metre at one metre away. */
  update(dt: number, pixelsPerMeter: number): void;
  clear(): void;
  dispose(): void;
}

function puffTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Soft core with a ragged edge: a clean radial gradient reads as a ball of
  // light, the noise breaks it into a puff of air.
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.78, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const pixels = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const x = (i / 4) % size;
    const y = Math.floor(i / 4 / size);
    const dx = x - size / 2;
    const dy = y - size / 2;
    const r = Math.hypot(dx, dy) / (size / 2);
    if (r >= 1) continue;
    // Two waves of noise, stronger towards the rim where the gradient is thin.
    const noise =
      0.72 +
      0.28 * Math.sin(x * 0.55 + y * 0.31) * Math.cos(y * 0.47 - x * 0.23) +
      0.16 * Math.sin(x * 1.7 + y * 1.3);
    const edge = Math.min(1, r * 1.15 + 0.15);
    pixels.data[i + 3] = Math.max(0, Math.min(255, pixels.data[i + 3] * noise * edge));
  }
  ctx.putImageData(pixels, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPixelsPerMeter;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * view;
    float depth = max(0.5, -view.z);
    gl_PointSize = clamp(aSize * uPixelsPerMeter / depth, 1.0, 900.0);
    vAlpha = aAlpha;
    vColor = aColor;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float mask = texture2D(uMap, gl_PointCoord).a;
    float alpha = mask * vAlpha;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <colorspace_fragment>
  }
`;

export function createTireSmoke(capacity: number): TireSmoke {
  const positions = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const colors = new Float32Array(capacity * 3);

  const velocity = new Float32Array(capacity * 3);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const startSize = new Float32Array(capacity);
  const endSize = new Float32Array(capacity);
  const strength = new Float32Array(capacity);
  const drag = new Float32Array(capacity);
  const rise = new Float32Array(capacity);

  for (let i = 0; i < capacity; i++) alphas[i] = 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setDrawRange(0, capacity);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const map = puffTexture();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uPixelsPerMeter: { value: 500 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  const object = new THREE.Points(geometry, material);
  object.name = 'tire-smoke';
  object.frustumCulled = false;
  object.renderOrder = 4;

  let cursor = 0;
  let live = 0;
  let emitted = 0;

  return {
    object,
    get live() {
      return live;
    },
    get emitted() {
      return emitted;
    },
    emit(x, y, z, vx, vy, vz, intensity, tint) {
      const i = cursor;
      cursor = (cursor + 1) % capacity;
      const p = i * 3;
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = z;
      velocity[p] = vx;
      velocity[p + 1] = vy;
      velocity[p + 2] = vz;
      colors[p] = tint.r;
      colors[p + 1] = tint.g;
      colors[p + 2] = tint.b;
      age[i] = 0;
      life[i] = 0.8 + Math.random() * 0.9;
      const weight = 0.6 + intensity * 0.4;
      startSize[i] = (0.34 + Math.random() * 0.3) * weight;
      endSize[i] = (1.5 + Math.random() * 1.4) * weight;
      strength[i] = 0.14 + intensity * 0.26;
      drag[i] = 2.2 + Math.random() * 1.2;
      rise[i] = 0.35 + Math.random() * 0.5;
      alphas[i] = 0;
      sizes[i] = startSize[i];
      emitted++;
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aColor.needsUpdate = true;
    },
    update(dt, pixelsPerMeter) {
      material.uniforms.uPixelsPerMeter.value = pixelsPerMeter;
      let alive = 0;
      for (let i = 0; i < capacity; i++) {
        if (life[i] <= 0) continue;
        age[i] += dt;
        const t = age[i] / life[i];
        if (t >= 1) {
          life[i] = 0;
          alphas[i] = 0;
          continue;
        }
        alive++;
        const p = i * 3;
        const damp = Math.exp(-drag[i] * dt);
        velocity[p] *= damp;
        velocity[p + 2] *= damp;
        velocity[p + 1] = velocity[p + 1] * damp + rise[i] * dt;
        positions[p] += velocity[p] * dt;
        positions[p + 1] += velocity[p + 1] * dt;
        positions[p + 2] += velocity[p + 2] * dt;
        sizes[i] = startSize[i] + (endSize[i] - startSize[i]) * Math.sqrt(t);
        // Fade in over the first frames, then out on a curve: smoke thins as it
        // expands instead of switching off.
        const fadeIn = Math.min(1, t / 0.09);
        const fadeOut = Math.pow(1 - t, 1.5);
        alphas[i] = strength[i] * fadeIn * fadeOut;
      }
      live = alive;
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aSize.needsUpdate = true;
      geometry.attributes.aAlpha.needsUpdate = true;
    },
    clear() {
      for (let i = 0; i < capacity; i++) {
        life[i] = 0;
        age[i] = 0;
        alphas[i] = 0;
      }
      live = 0;
      geometry.attributes.aAlpha.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
