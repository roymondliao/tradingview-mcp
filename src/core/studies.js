/**
 * Shared TradingView Study domain logic.
 *
 * A Study Instance is an indicator or strategy attached to the active pane.
 * Account-owned Pine scripts are handled separately by core/pine.js.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString } from '../connection.js';
import { listScripts as _listScripts } from './pine.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * Classify a TradingView study from normalized metadata.
 * Unknown is intentional: absence of strategy evidence is not enough when no
 * study metadata is available at all.
 */
export function classifyStudyMetadata(metaInfo, hasReportData = false) {
  if (metaInfo && (metaInfo.isTVScriptStrategy === true || metaInfo.is_strategy === true)) {
    return 'strategy';
  }
  if (hasReportData) return 'strategy';
  if (metaInfo && typeof metaInfo === 'object') return 'indicator';
  return 'unknown';
}

/** Infer the catalog origin without exposing the complete TradingView metadata. */
export function classifyStudySource(metaInfo) {
  const definitionId = String(
    metaInfo?.fullId || metaInfo?.id || metaInfo?.studyId || metaInfo?.shortId || '',
  );
  if (!definitionId) return 'unknown';
  if (/(?:\$|^)USER;/.test(definitionId)) return 'account';
  if (/(?:\$|^)PUB;/.test(definitionId)) return 'community';
  if (/(?:\$|^)STD;/.test(definitionId)) return 'built-in';
  if (!/@tv-scripting(?:-|$)/.test(definitionId)) return 'built-in';
  return 'unknown';
}

// Included in page-context expressions used by chart state, study list/get,
// and strategy discovery. Keep classification in one source.
export const STUDY_PAGE_HELPERS_JS = `
  var _classifyStudyMetadata = ${classifyStudyMetadata.toString()};
  function _studyMetaOf(study) {
    if (!study) return null;
    try { if (typeof study.metaInfo === 'function') return study.metaInfo(); } catch (e) {}
    try { if (typeof study.getStudyMeta === 'function') return study.getStudyMeta(); } catch (e) {}
    try { if (study._study && typeof study._study.metaInfo === 'function') return study._study.metaInfo(); } catch (e) {}
    return null;
  }
  function _studyReportOf(study) {
    try {
      if (!study || typeof study.reportData !== 'function') return null;
      var report = study.reportData();
      if (report && typeof report.value === 'function') report = report.value();
      return report || null;
    } catch (e) { return null; }
  }
  function _studyTypeOf(study) {
    var meta = _studyMetaOf(study);
    return _classifyStudyMetadata(meta, !!(study && typeof study.reportData === 'function'));
  }
  function _studySourceOf(study) {
    var meta = _studyMetaOf(study);
    var definitionId = '';
    try { definitionId = String((meta && (meta.fullId || meta.id || meta.studyId || meta.shortId)) || ''); } catch (e) {}
    if (!definitionId) return 'unknown';
    if (/(?:\\$|^)USER;/.test(definitionId)) return 'account';
    if (/(?:\\$|^)PUB;/.test(definitionId)) return 'community';
    if (/(?:\\$|^)STD;/.test(definitionId)) return 'built-in';
    if (!/@tv-scripting(?:-|$)/.test(definitionId)) return 'built-in';
    return 'unknown';
  }
  function _studyIdOf(study) {
    try { return typeof study.id === 'function' ? study.id() : study.id; } catch (e) { return null; }
  }
`;

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate };
}

const STUDY_TYPES = new Set(['strategy', 'indicator', 'unknown']);
const CATALOG_SEARCH_SOURCES = new Set(['built-in', 'account']);

function validateChoice(value, allowed, name) {
  if (value && !allowed.has(value)) throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
}

