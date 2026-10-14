import vm from 'node:vm';
import { RestoreCoordinator } from './desktop-operation-restore.js';
export function runtimeFixture() {
 const state={symbol:'TEST:A',resolution:'D',type:1,range:{from:100,to:200},inputs:[{id:'length',name:'Length',type:'integer',value:10}],visible:true,shapes:[],strategyStatus:2};
 const bars={firstIndex:()=>0,lastIndex:()=>1,size:()=>2,valueAt:i=>[[1700000000,10,12,9,11,100],[1700000060,11,13,10,12,101]][i]};
 const performance={all:{totalTrades:1,totalOpenTrades:1}};
 const report={performance,trades:[{e:{tm:1}},{e:{tm:2}}]};
 const indicator={id:()=> 'i',metaInfo:()=>({id:'STD;Fixture'}),dataWindowView:()=>({items:()=>[{_title:'Value',_value:'12.5'}]})};
 const strategy={id:()=> 's',status:()=>({type:state.strategyStatus}),reportData:()=>report,ordersData:()=>[],metaInfo:()=>({id:'USER;fixture',isStrategy:true})};
 const inner={dataSources:()=>[indicator,strategy],activeStrategySource:()=>({value:()=>strategy})};
 const series={bars:()=>bars,requestMoreData:async()=>{},requestMoreDataAvailable:()=>true};
 const model={mainSeries:()=>series,model:()=>inner};
 const chart={symbol:()=>state.symbol,symbolExt:()=>({full_name:state.symbol}),resolution:()=>state.resolution,chartType:()=>state.type,getVisibleRange:()=>state.range,_chartWidget:{model:()=>model},getAllStudies:()=>[{id:'i'},{id:'s'}]};
 const globals={globalThis:null,TradingViewApi:{_activeChartWidgetWV:{value:()=>chart}},document:{querySelector:()=>null},console,Promise,setTimeout,clearTimeout,fetch:async()=>({ok:true,json:async()=>({s:'ok',r:[]})})};globals.globalThis=globals;
 const driver={
  cache:{},connection:{getClient:async()=>({Page:{captureScreenshot:async()=>({data:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64')})}})},
  guard:async()=>{},read:async(fn,args=[])=>vm.runInNewContext(`(${fn.toString()})(...__args)`,{...globals,__args:args}),
  panes:{symbolIdentitiesMatch:(a,b)=>a===b},
  chart:{setSymbol:async({symbol})=>{state.symbol=symbol;},setTimeframe:async({timeframe})=>{state.resolution=timeframe;},setType:async({chart_type})=>{state.type=Number(chart_type);},setVisibleRange:async range=>{state.range=range;}},
  data:{getQuote:async()=>({last:12})},
  studies:{getActivePaneState:async()=>({studies:[{entity_id:'i',type:'indicator'},{entity_id:'s',type:'strategy'}]}),getStudyInputs:async()=>({inputs:state.inputs}),getActivePaneStudy:async()=>({inputs:structuredClone(state.inputs),visible:state.visible}),setStudyInputs:async({inputs})=>{state.inputs[0].value=inputs.length;},toggleStudyVisibility:async({visible})=>{state.visible=visible;}},
  drawing:{listDrawings:async()=>({shapes:state.shapes}),drawShape:async({point})=>{state.shapes.push({id:'owned',point});return {entity_id:'owned'};},getProperties:async({entity_id})=>({points:[state.shapes.find(s=>s.id===entity_id).point]}),removeOne:async({entity_id})=>{state.shapes=state.shapes.filter(s=>s.id!==entity_id);}},
 };
 return {state,chart,bars,series,strategy,report,globals,driver,context:{driver,restore:new RestoreCoordinator(),fixture:{target:{layout_name:'dev',pane_index:0},symbols:['TEST:A','TEST:B'],timeframes:['D','60'],indicator:{entity_id:'i'},strategy:{entity_id:'s'},input_mutation:{name:'Length',value:20}}}};
}

// Unit/E2E test support combines production read probes with operation test helpers.
import { handlers as readHandlers } from '../../src/core/compatibility/runtime.js';
import { controlledHandlers } from './desktop-operation-checks.js';
export const handlers = { ...readHandlers, ...controlledHandlers };
