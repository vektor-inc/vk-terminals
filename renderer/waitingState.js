// ─── Waiting detection ────────────────────────────────────────────────────────
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKWaitingState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// 「〜を（お）待ちしています / 〜を待っています」で待っている対象の許可リスト。
// ユーザーが差し出すもの（入力・選択・承認など）に限定し、第三者（サブエージェントや
// CI）の成果物を待つ進捗ナレーションと区別する（issue vektor-inc/vk-orchestrator#212）。
//
// なぜこれ以上絞り込まないか（レビューで「回答→ご回答」「返信→ご返信」への絞り込みが
// 提案されたが、意図的に採らなかった）:
//   - 「麗美の回答を待っています」「和田からの返信を待っています」のように、第三者宛ての
//     ナレーションが一部ヒットするのは事実。ただし本機能の判断基準は一貫して
//     「誤検知（うるさい）より見逃し（AI が止まったことに気づけない）のほうが実害が大きい」。
//     ご付きへの絞り込みは、コストを見逃し側へ寄せる変更になる。
//   - 現在の状態機械では、この種の誤検知は出力が流れている限り上限間隔
//     （WAITING_MAX_EVAL_INTERVAL_MS = 5 秒）で自動解除される。上限評価は「前回の評価
//     以降に届いた出力」だけを見る（selectWaitingBuffer 参照）ので、解除までの時間は
//     出力量に依らずこの間隔で頭打ちになり、被害は「作業中に数秒バッジが点く」に収まる。
//     旧実装のように永久に張り付くことはない。
//     （※ 出力が完全に止まっているときは解除されないが、それは「相手が止まっている」
//       状態なので、バッジが点いたままでも実害は小さい。）
//   将来この判断を見直すときは、上のトレードオフが変わったかどうかから検討すること。
const WAITING_TARGET_NOUNS = [
  '入力', '選択', '承認', '回答',
  'ご対応', 'ご確認', 'ご返信', '返信', 'ご連絡', 'ご指示', 'ご判断', 'ご返答', 'お返事',
];
const WAITING_TARGET_NOUNS_PATTERN = new RegExp(
  `(?:${WAITING_TARGET_NOUNS.join('|')})(?:を)?(?:お)?待(?:ち|って)`,
);

