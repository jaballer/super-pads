const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, mock } = require('node:test');
const { createCard } = require('./helpers');
const runWorker = require('../src/runWorker');
const writeCard = require('../src/writeCard');
const cardFingerprint = require('../src/cardFingerprint');
const { CardTransaction, SAMPLE_DIRECTORY } = require('../src/cardTransaction');
const { writeNew } = require('../src/fileStorage');

/** Read a card as the editor does and return a snapshot ready to save, plus the fingerprint it must present. */
async function open(card) {
  const { pads, patterns, fingerprint } = await runWorker('parsePads', card);
  return {
    fingerprint,
    state: {
      root: card.root,
      pads: Object.fromEntries(pads.map((pad) => [pad.label, { ...pad, convert: false, remove: false }])),
      patterns,
    },
  };
}

test('fingerprint tracks every sampler-owned file and ignores editor metadata', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const baseline = cardFingerprint(card.root);
  assert.equal(cardFingerprint(card.root), baseline);

  // Editor-only metadata is written by this app and must not invalidate its own session.
  fs.writeFileSync(path.join(card.root, 'super-pads.json'), '{}');
  assert.equal(cardFingerprint(card.root), baseline);

  const sample = path.join(card.directory, 'A0000001.WAV');
  fs.copyFileSync(card.file, sample);
  const withSample = cardFingerprint(card.root);
  assert.notEqual(withSample, baseline);
  fs.appendFileSync(sample, Buffer.alloc(2));
  assert.notEqual(cardFingerprint(card.root), withSample);

  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const before = cardFingerprint(card.root);
  const bytes = fs.readFileSync(info);
  bytes[0] ^= 1;
  fs.writeFileSync(info, bytes);
  assert.notEqual(cardFingerprint(card.root), before);

  const patterns = path.join(card.root, 'ROLAND', 'SP-404SX', 'PTN');
  fs.mkdirSync(patterns, { recursive: true });
  const beforePattern = cardFingerprint(card.root);
  fs.writeFileSync(path.join(patterns, 'PTN00005.BIN'), Buffer.alloc(16));
  assert.notEqual(cardFingerprint(card.root), beforePattern);
});

test('a save is refused, and nothing is written, when the card changed after it was opened', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { state, fingerprint } = await open(card);

  // Simulate another card (or the sampler) leaving different contents at the same path.
  fs.copyFileSync(card.file, path.join(card.directory, 'C0000004.WAV'));
  state.pads.A1.volume = 11;
  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(info);

  await assert.rejects(writeCard({ root: card.root, state, fingerprint }), /card has changed/);
  await assert.rejects(runWorker('writeCard', { root: card.root, state, fingerprint }), (error) => {
    assert.match(error.message, /card has changed/);
    assert.equal(error.recoveryRequired, false);
    return true;
  });
  assert.deepEqual(fs.readFileSync(info), before);
  assert.equal(fs.existsSync(path.join(card.root, 'super-pads.json')), false);
  assert.equal(fs.existsSync(path.join(card.root, '.super-pads-transaction')), false);
  assert.equal(state.pads.A1.volume, 11, 'pending edits stay in the caller for a retry');
});

test('a save is refused when the card is no longer readable', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { state, fingerprint } = await open(card);
  fs.rmSync(path.join(card.directory, 'PAD_INFO.BIN'));
  await assert.rejects(writeCard({ root: card.root, state, fingerprint }), /card has changed/);
});

test('a matching fingerprint saves, and the reply fingerprint authorises the next save', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { state, fingerprint } = await open(card);
  state.pads.A1.volume = 77;

  const first = await runWorker('writeCard', { root: card.root, state, fingerprint });
  assert.equal(first.fingerprint, cardFingerprint(card.root));
  assert.notEqual(first.fingerprint, fingerprint);

  // Reusing the pre-save fingerprint now fails, while the returned one is accepted.
  state.pads = Object.fromEntries(first.pads.map((pad) => [pad.label, pad]));
  state.pads.A1.volume = 78;
  await assert.rejects(runWorker('writeCard', { root: card.root, state, fingerprint }), /card has changed/);
  const second = await runWorker('writeCard', { root: card.root, state, fingerprint: first.fingerprint });
  assert.equal(second.fingerprint, cardFingerprint(card.root));
  assert.equal((await runWorker('parsePads', card)).pads[0].volume, 78);
});

