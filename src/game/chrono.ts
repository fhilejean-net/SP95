/**
 * Le chrono de la piste : une ligne de départ-arrivée, des tours, un meilleur.
 *
 * La détection se fait sur le signe de la distance à la ligne : le produit
 * scalaire passe de négatif à positif quand la voiture franchit le plan dans le
 * bon sens. La fenêtre latérale évite de valider un passage à l'autre bout du
 * circuit, où la piste repasse parfois près de la ligne.
 *
 * Aucune dépendance au rendu ni au DOM : les tests l'appellent directement.
 */

export interface ChronoLine {
  x: number;
  z: number;
  /** Cap de la piste à la ligne : le sens de franchissement autorisé. */
  heading: number;
}

export interface ChronoSnapshot {
  /** `false` tant que la ligne n'a pas été franchie une première fois. */
  armed: boolean;
  lap: number;
  current: number;
  last: number;
  best: number | null;
  /** Dernier temps enregistré, pour le bandeau « dernier tour ». */
  lastLabel: string;
}

/** Distance latérale tolérée de part et d'autre de la ligne, en mètres. */
export const CHRONO_HALF_WIDTH = 14;

/** Il faut rouler : un demi-tour sur place ne valide pas un tour. */
const MIN_SPEED = 1.5;

export class Chrono {
  /** Dernier côté de la ligne, et la position pour la fenêtre latérale. */
  private previous: number;
  private wasOnLine = true;
  armed = false;
  lap = 0;
  current = 0;
  last = 0;
  best: number | null = null;

  // Champs écrits à la main : les paramètres-propriétés du constructeur ne
  // passent pas le « strip-only » de Node, qui exécute les tests.
  private readonly line: ChronoLine;
  private readonly storageKey: string | null;

  constructor(line: ChronoLine, storageKey: string | null = null) {
    this.line = line;
    this.storageKey = storageKey;
    this.previous = -1;
    this.best = this.readStored();
  }

  /** Capacité du chrono : un tour est bouclé, valeurs mises à jour. */
  update(dt: number, x: number, z: number, speed: number): 'start' | 'lap' | null {
    if (this.armed) this.current += dt;

    const forward = { x: -Math.sin(this.line.heading), z: -Math.cos(this.line.heading) };
    const dx = x - this.line.x;
    const dz = z - this.line.z;
    const signed = dx * forward.x + dz * forward.z;
    // Hors de la largeur de piste, on ne regarde même pas le signe.
    const lateral = Math.abs(dx * forward.z - dz * forward.x) > CHRONO_HALF_WIDTH;
    const crossed =
      !lateral && this.previous < 0 && signed >= 0 && Math.abs(signed - this.previous) < 12;
    this.previous = lateral ? this.previous : signed;

    if (crossed && !this.wasOnLine && speed > MIN_SPEED) {
      this.wasOnLine = true;
      if (!this.armed) {
        this.armed = true;
        this.lap = 1;
        this.current = 0;
        return 'start';
      }
      this.last = this.current;
      if (this.best === null || this.last < this.best) {
        this.best = this.last;
        this.store();
      }
      this.lap += 1;
      this.current = 0;
      return 'lap';
    }
    // La voiture est *sur* la ligne au départ : il faut s'en éloigner avant de
    // pouvoir la re-franchir, sinon le premier mètre compterait un tour.
    if (lateral || Math.abs(signed) > 6) this.wasOnLine = false;
    return null;
  }

  /** Remise à zéro au respawn : le tour en cours est perdu, le meilleur reste. */
  reset(): void {
    this.armed = false;
    this.lap = 0;
    this.current = 0;
    this.previous = -1;
    this.wasOnLine = true;
  }

  snapshot(): ChronoSnapshot {
    return {
      armed: this.armed,
      lap: this.lap,
      current: this.current,
      last: this.last,
      best: this.best,
      lastLabel: this.last > 0 ? formatLap(this.last) : '—',
    };
  }

  private readStored(): number | null {
    if (!this.storageKey) return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private store(): void {
    if (!this.storageKey || this.best === null) return;
    try {
      localStorage.setItem(this.storageKey, String(this.best));
    } catch {
      // Mode privé : le meilleur tour ne survit pas à la session.
    }
  }
}

export function formatLap(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const hundredths = Math.floor((total * 100) % 100);
  return `${minutes}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}
