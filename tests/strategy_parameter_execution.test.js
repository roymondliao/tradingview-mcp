import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createParameterSetExecutionPlan,
  effectiveInputsFingerprint,
  executeParameterSets,
  ParameterSetExecutionError,
  planParameterSets,
} from '../src/core/strategy-parameter-sets.js';
import { CoreOperationError } from '../src/core/errors.js';

const context = Object.freeze({
  target_id: 'target-1',
  url_chart_id: 'chart-1',
  layout_id: 'chart-1',
  saved_layout_id: 101,
  pane_layout: 's',
  pane_index: 0,
  pane_id: '1',
  symbol: 'TWSE_DLY:2330',
  resolution: '1D',
});

const identity = Object.freeze({
  entity_id: 'strategy-1',
  script_id: 'USER;strategy-1',
  version: '3.0',
  source_sha256: 'source-hash',
});

function candidateSchema() {
  return {
    available: true,
    input_schema_fingerprint: 'candidate-schema',
    inputs: [
      { name: 'Length', runtime_value_type: 'int', constraints: { min: 1, max: 20 } },
      { name: 'Enabled', runtime_value_type: 'bool', constraints: {} },
    ],
  };
}

function baseInputs() {
  return [
    {
      id: 'in_7', name: 'Length', name_selectable: true,
      type: 'integer', value: 10, constraints: { min: 1, max: 20 },
    },
    {
      id: 'in_3', name: 'Enabled', name_selectable: true,
      type: 'boolean', value: true, constraints: {},
    },
    {
      id: 'in_20', name: 'Runtime property', name_selectable: true,
      type: 'integer', value: 20, constraints: { min: 0, max: 100 },
    },
  ];
}

function cloneInputs(inputs) {
  return inputs.map((input) => ({
    ...input,
    constraints: { ...(input.constraints || {}) },
  }));
}

function executionFixture(hooks = {}) {
  const state = {
    identity: { ...identity },
    inputs: cloneInputs(baseInputs()),
    events: [],
    generation: 0,
    now: 1700000000000,
    waitCalls: 0,
  };
  function fingerprint() {
    return effectiveInputsFingerprint(state.inputs);
  }
  const deps = {
    withChartSession: async (_options, operation) => operation({ context }),
    assertPaneContext: async ({ phase }) => {
      state.events.push(`context:${phase}`);
      if (hooks.contextError?.(phase)) throw hooks.contextError(phase);
      return { symbol: context.symbol, resolution: context.resolution };
    },
    readTargetPaneStudies: async () => ({
      target_id: context.target_id,
      pane_index: context.pane_index,
      symbol: context.symbol,
      timeframe: context.resolution,
      studies: [{
        entity_id: state.identity.entity_id,
        script_id: state.identity.script_id,
        version: state.identity.version,
        type: 'strategy',
        inputs: cloneInputs(state.inputs),
        inputs_fingerprint: fingerprint(),
      }],
    }),
    ensureStrategyActive: async () => ({ success: true }),
    readRawReportState: async () => ({
      runtime_signature: `runtime-${state.generation}`,
      inputs_fingerprint: fingerprint(),
      snapshot_candidate: {
        inputs_fingerprint: fingerprint(),
        metrics: { total_net_profit: 100, total_trades: 5 },
      },
      report_available: true,
      status_type: 2,
    }),
    setStudyInputs: async ({ inputs }) => {
      const call = Object.freeze({ ...inputs });
      state.events.push({ set: call });
      if (hooks.setError?.(call, state)) throw hooks.setError(call, state);
      if (!hooks.ignoreSet?.(call, state)) {
        for (const input of state.inputs) {
          if (Object.hasOwn(inputs, input.id)) input.value = inputs[input.id];
        }
        state.generation += 1;
      }
      return { success: true, inputs_fingerprint: fingerprint() };
    },
    waitForFreshTradingReport: async ({ before, mutated }) => {
      state.waitCalls += 1;
      state.events.push({ wait: { before: before.runtime_signature, mutated } });
      if (hooks.waitError?.(state.waitCalls, state)) throw hooks.waitError(state.waitCalls, state);
      return {
        success: true,
        fresh: mutated,
        transition_observed: mutated,
        stable_reads: 2,
        runtime_signature: `runtime-${state.generation}`,
        inputs_fingerprint: fingerprint(),
        snapshot_candidate: {
          inputs_fingerprint: fingerprint(),
          metrics: { total_net_profit: 100, total_trades: 5 },
        },
      };
    },
    now: () => {
      const value = state.now;
      state.now += 1000;
      return value;
    },
  };
  return { state, deps };
}

