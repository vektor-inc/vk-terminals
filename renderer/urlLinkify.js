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

  // 罫線テーブルのセル境界とみなす縦線の文字コード（issue #361）。ASCII の '|' は
  // 含めない（シェルパイプ「cmd1 | grep https://example.com | wc -l」のように、URL の
  // 直後にスペース＋パイプが続く正当な出力まで「テーブルの行」と誤検知するリスクが
  // 高いため。固定幅の罫線テーブルを描画するツールは通常 Unicode の罫線文字を使い、
  // ASCII パイプでこの種のセル折り返し表示を行うツールは一般的でない）。
  // 0x2502 = │（単線） / 0x2503 = ┃（太線） / 0x2551 = ║（二重線）。
  // 文字コードで比較する（charCodeAt）のは scanTableBorders() 側の性能対策（後述）に
  // 合わせるため。文字列比較・Set.has(文字) より高速。
  function isTableBorderCode(code) {
    return code === 0x2502 || code === 0x2503 || code === 0x2551;
  }

  // text 全体を 1 回だけ走査し、罫線テーブルの縦線の出現数と最初に出てくる位置を返す。
  // extractUrlMatches() が候補（URL）ごとに呼び出すのではなく、行（text）ごとに 1 回だけ
  // 呼び出して結果を使い回す（安藤レビュー指摘・MEDIUM。候補ごとに text 全体を数え直すと
  // O(候補数 × 行長) になり、URL を多数含む行では provideLinks が呼ばれるたび
  // （ホバーで移動するたびに呼ばれる経路）に数 ms かかる実測あり。行ごとに 1 回に
  // まとめることで候補数に依存しない O(行長) に落とす）。
  // for...of ではなく charCodeAt によるインデックスループを使うのも同じ理由の性能対策
  // （for...of は文字列に対してコードポイントごとに部分文字列を生成するため遅い）。
  function scanTableBorders(text) {
    let count = 0;
    let firstIndex = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (isTableBorderCode(text.charCodeAt(i))) {
        count += 1;
        if (firstIndex < 0) firstIndex = i;
      }
    }
    return { count, firstIndex };
  }

  // text の position（match.index + raw.length。生マッチの終端）から、句読点
  // （ALWAYS_TRIM_TRAILING に含まれる文字）が続く間だけ読み飛ばして終端位置を返す。
  // 閉じ括弧（CLOSING_BRACKETS）やその他の文字に当たったところで止まる（許可リスト
  // 方式。isTruncatedAtTableCellBorder のコメント「句読点だけを読み飛ばす理由（B案）」
  // 参照）。upTo（通常は raw の終端）を超えて読み飛ばすことはない。
  function skipTrailingPunctuation(text, position, upTo) {
    let i = position;
    while (i < upTo && ALWAYS_TRIM_TRAILING.has(text[i])) i += 1;
    return i;
  }

  // URL 候補が「罫線テーブルのセル境界で切り詰められた断片」らしいかどうかを判定する
  // （issue #361）。
  //
  // end には「句読点だけを読み飛ばした後の終端」（呼び出し側の skipTrailingPunctuation()
  // が返す値）を渡すこと。trimTrailingPunctuation() 後の url の終端をそのまま渡しては
  // いけない（PR #365 レビュー・HIGH）し、閉じ括弧まで無条件に読み飛ばした生マッチ
  // 終端（match.index + raw.length）を渡してもいけない（PR #365 再レビュー・植草の
  // UX 判断で修正。詳しい理由は下の「句読点だけを読み飛ばす理由（B案）」を参照）。
  //
  // 罫線テーブルの各行は「ターミナルの折り返し」ではなく独立したバッファ行のため、
  // xterm の isWrapped は false。terminalLinkProvider.js の getWrappedLineWindow() は
  // isWrapped な行しか連結しないため、セル幅で見た目上折り返された URL の先頭断片
  // だけが単独の候補として extractUrlMatches() に渡ってきてしまう
  // （罫線テーブルの行は isWrapped: false のため、terminalLinkProvider.js が渡す
  // text は通常その 1 行そのものと一致する。ただしペイン幅より広いテーブルは xterm
  // 自身が行を折り返すため isWrapped: true になり、merged が罫線を含む複数行の
  // 連結になることもあり得る。その場合も text 全体を対象に判定すれば「テーブルの
  // 行らしさ」の検出はできるため、安全側（抑止する方向）に倒れて問題ない）。
  //
  // 判定条件（司・issue 起票者・植草の合意事項。issue コメントにあった「テーブル内は
  // 一律諦める」よりも狭いルール）:
  //   1. 候補が乗っている行に罫線テーブルの縦線が2つ以上ある（＝テーブルの行らしい）。
  //   2. 候補より前に縦線が1つ以上ある（＝候補自身がセルの中にある）。これが無いと
  //      「see https://example.com/a │ x │ y」のような、そもそもテーブルではない
  //      地の文の行まで抑止してしまう（安藤レビュー指摘・LOW）。
  //   3. 候補の直後が「0個以上の空白＋縦線文字」で終わっている（＝セルの右端に接している）。
  // すべて満たす場合だけ「切り詰められている」とみなし、リンク化の対象から外す。
  //
  // 「セルの直下の物理行を実際に読んで続きがあるか検証する」というより厳密な判定も
  // 検討したが、罫線位置の解析・複数セルの対応付けが必要になり、issue のスコープに
  // 対してコストが不釣り合いなため採用しない（司・植草合意）。境界ケースは
  // 「非リンク化する」側に倒す方針のため、条件3 は空白の個数を問わない（0個も含む）
  // 最大限緩い判定にしている。誤って非リンク化した場合の実害は「押せない（テキスト
  // 選択でのコピーは可能）」に留まり、逆に切り詰められた URL をリンク化したままにした
  // 場合の実害（404 を開いてしまう）より小さいと判断したため、この非対称性を判定の
  // 緩さの根拠にしている。
  //
  // ただしこの非対称性ゆえに、条件3は空白の個数を問わない（パディングの空白が
  // 何個挟まっても素通りする）ため、「セル内で URL の直後が句読点だけを挟んで
  // 縦線に直接接している」場合は、その URL がそのセル内で最長かどうかに関わらず
  // 非リンク化される（切り詰められた場合と行内の情報だけでは区別できないため、
  // 原理的に避けられない）。これは意図して受け入れた仕様であり、changelog にも
  // 明記している。
  //
  // なお閉じ括弧（")" "]" 等）はセル内容として扱う（下記「句読点だけを読み飛ばす
  // 理由（B案）」を参照）ため、"#399 (URL)" のように閉じ括弧がセル右端に来る場合は
  // この非リンク化の対象にならず、従来どおりリンク化される。
  //
  // xterm のバッファには一切触れない（text と start/end というインデックスだけで
  // 完結する）純粋関数として書けるため、urlLinkify.js の責務境界（バッファに触れない）
  // を壊さずにここへ置ける。判定に必要なのは「この行に罫線が複数あるか」「候補の前後に
  // 罫線があるか」という文字列だけの情報であり、バッファ座標や折り返し状態への
  // アクセスは不要なため。
  //
  // borders は scanTableBorders(text) の結果を呼び出し側（extractUrlMatches）が
  // 候補ごとではなく行ごとに 1 回だけ計算して渡す（性能対策。上記コメント参照）。
  //
  // 句読点だけを読み飛ばす理由（B案。PR #365 再レビュー・植草の UX 判断で HIGH 修正
  // (3b513df) から変更）:
  // extractUrlMatches() は正規表現でまず「URL らしき塊」を大まかに拾い（raw）、
  // trimTrailingPunctuation() で末尾の "." "," ")" 等を落とした結果を実際の URL
  // （url）にしている。HIGH 修正（3b513df）では、この判定に「トリム前の生マッチ終端
  // （raw の終端）」を渡すことで、句読点で終わる切り詰め断片（例: "vk-agents." の直後
  // が縦線）を正しく抑止できるようにした。
  //
  // ところがこの方式には副作用があった。閉じ括弧（")" "]" や全角の "）" 等）も
  // trimTrailingPunctuation が落とす対象のため、生マッチ終端まで無条件に読み飛ばすと、
  // "#399 (URL)" のように「閉じ括弧がセルの右端に来る」だけの完全な URL まで抑止して
  // しまう。この書式は issue #361 の起票者が最初に貼った再現例そのもので、GitHub CLI
  // や Claude Code のログで頻出するため、この副作用は「境界ケースを抑止側へ倒す」
  // という許容範囲を超え、#361 の主目的（押せるはずの URL を押せるようにする）を
  // 損なう規模だと判断した（司・植草合意）。
  //
  // そこで読み飛ばす対象を ALWAYS_TRIM_TRAILING の句読点だけに絞り、CLOSING_BRACKETS
  // の閉じ括弧（半角・全角とも）は「セル内容」とみなして読み飛ばさない（＝そこで
  // 立ち止まり、抑止しない）ことにした。閉じ括弧の一覧をここで別途ベタ書きしていない
  // 点に注意: skipTrailingPunctuation() は ALWAYS_TRIM_TRAILING に含まれる文字だけを
  // 許可リスト方式で読み飛ばすため、CLOSING_BRACKETS の文字（を含め、それ以外の
  // あらゆる文字）は「許可リストに無い」という理由だけで自動的に読み飛ばし対象外になる。
  // CLOSING_BRACKETS 自体をここで参照する必要が無いため、ALWAYS_TRIM_TRAILING と
  // CLOSING_BRACKETS の定義が二重管理でズレる心配もない。
  //
  // 残るリスク（受け入れ済み・司・植草合意）: URL 自身が ")" 等の閉じ括弧を含み、
  // ちょうどその位置でセル幅に切られた場合だけ、閉じ括弧が「セル内容」と誤認されて
  // 抑止漏れとなり 404 が開く。「URL のパスに閉じ括弧を含む」かつ「切断位置がちょうど
  // そこ」の同時成立が必要なため、発生頻度は十分低いと判断した。
  //
  // 記号のあとに本当のセル内容（例: "済"）が続く場合は、その文字（句読点でも
  // 閉じ括弧でもない）で skipTrailingPunctuation() の読み飛ばしが止まるため、
  // 従来どおり抑止しない（"#363 (https://...) 済 │ done │" のようなケースは壊れない）。
  function isTruncatedAtTableCellBorder(text, start, end, borders) {
    if (borders.count < 2) return false;
    if (borders.firstIndex < 0 || borders.firstIndex >= start) return false;

    let i = end;
    while (i < text.length && text[i] === ' ') i += 1;
    return i < text.length && isTableBorderCode(text.charCodeAt(i));
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

  // 実改行（xterm の isWrapped ではなく、ペイン幅いっぱいの行を強制的に連結した境界。
  // issue #368・案D）をまたぐ URL 候補が「境界より前の部分で、すでにホストを書き終えて
  // パスに入っているか」を判定する純粋関数。
  //
  // なぜ必要か: terminalLinkProvider.js は「1行目がペイン幅いっぱいに埋まっていれば、
  // 次行の isWrapped が false でも連結候補に含める」（案Dの連結条件）。しかしこの連結は
  // 「たまたまペイン幅ちょうどで実改行された、無関係な2行」も対象にしうる。例えば
  // 1行目が "https://example.com" で（ホスト名の直後）ちょうど終わり、2行目が
  // "evil.example/foo"（攻撃者が制御しうるログ出力）で始まっていた場合、連結すると
  // "https://example.comevil.example/foo" という 1 本の候補になる。これは構文上正当な
  // ホスト名（"example.comevil.example"）を持つ URL のため、isSafeHttpUrl /
  // isAcceptableUrlHost / hasUserInfo のどれも検出できない「行き先すり替わり」になる
  // （司・植草 案D合意。ターミナル出力は攻撃者が内容を制御しうる前提のため）。
  //
  // 対策として、境界をまたぐ候補は「境界より前の部分で、スキーム（http(s)://）の直後に
  // パス区切りの '/' が最低1つ現れているか」だけを見る。'/' が現れているということは
  // ホスト名部分をすでに書き終えてパスに入っている（＝境界をまたいでもホスト名自体が
  // 後続の文字で伸びる余地が無い）とみなせる。これはホスト名の構文（IDNA・ポート番号等）
  // を厳密に解析せずに済む、文字列だけで完結する軽量な判定であり、textと数値だけで
  // 完結する純粋関数として書ける（urlLinkify.js の責務境界を壊さない）。
  //
  // text: extractUrlMatches に渡されたのと同じ（連結済みの）文字列。
  // start: 候補の開始インデックス（text 内、0-based）。
  // boundary: 候補がまたいでいる境界の text 内インデックス（この位置の直前まで1行目、
  //   直後から2行目の内容）。
  function isHostConfirmedBeforeBoundary(text, start, boundary) {
    const beforeBoundary = text.slice(start, boundary);
    const schemeMatch = /^https?:\/\//i.exec(beforeBoundary);
    if (!schemeMatch) return false;
    return beforeBoundary.indexOf('/', schemeMatch[0].length) >= 0;
  }

  // text（ANSI 除去済み・折り返しをまたぐ場合は連結済みのプレーンテキスト）から
  // http(s) URL を抽出する純粋関数。
  //
  // 戻り値: [{ url, start, end }, ...]
  //   - url:   末尾記号を落とした後の実際の URL 文字列
  //   - start: text 内での開始インデックス
  //   - end:   text 内での終了インデックス（exclusive。text.slice(start, end) === url）
  //
  // hardWrapBoundaries: terminalLinkProvider.js が「ペイン幅いっぱいの行を isWrapped が
  // false でも強制的に連結した」境界の text 内インデックスの配列（省略可・既定は空配列）。
  // xterm 自身の isWrapped による連結（従来からある正規のソフトラップ）はここに含まれない
  // ため、この配列が空である限り（＝案D の新しい連結が発生していない限り）従来の挙動から
  // 一切変わらない。
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
  function extractUrlMatches(text, hardWrapBoundaries) {
    if (typeof text !== 'string' || !text) return [];
    const boundaries = hardWrapBoundaries || [];

    const results = [];
    // 罫線の出現数・最初の位置は行（text）ごとに変わらないループ不変量のため、
    // 候補ごとに数え直さずここで 1 回だけ計算する（安藤レビュー指摘・MEDIUM。
    // scanTableBorders() のコメント参照）。
    const borders = scanTableBorders(text);
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

        // 案D（issue #368）: 強制連結境界をまたぐ候補は、境界より前でホストが確定して
        // いない限りリンク化しない（1行目の断片も含め一切リンク化しない）。複数の境界を
        // またぐ場合は、最初にまたぐ境界（＝候補内で最も手前の境界）だけを見れば十分
        // （そこでホストが確定していなければ、以降どれだけパスが続いても行き先の安全性は
        // 保証できないため）。境界そのものと同一位置（start や end に一致）は「またいで
        // いない」として扱う（find の比較を厳密不等号にしているのはこのため）。
        const crossedBoundary = boundaries.find((b) => b > start && b < end);
        if (crossedBoundary !== undefined
          && !isHostConfirmedBeforeBoundary(text, start, crossedBoundary)) {
          continue;
        }

        // 罫線テーブルのセル境界で切り詰められた URL 断片はリンク化しない（issue #361）。
        // isTruncatedAtTableCellBorder には、トリム後の end でも生マッチ終端
        // （start + raw.length）でもなく、句読点だけを読み飛ばした終端を渡す
        // （B案。PR #365 再レビュー。理由は isTruncatedAtTableCellBorder のコメント
        // 「句読点だけを読み飛ばす理由（B案）」参照）。
        const rawEnd = start + raw.length;
        const punctuationSkippedEnd = skipTrailingPunctuation(text, end, rawEnd);
        if (isTruncatedAtTableCellBorder(text, start, punctuationSkippedEnd, borders)) continue;
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
    isHostConfirmedBeforeBoundary,
    scanTableBorders,
    skipTrailingPunctuation,
  };
});
