/**
 * Fully procedural car audio: no asset downloads, everything is oscillators
 * and filtered noise. The interesting bits are the ones car people listen for:
 * a turbo that spools and flutters, a dual-clutch fart on every upshift, and
 * anti-lag style pops when you lift or bounce off the limiter.
 *
 * Two rules keep it clean at high revs:
 *  - the engine is one phase-locked harmonic stack, with no detuned partials
 *    and no inharmonic ratio, so nothing beats like a short audio loop;
 *  - every noise voice loops a buffer whose end is crossfaded into its start,
 *    so the loop point is silent instead of clicking every couple of seconds.
 *
 * Each family has its own bus, so the sound panel can balance them.
 */
import { fillSeamlessNoise } from './audioDsp.ts';
import {
  DEFAULT_MIX,
  clampChannel,
  loadMix,
  type SoundChannel,
  type SoundMix,
} from './audioMix.ts';

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

/** A band-limited engine waveform, built from integer harmonics only. */
function engineWave(
  ctx: AudioContext,
  harmonics: number,
  rolloff: number,
  evenWeight: number,
): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    const weight = 1 / Math.pow(n, rolloff);
    imag[n] = weight * (n % 2 === 0 ? evenWeight : 1);
  }
  return ctx.createPeriodicWave(real, imag);
}

