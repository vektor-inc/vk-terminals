/* global module */

// ─── Status derivation ───────────────────────────────────────────────────────

// deriveStatus: waiting / running / idle を純粋に判定する。
function deriveStatus({
  localWaiting,
  externalWaiting,
  now,
  lastOutputTime,
  lastInputTime,
  runningIdleTimeoutMs,
  runningInputGuardMs,
}) {
  if (localWaiting || externalWaiting) return 'waiting';
  const recentOutput = now - (lastOutputTime || 0) <= runningIdleTimeoutMs;
  const recentInput = now - (lastInputTime || 0) <= runningInputGuardMs;
  return (recentOutput && !recentInput) ? 'running' : 'idle';
}

module.exports = {
  deriveStatus,
};
