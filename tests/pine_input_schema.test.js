import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/core/pine.js';
import {
  extractCandidateInputSchema,
  normalizePineSource,
  normalizedPineSourceSha256,
  sanitizeCompilerInputVariables,
} from '../src/core/pine-input-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function compilerInput(variable_name, inferred_type) {
  return { variable_name, inferred_type };
}

function compilerResult(items, extra = {}) {
  return {
    variables2: [{
      title: 'User Variables',
      prefix: 'user_var_',
      docs: items.map(({ variable_name, inferred_type }) => ({
        name: variable_name,
        type: `input ${inferred_type}`,
      })),
    }],
    ...extra,
  };
}

function fakeResponse(json, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, json: async () => json };
}

describe('Pine source normalization and compiler metadata', () => {
  it('normalizes CRLF and CR before source hashing', () => {
    const lf = '//@version=6\nindicator("One")\n';
    assert.equal(normalizePineSource(lf.replaceAll('\n', '\r\n')), lf);
    assert.equal(normalizePineSource(lf.replaceAll('\n', '\r')), lf);
    assert.equal(normalizedPineSourceSha256(lf), normalizedPineSourceSha256(lf.replaceAll('\n', '\r\n')));
  });

  it('keeps only unique bounded compiler-confirmed Input variables', () => {
    const result = sanitizeCompilerInputVariables({
      variables2: [{ docs: [
        { name: 'length', type: 'input int', private_source: 'do not expose' },
        { name: 'seriesValue', type: 'series float' },
        { name: 'length', type: 'input int' },
        { name: 'enabled', type: 'input bool' },
      ] }],
    });
    assert.deepEqual(result, [
      { variable_name: 'length', inferred_type: 'int' },
      { variable_name: 'enabled', inferred_type: 'bool' },
    ]);
    assert.equal(Object.isFrozen(result), true);
  });

  it('returns an empty list for missing or unexpected compiler metadata', () => {
    assert.deepEqual(sanitizeCompilerInputVariables(null), []);
    assert.deepEqual(sanitizeCompilerInputVariables({ variables2: {} }), []);
    assert.deepEqual(sanitizeCompilerInputVariables({ variables2: [{ docs: null }] }), []);
  });
});