export function normalizeCatalogResult(result, accountScripts = []) {
  const section = String(result?.section || '').trim();
  const sectionLower = section.toLowerCase();
  let source = 'unknown';
  if (/my scripts|我的腳本|我的指標/.test(sectionLower)) source = 'account';
  else if (/community|社群/.test(sectionLower)) source = 'community';
  else if (/technical|built-in|strateg|技術|策略/.test(sectionLower)) source = 'built-in';

  const title = String(result?.title || '').trim();
  const titleLower = title.toLowerCase();
  const saved = source === 'account'
    ? accountScripts.find((script) => [script.name, script.title].some((value) => String(value || '').toLowerCase() === titleLower))
    : null;
  let type = saved?.type || 'unknown';
  if (!saved && /strateg|策略/.test(sectionLower)) type = 'strategy';
  else if (!saved && /technical|indicator|技術|指標/.test(sectionLower)) type = 'indicator';

  return {
    title,
    section: section || null,
    source,
    type,
    ...(saved?.script_id && { script_id: saved.script_id }),
    ...(result?.study_id && { study_id: result.study_id }),
    ...(result?.version && { version: result.version }),
  };
}

async function listBuiltinCatalog() {
  const response = await _evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=standard', { credentials: 'include' })
      .then(function(response) {
        if (!response.ok) throw new Error('pine-facade standard list failed with HTTP ' + response.status);
        return response.json();
      })
      .then(function(data) {
        if (!Array.isArray(data)) throw new Error('Unexpected standard list response');
        return data.map(function(script) {
          return {
            title: script.scriptTitle || script.scriptName || '',
            study_id: script.scriptIdPart || null,
            version: script.version || 'last',
            kind: script.extra && script.extra.kind ? script.extra.kind : null
          };
        });
      })
  `);
  return response || [];
}

export async function searchCatalog({ query, source, type, limit, _deps } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required.');
  validateChoice(source, CATALOG_SEARCH_SOURCES, 'source');
  validateChoice(type, STUDY_TYPES, 'type');
  const cap = limit == null ? 25 : Number(limit);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error('limit must be an integer from 1 to 100');

  const runListScripts = _deps?.listScripts || _listScripts;
  const normalizedQuery = String(query).trim();
  const queryLower = normalizedQuery.toLowerCase();
  const accountScripts = source === 'account' || !source ? (await runListScripts({})).scripts : [];
  const accountMatches = accountScripts
    .filter((script) => [script.name, script.title].some((value) => String(value || '').toLowerCase().includes(queryLower)))
    .map((script) => ({
      title: script.title || script.name,
      section: 'My scripts',
      source: 'account',
      type: script.type,
      script_id: script.script_id,
    }));
  const runListBuiltin = _deps?.listBuiltinCatalog || listBuiltinCatalog;
  const builtinRaw = source === 'account'
    ? []
    : await runListBuiltin();
  const builtinMatches = builtinRaw
    .filter((script) => String(script.title || '').toLowerCase().includes(queryLower))
    .map((script) => ({
      title: script.title,
      section: 'Technicals',
      source: 'built-in',
      type: script.kind === 'strategy' ? 'strategy' : script.kind === 'study' ? 'indicator' : 'unknown',
      study_id: script.study_id,
      version: script.version || 'last',
    }));
  const normalized = [...accountMatches, ...builtinMatches];
  const filtered = normalized
    .filter((result) => !source || result.source === source)
    .filter((result) => !type || result.type === type)
    .slice(0, cap);
  return {
    success: true,
    query: normalizedQuery,
    count: filtered.length,
    total_matches: normalized.length,
    ...(source && { source_filter: source }),
    ...(type && { type_filter: type }),
    results: filtered,
  };
}

/** Return active chart state with normalized Study Instance summaries. */
export async function getActivePaneState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      ${STUDY_PAGE_HELPERS_JS}
      var chart = ${CHART_API};
      var publicStudies = [];
      try { publicStudies = chart.getAllStudies() || []; } catch (e) {}

      var sourceById = {};
      var activeStrategySource = null;
      var activeStrategyResolved = false;
      try {
        var chartModel = chart._chartWidget.model();
        var internalModel = chartModel.model();
        var sources = internalModel.dataSources() || [];
        for (var i = 0; i < sources.length; i++) {
          var sourceId = _studyIdOf(sources[i]);
          if (sourceId != null) sourceById[String(sourceId)] = sources[i];
        }
        var activeStrategyValue = null;
        if (typeof internalModel.activeStrategySource === 'function') activeStrategyValue = internalModel.activeStrategySource();
        else if (typeof chartModel.activeStrategySource === 'function') activeStrategyValue = chartModel.activeStrategySource();
        if (activeStrategyValue) {
          activeStrategySource = typeof activeStrategyValue.value === 'function' ? activeStrategyValue.value() : activeStrategyValue;
          activeStrategyResolved = true;
        }
      } catch (e) {}

      var studies = [];
      for (var j = 0; j < publicStudies.length; j++) {
        var item = publicStudies[j] || {};
        var entityId = item.id == null ? null : String(item.id);
        var wrapper = null;
        try { wrapper = entityId ? chart.getStudyById(entityId) : null; } catch (e) {}
        var source = sourceById[entityId] || (wrapper && wrapper._study) || wrapper;
        var meta = _studyMetaOf(source) || _studyMetaOf(wrapper);
        var type = _studyTypeOf(source || wrapper);
        var visible = null;
        try { visible = wrapper && typeof wrapper.isVisible === 'function' ? wrapper.isVisible() : null; } catch (e) {}
        if (visible === null && source) {
          try { visible = source.properties().visible.value(); } catch (e) {}
        }
        var name = item.name || item.title || (meta && (meta.description || meta.shortDescription)) || 'unknown';
        var normalized = {
          id: entityId,
          entity_id: entityId,
          name: name,
          type: type,
          source: _studySourceOf(source || wrapper),
          visible: visible
        };
        if (type === 'strategy') {
          var report = _studyReportOf(source || wrapper);
          normalized.report_ready = !!(report && report.performance);
          var activeId = _studyIdOf(activeStrategySource);
          normalized.is_active_strategy = activeStrategyResolved
            ? !!(activeStrategySource && (activeStrategySource === source || String(activeId) === entityId))
            : null;
        }
        studies.push(normalized);
      }

      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies
      };
    })()
  `);
  return { success: true, ...state };
}

