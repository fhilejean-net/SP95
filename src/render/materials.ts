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
  ctx.fillStyle = '#3a3b41';
  ctx.fillRect(0, 0, 256, 256);
  // Taches larges, dessinées aussi sur les copies qui débordent du carreau :
  // sans ça une tache coupée au bord laissait une ligne nette à chaque
  // raccord d'asphalte, tous les `TRACK_TILE` mètres de piste.
  for (let i = 0; i < 320; i++) {
    const g = 46 + Math.floor(rand() * 26);
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.18 + rand() * 0.3})`;
    const x = rand() * 256;
    const y = rand() * 256;
    const rx = 7 + rand() * 24;
    const ry = rx * (0.55 + rand() * 0.7);
    const angle = rand() * Math.PI;
    for (const dx of [-256, 0, 256]) {
      for (const dy of [-256, 0, 256]) {
        if (Math.abs(x + dx - 128) > 190 || Math.abs(y + dy - 128) > 190) continue;
        ctx.beginPath();
        ctx.ellipse(x + dx, y + dy, rx, ry, angle, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Grain serré mais peu contrasté. Le fichier portait 9000 points d'un pixel sur
  // un carreau répété tous les 6 m : à distance ils scintillaient, et quatre
  // « rustines » en courbes de Bézier ressortaient en zigzag répété le long de la
  // route — la texture cassée posée sur l'asphalte que voyait le joueur.
  for (let i = 0; i < 5200; i++) {
    const g = 44 + Math.floor(rand() * 24);
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.14 + rand() * 0.22})`;
    const s = 1.3 + rand() * 2.2;
    ctx.fillRect(rand() * 256, rand() * 256, s, s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A photo-scanned ground material, tiled over the whole landscape. */
function loadGroundTexture(
  path: string,
  repeat: number,
  srgb: boolean,
): THREE.Texture {
  const base = import.meta.env.BASE_URL ?? '/';
  const tex = new THREE.TextureLoader().load(base + path);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(repeat, repeat);
  return tex;
}

/** Grass, with the normal and roughness maps that came with it. */
export function createGrassTextures(repeat: number): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
} {
  return {
    map: loadGroundTexture('textures/grass/albedo.jpg', repeat, true),
    normalMap: loadGroundTexture('textures/grass/normal.jpg', repeat, false),
    roughnessMap: loadGroundTexture('textures/grass/roughness.jpg', repeat, false),
  };
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

/** Loose gravel: brown base, hundreds of stones, darker wheel-polished patches. */
export function createGravelTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  const rand = seededRandom(53);
  ctx.fillStyle = '#6d5a44';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const g = 84 + rand() * 70;
    ctx.fillStyle = `rgba(${g + 12},${g},${g - 16},${0.25 + rand() * 0.5})`;
    const x = rand() * 256;
    const y = rand() * 256;
    const w = 0.8 + rand() * 2.6;
    ctx.beginPath();
    ctx.ellipse(x, y, w, w * (0.6 + rand() * 0.5), rand() * 3.14, 0, Math.PI * 2);
    ctx.fill();
  }
  // Dust and damp patches.
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(${70 + rand() * 30},${58 + rand() * 24},${44 + rand() * 18},0.08)`;
    ctx.beginPath();
    ctx.arc(rand() * 256, rand() * 256, 3 + rand() * 9, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface FacadeTexture {
  map: THREE.CanvasTexture;
  /** Same layout, black except the windows that are lit. */
  emissiveMap: THREE.CanvasTexture;
  repeatX: number;
  repeatY: number;
}

/**
 * Window-grid facade. `floors` rows of windows, warm stone or brick wall.
 * A share of the panes burn warm: that is the only "lighting" the buildings
 * need, and it is what makes the streets read as inhabited from a distance.
 */
export function createFacadeTexture(
  wall: string,
  floors: number,
  cols: number,
  litRatio = 0.26,
): FacadeTexture {
  const W = 256;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const glow = makeCanvas(W, H);
  glow.ctx.fillStyle = '#000000';
  glow.ctx.fillRect(0, 0, W, H);
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
      const lit = rand() < litRatio;
      if (lit) {
        // Warm interior, brighter at the top of the pane.
        const warm = 0.55 + rand() * 0.35;
        ctx.fillStyle = `rgba(255,${Math.round(180 + rand() * 40)},${Math.round(110 + rand() * 50)},${warm})`;
        ctx.fillRect(x, y, winW, winH);
        glow.ctx.fillStyle = `rgba(255,${Math.round(178 + rand() * 50)},${Math.round(96 + rand() * 60)},${warm})`;
        glow.ctx.fillRect(x, y, winW, winH);
      } else if (rand() > 0.72) {
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
  const emissive = new THREE.CanvasTexture(glow.canvas);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  return { map: tex, emissiveMap: emissive, repeatX: 1, repeatY: 1 };
}

export interface EnvironmentMaterials {
  asphalt: THREE.MeshStandardMaterial;
  asphaltPad: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  gravelRut: THREE.MeshStandardMaterial;
  gravelEdge: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  lines: THREE.MeshStandardMaterial;
  terrain: THREE.MeshStandardMaterial;
  buildingLow: THREE.MeshStandardMaterial;
  buildingMid: THREE.MeshStandardMaterial;
  buildingTall: THREE.MeshStandardMaterial;
  house: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  roofTile: THREE.MeshStandardMaterial;
  shop: THREE.MeshStandardMaterial;
  sign: THREE.MeshStandardMaterial;
  lampGlow: THREE.MeshBasicMaterial;
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
  // ~6 m per tile: fine enough to read as grass under the car, big enough that
  // the blades still resolve a few dozen metres away.
  const grass = createGrassTextures(320);
  const gravelTex = createGravelTexture();
  gravelTex.repeat.set(1, 1);
  const concreteTex = createConcreteTexture();
  concreteTex.repeat.set(2, 2);

  const low = createFacadeTexture('#b9a58c', 4, 3);
  const mid = createFacadeTexture('#a8897a', 7, 4);
  const tall = createFacadeTexture('#8d99a6', 12, 5);
  const house = createFacadeTexture('#c8b49b', 2, 2, 0.34);
  const shop = createFacadeTexture('#b0a394', 1, 3, 0.55);

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
    gravel: new THREE.MeshStandardMaterial({
      map: gravelTex,
      color: 0xb8a68c,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    gravelRut: new THREE.MeshStandardMaterial({
      map: gravelTex,
      color: 0x8a7458,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    gravelEdge: new THREE.MeshStandardMaterial({
      map: gravelTex,
      color: 0x7d6b52,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
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
      map: grass.map,
      normalMap: grass.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: grass.roughnessMap,
      vertexColors: true,
      roughness: 0.97,
      metalness: 0,
    }),
    buildingLow: new THREE.MeshStandardMaterial({
      map: low.map,
      emissive: 0xffffff,
      emissiveMap: low.emissiveMap,
      emissiveIntensity: 0.5,
      roughness: 0.82,
      vertexColors: false,
    }),
    buildingMid: new THREE.MeshStandardMaterial({
      map: mid.map,
      emissive: 0xffffff,
      emissiveMap: mid.emissiveMap,
      emissiveIntensity: 0.5,
      roughness: 0.8,
    }),
    buildingTall: new THREE.MeshStandardMaterial({
      map: tall.map,
      emissive: 0xffffff,
      emissiveMap: tall.emissiveMap,
      emissiveIntensity: 0.45,
      roughness: 0.55,
      metalness: 0.25,
    }),
    house: new THREE.MeshStandardMaterial({
      map: house.map,
      emissive: 0xffffff,
      emissiveMap: house.emissiveMap,
      emissiveIntensity: 0.65,
      roughness: 0.9,
    }),
    shop: new THREE.MeshStandardMaterial({
      map: shop.map,
      emissive: 0xffffff,
      emissiveMap: shop.emissiveMap,
      emissiveIntensity: 0.8,
      roughness: 0.8,
    }),
    sign: new THREE.MeshStandardMaterial({
      color: 0x241012,
      emissive: 0xff7a3c,
      emissiveIntensity: 1.1,
      roughness: 0.5,
    }),
    lampGlow: new THREE.MeshBasicMaterial({ color: 0xffe2b0 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x4a4a4e, roughness: 0.95 }),
    roofTile: new THREE.MeshStandardMaterial({ color: 0x8c4a37, roughness: 0.92, flatShading: true }),
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
