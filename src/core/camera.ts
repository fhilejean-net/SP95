import * as THREE from 'three';

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private current = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private initialized = false;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
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
  ): void {
    if (!this.initialized) {
      this.snap(position, forward, terrainHeight(position.x, position.z));
      return;
    }

    const yaw = Math.atan2(-forward.x, -forward.z) + orbitYaw;
    const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const distance = 6.2 + Math.min(2.6, speed * 0.035) + zoom;
    const height = 1.85 + Math.min(1.1, speed * 0.012) + orbitPitch * 4.5;

    this.desired.copy(position).addScaledVector(behind, distance);
    this.desired.y = position.y + height;

    const ground = terrainHeight(this.desired.x, this.desired.z);
    if (this.desired.y < ground + 0.6) this.desired.y = ground + 0.6;

    const posAlpha = 1 - Math.exp(-dt * 7.5);
    this.current.lerp(this.desired, posAlpha);

    const lookAhead = 6 + Math.min(12, speed * 0.16);
    this.lookTarget.copy(position).addScaledVector(forward, lookAhead);
    this.lookTarget.y = position.y + 1.05;
    const lookAlpha = 1 - Math.exp(-dt * 11);
    this.look.lerp(this.lookTarget, lookAlpha);

    this.camera.position.copy(this.current);
    this.camera.lookAt(this.look);

    const targetFov = 60 + Math.min(16, speed * 0.3);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 3));
    this.camera.updateProjectionMatrix();
  }
}