const WAITING_PATTERNS = [
  /\[y\/N\]/i, /\[Y\/n\]/i, /\(y\/n\)/i,
  /Press Enter/i,
  /Continue\?/i,
  /Do you want to/i,
  /Would you like/i,
  /Proceed\?/i,
  /\? .{1,60}[›>❯]\s*$/m,  // inquirer / Claude Code prompts
  // Claude Code 承認待ちパターン
  /Yes,?\s+allow/i,
  /No,?\s+don['']t allow/i,
  /Allow\s+(once|always|this)/i,
  /\bAllow\b.{0,40}\?/i,
  /Deny\b/i,
  /Yes\s*\/\s*No/i,
  /❯\s*(Yes|No|Allow|Deny)/,
  /›\s*(Yes|No|Allow|Deny)/,
  /\[\s*A\s*\]llow/i,
  /\[\s*D\s*\]eny/i,
  /approve.*\(y\/n\)/i,
  // NOTE: /permission/i は削除 — Claude Code の UI フッター "bypass permissions on" に誤反応するため
  // 日本語の確認待ちパターン（vk-kore など、Claude が確認を求めて中断する場面で出る文言）
  /ご確認(?:を|ください|お願い)/,
  /続行しますか/,
  /進めて(?:よろしい|よい)/,
  /(?:よろしい|いかが)(?:でしょうか|ですか)[。？?]?\s*$/m,
  // マージ待ちパターン（vk-kore の PR 作成後・マージ判断委譲のタイミング）
  /マージ(?:判断|してください|してもよろしい)/,
  /マージ.{0,30}(?:ご判断|お願い|よろしい|お任せ)/,
  // recap / 追加の確認待ち文言（issue #32）。
  // Claude Code が "※ recap: …承認待ちです。…(disable recaps in /config)" のような
  // 振り返りメッセージを最後に挟むケースで、本文末尾が "承認待ち" や "委任します"
  // のような形になる。これらの「次アクションをユーザーに委ねている」言い回しを拾う。
  // 「〜を（お）待ちしています」系（issue vektor-inc/vk-orchestrator#212）。
  //   旧実装は宛先を問わない /(?:お待ち|待って)(?:しています|います|ます)/ を併置していたため、
  //   「和田の修正を待っています。」「CI の完了を待っています。」のような、第三者
  //   （サブエージェント・外部処理）の完了待ちを伝える進捗ナレーションにも反応し、
  //   AI が動作中でも「入力待ち」が点灯していた。
  //   そこで **待つ対象の名詞を許可リスト化** し、ユーザーが差し出すものを待っている
  //   ときだけ一致させる。「修正 / 完了 / 応答」のような第三者の成果物は列挙しない。
  //   接頭辞なしの「指示 / 判断 / 対応」も、他エージェント宛て（例:「司の指示を待っています」）
  //   になり得るため入れず、ご付きの形だけを許可する。
  WAITING_TARGET_NOUNS_PATTERN,
  /(?:いただけ|いただい)たら.{0,30}(?:委任|お願い|進め|実装)/,
  /(?:お任せ|ご判断)(?:します|ください|いただけ)/,
  // AskUserQuestion / 数字選択肢の UI 検知（issue #46）。
  // Claude Code の AskUserQuestion は「❯ 1. … / 2. …」の選択肢と
  // 「Enter to select / ↑/↓ to navigate / Esc to cancel」のフッターが固定で出る。
  // 既存パターンは ASCII `?` と `❯ Yes|No|Allow|Deny` しか拾えず取りこぼしていた。
  /Enter\s+to\s+select/i,
  /[↑↓]\/[↑↓]\s+to\s+navigate/,
  /Esc\s+to\s+cancel/i,
  /❯\s*\d+\.\s/,  // `❯ 1. ラベル` 形式（任意ラベルの数字選択肢）
  // 全角「？」で終わる質問文。AskUserQuestion 以外の TUI / 日本語プロンプト
  // でも全角？で末尾するケースを拾うための補助パターン。
  // Claude Code の AskUserQuestion 自体は上の `Enter to select` フッターで
  // 確定検知できるため、ここは網羅性ではなく **誤検知抑制** を優先して
  // `m` フラグ無しでバッファ全体の末尾にのみアンカーする。
  // `m` を付けると `lastLines` バッファ（最大 80 行）に残る過去の質問行に
  // 反応して running 中も waiting に張り付くため、その挙動を避ける。
  /[？]\s*$/,
];

function matchesWaiting(cleanBuffer) {
  return WAITING_PATTERNS.some(p => p.test(cleanBuffer));
}

function normalizeWaitingExcludeCwdPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}

function isWaitingCwdExcluded(cwdFull, patterns) {
  if (typeof cwdFull !== 'string' || cwdFull === '') return false;
  const normalized = normalizeWaitingExcludeCwdPatterns(patterns);
  return normalized.some((pattern) => cwdFull.includes(pattern));
}

// ─── 判定タイミング（静止ゲート / issue vektor-inc/vk-orchestrator#212）──────
// PTY 出力のたびに判定すると、作業中スピナー（経過秒数付き）の再描画途中の
// バッファに対して評価してしまい、進捗ナレーションや描画途中の断片で誤検知しやすい。
// 逆に本物の確認待ちでは相手が止まるため出力が途絶える。この差を判定条件に使い、
// 「最後の出力から一定時間静止したら判定する」形にする。
//
// ⚠ renderer/app.js の RUNNING_IDLE_TIMEOUT_MS（1500ms）と同値であることに意味がある。
//   「出力が流れている最中の解除（quiescent = false）では status が idle を経由せず
//   running へ移る」保証は、静止時間 <= RUNNING_IDLE_TIMEOUT_MS が前提。
//   ここだけ伸ばすと deriveStatus の recentOutput が偽になり、解除の瞬間に中間 idle が
//   無言で復活する。変更するときは必ず両方を見ること。
const WAITING_QUIESCENCE_MS = 1500;
// 判定間隔の上限（ms）。出力が静止しないまま流れ続けても、必ずこの間隔ごとに 1 回は
// 評価する。これが無いと、
//   - waiting=false のペインで出力が途切れないまま本物のプロンプトが出た場合に
//     一度も評価されず、検知もビープもされない（取りこぼし）
//   - 誤検知で waiting=true になったまま出力が流れ続けると解除の機会が来ない（張り付き）
// の両方が起きる。状態によらず常時適用する。
const WAITING_MAX_EVAL_INTERVAL_MS = 5000;

