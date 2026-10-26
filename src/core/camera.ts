import * as THREE from 'three';

/**
 * Returns how much of the segment `from` -> `to` is free, in 0..1. Used to keep
 * the chase camera out of walls: a camera inside a building renders the black
 * inside of its box, which players read as the screen going black.
 */
export type ClearanceProbe = (from: THREE.Vector3, to: THREE.Vector3) => number;

/**
 * The points of view the player can cycle with `C`. The chase cameras orbit the
 * vehicle; the three onboard ones are bolted to it.
 */
export type CameraMode = 'chase' | 'near' | 'hood' | 'cockpit' | 'bumper';

export const CAMERA_MODES: CameraMode[] = ['chase', 'near', 'hood', 'cockpit', 'bumper'];

export function cameraModeLabel(mode: CameraMode): string {
  switch (mode) {
    case 'near':
      return 'Poursuite serrée';
    case 'hood':
      return 'Capot';
    case 'cockpit':
      return 'Poste de conduite';
    case 'bumper':
      return 'Pare-chocs';
    default:
      return 'Poursuite';
  }
}

/** Onboard rigs, in metres from the body origin (the contact patch). */
const ONBOARD: Record<'hood' | 'cockpit' | 'bumper', { car: [number, number]; bike: [number, number] }> = {
  // [forward, up]
  hood: { car: [1.55, 1.12], bike: [0.48, 1.02] },
  cockpit: { car: [0.15, 1.12], bike: [-0.02, 1.46] },
  bumper: { car: [2.05, 0.62], bike: [0.62, 0.6] },
};

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Current point of view; `C` cycles through CAMERA_MODES. */
  mode: CameraMode = 'chase';
  private current = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private initialized = false;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  nextMode(): CameraMode {
    const index = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(index + 1) % CAMERA_MODES.length];
    // The onboard rigs are bolted on: snapping kills the one-frame slide from
    // the old chase position.
    this.initialized = this.mode === 'chase' || this.mode === 'near';
    return this.mode;
  }

  private get onboard(): boolean {
    return this.mode === 'hood' || this.mode === 'cockpit' || this.mode === 'bumper';
  }

  snap(position: THREE.Vector3, forward: THREE.Vector3, ground: number): void {
    const yaw = Math.atan2(-forward.x, -forward.z);
    const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.current.copy(position).addScaledVector(behind, 6.5);
    this.current.y = Math.max(position.y + 1.9, ground + 0.8);
    this.look.copy(position).addScaledVector(forward, 7);
    this.look.y = position.y + 1.1;
    this.camera.position.copy(this.current);
    this.camera.lookAt(this.look);
    this.initialized = true;
  }

  update(
    dt: number,
    position: THREE.Vector3,
    forward: THREE.Vector3,
    speed: number,
    orbitYaw: number,
    orbitPitch: number,
    zoom: number,
    terrainHeight: (x: number, z: number) => number,
    clearance?: ClearanceProbe,
    vehicle: 'car' | 'bike' = 'car',
  ): void {
    if (!this.initialized) {
      this.snap(position, forward, terrainHeight(position.x, position.z));
      this.initialized = true;
    }

    const bike = vehicle === 'bike';

    if (this.onboard) {
      // Bolted to the vehicle: no smoothing on the rig itself, only on the
      // head, so the horizon stays readable while the chassis works.
      const anchors = ONBOARD[this.mode as 'hood' | 'cockpit' | 'bumper'][bike ? 'bike' : 'car'];
      this.current.copy(position).addScaledVector(forward, anchors[0]);
      this.current.y += anchors[1];

      const yawTotal = Math.atan2(-forward.x, -forward.z) + orbitYaw;
      const viewX = -Math.sin(yawTotal);
      const viewZ = -Math.cos(yawTotal);
      this.camera.position.copy(this.current);
      // Look far enough ahead that the road does not crawl: 30 m at the
      // horizon, biased by the head pitch.
      this.look.set(
        this.current.x + viewX * 24,
        this.current.y + orbitPitch * 9 - (this.mode === 'bumper' ? 0.12 : 0.02),
        this.current.z + viewZ * 24,
      );
      this.camera.lookAt(this.look);

      const onboardFov = this.mode === 'cockpit' ? 68 : this.mode === 'hood' ? 64 : 62;
      this.camera.fov += (onboardFov + Math.min(10, speed * 0.18) - this.camera.fov) * (1 - Math.exp(-dt * 6));
      this.camera.updateProjectionMatrix();
      return;
    }

    const yaw = Math.atan2(-forward.x, -forward.z) + orbitYaw;
    const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    // A bike is smaller and its rider's head sits where a car's roof would be:
    // the car framing left it looking like a toy in the middle of the road.
    const near = this.mode === 'near';
    const base = near ? (bike ? 3.1 : 4.4) : bike ? 4.3 : 6.2;
    const stretch = near ? (bike ? 0.9 : 1.6) : bike ? 1.3 : 2.6;
    const distance = base + Math.min(stretch, speed * 0.035) + zoom;
    const height =
      (near ? (bike ? 1.15 : 1.45) : bike ? 1.35 : 1.85) + Math.min(1.1, speed * 0.012) + orbitPitch * 4.5;

    this.desired.copy(position).addScaledVector(behind, distance);
    this.desired.y = position.y + height;

    const ground = terrainHeight(this.desired.x, this.desired.z);
    if (this.desired.y < ground + 0.6) this.desired.y = ground + 0.6;

    const posAlpha = 1 - Math.exp(-dt * 7.5);
    this.current.lerp(this.desired, posAlpha);

    // Pull the camera in front of whatever it would otherwise sit inside.
    if (clearance) {
      this.pivot.set(position.x, position.y + 1.15, position.z);
      this.offset.copy(this.current).sub(this.pivot);
      const wanted = this.offset.length();
      if (wanted > 0.4) {
        const free = clearance(this.pivot, this.current);
        const allowed = Math.max(1.9, wanted * free);
        if (allowed < wanted) {
          this.current.copy(this.pivot).addScaledVector(this.offset, allowed / wanted);
        }
      }
    }

    // Orbiting means the camera walks around the vehicle. The look target has
    // to follow it to the centre of the frame, otherwise the car slides out of
    // shot while the camera turns around it.
    const orbit = Math.min(1, Math.abs(orbitYaw) / 0.6);
    const lookAhead = ((bike ? 7 : 6) + Math.min(12, speed * 0.16)) * (1 - orbit);
    this.lookTarget.copy(position).addScaledVector(forward, lookAhead);
    this.lookTarget.y = position.y + (bike ? 0.85 : 1.05);
    const lookAlpha = 1 - Math.exp(-dt * 11);
    this.look.lerp(this.lookTarget, lookAlpha);

    this.camera.position.copy(this.current);
    this.camera.lookAt(this.look);

    const targetFov = 60 + Math.min(16, speed * 0.3);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 3));
    this.camera.updateProjectionMatrix();
  }
}
