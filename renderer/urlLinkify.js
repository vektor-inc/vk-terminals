'use strict';

// ターミナル出力中の http(s) URL を「文字列としての範囲」で切り出す純粋関数（issue #349）。
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（既存の urlSafety.js /
// taskQueueLink.js と同じ形）。
//
// ここでは xterm.js のバッファ（IBufferLine 等）には一切触れない。バッファの折り返し行を
// 1 本の論理行へ連結し、ここで見つけた文字位置をバッファ上の (行, 列) へ写像する処理は
// renderer/terminalLinkProvider.js 側の責務にする（xterm 依存部分とロジックを分け、
// ここは fixture 文字列だけで完結するテストを書けるようにするため）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKUrlLinkify = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // urlSafety は Node では require、ブラウザでは先に読み込まれた window.VKUrlSafety から
  // 受け取る（index.html の <script> 順で保証する。urlLinkify.js は urlSafety.js の後に置く）。
  const { isSafeHttpUrl } = (typeof require === 'function')
    ? require('./urlSafety')
    : self.VKUrlSafety;

  // まず「URL らしき塊」を大まかに拾う。文字集合は RFC 3986 の URI 構成文字（unreserved /
  // reserved / パーセントエンコーディングの %）に絞り、生の日本語・全角記号・引用符・
  // 山括弧・バッククォートは最初から候補に含めない。
  //
  // 空白区切りだけを境界にする素朴な実装（「空白以外は何でも拾う」）だと、Claude Code の
  // ログでよくある「URL の直後に区切りの空白が無く日本語が続く」ケース
  // （例:「…をご確認ください：https://example.com。」）で、日本語文まで URL に取り込んで
  // しまう。ASCII の URL 許容文字だけに絞ることで、区切りが無くても正しい境界で止まる
  // （日本語・全角記号はこの文字集合に含まれないため、そこで自然に候補が終わる）。
  //
  // 引用符（' "）とバッククォート（`）・山括弧（<>）は @xterm/addon-web-links の既定正規表現
  // と同じ理由（ログが URL を括る記法によく使われ、URL 自体に含まれることはまず無い）で
  // 候補にすら含めない。半角カッコ・角カッコは RFC 3986 上正当な URL 構成文字であり、
  // Wikipedia の "..._(disambiguation)" のように URL 自体の一部になり得るため候補には含め、
  // 末尾に来たときだけ trimTrailingPunctuation() で対応関係を見て判断する。
  const URL_CANDIDATE_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%()]+/gi;

  // URL の一部になることがまず無い「文の区切り記号」。見つかったら対応関係を見ずに
  // 常に切り落とす。半角・全角（日本語の句読点）の両方を見る。
  const ALWAYS_TRIM_TRAILING = new Set([
    ',', '.', ':', ';', '!', '?',
    '。', '、', '！', '？',
  ]);

  // 閉じカッコ: 「対応する開きカッコが URL 内に無ければ地の文の一部」とみなして切り落とす。
  // 開きカッコの方が多い・同数であれば URL 自体の一部として残す
  // （Wikipedia の "..._(disambiguation)" 等を壊さないための判定。植草レビュー指摘）。
  const CLOSING_BRACKETS = {
    ')': '(',
    ']': '[',
    '）': '（',
    '」': '「',
    '』': '『',
    '】': '【',
  };

  // str 内に ch が何回現れるかを数える小さなヘルパー。
  function countOccurrences(str, ch) {
    let count = 0;
    for (let i = 0; i < str.length; i += 1) {
      if (str[i] === ch) count += 1;
    }
    return count;
  }

  // candidate の末尾から「URL の一部ではなさそうな記号」を 1 文字ずつ切り落とし、
  // 実際の URL 境界を返す純粋関数。閉じカッコが連続する場合や
  // 「）。」のように種類の違う記号が重なる場合も、1 文字ずつ判定して繰り返し削るため
  // まとめて正しく処理できる。
  function trimTrailingPunctuation(candidate) {
    let end = candidate.length;
    while (end > 0) {
      const ch = candidate[end - 1];
      if (ALWAYS_TRIM_TRAILING.has(ch)) {
        end -= 1;
        continue;
      }
      const openBracket = CLOSING_BRACKETS[ch];
      if (openBracket) {
        const upToHere = candidate.slice(0, end);
        const opens = countOccurrences(upToHere, openBracket);
        const closes = countOccurrences(upToHere, ch);
        // 閉じカッコの数が開きカッコより多い＝対応の取れていない末尾の閉じカッコ
        // （ログ側が URL を括弧で囲んでいるケース）なので切り落とす。
        // 同数か開きカッコの方が多ければ URL 自体の一部として残し、そこで打ち切る。
        if (closes > opens) {
          end -= 1;
          continue;
        }
      }
      break;
    }
    return candidate.slice(0, end);
  }

  // text（ANSI 除去済み・折り返しをまたぐ場合は連結済みのプレーンテキスト）から
  // http(s) URL を抽出する純粋関数。
  //
  // 戻り値: [{ url, start, end }, ...]
  //   - url:   末尾記号を落とした後の実際の URL 文字列
  //   - start: text 内での開始インデックス
  //   - end:   text 内での終了インデックス（exclusive。text.slice(start, end) === url）
  //
  // 見た目（ANSI 前景色など）には一切関与しない。呼び出し側（terminalLinkProvider.js）が
  // この結果をバッファ上の (行, 列) 範囲へ変換し、xterm の registerLinkProvider に渡す。
  function extractUrlMatches(text) {
    if (typeof text !== 'string' || !text) return [];

    const results = [];
    // グローバルフラグ付き正規表現は lastIndex を使い回すため、呼び出しのたびに
    // 明示的にリセットする（モジュールスコープの単一インスタンスを使い回すため必須）。
    URL_CANDIDATE_REGEX.lastIndex = 0;
    let match;
    while ((match = URL_CANDIDATE_REGEX.exec(text))) {
      const raw = match[0];
      const url = trimTrailingPunctuation(raw);
      // 末尾記号をすべて削った結果、スキーム部分だけ残った等で URL として不正になった
      // ものは弾く。http(s) 以外を除く判定・長さ上限も isSafeHttpUrl に一本化する
      // （実際に開く経路 openExternalUrlSafe と同じ判定基準に揃えるため）。
      if (url && isSafeHttpUrl(url)) {
        results.push({ url, start: match.index, end: match.index + url.length });
      }
    }
    return results;
  }

  return {
    extractUrlMatches,
    trimTrailingPunctuation,
  };
});
