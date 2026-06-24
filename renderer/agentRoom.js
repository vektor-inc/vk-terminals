/* global module, require */
// ─── エージェントルーム（issue #58） ─────────────────────────────────────────
// サブエージェントの稼働状況を Gather / WorkAdventure 風のチビキャラ（ドット絵）で
// 可視化する描画モジュール。app.js から require して使う。
//
// 役割分担:
//   - app.js  : 状態の供給（HTTP API 由来 or PTY 出力フォールバック）と DOM への組み込み
//   - 本ファイル: キャラのスプライト生成・シーン（相談テーブル / デスク / 休憩）のレイアウト
//
// 状態（state）の語彙は 4 つ:
//   - 'consulting' : 相談中 → テーブルを囲んで吹き出しを出す
//   - 'working'    : 作業中 → デスクで PC に向かう
//   - 'idle'       : 待機中 → コーヒーを飲んでいる
//   - 'off'        : 離席   → 薄く表示

const fs = require('fs');
const path = require('path');

// 表示順（固定）。司＝メイン Claude（ディレクター）、以降はサブエージェント。
const AGENT_ORDER = ['司', '和田', '安藤', '麗美', '植草'];

// 日本語表示名 → Claude Code 上の英語ハンドル（worktree ルールで name は英数字必須）。
// サブエージェントは英語ハンドルで起動されるため、TUI 出力には日本語名ではなく
// このハンドル（@wada / wada / "○ wada # 和田 …" 等）が現れる。
// 司＝メイン Claude はサブエージェントではないのでハンドル判定の対象外（pane status で決める）。
const AGENT_HANDLES = {
  '司': ['tsukasa', 'main'],
  '和田': ['wada'],
  '安藤': ['ando'],
  '麗美': ['remi'],
  '植草': ['uekusa'],
};

// ハンドル判定の対象となるサブエージェント（司を除く全員）。
const SUBAGENT_ORDER = AGENT_ORDER.filter(n => n !== '司');

// 用意されたドット絵スプライト（renderer/sprites/*.svg）。
// ここに登録があるキャラは手続き生成より優先してその SVG を使う。無ければ makeChar で生成。
const SPRITE_FILES = {
  '司': 'tsukasa.svg',
  '和田': 'wada.svg',
  '安藤': 'ando.svg',
  '麗美': 'remi.svg',
  '植草': 'uekusa.svg',
};
const _spriteCache = {};
// 外部スプライト SVG を読み込み、CSS でサイズ制御できるよう class を注入して返す（無ければ null）。
function getExternalSprite(name) {
  if (!(name in _spriteCache)) {
    const file = SPRITE_FILES[name];
    if (!file) {
      _spriteCache[name] = null;
    } else {
      try {
        let svg = fs.readFileSync(path.join(__dirname, 'sprites', file), 'utf8').trim();
        // 開始タグだけ書き換え: 固定 width/height を外し、CSS 用 class と aria-hidden を付与。
        svg = svg.replace(/^<svg\b([^>]*)>/, (m, attrs) => {
          attrs = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
          return `<svg class="ar-sprite-svg" aria-hidden="true"${attrs}>`;
        });
        _spriteCache[name] = svg;
      } catch (e) {
        _spriteCache[name] = null;
      }
    }
  }
  return _spriteCache[name];
}

