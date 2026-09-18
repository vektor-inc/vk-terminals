'use strict';

// Web Push 通知（issue #396）の送信契機（状態が変わった瞬間の検知）と通知文面の組み立てを行う
// 純粋関数群。main.js から Electron 依存を切り離してテストしやすくするため、
// utils/apiAuth.js と同じ方針でここへ切り出している。
//
// main.js は ipcMain.on('terminal:report-states', ...)（renderer から 2 秒間隔で届く状態
// スナップショット）のたびに computeNotificationEvents() を呼び、返ってきた events を
// 送信のトリガーとして使う。ファイル I/O・実際の送信（web-push）はここでは行わない。

const { isWaitingCwdExcluded } = require('../renderer/waitingState');

/**
 * renderer から届く states（terminal:report-states の payload）1 件分から、
 * 「入力待ち」「マージ待ち」の現在値を、waitingExcludeCwdPatterns による除外を
 * 反映したうえで導出する。
 *
 * 【入力待ちの由来を分けて返す理由（司の指摘・A-10）】入力待ちは2つの由来を持つ:
 *   - waitingExternal: POST /api/set-status 由来の外部権威フラグ（t.externalWaiting）。
 *     vk-orchestrator 側が状態を保持しており、再起動後に同じ値を再送してくる。
 *   - waitingInternal: ターミナル出力からの内部判定（t.waiting）。再起動後は生きた
 *     出力から都度導出し直される。
 * computeNotificationEvents() 側で、外部由来にだけ「プロセス起動後に最初に観測した
 * true は基準として記録するだけで通知しない」という抑制（A-10）を掛け、内部判定には
 * 掛けない（既存の W-2 の挙動をそのまま残す）ため、ここで両者を分けて返す。
 * t.waiting フィールドが無い呼び出し（後方互換）は、t.externalWaiting が立っていない
 * 限り t.status === 'waiting' を内部判定由来として扱う。
 *
 * status（'idle' | 'running' | 'waiting'）は renderer 側の deriveStatus が
 * localWaiting（cwd 除外を反映済み）と externalWaiting（POST /api/set-status 由来、
 * cwd 除外は未反映）の OR で決めているため、ここで cwd 除外を再度掛けないと、
 * 除外対象ペインが externalWaiting 経由で waiting 表示になった場合に通知してしまう
 * （issue #396 の必須条件）。apiWaitingMerge（POST /api/set-title 由来）も同様に
 * cwd 除外が未反映のため、ここで掛ける。
 * @param {object} paneState cachedStates[paneId] 相当の1エントリ
 * @param {string[]} excludePatterns waitingExcludeCwdPatterns（正規化前でも可）
 * @returns {{ waiting: boolean, waitingInternal: boolean, waitingExternal: boolean,
 *             waitingMerge: boolean }}
 */
function derivePaneNotificationState(paneState, excludePatterns) {
  const t = paneState || {};
  const excluded = isWaitingCwdExcluded(typeof t.cwd === 'string' ? t.cwd : '', excludePatterns);
  if (excluded) {
    return {
      waiting: false, waitingInternal: false, waitingExternal: false, waitingMerge: false,
    };
  }
  const waitingExternal = !!t.externalWaiting;
  const waitingInternal = typeof t.waiting === 'boolean'
    ? t.waiting
    : (t.status === 'waiting' && !waitingExternal);
  return {
    waiting: waitingInternal || waitingExternal,
    waitingInternal,
    waitingExternal,
    waitingMerge: !!t.apiWaitingMerge,
  };
}

/**
 * termId（cachedStates のキーである paneId ではなく、ペインの安定した識別子）を取り出す。
 * termId が無い場合は paneId をそのまま使う（後方互換のフォールバック）。
 * @param {string} paneId
 * @param {object} paneState
 * @returns {string}
 */
function resolveTermId(paneId, paneState) {
  const t = paneState || {};
  return t.termId != null ? String(t.termId) : String(paneId);
}

/**
 * 通知に使うペイン名を決める。displayTitle（apiTitle || taskTitle の main 側計算済み値）を
 * 優先し、無ければ既定の表示名 "Terminal <termId>" にフォールバックする
 * （issue #396: モバイルページのカード表示・PC 側と同じ既定名の付け方に合わせる）。
 * @param {object} paneState
 * @param {string} termId
 * @returns {string}
 */
