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
    assert.ok(stdout.includes('select'));
    assert.ok(stdout.includes('report'));
    assert.ok(stdout.includes('orders'));
    assert.ok(stdout.includes('trades'));
    assert.ok(stdout.includes('equity'));
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
    assert.ok(stdout.includes('--pane-index'));
  });

  it('pane-scoped Study help exposes explicit Tab/Layout/Pane selectors', () => {
    const { stdout, exitCode } = run(['study', 'list', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--tab-index'));
    assert.ok(stdout.includes('--url-chart-id'));
    assert.ok(stdout.includes('--layout-id'));
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