// 各キャラのメタ情報。服装（outfit）と配色で役割を描き分ける。
//   color: hair（髪）/ cloth（シャツ等の主色）/ jacket（上着・ベスト）/ tie（ネクタイ・リボン）
//          / pants（ズボン）/ apron（エプロン）/ hat（帽子色）
//   style: outfit('suit'|'hoodie'|'vest'|'dress'|'apron'|'shirt') ほか髪型・メガネ・帽子
const AGENT_META = {
  '司':   { role: 'ディレクター',
    color: { hair: '#2b2630', cloth: '#ece7dd', jacket: '#ece7dd', inner: '#23252e' },
    style: { outfit: 'ladysuit', bangs: false, hairTop: 6, partLine: true, longHair: true, hairFront: true, longHairEnd: 27, longHairW: 3 } },
  '和田': { role: 'WP エンジニア',
    color: { hair: '#6b4a2a', cloth: '#2f81f7', pants: '#3d444d' },
    style: { outfit: 'hoodie', male: true } },
  '安藤': { role: 'リードエンジニア',
    color: { hair: '#2a2730', cloth: '#27365c', jacket: '#27365c', tie: '#2ea043', pants: '#222a3f' },
    style: { outfit: 'suit', glasses: true, male: true } },
  '麗美': { role: 'レビュアー / e2e',
    color: { hair: '#ecd06a', cloth: '#26242a', pants: '#ece7dd', inner: '#1b1b20' },
    style: { outfit: 'tee', bangs: false, hairTop: 6, partLine: true, longHair: true, hairFront: true, longHairEnd: 27, longHairW: 3 } },
  '植草': { role: 'UX デザイナー',
    color: { hair: '#7a5226', cloth: '#2bb3a3', apron: '#e8923a', hat: '#e8923a', pants: '#4a3f33' },
    style: { outfit: 'apron', hat: 'beret', male: true } },
};

const SPR_W = 32;
const SPR_H = 44;

// per-char に依存しない固定色。
const COLORS = {
  o: '#3b2f3f', s: '#ffd6a8', t: '#f2b98a', w: '#fbfbfb', i: '#ffffff',
  e: '#3b2f3f', m: '#c4566b', b: '#ff9aa6', f: '#4a3a2c', n: '#f3f5f8', G: '#ffcf48',
};

