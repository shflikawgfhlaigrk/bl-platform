/** Launch the local POS with secrets read server-side from an explicit private env file. */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
if (env.POS_STRIPE_ENV_FILE) {
  const allowed = new Set(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TERMINAL_READER_ID']);
  for (const line of readFileSync(env.POS_STRIPE_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allowed.has(match[1]) || env[match[1]]) continue;
    env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