// 次に waiting 判定を行うまでの待ち時間（ms）を返す。
//   - lastOutputTime: 最後に PTY 出力を受け取った時刻（静止判定の起点）
//   - pendingSince:   前回の判定以降、最初に出力を受け取った時刻（上限判定の起点）
// 「静止するまで」と「上限間隔」の早い方を採る。
function waitingCheckDelayMs({
  now,
  lastOutputTime,
  pendingSince,
  quiescenceMs = WAITING_QUIESCENCE_MS,
  maxEvalIntervalMs = WAITING_MAX_EVAL_INTERVAL_MS,
}) {
  let target = (lastOutputTime || 0) + quiescenceMs;
  if (pendingSince) target = Math.min(target, pendingSince + maxEvalIntervalMs);
  return Math.max(0, target - now);
}

// 判定時点で出力が静止しているか（＝相手が止まっているか）。
// 静止していれば「入力待ちかもしれない」、流れていれば「相手は動いている」の強い根拠になる。
function isOutputQuiescent({ now, lastOutputTime, quiescenceMs = WAITING_QUIESCENCE_MS }) {
  return now - (lastOutputTime || 0) >= quiescenceMs;
}

// 判定に使うバッファを、判定の種類で使い分ける（issue vektor-inc/vk-orchestrator#212）。
//   - 静止評価（quiescent = true / 出力が止まっている）
//       画面に残っているダイアログを拾う必要があるため、直近ウィンドウ全体
//       （fullBuffer = lastLines / 80 行）で判定する。
//   - 上限評価（quiescent = false / 出力が流れている）
//       前回の評価以降に届いた出力だけ（recentBuffer）で判定する。
//       ウィンドウ全体を見ると、点灯のもとになった文言が 80 行バッファから押し出される
//       まで一致し続けるため、解除までの時間が「経過時間」ではなく「出力の行数レート」に
//       依存してしまう（実測: 1 行 0.2 秒だと解除まで 20 秒 / 解除されない）。
//       直近の数秒に届いた出力だけを見れば、解除は上限間隔で頭打ちになる。
//
// 揺り戻しの自己修復:
//   本物のダイアログが出ている最中に別プロセスが出力を流し続けると、上限評価で
//   いったん解除され得る。その場合も出力が止まった時点の静止評価で lastLines 全体を
//   見直して再点灯するため、状態は自己修復する（ビープはクールダウンで抑止される）。
function selectWaitingBuffer({ quiescent, fullBuffer, recentBuffer }) {
  return (quiescent ? fullBuffer : recentBuffer) || '';
}

// waiting 判定（issue vektor-inc/vk-orchestrator#212）。
// 解除の根拠を「判定時点で出力が流れている」ことに一本化する。
//
//   静止して呼ばれた評価（quiescent = true / 相手は止まっている）
//     - マッチ   → 入力待ち ON
//     - 非マッチ → 現状維持。ウィンドウリサイズ等の再描画で確認文が別位置に折り返されると
//                  本物の確認待ちでも一時的に非マッチになるため（tests の
//                  「リサイズ再描画で確認文が折り返された非マッチ例」参照）、ここで
//                  解除すると本物を取りこぼす。
//   上限で強制的に呼ばれた評価（quiescent = false / 出力が流れ続けている）
//     - マッチ   → 入力待ち ON のまま
//     - 非マッチ → 解除。出力が流れている＝相手は入力を待たずに動いている、が根拠。
//                  張り付きからの唯一の自動復帰経路。
function nextWaitingState({ prev, matches, excluded = false, quiescent }) {
  if (excluded) return false;
  if (matches) return true;
  return quiescent ? prev === true : false;
}

// 入力待ち検知時のビープを鳴らしてよいか。
// 解除と再検知が短時間で往復すると鳴り続けてうるさいため、クールダウンを設ける。
// ユーザーが応答したとき（markPaneInput）は起点をリセットするので、
// 「応答したら次の確認でまた鳴る」という本来の通知は抑止しない。
const WAITING_BEEP_COOLDOWN_MS = 15000;

