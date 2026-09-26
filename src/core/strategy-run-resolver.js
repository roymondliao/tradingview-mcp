/** Read-only exact-name resource resolution for Strategy automation runs. */
import { list as listTabs, evaluateTarget } from './tab.js';
import { listScripts, getSavedScript } from './pine.js';
import { buildStudyInputCatalog, fingerprintStudyInputs } from './studies.js';
import { normalizedPineSourceSha256 } from './pine-input-schema.js';

function resolutionError(code, message, context = {}) {
  const error = new Error(message);
  Object.assign(error, { code, phase: 'resource_resolution', retryable: false, ...context });
  return error;
}

/** Extract one exact Account Pine ID from a TradingView Study definition ID. */
export function accountScriptIdFromDefinition(definitionId) {
  const match = String(definitionId || '').match(/(?:^|\$)(USER;[^@$!]+)(?=@|!|$)/);
  return match?.[1] || null;
}

export function resolveLayoutFromInventory({ inventory, layout_name, pane_index } = {}) {
  const tabs = Array.isArray(inventory?.tabs) ? inventory.tabs : [];
  const matches = tabs.filter((tab) => (
    tab.is_chart === true && tab.layout?.layout_name === layout_name
  ));
  if (matches.length === 0) {
    throw resolutionError('TARGET_LAYOUT_NOT_OPEN', `No open Chart Tab has exact Layout name: ${layout_name}`, {
      layout_name, match_count: 0,
    });
  }
  if (matches.length > 1) {
    throw resolutionError('TARGET_LAYOUT_AMBIGUOUS', `Exact Layout name is open in ${matches.length} Chart Tabs: ${layout_name}`, {
      layout_name, match_count: matches.length,
    });
  }
  const tab = matches[0];
  const pane = (tab.panes || []).find((item) => item.pane_index === pane_index);
  if (!pane) {
    throw resolutionError('PANE_INDEX_INVALID', `Pane index ${pane_index} does not exist in Layout ${layout_name}.`, {
      layout_name, pane_index, pane_count: tab.panes?.length || 0,
    });
  }
  return Object.freeze({
    tab_index: tab.tab_index,
    target_id: tab.target_id,
    url_chart_id: tab.url_chart_id,
    layout_name,
    layout_id: tab.layout?.layout_id ?? null,
    saved_layout_id: tab.layout?.saved_layout_id ?? null,
    pane_layout: tab.layout?.pane_layout ?? null,
    pane_index: pane.pane_index,
    pane_id: pane.pane_id ?? null,
    symbol: pane.symbol ?? null,
    timeframe: pane.resolution ?? null,
  });
}

export async function resolveLayoutTarget({ layout_name, pane_index, _deps } = {}) {
  const runListTabs = _deps?.listTabs || listTabs;
  return resolveLayoutFromInventory({
    inventory: await runListTabs(), layout_name, pane_index,
  });
}

export function resolveSavedStrategyFromInventory({ inventory, saved_name } = {}) {
  const scripts = Array.isArray(inventory?.scripts) ? inventory.scripts : [];
  const matches = scripts.filter((script) => (
    script.type === 'strategy'
    && (script.name === saved_name || script.title === saved_name)
  ));
  if (matches.length > 1) {
    throw resolutionError(
      'STRATEGY_NAME_AMBIGUOUS',
      `Exact Saved Strategy name resolved ${matches.length} Account scripts: ${saved_name}`,
      { saved_name, match_count: matches.length },
    );
  }
  return Object.freeze({
    saved_name,
    match_count: matches.length,
    exists: matches.length === 1,
    script: matches[0] || null,
  });
}

export async function resolveSavedStrategy({ saved_name, _deps } = {}) {
  const runListScripts = _deps?.listScripts || listScripts;
  return resolveSavedStrategyFromInventory({
    inventory: await runListScripts({ type: 'strategy' }), saved_name,
  });
}