function darken(hex, f = 0.68) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// 座標ベースでチビキャラを 1 体生成する（左右対称）。string[] を返す。
//   凡例: ' '透明 / o輪郭 / h髪 k髪影 / s肌 w白目 i光 e瞳 m口 b頬 a手
//         c服 d服影 j上着 J上着影 T襟リボン n白襟 p脚 u前掛け V帽子 f靴 G金
function makeChar(opts = {}) {
  const o = Object.assign({
    hairTop: 8, sideRows: 13, sideW: 3, bangs: true, ponytail: false, longHair: false,
    longHairEnd: 16, longHairW: 2, hairFront: false, partLine: false,
    centerPart: false, hat: null, glasses: false, male: false, outfit: 'shirt',
  }, opts);

  const g = Array.from({ length: SPR_H }, () => Array(SPR_W).fill(' '));
  const set = (r, c, ch) => { if (r >= 0 && r < SPR_H && c >= 0 && c < SPR_W) g[r][c] = ch; };
  // 中心 15.5。半幅 hw の対称スパン: 列 (16-hw)..(15+hw)
  const span = (r, hw, fill, outline) => {
    for (let c = 16 - hw; c <= 15 + hw; c++) set(r, c, fill);
    if (outline) { set(r, 16 - hw, outline); set(r, 15 + hw, outline); }
  };
  const rect = (r0, r1, c0, c1, ch) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(r, c, ch); };

  // ── 頭（あごは丸め） ──
  const head = { 1: 4, 2: 7, 3: 9, 4: 10, 5: 11, 6: 11, 7: 11, 8: 11, 9: 11, 10: 11, 11: 11, 12: 11, 13: 11, 14: 10, 15: 9, 16: 7 };
  for (const rs of Object.keys(head)) span(+rs, head[rs], 's', 'o');
  span(17, 5, 's', 'o'); // 丸いあご
  span(18, 3, 's', 'o'); // 首

  // ── 髪 ──
  for (let r = 1; r <= o.hairTop; r++) {
    const hw = head[r]; if (!hw) continue;
    for (let c = 16 - hw; c <= 15 + hw; c++) set(r, c, 'h');
    set(r, 16 - hw, 'o'); set(r, 15 + hw, 'o');
  }
  for (let r = o.hairTop + 1; r <= o.sideRows; r++) {
    const hw = head[r]; if (!hw) continue;
    for (let w = 0; w < o.sideW; w++) { set(r, 16 - hw + w, 'h'); set(r, 15 + hw - w, 'h'); }
    set(r, 16 - hw, 'o'); set(r, 15 + hw, 'o');
  }
  if (o.bangs) {
    for (let c = 9; c <= 22; c++) set(o.hairTop, c, 'h');
    for (let c = 10; c <= 21; c++) set(o.hairTop + 1, c, 'h');
    if (!o.male && !o.centerPart) { rect(o.hairTop, o.hairTop + 1, 15, 16, 'k'); } // 女の子は中央分け
    else if (o.male) { set(o.hairTop + 1, 12, 'k'); set(o.hairTop + 1, 19, 'k'); } // 男の子は毛束
  }
  if (o.centerPart) {
    // 前髪はしっかり残したまま、細い地肌のラインで「人」型の分け目を入れる。
    // （地肌＝明色なので暗い髪に対してシルエットが読める。生え際後退に見えないよう細く）
    const apex = o.hairTop - 3; // 頂点
    set(apex, 15, 's'); set(apex, 16, 's');
    set(apex + 1, 15, 's'); set(apex + 1, 16, 's');
    for (let i = 2; i <= 4; i++) {
      set(apex + i, 16 - i, 's'); set(apex + i, 17 - i, 's'); // 左の払い（ノ）
      set(apex + i, 15 + i, 's'); set(apex + i, 14 + i, 's'); // 右の払い（乀）
    }
  }
  if (o.partLine) {
    // 中央分け（パッツン回避）。生え際を山なりにして、地肌の細い分け目を上に見せる。
    set(o.hairTop, 14, 's'); set(o.hairTop, 15, 's'); set(o.hairTop, 16, 's'); set(o.hairTop, 17, 's');
    set(o.hairTop - 1, 15, 's'); set(o.hairTop - 1, 16, 's');
    for (let r = 2; r <= o.hairTop - 2; r++) { set(r, 15, 'k'); set(r, 16, 'k'); } // 頭頂の分け目
  }
  if (o.longHair) for (let r = o.sideRows + 1; r <= o.longHairEnd; r++) {
    const hw = head[r] || 9;
    for (let w = 0; w < o.longHairW; w++) { set(r, 16 - hw + w, 'h'); set(r, 15 + hw - w, 'h'); }
    set(r, 16 - hw, 'o'); set(r, 15 + hw, 'o');
  }
  if (o.ponytail) {
    [[4, 26], [5, 27], [6, 27], [7, 27], [8, 27], [9, 27], [10, 26], [11, 26], [12, 25]].forEach(([r, c]) => set(r, c, 'h'));
    [[5, 28], [6, 28], [7, 28], [8, 28]].forEach(([r, c]) => set(r, c, 'h'));
    [[5, 29], [7, 29]].forEach(([r, c]) => set(r, c, 'k'));
    set(4, 25, 'h'); // 結び目
  }

  // ── 目・眉・頬・口 ──
  const eyeL = 12, eyeR = 19; // 目の中心列（15.5 対称）
  const eye = (cx) => { set(10, cx, 'e'); set(11, cx, 'e'); set(12, cx, 'e'); set(10, cx, 'i'); };
  eye(eyeL); eye(eyeR);
  if (o.male) {
    rect(8, 8, eyeL - 1, eyeL + 1, 'o'); rect(8, 8, eyeR - 1, eyeR + 1, 'o'); // 眉
  } else {
    rect(13, 13, 9, 11, 'b'); rect(13, 13, 20, 22, 'b'); // ほっぺ
  }
  set(15, 14, 'm'); set(15, 15, 'm'); set(15, 16, 'm'); set(15, 17, 'm'); // 口

  // ── メガネ ──
  if (o.glasses) {
    const lens = (c0, c1) => {
      for (let c = c0; c <= c1; c++) { set(9, c, 'o'); set(13, c, 'o'); }
      for (let r = 9; r <= 13; r++) { set(r, c0, 'o'); set(r, c1, 'o'); }
    };
    lens(9, 14); lens(17, 22);
    set(11, 15, 'o'); set(11, 16, 'o');     // ブリッジ
    set(10, 8, 'o'); set(10, 23, 'o');      // つる
  }

  // ── 体 ──
  const torso = { 19: 6, 20: 9, 21: 10, 22: 10, 23: 10, 24: 10, 25: 10, 26: 10, 27: 10, 28: 10, 29: 9 };
  for (const rs of Object.keys(torso)) span(+rs, torso[rs], 'c', 'o');

  const collarV = () => { rect(19, 21, 15, 16, 'n'); set(20, 14, 'n'); set(20, 17, 'n'); };
  const tie = () => { for (let r = 20; r <= 28; r++) { set(r, 15, 'T'); set(r, 16, 'T'); } set(28, 14, 'T'); set(28, 17, 'T'); };

  if (o.outfit === 'suit') {
    rect(20, 29, 6, 25, 'j');
    rect(20, 22, 15, 16, 'n'); set(21, 14, 'n'); set(21, 17, 'n');
    set(22, 13, 'J'); set(23, 14, 'J'); set(22, 18, 'J'); set(23, 17, 'J'); // ラペル
    tie();
  } else if (o.outfit === 'hoodie') {
    set(18, 12, 'd'); set(18, 19, 'd');                       // フードの根本
    span(19, 6, 'c'); set(19, 10, 'd'); set(19, 21, 'd');
    rect(20, 22, 13, 13, 'n'); rect(20, 22, 18, 18, 'n');     // 紐
    set(23, 13, 'd'); set(23, 18, 'd');                       // 紐先
    rect(25, 27, 12, 19, 'd');                                // 前ポケット
    set(25, 12, 'o'); set(25, 19, 'o'); set(27, 12, 'o'); set(27, 19, 'o');
  } else if (o.outfit === 'vest') {
    rect(20, 29, 12, 19, 'j');                                // ベスト（中央）
    rect(20, 22, 15, 16, 'n'); set(21, 14, 'n'); set(21, 17, 'n');
    tie();
    set(24, 16, 'i'); set(27, 16, 'i');                       // ボタン
  } else if (o.outfit === 'dress') {
    rect(20, 22, 5, 7, 'c'); rect(20, 22, 24, 26, 'c');       // パフスリーブ
    set(20, 5, 'o'); set(22, 5, 'o'); set(20, 26, 'o'); set(22, 26, 'o');
    collarV();
    rect(27, 27, 6, 25, 'd');                                 // ウエストのベルト
    set(20, 15, 'T'); set(20, 16, 'T'); set(21, 14, 'T'); set(21, 17, 'T'); // リボン
    for (let r = 28; r <= 35; r++) {                          // スカート（縦プリーツ）
      const hw = 8 + Math.floor((r - 28) / 2);
      for (let c = 16 - hw; c <= 15 + hw; c++) set(r, c, (Math.floor(c / 2) % 2 === 0) ? 'c' : 'd');
      set(r, 16 - hw, 'o'); set(r, 15 + hw, 'o');
    }
    for (let c = 16 - 11; c <= 15 + 11; c++) set(36, c, (c % 2 === 0) ? 'c' : 'o'); // フリル裾
  } else if (o.outfit === 'sporty') {
    rect(19, 19, 12, 19, 'd');                 // 立ち襟
    rect(22, 29, 15, 16, 'd');                 // 中央ジップ
    set(20, 15, 'n'); set(20, 16, 'n'); set(21, 15, 'n'); set(21, 16, 'n'); // インナーのチラ見せ
    for (let r = 21; r <= 28; r++) { set(r, 7, 'n'); set(r, 24, 'n'); }     // 袖の白ライン
    rect(29, 29, 6, 25, 'd');                   // 裾のリブ
  } else if (o.outfit === 'apron') {
    collarV();
    rect(20, 21, 13, 13, 'u'); rect(20, 21, 18, 18, 'u');     // 肩紐
    rect(22, 29, 12, 19, 'u');                                // エプロン本体
    set(22, 12, 'o'); set(22, 19, 'o'); set(29, 12, 'o'); set(29, 19, 'o');
    rect(26, 26, 14, 17, 'o');                                // ポケットの口
    rect(27, 28, 13, 14, 'c'); rect(27, 28, 17, 18, 'c');     // 横からシャツ
  } else if (o.outfit === 'tee') {
    // オーバーサイズの黒バンドT（torso 'c' = 黒）。袖を広げる。
    rect(20, 24, 5, 7, 'c'); rect(20, 24, 24, 26, 'c');
    set(20, 5, 'o'); set(24, 5, 'o'); set(20, 26, 'o'); set(24, 26, 'o');
    rect(19, 19, 14, 17, 'd');                 // 襟ぐり
    for (let r = 22; r <= 27; r++) for (let c = 11; c <= 20; c++) set(r, c, ((r + c) % 3 === 0) ? 'n' : ((r * c) % 4 === 0 ? 'i' : 'c')); // 胸プリント
    rect(21, 21, 12, 19, 'd');                 // プリント上辺
  } else if (o.outfit === 'ladysuit') {
    rect(20, 29, 6, 25, 'j');                                 // 白ブレザー
    set(20, 15, 'B'); set(20, 16, 'B');                       // 黒インナー（V ネック）
    set(21, 14, 'B'); set(21, 15, 'B'); set(21, 16, 'B'); set(21, 17, 'B');
    set(22, 15, 'B'); set(22, 16, 'B');
    set(20, 13, 'J'); set(21, 13, 'J'); set(22, 14, 'J'); set(23, 15, 'J'); // ラペル
    set(20, 18, 'J'); set(21, 18, 'J'); set(22, 17, 'J'); set(23, 16, 'J');
    set(25, 16, 'G');                                         // ボタン
    rect(24, 29, 15, 16, 'J');                                // 前合わせ
  } else {
    collarV();
  }

  // ── 手 ──
  set(28, 6, 'a'); set(29, 6, 'a'); set(28, 25, 'a'); set(29, 25, 'a');

  // ── 脚（太め）＋ 靴 ──
  const leg = (r, fill) => {
    set(r, 11, 'o'); set(r, 12, fill); set(r, 13, fill); set(r, 14, 'o');
    set(r, 17, 'o'); set(r, 18, fill); set(r, 19, fill); set(r, 20, 'o');
  };
  let shoeR;
  if (o.outfit === 'sporty') {
    for (let r = 30; r <= 33; r++) leg(r, 'p'); // 短パン
    for (let r = 34; r <= 37; r++) leg(r, 's'); // 素足（太もも〜脛）
    shoeR = 38;
  } else if (o.outfit === 'ladysuit') {
    for (let r = 30; r <= 37; r++) { const hw = 8 - Math.floor((r - 30) / 3); span(r, hw, 'c', 'o'); } // タイトスカート
    for (let r = 38; r <= 39; r++) leg(r, 's'); // 脚（ストッキング）
    shoeR = 40;
  } else if (o.outfit === 'tee') {
    // 白のワイドカーゴパンツ（太い脚）
    for (let r = 30; r <= 39; r++) {
      set(r, 8, 'o'); set(r, 9, 'p'); set(r, 10, 'p'); set(r, 11, 'p'); set(r, 12, 'o');
      set(r, 19, 'o'); set(r, 20, 'p'); set(r, 21, 'p'); set(r, 22, 'p'); set(r, 23, 'o');
    }
    rect(33, 35, 9, 10, 'P'); rect(33, 35, 21, 22, 'P'); // カーゴポケット
    shoeR = 40;
  } else {
    const legTop = (o.outfit === 'dress') ? 37 : 30;
    for (let r = legTop; r <= legTop + 4; r++) leg(r, 'p');
    shoeR = legTop + 5;
  }
  if (o.outfit === 'tee') {
    // 厚底スニーカー（黒アッパー×白ソール）
    for (const cc of [[8, 13], [18, 23]]) {
      for (let c = cc[0]; c <= cc[1]; c++) { set(shoeR, c, 'B'); set(shoeR + 1, c, 'n'); }
      set(shoeR, cc[0], 'o'); set(shoeR, cc[1], 'o'); set(shoeR + 1, cc[0], 'o'); set(shoeR + 1, cc[1], 'o');
    }
  } else {
    const shoeFill = (o.outfit === 'sporty') ? 'n' : 'f'; // スポーティは白スニーカー
    set(shoeR, 10, 'o'); set(shoeR, 11, shoeFill); set(shoeR, 12, shoeFill); set(shoeR, 13, shoeFill); set(shoeR, 14, 'o');
    set(shoeR, 17, 'o'); set(shoeR, 18, shoeFill); set(shoeR, 19, shoeFill); set(shoeR, 20, shoeFill); set(shoeR, 21, 'o');
  }

  // ── 帽子 ──
  if (o.hat === 'crown') { [8, 12, 16, 20, 23].forEach(c => set(0, c, 'G')); for (let c = 8; c <= 23; c++) set(1, c, 'G'); set(1, 7, 'o'); set(1, 24, 'o'); }
  if (o.hat === 'beret') {
    for (let c = 7; c <= 23; c++) { set(2, c, 'V'); set(3, c, 'V'); }
    for (let c = 6; c <= 21; c++) set(4, c, 'V');
    for (let c = 8; c <= 20; c++) set(1, c, 'V');
    set(0, 19, 'V'); set(0, 20, 'V');                        // へた
    set(2, 6, 'o'); set(2, 24, 'o'); set(4, 5, 'o');
    for (let c = 7; c <= 22; c++) set(5, c, 'v');            // 帽子のリブ（影）
  }

  // ── 前に垂らすロングヘア（体の上に重ねる） ──
  if (o.hairFront) {
    for (let r = o.sideRows + 1; r <= o.longHairEnd; r++) {
      const hw = head[r] || 9;
      for (let w = 0; w < o.longHairW; w++) { set(r, 16 - hw + w, 'h'); set(r, 15 + hw - w, 'h'); }
      set(r, 16 - hw, 'o'); set(r, 15 + hw, 'o');
    }
  }

  return g.map(row => row.join(''));
}

