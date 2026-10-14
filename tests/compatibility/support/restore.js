/** Serial effect journal: register undo before mutation, verify after undo. */
export class RestoreCoordinator {
  constructor({ timeout_ms=20000 }={}) { this.entries=[];this.timeout=timeout_ms;this.quiescent=true; }
  register(label,undo,verify) { this.entries.push({label,undo,verify}); }
  async restore() {
    const results=[];
    const deadline=Date.now()+60000;
    if(!this.quiescent) return {status:'failed',attempted:false,fields:[],pending:this.entries.map(e=>e.label),reason:'OPERATION_NOT_QUIESCENT'};
    for(const entry of this.entries.reverse()) {
      let timer;
      try {
        await Promise.race([(async()=>{await entry.undo();if(!await entry.verify()) throw new Error('Restore readback mismatch');})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Restore timed out')),Math.max(1,Math.min(this.timeout,deadline-Date.now())));})]);
        results.push({field:entry.label,status:'passed'});
      }catch{
        results.push({field:entry.label,status:'failed'});
        // Unknown pending page work must not overlap a second restoration mutation.
        this.quiescent=false;break;
      }finally{clearTimeout(timer);}
    }
    return {attempted:this.entries.length>0,status:results.every(r=>r.status==='passed')&&this.quiescent?'passed':'failed',fields:results,pending:this.entries.slice(results.length).map(e=>e.label)};
  }
}
