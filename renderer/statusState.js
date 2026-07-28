// ─── Status derivation ───────────────────────────────────────────────────────
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKStatusState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

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

return {
  deriveStatus,
};
});