// char → 実際の塗り色。服飾の各パーツはキャラの color から解決する。
function resolveColor(ch, col) {
  switch (ch) {
    case ' ': return null;
    case 'h': return col.hair;
    case 'k': return darken(col.hair);
    case 'c': return col.cloth;
    case 'd': return darken(col.cloth);
    case 'j': return col.jacket || darken(col.cloth);
    case 'J': return darken(col.jacket || col.cloth);
    case 'T': return col.tie || '#d0d0d0';
    case 'p': return col.pants || '#3d444d';
    case 'P': return darken(col.pants || '#3d444d'); // ズボンの影（ポケット等）
    case 'u': return col.apron || col.cloth;
    case 'V': return col.hat || darken(col.cloth);
    case 'v': return darken(col.hat || col.cloth); // 帽子の影
    case 'B': return col.inner || '#22242c';       // 黒インナー等
    case 'a': return COLORS.s;
    default: return COLORS[ch] || null;
  }
}

// グリッドを SVG にする（行ごとに同色ランをまとめて <rect> 化）。
// 用意済みスプライト（SPRITE_FILES）があればそれを優先して返す。
function buildSpriteSvg(name) {
  const ext = getExternalSprite(name);
  if (ext) return ext;
  const meta = AGENT_META[name] || { color: { hair: '#888', cloth: '#666' }, style: {} };
  const col = meta.color || { hair: '#888', cloth: '#666' };
  const grid = makeChar(meta.style || {});
  const rects = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    let c = 0;
    while (c < row.length) {
      const color = resolveColor(row[c], col);
      if (color === null) { c++; continue; }
      let run = 1;
      while (c + run < row.length && resolveColor(row[c + run], col) === color) run++;
      rects.push(`<rect x="${c}" y="${r}" width="${run}" height="1" fill="${color}"/>`);
      c += run;
    }
  }
  return `<svg class="ar-sprite-svg" viewBox="0 0 ${SPR_W} ${SPR_H}" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

// 小道具の SVG（コーヒー / モニタ）。
const COFFEE_SVG =
  '<svg class="ar-prop-svg" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">' +
  '<rect x="2" y="5" width="6" height="6" fill="#3b2f3f"/>' +
  '<rect x="3" y="5" width="4" height="5" fill="#eef1f5"/>' +
  '<rect x="3" y="6" width="4" height="2" fill="#6f4e37"/>' +
  '<rect x="8" y="6" width="2" height="3" fill="#3b2f3f"/>' +
  '<rect x="8" y="7" width="1" height="1" fill="#eef1f5"/>' +
  '</svg>';

const MONITOR_SVG =
  '<svg class="ar-prop-svg ar-prop-monitor" viewBox="0 0 16 12" shape-rendering="crispEdges" aria-hidden="true">' +
  '<rect x="1" y="0" width="14" height="9" fill="#3b2f3f"/>' +
  '<rect x="2" y="1" width="12" height="7" fill="#0d2a22"/>' +
  '<rect x="3" y="2" width="7" height="1" fill="#2ea043"/>' +
  '<rect x="3" y="4" width="9" height="1" fill="#58a6ff"/>' +
  '<rect x="3" y="6" width="5" height="1" fill="#8b949e"/>' +
  '<rect x="6" y="9" width="4" height="1" fill="#3b2f3f"/>' +
  '<rect x="3" y="10" width="10" height="2" fill="#3b2f3f"/>' +
  '</svg>';

// 1 ハンドルが直近出力に「単語として」出現するか（任意で先頭に @ が付く）を判定する。
// 単語境界で囲むことで "ando" が "andouble" に部分一致する誤検出を防ぐ。
function handleAppears(text, handle) {
  // 例: @wada / wada / "○ wada # …" にマッチし、andouble などにはマッチしない。
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])@?${handle}(?![A-Za-z0-9_])`, 'i');
  return re.test(text);
}

