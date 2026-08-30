# Demo assets

`../demo.gif` / `.mp4` / `.webm` — the collision → deny → auto-resume demo used in the
README and on the landing page. ~23 s.

## What's on screen

Two panes, one workspace, one file (`app/src/auth.ts`):

1. **Session A** edits it → the `PreToolUse` edit-hook claims it on first touch.
2. **Session B** edits the same file → after a ~6 s inline auto-wait the hook returns a
   `deny`, naming the holder and the recovery commands.
3. B runs `repolith claim wait --file app/src/auth.ts --session B` and blocks.
4. A commits → the `post-commit` hook releases A's claim → B's wait returns
   `Acquired … it's yours now`.
5. B's edit lands.

Nothing is mocked. `repolith` is the published npm package; `edit <file>` is a 10-line
shell function in [`panerc.sh`](panerc.sh) that pipes the same JSON payload Claude Code's
Edit tool sends into `repolith edit-hook` and prints the hook's
`permissionDecisionReason` on a deny. Session ids are `A`/`B` instead of Claude's UUIDs
purely for legibility.

## Files

| File | Role |
|---|---|
| `demo.tape` | [VHS](https://github.com/charmbracelet/vhs) script — keystrokes, timing, output formats |
| `prep.sh` | builds a throwaway workspace at `$HOME/demo` (manifest, one git repo, `repolith hooks install --post-commit`) and a 2-pane tmux session |
| `panerc.sh` | per-pane shell rc: prompt colour + the `edit` wrapper |
| `demo.tmux.conf` | pane titles, no status bar |

## Re-render

Linux or WSL. Needs `vhs`, `ttyd`, `ffmpeg`, `tmux`, `jq`, and `npm i -g repolith`.
VHS drives a headless Chromium, which refuses to run as root — render as a normal user.

```bash
cd assets/demo
vhs demo.tape        # writes ../demo.gif, ../demo.mp4, ../demo.webm
```

## Recording the real thing (two live Claude Code sessions)

The tape shows the mechanism; a screen recording of two real sessions shows the product.
Runbook:

1. Stage a workspace: `repolith init` + a small git repo + `repolith hooks install --post-commit`.
2. Open two terminals in it and start `claude` in each. Disable any personal hooks that
   prompt on `Edit`/`Bash` first — they will wreck the take.
3. Prompt A: *"Add a refresh-token path to `src/auth.ts`. Don't commit yet."*
   Prompt B (after A's edit lands): *"Add rate limiting to `src/auth.ts`."* → B is denied,
   names A, and offers `claim wait`. Tell B: *"Wait for it, then do the edit."*
4. Tell A: *"Commit."* → B resumes and edits.
5. Trim, speed up, and emit both formats:

```bash
ffmpeg -i take.mp4 -ss 00:00:04 -to 00:00:34 -filter:v "setpts=PTS/1.5" -an trimmed.mp4
ffmpeg -i trimmed.mp4 -vf "fps=15,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" demo-live.gif
ffmpeg -i trimmed.mp4 -c:v libvpx-vp9 -b:v 0 -crf 32 -an demo-live.webm
```
