// Keep reconnecting without changing the server job's last known state.
export function createRunObserver({read,onError,onConnected,schedule=setTimeout,unschedule=clearTimeout}) {
  let generation=0,timer=null,failures=0;
  return async function observe(runId) {
    const current=++generation;
    unschedule(timer);
    const isCurrent=()=>current===generation;
    try {
      const again=await read(runId,isCurrent);
      if(!isCurrent())return;
      failures=0;onConnected();
      if(again)timer=schedule(()=>observe(runId),2000);
    } catch(error) {
      if(!isCurrent())return;
      // A missing historical run cannot recover by polling (e.g. a different DATA_ROOT).
      if(error.status===404){onError(error,0);return;}
      failures++;onError(error,failures);
      timer=schedule(()=>observe(runId),Math.min(30000,2000*2**Math.min(failures,4)));
    }
  };
}
