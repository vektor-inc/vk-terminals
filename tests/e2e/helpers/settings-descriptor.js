// 設定パネルの e2e で使う window.VKIpc.invoke の差し替えヘルパー（issue #293）。
//
// 設定パネル系の spec は「window.VKIpc.invoke を退避してテスト用の応答へ差し替え、
// afterEach で元へ戻す」という同じ骨格を spec ごとに写して持っていた。差し替え先が
// window.VKIpc なのは、preload が contextBridge で公開した window.vkBridge を renderer から
// 書き換えられないため（issue #268）で、この「どこを差し替えるか」の判断は今後 IPC 経路を
// 変えるたびに見直す対象になる。写しのままだと全箇所を同時に直す必要があり、直し漏れた
// spec は差し替えが効かないまま実 IPC を叩いて（＝実 HOME の設定ファイルを触りながら）
// 静かに通ってしまう。骨格をここへ集約し、直す場所を減らしていく。
//
// ただし移行はまだ途中で、「ここ 1 箇所を直せば済む」状態には達していない。issue #293 で
// 移行したのは次の 4 spec だけ:
//   settings-code-wrap / settings-mobile-guide-tab / settings-empty-tab-guidance /
//   settings-focus-ring
// 同じ骨格（describe を差し替えて save の payload を積む形）は次の 4 spec に残っており、
// 順次こちらへ移行する予定:
//   settings-duplicate-key / settings-pattern-validation / settings-tabs / settings-visible-when
// したがって差し替えの方式を変えるときは、このファイルだけでなく上記 4 spec も併せて直す。
//
// 一方で、写しに見えた 3 つの差し込み処理は挙動が別物であり、統合してはいけない。
//   - settings:describe を差し替えるか（保存の遅延だけを見る spec は組み込みスキーマを使う）
//   - settings:save の payload を記録するか（記録した payload を直接読んで検証する spec がある）
//   - settings:describe / settings:save 以外のチャンネル（以下「その他チャンネル」）を
//     実装へ委譲するか、null を返して実 IPC から完全に切り離すか
// 3 つ目はかつて spec が選べる真偽値（passthroughOtherChannels）だったが、issue #304 の
// 調査で「describe を差し替えたかどうか」だけから機械的に決まり、選ぶ余地がないことが
// 分かった（下の installInvokeStub 参照）。設定定義を丸ごと差し替える 2 つの入口
// （installDescriptor / installDescriptorRecordingSaves）は、実測でその他チャンネルが
// 一度も発生しないことを確認済み。差し替えない stubSlowSave は settings:describe 自身が
// その他チャンネル扱いになり、モーダルを閉じて開き直す spec で実際に再呼び出しされるため
// 委譲が必須。そのため真偽値のオプションは廃止し、意図の読める 3 つの入口として公開する。
// spec 側は呼び出し行を見れば何を差し込んでいるのかが分かり、丸めた統合も起きない。

