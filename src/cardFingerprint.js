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
/** Evenly spaced probes between the two ends of long files, so a differing stretch in the middle is noticed. */
const PROBES = 32;
const PROBE_BYTES = 4096;

/**
 * Hash both ends of an open file plus evenly spaced probes across the middle. Files up to 128 KiB are hashed in full.
 * Longer files are sampled: any changed stretch longer than the gap between probes (about 1/32 of the file) is
 * seen, but a shorter edit that keeps both size and timestamp can still go unnoticed.
 */
function edgeDigest(fd, size) {
  const hash = createHash('sha256');
  const read = (offset, length) => {
    const chunk = Buffer.alloc(length);
    fs.readSync(fd, chunk, 0, length, offset);
    hash.update(chunk);
  };
  read(0, Math.min(size, SAMPLE_BYTES));
  if (size > SAMPLE_BYTES) read(size - Math.min(size - SAMPLE_BYTES, SAMPLE_BYTES), Math.min(size - SAMPLE_BYTES, SAMPLE_BYTES));
  const middleStart = SAMPLE_BYTES;
  const middleLength = size - 2 * SAMPLE_BYTES;
  if (middleLength > PROBE_BYTES) {
    for (let i = 0; i < PROBES; i++) {
      const offset = middleStart + Math.floor((middleLength - PROBE_BYTES) * i / (PROBES - 1));
      read(offset, PROBE_BYTES);
    }
  }
  return hash.digest('hex');
}

/**
 * Identify the card contents an editor session was built from: the full PAD_INFO.BIN bytes plus, for every sample and
 * pattern file (or its absence), its size, modification time, and a content digest (see edgeDigest). Sizes and
 * timestamps alone can match on a different card (for example a copy made with preserved times), so the content
 * samples catch swapped cards whose audio differs. Hashing every sample in full would read the whole card several
 * times per save, so long samples are probed rather than read completely; pattern files and short samples are
 * covered completely.
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
