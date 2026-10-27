import { CARS, type CarDef, type CarId } from './cars.ts';
import { describeSetup, type Setup } from './tuning.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing showroom element #${id}`);
  return node as T;
}

/**
 * Le showroom : un écran par voiture, au lieu du petit bandeau de l'atelier.
 *
 * La fiche de gauche montre la voiture telle qu'elle sortirait de l'atelier
 * avec le réglage du moment ; cliquer une carte la fait charger pour de vrai —
 * elle tourne derrière la vitre dans le menu. L'atelier, lui, ne s'occupe plus
 * que des pièces.
 */
export class Showroom {
  private overlay = el('showroom');
  private list: HTMLDivElement = el('showroom-list');
  private detail: HTMLElement = el('showroom-detail');
  private drive: HTMLButtonElement = el('btn-showroom-drive') as HTMLButtonElement;
  private pickButton: HTMLButtonElement = el('btn-showroom-pick') as HTMLButtonElement;
  /** Voiture mise en avant : celle dont la fiche est affichée. */
  private selection: CarId;
  /** Voiture en cours de chargement, s'il y en a une. */
  private pending: CarId | null = null;
  private setup: Setup;

  constructor(
    setup: Setup,
    private car: CarDef,
    private readonly onPick: (id: CarId) => void,
    private readonly onDrive: (id: CarId) => void,
  ) {
    this.setup = { ...setup };
    this.selection = car.id;
    this.list.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-car]');
      if (!button) return;
      this.highlight(button.getAttribute('data-car') as CarId);
      this.pick();
    });
    this.list.addEventListener('pointerenter', (event) => {
      const card = (event.target as HTMLElement).closest('button[data-car]');
      if (!card) return;
      const id = card.getAttribute('data-car') as CarId;
      if (id !== this.selection) this.highlight(id);
    }, true);
    this.pickButton.addEventListener('click', () => this.pick());
    this.drive.addEventListener('click', () => {
      const id = this.selection;
      if (CARS.some((entry) => entry.id === id)) this.onDrive(id);
    });
    el('btn-showroom-close').addEventListener('click', () => this.close());
    window.addEventListener('keydown', (event) => {
      if (!this.isOpen) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const index = CARS.findIndex((entry) => entry.id === this.selection);
        const next = CARS[(index + step + CARS.length) % CARS.length];
        this.highlight(next.id);
        this.pick();
        event.preventDefault();
      }
    });
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  open(setup: Setup): void {
    this.setup = { ...setup };
    this.selection = this.car.id;
    this.overlay.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  /** La voiture demandée est chargée : la carte passe au vert. */
  setCar(car: CarDef): void {
    this.car = car;
    this.selection = car.id;
    this.pending = null;
    if (this.isOpen) this.render();
  }

  /** Le chargement a échoué : la carte redevient cliquable. */
  clearPending(): void {
    this.pending = null;
    if (this.isOpen) this.render();
  }

  /** Met une voiture en avant, sans la charger (survol, flèches). */
  private highlight(id: CarId): void {
    if (!CARS.some((entry) => entry.id === id)) return;
    this.selection = id;
    this.render();
  }

  /** Charge la voiture mise en avant ; l'écran reste ouvert. */
  private pick(): void {
    if (this.pending || this.selection === this.car.id) return;
    this.pending = this.selection;
    this.render();
    this.onPick(this.selection);
  }

  private render(): void {
    this.list.replaceChildren(
      ...CARS.map((car) => {
        const selected = car.id === this.car.id;
        const shown = car.id === this.selection;
        const card = document.createElement('button');
        card.type = 'button';
        card.dataset.car = car.id;
        const classes = ['car-card'];
        if (shown) classes.push('shown');
        if (selected) classes.push('selected');
        if (car.id === this.pending) classes.push('loading');
        card.className = classes.join(' ');
        card.innerHTML =
          `<strong>${car.label}</strong>` +
          `<span>${car.id === this.pending ? 'Chargement…' : car.detail}</span>` +
          `<em>${car.origin ?? 'SP95'}</em>`;
        return card;
      }),
    );

    const car = CARS.find((entry) => entry.id === this.selection) ?? this.car;
    const summary = describeSetup(this.setup, car.spec);
    this.detail.innerHTML = `
      <p class="eyebrow">${car.id === this.car.id ? 'Au volant' : 'Aperçu'}</p>
      <h3 class="showroom-name">${car.label}</h3>
      <p class="showroom-sub">${car.detail}${car.origin ? ` · ${car.origin}` : ''}</p>
      <div class="showroom-stats">
        <div class="car-stat"><span>Puissance</span><i class="bar"><b style="width:${Math.min(100, (summary.powerHp / 900) * 100)}%"></b></i><em>${summary.powerHp} ch</em></div>
        <div class="car-stat"><span>Poids</span><i class="bar"><b style="width:${Math.min(100, (summary.mass / 2200) * 100)}%"></b></i><em>${summary.mass} kg</em></div>
        <div class="car-stat"><span>Rapport</span><i class="bar"><b style="width:${Math.min(100, (summary.ratio / 700) * 100)}%"></b></i><em>${summary.ratio} ch/t</em></div>
        <div class="car-stat"><span>Grip</span><i class="bar"><b style="width:${summary.gripBar * 100}%"></b></i><em>${summary.grip}</em></div>
        <div class="car-stat"><span>Appui</span><i class="bar"><b style="width:${summary.aeroBar * 100}%"></b></i><em>${Math.round(summary.aeroBar * 100)} %</em></div>
      </div>
      <p class="showroom-drive">${summary.drive} · ${summary.steering}</p>
    `;
    const loaded = car.id === this.car.id;
    this.drive.disabled = this.pending !== null;
    this.drive.textContent = loaded ? 'Conduire celle-ci' : `Conduire la ${car.label}`;
    // Une voiture déjà au volant n'a rien à charger : le bouton s'efface.
    this.pickButton.disabled = this.pending !== null || loaded;
    this.pickButton.textContent = loaded ? 'Voiture au volant' : 'Charger cette voiture';
  }
}