// 差し替えの骨格。ここだけが window.VKIpc.invoke を触る。
//
// options はページへ渡すため構造化複製できるプレーンデータに限る（関数は渡せない）。
// そのため「チャンネルごとのハンドラを spec から渡す」形は採れず、ページ側の 1 つの
// ディスパッチャが options を見て分岐する形にしている。
//
//   - describe: { descriptor } を渡したときだけ settings:describe を横取りする。
//     判定は `descriptor` プロパティの有無ではなく、`describe` ラッパーそのものの
//     truthy 判定（if (opts.describe)）。descriptor に null を差し込めば「利用不可」を
//     再現できる（ラッパー自体は truthy なので横取りされ、settings:describe の応答として
//     null が返る）。一方、`describe: undefined` のように呼び出し側がラッパーごと
//     undefined を渡すと横取りされない（差し替えないことと区別する、という元の意図どおり）。
//     このラッパーの truthy / falsy は、その他チャンネル（settings:describe / settings:save
//     以外。describe が falsy な場合は settings:describe 自身もここに含まれる）の扱いも
//     決める。真偽値のオプションは持たない — describe が truthy＝設定定義を丸ごと
//     差し替えたときはその他チャンネルも Promise.resolve(null) を返して実 IPC から切り離し
//     （差し込んだ定義と実環境の状態が混ざるのを防ぐ）、describe が falsy なときはその他
//     チャンネルを元の invoke（実装）へ委譲する。したがって `describe: cond ? { descriptor }
//     : undefined` のように条件次第でラッパーごと undefined になりうる渡し方をすると、
//     安全側（null で切り離す）ではなく委譲側へ黙って倒れる点に注意（呼び出し側が
//     describe を渡すかどうかを条件分岐する場合は、呼び出し自体を分ける）。issue #304 の
//     実測で、前者（installDescriptor / installDescriptorRecordingSaves）はその他チャンネルが
//     一度も発生しないこと、後者（stubSlowSave）は settings:describe 自身が実際に委譲される
//     （モーダルを閉じて開き直すと再呼び出しされる）ことを確認している。
//   - recordSavePayloads: settings:save で受け取った payload を window.__savedPayloads へ積む。
//   - saveDelayMs: 指定があれば settings:save の応答をその時間だけ遅らせる。
async function installInvokeStub(win, options) {
  await win.evaluate((opts) => {
    const vkIpc = window.VKIpc;
    // 退避は初回だけ。既にスタブが載っている状態で上書きすると、スタブ自身を
    // 「元の invoke」として控えてしまい、restoreInvoke しても実経路へ戻らなくなる。
    if (!window.__origInvoke) window.__origInvoke = vkIpc.invoke.bind(vkIpc);
    // 差し込みのたびに空へ戻す。前のテストで積んだ payload が残っていると、
    // 「最後に保存された値」を見る検証が前のテストの結果を拾って通ってしまう。
    if (opts.recordSavePayloads) window.__savedPayloads = [];
    vkIpc.invoke = (channel, ...args) => {
      if (opts.describe && channel === 'settings:describe') {
        return Promise.resolve(opts.describe.descriptor);
      }
      if (channel === 'settings:save') {
        // 保存は実ファイルへ書かせない（一時 HOME の設定ファイルを書き換えないため）。
        if (opts.recordSavePayloads) window.__savedPayloads.push(args[0]);
        const response = { ok: true };
        if (opts.saveDelayMs === undefined) return Promise.resolve(response);
        return new Promise((resolve) => setTimeout(() => resolve(response), opts.saveDelayMs));
      }
      // その他チャンネル（settings:describe を差し替えていない場合はそれ自身も含む）。
      // describe を渡した＝設定定義を丸ごと差し替えたときだけ null で切り離す。
      if (opts.describe) return Promise.resolve(null);
      return window.__origInvoke(channel, ...args);
    };
  }, options);
}

// テスト用の設定ディスクリプタを読み込ませる。保存は成功だけ返す。describe/save 以外の
// その他チャンネルは実 IPC から切り離す（Promise.resolve(null)）。設定定義を丸ごと差し替えて
// いるため、残りのチャンネルまで実環境の応答を混ぜると、差し込んだ定義と実環境の状態が
// 入り混じった状態を見ることになる（installInvokeStub 冒頭のコメント参照）。
//
// かつては「設定パネルの描画に必要な周辺の問い合わせをアプリに任せる」目的でその他
// チャンネルを実装へ委譲していたが、issue #304 の実測でこの入口を使う spec
// （settings-code-wrap / settings-focus-ring）ではその他チャンネルが一度も発生しないことを
// 確認済み。周辺の問い合わせは実在しなかったため、他の 2 入口と同じ「渡さない」へ統一した。
async function installDescriptor(win, descriptor) {
  await installInvokeStub(win, { describe: { descriptor } });
}

