/**
 * Fully procedural car audio: no asset downloads, everything is oscillators
 * and filtered noise. The interesting bits are the ones car people listen for:
 * a turbo that spools and flutters, a dual-clutch fart on every upshift, and
 * anti-lag style pops when you lift or bounce off the limiter.
 *
 * Two rules keep it clean at high revs:
 *  - the engine is one phase-locked harmonic stack, with no detuned partials
 *    and no inharmonic ratio, so nothing beats like a short audio loop;
 *  - only short one-shots use the recordings. There is no continuous playback
 *    of an engine sample: a recording at its own pitch under an engine that
 *    revs is a second engine droning along, and constantly re-triggered grains
 *    of it read as a train or a broken CV joint in the background.
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
  /** Cylinders (or rotors) firing once per revolution. 4 for a four, 12 for
   *  the V12: it is what gives each car its firing frequency. */
  cylinders: number;
  /** Turbocharged engines flutter and chatter; the base engine does not. */
  turbo: boolean;
  /** 0..2, how open the exhaust is. */
  exhaustLevel: number;
  /** 0..3 engine stage: more induction noise and a harder edge. */
  engineLevel: number;
  /** A bike has a quickshifter, not a dual clutch: no DSG fart on a shift. */
  transmission?: 'dsg' | 'quickshift';
}

/**
 * Recordings used as one-shot raw material: the compressor surge on a lift.
 * They live in public/audio and are fetched at start-up. Nothing else is a
 * recording: the engine is synthesised so its pitch is the firing frequency,
 * not a sample played at some other speed.
 */