function resolvePaneLabel(paneState, termId) {
  const t = paneState || {};
  const label = (typeof t.displayTitle === 'string' && t.displayTitle.trim())
    || (typeof t.apiTitle === 'string' && t.apiTitle.trim())
    || (typeof t.taskTitle === 'string' && t.taskTitle.trim())
    || '';
  return label || `Terminal ${termId}`;
}

/**
 * 前回のスナップショット（termId → { waiting, waitingMerge }）と今回の states を比較し、
 * 「入力待ちでない→入力待ち」「マージ待ちでない→マージ待ち」の遷移が起きたペインだけを
 * イベントとして返す（issue #396 必須条件・値を受け取るたびに送ると通知が連発するため）。
 * 併せて、次回の比較に使うスナップショットも返す（呼び出し側が状態を持ち回す）。
 *
 * states に存在しなくなった termId（ペインを閉じた等）は次回スナップショットに残らない
 * （自然に GC される）。
 *
 * 【isFirstReport（司の指摘・W-2）】呼び出し側（main.js）はプロセス起動のたびに
 * prevSnapshot（notificationSnapshot）を空から始める。そのため起動後最初の報告を
 * そのまま比較すると、既に入力待ち・マージ待ちだったペインについて「変化した」と
 * 誤検知してしまう（とくにマージ待ちは vk-orchestrator が同じ値を送り続けるため、
 * 再起動のたびに同じペインへ通知が飛ぶ形になる）。これは issue #396 の完了条件
 * 「状態が変わった瞬間だけ送る」に反するため、isFirstReport が true の間は
 * nextSnapshot を「基準」として計算はするが、events は送信対象として返さない
 * （空配列にする）。呼び出し側はプロセス全体で最初の1回だけ true を渡す。
 * この結果、アプリ起動の瞬間に入力待ちへ変わったペインの通知を1回だけ取りこぼす
 * 可能性があるが、起動直後は利用者がその画面を見ている可能性が高いため許容する
 * （司の判断）。
 *
 * 【isFirstReport だけでは足りなかった理由（司の指摘・A-10）】外部由来の2つの値
 * （t.externalWaiting・t.apiWaitingMerge）はどちらも「ペイン生成時に false で初期化され、
 * POST /api/set-status・POST /api/set-title が来たときだけ true になる」フィールドで、
 * 永続化されない。つまり isFirstReport（起動後“最初の報告”）が false の報告
 * （起動から数秒後、vk-orchestrator が値を再送してきたタイミング）で初めて true が
 * 届くことがあり、その回は isFirstReport による一律抑制の外に出てしまう。にもかかわらず
 * これは実際の状態変化ではなく、再起動前から既に true だった値が遅れて届いただけである。
 * そのため外部由来の waitingExternal・waitingMerge に限り、「isFirstReport の1回」では
 * なく「そのペイン・その種別について、プロセス起動後に初めて観測した true」を基準
 * として記録するだけにし、通知しない（baselineSeen フラグを nextSnapshot に持ち回す）。
 * 一度 true を観測した後は通常どおりの遷移検出に戻る（true→false→true と変化すれば
 * 2回目の true は通知する）。
 *
 * 内部判定（waitingInternal）にはこの抑制を広げない。再起動後も生きた出力から
 * 都度導出し直されるため同じ問題を持たず、広げると各ペインについて「アプリ起動後に
 * 最初に本当に入力待ちになったとき」の通知を1回失い、この機能の主目的（入力待ちに
 * 気づく）を損なうため。マージ待ち（waitingMerge）は完全に外部由来のフィールドのため、
 * この抑制を全面的に適用する。
 *
 * 【残る性質（司が承知のうえで進める。司の指摘・A-10）】各ペインについて、アプリ起動後に
 * 最初に来る外部由来の入力待ち・マージ待ちの通知は1回取りこぼす。
 * @param {{ prevSnapshot: Record<string, {waiting:boolean, waitingMerge:boolean,
 *             waitingExternalBaselineSeen?:boolean, waitingMergeBaselineSeen?:boolean}>,
 *           states: Record<string, object>, excludePatterns: string[],
 *           isFirstReport?: boolean }} params
 * @returns {{ events: Array<{termId:string, kind:'waiting'|'merge', paneLabel:string}>,
 *             nextSnapshot: Record<string, {waiting:boolean, waitingMerge:boolean,
 *             waitingExternalBaselineSeen:boolean, waitingMergeBaselineSeen:boolean}> }}
 */
