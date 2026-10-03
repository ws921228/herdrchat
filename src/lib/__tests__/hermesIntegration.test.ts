/**
 * @jest-environment node
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { HERMES_INTEGRATION_SCRIPT_BASE64 } from '../herdr/hermesIntegrationScript';
import { hermesCompatibilityCommand, installHermesCompatibility } from '../herdr/hermesIntegration';
import type { HerdrTransport } from '../herdr/transport';

const SCRIPT = resolve(__dirname, '../../../scripts/herdr-hermes.py');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdrchat-hermes-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('embeds the current Hermes installer script for installation from the phone', () => {
  const embedded = Buffer.from(HERMES_INTEGRATION_SCRIPT_BASE64, 'base64').toString('utf8');
  expect(embedded).toBe(readFileSync(SCRIPT, 'utf8'));
});

it('builds a command with explicit herdr binary and session arguments', async () => {
  const transport: HerdrTransport = {
    exec: async (command, timeoutMs) => {
      expect(command).toContain('python3 -c');
      expect(command).toContain("'--herdr' '/opt/herdr bin/herdr'");
      expect(command).toContain("'--hermes' 'hermes'");
      expect(command).toContain("'--session' 'smoke session'");
      expect(timeoutMs).toBeGreaterThan(0);
      return { ok: true, stdout: '{"ok":true,"status":"already_installed","path":"/tmp/hermes.toml"}\n', stderr: '', exitCode: 0 };
    },
    streamLines: async function* () {},
  };

  await expect(installHermesCompatibility(transport, '/opt/herdr bin/herdr', 'smoke session')).resolves.toEqual({
    ok: true,
    status: 'already_installed',
    path: '/tmp/hermes.toml',
  });
  expect(hermesCompatibilityCommand('herdr')).toContain('--herdr');
});

it('installs a local override for the known remote Hermes manifest and reloads Herdr', () => {
  const host = mockHost();
  const result = runInstaller(host);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: 'installed', version: '2026.10.03.1' });
  expect(JSON.parse(result.stdout)).toMatchObject({ launcher: { ok: true, status: 'installed', command: host.launcher } });
  const override = readFileSync(host.override, 'utf8');
  const launcher = readFileSync(host.launcher, 'utf8');
  expect(launcher).toContain('# herdrchat-managed-hermes-launcher-v1');
  expect(launcher).toContain(host.hermesScript);
  expect(execFileSync(host.launcher, ['--mock-arg', 'value'], { encoding: 'utf8' })).toBe('["--mock-arg","value"]');
  expect(override).toContain('id = "dangerous_command_approval"');
  expect(override).toContain('id = "classic_cancel_working"');
  expect(override).toContain('id = "herdrchat_classic_prompt_idle"');
  expect(override).toContain('priority = 50');
  expect(override).toContain('☤\\s+.*\\s│\\s+ctx');
  expect(override).toContain('❯(?:\\s|$)');
  expect(override.indexOf('id = "herdrchat_classic_prompt_idle"')).toBeLessThan(override.indexOf('id = "osc_title_idle"'));
  expect(readFileSync(host.log, 'utf8')).toContain('--session smoke server reload-agent-manifests');
});

it('is idempotent after its own override is active', () => {
  const host = mockHost();
  expect(runInstaller(host).status).toBe(0);
  const first = readFileSync(host.override, 'utf8');
  const second = runInstaller(host);

  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, status: 'already_installed' });
  expect(readFileSync(host.override, 'utf8')).toBe(first);
  expect(readFileSync(host.log, 'utf8').match(/reload-agent-manifests/g)?.length).toBe(2);
});

it('does not report success when its managed file is not active in the running server', () => {
  const host = mockHost();
  expect(runInstaller(host).status).toBe(0);
  const inactiveHost = { ...host, ignoreOverride: true };

  const result = runInstaller(inactiveHost);

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: 'failed', reason: 'override_not_active', rollback: false });
});

it('requires both the Hermes status bar and prompt line in the idle rule', () => {
  const host = mockHost();
  expect(runInstaller(host).status).toBe(0);
  const override = readFileSync(host.override, 'utf8');

  expect(override).toMatch(/all = \[\n  \{ line_regex = \['\^\\s\*☤\\s\+\.\*\\s│\\s\+ctx\\s'\] \},\n  \{ line_regex = \['\^\\s\*❯\(\?:\\s\|\$\)'\] \},\n\]/);
  expect(override).not.toContain('contains = ["☤"]');
});

it('refuses to overwrite an unrelated local Hermes override', () => {
  const host = mockHost();
  mkdirSync(dirname(host.override), { recursive: true });
  writeFileSync(host.override, 'id = "hermes"\nversion = "custom"\n');

  const result = runInstaller(host);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: 'refused', reason: 'custom_override_exists' });
  expect(readFileSync(host.override, 'utf8')).toBe('id = "hermes"\nversion = "custom"\n');
  expect(existsSync(host.log)).toBe(false);
  expect(existsSync(host.launcher)).toBe(false);
});

it('refuses an unrelated launcher conflict without overwriting it', () => {
  const host = mockHost();
  mkdirSync(dirname(host.launcher), { recursive: true });
  writeFileSync(host.launcher, 'custom launcher');

  const result = runInstaller(host);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    status: 'installed',
    launcher: { ok: false, status: 'conflict', path: host.launcher },
  });
  expect(readFileSync(host.launcher, 'utf8')).toBe('custom launcher');
});

it('rolls back the override when Herdr refuses to reload manifests', () => {
  const host = mockHost({ reloadFails: true });
  const result = runInstaller(host);

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: 'failed', reason: 'reload_failed', rollback: true });
  expect(existsSync(host.override)).toBe(false);
});

it('refuses unfamiliar Hermes manifests instead of installing a broad idle rule', () => {
  const host = mockHost({ manifest: KNOWN_HERMES_MANIFEST.replace('id = "classic_cancel_working"', 'id = "renamed_idle_rule"') });
  const result = runInstaller(host);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: 'refused', reason: 'unfamiliar_manifest' });
  expect(existsSync(host.override)).toBe(false);
  expect(existsSync(host.launcher)).toBe(false);
});

it('parses a quoted Hermes runtime path safely', () => {
  const host = mockHost({ rootName: "hermes agent's root" });
  const result = runInstaller(host);

  expect(result.status).toBe(0);
  expect(readFileSync(host.launcher, 'utf8')).toContain("hermes agent'\\''s root/hermes");
  expect(execFileSync(host.launcher, ['quoted'], { encoding: 'utf8' })).toBe('["quoted"]');
});

function runInstaller(host: MockHost) {
  return spawnSync('python3', [SCRIPT, '--herdr', host.herdr, '--session', 'smoke'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: host.home,
      HERDR_CONFIG_PATH: host.config,
      PATH: `${host.bin}:${process.env.PATH ?? ''}`,
      XDG_CONFIG_HOME: host.xdgConfig,
      HC_REMOTE_MANIFEST: host.remoteManifest,
      HC_HERDR_LOG: host.log,
      HC_IGNORE_OVERRIDE: host.ignoreOverride ? '1' : '',
      HC_RELOAD_FAIL: host.reloadFails ? '1' : '',
    },
  });
}

type MockHost = {
  bin: string;
  config: string;
  herdr: string;
  hermesScript: string;
  home: string;
  ignoreOverride: boolean;
  launcher: string;
  log: string;
  override: string;
  reloadFails: boolean;
  remoteManifest: string;
  xdgConfig: string;
};

function mockHost({ manifest = KNOWN_HERMES_MANIFEST, reloadFails = false, rootName = 'hermes-agent' } = {}): MockHost {
  const bin = join(dir, 'bin');
  const xdgConfig = join(dir, 'xdg-config');
  const home = join(dir, 'home');
  const config = join(dir, 'custom-config-location', 'config.toml');
  const remoteManifest = join(dir, 'remote', 'hermes.toml');
  const herdr = join(dir, 'herdr-mock.js');
  const hermes = join(bin, 'hermes');
  const hermesRoot = join(dir, rootName);
  const hermesScript = join(hermesRoot, 'hermes');
  const log = join(dir, 'herdr.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(remoteManifest), { recursive: true });
  mkdirSync(hermesRoot, { recursive: true });
  writeFileSync(remoteManifest, manifest);
  writeFileSync(herdr, MOCK_HERDR);
  writeFileSync(hermesScript, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  writeFileSync(hermes, mockHermes(hermesRoot));
  chmodSync(herdr, 0o755);
  chmodSync(hermes, 0o755);
  return {
    bin,
    config,
    herdr,
    hermesScript,
    home,
    ignoreOverride: false,
    launcher: join(home, '.local', 'bin', 'herdrchat-hermes'),
    log,
    override: join(xdgConfig, 'herdr', 'agent-detection', 'hermes.toml'),
    reloadFails,
    remoteManifest,
    xdgConfig,
  };
}

function mockHermes(root: string): string {
  const pythonCode = `import sys; sys.path.insert(0, ${JSON.stringify(root)}); import hermes_bootstrap`;
  return `#!${process.execPath}
if (process.argv[2] !== '--print-runtime-command') process.exit(64);
console.log(JSON.stringify([${JSON.stringify(process.execPath)}, '-I', '-c', ${JSON.stringify(pythonCode)}]));
`;
}

const MOCK_HERDR = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HC_HERDR_LOG, args.join(' ') + '\\n');
let rest = args;
if (rest[0] === '--session') rest = rest.slice(2);
if (rest.join(' ') === 'server reload-agent-manifests') {
  if (process.env.HC_RELOAD_FAIL === '1') {
    console.error('reload failed');
    process.exit(2);
  }
  process.exit(0);
}
if (rest.join(' ') !== 'server agent-manifests --json') {
  console.error('unexpected args: ' + rest.join(' '));
  process.exit(64);
}
const config = process.env.HERDR_CONFIG_PATH;
const override = path.join(process.env.XDG_CONFIG_HOME, 'herdr', 'agent-detection', 'hermes.toml');
const shadow = fs.existsSync(override) && process.env.HC_IGNORE_OVERRIDE !== '1';
const source = shadow ? 'local:' + override : 'remote:' + process.env.HC_REMOTE_MANIFEST;
const text = fs.readFileSync(shadow ? override : process.env.HC_REMOTE_MANIFEST, 'utf8');
const version = /version = "([^"]+)"/.exec(text)?.[1] || 'unknown';
console.log(JSON.stringify({ result: { manifests: [{
  agent: 'hermes',
  id: 'hermes',
  source,
  source_kind: shadow ? 'local' : 'remote',
  active_version: version,
  local_override_shadowing_remote: shadow,
}] } }));
`;

const KNOWN_HERMES_MANIFEST = `id = "hermes"
version = "2026.07.24.1"
min_engine_version = 2
updated_at = "2026-07-24T19:12:54Z"
aliases = ["hermes-agent"]

[[rules]]
id = "osc_title_blocked"
state = "blocked"
priority = 1100
region = "osc_title"
visible_blocker = true
regex = ['^⚠[\\u{fe0e}\\u{fe0f}]?(?:\\s|$)']

[[rules]]
id = "dangerous_command_approval"
state = "blocked"
priority = 900
region = "bottom_non_empty_lines(14)"
visible_blocker = true
any = [
  { contains = ["dangerous"] },
  { contains = ["approval"] },
]

[[rules]]
id = "clarification_prompt"
state = "blocked"
priority = 900
region = "bottom_non_empty_lines(14)"
visible_blocker = true
any = [
  { contains = ["hermes needs your"] },
]

[[rules]]
id = "credential_prompt"
state = "blocked"
priority = 900
region = "bottom_non_empty_lines(14)"
visible_blocker = true
any = [
  { contains = ["sudo password"] },
]

[[rules]]
id = "confirmation_prompt"
state = "blocked"
priority = 900
region = "bottom_non_empty_lines(14)"
visible_blocker = true
all = [
  { any = [{ contains = ["approve once", "cancel"] }] },
]

[[rules]]
id = "interrupt_status_working"
state = "working"
priority = 950
region = "bottom_non_empty_lines(5)"
visible_working = true
any = [
  { contains = ["msg=interrupt"] },
  { contains = ["ctrl+c to interrupt"] },
]

[[rules]]
id = "classic_cancel_working"
state = "working"
priority = 500
region = "bottom_non_empty_lines(5)"
visible_working = true
contains = ["ctrl+c cancel"]

[[rules]]
id = "osc_title_idle"
state = "idle"
priority = 100
region = "osc_title"
visible_idle = true
regex = ['^✓[\\u{fe0e}\\u{fe0f}]?(?:\\s|$)']
`;