test('the save worker requires a fingerprint from the card read', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { state } = await open(card);
  const before = fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN'));
  await assert.rejects(runWorker('writeCard', { root: card.root, state }), /Missing card fingerprint/);
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN')), before);
});

test('same-length audio with preserved timestamps still changes the fingerprint', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const sample = path.join(card.directory, 'A0000001.WAV');
  fs.copyFileSync(card.file, sample);
  // A whole-second timestamp restores exactly; fractional times can shift by a millisecond through Date rounding.
  const stamp = 1_700_000_000;
  fs.utimesSync(sample, stamp, stamp);
  const before = cardFingerprint(card.root);

  // Flip one byte at each end, then restore the original timestamps, as a time-preserving copy would.
  for (const offset of [100, fs.statSync(sample).size - 10]) {
    const bytes = fs.readFileSync(sample);
    bytes[offset] ^= 0xff;
    fs.writeFileSync(sample, bytes);
    fs.utimesSync(sample, stamp, stamp);
    assert.notEqual(cardFingerprint(card.root), before, `byte at ${offset}`);
    bytes[offset] ^= 0xff;
    fs.writeFileSync(sample, bytes);
    fs.utimesSync(sample, stamp, stamp);
    assert.equal(cardFingerprint(card.root), before);
  }
});

test('a card that changes while the save is staging is refused before the commit', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const patterns = path.join(card.root, 'ROLAND', 'SP-404SX', 'PTN');
  fs.mkdirSync(patterns, { recursive: true });
  const patternFile = path.join(patterns, 'PTN00005.BIN');
  fs.writeFileSync(patternFile, Buffer.alloc(16));
  const { state, fingerprint } = await open(card);
  state.patterns.A5 = { label: 'A5', filename: 'PTN00005.BIN', remove: true };
  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(info);

  // The pattern directory is prepared during staging, after the first check has passed.
  const original = fs.mkdirSync;
  const tamper = mock.method(fs, 'mkdirSync', (...args) => {
    const result = original.apply(fs, args);
    fs.copyFileSync(card.file, path.join(card.directory, 'C0000004.WAV'));
    return result;
  });
  t.after(() => tamper.mock.restore());

  await assert.rejects(writeCard({ root: card.root, state, fingerprint }), /card has changed/);
  assert.equal(tamper.mock.callCount() > 0, true, 'the staging hook ran');
  tamper.mock.restore();
  assert.deepEqual(fs.readFileSync(info), before);
  assert.equal(fs.existsSync(patternFile), true, 'the pattern file was not deleted');
  assert.equal(fs.existsSync(path.join(card.root, 'super-pads.json')), false);
  assert.equal(fs.existsSync(path.join(card.root, '.super-pads-transaction')), false);
});

test('a changed card is refused before any interrupted journal on it is recovered', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { state, fingerprint } = await open(card);

  // Leave a half-finished save on the card, as a different card with an interrupted journal would have.
  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const tx = new CardTransaction(card.root);
  writeNew(tx.stage(`${SAMPLE_DIRECTORY}/PAD_INFO.BIN`), Buffer.alloc(3840));
  writeNew(tx.stage('super-pads.json'), '{}');
  const rename = fs.renameSync;
  const interrupt = mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(card.root, 'super-pads.json')) throw new Error('Simulated interruption');
    return rename(source, target);
  });
  assert.throws(() => tx.commit(), /interruption/);
  interrupt.mock.restore();
  const interrupted = fs.readFileSync(info);

  await assert.rejects(writeCard({ root: card.root, state, fingerprint }), /card has changed/);
  assert.deepEqual(fs.readFileSync(info), interrupted, 'recovery did not run on the unidentified card');
  assert.equal(fs.existsSync(path.join(card.root, '.super-pads-transaction')), true, 'the journal was left for the reopen flow');
});

test('a changed stretch in the middle of a long sample is noticed', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const sample = path.join(card.directory, 'A0000001.WAV');
  const bytes = Buffer.alloc(1024 * 1024, 7);
  fs.writeFileSync(sample, bytes);
  const stamp = 1_700_000_000;
  fs.utimesSync(sample, stamp, stamp);
  const before = cardFingerprint(card.root);

  // A stretch about as long as the probe spacing (1/32 of the file) cannot slip between probes.
  bytes.fill(9, 400 * 1024, 400 * 1024 + 40 * 1024);
  fs.writeFileSync(sample, bytes);
  fs.utimesSync(sample, stamp, stamp);
  assert.notEqual(cardFingerprint(card.root), before);
});
