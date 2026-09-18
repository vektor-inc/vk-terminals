'use strict';

// モバイルページ本体を構成する静的ファイルの一覧（issue #396 安藤のセキュリティレビュー
// 指摘・LOW-9）。
//
// 以前は「main.js が配信するパスの表（fileMap 等）」と「utils/apiAuth.js が認証を免除する
// パスの集合（AUTH_EXEMPT_GET_PATHS）」が別々の2つのリストとして存在し、新しい静的ファイルを
// 追加するときに片方だけ書き足す事故が構造的に起こりえた。この一覧を唯一の正とし、
// main.js（配信）と utils/apiAuth.js（認証免除）の両方がここを参照する。
//
// GET / と /index.html は mobile.html 本体の配信（CSP ヘッダー付与・?token= 初回登録処理）が
// main.js 側に別途あるため、この一覧（STATIC_FILES）には含めない。ただし認証免除の対象では
// あるため、SPECIAL_EXEMPT_PATHS として別に持つ。

const path = require('path');

// relPath は main.js の __dirname（vk-terminals リポジトリ直下）からの相対パスの配列。
// main.js 側で path.join(__dirname, ...relPath) して実ファイルへ解決する。
const STATIC_FILES = {
  '/mobile.css': {
    relPath: ['renderer', 'mobile.css'],
    contentType: 'text/css; charset=utf-8',
  },
  '/shared.css': {
    relPath: ['renderer', 'shared.css'],
    contentType: 'text/css; charset=utf-8',
  },
  '/widgetContract.js': {
    relPath: ['utils', 'widgetContract.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/widgetView.js': {
    relPath: ['renderer', 'widgetView.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/terminalDisplay.js': {
    relPath: ['renderer', 'terminalDisplay.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/urlSafety.js': {
    relPath: ['renderer', 'urlSafety.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/prBadge.js': {
    relPath: ['renderer', 'prBadge.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/statusPresentation.js': {
    relPath: ['renderer', 'statusPresentation.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/mobilePreviewText.js': {
    relPath: ['renderer', 'mobilePreviewText.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/mobile.js': {
    relPath: ['renderer', 'mobile.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  // issue #396 で追加した通知関連の静的ファイル。
  '/notificationUiState.js': {
    relPath: ['utils', 'notificationUiState.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/sw.js': {
    relPath: ['renderer', 'sw.js'],
    contentType: 'text/javascript; charset=utf-8',
  },
  '/manifest.webmanifest': {
    relPath: ['renderer', 'manifest.webmanifest'],
    contentType: 'application/manifest+json; charset=utf-8',
  },
  '/icons/icon-192.png': {
    relPath: ['renderer', 'icons', 'icon-192.png'],
    contentType: 'image/png',
    // アイコンは固定の内容で、モバイル端末側で長期キャッシュされても問題無い
    // （他の静的ファイルの既定 no-store とは異なり明示的に上書きする）。
    cacheControl: 'public, max-age=604800',
  },
  '/icons/icon-512.png': {
    relPath: ['renderer', 'icons', 'icon-512.png'],
    contentType: 'image/png',
    cacheControl: 'public, max-age=604800',
  },
};

// GET / と /index.html は STATIC_FILES に含めないが、認証不要な点は共通のため列挙する。
const SPECIAL_EXEMPT_PATHS = ['/', '/index.html'];

/**
 * @param {string} appRootDir main.js の __dirname
 * @param {{relPath: string[]}} entry STATIC_FILES の値
 * @returns {string} 絶対パス
 */
function resolveStaticFilePath(appRootDir, entry) {
  return path.join(appRootDir, ...entry.relPath);
}

/**
 * 認証を免除してよい GET パスの一覧（/api/health を除く。それは utils/apiAuth.js 側で
 * 個別に管理する）。
 * @returns {string[]}
 */
function allExemptStaticPaths() {
  return [...SPECIAL_EXEMPT_PATHS, ...Object.keys(STATIC_FILES)];
}

module.exports = {
  STATIC_FILES,
  SPECIAL_EXEMPT_PATHS,
  resolveStaticFilePath,
  allExemptStaticPaths,
};
