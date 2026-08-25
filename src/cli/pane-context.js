import { prepareContext } from '../core/pane.js';

export const PANE_CONTEXT_OPTIONS = Object.freeze({
  'tab-index': { type: 'string', description: 'TradingView Desktop Tab index from tab list' },
  'url-chart-id': { type: 'string', description: 'Short Chart token from the TradingView Tab URL' },
  'layout-id': { type: 'string', description: 'Saved Chart Layout ID' },
  'pane-index': { type: 'string', description: 'Chart Pane index within the selected Layout' },
});

export function paneContextArgs(opts = {}) {
  return {
    tab_index: opts['tab-index'] != null ? Number(opts['tab-index']) : undefined,
    url_chart_id: opts['url-chart-id'],
    layout_id: opts['layout-id'],
    pane_index: opts['pane-index'] != null ? Number(opts['pane-index']) : undefined,
  };
}

export async function withPaneContext(opts, operation) {
  const context = await prepareContext(paneContextArgs(opts));
  const result = await operation();
  return { ...result, context };
}
