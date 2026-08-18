'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 設定ディスクリプタは環境変数 VK_TERMINALS_SETTINGS で外部から差し替えられるため、
// 信頼できない入力として扱う。キーを「.」で区切って階層をたどる処理に
// __proto__ や constructor.prototype が入ると Object.prototype へ書き込まれ、
// fs と pty.spawn を持つメインプロセス全体のオブジェクトが汚染される。
// そのため検証時の isValidSettingsDescriptor / validateSettingsSchema と、読み書き時の
// deepGet / deepSet の両方で同じ判定を行う多重防御にする。
const UNSAFE_KEY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function hasUnsafeKeySegment(dottedKey) {
  return dottedKey.split('.').some((segment) => UNSAFE_KEY_SEGMENTS.has(segment));
}

function resolveTargetPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  if (rawPath.trim() === '') return null;
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  return path.resolve(rawPath);
}

function descriptorFieldEntries(descriptor) {
  const entries = [];
  const groups = descriptor && Array.isArray(descriptor.groups) ? descriptor.groups : [];
  groups.forEach((group, groupIndex) => {
    if (!group || !Array.isArray(group.fields)) return;
    group.fields.forEach((field) => {
      if (!field || typeof field.key !== 'string') return;
      entries.push({ group, groupIndex, field });
    });
  });
  return entries;
}

function descriptorFields(descriptor) {
  return descriptorFieldEntries(descriptor).map(({ field }) => field);
}

function resolveFieldTargetPath(descriptor, group, field) {
  const rawPath = (field && typeof field.targetPath === 'string')
    ? field.targetPath
    : (group && typeof group.targetPath === 'string')
      ? group.targetPath
      : descriptor && typeof descriptor.targetPath === 'string'
        ? descriptor.targetPath
        : null;
  return resolveTargetPath(rawPath);
}

function descriptorFieldTargetEntries(descriptor) {
  return descriptorFieldEntries(descriptor).map((entry) => ({
    ...entry,
    targetPath: resolveFieldTargetPath(descriptor, entry.group, entry.field),
  }));
}

function isValidSettingsDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(descriptor.groups)) {
    return false;
  }
  const seenKeys = new Set();
  for (const { field, targetPath } of descriptorFieldTargetEntries(descriptor)) {
    if (typeof targetPath !== 'string' || targetPath === '') return false;
    if (hasUnsafeKeySegment(field.key)) return false;
    if (seenKeys.has(field.key)) return false;
    seenKeys.add(field.key);
  }
  return true;
}

function deepGet(obj, dottedKey) {
  if (hasUnsafeKeySegment(dottedKey)) return undefined;
  return dottedKey.split('.').reduce(
    (acc, key) => (acc == null ? undefined : acc[key]),
    obj,
  );
}

