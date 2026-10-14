/** Operation lifecycle/restore test support; not part of Desktop compatibility certification. */
import { randomUUID } from 'node:crypto';
import { pageFacts, pass, blocked, failed, decide } from '../../src/core/compatibility/runtime.js';
function guardedProbe(fn,{guard=true}={}) {
  return async ctx=>{
    if(!ctx.driver)return blocked('CDP_UNAVAILABLE',null,'environment');
    try{
      if(guard)await ctx.driver.guard();
      let answer=await fn(ctx);
      return answer;
    }
    catch(err){
      if(err.kind==='cdp'||/^CDP_/.test(err.code||'')){ctx.restore.quiescent=false;return blocked('CDP_UNAVAILABLE',null,'environment');}
      if(/FIXTURE/.test(err.code||''))return blocked(err.code);
      if(err.code==='CONTEXT_DRIFT')return blocked('CONTEXT_DRIFT',null,'environment');
      if(/not a function|undefined|null|not available/i.test(err.message||''))return failed('PROVIDER_UNAVAILABLE');
      return blocked('PROVIDER_READ_UNRESOLVED',null,'undetermined');
    }
  };
}

const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function waitUntil(read, predicate, {timeout=10000,signal}={}) {
  const end=Date.now()+timeout;let value;
  do {if(signal?.aborted)throw signal.reason;value=await read();if(predicate(value))return value;await delay(150);}while(Date.now()<end);
  return null;
}
/** Restore each effect before the next assertion, retaining an emergency journal. */
export async function effect(ctx,label,undo,verify,operation) {
  let restored=false;
  const cleanup=async()=>{if(!restored){await undo();if(!await verify())throw new Error('Restore readback failed');restored=true;}};
  ctx.restore.register(label,cleanup,async()=>restored);
  try{return await operation();}
  catch(err){if(err.kind==='cdp'||err.code==='CHECK_TIMEOUT')ctx.restore.quiescent=false;throw err;}
  finally{if(ctx.restore.quiescent){try{if(ctx.driver.connection?.withCdpSignal)await ctx.driver.connection.withCdpSignal(null,cleanup);else await cleanup();}catch{ctx.restore.quiescent=false;}}}
}
async function chartEffect(ctx,operation){
  const d=ctx.driver,before=await d.read(pageFacts,['chart']);
  return effect(ctx,'chart_state',async()=>{
    await d.chart.setSymbol({symbol:before.symbol});await d.chart.setTimeframe({timeframe:before.resolution});
    await d.chart.setType({chart_type:before.chart_type});
    if(before.range)await d.chart.setVisibleRange(before.range);
  },async()=>{const x=await d.read(pageFacts,['chart']);const rangeRestored=!before.range||['from','to'].every(key=>Number.isFinite(x.range?.[key])&&Math.abs(x.range[key]-before.range[key])<=1);return d.panes.symbolIdentitiesMatch(x.symbol,before.symbol)&&x.resolution===before.resolution&&x.chart_type===before.chart_type&&rangeRestored;},()=>operation(before));
}
async function switchTo(d,selector){
  const list=await d.tabs.list();const matches=list.tabs.filter(t=>selector.saved_layout_id!=null?String(t.layout?.saved_layout_id)===String(selector.saved_layout_id):t.layout?.layout_name===selector.layout_name);
  if(matches.length!==1)return null;await d.tabs.switchTab({index:matches[0].tab_index});return matches[0];
}
const raw={};const add=(id,fn,options={})=>{raw[id]=guardedProbe(fn,{...options,mutation:true});};
add('CDP-001.controlled.reconnect',async({driver:d})=>{await d.reconnect();return decide(await d.evaluate('21*2')===42,{reconnected:true});},{guard:false});
add('TARGET-001.controlled.tab_switch_restore',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.second_target)return blocked('SECOND_TAB_FIXTURE_MISSING');
  const active=d.inventory.tabs.filter(t=>t.active&&t.is_chart);if(active.length!==1)return blocked('ORIGINAL_TAB_UNRESOLVED');
  const original=active[0];return effect(ctx,'active_tab',async()=>{const list=await d.tabs.list();const tab=list.tabs.find(t=>t.target_id===original.target_id);if(!tab)throw new Error('Original Tab disappeared');await d.tabs.switchTab({index:tab.tab_index});await d.connection.reconnectTo(d.selected.target_id);},async()=>{const list=await d.tabs.list();return list.tabs.some(t=>t.target_id===original.target_id&&t.active);},async()=>{
    const second=await switchTo(d,f.second_target);if(!second||second.target_id===d.selected.target_id)return blocked('SECOND_TAB_FIXTURE_INVALID');
    const switched=(await d.tabs.list()).tabs.some(t=>t.target_id===second.target_id&&t.active);
    await d.connection.reconnectTo(d.selected.target_id);return decide(switched,{tab_switch_verified:switched});
  });
},{guard:false});
add('CONTEXT-001.controlled.pane_switch_restore',async ctx=>{
  const {driver:d,fixture:f}=ctx;const before=await d.metadata();
  if(!Number.isInteger(f?.other_pane_index)||f.other_pane_index===before.active_index||!before.panes[f.other_pane_index])return blocked('SECOND_PANE_FIXTURE_MISSING');
  return effect(ctx,'active_pane',()=>d.panes.focus({index:before.active_index}),async()=>(await d.metadata()).active_index===before.active_index,async()=>{
    await d.panes.focus({index:f.other_pane_index});const after=await d.metadata();return decide(after.active_index===f.other_pane_index,{pane_switch_verified:after.active_index===f.other_pane_index});
  });
});
add('CHART-001.controlled.symbol_resolution',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.symbols||!f?.timeframes)return blocked('SYMBOL_TIMEFRAME_FIXTURE_MISSING');
  return chartEffect(ctx,async()=>{
    for(let i=0;i<2;i++){
      await d.chart.setSymbol({symbol:f.symbols[i]});await d.chart.setTimeframe({timeframe:f.timeframes[i]});
      const ready=await waitUntil(()=>d.read(pageFacts,['chart']),x=>d.panes.symbolIdentitiesMatch(x.symbol,f.symbols[i])&&d.panes.symbolIdentitiesMatch(x.resolved,f.symbols[i])&&x.resolution===f.timeframes[i],ctx);
      if(!ready)return failed('CHART_READBACK_MISMATCH');
    }return pass({switches:2,identity_readback:true});
  });
});
add('CHART-001.controlled.chart_type_range',async ctx=>chartEffect(ctx,async before=>{
  if(!before.range||!Number.isFinite(before.range.from)||!Number.isFinite(before.range.to))return blocked('VISIBLE_RANGE_FIXTURE_MISSING');
  const d=ctx.driver,nextType=before.chart_type===1?2:1;
  await d.chart.setType({chart_type:nextType});const range={from:before.range.from+(before.range.to-before.range.from)/4,to:before.range.to};
  await d.chart.setVisibleRange(range);const x=await waitUntil(()=>d.read(pageFacts,['chart']),x=>x.chart_type===nextType&&x.range?.from>before.range.from,ctx);
  return decide(!!x,{chart_type_readback:!!x,range_changed:!!x});
}));
add('HISTORY-001.controlled.progress',async ctx=>chartEffect(ctx,async()=>{
  const d=ctx.driver,before=await d.read(pageFacts,['bars']);if(!before.more)return blocked('HISTORY_PROGRESS_FIXTURE_EXHAUSTED');
  await d.read(async()=>{const p=globalThis.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().requestMoreData(100);if(p?.then)await p;});
  const after=await waitUntil(()=>d.read(pageFacts,['bars']),x=>x.first_time<before.first_time||x.more===false,ctx);
  d.cache.history={before,after};return after?.first_time<before.first_time?pass({progress:true,loaded_before:before.size,loaded_after:after.size}):blocked('HISTORY_NO_PROGRESS',null,'undetermined');
}));
add('HISTORY-001.controlled.stop',async({driver:d})=>{
  const x=await d.read(pageFacts,['bars']);return x.more===false?pass({stop_reason:'no_more_data'}):blocked('HISTORY_STOP_FIXTURE_NOT_REACHED');
});
add('STUDY-001.controlled.study_lifecycle',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.indicator?.study_id)return blocked('STUDY_DEFINITION_FIXTURE_MISSING');let id;
  return effect(ctx,'created_study',async()=>{if(id&&(await d.studies.getActivePaneState()).studies.some(s=>s.entity_id===id))await d.studies.removeActivePaneStudy({entity_id:id});},async()=>!id||!(await d.studies.getActivePaneState()).studies.some(s=>s.entity_id===id),async()=>{
    const x=await d.studies.addActivePaneStudy({study_id:f.indicator.study_id,_deps:{onCreated:created=>{id=created.entity_id;}}});id=x.instance?.entity_id||x.entity_id;
    if(!id){ctx.restore.quiescent=false;return failed('CREATED_STUDY_ID_UNAVAILABLE');}
    const found=(await d.studies.getActivePaneState()).studies.some(s=>s.entity_id===id);return decide(found,{created_entity_readback:found});
  });
});
add('STUDY-001.controlled.input_visibility',async ctx=>{
  const {driver:d,fixture:f}=ctx;const id=f?.strategy?.entity_id||f?.indicator?.entity_id;
  if(!id||!f?.input_mutation)return blocked('INPUT_MUTATION_FIXTURE_MISSING');
  const before=await d.studies.getActivePaneStudy({entity_id:id});const matches=before.inputs.filter(x=>x.name===f.input_mutation.name);
  if(matches.length!==1||typeof before.visible!=='boolean')return blocked('INPUT_MUTATION_FIXTURE_AMBIGUOUS');const input=matches[0];
  return effect(ctx,'study_inputs_visibility',async()=>{await d.studies.setStudyInputs({entity_id:id,inputs:{[input.id]:input.value}});await d.studies.toggleStudyVisibility({entity_id:id,visible:before.visible});},async()=>{const x=await d.studies.getActivePaneStudy({entity_id:id});return x.visible===before.visible&&x.inputs.find(i=>i.id===input.id)?.value===input.value;},async()=>{
    await d.studies.setStudyInputs({entity_id:id,inputs:{[input.id]:f.input_mutation.value}});await d.studies.toggleStudyVisibility({entity_id:id,visible:!before.visible});
    const x=await d.studies.getActivePaneStudy({entity_id:id});return decide(x.visible!==before.visible&&x.inputs.find(i=>i.id===input.id)?.value===f.input_mutation.value,{input_readback:true,visibility_readback:x.visible!==before.visible});
  });
});
async function strategyContext(d){const m=await d.metadata(),p=m.panes[d.paneIndex];return {target_id:d.selected.target_id,url_chart_id:d.selected.url_chart_id,layout_id:m.layout.layout_id,saved_layout_id:m.layout.saved_layout_id,pane_layout:m.layout.pane_layout,pane_index:d.paneIndex,pane_id:p.pane_id,symbol:p.symbol,resolution:p.resolution};}
add('STRATEGY-001.controlled.freshness',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.strategy?.entity_id||!f.symbols)return blocked('STRATEGY_MUTATION_FIXTURE_MISSING');
  return chartEffect(ctx,async before=>{
    const context=await strategyContext(d);const symbol=f.symbols.find(s=>!d.panes.symbolIdentitiesMatch(s,before.symbol));if(!symbol)return blocked('DISTINCT_SYMBOL_FIXTURE_MISSING');
    const x=await d.trading.getStrategyTradingReport({entity_id:f.strategy.entity_id,symbol,context});
    d.cache.fresh_report=x;return decide(x.success===true&&!!x.snapshot_id&&x.calculation?.fresh===true&&x.calculation?.stable_reads>=2,{fresh_report_obtained:x.calculation?.fresh===true,stable_reads:x.calculation?.stable_reads??null,snapshot_present:!!x.snapshot_id});
  });
});
add('STRATEGY-001.controlled.pagination',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.strategy?.entity_id)return blocked('STRATEGY_FIXTURE_MISSING');
  const context=await strategyContext(d);const base={entity_id:f.strategy.entity_id,symbol:context.symbol,context,limit:1};
  const a=await d.trading.getStrategyTradingData({...base,offset:0});if(a.complete||!a.trades?.length)return blocked('STRATEGY_PAGINATION_FIXTURE_MISSING');
  const b=await d.trading.getStrategyTradingData({...base,offset:1,snapshot_id:a.snapshot_id});
  return decide(a.snapshot_id===b.snapshot_id&&b.trades?.length===1,{snapshot_match:a.snapshot_id===b.snapshot_id,batches:2});
});
add('STRATEGY-001.controlled.open_empty_cases',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!Array.isArray(f?.strategy_cases)||f.strategy_cases.length<2)return blocked('STRATEGY_CASE_FIXTURES_MISSING');
  const cases=[];for(const c of f.strategy_cases){if(!c.entity_id||!['open','empty'].includes(c.kind))return blocked('STRATEGY_CASE_FIXTURE_INVALID');const x=await d.read(pageFacts,['strategy',{entity_id:c.entity_id}]);if(x.missing||x.status!==2)return blocked('STRATEGY_CASE_NOT_READY');cases.push({kind:c.kind,matches:c.kind==='open'?x.open>0:x.trade_count===0});}
  return decide(cases.some(c=>c.kind==='open')&&cases.some(c=>c.kind==='empty')&&cases.every(c=>c.matches),{cases});
});
add('PINE-ACCOUNT-001.controlled.script_lifecycle',async ctx=>{
  const d=ctx.driver;let id;const source='//@version=6\nindicator("Compatibility fixture")\nplot(close)\n';const name=`compatibility-${randomUUID()}`;
  return effect(ctx,'saved_test_pine',async()=>{if(id&&(await d.pine.listScripts()).scripts.some(s=>s.script_id===id))await d.pine.deleteSavedScript({script_id:id,confirmed:true});},async()=>!id||!(await d.pine.listScripts()).scripts.some(s=>s.script_id===id),async()=>{
    const created=await d.pine.createSavedScript({name,type:'indicator',source,_deps:{onCreated:created=>{id=created.script_id;}}});id=created.script_id;if(!id){ctx.restore.quiescent=false;return failed('CREATED_SCRIPT_ID_UNAVAILABLE');}
    const next=await d.pine.updateSavedScript({script_id:id,source:source.replace('plot(close)','plot(open)')});const readback=await d.pine.getSavedScript({script_id:id});
    return decide(created.success&&next.success&&String(next.version)!==String(created.version)&&readback.pine_source.includes('plot(open)'),{created:true,version_changed:String(next.version)!==String(created.version),source_readback:true});
  });
},{guard:false});
add('WATCHLIST-001.controlled.symbols_restore',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.watchlist?.mutable||!f.watchlist.test_symbol)return blocked('MUTABLE_WATCHLIST_FIXTURE_MISSING');
  const capture=await d.watchlist.captureNamedWatchlistSnapshot({name:f.watchlist.name});const snapshot=capture;
  const panel=await d.read(watchlistPanelStatePage,[d.ui.RIGHT_PANEL_LOCATORS.watchlist]);
  if(panel.button_count!==1||!panel.watchlist_open)return blocked('TEST_WATCHLIST_PANEL_NOT_OPEN');const active=await d.watchlist.getWatchlist();
  if(String(active.list_id)!==String(capture.watchlist.watchlist_id))return blocked('TEST_WATCHLIST_NOT_ACTIVE');
  const symbol=f.watchlist.test_symbol;if(snapshot.symbols.includes(symbol))return blocked('WATCHLIST_TEST_SYMBOL_ALREADY_PRESENT');
  return effect(ctx,'test_watchlist_symbol',()=>d.watchlist.remove({symbols:[symbol]}),async()=>{const x=await d.watchlist.captureNamedWatchlistSnapshot({name:f.watchlist.name});return JSON.stringify(x.symbols)===JSON.stringify(snapshot.symbols);},async()=>{
    await d.watchlist.add({symbol});const x=await d.watchlist.captureNamedWatchlistSnapshot({name:f.watchlist.name});return decide(x.symbols.includes(symbol),{added_symbol_readback:x.symbols.includes(symbol)});
  });
},{guard:false});
add('ALERT-001.controlled.alert_lifecycle',async ctx=>{
  const {driver:d,fixture:f}=ctx;
  if(!Number.isFinite(f?.alert?.price))return blocked('ALERT_PRICE_FIXTURE_MISSING');
  let id;
  return effect(ctx,'created_alert',async()=>{if(id&&(await d.alerts.list()).alerts.some(a=>a.alert_id===id))await d.alerts.deleteAlerts({alert_id:id});},async()=>{const x=await d.alerts.list();return !x.error&&(!id||!x.alerts.some(a=>a.alert_id===id));},async()=>{
    const x=await d.alerts.create({condition:'greater_than',price:f.alert.price,message:`compatibility-${randomUUID()}`,notifications:false});id=x.alert_id;
    if(!x.success)return blocked('ALERT_CREATE_UNAVAILABLE',null,'undetermined');
    if(!id){ctx.restore.quiescent=false;return failed('CREATED_ALERT_ID_UNAVAILABLE');}
    const found=(await d.alerts.list()).alerts.some(a=>a.alert_id===id);
    return decide(found,{create_readback:found,notifications:false});
  });
});
export function editorStudyInventoryPage() {
  const chart=globalThis.TradingViewApi._activeChartWidgetWV.value();
  return chart.getAllStudies().map(s=>({entity_id:String(s.id),script_id:chart.getStudyById(s.id).getInputValues().find(i=>i.id==='pineId')?.value??null}));
}
add('PINE-001.controlled.compile_success_error',async ctx=>{
  const {driver:d,fixture:f}=ctx;
  if(!f?.editor?.disposable||!f.editor.script_name)return blocked('DISPOSABLE_EDITOR_FIXTURE_MISSING');
  // Require a test-owned editor script and a pristine buffer before altering it.
  const editor=await d.read(pageFacts,['editor']);if(!editor.model)return blocked('EDITOR_NOT_OPEN');
  const listed=(await d.pine.listScripts()).scripts.filter(s=>s.name===f.editor.script_name);
  if(listed.length!==1||!f.editor.script_id||listed[0].script_id!==f.editor.script_id)return blocked('EDITOR_SCRIPT_OWNERSHIP_UNVERIFIED');
  const original=await d.pine.getSource();const saved=await d.pine.getSavedScript({script_id:f.editor.script_id});
  if(original.source!==saved.pine_source)return blocked('EDITOR_DIRTY_OR_DIFFERENT_SCRIPT');
  const inventory=()=>d.read(editorStudyInventoryPage);
  const beforeStudies=await inventory();
  // Compile can update an existing instance. Require the disposable script to be unattached.
  if(beforeStudies.some(s=>s.script_id===f.editor.script_id))return blocked('EDITOR_SCRIPT_ALREADY_ON_CHART');
  const beforeIds=new Set(beforeStudies.map(s=>s.entity_id));
  const owned=s=>!beforeIds.has(s.entity_id)&&s.script_id===f.editor.script_id;
  return effect(ctx,'editor_buffer_and_test_studies',async()=>{
    await d.pine.updateSavedScript({script_id:f.editor.script_id,source:original.source});
    await d.pine.setSource({source:original.source});
    for(const s of await inventory())if(owned(s))await d.studies.removeActivePaneStudy({entity_id:s.entity_id});
  },async()=>(await d.pine.getSource()).source===original.source&&(await d.pine.getSavedScript({script_id:f.editor.script_id})).pine_source===original.source&&(await inventory()).every(s=>beforeIds.has(s.entity_id)),async()=>{
    await d.pine.setSource({source:'//@version=6\nindicator("Compatibility compile")\nplot(close)'});await d.pine.compile();
    const ok=await d.pine.getErrors();
    await d.pine.setSource({source:'//@version=6\nindicator("Compatibility compile")\nplot('});await d.pine.compile();
    const bad=await waitUntil(()=>d.pine.getErrors(),x=>(x.errors||[]).length>0,{signal:ctx.signal});
    return decide((ok.errors||[]).length===0&&!!bad,{valid_source_errors:(ok.errors||[]).length,invalid_source_has_errors:!!bad});
  });
});
export function watchlistPanelStatePage(locators) {
  const doc=globalThis.document;
  const matches=locators.dataNames.flatMap(name=>Array.from(doc.querySelectorAll('[data-name="'+name+'"]'))).filter(el=>(el.tagName==='BUTTON'||el.getAttribute('role')==='button')&&(el.offsetWidth||el.offsetHeight));
  const buttons=[...new Set(matches)];const btn=buttons[0];
  const active=btn&&(btn.getAttribute('aria-pressed')==='true'||/active/i.test(btn.className));
  const area=doc.querySelector('[class*="layout__area--right"]');const areaOpen=!!(area&&area.offsetWidth>50);
  return {button_count:buttons.length,area_open:areaOpen,watchlist_open:!!(areaOpen&&active),dialog_present:!!doc.querySelector('[data-name="indicators-dialog"]'),text_input_active:['INPUT','TEXTAREA'].includes(doc.activeElement?.tagName)};
}
add('UI-001.controlled.panels_dialogs',async ctx=>{
  const {driver:d,fixture:f}=ctx;
  if(!f?.ui?.indicator_query)return blocked('INDICATOR_DIALOG_QUERY_FIXTURE_MISSING');
  const state=()=>d.read(watchlistPanelStatePage,[d.ui.RIGHT_PANEL_LOCATORS.watchlist]);
  const before=await state();
  if(before.button_count!==1||before.dialog_present||before.text_input_active||before.area_open&&!before.watchlist_open)return blocked('UI_FIXTURE_NOT_IDLE');
  return effect(ctx,'watchlist_panel_and_indicator_dialog',async()=>{
    const current=await state();
    if(current.dialog_present)await d.ui.keyboard({key:'Escape'});
    await d.ui.openPanel({panel:'watchlist',action:before.watchlist_open?'open':'close'});
  },async()=>{const x=await state();return x.watchlist_open===before.watchlist_open&&!x.dialog_present;},async()=>{
    await d.ui.openPanel({panel:'watchlist',action:before.watchlist_open?'close':'open'});
    const toggled=await waitUntil(state,x=>x.watchlist_open!==before.watchlist_open,ctx);
    if(!toggled)return failed('PANEL_READBACK_MISMATCH');
    const search=await d.indicators.searchStudies({query:f.ui.indicator_query,limit:3});
    if(!search.success||search.count<1)return blocked('INDICATOR_QUERY_FIXTURE_EMPTY');
    await d.ui.click({by:'data-name',value:'open-indicators-dialog'});
    const opened=await waitUntil(state,x=>x.dialog_present,ctx);if(!opened)return failed('DIALOG_READBACK_MISMATCH');
    await d.ui.keyboard({key:'Escape'});
    const closed=await waitUntil(state,x=>!x.dialog_present,ctx);
    return decide(!!closed,{panel_readback:true,dialog_search:true,input_escape_closed:!!closed});
  });
});
add('UI-001.controlled.tab_lifecycle',async ctx=>{
  const {driver:d,fixture:f}=ctx;if(!f?.second_target)return blocked('TAB_LAYOUT_FIXTURE_MISSING');
  const before=await d.tabs.list();let ownedTarget=null;
  const originalActive=before.tabs.filter(t=>t.active&&t.is_chart);
  if(before.tabs.some(t=>!t.is_chart)||originalActive.length!==1)return blocked('UNOWNED_LANDING_TAB_OR_ACTIVE_TARGET_UNRESOLVED');
  return effect(ctx,'created_tab',async()=>{
    if(ownedTarget){const now=await d.tabs.list();const tab=now.tabs.find(t=>t.target_id===ownedTarget);if(tab){await d.tabs.switchTab({index:tab.tab_index});await d.tabs.closeTab();}}
    const now=await d.tabs.list();const original=now.tabs.find(t=>t.target_id===originalActive[0].target_id);if(original)await d.tabs.switchTab({index:original.tab_index});await d.connection.reconnectTo(d.selected.target_id);
  },async()=>!(await d.tabs.list()).tabs.some(t=>t.target_id===ownedTarget),async()=>{
    const created=await d.tabs.newTab({layout:f.second_target.layout_name||String(f.second_target.saved_layout_id)});
    const now=await d.tabs.list();const added=now.tabs.filter(t=>!before.tabs.some(b=>b.target_id===t.target_id));
    if(added.length!==1||!added[0].is_chart){ctx.restore.quiescent=false;return failed('CREATED_TAB_OWNERSHIP_UNRESOLVED');}
    ownedTarget=added[0].target_id;await d.connection.reconnectTo(d.selected.target_id);
    return decide(created.success!==false,{new_target_verified:true});
  });
});
add('UI-001.controlled.depth',async({driver:d,fixture:f})=>{
  const entitlement=f?.entitlements?.depth;
  if(entitlement?.applicable===false&&typeof entitlement.evidence==='string'&&entitlement.evidence.trim())return {status:'not_applicable',reason_code:'ENTITLEMENT_NOT_APPLICABLE',observed:{evidence:entitlement.evidence.slice(0,200)}};
  if(entitlement?.applicable!==true)return blocked('DEPTH_ENTITLEMENT_UNKNOWN');
  const x=await d.data.getDepth();return x.found===false||x.error?blocked('DEPTH_PANEL_FIXTURE_MISSING'):decide(Array.isArray(x.bids)&&Array.isArray(x.asks),{bids:x.bids?.length,asks:x.asks?.length});
});
add('DRAWING-001.controlled.shape_lifecycle',async ctx=>{
  const d=ctx.driver,b=await d.read(pageFacts,['bars']);const point=b.sample.at(-1);if(!point)return blocked('DRAWING_BAR_FIXTURE_MISSING');let id;
  return effect(ctx,'created_drawing',async()=>{if(id&&(await d.drawing.listDrawings()).shapes.some(s=>s.id===id))await d.drawing.removeOne({entity_id:id});},async()=>!id||!(await d.drawing.listDrawings()).shapes.some(s=>s.id===id),async()=>{
    const created=await d.drawing.drawShape({shape:'horizontal_line',point:{time:point[0],price:point[4]}});id=created.entity_id;
    if(!id){ctx.restore.quiescent=false;return failed('CREATED_DRAWING_ID_UNAVAILABLE');}
    const x=await d.drawing.getProperties({entity_id:id});return decide(x.points?.some(p=>Math.abs(p.price-point[4])<1e-8),{geometry_readback:!!x.points?.length});
  });
});
async function replayEffect(ctx,operation){
  const {driver:d,fixture:f}=ctx;if(!f?.replay_target)return blocked('REPLAY_FIXTURE_MISSING');
  if(f.replay_target.layout_name!=null&&f.replay_target.layout_name===f.target?.layout_name||f.replay_target.saved_layout_id!=null&&f.replay_target.saved_layout_id===f.target?.saved_layout_id)return blocked('REPLAY_FIXTURE_MUST_BE_SEPARATE');
  let replayTarget,originalChart;
  return effect(ctx,'replay_session',async()=>{
    if(replayTarget){await d.connection.reconnectTo(replayTarget.target_id);await d.replay.stop();}
    await d.connection.reconnectTo(d.selected.target_id);
  },async()=>{
    if(!replayTarget)return true;
    await d.connection.reconnectTo(replayTarget.target_id);const state=await d.replay.status();const chart=await d.read(pageFacts,['chart']);await d.connection.reconnectTo(d.selected.target_id);
    return !state.is_replay_started&&chart.symbol===originalChart?.symbol&&chart.resolution===originalChart?.resolution;
  },async()=>{
    const list=await d.tabs.list();const matches=list.tabs.filter(t=>f.replay_target.saved_layout_id!=null?String(t.layout?.saved_layout_id)===String(f.replay_target.saved_layout_id):t.layout?.layout_name===f.replay_target.layout_name);
    if(matches.length!==1||matches[0].target_id===d.selected.target_id)return blocked('REPLAY_FIXTURE_MISSING');
    await d.connection.reconnectTo(matches[0].target_id);
    const current=await d.replay.status();
    if(current.is_replay_started){await d.connection.reconnectTo(d.selected.target_id);return blocked('REPLAY_ALREADY_IN_USE');}
    const metadata=await d.metadata();if(metadata.active_index!==f.replay_target.pane_index){await d.connection.reconnectTo(d.selected.target_id);return blocked('REPLAY_PANE_NOT_ACTIVE');}
    replayTarget=matches[0];originalChart=await d.read(pageFacts,['chart']);
    const start=await d.replay.start();if(!start.replay_started)return failed('REPLAY_START_FAILED');
    return operation();
  });
}
add('REPLAY-001.controlled.start_step_stop',async ctx=>replayEffect(ctx,async()=>{
  const d=ctx.driver;const before=await d.replay.status();await d.replay.step();const after=await d.replay.status();
  return decide(after.is_replay_started&&after.current_date!==before.current_date,{step_changed:after.current_date!==before.current_date});
}));
add('REPLAY-001.controlled.trading',async ctx=>replayEffect(ctx,async()=>{
  const d=ctx.driver;
  const safe=await d.read(()=>{const c=globalThis.TradingViewApi._replayApi._replayUIController?._replayTradingUIController;return c&&typeof c.clearExecutions==='function'&&typeof c.isTradingReplaySessionHasExecutions==='function'&&!c.isTradingReplaySessionHasExecutions();});
  if(!safe)return blocked('REPLAY_TRADING_NOT_EMPTY_OR_CLEANUP_UNAVAILABLE');
  return effect(ctx,'replay_executions',async()=>{
    await d.replay.trade({action:'close'});await d.read(()=>{const api=globalThis.TradingViewApi;const c=api._replayApi._replayUIController._replayTradingUIController;c.clearExecutions(api._activeChartWidgetWV.value()._chartWidget.model().model().id());});
  },async()=>d.read(()=>!globalThis.TradingViewApi._replayApi._replayUIController._replayTradingUIController.isTradingReplaySessionHasExecutions()),async()=>{
    const x=await d.replay.trade({action:'buy'});return decide(x.success&&x.position!=null,{position_available:x.position!=null});
  });
}));
export const controlledHandlers=raw;
