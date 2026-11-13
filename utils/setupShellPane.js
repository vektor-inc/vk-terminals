'use strict';

function resolvePaneNoClaude({ guideLaunch, setupShell, noClaude, globalPlainMode }) {
  if (guideLaunch) return false;
  if (setupShell) return true;
  return typeof noClaude === 'boolean' ? noClaude : globalPlainMode;
}

module.exports = { resolvePaneNoClaude };
