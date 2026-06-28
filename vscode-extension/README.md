# repolith — Workspace Composer

Make a set of independent git repos feel like one folder. Companion to the [`repolith`](https://www.npmjs.com/package/repolith) CLI.

## Features

- **Sidebar folders** — reads `repolith.toml` and adds each repo as a VS Code workspace folder, so go-to-definition and find-references work per repo.
- **Cross-repo search** — one quick-pick search across *all* repos (via `git grep`) that jumps straight to the matched line.

## Commands

- **Repolith: Sync Repos** — add the manifest's repos as workspace folders
- **Repolith: Search Across Repos** — search every repo and open the result at its line

The extension activates automatically when a `repolith.toml` is present in the opened folder.

## Requirements

The repos must already be cloned — run `repolith sync` with the [CLI](https://www.npmjs.com/package/repolith) first.

## Links

- CLI on npm: https://www.npmjs.com/package/repolith
- Source: https://github.com/ethanrickyjrjr-wq/repolith

MIT © Ricky Cooper