const FLUTTER_SAMPLES = ['audio/turbo-flutter-2.mp3', 'audio/turbo-flutter.mp3'];

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
  private exhaustFilter: BiquadFilterNode | null = null;
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

  /** Decoded recordings, keyed by their public path. */
  private samples = new Map<string, AudioBuffer>();
  private turboBus: GainNode | null = null;
  private flutterFlip = false;
  /** True between a lift and the next time the throttle is picked up again. */
  private lifted = false;

  /** 0..1 turbo boost pressure, integrated from throttle and revs. */
  private boost = 0;
  private prevGear = 1;
  private prevThrottle = 0;
  private prevRpm = 900;
  private lastTime = 0;
  private lastPop = 0;
  /** Last overrun burst: a jittery pedal must not machine-gun the pops. */
  private lastLift = -10;
  private popCount = 0;
  /** How many one-shot effects have fired: used by the smoke test. */
  events = 0;
  private tune: EngineTune = {
    redline: 7300,
    cylinders: 4,
    turbo: false,
    exhaustLevel: 0,
    engineLevel: 0,
  };

  constructor() {
    this.mix = loadMix();
  }

  /** Current user mix, as a copy. */
  get soundMix(): SoundMix {
    return { ...this.mix };
  }

  /** Recordings decoded so far (the smoke test checks them all arrive). */
  get loadedSamples(): number {
    return this.samples.size;
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
    this.turboBus = turboBus;
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
    this.exhaustFilter = exhaustFilter;

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

    // The compressor surge is the only recording left, and it only ever plays
    // as a one-shot when the driver lifts.
    void this.loadSamples(ctx);

    // Bursts and impacts live on the effects bus.
    this.effects = effectsBus;
    this.lastTime = ctx.currentTime;
  }

  private effects: GainNode | null = null;

  /** Decodes the provided recordings. A failed file only costs its layer. */
  private async loadSamples(ctx: AudioContext): Promise<void> {
    const base = import.meta.env.BASE_URL ?? '/';
    const urls = [...FLUTTER_SAMPLES];
    await Promise.all(
      urls.map(async (path) => {
        try {
          const response = await fetch(base + path);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          const buffer = await ctx.decodeAudioData(data);
          this.samples.set(path, buffer);
        } catch (error) {
          console.warn('[audio]', path, error);
        }
      }),
    );
  }

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

    // --- Engine tone. A four-stroke fires half its cylinders per revolution:
    // two pulses for an inline four, six for the V12, one every other turn for
    // a single. That frequency, not a pitch bend, is what makes the cars and
    // the thumper sound like different engines.
    const pulsesPerRev = Math.max(0.5, tune.cylinders * 0.5);
    const firing = Math.max(24, (rpm / 60) * pulsesPerRev);
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
    if (this.exhaustFilter) {
      // The rasp is a resonance of the exhaust, so its band follows the firing
      // frequency instead of sitting at a fixed 240 Hz: a fixed band thins out
      // as the engine revs and leaves a whistle behind.
      this.exhaustFilter.frequency.setTargetAtTime(140 + firing * 1.15, now, 0.05);
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
    // Upshift under load: dual-clutch fart (a hard, short, low thump), then the
    // unburnt fuel lighting off in the hot exhaust a moment later.
    if (gear > this.prevGear && this.prevThrottle > 0.35 && this.prevGear > 0) {
      if (tune.transmission === 'quickshift') {
        // A quickshifter cuts the ignition for a few milliseconds: one hard
        // bark through the open pipe, no torque-converter fart.
        this.bang(0.5 + Math.min(0.4, this.prevRpm / 9000), 0.03);
      } else {
        this.dsgFart(this.prevThrottle, rpm);
        if (tune.exhaustLevel > 0 || this.prevRpm > 4500) {
          this.bang(0.45 + Math.min(0.5, this.prevRpm / 8000), 0.06 + Math.random() * 0.05);
        }
      }
    }
    // Lift off at revs: overrun bangs, wastegate chatter and turbo flutter.
    // The pedals are smoothed, so a lift never crosses from 1 to 0 in a single
    // frame: the old test needed exactly that, which is why no pop and no
    // "stu stu stu" ever played. Crossing a threshold once is what fires.
    if (throttle < 0.5 && this.prevThrottle >= 0.5 && !this.lifted) {
      this.lifted = true;
      if (this.prevRpm > 3200 && now - this.lastLift > 0.9) {
        this.lastLift = now;
        const strength = Math.min(1, (this.prevRpm - 2600) / 3800);
        this.pops(3 + Math.round(strength * 5), strength * 0.95 + tune.exhaustLevel * 0.15);
        if (this.boost > 0.18) this.blowOff(this.boost);
        // The recording is the "stu stu stu" itself: the synthesized chirps sit
        // under it, they never carry it on their own.
        if (tune.turbo && this.boost > 0.1) this.flutter(this.boost);
      }
    }
    if (throttle > 0.62) this.lifted = false;
    // Bouncing off the limiter: anti-lag bangs, not a clean cut.
    if (limiter && throttle > 0.35 && now - this.lastPop > 0.16) {
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

  /**
   * The BRAP of a dual-clutch upshift. A filtered noise burst only ever sounds
   * like a hiss, so the fart is a saw whose pitch collapses through a resonant
   * lowpass, with the clutch slap on top.
   */
  private dsgFart(throttle: number, rpm: number): void {
    const ctx = this.ctx;
    const output = this.effects;
    if (!ctx || !output) return;
    this.events++;
    const strength = 1 + throttle * 0.45;
    const now = ctx.currentTime;
    const base = 96 + Math.min(1, rpm / 8000) * 46;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * 1.15, now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.52, now + 0.11);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 7;
    filter.frequency.setValueAtTime(780, now);
    filter.frequency.exponentialRampToValueAtTime(260, now + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3 * strength, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    osc.start(now);
    osc.stop(now + 0.15);

    this.burst({ freq: 1400, q: 1.6, type: 'bandpass', gain: 0.05 * strength, decay: 0.03 });
  }

  /**
   * One exhaust bang: the crack of the ignition, the thump of the pressure
   * wave, and a little grit in between.
   */
  private bang(strength: number, delay = 0): void {
    const ctx = this.ctx;
    const output = this.effects;
    if (!ctx || !output) return;
    this.events++;
    const now = ctx.currentTime + delay;
    this.burst({
      freq: 2000 + Math.random() * 1600,
      q: 0.8,
      type: 'bandpass',
      gain: 0.34 * strength,
      decay: 0.04,
      attack: 0.001,
      delay,
    });
    this.burst({
      freq: 240 + Math.random() * 140,
      q: 1.1,
      type: 'lowpass',
      gain: 0.5 * strength,
      decay: 0.14,
      attack: 0.002,
      delay,
    });
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const start = now;
    osc.frequency.setValueAtTime(120 + Math.random() * 50, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28 * strength, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    osc.connect(gain);
    gain.connect(output);
    osc.start(start);
    osc.stop(start + 0.13);
  }

  /** Overrun bangs: a handful of uneven shots, never a machine gun. */
  private pops(count: number, strength: number): void {
    if (!this.ctx) return;
    for (let i = 0; i < count; i++) {
      const delay = i * (0.035 + Math.random() * 0.05);
      this.bang((0.55 + Math.random() * 0.45) * Math.max(0.35, strength), delay);
    }
  }

  /** Blow-off "psh" with the compressor chirping under it. The recorded surge
   * is triggered by the caller, so a lift never plays it twice. */
  private blowOff(boost: number): void {
    if (!this.ctx) return;
    this.events++;
    const output = this.turboBus;
    this.burst({
      freq: 1900,
      q: 0.8,
      type: 'bandpass',
      gain: 0.08 + boost * 0.08,
      decay: 0.14,
      attack: 0.006,
      sweepTo: 900,
      output,
    });
    const chirps = 4 + Math.round(boost * 4);
    for (let i = 0; i < chirps; i++) {
      this.burst({
        freq: 2400 - i * 120,
        q: 2.6,
        type: 'bandpass',
        gain: 0.04 * (1 - i / (chirps + 2)),
        decay: 0.03,
        attack: 0.002,
        delay: 0.03 + i * 0.042,
        output,
      });
    }
  }

  /**
   * The recorded compressor surge. It is a decaying burst, so it is played as a
   * one-shot at whatever pitch the boost asks for; the two recordings alternate
   * so two lifts in a row do not sound copy-pasted.
   */
  private flutter(boost: number): void {
    const ctx = this.ctx;
    // On the turbo bus, not the effects one: the flutter is the turbo voice, so
    // its fader has to move it and nothing else.
    const output = this.turboBus;
    if (!ctx || !output) return;
    const path = FLUTTER_SAMPLES[this.flutterFlip ? 1 : 0];
    this.flutterFlip = !this.flutterFlip;
    const buffer = this.samples.get(path);
    if (!buffer) return;
    this.events++;
    const now = ctx.currentTime;
    const rate = 0.88 + boost * 0.4 + Math.random() * 0.06;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 5200 + boost * 2400;
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    // Audible on a lift without sitting on top of everything: the default
    // turbo channel sits well under the engine now, and the player has a fader.
    const peak = 0.4 + boost * 0.3;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.015);
    gain.gain.setValueAtTime(peak, now + 0.35 / rate);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + buffer.duration / rate);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    source.start(now);
    source.stop(now + buffer.duration / rate + 0.05);
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
    /** Overrides the effects bus, for a voice that belongs to another fader. */
    output?: GainNode | null;
  }): void {
    const ctx = this.ctx;
    const output = opts.output ?? this.effects;
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

  /** Tail unit grinding the road: a short bright scrape, not a crash. */
  scrape(strength: number): void {
    if (!this.ctx) return;
    this.events++;
    this.burst({
      freq: 2600 + Math.random() * 1800,
      q: 0.8,
      type: 'highpass',
      gain: 0.012 + strength * 0.022,
      decay: 0.07 + Math.random() * 0.05,
    });
    this.burst({
      freq: 780 + Math.random() * 260,
      q: 1.5,
      gain: 0.01 + strength * 0.014,
      decay: 0.1 + Math.random() * 0.06,
    });
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
