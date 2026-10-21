// セットアップ状況の一覧パネル（issue #456）。
//
// 組み込み側（例: VK Orchestrator）が渡した doctor の結果を、ペインの右に並べるパネルとして描く。
// 状態は 3 つ。
//   - 主役（main）  : セットアップ用ペインがまだ無いとき。パネルを広めに出す。
//   - 並べる（side）: セットアップ用ペインが開いているとき。ペインの右に幅 360px 前後で並べる。
//   - 畳む（folded）: 「閉じる」を押したとき。上端の 1 行の帯にして、完全には消さない。
// セットアップ済みの利用者には組み立てない（controller.applyResult が未完了・確認失敗のときだけ作る）。
//
// 安全: doctor の文字列は外から来た値として扱い、textContent だけで描く（HTML として解釈される描き方はしない）。
// 項目数・文字数の切り詰めと形の検証は VKSetupStatus.normalizeSetupStatus（main 側）で済んでいる。
// コマンドはコピーするだけで、ここからは実行しない。
(function (root) {
  'use strict';

  const S = root.VKSetupStatus;
  const T = S.SETUP_TEXT;
  const COPIED_LABEL_MS = 2000;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  /**
   * @param {object} deps
   * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke        IPC（setup:check）
   * @param {(text: string) => Promise<boolean>} deps.writeClipboard               上限つきのコピー経路
   * @param {() => ('none'|'plain'|'claude')} deps.getSetupPaneState               セットアップ用ペインの状態（plain は Claude 無しのシェル）
   * @param {() => void} deps.restoreFocus                                         パネルを消したあと、直前のターミナルへフォーカスを戻す
   * @param {() => void} deps.startSetup                                           セットアップ用ペインを開く
   * @param {() => void} deps.showSetupPane                                        開いているペインへフォーカスを移す
   * @param {() => void} deps.requestLayout                                        パネルの置き場所が変わったので再配置してほしい
   * @param {() => void} deps.onStatusChange                                       判定が変わった（サイドバーの再描画用）
   */
  function create(deps) {
    let result = null;
    // 直近に「確認できた」判定の allRequiredOk。確認に失敗しても、サイドバーの停止表示は
    // この値のまま保つ（失敗でセットアップ済みの表示に戻さず、文言もちらつかせない）。
    let lastKnownAllRequiredOk = null;
    let checking = false;
    let folded = false;
    let dismissed = false;
    let built = false;
    let renderedPaneState = 'none';
    // 直近に確認できた結果。確認に失敗しても、一覧はこれを薄く残す。
    let lastGood = null;
    // ウィンドウが狭いとき（ターミナルが潰れるため）は自動で畳む。利用者が開いたときだけ広げる。
    const NARROW_WINDOW_MAX = 1000;
    let forceOpenWhenNarrow = false;
    let narrowNow = root.innerWidth < NARROW_WINDOW_MAX;

    let panel = null;
    let content = null;
    let live = null;
    let band = null;
    let bandText = null;
    let mainArea = null;

    // ─── 状態の問い合わせ ───────────────────────────────────────────────
    function isComplete(r) {
      return !!(r && r.ok === true && r.status.summary.allRequiredOk === true);
    }

    // 判定が出るまでは null（停止表示の文言を変えない）。
    function getAllRequiredOk() {
      return lastKnownAllRequiredOk;
    }

    function isIncomplete() {
      return getAllRequiredOk() === false;
    }

    function mode() {
      if (!built || dismissed) return 'hidden';
      if (folded || (root.innerWidth < NARROW_WINDOW_MAX && !forceOpenWhenNarrow)) return 'folded';
      return deps.getSetupPaneState() !== 'none' ? 'side' : 'main';
    }

    // ─── 部品 ───────────────────────────────────────────────────────────
    function actionButton(key, label, className, onClick, { ariaDisabled = false, describedBy = '' } = {}) {
      const button = el('button', className, label);
      button.type = 'button';
      button.dataset.setupKey = key;
      // disabled 属性にするとフォーカスが外れるため、押せない状態は aria-disabled で示してクリックだけ無効にする。
      if (ariaDisabled) {
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('is-disabled');
      }
      if (describedBy) button.setAttribute('aria-describedby', describedBy);
      button.addEventListener('click', () => {
        if (ariaDisabled) return;
        onClick(button);
      });
      return button;
    }

    function announce(text) {
      if (!live) return;
      if (live.textContent === text) {
        // 同じ文言を読み直させるときだけ、いったん空にして次の描画で入れ直す。
        live.textContent = '';
        requestAnimationFrame(() => { live.textContent = text; });
        return;
      }
      live.textContent = text;
    }

    async function copyWithFeedback(button, text, idleLabel) {
      let ok = false;
      try { ok = await deps.writeClipboard(text); } catch (_e) { ok = false; }
      const message = ok ? T.copiedButton : T.copyFailed;
      button.textContent = message;
      announce(message);
      setTimeout(() => {
        // 再描画で外れたボタンには触らない。
        if (button.isConnected) button.textContent = idleLabel;
      }, COPIED_LABEL_MS);
    }

    function commandBlock(row) {
      const wrap = el('div', 'setup-cmd-list');
      row.commands.forEach((entry, index) => {
        const item = el('div', 'setup-cmd');
        item.setAttribute('role', 'group');
        item.setAttribute('aria-label', `${row.label}の導入コマンド`);
        if (entry.os) item.appendChild(el('span', 'setup-cmd-os', entry.os));
        const line = el('div', 'setup-cmd-line');
        const code = el('code', 'setup-cmd-code', entry.command);
        const copy = actionButton(`copy-${row.id}-${index}`, T.copyButton, 'setup-btn setup-btn-secondary setup-cmd-copy', (button) => {
          copyWithFeedback(button, entry.command, T.copyButton);
        });
        copy.setAttribute('aria-label', `${row.label}の導入コマンドを${T.copyButton}`);
        line.append(code, copy);
        item.appendChild(line);
        wrap.appendChild(item);
      });
      return wrap;
    }

    function rowItem(row) {
      const li = el('li', 'setup-item');
      const head = el('div', 'setup-item-head');
      head.appendChild(el('span', 'setup-item-label', row.label));
      if (row.isFirstStep) head.appendChild(el('span', 'setup-item-first', T.firstStep));
      li.appendChild(head);
      if (row.stateText) li.appendChild(el('p', 'setup-item-state', row.stateText));
      if (row.showNotOnPathNote) li.appendChild(el('p', 'setup-item-note', T.notOnPathNote));
      if (row.hint) {
        li.appendChild(el('p', 'setup-item-hint', row.hint));
      } else if (row.useSetupHint) {
        // 「セットアップで設定するもの」は固定の案内にし、元の文は「詳しく」に畳む。
        li.appendChild(el('p', 'setup-item-hint', T.setupItemHint));
      }
      if (row.detailHint) {
        const details = el('details', 'setup-item-detail');
        details.appendChild(el('summary', '', T.setupItemDetail));
        details.appendChild(el('p', 'setup-item-hint', row.detailHint));
        li.appendChild(details);
      }
      if (row.commands.length > 0) li.appendChild(commandBlock(row));
      return li;
    }

    function satisfiedBlock(rows) {
      if (rows.length === 0) return null;
      const details = el('details', 'setup-satisfied');
      details.appendChild(el('summary', '', T.satisfiedCount(rows.length)));
      const ul = el('ul', 'setup-satisfied-list');
      rows.forEach((row) => {
        ul.appendChild(el('li', '', row.current ? `${row.label}（${row.current}）` : row.label));
      });
      details.appendChild(ul);
      return details;
    }

    function groupBlock(group) {
      const section = el('section', 'setup-group');
      section.appendChild(el('h3', 'setup-group-title', group.title));
      [['required', true], ['optional', false]].forEach(([kind, isRequired]) => {
        const part = group[kind];
        if (part.pending.length === 0 && part.satisfied.length === 0) return;
        let heading;
        if (isRequired) {
          heading = part.pending.length > 0 ? T.requiredHeading(part.pending.length) : T.requiredHeadingDone;
        } else {
          heading = T.optionalHeading(part.pending.length);
        }
        section.appendChild(el('h4', 'setup-kind-title', heading));
        if (part.pending.length > 0) {
          const ul = el('ul', 'setup-list');
          part.pending.forEach((row) => ul.appendChild(rowItem(row)));
          section.appendChild(ul);
        }
        const satisfied = satisfiedBlock(part.satisfied);
        if (satisfied) section.appendChild(satisfied);
      });
      return section;
    }

    function actionsRow(vm, view, skipRecheck) {
      const row = el('div', 'setup-actions');
      const buttons = el('div', 'setup-actions-buttons');
      if (vm && !vm.allRequiredOk) {
        if (deps.getSetupPaneState() === 'claude') {
          buttons.appendChild(actionButton('show-pane', T.showPaneButton, 'setup-btn setup-btn-primary', () => deps.showSetupPane()));
        } else {
          const needsClaude = !vm.claudeOk;
          // 押せない理由は、ボタンのすぐ下に添える。
          const start = el('div', 'setup-start');
          start.appendChild(actionButton('start', T.startButton, 'setup-btn setup-btn-primary', () => deps.startSetup(), {
            ariaDisabled: needsClaude,
            describedBy: needsClaude ? 'setup-start-note' : '',
          }));
          if (needsClaude) {
            const note = el('p', 'setup-start-note', T.startNeedsClaude);
            note.id = 'setup-start-note';
            start.appendChild(note);
          }
          buttons.appendChild(start);
        }
      }
      // 確認に失敗しているときの「もう一度確認」は、失敗の帯の側に出す。
      if (!skipRecheck) {
        buttons.appendChild(actionButton('recheck', checking ? T.checkingButton : T.recheckButton, 'setup-btn setup-btn-secondary', () => recheck(), {
          ariaDisabled: checking,
        }));
      }
      if (buttons.childNodes.length > 0) row.appendChild(buttons);
      // 失敗の帯が最終確認の時刻を出すので、ここでは重ねて出さない。
      if (!skipRecheck && view && Number.isFinite(view.checkedAt)) {
        const time = S.formatCheckedTime(view.checkedAt);
        if (time) row.appendChild(el('span', 'setup-checked', T.lastChecked(time)));
      }
      return row;
    }

    function unavailableBlock() {
      const block = el('div', 'setup-unavailable');
      block.appendChild(el('p', 'setup-unavailable-title', T.unavailableHeading));
      block.appendChild(el('p', 'setup-unavailable-reason', S.unavailableReasonText(result)));
      const row = el('div', 'setup-actions');
      const buttons = el('div', 'setup-actions-buttons');
      buttons.appendChild(actionButton('recheck', checking ? T.checkingButton : T.recheckButton, 'setup-btn setup-btn-primary', () => recheck(), {
        ariaDisabled: checking,
      }));
      buttons.appendChild(actionButton('copy-detail', T.copyDetail, 'setup-btn setup-btn-secondary', (button) => {
        copyWithFeedback(button, result && typeof result.detail === 'string' ? result.detail : '', T.copyDetail);
      }));
      row.appendChild(buttons);
      // 「最終確認」は、直近に確認できた時刻（無ければ今回の時刻）。
      const timeSource = lastGood || result;
      if (timeSource && Number.isFinite(timeSource.checkedAt)) {
        const time = S.formatCheckedTime(timeSource.checkedAt);
        if (time) row.appendChild(el('span', 'setup-checked', T.lastChecked(time)));
      }
      block.appendChild(row);
      return block;
    }

    // ─── 描画 ───────────────────────────────────────────────────────────
    function renderContent() {
      if (!content) return;
      // 再描画でフォーカス中のボタンが失われないよう、キーを覚えて描画後に戻す。
      const active = document.activeElement;
      const focusKey = active && panel && panel.contains(active) ? (active.dataset && active.dataset.setupKey) : null;

      renderedPaneState = deps.getSetupPaneState();
      const nodes = [];

      const header = el('div', 'setup-header');
      const title = el('h2', 'setup-title', T.heading);
      title.id = 'setup-panel-title';
      // サイドバーの「セットアップ状況を見る」から開いたとき、見出しへフォーカスを移す。
      title.tabIndex = -1;
      header.appendChild(title);
      const foldKey = 'fold';
      header.appendChild(actionButton(foldKey, T.foldButton, 'setup-btn setup-btn-secondary setup-fold', () => fold()));
      nodes.push(header);

      const failed = !!(result && result.ok === false);
      // 失敗したときは、失敗の帯を一覧の上に出し、直近に確認できた一覧を薄く残す。
      const view = result && result.ok === true ? result : lastGood;
      if (failed) {
        const block = unavailableBlock();
        block.classList.toggle('is-checking', checking);
        block.setAttribute('aria-busy', checking ? 'true' : 'false');
        nodes.push(block);
      }
      if (view) {
        const vm = S.buildSetupViewModel(view.status);
        const complete = vm.allRequiredOk === true;
        nodes.push(el('p', 'setup-lead', complete ? T.leadComplete : T.leadRemaining(vm.remaining)));
        if (complete) nodes.push(el('p', 'setup-sub', T.leadCompleteDetail));
        if (!complete) {
          // 信頼の案内は Claude 付きのペインのときだけ。Claude 無しのシェルでは、入れる案内に差し替える。
          if (renderedPaneState === 'claude') nodes.push(el('p', 'setup-guide', T.guideOnSetupPane));
          else if (renderedPaneState === 'plain' && !vm.claudeOk) nodes.push(el('p', 'setup-guide', T.guideOnPlainPane));
        }
        nodes.push(actionsRow(vm, view, failed));
        const body = el('div', 'setup-body');
        body.classList.toggle('is-checking', checking || failed);
        body.setAttribute('aria-busy', checking ? 'true' : 'false');
        vm.groups.forEach((group) => body.appendChild(groupBlock(group)));
        nodes.push(body);
      }

      content.replaceChildren(...nodes);
      renderBand();

      if (focusKey) {
        const next = content.querySelector(`[data-setup-key="${focusKey}"]`);
        if (next) next.focus();
      }
    }

    function renderBand() {
      if (!band || !bandText) return;
      let text = T.bandUnavailable;
      if (result && result.ok === true) {
        text = result.status.summary.allRequiredOk === true
          ? T.bandComplete
          : T.bandIncomplete(S.buildSetupViewModel(result.status).remaining);
      } else if (lastGood && lastGood.status.summary.allRequiredOk === false) {
        text = `${T.bandUnavailable}（${T.bandIncomplete(S.buildSetupViewModel(lastGood.status).remaining)}）`;
      }
      // 「。」の後ろで折り返せるよう、文ごとに inline-block の span に分ける（文節の途中で割れない）。
      const parts = text.match(/[^。]+。?/g) || [text];
      bandText.replaceChildren(...parts.map((part) => {
        const span = el('span', 'setup-band-sentence');
        span.textContent = part;
        return span;
      }));
    }

    function ensureBuilt() {
      if (built) return;
      panel = el('aside', 'setup-panel');
      panel.setAttribute('aria-labelledby', 'setup-panel-title');
      live = el('div', 'setup-sr-only');
      live.setAttribute('role', 'status');
      content = el('div', 'setup-content');
      panel.append(live, content);

      band = el('div', 'setup-band');
      band.setAttribute('role', 'region');
      band.setAttribute('aria-label', T.heading);
      bandText = el('span', 'setup-band-text');
      const open = actionButton('open', T.bandOpen, 'setup-btn setup-btn-secondary setup-band-open', () => reveal());
      band.append(bandText, open);

      mainArea = el('div', 'setup-main-area');
      built = true;
    }

    // 狭いウィンドウで利用者が開いたときは、ターミナルを潰さないようグリッドの上に重ねて出す。
    function isOverlay() {
      const m = mode();
      return (m === 'side' || m === 'main') && root.innerWidth < NARROW_WINDOW_MAX;
    }
    function layoutKey() {
      return mode() + (isOverlay() ? ':overlay' : '');
    }

    // ─── 操作 ───────────────────────────────────────────────────────────
    function fold() {
      if (isComplete(result)) {
        // 完了後の「閉じる」は帯にも残さず消す。
        dismissed = true;
      } else {
        folded = true;
        forceOpenWhenNarrow = false;
      }
      deps.requestLayout();
      onStatusChange();
      if (dismissed) {
        // パネルが消えるので、フォーカスは直前に使っていたターミナルへ戻す。
        deps.restoreFocus();
      } else if (band) {
        const open = band.querySelector('[data-setup-key="open"]');
        if (open) open.focus();
      }
    }

    function reveal() {
      folded = false;
      dismissed = false;
      forceOpenWhenNarrow = true;
      ensureBuilt();
      renderContent();
      deps.requestLayout();
      focusHeading();
    }

    function focusHeading() {
      const title = content ? content.querySelector('#setup-panel-title') : null;
      if (title) title.focus();
    }

    function onStatusChange() {
      deps.onStatusChange();
    }

    async function recheck({ silent = false } = {}) {
      if (checking) return;
      const before = layoutKey();
      checking = true;
      // 初回の確認は、パネルが無いうちは何も出さない（未完了と分かってから組み立てる）。
      if (built && !silent) {
        renderContent();
        announce(T.checkingButton);
      }
      let next;
      try {
        next = await deps.invoke('setup:check');
      } catch (error) {
        next = {
          ok: false,
          reason: 'error',
          detail: `reason: error\nmessage: ${error && error.message ? String(error.message).slice(0, 300) : 'ipc failed'}`,
          checkedAt: Date.now(),
        };
      }
      checking = false;
      applyResult(next, { announceResult: !silent, layoutBefore: before });
    }

    /**
     * 確認の結果を取り込む。未完了・確認失敗のときだけパネルを組み立てる。
     * @param {object|null} next setup:check / setup:initial-pane の result
     */
    function applyResult(next, { announceResult = false, layoutBefore = null } = {}) {
      const before = layoutBefore !== null ? layoutBefore : layoutKey();
      result = next && typeof next === 'object' ? next : null;
      if (result && result.ok === true) {
        lastKnownAllRequiredOk = result.status.summary.allRequiredOk;
        lastGood = result;
      }
      const complete = isComplete(result);
      if (!result) {
        onStatusChange();
        return;
      }
      if (complete && !built) {
        // セットアップ済みなら一覧は組み立てない。
        onStatusChange();
        return;
      }
      ensureBuilt();
      if (!complete) {
        dismissed = false;
      } else if (!dismissed) {
        folded = false;
      }
      renderContent();
      if (announceResult) {
        if (result.ok === false) announce(T.unavailableHeading);
        else if (complete) announce(T.leadComplete);
        else announce(T.leadRemaining(S.buildSetupViewModel(result.status).remaining));
      }
      if (layoutKey() !== before) deps.requestLayout();
      onStatusChange();
    }

    // app.js の render() から呼ばれ、#root に並べる要素の組を返す。
    function layout(gridContent) {
      const current = mode();
      if (current === 'hidden') return [gridContent];
      // ペインの開閉でボタンの文言・案内が変わるため、変化があれば中身を作り直す。
      if (renderedPaneState !== deps.getSetupPaneState()) renderContent();
      panel.dataset.mode = current;
      if (current === 'folded') {
        mainArea.classList.remove('is-overlay');
        mainArea.replaceChildren(band, gridContent);
        return [mainArea];
      }
      const overlay = isOverlay();
      mainArea.classList.toggle('is-overlay', overlay);
      if (overlay) {
        mainArea.replaceChildren(gridContent, panel);
        return [mainArea];
      }
      return [gridContent, panel];
    }

    // 幅が 1000px を境に変わったら、畳む・広げるを切り替えるため再配置を頼む。
    root.addEventListener('resize', () => {
      const narrow = root.innerWidth < NARROW_WINDOW_MAX;
      if (narrow === narrowNow) return;
      narrowNow = narrow;
      if (!narrow) forceOpenWhenNarrow = false;
      if (built && !dismissed) deps.requestLayout();
    });

    // 初回の判定結果・「もう一度確認」の結果は applyResult / recheck から入る。
    return {
      applyResult,
      recheck,
      reveal,
      layout,
      focusHeading,
      getAllRequiredOk,
      isIncomplete,
      isChecking: () => checking,
    };
  }

  root.VKSetupPanel = { create };
})(window);
