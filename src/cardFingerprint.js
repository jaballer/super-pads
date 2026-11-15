const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SAMPLE_DIRECTORY } = require('./cardTransaction');
const { PATTERN_DIRECTORY } = require('./readPatterns');

/** Every card file the sampler owns: 120 sample slots and 120 pattern slots, using canonical names. */
const SAMPLE_FILES = Array.from('ABCDEFGHIJ', (bank) => Array.from({ length: 12 }, (_, i) => `${bank}${String(i + 1).padStart(7, '0')}.WAV`)).flat();
const PATTERN_FILES = Array.from({ length: 120 }, (_, i) => `PTN${String(i).padStart(5, '0')}.BIN`);

/** Bytes read from each end of a file; pattern files and short samples are therefore hashed completely. */
const SAMPLE_BYTES = 64 * 1024;

/** Hash the head and tail of an open file; both ends are needed to notice same-length audio that differs. */
function edgeDigest(fd, size) {
  const hash = createHash('sha256');
  const head = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
  fs.readSync(fd, head, 0, head.length, 0);
  hash.update(head);
  if (size > SAMPLE_BYTES) {
    const tail = Buffer.alloc(Math.min(size - SAMPLE_BYTES, SAMPLE_BYTES));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    hash.update(tail);
  }
  return hash.digest('hex');
}

/**
 * Identify the card contents an editor session was built from: the full PAD_INFO.BIN bytes plus, for every sample and
 * pattern file (or its absence), its size, modification time, and a hash of its first and last 64 KiB. Sizes and
 * timestamps alone can match on a different card (for example a copy made with preserved times), so the content
 * samples catch swapped cards whose audio differs. Hashing every sample in full would read a whole card on each
 * check, so the middle of long samples is not read; pattern files and short samples are covered completely.
 * super-pads.json is excluded because only this application writes it. Throws if PAD_INFO.BIN is unreadable.
 */
function cardFingerprint(root) {
  const hash = createHash('sha256');
  const samples = path.join(root, SAMPLE_DIRECTORY);
  hash.update(fs.readFileSync(path.join(samples, 'PAD_INFO.BIN')));
  const addFiles = (directory, names) => {
    for (const name of names) {
      let identity = 'absent';
      try {
        const fd = fs.openSync(path.join(directory, name), 'r');
        try {
          // Size, time, and contents come from one handle, so a file replaced mid-check cannot mix identities.
          // BigInt stats give exact whole milliseconds; float mtimes can read as .999 after a time-preserving copy.
          const { size, mtimeMs } = fs.fstatSync(fd, { bigint: true });
          identity = `${size}:${mtimeMs}:${edgeDigest(fd, Number(size))}`;
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      hash.update(`\n${name}:${identity}`);
    }
  };
  addFiles(samples, SAMPLE_FILES);
  addFiles(path.join(root, PATTERN_DIRECTORY), PATTERN_FILES);
  return hash.digest('hex');
}

module.exports = cardFingerprint;
