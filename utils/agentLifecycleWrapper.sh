#!/bin/sh

# 監視とフォールバックを同じ前景ジョブ内で実行し、利用者のシェル構文に依存させない。
if [ "$#" -ne 6 ]; then
	exit 64
fi

agent_executable=$1
monitor_path=$2
generation=$3
start_token=$4
exit_token=$5
encoded_command=$6

ELECTRON_RUN_AS_NODE=1 "$agent_executable" "$monitor_path" \
	"$generation" "$start_token" "$exit_token" "$encoded_command"
monitor_status=$?

# 正常 exit の後はトークンが消費済みのため、この unknown は状態を上書きしない。
printf '\033]777;vk-terminals;agent-unknown;%s;%s\007' "$generation" "$exit_token"
exit "$monitor_status"
