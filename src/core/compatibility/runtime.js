/** Bounded shared-Core probes. No CLI/MCP handlers are invoked by the checker. */
import * as connection from '../../connection.js';
import * as tabs from '../tab.js';
import * as panes from '../pane.js';
import * as chart from '../chart.js';
import * as data from '../data.js';
import * as studies from '../studies.js';
import * as pine from '../pine.js';
import * as watchlist from '../watchlist.js';
import * as drawing from '../drawing.js';
import * as alerts from '../alerts.js';
import * as replay from '../replay.js';
import * as ui from '../ui.js';
import * as indicators from '../indicators.js';
import * as strategyRuntime from '../strategy-runtime.js';
import * as trading from '../strategy-trading.js';
import { readChartRuntimeMetadataPage } from '../layout-identity.js';
import { compatibilityError } from './identity.js';
export const pass = (observed={}) => ({status:'passed',observed});
export const blocked = (reason='FIXTURE_MISSING',observed=null,origin='fixture') => ({status:'blocked',reason_code:reason,observed,failure_origin:origin});
export const failed = (reason,observed=null,origin='desktop_runtime') => ({status:'failed',reason_code:reason,observed,failure_origin:origin});
export const decide = (condition,observed,reason='RETURN_SHAPE_CHANGED') => condition?pass(observed):failed(reason,observed);
export async function createDriver({endpoint,fixture}) {
  if(endpoint.host!==connection.CDP_HOST||endpoint.port!==connection.CDP_PORT)throw compatibilityError('CDP_ENDPOINT_MISMATCH','Checker endpoint must match the configured Core endpoint.','cdp');
  const inventory=await connection.withTimeout(tabs.list(),10000,{stage:'compatibility_targets'});
  const candidates=inventory.tabs.filter(t=>t.is_chart);
  let selected;
  if(fixture?.target){
    const matches=candidates.filter(t=>fixture.target.saved_layout_id!=null?String(t.layout?.saved_layout_id)===String(fixture.target.saved_layout_id):t.layout?.layout_name===fixture.target.layout_name);
    if(matches.length!==1)throw compatibilityError('COMPATIBILITY_FIXTURE_TARGET_UNRESOLVED','Test Layout must resolve to exactly one Chart.');
    selected=matches[0];
  }else{
    await connection.getClient();const current=await connection.getTargetInfo();selected=candidates.find(t=>t.target_id===current.id);
  }
  if(!selected)throw compatibilityError('CDP_CHART_TARGET_NOT_FOUND','No Chart target available.','cdp');
  await connection.reconnectTo(selected.target_id);
  const metadata=await connection.callPageFunction(readChartRuntimeMetadataPage);
  const paneIndex=fixture?.target?.pane_index??metadata.active_index;
  const driver={
    connection,tabs,panes,chart,data,studies,pine,watchlist,drawing,alerts,replay,ui,indicators,strategyRuntime,trading,
    selected,inventory,initial:metadata,paneIndex,cache:{},
    read:connection.callPageFunction,evaluate:connection.evaluate,evaluateAsync:connection.evaluateAsync,
    metadata:()=>connection.callPageFunction(readChartRuntimeMetadataPage),
    async guard(){
      const now=await driver.metadata();
      if(now.layout?.layout_id!==metadata.layout?.layout_id)throw compatibilityError('CONTEXT_DRIFT','Chart Layout changed during compatibility check.','identity');
      const expected=metadata.panes?.[paneIndex],current=now.panes?.[paneIndex];
      if(!current||expected?.pane_id!=null&&current.pane_id!==expected.pane_id)throw compatibilityError('CONTEXT_DRIFT','Pane identity changed during compatibility check.','identity');
      if(now.active_index!==paneIndex)throw compatibilityError('FIXTURE_PANE_NOT_ACTIVE','Read-only checks require the selected Pane to be active.');
      return now;
    },
    close:connection.disconnect,
  };
  return driver;
}
export async function pageFacts(kind, args={}) {
  const api=globalThis.TradingViewApi;
  const ch=api?._activeChartWidgetWV?.value?.();
  const model=ch?._chartWidget?.model?.();
  const unwrap=v=>v&&typeof v.value==='function'?v.value():v;
  if(kind==='chart') {
    const ext=ch.symbolExt();
    return {symbol:ch.symbol(),resolution:ch.resolution(),chart_type:ch.chartType(),range:ch.getVisibleRange(),resolved:ext?.full_name||ext?.pro_name||(ext?.exchange&&ext?.symbol?`${ext.exchange}:${ext.symbol}`:null)};
  }
  if(kind==='bars') {
    const series=model.mainSeries(),bars=series.bars();const first=bars.firstIndex(),last=bars.lastIndex();
    const sample=[];for(let i=Math.max(first,last-19);i<=last;i++){const v=bars.valueAt(i);if(v)sample.push(v.slice(0,6));}
    return {first,last,size:bars.size(),first_time:bars.valueAt(first)?.[0]??null,last_time:bars.valueAt(last)?.[0]??null,sample,request:typeof series.requestMoreData==='function',more:typeof series.requestMoreDataAvailable==='function'?series.requestMoreDataAvailable():null};
  }
  if(kind==='study') {
    const items=ch.getAllStudies(),sources=model.model().dataSources();
    return {count:items.length,mapped:items.every(item=>sources.some(s=>String(s.id())===String(item.id))),selected:args.entity_id?items.some(i=>String(i.id)===String(args.entity_id)):null};
  }
  if(kind==='strategy') {
    const inner=model.model();const sources=inner.dataSources();const selected=sources.find(s=>String(s.id())===String(args.entity_id));
    if(!selected)return {missing:true};
    const active=unwrap(typeof inner.activeStrategySource==='function'?inner.activeStrategySource():model.activeStrategySource());
    const state=unwrap(selected.status());const report=unwrap(selected.reportData());
    const trades=report?.trades;
    const entries=Array.isArray(trades)?trades.map(t=>t.e?.tm??t.entry?.time??t.entry?.timestamp):[];
    return {active:active===selected,status:state?.type??state,report:!!report,performance:!!report?.performance,trade_array:Array.isArray(trades),trade_count:trades?.length??null,closed:report?.performance?.all?.totalTrades??null,open:report?.performance?.all?.totalOpenTrades??null,ordered:entries.every((x,i)=>Number.isFinite(x)&&(i===0||x>=entries[i-1])),equity_type:report?.equity==null&&report?.equityChart==null?'unavailable':Array.isArray(report?.equity)||Array.isArray(report?.equityChart)?'array':'invalid',orders_method:typeof selected.ordersData==='function'};
  }
  if(kind==='editor') {
    let el=globalThis.document.querySelector('.monaco-editor.pine-editor-monaco');
    if(!el)return {found:false};
    let key;for(let i=0;i<20&&el;i++,el=el.parentElement){key=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(key)break;}
    let fiber=el?.[key];for(let i=0;i<15&&fiber;i++,fiber=fiber.return){const env=fiber.memoizedProps?.value?.monacoEnv;const editor=env?.editor?.getEditors?.()[0];if(editor){const m=editor.getModel();return {found:true,model:!!m,read:typeof m?.getValue==='function',write:typeof m?.setValue==='function',markers:typeof env.editor.getModelMarkers==='function'};}}
    return {found:true,model:false};
  }
  if(kind==='canvas') {
    const elements=globalThis.document.querySelectorAll('[data-name="pane-canvas"]');
    const canvas=elements[0]||globalThis.document.querySelector('canvas');const bounds=canvas?.getBoundingClientRect();
    return {found:!!canvas,width:bounds?.width||0,height:bounds?.height||0};
  }
  if(kind==='replay') {
    const rp=api._replayApi;if(!rp)return {found:false};
    const names=['selectDate','doStep','goToRealtime','stopReplay','isReplayStarted','isReplayAvailable'];
    return {found:true,methods:Object.fromEntries(names.map(n=>[n,typeof rp[n]==='function'])),available:unwrap(rp.isReplayAvailable()),started:unwrap(rp.isReplayStarted())};
  }
  return null;
}
export function validateBars(b) {
  if(!b?.sample?.length)return blocked('BARS_NOT_LOADED');
  const invalid=b.sample.filter((v,i,all)=>v.length!==6||!v.slice(0,5).every(Number.isFinite)||v[5]!=null&&!Number.isFinite(v[5])||v[0]<=0||v[0]>=1e11||v[2]<Math.max(v[1],v[4])||v[3]>Math.min(v[1],v[4])||i>0&&v[0]<=all[i-1][0]);
  return decide(invalid.length===0,{sample_size:b.sample.length,invalid_count:invalid.length,loaded_count:b.size});
}
export function guardedProbe(fn,{guard=true}={}) {
  return async ctx=>{
    if(!ctx.driver)return blocked('CDP_UNAVAILABLE',null,'environment');
    try{
      if(guard)await ctx.driver.guard();
      let answer=await fn(ctx);
      if(answer.status==='failed'){
        // Only bounded read-only observations are retried.
        await new Promise(resolve=>setTimeout(resolve,150));
        if(guard)await ctx.driver.guard();
        answer={...await fn(ctx),attempts:2};
      }
      return answer;
    }
    catch(err){
      if(err.kind==='cdp'||/^CDP_/.test(err.code||'')){return blocked('CDP_UNAVAILABLE',null,'environment');}
      if(/FIXTURE/.test(err.code||''))return blocked(err.code);
      if(err.code==='CONTEXT_DRIFT')return blocked('CONTEXT_DRIFT',null,'environment');
      if(/not a function|undefined|null|not available/i.test(err.message||''))return failed('PROVIDER_UNAVAILABLE');
      return blocked('PROVIDER_READ_UNRESOLVED',null,'undetermined');
    }
  };
}
const read = {};
function register(id,fn,options){read[id]=guardedProbe(fn,options);}
register('CDP-001.read.evaluate',async({driver:d})=>decide(await d.evaluate('6 * 7')===42,{return_type:'number'}),{guard:false});
register('CDP-001.read.promise',async({driver:d})=>decide(await d.evaluateAsync('Promise.resolve(42)')===42,{promise_resolved:true}),{guard:false});
register('CDP-001.read.function_arguments',async({driver:d})=>decide(await d.read(x=>x.value,[{value:'compatibility'}])==='compatibility',{arguments_round_trip:true}),{guard:false});
register('TARGET-001.read.active_target',async({driver:d})=>{
  const active=d.inventory.tabs.filter(t=>t.active&&t.is_chart);return active.length===1?pass({chart_targets:d.inventory.tabs.filter(t=>t.is_chart).length,active_resolved:true}):blocked('ACTIVE_TARGET_AMBIGUOUS',null,'environment');
},{guard:false});
register('CONTEXT-001.read.layout_mapping',async({driver:d})=>{
  const m=await d.metadata();
  if(!m.layout?.layout_id||m.layout.saved_layout_id==null)return blocked('SAVED_LAYOUT_FIXTURE_MISSING');
  const mapping=await d.read(async identity=>new Promise(resolve=>{
    let done=false;const finish=result=>{if(!done){done=true;resolve(result);}};
    globalThis.TradingViewApi.getSavedCharts(rows=>{const matches=Array.isArray(rows)?rows.filter(r=>String(r.url)===String(identity.layout_id)):[];finish({matches:matches.length,id_match:matches.length===1&&String(matches[0].id)===String(identity.saved_layout_id)});});
    setTimeout(()=>finish({timeout:true}),2000);
  }),[m.layout]);
  if(mapping.timeout)return blocked('LAYOUT_CATALOG_TIMEOUT',null,'environment');
  return decide(mapping.matches===1&&mapping.id_match,{runtime_layout_present:true,catalog_matches:mapping.matches,saved_mapping_matches:mapping.id_match},'LAYOUT_IDENTITY_MISMATCH');
},{guard:false});
register('CONTEXT-001.read.pane_ownership',async({driver:d})=>{const m=await d.guard();return decide(m.panes[d.paneIndex]?.pane_id!=null,{pane_count:m.panes.length,pane_identity_present:m.panes[d.paneIndex]?.pane_id!=null});});
register('CHART-001.read.chart_state',async({driver:d})=>{const x=await d.read(pageFacts,['chart']);return decide(typeof x.symbol==='string'&&!!x.symbol&&!!x.resolution&&Number.isInteger(x.chart_type)&&Number.isFinite(x.range?.from)&&Number.isFinite(x.range?.to)&&x.range.from<x.range.to,{symbol_present:!!x.symbol,resolution:x.resolution,chart_type:x.chart_type});});
register('CHART-001.read.symbol_metadata',async({driver:d})=>{const x=await d.read(pageFacts,['chart']);return decide(d.panes.symbolIdentitiesMatch(x.symbol,x.resolved),{identity_match:d.panes.symbolIdentitiesMatch(x.symbol,x.resolved)});});
register('DATA-001.read.bars',async({driver:d})=>validateBars(await d.read(pageFacts,['bars'])));
register('DATA-001.read.quote',async({driver:d})=>{const q=await d.data.getQuote();return decide(Number.isFinite(q.last??q.price??q.close),{price_present:Number.isFinite(q.last??q.price??q.close)});});
register('DATA-001.read.study_values',async({driver:d,fixture:f})=>{
  if(!f?.indicator?.entity_id)return blocked('INDICATOR_FIXTURE_MISSING');
  const x=await d.read(entity=>{const ch=globalThis.TradingViewApi._activeChartWidgetWV.value();const s=ch._chartWidget.model().model().dataSources().find(s=>String(s.id())===String(entity));if(!s)return null;const items=s.dataWindowView()?.items?.();const visible=(items||[]).filter(i=>i._title&&i._value!=null&&i._value!=='∅');const valid=visible.every(i=>typeof i._value==='string'?i._value.trim().length>0:Number.isFinite(i._value));return {items:Array.isArray(items),count:visible.length,values_valid:valid,formatted_values:visible.some(i=>typeof i._value==='string')};},[f.indicator.entity_id]);
  return x?decide(x.items&&x.count>0&&x.values_valid,x):blocked('INDICATOR_FIXTURE_MISSING');
});
register('HISTORY-001.read.history_capability',async({driver:d})=>{const b=await d.read(pageFacts,['bars']);return decide(b.request&&typeof b.more==='boolean',{request:b.request,more_type:typeof b.more});});
register('STUDY-001.read.entity_mapping',async({driver:d})=>{const x=await d.read(pageFacts,['study']);return x.count?decide(x.mapped,{count:x.count,mapped:x.mapped}):blocked('STUDY_FIXTURE_MISSING');});
register('STUDY-001.read.metadata',async({driver:d,fixture:f})=>{
  if(!f?.indicator?.entity_id||!f?.strategy?.entity_id)return blocked('STUDY_FIXTURE_MISSING');
  const state=await d.studies.getActivePaneState();const a=state.studies.find(x=>x.entity_id===f.indicator.entity_id),b=state.studies.find(x=>x.entity_id===f.strategy.entity_id);
  if(!a||!b)return blocked('STUDY_FIXTURE_MISSING');return decide(a.type==='indicator'&&b.type==='strategy',{indicator_type:a.type,strategy_type:b.type});
});
register('STUDY-001.read.inputs',async({driver:d,fixture:f})=>{
  const id=f?.strategy?.entity_id||f?.indicator?.entity_id;if(!id)return blocked('STUDY_FIXTURE_MISSING');
  const x=await d.studies.getStudyInputs({entity_id:id});return x.inputs?.length?decide(x.inputs.every(v=>v.id&&v.type),{count:x.inputs.length,fingerprint:x.inputs_fingerprint}):blocked('INPUT_FIXTURE_MISSING');
});
for(const name of ['active_source','report_shape','trades','equity']) register(`STRATEGY-001.read.${name}`,async({driver:d,fixture:f})=>{
  if(!f?.strategy?.entity_id)return blocked('STRATEGY_FIXTURE_MISSING');
  const x=await d.read(pageFacts,['strategy',{entity_id:f.strategy.entity_id}]);if(x.missing)return blocked('STRATEGY_FIXTURE_MISSING');
  if(name==='active_source')return x.active?pass({active:true,status:x.status}):blocked('STRATEGY_NOT_ACTIVE');
  if(x.status!==2)return blocked('STRATEGY_CALCULATING',null,'environment');
  if(name==='report_shape')return decide(x.performance&&x.trade_array&&x.orders_method,{performance:x.performance,trades_array:x.trade_array,orders_method:x.orders_method});
  if(name==='trades')return decide(x.trade_array&&x.ordered&&x.trade_count===x.closed+x.open,{count:x.trade_count,closed:x.closed,open:x.open,ordered:x.ordered});
  return decide(x.equity_type!=='invalid',{equity_type:x.equity_type,available:x.equity_type==='array'});
});
register('PINE-ACCOUNT-001.read.inventory',async({driver:d})=>{const r=await d.pine.listScripts();if(r.error)return blocked('ACCOUNT_UNAVAILABLE',null,'environment');return decide(r.scripts.every(s=>s.script_id&&s.version!=null),{count:r.count},'ACCOUNT_RETURN_SHAPE_CHANGED');},{guard:false});
register('PINE-ACCOUNT-001.read.saved_source',async({driver:d,fixture:f})=>{if(!f?.strategy?.script_id)return blocked('SAVED_PINE_FIXTURE_MISSING');const r=await d.pine.getSavedScript({script_id:f.strategy.script_id});return decide(!!r.pine_source&&r.version!=null,{source_readable:!!r.pine_source,version_present:r.version!=null});},{guard:false});
register('WATCHLIST-001.read.inventory',async({driver:d})=>{const r=await d.watchlist.listWatchlists();return decide(Array.isArray(r.lists)&&r.lists.every(x=>(x.id??x.watchlist_id)!=null&&String(x.id??x.watchlist_id).length>0),{count:r.lists?.length??null});},{guard:false});
register('WATCHLIST-001.read.complete_detail',async({driver:d,fixture:f})=>{if(!f?.watchlist?.name)return blocked('WATCHLIST_FIXTURE_MISSING');const x=await d.watchlist.captureNamedWatchlistSnapshot({name:f.watchlist.name});return decide(x.success!==false,{complete:true,symbol_count:x.snapshot?.symbols?.length??x.symbols?.length??null});},{guard:false});
register('ALERT-001.read.inventory',async({driver:d})=>{
  const x=await d.read(async()=>{try{const r=await fetch('https://pricealerts.tradingview.com/list_alerts',{credentials:'include'});if(!r.ok)return {http_status:r.status};const x=await r.json();return {ok:x.s==='ok',array:Array.isArray(x.r),count:Array.isArray(x.r)?x.r.length:null,valid:Array.isArray(x.r)&&x.r.every(a=>a.alert_id!=null&&a.symbol!=null)};}catch{return {unavailable:true};}});
  if(x.unavailable||x.http_status)return blocked('ACCOUNT_UNAVAILABLE',null,'environment');const result=decide(x.ok&&x.array&&x.valid,x,'ACCOUNT_RETURN_SHAPE_CHANGED');if(result.status==='failed')result.failure_origin='account_service';return result;
},{guard:false});
register('PINE-001.read.editor_model',async({driver:d})=>{const x=await d.read(pageFacts,['editor']);return x.found?decide(x.model&&x.read&&x.write&&x.markers,x):blocked('EDITOR_NOT_OPEN');});
register('UI-001.read.canvas',async({driver:d})=>{const x=await d.read(pageFacts,['canvas']);return decide(x.found&&x.width>0&&x.height>0,x);});
register('UI-001.read.screenshot',async({driver:d})=>{const c=await d.connection.getClient();const x=await c.Page.captureScreenshot({format:'png'});const bytes=Buffer.from(x.data,'base64');return decide(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),{png_valid:bytes.length>8,bytes:bytes.length});});
for(const [name,method] of [['lines','getPineLines'],['labels','getPineLabels'],['tables','getPineTables'],['boxes','getPineBoxes']]) register(`GRAPHICS-001.read.${name}`,async({driver:d,fixture:f})=>{
  if(!f?.graphics?.study_name)return blocked('GRAPHICS_FIXTURE_MISSING');const x=await d.data[method]({study_filter:f.graphics.study_name,verbose:true});
  const matches=x.studies?.filter(s=>s.name===f.graphics.study_name)||[];
  if(matches.length!==1)return blocked('GRAPHICS_FIXTURE_EMPTY_OR_AMBIGUOUS');
  const study=matches[0];let valid=false,count=0;
  if(name==='lines'){const items=study.all_lines||[];count=items.length;valid=items.every(i=>Number.isFinite(i.y1)&&Number.isFinite(i.y2)&&Number.isFinite(i.x1)&&Number.isFinite(i.x2));}
  if(name==='labels'){const items=study.labels||[];count=items.length;valid=items.every(i=>typeof i.text==='string'&&Number.isFinite(i.price)&&Number.isFinite(i.x));}
  if(name==='tables'){const rows=(study.tables||[]).flatMap(t=>t.rows||[]);count=rows.length;valid=rows.every(r=>typeof r==='string'&&r.length>0);}
  if(name==='boxes'){const items=study.all_boxes||[];count=items.length;valid=items.every(i=>Number.isFinite(i.high)&&Number.isFinite(i.low)&&i.high>=i.low&&Number.isFinite(i.x1)&&Number.isFinite(i.x2));}
  return count?decide(valid,{primitive_type:name,count,shape_valid:valid}):blocked('GRAPHICS_FIXTURE_EMPTY');
});
register('DRAWING-001.read.inventory',async({driver:d})=>{const x=await d.drawing.listDrawings();return decide(Array.isArray(x.shapes)&&x.shapes.every(s=>s.id!=null),{count:x.shapes?.length??null});});
register('DRAWING-001.read.properties',async({driver:d,fixture:f})=>{if(!f?.drawing?.entity_id)return blocked('DRAWING_FIXTURE_MISSING');const x=await d.drawing.getProperties({entity_id:f.drawing.entity_id});return decide(Array.isArray(x.points)&&x.points.every(p=>Number.isFinite(p.time)&&Number.isFinite(p.price)),{points:x.points?.length??null});});
register('REPLAY-001.read.capability',async({driver:d})=>{const x=await d.read(pageFacts,['replay']);return decide(x.found&&Object.values(x.methods||{}).every(Boolean),x);});
register('REPLAY-001.read.state',async({driver:d})=>{const x=await d.read(pageFacts,['replay']);return typeof x.available==='boolean'&&typeof x.started==='boolean'?pass({available:x.available,started:x.started}):failed('RETURN_SHAPE_CHANGED');});
export const handlers=read;
