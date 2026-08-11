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

  // CLOSING_BRACKETS の値（開きカッコ側）だけを集めた集合。開きカッコの出現数を
  // 数える際に「この文字は何かの開きカッコか」を判定するのに使う。
  const OPEN_BRACKETS = new Set(Object.values(CLOSING_BRACKETS));

  // candidate の末尾から「URL の一部ではなさそうな記号」を 1 文字ずつ切り落とし、
  // 実際の URL 境界を返す純粋関数。閉じカッコが連続する場合や
  // 「）。」のように種類の違う記号が重なる場合も、1 文字ずつ判定して繰り返し削るため
  // まとめて正しく処理できる。
  //
  // 開き/閉じカッコの出現数は candidate 全体を 1 回走査して先に数えておき、末尾から
  // 1 文字削るたびにカウンタを減算するだけにする（安藤レビュー指摘・LOW）。以前は
  // 1 文字削るたびに candidate.slice() + 再カウントをしており、閉じカッコが n 個
  // 連続するログ 1 行でホバーのたびに O(n^2) の計算コストがかかっていた
  // （n=2000 で 9.88ms、n を倍にすると 4 倍に悪化する実測あり）。
  function trimTrailingPunctuation(candidate) {
    const closeCounts = Object.create(null);
    const openCounts = Object.create(null);
    for (let i = 0; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (CLOSING_BRACKETS[ch]) {
        closeCounts[ch] = (closeCounts[ch] || 0) + 1;
      } else if (OPEN_BRACKETS.has(ch)) {
        openCounts[ch] = (openCounts[ch] || 0) + 1;
      }
    }

    let end = candidate.length;
    while (end > 0) {
      const ch = candidate[end - 1];
      if (ALWAYS_TRIM_TRAILING.has(ch)) {
        end -= 1;
        continue;
      }
      const openBracket = CLOSING_BRACKETS[ch];
      if (openBracket) {
        const opens = openCounts[openBracket] || 0;
        const closes = closeCounts[ch] || 0;
        // 閉じカッコの数が開きカッコより多い＝対応の取れていない末尾の閉じカッコ
        // （ログ側が URL を括弧で囲んでいるケース）なので切り落とす。
        // 同数か開きカッコの方が多ければ URL 自体の一部として残し、そこで打ち切る。
        if (closes > opens) {
          end -= 1;
          // 末尾から取り除いた分だけ、この文字のカウントを減らす
          // （以降の判定は「残っている範囲」に対して行うため）。
          closeCounts[ch] = closes - 1;
          continue;
        }
      }
      break;
    }
    return candidate.slice(0, end);
  }

  // url の「見た目の行き先」を安全に取り出すヘルパー（安藤レビュー指摘・MEDIUM）。
  // new URL().host はポート込みのホスト（例: "evil.example" / "127.0.0.1:3000"）。
  // 解析に失敗した場合は空文字を返す（isSafeHttpUrl 済みの値を渡す前提のため通常は
  // 到達しないが、呼び出し側の防御として fail-safe にしておく）。
  function getUrlHost(url) {
    try {
      return new URL(url).host;
    } catch (_e) {
      return '';
    }
  }

  // ユーザー情報（user:pass@host 形式）を含む URL かどうか。
  //
  // `https://github.com@evil.example/login` のように、見た目上は github.com への
  // リンクに見えても実際のホストは evil.example になる「なりすまし URL」が存在する
  // （ユーザー情報部分がブラウザの表示上パスの一部のように誤読されやすいことを悪用する
  // 手口。安藤レビュー指摘・MEDIUM）。ターミナル出力は攻撃者が内容を制御しうる前提の
  // ため、ツールチップで実ホストを示すだけでなく、そもそもユーザー情報付き URL は
  // リンク化の対象から外す。`https://token@github.com/...` のような正当な用途の URL も
  // クリックできなくなるが、なりすまし対策として防げるものの方が大きいと判断している
  // （司・安藤合意）。
  function hasUserInfo(url) {
    try {
      const parsed = new URL(url);
      return !!(parsed.username || parsed.password);
    } catch (_e) {
      // 解析できない値は安全側（弾く）に倒す。
      return true;
    }
  }

  // 罫線テーブルのセル境界とみなす縦線文字（issue #361）。ASCII の '|' は含めない
  // （シェルパイプ「cmd1 | grep https://example.com | wc -l」のように、URL の直後に
  // スペース＋パイプが続く正当な出力まで「テーブルの行」と誤検知するリスクが高いため。
  // 固定幅の罫線テーブルを描画するツールは通常 Unicode の罫線文字（│ U+2502 /
  // ┃ U+2503）を使い、ASCII パイプでこの種のセル折り返し表示を行うツールは一般的でない）。
  const TABLE_BORDER_CHARS = new Set(['│', '┃']); // │ ┃

  // URL 候補（text.slice(start, end)）が「罫線テーブルのセル境界で切り詰められた断片」
  // らしいかどうかを判定する（issue #361）。
  //
  // 罫線テーブルの各行は「ターミナルの折り返し」ではなく独立したバッファ行のため、
  // xterm の isWrapped は false。terminalLinkProvider.js の getWrappedLineWindow() は
  // isWrapped な行しか連結しないため、セル幅で見た目上折り返された URL の先頭断片
  // だけが単独の候補として extractUrlMatches() に渡ってきてしまう
  // （罫線テーブルの行は isWrapped: false のため、terminalLinkProvider.js が渡す
  // text は常にその 1 行そのものと一致する。折り返しをまたいだ本物の連結結果に
  // 罫線文字が混じることは通常無いため、text 全体を見て判定して問題ない）。
  //
  // 判定条件（司・issue 起票者・植草の合意事項。issue コメントにあった「テーブル内は
  // 一律諦める」よりも狭いルール）:
  //   1. 候補が乗っている行に罫線テーブルの縦線が2つ以上ある（＝テーブルの行らしい）。
  //   2. 候補の直後が「0個以上の空白＋縦線文字」で終わっている（＝セルの右端に接している）。
  // 両方満たす場合だけ「切り詰められている」とみなし、リンク化の対象から外す。
  //
  // 「セルの直下の物理行を実際に読んで続きがあるか検証する」というより厳密な判定も
  // 検討したが、罫線位置の解析・複数セルの対応付けが必要になり、issue のスコープに
  // 対してコストが不釣り合いなため採用しない（司・植草合意）。境界ケースは
  // 「非リンク化する」側に倒す方針のため、条件2 は空白の個数を問わない（0個も含む）
  // 最大限緩い判定にしている。誤って非リンク化した場合の実害は「押せない（テキスト
  // 選択でのコピーは可能）」に留まり、逆に切り詰められた URL をリンク化したままにした
  // 場合の実害（404 を開いてしまう）より小さいと判断したため、この非対称性を判定の
  // 緩さの根拠にしている。
  //
  // xterm のバッファには一切触れない（text と start/end というインデックスだけで
  // 完結する）純粋関数として書けるため、urlLinkify.js の責務境界（バッファに触れない）
  // を壊さずにここへ置ける。判定に必要なのは「この行に罫線が複数あるか」「候補の直後が
  // 罫線で閉じているか」という文字列だけの情報であり、バッファ座標や折り返し状態への
  // アクセスは不要なため。
  function isTruncatedAtTableCellBorder(text, start, end) {
    let borderCount = 0;
    for (const ch of text) {
      if (TABLE_BORDER_CHARS.has(ch)) borderCount += 1;
    }
    if (borderCount < 2) return false;

    let i = end;
    while (i < text.length && text[i] === ' ') i += 1;
    return i < text.length && TABLE_BORDER_CHARS.has(text[i]);
  }

  // ホスト名が「実在しそうな行き先」かどうかの最低限のチェック（安藤レビュー指摘・LOW）。
  // URL_CANDIDATE_REGEX は ASCII 文字だけを候補にしているため、`https://götest.com` は
  // `https://g` のようにホスト名が 1 文字だけ切り取られた状態でも isSafeHttpUrl は
  // 通ってしまう（new URL() 自体は成功するため）。切り詰めは常に「短くなる」方向で
  // セキュリティ上の実害は無いが、押しても意味の無いページが開くのを避ける。
  //
  // ただし vk-terminals はローカル開発サーバの URL（http://localhost:8888 /
  // http://127.0.0.1:3000 等）がログに頻出するアプリのため、ドットを含まない
  // ホスト名を一律弾くと実用上の価値が大きく下がる。'localhost' と IP リテラル
  // （IPv4 はドットを含むため下の一般ルールで自動的に許可される。IPv6 は
  // new URL().hostname が "[::1]" のように角括弧付き・コロン込みで返るため、
  // コロンを含むホストも明示的に許可する）は必ず通す。
  function isAcceptableUrlHost(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (!hostname) return false;
      if (hostname === 'localhost') return true;
      if (hostname.includes(':')) return true; // IPv6 リテラル（[::1] 等）
      return hostname.includes('.'); // IPv4 はドットを含むためここで許可される
    } catch (_e) {
      return false;
    }
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
  //
  // 折り返し行をまたいだ結果として偶然できあがる文字列にも同じ判定を通す。例えば
  // 行末が "https://github.com" で終わり、次行の先頭が "@evil.example/x"（前景色を
  // 背景色と同じにして不可視にできる）だった場合、terminalLinkProvider.js が連結した
  // 論理行では "https://github.com@evil.example/x" という 1 本の候補になる。これは
  // ユーザー情報付き URL に該当するため hasUserInfo() で弾かれ、リンク化されない
  // （安藤レビュー指摘・MEDIUM。折り返しをまたぐケースが特に危険という指摘への対応）。
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
      if (url && isSafeHttpUrl(url) && !hasUserInfo(url) && isAcceptableUrlHost(url)) {
        const start = match.index;
        const end = start + url.length;
        // 罫線テーブルのセル境界で切り詰められた URL 断片はリンク化しない（issue #361）。
        if (isTruncatedAtTableCellBorder(text, start, end)) continue;
        results.push({ url, start, end });
      }
    }
    return results;
  }

  return {
    extractUrlMatches,
    trimTrailingPunctuation,
    getUrlHost,
    hasUserInfo,
    isAcceptableUrlHost,
    isTruncatedAtTableCellBorder,
  };
});
