const writeCard = require('../writeCard');

/** Return one terminal result; the renderer retains its pending changes on failure. */
onmessage = async ({ data }) => {
  try {
    // Production saves must prove which card read they were built from; only direct library callers may omit it.
    if (typeof data?.fingerprint !== 'string') throw new Error('Missing card fingerprint. Reopen the card before saving.');
    postMessage({ success: true, ...await writeCard(data) });
  } catch (error) {
    postMessage({ success: false, error: error.message, recoveryRequired: Boolean(error.recoveryRequired) });
  }
};
