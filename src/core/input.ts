export interface Controls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

type Action = 'reset' | 'pause' | 'mute' | 'help' | 'tcs' | 'wheelie' | 'camera' | 'wet' | 'replay';

const DEADZONE = 0.09;

export class InputManager {
  private keys = new Set<string>();
  private pendingActions = new Set<Action>();
  private throttleSmooth = 0;
  private brakeSmooth = 0;
  private steerSmooth = 0;
  private gamepadIndex: number | null = null;

  orbitYaw = 0;
  orbitPitch = 0;
  orbitActive = false;
  private orbitIdle = 99;
  private lastPointer = { x: 0, y: 0 };
  zoom = 0;

  readonly usingTouch: boolean;
  private touchSteer = 0;
  private touchThrottle = false;
  private touchBrake = false;
  private touchHandbrake = false;

  constructor(canvas: HTMLCanvasElement) {
    this.usingTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (!e.repeat) {
        if (e.code === 'KeyR') this.pendingActions.add('reset');
        if (e.code === 'Escape' || e.code === 'KeyP') this.pendingActions.add('pause');
        if (e.code === 'KeyM') this.pendingActions.add('mute');
        if (e.code === 'KeyH') this.pendingActions.add('help');
        if (e.code === 'KeyT') this.pendingActions.add('tcs');
        if (e.code === 'KeyC') this.pendingActions.add('camera');
        if (e.code === 'KeyG') this.pendingActions.add('wet');
        if (e.code === 'KeyV') this.pendingActions.add('replay');
        // A supermotard has no handbrake lever, so the space bar is the clutch
        // dump on the bike. On four wheels it stays the handbrake.
        if (e.code === 'Space') this.pendingActions.add('wheelie');
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      this.orbitActive = true;
      this.orbitIdle = 0;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.orbitActive || e.pointerType === 'touch') return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.orbitYaw = Math.max(-2.6, Math.min(2.6, this.orbitYaw - dx * 0.006));
      this.orbitPitch = Math.max(-0.45, Math.min(0.9, this.orbitPitch + dy * 0.004));
      this.orbitIdle = 0;
    });
    const endDrag = () => {
      this.orbitActive = false;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.max(-2.4, Math.min(4, this.zoom + e.deltaY * 0.0035));
      },
      { passive: false },
    );

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
    });

    this.setupTouch();
  }

  private setupTouch(): void {
    const pad = document.getElementById('touch-steer');
    const knob = document.getElementById('touch-steer-knob');
    if (pad && knob) {
      const update = (e: PointerEvent) => {
        const rect = pad.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const dx = e.clientX - cx;
        const limit = rect.width * 0.38;
        const norm = Math.max(-1, Math.min(1, dx / limit));
        this.touchSteer = norm;
        knob.style.transform = `translate(${norm * limit}px, -50%)`;
      };
      pad.addEventListener('pointerdown', (e) => {
        pad.setPointerCapture(e.pointerId);
        update(e);
      });
      pad.addEventListener('pointermove', (e) => {
        if (pad.hasPointerCapture(e.pointerId)) update(e);
      });
      const reset = () => {
        this.touchSteer = 0;
        knob.style.transform = 'translate(0px, -50%)';
      };
      pad.addEventListener('pointerup', reset);
      pad.addEventListener('pointercancel', reset);
    }

    const bindHold = (id: string, on: () => void, off: () => void) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('pressed');
        on();
      });
      const release = () => {
        el.classList.remove('pressed');
        off();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
    };

    bindHold(
      'touch-throttle',
      () => {
        this.touchThrottle = true;
      },
      () => {
        this.touchThrottle = false;
      },
    );
    bindHold(
      'touch-brake',
      () => {
        this.touchBrake = true;
      },
      () => {
        this.touchBrake = false;
      },
    );
    bindHold(
      'touch-handbrake',
      () => {
        this.touchHandbrake = true;
      },
      () => {
        this.touchHandbrake = false;
      },
    );
  }

  private axis(): number {
    const pad = this.gamepadIndex !== null ? navigator.getGamepads()[this.gamepadIndex] : null;
    if (!pad) return 0;
    const value = pad.axes[0] ?? 0;
    return Math.abs(value) < DEADZONE ? 0 : value;
  }

  private pedal(pad: Gamepad | null, primary: number): number {
    if (!pad) return 0;
    const button = pad.buttons[primary];
    if (button && button.value > 0.02) return button.value;
    return 0;
  }

  update(dt: number): Controls {
    const pad = this.gamepadIndex !== null ? (navigator.getGamepads()[this.gamepadIndex] ?? null) : null;
    if (!pad) {
      // Try to pick up a pad that was already connected before the page loaded.
      const pads = navigator.getGamepads();
      for (const p of pads) {
        if (p && p.connected) {
          this.gamepadIndex = p.index;
          break;
        }
      }
    }

    const activePad = this.gamepadIndex !== null ? (navigator.getGamepads()[this.gamepadIndex] ?? null) : null;

    let steerTarget = 0;
    if (this.keys.has('KeyA') || this.keys.has('KeyQ') || this.keys.has('ArrowLeft')) steerTarget -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steerTarget += 1;
    const padSteer = this.axis();
    if (Math.abs(padSteer) > 0) steerTarget = padSteer;
    if (this.touchSteer !== 0) steerTarget = this.touchSteer;

    const steerRate = Math.abs(steerTarget) > Math.abs(this.steerSmooth) ? 5.2 : 7.5;
    this.steerSmooth += Math.max(-steerRate * dt, Math.min(steerRate * dt, steerTarget - this.steerSmooth));
    this.steerSmooth = Math.max(-1, Math.min(1, this.steerSmooth));

    let throttleTarget = this.keys.has('KeyW') || this.keys.has('KeyZ') || this.keys.has('ArrowUp') ? 1 : 0;
    let brakeTarget = this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
    throttleTarget = Math.max(throttleTarget, this.pedal(activePad, 7));
    brakeTarget = Math.max(brakeTarget, this.pedal(activePad, 6));
    if (this.touchThrottle) throttleTarget = 1;
    if (this.touchBrake) brakeTarget = 1;

    const throttleRate = throttleTarget > this.throttleSmooth ? 9 : 14;
    const brakeRate = brakeTarget > this.brakeSmooth ? 14 : 20;
    this.throttleSmooth += Math.max(-throttleRate * dt, Math.min(throttleRate * dt, throttleTarget - this.throttleSmooth));
    this.brakeSmooth += Math.max(-brakeRate * dt, Math.min(brakeRate * dt, brakeTarget - this.brakeSmooth));

    const handbrake =
      this.keys.has('Space') || this.touchHandbrake || (activePad?.buttons[0]?.pressed ?? false);

    this.orbitIdle += dt;
    if (!this.orbitActive && this.orbitIdle > 1.6) {
      const decay = Math.exp(-dt * 2.2);
      this.orbitYaw *= decay;
      this.orbitPitch *= decay;
    }

    return {
      throttle: this.throttleSmooth,
      brake: this.brakeSmooth,
      steer: this.steerSmooth,
      handbrake,
    };
  }

  consume(action: Action): boolean {
    if (this.pendingActions.has(action)) {
      this.pendingActions.delete(action);
      return true;
    }
    return false;
  }

  clear(): void {
    this.keys.clear();
    this.pendingActions.clear();
    this.throttleSmooth = 0;
    this.brakeSmooth = 0;
    this.steerSmooth = 0;
  }
}
