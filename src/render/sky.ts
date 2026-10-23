import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export interface SkyResult {
  sun: THREE.DirectionalLight;
  sunDirection: THREE.Vector3;
  sky: Sky;
}

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): SkyResult {
  const sky = new Sky();
  sky.scale.setScalar(8000);
  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = 3.4;
  uniforms.rayleigh.value = 1.5;
  // A strong Mie term balloons the sun into a white blob that washes out the
  // whole frame once tone mapping lifts it.
  uniforms.mieCoefficient.value = 0.0022;
  uniforms.mieDirectionalG.value = 0.76;

  const elevation = 32;
  const azimuth = 132;
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevation),
    THREE.MathUtils.degToRad(azimuth),
  );
  uniforms.sunPosition.value.copy(sunDirection);
  scene.add(sky);

  // Generate an environment map from the sky so paint, glass and chrome get
  // believable reflections. A separate scene avoids including the world.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(8000);
  const envUniforms = envSky.material.uniforms;
  Object.assign(envUniforms, {});
  envUniforms.turbidity.value = uniforms.turbidity.value;
  envUniforms.rayleigh.value = uniforms.rayleigh.value;
  envUniforms.mieCoefficient.value = uniforms.mieCoefficient.value;
  envUniforms.mieDirectionalG.value = uniforms.mieDirectionalG.value;
  envUniforms.sunPosition.value.copy(sunDirection);
  envScene.add(envSky);
  const envTexture = pmrem.fromScene(envScene, 0, 1, 12000).texture;
  scene.environment = envTexture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.copy(sunDirection).multiplyScalar(400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 700;
  sun.shadow.camera.left = -95;
  sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95;
  sun.shadow.camera.bottom = -95;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x6e6650, 0.35);
  scene.add(hemi);

  // A solid colour behind everything: if any frame ever fails to draw the sky
  // dome, the player sees haze instead of a black flash.
  scene.background = new THREE.Color(0xb9cfdd);
  scene.fog = new THREE.Fog(0xc4d6e2, 380, 1750);

  return { sun, sunDirection, sky };
}
