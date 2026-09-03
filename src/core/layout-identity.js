/** Shared TradingView page-context reader for Tab, Layout, and Pane identity. */

/**
 * This function is serialized and executed inside a TradingView Chart target.
 * It must remain self-contained and only return bounded identity metadata.
 */
export async function readChartRuntimeMetadataPage() {
  const api = globalThis.TradingViewApi || {};
  const collection = api._chartWidgetCollection || null;
  const service = api._saveChartService || null;
  const saver = service?._chartSaver || null;
  const saved = saver?._prevChartState || null;
  let savedContent = null;
  try {
    savedContent = saved && typeof saved.content === 'string'
      ? JSON.parse(saved.content)
      : (saved?.content || null);
  } catch {
    savedContent = null;
  }

  const savedCharts = Array.isArray(savedContent?.charts) ? savedContent.charts : [];
  const charts = collection && typeof collection.getAll === 'function'
    ? collection.getAll()
    : [];
  let activeWidget = null;
  try {
    const active = api._activeChartWidgetWV?.value?.() || null;
    activeWidget = active?._chartWidget || null;
  } catch {
    activeWidget = null;
  }
  const panes = [];
  for (let index = 0; index < charts.length; index += 1) {
    try {
      const model = charts[index].model();
      const main = model.mainSeries();
      panes.push({
        index,
        pane_index: index,
        pane_id: savedCharts[index]?.chartId == null
          ? null
          : String(savedCharts[index].chartId),
        symbol: main.symbol(),
        resolution: main.interval() || null,
        active: charts[index] === activeWidget,
      });
    } catch (error) {
      panes.push({
        index,
        pane_index: index,
        pane_id: null,
        error: String(error?.message || error).slice(0, 200),
        active: false,
      });
    }
  }

  let paneLayout = collection?._layoutType ?? null;
  try {
    if (paneLayout && typeof paneLayout.value === 'function') paneLayout = paneLayout.value();
  } catch {
    paneLayout = null;
  }
  let chartCount = collection?.inlineChartsCount ?? charts.length;
  try {
    if (chartCount && typeof chartCount.value === 'function') chartCount = chartCount.value();
  } catch {
    chartCount = charts.length;
  }

  let runtimeLayoutId = null;
  try {
    runtimeLayoutId = typeof service?.layoutId === 'function' ? service.layoutId() : null;
    if (runtimeLayoutId && typeof runtimeLayoutId.value === 'function') {
      runtimeLayoutId = runtimeLayoutId.value();
    }
  } catch {
    runtimeLayoutId = null;
  }
  const urlChartId = globalThis.location?.pathname?.match(/\/chart\/([^/]+)/)?.[1] || null;
  if (runtimeLayoutId == null) runtimeLayoutId = urlChartId;

  const catalog = await new Promise((resolve) => {
    let settled = false;
    const complete = (value) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(value) ? value : []);
    };
    if (typeof api.getSavedCharts === 'function') {
      try {
        api.getSavedCharts(complete);
      } catch {
        complete([]);
      }
      globalThis.setTimeout(() => complete([]), 2000);
    } else {
      complete([]);
    }
  });

  let matchedLayout = null;
  if (runtimeLayoutId != null) {
    const matches = catalog.filter((item) => String(item?.url) === String(runtimeLayoutId));
    if (matches.length === 1) [matchedLayout] = matches;
  }
  if (!matchedLayout && saved?.id != null) {
    const legacyMatches = catalog.filter((item) => String(item?.id) === String(saved.id));
    if (legacyMatches.length === 1) [matchedLayout] = legacyMatches;
  }
  if (runtimeLayoutId == null && matchedLayout?.url != null) {
    runtimeLayoutId = matchedLayout.url;
  }

  return {
    visibility: globalThis.document?.visibilityState || null,
    focused: globalThis.document?.hasFocus?.() === true,
    layout: {
      layout_id: runtimeLayoutId == null ? null : String(runtimeLayoutId),
      saved_layout_id: matchedLayout?.id ?? saved?.id ?? null,
      layout_name: matchedLayout?.name
        || matchedLayout?.title
        || savedContent?.name
        || saved?.name
        || saved?.description
        || null,
      pane_layout: paneLayout || savedContent?.layout || null,
    },
    chart_count: chartCount,
    active_index: panes.find((pane) => pane.active)?.pane_index ?? null,
    panes,
  };
}

/** Safe expression; it contains no user-controlled values. */
export function chartRuntimeMetadataExpression() {
  return `(${readChartRuntimeMetadataPage.toString()})()`;
}
