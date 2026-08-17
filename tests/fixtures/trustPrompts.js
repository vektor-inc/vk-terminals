'use strict';

// 2026-08-17 に実機 PTY から採取し、main.js と同じ stripAnsiForPattern を通した
// 信頼確認画面の該当部分。ターミナルのカーソル描画では単語間の空白がデータに含まれない
// 場合があるため、その状態も含めてフィクスチャとして固定する（issue #373）。
const CLAUDE_CURRENT_TRUST_PROMPT = [
  'Accessingworkspace:',
  'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
  'ClaudeCode\'llbeabletoread,edit,andexecutefileshere.',
  '❯1.Yes,Itrustthisfolder',
  '2.No,exit',
  'Entertoconfirm·Esctocancel',
].join('\r\n');

const CODEX_CURRENT_TRUST_PROMPT = [
  'Doyoutrustthecontentsofthisdirectory?',
  'Workingwithuntrustedcontentscomeswithhigherriskofpromptinjection.',
  '› 1. Yes, continue',
  '2.No,quit',
  'Press enter to continue',
].join('');

// Claude Code 旧 UI。過去に自動承認していた2種類のキー文言を残し、現行 UI 対応で
// 旧バージョン利用者を待機状態へ戻さないことを確認する。
const CLAUDE_LEGACY_TRUST_PROMPT = [
  'Do you trust the files in this folder?',
  'Yes, I trust this folder',
  'Enter to confirm',
].join('\r\n');

module.exports = {
  CLAUDE_CURRENT_TRUST_PROMPT,
  CODEX_CURRENT_TRUST_PROMPT,
  CLAUDE_LEGACY_TRUST_PROMPT,
};