function paneStudyInventoryExpression(paneIndex) {
  return `
    (function() {
      var index = ${Number(paneIndex)};
      var api = window.TradingViewApi || {};
      var all = api._chartWidgetCollection && api._chartWidgetCollection.getAll
        ? api._chartWidgetCollection.getAll() : [];
      if (!Number.isInteger(index) || index < 0 || index >= all.length) {
        return { error: 'Pane index out of range', pane_count: all.length };
      }
      var widget = all[index];
      var chartModel = null;
      var model = null;
      try { chartModel = widget.model(); model = chartModel.model(); } catch (e) {
        return { error: 'Pane model unavailable: ' + e.message, pane_count: all.length };
      }
      var sources = [];
      try { sources = model.dataSources() || []; } catch (e) {}
      var internalIds = { text: true, pineId: true, pineVersion: true, pineFeatures: true, __profile: true };
      function call(target, method) {
        try { return target && typeof target[method] === 'function' ? target[method]() : null; } catch (e) { return null; }
      }
      function primitive(value, maximum) {
        if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value === 'string' && value.length <= maximum) return value;
        return undefined;
      }
      var studies = [];
      for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var inner = source && source._study ? source._study : source;
        var meta = call(source, 'metaInfo') || call(source, 'getStudyMeta')
          || call(inner, 'metaInfo') || call(inner, 'getStudyMeta');
        var hasReport = !!(source && typeof source.reportData === 'function')
          || !!(inner && typeof inner.reportData === 'function');
        var definitionId = String((meta && (meta.fullId || meta.id || meta.studyId || meta.shortId)) || '');
        if (!definitionId && !hasReport) continue;
        var type = meta && (meta.isTVScriptStrategy === true || meta.is_strategy === true)
          ? 'strategy' : hasReport ? 'strategy' : meta ? 'indicator' : 'unknown';
        var id = call(source, 'id');
        if (id == null) id = source && source.id != null ? source.id : call(inner, 'id');
        var values = call(source, 'getInputValues') || call(inner, 'getInputValues') || [];
        var apiInputMap = call(source, '_apiInputs') || call(inner, '_apiInputs')
          || call(source, 'inputs') || call(inner, 'inputs') || null;
        if (!Array.isArray(values) && values && typeof values === 'object') apiInputMap = values;
        if (!Array.isArray(values)) values = [];
        if (!values.length && apiInputMap && typeof apiInputMap === 'object') {
          values = Object.keys(apiInputMap).map(function(inputId) {
            var record = apiInputMap[inputId];
            var value = record && typeof record === 'object'
              && Object.prototype.hasOwnProperty.call(record, 'v') ? record.v : record;
            return { id: inputId, value: value };
          });
        }
        var info = call(source, 'getInputsInfo') || call(inner, 'getInputsInfo')
          || (meta && Array.isArray(meta.inputs) ? meta.inputs : []);
        var projectedValues = [];
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
          var valueItem = values[valueIndex] || {};
          var valueId = valueItem.id == null ? '' : String(valueItem.id);
          if (!valueId || internalIds[valueId]) continue;
          var safeValue = primitive(valueItem.value, 500);
          if (safeValue !== undefined) projectedValues.push({ id: valueId, value: safeValue });
        }
        var projectedInfo = [];
        for (var infoIndex = 0; infoIndex < info.length; infoIndex++) {
          var item = info[infoIndex] || {};
          var infoId = item.id == null ? '' : String(item.id);
          if (!infoId || internalIds[infoId] || item.isHidden === true) continue;
          var projected = {
            id: infoId,
            name: primitive(item.name, 500),
            type: primitive(item.type, 100),
            group: primitive(item.group, 500),
            min: primitive(item.min, 100),
            max: primitive(item.max, 100),
            step: primitive(item.step, 100),
            active: typeof item.active === 'boolean' ? item.active : undefined
          };
          var defval = primitive(item.defval, 2000);
          if (defval !== undefined) projected.defval = defval;
          if (Array.isArray(item.options) && item.options.length <= 200) projected.options = item.options;
          projectedInfo.push(projected);
        }
        if (projectedInfo.length) {
          var allowedInputIds = {};
          for (var projectedIndex = 0; projectedIndex < projectedInfo.length; projectedIndex++) {
            allowedInputIds[projectedInfo[projectedIndex].id] = true;
          }
          projectedValues = projectedValues.filter(function(valueItem) {
            return allowedInputIds[valueItem.id] === true;
          });
        }
        studies.push({
          entity_id: id == null ? null : String(id),
          name: String((meta && (meta.description || meta.shortDescription)) || 'unknown').slice(0, 500),
          type: type,
          definition_id: definitionId || null,
          script_id: meta && typeof meta.scriptIdPart === 'string'
            ? meta.scriptIdPart
            : null,
          version: apiInputMap && apiInputMap.pineVersion != null
            ? (typeof apiInputMap.pineVersion === 'object'
              ? (apiInputMap.pineVersion.v ?? null)
              : apiInputMap.pineVersion)
            : null,
          definition_version: meta && meta.version != null ? meta.version : null,
          values: projectedValues,
          info: projectedInfo
        });
      }
      var main = null;
      try { main = chartModel.mainSeries(); } catch (e) {}
      return {
        pane_index: index,
        symbol: main ? main.symbol() : null,
        timeframe: main ? main.interval() : null,
        studies: studies
      };
    })()
  `;
}

