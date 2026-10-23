import * as THREE from 'three';

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createAsphaltTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  const rand = seededRandom(7);
  ctx.fillStyle = '#33343a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const g = 38 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.35 + rand() * 0.4})`;
    const x = rand() * 256;
    const y = rand() * 256;
    const s = 0.6 + rand() * 1.8;
    ctx.fillRect(x, y, s, s);
  }
  // Faint repair patches.
  ctx.strokeStyle = 'rgba(20,20,24,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    const x = rand() * 256;
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 30, 80, x - 30, 170, x + 10, 256);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createGrassTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  const rand = seededRandom(19);
  ctx.fillStyle = '#6b7a4d';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 12000; i++) {
    const r = 74 + rand() * 40;
    const g = 88 + rand() * 42;
    const b = 52 + rand() * 30;
    ctx.fillStyle = `rgba(${r},${g},${b},${0.25 + rand() * 0.5})`;
    const x = rand() * 256;
    const y = rand() * 256;
    ctx.fillRect(x, y, 1 + rand() * 3, 1 + rand() * 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createConcreteTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 128);
  const rand = seededRandom(31);
  ctx.fillStyle = '#8b8a86';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2000; i++) {
    const g = 110 + rand() * 50;
    ctx.fillStyle = `rgba(${g},${g},${g - 6},${0.2 + rand() * 0.3})`;
    ctx.fillRect(rand() * 128, rand() * 128, 1 + rand() * 2, 1 + rand() * 2);
  }
  ctx.strokeStyle = 'rgba(60,60,60,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface FacadeTexture {
  map: THREE.CanvasTexture;
  repeatX: number;
  repeatY: number;
}

/** Window-grid facade. `floors` rows of windows, warm stone or brick wall. */
export function createFacadeTexture(wall: string, floors: number, cols: number): FacadeTexture {
  const W = 256;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const rand = seededRandom(wall.charCodeAt(1) * 97 + floors * 13);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);

  const cellW = W / cols;
  const cellH = H / floors;
  const winW = cellW * 0.46;
  const winH = cellH * 0.52;

  for (let row = 0; row < floors; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cellW + (cellW - winW) / 2;
      const y = row * cellH + cellH * 0.2;
      // Frame.
      ctx.fillStyle = 'rgba(40,40,44,0.55)';
      ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
      const shade = 30 + rand() * 40;
      ctx.fillStyle = `rgb(${shade + 8},${shade + 16},${shade + 26})`;
      ctx.fillRect(x, y, winW, winH);
      // A few lit / reflective panes.
      if (rand() > 0.72) {
        ctx.fillStyle = 'rgba(210,225,240,0.35)';
        ctx.fillRect(x + 2, y + 2, winW * 0.45, winH - 4);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x, y + winH * 0.5, winW, 1);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, row * cellH, W, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return { map: tex, repeatX: 1, repeatY: 1 };
}

export interface EnvironmentMaterials {
  asphalt: THREE.MeshStandardMaterial;
  asphaltPad: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  lines: THREE.MeshStandardMaterial;
  terrain: THREE.MeshStandardMaterial;
  buildingLow: THREE.MeshStandardMaterial;
  buildingMid: THREE.MeshStandardMaterial;
  buildingTall: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  barrier: THREE.MeshStandardMaterial;
  cone: THREE.MeshStandardMaterial;
  gate: THREE.MeshStandardMaterial;
  checker: THREE.MeshBasicMaterial;
  glass: THREE.MeshPhysicalMaterial;
}

export function createEnvironmentMaterials(): EnvironmentMaterials {
  const asphalt = createAsphaltTexture();
  asphalt.repeat.set(1, 1);
  const grass = createGrassTexture();
  grass.repeat.set(140, 140);
  const concreteTex = createConcreteTexture();
  concreteTex.repeat.set(2, 2);

  const low = createFacadeTexture('#b9a58c', 4, 3);
  const mid = createFacadeTexture('#a8897a', 7, 4);
  const tall = createFacadeTexture('#8d99a6', 12, 5);

  const checkerCanvas = makeCanvas(128, 32);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 2; y++) {
      checkerCanvas.ctx.fillStyle = (x + y) % 2 === 0 ? '#e9e6df' : '#1b1b1f';
      checkerCanvas.ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const checkerTex = new THREE.CanvasTexture(checkerCanvas.canvas);
  checkerTex.colorSpace = THREE.SRGBColorSpace;

  return {
    asphalt: new THREE.MeshStandardMaterial({
      map: asphalt,
      color: 0x8f9096,
      roughness: 0.92,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    asphaltPad: new THREE.MeshStandardMaterial({
      map: asphalt,
      color: 0x808086,
      roughness: 0.88,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: concreteTex,
      color: 0xb8b5ad,
      roughness: 0.95,
    }),
    lines: new THREE.MeshStandardMaterial({
      color: 0xe4e0d6,
      roughness: 0.7,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
    terrain: new THREE.MeshStandardMaterial({
      map: grass,
      vertexColors: true,
      roughness: 0.97,
      metalness: 0,
    }),
    buildingLow: new THREE.MeshStandardMaterial({ map: low.map, roughness: 0.82, vertexColors: false }),
    buildingMid: new THREE.MeshStandardMaterial({ map: mid.map, roughness: 0.8 }),
    buildingTall: new THREE.MeshStandardMaterial({ map: tall.map, roughness: 0.55, metalness: 0.25 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x4a4a4e, roughness: 0.95 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x3f5a34, roughness: 1, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x4b3a2a, roughness: 1 }),
    barrier: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.6, metalness: 0.4 }),
    cone: new THREE.MeshStandardMaterial({ color: 0xf05a1e, roughness: 0.6 }),
    gate: new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.5 }),
    checker: new THREE.MeshBasicMaterial({ map: checkerTex }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x1b2a33,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.72,
      envMapIntensity: 1.6,
    }),
  };
}
