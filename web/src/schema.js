/* Offline schema-1 import validation. Returns the original object unchanged;
 * throws an Error with the invalid field path. Mirrors schema.py, including
 * recomputation of stored geometry, rather than trusting imported summaries.
 * Validation proves internal consistency, not external source authenticity. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OFSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const roles = new Set(['route','coverage','rush','block','pass','ball','other']);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
  const fail = (path,message) => { throw new Error(`${path}: ${message}`); };
  function number(value,path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path,'expected a finite number');
    return value;
  }
  function finiteTree(value,path='dataset',seen=new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { number(value,path); return; }
    if (typeof value !== 'object') fail(path,'unsupported JSON value');
    if (seen.has(value)) fail(path,'cyclic value');
    seen.add(value);
    if (Array.isArray(value)) value.forEach((v,i)=>finiteTree(v,`${path}[${i}]`,seen));
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path,'expected JSON object');
      for (const [key,v] of Object.entries(value)) finiteTree(v,`${path}.${key}`,seen);
    }
    seen.delete(value);
  }
  const equalSets = (a,b) => a.size === b.size && [...a].every(x=>b.has(x));
  function tracks(track,size,path) {
    if (!Array.isArray(track) || track.length !== size) fail(path,`expected ${size} aligned frames`);
    let width;
    track.forEach((row,i)=>{
      if (!Array.isArray(row) || ![5,6,7].includes(row.length)) fail(`${path}[${i}]`,'expected [x,y,s,dir,o] with optional a,dis');
      if (width === undefined) width=row.length;
      if (width !== row.length) fail(path,'track rows have inconsistent widths');
      row.forEach((v,k)=>{ if (!(k>=5 && v===null)) number(v,`${path}[${i}][${k}]`); });
      if (row[2]<0) fail(path,'speed must be nonnegative');
      if (!(row[3]>=0 && row[3]<360 && row[4]>=0 && row[4]<360)) fail(path,'angles must be in [0,360)');
      if (row.length>6 && row[6]!==null && row[6]<0) fail(path,'displacement must be nonnegative');
    });
  }
  function optional(value,path,{strings=[],numbers=[],booleans=[],nullableStrings=[]}={}) {
    if (!object(value)) fail(path,'expected object');
    for (const k of strings) if (own(value,k) && typeof value[k]!=='string') fail(`${path}.${k}`,'expected string');
    for (const k of nullableStrings) if (own(value,k) && value[k]!==null && typeof value[k]!=='string') fail(`${path}.${k}`,'expected string or null');
    for (const k of numbers) if (own(value,k) && value[k]!==null) number(value[k],`${path}.${k}`);
    for (const k of booleans) if (own(value,k) && value[k]!==null && typeof value[k]!=='boolean') fail(`${path}.${k}`,'expected boolean or null');
  }
  function validateDataset(data) {
    if (!object(data) || data.schemaVersion!==1) fail('dataset.schemaVersion','requires version 1');
    finiteTree(data);
    const {meta,plays}=data;
    if (!object(meta)) fail('dataset.meta','missing object');
    if (!Array.isArray(plays) || !plays.length) fail('dataset.plays','expected nonempty list');
    const fps=number(meta.fps,'meta.fps');
    if (fps<=0) fail('meta.fps','must be positive');
    for (const k of ['fieldLength','fieldWidth']) if (number(meta[k],`meta.${k}`)<=0) fail(`meta.${k}`,'must be positive');
    if (meta.playCount!==plays.length) fail('meta.playCount','does not match plays');
    if (own(meta,'windowThreshold') && number(meta.windowThreshold,'meta.windowThreshold')<0) fail('meta.windowThreshold','must be nonnegative');
    const tolerance=meta.separationPrecision==='full'?1e-8:.000501;
    const playIds=new Set(), receiverIds=new Map();
    const inBounds=row=>row[0]>=0 && row[0]<=meta.fieldLength && row[1]>=0 && row[1]<=meta.fieldWidth;
    plays.forEach((play,pi)=>{
      const path=`plays[${pi}]`;
      if (!object(play)) fail(path,'expected object');
      const id=play.id;
      if (typeof id!=='string' || playIds.has(id)) fail(`${path}.id`,'must be a unique string');
      playIds.add(id);
      if (id!==`${play.gameId}_${play.playId}`) fail(`${path}.id`,'does not match gameId/playId');
      for (const k of ['gameId','playId','quarter','down','yardsToGo']) if (!Number.isSafeInteger(play[k])) fail(`${path}.${k}`,'expected integer');
      for (const k of ['los','firstDown','yards']) number(play[k],`${path}.${k}`);
      for (const k of ['homeTeam','awayTeam','offense','defense','description','clock','result','endpointLabel']) if (typeof play[k]!=='string') fail(`${path}.${k}`,'expected string');
      if (![1,2,3,4].includes(play.down) || play.quarter<1 || play.yardsToGo<0) fail(path,'invalid football situation');
      if (!equalSets(new Set([play.homeTeam,play.awayTeam]),new Set([play.offense,play.defense]))) fail(path,'game teams do not match play teams');
      if (play.offense===play.defense) fail(path,'offense and defense must differ');
      if (!(play.los>=0 && play.los<=meta.fieldLength && play.firstDown>=0 && play.firstDown<=meta.fieldLength)) fail(path,'line markers outside field length');
      if (Math.abs(play.firstDown-Math.min(meta.fieldLength,Math.max(0,play.los+play.yardsToGo)))>1e-6) fail(`${path}.firstDown`,'does not match line of scrimmage and yards to go');
      for (const k of ['formation','coverage','coverageType']) if (own(play,k) && typeof play[k]!=='string') fail(`${path}.${k}`,'expected string');
      if (own(play,'context')) optional(play.context,`${path}.context`,{strings:['gameDate','personnelO','personnelD','dropbackType'],numbers:['season','week','defendersInBox','homeScore','awayScore'],booleans:['playAction']});
      const {times,frameIds:frames,events,players}=play;
      if (!Array.isArray(times) || times.length<2) fail(`${path}.times`,'requires at least two observations');
      const size=times.length;
      if (!Array.isArray(frames) || !Array.isArray(events) || frames.length!==size || events.length!==size) fail(path,'time, frame and event arrays must align');
      if (frames.some(f=>!Number.isSafeInteger(f))) fail(`${path}.frameIds`,'expected integer frames');
      times.forEach((t,i)=>{
        number(t,`${path}.times[${i}]`);
        if (Math.abs(t-i/fps)>1e-6) fail(`${path}.times`,'must start at zero and follow fps');
        if (frames[i]!==frames[0]+i) fail(`${path}.frameIds`,'must be consecutive');
      });
      if (events.some(e=>typeof e!=='string')) fail(`${path}.events`,'expected strings');
      if (events[0]!=='ball_snap') fail(`${path}.events`,'must begin at ball_snap');
      if (events.slice(0,-1).includes('pass_forward')) fail(`${path}.events`,'extends beyond first pass release');
      if (play.endpointLabel==='Pass release' && events[size-1]!=='pass_forward') fail(path,'release endpoint missing pass_forward');
      if (play.endpointLabel!=='Pass release' && !['S','R'].includes(play.result)) fail(path,'non-release endpoint requires sack or scramble');
      if (!Array.isArray(players) || players.length!==23) fail(`${path}.players`,'requires 22 players and ball');
      const byId=new Map(),sides={offense:0,defense:0,ball:0};
      players.forEach((entity,ei)=>{
        const ep=`${path}.players[${ei}]`;
        if (!object(entity)) fail(ep,'expected object');
        const {id:eid,side,role}=entity;
        if (typeof eid!=='string' || !eid || byId.has(eid)) fail(`${ep}.id`,'must be a unique nonempty string');
        byId.set(eid,entity);
        if (!own(sides,side) || !roles.has(role)) fail(ep,'invalid side or role');
        sides[side]++;
        if (side==='ball') {
          if (eid!=='ball' || role!=='ball' || entity.team!=='football') fail(ep,'invalid ball identity');
        } else if (eid==='ball' || role==='ball') fail(ep,'ball identity and role require ball side');
        else if (entity.team!==play[side]) fail(`${ep}.team`,'does not match offense/defense');
        if (['coverage','rush'].includes(role) && side!=='defense') fail(`${ep}.role`,'defensive role on non-defender');
        if (['route','pass','block'].includes(role) && side!=='offense') fail(`${ep}.role`,'offensive role on non-offense');
        for (const k of ['name','jersey','position','officialPosition']) if (own(entity,k) && typeof entity[k]!=='string') fail(`${ep}.${k}`,'expected string');
        if (own(entity,'scoutingAvailable') && typeof entity.scoutingAvailable!=='boolean') fail(`${ep}.scoutingAvailable`,'expected boolean');
        if (own(entity,'protection')) optional(entity.protection,`${ep}.protection`,{nullableStrings:['blockedPlayerId','blockType'],booleans:['hit','hurry','sack','beatenByDefender','hitAllowed','hurryAllowed','sackAllowed','backFieldBlock']});
        tracks(entity.track,size,`${ep}.track`);
        if (own(entity,'fieldStatus')) {
          const status=entity.fieldStatus;
          if (!Array.isArray(status) || status.length!==size || status.some(s=>!['in_bounds','outside_field'].includes(s))) fail(`${ep}.fieldStatus`,'invalid aligned field status');
          if (status.some((s,i)=>s!==(inBounds(entity.track[i])?'in_bounds':'outside_field'))) fail(`${ep}.fieldStatus`,'does not match recorded positions');
        }
      });
      if (sides.offense!==11 || sides.defense!==11 || sides.ball!==1) fail(`${path}.players`,'requires 11 players per team');
      const defenders=players.filter(e=>e.role==='coverage'),routes=new Set(players.filter(e=>e.role==='route').map(e=>e.id));
      if (!defenders.length) fail(path,'no coverage defenders');
      if (!object(play.metrics) || !Array.isArray(play.metrics.receivers)) fail(`${path}.metrics.receivers`,'expected list');
      const seen=new Set();
      play.metrics.receivers.forEach((metric,mi)=>{
        const mp=`${path}.metrics.receivers[${mi}]`;
        if (!object(metric)) fail(mp,'expected object');
        const rid=metric.id;
        if (!routes.has(rid) || seen.has(rid)) fail(`${mp}.id`,'must uniquely identify a route runner');
        seen.add(rid);
        const sep=metric.separation,nearest=metric.nearestId;
        if (!Array.isArray(sep) || !Array.isArray(nearest) || sep.length!==size || nearest.length!==size) fail(mp,'distance and nearest-defender arrays must align');
        const actual=sep.map((v,i)=>{
          number(v,`${mp}.separation[${i}]`);
          const point=byId.get(rid).track[i];let expected=Infinity,eid;
          for (const e of defenders) {
            const distance=Math.hypot(point[0]-e.track[i][0],point[1]-e.track[i][1]);
            if (distance<expected || (distance===expected && e.id<eid)) { expected=distance;eid=e.id; }
          }
          if (Math.abs(v-expected)>tolerance || nearest[i]!==eid) fail(mp,`geometry or nearest defender inconsistent at frame ${i}`);
          return expected;
        });
        for (const [key,expected] of [['peakSeparation',Math.max(...actual)],['separationAtEnd',actual[size-1]]]) if (own(metric,key) && Math.abs(number(metric[key],`${mp}.${key}`)-expected)>tolerance) fail(`${mp}.${key}`,'inconsistent with distances');
        const threshold=meta.windowThreshold??3;let count=0,longest=0,run=0;
        actual.slice(0,-1).forEach(d=>{if(d>=threshold){count++;run++;}else run=0;longest=Math.max(longest,run/fps);});
        for (const [key,expected] of [['totalOpenSeconds',count/fps],['longestOpenSeconds',longest]]) if (own(metric,key) && Math.abs(number(metric[key],`${mp}.${key}`)-expected)>1e-6) fail(`${mp}.${key}`,'inconsistent interval duration');
      });
      if (!equalSets(seen,routes)) fail(`${path}.metrics`,'requires exactly one series per route runner');
      receiverIds.set(id,routes);
      if (!object(play.bounds)) fail(`${path}.bounds`,'missing object');
      for (const [axis,k] of [['x',0],['y',1]]) {
        let minimum=Infinity,maximum=-Infinity;
        for (const entity of players) for (const row of entity.track) { minimum=Math.min(minimum,row[k]);maximum=Math.max(maximum,row[k]); }
        for (const [suffix,expected] of [['Min',minimum],['Max',maximum]]) {
          const key=axis+suffix;
          if (Math.abs(number(play.bounds[key],`${path}.bounds.${key}`)-expected)>1e-6) fail(`${path}.bounds.${key}`,'does not enclose the recorded positions exactly');
        }
      }
      const penalty=play.penalty;
      if (penalty!==undefined && penalty!==null) {
        if (!object(penalty) || ['hasPenalty','nullified'].some(k=>typeof penalty[k]!=='boolean')) fail(`${path}.penalty`,'requires boolean hasPenalty and nullified');
        if (!Array.isArray(penalty.fouls)) fail(`${path}.penalty.fouls`,'expected list');
        optional(penalty,`${path}.penalty`,{strings:['nullifiedSource'],numbers:['yards','prePenaltyYards']});
        for (const foul of penalty.fouls) {
          optional(foul,`${path}.penalty.fouls`,{strings:['name'],nullableStrings:['playerId']});
          if (typeof foul.name!=='string' || !foul.name) fail(`${path}.penalty.fouls`,'requires nonempty foul name');
        }
        if (penalty.nullified && play.cohortEligible===true) fail(`${path}.cohortEligible`,'nullified play cannot be analysis eligible');
      }
      if (own(play,'cohortEligible') && typeof play.cohortEligible!=='boolean') fail(`${path}.cohortEligible`,'expected boolean');
      const quality=play.quality;
      if (quality!==undefined && quality!==null) {
        if (!object(quality) || !Array.isArray(quality.flags)) fail(`${path}.quality`,'requires diagnostic flags');
        if (quality.flags.some(f=>typeof f!=='string') || new Set(quality.flags).size!==quality.flags.length) fail(`${path}.quality.flags`,'expected unique strings');
        const counts={};for(const e of players) counts[e.role]=(counts[e.role]||0)+1;
        if (!object(quality.roleCounts) || !equalSets(new Set(Object.keys(counts)),new Set(Object.keys(quality.roleCounts))) || Object.keys(counts).some(k=>counts[k]!==quality.roleCounts[k])) fail(`${path}.quality.roleCounts`,'does not match player roles');
        for (const k of ['scoutingMissingIds','unknownRoleIds']) {
          if (!Array.isArray(quality[k]) || quality[k].some(eid=>!byId.has(eid))) fail(`${path}.quality.${k}`,'references unknown entities');
          if (new Set(quality[k]).size!==quality[k].length) fail(`${path}.quality.${k}`,'duplicate entity');
        }
        if (players.every(e=>own(e,'scoutingAvailable')) && !equalSets(new Set(quality.scoutingMissingIds),new Set(players.filter(e=>!e.scoutingAvailable).map(e=>e.id)))) fail(`${path}.quality.scoutingMissingIds`,'does not match player availability');
        if (!equalSets(new Set(quality.unknownRoleIds),new Set(players.filter(e=>e.role==='other').map(e=>e.id)))) fail(`${path}.quality.unknownRoleIds`,'does not match player roles');
        const ambiguity=quality.fieldAmbiguity??{},outside=new Set(players.filter(e=>e.side!=='ball' && e.track.some(row=>!inBounds(row))).map(e=>e.id));
        if (!object(ambiguity) || !Array.isArray(ambiguity.entityIds??[]) || !equalSets(new Set(ambiguity.entityIds??[]),outside)) fail(`${path}.quality.fieldAmbiguity`,'does not match player positions');
        for (const [flag,present] of [['scouting_missing',!!quality.scoutingMissingIds.length],['unknown_roles',!!quality.unknownRoleIds.length],['field_boundary',!!outside.size]]) if (quality.flags.includes(flag)!==present) fail(`${path}.quality.flags`,`does not match ${flag} observations`);
        if (play.cohortEligible && quality.flags.some(f=>['scouting_missing','unknown_roles','field_boundary','trajectory_flag','event_disagreement'].includes(f))) fail(`${path}.cohortEligible`,'does not match diagnostic flags');
      }
      const pre=play.preSnap;
      if (pre!==undefined && pre!==null) {
        if (!object(pre)) fail(`${path}.preSnap`,'expected object');
        const {times:pt,frameIds:pf,events:pe,players:pp}=pre;
        if (![pt,pf,pe,pp].every(Array.isArray) || pt.length!==pf.length || pt.length!==pe.length) fail(`${path}.preSnap`,'invalid aligned arrays');
        if (pe.some(e=>typeof e!=='string')) fail(`${path}.preSnap.events`,'expected strings');
        if (pf.length && pf[pf.length-1]!==frames[0]-1) fail(`${path}.preSnap.frameIds`,'must end immediately before snap');
        if (pp.some(e=>!object(e)) || new Set(pp.map(e=>e.id)).size!==pp.length || !equalSets(new Set(pp.map(e=>e.id)),new Set(byId.keys()))) fail(`${path}.preSnap.players`,'must identify the replay entities');
        pt.forEach((t,i)=>{
          number(t,`${path}.preSnap.times`);
          if (!Number.isSafeInteger(pf[i]) || pf[i]>=frames[0] || Math.abs(t-(pf[i]-frames[0])/fps)>1e-6 || t>=0) fail(`${path}.preSnap`,'invalid negative timing');
          if (i && pf[i]!==pf[i-1]+1) fail(`${path}.preSnap`,'frames must be consecutive');
        });
        pp.forEach(e=>tracks(e.track,pt.length,`${path}.preSnap.track`));
      }
    });
    if (meta.gameCount!==new Set(plays.map(p=>p.gameId)).size) fail('meta.gameCount','does not match plays');
    if (!Array.isArray(data.featured??[]) || (data.featured??[]).some(id=>!playIds.has(id))) fail('dataset.featured','references unknown play');
    if (!Array.isArray(data.stories??[])) fail('dataset.stories','expected list');
    (data.stories??[]).forEach((story,i)=>{
      if (!object(story)) fail(`stories[${i}]`,'expected object');
      for (const [key,rkey] of [['id','receiverId'],['compareId','compareReceiverId']]) if (!playIds.has(story[key]) || !receiverIds.get(story[key]).has(story[rkey])) fail(`stories[${i}]`,'references unknown play or receiver');
      const focus=number(story.focusTime,`stories[${i}].focusTime`),selected=plays.find(p=>p.id===story.id);
      if (!(focus>=0 && focus<=selected.times[selected.times.length-1])) fail(`stories[${i}].focusTime`,'outside recorded replay');
    });
    return data;
  }
  return {version:'1.0.0',validateDataset};
});