export async function readTargetPaneStudies({ target_id, pane_index, _deps } = {}) {
  const runEvaluateTarget = _deps?.evaluateTarget || evaluateTarget;
  const raw = await runEvaluateTarget(target_id, paneStudyInventoryExpression(pane_index));
  if (raw?.error) {
    throw resolutionError('PANE_STUDY_INVENTORY_UNAVAILABLE', raw.error, {
      target_id, pane_index, pane_count: raw.pane_count,
    });
  }
  const studies = (raw?.studies || []).map((study) => {
    const inputs = buildStudyInputCatalog({ values: study.values, info: study.info });
    return Object.freeze({
      entity_id: study.entity_id,
      name: study.name,
      type: study.type,
      definition_id: study.definition_id,
      script_id: String(study.script_id || '').startsWith('USER;')
        ? study.script_id
        : accountScriptIdFromDefinition(study.definition_id),
      version: study.version,
      definition_version: study.definition_version ?? null,
      inputs,
      inputs_fingerprint: fingerprintStudyInputs(inputs),
    });
  });
  return Object.freeze({
    target_id,
    pane_index,
    symbol: raw?.symbol ?? null,
    timeframe: raw?.timeframe ?? null,
    studies: Object.freeze(studies),
  });
}

export function listPaneStrategyInstances({ pane_state, script_id } = {}) {
  if (!script_id) return Object.freeze([]);
  const matches = (pane_state?.studies || []).filter((study) => (
    study.type === 'strategy'
    && String(
      String(study.script_id || '').startsWith('USER;')
        ? study.script_id
        : accountScriptIdFromDefinition(study.definition_id) || '',
    ) === String(script_id)
  ));
  return Object.freeze(matches);
}

export function resolvePaneStrategyInstances({ pane_state, script_id } = {}) {
  const matches = listPaneStrategyInstances({ pane_state, script_id });
  if (matches.length > 1) {
    throw resolutionError(
      'STRATEGY_INSTANCE_AMBIGUOUS',
      `Pane contains ${matches.length} Strategy Instances for ${script_id}.`,
      { script_id, match_count: matches.length },
    );
  }
  return Object.freeze({ match_count: matches.length, matches: Object.freeze(matches) });
}

export async function readResolvedSavedStrategy({ resolved_account, _deps } = {}) {
  if (!resolved_account?.exists) return null;
  const runGetSavedScript = _deps?.getSavedScript || getSavedScript;
  const detail = await runGetSavedScript({ script_id: resolved_account.script.script_id });
  return Object.freeze({
    ...resolved_account.script,
    source_sha256: normalizedPineSourceSha256(detail.pine_source),
    pine_source: detail.pine_source,
  });
}