export class CarAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private toneEdgeGain: GainNode | null = null;
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
  private lfo: OscillatorNode | null = null;
  private buses = new Map<SoundChannel, GainNode>();
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private mix: SoundMix;
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

  constructor() {
    this.mix = loadMix();
  }

  /** Current user mix, as a copy. */
  get soundMix(): SoundMix {
    return { ...this.mix };
  }

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
    master.gain.value = this.muted ? 0 : this.mix.master;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 20;
    compressor.ratio.value = 4.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    this.master = master;

    const bus = (channel: Exclude<SoundChannel, 'master'>): GainNode => {
      const gain = ctx.createGain();
      gain.gain.value = this.mix[channel];
      gain.connect(master);
      this.buses.set(channel, gain);
      return gain;
    };
    const engineBus = bus('engine');
    const intakeBus = bus('intake');
    const exhaustBus = bus('exhaust');
    const turboBus = bus('turbo');
    const tyresBus = bus('tyres');
    const gravelBus = bus('gravel');
    const windBus = bus('wind');
    const effectsBus = bus('effects');

    /** One seamlessly looped noise buffer per voice family. */
    const noise = (seconds: number): AudioBuffer => {
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
      fillSeamlessNoise(buffer.getChannelData(0), Math.floor(ctx.sampleRate * 0.4));
      return buffer;
    };
    const intakeNoise = noise(1.9);
    const exhaustNoise = noise(2.3);
    const tyreNoise = noise(2.7);
    const gravelNoise = noise(3.1);
    const windNoise = noise(4.3);
    this.noiseBuffer = noise(2.1);

    // --- Engine: one harmonic stack plus a half-order sub. No detune, no
    // inharmonic partial: every component is locked to the firing frequency,
    // so the tone cannot beat or repeat like a short sample.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.85;
    engineGain.connect(filter);
    filter.connect(engineBus);
    this.engineGain = engineGain;
    this.engineFilter = filter;

    const makeOsc = (wave: PeriodicWave, gainValue: number): { osc: OscillatorNode; gain: GainNode } => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 60;
      const gain = ctx.createGain();
      gain.gain.value = gainValue;
      osc.connect(gain);
      gain.connect(engineGain);
      osc.start();
      return { osc, gain };
    };
    const bodyWave = engineWave(ctx, 16, 1.15, 0.7);
    const edgeWave = engineWave(ctx, 26, 0.8, 0.5);
    const body = makeOsc(bodyWave, 0.5);
    const edge = makeOsc(edgeWave, 0.16);
    this.oscA = body.osc;
    this.toneEdgeGain = edge.gain;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 30;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.34;
    sub.connect(subGain);
    subGain.connect(engineGain);
    sub.start();
    this.oscSub = sub;
    this.oscB = edge.osc;

    // A slow amplitude wobble at half the firing frequency gives the idle its
    // lump without adding a second, beating pitch.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 16;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain);
    lfoGain.connect(engineGain.gain);
    lfo.start();
    this.lfo = lfo;

    // --- Intake honk: follows throttle, gets louder with engine work.
    const intake = ctx.createBufferSource();
    intake.buffer = intakeNoise;
    intake.loop = true;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 950;
    intakeFilter.Q.value = 0.9;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    intake.connect(intakeFilter);
    intakeFilter.connect(intakeGain);
    intakeGain.connect(intakeBus);
    intake.start();
    this.intakeGain = intakeGain;

    // --- Exhaust rasp.
    const exhaust = ctx.createBufferSource();
    exhaust.buffer = exhaustNoise;
    exhaust.loop = true;
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.frequency.value = 240;
    exhaustFilter.Q.value = 0.85;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    exhaust.connect(exhaustFilter);
    exhaustFilter.connect(exhaustGain);
    exhaustGain.connect(exhaustBus);
    exhaust.start();
    this.exhaustGain = exhaustGain;

    // --- Turbo: a thin high whine that tracks boost.
    const turboOsc = ctx.createOscillator();
    turboOsc.type = 'sine';
    turboOsc.frequency.value = 1200;
    const turboGain = ctx.createGain();
    turboGain.gain.value = 0;
    turboOsc.connect(turboGain);
    turboGain.connect(turboBus);
    turboOsc.start();
    this.turboOsc = turboOsc;
    this.turboGain = turboGain;

    // --- Tire squeal.
    const tire = ctx.createBufferSource();
    tire.buffer = tyreNoise;
    tire.loop = true;
    const tireFilter = ctx.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = 1250;
    tireFilter.Q.value = 4.5;
    const tireGain = ctx.createGain();
    tireGain.gain.value = 0;
    tire.connect(tireFilter);
    tireFilter.connect(tireGain);
    tireGain.connect(tyresBus);
    tire.start();
    this.tireGain = tireGain;

    // --- Gravel / grass rumble.
    const gravel = ctx.createBufferSource();
    gravel.buffer = gravelNoise;
    gravel.loop = true;
    const gravelFilter = ctx.createBiquadFilter();
    gravelFilter.type = 'lowpass';
    gravelFilter.frequency.value = 620;
    gravelFilter.Q.value = 0.6;
    const gravelGain = ctx.createGain();
    gravelGain.gain.value = 0;
    gravel.connect(gravelFilter);
    gravelFilter.connect(gravelGain);
    gravelGain.connect(gravelBus);
    gravel.start();
    this.gravelGain = gravelGain;

    // --- Wind.
    const wind = ctx.createBufferSource();
    wind.buffer = windNoise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(windBus);
    wind.start();
    this.windGain = windGain;

    // Bursts and impacts live on the effects bus.
    this.effects = effectsBus;
    this.lastTime = ctx.currentTime;
  }

  private effects: GainNode | null = null;

  /** Applies the current garage spec: redline, turbo, exhaust, engine stage. */
  configure(tune: EngineTune): void {
    this.tune = tune;
  }

  /** Moves one channel of the mix; the rest keeps playing. */
  setChannel(channel: SoundChannel, value: number): void {
    this.mix[channel] = clampChannel(value, DEFAULT_MIX[channel]);
    const ctx = this.ctx;
    if (!ctx) return;
    if (channel === 'master') {
      if (!this.muted && this.master) {
        this.master.gain.setTargetAtTime(this.mix.master, ctx.currentTime, 0.04);
      }
      return;
    }
    const bus = this.buses.get(channel);
    bus?.gain.setTargetAtTime(this.mix[channel], ctx.currentTime, 0.04);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.mix.master, this.ctx.currentTime, 0.05);
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

    // --- Engine tone. Four-stroke four-cylinder: two ignitions per rev.
    const firing = Math.max(24, (rpm / 60) * 2);
    this.oscA.frequency.setTargetAtTime(firing, now, 0.03);
    this.oscB.frequency.setTargetAtTime(firing, now, 0.03);
    this.oscSub.frequency.setTargetAtTime(firing * 0.5, now, 0.035);
    this.lfo?.frequency.setTargetAtTime(Math.max(10, firing * 0.5), now, 0.05);

    const load = Math.max(0.12, throttle);
    const rpmFactor = Math.min(1, Math.max(0, (rpm - 700) / Math.max(1, tune.redline - 900)));
    const openExhaust = tune.exhaustLevel * 0.045;
    this.engineGain.gain.setTargetAtTime(
      (0.03 + rpmFactor * 0.075 + openExhaust * 0.3) *
        (grounded ? 1 : 0.6) *
        (0.6 + load * 0.4),
      now,
      0.05,
    );
    this.toneEdgeGain?.gain.setTargetAtTime(0.1 + throttle * 0.16 + rpmFactor * 0.06, now, 0.06);
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(
        700 + rpmFactor * 3600 + throttle * 500 + tune.engineLevel * 240,
        now,
        0.06,
      );
    }
    if (this.intakeGain) {
      this.intakeGain.gain.setTargetAtTime(
        (0.01 + rpmFactor * 0.026) * throttle * (1 + tune.engineLevel * 0.3),
        now,
        0.05,
      );
    }
    if (this.exhaustGain) {
      this.exhaustGain.gain.setTargetAtTime(
        (0.007 + throttle * 0.042 * (0.35 + rpmFactor)) * (1 + tune.exhaustLevel * 0.55),
        now,
        0.05,
      );
    }
    if (this.turboOsc && this.turboGain) {
      // Keep the whine under the engine: it used to sit on top at half revs.
      this.turboOsc.frequency.setTargetAtTime(900 + this.boost * 3400 + rpmFactor * 500, now, 0.08);
      this.turboGain.gain.setTargetAtTime(this.boost * 0.006 * (1 + tune.engineLevel * 0.4), now, 0.12);
    }
    if (this.tireGain) {
      const squeal = offRoad
        ? 0
        : Math.min(1, Math.max(0, (Math.abs(slip) - 0.12) / 0.35));
      this.tireGain.gain.setTargetAtTime(squeal * 0.12 * Math.min(1, speed / 18), now, 0.06);
    }
    if (this.gravelGain) {
      this.gravelGain.gain.setTargetAtTime(
        offRoad ? roughness * 0.085 * Math.min(1, speed / 9) : 0,
        now,
        0.09,
      );
    }
    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(Math.min(0.1, (speed * speed) / 42000), now, 0.1);
    }

    // --- Events -----------------------------------------------------------
    // Upshift under load: dual-clutch fart (a hard, short, low thump).
    if (gear > this.prevGear && this.prevThrottle > 0.35 && this.prevGear > 0) {
      this.dsgFart(this.prevThrottle, rpm);
    }
    // Lift off at revs: overrun pops, wastegate chatter and turbo flutter.
    if (this.prevThrottle > 0.55 && throttle < 0.12 && this.prevRpm > 3800) {
      const strength = Math.min(1, (this.prevRpm - 3200) / 3600);
      this.pops(2 + Math.round(strength * 6), strength * 0.9 + tune.exhaustLevel * 0.15);
      if (this.boost > 0.25) this.blowOff(this.boost);
    }
    // Bouncing off the limiter: anti-lag bangs, not a clean cut.
    if (limiter && throttle > 0.35 && now - this.lastPop > 0.09) {
      this.lastPop = now;
      this.popCount = (this.popCount + 3) % 3;
      if (this.popCount === 0) this.pops(1, 0.75 + Math.random() * 0.25);
      if (this.boost > 0.3 && Math.random() > 0.55) this.burst({
        freq: 2600,
        q: 1.2,
        type: 'bandpass',
        gain: 0.045 + this.boost * 0.045,
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
    const strength = 1 + throttle * 0.45;
    this.burst({
      freq: 150 + Math.min(1, rpm / 8000) * 90,
      q: 7,
      type: 'lowpass',
      gain: 0.26 * strength,
      decay: 0.075 + throttle * 0.05,
      attack: 0.004,
    });
    this.burst({ freq: 900, q: 1.4, type: 'bandpass', gain: 0.06 * strength, decay: 0.05 });
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
        gain: (0.12 + Math.random() * 0.13) * strength,
        decay: 0.045 + Math.random() * 0.05,
        attack: 0.002,
        delay,
      });
      if (Math.random() > 0.45) {
        this.burst({
          freq: 1500 + Math.random() * 1800,
          q: 0.9,
          type: 'bandpass',
          gain: 0.04 * strength,
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
      gain: 0.08 + boost * 0.08,
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
        gain: 0.04 * (1 - i / (chirps + 2)),
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
    const output = this.effects;
    const buffer = this.noiseBuffer;
    if (!ctx || !output || !buffer) return;

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
    gain.connect(output);
    source.start(start, Math.random() * (buffer.duration - 0.1));
    source.stop(start + attack + opts.decay + 0.02);
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.effects || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(Math.min(0.45, strength * 0.3), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effects);
    source.start(now);
    source.stop(now + 0.3);
  }

  /** Stones and gravel ticking under the sills. */
  gravelTick(): void {
    this.burst({
      freq: 900 + Math.random() * 1500,
      q: 1.4,
      type: 'bandpass',
      gain: 0.025 + Math.random() * 0.025,
      decay: 0.04,
    });
  }
}