function computeNotificationEvents({ prevSnapshot, states, excludePatterns, isFirstReport }) {
  const prev = prevSnapshot && typeof prevSnapshot === 'object' ? prevSnapshot : {};
  const nextSnapshot = {};
  const events = [];

  Object.keys(states || {}).forEach((paneId) => {
    const paneState = states[paneId];
    if (!paneState) return;
    const termId = resolveTermId(paneId, paneState);
    const current = derivePaneNotificationState(paneState, excludePatterns);
    const previous = prev[termId] || {
      waiting: false,
      waitingMerge: false,
      waitingExternalBaselineSeen: false,
      waitingMergeBaselineSeen: false,
    };

    // 「入力待ち」: 外部由来（waitingExternal）だけ、プロセス起動後に初めて観測した
    // true を基準記録に留める（A-10）。内部判定（waitingInternal）は通常どおり
    // 前回 false → 今回 true の遷移で判定する（W-2 の挙動のまま）。
    const isFirstExternalWaitingTrue = current.waitingExternal && !previous.waitingExternalBaselineSeen;
    const waitingFires = isFirstExternalWaitingTrue
      ? (!previous.waiting && current.waitingInternal)
      : (!previous.waiting && current.waiting);
    if (waitingFires) {
      events.push({ termId, kind: 'waiting', paneLabel: resolvePaneLabel(paneState, termId) });
    }

    // 「マージ待ち」: 完全に外部由来のため、同じ抑制を全面的に適用する（A-10）。
    const isFirstWaitingMergeTrue = current.waitingMerge && !previous.waitingMergeBaselineSeen;
    const waitingMergeFires = !isFirstWaitingMergeTrue && !previous.waitingMerge && current.waitingMerge;
    if (waitingMergeFires) {
      events.push({ termId, kind: 'merge', paneLabel: resolvePaneLabel(paneState, termId) });
    }

    nextSnapshot[termId] = {
      waiting: current.waiting,
      waitingMerge: current.waitingMerge,
      // 一度 true を観測したら以後もずっと true のまま（sticky）。false に戻っても
      // 「未観測」には戻さない（true→false→true の2回目の true は通常の遷移として
      // 通知したいため）。
      waitingExternalBaselineSeen: previous.waitingExternalBaselineSeen || current.waitingExternal,
      waitingMergeBaselineSeen: previous.waitingMergeBaselineSeen || current.waitingMerge,
    };
  });

  return { events: isFirstReport ? [] : events, nextSnapshot };
}

// 通知本文（issue #396: ペイン名と種別以外の情報は載せない）。
const NOTIFICATION_BODY_TEXT = {
  waiting: '入力待ちになりました。',
  merge: 'マージ待ちになりました。',
};

// 通知タイトルの長さ上限（安藤のセキュリティレビュー指摘・LOW-6）。ペイン名（POST /api/set-title
// の title、または OSC タイトル）には長さ上限が無いため、そのまま使うと Web Push の通知本体の
// サイズ上限（プッシュ配信サーバー側でおおむね 4KB 程度）を超えて送信そのものが失敗しうる。
// ロック画面での可読性の観点でも、100 文字あれば十分な情報量。
const MAX_NOTIFICATION_TITLE_LENGTH = 100;

// 切り詰めが発生したことを示す省略記号（植草の UX レビュー再指摘・U-2）。ロック画面では
// 通知本体の続きを確認する手段が無いため、無音で切れているとタイトルの途中で終わって
// いることに気づけない。
const TITLE_TRUNCATION_SUFFIX = '…';

// 通知タイトルの UTF-8 バイト長の上限（安藤のセキュリティレビュー再指摘・A-5-b）。
//
// 【書記素数の上限だけでは足りない理由】A-5 で文字（書記素クラスタ）単位の切り詰めに
// 変えたのは正しい対応だったが、1つの書記素クラスタは結合文字（例: U+0301 結合アキュート
// アクセント）をいくらでも含みうるため、「MAX_NOTIFICATION_TITLE_LENGTH 書記素以内」は
// バイト長を何も保証しない。安藤の実測: `'a' + U+0301 × 5000` は書記素数1（上限を素通り）
// だが 10,078 バイト、`('a' + U+0301 × 40) × 100` は書記素数ちょうど100だが 8,177 バイト。
// 一方 `web-push@3.6.7` にローカルのペイロード長チェックは無いため、過大なペイロードは
// そのまま送信され配信サーバーが 413 を返す。413 は 404 / 410 ではないため
// isExpiredSubscriptionStatus() の削除対象に当たらず、宛先は残ったままそのペインの通知
// だけが届かずエラーログが出続ける（LOW-6 で避けたかった状態の再発）。
// 1024 バイトあれば、ロック画面表示に十分な情報量（数百文字相当）を保ちつつ、
// Web Push の通知本体のサイズ上限（プッシュ配信サーバー側でおおむね 4KB 程度。本文・
// tag 等 title 以外のフィールドの分の余裕も見込む）を十分に下回る。
const MAX_NOTIFICATION_TITLE_BYTES = 1024;

