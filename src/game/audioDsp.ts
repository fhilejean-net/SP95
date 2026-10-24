/**
 * Noise helpers for the synthesiser. The engine used to loop a raw 2 s noise
 * buffer, so every two seconds the loop point dropped a click that became
 * obvious as soon as the exhaust opened up above half revs. The buffer is now
 * filled so that its last sample flows into its first one.
 */

/**
 * Fills `out` with white noise whose end joins its start: the head of the
 * buffer is crossfaded with the noise that would have followed the tail.
 */
export function fillSeamlessNoise(
  out: Float32Array,
  fadeSamples: number,
  random: () => number = Math.random,
): void {
  const length = out.length;
  const fade = Math.max(1, Math.min(Math.floor(fadeSamples), Math.floor(length / 3)));
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;

  // The samples that come *after* the loop point. Blending them into the head
  // makes out[0] the natural continuation of out[length - 1].
  const tail = new Float32Array(fade);
  for (let i = 0; i < fade; i++) tail[i] = random() * 2 - 1;

  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const head = Math.sin(t * Math.PI * 0.5);
    const continuation = Math.cos(t * Math.PI * 0.5);
    out[i] = out[i] * head + tail[i] * continuation;
  }
}
