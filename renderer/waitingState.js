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
//
// 誤検知したときの実害をどう抑えるか（上の判断基準そのものは変えず、解除経路を見直した）:
//   旧実装（vk-orchestrator#212）は「出力が流れている最中の非マッチでのみ解除する」
//   （上限間隔 WAITING_MAX_EVAL_INTERVAL_MS = 5 秒で頭打ち）の一本槍で、静止評価
//   （quiescent = true）では非マッチでも常に現状維持していた。これは「出力が完全に
//   止まっているときは相手も止まっているのだから、バッジが点いたままでも実害は
//   小さい」という前提に立っていた。
//
//   ところが vektor-inc/vk-terminals#352 で、この前提が崩れる実例が見つかった。
//   数秒おきに 1 行だけ出力し続ける無人ペイン（vk-orchestrator 自身の常駐ログ等）は、
//   出力が完全に止まっているわけではないのに、判定のたびに「最後の出力から静止時間
//   （1.5 秒）以上経っている」＝ quiescent = true と評価される。解除の評価
//   （quiescent = false のときだけ）が一度も回ってこないため、誤って点いた
//   「入力待ち」が人が打鍵するまで無期限に張り付いた。「実害は小さい」という前提が
//   成立しない典型例だった。
//
//   そこで、静止評価にも解除経路を追加した（nextWaitingState の onsetStillVisible /
//   findWaitingMatch / containsIgnoringWhitespace）。点灯の根拠になった実際の
//   マッチ文字列（前後に文脈を含めたもの。理由は findWaitingMatch 参照）を記録し、
//   静止評価で非マッチのときに「その文字列が判定バッファ（lastLines）から消えているか」
//   を空白・改行を無視した包含比較で確かめる。消えていれば解除し、残っていれば
//   現状維持する。
//     - 「消えている」＝疎な出力で 80 行バッファから実際に押し出された（#352 のケース）
//     - 「残っている」＝画面サイズを変えて折り返し位置だけが変わった。文字自体は
//       バッファに残るので誤解除しない（vektor-inc/vk-terminals#91 の再発防止）
//   つまり今回の判断は「見逃しより誤検知の実害を軽くする」という優先順位そのものは
//   変えず、「一度点いた誤検知が自力で消えるまでの時間」を、出力の疎密に関わらず
//   有限にすることを優先した。
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

// 点灯根拠として記録する文字列に含める、一致箇所前後の文脈の文字数（issue #352）。
//
// WAITING_PATTERNS の一致範囲（m[0]）だけを記録すると、パターンによっては
// 極端に短い文字列しか取れない（例: 全角「？」で終わる文への補助パターン
// /[？]\s*$/ は m[0] が「？」1 文字になる）。1 文字だと、後続の無関係な出力に
// 同じ文字が 1 つでも含まれるだけで containsIgnoringWhitespace が「まだ画面にある」
// と判定してしまい、疎な出力ペインでの自動解除（#352 の本題）が実質的に効かなく
// なる。そこで一致箇所の前後に固定文字数の文脈を含めて記録する。
//
// 文脈を広げても vektor-inc/vk-terminals#91（リサイズ再描画）への耐性は失われない。
// リサイズは文字自体を書き換えず折り返し位置だけを変えるため、文脈を含めた文字列も
// 空白・改行を無視した比較なら変わらず一致し続ける。
const WAITING_ONSET_CONTEXT_CHARS = 24;

// WAITING_PATTERNS のいずれかに一致した箇所を、前後の文脈込みの文字列として返す
// （一致しなければ null）。この関数はどのパターンが一致したかを区別しない
// （呼び出し側が知る必要が無いため）。
//
// 返り値は「正規表現の一致範囲そのもの」ではなく、前後 WAITING_ONSET_CONTEXT_CHARS
// 文字を加えた範囲であることに注意（理由は WAITING_ONSET_CONTEXT_CHARS のコメント
// 参照）。真偽値だけが要る呼び出し（matchesWaiting）はこの差を意識しなくてよい。
function findWaitingMatch(cleanBuffer) {
  if (typeof cleanBuffer !== 'string' || cleanBuffer === '') return null;
  for (const pattern of WAITING_PATTERNS) {
    const m = pattern.exec(cleanBuffer);
    if (m && m[0] !== '') {
      const start = Math.max(0, m.index - WAITING_ONSET_CONTEXT_CHARS);
      const end = Math.min(cleanBuffer.length, m.index + m[0].length + WAITING_ONSET_CONTEXT_CHARS);
      return cleanBuffer.slice(start, end);
    }
  }
  return null;
}

