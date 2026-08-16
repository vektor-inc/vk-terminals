// 新規ペインで起動する AI エンジン（claude / codex）とモデル指定を検証し、
// ペインへ書き込む起動コマンドを組み立てる。
//
// 設計思想（崩さないこと）: 実行ファイル名は固定文字列のみを許可リストから返し、
// 引数（claude の model）も別の許可リストで検証する。API は設定次第でループバック
// 以外にも公開され得るため、任意文字列が起動コマンドへそのまま混入する口を
// 絶対に開けない（main.js 冒頭・README のセキュリティ節も参照）。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKClaudeModel = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CLAUDE_MODEL_LENGTH = 64;

  // 許可リスト方式。英数字・`.`・`_`・`-`・`[`・`]` のみを 64 文字まで許可し、先頭は英数字に限る。
  // 「危ない文字を除く」方式は抜けが出るため、通す文字を列挙して想定外を自動的に落とす。
  // `[` `]` を許可するのは claude-opus-5[1m] のようなモデル名があるため。zsh ではこれが
  // ファイル名展開の記号になるので、書き込み時はシングルクォートで囲んで無効化する。
  // シングルクォートは許可文字に含めないため、クォートの脱出は成立しない。
  const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$/;

  function isValidClaudeModel(value) {
    if (typeof value !== 'string') return false;
    if (value.length > MAX_CLAUDE_MODEL_LENGTH) return false;
    return CLAUDE_MODEL_PATTERN.test(value);
  }

  // ペインへ書き込む claude の起動コマンド（末尾の改行は含めない）を返す。
  // 未指定・不正値では例外を投げず、従来どおりの素の `claude` へ倒す（安全側の既定）。
  function buildClaudeLaunchCommand(model) {
    if (!isValidClaudeModel(model)) return 'claude';
    return `claude --model '${model}'`;
  }

  // ─── engine（issue #367） ───────────────────────────────────────────────
  // 新規ペインで起動する AI エンジンの許可リスト。将来エンジンを足すときは
  // この配列（と下の ENGINE_LAUNCH_COMMANDS）だけを直せば済む形にしてある。
  // Object.freeze で凍結し、呼び出し側が push() 等で許可値を増やせないようにする
  // （安藤の指摘・対応6）。
  //
  // NOTE（次にエンジンを足すとき向け）: このファイルは元々 claude 専用だったところへ
  // engine の許可リストという別関心事を後乗せしている。ファイル名 claudeModel.js が
  // 実態と合わなくなってきているが、今回は差分を広げないため据え置いた。次にエンジンを
  // 追加するときは、engine 関連のコードを別ファイル（例: renderer/engineModel.js）へ
  // 切り出すことを検討すること。
  const ALLOWED_ENGINES = Object.freeze(['claude', 'codex']);

  function isValidEngine(value) {
    return typeof value === 'string' && ALLOWED_ENGINES.includes(value);
  }

  // engine → 起動コマンドの固定文字列マッピング（'claude' はモデル対応があるため
  // buildClaudeLaunchCommand を使い、ここには含めない）。値から動的にコマンド文字列を
  // 組み立てず、固定リテラルを返すだけにすることで、任意文字列が起動コマンドへ
  // 混入する余地を無くしている。
  //
  // Object.create(null) で作る（安藤の指摘 MEDIUM・必須1）: 素のオブジェクトリテラル
  // （`{ codex: 'codex' }`）だと Object.prototype を継承するため、`engine` に
  // 'constructor' / 'toString' / 'valueOf' / 'hasOwnProperty' のような文字列を渡すと
  // 添字アクセス（`ENGINE_LAUNCH_COMMANDS[engine]`）が Object.prototype 側のメンバー
  // （関数）を返してしまい、`|| null` を通過しない（関数は truthy なため）。
  // Object.create(null) なら継承元が無いため、この経路が構造的に成立しない。
  const ENGINE_LAUNCH_COMMANDS = Object.create(null);
  ENGINE_LAUNCH_COMMANDS.codex = 'codex';

  // 'claude' 以外の engine の起動コマンドを返す。未対応の engine（'claude' 自身を
  // 含む）には null を返す。'claude' は呼び出し側が buildClaudeLaunchCommand を使うこと。
  //
  // 二重の安全策（安藤の指摘・必須1）: ENGINE_LAUNCH_COMMANDS 自体を Object.create(null)
  // にした上で、さらに Object.prototype.hasOwnProperty.call() で自プロパティかどうかを
  // 明示確認する。前者だけで prototype 経由の混入は防げるが、将来この定数がまた
  // オブジェクトリテラルに書き換えられても壊れないよう、値の取り出し方自体を
  // 「継承を辿らない」形に固定しておく。
  function buildEngineLaunchCommand(engine) {
    if (typeof engine !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(ENGINE_LAUNCH_COMMANDS, engine)) return null;
    const command = ENGINE_LAUNCH_COMMANDS[engine];
    return typeof command === 'string' ? command : null;
  }

  // 呼び出し側（main.js の terminal:create）が resolvedEngine（isValidEngine 済み・
  // 未指定/不正値は 'claude' に倒した後の値）と options.model から、実際にペインへ
  // 書き込む起動コマンドを 1 箇所で決める純粋関数（副作用なし。console.warn は main.js
  // 側が modelIgnored を見て LOG_PREFIX 付きで出す。テスト容易性のため状態を持たせない）。
  //
  // 仕様（issue #367 / ユーザー承認済み）: resolvedEngine が 'claude' 以外のときは
  // model を無視して素のエンジンを起動する（400 にはしない）。vk-orchestrator は
  // claudeModel 設定が空でなければ常に model を載せる作りのため、ここで弾くと
  // engine を切り替えた瞬間にペイン作成が全て失敗する。vk-orchestrator の tmux モード
  // （buildPaneClaudeCommand・vektor-inc/vk-orchestrator#406）が同じ問題を「無視」で
  // 解決済みで、挙動を揃える。Codex 側のモデル指定（codex --model 等）は本 issue の
  // スコープ外（後日の追加実装）。
  //
  // 戻り値:
  //   - command: ペインへ書き込む起動コマンド文字列
  //   - modelIgnored: model が指定されていたが無視された（＝呼び出し側が警告ログを
  //     出すべき）かどうか
  function buildEngineAwareLaunchCommand(resolvedEngine, model) {
    if (resolvedEngine === 'claude') {
      return { command: buildClaudeLaunchCommand(model), modelIgnored: false };
    }
    // ENGINE_LAUNCH_COMMANDS に無い値がここに来るのは、呼び出し側が isValidEngine を
    // 経由せず未検証の resolvedEngine を渡した場合のみ（本来は起きない想定の防御的
    // フォールバック）。その場合は任意文字列を書き込まないよう安全側の素の claude へ
    // 倒す。この経路では model は使われていないため無視扱いにはしない
    // （claude 起動時は model を弾いていないのと同じ「安全側の既定」の考え方）。
    //
    // typeof command !== 'string' で判定する（安藤の指摘・必須1。`=== null` だけの
    // 判定は buildEngineLaunchCommand 側の実装（prototype 経由の混入対策）に依存して
    // しまう。呼び出し側でも独立に「文字列以外は絶対に書き込まない」を保証しておけば、
    // buildEngineLaunchCommand が将来 null 以外の非文字列を返す実装に変わっても
    // ここで二重に安全側へ倒れる）。
    const command = buildEngineLaunchCommand(resolvedEngine);
    if (typeof command !== 'string') {
      return { command: 'claude', modelIgnored: false };
    }
    const modelIgnored = model !== undefined && model !== null;
    return { command, modelIgnored };
  }

  return {
    MAX_CLAUDE_MODEL_LENGTH,
    CLAUDE_MODEL_PATTERN,
    isValidClaudeModel,
    buildClaudeLaunchCommand,
    ALLOWED_ENGINES,
    isValidEngine,
    buildEngineLaunchCommand,
    buildEngineAwareLaunchCommand,
  };
});