// 直近の PTY 出力テキストから、サブエージェントの稼働状態 { 和田: 'working'|'idle', … } を判定する。
// API（POST /api/agentroom）未通知時のフォールバック用。DOM 非依存の純粋関数なのでユニットテスト可能。
// recentText は ANSI 除去済みのプレーンテキストを想定する（呼び出し側で stripAnsiForDisplay 済み）。
//
// 判定: サブエージェントは Claude Code 上で英語ハンドル（wada / ando / remi / uekusa）で
// 起動されるため、直近出力に日本語名ではなくハンドルが現れる。ハンドルが単語として
// 出現すれば working、無ければ idle とする（司は対象外。pane status で別途決める）。
function resolveAgentStatesFromOutput(recentText) {
  const text = typeof recentText === 'string' ? recentText : '';
  const out = {};
  for (const name of SUBAGENT_ORDER) {
    const handles = AGENT_HANDLES[name] || [];
    out[name] = (text && handles.some(h => handleAppears(text, h))) ? 'working' : 'idle';
  }
  return out;
}

// state 文字列を正規化する。外部（HTTP API）からの表記ゆれを吸収する。
function normalizeState(raw) {
  if (typeof raw !== 'string') return 'idle';
  const s = raw.trim().toLowerCase();
  if (/^(consult|consulting|meeting|discuss|talk)/.test(s) || /相談|会議|打ち合わせ|打合せ/.test(raw)) return 'consulting';
  if (/^(work|working|busy|coding|implement|implementing|test|testing|run|running)/.test(s) || /作業|実装|テスト|稼働/.test(raw)) return 'working';
  if (/^(off|away|gone|absent)/.test(s) || /離席|不在|退室/.test(raw)) return 'off';
  return 'idle';
}

