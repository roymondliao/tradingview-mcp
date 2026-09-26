import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareInputSchemas, planParameterSets } from '../src/core/strategy-parameter-sets.js';

function candidate(inputs) {
  return { available: true, inputs };
}

describe('Strategy Parameter Set planning', () => {
  it('resolves exact names and validates Candidate and Runtime constraints', () => {
    const schema = candidate([{
      name: 'Length', runtime_value_type: 'int', constraints: { min: 1, max: 20, step: 1 },
    }]);
    const result = planParameterSets({
      candidate_schema: schema,
      base_catalog: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10, constraints: { min: 1, max: 20 } }],
      parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.parameter_sets[0].resolved_inputs[0], {
      name: 'Length', id: 'in_0', base_value: 10, requested_value: 5,
    });
    assert.equal(result.parameter_sets[0].runtime_validation, 'complete');
    assert.equal(result.parameter_sets[0].inputs_fingerprint.available, true);
    assert.equal(result.parameter_sets[0].inputs_fingerprint.count, 1);
    assert.equal('effective_inputs' in result.parameter_sets[0], false);
  });

  it('aggregates missing names and invalid values across all sets', () => {
    const result = planParameterSets({
      candidate_schema: candidate([{
        name: 'Length', runtime_value_type: 'int', constraints: { min: 1, max: 20 },
      }]),
      parameter_sets: [
        { name: 'one', inputs: { Missing: 5 } },
        { name: 'two', inputs: { Length: 99 } },
      ],
    });
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((error) => error.code), [
      'PARAMETER_SET_INPUT_NOT_FOUND', 'PARAMETER_SET_INPUT_VALUE_INVALID',
    ]);
    assert.equal(result.parameter_sets[0].runtime_validation, 'blocked_pending_pane_sync');
    assert.equal(result.parameter_sets[0].inputs_fingerprint.available, false);
  });

  it('reports added, removed, and modified input schema names', () => {
    const result = compareInputSchemas({
      current_schema: candidate([
        { name: 'Old', runtime_value_type: 'int', constraints: {} },
        { name: 'Length', runtime_value_type: 'int', constraints: { min: 1 } },
      ]),
      candidate_schema: candidate([
        { name: 'New', runtime_value_type: 'bool', constraints: {} },
        { name: 'Length', runtime_value_type: 'float', constraints: { min: 0 } },
      ]),
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, ['New']);
    assert.deepEqual(result.removed, ['Old']);
    assert.equal(result.modified[0].name, 'Length');
    assert.deepEqual(result.modified[0].changed_fields, ['type', 'min']);
  });

  it('compares only type, default, min, and max schema fields', () => {
    const changed = compareInputSchemas({
      current_schema: candidate([{
        name: 'Length', pine_input_type: 'int', default_value: 10,
        group: 'Old', constraints: { min: 1, max: 20, step: 1, options: [10] },
      }]),
      candidate_schema: candidate([{
        name: 'Length', pine_input_type: 'int', default_value: 15,
        group: 'New', constraints: { min: 1, max: 30, step: 5, options: [15] },
      }]),
    });
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.modified[0].changed_fields, ['default', 'max']);

    const ignored = compareInputSchemas({
      current_schema: candidate([{
        name: 'Length', pine_input_type: 'int', default_value: 10,
        group: 'Old', constraints: { min: 1, max: 20, step: 1, options: [10] },
      }]),
      candidate_schema: candidate([{
        name: 'Length', pine_input_type: 'int', default_value: 10,
        group: 'New', constraints: { min: 1, max: 20, step: 5, options: [10, 15] },
      }]),
    });
    assert.equal(ignored.changed, false);
  });

  it('rejects an empty or incomplete Runtime Catalog when Candidate Inputs exist', () => {
    const schema = candidate([
      { name: 'Length', runtime_value_type: 'int', constraints: {} },
      { name: 'Enabled', runtime_value_type: 'bool', constraints: {} },
    ]);
    const empty = planParameterSets({
      candidate_schema: schema, base_catalog: [],
      parameter_sets: [{ name: 'baseline', inputs: {} }],
    });
    assert.equal(empty.valid, false);
    assert.deepEqual(empty.errors.map((error) => error.code), ['RUNTIME_INPUT_CATALOG_EMPTY']);
    assert.equal(empty.parameter_sets[0].runtime_validation, 'invalid');

    const incomplete = planParameterSets({
      candidate_schema: schema,
      base_catalog: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10 }],
      parameter_sets: [{ name: 'baseline', inputs: {} }],
    });
    assert.ok(incomplete.errors.some((error) => error.code === 'RUNTIME_INPUT_NOT_FOUND'));
  });

  it('fingerprints complete Effective Inputs without returning the full catalog', () => {
    const schema = candidate([{
      name: 'Length', runtime_value_type: 'int', constraints: {},
    }]);
    const plan = (otherValue) => planParameterSets({
      candidate_schema: schema,
      base_catalog: [
        { id: 'in_0', name: 'Length', type: 'integer', value: 10 },
        { id: 'in_1', name: 'Other', type: 'integer', value: otherValue },
      ],
      parameter_sets: [{ name: 'fast', inputs: { Length: 5 } }],
    }).parameter_sets[0];
    const first = plan(20);
    const second = plan(30);
    assert.notEqual(first.inputs_fingerprint.value, second.inputs_fingerprint.value);
    assert.equal(first.inputs_fingerprint.count, 2);
    assert.equal(first.requested_inputs_fingerprint, second.requested_inputs_fingerprint);
    assert.equal('effective_inputs' in first, false);
  });

  it('accepts compiler-confirmed enum values by Pine input type', () => {
    const result = planParameterSets({
      candidate_schema: candidate([{
        name: 'Mode', pine_input_type: 'enum', runtime_value_type: 'Mode', constraints: {},
      }]),
      parameter_sets: [{ name: 'enum', inputs: { Mode: 'fast' } }],
    });
    assert.equal(result.valid, true);
  });
});