function shouldBeepForWaiting({ now, lastBeepAt, cooldownMs = WAITING_BEEP_COOLDOWN_MS }) {
  if (!lastBeepAt) return true;
  return now - lastBeepAt >= cooldownMs;
}

// ─── バックグラウンドサブエージェント数の検知（issue vektor-inc/vk-terminals#340）──
//
// 背景: 司令塔（vk-orchestrator）はペインの稼働判定を lastOutputTime（最後の画面出力
// 時刻）の新しさだけで行っている。Claude Code のメイン応答が終わり、サブエージェント
// だけがバックグラウンドで走っている間は画面の再描画が止まり出力が流れなくなるため、
// 司令塔が「作業終了」と誤認してしまう（2026-08-06 に実際発生）。この誤認を防ぐため、
// 画面末尾に出るフッター表示からバックグラウンドで動くサブエージェント数を読み取る。
//
// このフッター行は **ペイン幅に応じて末尾が "…" で截断される。** 実機
// （~/.vk-terminals/states.json に記録された実際の画面出力）で以下を確認済み。
//
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents · ↓ to mana…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agent…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agen…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 age…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 ag…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 a…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 …
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2…
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← …        （数字自体が截断）
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to inte…（agents セグメント自体が截断で消滅）
//
// フッターの目印（bypass permissions on 等）は行の**先頭側**にあるので必ず一致するが、
// agents セグメントは行の**末尾側**なので真っ先に切られる。「目印が読めた＝フッターの
// 全容が読めた」ではないため、目印が読めたことだけを根拠に「agents 表示が無い→0」と
// 断定すると、上記のように数字が読めているのに 0 を返す・数字自体が見えないのに 0 を
// 返す、という false 0（動いているのに止まっていると誤認させる、この issue が最も
// 避けたい失敗）を量産してしまう。そこで判定順序を次のようにする。
//
//   1. 正の証拠（フッターの目印の有無に関わらず先に見る）
//        - 「✻ Waiting for N background agent(s) to finish」ナレーション
//        - 「← N」+ agents の断片（"agents"〜"a" のどこまで截断されていても）
//      数字が読めている以上、それを信じる。誤って Claude Code 以外の画面から
//      拾ってしまっても、司令塔側は「動いている」と保守的に見えるだけで実害は小さい
//      （見逃し＝false 0 のほうが「未検証PRをマージする」実害が大きい）。
//   2. フッターの目印が無ければ null（不明）
//   3. 目印はあるが、その行の末尾が "…" で截断されている場合も null（不明）。
//      截断された先に agents セグメントがあったかどうか分からないため。
//   4. フッターが最後まで読めていて agents セグメントが無ければ、そこで初めて 0。

// 「✻ Waiting for N background agent(s) to finish」ナレーション（実機で単数・複数とも確認済み）。
// メイン応答がサブエージェントの完了待ちで停止しているときに出る、← N agents とは別の表示。
const WAITING_FOR_BACKGROUND_AGENTS_PATTERN = /Waiting for (\d+) background agents? to finish/i;

// 「← N agents · ↓ to manage」ヒント。末尾側の agents の綴りがどこまで截断されていても
// （"agents" 〜 "a" の1文字、または省略記号 "…"/"..." が直後に来る場合も）拾えるように、
// 長い候補から順に alternation を並べる（find -regex の注意と同じ理由）。
// "←" という左矢印はこの用途以外での使用が確認できていないため、"↓ 75.4k tokens" のような
// 別表示（下矢印・別記号）と混同する心配はない。一方、agents の断片も省略記号も無い
// 「← 5 minutes ago」のような無関係な文字列とは区別できるよう、断片 or 省略記号の
// いずれかを必須（オプションにしない）にしている。
const BACKGROUND_AGENTS_ARROW_PATTERN = /←\s*(\d+)\s*(?:agents?|agen|age|ag|a|…|\.\.\.)/i;