describe('Candidate Pine Input Schema extraction', () => {
  it('extracts multiline declarations, nested expressions, literals, groups, and constraints', () => {
    const source = `//@version=6
strategy("Candidate")
startDate = input.time(
    timestamp("1 Jan 2010"),
    title="Start date",
    group="Range")
length = input.int(
    10,
    title="Length",
    minval=3,
    maxval=30,
    step=1,
    options=[5, 10, 20])`;
    const result = extractCandidateInputSchema({
      source,
      compiler_inputs: [compilerInput('startDate', 'int'), compilerInput('length', 'int')],
    });
    assert.equal(result.available, true);
    assert.equal(result.input_count, 2);
    assert.deepEqual(result.inputs[0], {
      declaration_index: 0,
      variable_name: 'startDate',
      name: 'Start date',
      pine_input_type: 'time',
      runtime_value_type: 'int',
      default_expression: 'timestamp("1 Jan 2010")',
      group: 'Range',
      constraints: {},
      location: { line: 3, column: 1 },
      declaration_sha256: result.inputs[0].declaration_sha256,
    });
    assert.deepEqual(result.inputs[1].constraints, {
      min: 3, max: 30, step: 1, options: [5, 10, 20],
    });
    assert.equal(result.inputs[1].default_value, 10);
    assert.match(result.input_schema_fingerprint, /^[a-f0-9]{64}$/);
  });

  it('supports positional default and static title arguments', () => {
    const source = 'length = input.int(10, "Length")';
    const result = extractCandidateInputSchema({
      source, compiler_inputs: [compilerInput('length', 'int')],
    });
    assert.equal(result.available, true);
    assert.equal(result.inputs[0].name, 'Length');
    assert.equal(result.inputs[0].default_value, 10);
  });

  it('ignores strings and comments that contain fake input declarations', () => {
    const source = `//@version=6
// fake = input.int(1, title="Fake")
message = "other = input.float(1.0, title=\\"Other\\")"
length = input.int(10, title="Length")`;
    const result = extractCandidateInputSchema({
      source, compiler_inputs: [compilerInput('length', 'int')],
    });
    assert.equal(result.available, true);
    assert.deepEqual(result.inputs.map((item) => item.variable_name), ['length']);
  });

  it('uses a generic registry for supported typed input functions', () => {
    const cases = [
      ['a', 'bool', 'true', 'bool'],
      ['b', 'int', '1', 'int'],
      ['c', 'float', '1.5', 'float'],
      ['d', 'string', '"x"', 'string'],
      ['e', 'time', 'timestamp("1 Jan 2010")', 'int'],
      ['f', 'source', 'close', 'source'],
      ['g', 'symbol', '"NASDAQ:AAPL"', 'string'],
      ['h', 'timeframe', '"1D"', 'string'],
      ['i', 'session', '"0900-1300"', 'string'],
      ['j', 'color', 'color.red', 'color'],
      ['k', 'price', '1.0', 'float'],
      ['l', 'text_area', '"note"', 'string'],
      ['m', 'enum', 'Mode.one', 'Mode'],
    ];
    const source = `enum Mode\n    one\n${cases.map(([name, type, value]) => (
      `${name} = input.${type}(${value}, title="${name.toUpperCase()}")`
    )).join('\n')}`;
    const result = extractCandidateInputSchema({
      source,
      compiler_inputs: cases.map(([name, , , inferred]) => compilerInput(name, inferred)),
    });
    assert.equal(result.available, true, JSON.stringify(result.errors));
    assert.equal(result.input_count, cases.length);
    assert.equal(result.inputs.find((item) => item.variable_name === 'e').default_expression, 'timestamp("1 Jan 2010")');
    assert.equal(result.inputs.find((item) => item.variable_name === 'm').pine_input_type, 'enum');
  });

  it('reports stable errors for missing, dynamic, duplicate, and legacy titles', () => {
    const cases = [
      {
        source: 'a = input.int(1)',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_STATIC_TITLE_REQUIRED',
      },
      {
        source: 'a = input.int(1, title=TITLE)',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_NAME_UNRESOLVED',
      },
      {
        source: 'a = input(1, title="A")',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_TYPE_UNSUPPORTED',
      },
      {
        source: 'a = input.int(1, title="A", maxval=MAX)',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_CONSTRAINT_UNRESOLVED',
      },
      {
        source: 'a = input.float(1, title="A")',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_TYPE_MISMATCH',
      },
      {
        source: 'other = input.int(1, title="Other")',
        inputs: [compilerInput('a', 'int')],
        code: 'PINE_INPUT_DECLARATION_NOT_FOUND',
      },
    ];
    for (const current of cases) {
      const result = extractCandidateInputSchema({ source: current.source, compiler_inputs: current.inputs });
      assert.equal(result.available, false);
      assert.ok(result.errors.some((error) => error.code === current.code), current.code);
    }

    const duplicate = extractCandidateInputSchema({
      source: 'a = input.int(1, title="Same")\nb = input.bool(true, title="Same")',
      compiler_inputs: [compilerInput('a', 'int'), compilerInput('b', 'bool')],
    });
    assert.equal(duplicate.available, false);
    assert.ok(duplicate.errors.some((error) => error.code === 'PINE_INPUT_NAME_AMBIGUOUS'));
  });

  it('keeps schema fingerprints stable across formatting and comments', () => {
    const one = 'length = input.int(10, title="Length", minval=1)';
    const two = '// comment\nlength=input.int(10,title="Length",minval=1)';
    const inputs = [compilerInput('length', 'int')];
    const first = extractCandidateInputSchema({ source: one, compiler_inputs: inputs });
    const second = extractCandidateInputSchema({ source: two, compiler_inputs: inputs });
    assert.equal(first.input_schema_fingerprint, second.input_schema_fingerprint);
    assert.notEqual(first.source_sha256, second.source_sha256);
  });

  it('extracts the expected 16 named Inputs from data/obv-v3.pine', () => {
    const source = readFileSync(join(__dirname, '..', 'data', 'obv-v3.pine'), 'utf8');
    const inputs = [
      ['useDateFilter', 'bool'], ['backtestStartDate', 'int'], ['backtestEndDate', 'int'],
      ['wobvMaLen', 'int'], ['minChangePct', 'float'], ['capPct', 'float'],
      ['wobvBreakoutLen', 'int'], ['smaLen', 'int'], ['rsiLen', 'int'],
      ['rsiThreshold', 'int'], ['divLookback', 'int'], ['divConfirmBars', 'int'],
      ['trailActivationPct', 'float'], ['atrTrailMultiplier', 'float'],
      ['stopLossPct', 'float'], ['maxHoldingDays', 'int'],
    ].map(([name, type]) => compilerInput(name, type));
    const result = extractCandidateInputSchema({ source, compiler_inputs: inputs });
    assert.equal(result.available, true, JSON.stringify(result.errors));
    assert.equal(result.input_count, 16);
    assert.equal(new Set(result.inputs.map((item) => item.name)).size, 16);
    assert.deepEqual(result.inputs.slice(0, 4).map((item) => item.name), [
      '啓用回測時間範圍限定', '開始時間', '結束時間', 'wOBV 平滑 MA 週期',
    ]);
    assert.deepEqual(result.inputs.find((item) => item.variable_name === 'wobvMaLen').constraints, {
      min: 3, max: 30, step: 1,
    });
  });
});

