import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStrategyProgressRenderer,
  formatStrategyProgress,
  formatStrategyStatus,
} from '../src/cli/progress.js';

function event(overrides = {}) {
  return {
    processed: 0,
    total: 10,
    succeeded: 0,
    failed: 0,
    experiment: { index: 1, count: 3, name: 'baseline' },
    ...overrides,
  };
}

describe('Strategy CLI progress formatter', () => {
  it('formats fixed process information without percentage details', () => {
    const line = formatStrategyStatus({ stage: 'validating_watchlist' });
    assert.equal(line, 'Process: Validating Watchlist Symbols...');
    assert.doesNotMatch(line, /%|processed|succeeded|failed/);
  });

  it('formats 0%, intermediate, and 100% in the required information order', () => {
    const zero = formatStrategyProgress(event(), { columns: 160, unicode: false });
    assert.match(zero, /0\.0%  0\/10 processed \| Experiment 1\/3: baseline \| succeeded 0 \| failed 0$/);
    const middle = formatStrategyProgress(event({
      processed: 892, total: 1304, succeeded: 891, failed: 1,
      experiment: { index: 2, count: 3, name: 'candidate-check' },
    }), { columns: 160 });
    assert.match(middle, /68\.4%  892\/1304 processed \| Experiment 2\/3: candidate-check \| succeeded 891 \| failed 1$/);
    const complete = formatStrategyProgress(event({
      processed: 10, succeeded: 8, failed: 2,
    }), { columns: 160 });
    assert.match(complete, /100\.0%  10\/10 processed .* succeeded 8 \| failed 2$/);
  });

  it('keeps all required labels in a narrow terminal and removes control characters', () => {
    const line = formatStrategyProgress(event({
      experiment: { index: 2, count: 3, name: 'candidate\r\n\u001b[31mcheck' },
    }), { columns: 30, unicode: false });
    assert.doesNotMatch(line, /[\r\n\u001b]/);
    assert.match(line, /processed/);
    assert.match(line, /Experiment 2\/3:/);
    assert.match(line, /succeeded 0/);
    assert.match(line, /failed 0/);
  });
});

describe('Strategy CLI progress renderer', () => {
  it('uses carriage-return updates and finishes with exactly one newline', () => {
    const writes = [];
    const stream = {
      isTTY: true,
      columns: 140,
      write(value) { writes.push(value); },
    };
    const renderer = createStrategyProgressRenderer({ stream, unicode: false });
    renderer.status({ stage: 'validating_watchlist' });
    renderer.update(event());
    renderer.update(event({ processed: 1, succeeded: 1 }));
    renderer.finish();
    renderer.finish();
    assert.equal(renderer.enabled, true);
    assert.match(writes[0], /Process: Validating Watchlist Symbols/);
    assert.equal(writes.filter((value) => value === '\n').length, 1);
    assert.ok(writes.slice(0, -1).every((value) => value.startsWith('\r')));
    assert.ok(writes.slice(0, -1).every((value) => !value.includes('\n')));
  });

  it('does not write for non-TTY streams and isolates writer failures', () => {
    const writes = [];
    const nonTty = createStrategyProgressRenderer({
      stream: { isTTY: false, write(value) { writes.push(value); } },
    });
    nonTty.update(event());
    nonTty.finish();
    assert.deepEqual(writes, []);

    const broken = createStrategyProgressRenderer({
      stream: { isTTY: true, columns: 80, write() { throw new Error('closed'); } },
    });
    assert.doesNotThrow(() => broken.update(event()));
    assert.doesNotThrow(() => broken.finish());
  });
});
