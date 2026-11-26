import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { ShaderGrade } from '../game/shaderSettings.ts';

/**
 * Étalonnage couleur final. Quand il est actif, il **remplace** OutputPass :
 * la passe fait le tone mapping ACES, la conversion sRGB et la retouche en une
 * seule fois. C'est le vrai budget d'un profil couleur — une passe plein écran,
 * pas deux.
 *
 * Le shader reprend exactement les fonctions ACES et sRGB de three.js, puis
 * applique contraste, saturation, chaleur, vignette et grain sur l'image déjà
 * convertie : les réglages se lisent comme dans un logiciel de retouche. Aucun
 * bloom, SSAO ou flou de profondeur, et un seul échantillon de texture.
 */
const GRADE_SHADER = {
  name: 'Sp95GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    toneMappingExposure: { value: 1 },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uWarmth: { value: 0 },
    uVignette: { value: 0 },
    uGrain: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uWarmth;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;

    // three.js injecte déjà toneMappingExposure, ACESFilmicToneMapping et
    // sRGBTransferOETF dans un ShaderMaterial : on les appelle au lieu de les
    // redéfinir.
    void main() {
      vec3 linear = texture2D(tDiffuse, vUv).rgb;
      vec3 color = sRGBTransferOETF(vec4(ACESFilmicToneMapping(linear), 1.0)).rgb;

      // Contraste autour du gris moyen, puis saturation autour de la luma
      // Rec. 709 : les rouges de carrosserie ne virent pas au fluo.
      color = (color - 0.5) * uContrast + 0.5;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);

      // Une pointe de chaleur, sans jaunir les ombres.
      color += vec3(uWarmth, uWarmth * 0.3, -uWarmth * 0.55);

      // Vignette douce : elle guide l'œil au centre sans assombrir le HUD,
      // puisque le HUD est dessiné dans le DOM, après ce shader.
      vec2 offset = vUv - 0.5;
      float falloff = smoothstep(0.18, 0.72, dot(offset, offset));
      color *= 1.0 - falloff * uVignette;

      // Grain animé très fin. Le facteur 1024 garde des pixels de bruit, pas
      // de grosses taches visibles à 30 cm de l'écran.
      float grain = fract(sin(dot(vUv * 1024.0 + uTime * 60.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      color += grain * uGrain;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

export function createShaderGradePass(): ShaderPass {
  const pass = new ShaderPass(GRADE_SHADER);
  pass.enabled = false;
  return pass;
}

export function applyShaderGrade(pass: ShaderPass, grade: ShaderGrade): void {
  const uniforms = pass.uniforms as Record<string, { value: number }>;
  uniforms.uContrast.value = grade.contrast;
  uniforms.uSaturation.value = grade.saturation;
  uniforms.uWarmth.value = grade.warmth;
  uniforms.uVignette.value = grade.vignette;
  uniforms.uGrain.value = grade.grain;
}

export function updateShaderGradePass(
  pass: ShaderPass,
  seconds: number,
  exposure: number,
): void {
  const uniforms = pass.uniforms as Record<string, { value: number }>;
  uniforms.uTime.value = seconds;
  uniforms.toneMappingExposure.value = exposure;
}
