import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Presets de lumière. Le jeu était éclairé par un seul plein soleil : tout
 * cramait (peintures blanches, herbe pâle, ciel délavé) et aucune partie ne
 * ressemblait à une autre. Chaque preset règle le soleil, le ciel, l'ambiance,
 * le brouillard, la couleur de fond et surtout l'exposition du rendu.
 *
 * Les valeurs sont mesurées à l'écran : sous le plein soleil, 0,62 d'exposition
 * garde le ciel bleu et les carrosseries claires detailées, là où 0,74 les
 * sortait blanches.
 */
export interface SkyPreset {
  id: string;
  label: string;
  /** Hauteur du soleil au-dessus de l'horizon, en degrés. */
  elevation: number;
  azimuth: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunColor: number;
  sunIntensity: number;
  hemisphereSky: number;
  hemisphereGround: number;
  hemisphereIntensity: number;
  environmentIntensity: number;
  /** Exposition du tone mapping ACES. */
  exposure: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  background: number;
}

export const NIGHT_PRESET: SkyPreset = {
  id: 'nuit-col', label: 'Nuit en forêt', elevation: -8, azimuth: 142,
  turbidity: 5, rayleigh: 0.2, mieCoefficient: 0.004, mieDirectionalG: 0.78,
  sunColor: 0x9cb6d5, sunIntensity: 0.08,
  hemisphereSky: 0x62758f, hemisphereGround: 0x1a201c, hemisphereIntensity: 0.25,
  environmentIntensity: 0.06, exposure: 0.9,
  fogColor: 0x0b1118, fogNear: 70, fogFar: 350, background: 0x090e15,
};

export const SKY_PRESETS: SkyPreset[] = [
  {
    id: 'apres-midi',
    label: 'Fin d’après-midi',
    elevation: 20,
    azimuth: 142,
    turbidity: 5.2,
    rayleigh: 0.95,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.78,
    sunColor: 0xffdcae,
    sunIntensity: 1.6,
    hemisphereSky: 0x9fb8d6,
    hemisphereGround: 0x4a4538,
    hemisphereIntensity: 0.26,
    environmentIntensity: 0.3,
    exposure: 0.66,
    fogColor: 0xaebcc4,
    fogNear: 460,
    fogFar: 1950,
    background: 0x93a8b8,
  },
  {
    id: 'matin-brumeux',
    label: 'Matin brumeux',
    elevation: 11,
    azimuth: 96,
    turbidity: 7.5,
    rayleigh: 0.7,
    mieCoefficient: 0.008,
    mieDirectionalG: 0.82,
    sunColor: 0xffd2a2,
    sunIntensity: 1.2,
    hemisphereSky: 0xb2c2cf,
    hemisphereGround: 0x504b3e,
    hemisphereIntensity: 0.38,
    environmentIntensity: 0.3,
    exposure: 0.74,
    fogColor: 0xbfc8cc,
    fogNear: 240,
    fogFar: 1250,
    background: 0xb0b9be,
  },
  {
    id: 'ciel-couvert',
    label: 'Ciel couvert',
    elevation: 34,
    azimuth: 165,
    turbidity: 10,
    rayleigh: 0.3,
    mieCoefficient: 0.09,
    mieDirectionalG: 0.6,
    sunColor: 0xdfe3e6,
    sunIntensity: 0.5,
    hemisphereSky: 0xa7b6c4,
    hemisphereGround: 0x46463f,
    hemisphereIntensity: 0.62,
    environmentIntensity: 0.42,
    exposure: 0.76,
    fogColor: 0x9fa9b0,
    fogNear: 320,
    fogFar: 1500,
    background: 0x99a3aa,
  },
  {
    id: 'soleil-haut',
    label: 'Grand beau temps',
    elevation: 46,
    azimuth: 120,
    turbidity: 3.2,
    rayleigh: 1.15,
    mieCoefficient: 0.003,
    mieDirectionalG: 0.76,
    sunColor: 0xfff3e0,
    sunIntensity: 1.95,
    hemisphereSky: 0xa8c4e6,
    hemisphereGround: 0x5a5544,
    hemisphereIntensity: 0.3,
    environmentIntensity: 0.36,
    exposure: 0.62,
    fogColor: 0xa9c0d2,
    fogNear: 520,
    fogFar: 2100,
    background: 0x8fa9bd,
  },
];

