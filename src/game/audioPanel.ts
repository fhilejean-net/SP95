import {
  DEFAULT_MIX,
  SOUND_CHANNEL_DEFS,
  type SoundChannel,
  type SoundMix,
} from './audioMix.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing sound element #${id}`);
  return node as T;
}

/**
 * The sound panel: one fader per family, applied live so the engine keeps
 * running while the player finds the balance. The panel only reports changes;
 * the game applies them to the audio graph and remembers them.
 */
export class AudioPanel {
  private overlay = el('sound');
  private list = el('sound-channels');
  private sliders = new Map<SoundChannel, HTMLInputElement>();
  private outputs = new Map<SoundChannel, HTMLOutputElement>();
  private mix: SoundMix;

  constructor(
    mix: SoundMix,
    private readonly onChange: (channel: SoundChannel, value: number) => void,
    private readonly onClose: (() => void) | null = null,
  ) {
    this.mix = { ...mix };
    for (const def of SOUND_CHANNEL_DEFS) {
      const row = document.createElement('label');
      row.className = 'sound-row';

      const label = document.createElement('span');
      label.className = 'sound-label';
      const name = document.createElement('b');
      name.textContent = def.label;
      const hint = document.createElement('em');
      hint.textContent = def.hint;
      label.append(name, hint);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(Math.round(this.mix[def.key] * 100));
      slider.dataset.channel = def.key;

      const output = document.createElement('output');
      output.className = 'sound-value';
      output.textContent = `${slider.value} %`;

      row.append(label, slider, output);
      this.list.append(row);
      this.sliders.set(def.key, slider);
      this.outputs.set(def.key, output);
    }

    this.list.addEventListener('input', (event) => {
      const slider = event.target as HTMLInputElement;
      const channel = slider.dataset.channel as SoundChannel | undefined;
      if (!channel) return;
      const value = Number(slider.value) / 100;
      this.mix[channel] = value;
      const output = this.outputs.get(channel);
      if (output) output.textContent = `${slider.value} %`;
      this.onChange(channel, value);
    });

    el('btn-sound-reset').addEventListener('click', () => {
      this.sync(DEFAULT_MIX);
      for (const def of SOUND_CHANNEL_DEFS) this.onChange(def.key, DEFAULT_MIX[def.key]);
    });
    el('btn-sound-close').addEventListener('click', () => {
      if (this.onClose) this.onClose();
      else this.close();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  open(mix: SoundMix = this.mix): void {
    this.sync(mix);
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private sync(mix: SoundMix): void {
    this.mix = { ...mix };
    for (const def of SOUND_CHANNEL_DEFS) {
      const slider = this.sliders.get(def.key);
      const output = this.outputs.get(def.key);
      const percent = Math.round(this.mix[def.key] * 100);
      if (slider) slider.value = String(percent);
      if (output) output.textContent = `${percent} %`;
    }
  }
}
