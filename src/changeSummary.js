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

/** Describe what the pad at one slot will do on the next write, or return nothing when it stays as it is. */
function summarizePad(pad, baselinePads) {
  const saved = baselinePads[pad.label];
  const details = [];
  let kind = 'edit';

  if (pad.remove) {
    return { label: pad.label, kind: 'remove', details: ['Remove sample'] };
  }
  if (pad.convert) {
    kind = 'import';
    const name = pad.externalFile ? path.basename(pad.externalFile) : 'audio file';
    details.push(`Import ${name}${saved?.samplePresent ? ' (replaces the existing sample)' : ''}`);
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
  if (!slot.dirty) return undefined;
  const name = typeof slot.name === 'string' && slot.name ? ` ${slot.name}` : '';
  const replaces = saved?.bytes ? ' (replaces the existing pattern)' : '';
  return { label: slot.label, kind: 'import', details: [`Import pattern${name}${replaces}`] };
}

/**
 * Compare the editor with the snapshot taken when the card was last read or saved, and list what a write will do.
 * Both arguments are `{ pads, patterns }` maps keyed by slot label. Pure: nothing is read from disk or modified.
 * Returns `{ pads, patterns, count, removals }`; `count` is zero when there is nothing to write.
 */
function summarizeChanges(baseline, current) {
  const baselinePads = baseline?.pads || {};
  const baselinePatterns = baseline?.patterns || {};
  const pads = Object.values(current?.pads || {}).map((pad) => summarizePad(pad, baselinePads)).filter(Boolean);
  const patterns = Object.values(current?.patterns || {}).map((slot) => summarizePattern(slot, baselinePatterns)).filter(Boolean);
  const removals = [...pads, ...patterns].filter((item) => item.kind === 'remove').length;
  return {
    pads, patterns, count: pads.length + patterns.length, removals,
  };
}

module.exports = summarizeChanges;
