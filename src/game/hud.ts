import {
  DIRT_TRACKS,
  DRIFT_PAD,
  MOUNTAIN_ROADS,
  RACE_START,
  SAMPLED_ROADS,
  SUMMIT,
  WORLD_SIZE,
  CIRCUIT,
} from '../world/layout.ts';
import { Race, type RaceSnapshot } from './race.ts';

export type GameMode = 'menu' | 'free' | 'race';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing HUD element #${id}`);
  return node as T;
}

export class Hud {
  private modeBadge = el('mode-badge');
  private racePanel = el('race-panel');
  private raceLap = el('race-lap');
  private raceTime = el('race-time');
  private raceBest = el('race-best');
  private driftTotal = el('drift-total');
  private driftPanel = el('drift-panel');
  private driftPoints = el('drift-points');
  private driftMult = el('drift-mult');
  private driftWrap = el('drift-total-wrap');
  private stuntWrap = el('stunt-total-wrap');
  private stuntPanel = el('stunt-panel');
  private stuntTotal = el('stunt-total');
  private stuntPoints = el('stunt-points');
  private stuntMult = el('stunt-mult');
  private stuntLabel = el('stunt-label');
  private stuntAngle = el('stunt-angle');
  private bikePreset = el('bike-preset');
  private tcsChip = el('tcs-chip');
  private absChip = el('abs-chip');
  private wheelieChip = el('wheelie-chip');
  private hint = el('hint');
  private speedValue = el('speed-value');
  private gearValue = el('gear');
  private rpmFill = el('rpm-fill');
  private rpmValue = el('rpm-value');
  private rpmReadout = el('rpm-readout');
  private rpmMax = el('rpm-max');
  private message = el('message');
  private minimap = el<HTMLCanvasElement>('minimap');
  private minimapBase: HTMLCanvasElement;
  private messageTimer = 0;
  private messageSeq = 0;
  private mapScale = 1;
  private mapCenter = 0;
  private lastSpeed = -1;
  private lastGear = -99;
  private lastRpm = -1;
  /** Le panneau des tours sert aussi de chrono en conduite libre chronométrée. */
  private chrono = false;

  constructor() {
    this.minimapBase = document.createElement('canvas');
    this.minimapBase.width = this.minimap.width;
    this.minimapBase.height = this.minimap.height;
    this.mapCenter = this.minimap.width / 2;
    // The col reaches the far corner, so the whole world has to fit.
    this.mapScale = (this.minimap.width - 10) / (WORLD_SIZE + 120);
    this.drawMinimapBase();
  }