export async function listActivePaneStudies({ type, _deps } = {}) {
  validateChoice(type, STUDY_TYPES, 'type');
  const getState = _deps?.getActivePaneState || getActivePaneState;
  const state = await getState({ _deps });
  const allStudies = state.studies || [];
  const studies = type ? allStudies.filter((study) => study.type === type) : allStudies;
  return {
    success: true,
    symbol: state.symbol,
    resolution: state.resolution,
    count: studies.length,
    total_count: allStudies.length,
    ...(type && { type_filter: type }),
    studies,
  };
}

export function sanitizeStudyInputs(inputs) {
  if (!Array.isArray(inputs)) return [];
  const safe = [];
  const internalIds = new Set(['pineId', 'pineVersion', 'pineFeatures', '__profile']);
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || !input.id) continue;
    if (internalIds.has(String(input.id))) continue;
    const value = input.value;
    if (input.id === 'text' && typeof value === 'string' && value.length > 200) continue;
    if (typeof value === 'string' && value.length > 500) continue;
    let serialized = '';
    try { serialized = JSON.stringify(value); } catch { continue; }
    if (serialized.length > 2000) continue;
    safe.push({
      id: String(input.id),
      ...(input.name != null && { name: String(input.name) }),
      value,
    });
  }
  return safe;
}

