import * as vscode from 'vscode';
import { join } from 'node:path';
import { addWorkspaceFolders } from './workspace';
import { crossRepoSearch } from './search';

export function activate(context: vscode.ExtensionContext): void {
  console.log('repolith extension active');

  const getManifestPath = (): string | undefined => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return join(folders[0].uri.fsPath, 'repolith.toml');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repolith.sync', async () => {
      const manifest = getManifestPath();
      if (!manifest) {
        vscode.window.showErrorMessage('repolith: open a folder containing repolith.toml first');
        return;
      }
      await addWorkspaceFolders(manifest);
    }),

    vscode.commands.registerCommand('repolith.search', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) {
        vscode.window.showErrorMessage('repolith: no workspace folders open');
        return;
      }
      await crossRepoSearch(folders);
    }),
  );

  // Auto-add repo folders if a manifest is present on activation.
  const manifest = getManifestPath();
  if (manifest) {
    addWorkspaceFolders(manifest).catch((e) => console.error(e));
  }
}

export function deactivate(): void {}
