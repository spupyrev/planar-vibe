import { parentPort, workerData } from 'node:worker_threads';

import { computeReportInstance } from './report-instance-core.mjs';

async function main() {
  const graphName = String(workerData && workerData.graphName ? workerData.graphName : '');
  const algorithmKey = String(workerData && workerData.algorithmKey ? workerData.algorithmKey : '');
  const rec = await computeReportInstance(graphName, algorithmKey);
  parentPort.postMessage({ ok: true, rec });
}

main().catch((err) => {
  parentPort.postMessage({
    ok: false,
    message: err && err.message ? err.message : String(err)
  });
});