function matchesWaiting(cleanBuffer) {
  return findWaitingMatch(cleanBuffer) !== null;
}

// 空白・改行（全角スペース含む。JS の \s は Unicode の空白分離子を含むため対応済み）
// を取り除いた文字列を返す純粋関数。containsIgnoringWhitespace の下請け。
function stripWhitespaceForCompare(str) {
  return typeof str === 'string' ? str.replace(/\s+/g, '') : '';
}

// haystack に needle が「空白・改行を無視して」含まれているかを判定する（issue #352）。
// リサイズ再描画で確認文の折り返し位置だけが変わったケース（vektor-inc/vk-terminals#91）
// では、文字自体はまだ画面に残っているため、この比較なら「まだ見える」と判定できる。
// needle が空・非文字列なら false を返す（空文字列は素朴な includes だと常に true に
// なってしまい、「根拠が無いのに常に見える」という誤った結果を招くため明示的に弾く）。
function containsIgnoringWhitespace(haystack, needle) {
  if (typeof needle !== 'string' || needle === '') return false;
  const strippedNeedle = stripWhitespaceForCompare(needle);
  if (strippedNeedle === '') return false;
  return stripWhitespaceForCompare(haystack).includes(strippedNeedle);
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

// waiting 判定（issue vektor-inc/vk-orchestrator#212 / vektor-inc/vk-terminals#352）。
//
//   静止して呼ばれた評価（quiescent = true / 相手は止まっている）
//     - マッチ   → 入力待ち ON
//     - 非マッチ → 原則現状維持。ウィンドウリサイズ等の再描画で確認文が別位置に
//                  折り返されると本物の確認待ちでも一時的に非マッチになるため（tests の
//                  「リサイズ再描画で確認文が折り返された非マッチ例」参照）、ここで
//                  無条件に解除すると本物を取りこぼす。
//                  ただし onsetStillVisible（点灯根拠の文字列が判定バッファから
//                  空白無視の包含比較で見えるか。findWaitingMatch /
//                  containsIgnoringWhitespace 参照）が明示的に false のときは解除する
//                  （issue #352: 数秒おきに 1 行だけ出力し続けるペインは quiescent = true
//                  の評価しか回ってこないため、この経路が無いと永久に張り付く）。
//                  onsetStillVisible を渡さない呼び出し（undefined）は従来どおり
//                  現状維持のみ。呼び出し側が点灯根拠を追跡していない場面
//                  （excluded 判定のテスト等）の後方互換のため。
//   上限で強制的に呼ばれた評価（quiescent = false / 出力が流れ続けている）
//     - マッチ   → 入力待ち ON のまま
//     - 非マッチ → 解除。出力が流れている＝相手は入力を待たずに動いている、が根拠。
function nextWaitingState({ prev, matches, excluded = false, quiescent, onsetStillVisible }) {
  if (excluded) return false;
  if (matches) return true;
  if (!quiescent) return false;
  if (prev !== true) return false;
  if (onsetStillVisible === false) return false;
  return true;
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
//   1. 正の証拠（フッターの目印の有無に関わらず、走査窓の**全行**から先に集める）
//        - 「✻ Waiting for N background agent(s) to finish」ナレーション
//        - 「← N」+ agents の断片（"agents"〜"a" のどこまで截断されていても）
//      数字が読めている以上、それを信じる。誤って Claude Code 以外の画面から
//      拾ってしまっても、司令塔側は「動いている」と保守的に見えるだけで実害は小さい
//      （見逃し＝false 0 のほうが「未検証PRをマージする」実害が大きい）。
//      ⚠ 安藤（セキュリティレビュー）の指摘（HIGH-1）: 走査窓は複数行あるため、
//      先頭に一致した1件だけを採ると、画面上部にたまたま流れた「← 0 agents」や
//      「Waiting for 0 background agents to finish」（このコードのコメント・
//      この PR の diff 自体を Claude Code ペインに表示しただけで出現し得る）が、
//      画面下端にある本物の「← 2 agents」を **打ち消して 0 を返してしまう。**
//      これを避けるため、走査窓の全行から候補を集めて **最大値** を採る
//      （collectAgentCounts）。0 という「無い」証拠が非0の「ある」証拠を
//      上書きしないようにする。
//   1b. 「← 0 agents」のように、実機の Claude Code が描画しないはずの値（0・
//      桁数上限超え・先頭ゼロ埋め等）にしか一致しなかった場合は、それを 0 の
//      根拠にせず null（不明）にする。⚠ 安藤の指摘（MEDIUM-2）: 「証拠が無い」
//      （目印すら無い）と「証拠はあったが信用できなかった」はどちらも「確定できない」
//      という点で同じであり、後者だけを 0 として扱う理由が無い。
//   2. フッターの目印が無ければ null（不明）
//   3. 目印の行、**および画面上でそれより下にある行**が "…" で截断されている場合は
//      null（不明）。截断された先に agents セグメントがあったかどうか分からないため。
//      ⚠ 安藤の指摘（HIGH-2）: 目印行だけを截断チェックしていると、agents ヒントが
//      目印と別の行に出るレイアウト（本ファイルのテスト自体がそうだった）で、
//      ヒント行だけが截断されていても目印行が無傷なら 0 を返してしまう。目印より
//      下の行を丸ごと対象にすることで、単一行・複数行どちらのレイアウトでも塞ぐ。
//   4. フッターが最後まで読めていて agents セグメントが無ければ、そこで初めて 0。

// 拾ってよい上限値（無効な巨大数値が JSON にそのまま載るのを防ぐ、安藤の指摘 LOW）。
// Claude Code の実際のサブエージェント数がこの値を超えることは想定していない。
const MAX_BACKGROUND_AGENTS = 999;

// 「✻ Waiting for N background agent(s) to finish」ナレーション（実機で単数・複数とも確認済み）。
// メイン応答がサブエージェントの完了待ちで停止しているときに出る、← N agents とは別の表示。
// (?!\d) で数字の直後にさらに数字が続かないことを要求し、\d{1,4} を桁数無制限にしない
// （安藤の指摘 LOW: 20 桁の数値でも Number.isInteger は通過するため、上限チェックだけでは
// 不十分。桁数自体をここで絞ることで巨大な数値そのものを取り込まないようにする）。
// g フラグは collectAgentCounts で matchAll に渡すために必要（後述のコメント参照）。
const WAITING_FOR_BACKGROUND_AGENTS_PATTERN = /Waiting for (\d{1,4})(?!\d) background agents? to finish/gi;

// 「← N agents · ↓ to manage」ヒント。末尾側の agents の綴りがどこまで截断されていても
// （"agents" 〜 "a" の1文字、または省略記号 "…"/"..." が直後に来る場合も）拾えるように、
// 長い候補から順に alternation を並べる（find -regex の注意と同じ理由）。
// "←" という左矢印はこの用途以外での使用が確認できていないため、"↓ 75.4k tokens" のような
// 別表示（下矢印・別記号）と混同する心配はない。
//
// 一方、安藤の指摘（MEDIUM-3）で「← 3 apples remaining」「← 5 and counting」のような
// 無関係な文字列まで拾ってしまうことが分かった。截断は必ず行末で起きるため、断片は
// 「行末（$）」または「省略記号の直前」のどちらかに限定し、単語の途中に出てくる
// "a" 等を誤って拾わないようにする。
//   - `agents?\b` … 截断されていない完全な語（単数・複数、語境界必須）
//   - `(?:agents?|agen|age|ag|a)?[ \t]*(?:…|\.\.\.)` … 断片（空でもよい）＋省略記号
//   - `(?:agent|agen|age|ag|a)$` … 省略記号を伴わずに行末そのものが断片で切れている場合
const BACKGROUND_AGENTS_ARROW_PATTERN =
  /←[ \t]*(\d{1,4})(?!\d)[ \t]*(?:agents?\b|(?:agents?|agen|age|ag|a)?[ \t]*(?:…|\.\.\.)|(?:agent|agen|age|ag|a)$)/gi;

// BACKGROUND_AGENTS_ARROW_PATTERN と同じ形だが、\d{1,4}(?!\d) の桁数上限を外した
// 「緩い」版。値の抽出には使わず（キャプチャは無視する）、collectAgentCounts が
// 「厳格パターンでは一致しなかった行に、agents ヒントらしきものが実在したか」を
// 判定するためだけに使う。安藤の指摘（MEDIUM-2）: 桁数上限超え（例: 5 桁以上）や
// 先頭ゼロ埋め（例: 0000000002）だと厳格パターンはそもそも 1 件もマッチしない
// （\d{1,4} は同じ開始位置から縮めるだけで、次の文字が常にまだ数字のままなので
// 全長どこを取っても (?!\d) を満たせない）。マッチが 0 件だと「agents 表示が無い」
// のと区別が付かず、素通りしてそのまま 0 になってしまう。この緩い版で「digit + agent
// の断片/省略記号」という形自体は実在したことを検知し、0 と断定しない根拠にする。
// g フラグを持たないため matchAll 専用の lastIndex 汚染の心配は無く、.test() で
// 十分（安藤の指摘 MEDIUM-1 と同じ理由で、この用途には g を付けない）。
const BACKGROUND_AGENTS_ARROW_AMBIGUOUS_PATTERN =
  /←[ \t]*\d+[ \t]*(?:agents?\b|(?:agents?|agen|age|ag|a)?[ \t]*(?:…|\.\.\.)|(?:agent|agen|age|ag|a)$)/i;

// Claude Code の画面であることの常時表示の目印（フッター行）。
// このいずれかが検知できて初めて「フッターが読み取れる状態」とみなす。
//   - "? for shortcuts"                        : 既定モードのフッター
//   - "bypass permissions on (shift+tab ...)"   : 権限確認バイパスモードのフッター
//   - "accept edits on (shift+tab ...)"         : 編集自動承認モードのフッター
// 後者 2 つは "(shift+tab to cycle)" を伴うため、まとめて拾えるようにしている。
// 実機の vk-terminals 稼働ペイン（~/.vk-terminals/states.json に記録された実際の
// 画面出力）で "bypass permissions on (shift+tab to cycle)" を確認済み。
const CLAUDE_CODE_FOOTER_PATTERN = /\?\s*for\s+shortcuts|shift\+tab\s+to\s+cycle|bypass permissions on|accept edits on/i;

// 省略記号（全角三点リーダー … / 半角3連ドット ...）で終わっているかを判定する。
// フッター行がペイン幅で截断されているかどうかの目印。
//
// 安藤の指摘（LOW: ReDoS）: 旧実装は `line.replace(/[ \t]+$/, '')` で末尾空白を
// 削ってから判定していたが、`+` の末尾アンカー付き量指定子は入力次第で二次の
// バックトラッキングを起こし、実測で 5 万文字の入力に 1.5 秒かかった。
// `translateToString(true)` は末尾空白を落とすため通常は到達しないが、
// この関数自体は export された汎用の純粋関数であり、将来 lastLines（最大 8000 字）
// のような長い文字列を渡されても安全なように、末尾の空白・CR ごと省略記号にまとめて
// 一度でマッチさせる形に変更した（実測 1.5s → 0.035ms）。
function isTruncatedLine(line) {
  return /(?:…|\.\.\.)[ \t\r]*$/.test(line);
}

// parseInt した数値が「バックグラウンドエージェント数」として妥当かを検証する。
// 安藤の指摘（LOW）: Number.isInteger だけでは巨大な数値（例: 20 桁）も通過してしまい、
// そのまま JSON に載る。Number.isSafeInteger と値域チェックの両方で防ぐ。
function parseSafeAgentCount(rawDigits) {
  const n = parseInt(rawDigits, 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BACKGROUND_AGENTS) return null;
  return n;
}

// 走査窓（screenText を分割した各行）の**全行**から正の証拠（Waiting for N.../← N...）
// を集め、最大値を採る。安藤の指摘（HIGH-1）への対応の中核: 1 件でも先頭一致させると
// 画面上部のノイズ（「← 0 agents」等）が下端の本物を打ち消してしまうため、必ず全件
// 集めてから最大値を選ぶ。
//
// 正規表現に g フラグを付けているのは String.prototype.matchAll に渡すために必要
// なため。matchAll は渡された正規表現の複製（内部で新しく作られる別オブジェクト）
// の lastIndex は書き換えないが、**その複製を作る際に元の正規表現オブジェクトの
// lastIndex を読み取って引き継ぐ**（安藤の指摘 MEDIUM-1）。つまり守られるのは
// 「書き込みされない」ことだけで、「外部から汚染されない」ことは守られない。
// この 2 定数は module 内に閉じている（export していない）とはいえ、念のため
// 呼び出しのたびに明示的に 0 へリセットし、外部汚染や呼び出し順に依存しない形にする。
function collectAgentCounts(lines) {
  let best = null;
  // 「証拠らしきものは見えたが、値として信用できなかった」ことを覚えておく。
  // 実機の Claude Code は「← 0 agents」を描画しない（サブエージェントが無ければ
  // セグメント自体を出さない）ため、0 にマッチした・桁数上限を超えた・先頭ゼロ埋め
  // だったなどの理由で「0」として扱われた場合、それは確定した 0 の根拠にはならず
  // ノイズでしかない。0 と断定せず不明（null）側へ倒す判断材料として記録する
  // （安藤の指摘 MEDIUM-2）。
  let sawUnreadableEvidence = false;
  for (const line of lines) {
    // 「← N agents」の厳格パターンがこの行で 1 件でも一致したか。一致していれば、
    // 桁数上限超え・先頭ゼロ埋めの心配は無い（その場合はそもそも一致しないため）ので、
    // 後段の緩いパターンでの二重検知はしない。
    let arrowMatchedOnLine = false;
    for (const pattern of [WAITING_FOR_BACKGROUND_AGENTS_PATTERN, BACKGROUND_AGENTS_ARROW_PATTERN]) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        if (pattern === BACKGROUND_AGENTS_ARROW_PATTERN) arrowMatchedOnLine = true;
        const n = parseSafeAgentCount(m[1]);
        if (n === null || n === 0) {
          sawUnreadableEvidence = true;
          continue;
        }
        if (best === null || n > best) best = n;
      }
    }
    // 厳格パターンが 1 件も一致しなかった行でも、桁数上限を外した緩いパターンで
    // 「agents ヒントらしきもの」を検知できた場合（安藤の指摘 MEDIUM-2: 範囲外の
    // 桁数「← 99999 agents」・先頭ゼロ埋め「← 0000000002 agents」等）は、
    // 「何も無かった」と区別できないまま 0 の根拠にしないよう記録する。
    if (!arrowMatchedOnLine && BACKGROUND_AGENTS_ARROW_AMBIGUOUS_PATTERN.test(line)) {
      sawUnreadableEvidence = true;
    }
  }
  return { best, sawUnreadableEvidence };
}

