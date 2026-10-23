import type * as THREE from 'three';

/**
 * Drops the render resolution, then the shadows, when the machine cannot keep
 * up. Letting a weak GPU run out of budget is what turns into stutter, frozen
 * frames or a lost context, so the game degrades itself instead.
 */
export class QualityGovernor {
  private ratio: number;
  private elapsed = 0;
  private frames = 0;
  private stage = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    initialRatio: number,
  ) {
    this.ratio = initialRatio;
  }

  /** True once the last quality step has been taken. */
  get settled(): boolean {
    return this.stage >= 2;
  }

  update(dt: number): void {
    if (this.stage >= 2) return;
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
    this.stage = 2;
    this.renderer.shadowMap.enabled = false;
    this.resize(0.75);
  }

  private resize(ratio: number): void {
    this.ratio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
