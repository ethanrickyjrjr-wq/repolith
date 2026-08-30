// Read the Claude Code hook payload JSON from stdin. Shared by the plan and
// edit hooks. Returns '' when there is no piped input (e.g. a TTY), so callers
// can exit 0 silently and never break the user's flow.
export function readHookStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => res(''));
  });
}
