/** Streaming encoders for canonical Strategy Trading Data. */
import { finished } from 'node:stream/promises';
import { extname } from 'node:path';
import { CoreOperationError } from './errors.js';

export const TRADING_DATA_FORMATS = Object.freeze(['json', 'jsonl', 'csv']);

const EXTENSION_FORMATS = Object.freeze({
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.csv': 'csv',
});

export const TRADING_DATA_CSV_COLUMNS = Object.freeze([
  'trade_number',
  'leg_type',
  'time',
  'time_iso',
  'signal',
  'price',
  'currency',
  'quantity',
  'position_value',
  'net_profit',
  'return_percent',
  'commission',
  'run_up',
  'run_up_percent',
  'drawdown',
  'drawdown_percent',
  'cumulative_profit',
  'cumulative_profit_percent',
  'duration_bars',
  'status',
]);

function formatError(message, code = 'OUTPUT_FORMAT_UNSUPPORTED') {
  return new CoreOperationError(message, { code, phase: 'output_validation' });
}

/** Resolve an explicit format or infer it from a recognized output extension. */
export function resolveTradingDataFormat({ format, output } = {}) {
  const explicit = format == null ? null : String(format).trim().toLowerCase();
  if (explicit && !TRADING_DATA_FORMATS.includes(explicit)) {
    throw formatError(
      `Unsupported Trading Data format: ${format}. Expected json, jsonl, or csv.`,
    );
  }
  const extension = output == null ? '' : extname(String(output)).toLowerCase();
  const inferred = EXTENSION_FORMATS[extension] || null;
  if (explicit && inferred && explicit !== inferred) {
    throw formatError(
      `--format ${explicit} conflicts with output extension ${extension}.`,
      'OUTPUT_FORMAT_EXTENSION_MISMATCH',
    );
  }
  return explicit || inferred || 'json';
}

async function writeChunk(writable, value) {
  if (!writable || typeof writable.write !== 'function') {
    throw new TypeError('A writable stream is required.');
  }
  if (writable.destroyed) throw new Error('Output stream is no longer writable.');
  await new Promise((resolveWrite, rejectWrite) => {
    writable.write(value, 'utf8', (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function csvCell(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(values) {
  return `${values.map(csvCell).join(',')}\n`;
}

function tradeRow(metadata, trade, leg, legType, includeMetrics) {
  const metric = (pair, field) => (includeMetrics ? pair?.[field] ?? null : null);
  return {
    trade_number: trade.trade_number ?? null,
    leg_type: legType,
    time: leg?.time ?? null,
    time_iso: leg?.time_iso ?? null,
    signal: leg?.label ?? null,
    price: leg?.price ?? null,
    currency: trade.currency ?? metadata.currency ?? null,
    quantity: trade.quantity ?? null,
    position_value: trade.position_value ?? null,
    net_profit: metric(trade.profit, 'value'),
    return_percent: metric(trade.profit, 'percent'),
    commission: includeMetrics ? trade.commission ?? null : null,
    run_up: metric(trade.run_up, 'value'),
    run_up_percent: metric(trade.run_up, 'percent'),
    drawdown: metric(trade.drawdown, 'value'),
    drawdown_percent: metric(trade.drawdown, 'percent'),
    cumulative_profit: metric(trade.cumulative_profit, 'value'),
    cumulative_profit_percent: metric(trade.cumulative_profit, 'percent'),
    duration_bars: includeMetrics ? trade.duration_bars ?? null : null,
    status: trade.status ?? null,
  };
}

function summaryRecord(metadata, writtenTrades, writtenRows) {
  const fields = [
    'schema_version', 'snapshot_id', 'total', 'offset', 'limit', 'returned',
    'next_offset', 'has_more', 'complete', 'ordering',
  ];
  const summary = { record_type: 'summary' };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(metadata, field)) summary[field] = metadata[field];
  }
  summary.written_trades = writtenTrades;
  summary.written_rows = writtenRows;
  return summary;
}

/**
 * Create one stateful encoder. The caller owns artifact publication; finish only
 * closes the supplied staging stream.
 */
export function createTradingDataEncoder({ format = 'json', metadata = {}, writable } = {}) {
  const resolvedFormat = resolveTradingDataFormat({ format });
  const { trades: _ignoredTrades, ...safeMetadata } = metadata || {};
  let streamError = null;
  const captureStreamError = (error) => { streamError ||= error; };
  writable?.on?.('error', captureStreamError);
  let state = 'created';
  let writtenTrades = 0;
  let writtenRows = 0;
  let firstJsonTrade = true;

  function requireState(expected) {
    if (state !== expected) throw new Error(`Trading Data encoder is ${state}; expected ${expected}.`);
  }

  return {
    format: resolvedFormat,

    async start() {
      requireState('created');
      state = 'started';
      if (resolvedFormat === 'json') {
        const entries = Object.entries(safeMetadata)
          .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
        await writeChunk(writable, `{${entries.length ? `${entries.join(',')},` : ''}"trades":[`);
      } else if (resolvedFormat === 'jsonl') {
        await writeChunk(writable, `${JSON.stringify({ ...safeMetadata, record_type: 'metadata' })}\n`);
      } else {
        await writeChunk(writable, csvLine(TRADING_DATA_CSV_COLUMNS));
      }
    },

    async writeBatch(canonicalTrades) {
      requireState('started');
      if (!Array.isArray(canonicalTrades)) throw new TypeError('canonicalTrades must be an array.');
      for (const trade of canonicalTrades) {
        if (resolvedFormat === 'json') {
          await writeChunk(writable, `${firstJsonTrade ? '' : ','}${JSON.stringify(trade)}`);
          firstJsonTrade = false;
          writtenRows += 1;
        } else if (resolvedFormat === 'jsonl') {
          await writeChunk(writable, `${JSON.stringify({ record_type: 'trade', trade })}\n`);
          writtenRows += 1;
        } else {
          const endLeg = trade.status === 'open' ? trade.mark : trade.exit;
          const endType = trade.status === 'open' ? 'mark' : 'exit';
          const rows = [
            tradeRow(safeMetadata, trade, endLeg, endType, true),
            tradeRow(safeMetadata, trade, trade.entry, 'entry', false),
          ];
          for (const row of rows) {
            await writeChunk(
              writable,
              csvLine(TRADING_DATA_CSV_COLUMNS.map((column) => row[column])),
            );
          }
          writtenRows += rows.length;
        }
        writtenTrades += 1;
      }
    },

    async finish() {
      requireState('started');
      if (streamError) throw streamError;
      if (resolvedFormat === 'json') {
        await writeChunk(writable, ']}\n');
      } else if (resolvedFormat === 'jsonl') {
        await writeChunk(writable, `${JSON.stringify(summaryRecord(
          safeMetadata, writtenTrades, writtenRows,
        ))}\n`);
      }
      state = 'finished';
      writable.end();
      await finished(writable);
      if (streamError) throw streamError;
      return { format: resolvedFormat, written_trades: writtenTrades, written_rows: writtenRows };
    },

    async abort() {
      if (state === 'finished' || state === 'aborted') return;
      state = 'aborted';
      if (writable && !writable.destroyed) writable.destroy();
    },
  };
}
