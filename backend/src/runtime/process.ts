import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const ENV_SECRET = /(?:API[_-]?KEY|(?:^|_)KEY|(?:^|_)TOKEN|BEARER|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|BASE[_-]?URL)$/i;
const NESTED_SESSION = /^(?:CLAUDECODE|CLAUDE_CODE_(?:SESSION_ID|ENTRYPOINT)|CODEX_(?:SESSION_ID|THREAD_ID))$/i;
const SECRET_VALUE = /((?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}))/g;

export function childEnv(source = process.env, additions: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && key !== 'SHAO_MCP_CAPABILITY' && !ENV_SECRET.test(key) && !NESTED_SESSION.test(key)) env[key] = value;
  for (const [key, value] of Object.entries(additions)) if (key === 'SHAO_MCP_CAPABILITY' || !ENV_SECRET.test(key)) env[key] = value;
  return env;
}

export function redact(text: string, secrets: string[] = []) {
  let clean = text.replace(SECRET_VALUE, '[REDACTED_SECRET]').replace(/(Bearer\s+)\S+/gi, '$1[REDACTED_SECRET]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED_SECRET]');
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('[REDACTED_SECRET]');
  return clean;
}

export function redactDiagnostic(text: string, secrets: string[] = []) {
  let clean = redact(text.split(/\r?\n/).find(line => line.trim()) ?? '', secrets)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
    .replace(/[A-Z]:\\Users\\[^\\\r\n"']+(?:\\[^\s"']*)*/gi, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_SECRET]');
  return clean.slice(0, 180);
}

export function spawnCli(command: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs = 120_000, secrets: string[] = []) {
  const child = spawn(command, args, { cwd, env: childEnv(process.env, env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let settled = false; let forced = false; let closed = false;
  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; terminated: boolean; spawnError?: string }>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), timedOut: forced, terminated: closed, ...(spawnError ? { spawnError: redact(spawnError, secrets) } : {}) });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => { closed = true; finish(code, signal); });
    const timer = setTimeout(() => {
      forced = true;
      void (async () => {
        await terminateTree();
        if (settled || closed) return;
        await delay(1500);
        if (settled || closed) return;
        await terminateTree();
        await delay(3000);
        if (!settled) finish(null, null, 'Process termination could not be confirmed.');
      })();
    }, timeoutMs);
    timer.unref?.();
  });
  const terminateTree = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      // taskkill targets the process tree and uses argv, not a shell command string.
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('close', () => resolve()); killer.once('error', () => resolve());
      });
    } else child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const stop = () => { void terminateTree(); };
  return {
    child, outcome,
    write(input: string) { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(input); },
    end() { child.stdin.end(); },
    stop,
    async terminateAndConfirm(graceMs = 1500) {
      await terminateTree();
      const first = await Promise.race([outcome, delay(graceMs).then(() => null)]);
      if (first) return true;
      await terminateTree();
      return Promise.race([outcome.then(() => true), delay(3000).then(() => false)]);
    },
    onLine(fn: (line: string) => void) {
      let pending = '';
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
          if (line) fn(redact(line, secrets));
        }
      });
      child.stdout.on('end', () => { if (pending.trim()) fn(redact(pending.trim(), secrets)); });
    },
  };
}

export function parseJsonLine(line: string): unknown | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

export function classifyFailure(stderr: string, code: number | null, timedOut: boolean) {
  const s = stderr.toLowerCase();
  if (timedOut) return { status: 'outcome_uncertain' as const, error: { code: 'runtime_timeout', message: 'CLI timed out; its final effect is unknown.', retryable: false } };
  if (/not logged in|authentication required|unauthorized|invalid api key|please log in/.test(s)) return { status: 'failed' as const, error: { code: 'runtime_auth', message: 'CLI authentication is unavailable.', retryable: false } };
  if (/rate.?limit|quota|usage limit|out of .*credits|insufficient_quota/.test(s)) return { status: 'failed' as const, error: { code: 'runtime_quota', message: 'CLI reported a usage limit.', retryable: false } };
  if (/unknown (?:argument|option)|unexpected argument|unrecognized (?:argument|option)|invalid (?:argument|option)|usage:/.test(s)) return { status: 'failed' as const, error: { code: 'runtime_cli_arguments', message: 'Installed CLI rejected the adapter arguments.', retryable: false } };
  if (/permission denied|not permitted|permission prompt|restricted mode/.test(s)) return { status: 'failed' as const, error: { code: 'runtime_cli_permissions', message: 'Installed CLI rejected the configured read-only permission mode.', retryable: false } };
  if (/schema/.test(s)) return { status: 'failed' as const, error: { code: 'runtime_cli_schema', message: 'Installed CLI rejected the adapter output schema.', retryable: false } };
  return { status: 'failed' as const, error: { code: code === null ? 'runtime_process' : `runtime_exit_${code}`, message: 'CLI exited without a valid final result.', retryable: false } };
}
