import * as THREE from 'three';

/**
 * Sparks from the tail unit scraping the road on a bavette.
 *
 * A single additive point cloud: the particles are thrown backwards along the
 * road, fall under gravity and fade in under half a second. There is no floor
 * collision, but they are emitted at the contact point and die before they can
 * sink far, which reads as a shower of sparks rather than a firework.
 */

export interface Sparks {
  readonly object: THREE.Points;
  readonly live: number;
  readonly emitted: number;
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, strength: number): void;
  update(dt: number, pixelsPerMeter: number): void;
  clear(): void;
  dispose(): void;
}

function sparkTexture(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,235,170,0.9)');
  gradient.addColorStop(0.7, 'rgba(255,145,40,0.28)');
  gradient.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
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
    gl_PointSize = clamp(aSize * uPixelsPerMeter / depth, 1.0, 96.0);
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
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor * 1.9, alpha);
  }
`;

export function createSparks(capacity: number): Sparks {
  const positions = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const colors = new Float32Array(capacity * 3);
  const velocity = new Float32Array(capacity * 3);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const size = new Float32Array(capacity);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const map = sparkTexture();
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uPixelsPerMeter: { value: 500 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object = new THREE.Points(geometry, material);
  object.name = 'sparks';
  object.frustumCulled = false;
  object.renderOrder = 5;

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
    emit(x, y, z, vx, vy, vz, strength) {
      const i = cursor;
      cursor = (cursor + 1) % capacity;
      const p = i * 3;
      positions[p] = x + (Math.random() - 0.5) * 0.2;
      positions[p + 1] = y + Math.random() * 0.06;
      positions[p + 2] = z + (Math.random() - 0.5) * 0.2;
      // A fan thrown back and to both sides of the plate, not a single jet.
      velocity[p] = vx + (Math.random() - 0.5) * 9;
      velocity[p + 1] = vy + Math.random() * 3.4;
      velocity[p + 2] = vz + (Math.random() - 0.5) * 9;
      const heat = Math.random();
      colors[p] = 1;
      colors[p + 1] = 0.58 + heat * 0.4;
      colors[p + 2] = 0.14 + heat * 0.3;
      age[i] = 0;
      life[i] = 0.34 + Math.random() * 0.5;
      size[i] = (0.055 + Math.random() * 0.085) * (0.8 + strength * 0.7);
      alphas[i] = 0.9;
      emitted++;
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
        velocity[p + 1] -= 13 * dt;
        const damp = Math.exp(-dt * 1.2);
        velocity[p] *= damp;
        velocity[p + 2] *= damp;
        positions[p] += velocity[p] * dt;
        positions[p + 1] += velocity[p + 1] * dt;
        positions[p + 2] += velocity[p + 2] * dt;
        sizes[i] = size[i] * (1 - t * 0.55);
        alphas[i] = 0.95 * Math.pow(1 - t, 1.1);
      }
      live = alive;
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aSize.needsUpdate = true;
      geometry.attributes.aAlpha.needsUpdate = true;
      geometry.attributes.aColor.needsUpdate = true;
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