export async function getActivePaneStudy({ entity_id, _deps } = {}) {
  if (!entity_id) throw new Error('entity_id is required. Use study list to find Active Pane Study IDs.');
  const getState = _deps?.getActivePaneState || getActivePaneState;
  const state = await getState({ _deps });
  const summary = (state.studies || []).find((study) => study.entity_id === entity_id);
  if (!summary) throw new Error(`Study not found in the active pane: ${entity_id}`);

  const runEvaluate = _deps?.evaluate || _evaluate;
  const detail = await runEvaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found in active pane' };
      var inputs = [];
      try { inputs = study.getInputValues() || []; } catch (e) { return { inputs: [], inputs_error: e.message }; }
      return { inputs: inputs };
    })()
  `);
  if (detail?.error) throw new Error(detail.error);
  return {
    success: true,
    ...summary,
    inputs: sanitizeStudyInputs(detail?.inputs),
    ...(detail?.inputs_error && { inputs_error: detail.inputs_error }),
  };
}

export async function getStudyInputs({ entity_id, _deps } = {}) {
  const getStudy = _deps?.getActivePaneStudy || getActivePaneStudy;
  const study = await getStudy({ entity_id, _deps });
  return {
    success: true,
    entity_id: study.entity_id,
    name: study.name,
    type: study.type,
    inputs: study.inputs || [],
  };
}

export async function setStudyInputs({ entity_id, inputs: inputsRaw, _deps } = {}) {
  const requested = typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || !Object.keys(requested).length) {
    throw new Error('inputs must be a non-empty JSON object');
  }
  const getStudy = _deps?.getActivePaneStudy || getActivePaneStudy;
  const beforeStudy = await getStudy({ entity_id, _deps });
  const beforeById = new Map((beforeStudy.inputs || []).map((input) => [input.id, input.value]));
  const known = {};
  const unknownInputs = [];
  for (const [key, value] of Object.entries(requested)) {
    if (beforeById.has(key)) known[key] = value;
    else unknownInputs.push(key);
  }
  if (!Object.keys(known).length) {
    throw new Error(`None of the requested input IDs exist on Study ${entity_id}: ${unknownInputs.join(', ')}`);
  }

  const runEvaluate = _deps?.evaluate || _evaluate;
  const mutation = await runEvaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found in active pane' };
      var values = study.getInputValues() || [];
      var overrides = ${JSON.stringify(known)};
      for (var i = 0; i < values.length; i++) {
        if (Object.prototype.hasOwnProperty.call(overrides, values[i].id)) values[i].value = overrides[values[i].id];
      }
      study.setInputValues(values);
      return { inputs: study.getInputValues() || [] };
    })()
  `);
  if (mutation?.error) throw new Error(mutation.error);
  const afterInputs = sanitizeStudyInputs(mutation?.inputs);
  const afterById = new Map(afterInputs.map((input) => [input.id, input.value]));
  const appliedInputs = {};
  const unchangedInputs = {};
  const unconfirmedInputs = [];
  for (const [key, requestedValue] of Object.entries(known)) {
    if (!afterById.has(key)) { unconfirmedInputs.push(key); continue; }
    const actual = afterById.get(key);
    if (Object.is(beforeById.get(key), actual)) unchangedInputs[key] = actual;
    else appliedInputs[key] = actual;
    if (!Object.is(actual, requestedValue) && !unconfirmedInputs.includes(key)) unconfirmedInputs.push(key);
  }
  return {
    success: unconfirmedInputs.length === 0,
    entity_id,
    type: beforeStudy.type,
    requested_inputs: requested,
    applied_inputs: appliedInputs,
    unchanged_inputs: unchangedInputs,
    ...(unknownInputs.length && { unknown_inputs: unknownInputs }),
    ...(unconfirmedInputs.length && { unconfirmed_inputs: unconfirmedInputs }),
    ...(beforeStudy.type === 'strategy' && { report_state: 'recalculating' }),
  };
}

