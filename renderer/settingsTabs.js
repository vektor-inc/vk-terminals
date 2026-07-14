'use strict';

function normalizeSettingsTabs(desc) {
  const rawTabs = desc && Array.isArray(desc.tabs) ? desc.tabs : [];
  return rawTabs
    .filter((tab) => tab && typeof tab.id === 'string' && tab.id.trim())
    .map((tab, index) => ({
      id: tab.id,
      label: (typeof tab.label === 'string' && tab.label.trim()) ? tab.label : tab.id,
      index,
    }));
}

function groupSettingsGroupsByTab(groups, tabs) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  if (!Array.isArray(tabs) || tabs.length === 0) return [];

  const tabIds = new Set(tabs.map((tab) => tab.id));
  const firstTabId = tabs[0].id;
  const grouped = tabs.map((tab) => ({ tab, groups: [] }));
  const groupByTabId = new Map(grouped.map((entry) => [entry.tab.id, entry]));

  for (const group of safeGroups) {
    const groupTab = group && typeof group.tab === 'string' && tabIds.has(group.tab)
      ? group.tab
      : firstTabId;
    groupByTabId.get(groupTab).groups.push(group);
  }

  return grouped;
}

function deriveSettingsTargetPathsForGroups(groups) {
  const paths = [];
  const seen = new Set();

  for (const group of Array.isArray(groups) ? groups : []) {
    const targetPaths = group && Array.isArray(group.targetPaths) ? group.targetPaths : [];
    for (const targetPath of targetPaths) {
      if (typeof targetPath !== 'string' || !targetPath || seen.has(targetPath)) continue;
      seen.add(targetPath);
      paths.push(targetPath);
    }
  }

  return paths;
}

module.exports = {
  deriveSettingsTargetPathsForGroups,
  groupSettingsGroupsByTab,
  normalizeSettingsTabs,
};
