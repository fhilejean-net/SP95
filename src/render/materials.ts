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

/**
 * Asphalte photographié : la tuile de rue fournie avec le projet ne garde que
 * sa zone d'asphalte propre (ni ligne, ni bordure), découpée et compressée en
 * WebP (51 kB au lieu des 14 Mo du GLB d'origine).
 */
export function createRoadTextures(anisotropy: number, repeat: number): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
} {
  const load = (file: string, srgb: boolean): THREE.Texture => {
    const base = import.meta.env.BASE_URL ?? '/';
    const texture = new THREE.TextureLoader().load(`${base}textures/road/${file}`);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = anisotropy;
    texture.repeat.set(repeat, 1);
    return texture;
  };
  return {
    map: load('asphalt_albedo.webp', true),
    normalMap: load('asphalt_normal.webp', false),
    roughnessMap: load('asphalt_rough.webp', false),
  };
}

/**
 * Asphalte de piste, entièrement procédural.
 *
 * Le relevé photo avait deux défauts en jeu : ses graviers blancs
 * scintillaient à distance (taches bleues sur la piste), et son échelle n'était
 * pas carrée — le grain se retrouvait étiré sur la largeur. Ici albédo, normale
 * et rugosité sortent du **même** champ de hauteur, sur une tuile carrée qui se
 * raccorde sans couture. Les graviers sont assez gros pour se lire à 1 m, assez
 * sombres pour ne pas clignoter au loin.
 */
export function createTrackSurfaceTextures(anisotropy: number, size = 512): {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
} {
  const heights = new Float32Array(size * size);

  /** Bruit de valeur périodique : le bord de la tuile reprend son autre bord. */
  const valueNoise = (frequency: number, seed: number): ((u: number, v: number) => number) => {
    const rand = seededRandom(seed);
    const grid = new Float32Array(frequency * frequency);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    const at = (i: number, j: number): number =>
      grid[(((j % frequency) + frequency) % frequency) * frequency + (((i % frequency) + frequency) % frequency)];
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    return (u, v) => {
      const x = u * frequency;
      const y = v * frequency;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = smooth(x - x0);
      const fy = smooth(y - y0);
      const a = at(x0, y0);
      const b = at(x0 + 1, y0);
      const c = at(x0, y0 + 1);
      const d = at(x0 + 1, y0 + 1);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    };
  };

  const octaves = [
    { noise: valueNoise(4, 991), weight: 0.34 },
    { noise: valueNoise(12, 733), weight: 0.26 },
    { noise: valueNoise(48, 311), weight: 0.22 },
    { noise: valueNoise(160, 97), weight: 0.18 },
  ];
  let lowest = Infinity;
  let highest = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (const octave of octaves) value += octave.noise(x / size, y / size) * octave.weight;
      heights[y * size + x] = value;
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
  }
  const span = Math.max(1e-6, highest - lowest);
  for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] - lowest) / span;

  // Graviers : des grains de 1 à 3 px, posés avec repli sur les bords, donc
  // sans couture. Ils donnent l'éclat clair de l'agrégat sous le liant.
  const rand = seededRandom(613);
  for (let stone = 0; stone < 6200; stone++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const radius = 0.6 + rand() * 1.7;
    const amplitude = 0.08 + rand() * 0.3;
    const reach = Math.ceil(radius);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const distance = Math.hypot(dx, dy) / radius;
        if (distance > 1) continue;
        const px = ((Math.floor(cx) + dx) % size + size) % size;
        const py = ((Math.floor(cy) + dy) % size + size) % size;
        const index = py * size + px;
        heights[index] = Math.min(1, heights[index] + amplitude * (1 - distance * distance));
      }
    }
  }

  /** Grain fin d'un pixel, indépendant de la tuile. */
  const speckle = (x: number, y: number): number => {
    let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const slope = 1.1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const height = heights[index];
      const grain = speckle(x, y);
      // Agrégat : le sommet d'un gravier renvoie plus de lumière que le liant,
      // mais très peu — un asphalte neigeux se lit comme du gravier, pas comme
      // une piste. Le grain doit se deviner, pas clignoter.
      const aggregate = Math.max(0, height - 0.62) * 42;
      const value = 46 + (height - 0.5) * 20 + (grain - 0.5) * 9 + aggregate;
      albedo[index * 4] = clamp(value * 0.98);
      albedo[index * 4 + 1] = clamp(value);
      albedo[index * 4 + 2] = clamp(value * 1.05);
      albedo[index * 4 + 3] = 255;

      const left = heights[y * size + ((x - 1 + size) % size)];
      const right = heights[y * size + ((x + 1) % size)];
      const down = heights[((y - 1 + size) % size) * size + x];
      const up = heights[((y + 1) % size) * size + x];
      let nx = (left - right) * slope;
      let ny = (down - up) * slope;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      normal[index * 4] = clamp((nx * 0.5 + 0.5) * 255);
      normal[index * 4 + 1] = clamp((ny * 0.5 + 0.5) * 255);
      normal[index * 4 + 2] = clamp((nz / length) * 0.5 * 255 + 127.5);
      normal[index * 4 + 3] = 255;

      // Piste sèche : très mate, avec juste ce qu'il faut de variation pour
      // que le soleil ne la lisse pas en aplat.
      const rough = 0.88 + (0.5 - height) * 0.07 + (grain - 0.5) * 0.025;
      roughness[index * 4] = clamp(rough * 255);
      roughness[index * 4 + 1] = clamp(rough * 255);
      roughness[index * 4 + 2] = clamp(rough * 255);
      roughness[index * 4 + 3] = 255;
    }
  }

  const make = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = anisotropy;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    map: make(albedo, true),
    normalMap: make(normal, false),
    roughnessMap: make(roughness, false),
  };
}

/** Touffe d'herbe : quelques brins découpés dans la planche fournie. */
export function createGrassTuftTexture(anisotropy: number): THREE.Texture {
  const base = import.meta.env.BASE_URL ?? '/';
  const texture = new THREE.TextureLoader().load(`${base}textures/grass/tuft.png`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
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
      envMapIntensity: 1.1,
    }),
  };
}