// Claude Code の画面であることの常時表示の目印（フッター行）。
// このいずれかが検知できて初めて「フッターが読み取れる状態」とみなす。
//   - "? for shortcuts"                        : 既定モードのフッター
//   - "bypass permissions on (shift+tab ...)"   : 権限確認バイパスモードのフッター
//   - "accept edits on (shift+tab ...)"         : 編集自動承認モードのフッター
// 後者 2 つは "(shift+tab to cycle)" を伴うため、まとめて拾えるようにしている。
// 実機の vk-terminals 稼働ペイン（~/.vk-terminals/states.json に記録された実際の
// 画面出力）で "bypass permissions on (shift+tab to cycle)" を確認済み。
const CLAUDE_CODE_FOOTER_PATTERN = /\?\s*for\s+shortcuts|shift\+tab\s+to\s+cycle|bypass permissions on|accept edits on/i;

// 行末の空白を取り除いたうえで、省略記号（全角三点リーダー … / 半角3連ドット ...）で
// 終わっているかを判定する。フッター行がペイン幅で截断されているかどうかの目印。
function isTruncatedLine(line) {
  return /(?:…|\.\.\.)\s*$/.test(line.replace(/[ \t]+$/, ''));
}

// バックグラウンドで動いている Claude Code サブエージェントの数を判定する。
//
// 引数 screenText には、累積バッファ（lastLines）ではなく **現在画面に表示されている
// 内容のスナップショット**（xterm の term.buffer.active から読んだ末尾数行）を渡すこと。
// 累積バッファをそのまま渡すと、サブエージェント終了後も過去に流れた
// 「← N agents」の描画がバッファに残り続け、いつまでも古い数を返してしまう
// （完了条件「サブエージェントが終わると 0 に戻る」を満たせなくなる）。
// 呼び出し側は matchesWaiting と同様、ANSI 除去済みのテキストを渡す想定。
//
// 返り値:
//   - 整数（0 以上）: 値が確定した（agents 表示が読めた、またはフッターが最後まで
//     読めていて agents 表示が無かった）
//   - null: 不明。バッファが空・Claude Code の画面ではない・フッターが截断されていて
//     agents 表示の有無を確認できない、のいずれか。呼び出し側は 0 と区別して扱うこと。
function detectBackgroundAgents(screenText) {
  if (typeof screenText !== 'string' || screenText === '') return null;

  // 1a. 「Waiting for N background agent(s) to finish」ナレーション（正の証拠）。
  const waitingMatch = WAITING_FOR_BACKGROUND_AGENTS_PATTERN.exec(screenText);
  if (waitingMatch) {
    const n = parseInt(waitingMatch[1], 10);
    if (Number.isInteger(n) && n >= 0) return n;
    return null; // 実質到達しないが、原則どおり不正値は 0 にしない
  }

  // 1b. 「← N agents」ヒント（截断されていても数字さえ読めれば正の証拠として拾う）。
  const arrowMatch = BACKGROUND_AGENTS_ARROW_PATTERN.exec(screenText);
  if (arrowMatch) {
    const n = parseInt(arrowMatch[1], 10);
    if (Number.isInteger(n) && n >= 0) return n;
    return null;
  }

  // 2. フッターの目印が無ければ Claude Code の画面と確証が持てないため不明。
  const lines = screenText.split('\n');
  const footerLines = lines.filter((line) => CLAUDE_CODE_FOOTER_PATTERN.test(line));
  if (footerLines.length === 0) return null;

  // 3. 目印はあるが、その行が截断されている（末尾が省略記号）場合、截断された先に
  //    agents セグメントがあったかどうか分からないため 0 と断定せず不明とする。
  if (footerLines.some(isTruncatedLine)) return null;

  // 4. フッターが最後まで読めていて agents セグメントが見当たらないので 0。
  return 0;
}

return {
  BACKGROUND_AGENTS_ARROW_PATTERN,
  CLAUDE_CODE_FOOTER_PATTERN,
  WAITING_BEEP_COOLDOWN_MS,
  WAITING_FOR_BACKGROUND_AGENTS_PATTERN,
  WAITING_MAX_EVAL_INTERVAL_MS,
  WAITING_PATTERNS,
  WAITING_QUIESCENCE_MS,
  detectBackgroundAgents,
  isOutputQuiescent,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
  selectWaitingBuffer,
  shouldBeepForWaiting,
  waitingCheckDelayMs,
};
});
