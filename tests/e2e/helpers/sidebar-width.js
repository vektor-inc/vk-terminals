const { expect } = require('@playwright/test');

// サイドバーの幅（--vktm-sidebar-width）を変え、実際の幅がその値になるまで待つ。
// .sidebar の幅は flex-basis のトランジション（0.18s）で追従するため、値を書いた直後に
// 測ると変更前の幅のまま判定してしまう（PR #619 の麗美の指摘）。
// 戻り値は元の指定（値と priority）に戻す関数。
async function setSidebarWidth(sidebar, widthPx) {
  const original = await sidebar.evaluate((element, value) => {
    const previous = {
      value: element.style.getPropertyValue('--vktm-sidebar-width'),
      priority: element.style.getPropertyPriority('--vktm-sidebar-width'),
    };
    element.style.setProperty('--vktm-sidebar-width', `${value}px`);
    return previous;
  }, widthPx);
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(widthPx);
  return async () => {
    await sidebar.evaluate((element, previous) => {
      if (previous.value) element.style.setProperty('--vktm-sidebar-width', previous.value, previous.priority);
      else element.style.removeProperty('--vktm-sidebar-width');
    }, original);
  };
}

module.exports = { setSidebarWidth };
