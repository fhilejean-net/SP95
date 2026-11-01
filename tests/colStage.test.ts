import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ColStage } from '../src/game/colStage.ts';

const samples = [0, 10, 20, 30].map((s) => ({ x: s, z: 0, s, width: 6 }));

test('le chrono démarre puis s’arrête aux lignes dans le sens de la descente', () => {
  const stage = new ColStage(samples, 20);
  stage.update(1, -3, 0);
  assert.equal(stage.update(1, 2, 0), 'start');
  stage.update(3, 15, 0);
  assert.equal(stage.update(2, 21, 0), 'finish');
  assert.equal(stage.state, 'finished');
  assert.equal(stage.elapsed, 5);
  stage.update(2, 28, 0);
  assert.equal(stage.elapsed, 5);
  stage.reset();
  assert.equal(stage.state, 'waiting');
});

test('un passage hors piste ou dans le mauvais sens ne déclenche pas le chrono', () => {
  const stage = new ColStage(samples, 20);
  stage.update(1, -2, 20);
  assert.equal(stage.update(1, 2, 20), null);
  stage.reset();
  stage.update(1, 2, 0);
  assert.equal(stage.update(1, -2, 0), null);
  stage.reset();
  stage.update(1, -1, 100);
  assert.equal(stage.update(1, 1, 0), null, 'une téléportation latérale ne franchit pas la ligne');
});
