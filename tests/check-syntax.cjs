const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const source = process.env.TRACKER_SOURCE || path.join(root, 'lopatcong-game-tracker (6).html');
const html = fs.readFileSync(source, 'utf8');
let count = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const result = spawnSync(process.execPath, ['--check', '--input-type=' + (/type=["']module["']/.test(match[1]) ? 'module' : 'commonjs')], { input: match[2], encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error || 'Script syntax check failed');
  count++;
}
if (!count) throw new Error('No inline scripts found');
for (const file of fs.readdirSync(__dirname).filter(file => file.endsWith('.cjs'))) {
  const result = spawnSync(process.execPath, ['--check', path.join(__dirname, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error || 'Test syntax check failed');
}
console.log(`Syntax checked ${count} application scripts and all test scripts.`);
