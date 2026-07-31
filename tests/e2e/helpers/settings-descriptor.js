// 設定パネルの e2e で使う window.VKIpc.invoke の差し替えヘルパー（issue #293）。
//
// 設定パネル系の 4 spec は「window.VKIpc.invoke を退避してテスト用の応答へ差し替え、
// afterEach で元へ戻す」という同じ骨格を spec ごとに写して持っていた。差し替え先が
// window.VKIpc なのは、preload が contextBridge で公開した window.vkBridge を renderer から
// 書き換えられないため（issue #268）で、この「どこを差し替えるか」の判断は今後 IPC 経路を
// 変えるたびに見直す対象になる。写しのままだと 4 箇所を同時に直す必要があり、直し漏れた
// spec は差し替えが効かないまま実 IPC を叩いて（＝実 HOME の設定ファイルを触りながら）
// 静かに通ってしまう。骨格をここへ一本化し、直す場所を 1 箇所にする。
//
// 一方で、写しに見えた 3 つの差し込み処理は挙動が別物であり、統合してはいけない。
//   - settings:describe を差し替えるか（保存の遅延だけを見る spec は組み込みスキーマを使う）
//   - settings:save の payload を記録するか（記録した payload を直接読んで検証する spec がある）
//   - それ以外のチャンネルを実装へ委譲するか、null を返して実 IPC から完全に切り離すか
// これらは「どこまでを本物のアプリに任せるか」という、spec ごとに意図して選んだ違いなので、
// オプションの真偽値を spec に並べさせるのではなく、意図の読める 3 つの入口として公開する。
// spec 側は呼び出し行を見れば何を差し込んでいるのかが分かり、丸めた統合も起きない。

// 差し替えの骨格。ここだけが window.VKIpc.invoke を触る。
//
// options はページへ渡すため構造化複製できるプレーンデータに限る（関数は渡せない）。
// そのため「チャンネルごとのハンドラを spec から渡す」形は採れず、ページ側の 1 つの
// ディスパッチャが options を見て分岐する形にしている。
//
//   - describe: { descriptor } を渡したときだけ settings:describe を横取りする。
//     キーの有無で判定するのは、descriptor に null を差し込んで「利用不可」を再現したく
//     なったときに、差し替えないことと区別できるようにするため。
//   - recordSavePayloads: settings:save で受け取った payload を window.__savedPayloads へ積む。
//   - saveDelayMs: 指定があれば settings:save の応答をその時間だけ遅らせる。
//   - passthroughOtherChannels: 横取りしないチャンネルを元の invoke へ委譲するか。
//     false のときは Promise.resolve(null) を返し、実 IPC へ一切届かせない。
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
      if (opts.passthroughOtherChannels) return window.__origInvoke(channel, ...args);
      return Promise.resolve(null);
    };
  }, options);
}

// テスト用の設定ディスクリプタを読み込ませる。保存は成功だけ返し、それ以外のチャンネルは
// 本物の実装へ委譲する（設定パネルの描画に必要な周辺の問い合わせをアプリに任せる）。
async function installDescriptor(win, descriptor) {
  await installInvokeStub(win, {
    describe: { descriptor },
    passthroughOtherChannels: true,
  });
}

// テスト用の設定ディスクリプタを読み込ませ、あわせて保存時の payload を記録する。
// 「保存処理がどの欄の値を採用したか」を DOM ではなく payload で直接観測する spec 用。
// 記録した内容は savedPayloads / lastSavedPayload で読む。
//
// こちらは横取りしないチャンネルも実装へ委譲せず null を返す。ディスクリプタを丸ごと
// 差し替えて成立させている検証なので、残りのチャンネルだけ実 IPC の応答が混ざると、
// 差し込んだ定義と実環境の状態が入り混じった状態を見ることになる。
async function installDescriptorRecordingSaves(win, descriptor) {
  await installInvokeStub(win, {
    describe: { descriptor },
    recordSavePayloads: true,
    passthroughOtherChannels: false,
  });
}

// settings:save の応答だけをわざと遅らせる。保存処理は await の向こう側なので、
// 「応答が返ってきた時点では既にモーダルが閉じられている」状況をこれで再現する。
// settings:describe は差し替えないため、描画されるのは組み込みスキーマのまま
// （このスタブの本体は遅延であって、定義の差し替えではない）。
async function stubSlowSave(win, delayMs) {
  await installInvokeStub(win, {
    saveDelayMs: delayMs,
    passthroughOtherChannels: true,
  });
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

// 記録した payload の読み出し。window.__savedPayloads はこのヘルパーの実装詳細なので、
// spec 側から直接触らせない（記録先の名前を変えるときに spec を追いかけずに済む）。
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
