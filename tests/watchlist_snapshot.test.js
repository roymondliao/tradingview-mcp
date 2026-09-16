import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureNamedWatchlistSnapshot,
  normalizeAccountWatchlistDetail,
  readAccountWatchlistDetail,
  resolveNamedWatchlist,
  summarizeNamedWatchlistSnapshot,
  writeNamedWatchlistSnapshot,
} from '../src/core/watchlist.js';
import { registerWatchlistTools } from '../src/tools/watchlist.js';

const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    await rm(directory, { recursive: true, force: true });
  }
});

function inventoryItem(overrides = {}) {
  return {
    id: 101,
    watchlist_id: 101,
    name: 'dev-testing-list',
    symbol_count: 2,
    declared_symbol_count: 2,
    declared_entry_count: 2,
    separator_count: 0,
    active: false,
    ...overrides,
  };
}

function detail(symbols = ['TWSE:2330', 'TWSE:2317'], overrides = {}) {
  return normalizeAccountWatchlistDetail({
    id: 101,
    name: 'dev-testing-list',
    modified: '2026-09-16T00:00:00.000Z',
    symbols,
    ...overrides,
  });
}

function snapshotDeps({ reads, resolved = inventoryItem(), now = 1_700_000_000_000 } = {}) {
  const queue = [...reads];
  return {
    resolveNamedWatchlist: async () => resolved,
    readAccountWatchlistDetail: async () => queue.shift(),
    sleep: async () => {},
    now: () => now,
  };
}

describe('Named Watchlist exact-name resolution', () => {
  it('resolves exactly one case-sensitive Account name', async () => {
    const result = await resolveNamedWatchlist({
      name: 'dev-testing-list',
      _deps: {
        listWatchlists: async () => ({
          lists: [inventoryItem(), inventoryItem({ id: 202, watchlist_id: 202, name: 'DEV-TESTING-LIST' })],
        }),
      },
    });
    assert.equal(result.watchlist_id, 101);
  });

  it('rejects missing and duplicate exact names', async () => {
    await assert.rejects(() => resolveNamedWatchlist({
      name: 'missing',
      _deps: { listWatchlists: async () => ({ lists: [inventoryItem()] }) },
    }), (error) => error.code === 'WATCHLIST_NOT_FOUND');

    await assert.rejects(() => resolveNamedWatchlist({
      name: 'dev-testing-list',
      _deps: { listWatchlists: async () => ({ lists: [inventoryItem(), inventoryItem({ id: 102 })] }) },
    }), (error) => error.code === 'WATCHLIST_AMBIGUOUS');
  });

  it('wraps inventory provider failures with a structured capability error', async () => {
    await assert.rejects(() => resolveNamedWatchlist({
      name: 'dev-testing-list',
      _deps: { listWatchlists: async () => { throw new Error('schema changed'); } },
    }), (error) => error.code === 'WATCHLIST_SNAPSHOT_UNSUPPORTED' && error.retryable === true);
  });
});

describe('Account Watchlist detail provider', () => {
  it('uses the same-origin detail endpoint and filters section entries', async () => {
    let requestedPath = null;
    const result = await readAccountWatchlistDetail({
      watchlist_id: 101,
      _deps: {
        fetchAccountWatchlistDetail: async (path) => {
          requestedPath = path;
          return {
            ok: true,
            status: 200,
            data: {
              id: 101,
              name: 'dev-testing-list',
              modified: '2026-09-16T00:00:00.000Z',
              symbols: ['###Taiwan', 'TWSE:2330', 'TWSE:2317'],
            },
          };
        },
      },
    });
    assert.equal(requestedPath, '/api/v1/symbols_list/custom/101/');
    assert.equal(result.entry_count, 3);
    assert.equal(result.separator_count, 1);
    assert.deepEqual(result.symbols, ['TWSE:2330', 'TWSE:2317']);
  });

  it('returns structured unsupported errors for provider and schema failures', async () => {
    await assert.rejects(() => readAccountWatchlistDetail({
      watchlist_id: 101,
      _deps: {
        fetchAccountWatchlistDetail: async () => ({ ok: false, status: 503, body: 'Unavailable' }),
      },
    }), (error) => error.code === 'WATCHLIST_SNAPSHOT_UNSUPPORTED' && error.retryable === true);

    assert.throws(
      () => normalizeAccountWatchlistDetail({ id: 101, name: 'Broken', modified: 'now' }),
      (error) => error.code === 'WATCHLIST_SNAPSHOT_UNSUPPORTED',
    );
  });
});