export async function toggleStudyVisibility({ entity_id, visible, _deps } = {}) {
  if (typeof visible !== 'boolean') throw new Error('visible must be true or false');
  const getStudy = _deps?.getActivePaneStudy || getActivePaneStudy;
  const before = await getStudy({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found in active pane' };
      study.setVisible(${visible});
      return { visible: study.isVisible() };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.visible !== visible) throw new Error(`Study visibility readback mismatch for ${entity_id}`);
  return {
    success: true,
    entity_id,
    type: before.type,
    previous_visible: before.visible,
    visible: result.visible,
    ...(before.type === 'strategy' && { report_state: visible ? 'recalculating' : 'unavailable_while_hidden' }),
  };
}

export async function removeActivePaneStudy({ entity_id, _deps } = {}) {
  const getStudy = _deps?.getActivePaneStudy || getActivePaneStudy;
  const before = await getStudy({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found in active pane' };
      chart.removeEntity(${safeString(entity_id)});
      return true;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  const delay = _deps?.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await delay(300);
  const getState = _deps?.getActivePaneState || getActivePaneState;
  const after = await getState({ _deps });
  if ((after.studies || []).some((study) => study.entity_id === entity_id)) {
    throw new Error(`Study removal readback failed for ${entity_id}`);
  }
  return { success: true, entity_id, name: before.name, type: before.type, removed: true };
}

export async function addActivePaneStudy({ script_id, study_id, query, source, type, inputs, _deps } = {}) {
  const selectors = [script_id, study_id, query].filter(Boolean);
  if (selectors.length !== 1) throw new Error('Exactly one of script_id, study_id, or query is required.');
  const getState = _deps?.getActivePaneState || getActivePaneState;
  const before = await getState({ _deps });
  let definitionId = study_id || null;
  let createDescriptor = study_id && /^(?:STD|PUB|USER);/.test(study_id)
    ? { type: 'pine', pineId: study_id, version: 'last' }
    : study_id || null;
  let selected = null;

  if (script_id) {
    const getScript = _deps?.getSavedScript || (async (args) => {
      const { getSavedScript } = await import('./pine.js');
      return getSavedScript(args);
    });
    const script = await getScript({ script_id });
    if (!['strategy', 'indicator'].includes(script.type)) {
      throw new Error(`Saved Pine Script type cannot be added to a pane: ${script.type}`);
    }
    definitionId = script.script_id;
    createDescriptor = { type: 'pine', pineId: script.script_id, version: 'last' };
    selected = { source: 'account', type: script.type, script_id: script.script_id, title: script.title || script.name };
  } else if (query) {
    const runSearch = _deps?.searchCatalog || searchCatalog;
    const search = await runSearch({ query, source, type, limit: 100, _deps });
    const exact = search.results.filter((result) => result.title.toLowerCase() === String(query).trim().toLowerCase());
    const candidates = exact.length ? exact : search.results;
    if (candidates.length !== 1) {
      throw new Error(`Study query is ambiguous (${candidates.length} matches). Specify script_id, study_id, source, or a unique title.`);
    }
    selected = candidates[0];
    if (selected.script_id) {
      return addActivePaneStudy({ script_id: selected.script_id, inputs, _deps });
    }
    if (!selected.study_id) {
      throw new Error('Selected Study result has no stable study_id; use an explicit study_id or account script_id.');
    }
    definitionId = selected.study_id;
    createDescriptor = /^(?:STD|PUB|USER);/.test(selected.study_id)
      ? { type: 'pine', pineId: selected.study_id, version: selected.version || 'last' }
      : selected.study_id;
  }

  const runEvaluate = _deps?.evaluate || _evaluate;
  await runEvaluate(`
    (function() {
      var chart = ${CHART_API};
      return chart.createStudy(${JSON.stringify(createDescriptor)}, false, false, []);
    })()
  `);
  const delay = _deps?.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await delay(1500);
  const after = await getState({ _deps });
  const beforeIds = new Set((before.studies || []).map((study) => study.entity_id));
  const added = (after.studies || []).filter((study) => !beforeIds.has(study.entity_id));
  if (added.length !== 1) {
    throw new Error(`Study add readback expected one new Entity, found ${added.length}.`);
  }
  const instance = added[0];
  let inputResult;
  if (inputs) {
    const setInputs = _deps?.setStudyInputs || setStudyInputs;
    inputResult = await setInputs({ entity_id: instance.entity_id, inputs, _deps });
  }
  return {
    success: true,
    action: 'added',
    definition_id: definitionId,
    definition: createDescriptor,
    ...(selected?.source && { source: selected.source }),
    ...(selected?.script_id && { script_id: selected.script_id }),
    ...instance,
    ...(inputResult && { inputs: inputResult }),
  };
}
