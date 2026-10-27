import { CATEGORIES, PRESETS, describeSetup, type Setup, type SetupKey } from './tuning.ts';
import {
  BIKE_CATEGORIES,
  BIKE_PRESETS,
  describeBikeSetup,
  type BikeSetup,
  type BikeSetupKey,
} from './bikeTuning.ts';
import type { CarDef } from './cars.ts';
import { SUPERMOTARD } from './bikes.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing garage element #${id}`);
  return node as T;
}

type GarageMode = 'car' | 'bike';
type AnyKey = SetupKey | BikeSetupKey;
type AnySetup = Record<string, number>;

/**
 * The garage panel. It owns nothing but the UI: every change is handed back to
 * the game, which rebuilds the vehicle with the new spec. The same panel tunes
 * the cars and the bike; the catalog and the summary come from whichever is
 * being worked on.
 */
export class Garage {
  private overlay = el('garage');
  private tabs: HTMLDivElement = el('garage-tabs');
  private options: HTMLDivElement = el('garage-options');
  private hint = el('garage-hint');
  private stats = el('garage-stats');
  private presets: HTMLDivElement = el('garage-presets');
  private title: HTMLElement = el('garage-vehicle');
  private setup: Setup;
  private bikeSetup: BikeSetup;
  private mode: GarageMode = 'car';
  private active: AnyKey = 'engine';

  constructor(
    setup: Setup,
    bikeSetup: BikeSetup,
    private car: CarDef,
    private readonly onChange: (setup: Setup) => void,
    private readonly onBikeChange: (setup: BikeSetup) => void,
  ) {
    this.setup = { ...setup };
    this.bikeSetup = { ...bikeSetup };
    this.tabs.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-key]');
      if (!button) return;
      this.active = button.getAttribute('data-key') as AnyKey;
      this.render();
    });
    this.presets.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-preset]');
      if (!button) return;
      const index = Number(button.getAttribute('data-preset'));
      if (!Number.isFinite(index)) return;
      if (this.mode === 'bike') {
        const preset = BIKE_PRESETS[index];
        if (!preset) return;
        this.bikeSetup = { ...preset.setup };
        this.onBikeChange({ ...this.bikeSetup });
      } else {
        const preset = PRESETS[index];
        if (!preset) return;
        this.setup = { ...preset.setup };
        this.onChange({ ...this.setup });
      }
      this.render();
    });
    this.options.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-option]');
      if (!button) return;
      const index = Number(button.getAttribute('data-option'));
      if (!Number.isFinite(index)) return;
      if (this.mode === 'bike') {
        this.bikeSetup = { ...this.bikeSetup, [this.active as BikeSetupKey]: index };
        this.onBikeChange({ ...this.bikeSetup });
      } else {
        this.setup = { ...this.setup, [this.active as SetupKey]: index };
        this.onChange({ ...this.setup });
      }
      this.render();
    });
    el('btn-garage-close').addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Le showroom a changé de voiture : les stats suivent la nouvelle caisse. */
  setCar(car: CarDef): void {
    this.car = car;
    if (this.isOpen) this.render();
  }

  open(setup: Setup): void {
    this.mode = 'car';
    this.setup = { ...setup };
    this.overlay.classList.remove('hidden');
    this.render();
  }

  /** The same panel, wired to the supermotard. */
  openBike(setup: BikeSetup): void {
    this.mode = 'bike';
    this.bikeSetup = { ...setup };
    this.active = 'engine';
    this.overlay.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private get categories() {
    return this.mode === 'bike' ? BIKE_CATEGORIES : CATEGORIES;
  }

  private get activeSetup(): AnySetup {
    return this.mode === 'bike' ? this.bikeSetup : this.setup;
  }

  private render(): void {
    const bike = this.mode === 'bike';
    this.title.textContent = bike ? 'Atelier moto' : 'Atelier';

    this.presets.replaceChildren(
      ...(bike ? BIKE_PRESETS : PRESETS).map((preset, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.preset = String(index);
        button.className = 'preset';
        button.textContent = preset.label;
        return button;
      }),
    );

    const categories = this.categories;
    if (!categories.some((category) => category.key === this.active)) this.active = categories[0].key;

    this.tabs.replaceChildren(
      ...categories.map((category) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.key = category.key;
        button.className = category.key === this.active ? 'tab active' : 'tab';
        button.innerHTML = `<span>${category.label}</span><em>${
          category.options[this.activeSetup[category.key]]?.label ?? ''
        }</em>`;
        return button;
      }),
    );

    const category = categories.find((c) => c.key === this.active) ?? categories[0];
    this.hint.textContent = category.hint;
    this.options.replaceChildren(
      ...category.options.map((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.option = String(index);
        button.className = index === this.activeSetup[category.key] ? 'part selected' : 'part';
        button.innerHTML = `<strong>${option.label}</strong><span>${option.detail}</span>`;
        return button;
      }),
    );

    const summary = bike
      ? describeBikeSetup(this.bikeSetup, SUPERMOTARD.spec)
      : describeSetup(this.setup, this.car.spec);
    this.stats.innerHTML = [
      `<span><b>${summary.powerHp}</b> ch</span>`,
      `<span><b>${summary.mass}</b> kg</span>`,
      `<span><b>${summary.ratio}</b> ch/t</span>`,
    ].join('');
  }
}
