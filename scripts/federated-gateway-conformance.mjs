import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_REPORT_PATH = 'security/reports/federated-gateway-conformance-report.json';
const REPRO_COMMAND = 'pnpm security:federated:conformance';

function run() {
  return new Promise((resolve, reject) => {
    const reportPath = process.env.FEDERATED_CONFORMANCE_REPORT_PATH || DEFAULT_REPORT_PATH;
    const child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '__tests__/federated-gateway-conformance.test.ts'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          FEDERATED_CONFORMANCE_REPORT_PATH: reportPath,
          FEDERATED_CONFORMANCE_REPRO_COMMAND: REPRO_COMMAND,
        },
      },
    );

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const reportPath = process.env.FEDERATED_CONFORMANCE_REPORT_PATH || DEFAULT_REPORT_PATH;
  await mkdir(path.dirname(reportPath), { recursive: true });
  const code = await run();
  process.exit(code);
}

main().catch((error) => {
  console.error('Federated conformance runner failed to start:', error);
  process.exit(1);
});
