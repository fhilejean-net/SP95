import { CATEGORIES, PRESETS, describeSetup, type Setup, type SetupKey } from './tuning.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing garage element #${id}`);
  return node as T;
}

/**
 * The garage panel. It owns nothing but the UI: every change is handed back to
 * the game, which rebuilds the car with the new spec.
 */
export class Garage {
  private overlay = el('garage');
  private tabs: HTMLDivElement = el('garage-tabs');
  private options: HTMLDivElement = el('garage-options');
  private hint = el('garage-hint');
  private stats = el('garage-stats');
  private presets: HTMLDivElement = el('garage-presets');
  private setup: Setup;
  private active: SetupKey = 'engine';

  constructor(
    setup: Setup,
    private readonly onChange: (setup: Setup) => void,
  ) {
    this.setup = { ...setup };
    this.tabs.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-key]');
      if (!button) return;
      this.active = button.getAttribute('data-key') as SetupKey;
      this.render();
    });
    this.presets.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-preset]');
      if (!button) return;
      const preset = PRESETS[Number(button.getAttribute('data-preset'))];
      if (!preset) return;
      this.setup = { ...preset.setup };
      this.onChange({ ...this.setup });
      this.render();
    });
    this.options.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-option]');
      if (!button) return;
      const index = Number(button.getAttribute('data-option'));
      if (!Number.isFinite(index)) return;
      this.setup = { ...this.setup, [this.active]: index };
      this.onChange({ ...this.setup });
      this.render();
    });
    el('btn-garage-close').addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  open(setup: Setup): void {
    this.setup = { ...setup };
    this.overlay.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private render(): void {
    this.presets.replaceChildren(
      ...PRESETS.map((preset, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.preset = String(index);
        button.className = 'preset';
        button.textContent = preset.label;
        return button;
      }),
    );

    this.tabs.replaceChildren(
      ...CATEGORIES.map((category) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.key = category.key;
        button.className = category.key === this.active ? 'tab active' : 'tab';
        button.innerHTML = `<span>${category.label}</span><em>${category.options[this.setup[category.key]].label}</em>`;
        return button;
      }),
    );

    const category = CATEGORIES.find((c) => c.key === this.active) ?? CATEGORIES[0];
    this.hint.textContent = category.hint;
    this.options.replaceChildren(
      ...category.options.map((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.option = String(index);
        button.className = index === this.setup[category.key] ? 'part selected' : 'part';
        button.innerHTML = `<strong>${option.label}</strong><span>${option.detail}</span>`;
        return button;
      }),
    );

    const summary = describeSetup(this.setup);
    this.stats.innerHTML = [
      `<span><b>${summary.powerHp}</b> ch</span>`,
      `<span><b>${summary.mass}</b> kg</span>`,
      `<span><b>${summary.ratio}</b> ch/t</span>`,
    ].join('');
  }
}
