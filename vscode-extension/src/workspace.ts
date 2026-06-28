import * as vscode from 'vscode';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

interface RepoEntry { name: string; path: string; url: string; ref: string; }

// Minimal [[repos]] reader — avoids bundling a TOML library into the extension.
function parseTomlRepos(tomlText: string): RepoEntry[] {
  const repos: RepoEntry[] = [];
  const repoBlocks = tomlText.split('[[repos]]').slice(1);
  for (const block of repoBlocks) {
    const get = (key: string): string => {
      const m = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
      return m?.[1] ?? '';
    };
    repos.push({ name: get('name'), url: get('url'), path: get('path'), ref: get('ref') });
  }
  return repos.filter((r) => r.name && r.path);
}

export async function addWorkspaceFolders(manifestPath: string): Promise<void> {
  if (!existsSync(manifestPath)) {
    vscode.window.showErrorMessage(`repolith.toml not found: ${manifestPath}`);
    return;
  }
  const manifestDir = resolve(manifestPath, '..');
  const toml = readFileSync(manifestPath, 'utf8');
  const repos = parseTomlRepos(toml);

  const existing = new Set(
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  );

  const toAdd: { uri: vscode.Uri; name: string }[] = [];
  for (const repo of repos) {
    const absPath = join(manifestDir, repo.path);
    if (!existsSync(absPath)) {
      vscode.window.showWarningMessage(`repolith: ${repo.name} not cloned yet — run repolith sync`);
      continue;
    }
    if (!existing.has(absPath)) {
      toAdd.push({ uri: vscode.Uri.file(absPath), name: repo.name });
    }
  }

  if (toAdd.length > 0) {
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(start, null, ...toAdd);
    vscode.window.showInformationMessage(`repolith: added ${toAdd.length} repo folder(s) to workspace`);
  }
}