  private drawMinimapBase(): void {
    const ctx = this.minimapBase.getContext('2d');
    if (!ctx) return;
    const cx = this.mapCenter;
    const cy = this.mapCenter;
    const s = this.mapScale;
    ctx.clearRect(0, 0, this.minimapBase.width, this.minimapBase.height);

    // La carte du circuit n'a que son emprise : sa dalle, en pointillés. Rien
    // d'autre n'existe autour, la mini-carte de la ville ne doit pas s'y
    // superposer (ses routes sont dans les données, pas dans ce monde-ci).
    if (CIRCUIT.active) {
      const circuitHalfX = CIRCUIT.plateHalfX * CIRCUIT.scale;
      const circuitHalfZ = CIRCUIT.plateHalfZ * CIRCUIT.scale;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(226,232,240,0.55)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(
        cx + (CIRCUIT.cx - circuitHalfX) * s,
        cy + (CIRCUIT.cz - circuitHalfZ) * s,
        circuitHalfX * 2 * s,
        circuitHalfZ * 2 * s,
      );
      ctx.restore();
      return;
    }

    for (const road of SAMPLED_ROADS) {
      if (road.def.id === 'ring') continue;
      ctx.beginPath();
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const x = cx + p.x * s;
        const y = cy + p.z * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = road.def.kind === 'city' ? 'rgba(150,160,172,0.5)' : 'rgba(170,180,192,0.6)';
      ctx.lineWidth = road.def.kind === 'city' ? 1.6 : 2.4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    for (const road of MOUNTAIN_ROADS) {
      ctx.beginPath();
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const x = cx + p.x * s;
        const y = cy + p.z * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(242,163,60,0.75)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    for (const road of DIRT_TRACKS) {
      ctx.beginPath();
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const x = cx + p.x * s;
        const y = cy + p.z * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (road.def.closed) ctx.closePath();
      ctx.strokeStyle = 'rgba(176,131,80,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const summitRadius = Math.max(3, SUMMIT.radius * s);
    ctx.beginPath();
    ctx.arc(cx + SUMMIT.cx * s, cy + SUMMIT.cz * s, summitRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(242,163,60,0.22)';
    ctx.fill();

    const ring = SAMPLED_ROADS.find((r) => r.def.id === 'ring');
    if (ring) {
      ctx.beginPath();
      for (let i = 0; i <= ring.points.length; i++) {
        const p = ring.points[i % ring.points.length];
        const x = cx + p.x * s;
        const y = cy + p.z * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(242,163,60,0.8)';
      ctx.lineWidth = 3.2;
      ctx.stroke();
    }

    // Drift pad.
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(
      cx + (DRIFT_PAD.cx - DRIFT_PAD.halfX) * s,
      cy + (DRIFT_PAD.cz - DRIFT_PAD.halfZ) * s,
      DRIFT_PAD.halfX * 2 * s,
      DRIFT_PAD.halfZ * 2 * s,
    );

    // Start line tick.
    ctx.fillStyle = '#f6f2e7';
    ctx.fillRect(cx + RACE_START.x * s - 1.5, cy + RACE_START.z * s - 1.5, 3, 3);
  }

  /** `track` remplace le libellé du mode quand la carte n'est pas la ville. */
  setMode(mode: GameMode, track?: string): void {
    this.racePanel.classList.toggle('hidden', mode !== 'race' && !this.chrono);
    this.modeBadge.textContent =
      track ??
      (mode === 'race' ? 'Course · 2 tours' : mode === 'free' ? 'Conduite libre' : 'SP95');
  }

  updateSpeed(kmh: number, gear: number, rpm: number, redline: number): void {
    const rounded = Math.round(kmh);
    if (rounded !== this.lastSpeed) {
      this.speedValue.textContent = String(rounded);
      this.lastSpeed = rounded;
    }
    if (gear !== this.lastGear) {
      this.gearValue.textContent = gear === -1 ? 'R' : gear === 0 ? 'N' : String(gear);
      this.lastGear = gear;
    }
    const shown = Math.round(rpm / 10) * 10;
    if (shown !== this.lastRpm) {
      this.lastRpm = shown;
      this.rpmValue.textContent = shown.toLocaleString('fr-FR');
      this.rpmReadout.classList.toggle('redline', rpm > redline * 0.93);
    }
    const ratio = redline > 0 ? rpm / redline : 0;
    this.rpmFill.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`;
  }

  /** Redline follows the garage spec: a Stage 3 engine does not rev like stock. */
  setRedline(redline: number): void {
    this.rpmMax.textContent = `/ ${redline.toLocaleString('fr-FR')}`;
  }

  updateDrift(pending: number, total: number, multiplier: number, active: boolean): void {
    this.driftTotal.textContent = String(Math.round(total));
    this.driftPanel.classList.toggle('active', active || pending > 10);
    this.driftPoints.textContent = String(Math.round(pending));
    this.driftMult.textContent = `×${multiplier}`;
  }

  /**
   * Swaps the whole scoring language: a car banks drifts, a bike banks
   * wheelies, and the two panels never show at once.
   */
  setVehicle(kind: 'car' | 'bike'): void {
    const bike = kind === 'bike';
    this.driftWrap.classList.toggle('hidden', bike);
    this.stuntWrap.classList.toggle('hidden', !bike);
    this.driftPanel.classList.toggle('hidden', bike);
    this.stuntPanel.classList.toggle('hidden', !bike);
    this.tcsChip.classList.toggle('hidden', bike);
    this.absChip.classList.toggle('hidden', bike);
    this.wheelieChip.classList.toggle('hidden', !bike);
    this.hint.textContent = bike
      ? 'Espace wheelie · S frein et marche arrière · C caméra · ZQSD conduire · Échap pause'
      : 'ZQSD conduire · Espace frein à main · T antipatinage · Souris caméra · Échap pause';
    // On a bike the handbrake button has nothing to pull: it becomes the
    // one-touch wheelie, right where the thumb already is.
    const touch = document.getElementById('touch-handbrake');
    if (touch) touch.textContent = bike ? 'WHEELIE' : 'DRIFT';
  }

  updateStunt(
    pending: number,
    total: number,
    multiplier: number,
    active: boolean,
    deep: boolean,
    angleDeg: number,
  ): void {
    this.stuntTotal.textContent = String(Math.round(total));
    this.stuntPanel.classList.toggle('active', active || pending > 10);
    this.stuntPoints.textContent = String(Math.round(pending));
    this.stuntMult.textContent = `×${multiplier}`;
    this.stuntLabel.textContent = deep ? 'BAVETTE' : 'WHEELIE';
    this.stuntLabel.classList.toggle('bavette', deep);
    this.stuntAngle.textContent = `${Math.round(angleDeg)}°`;
  }

  /** Nom du réglage monté sur la moto : preset de l'atelier ou « réglage perso ». */
  setBikePreset(label: string): void {
    this.bikePreset.textContent = label;
  }

  /** The assist is on unless the driver turned it off: the chip shows both. */
  setTcs(enabled: boolean): void {
    this.tcsChip.classList.toggle('off', !enabled);
    this.tcsChip.classList.toggle('on', enabled);
    this.tcsChip.title = enabled
      ? 'Antipatinage actif — T ou le menu pause pour le couper'
      : 'Antipatinage coupé — T pour le remettre';
  }

  /** Même témoin que l'antipatinage, pour les freins : B ou le menu pause. */
  setAbs(enabled: boolean): void {
    this.absChip.classList.toggle('off', !enabled);
    this.absChip.classList.toggle('on', enabled);
    this.absChip.title = enabled
      ? 'ABS actif — B ou le menu pause pour le couper'
      : 'ABS coupé — B pour le remettre';
  }

  /**
   * Le chrono de la piste : le tour en cours, le meilleur. Sur la carte du
   * circuit, la conduite libre est chronométrée sans qu'il y ait de course à
   * gagner — c'est le panneau des tours, avec un autre libellé.
   */
  setChrono(on: boolean): void {
    this.chrono = on;
    this.racePanel.classList.toggle('hidden', !on);
  }

  updateChrono(lap: number, current: number, best: number | null): void {
    this.raceLap.textContent = lap > 0 ? String(lap) : '—';
    this.raceTime.textContent = Race.formatTime(current);
    this.raceBest.textContent = Race.formatTime(best);
  }

  updateRace(snapshot: RaceSnapshot | null): void {
    if (!snapshot) return;
    this.raceLap.textContent = `${Math.min(snapshot.lap, snapshot.totalLaps)} / ${snapshot.totalLaps}`;
    this.raceTime.textContent = Race.formatTime(snapshot.lapTime);
    this.raceBest.textContent = Race.formatTime(snapshot.bestLap);
  }

  drawMinimap(
    x: number,
    z: number,
    yaw: number,
    nextCheckpoint: { x: number; z: number } | null,
  ): void {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;
    const cx = this.mapCenter;
    const cy = this.mapCenter;
    const s = this.mapScale;
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(this.minimapBase, 0, 0);

    if (nextCheckpoint) {
      const px = cx + nextCheckpoint.x * s;
      const py = cy + nextCheckpoint.z * s;
      const pulse = 3.5 + Math.sin(performance.now() / 220) * 1.2;
      ctx.beginPath();
      ctx.arc(px, py, pulse + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242,163,60,0.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, pulse, 0, Math.PI * 2);
      ctx.fillStyle = '#f2a33c';
      ctx.fill();
    }

    ctx.save();
    ctx.translate(cx + x * s, cy + z * s);
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.4, 5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-4.4, 5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#111418';
    ctx.stroke();
    ctx.restore();
  }

  flash(text: string, options: { accent?: boolean; duration?: number } = {}): void {
    this.message.textContent = text;
    this.message.classList.toggle('accent', options.accent ?? false);
    this.message.classList.add('show');
    this.messageTimer = options.duration ?? 1400;
    const seq = ++this.messageSeq;
    window.setTimeout(() => {
      if (this.messageSeq === seq) {
        this.message.classList.remove('show');
        this.messageTimer = 0;
      }
    }, this.messageTimer);
  }

  hideMessage(): void {
    this.messageTimer = 0;
    this.messageSeq++;
    this.message.classList.remove('show');
  }
}
