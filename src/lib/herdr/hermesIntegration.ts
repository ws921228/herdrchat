import { HERMES_INTEGRATION_SCRIPT_BASE64 } from './hermesIntegrationScript';
import { HerdrError, transportError } from './protocol';
import { shellQuote, withPath } from './shell';
import { LAUNCH_TIMEOUT_MS } from './timeouts';
import type { HerdrTransport } from './transport';

export type HermesCompatibilityResult =
  | { ok: true; status: 'installed' | 'already_installed' | 'not_needed'; path?: string; version?: string; launcher?: HermesLauncherResult }
  | { ok: false; status: 'refused' | 'failed'; reason: string; path?: string; detail?: string; stderr?: string; rollback?: boolean };

export type HermesLauncherResult =
  | { ok: true; status: 'installed' | 'already_installed'; path: string; command: string }
  | { ok: false; status: 'unavailable' | 'conflict'; reason?: string; path?: string; stderr?: string; script?: string };

export async function installHermesCompatibility(
  transport: HerdrTransport,
  herdrExecutable = 'herdr',
  session?: string,
  hermesExecutable = 'hermes'
): Promise<HermesCompatibilityResult> {
  const result = await transport.exec(hermesCompatibilityCommand(herdrExecutable, session, hermesExecutable), LAUNCH_TIMEOUT_MS);
  if (!result.ok) throw transportError(result);
  const parsed = parseHermesCompatibilityResult(result.stdout);
  if (result.exitCode !== 0 && parsed === null) {
    throw new HerdrError(
      'hermes_compatibility_install_failed',
      `Could not install Hermes compatibility (exit ${result.exitCode}). ${result.stderr.trim()}`
    );
  }
  if (parsed !== null) return parsed;
  throw new HerdrError('hermes_compatibility_install_failed', 'Hermes compatibility installer returned no JSON result.');
}

export function hermesCompatibilityCommand(herdrExecutable = 'herdr', session?: string, hermesExecutable = 'hermes'): string {
  const args = [
    '--herdr',
    herdrExecutable,
    '--hermes',
    hermesExecutable,
    ...(session && session.trim().length > 0 ? ['--session', session.trim()] : []),
  ];
  const python = [
    'import base64,sys',
    'code=base64.b64decode(sys.argv[1])',
    'sys.argv=["herdr-hermes.py"]+sys.argv[2:]',
    'exec(compile(code,"herdr-hermes.py","exec"))',
  ].join(';');
  return withPath([
    'command -v python3 >/dev/null 2>&1 || { echo "python3 is required by the Herdr Hermes integration." >&2; exit 127; }',
    `python3 -c ${shellQuote(python)} ${shellQuote(HERMES_INTEGRATION_SCRIPT_BASE64)} ${args.map(shellQuote).join(' ')}`,
  ].join('; '));
}

function parseHermesCompatibilityResult(stdout: string): HermesCompatibilityResult | null {
  const lines = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{') && candidate.includes('"status"'));
  const line = lines.length > 0 ? lines[lines.length - 1] : undefined;
  if (line === undefined) return null;
  try {
    const parsed = JSON.parse(line) as Partial<HermesCompatibilityResult>;
    if (parsed.ok === true && typeof parsed.status === 'string') return parsed as HermesCompatibilityResult;
    if (parsed.ok === false && typeof parsed.status === 'string' && typeof parsed.reason === 'string') {
      return parsed as HermesCompatibilityResult;
    }
  } catch {
    return null;
  }
  return null;
}
