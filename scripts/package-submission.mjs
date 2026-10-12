import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../runtime/hosts/claude/tools.mjs';
import { createZip, inspectZip } from './submission-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = 'plugins/android-emulator/';
const manifestFile = '.claude-plugin/plugin.json';
export const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = (files, file) => JSON.parse(files.get(file).bytes.toString('utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function clean() { assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '', 'Commit source changes before packaging; the release ZIP must have a clean source commit.'); }
function run(...args) { execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' }); }
export function committedBytes(file, repository = root) {
  return execFileSync('git', ['cat-file', 'blob', `HEAD:${file}`], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
}
export function committedFiles(repository = root, prefix = sourceDirectory) {
  const files = new Map();
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', prefix], { cwd: repository, encoding: 'utf8' });
  for (const record of tree.split('\0').filter(Boolean)) {
    const match = record.match(/^([0-7]{6}) blob ([a-f0-9]+)\t(.+)$/s);
    assert(match, `Unsupported committed entry: ${record}`);
    const [, mode, object, file] = match;
    assert(['100644', '100755'].includes(mode), `Special committed file: ${file}`);
    assert(fs.lstatSync(path.join(repository, file)).isFile(), `Special source file: ${file}`);
    files.set(file.slice(prefix.length), {
      bytes: execFileSync('git', ['cat-file', 'blob', object], { cwd: repository, maxBuffer: 16 * 1024 * 1024 }),
      mode: parseInt(mode, 8),
    });
  }
  assert(files.size > 0, 'No committed plugin files found');
  return files;
}
function contained(file, files) {
  assert.equal(typeof file, 'string'); assert(file.startsWith('./'), `Expected ./-prefixed contained path: ${file}`);
  const relative = file.slice(2);
  assert(!relative.includes('\\') && !relative.split('/').some(p => !p || p === '.' || p === '..'), `Unsafe contained path: ${file}`);
  assert(files.has(relative), `Missing referenced file: ${file}`); return relative;
}
export function extractChangelog(bytes, version) {
  assert(semanticVersion.test(version), 'Changelog version must be valid semantic version');
  const text = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  const headings = [...text.matchAll(/^##\s+\[([^\]\n]+)\][^\n]*$/gm)];
  const matching = headings.filter(heading => heading[1] === version);
  assert.equal(matching.length, 1, `CHANGELOG.md needs exactly one ## [${version}] entry`);
  const start = matching[0].index;
  const remainder = text.slice(start + matching[0][0].length);
  const next = remainder.search(/^##(?:\s|$)/m);
  const body = next < 0 ? remainder : remainder.slice(0, next);
  const substantive = body.replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .some(line => !/^\s*#{1,6}(?:\s|$)/.test(line) && /[\p{L}\p{N}]/u.test(line));
  assert(substantive, `CHANGELOG.md entry ${version} is empty`);
  return `${matching[0][0]}${body}`.trimEnd() + '\n';
}
const ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}/';
// Claude Code substitutes ${CLAUDE_PLUGIN_ROOT}; every referenced file must ship in the plugin.
function rootReference(value, files) {
  assert.equal(typeof value, 'string');
  assert(value.startsWith(ROOT_VARIABLE), `Expected a \${CLAUDE_PLUGIN_ROOT} path: ${value}`);
  return contained(`./${value.slice(ROOT_VARIABLE.length)}`, files);
}
function frontmatter(files, file, fields) {
  const text = files.get(file).bytes.toString('utf8'); const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert(header && fields.every(field => new RegExp(`^${field}:\\s*\\S+`, 'm').test(header[1])), `Frontmatter (${fields.join(', ')}): ${file}`);
}

export function validatePackage(files, original) {
  for (const [file, entry] of files) {
    assert(!file.startsWith('/') && !file.includes('\\') && !file.split('/').some(p => !p || p === '.' || p === '..'), `Unsafe package path: ${file}`);
    assert.equal(entry.mode & 0o170000, 0o100000, `Special file: ${file}`);
    // claude.ai and Cowork refuse plugins with a top-level bin/, which would also join the Bash PATH.
    assert(!file.startsWith('bin/'), `Top-level bin/ is not installable everywhere: ${file}`);
  }
  const manifest = parse(files, manifestFile);
  assert.equal(manifest.name, original.name); assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) && manifest.name.length <= 64);
  assert.equal(manifest.version, original.version); assert(semanticVersion.test(manifest.version), 'Explicit valid semantic version required');
  assert.equal(manifest.license, original.license); assert.equal(manifest.author.name, original.author.name);
  for (const field of ['description', 'homepage', 'repository']) assert(typeof manifest[field] === 'string' && manifest[field].trim(), `Missing ${field}`);
  for (const field of ['homepage', 'supportUrl']) if (manifest[field]) assert.equal(new URL(manifest[field]).protocol, 'https:', `Invalid ${field}`);
  for (const field of ['mcpServers', 'hooks', 'commands', 'skills', 'agents']) assert.equal(manifest[field], undefined, `Use the standard ${field} location`);
  const icons = [];
  if (manifest.icon) {
    const file = contained(manifest.icon, files); const svg = files.get(file).bytes.toString('utf8');
    const view = svg.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/);
    assert(file.endsWith('.svg') && view && Number(view[3]) === Number(view[4]), `Square SVG icon required: ${file}`);
    assert(!/<script|<foreignObject|(?:href|src)\s*=\s*["']https?:/i.test(svg), `External/scripted SVG: ${file}`);
    icons.push({ field: 'icon', file, format: 'SVG', width: Number(view[3]), height: Number(view[4]), size_bytes: files.get(file).bytes.length });
  }
  const mcp = parse(files, '.mcp.json'); const servers = Object.entries(mcp.mcpServers);
  assert.equal(servers.length, 1); assert.equal(servers[0][0], 'emu');
  // Node from PATH runs on every platform; shell launchers do not start on Windows.
  const server = servers[0][1]; assert.equal(server.command, 'node', 'The MCP server must start through node');
  for (const arg of server.args ?? []) rootReference(arg, files);
  assert.deepEqual(mcp, JSON.parse(committedBytes(`${sourceDirectory}.mcp.json`)), 'MCP behavior must stay intact');
  const hooks = parse(files, 'hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionEnd', 'SessionStart'], 'Hooks only record session lifecycle');
  for (const handlers of Object.values(hooks)) for (const hook of handlers.flatMap(entry => entry.hooks)) {
    assert.equal(hook.type, 'command');
    for (const reference of hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"\s]+/g) ?? []) rootReference(reference, files);
    assert(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\//.test(hook.command), 'Hooks must start through node');
    assert(Number.isInteger(hook.timeout) && hook.timeout <= 60, 'Hooks need a bounded timeout');
  }
  const skills = [...files.keys()].filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p)); assert(skills.length > 0);
  for (const file of skills) frontmatter(files, file, ['name', 'description']);
  const commands = [...files.keys()].filter(p => /^commands\/[^/]+\.md$/.test(p));
  for (const file of commands) frontmatter(files, file, ['description']);
  for (const tool of TOOLS) for (const field of ['readOnlyHint', 'openWorldHint', 'destructiveHint']) assert.equal(typeof tool.annotations[field], 'boolean');
  for (const tool of TOOLS) assert(`mcp__plugin_${manifest.name}_${servers[0][0]}__${tool.name}`.length <= 64, `Tool name too long: ${tool.name}`);
  for (const file of ['LICENSE', 'NOTICE']) for (const location of [file, `runtime/${file}`]) {
    assert(files.get(location)?.bytes.equals(committedBytes(file)), `Legal copy mismatch: ${location}`);
  }
  assert.equal(hash(files.get('runtime/core/vendor/scrcpy-server-v5.0.1').bytes), '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536');
  assert.equal(hash(files.get('runtime/core/vendor/MINIMAP-RUST-COPYRIGHT-library.html').bytes), '5647be074c8edf7339fd863055923a8fc80bc5610a8d4661ec3b767b9d392c27');
  assert(files.has('CHANGELOG.md'), 'Missing packaged CHANGELOG.md');
  const section = extractChangelog(files.get('CHANGELOG.md').bytes, manifest.version);
  return { manifest, icons, skills, commands, tool_count: TOOLS.length,
    changelog: { file_name: 'CHANGELOG.md', version: manifest.version, sha256: hash(files.get('CHANGELOG.md').bytes), section_sha256: hash(Buffer.from(section)), section } };
}

function main() {
  const args = process.argv.slice(2); const options = {};
  while (args.length) {
    const key = args.shift(); assert(['--version', '--tag'].includes(key) && args.length, `Unknown/incomplete option: ${key}`);
    assert(!Object.hasOwn(options, key), `Repeated option: ${key}`); options[key] = args.shift();
  }
  clean();
  const commit = git('rev-parse', 'HEAD'); const original = JSON.parse(committedBytes(`${sourceDirectory}${manifestFile}`));
  if (Object.hasOwn(options, '--version')) assert.equal(options['--version'], original.version, 'Requested version differs from manifest');
  if (Object.hasOwn(options, '--tag')) {
    assert.equal(options['--tag'], `v${original.version}`, 'Tag must be v<manifest version>');
    assert.equal(git('rev-parse', '--verify', `refs/tags/${options['--tag']}^{commit}`), commit, 'Existing local tag must resolve exactly to checkout HEAD');
  }
  run('scripts/build-plugin.mjs'); clean();
  run('scripts/build-plugin.mjs', '--check');
  run('--test', ...fs.readdirSync(path.join(root, 'test')).filter(p => p.endsWith('.test.mjs')).sort().map(p => `test/${p}`));
  clean();
  // Git's committed modes and blobs preserve provenance even when a host ignores
  // mode changes or has extra group/world execute bits invisible to Git status.
  const files = committedFiles();
  files.set('LICENSE-AUDIT.md', { bytes: committedBytes('LICENSE-AUDIT.md'), mode: 0o100644 });
  files.set('CHANGELOG.md', { bytes: committedBytes('CHANGELOG.md'), mode: 0o100644 });
  const initial = validatePackage(files, original); const prefix = `${original.name}/`;
  const entries = [...files].map(([name, file]) => ({ name: prefix + name, bytes: file.bytes, executable: Boolean(file.mode & 0o111) }));
  const zip = createZip(entries); const actual = inspectZip(zip); const unpacked = new Map();
  assert.equal(actual.size, entries.length);
  for (const [name, entry] of actual) { assert(name.startsWith(prefix)); unpacked.set(name.slice(prefix.length), entry); }
  for (const [name, file] of files) assert(unpacked.get(name)?.bytes.equals(file.bytes), `Archive byte mismatch: ${name}`);
  validatePackage(unpacked, original);
  const output = path.join(root, 'dist'); fs.mkdirSync(output, { recursive: true });
  const filename = `${original.name}-${original.version}.zip`; const digest = hash(zip);
  const gaps = ['Anthropic plugin directory submission has not been prepared; the package is for marketplace or ZIP installation.',
    'No Claude Code screenshots are packaged yet.',
    'Manual end-to-end checks on macOS and Linux with a real Android SDK are not recorded by this report.'];
  const report = { package_status: 'local_checks_passed',
    source: { commit, tag: options['--tag'] ?? null, version: original.version, clean: true },
    archive: { file_name: filename, sha256: digest, size_bytes: zip.length, file_count: actual.size, format: 'Claude Code plugin' },
    checks: ['shared runtime built and checked', 'full local test suite passed', 'single plugin root and explicit version', 'no top-level bin/ directory', 'committed MCP configuration, session hooks, skills, commands, runtime and assets preserved', 'every ${CLAUDE_PLUGIN_ROOT} reference resolves inside the plugin', 'tool names fit the 64-character limit', 'contained paths, regular files, CRC32 and exact ZIP bytes checked', 'LICENSE/NOTICE, server hash and exact Rust notice hash checked', 'committed CHANGELOG.md has one nonempty current-version entry; exact section emitted as RELEASE-NOTES.md'],
    icons: initial.icons, changelog: initial.changelog, tool_count: initial.tool_count, gaps,
    inventory: [...actual].map(([name, file]) => ({ name, size_bytes: file.bytes.length, sha256: hash(file.bytes), mode: file.mode.toString(8) })),
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-package-'));
  try {
    for (const [name, bytes] of [[filename, zip], [`${filename}.sha256`, Buffer.from(`${digest}  ${filename}\n`)], ['submission-report.json', Buffer.from(`${JSON.stringify(report, null, 2)}\n`)], ['RELEASE-NOTES.md', Buffer.from(initial.changelog.section)]]) {
      const temp = path.join(temporary, name); fs.writeFileSync(temp, bytes); fs.copyFileSync(temp, path.join(output, name));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log(JSON.stringify({ archive: path.join(output, filename), sha256: digest, file_count: actual.size, package_status: report.package_status, gaps }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
