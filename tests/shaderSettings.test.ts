import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SHADER,
  SHADER_PRESETS,
  SHADER_STORAGE_KEY,
  findShaderPreset,
  loadShaderPreset,
  parseShaderPreset,
  saveShaderPreset,
  shaderFromSearch,
} from '../src/game/shaderSettings.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => (key === SHADER_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === SHADER_STORAGE_KEY) value = next;
    },
    read: () => value,
  };
}

test('shader presets keep Nature free and every colour profile in one pass', () => {
  assert.equal(SHADER_PRESETS[0].id, 'nature');
  assert.equal(SHADER_PRESETS[0].grade, null);
  assert.match(SHADER_PRESETS[0].cost, /0 passe/);
  for (const preset of SHADER_PRESETS.slice(1)) {
    assert.ok(preset.grade, `${preset.id} should grade`);
    assert.match(preset.cost, /^1 passe/);
    assert.ok(preset.grade.contrast > 1);
    assert.ok(preset.grade.saturation > 1);
    assert.ok(preset.grade.vignette >= 0 && preset.grade.vignette < 1);
    assert.ok(preset.grade.grain >= 0 && preset.grade.grain < 0.1);
  }
});

test('unknown shader names never replace the default', () => {
  assert.equal(parseShaderPreset('cinema'), 'cinema');
  assert.equal(parseShaderPreset('vif'), 'vif');
  assert.equal(parseShaderPreset('nope'), null);
  assert.equal(parseShaderPreset(null), null);
  assert.equal(shaderFromSearch('?shader=cinema'), 'cinema');
  assert.equal(shaderFromSearch('?shader=nope'), null);
  assert.equal(findShaderPreset('nope' as never).id, 'nature');
});

test('a saved shader survives reloads, but a URL preview does not overwrite it', () => {
  const storage = memoryStorage();
  saveShaderPreset('cinema', storage);
  assert.equal(storage.read(), 'cinema');
  assert.equal(loadShaderPreset(storage, ''), 'cinema');
  assert.equal(loadShaderPreset(storage, '?shader=vif'), 'vif');
  assert.equal(storage.read(), 'cinema');
});

test('missing storage and bad values fall back to Nature', () => {
  assert.equal(loadShaderPreset(null, ''), DEFAULT_SHADER);
  const storage = memoryStorage('broken');
  assert.equal(loadShaderPreset(storage, ''), DEFAULT_SHADER);
});
