import * as vscode from 'vscode';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface GrepResult extends vscode.QuickPickItem {
  label: string;
  detail: string;
  file: string;
  line: number;
  repoName: string;
  repoPath: string;
}

function runGrepInRepo(repoPath: string, repoName: string, pattern: string): GrepResult[] {
  try {
    const raw = execSync(
      `git grep -n --color=never ${JSON.stringify(pattern)}`,
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      const [filePart, linePart, ...rest] = line.split(':');
      return {
        label: `[${repoName}] ${filePart}:${linePart}`,
        detail: rest.join(':').trim(),
        file: join(repoPath, filePart ?? ''),
        line: Number(linePart ?? 1),
        repoName,
        repoPath,
      };
    });
  } catch {
    // git grep exits non-zero when there are no matches — treat as empty.
    return [];
  }
}

export async function crossRepoSearch(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
  const pattern = await vscode.window.showInputBox({ prompt: 'Search pattern (git grep)' });
  if (!pattern) return;

  const allResults: GrepResult[] = [];
  for (const folder of workspaceFolders) {
    if (!existsSync(join(folder.uri.fsPath, '.git'))) continue;
    allResults.push(...runGrepInRepo(folder.uri.fsPath, folder.name, pattern));
  }

  if (!allResults.length) {
    vscode.window.showInformationMessage(`repolith: no matches for "${pattern}"`);
    return;
  }

  const picked = await vscode.window.showQuickPick(allResults, {
    matchOnDetail: true,
    placeHolder: `${allResults.length} matches — select to open`,
  });

  if (!picked) return;

  const doc = await vscode.workspace.openTextDocument(picked.file);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(picked.line - 1, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