describe('pine check Candidate Schema response', () => {
  it('returns sanitized compiler variables and a candidate schema without raw payloads', async () => {
    const source = 'length = input.int(10, title="Length")';
    const opaque = 'secret-opaque-compiler-payload';
    const result = await check({ source, _deps: {
      fetch: async () => fakeResponse({
        success: true,
        result: compilerResult([compilerInput('length', 'int')], { opaque, private_source: source }),
      }),
    } });
    assert.equal(result.compiled, true);
    assert.equal(result.input_metadata_available, true);
    assert.deepEqual(result.input_variables, [compilerInput('length', 'int')]);
    assert.equal(result.input_schema.available, true);
    assert.equal(result.input_schema.inputs[0].name, 'Length');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(opaque));
    assert.doesNotMatch(JSON.stringify(result), /private_source/);
  });

  it('preserves compile failure semantics and marks Candidate Schema unavailable', async () => {
    const result = await check({ source: 'bad()', _deps: {
      fetch: async () => fakeResponse({
        success: true,
        result: {
          errors2: [{ message: 'Unknown function', start: { line: 1, column: 1 } }],
          variables2: [],
        },
      }),
    } });
    assert.equal(result.success, true);
    assert.equal(result.compiled, false);
    assert.equal(result.error_count, 1);
    assert.equal(result.input_schema.available, false);
    assert.equal(result.input_schema.errors[0].code, 'PINE_COMPILE_FAILED');
  });

  it('keeps compile success while reporting unavailable compiler metadata', async () => {
    const result = await check({ source: 'indicator("One")', _deps: {
      fetch: async () => fakeResponse({ success: true, result: {} }),
    } });
    assert.equal(result.compiled, true);
    assert.equal(result.input_metadata_available, false);
    assert.equal(result.input_schema.available, false);
    assert.equal(result.input_schema.errors[0].code, 'PINE_COMPILER_INPUT_METADATA_UNAVAILABLE');
  });

  it('preserves HTTP failure behavior', async () => {
    await assert.rejects(() => check({ source: 'indicator("One")', _deps: {
      fetch: async () => fakeResponse({}, { ok: false, status: 503, statusText: 'Unavailable' }),
    } }), /TradingView API returned 503/);
  });
});

