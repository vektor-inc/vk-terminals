// 新規ペインで起動する AI エンジン（claude / codex）とモデル指定を検証し、
// ペインへ書き込む起動コマンドを組み立てる。
//
// 設計思想（崩さないこと）: 実行ファイル名は固定文字列のみを許可リストから返し、
// 引数（各エンジンの model）も別の許可リストで検証する。API は設定次第でループバック
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
  const MAX_CODEX_MODEL_LENGTH = MAX_CLAUDE_MODEL_LENGTH;

  // 許可リスト方式。英数字・`.`・`_`・`-`・`[`・`]` のみを 64 文字まで許可し、先頭は英数字に限る。
  // 「危ない文字を除く」方式は抜けが出るため、通す文字を列挙して想定外を自動的に落とす。
  // `[` `]` を許可するのは claude-opus-5[1m] のようなモデル名があるため。zsh ではこれが
  // ファイル名展開の記号になるので、書き込み時はシングルクォートで囲んで無効化する。
  // シングルクォートは許可文字に含めないため、クォートの脱出は成立しない。
  const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$/;
  const CODEX_MODEL_PATTERN = CLAUDE_MODEL_PATTERN;
  const ALLOWED_CODEX_APPROVAL_POLICIES = Object.freeze(['untrusted', 'on-failure', 'on-request', 'never']);
  // danger-full-access は作業フォルダ外への書き込み制限を外すため、API 経由では許可しない。
  const ALLOWED_CODEX_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);

  function isValidCodexApprovalPolicy(value) {
    return typeof value === 'string' && ALLOWED_CODEX_APPROVAL_POLICIES.includes(value);
  }

  function isValidCodexSandboxMode(value) {
    return typeof value === 'string' && ALLOWED_CODEX_SANDBOX_MODES.includes(value);
  }

  // タスク用ポリシー（issue #428）。preset と、Orchestrator が管理する GitHub owner の
  // 許可リストだけを受ける。許可リストは起動時に検証し、子が変更できないランチャーへ束縛する。
  // 名前は utils/codexTaskPolicy.js の CODEX_TASK_POLICY_PRESETS のキーと一致させること
  // （片方だけ変えると壊れる。tests/codexTaskPolicy.test.js が一致を検証している）。
  const ALLOWED_CODEX_POLICY_KEYS = Object.freeze(['preset', 'allowedOwners']);
  const ALLOWED_CODEX_POLICY_PRESETS = Object.freeze(['orchestrated-task']);
  const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9._-]+$/;
  // ポリシーの CODEX_HOME はアプリ（main.js）が生成した絶対パスだけを受け付け、
  // シングルクォートと制御文字は拒否する（クォートの脱出を成立させない）。
  const CODEX_POLICY_HOME_PATTERN = /^\/[^'\x00-\x1f\x7f]+$/;

  function validateCodexPolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid codexPolicy' };
    }
    for (const key of Object.keys(value)) {
      if (!ALLOWED_CODEX_POLICY_KEYS.includes(key)) return { ok: false, error: `unknown codexPolicy key: ${key}` };
    }
    if (typeof value.preset !== 'string' || !ALLOWED_CODEX_POLICY_PRESETS.includes(value.preset)) {
      return { ok: false, error: 'invalid codexPolicy preset' };
    }
    let allowedOwners;
    if (value.allowedOwners !== undefined) {
      if (!Array.isArray(value.allowedOwners) || value.allowedOwners.length === 0 || value.allowedOwners.length > 100) {
        return { ok: false, error: 'invalid codexPolicy allowedOwners' };
      }
      allowedOwners = [];
      const seen = new Set();
      for (const owner of value.allowedOwners) {
        if (typeof owner !== 'string' || !GITHUB_OWNER_PATTERN.test(owner) || ['.', '..'].includes(owner) || owner.startsWith('-')) {
          return { ok: false, error: 'invalid codexPolicy allowedOwners' };
        }
        const normalized = owner.toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          allowedOwners.push(owner);
        }
      }
    }
    return { ok: true, codexPolicy: { preset: value.preset, ...(allowedOwners === undefined ? {} : { allowedOwners }) } };
  }

  function validateCodexLaunchOptions(engine, options = {}) {
    const approvalPolicy = options.approvalPolicy;
    const sandboxMode = options.sandboxMode;
    const hasCodexOptions = approvalPolicy !== undefined || sandboxMode !== undefined || options.codexPolicy !== undefined;
    if (hasCodexOptions && engine !== 'codex') return { ok: false, error: 'Codex options require engine "codex"' };
    if (approvalPolicy !== undefined && !isValidCodexApprovalPolicy(approvalPolicy)) {
      return { ok: false, error: 'invalid approvalPolicy' };
    }
    if (sandboxMode !== undefined && !isValidCodexSandboxMode(sandboxMode)) {
      return { ok: false, error: 'invalid sandboxMode' };
    }
    let codexPolicy;
    if (options.codexPolicy !== undefined) {
      const validatedPolicy = validateCodexPolicy(options.codexPolicy);
      if (!validatedPolicy.ok) return validatedPolicy;
      codexPolicy = validatedPolicy.codexPolicy;
    }
    return { ok: true, approvalPolicy, sandboxMode, codexPolicy };
  }

  // Claude と Codex は現時点で必要な文字種・上限が同じなので、許可リストの本体を共有する。
  // エンジン別の関数名は残し、将来どちらかの命名規則だけが変わったときに呼び出し側の
  // 意味を崩さず検証規則を分離できるようにする。
  function isValidEngineModel(value, maxLength, pattern) {
    if (typeof value !== 'string') return false;
    if (value.length > maxLength) return false;
    return pattern.test(value);
  }

  function isValidClaudeModel(value) {
    return isValidEngineModel(value, MAX_CLAUDE_MODEL_LENGTH, CLAUDE_MODEL_PATTERN);
  }

  function isValidCodexModel(value) {
    return isValidEngineModel(value, MAX_CODEX_MODEL_LENGTH, CODEX_MODEL_PATTERN);
  }

  // engine → その engine の model 検証関数。未登録の engine は「通してよい値が
  // 定義されていない」ものとして必ず拒否する。エンジン追加時にこの対応表を更新すれば、
  // HTTP 受け口もコマンド組み立ても同じ検証規則へ追随する。
  const ENGINE_MODEL_VALIDATORS = Object.create(null);
  ENGINE_MODEL_VALIDATORS.claude = isValidClaudeModel;
  ENGINE_MODEL_VALIDATORS.codex = isValidCodexModel;
  Object.freeze(ENGINE_MODEL_VALIDATORS);

  function isValidModelForEngine(engine, value) {
    if (typeof engine !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(ENGINE_MODEL_VALIDATORS, engine)) return false;
    const validate = ENGINE_MODEL_VALIDATORS[engine];
    return typeof validate === 'function' ? validate(value) : false;
  }

  // ペインへ書き込む claude の起動コマンド（末尾の改行は含めない）を返す。
  // 未指定・不正値では例外を投げず、従来どおりの素の `claude` へ倒す（安全側の既定）。
  function buildClaudeLaunchCommand(model) {
    if (!isValidClaudeModel(model)) return 'claude';
    return `claude --model '${model}'`;
  }

  // Codex も固定実行ファイル名と検証済み引数だけで組み立てる。共有 daemon の設定と
  // 衝突して起動が止まるのを防ぐため、すべての起動経路で `--no-daemon` を付ける。
  // 未指定・不正値は HTTP を通らない内部経路への最終防衛線として既定モデルへ倒す。
  //
  // タスク用ポリシー付き（options.codexPolicy）の場合は、main.js が生成した専用 CODEX_HOME
  // （options.codexPolicyHome）を必須とし、その起動だけ CODEX_HOME を向ける。専用 CODEX_HOME が
  // 無い・不正なときは承認方針だけを付けた起動にせず、例外で止める（呼び出し側は事前に
  // resolveCodexTaskPolicyLaunchOptions で用意するため、通常ここには来ない最終防衛線）。
  // sandboxMode 未指定でも workspace-write を明示し、新規作成と再起動で同じ実効ポリシーにする。
  function buildCodexLaunchCommand(model, options = {}) {
    const validated = validateCodexLaunchOptions('codex', options);
    const parts = ['codex', '--no-daemon'];
    if (isValidCodexModel(model)) parts.push('--model', `'${model}'`);
    if (options.codexPolicy !== undefined && !validated.ok) {
      throw new Error('invalid codex task policy');
    }
    if (validated.ok && validated.codexPolicy !== undefined) {
      const home = options.codexPolicyHome;
      if (typeof home !== 'string' || !CODEX_POLICY_HOME_PATTERN.test(home)) {
        throw new Error('codex task policy requires a prepared policy home');
      }
      // 判定に使った一時フォルダと同じ値を TMPDIR として固定する（シェル側の TMPDIR で判定をすり抜けられないように）。
      const tmpdir = options.codexPolicyTmpdir;
      if (typeof tmpdir !== 'string' || !CODEX_POLICY_HOME_PATTERN.test(tmpdir)) {
        throw new Error('codex task policy requires a prepared policy tmpdir');
      }
      parts.unshift(`TMPDIR='${tmpdir}'`, `CODEX_HOME='${home}'`);
    }
    if (validated.ok && validated.approvalPolicy !== undefined) {
      parts.push('--ask-for-approval', `'${validated.approvalPolicy}'`);
    }
    const sandboxMode = validated.ok && validated.sandboxMode === undefined && validated.codexPolicy !== undefined
      ? 'workspace-write'
      : validated.sandboxMode;
    if (validated.ok && sandboxMode !== undefined) {
      parts.push('--sandbox', `'${sandboxMode}'`);
    }
    return parts.join(' ');
  }

  // engine → model 対応の起動コマンドビルダー。検証関数の対応表と同じキーだけを
  // 登録し、エンジン別の分岐が複数箇所へ増えないようにする。
  const ENGINE_COMMAND_BUILDERS = Object.create(null);
  ENGINE_COMMAND_BUILDERS.claude = buildClaudeLaunchCommand;
  ENGINE_COMMAND_BUILDERS.codex = buildCodexLaunchCommand;
  Object.freeze(ENGINE_COMMAND_BUILDERS);

  // ─── engine（issue #367） ───────────────────────────────────────────────
  // 新規ペインで起動する AI エンジンの許可リスト。将来エンジンを足すときは
  // この配列とエンジン別の検証・ビルダー・固定コマンド対応表を揃えて更新する。
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
  //
  // Object.freeze する（安藤の指摘・修正3）: ALLOWED_ENGINES は凍結している一方こちらは
  // 未凍結だと非対称で意図が読み取りにくい。このオブジェクト自体は export しておらず
  // （呼び出し側は buildEngineLaunchCommand 経由でしか触れない）実害は無いが、
  // 「値を書き換えない定数」という扱いを揃えるため凍結する。
  const ENGINE_LAUNCH_COMMANDS = Object.create(null);
  ENGINE_LAUNCH_COMMANDS.codex = 'codex --no-daemon';
  Object.freeze(ENGINE_LAUNCH_COMMANDS);

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
  // 書き込む起動コマンドを 1 箇所で決める純粋関数。副作用を持たせず、警告が必要かは
  // 戻り値の modelIgnored を使って main.js 側で判断する。
  //
  // 仕様（issue #374）: Claude / Codex はそれぞれ専用の検証関数を通した model を
  // `--model` 引数として受け取る。未指定・不正値は各ビルダー内で素のコマンドへ倒し、
  // HTTP を通らない IPC 経路でも任意文字列をコマンドへ混入させない。
  //
  // 戻り値:
  //   - command: ペインへ書き込む起動コマンド文字列
  //   - modelIgnored: 未登録エンジンで指定された model を無視したか
  function buildEngineAwareLaunchCommand(resolvedEngine, model, options = {}) {
    if (typeof resolvedEngine === 'string'
      && Object.prototype.hasOwnProperty.call(ENGINE_COMMAND_BUILDERS, resolvedEngine)) {
      const buildCommand = ENGINE_COMMAND_BUILDERS[resolvedEngine];
      if (typeof buildCommand === 'function') {
        return { command: buildCommand(model, options), modelIgnored: false };
      }
    }
    // ENGINE_COMMAND_BUILDERS に無い値がここに来るのは、呼び出し側が isValidEngine を
    // 経由せず未検証の resolvedEngine を渡した場合のみ（本来は起きない想定の防御的
    // フォールバック）。ENGINE_LAUNCH_COMMANDS の唯一の登録値 codex は上のビルダーで
    // 先に処理されるため、buildEngineAwareLaunchCommand から buildEngineLaunchCommand の
    // 登録済みコマンドへ到達する経路は現在存在しない。未登録値は任意文字列を書き込まない
    // よう安全側の素の claude へ倒す。この経路で model が指定されていれば、黙って捨てず
    // 警告できるよう無視扱いにする。
    //
    // typeof command !== 'string' で判定する（安藤の指摘・必須1。`=== null` だけの
    // 判定は buildEngineLaunchCommand 側の実装（prototype 経由の混入対策）に依存して
    // しまう。呼び出し側でも独立に「文字列以外は絶対に書き込まない」を保証しておけば、
    // buildEngineLaunchCommand が将来 null 以外の非文字列を返す実装に変わっても
    // ここで二重に安全側へ倒れる）。
    const command = buildEngineLaunchCommand(resolvedEngine);
    if (typeof command !== 'string') {
      return { command: 'claude', modelIgnored: model !== undefined };
    }
    return { command, modelIgnored: model !== undefined };
  }

  return {
    MAX_CLAUDE_MODEL_LENGTH,
    CLAUDE_MODEL_PATTERN,
    isValidClaudeModel,
    buildClaudeLaunchCommand,
    MAX_CODEX_MODEL_LENGTH,
    CODEX_MODEL_PATTERN,
    isValidCodexModel,
    isValidModelForEngine,
    buildCodexLaunchCommand,
    ALLOWED_CODEX_APPROVAL_POLICIES,
    ALLOWED_CODEX_SANDBOX_MODES,
    isValidCodexApprovalPolicy,
    isValidCodexSandboxMode,
    ALLOWED_CODEX_POLICY_KEYS,
    ALLOWED_CODEX_POLICY_PRESETS,
    validateCodexPolicy,
    validateCodexLaunchOptions,
    ALLOWED_ENGINES,
    isValidEngine,
    buildEngineLaunchCommand,
    buildEngineAwareLaunchCommand,
  };
});
