# Per-pane shell for the demo. `edit <file>` is what Claude Code's Edit tool triggers:
# the PreToolUse hook (`repolith edit-hook`) gets the Claude-shaped payload on stdin.
DEMO="$HOME/demo"
cd "$DEMO"
export SESSION
if [ "$SESSION" = "A" ]; then C='36'; else C='35'; fi
PS1="\[\e[1;${C}m\]session $SESSION ❯\[\e[0m\] "
edit() {
  local f="$1" abs="$DEMO/$1" payload out
  payload=$(jq -nc --arg s "$SESSION" --arg f "$abs" --arg cwd "$DEMO" \
    '{session_id:$s,cwd:$cwd,tool_name:"Edit",tool_input:{file_path:$f}}')
  out=$(printf '%s' "$payload" | repolith edit-hook)
  if [ -z "$out" ]; then
    printf '// %s: refresh-token path\n' "$SESSION" >> "$abs"
    printf '\e[32m✔ Edit applied\e[0m — %s now claimed by session %s\n' "$f" "$SESSION"
  else
    printf '\e[1;31m✖ Edit denied\e[0m\n'
    printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' | fold -s -w "$(tput cols)"
  fi
}
clear
