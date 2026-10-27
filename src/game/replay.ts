/**
 * The replay memory: the last few seconds of the player's poses, and nothing
 * else. It never records inputs, physics state or score — a replay only reads
 * these poses back, so starting or leaving one cannot change the live game.
 *
 * Once the buffer is full the oldest frame is dropped, so a long session costs
 * exactly as much as a short one.
 */

export interface PoseSample {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface ReplayPose extends PoseSample {
  /** Seconds since the recording started. */
  t: number;
}

export class ReplayBuffer {
  /** Frames kept; the oldest is dropped once full. */
  readonly capacity: number;
  /** Minimum seconds between two stored frames. */
  readonly interval: number;
  private poses: ReplayPose[] = [];
  private origin = Number.NaN;
  private lastRecorded = Number.NEGATIVE_INFINITY;

  constructor(capacity = 120, interval = 0.08) {
    this.capacity = capacity;
    this.interval = interval;
  }

  get frames(): number {
    return this.poses.length;
  }

  /** Seconds covered by the frames still in memory. */
  get duration(): number {
    if (this.poses.length < 2) return 0;
    return this.poses[this.poses.length - 1].t - this.poses[0].t;
  }

  get full(): boolean {
    return this.poses.length >= this.capacity;
  }

  /** Stores a pose once `interval` has passed since the last one. */
  record(pose: PoseSample, now: number): boolean {
    if (!Number.isFinite(this.origin)) this.origin = now;
    if (now - this.lastRecorded < this.interval) return false;
    this.lastRecorded = now;
    this.poses.push({ ...pose, t: now - this.origin });
    // Rebase on the oldest frame still kept, so `t` always runs from zero and
    // playback length stays what the capacity says instead of the session age.
    if (this.poses.length > this.capacity) {
      const dropped = this.poses.shift();
      if (dropped) {
        this.origin += dropped.t;
        for (const kept of this.poses) kept.t -= dropped.t;
      }
    }
    return true;
  }

  /** Ordered copy, oldest first, so playback cannot mutate the memory. */
  snapshot(): ReplayPose[] {
    return this.poses.map((pose) => ({ ...pose }));
  }

  reset(): void {
    this.poses = [];
    this.origin = Number.NaN;
    this.lastRecorded = Number.NEGATIVE_INFINITY;
  }
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * The pose `elapsed` seconds into a snapshot, interpolated between the two
 * frames that straddle that instant and clamped at both ends. Quaternions are
 * blended on the shortest arc, then normalised: at 12 Hz the steps are small,
 * so a normalised lerp is indistinguishable from a slerp here.
 */
export function samplePoses(poses: ReplayPose[], elapsed: number): ReplayPose | null {
  if (poses.length === 0) return null;
  const first = poses[0];
  if (poses.length === 1 || elapsed <= 0) return { ...first };
  const last = poses[poses.length - 1];
  if (elapsed >= last.t) return { ...last };

  let index = 1;
  while (index < poses.length && poses[index].t < elapsed) index++;
  const a = poses[index - 1];
  const b = poses[index];
  const span = b.t - a.t;
  const k = span > 1e-6 ? (elapsed - a.t) / span : 0;
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    z: lerp(a.z, b.z, k),
    ...blendQuat(a, b, k),
    t: elapsed,
  };
}

function blendQuat(a: PoseSample, b: PoseSample, k: number): Omit<PoseSample, 'x' | 'y' | 'z'> {
  const dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw;
  const sign = dot < 0 ? -1 : 1;
  const qx = lerp(a.qx, b.qx * sign, k);
  const qy = lerp(a.qy, b.qy * sign, k);
  const qz = lerp(a.qz, b.qz * sign, k);
  const qw = lerp(a.qw, b.qw * sign, k);
  const length = Math.hypot(qx, qy, qz, qw) || 1;
  return { qx: qx / length, qy: qy / length, qz: qz / length, qw: qw / length };
}
