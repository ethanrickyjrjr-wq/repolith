# repolith coordination demo — two Claude Code sessions, one file.
#
# What it shows: session A edits src/auth.ts (claimed on first touch); session B
# tries the same file and the PreToolUse hook denies it, naming the holder; B runs
# `repolith claim wait`; A commits, the post-commit hook releases the claim, B
# auto-resumes and its edit lands.
#
# Everything on screen is the real `repolith` CLI from npm. `edit <file>` is a
# tiny shell wrapper (panerc.sh) that feeds `repolith edit-hook` the same JSON
# payload Claude Code's Edit tool sends — nothing is mocked.
#
# Render (Linux/WSL, needs vhs + ttyd + ffmpeg + tmux + jq + `npm i -g repolith`):
#   cd assets/demo && vhs demo.tape
Output ../demo.gif
Output ../demo.mp4
Output ../demo.webm
Require tmux
Require repolith
Require jq
Set Shell bash
Set FontSize 17
Set Width 1500
Set Height 520
Set Padding 14
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 30ms
Set PlaybackSpeed 1.2
Set Framerate 30

Hide
Type "bash ./prep.sh && clear && tmux attach -t demo" Enter
Sleep 2.5s
Show

Sleep 800ms
Type "edit app/src/auth.ts" Sleep 300ms Enter
Sleep 1.5s

Ctrl+B
Type "o"
Sleep 500ms
Type "edit app/src/auth.ts" Sleep 300ms Enter
Sleep 7.5s

Type "repolith claim wait --file app/src/auth.ts --session B" Sleep 300ms Enter
Sleep 1s

Ctrl+B
Type "o"
Sleep 500ms
Type 'git -C app commit -am "auth: add refresh-token path"' Sleep 300ms Enter
Sleep 4.5s

Ctrl+B
Type "o"
Sleep 500ms
Type "edit app/src/auth.ts" Sleep 300ms Enter
Sleep 3.5s
