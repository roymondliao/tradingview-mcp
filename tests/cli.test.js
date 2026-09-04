/**
 * CLI unit tests — no TradingView connection needed.
 * Tests: help output, pine analyze, pine check, error handling, exit codes.
 *
 * Run: node --test tests/cli.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resultExitCode } from '../src/cli/router.js';

function require_fs() { return { writeFileSync, unlinkSync }; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
const RUN_NETWORK_TESTS = process.env.TV_RUN_NETWORK_TESTS === '1';

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('CLI — help and routing', () => {
  it('maps partial and CDP result summaries to stable process exit codes', () => {
    assert.equal(resultExitCode({ success: true }), 0);
    assert.equal(resultExitCode({ success: false, failure_kind: 'partial' }), 1);
    assert.equal(resultExitCode({ success: false, failure_kind: 'cdp_connection' }), 2);
  });

  it('--help shows command list', () => {
    const { stdout, exitCode } = run(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
    assert.ok(stdout.includes('status'));
    assert.ok(stdout.includes('pine'));
    assert.ok(stdout.includes('quote'));
    assert.ok(stdout.includes('history'));
  });

  it('-h is same as --help', () => {
    const { stdout, exitCode } = run(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('no args shows help', () => {
    const { stdout, exitCode } = run([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('--version matches package.json', () => {
    const { stdout, exitCode } = run(['--version']);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), PACKAGE_VERSION);
  });

  it('unknown command exits 1', () => {
    const { exitCode, stderr } = run(['nonexistent']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });

  it('pine --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pine', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('create'));
    assert.ok(stdout.includes('update'));
    assert.ok(stdout.includes('delete'));
    assert.ok(stdout.includes('set'));
    assert.ok(stdout.includes('compile'));
    assert.ok(stdout.includes('analyze'));
    assert.ok(stdout.includes('check'));
  });

  it('pine delete refuses non-interactive execution without --yes', () => {
    const { stderr, exitCode } = run(['pine', 'delete', '--script-id', 'USER;test']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /without --yes/);
  });

  it('study --help shows read-only Study commands', () => {
    const { stdout, exitCode } = run(['study', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('search'));
    assert.ok(stdout.includes('list'));
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('inputs'));
    assert.ok(stdout.includes('toggle'));
    assert.ok(stdout.includes('remove'));
  });

  it('strategy --help shows explicit Strategy Tester commands', () => {
    const { stdout, exitCode } = run(['strategy', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('active'));
    assert.ok(stdout.includes('trading-report'));
    assert.ok(stdout.includes('trading-data'));
    assert.ok(stdout.includes('trading-export'));
    assert.ok(stdout.includes('select'));
    assert.ok(stdout.includes('report'));
    assert.ok(stdout.includes('orders'));
    assert.ok(stdout.includes('trades'));
    assert.ok(stdout.includes('equity'));
  });

  it('strategy trading-data help exposes Offset/Limit/Snapshot pagination', () => {
    const { stdout, exitCode } = run(['strategy', 'trading-data', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('<entity-id>'));
    assert.ok(stdout.includes('--symbol'));
    assert.ok(stdout.includes('--offset'));
    assert.ok(stdout.includes('--limit'));
    assert.ok(stdout.includes('--snapshot-id'));
    assert.ok(stdout.includes('--format'));
    assert.ok(stdout.includes('--output'));
    assert.ok(stdout.includes('--force'));
    assert.ok(stdout.includes('--layout-id'));
    assert.ok(stdout.includes('--saved-layout-id'));
    assert.ok(stdout.includes('--pane-index'));
  });

  it('strategy trading-data validates pagination before CDP discovery', () => {
    const missingSnapshot = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344', '--offset', '1',
    ]);
    assert.equal(missingSnapshot.exitCode, 1);
    assert.equal(JSON.parse(missingSnapshot.stderr).code, 'STALE_STRATEGY_SNAPSHOT');
    const invalidOffset = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344', '--offset', '-1',
    ]);
    assert.equal(invalidOffset.exitCode, 1);
    assert.equal(JSON.parse(invalidOffset.stderr).code, 'STRATEGY_RUNTIME_INVALID');
    const invalidLimit = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344', '--limit', '5001',
    ]);
    assert.equal(invalidLimit.exitCode, 1);
    assert.equal(JSON.parse(invalidLimit.stderr).code, 'STRATEGY_RUNTIME_INVALID');
    const unsupportedFormat = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344', '--format', 'xlsx',
    ]);
    assert.equal(unsupportedFormat.exitCode, 1);
    assert.equal(JSON.parse(unsupportedFormat.stderr).code, 'OUTPUT_FORMAT_UNSUPPORTED');
    const extensionMismatch = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344',
      '--format', 'csv', '--output', 'trades.json',
    ]);
    assert.equal(extensionMismatch.exitCode, 1);
    assert.equal(JSON.parse(extensionMismatch.stderr).code, 'OUTPUT_FORMAT_EXTENSION_MISMATCH');
    const forceWithoutOutput = run([
      'strategy', 'trading-data', 'strategy-1', '--symbol', 'TWSE:2344', '--force',
    ]);
    assert.equal(forceWithoutOutput.exitCode, 1);
    assert.equal(JSON.parse(forceWithoutOutput.stderr).code, 'OUTPUT_WRITE_FAILED');
  });

  it('strategy trading-report help exposes required Symbol and context options', () => {
    const { stdout, exitCode } = run(['strategy', 'trading-report', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('<entity-id>'));
    assert.ok(stdout.includes('--symbol'));
    assert.ok(stdout.includes('--timeframe'));
    assert.ok(stdout.includes('--timeout'));
    assert.ok(stdout.includes('--tab-index'));
    assert.ok(stdout.includes('--layout-id'));
    assert.ok(stdout.includes('--saved-layout-id'));
    assert.ok(stdout.includes('--pane-index'));
  });

  it('strategy trading-report rejects missing required inputs before CDP discovery', () => {
    const missingEntity = run(['strategy', 'trading-report', '--symbol', 'TWSE:2344']);
    assert.equal(missingEntity.exitCode, 1);
    assert.equal(JSON.parse(missingEntity.stderr).code, 'STRATEGY_ENTITY_REQUIRED');
    const missingSymbol = run(['strategy', 'trading-report', 'strategy-1']);
    assert.equal(missingSymbol.exitCode, 1);
    assert.equal(JSON.parse(missingSymbol.stderr).code, 'SYMBOL_REQUIRED');
    const invalidSymbol = run(['strategy', 'trading-report', 'strategy-1', '--symbol', '2344']);
    assert.equal(invalidSymbol.exitCode, 1);
    assert.equal(JSON.parse(invalidSymbol.stderr).code, 'SYMBOL_INVALID');
    const invalidTimeout = run([
      'strategy', 'trading-report', 'strategy-1', '--symbol', 'TWSE:2344', '--timeout', 'forever',
    ]);
    assert.equal(invalidTimeout.exitCode, 1);
    assert.equal(JSON.parse(invalidTimeout.stderr).code, 'STRATEGY_RUNTIME_INVALID');
  });

  it('strategy trading-export help exposes Symbol and Active Watchlist options', () => {
    const { stdout, exitCode } = run(['strategy', 'trading-export', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('<entity-id>'));
    assert.ok(stdout.includes('--symbol'));
    assert.ok(stdout.includes('--watchlist'));
    assert.ok(stdout.includes('--timeframe'));
    assert.ok(stdout.includes('--output'));
    assert.ok(stdout.includes('--format'));
    assert.ok(stdout.includes('--force'));
    assert.ok(stdout.includes('--fail-fast'));
    assert.ok(stdout.includes('--timeout'));
    assert.ok(stdout.includes('--layout-id'));
    assert.ok(stdout.includes('--pane-index'));
  });

  it('strategy trading-export validates required inputs before CDP discovery', () => {
    const missingEntity = run([
      'strategy', 'trading-export', '--symbol', 'TWSE:2344', '--output', '/tmp/export',
    ]);
    assert.equal(missingEntity.exitCode, 1);
    assert.equal(JSON.parse(missingEntity.stderr).code, 'STRATEGY_ENTITY_REQUIRED');
    const missingScope = run([
      'strategy', 'trading-export', 'strategy-1', '--output', '/tmp/export',
    ]);
    assert.equal(missingScope.exitCode, 1);
    assert.equal(JSON.parse(missingScope.stderr).code, 'TRADING_EXPORT_SCOPE_INVALID');
    const missingOutput = run([
      'strategy', 'trading-export', 'strategy-1', '--symbol', 'TWSE:2344',
    ]);
    assert.equal(missingOutput.exitCode, 1);
    assert.equal(JSON.parse(missingOutput.stderr).code, 'OUTPUT_WRITE_FAILED');
    const invalidFormat = run([
      'strategy', 'trading-export', 'strategy-1', '--symbol', 'TWSE:2344',
      '--output', '/tmp/export', '--format', 'xlsx',
    ]);
    assert.equal(invalidFormat.exitCode, 1);
    assert.equal(JSON.parse(invalidFormat.stderr).code, 'OUTPUT_FORMAT_UNSUPPORTED');

    const conflictingScope = run([
      'strategy', 'trading-export', 'strategy-1', '--symbol', 'TWSE:2344',
      '--watchlist', 'active', '--output', '/tmp/export',
    ]);
    assert.equal(conflictingScope.exitCode, 1);
    assert.equal(JSON.parse(conflictingScope.stderr).code, 'TRADING_EXPORT_SCOPE_INVALID');

    const unsupportedWatchlist = run([
      'strategy', 'trading-export', 'strategy-1', '--watchlist', 'favorites',
      '--output', '/tmp/export',
    ]);
    assert.equal(unsupportedWatchlist.exitCode, 1);
    assert.equal(JSON.parse(unsupportedWatchlist.stderr).code, 'WATCHLIST_SCOPE_UNSUPPORTED');

    const misplacedFailFast = run([
      'strategy', 'trading-export', 'strategy-1', '--symbol', 'TWSE:2344',
      '--output', '/tmp/export', '--fail-fast',
    ]);
    assert.equal(misplacedFailFast.exitCode, 1);
    assert.equal(JSON.parse(misplacedFailFast.stderr).code, 'TRADING_EXPORT_SCOPE_INVALID');
  });

  it('ohlcv --help shows options', () => {
    const { stdout, exitCode } = run(['ohlcv', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--count'));
    assert.ok(stdout.includes('--summary'));
  });

  it('history --help shows batch loading and output options', () => {
    const { stdout, exitCode } = run(['history', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--bars-per-request'));
    assert.ok(stdout.includes('--max-requests'));
    assert.ok(stdout.includes('--include-bars'));
    assert.ok(stdout.includes('--output'));
    assert.ok(stdout.includes('--force'));
    assert.ok(stdout.includes('--layout-id'));
    assert.ok(stdout.includes('--saved-layout-id'));
    assert.ok(stdout.includes('--pane-index'));
  });

  it('pane-scoped Study help exposes explicit Tab/Layout/Pane selectors', () => {
    const { stdout, exitCode } = run(['study', 'list', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--tab-index'));
    assert.ok(stdout.includes('--url-chart-id'));
    assert.ok(stdout.includes('--layout-id'));
    assert.ok(stdout.includes('--saved-layout-id'));
    assert.ok(stdout.includes('--pane-index'));
  });

  it('history rejects removed page terminology before connecting', () => {
    const { stderr, exitCode } = run(['history', '--page-size', '1000']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--bars-per-request/);
  });

  it('CDP failures return structured JSON and exit code 2', () => {
    const { stderr, exitCode } = run(['status'], {
      env: {
        ...process.env,
        TV_CDP_PORT: '9',
        TV_CDP_DISCOVERY_TIMEOUT_MS: '25',
        TV_CDP_TOTAL_TIMEOUT_MS: '100',
      },
    });
    assert.equal(exitCode, 2);
    const result = JSON.parse(stderr);
    assert.equal(result.success, false);
    assert.match(result.code, /^CDP_/);
    assert.ok(result.stage);
  });
});

describe('CLI — pine analyze (offline)', () => {
  it('analyzes clean v6 script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.issue_count, 0);
  });

  it('detects array out of bounds', () => {
    const source = '//@version=6\nindicator("test")\narr = array.from(1, 2, 3)\nval = array.get(arr, 5)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.issue_count, 1);
    assert.ok(result.diagnostics[0].message.includes('out of bounds'));
  });

  it('detects strategy.entry without strategy()', () => {
    const source = '//@version=6\nindicator("test")\nstrategy.entry("long", strategy.long)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.diagnostics.some(d => d.message.includes('strategy()')));
  });

  it('errors without input', () => {
    // When stdin is a TTY (no pipe), analyze should error
    const { exitCode, stderr } = run(['pine', 'analyze']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('No source provided'));
  });

  it('reads --file flag', () => {
    const { writeFileSync, unlinkSync } = require_fs();
    const tmpFile = join(__dirname, '_test_script.pine');
    writeFileSync(tmpFile, '//@version=6\nindicator("test")\nplot(close)');
    try {
      const { stdout, exitCode } = run(['pine', 'analyze', '--file', tmpFile]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.success, true);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe('CLI — pine check (server compile)', { skip: !RUN_NETWORK_TESTS }, () => {
  it('compiles valid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns errors for invalid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(nonexistent_var)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });
});
