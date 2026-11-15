const assert = require('node:assert/strict');
const { test } = require('node:test');
const summarizeChanges = require('../src/changeSummary');
const { transferPads } = require('../src/padTransfer');
const { emptyPatternSlots } = require('../src/patternSlots');

/** A card with samples on A1 and A2; everything else is empty. */
function editor() {
  const pads = {};
  for (const bank of 'AB') {
    for (let i = 1; i <= 12; i++) {
      const label = `${bank}${i}`;
      const present = label === 'A1' || label === 'A2';
      pads[label] = {
        label,
        filename: `${bank}${String(i).padStart(7, '0')}.WAV`,
        samplePresent: present,
        avaliable: !present,
        channels: 'Stereo',
        convert: false,
        remove: false,
        volume: 64,
        loop: false,
        gate: true,
        reverse: false,
        lofi: false,
        tempoMode: 'Normal',
        originalTempo: 120,
        userTempo: 120,
      };
    }
  }
  return { pads, patterns: emptyPatternSlots() };
}

/** The snapshot the renderer keeps is JSON, so the baseline is always a deep copy. */
const baselineOf = (state) => JSON.parse(JSON.stringify(state));

test('an untouched editor has nothing to review', () => {
  const state = editor();
  const summary = summarizeChanges(baselineOf(state), state);
  assert.deepEqual(summary, {
    pads: [], patterns: [], other: [], count: 0, removals: 0,
  });
});

test('imports, replacements, and removals are described per pad', () => {
  const state = editor();
  const baseline = baselineOf(state);
  Object.assign(state.pads.B3, { convert: true, avaliable: false, externalFile: '/music/kick one.wav' });
  Object.assign(state.pads.A1, { convert: true, externalFile: '/music/snare.wav' });
  state.pads.A2.remove = true;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind, item.details]), [
    ['A1', 'import', ['Import snare.wav (replaces the existing sample)']],
    ['A2', 'remove', ['Remove sample']],
    ['B3', 'import', ['Import kick one.wav']],
  ]);
  assert.equal(summary.removals, 1);
  assert.equal(summary.count, 3);
});

test('setting edits list old and new values and ignore unchanged fields', () => {
  const state = editor();
  const baseline = baselineOf(state);
  state.pads.A1.volume = 100;
  state.pads.A1.loop = true;
  state.pads.A1.userTempo = 98.5;

  const [item, ...rest] = summarizeChanges(baseline, state).pads;
  assert.equal(rest.length, 0);
  assert.equal(item.kind, 'edit');
  assert.deepEqual(item.details, ['Volume: 64 → 100', 'Loop: off → on', 'User BPM: 120 → 98.5']);

  // Reverting the edit leaves nothing to review.
  Object.assign(state.pads.A1, { volume: 64, loop: false, userTempo: 120 });
  assert.equal(summarizeChanges(baseline, state).count, 0);
});

test('a swap reports each destination once, with settings compared against the pad that moved', () => {
  const state = editor();
  const baseline = baselineOf(state);
  state.pads.A2.volume = 10;
  baseline.pads.A2.volume = 10;
  assert.equal(transferPads(state.pads, 'A1', 'A2'), true);
  state.pads.A1.loop = true; // A1 now holds the sample that came from A2

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.details]), [
    ['A1', ['Move sample here from A2', 'Loop: off → on']],
    ['A2', ['Move sample here from A1']],
  ]);
});

test('moving into an empty slot reports the destination and not the vacated slot', () => {
  const state = editor();
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'B5'), true);

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind, item.details]), [
    ['B5', 'move', ['Move sample here from A1']],
  ]);
});

test('channel conversion is listed for stored samples and queued imports', () => {
  const state = editor();
  const baseline = baselineOf(state);
  state.pads.A1.targetChannels = 'Mono';
  Object.assign(state.pads.B1, { convert: true, avaliable: false, externalFile: '/x/loop.wav', targetChannels: 'Mono' });

  assert.deepEqual(summarizeChanges(baseline, state).pads.map((item) => [item.label, item.details]), [
    ['A1', ['Convert to mono']],
    ['B1', ['Import loop.wav', 'Convert to mono']],
  ]);
});

test('pattern imports and removals are listed with replacements called out', () => {
  const state = editor();
  state.patterns.C2 = { ...state.patterns.C2, bytes: [1, 2, 3], summary: {} };
  state.patterns.C5 = { ...state.patterns.C5, bytes: [9], summary: {} };
  const baseline = baselineOf(state);
  Object.assign(state.patterns.C2, { dirty: true, name: 'beat.mid' });
  Object.assign(state.patterns.D4, { dirty: true, bytes: [4], summary: {} });
  state.patterns.C5.remove = true;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.patterns.map((item) => [item.label, item.kind, item.details]), [
    ['C2', 'import', ['Import pattern beat.mid (replaces the existing pattern)']],
    ['C5', 'remove', ['Remove pattern']],
    ['D4', 'import', ['Import pattern']],
  ]);
  assert.equal(summary.removals, 1);
});

