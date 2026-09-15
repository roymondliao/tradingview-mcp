import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  createTradingDataEncoder,
  resolveTradingDataFormat,
  TRADING_DATA_CSV_COLUMNS,
} from '../src/core/strategy-trading-format.js';

const golden = JSON.parse(readFileSync(new URL(
  './fixtures/strategy-trading/format-golden.json', import.meta.url,
), 'utf8'));

function stringSink({ failAfter = Infinity } = {}) {
  let output = '';
  let writes = 0;
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      writes += 1;
      if (writes > failAfter) return callback(new Error('injected write failure'));
      output += chunk.toString();
      callback();
    },
  });
  return { writable, value: () => output };
}

async function encode(format, batches = [golden.trades]) {
  const sink = stringSink();
  const encoder = createTradingDataEncoder({ format, metadata: golden.metadata, writable: sink.writable });
  await encoder.start();
  for (const batch of batches) await encoder.writeBatch(batch);
  const stats = await encoder.finish();
  return { output: sink.value(), stats };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (character !== '\r') cell += character;
  }
  return rows;
}

describe('Strategy Trading Data format resolution', () => {
  it('defaults to JSON and infers recognized extensions case-insensitively', () => {
    assert.equal(resolveTradingDataFormat(), 'json');
    assert.equal(resolveTradingDataFormat({ output: 'trades.JSONL' }), 'jsonl');
    assert.equal(resolveTradingDataFormat({ output: 'trades.csv' }), 'csv');
    assert.equal(resolveTradingDataFormat({ output: 'trades.unknown' }), 'json');
  });

  it('rejects unsupported formats and recognized extension conflicts', () => {
    assert.throws(
      () => resolveTradingDataFormat({ format: 'xlsx' }),
      (error) => error.code === 'OUTPUT_FORMAT_UNSUPPORTED',
    );
    assert.throws(
      () => resolveTradingDataFormat({ format: 'csv', output: 'trades.json' }),
      (error) => error.code === 'OUTPUT_FORMAT_EXTENSION_MISMATCH',
    );
  });
});

describe('Strategy Trading Data streaming encoders', () => {
  it('writes lossless JSON from multiple canonical batches', async () => {
    const { output, stats } = await encode('json', [[golden.trades[0]], [golden.trades[1]]]);
    assert.deepEqual(JSON.parse(output), { ...golden.metadata, trades: golden.trades });
    assert.deepEqual(stats, { format: 'json', written_trades: 2, written_rows: 2 });
    assert.equal(output.endsWith('\n'), true);
  });

  it('writes metadata-first JSONL, canonical Trade records, and a summary', async () => {
    const { output, stats } = await encode('jsonl');
    const records = output.trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(records[0].record_type, 'metadata');
    assert.equal(records[1].record_type, 'trade');
    assert.deepEqual(records[1].trade, golden.trades[0]);
    assert.deepEqual(records[2].trade, golden.trades[1]);
    assert.equal(records[3].record_type, 'summary');
    assert.equal(records[3].written_trades, 2);
    assert.deepEqual(stats, { format: 'jsonl', written_trades: 2, written_rows: 2 });
  });

  it('writes locale-independent RFC 4180 CSV Exit/Entry and Mark/Entry rows', async () => {
    const { output, stats } = await encode('csv');
    const rows = parseCsv(output);
    assert.deepEqual(rows[0], TRADING_DATA_CSV_COLUMNS);
    assert.equal(rows.length, 5);
    const records = rows.slice(1).map((values) => Object.fromEntries(
      TRADING_DATA_CSV_COLUMNS.map((column, index) => [column, values[index]]),
    ));
    assert.equal(records[0].leg_type, 'exit');
    assert.equal(records[0].net_profit, '9');
    assert.equal(records[1].leg_type, 'entry');
    assert.equal(records[1].signal, '進場,"A"\nnext');
    assert.equal(records[1].net_profit, '');
    assert.equal(records[2].leg_type, 'mark');
    assert.equal(records[2].drawdown, '');
    assert.equal(records[3].leg_type, 'entry');
    assert.deepEqual(stats, { format: 'csv', written_trades: 2, written_rows: 4 });
    assert.equal(output.startsWith('\uFEFF'), false);
    assert.equal(output.includes('\r\n'), false);
  });

  it('propagates streaming write failures', async () => {
    const sink = stringSink({ failAfter: 1 });
    const encoder = createTradingDataEncoder({
      format: 'json', metadata: golden.metadata, writable: sink.writable,
    });
    await encoder.start();
    await assert.rejects(encoder.writeBatch(golden.trades), /injected write failure/);
    await encoder.abort();
  });

  it('streams a large input as bounded batches', async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const encoder = createTradingDataEncoder({
      format: 'jsonl', metadata: { ...golden.metadata, total: 2500 }, writable: sink,
    });
    await encoder.start();
    for (let batch = 0; batch < 25; batch += 1) {
      await encoder.writeBatch(Array.from({ length: 100 }, (_, index) => ({
        ...golden.trades[0], report_index: batch * 100 + index,
      })));
    }
    const stats = await encoder.finish();
    assert.equal(stats.written_trades, 2500);
  });

  it('loads the golden fixture from the repository', () => {
    assert.match(fileURLToPath(new URL(
      './fixtures/strategy-trading/format-golden.json', import.meta.url,
    )), /format-golden\.json$/);
  });
});