/**
 * 文字列を Unicode の書記素クラスタ（見た目上の1文字）単位の配列に分解する
 * （安藤のセキュリティレビュー再指摘・A-5）。JS の文字列インデックス・length は
 * UTF-16 コード単位基準のため、サロゲートペア（絵文字等）や結合文字列（肌色修飾・
 * ZWJ で連結した家族絵文字・国旗など複数コードポイントで1つの見た目になる列）を
 * 単純な slice() で切ると、組を割って壊れた表示（片割れの絵文字・置換文字）になる。
 * Intl.Segmenter（Node 16+ で利用可能）が使えない環境ではコードポイント単位
 * （サロゲートペアは保持するが、結合絵文字までは保証しない）にフォールバックする。
 * @param {string} str
 * @returns {string[]}
 */
function toGraphemes(str) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str); // フォールバック: コードポイント単位
}

/**
 * タイトルを文字（書記素）単位で maxLength 以内に切り詰め、さらに UTF-8 バイト長を
 * maxBytes 以内に収める。切り詰めが発生した場合（書記素数・バイト長のどちらか一方でも
 * 超えていた場合）だけ末尾に省略記号を付ける（安藤のセキュリティレビュー再指摘・A-5・
 * A-5-b、植草の UX レビュー再指摘・U-2）。
 *
 * 【手順】まず書記素数で切る（A-5）。その結果を UTF-8 バイト長で測り、省略記号のバイト数
 * を含めた合計が maxBytes を超えている間、末尾の書記素を1つずつ落とす（A-5-b）。
 * このファイルは Node / Electron 本体側専用でモバイルページへは配信されないため、
 * Buffer.byteLength（グローバル）をそのまま使って問題ない。
 * @param {string} rawTitle
 * @param {number} maxLength 書記素数の上限
 * @param {number} [maxBytes] UTF-8 バイト長の上限（既定 MAX_NOTIFICATION_TITLE_BYTES）
 * @returns {string}
 */
function truncateNotificationTitle(rawTitle, maxLength, maxBytes = MAX_NOTIFICATION_TITLE_BYTES) {
  let graphemes = toGraphemes(rawTitle);
  let truncated = false;
  if (graphemes.length > maxLength) {
    const keep = Math.max(maxLength - TITLE_TRUNCATION_SUFFIX.length, 0);
    graphemes = graphemes.slice(0, keep);
    truncated = true;
  }

  const suffixBytes = Buffer.byteLength(TITLE_TRUNCATION_SUFFIX, 'utf8');
  while (
    graphemes.length > 0
    && Buffer.byteLength(graphemes.join(''), 'utf8') + (truncated ? suffixBytes : 0) > maxBytes
  ) {
    graphemes.pop();
    truncated = true;
  }

  const joined = graphemes.join('');
  return truncated ? joined + TITLE_TRUNCATION_SUFFIX : joined;
}

/**
 * computeNotificationEvents() が返した 1 件のイベントから、Web Push の通知ペイロード
 * （Service Worker の push イベントハンドラがそのまま showNotification に渡す形）を組み立てる。
 * tag は termId と種別を組み合わせた値にし、同じペイン・同じ種別の通知は OS 側で
 * 上書きされる（issue #396: 通知が積み重なって鳴り続けないようにする）。
 * @param {{ termId: string, kind: 'waiting'|'merge', paneLabel: string }} event
 * @returns {{ title: string, body: string, tag: string }}
 */
function buildNotificationPayload(event) {
  const kind = event && event.kind === 'merge' ? 'merge' : 'waiting';
  const termId = event && event.termId != null ? String(event.termId) : '';
  const rawTitle = (event && event.paneLabel) || `Terminal ${termId}`;
  const title = truncateNotificationTitle(rawTitle, MAX_NOTIFICATION_TITLE_LENGTH);
  return {
    title,
    body: NOTIFICATION_BODY_TEXT[kind],
    tag: `vkt-${termId}-${kind}`,
  };
}

module.exports = {
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_NOTIFICATION_TITLE_BYTES,
  TITLE_TRUNCATION_SUFFIX,
  derivePaneNotificationState,
  computeNotificationEvents,
  buildNotificationPayload,
  truncateNotificationTitle,
};
