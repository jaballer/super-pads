const path = require('node:path');

/** Pad settings a user can edit in place, with the names shown in the review. */
const SETTINGS = [
  ['volume', 'Volume'],
  ['loop', 'Loop'],
  ['gate', 'Gate'],
  ['reverse', 'Reverse'],
  ['lofi', 'Lo-Fi'],
  ['tempoMode', 'Tempo mode'],
  ['originalTempo', 'Original BPM'],
  ['userTempo', 'User BPM'],
];

/** Display booleans the way the pad switches read; everything else prints as stored. */
const show = (value) => {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value);
};

/** Convert a card filename such as `A0000003.WAV` to its pad label (`A3`). */
const labelFromFilename = (filename) => `${filename[0]}${Number(filename.slice(1, 8))}`;

/** List the in-place setting edits between the pad as it was last read or saved and the pad as it is now. */
function settingChanges(before, after) {
  if (!before) return [];
  return SETTINGS
    .filter(([field]) => before[field] !== after[field])
    .map(([field, name]) => `${name}: ${show(before[field])} → ${show(after[field])}`);
}

/**
 * Work out which card samples survive the write. A pad that still holds audio keeps the sample it started from
 * (its own, or the one moved or swapped into it); a pad queued for removal deletes its sample on purpose.
 * Samples that are neither are overwritten or deleted as a side effect of another change, such as an import
 * onto a slot that a moved sample had just vacated.
 */
function sampleFates(pads) {
  const kept = new Set();
  const removed = new Set();
  for (const pad of Object.values(pads)) {
    const origin = labelFromFilename(pad.sourceFilename || pad.filename);
    if (pad.remove) removed.add(origin);
    else if (pad.samplePresent && !pad.convert) kept.add(origin);
  }
  return { kept, removed };
}

/** Describe what the pad at one slot will do on the next write, or return nothing when it stays as it is. */
function summarizePad(pad, baselinePads, fates) {
  const saved = baselinePads[pad.label];
  const details = [];
  let kind = 'edit';

  if (pad.remove) {
    return { label: pad.label, kind: 'remove', details: ['Remove sample'] };
  }
  if (pad.convert) {
    kind = 'import';
    const name = pad.externalFile ? path.basename(pad.externalFile) : 'audio file';
    // A sample that moved away before this import is not replaced here; one that has no other home is.
    const replaces = saved?.samplePresent && !fates.kept.has(pad.label);
    details.push(`Import ${name}${replaces ? ' (replaces the existing sample)' : ''}`);
  } else if (pad.relocated && !pad.samplePresent) {
    // The vacated half of a move is reported at the slot that receives the sample.
    return undefined;
  } else if (pad.sourceFilename && pad.sourceFilename !== pad.filename) {
    kind = 'move';
    const from = labelFromFilename(pad.sourceFilename);
    // Moves swap samples, so nothing is lost; settings travel with the sample and are compared at its origin.
    details.push(`Move sample here from ${from}`);
    details.push(...settingChanges(baselinePads[from], pad));
  } else {
    details.push(...settingChanges(saved, pad));
  }

  // An import's settings belong to the new audio and are not diffed above, but a channel conversion still matters.
  if (pad.targetChannels && pad.targetChannels !== pad.channels) {
    details.push(pad.samplePresent || pad.convert ? `Convert to ${pad.targetChannels.toLowerCase()}` : `${pad.targetChannels} for the next import`);
  }
  if (!details.length) return undefined;
  return { label: pad.label, kind, details };
}

/** Describe a pattern slot's pending import or removal. */
function summarizePattern(slot, baselinePatterns) {
  const saved = baselinePatterns[slot.label];
  if (slot.remove) return { label: slot.label, kind: 'remove', details: ['Remove pattern'] };
  if (!slot.dirty) {
    // Editor-only metadata is saved with the card's editor state even though the pattern file is untouched.
    const details = [];
    if (saved?.bpm !== slot.bpm) details.push(`BPM: ${saved?.bpm ?? 'not set'} → ${slot.bpm ?? 'not set'}`);
    if (JSON.stringify(saved?.noteMap) !== JSON.stringify(slot.noteMap)) details.push('Remember the MIDI note assignment used for export');
    return details.length ? { label: slot.label, kind: 'edit', details } : undefined;
  }
  const name = typeof slot.name === 'string' && slot.name ? ` ${slot.name}` : '';
  let replaces = '';
  if (saved?.bytes) replaces = ' (replaces the existing pattern)';
  // An occupied slot whose file could not be parsed still holds card data that the import overwrites.
  else if (saved?.error) replaces = ' (replaces an unreadable pattern file)';
  return { label: slot.label, kind: 'import', details: [`Import pattern${name}${replaces}`] };
}

/**
 * Compare the editor with the snapshot taken when the card was last read or saved, and list what a write will do.
 * Both arguments are `{ pads, patterns }` maps keyed by slot label. Pure: nothing is read from disk or modified.
 * Returns `{ pads, patterns, other, count, removals }`; `count` is zero only when the two snapshots are identical.
 * `other` is a catch-all so an edit this module does not describe can never pass as "nothing to review".
 */
function summarizeChanges(baseline, current) {
  const baselinePads = baseline?.pads || {};
  const baselinePatterns = baseline?.patterns || {};
  const fates = sampleFates(current?.pads || {});
  const pads = Object.values(current?.pads || {}).flatMap((pad) => {
    const items = [summarizePad(pad, baselinePads, fates)];
    const original = baselinePads[pad.label];
    // The slot's original sample ends up nowhere and nothing here says so: it is a side effect of another edit.
    if (original?.samplePresent && !pad.convert && !fates.kept.has(pad.label) && !fates.removed.has(pad.label)) {
      items.push({ label: pad.label, kind: 'remove', details: ['Sample will be deleted (it was displaced by an import)'] });
    }
    return items;
  }).filter(Boolean);
  const patterns = Object.values(current?.patterns || {}).map((slot) => summarizePattern(slot, baselinePatterns)).filter(Boolean);
  const removals = [...pads, ...patterns].filter((item) => item.kind === 'remove').length;
  const other = [];
  if (!pads.length && !patterns.length
    && JSON.stringify([baselinePads, baselinePatterns]) !== JSON.stringify([current?.pads || {}, current?.patterns || {}])) {
    other.push({ label: '', kind: 'edit', details: ['Editor data changed. No sample or pattern files on the card are affected.'] });
  }
  return {
    pads, patterns, other, count: pads.length + patterns.length + other.length, removals,
  };
}

module.exports = summarizeChanges;
