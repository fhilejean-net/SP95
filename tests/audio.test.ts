import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MIX,
  MIX_STORAGE_KEY,
  SOUND_CHANNELS,
  clampChannel,
  loadMix,
  loadVehicleMixes,
  mixForVehicle,
  rememberMix,
  sanitizeMix,
  saveMix,
  saveVehicleMixes,
} from '../src/game/audioMix.ts';
import { fillSeamlessNoise } from '../src/game/audioDsp.ts';

test('every sound channel has a default inside 0..1', () => {
  for (const channel of SOUND_CHANNELS) {
    const value = DEFAULT_MIX[channel];
    assert.ok(value >= 0 && value <= 1, `${channel} = ${value}`);
  }
  // The piercing voices start below the engine so they no longer dominate.
  assert.ok(DEFAULT_MIX.turbo < DEFAULT_MIX.engine);
  assert.ok(DEFAULT_MIX.tyres < DEFAULT_MIX.engine);
});

test('channel values are clamped and bad input falls back', () => {
  assert.equal(clampChannel(1.7, 0.5), 1);
  assert.equal(clampChannel(-2, 0.5), 0);
  assert.equal(clampChannel('0.42', 0.5), 0.42);
  assert.equal(clampChannel('loud', 0.5), 0.5);
  assert.equal(clampChannel(undefined, 0.7), 0.7);
});

test('a stored mix keeps known channels and drops everything else', () => {
  const mix = sanitizeMix({ engine: 0.2, tyres: 9, bogus: 0.3, wind: 'quiet' });
  assert.equal(mix.engine, 0.2);
  assert.equal(mix.tyres, 1);
  assert.equal(mix.wind, DEFAULT_MIX.wind);
  assert.equal(mix.master, DEFAULT_MIX.master);
  assert.equal('bogus' in mix, false);
});

test('the mix round-trips through storage and survives a broken entry', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const custom = { ...DEFAULT_MIX, turbo: 0.15, master: 0.6 };
  saveMix(custom, storage);
  assert.ok(store.get(MIX_STORAGE_KEY));
  assert.deepEqual(loadMix(storage), custom);

  store.set(MIX_STORAGE_KEY, '{not json');
  assert.deepEqual(loadMix(storage), DEFAULT_MIX);
  assert.deepEqual(loadMix(null), DEFAULT_MIX);
});

test('car and bike mixes are restored independently, master stays shared', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };

  // The car is balanced first: quieter engine, no turbo whine.
  let mixes = loadVehicleMixes(storage);
  const carMix = { ...DEFAULT_MIX, engine: 0.2, turbo: 0, master: 0.55 };
  mixes = rememberMix(mixes, 'car', carMix);
  saveVehicleMixes(mixes, storage);

  // Switch to the bike: it opens on its own preset, not the car's.
  mixes = loadVehicleMixes(storage);
  assert.equal(mixForVehicle(mixes, 'car').engine, 0.2);
  assert.equal(mixForVehicle(mixes, 'bike').engine, DEFAULT_MIX.engine);

  const bikeMix = { ...mixForVehicle(mixes, 'bike'), engine: 0.9, turbo: 0.1 };
  mixes = rememberMix(mixes, 'bike', bikeMix);
  saveVehicleMixes(mixes, storage);

  // And back again, across a reload: each vehicle keeps its own channels.
  mixes = loadVehicleMixes(storage);
  assert.equal(mixForVehicle(mixes, 'car').engine, 0.2);
  assert.equal(mixForVehicle(mixes, 'car').turbo, 0);
  assert.equal(mixForVehicle(mixes, 'bike').engine, 0.9);
  assert.equal(mixForVehicle(mixes, 'bike').turbo, 0.1);

  // The master followed the player instead of being restored per vehicle.
  assert.equal(mixForVehicle(mixes, 'car').master, 0.55);
  assert.equal(mixForVehicle(mixes, 'bike').master, 0.55);
});

test('the first run after presets seeds both vehicles from the old mix', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const legacy = { ...DEFAULT_MIX, wind: 0.12, master: 0.4 };
  saveMix(legacy, storage);

  const mixes = loadVehicleMixes(storage);
  assert.deepEqual(mixForVehicle(mixes, 'car'), legacy);
  assert.deepEqual(mixForVehicle(mixes, 'bike'), legacy);
});

test('the looping noise continues across the loop point', () => {
  let draws = 0;
  const random = () => {
    draws++;
    return draws / 10_000;
  };
  const length = 3000;
  const fade = 300;
  const out = new Float32Array(length);
  fillSeamlessNoise(out, fade, random);

  // The first pass fills the buffer, then `fade` extra samples describe what
  // would have come after the end. out[0] must be that continuation, so the
  // end-to-start seam is continuous instead of a click.
  const expectedContinuation = (length + 1) / 10_000;
  assert.ok(Math.abs(out[0] - (expectedContinuation * 2 - 1)) < 1e-6, `out[0]=${out[0]}`);
  assert.ok(Math.abs(out[length - 1] - ((length / 10_000) * 2 - 1)) < 1e-6);

  // At the end of the crossfade the buffer is the untouched noise again.
  assert.ok(Math.abs(out[fade] - (((fade + 1) / 10_000) * 2 - 1)) < 1e-6);
});
