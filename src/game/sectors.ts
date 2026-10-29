/**
 * Les secteurs d'un tour : trois portions de piste, chronométrées séparément.
 *
 * Un tour se perd rarement en un point : il se perd dans un enchaînement. Le
 * temps du tour ne dit pas *où* ; les secteurs, oui. Chaque secteur est comparé
 * au même secteur du meilleur tour, et la différence est écrite en secondes —
 * négative en vert quand on gagne, positive en rouge quand on perd.
 *
 * Aucune dépendance au rendu ni au DOM : les tests l'appellent directement.
 */

export const SECTOR_COUNT = 3;

export interface SectorSplit {
  /** Durée du secteur, en secondes. */
  time: number;
  /** Écart au même secteur du meilleur tour ; `null` sans référence. */
  delta: number | null;
}

export interface SectorSnapshot {
  count: number;
  /** Secteurs bouclés sur ce tour, `null` pour ceux qui restent. */
  splits: (SectorSplit | null)[];
  /** Secteur en cours, `-1` hors chrono. */
  running: number;
  /** Secondes écoulées dans le secteur en cours. */
  partial: number;
  /** Temps du tour de référence, s'il existe. */
  reference: number | null;
}

interface StoredSectors {
  lap: number;
  splits: number[];
}

export class SectorTimer {
  readonly count = SECTOR_COUNT;
  private readonly boundaries: number[];
  private readonly storageKey: string | null;
  private splits: (number | null)[] = [];
  private running = -1;
  private partial = 0;
  private reference: number | null = null;
  private bestSplits: number[] | null = null;

  /**
   * `length` est la longueur du tour en mètres : les frontières tombent au
   * tiers et aux deux tiers. Elles restent ainsi sur les mêmes virages d'un
   * tour à l'autre, quel que soit le temps mis à les atteindre.
   */
  constructor(length: number, storageKey: string | null = null) {
    this.storageKey = storageKey;
    this.boundaries = [];
    for (let i = 1; i < SECTOR_COUNT; i++) {
      this.boundaries.push((length * i) / SECTOR_COUNT);
    }
    this.splits = new Array(SECTOR_COUNT).fill(null);
    this.read();
  }

  /** Chrono lancé : un tour commence, les secteurs aussi. */
  arm(): void {
    this.running = 0;
    this.partial = 0;
    this.splits = new Array(SECTOR_COUNT).fill(null);
  }

  /** Chrono remis à zéro (respawn, changement de carte). */
  reset(): void {
    this.running = -1;
    this.partial = 0;
    this.splits = new Array(SECTOR_COUNT).fill(null);
  }

  /**
   * Avance d'une image. `lapDistance` est la distance parcourue depuis la
   * ligne, en mètres, dans `[0, length)`. Renvoie l'indice du secteur qui vient
   * d'être bouclé, ou `null`.
   */
  update(dt: number, lapDistance: number): number | null {
    if (this.running < 0 || this.running >= this.count) return null;
    this.partial += dt;
    let closed: number | null = null;
    // Une téléportation ou un respawn peut franchir plusieurs frontières d'un
    // coup : on ferme chaque secteur traversé au lieu d'en sauter un.
    while (this.running < this.count - 1 && lapDistance >= this.boundaries[this.running]) {
      this.splits[this.running] = this.partial;
      closed = this.running;
      this.running += 1;
      this.partial = 0;
    }
    return closed;
  }

  /**
   * Tour bouclé. Le dernier secteur se ferme sur le temps du tour, ce qui
   * garantit que la somme des trois secteurs égale le tour au centième près.
   * Le tour devient la référence s'il est meilleur que le précédent.
   */
  completeLap(lapTime: number): void {
    if (this.running < 0) return;
    let sum = 0;
    for (let i = 0; i < this.count - 1; i++) {
      if (this.splits[i] === null) this.splits[i] = Math.max(0, this.partial);
      sum += this.splits[i]!;
    }
    this.splits[this.count - 1] = Math.max(0, lapTime - sum);
    this.running = -1;
    this.partial = 0;
    const complete = this.splits.map((value) => value ?? 0);
    if (this.reference === null || lapTime < this.reference) {
      this.reference = lapTime;
      this.bestSplits = complete;
      this.store();
    }
  }

  snapshot(): SectorSnapshot {
    const splits: (SectorSplit | null)[] = [];
    for (let i = 0; i < this.count; i++) {
      const time = this.splits[i];
      const best = this.bestSplits?.[i] ?? null;
      splits.push(
        time === null || time === undefined
          ? null
          : { time, delta: best === null ? null : time - best },
      );
    }
    return {
      count: this.count,
      splits,
      running: this.running,
      partial: this.partial,
      reference: this.reference,
    };
  }

  /** Meilleurs temps de secteur, pour l'affichage de la référence. */
  get best(): number[] | null {
    return this.bestSplits;
  }

  private read(): void {
    if (!this.storageKey) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredSectors;
      if (!Number.isFinite(parsed.lap)) return;
      if (!Array.isArray(parsed.splits) || parsed.splits.length !== SECTOR_COUNT) return;
      if (!parsed.splits.every((value) => Number.isFinite(value))) return;
      this.reference = parsed.lap;
      this.bestSplits = parsed.splits.slice();
    } catch {
      // Stockage indisponible ou entrée corrompue : on repart sans référence.
    }
  }

  private store(): void {
    if (!this.storageKey || this.reference === null || !this.bestSplits) return;
    try {
      const payload: StoredSectors = { lap: this.reference, splits: this.bestSplits };
      localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Mode privé : la référence ne survit pas à la session.
    }
  }
}

/** Écart signé, au millième, avec le signe toujours visible. */
export function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 1000) / 1000;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(3)}`;
}

/** Temps de secteur : les secondes et les millièmes, sans les minutes. */
export function formatSector(seconds: number): string {
  return seconds.toFixed(3);
}