function stateLabel(state) {
  if (state === 'consulting') return '相談中';
  if (state === 'working') return '作業中';
  if (state === 'off') return '離席中';
  return '待機中';
}

// 1 キャラ分の DOM。state に応じて小道具・アニメーションクラスを変える。
function buildCharEl(name, state) {
  const meta = AGENT_META[name] || {};
  const el = document.createElement('div');
  el.className = `ar-char ar-state-${state}`;
  el.dataset.agent = name;
  if (meta.role) el.title = `${name}（${meta.role}）: ${stateLabel(state)}`;

  if (state === 'consulting') {
    const bubble = document.createElement('div');
    bubble.className = 'ar-bubble';
    bubble.textContent = '…';
    el.appendChild(bubble);
  }

  const fig = document.createElement('div');
  fig.className = 'ar-figure';
  fig.innerHTML = buildSpriteSvg(name);

  if (state === 'idle') {
    const cup = document.createElement('div');
    cup.className = 'ar-coffee';
    cup.innerHTML = COFFEE_SVG;
    fig.appendChild(cup);
  }
  el.appendChild(fig);

  if (state === 'working') {
    const desk = document.createElement('div');
    desk.className = 'ar-desk';
    desk.innerHTML = MONITOR_SVG;
    el.appendChild(desk);
  }

  const label = document.createElement('div');
  label.className = 'ar-name';
  label.textContent = name;
  el.appendChild(label);

  return el;
}

