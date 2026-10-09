/* Coverage Lift 2.0.0. Pure numerical twin of metrics.py; no DOM or network.
 * Distances are yards, rates yards/second, times seconds, percentages 0..100.
 * options: scope coverage|all, threshold, lookback, minDuration,
 * downfieldOnly, inBoundsOnly, throughFrame/throughTime, maxGap.
 * Shapley and association analyses are deliberately on-demand operations.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '2.0.0', EPS = 1e-9;
  const DEFAULTS = Object.freeze({scope:'coverage',threshold:3,lookback:.5,minDuration:.2,downfieldOnly:true,inBoundsOnly:true,fieldWidth:53.3,fieldLength:120,maxGap:.15});
  const lexical = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);
  function options(input) {
    const o = {...DEFAULTS,...(input||{})};
    if (!['coverage','all'].includes(o.scope)) throw new RangeError('scope must be coverage or all');
    for (const key of ['threshold','lookback','minDuration','fieldWidth','fieldLength','maxGap']) {
      if (!isFiniteNumber(o[key]) || o[key] < 0) throw new RangeError(key+' must be a finite nonnegative number');
      if (['lookback','fieldWidth','fieldLength','maxGap'].includes(key) && !o[key]) throw new RangeError(key+' must be positive');
    }
    return o;
  }
  const player = (play,id) => (play.players||[]).find(p=>String(p.id)===String(id));
  function point(p,frame) {
    if (!p || !Number.isInteger(frame) || frame<0) return null;
    const row=p.track?.[frame];
    return Array.isArray(row)&&row.length>=2&&row.slice(0,2).every(isFiniteNumber)?row.slice(0,2):null;
  }
  function frameAt(play,time) {
    const times=play.times||[];
    if(!times.length)return -1;
    let lo=0,hi=times.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(times[mid]<=time+EPS)lo=mid;else hi=mid-1;}
    return lo;
  }
  function endFrame(play,o) {
    const times=play.times||[];
    let last=times.length-1;
    if ('throughTime' in o) {if(!times.length||o.throughTime<times[0]-EPS)return -1;last=Math.min(last,frameAt(play,o.throughTime));}
    if ('throughFrame' in o) last=Math.min(last,Math.trunc(o.throughFrame));
    return Math.max(-1,last);
  }
  function defenders(play,scope='coverage') {
    if(!['coverage','all'].includes(scope))throw new RangeError('scope must be coverage or all');
    return (play.players||[]).filter(p=>p.side==='defense'&&(scope==='all'||p.role==='coverage')).sort((a,b)=>lexical(String(a.id),String(b.id)));
  }
  function eligible(play,p,o) {
    if(!p)return [false,'Missing receiver position'];
    if(o.inBoundsOnly&&!(p[0]>=0&&p[0]<=o.fieldLength&&p[1]>=0&&p[1]<=o.fieldWidth))return [false,'Receiver outside field boundaries'];
    if(o.downfieldOnly&&p[0]<Number(play.los||0)-EPS)return [false,'Receiver behind line of scrimmage'];
    return [true,''];
  }
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const space=(q,ds)=>Math.min(...ds.map(d=>distance(q,d)));
  function orderedDistances(play,q,frame,o) {
    const ds=defenders(play,o.scope);
    if(!ds.length||ds.some(d=>point(d,frame)===null))return [];
    return ds.map(d=>[distance(q,point(d,frame)),String(d.id)]).sort((a,b)=>a[0]-b[0]||lexical(a[1],b[1]));
  }
  function nearest(play,receiverId,frame,input) {
    const o=options(input),r=player(play,receiverId),p=point(r,frame);
    const invalid={valid:false,distance:null,nearestId:null,secondDistance:null,secondId:null,within3:0,within5:0,closingRate:null,separationRate:null,leverage:null,nearestSwitch:false};
    if(!p||frame>=(play.times||[]).length)return {...invalid,reason:'Missing receiver observation'};
    const ranked=orderedDistances(play,p,frame,o);
    if(!ranked.length)return {...invalid,reason:'Incomplete or absent defender observations'};
    const [d,id]=ranked[0],dp=point(player(play,id),frame),inside=Math.abs(dp[1]-o.fieldWidth/2)<Math.abs(p[1]-o.fieldWidth/2),deeper=dp[0]>p[0];
    const leverage={lateral:dp[1]-p[1],downfield:dp[0]-p[0],inside,deeper,label:(inside?'inside':'outside')+(deeper?' / deeper':' / shallower')};
    let rate=null,switched=false;
    const previous=point(r,frame-1);
    if(frame>0&&previous){const dt=play.times[frame]-play.times[frame-1],before=orderedDistances(play,previous,frame-1,o);if(before.length&&dt>0&&dt<=o.maxGap+EPS){rate=(d-before[0][0])/dt;switched=before[0][1]!==id;}}
    return {valid:true,reason:'',distance:d,nearestId:id,secondDistance:ranked[1]?.[0]??null,secondId:ranked[1]?.[1]??null,within3:ranked.filter(x=>x[0]<=3).length,within5:ranked.filter(x=>x[0]<=5).length,closingRate:rate===null?null:-rate,separationRate:rate,leverage,nearestSwitch:switched};
  }
  function liftInputs(play,receiverId,frame,o) {
    const times=play.times||[];
    if(frame<0||frame>=times.length||frame>endFrame(play,o))return [null,'Frame outside observed analysis range'];
    if(times[frame]-times[0]<o.lookback-EPS)return [null,'Insufficient lookback history'];
    const before=frameAt(play,times[frame]-o.lookback);
    if(before<0||before===frame)return [null,'Insufficient lookback history'];
    for(let i=before;i<frame;i++){const dt=times[i+1]-times[i];if(!(dt>0&&dt<=o.maxGap+EPS))return [null,'Gap in observed lookback history'];}
    const r=player(play,receiverId),b0=point(r,before),b1=point(r,frame),ds=defenders(play,o.scope);
    if(!b0||!b1||!ds.length||ds.some(d=>!point(d,before)||!point(d,frame)))return [null,'Incomplete receiver or defender observations'];
    return [{before,b0,b1,ds,d0:ds.map(d=>point(d,before)),d1:ds.map(d=>point(d,frame))},''];
  }
  function decompose(b0,b1,d0,d1) {
    const s00=space(b0,d0),s01=space(b0,d1),s10=space(b1,d0),s11=space(b1,d1);
    const coverage=((s01-s00)+(s11-s10))/2,receiver=((s10-s00)+(s11-s01))/2,gain=s11-s00;
    return {separationBefore:s00,separationAfter:s11,coverage,receiver,gain,rawCaptured:Math.min(Math.max(coverage,0),Math.max(gain,0)),hybrids:{beforeReceiverAfterCoverage:s01,afterReceiverBeforeCoverage:s10}};
  }
  function coverageLift(play,receiverId,frame,input) {
    const o=options(input),[args,reason]=liftInputs(play,receiverId,frame,o);
    const base={frame,time:play.times?.[frame]??null,lookback:o.lookback,scope:o.scope};
    if(!args)return {...base,valid:false,eligible:false,reason,coverage:null,receiver:null,gain:null,captured:null,rawCaptured:null,rate:null,previousFrame:null,elapsed:null,separationBefore:null,separationAfter:null,nearestBefore:null,nearestAfter:null,nearestSwitch:false};
    const {before,b0,b1,ds,d0,d1}=args,result=decompose(b0,b1,d0,d1),e0=eligible(play,b0,o),e1=eligible(play,b1,o),ok=e0[0]&&e1[0],elapsed=play.times[frame]-play.times[before];
    const near=(b,d)=>ds.map((v,i)=>[distance(b,d[i]),String(v.id)]).sort((a,b)=>a[0]-b[0]||lexical(a[1],b[1]))[0][1];
    const nearestBefore=near(b0,d0),nearestAfter=near(b1,d1),end=play.times.at(-1);
    return {...base,...result,valid:true,eligible:ok,reason:e0[1]||e1[1],captured:ok?result.rawCaptured:0,rate:result.coverage/elapsed,previousFrame:before,elapsed,nearestBefore,nearestAfter,nearestSwitch:nearestBefore!==nearestAfter,endpointTime:end,releaseLead:play.endpointLabel==='Pass release'?end-play.times[frame]:null};
  }
  function series(play,receiverId,input) {
    const o=options(input),r=player(play,receiverId),output=[];
    for(let frame=0;frame<=endFrame(play,o);frame++){const n=nearest(play,receiverId,frame,o),lift=coverageLift(play,receiverId,frame,o),e=eligible(play,point(r,frame),o);output.push({...n,...lift,observationValid:n.valid,windowEligible:n.valid&&e[0],eligibilityReason:e[1],distance:n.distance,nearestId:n.nearestId});}
    return output;
  }
  function windows(play,receiverId,input) {
    const o=options(input),last=endFrame(play,o),times=(play.times||[]).slice(0,last+1),r=player(play,receiverId);
    const rows=times.map((_,i)=>{const n=nearest(play,receiverId,i,o),e=eligible(play,point(r,i),o);return {distance:n.distance,eligible:e[0]&&n.valid,reason:e[1]};});
    let intervals=[];let active=null,eligibleSeconds=0;
    for(let i=0;i<times.length-1;i++){
      const dt=times[i+1]-times[i],validInterval=dt>0&&dt<=o.maxGap+EPS&&rows[i].eligible&&rows[i+1].distance!==null;
      if(validInterval)eligibleSeconds+=dt;
      const open=validInterval&&rows[i].distance>=o.threshold;
      if(open&&active===null){const prior=i>0&&rows[i-1].eligible&&times[i]-times[i-1]>0&&times[i]-times[i-1]<=o.maxGap+EPS;active={start:times[i],startFrame:i,leftCensored:!prior||rows[i-1].distance>=o.threshold};}
      if(active&&!open){const natural=rows[i].eligible&&rows[i].distance!==null&&rows[i].distance<o.threshold;intervals.push({...active,end:times[i],endFrame:i,duration:times[i]-active.start,rightCensored:!natural,endReason:natural?'threshold crossed':'eligibility or observation ended'});active=null;}
    }
    if(active){const natural=!!(rows.length&&rows.at(-1).eligible&&rows.at(-1).distance!==null&&rows.at(-1).distance<o.threshold);intervals.push({...active,end:times.at(-1),endFrame:times.length-1,duration:times.at(-1)-active.start,rightCensored:!natural,endReason:natural?'threshold crossed':last<(play.times||[]).length-1?'analysis cutoff':'tracking ended'});}
    const rawIntervals=intervals,rawTotal=rawIntervals.reduce((s,w)=>s+w.duration,0);
    intervals=rawIntervals.filter(w=>{
      if(w.duration+EPS<o.minDuration)return false;
      let confirm=null;for(let i=w.startFrame;i<=w.endFrame;i++)if(times[i]>=w.start+o.minDuration-EPS){confirm=i;break;}
      if(confirm===null)return false;
      for(let i=w.startFrame;i<=confirm;i++)if(!rows[i].eligible||rows[i].distance<o.threshold)return false;
      return true;
    });
    const total=intervals.reduce((s,w)=>s+w.duration,0),first=intervals.find(w=>!w.leftCensored)?.start??null,release=play.endpointLabel==='Pass release',endpoint=play.times?.at(-1)??0;
    return {intervals,total,longest:Math.max(0,...intervals.map(w=>w.duration)),rawIntervals,rawTotal,rawLongest:Math.max(0,...rawIntervals.map(w=>w.duration)),rawPercentEligible:eligibleSeconds>0?100*rawTotal/eligibleSeconds:null,minDuration:o.minDuration,percentEligible:eligibleSeconds>0?100*total/eligibleSeconds:null,timeToFirst:first,releaseLead:release&&first!==null?endpoint-first:null,lastWindowToRelease:release&&intervals.length?endpoint-intervals.at(-1).end:null,eligibleSeconds,observedUntil:times.at(-1)??null,threshold:o.threshold,scope:o.scope};
  }
  function events(play,receiverId,input) {
    const o=options(input),output=[];
    for(const w of windows(play,receiverId,o).intervals){
      if(w.leftCensored||w.duration+EPS<o.minDuration)continue;
      const frame=w.startFrame,lift=coverageLift(play,receiverId,frame,o);
      if(!lift.valid||!lift.eligible||lift.separationBefore>=o.threshold||lift.gain<=0)continue;
      let confirm=null;for(let i=frame;i<=w.endFrame;i++)if(play.times[i]>=w.start+o.minDuration-EPS){confirm=i;break;}
      if(confirm===null)continue;
      let holds=true;for(let i=frame;i<=confirm;i++){const n=nearest(play,receiverId,i,o);if(!n.valid||n.distance<o.threshold||!eligible(play,point(player(play,receiverId),i),o)[0]){holds=false;break;}}
      if(!holds)continue;
      const distances=[];for(let i=frame;i<=w.endFrame;i++)distances.push(nearest(play,receiverId,i,o).distance);
      output.push({...lift,onsetFrame:frame,onset:w.start,confirmedAt:play.times[confirm],end:w.end,duration:w.duration,leftCensored:false,rightCensored:w.rightCensored,peakSeparation:Math.max(...distances),receiverId:String(receiverId),playId:play.id??null});
    }
    return output;
  }
  function defaultReceiver(play,input) {
    const o=options(input),rows=[];
    for(const p of play.players||[])if(p.side==='offense'&&p.role==='route'){const ev=events(play,p.id,o),w=windows(play,p.id,o);rows.push({id:String(p.id),captured:Math.max(0,...ev.map(e=>e.captured)),longest:w.longest});}
    rows.sort((a,b)=>b.captured-a.captured||b.longest-a.longest||lexical(a.id,b.id));return rows[0]?.id??null;
  }
  function context(play,receiverId,frame,input) {
    const o=options(input),r=player(play,receiverId),p=point(r,frame),n=nearest(play,receiverId,frame,o),lift=coverageLift(play,receiverId,frame,o),e=eligible(play,p,o),row=p?r.track[frame]:[];
    return {...n,...lift,nearest:n,lift,x:p?.[0]??null,y:p?.[1]??null,speed:row[2]??null,direction:row[3]??null,orientation:row[4]??null,acceleration:row[5]??null,downfield:p?p[0]-(play.los||0):null,windowEligible:e[0]&&n.valid,eligibilityReason:e[1],roleScope:o.scope,quality:play.quality||{},cohortEligible:play.cohortEligible??true,nullified:play.penalty?.nullified??false,instantNearestSwitch:n.nearestSwitch,observedTime:p?play.times?.[frame]??null:null};
  }
  function inspectPoint(play,q,frame,input) {
    const o=options(input),p=Array.isArray(q)?q:[q?.x,q?.y];
    const invalid={valid:false,reason:'Invalid point or frame',distance:null,change:null,previousDistance:null,changeValid:false,nearestId:null,secondDistance:null,within3:0,within5:0};
    if(p.length!==2||!p.every(isFiniteNumber)||!(frame>=0&&frame<=endFrame(play,o)))return invalid;
    const now=orderedDistances(play,p,frame,o);if(!now.length)return {...invalid,reason:'Incomplete or absent defender observations'};
    const t=play.times[frame],before=frameAt(play,t-o.lookback);let history=t-play.times[0]>=o.lookback-EPS&&before<frame;
    if(history)for(let i=before;i<frame;i++){const dt=play.times[i+1]-play.times[i];if(!(dt>0&&dt<=o.maxGap+EPS))history=false;}
    const old=history?orderedDistances(play,p,before,o):[];
    return {valid:true,reason:old.length?'':'Insufficient complete lookback history',x:p[0],y:p[1],time:t,frame,distance:now[0][0],nearestId:now[0][1],secondDistance:now[1]?.[0]??null,within3:now.filter(x=>x[0]<=3).length,within5:now.filter(x=>x[0]<=5).length,previousDistance:old[0]?.[0]??null,change:old.length?now[0][0]-old[0][0]:null,changeValid:!!old.length,elapsed:old.length?t-play.times[before]:null};
  }
  function regionSeries(play,bounds,input) {
    const o=options(input),x0=Math.max(0,Number(bounds?.xMin)),x1=Math.min(o.fieldLength,Number(bounds?.xMax)),y0=Math.max(0,Number(bounds?.yMin)),y1=Math.min(o.fieldWidth,Number(bounds?.yMax)),step=Number(o.gridStep??2);
    if(![x0,x1,y0,y1,step].every(Number.isFinite)||x1<=x0||y1<=y0||step<=0)return {valid:false,reason:'Region must have positive finite area',series:[]};
    const nx=Math.ceil((x1-x0)/step),ny=Math.ceil((y1-y0)/step);
    if(nx*ny>1600)return {valid:false,reason:'Region exceeds 1600 grid cells; increase gridStep',series:[]};
    const points=[];for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)points.push([x0+(i+.5)*(x1-x0)/nx,y0+(j+.5)*(y1-y0)/ny]);
    const area=(x1-x0)*(y1-y0),routes=(play.players||[]).filter(p=>p.side==='offense'&&p.role==='route'),output=[];let priorInside=new Set();
    for(let frame=0;frame<=endFrame(play,o);frame++){
      const values=points.map(q=>inspectPoint(play,q,frame,o)),good=values.filter(v=>v.valid),changes=good.filter(v=>v.changeValid).map(v=>v.change),inside=new Set(),arrivals=[];
      for(const r of routes){
        const q=point(r,frame);if(!q||!(q[0]>=x0&&q[0]<=x1&&q[1]>=y0&&q[1]<=y1))continue;
        inside.add(String(r.id));if(!eligible(play,q,o)[0])continue;
        const previousPoint=point(r,frame-1),dt=frame>0?play.times[frame]-play.times[frame-1]:0;
        const observedEntry=frame>0&&previousPoint!==null&&dt>0&&dt<=o.maxGap+EPS;
        const n=nearest(play,r.id,frame,o),entered=observedEntry&&!priorInside.has(String(r.id)),scopeEntered=observedEntry&&!entered&&!eligible(play,previousPoint,o)[0],inspection=inspectPoint(play,q,frame,o);let openingOnset=null;
        if(entered&&n.valid&&n.distance>=o.threshold){let previous=null;for(let j=0;j<=frame;j++){const v=inspectPoint(play,q,j,o),current=v.valid?v.distance:null;if(current!==null&&current>=o.threshold&&previous!==null&&previous<o.threshold)openingOnset=play.times[j];if(current===null||current<o.threshold)openingOnset=null;previous=current;}}
        arrivals.push({id:String(r.id),name:r.name||String(r.id),entered,scopeEntered,leftCensored:!observedEntry||scopeEntered,open:n.valid&&n.distance>=o.threshold,separation:n.distance,spaceChange:inspection.change,openingOnsetAtArrivalLocation:openingOnset,openingToArrival:openingOnset!==null?play.times[frame]-openingOnset:null});
      }
      priorInside=inside;const fraction=good.length?good.filter(v=>v.distance>=o.threshold).length/good.length:null;
      output.push({frame,time:play.times[frame],meanSpace:good.length?good.reduce((s,v)=>s+v.distance,0)/good.length:null,openArea:fraction===null?null:fraction*area,openFraction:fraction,meanChange:changes.length?changes.reduce((a,b)=>a+b,0)/changes.length:null,arrivals});
    }
    return {valid:true,reason:'',area,points:points.length,gridStep:step,bounds:{xMin:x0,xMax:x1,yMin:y0,yMax:y1},series:output,note:'Grid estimate of observed coverage spacing; arrivals do not establish route causation.'};
  }
  function sensitivity(play,receiverId,frame,input) {
    const o=options(input),baseline=coverageLift(play,receiverId,frame,o),thresholds=[];
    for(const threshold of [...new Set([Math.max(0,o.threshold-.5),o.threshold,o.threshold+.5])].sort((a,b)=>a-b)){const choice={...o,threshold},w=windows(play,receiverId,choice);thresholds.push({threshold,eventCount:events(play,receiverId,choice).length,total:w.total,longest:w.longest});}
    const lookbacks=[...new Set([Math.max(.1,o.lookback-.2),o.lookback,o.lookback+.2])].sort((a,b)=>a-b).map(h=>coverageLift(play,receiverId,frame,{...o,lookback:h}));
    const amplitude=o.jitter??.1,samples=Math.min(256,Math.max(4,Math.trunc(o.jitterSamples??32)));
    if(!isFiniteNumber(amplitude)||amplitude<0)throw new RangeError('jitter must be finite and nonnegative');
    const [args]=liftInputs(play,receiverId,frame,o),values=[];let seed=(o.seed??12345678)>>>0;
    const uniform=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return (seed/4294967296*2-1)*amplitude;};
    if(args){const {b0,b1,d0,d1}=args,n=d0.length;for(let i=0;i<samples;i++){const p=[b0,b1,...d0,...d1].map(q=>[q[0]+uniform(),q[1]+uniform()]);values.push(decompose(p[0],p[1],p.slice(2,2+n),p.slice(2+n)).coverage);}}
    values.sort((a,b)=>a-b);const sign=x=>x>EPS?1:x<-EPS?-1:0,median=values.length?(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2:null;
    return {baseline,thresholds,lookbacks,jitter:{amplitude,samples:values.length,min:values[0]??null,max:values.at(-1)??null,median,p05:values.length?values[Math.floor((values.length-1)*.05)]:null,p95:values.length?values[Math.floor((values.length-1)*.95)]:null,signStable:values.length?values.every(v=>sign(v)===sign(baseline.coverage)):null,note:'Illustrative independent coordinate jitter, not a confidence interval or a calibrated tracking-error model.'}};
  }
  function combinations(n,k){let result=1;for(let i=1;i<=k;i++)result=result*(n-i+1)/i;return result;}
  function bits(n){let count=0;while(n){n&=n-1;count++;}return count;}
  function defenderContributions(play,receiverId,frame,input) {
    const o=options(input),lift=coverageLift(play,receiverId,frame,o),[args,reason]=liftInputs(play,receiverId,frame,o);
    if(!args)return {valid:false,reason,contributions:[],coverage:null,total:null,residual:null,coalitions:0};
    const {b0,b1,ds,d0,d1}=args,n=ds.length;
    if(n>11)return {valid:false,reason:'Exact decomposition is bounded to 11 defenders',contributions:[],coverage:lift.coverage,total:null,residual:null,coalitions:0};
    const dist=[b0,b1].map(b=>ds.map((_,j)=>[distance(b,d0[j]),distance(b,d1[j])])),values=[];
    for(let mask=0;mask<(1<<n);mask++){let sum=0;for(let b=0;b<2;b++){let nearest=Infinity;for(let j=0;j<n;j++)nearest=Math.min(nearest,dist[b][j][(mask>>j)&1]);sum+=nearest;}values.push(sum/2);}
    const contributions=ds.map((d,j)=>{let value=0;for(let mask=0;mask<(1<<n);mask++){if(mask&(1<<j))continue;value+=(values[mask|(1<<j)]-values[mask])/(n*combinations(n-1,bits(mask)));}return {id:String(d.id),name:d.name||String(d.id),value,movement:distance(d0[j],d1[j]),distanceBefore:distance(b0,d0[j]),distanceAfter:distance(b1,d1[j])};});
    contributions.sort((a,b)=>b.value-a.value||lexical(a.id,b.id));const total=contributions.reduce((s,c)=>s+c.value,0);
    return {valid:true,reason:'',coverage:lift.coverage,total,residual:lift.coverage-total,coalitions:1<<n,contributions,note:'Exact Shapley allocation of geometric defender motion, not responsibility or causal credit.'};
  }
  function assistCandidates(play,receiverId,frame,input) {
    const o=options(input),lift=coverageLift(play,receiverId,frame,o),decomposition=defenderContributions(play,receiverId,frame,o),note='Co-motion associations only. Unassigned value preserves ambiguous or absent evidence; no causal route credit is inferred.';
    if(!lift.valid||!decomposition.valid)return {valid:false,reason:lift.reason||decomposition.reason,candidates:[],unassigned:null,allocationBudget:null,coveragePositive:null,note};
    const budget=lift.captured,positive=decomposition.contributions.filter(d=>d.value>EPS),positiveSum=positive.reduce((s,d)=>s+d.value,0);
    if(budget<=EPS||positiveSum<=EPS)return {valid:true,reason:'No eligible positive captured coverage lift',candidates:[],unassigned:0,allocationBudget:0,coveragePositive:Math.max(lift.coverage,0),note};
    const before=lift.previousFrame,routes=(play.players||[]).filter(r=>r.side==='offense'&&r.role==='route'&&String(r.id)!==String(receiverId)),candidates=new Map();
    for(const contribution of positive){
      const d=player(play,contribution.id),d0=point(d,before),d1=point(d,frame),dv=[d1[0]-d0[0],d1[1]-d0[1]],dm=Math.hypot(...dv),ranked=[];
      for(const r of routes){const a0=point(r,before),a1=point(r,frame);if(!a0||!a1)continue;const av=[a1[0]-a0[0],a1[1]-a0[1]],am=Math.hypot(...av);if(Math.min(dm,am)/lift.elapsed<.5)continue;const alignment=Math.max(-1,Math.min(1,(dv[0]*av[0]+dv[1]*av[1])/(dm*am))),distances=[];for(let i=before;i<=frame;i++)if(point(d,i)&&point(r,i))distances.push(distance(point(d,i),point(r,i)));if(distances.length!==frame-before+1)continue;const meanDistance=distances.reduce((a,b)=>a+b,0)/distances.length,fraction=distances.filter(x=>x<=6).length/distances.length,score=Math.max(0,(alignment-.5)/.5)*Math.max(0,1-meanDistance/6)*fraction;if(fraction>=.6&&score>.2)ranked.push({score,id:String(r.id),r,alignment,meanDistance});}
      ranked.sort((a,b)=>b.score-a.score||lexical(a.id,b.id));if(!ranked.length)continue;
      const best=ranked[0],margin=Math.max(0,Math.min(1,best.score-(ranked[1]?.score||0))),allocated=budget*contribution.value/positiveSum*margin;
      if(!candidates.has(best.id))candidates.set(best.id,{id:best.id,name:best.r.name||best.id,associatedValue:0,score:0,defenderIds:[],evidence:[]});
      const candidate=candidates.get(best.id);candidate.associatedValue+=allocated;candidate.score=Math.max(candidate.score,best.score);candidate.defenderIds.push(contribution.id);candidate.evidence.push({defenderId:contribution.id,alignment:best.alignment,meanDistance:best.meanDistance,coMotionScore:best.score,distinctnessMargin:margin,associatedValue:allocated});
    }
    const result=[...candidates.values()].sort((a,b)=>b.associatedValue-a.associatedValue||lexical(a.id,b.id));
    return {valid:true,reason:'',candidates:result,allocationBudget:budget,unassigned:Math.max(0,budget-result.reduce((s,c)=>s+c.associatedValue,0)),coveragePositive:Math.max(lift.coverage,0),note};
  }
  function compareMatches(play,plays,input) {
    const o=input||{},weights={offense:1,coverage:3,coverageType:1,formation:2,down:2,yardsToGoBand:2,dropBackType:1,personnelO:1};
    const value=(p,key)=>key==='yardsToGoBand'?(p.yardsToGo===null||p.yardsToGo===undefined?null:p.yardsToGo<=3?'short':p.yardsToGo<=7?'medium':'long'):(p[key]??(key==='dropBackType'?p.context?.dropbackType??p.context?.[key]:p.context?.[key]));
    const result=[];
    for(const candidate of plays){if(candidate.id===play.id&&!o.includeSame)continue;const reasons=[],mismatches=[];let score=0,maximum=0;
      for(const [key,weight] of Object.entries(weights)){const a=value(play,key),b=value(candidate,key);if([null,undefined,'','NA'].includes(a)||[null,undefined,'','NA'].includes(b))continue;maximum+=weight;if(a===b){score+=weight;reasons.push(key);}else mismatches.push({field:key,selected:a,candidate:b});}
      result.push({playId:candidate.id??null,score:maximum?score/maximum:0,reasons,mismatches,comparedWeight:maximum});}
    return result.sort((a,b)=>b.score-a.score||lexical(String(a.playId),String(b.playId))).slice(0,Math.trunc(o.limit??25));
  }
  return Object.freeze({version:VERSION,defaults:DEFAULTS,frameAt,defenders,nearest,coverageLift,series,windows,events,defaultReceiver,context,inspectPoint,regionSeries,sensitivity,defenderContributions,assistCandidates,compareMatches});
});
