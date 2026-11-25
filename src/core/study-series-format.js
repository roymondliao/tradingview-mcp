import { pipeline } from 'node:stream/promises';
import { createArtifactTransaction, writeJsonArtifact } from './artifacts.js';
import { csvLine } from './csv.js';
import { CoreOperationError } from './errors.js';

function csvHeader(column) {
  return column.source_slot == null ? column.key : `${column.title} [${column.key}]`;
}

function* encodeCsv({ columns, rows }) {
  const keys = columns.map(c => c.key);
  yield csvLine(columns.map(csvHeader));
  for (const row of rows) yield csvLine(keys.map(key => row[key]));
}

const ROW_DESCRIPTIONS = new Map([
  ['plots', 'One study observation at a bar timestamp.'],
  ['boxes', 'One box on the snapshot chart, with its price and time anchors.'],
  ['lines', 'One line on the snapshot chart, with its endpoints.'],
  ['labels', 'One label on the snapshot chart, with its text and anchor.'],
  ['table_cells', 'One table cell on the snapshot chart.'],
  ['display_values', 'One formatted Data Window item at capture time.'],
]);

export function previewStudySeries(result, format) {
  const singleTable = result.datasets.length === 1;
  return {
    ...result,
    dry_run: true,
    export_format: format,
    recommended_format: singleTable ? 'csv' : 'json',
    reason: singleTable
      ? 'The selection is one table with a single set of columns.'
      : 'The selection contains multiple datasets. JSON preserves them together.',
    datasets: result.datasets.map(({ rows, columns, ...table }) => ({
      ...table,
      row_represents: ROW_DESCRIPTIONS.get(table.key) || 'One graphics object from this study snapshot.',
      csv_available: true,
      columns: columns.map(column => ({ ...column, csv_header: csvHeader(column) })),
    })),
  };
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