function parameterSets() {
  return [
    { name: 'baseline', inputs: {} },
    { name: 'fast', inputs: { Length: 5 } },
    { name: 'property-test', inputs: { Enabled: false } },
  ];
}

describe('Parameter Set execution planning', () => {
  it('keeps declared ordering and builds every Effective Inputs set from the same Base', () => {
    const result = createParameterSetExecutionPlan({
      base_catalog: baseInputs(),
      candidate_schema: candidateSchema(),
      parameter_sets: parameterSets(),
      identity,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.parameter_sets.map((set) => set.name), [
      'baseline', 'fast', 'property-test',
    ]);
    assert.deepEqual(
      result.parameter_sets.map((set) => set.effective_inputs.map((input) => input.value)),
      [[10, true, 20], [5, true, 20], [10, false, 20]],
    );
    assert.equal(result.parameter_sets[0].inputs_fingerprint.value, result.base_inputs_fingerprint.value);
  });

  it('maps exact names to reordered Runtime IDs', () => {
    const result = createParameterSetExecutionPlan({
      base_catalog: baseInputs(),
      candidate_schema: candidateSchema(),
      parameter_sets: [{ name: 'mapped', inputs: { Enabled: false, Length: 7 } }],
      identity,
    });
    assert.deepEqual(result.parameter_sets[0].resolved_inputs.map(({ name, id }) => ({ name, id })), [
      { name: 'Enabled', id: 'in_3' },
      { name: 'Length', id: 'in_7' },
    ]);
  });

  it('rejects empty, duplicate, and non-path-safe Parameter Set names', () => {
    const empty = planParameterSets({
      base_catalog: baseInputs(), candidate_schema: candidateSchema(), parameter_sets: [],
    });
    assert.equal(empty.errors[0].code, 'PARAMETER_SETS_REQUIRED');

    const invalid = planParameterSets({
      base_catalog: baseInputs(),
      candidate_schema: candidateSchema(),
      parameter_sets: [
        { name: 'same', inputs: {} },
        { name: 'same', inputs: {} },
        { name: '../unsafe', inputs: {} },
      ],
    });
    assert.deepEqual(invalid.errors.map((error) => error.code), [
      'PARAMETER_SET_NAME_DUPLICATE', 'PARAMETER_SET_NAME_INVALID',
    ]);
  });

  it('creates deterministic Experiment IDs independent of timestamps', () => {
    const args = {
      base_catalog: baseInputs(), candidate_schema: candidateSchema(),
      parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }], identity,
    };
    const first = createParameterSetExecutionPlan(args);
    const second = createParameterSetExecutionPlan(args);
    assert.equal(first.parameter_sets[0].experiment_id, second.parameter_sets[0].experiment_id);
    assert.match(first.parameter_sets[0].experiment_id, /^sha256:[a-f0-9]{64}$/);
  });
});

