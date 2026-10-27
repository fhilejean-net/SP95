import type * as THREE from 'three';

/**
 * Drops the render resolution, then the shadows, when the machine cannot keep
 * up. Letting a weak GPU run out of budget is what turns into stutter, frozen
 * frames or a lost context, so the game degrades itself instead.
 *
 * Les paliers sont progressifs — résolution interne, puis carte d'ombres, puis
 * ombres entières : couper les ombres d'un coup à une machine qui tient 45
 * images par seconde lui retirait tout un décor pour rien.
 */
export class QualityGovernor {
  private ratio: number;
  private elapsed = 0;
  private frames = 0;
  private stage = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    initialRatio: number,
    private readonly sun?: THREE.DirectionalLight,
  ) {
    this.ratio = initialRatio;
  }

  /** True once the last quality step has been taken. */
  get settled(): boolean {
    return this.stage >= 3;
  }

  update(dt: number): void {
    if (this.stage >= 3) return;
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < 2.5) return;

    const averageFps = this.frames / this.elapsed;
    this.elapsed = 0;
    this.frames = 0;
    if (averageFps > 48) return;

    if (this.stage === 0) {
      this.stage = 1;
      this.resize(Math.min(this.ratio, 1));
      return;
    }
    if (this.stage === 1) {
      this.stage = 2;
      // La passe d'ombres est la deuxième dépense de la machine : à 1024² elle
      // coûte moitié moins et ne se voit pas à l'écran.
      const shadow = this.sun?.shadow;
      if (shadow) {
        shadow.mapSize.set(1024, 1024);
        shadow.map?.dispose();
        shadow.map = null;
      }
      return;
    }
    this.stage = 3;
    this.renderer.shadowMap.enabled = false;
    this.resize(0.75);
  }

  private resize(ratio: number): void {
    this.ratio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
