const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SAMPLE_DIRECTORY } = require('./cardTransaction');
const { PATTERN_DIRECTORY } = require('./readPatterns');

/** Every card file the sampler owns: 120 sample slots and 120 pattern slots, using canonical names. */
const SAMPLE_FILES = Array.from('ABCDEFGHIJ', (bank) => Array.from({ length: 12 }, (_, i) => `${bank}${String(i + 1).padStart(7, '0')}.WAV`)).flat();
const PATTERN_FILES = Array.from({ length: 120 }, (_, i) => `PTN${String(i).padStart(5, '0')}.BIN`);

/**
 * Identify the card contents an editor session was built from: the full PAD_INFO.BIN bytes plus the size and
 * modification time of every sample and pattern file (or its absence). Audio payloads are not hashed so large
 * cards stay fast; a changed, swapped, or sampler-edited card still differs in at least one of these values.
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
        const { size, mtimeMs } = fs.statSync(path.join(directory, name));
        identity = `${size}:${Math.trunc(mtimeMs)}`;
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
