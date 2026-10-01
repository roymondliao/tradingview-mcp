import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runStrategyDurableBenchmark,
  STRATEGY_DURABLE_BENCHMARK_PARAMETER_SET_COUNT,
  STRATEGY_DURABLE_BENCHMARK_SYMBOL_COUNT,
  STRATEGY_DURABLE_BENCHMARK_THRESHOLDS,
} from '../scripts/strategy-durable-benchmark.js';

describe('Strategy durable filesystem benchmark harness', () => {
  it('exercises transitions, atomic attempts, audit, planning, and finalization without Desktop', async () => {
    const result = await runStrategyDurableBenchmark({
      symbol_count: 3,
      parameter_set_count: 2,
      repetitions: 1,
      measure_only: true,
    });
    assert.deepEqual(result.shape, {
      symbols: 3,
      parameter_sets: 2,
      symbol_executions: 6,
      repetitions: 1,
    });
    assert.equal(result.repetitions[0].symbols_succeeded, 6);
    assert.equal(result.repetitions[0].experiments_succeeded, 2);
    assert.ok(result.summary.max_bytes_written > result.summary.max_final_disk_bytes);
    assert.ok(result.summary.max_manifest_bytes > 0);
    assert.equal(result.thresholds_enforced, false);
  });

  it('pins the delivery-gate workload shape at 652 x 3', () => {
    assert.equal(STRATEGY_DURABLE_BENCHMARK_SYMBOL_COUNT, 652);
    assert.equal(STRATEGY_DURABLE_BENCHMARK_PARAMETER_SET_COUNT, 3);
    assert.equal(
      Object.values(STRATEGY_DURABLE_BENCHMARK_THRESHOLDS)
        .every((maximum) => Number.isFinite(maximum) && maximum > 0),
      true,
    );
  });
});
