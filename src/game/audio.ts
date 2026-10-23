/**
 * Fully procedural car audio: no asset downloads, everything is oscillators
 * and filtered noise. The interesting bits are the ones car people listen for:
 * a turbo that spools and flutters, a dual-clutch fart on every upshift, and
 * anti-lag style pops when you lift or bounce off the limiter.
 */

export interface EngineTune {
  /** Rev limiter, rpm. */
  redline: number;
  /** Turbocharged engines flutter and chatter; the base engine does not. */
  turbo: boolean;
  /** 0..2, how open the exhaust is. */
  exhaustLevel: number;
  /** 0..3 engine stage: more induction noise and a harder edge. */
  engineLevel: number;
}

type NoiseKind = 'lowpass' | 'bandpass' | 'highpass';

export class CarAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private intakeGain: GainNode | null = null;
  private exhaustGain: GainNode | null = null;
  private turboGain: GainNode | null = null;
  private turboOsc: OscillatorNode | null = null;
  private tireGain: GainNode | null = null;
  private gravelGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  started = false;

  /** 0..1 turbo boost pressure, integrated from throttle and revs. */
  private boost = 0;
  private prevGear = 1;
  private prevThrottle = 0;
  private prevRpm = 900;
  private lastTime = 0;
  private lastPop = 0;
  private popCount = 0;
  /** How many one-shot effects have fired: used by the smoke test. */
  events = 0;
  private tune: EngineTune = { redline: 7300, turbo: false, exhaustLevel: 0, engineLevel: 0 };

  init(): void {
    if (this.started) {
      this.ctx?.resume();
      return;
    }
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    this.ctx = ctx;
    this.started = true;

    const master = ctx.createGain();
    master.gain.value = 0.55;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 20;
    compressor.ratio.value = 4.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    this.master = master;

    // White noise, shared by every noise voice.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    // --- Engine: two detuned saws, a square an octave-and-a-half up and a sub.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 1.15;
    engineGain.connect(filter);
    filter.connect(master);
    this.engineGain = engineGain;
    this.engineFilter = filter;

    const makeOsc = (type: OscillatorType, gainValue: number, detune = 0) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 60;
      osc.detune.value = detune;
      const gain = ctx.createGain();
      gain.gain.value = gainValue;
      osc.connect(gain);
      gain.connect(engineGain);
      osc.start();
      return osc;
    };
    this.oscA = makeOsc('sawtooth', 0.42, -6);
    this.oscB = makeOsc('square', 0.16, 9);
    this.oscSub = makeOsc('sine', 0.34);

    // A slow amplitude wobble at the firing frequency gives the idle its lump.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 18;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain);
    lfoGain.connect(engineGain.gain);
    lfo.start();

    // --- Intake honk: follows throttle, gets louder with engine work.
    const intake = ctx.createBufferSource();
    intake.buffer = buffer;
    intake.loop = true;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 950;
    intakeFilter.Q.value = 0.9;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    intake.connect(intakeFilter);
    intakeFilter.connect(intakeGain);
    intakeGain.connect(master);
    intake.start();
    this.intakeGain = intakeGain;

    // --- Exhaust rasp.
    const exhaust = ctx.createBufferSource();
    exhaust.buffer = buffer;
    exhaust.loop = true;
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.frequency.value = 240;
    exhaustFilter.Q.value = 0.85;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    exhaust.connect(exhaustFilter);
    exhaustFilter.connect(exhaustGain);
    exhaustGain.connect(master);
    exhaust.start();
    this.exhaustGain = exhaustGain;

    // --- Turbo: a thin high whine that tracks boost.
    const turboOsc = ctx.createOscillator();
    turboOsc.type = 'sine';
    turboOsc.frequency.value = 1600;
    const turboGain = ctx.createGain();
    turboGain.gain.value = 0;
    turboOsc.connect(turboGain);
    turboGain.connect(master);
    turboOsc.start();
    this.turboOsc = turboOsc;
    this.turboGain = turboGain;

    // --- Tire squeal.
    const tire = ctx.createBufferSource();
    tire.buffer = buffer;
    tire.loop = true;
    const tireFilter = ctx.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = 1450;
    tireFilter.Q.value = 7;
    const tireGain = ctx.createGain();
    tireGain.gain.value = 0;
    tire.connect(tireFilter);
    tireFilter.connect(tireGain);
    tireGain.connect(master);
    tire.start();
    this.tireGain = tireGain;

    // --- Gravel / grass rumble.
    const gravel = ctx.createBufferSource();
    gravel.buffer = buffer;
    gravel.loop = true;
    const gravelFilter = ctx.createBiquadFilter();
    gravelFilter.type = 'lowpass';
    gravelFilter.frequency.value = 620;
    gravelFilter.Q.value = 0.6;
    const gravelGain = ctx.createGain();
    gravelGain.gain.value = 0;
    gravel.connect(gravelFilter);
    gravelFilter.connect(gravelGain);
    gravelGain.connect(master);
    gravel.start();
    this.gravelGain = gravelGain;

    // --- Wind.
    const wind = ctx.createBufferSource();
    wind.buffer = buffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    wind.start();
    this.windGain = windGain;

    this.lastTime = ctx.currentTime;
  }

  /** Applies the current garage spec: redline, turbo, exhaust, engine stage. */
  configure(tune: EngineTune): void {
    this.tune = tune;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  update(params: {
    rpm: number;
    throttle: number;
    speed: number;
    slip: number;
    gear: number;
    grounded: boolean;
    limiter: boolean;
    /** Surface roughness 0..1 from the world. */
    roughness: number;
    /** Dirty = dirt or grass, for the rumble. */
    offRoad: boolean;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.oscA || !this.oscB || !this.oscSub) return;
    const now = ctx.currentTime;
    const dt = Math.max(0.001, Math.min(0.1, now - this.lastTime));
    this.lastTime = now;
    const { rpm, throttle, speed, slip, gear, grounded, limiter, roughness, offRoad } = params;
    const tune = this.tune;

    // --- Boost: builds with throttle and revs, dumps the moment you lift.
    const spool = Math.min(1, Math.max(0, (rpm - 1800) / 3200));
    const target = tune.turbo ? throttle * spool : 0;
    const rate = target > this.boost ? 0.32 : 0.55;
    this.boost += (target - this.boost) * Math.min(1, dt * rate * 10);

    // --- Engine tone.
    const firing = Math.max(26, (rpm / 60) * 2.1);
    this.oscA.frequency.setTargetAtTime(firing, now, 0.035);
    this.oscB.frequency.setTargetAtTime(firing * 1.495, now, 0.035);
    this.oscSub.frequency.setTargetAtTime(firing * 0.5, now, 0.04);

    const load = Math.max(0.12, throttle);
    const rpmFactor = Math.min(1, Math.max(0, (rpm - 700) / Math.max(1, tune.redline - 900)));
    const openExhaust = tune.exhaustLevel * 0.045;
    this.engineGain.gain.setTargetAtTime(
      (0.032 + rpmFactor * 0.085 + openExhaust * 0.35) *
        (grounded ? 1 : 0.6) *
        (0.55 + load * 0.45),
      now,
      0.05,
    );
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(
        650 + rpmFactor * 3000 + throttle * 600 + tune.engineLevel * 260,
        now,
        0.06,
      );
    }
    if (this.intakeGain) {
      this.intakeGain.gain.setTargetAtTime(
        (0.012 + rpmFactor * 0.03) * throttle * (1 + tune.engineLevel * 0.3),
        now,
        0.05,
      );
    }
    if (this.exhaustGain) {
      this.exhaustGain.gain.setTargetAtTime(
        (0.008 + throttle * 0.05 * (0.35 + rpmFactor)) * (1 + tune.exhaustLevel * 0.55),
        now,
        0.05,
      );
    }
    if (this.turboOsc && this.turboGain) {
      this.turboOsc.frequency.setTargetAtTime(1200 + this.boost * 4600 + rpmFactor * 700, now, 0.08);
      this.turboGain.gain.setTargetAtTime(this.boost * 0.012 * (1 + tune.engineLevel * 0.4), now, 0.12);
    }
    if (this.tireGain) {
      const squeal = offRoad
        ? 0
        : Math.min(1, Math.max(0, (Math.abs(slip) - 0.12) / 0.35));
      this.tireGain.gain.setTargetAtTime(squeal * 0.17 * Math.min(1, speed / 18), now, 0.06);
    }
    if (this.gravelGain) {
      this.gravelGain.gain.setTargetAtTime(
        offRoad ? roughness * 0.11 * Math.min(1, speed / 9) : 0,
        now,
        0.09,
      );
    }
    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(Math.min(0.12, (speed * speed) / 42000), now, 0.1);
    }

    // --- Events -----------------------------------------------------------
    // Upshift under load: dual-clutch fart (a hard, short, low thump).
    if (gear > this.prevGear && this.prevThrottle > 0.35 && this.prevGear > 0) {
      this.dsgFart(this.prevThrottle, rpm);
    }
    // Lift off at revs: overrun pops, wastegate chatter and turbo flutter.
    if (this.prevThrottle > 0.55 && throttle < 0.12 && this.prevRpm > 3800) {
      const strength = Math.min(1, (this.prevRpm - 3200) / 3600);
      this.pops(2 + Math.round(strength * 3), strength * 0.9 + tune.exhaustLevel * 0.15);
      if (this.boost > 0.25) this.blowOff(this.boost);
    }
    // Bouncing off the limiter: anti-lag bangs, not a clean cut.
    if (limiter && throttle > 0.35 && now - this.lastPop > 0.09) {
      this.lastPop = now;
      this.popCount = (this.popCount + 1) % 3;
      if (this.popCount === 0) this.pops(1, 0.75 + Math.random() * 0.25);
      if (this.boost > 0.3 && Math.random() > 0.55) this.burst({
        freq: 2600,
        q: 1.2,
        type: 'bandpass',
        gain: 0.05 + this.boost * 0.05,
        decay: 0.035,
      });
    }

    this.prevGear = gear;
    this.prevThrottle = throttle;
    this.prevRpm = rpm;
  }

  /** The BRAP of a dual-clutch upshift: short, low, and with a bite. */
  private dsgFart(throttle: number, rpm: number): void {
    if (!this.ctx) return;
    this.events++;
    const strength = 0.35 + throttle * 0.45;
    this.burst({
      freq: 150 + Math.min(1, rpm / 8000) * 90,
      q: 7,
      type: 'lowpass',
      gain: 0.34 * strength,
      decay: 0.075 + throttle * 0.05,
      attack: 0.004,
    });
    this.burst({ freq: 900, q: 1.4, type: 'bandpass', gain: 0.07 * strength, decay: 0.05 });
  }

  /** Overrun crackle: a handful of uneven shots, never a machine gun. */
  private pops(count: number, strength: number): void {
    if (!this.ctx) return;
    this.events++;
    for (let i = 0; i < count; i++) {
      const delay = i * (0.028 + Math.random() * 0.045);
      const pitch = 0.7 + Math.random() * 0.9;
      this.burst({
        freq: 190 * pitch,
        q: 2.4,
        type: 'bandpass',
        gain: (0.16 + Math.random() * 0.16) * strength,
        decay: 0.045 + Math.random() * 0.05,
        attack: 0.002,
        delay,
      });
      if (Math.random() > 0.45) {
        this.burst({
          freq: 1500 + Math.random() * 1800,
          q: 0.9,
          type: 'bandpass',
          gain: 0.05 * strength,
          decay: 0.03,
          delay: delay + 0.004,
        });
      }
    }
  }

  /** Blow-off "psh" followed by compressor flutter (stututu). */
  private blowOff(boost: number): void {
    if (!this.ctx) return;
    this.events++;
    this.burst({
      freq: 1900,
      q: 0.8,
      type: 'bandpass',
      gain: 0.1 + boost * 0.1,
      decay: 0.14,
      attack: 0.006,
      sweepTo: 900,
    });
    const chirps = 4 + Math.round(boost * 4);
    for (let i = 0; i < chirps; i++) {
      this.burst({
        freq: 2400 - i * 120,
        q: 2.6,
        type: 'bandpass',
        gain: 0.05 * (1 - i / (chirps + 2)),
        decay: 0.026,
        attack: 0.002,
        delay: 0.03 + i * 0.042,
      });
    }
  }

  /** One filtered noise burst with an attack/decay envelope. */
  private burst(opts: {
    freq: number;
    q?: number;
    type?: NoiseKind;
    gain: number;
    decay: number;
    attack?: number;
    delay?: number;
    sweepTo?: number;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    const buffer = this.noiseBuffer;
    if (!ctx || !master || !buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q ?? 1;
    const gain = ctx.createGain();

    const start = ctx.currentTime + (opts.delay ?? 0);
    const attack = opts.attack ?? 0.003;
    const peak = Math.max(0.001, opts.gain);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + opts.decay);
    if (opts.sweepTo) {
      filter.frequency.setValueAtTime(opts.freq, start);
      filter.frequency.exponentialRampToValueAtTime(opts.sweepTo, start + attack + opts.decay);
    }

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start, Math.random() * 1.5);
    source.stop(start + attack + opts.decay + 0.02);
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(Math.min(0.5, strength * 0.35), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + 0.3);
  }

  /** Stones and gravel ticking under the sills. */
  gravelTick(): void {
    this.burst({
      freq: 900 + Math.random() * 1500,
      q: 1.4,
      type: 'bandpass',
      gain: 0.03 + Math.random() * 0.03,
      decay: 0.04,
    });
  }
}
