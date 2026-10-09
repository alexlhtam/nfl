/* Run: node tests/metrics_js.cjs [--json]. No browser or packages required. */
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const ROOT=path.join(__dirname,'..'),M=require(path.join(ROOT,'web/src/metrics.js'));
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/metric_cases.json'),'utf8'));
const data=JSON.parse(fs.readFileSync(path.join(ROOT,'data/demo.json'),'utf8'));
const tolerance=fixtures.tolerance;
const close=(actual,expected,label)=>assert(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);
function check(c){
  const lift=M.coverageLift(c.play,c.receiverId,c.frame,c.options);
  for(const [key,expected]of Object.entries(c.expected)){
    if(key==='shapley'){const result=M.defenderContributions(c.play,c.receiverId,c.frame,c.options);for(const[id,value]of Object.entries(expected))close(result.contributions.find(x=>x.id===id).value,value,c.name+' '+id);}
    else if(key==='eventCount')assert.equal(M.events(c.play,c.receiverId,c.options).length,expected,c.name);
    else if(typeof expected==='number')close(lift[key],expected,c.name+' '+key);
    else assert.deepStrictEqual(lift[key],expected,c.name+' '+key);
  }
  const contribution=M.defenderContributions(c.play,c.receiverId,c.frame,c.options);
  if(lift.valid){close(lift.coverage+lift.receiver,lift.gain,c.name+' additivity');close(contribution.total,lift.coverage,c.name+' Shapley sum');assert(lift.captured>=0&&lift.captured<=Math.max(lift.gain,0)+tolerance);}
  const assist=M.assistCandidates(c.play,c.receiverId,c.frame,c.options);
  if(assist.valid)close(assist.candidates.reduce((s,x)=>s+x.associatedValue,0)+assist.unassigned,assist.allocationBudget,c.name+' association budget');
  return {name:c.name,lift,nearest:M.nearest(c.play,c.receiverId,c.frame,c.options),windows:M.windows(c.play,c.receiverId,c.options),events:M.events(c.play,c.receiverId,c.options),series:M.series(c.play,c.receiverId,c.options),contribution,assist,sensitivity:M.sensitivity(c.play,c.receiverId,c.frame,{...c.options,jitterSamples:8}),point:M.inspectPoint(c.play,{x:30,y:20},c.frame,c.options),region:M.regionSeries(c.play,{xMin:28,xMax:32,yMin:18,yMax:22},{...c.options,gridStep:2})};
}
const results=fixtures.cases.map(check);
for(const c of fixtures.realCases){const play=data.plays.find(p=>p.id===c.playId);assert(play,'Missing real fixture '+c.playId);const frame=M.frameAt(play,c.time),lift=M.coverageLift(play,c.receiverId,frame);for(const[key,value]of Object.entries(c.expected))close(lift[key],value,c.name+' '+key);results.push({name:c.name,lift,contribution:M.defenderContributions(play,c.receiverId,frame),assist:M.assistCandidates(play,c.receiverId,frame)});}
const event=fixtures.cases.find(c=>c.name==='observed_event');
assert.equal(M.events(event.play,'r',{throughTime:.7}).length,0,'No unobserved future confirmation');
assert.equal(M.events(event.play,'r',{throughTime:.8}).length,1,'Observed hold confirmation');
assert.equal(M.series(event.play,'r',{throughTime:.45}).length,5,'Elapsed cutoff floors to observation');
const partial=M.windows(event.play,'r',{throughTime:.7});assert(partial.rawIntervals.at(-1).rightCensored,'Partial raw window remains censored');assert.equal(partial.intervals.length,0,'Unconfirmed partial window is not qualified');
assert.equal(M.frameAt(event.play,.15),1);assert.equal(M.frameAt(event.play,99),9);
assert.throws(()=>M.coverageLift(event.play,'r',6,{lookback:0}),/positive/);
assert.throws(()=>M.nearest(event.play,'r',6,{scope:'future'}),/scope/);
assert.equal(M.regionSeries(event.play,{xMin:0,xMax:120,yMin:0,yMax:53.3},{gridStep:.1}).valid,false,'Bound regional work');
const zero=M.sensitivity(event.play,'r',6,{jitter:0,jitterSamples:8});close(zero.jitter.min,zero.baseline.coverage,'Zero jitter');close(zero.jitter.max,zero.baseline.coverage,'Zero jitter');
if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(results));
else console.log(JSON.stringify({status:'passed',metricVersion:M.version,syntheticCases:fixtures.cases.length,realCases:fixtures.realCases.length,checks:['decomposition','observed opening events','cutoffs and censoring','exact defender allocation','association budget','sensitivity','point and regional geometry']}));