describe('Sequential Parameter Set execution and restore', () => {
  it('executes in order from Base, confirms stable Report, then restores Base Inputs', async () => {
    const fixture = executionFixture();
    const callbackOrder = [];
    const result = await executeParameterSets({
      candidate_schema: candidateSchema(),
      parameter_sets: parameterSets(),
      identity,
      context,
      _deps: fixture.deps,
    }, async (experiment) => {
      callbackOrder.push(experiment.parameter_set.name);
      assert.equal(experiment.report.stable_reads, 2);
      assert.deepEqual(experiment.report.snapshot_candidate.metrics, {
        total_net_profit: 100, total_trades: 5,
      });
      return { exported: experiment.parameter_set.name };
    });

    assert.deepEqual(callbackOrder, ['baseline', 'fast', 'property-test']);
    assert.equal(result.experiment_count, 3);
    assert.equal(result.experiments[0].mutation.mutated, false);
    assert.deepEqual(
      fixture.state.events.filter((event) => typeof event === 'object' && event.wait)[0].wait,
      { before: 'runtime-0', mutated: false },
    );
    assert.deepEqual(
      fixture.state.events.filter((event) => typeof event === 'object' && event.set).map((event) => event.set),
      [
        { in_7: 5 },
        { in_7: 10, in_3: false },
        { in_3: true },
      ],
    );
    assert.deepEqual(fixture.state.inputs.map((input) => input.value), [10, true, 20]);
    assert.equal(result.restore.restored, true);
  });

  it('records Unix and ISO timestamps while keeping same-metric reports valid', async () => {
    const fixture = executionFixture();
    const result = await executeParameterSets({
      candidate_schema: candidateSchema(),
      parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
      identity,
      context,
      _deps: fixture.deps,
    }, async () => ({ exported: true }));
    const experiment = result.experiments[0].experiment;
    assert.equal(experiment.started_at, 1700000000000);
    assert.equal(experiment.started_at_iso, '2023-11-14T22:13:20.000Z');
    assert.equal(experiment.completed_at, 1700000001000);
    assert.equal(experiment.completed_at_iso, '2023-11-14T22:13:21.000Z');
    assert.equal(experiment.report.fresh, true);
  });

  it('restores Base Inputs after an operation failure and reports completed progress', async () => {
    const fixture = executionFixture();
    await assert.rejects(
      executeParameterSets({
        candidate_schema: candidateSchema(),
        parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
        identity,
        context,
        _deps: fixture.deps,
      }, async () => { throw new Error('export failed'); }),
      (error) => {
        assert.ok(error instanceof ParameterSetExecutionError);
        assert.equal(error.parameter_set, 'fast');
        assert.equal(error.restore.success, true);
        assert.equal(error.execution_state.completed_experiments, 0);
        return true;
      },
    );
    assert.deepEqual(fixture.state.inputs.map((input) => input.value), [10, true, 20]);
  });

  it('detects callback or external Input interference and restores Base', async () => {
    const fixture = executionFixture();
    await assert.rejects(
      executeParameterSets({
        candidate_schema: candidateSchema(),
        parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
        identity,
        context,
        _deps: fixture.deps,
      }, async () => {
        fixture.state.inputs[1].value = false;
        return { exported: true };
      }),
      (error) => error.code === 'PARAMETER_SET_INPUT_FINGERPRINT_MISMATCH'
        && error.restore.success === true,
    );
    assert.deepEqual(fixture.state.inputs.map((input) => input.value), [10, true, 20]);
  });

  it('restores Base Inputs after a calculation timeout', async () => {
    const fixture = executionFixture({
      waitError: (call) => call === 1
        ? new CoreOperationError('calculation timed out', {
          code: 'STRATEGY_CALCULATION_TIMEOUT', phase: 'strategy_calculation', retryable: true,
        })
        : null,
    });
    await assert.rejects(
      executeParameterSets({
        candidate_schema: candidateSchema(),
        parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
        identity,
        context,
        _deps: fixture.deps,
      }, async () => ({ exported: true })),
      (error) => error.code === 'STRATEGY_CALCULATION_TIMEOUT'
        && error.restore.success === true
        && error.retryable === true,
    );
    assert.deepEqual(fixture.state.inputs.map((input) => input.value), [10, true, 20]);
  });

  it('makes restore mismatch the final run failure', async () => {
    let setCalls = 0;
    const fixture = executionFixture({
      ignoreSet: () => {
        setCalls += 1;
        return setCalls === 2;
      },
    });
    await assert.rejects(
      executeParameterSets({
        candidate_schema: candidateSchema(),
        parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
        identity,
        context,
        _deps: fixture.deps,
      }, async () => ({ exported: true })),
      (error) => error.code === 'PARAMETER_SET_RESTORE_FAILED'
        && error.restore.success === false,
    );
    assert.equal(fixture.state.inputs[0].value, 5);
  });

  it('stops on fixed Strategy identity changes without mutating a replacement', async () => {
    const fixture = executionFixture();
    await assert.rejects(
      executeParameterSets({
        candidate_schema: candidateSchema(),
        parameter_sets: [{ name: 'baseline', inputs: {} }],
        identity,
        context,
        _deps: fixture.deps,
      }, async () => {
        fixture.state.identity.version = '4.0';
        return { exported: true };
      }),
      (error) => error.code === 'PARAMETER_SET_RESTORE_FAILED'
        && error.execution_state.original_error.code === 'PARAMETER_SET_STRATEGY_CHANGED',
    );
    assert.equal(fixture.state.events.some((event) => typeof event === 'object' && event.set), false);
  });
});
