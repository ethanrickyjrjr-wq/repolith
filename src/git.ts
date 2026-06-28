import { execa } from 'execa';

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function gitClone(url: string, dest: string, ref: string): Promise<void> {
  const r = await execa('git', ['clone', '--branch', ref, '--single-branch', url, dest], { reject: false });
  if (r.exitCode !== 0) throw new Error(`git clone failed:\n${r.stderr}`);
}

export async function gitFetch(repoDir: string): Promise<void> {
  await git(repoDir, ['fetch', '--all', '--prune']);
}

export async function gitCheckout(repoDir: string, ref: string): Promise<void> {
  await git(repoDir, ['checkout', ref]);
  await git(repoDir, ['pull', '--ff-only']);
}

export async function gitCurrentCommit(repoDir: string): Promise<string> {
  const { stdout } = await git(repoDir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function gitRun(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return git(repoDir, args);
}
