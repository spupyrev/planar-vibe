import { computeReportInstance } from './report-instance-core.mjs';

async function main() {
  const graphName = String(process.argv[2] || '');
  const algorithmKey = String(process.argv[3] || '');
  if (!graphName || !algorithmKey) {
    throw new Error('Usage: node scripts/run-report-instance.mjs <graph> <algorithm>');
  }

  const rec = await computeReportInstance(graphName, algorithmKey);
  process.stdout.write(`${JSON.stringify(rec)}\n`);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    message
  })}\n`);
  process.exitCode = 1;
});
