import { z } from 'zod';
import { prepareContext } from '../core/pane.js';

export const paneContextSchema = Object.freeze({
  tab_index: z.coerce.number().optional().describe('TradingView Desktop Tab index from tab_list'),
  url_chart_id: z.string().optional().describe('Short Chart token from the TradingView Tab URL'),
  layout_id: z.union([z.string(), z.coerce.number()]).optional().describe('Saved Chart Layout ID'),
  pane_index: z.coerce.number().optional().describe('Chart Pane index within the selected Layout'),
});

export function paneContextArgs(args = {}) {
  return {
    tab_index: args.tab_index,
    url_chart_id: args.url_chart_id,
    layout_id: args.layout_id,
    pane_index: args.pane_index,
  };
}

export async function withPaneContext(args, operation) {
  const context = await prepareContext(paneContextArgs(args));
  const result = await operation();
  return { ...result, context };
}
