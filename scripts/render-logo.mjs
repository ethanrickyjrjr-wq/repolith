import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const svg = readFileSync('assets/logo.svg', 'utf8');

function render(size, out) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(out, r.render().asPng());
  console.log(`wrote ${out} (${size}px)`);
}

mkdirSync('assets', { recursive: true });
render(512, 'assets/logo-512.png'); // preview
render(128, 'vscode-extension/icon.png'); // VS Code marketplace icon
