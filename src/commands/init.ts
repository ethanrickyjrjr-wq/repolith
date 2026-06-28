import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as procStdin, stdout as procStdout } from 'node:process';

export type Asker = (question: string) => Promise<string>;

export async function initCommand(dir: string, force: boolean, ask?: Asker): Promise<void> {
  const target = join(dir, 'repolith.toml');
  if (existsSync(target) && !force) {
    throw new Error(`repolith.toml already exists at ${target} — use --force to overwrite`);
  }

  let rl: ReturnType<typeof createInterface> | undefined;
  const prompt: Asker = ask ?? ((q) => {
    rl ??= createInterface({ input: procStdin, output: procStdout });
    return rl.question(q);
  });

  try {
    const name = (await prompt('Workspace name: ')).trim() || 'my-workspace';
    const blocks: string[] = [`[workspace]\nname = "${name}"\n`];

    console.log('\nAdd repos (blank repo name to finish):');
    for (;;) {
      const repoName = (await prompt('  repo name: ')).trim();
      if (!repoName) break;
      const url = (await prompt('  url: ')).trim();
      const path = (await prompt(`  path [repos/${repoName}]: `)).trim() || `repos/${repoName}`;
      const ref = (await prompt('  ref [main]: ')).trim() || 'main';
      blocks.push(`[[repos]]\nname = "${repoName}"\nurl = "${url}"\npath = "${path}"\nref = "${ref}"\n`);
    }

    await writeFile(target, blocks.join('\n') + '\n', 'utf8');
    console.log(`\nWrote ${target}`);
  } finally {
    rl?.close();
  }
}