// シーン全体を組み立てて返す。agents: { [name]: state }（生文字列でも可）。
function buildScene(agents) {
  const resolved = {};
  for (const name of AGENT_ORDER) resolved[name] = normalizeState(agents && agents[name]);

  const stage = document.createElement('div');
  stage.className = 'ar-stage';

  const consulting = AGENT_ORDER.filter(n => resolved[n] === 'consulting');
  const working = AGENT_ORDER.filter(n => resolved[n] === 'working');
  const lounge = AGENT_ORDER.filter(n => resolved[n] === 'idle' || resolved[n] === 'off');

  if (consulting.length > 0) {
    const zone = document.createElement('div');
    zone.className = 'ar-zone ar-zone-table';
    const around = document.createElement('div');
    around.className = 'ar-around';
    consulting.forEach(n => around.appendChild(buildCharEl(n, 'consulting')));
    const tableTop = document.createElement('div');
    tableTop.className = 'ar-table-top';
    tableTop.innerHTML = '<span class="ar-zone-tag">相談中</span>';
    zone.appendChild(around);
    zone.appendChild(tableTop);
    stage.appendChild(zone);
  }

  if (working.length > 0) {
    const zone = document.createElement('div');
    zone.className = 'ar-zone ar-zone-desks';
    working.forEach(n => zone.appendChild(buildCharEl(n, 'working')));
    const tag = document.createElement('span');
    tag.className = 'ar-zone-tag';
    tag.textContent = '作業中';
    zone.appendChild(tag);
    stage.appendChild(zone);
  }

  if (lounge.length > 0) {
    const zone = document.createElement('div');
    zone.className = 'ar-zone ar-zone-lounge';
    lounge.forEach(n => zone.appendChild(buildCharEl(n, resolved[n])));
    const tag = document.createElement('span');
    tag.className = 'ar-zone-tag';
    tag.textContent = '休憩中';
    zone.appendChild(tag);
    stage.appendChild(zone);
  }

  return stage;
}

module.exports = {
  AGENT_ORDER,
  AGENT_HANDLES,
  SUBAGENT_ORDER,
  AGENT_META,
  normalizeState,
  resolveAgentStatesFromOutput,
  buildScene,
};
