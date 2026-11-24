// Seeded randomness for tests, so a failure can be replayed.
// Every run uses TEST_SEED if set, otherwise a fresh seed; a failing test's message ends with
// "replay with TEST_SEED=<seed>".
// Note: for concurrency tests the seed replays the jitter sequence, not the event-loop scheduling,
// so a replay is likely but not guaranteed to hit the same interleaving.

export const SEED = process.env.TEST_SEED !== undefined ? Number(process.env.TEST_SEED) >>> 0 : (Date.now() ^ (process.pid << 16)) >>> 0;

/** mulberry32: a small, well-distributed 32-bit PRNG. Returns () => [0, 1). */
export function prng(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wrap a test body so any failure names the seed. */
export const replayable = (fn) => async (t) => {
  try {
    await fn(t);
  } catch (e) {
    // AssertionErrors print their generated diff, not an edited message, so wrap the error and keep
    // the original (with its diff) as the cause.
    t.diagnostic(`replay with TEST_SEED=${SEED}`);
    throw new Error(`replay with TEST_SEED=${SEED}`, { cause: e });
  }
};
