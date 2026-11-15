#!/usr/bin/env node
// Builds a ready-to-upload Agensi package (https://agensi.io/docs/packaging) from this repo's skill.
//   node scripts/build-agensi.mjs            -> dist-agensi/<skill>-agensi.zip
// Agensi-only listing fields (version, summary, tags, docs_url) are added to the copy in the ZIP,
// so the repo's SKILL.md keeps to the Agent Skills spec. The package is validated against
// Agensi's agent-upload limits (100 files, 5 MB, text only) before zipping.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const skillsDir = path.join(root, 'skills');
const [skill] = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
if (!skill) throw new Error('no skills/<name>/SKILL.md found');

const MAX_FILES = 100, MAX_BYTES = 5 * 1024 * 1024;
const FORBIDDEN_EXT = /\.(exe|dll|so|dylib|bin|app|dmg|msi|deb|rpm|wasm|class|jar|war|png|jpe?g|gif|webp|pdf|zip|gz)$/i;
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agensi-'));
const top = path.join(stage, skill);
fs.cpSync(path.join(skillsDir, skill), top, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
if (!fs.existsSync(path.join(top, 'LICENSE')) && fs.existsSync(path.join(root, 'LICENSE'))) fs.copyFileSync(path.join(root, 'LICENSE'), path.join(top, 'LICENSE'));

// Frontmatter: require name + description, then add Agensi listing fields.
const skillMd = path.join(top, 'SKILL.md');
const text = fs.readFileSync(skillMd, 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!m) throw new Error('SKILL.md has no frontmatter');
for (const key of ['name', 'description']) if (!new RegExp(`^${key}:`, 'm').test(m[1])) throw new Error(`SKILL.md frontmatter is missing ${key}`);
const q = (s) => JSON.stringify(s);
const tags = (pkg.keywords || []).filter((k) => !['ai', 'ai-agent', 'agent-skills'].includes(k)).slice(0, 10);
const extra = [
  `version: ${q(pkg.version)}`,
  `summary: ${q(String(pkg.description).slice(0, 300))}`,
  `tags: [${tags.map(q).join(', ')}]`,
  `docs_url: ${q(String(pkg.homepage || '').replace(/#readme$/, ''))}`,
].filter((l) => !new RegExp(`^${l.split(':')[0]}:`, 'm').test(m[1]));
fs.writeFileSync(skillMd, text.replace(m[0], `---\n${m[1]}\n${extra.join('\n')}\n---\n`));

// Validate against Agensi's agent-upload limits.
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
walk(top);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
const bad = files.filter((f) => FORBIDDEN_EXT.test(f)).map((f) => path.relative(top, f));
const problems = [
  files.length > MAX_FILES && `${files.length} files (max ${MAX_FILES})`,
  bytes > MAX_BYTES && `${bytes} bytes (max ${MAX_BYTES})`,
  bad.length && `non-text or forbidden files: ${bad.join(', ')}`,
].filter(Boolean);
if (problems.length) { console.error(`Agensi package invalid:\n  - ${problems.join('\n  - ')}`); process.exit(1); }

const outDir = path.join(root, 'dist-agensi');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${skill}-agensi.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, skill], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${skill} v${pkg.version}, ${files.length} files, ${(bytes / 1024).toFixed(1)} KB`);