function deepSet(obj, dottedKey, value) {
  if (hasUnsafeKeySegment(dottedKey)) {
    // 黙って保存対象から落とすと原因の追跡が困難になるため、saveSettingsToTargets が
    // 保存失敗として捕捉し、呼び出し元からユーザーへ伝えられるよう例外にする。
    throw new Error(`Unsafe settings key: ${dottedKey}`);
  }
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cur[key] == null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

function readJsonObject(targetPath) {
  let current = {};
  if (fs.existsSync(targetPath)) {
    current = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current : {};
}

function describeSettingsValues(descriptor, options = {}) {
  const onReadError = typeof options.onReadError === 'function' ? options.onReadError : null;
  const cache = new Map();
  const values = {};

  for (const { field, targetPath } of descriptorFieldTargetEntries(descriptor)) {
    // 読み書き時の扱いと揃えて危険なキーを飛ばし、画面へ渡す一覧オブジェクト自身の
    // プロトタイプが差し替えられることを防ぐ。
    if (hasUnsafeKeySegment(field.key)) continue;
    let current = cache.get(targetPath);
    if (!cache.has(targetPath)) {
      try {
        current = readJsonObject(targetPath);
      } catch (error) {
        if (onReadError) onReadError(targetPath, error);
        current = {};
      }
      cache.set(targetPath, current);
    }
    const value = deepGet(current, field.key);
    values[field.key] = value === undefined
      ? (field.default !== undefined ? field.default : null)
      : value;
  }

  return values;
}

// 設定コンテンツテーブルの savedValue セル（issue #380）用。「設定ファイルに実際に
// 保存されている値」を、複数キーまとめて 1 回の呼び出しで返す。
//
// セキュリティ上の必須要件: 設定ディスクリプタは環境変数 VK_TERMINALS_SETTINGS で
// 外部から差し替えられる信頼できない入力のため、読めるキーはそのディスクリプタ自身が
// groups[].fields[].key として宣言しているキーだけに限定する（許可制）。任意のキー・
// 任意のパスを読み出せる汎用の問い合わせ窓口にしないこと。呼び出し元（main.js）は
// renderer から届いた key をそのまま渡してよく、許可判定はこの関数の中で完結する。
// あわせて type: 'password' のフィールドは拒否する（マスク対象の秘密情報を表へ
// 平文で漏らさないための必須要件・安藤のセキュリティレビュー指摘・issue #380）。
//
// main.js:1 セルごとに loadSettingsDescriptor() + readJsonObject() を直列実行すると
// 行数の多い表でメインプロセスが固まる（同レビュー指摘）。ここでは
// describeSettingsValues と同じ方針で targetPath ごとに読み込みをキャッシュし、
// 同じファイルへの重複読み込みを避ける。
//
// 戻り値はキーをそのままプロパティ名にした素のオブジェクトを返す想定だが、
// __proto__ 等のキーで自身のプロトタイプを書き換えられないよう、プロトタイプを
// 持たないオブジェクト（Object.create(null)）に積む
// （dedupeSettingsFieldsByKeyQuiet が seenKeys を Set にしているのと同じ配慮）。
function resolveSavedFieldValues(descriptor, keys) {
  const keyList = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string');
  // new Map(...) へ重複キーの配列をそのまま渡すと後勝ちになる。renderer 側の
  // dedupeSettingsFieldsByKeyQuiet は描画順で最初の 1 件を残す先勝ちのため、判定基準が
  // 割れないよう main 側もここで先勝ちに揃える（安藤のレビュー指摘。重複 key を持つ
  // ディスクリプタ自体は isValidSettingsDescriptor が丸ごと拒否するため到達経路は無いが、
  // 片方だけを見て直すと将来また食い違う）。
  const entryByKey = new Map();
  for (const entry of descriptorFieldTargetEntries(descriptor)) {
    if (!entryByKey.has(entry.field.key)) entryByKey.set(entry.field.key, entry);
  }
  const jsonCache = new Map(); // targetPath -> パース済みオブジェクト（読み込みは 1 回だけ）
  const results = Object.create(null);

  for (const key of keyList) {
    if (!key.trim()) {
      results[key] = { ok: false, error: '対象の設定キーが指定されていません' };
      continue;
    }
    if (hasUnsafeKeySegment(key)) {
      results[key] = { ok: false, error: '許可されていない設定キーです' };
      continue;
    }
    // ディスクリプタが宣言しているフィールドの中に無いキーは、たとえ実在の設定
    // ファイルに同名のキーがあっても拒否する（宣言されていないキー・パスを
    // 読み出せる窓口を作らない）。
    const entry = entryByKey.get(key);
    if (!entry) {
      results[key] = { ok: false, error: '許可されていない設定キーです' };
      continue;
    }
    if (entry.field.type === 'password') {
      results[key] = { ok: false, error: 'マスク対象の設定キーです' };
      continue;
    }
    if (typeof entry.targetPath !== 'string' || entry.targetPath === '') {
      results[key] = { ok: false, error: '保存先が未設定です' };
      continue;
    }
    try {
      if (!jsonCache.has(entry.targetPath)) {
        jsonCache.set(entry.targetPath, readJsonObject(entry.targetPath));
      }
      const current = jsonCache.get(entry.targetPath);
      const value = deepGet(current, key);
      results[key] = { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      results[key] = { ok: false, error: `読み込みに失敗しました: ${error.message}` };
    }
  }

  return results;
}

function coerceFieldValue(field, raw) {
  const label = field.label || field.key;
  switch (field.type) {
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
      const numberValue = Number(raw);
      if (!Number.isFinite(numberValue)) return { ok: false, error: `${label}: 数値として不正です` };
      return { ok: true, value: numberValue };
    }
    case 'boolean':
      return {
        ok: true,
        value: (raw === null || raw === undefined)
          ? (field.default !== undefined ? !!field.default : false)
          : !!raw,
      };
    case 'json': {
      if (raw === '' || raw === null || raw === undefined) {
        return { ok: true, value: field.emptyToNull ? null : [] };
      }
      try {
        return { ok: true, value: typeof raw === 'string' ? JSON.parse(raw) : raw };
      } catch (error) {
        return { ok: false, error: `${label}: JSON として不正です（${error.message}）` };
      }
    }
    case 'lines': {
      if (raw === '' || raw === null || raw === undefined) {
        return { ok: true, value: field.emptyToNull ? null : [] };
      }
      const lines = Array.isArray(raw) ? raw : String(raw).split('\n');
      const normalized = lines.map((line) => String(line).trim()).filter((line) => line !== '');
      if (normalized.length === 0 && field.emptyToNull) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: normalized,
      };
    }
    case 'select': {
      const allowed = (Array.isArray(field.options) ? field.options : []).map((option) => String(option.value ?? ''));
      const stringValue = raw == null ? '' : String(raw);
      if (allowed.length && !allowed.includes(stringValue)) {
        return { ok: false, error: `${label}: 不正な値です（${allowed.join(' / ')} のいずれか）` };
      }
      return { ok: true, value: (stringValue === '' && field.emptyToNull) ? null : stringValue };
    }
    default: {
      const stringValue = raw == null ? '' : String(raw);
      return { ok: true, value: (stringValue === '' && field.emptyToNull) ? null : stringValue };
    }
  }
}

function groupFieldsByTargetPath(descriptor, incoming) {
  const values = incoming && typeof incoming === 'object' ? incoming : {};
  const grouped = new Map();

  for (const entry of descriptorFieldTargetEntries(descriptor)) {
    const { field, targetPath } = entry;
    // in 演算子はプロトタイプチェーンまで参照するため使わない。toString や valueOf などを
    // 画面側が送っていなくても送信済みと誤判定し、意図しない値を保存することを防ぐ。
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    if (typeof targetPath !== 'string' || targetPath === '') {
      return { ok: false, error: `${field.label || field.key}: 保存先が未設定です` };
    }
    const coerced = coerceFieldValue(field, values[field.key]);
    if (!coerced.ok) return coerced;
    if (!grouped.has(targetPath)) grouped.set(targetPath, []);
    grouped.get(targetPath).push({ field, value: coerced.value });
  }

  return { ok: true, grouped };
}

function atomicWriteJsonFile(targetPath, config) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let mode = 0o600;
  try {
    mode = fs.statSync(targetPath).mode & 0o7777;
  } catch (_error) {
    mode = 0o600;
  }
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', { mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_cleanupError) {
      // 元の保存エラーを優先する。
    }
    throw error;
  }
}

