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

// apiUrl があるペインを管理ペインとして扱う。表示・通知・ビープで同じ基準を使う。
function isManagedPaneState({ apiUrl } = {}) {
  return typeof apiUrl === 'string' && apiUrl !== '';
}

// apiUrl がある管理ペインは、外部権威または TUI 構造で確定できる待ちだけを表示する。
function deriveDisplayWaiting({ localWaiting, structuralWaiting, externalWaiting, apiUrl }) {
  const managed = isManagedPaneState({ apiUrl });
  return !!externalWaiting || (managed ? !!structuralWaiting : !!localWaiting);
}

// 管理ペインは表示上の待ち、非管理ペインは従来のローカル待ちの立ち上がりで鳴らす。
function shouldBeepForPaneWaiting({ apiUrl, waitingBefore, waiting, displayWaitingBefore, displayWaiting }) {
  const managed = isManagedPaneState({ apiUrl });
  return managed
    ? !displayWaitingBefore && !!displayWaiting
    : !waitingBefore && !!waiting;
}

return {
  deriveStatus,
  isManagedPaneState,
  deriveDisplayWaiting,
  shouldBeepForPaneWaiting,
};
});