describe('Complete named Watchlist Snapshot', () => {
  it('captures two stable ordered reads with deterministic identities', async () => {
    const first = detail();
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list',
      _deps: snapshotDeps({ reads: [first, first] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.snapshot.complete, true);
    assert.equal(result.snapshot.stable_reads, 2);
    assert.equal(result.snapshot.read_attempts, 2);
    assert.equal(result.snapshot.returned_symbol_count, 2);
    assert.match(result.snapshot.snapshot_id, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.snapshot.ordered_symbol_fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.snapshot.captured_at_iso, '2023-11-14T22:13:20.000Z');
    assert.deepEqual(result.symbols, ['TWSE:2330', 'TWSE:2317']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.symbols), true);

    const later = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list',
      _deps: snapshotDeps({ reads: [first, first], now: 1_800_000_000_000 }),
    });
    assert.equal(later.snapshot.snapshot_id, result.snapshot.snapshot_id);
  });

  it('accepts an eventually stable consecutive pair', async () => {
    const first = detail(['TWSE:2330'], { modified: 'v1' });
    const second = detail(['TWSE:2330', 'TWSE:2317'], { modified: 'v2' });
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list',
      _deps: snapshotDeps({ reads: [first, second, second] }),
    });
    assert.equal(result.snapshot.read_attempts, 3);
  });

  it('retries a transient detail provider failure and still requires two consecutive reads', async () => {
    const stable = detail();
    let calls = 0;
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list',
      _deps: {
        resolveNamedWatchlist: async () => inventoryItem(),
        readAccountWatchlistDetail: async () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('temporary provider failure');
            error.code = 'WATCHLIST_SNAPSHOT_UNSUPPORTED';
            error.retryable = true;
            throw error;
          }
          return stable;
        },
        sleep: async () => {},
        now: () => 1_700_000_000_000,
      },
    });
    assert.equal(result.snapshot.read_attempts, 3);
    assert.equal(calls, 3);
  });

  it('rejects a sequence that never stabilizes', async () => {
    const reads = ['v1', 'v2', 'v3', 'v4'].map((modified, index) => (
      detail(['TWSE:2330', 'TWSE:2317'], { modified: `${modified}-${index}` })
    ));
    await assert.rejects(() => captureNamedWatchlistSnapshot({
      name: 'dev-testing-list', _deps: snapshotDeps({ reads }),
    }), (error) => error.code === 'WATCHLIST_SNAPSHOT_UNSTABLE' && error.retryable === true);
  });

  it('rejects count mismatches, invalid Symbols, and duplicates', async () => {
    const cases = [
      {
        reads: [detail(['TWSE:2330']), detail(['TWSE:2330'])],
        code: 'WATCHLIST_INCOMPLETE',
      },
      {
        reads: [detail(['2330', 'TWSE:2317']), detail(['2330', 'TWSE:2317'])],
        code: 'WATCHLIST_INVALID_SYMBOLS',
      },
      {
        reads: [detail(['TWSE:2330', 'TWSE:2330']), detail(['TWSE:2330', 'TWSE:2330'])],
        code: 'WATCHLIST_DUPLICATE_SYMBOLS',
      },
    ];
    for (const current of cases) {
      await assert.rejects(() => captureNamedWatchlistSnapshot({
        name: 'dev-testing-list', _deps: snapshotDeps({ reads: current.reads }),
      }), (error) => error.code === current.code);
    }
  });

  it('accepts a stable empty Watchlist as complete', async () => {
    const empty = detail([]);
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list',
      _deps: snapshotDeps({ reads: [empty, empty], resolved: inventoryItem({
        symbol_count: 0, declared_symbol_count: 0, declared_entry_count: 0,
      }) }),
    });
    assert.equal(result.snapshot.complete, true);
    assert.equal(result.snapshot.returned_symbol_count, 0);
  });

  it('returns a bounded summary without the complete symbols array', async () => {
    const current = detail();
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list', _deps: snapshotDeps({ reads: [current, current] }),
    });
    const summary = summarizeNamedWatchlistSnapshot(result, { sample_size: 1 });
    assert.equal(Object.hasOwn(summary, 'symbols'), false);
    assert.deepEqual(summary.symbol_sample, { first: ['TWSE:2330'], last: ['TWSE:2317'] });
  });
});

describe('Named Watchlist atomic JSON output', () => {
  it('writes the full Snapshot, rejects existing output, and supports force', async () => {
    const current = detail();
    const result = await captureNamedWatchlistSnapshot({
      name: 'dev-testing-list', _deps: snapshotDeps({ reads: [current, current] }),
    });
    const directory = await mkdtemp(join(tmpdir(), 'tv-watchlist-snapshot-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'snapshot.json');

    const first = await writeNamedWatchlistSnapshot({ result, output });
    assert.equal(first.output.atomic, true);
    assert.equal(first.output.written_symbols, 2);
    assert.equal(Object.hasOwn(first, 'symbols'), false);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);

    await assert.rejects(
      () => writeNamedWatchlistSnapshot({ result, output }),
      (error) => error.code === 'OUTPUT_ALREADY_EXISTS',
    );
    const replaced = await writeNamedWatchlistSnapshot({ result, output, force: true });
    assert.equal(replaced.output.atomic, true);
  });
});

describe('Watchlist MCP registration', () => {
  it('registers a bounded named Snapshot tool', () => {
    const tools = [];
    registerWatchlistTools({
      tool(name, description, schema, handler) {
        tools.push({ name, description, schema, handler });
      },
    });
    const snapshot = tools.find((tool) => tool.name === 'watchlist_snapshot');
    assert.ok(snapshot);
    assert.ok(snapshot.schema.name);
    assert.match(snapshot.description, /complete, stable named Account Watchlist/);
  });
});