test('missing baselines are tolerated', () => {
  const state = editor();
  state.pads.A1.volume = 1;
  assert.doesNotThrow(() => summarizeChanges(undefined, state));
  assert.equal(summarizeChanges(undefined, undefined).count, 0);
});

test('pattern BPM and remembered note maps are reviewed even though the pattern file is untouched', () => {
  const state = editor();
  state.patterns.C2 = { ...state.patterns.C2, bytes: [1], summary: {}, bpm: 120 };
  const baseline = baselineOf(state);
  state.patterns.C2.bpm = 98;
  state.patterns.C2.noteMap = { 36: 'A1' };
  state.patterns.C3 = { ...state.patterns.C3, bytes: [1], summary: {} };
  baseline.patterns.C3 = JSON.parse(JSON.stringify(state.patterns.C3));
  state.patterns.C3.bpm = 140;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.patterns.map((item) => [item.label, item.kind, item.details]), [
    ['C2', 'edit', ['BPM: 120 → 98', 'Remember the MIDI note assignment used for export']],
    ['C3', 'edit', ['BPM: not set → 140']],
  ]);
  assert.equal(summary.other.length, 0);
});

test('an edit with no description still counts as a change instead of passing as nothing to review', () => {
  const state = editor();
  const baseline = baselineOf(state);
  state.pads.B7.format = 'AIFF'; // a field the review does not describe
  const summary = summarizeChanges(baseline, state);
  assert.equal(summary.pads.length + summary.patterns.length, 0);
  assert.equal(summary.other.length, 1);
  assert.equal(summary.count, 1);
});

test('a sample moved away and then overwritten by an import is reported as deleted', () => {
  const state = editor();
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'B1'), true);
  Object.assign(state.pads.B1, { convert: true, avaliable: false, externalFile: '/x/new.wav' });
  delete state.pads.B1.sourceFilename;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind, item.details]), [
    ['A1', 'remove', ['Sample will be deleted (it was displaced by an import)']],
    ['B1', 'import', ['Import new.wav']],
  ]);
  assert.equal(summary.removals, 1);
});

test('a swap followed by an import reports the displaced sample, not a false replacement', () => {
  const state = editor();
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'A2'), true); // A1 now holds A2's sample and A2 holds A1's
  Object.assign(state.pads.A1, { convert: true, externalFile: '/x/new.wav' });
  delete state.pads.A1.sourceFilename;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind, item.details]), [
    ['A1', 'import', ['Import new.wav']],
    ['A2', 'move', ['Move sample here from A1']],
    ['A2', 'remove', ['Sample will be deleted (it was displaced by an import)']],
  ]);
});

test('moves, swaps, and explicit removals never report displaced samples', () => {
  const state = editor();
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'A2'), true);
  assert.equal(transferPads(state.pads, 'A1', 'B3'), true);
  state.pads.A2.remove = true;
  assert.equal(summarizeChanges(baseline, state).pads.some((item) => item.details[0].startsWith('Sample will be deleted')), false);
});

test('importing over an unreadable pattern file discloses the replacement', () => {
  const state = editor();
  state.patterns.C2 = { ...state.patterns.C2, error: 'Invalid pattern file.' };
  const baseline = baselineOf(state);
  Object.assign(state.patterns.C2, { dirty: true, bytes: [1], summary: {} });
  assert.deepEqual(summarizeChanges(baseline, state).patterns.map((item) => item.details), [
    ['Import pattern (replaces an unreadable pattern file)'],
  ]);
});

test('an undescribed edit alongside described ones is still reported', () => {
  const state = editor();
  const baseline = baselineOf(state);
  state.pads.A1.volume = 90; // described
  state.pads.B7.format = 'AIFF'; // not described by the review

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => item.label), ['A1']);
  assert.equal(summary.other.length, 1);
  assert.equal(summary.count, 2);

  // The same holds for a pattern slot, and for a field changed on a pad that also has a described edit.
  const withPattern = editor();
  withPattern.patterns.C2 = { ...withPattern.patterns.C2, bytes: [1], summary: {} };
  const patternBaseline = baselineOf(withPattern);
  withPattern.patterns.C2.bpm = 100;
  withPattern.patterns.C2.summary = { notes: [] };
  assert.equal(summarizeChanges(patternBaseline, withPattern).other.length, 1);
  state.pads.B7.format = 'WAVE';
  state.pads.A1.format = 'AIFF';
  assert.equal(summarizeChanges(baseline, state).other.length, 1);
});

