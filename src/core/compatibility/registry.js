import { REGISTRY_REVISION } from './identity.js';
// Optional feature groups may be explicitly omitted; the six core groups remain required.
export const EXCLUDABLE_CHECKS = Object.freeze(['PINE-001', 'GRAPHICS-001', 'DRAWING-001']);
const definitions = [
  ['ENV-001','environment',[],['version','identity']],
  ['CDP-001','cdp',['ENV-001'],['evaluate','promise','function_arguments']],
  ['TARGET-001','context',['CDP-001'],['active_target']],
  ['CONTEXT-001','context',['TARGET-001'],['layout_mapping','pane_ownership']],
  ['CHART-001','chart',['CONTEXT-001'],['chart_state','symbol_metadata']],
  ['DATA-001','data',['CHART-001'],['bars','quote','study_values']],
  ['HISTORY-001','data',['DATA-001'],['history_capability']],
  ['STUDY-001','study',['CONTEXT-001'],['entity_mapping','metadata','inputs']],
  ['STRATEGY-001','strategy',['STUDY-001','DATA-001'],['active_source','report_shape','trades','equity']],
  ['PINE-ACCOUNT-001','account',['TARGET-001'],['inventory','saved_source']],
  ['WATCHLIST-001','account',['TARGET-001'],['inventory','complete_detail']],
  ['ALERT-001','account',['TARGET-001'],['inventory']],
  ['PINE-001','editor_ui',['CONTEXT-001'],['editor_model']],
  ['UI-001','editor_ui',['TARGET-001'],['canvas','screenshot']],
  ['GRAPHICS-001','feature_runtime',['STUDY-001'],['lines','labels','tables','boxes']],
  ['DRAWING-001','feature_runtime',['CHART-001'],['inventory','properties']],
  ['REPLAY-001','feature_runtime',['DATA-001'],['capability','state']],
];
const expectations = {
  version:{exact_desktop_version:true},identity:{stable_environment:true},
  evaluate:{value:42},promise:{resolved_value:42},function_arguments:{json_round_trip:true},
  active_target:{unique_active_chart:true},layout_mapping:{runtime_and_saved_mapping:true},pane_ownership:{stable_pane_identity:true},
  chart_state:{symbol:'string',resolution:'string',chart_type:'integer',range:'finite bounds'},symbol_metadata:{requested_resolved_identity_match:true},
  bars:{tuple:['time','open','high','low','close','volume'],time_unit:'seconds',ordering:'ascending',finite_ohlc:true},quote:{finite_last_price:true},study_values:{fixture_values:true,numeric_or_formatted_display_value:true},history_capability:{request_more:'function',available:'boolean'},
  entity_mapping:{public_internal_ids_match:true},metadata:{indicator_strategy_types:true},inputs:{ids_names_types_values:true},
  active_source:{matches_entity:true},report_shape:{performance:'object',trades:'array',orders_data:'function'},trades:{counts_match:true,ordering:'oldest_first'},equity:{array_or_explicit_unavailable:true},
  inventory:{business_success:true,collection:'array',ids:'present'},saved_source:{requested_script_version_source:true},complete_detail:{complete_ordered_symbols:true,stable_fingerprint:true},
  editor_model:{monaco_model:true,read_write_markers:true},canvas:{nonempty_bounds:true},screenshot:{valid_png:true},
  lines:{fixture_geometry:true},labels:{fixture_text_coordinates:true},tables:{fixture_cells:true},boxes:{fixture_geometry:true},properties:{finite_points:true},capability:{required_methods:true},state:{available:'boolean',started:'boolean'},
};
export const DEPENDENCY_ASSERTIONS = {
  'HISTORY-001':['DATA-001.read.bars'],
  'STRATEGY-001':['STUDY-001.read.entity_mapping','DATA-001.read.bars'],
  'GRAPHICS-001':['STUDY-001.read.entity_mapping'],
  'REPLAY-001':['DATA-001.read.bars'],
};
const providers = {
  'ENV-001':'CDP /json/version', 'CDP-001':'Runtime.evaluate / Runtime.callFunctionOn',
  'TARGET-001':'CDP targets + renderer visibility + Desktop shell tabs',
  'CONTEXT-001':'TradingViewApi._chartWidgetCollection / _saveChartService.layoutId / getSavedCharts',
  'CHART-001':'TradingViewApi._activeChartWidgetWV.value()',
  'DATA-001':'chart._chartWidget.model().mainSeries().bars() / Study.dataWindowView',
  'HISTORY-001':'mainSeries.requestMoreData / requestMoreDataAvailable',
  'STUDY-001':'chart.getAllStudies / getStudyById / model().model().dataSources',
  'STRATEGY-001':'activeStrategySource / status / reportData / ordersData',
  'PINE-ACCOUNT-001':'pine-facade / TradingViewApi.pineLibApi',
  'WATCHLIST-001':'/api/v1/symbols_list/custom / Watchlist add UI',
  'ALERT-001':'pricealerts.tradingview.com', 'PINE-001':'React fiber / Monaco editor model',
  'UI-001':'Desktop DOM locators / CDP Page / Input',
  'GRAPHICS-001':'Study._graphics._primitivesCollection',
  'DRAWING-001':'chart.createShape / getShapeById / removeEntity',
  'REPLAY-001':'TradingViewApi._replayApi',
};
const assertion = (id,name)=>({id:`${id}.read.${name}`,stage:'read-only',kind:name.includes('capability')?'capability':'data',provider:providers[id],expected:expectations[name]});
export const CHECKS = Object.freeze(definitions.map(([id,component,depends_on,reads]) => Object.freeze({
  id, component, depends_on, required_when:'applicable', timeout_ms:15000,
  assertions:Object.freeze(reads.map(name=>assertion(id,name))),
})));
export { REGISTRY_REVISION };
export function checkForSurface(name, type = 'cli') {
  if (type === 'mcp') {
    if (name === 'tv_update' || name === 'pine_analyze' || name === 'pine_check' || name === 'symbol_search') return [];
    if (name.startsWith('tv_')) return name === 'tv_ui_state' ? ['UI-001'] : ['ENV-001','CDP-001'];
    if (name.startsWith('layout_')) return ['CONTEXT-001','UI-001'];
    if (name === 'depth_get') return ['UI-001'];
    if (name.startsWith('pane_') || name.startsWith('tab_')) return ['TARGET-001','CONTEXT-001'];
    if (name.startsWith('strategy_')) return ['STRATEGY-001'];
    if (name.startsWith('study_') || name.startsWith('indicator_')) return ['STUDY-001'];
    if (name.startsWith('watchlist_')) return ['WATCHLIST-001'];
    if (name.startsWith('alert_')) return ['ALERT-001'];
    if (name.startsWith('replay_')) return ['REPLAY-001'];
    if (name.startsWith('draw_') || name.startsWith('drawing_')) return ['DRAWING-001'];
    if (name.startsWith('pine_')) return ['PINE-001','PINE-ACCOUNT-001'];
    if (name.startsWith('capture_') || name.startsWith('ui_')) return ['UI-001'];
    if (name.startsWith('chart_')) return ['CHART-001','STUDY-001'];
    if (name.startsWith('batch_')) return ['CHART-001','STRATEGY-001'];
    if (name.startsWith('data_get_pine_')) return ['GRAPHICS-001'];
    if (name.includes('history')) return ['HISTORY-001'];
    if (name.includes('strategy') || name.includes('trades') || name.includes('equity')) return ['STRATEGY-001'];
    if (name === 'data_get_depth') return ['UI-001'];
    if (name.startsWith('data_') || name === 'quote_get' || name === 'symbol_info') return ['DATA-001'];
    return null;
  }
  const [group, sub] = name.split(' ');
  if (['compatibility','update','search'].includes(group) || group === 'pine' && ['analyze','check'].includes(sub)) return [];
  const groups = { status:['ENV-001','CDP-001'],launch:['ENV-001'],discover:['CDP-001'], 'ui-state':['UI-001'],state:['CHART-001','STUDY-001'],symbol:['CHART-001'],timeframe:['CHART-001'],type:['CHART-001'],range:['CHART-001'],scroll:['CHART-001','HISTORY-001'],info:['CHART-001'],quote:['DATA-001'],ohlcv:['DATA-001'],history:['HISTORY-001'],values:['DATA-001'],pane:['CONTEXT-001'],tab:['TARGET-001'],layout:['CONTEXT-001'],study:['STUDY-001'],indicator:['STUDY-001'],strategy:['STRATEGY-001'],watchlist:['WATCHLIST-001'],alert:['ALERT-001'],draw:['DRAWING-001'],replay:['REPLAY-001'],screenshot:['UI-001'],ui:['UI-001'],pine:['PINE-001','PINE-ACCOUNT-001'],stream:['DATA-001','GRAPHICS-001','CONTEXT-001'] };
  if (group === 'data') return ['lines','labels','tables','boxes'].includes(sub) ? ['GRAPHICS-001'] : ['strategy','trades','equity'].includes(sub) ? ['STRATEGY-001'] : sub === 'depth' ? ['UI-001'] : ['DATA-001','STUDY-001'];
  return groups[group] || null;
}