function saveSettingsToTargets(descriptor, incoming) {
  const groupedResult = groupFieldsByTargetPath(descriptor, incoming);
  if (!groupedResult.ok) return { ok: false, error: groupedResult.error };

  const writtenPaths = [];
  const failedPaths = [];
  let firstError = null;

  for (const [targetPath, updates] of groupedResult.grouped.entries()) {
    let config = {};
    try {
      config = readJsonObject(targetPath);
      for (const { field, value } of updates) {
        deepSet(config, field.key, value);
      }
      atomicWriteJsonFile(targetPath, config);
      writtenPaths.push(targetPath);
    } catch (error) {
      failedPaths.push(targetPath);
      if (!firstError) firstError = error;
    }
  }

  const targetPath = resolveTargetPath(descriptor && descriptor.targetPath) || writtenPaths[0] || '';
  if (failedPaths.length > 0) {
    return {
      ok: false,
      error: `保存に失敗: ${firstError ? firstError.message : '不明なエラー'}`,
      targetPath,
      writtenPaths,
      failedPaths,
    };
  }

  return { ok: true, targetPath, writtenPaths };
}

function describeTargetPaths(descriptor) {
  const groupTargets = [];
  const allTargets = new Set();
  const entries = descriptorFieldTargetEntries(descriptor);

  for (let groupIndex = 0; groupIndex < descriptor.groups.length; groupIndex++) {
    const paths = [...new Set(entries
      .filter((entry) => entry.groupIndex === groupIndex)
      .map((entry) => entry.targetPath)
      .filter((targetPath) => typeof targetPath === 'string' && targetPath !== ''))];
    paths.forEach((targetPath) => allTargets.add(targetPath));
    groupTargets[groupIndex] = paths;
  }

  return {
    targetPath: resolveTargetPath(descriptor.targetPath) || '',
    groupTargets,
    allTargets: [...allTargets],
    hasMultipleTargets: allTargets.size > 1,
  };
}

module.exports = {
  atomicWriteJsonFile,
  coerceFieldValue,
  deepGet,
  deepSet,
  describeSettingsValues,
  describeTargetPaths,
  descriptorFields,
  descriptorFieldEntries,
  descriptorFieldTargetEntries,
  groupFieldsByTargetPath,
  hasUnsafeKeySegment,
  isValidSettingsDescriptor,
  readJsonObject,
  resolveFieldTargetPath,
  resolveSavedFieldValues,
  resolveTargetPath,
  saveSettingsToTargets,
};