/**
 * Lumière de la partie. `?light=` force un preset (utile aux captures et au
 * réglage) ; sinon on tire au sort une fois par chargement, avec deux chances
 * sur cinq d'un plein soleil : le jeu ne vit plus sous la même lumière.
 */
export function pickSkyPreset(): SkyPreset {
  const requested = new URLSearchParams(window.location.search).get('light');
  if (requested) {
    const found = SKY_PRESETS.find((preset) => preset.id === requested);
    if (found) return found;
  }
  const table = [
    SKY_PRESETS[0],
    SKY_PRESETS[0],
    SKY_PRESETS[1],
    SKY_PRESETS[2],
    SKY_PRESETS[3],
  ];
  return table[Math.floor(Math.random() * table.length)];
}

export interface SkyResult {
  sun: THREE.DirectionalLight;
  sunDirection: THREE.Vector3;
  sky: Sky;
  preset: SkyPreset;
}

export function createSky(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  preset: SkyPreset = SKY_PRESETS[0],
): SkyResult {
  const sky = new Sky();
  sky.scale.setScalar(8000);
  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = preset.turbidity;
  uniforms.rayleigh.value = preset.rayleigh;
  uniforms.mieCoefficient.value = preset.mieCoefficient;
  uniforms.mieDirectionalG.value = preset.mieDirectionalG;

  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - preset.elevation),
    THREE.MathUtils.degToRad(preset.azimuth),
  );
  uniforms.sunPosition.value.copy(sunDirection);
  if (preset.id !== 'nuit-col') scene.add(sky);

  // Environment map from the same sky, so paint, glass and chrome reflect the
  // light of the moment instead of a fixed studio.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(8000);
  const envUniforms = envSky.material.uniforms;
  envUniforms.turbidity.value = preset.turbidity;
  envUniforms.rayleigh.value = preset.rayleigh;
  envUniforms.mieCoefficient.value = preset.mieCoefficient;
  envUniforms.mieDirectionalG.value = preset.mieDirectionalG;
  envUniforms.sunPosition.value.copy(sunDirection);
  envScene.add(envSky);
  const envTexture = pmrem.fromScene(envScene, 0, 1, 12000).texture;
  scene.environment = envTexture;
  scene.environmentIntensity = preset.environmentIntensity;
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
  sun.position.copy(sunDirection).multiplyScalar(400);
  // La passe d'ombre du soleil tourne mais ne dépose rien sur l'asphalte de ce
  // rendu : mesure A/B sur la même scène, 129 pixels changent sur 416 000
  // quand on la coupe. La carte coûtait donc une passe complète sur 500 000
  // triangles par image pour rien. Les véhicules et le décor sont ancrés par
  // les décalques de `grounding.ts` ; on rallume ici le jour où la carte
  // écrira vraiment.
  sun.castShadow = false;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 700;
  // La fenêtre glisse avec la voiture (main.ts) : 64 m autour d'elle couvre les
  // murs, gradins et bâtiments dans le champ, et resserre les texels du filtre
  // de 9,3 à 6,2 cm — l'ombre de la caisse a un contour net au lieu d'un flou.
  sun.shadow.camera.left = -64;
  sun.shadow.camera.right = 64;
  sun.shadow.camera.top = 64;
  sun.shadow.camera.bottom = -64;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.022;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(
    preset.hemisphereSky,
    preset.hemisphereGround,
    preset.hemisphereIntensity,
  );
  scene.add(hemi);

  // A solid colour behind everything: if any frame ever fails to draw the sky
  // dome, the player sees haze instead of a black flash.
  scene.background = new THREE.Color(preset.background);
  scene.fog = new THREE.Fog(preset.fogColor, preset.fogNear, preset.fogFar);

  document.documentElement.dataset.sky = preset.id;
  return { sun, sunDirection, sky, preset };
}
