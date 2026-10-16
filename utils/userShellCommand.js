'use strict';

const path = require('node:path');

/** 現在の対話シェル内で元コマンドを評価し、監視サイドカーと同じ前景ジョブで待つ。 */
function buildTrackedShellCommand(userShell, monitorCommand, readyPath) {
  const name = path.basename(userShell);
  const quotedReadyPath = `'${String(readyPath).replace(/'/g, `'\\''`)}'`;
  if (name === 'fish') {
    return `begin; set -l vk_ready ${quotedReadyPath}; set -l vk_started "$vk_ready.started"; ${monitorCommand} &; set -l vk_monitor_pid $last_pid; while not test -e $vk_ready; and kill -0 $vk_monitor_pid 2>/dev/null; sleep 0.01; end; set -l vk_command (cat $vk_ready 2>/dev/null); rm -f $vk_ready; kill -s USR2 $vk_monitor_pid 2>/dev/null; while not test -e $vk_started; and kill -0 $vk_monitor_pid 2>/dev/null; sleep 0.01; end; rm -f $vk_started; eval $vk_command; set -l vk_status $status; kill -s USR1 $vk_monitor_pid 2>/dev/null; wait $vk_monitor_pid 2>/dev/null; exit $vk_status; end`;
  }
  return `( vk_ready=${quotedReadyPath}; vk_started="$vk_ready.started"; ${monitorCommand} & vk_monitor_pid=$!; while [ ! -e "$vk_ready" ] && kill -0 "$vk_monitor_pid" 2>/dev/null; do sleep 0.01; done; vk_command=$(cat "$vk_ready" 2>/dev/null); rm -f "$vk_ready"; kill -USR2 "$vk_monitor_pid" 2>/dev/null; while [ ! -e "$vk_started" ] && kill -0 "$vk_monitor_pid" 2>/dev/null; do sleep 0.01; done; rm -f "$vk_started"; eval "$vk_command"; vk_status=$?; kill -USR1 "$vk_monitor_pid" 2>/dev/null; wait "$vk_monitor_pid" 2>/dev/null; exit "$vk_status" )`;
}

module.exports = { buildTrackedShellCommand };
