import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadStrategyResume,
  withStrategyResumeContext,
  withStrategyResumeOwnership,
} from '../src/core/strategy-resume.js';
import {
  transitionExperimentState,
  transitionSymbolState,
} from '../src/core/strategy-run-state.js';
import { createResumeFixture } from './helpers/strategy_resume_fixture.js';

const temporaryDirectories = [];

function temporaryDirectory(prefix = 'tv-strategy-resume-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Strategy Resume local loader', () => {
  it('loads only frozen artifacts and plans every non-succeeded Symbol', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const baseline = await fixture.createExperiment(0);
    await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[0] });
    await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[1] });
    let manifest = fixture.succeedSymbol(baseline.manifest, 0, 1002);
    manifest = transitionSymbolState(manifest, {
      index: 1,
      status: 'running',
      updated_at: 1003,
    });
    manifest = transitionSymbolState(manifest, {
      index: 1,
      status: 'failed',
      updated_at: 1004,
      error: { code: 'SYMBOL_SWITCH_FAILED', phase: 'test', message: 'failed' },
    });
    manifest = transitionSymbolState(manifest, {
      index: 2,
      status: 'running',
      updated_at: 1005,
    });
    await fixture.store.replaceManifest(manifest);

    const loaded = await loadStrategyResume({ run_directory: fixture.store.run_path });
    assert.equal(loaded.run_directory, fixture.store.run_path);
    assert.deepEqual(loaded.symbols, fixture.symbols);
    assert.deepEqual(loaded.plan.experiments[0].selected_indices, [1, 2]);
    assert.deepEqual(loaded.plan.experiments[1].selected_indices, [0, 1, 2]);
    assert.equal(loaded.plan.experiments[1].manifest_present, false);
    assert.deepEqual(loaded.plan.experiments[0].cleanup_targets, [
      { experiment_name: 'baseline', index: 1, symbol: fixture.symbols[1] },
      { experiment_name: 'baseline', index: 2, symbol: fixture.symbols[2] },
    ]);
    assert.equal(loaded.summary.symbols_selected, 5);
    assert.equal(loaded.summary.symbols_succeeded, 1);
  });

  it('never upgrades a non-succeeded manifest entry from final-folder presence', async () => {
    const fixture = await createResumeFixture({
      root: temporaryDirectory(),
      symbols: ['TWSE:2330'],
      parameter_sets: [{ name: 'baseline', inputs: {} }],
    });
    const baseline = await fixture.createExperiment(0);
    await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[0] });
    let manifest = transitionSymbolState(baseline.manifest, {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'failed',
      updated_at: 1002,
      error: { code: 'SYMBOL_SWITCH_FAILED', phase: 'test', message: 'failed' },
    });
    await fixture.store.replaceManifest(manifest);
    const loaded = await loadStrategyResume({ run_directory: fixture.store.run_path });
    assert.deepEqual(loaded.plan.experiments[0].selected_indices, [0]);
    assert.equal(loaded.plan.experiments[0].cleanup_targets[0].symbol, 'TWSE:2330');
  });

  it('rejects missing, unsupported, malformed, symlink, and oversized Run artifacts', async () => {
    await assert.rejects(
      loadStrategyResume({ run_directory: join(temporaryDirectory(), 'missing') }),
      (error) => error.code === 'RUN_RESUME_NOT_FOUND',
    );

    for (const schemaVersion of [1, 3]) {
      const directory = join(temporaryDirectory(), `version-${schemaVersion}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ schema_version: schemaVersion }));
      await assert.rejects(
        loadStrategyResume({ run_directory: directory }),
        (error) => error.code === 'RUN_RESUME_VERSION_UNSUPPORTED',
      );
    }

    const malformed = join(temporaryDirectory(), 'malformed');
    mkdirSync(malformed);
    writeFileSync(join(malformed, 'run.json'), '{bad json');
    await assert.rejects(
      loadStrategyResume({ run_directory: malformed }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );

    const real = join(temporaryDirectory(), 'real-run');
    const alias = join(dirname(real), 'alias-run');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    await assert.rejects(
      loadStrategyResume({ run_directory: alias }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );

    const oversized = join(temporaryDirectory(), 'oversized');
    mkdirSync(oversized);
    writeFileSync(join(oversized, 'run.json'), JSON.stringify({ value: 'x'.repeat(9 * 1024 * 1024) }));
    await assert.rejects(
      loadStrategyResume({ run_directory: oversized }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects a succeeded Run before runtime identity resolution', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    await fixture.store.replaceRun({
      ...fixture.run,
      status: 'succeeded',
      updated_at: 1001,
      updated_at_iso: '1970-01-01T00:00:01.001Z',
      error: null,
    });
    let runtimeCalls = 0;
    await assert.rejects(
      withStrategyResumeContext({
        run_directory: fixture.store.run_path,
        _deps: {
          identity: {
            resolveLayoutTarget: async () => { runtimeCalls += 1; },
          },
        },
      }, async () => null),
      (error) => error.code === 'RUN_ALREADY_SUCCEEDED',
    );
    assert.equal(runtimeCalls, 0);
  });

  it('rejects a known failed frozen Watchlist before runtime identity resolution', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    await fixture.store.replaceWatchlist({
      ...fixture.watchlist,
      symbol_validation: {
        schema_version: 1,
        performed: true,
        success: false,
        source: 'tradingview_desktop_cdp',
        timeframe: '1D',
        requested: fixture.symbols.length,
        valid: fixture.symbols.length - 1,
        failed: 1,
        max_attempts: 3,
        attempt_timeout_ms: 1000,
        validated_at: 1800000000000,
        validated_at_iso: '2027-01-15T08:00:00.000Z',
        errors: [{
          index: 0,
          symbol: fixture.symbols[0],
          code: 'WATCHLIST_SYMBOL_NOT_FOUND',
          phase: 'watchlist_symbol_validation',
          attempt_count: 1,
          message: `TradingView reports that ${fixture.symbols[0]} does not exist.`,
        }],
      },
    });
    let runtimeCalls = 0;
    await assert.rejects(withStrategyResumeContext({
      run_directory: fixture.store.run_path,
      _deps: {
        identity: {
          resolveLayoutTarget: async () => { runtimeCalls += 1; },
        },
      },
    }, async () => null), (error) => (
      error.code === 'WATCHLIST_SYMBOL_VALIDATION_FAILED'
      && error.phase === 'watchlist_symbol_validation'
    ));
    assert.equal(runtimeCalls, 0);
  });

  it('rejects missing, non-canonical, and non-regular succeeded artifacts', async () => {
    async function succeededFixture() {
      const fixture = await createResumeFixture({
        root: temporaryDirectory(),
        symbols: ['TWSE:2330'],
        parameter_sets: [{ name: 'baseline', inputs: {} }],
      });
      const baseline = await fixture.createExperiment(0);
      return { fixture, baseline };
    }

    {
      const { fixture, baseline } = await succeededFixture();
      await fixture.store.replaceManifest(fixture.succeedSymbol(baseline.manifest, 0));
      await assert.rejects(
        loadStrategyResume({ run_directory: fixture.store.run_path }),
        (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
      );
    }

    {
      const { fixture, baseline } = await succeededFixture();
      await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[0] });
      const manifest = fixture.succeedSymbol(baseline.manifest, 0);
      const [entry] = manifest.symbols;
      await fixture.store.replaceManifest({
        ...manifest,
        symbols: [{
          ...entry,
          artifacts: {
            ...entry.artifacts,
            report: 'experiments/baseline/symbols/wrong/report.json',
          },
        }],
      });
      await assert.rejects(
        loadStrategyResume({ run_directory: fixture.store.run_path }),
        (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
      );
    }

    {
      const { fixture, baseline } = await succeededFixture();
      await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[0] });
      await fixture.store.replaceManifest(fixture.succeedSymbol(baseline.manifest, 0));
      const report = fixture.store.artifactPath(
        'experiments/baseline/symbols/TWSE_u3A_2330/report.json',
      );
      rmSync(report);
      mkdirSync(report);
      await assert.rejects(
        loadStrategyResume({ run_directory: fixture.store.run_path }),
        (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
      );
    }
  });

  it('rejects a missing persisted Experiment plan instead of treating it as pending', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    await fixture.store.replaceRun({
      ...fixture.run,
      planned_experiments: fixture.run.planned_experiments.slice(0, 1),
    });
    await assert.rejects(
      loadStrategyResume({ run_directory: fixture.store.run_path }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects frozen Watchlist and manifest timeframe or format drift', async () => {
    {
      const fixture = await createResumeFixture({ root: temporaryDirectory() });
      const watchlistPath = fixture.store.artifactPath('watchlist.json');
      const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
      watchlist.symbols[0] = 'TWSE:9999';
      writeFileSync(watchlistPath, `${JSON.stringify(watchlist)}\n`);
      await assert.rejects(
        loadStrategyResume({ run_directory: fixture.store.run_path }),
        (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
      );
    }

    for (const patch of [{ timeframe: '60' }, { format: 'json' }]) {
      const fixture = await createResumeFixture({ root: temporaryDirectory() });
      const baseline = await fixture.createExperiment(0);
      await fixture.store.replaceManifest({ ...baseline.manifest, ...patch });
      await assert.rejects(
        loadStrategyResume({ run_directory: fixture.store.run_path }),
        (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
      );
    }
  });
});

describe('Strategy Resume ownership and TOCTOU re-read', () => {
  it('uses the post-lock artifacts as the deterministic Resume plan', async () => {
    const fixture = await createResumeFixture({
      root: temporaryDirectory(),
      symbols: ['TWSE:2330'],
      parameter_sets: [{ name: 'baseline', inputs: {} }],
    });
    const baseline = await fixture.createExperiment(0);
    let released = 0;
    const result = await withStrategyResumeOwnership({
      run_directory: fixture.store.run_path,
      _deps: {
        acquireLeases: async () => {
          await fixture.publishSymbol({ experiment_name: 'baseline', symbol: fixture.symbols[0] });
          let manifest = fixture.succeedSymbol(baseline.manifest, 0);
          manifest = transitionExperimentState(manifest, {
            status: 'succeeded', updated_at: 1003,
          });
          await fixture.store.replaceManifest(manifest);
          return {
            run_identity: { canonical_path: fixture.store.run_path },
            async release() { released += 1; },
          };
        },
      },
    }, async ({ initial, locked }) => ({
      initial: initial.summary.symbols_selected,
      locked: locked.summary.symbols_selected,
    }));
    assert.deepEqual(result, { initial: 1, locked: 0 });
    assert.equal(released, 1);
  });

  it('blocks a duplicate live Resume process with the Run lease', async () => {
    const root = temporaryDirectory();
    const fixture = await createResumeFixture({ root });
    const leaseRoot = temporaryDirectory('tv-strategy-resume-leases-');
    let entered;
    let finish;
    const enteredPromise = new Promise((resolveEntered) => { entered = resolveEntered; });
    const finishPromise = new Promise((resolveFinish) => { finish = resolveFinish; });
    const options = {
      run_directory: fixture.store.run_path,
      _deps: { leases: { tmpdir: () => leaseRoot } },
    };
    const first = withStrategyResumeOwnership(options, async () => {
      entered();
      await finishPromise;
      return 'done';
    });
    await enteredPromise;
    await assert.rejects(
      withStrategyResumeOwnership(options, async () => null),
      (error) => error.code === 'RUN_ALREADY_ACTIVE',
    );
    finish();
    assert.equal(await first, 'done');
  });
});
