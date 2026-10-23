import * as THREE from 'three';

export type RacePhase = 'countdown' | 'running' | 'finished';

const BEST_LAP_KEY = 'sp95.bestLap';

export interface RaceSnapshot {
  phase: RacePhase;
  countdown: number;
  lap: number;
  totalLaps: number;
  lapTime: number;
  totalTime: number;
  lastLap: number;
  bestLap: number | null;
  nextCheckpoint: number;
  checkpointDistance: number;
}

export class Race {
  phase: RacePhase = 'countdown';
  countdown = 3.4;
  lap = 1;
  readonly totalLaps = 2;
  lapTime = 0;
  totalTime = 0;
  lastLap = 0;
  bestLap: number | null = null;
  next = 1;
  countdownJustFinished = false;
  private lastBeep = 4;
  readonly checkpoints: THREE.Vector3[];
  readonly checkpointRadius: number;

  constructor(checkpoints: THREE.Vector3[], checkpointRadius = 17) {
    this.checkpoints = checkpoints;
    this.checkpointRadius = checkpointRadius;
    try {
      const stored = localStorage.getItem(BEST_LAP_KEY);
      if (stored) {
        const value = Number.parseFloat(stored);
        if (Number.isFinite(value)) this.bestLap = value;
      }
    } catch {
      // Storage can be unavailable in private mode; ignore.
    }
  }

  get locked(): boolean {
    return this.phase === 'countdown';
  }

  update(dt: number, position: THREE.Vector3): 'lap' | 'finish' | 'go' | 'beep' | null {
    this.countdownJustFinished = false;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      this.totalTime = 0;
      const beepAt = Math.ceil(this.countdown);
      if (beepAt < this.lastBeep && beepAt > 0) {
        this.lastBeep = beepAt;
        return 'beep';
      }
      if (this.countdown <= 0) {
        this.phase = 'running';
        this.countdown = 0;
        this.lapTime = 0;
        this.countdownJustFinished = true;
        return 'go';
      }
      return null;
    }

    if (this.phase !== 'running') return null;

    this.lapTime += dt;
    this.totalTime += dt;

    const cp = this.checkpoints[this.next];
    const dx = position.x - cp.x;
    const dz = position.z - cp.z;
    const distance = Math.hypot(dx, dz);
    if (distance < this.checkpointRadius) {
      if (this.next === 0) {
        // Crossed the start / finish line with every checkpoint behind us.
        this.lastLap = this.lapTime;
        if (this.bestLap === null || this.lapTime < this.bestLap) {
          this.bestLap = this.lapTime;
          try {
            localStorage.setItem(BEST_LAP_KEY, String(this.lapTime));
          } catch {
            // Ignore storage failures.
          }
        }
        if (this.lap >= this.totalLaps) {
          this.phase = 'finished';
          return 'finish';
        }
        this.lap += 1;
        this.lapTime = 0;
        this.next = 1;
        return 'lap';
      }
      this.next = (this.next + 1) % this.checkpoints.length;
    }
    return null;
  }

  snapshot(position?: THREE.Vector3): RaceSnapshot {
    const cp = this.checkpoints[this.next];
    const distance = position ? Math.hypot(position.x - cp.x, position.z - cp.z) : 0;
    return {
      phase: this.phase,
      countdown: Math.max(0, this.countdown),
      lap: this.lap,
      totalLaps: this.totalLaps,
      lapTime: this.lapTime,
      totalTime: this.totalTime,
      lastLap: this.lastLap,
      bestLap: this.bestLap,
      nextCheckpoint: this.next,
      checkpointDistance: distance,
    };
  }

  /** Pose on the checkpoint the player must reach, used for resets. */
  respawnPose(): { x: number; z: number; heading: number } {
    const target = this.checkpoints[this.next];
    const previous = this.checkpoints[(this.next - 1 + this.checkpoints.length) % this.checkpoints.length];
    const dx = target.x - previous.x;
    const dz = target.z - previous.z;
    const base = this.checkpoints[(this.next - 1 + this.checkpoints.length) % this.checkpoints.length];
    return {
      x: base.x,
      z: base.z,
      heading: Math.atan2(-dx, -dz),
    };
  }

  static formatTime(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '—';
    const total = Math.max(0, seconds);
    const minutes = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    const hundredths = Math.floor((total * 100) % 100);
    return `${minutes}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
  }
}
