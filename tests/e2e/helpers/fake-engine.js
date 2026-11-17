// 一時 PATH の先頭へ置く偽 claude / 偽 codex のスクリプトに足す断片。
//
// VK Terminals は Codex が起動から 5 秒以内に終了すると、1 回だけ起動し直す（issue #621）。
// 呼び出しを記録してすぐ終了する偽 codex だと、この起動し直しで呼び出しが 1 回増えるため、
// 偽 codex は本物の Codex と同じく起動したまま残す。
// アプリ終了時の後始末から漏れても残り続けないよう、60 秒たったら自分から終了する。
// 偽 claude は起動し直しの対象外のため、従来どおり記録後すぐ終了する。
const FAKE_CODEX_STAY_ALIVE_MS = 60_000;

function fakeEngineStayAliveSource(binName) {
  return binName === 'codex' ? `setTimeout(() => {}, ${FAKE_CODEX_STAY_ALIVE_MS});\n` : '';
}

module.exports = { fakeEngineStayAliveSource, FAKE_CODEX_STAY_ALIVE_MS };
