'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
    if (!(field.key in values)) continue;
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
  isValidSettingsDescriptor,
  readJsonObject,
  resolveFieldTargetPath,
  resolveTargetPath,
  saveSettingsToTargets,
};