// バックグラウンドで動いている Claude Code サブエージェントの数を判定する。
//
// 引数 screenText には、累積バッファ（lastLines）ではなく **現在画面に表示されている
// 内容のスナップショット**（xterm の term.buffer.active から読んだ末尾数行）を渡すこと。
// 累積バッファをそのまま渡すと、サブエージェント終了後も過去に流れた
// 「← N agents」の描画がバッファに残り続け、いつまでも古い数を返してしまう
// （完了条件「サブエージェントが終わると 0 に戻る」を満たせなくなる）。
// xterm のバッファは元々 ANSI エスケープを含まないため通常は無加工で渡せるが、
// ANSI が混ざる入力（テスト等）を渡す場合は matchesWaiting と同様に
// stripAnsiForDisplay を通してから渡すこと（エスケープシーケンスが判定対象の
// 文字列の途中に挟まると一致しなくなるため）。
//
// 返り値:
//   - 整数（0 以上）: 値が確定した（agents 表示が読めた、またはフッターが最後まで
//     読めていて agents 表示が無かった）
//   - null: 不明。バッファが空・Claude Code の画面ではない・agents ヒントらしきものは
//     見えたが値を確定できない（0・桁数上限超え・先頭ゼロ埋め）・フッターが截断されて
//     いて agents 表示の有無を確認できない、のいずれか。呼び出し側は 0 と区別して扱う
//     こと。
function detectBackgroundAgents(screenText) {
  if (typeof screenText !== 'string' || screenText === '') return null;
  const lines = screenText.split('\n');

  // 1. 正の証拠を走査窓の全行から集め、最大値を採る（best は必ず 1 以上。0 に
  //    打ち消されない）。
  const { best, sawUnreadableEvidence } = collectAgentCounts(lines);
  if (best !== null) return best;

  // 1b. 「← 0 agents」のような、実機では出現しないはずの信用できない証拠
  //     （0・桁数上限超え・先頭ゼロ埋め等）を見た場合は、0 と断定せず不明側へ倒す
  //     （安藤の指摘 MEDIUM-2: 規則2「目印が無ければ null」より、確定できない
  //     証拠を 0 と断定してしまうほうが誤りが大きい）。
  if (sawUnreadableEvidence) return null;

  // 2. フッターの目印が無ければ Claude Code の画面と確証が持てないため不明。
  const footerIndex = lines.findIndex((line) => CLAUDE_CODE_FOOTER_PATTERN.test(line));
  if (footerIndex === -1) return null;

  // 3. 目印行、**およびそれより画面下側の全行**が截断されていれば 0 と断定しない
  //    （HIGH-2: agents ヒントが目印と別行に出るレイアウトも塞ぐ）。
  //
  //    既知の残存リスク（対応不要・記録のみ、安藤・司と合意済み）: 「✻ Waiting for
  //    N background agents to finish」ナレーションは入力ボックスより**上**（＝
  //    footerIndex より前）に出るため、この截断チェックの対象外になる。ナレーション
  //    行だけが截断され、目印行以降が無傷だと 0 を返す経路が残る。ただし Claude Code
  //    はツール結果の行を日常的に "…" で切り詰めるため、チェック範囲を画面全体へ
  //    広げると大半の画面が null に落ち、この機能自体が実用にならない。見逃しの
  //    実害（稀）と可用性の低下（大半が null 化）を比較し、あえて塞がない判断とした。
  for (let i = footerIndex; i < lines.length; i++) {
    if (isTruncatedLine(lines[i])) return null;
  }

  // 4. フッターが最後まで読めていて agents セグメントが見当たらないので 0。
  return 0;
}

