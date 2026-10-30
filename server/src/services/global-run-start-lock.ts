// Serializes "count running runs + flip one queued run to running" across all
// agents in this process, so the instance-wide concurrent-run cap cannot be
// overshot by two agents claiming at the same time. Unlike withAgentStartLock
// there is no stale bypass: a bypass would let a claim exceed the cap. Callers
// must keep the critical section to database work only (no adapter calls, no
// promotion of other runs), so it cannot wait on itself.
let tail: Promise<void> = Promise.resolve();

export async function withGlobalRunStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}
