import { pipeline } from 'node:stream/promises';
import { createArtifactTransaction, writeJsonArtifact } from './artifacts.js';
import { csvLine } from './csv.js';
import { CoreOperationError } from './errors.js';

function* encodeCsv({ columns, rows }) {
  const keys = columns.map(c => c.key);
  yield csvLine(columns.map(c => c.source_slot == null ? c.key : `${c.title} [${c.key}]`));
  for (const row of rows) yield csvLine(keys.map(key => row[key]));
}

export async function writeStudySeriesArtifact(result, { format, output, force }) {
  let artifact;
  if (format === 'json') {
    artifact = await writeJsonArtifact({ value: result, output, force });
  } else {
    const transaction = await createArtifactTransaction({ output, force });
    try {
      await pipeline(encodeCsv(result.datasets[0]), transaction.openArtifact());
      artifact = { ...await transaction.publish(), format };
    } catch (error) {
      await transaction.abort();
      if (error instanceof CoreOperationError) throw error;
      throw new CoreOperationError('Could not write study CSV: ' + error.message, {
        code: 'OUTPUT_WRITE_FAILED', kind: 'filesystem', phase: 'artifact_write', cause: error,
      });
    }
  }
  return { ...result, datasets: result.datasets.map(({ rows, ...metadata }) => metadata), output: artifact };
}