test('legitimate moves, imports, and removals do not produce a catch-all entry', () => {
  const state = editor();
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'B5'), true);
  Object.assign(state.pads.B2, { convert: true, avaliable: false, externalFile: '/x/a.wav', externalFileSize: 999 });
  state.pads.A2.remove = true;
  state.pads.B9.volume = 3;
  assert.equal(summarizeChanges(baseline, state).other.length, 0);
});

test('settings edited after queuing an import are listed with it', () => {
  const state = editor();
  const baseline = baselineOf(state);
  Object.assign(state.pads.B3, { convert: true, avaliable: false, externalFile: '/x/kick.wav' });
  state.pads.B3.volume = 90;
  state.pads.B3.loop = true;

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.details]), [
    ['B3', ['Import kick.wav', 'Volume: 64 → 90', 'Loop: off → on']],
  ]);
  assert.equal(summary.other.length, 0);

  // An undescribed field edited on a queued import is still caught.
  state.pads.B3.format = 'AIFF';
  assert.equal(summarizeChanges(baseline, state).other.length, 1);
});

test('export settings on a freshly imported pattern are listed', () => {
  const state = editor();
  const baseline = baselineOf(state);
  Object.assign(state.patterns.D4, {
    dirty: true, bytes: [4], summary: {}, name: 'groove.mid', bpm: 96, noteMap: { 36: 'A1' },
  });
  assert.deepEqual(summarizeChanges(baseline, state).patterns.map((item) => item.details), [
    ['Import pattern groove.mid', 'Export BPM: 96', 'Remember the MIDI note assignment used for export'],
  ]);
});

test('cancelling a queued import or pattern in an empty slot is not a deletion', () => {
  const state = editor();
  state.patterns.C5 = { ...state.patterns.C5 };
  const baseline = baselineOf(state);
  Object.assign(state.pads.B3, {
    convert: true, avaliable: false, externalFile: '/x/a.wav', remove: true,
  });
  Object.assign(state.patterns.C5, { remove: true, bytes: [1], dirty: true });
  state.patterns.D1 = { ...state.patterns.D1, bytes: [1], summary: {} };
  baseline.patterns.D1 = JSON.parse(JSON.stringify(state.patterns.D1));
  state.patterns.D1.remove = true;

  const summary = summarizeChanges(baseline, state);
  // Nothing is deleted, but the write resets the slot's settings, so the cancellation is still disclosed.
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind]), [['B3', 'edit']]);
  assert.match(summary.pads[0].details[0], /reset to defaults/);
  assert.deepEqual(summary.patterns.map((item) => [item.label, item.kind]), [['D1', 'remove']]);
  assert.equal(summary.removals, 1);

  // Removing an import queued over an existing sample still deletes that sample.
  const over = editor();
  const overBaseline = baselineOf(over);
  Object.assign(over.pads.A1, { convert: true, externalFile: '/x/a.wav', remove: true });
  assert.deepEqual(summarizeChanges(overBaseline, over).pads.map((item) => [item.label, item.kind]), [['A1', 'remove']]);
});

test('settings edited after dragging a queued import to another pad are still listed', () => {
  const state = editor();
  state.pads.B3.volume = 40;
  const baseline = baselineOf(state);
  Object.assign(state.pads.B3, { convert: true, avaliable: false, externalFile: '/x/kick.wav' });
  assert.equal(transferPads(state.pads, 'B3', 'C4'), false, 'C4 is outside this fixture');
  assert.equal(transferPads(state.pads, 'B3', 'B8'), true);
  state.pads.B8.volume = 100;
  state.pads.B8.gate = false;

  const summary = summarizeChanges(baseline, state);
  // B3 held no sample, so the write resets its settings; that is reported separately from the import.
  assert.deepEqual(summary.pads.map((item) => [item.label, item.details]), [
    ['B3', ["Reset this empty slot's settings to the sampler defaults"]],
    ['B8', ['Import kick.wav', 'Volume: 40 → 100', 'Gate: on → off']],
  ]);

  // Moving it again keeps pointing at the slot the settings started on.
  assert.equal(transferPads(state.pads, 'B8', 'B9'), true);
  const moved = summarizeChanges(baseline, state).pads.find((item) => item.label === 'B9');
  assert.deepEqual(moved.details, ['Import kick.wav', 'Volume: 40 → 100', 'Gate: on → off']);
});

test('an empty slot left behind by moving a sample away and back is reported as reset', () => {
  const state = editor();
  state.pads.B5.volume = 20; // an empty slot with saved, non-default settings
  const baseline = baselineOf(state);
  assert.equal(transferPads(state.pads, 'A1', 'B5'), true);
  assert.equal(transferPads(state.pads, 'B5', 'A1'), true);

  const summary = summarizeChanges(baseline, state);
  assert.deepEqual(summary.pads.map((item) => [item.label, item.kind]), [['B5', 'edit']]);
  assert.match(summary.pads[0].details[0], /Reset this empty slot's settings/);
  assert.equal(summary.removals, 0);
});
