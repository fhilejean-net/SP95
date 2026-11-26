import { SHADER_PRESETS, type ShaderPresetId } from './shaderSettings.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing graphics element #${id}`);
  return node as T;
}

/**
 * Le panneau Graphismes. Il ne connaît ni le renderer ni le composer : il
 * signale seulement le profil choisi, et la scène applique le shader en direct.
 */
export class GraphicsPanel {
  private overlay = el('graphics');
  private list = el('graphics-options');
  private note = el('graphics-note');
  private buttons = new Map<ShaderPresetId, HTMLButtonElement>();

  constructor(
    private active: ShaderPresetId,
    private readonly disabled: boolean,
    private readonly onChange: (id: ShaderPresetId) => void,
    private readonly onClose: (() => void) | null = null,
  ) {
    for (const preset of SHADER_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'graphics-option';
      button.dataset.preset = preset.id;
      button.setAttribute('aria-pressed', 'false');
      if (this.disabled && preset.id !== 'nature') button.disabled = true;

      const swatch = document.createElement('span');
      swatch.className = 'graphics-swatch';
      swatch.dataset.preset = preset.id;
      swatch.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'graphics-copy';
      const name = document.createElement('strong');
      name.textContent = preset.label;
      const detail = document.createElement('span');
      detail.textContent = preset.detail;
      const cost = document.createElement('em');
      cost.textContent = preset.cost;
      copy.append(name, detail, cost);

      button.append(swatch, copy);
      button.addEventListener('click', () => {
        if (button.disabled) return;
        this.onChange(preset.id);
      });
      this.list.append(button);
      this.buttons.set(preset.id, button);
    }

    el('btn-graphics-close').addEventListener('click', () => {
      if (this.onClose) this.onClose();
      else this.close();
    });

    this.sync(this.active);
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  open(active: ShaderPresetId = this.active): void {
    this.sync(active);
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  sync(active: ShaderPresetId): void {
    this.active = active;
    for (const [id, button] of this.buttons) {
      const selected = id === active;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this.note.textContent = this.disabled
      ? 'Mode performance actif : les shaders restent désactivés.'
      : 'Un seul passage plein écran, sans bloom ni flou de profondeur. Nature le désactive.';
  }
}