// テスト用の設定ディスクリプタを読み込ませ、あわせて保存時の payload を記録する。
// 「保存処理がどの欄の値を採用したか」を DOM ではなく payload で直接観測する spec 用。
// 記録した内容は savedPayloads / lastSavedPayload で読む。
//
// describe を渡しているため、installInvokeStub の規則により describe/save 以外の
// その他チャンネルも実装へ委譲せず null を返す。ディスクリプタを丸ごと差し替えて
// 成立させている検証なので、残りのチャンネルだけ実 IPC の応答が混ざると、差し込んだ
// 定義と実環境の状態が入り混じった状態を見ることになる（issue #304 の実測で、この入口を
// 使う settings-empty-tab-guidance ではその他チャンネルが一度も発生しないことも確認済み）。
async function installDescriptorRecordingSaves(win, descriptor) {
  await installInvokeStub(win, {
    describe: { descriptor },
    recordSavePayloads: true,
  });
}

// settings:save の応答だけをわざと遅らせる。保存処理は await の向こう側なので、
// 「応答が返ってきた時点では既にモーダルが閉じられている」状況をこれで再現する。
// settings:describe は差し替えないため、描画されるのは組み込みスキーマのまま
// （このスタブの本体は遅延であって、定義の差し替えではない）。
//
// describe を渡していないため、installInvokeStub の規則により settings:describe 自身も
// 「その他チャンネル」として元の invoke（実装）へ委譲される。この委譲は他の 2 入口と違って
// 見た目の一致ではなく実際に必要 — この spec は保存後にモーダルを閉じてすぐ開き直す手順を
// 含み、その再オープンのたびに settings:describe が再度呼ばれて組み込みスキーマを取り直す
// （settings-mobile-guide-tab.smoke.spec.js の「保存応答が閉じた後に返ってきても、
// 自動クローズを武装し直さない」で実測済み。issue #304）。ここで委譲を止めると、
// 再オープン後の設定パネルは組み込みスキーマが読めず空のまま描画される。
//
// 遅延こそがこの入口の本体なので、delayMs を渡し忘れたら黙って遅延ゼロにせず落とす
// （即応答になると「閉じた後に応答が返る」状況が再現されず、テストが素通りする）。
async function stubSlowSave(win, delayMs) {
  if (typeof delayMs !== 'number') throw new Error('stubSlowSave: delayMs は必須');
  await installInvokeStub(win, { saveDelayMs: delayMs });
}

// 差し替えを元へ戻す。上記 3 つのどれを当てた場合でも、これ 1 つで戻る。
// describe.serial では win を共有しているため、差し替えたテストは必ずここまで戻して
// 後続へ漏らさない（組み込みスキーマを読む実経路の検証が、前のテストの差し込みで
// 静かに壊れるのを防ぐ）。
//
// window.__savedPayloads はここでは消さない。消さなくても次の差し込みで空へ戻るうえ、
// 「戻す」処理が記録の後始末まで兼ねると、記録を読む前に戻してしまう順序ミスを誘う。
async function restoreInvoke(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) return;
    vkIpc.invoke = window.__origInvoke;
    delete window.__origInvoke;
  });
}

// 記録した payload の読み出し。移行済みの spec は window.__savedPayloads を直接触らず
// ここを通す（記録先の名前を変えるときに追う範囲を狭めるため）。ただし未移行の 4 spec は
// 今も window.__savedPayloads を直接読み書きしているので、名前を変えるならそちらも直す。
//
// savedPayloads は現時点でどの spec からも呼ばれていないが、消さない。lastSavedPayload では
// 「保存が 1 度も呼ばれていない（0 件）」も「先頭の 1 件」も表せず、未移行の
// settings-pattern-validation / settings-tabs / settings-visible-when が実際にその 2 つを
// 見ている。読み出し口をこれだけにすると、移行時に再び window.__savedPayloads を直接
// 触る形へ戻ってしまう。
const savedPayloads = (win) => win.evaluate(() => (window.__savedPayloads || []).slice());
const lastSavedPayload = (win) => win.evaluate(
  () => window.__savedPayloads[window.__savedPayloads.length - 1]
);

module.exports = {
  installDescriptor,
  installDescriptorRecordingSaves,
  lastSavedPayload,
  restoreInvoke,
  savedPayloads,
  stubSlowSave,
};
