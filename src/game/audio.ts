/** Fully procedural car audio: no asset downloads, everything is oscillators
 *  and filtered noise. */
export class CarAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private exhaustGain: GainNode | null = null;
  private tireGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  started = false;

  init(): void {
    if (this.started) {
      this.ctx?.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    this.ctx = ctx;
    this.started = true;

    const master = ctx.createGain();
    master.gain.value = 0.55;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    this.master = master;

    // White noise buffer shared by exhaust, tires and wind.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    // Engine: two detuned saws plus a sub.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 1.1;
    engineGain.connect(filter);
    filter.connect(master);
    this.engineGain = engineGain;
    this.engineFilter = filter;

    const makeOsc = (type: OscillatorType, ratio: number, gainValue: number) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 60;
      const gain = ctx.createGain();
      gain.gain.value = gainValue;
      osc.connect(gain);
      gain.connect(engineGain);
      osc.start();
      void ratio;
      return osc;
    };
    this.oscA = makeOsc('sawtooth', 1, 0.5);
    this.oscB = makeOsc('square', 1.5, 0.18);
    this.oscSub = makeOsc('sine', 0.5, 0.35);

    // Exhaust rasp.
    const exhaust = ctx.createBufferSource();
    exhaust.buffer = buffer;
    exhaust.loop = true;
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.frequency.value = 260;
    exhaustFilter.Q.value = 0.9;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    exhaust.connect(exhaustFilter);
    exhaustFilter.connect(exhaustGain);
    exhaustGain.connect(master);
    exhaust.start();
    this.exhaustGain = exhaustGain;

    // Tire squeal.
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

    // Wind.
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
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.oscA || !this.oscB || !this.oscSub) return;
    const now = ctx.currentTime;
    const { rpm, throttle, speed, slip, gear, grounded } = params;

    const firing = Math.max(26, (rpm / 60) * 2.1);
    this.oscA.frequency.setTargetAtTime(firing, now, 0.035);
    this.oscB.frequency.setTargetAtTime(firing * 1.495, now, 0.035);
    this.oscSub.frequency.setTargetAtTime(firing * 0.5, now, 0.04);

    const load = Math.max(0.12, throttle);
    const rpmFactor = Math.min(1, Math.max(0, (rpm - 700) / 6800));
    this.engineGain.gain.setTargetAtTime(
      (0.035 + rpmFactor * 0.09) * (grounded ? 1 : 0.6) * (0.55 + load * 0.45),
      now,
      0.05,
    );
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(700 + rpmFactor * 3200 + throttle * 500, now, 0.06);
    }
    if (this.exhaustGain) {
      this.exhaustGain.gain.setTargetAtTime(0.01 + throttle * 0.055 * (0.4 + rpmFactor), now, 0.05);
    }
    if (this.tireGain) {
      const squeal = Math.min(1, Math.max(0, (Math.abs(slip) - 0.12) / 0.35));
      this.tireGain.gain.setTargetAtTime(squeal * 0.16 * Math.min(1, speed / 18), now, 0.06);
    }
    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(Math.min(0.12, (speed * speed) / 42000), now, 0.1);
    }
    void gear;
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
}