// xterm の画面バッファ（term.buffer.active 相当のダック型オブジェクト）から、
// detectBackgroundAgents に渡す「現在画面の末尾 N 行」を切り出す純粋関数（issue #340）。
//
// renderer/app.js から xterm 依存のロジックをここへ移し、Node（require）から
// テスト可能にしている。引数 buffer は次の形を想定する（xterm の IBuffer が実際に
// この形を持つ。テストでは同じ形のスタブを渡せばよい）:
//   - length:  number             総行数（スクロールバック込み）
//   - baseY:   number             現在の画面（最下端までスクロールしたときの
//                                 viewport 先頭行）の絶対行番号
//   - getLine: (i: number) => { translateToString(trimRight: boolean): string,
//                                isWrapped?: boolean } | undefined
//
// 安藤の指摘（MEDIUM-1）: 末尾 maxLines 行を無条件に読むと、ペインが maxLines より
// 少ない行数（グリッド分割で縦に小さいペインは常態）のとき、その差分だけ baseY より
// 前（＝スクロールバック側の古い描画）まで読んでしまう。「buffer.active だから古い
// 描画は残らない」という前提が崩れ、サブエージェント終了後も古い「← 2 agents」を
// 拾い続ける退行につながるため、読み出し開始位置を baseY でクランプする。
//
// 安藤の指摘（LOW: 折り返し行）: xterm の IBufferLine.translateToString は行の
// 折り返し（isWrapped）を考慮しない。フッターが截断ではなく折り返しで複数行に
// 分かれた場合、素朴に改行で連結すると「← 2」と「agents」が行境界で分断され、
// 截断の目印（省略記号）も無いまま 0 と誤判定される恐れがある。isWrapped が真の
// 行は改行を挟まず直前の行へ連結する。
//
// 安藤の指摘（LOW-2）: 境界値が緩く、契約（「buffer が不正な形なら null」）と
// 食い違うケースがあった。
//   - baseY が buffer.length を超える（あるいは負の）値だと、素朴には空配列や
//     負インデックス読み出しにつながる → baseY は 0 未満に倒さずクランプする
//   - maxLines が数値でない・0 以下だと NaN 経由で意図せず空配列になる
//     → 事前に検証し、不正なら null にする
//   - 結果として読める行が 1 行も無かった場合も、呼び出し側からは「バッファが
//     不正だった」場合と区別が付かない空配列ではなく null を返す
//
// 返り値: 行文字列の配列（1 行以上）。buffer / maxLines が不正な形、または
// 読める行が 1 行も無かった場合は null。
function extractScreenLines(buffer, maxLines) {
  if (!buffer || typeof buffer.length !== 'number' || typeof buffer.getLine !== 'function') return null;
  if (typeof maxLines !== 'number' || !Number.isFinite(maxLines) || maxLines <= 0) return null;
  const total = buffer.length;
  if (!Number.isFinite(total) || total <= 0) return null;
  const rawBaseY = Number.isFinite(buffer.baseY) ? buffer.baseY : 0;
  const baseY = Math.max(0, rawBaseY);
  const start = Math.max(baseY, total - maxLines);
  const lines = [];
  for (let i = start; i < total; i++) {
    const bufLine = buffer.getLine(i);
    if (!bufLine) continue;
    const text = typeof bufLine.translateToString === 'function' ? bufLine.translateToString(true) : '';
    if (bufLine.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.length > 0 ? lines : null;
}

return {
  // BACKGROUND_AGENTS_ARROW_PATTERN / WAITING_FOR_BACKGROUND_AGENTS_PATTERN は
  // あえて export しない（安藤の指摘 MEDIUM-1）。g フラグ付き正規表現は lastIndex
  // という可変状態を持つオブジェクトのため、外部から .test()/.exec() を一度でも
  // 呼ばれると、次の matchAll 呼び出し（collectAgentCounts 側で毎回 lastIndex を
  // 0 にリセットしているので実害は無いが）に依存しない設計であっても、export した
  // 時点で「外部から触ってよいもの」という誤解を招く。この 2 定数は
  // collectAgentCounts の内部実装詳細として module 内に閉じ、他モジュール・
  // テストからは detectBackgroundAgents 経由でのみ振る舞いを検証する。
  CLAUDE_CODE_FOOTER_PATTERN,
  MAX_BACKGROUND_AGENTS,
  WAITING_BEEP_COOLDOWN_MS,
  WAITING_MAX_EVAL_INTERVAL_MS,
  WAITING_PATTERNS,
  WAITING_QUIESCENCE_MS,
  containsIgnoringWhitespace,
  detectBackgroundAgents,
  extractScreenLines,
  findWaitingMatch,
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
