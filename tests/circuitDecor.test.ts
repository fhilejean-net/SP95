/**
 * Le décor du circuit plat a deux règles géométriques qui ne doivent pas être
 * écrites au jugé : un objet posé près du mur ne peut pas se replier sur
 * lui-même dans un virage serré, et un bac à gravier ne peut pas être une plaque
 * allumée d'un coup au milieu de l'herbe.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRAVEL_FULL_RADIUS,
  GRAVEL_RADIUS,
  MIN_OFFSET_RADIUS,
  gravelFill,
  gravelFillAt,
  gravelRuns,
  offsetFits,
  outsideOf,
} from '../src/world/circuitDecor.ts';
import { TRACK, WALL_OFFSET, cornerRadius } from '../src/world/trackLayout.ts';

/** Échantillon du virage le plus serré du circuit. */
function tightest() {
  let best = TRACK.samples[0];
  for (const sample of TRACK.samples) {
    if (cornerRadius(sample) < cornerRadius(best)) best = sample;
  }
  return best;
}

test('un objet à l’offset du mur n’est posé que là où la ligne ne se replie pas', () => {
  const tight = tightest();
  const outside = outsideOf(tight);
  const insideLateral = -outside * (WALL_OFFSET - 0.34);
  // Intérieur du virage : la ligne n'a plus que quelques mètres de rayon.
  assert.equal(offsetFits(tight, insideLateral), false);
  // Extérieur : la ligne s'ouvre, la place est toujours valable.
  assert.equal(offsetFits(tight, -insideLateral), true);
  // Sur l'asphalte, même dans l'épingle, la ligne reste large.
  assert.equal(offsetFits(tight, 7), true);
  assert.ok(cornerRadius(tight) - Math.abs(insideLateral) < MIN_OFFSET_RADIUS);
});

test('le bac à gravier est à l’extérieur et s’élargit avec le serrage', () => {
  const tight = tightest();
  assert.equal(gravelFill(tight), 1, 'une épingle occupe toute la largeur');
  assert.ok(gravelFill({ ...tight, curvature: 1 / GRAVEL_RADIUS }) === 0);
  const medium = { ...tight, curvature: 1 / ((GRAVEL_RADIUS + GRAVEL_FULL_RADIUS) / 2) };
  const fill = gravelFill(medium);
  assert.ok(fill > 0 && fill < 1, `remplissage intermédiaire ${fill}`);

  const runs = gravelRuns(TRACK.samples);
  assert.ok(runs.length > 4, `${runs.length} bacs`);
  for (const run of runs) {
    // Le bac est toujours du côté extérieur du virage.
    const sample = TRACK.samples[run.start];
    assert.equal(run.side, outsideOf(sample));
    assert.ok(gravelFill(sample) > 0);
  }
  // Aucun bac ne couvre une ligne droite.
  const trapped = TRACK.samples.filter((sample) => gravelFill(sample) > 0);
  assert.ok(trapped.every((sample) => cornerRadius(sample) < GRAVEL_RADIUS));
});

test('le bac s’éteint en douceur sur ses extrémités', () => {
  const run = gravelRuns(TRACK.samples)[0];
  assert.ok(run, 'au moins un bac');
  const first = gravelFillAt(TRACK.samples, run, run.start);
  const last = gravelFillAt(TRACK.samples, run, run.end);
  assert.equal(first, 0, 'premier échantillon plat');
  assert.equal(last, 0, 'dernier échantillon plat');
  const middle = gravelFillAt(
    TRACK.samples,
    run,
    (run.start + Math.floor((run.end - run.start) / 2)) % TRACK.samples.length,
  );
  assert.ok(middle > 0.5, `milieu du bac à ${middle}`);
  for (let index = run.start; index <= run.end; index++) {
    assert.ok(gravelFillAt(TRACK.samples, run, index) >= 0);
  }
});
