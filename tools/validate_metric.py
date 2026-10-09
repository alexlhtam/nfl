#!/usr/bin/env python3
"""Execute Coverage Lift's claims and real-data invariants without human review.

Run python tools/validate_metric.py --data data/demo.json --output data/metric-validation.json.
The output is a reproducible evidence report, not calibration or causal validation.
Exit status is nonzero if any numeric story claim, decomposition, or allocation
check fails. Custom game packs validate their present claims and are supported.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import metrics as M


def numeric_story_claim(play, claim):
    if claim.get('type')!='coverage_lift':
        raise ValueError('Unsupported numerical claim type')
    t0,t1=float(claim['t0']),float(claim['t1'])
    if not (math.isfinite(t0) and math.isfinite(t1) and t1>t0):
        raise ValueError('Claim interval must be finite and increasing')
    before,frame=M.frame_at(play,t0),M.frame_at(play,t1)
    if abs(play['times'][before]-t0)>1e-9 or abs(play['times'][frame]-t1)>1e-9:
        raise ValueError('Claim times must be actual observed frames')
    opts={'scope':claim.get('defenderScope','coverage'),'lookback':t1-t0,
          'downfieldOnly':claim.get('requireDownfield',False),'inBoundsOnly':claim.get('requireInBounds',False)}
    result=M.coverage_lift(play,claim['receiverId'],frame,opts)
    if not result['valid'] or not result['eligible']:
        raise ValueError(result['reason'] or 'Claim is outside required eligibility')
    actual={'start':result['separationBefore'],'end':result['separationAfter'],
            'receiverMoved':result['hybrids']['afterReceiverBeforeCoverage'],
            'defenseMoved':result['hybrids']['beforeReceiverAfterCoverage'],
            'coverageLift':result['coverage'],'receiverMovement':result['receiver'],'netChange':result['gain']}
    tolerance=claim.get('tolerance',1e-6)
    if not isinstance(tolerance,(int,float)) or not 0<tolerance<=.01:
        raise ValueError('Claim tolerance must be positive and no more than .01 yards')
    for key,expected in claim['expected'].items():
        if key not in actual or not isinstance(expected,(int,float)) or not math.isfinite(expected):
            raise ValueError(f'Invalid expected claim: {key}')
        if abs(actual[key]-expected)>tolerance:
            raise ValueError(f'{key}: measured {actual[key]}, expected {expected}')
    sustained=claim.get('sustainedWindow')
    if sustained:
        start,end=sustained['start'],sustained['end'];i,j=M.frame_at(play,start),M.frame_at(play,end)
        if i<0 or j<=i or abs(play['times'][i]-start)>1e-9 or abs(play['times'][j]-end)>1e-9:
            raise ValueError('Sustained window endpoints must be observed frames')
        if end-start+1e-9<sustained['minSeconds']:
            raise ValueError('Sustained window is too short')
        for frame_index in range(i,j+1):
            nearest=M.nearest(play,claim['receiverId'],frame_index,opts)
            details=M.context(play,claim['receiverId'],frame_index,opts)
            if not nearest['valid'] or nearest['distance']<sustained['threshold'] or not details['windowEligible']:
                raise ValueError(f'Sustained window fails at {play["times"][frame_index]} seconds')
    return {'type':'coverage_lift','receiverId':claim['receiverId'],'t0':t0,'t1':t1,
            'status':'passed','actual':actual,'tolerance':tolerance,'sustainedWindow':sustained}


def _rounded_fact(play,receiver_id,time,expected,depth=None):
    frame=M.frame_at(play,time)
    if abs(play['times'][frame]-time)>1e-9:raise ValueError('Missing fact observation')
    result=M.nearest(play,receiver_id,frame)
    if not result['valid'] or abs(result['distance']-expected)>.000500001:
        raise ValueError(f'Separation fact {time}: {result["distance"]} != rounded {expected}')
    if depth is not None:
        value=M.context(play,receiver_id,frame)['downfield']
        if abs(value-depth)>.005000001:raise ValueError('Downfield distance fact does not match')
    return {'time':time,'distance':result['distance'],'expectedRounded':expected}


def legacy_story_claim(play,story):
    """Executable numerical evidence for the two retained spacing stories."""
    pid=play['id']
    facts=[]
    if pid=='2021110100_2032':
        for time,value in ((3.1,3.216),(4.1,10.132),(6.2,2.856),(7.2,1.794)):
            facts.append(_rounded_fact(play,'47839',time,value,20.03 if time==3.1 else None))
        if abs(play['times'][-1]-7.2)>1e-9 or play['endpointLabel']!='Pass release':raise ValueError('Hardman release timing differs')
        for i,t in enumerate(play['times']):
            if t>=6.2:
                near=M.nearest(play,'47839',i)
                name=next(p['name'] for p in play['players'] if p['id']==near['nearestId'])
                if name!='Julian Love':raise ValueError('Closing-phase nearest defender differs')
    elif pid=='2021090900_3633':
        for i,t in enumerate(play['times']):
            if 1.5<=t<=2.9:
                for rid,name in (('44896','Anthony Brown'),('35481','Keanu Neal')):
                    near=M.nearest(play,rid,i)
                    actual_name=next(p['name'] for p in play['players'] if p['id']==near['nearestId'])
                    if actual_name!=name:raise ValueError('Paired-story nearest defender differs')
                    if rid=='44896' and near['distance']>2.13:raise ValueError('Godwin separation bound differs')
                    if not M.context(play,rid,i)['windowEligible']:raise ValueError('Paired story is not downfield/in bounds')
        facts.extend([_rounded_fact(play,'35481',1.5,3.054),_rounded_fact(play,'35481',2.9,6.266)])
        if abs(play['times'][-1]-2.9)>1e-9:raise ValueError('Paired story release timing differs')
    elif pid=='2021110100_1396':
        facts.extend([_rounded_fact(play,'43454',1.6,.891,3.38),_rounded_fact(play,'43454',2.3,3.121),_rounded_fact(play,'43454',4.1,5.777)])
    else:
        raise ValueError('Story has no executable numerical claims')
    return {'type':'observed_spacing','status':'passed','facts':facts}


def validate(data):
    by_id={p['id']:p for p in data['plays']}
    failures,claim_checks=[],[]
    for story in data.get('stories',[]):
        play=by_id.get(story['id'])
        if play is None:
            failures.append({'check':'story_present','playId':story['id'],'reason':'Story play is absent'});continue
        claims=story.get('numericClaims',[])
        for index,claim in enumerate(claims or [None]):
            try:
                evidence=numeric_story_claim(play,claim) if claim is not None else legacy_story_claim(play,story)
                claim_checks.append({'playId':play['id'],'story':story['title'],'claimIndex':index,**evidence})
            except (ValueError,KeyError,TypeError,IndexError) as error:
                failures.append({'check':'curated_claim','playId':play['id'],'claimIndex':index,'reason':str(error)})
    all_events=[];counts={'plays':len(data['plays']),'receiverSeries':0,'validDecompositions':0,'eligibleDecompositions':0,
                         'openingEvents':0,'positiveCapturedEvents':0,'cohortEligibleEvents':0,'cohortEligiblePlays':0}
    max_additivity=0.0;max_capture_error=0.0
    for play in data['plays']:
        if play.get('cohortEligible',True):counts['cohortEligiblePlays']+=1
        for receiver in play['players']:
            if receiver.get('side')!='offense' or receiver.get('role')!='route':continue
            counts['receiverSeries']+=1
            for row in M.series(play,receiver['id']):
                if not row['valid']:continue
                counts['validDecompositions']+=1
                counts['eligibleDecompositions']+=int(row['eligible'])
                max_additivity=max(max_additivity,abs(row['coverage']+row['receiver']-row['gain']))
                max_capture_error=max(max_capture_error,max(0,-row['captured'],row['captured']-max(row['gain'],0)))
            for event in M.events(play,receiver['id']):
                counts['openingEvents']+=1
                counts['positiveCapturedEvents']+=int(event['captured']>1e-9)
                counts['cohortEligibleEvents']+=int(play.get('cohortEligible',True))
                all_events.append({**event,'receiverName':receiver['name'],'cohortEligible':play.get('cohortEligible',True),
                                   'offense':play['offense'],'coverageScheme':play.get('coverage')})
    if max_additivity>1e-9:failures.append({'check':'decomposition_additivity','error':max_additivity})
    if max_capture_error>1e-9:failures.append({'check':'capture_bounds','error':max_capture_error})
    # Exact allocation and stress tests use every positive eligible opening,
    # never cherry-picking only the two demonstration plays.
    allocation_checks=[]
    for event in all_events:
        if event['captured']<=1e-9:continue
        play=by_id[event['playId']];rid=event['receiverId'];frame=event['frame']
        allocation=M.defender_contributions(play,rid,frame)
        assists=M.assist_candidates(play,rid,frame)
        budget_error=abs(sum(c['associatedValue'] for c in assists['candidates'])+assists['unassigned']-assists['allocationBudget'])
        if not allocation['valid'] or abs(allocation['residual'])>1e-8 or budget_error>1e-8:
            failures.append({'check':'allocation_conservation','playId':play['id'],'receiverId':rid,'frame':frame})
        allocation_checks.append({'playId':play['id'],'receiverId':rid,'frame':frame,'residual':allocation['residual'],
                                  'coalitions':allocation['coalitions'],'associationBudgetError':budget_error})
    ranked=sorted((e for e in all_events if e['cohortEligible']),key=lambda e:(-e['captured'],e['playId'],e['receiverId'],e['frame']))
    evidence=[{key:e[key] for key in ('playId','receiverId','receiverName','onset','confirmedAt','coverage','receiver','gain','captured','duration','rightCensored','offense','coverageScheme')} for e in ranked[:25]]
    return {'status':'passed' if not failures else 'failed','metricVersion':M.VERSION,
            'sourceRevision':data.get('meta',{}).get('sourceRevision'),'sourceSeason':data.get('meta',{}).get('season'),
            'options':M.DEFAULTS,'counts':counts,'maxAdditivityError':max_additivity,'maxCaptureBoundError':max_capture_error,
            'curatedClaims':claim_checks,'allocationChecks':allocation_checks,'exampleEvents':evidence,'failures':failures,
            'interpretation':'Coverage Lift is an exact geometric motion decomposition. Captured value is gated and capped observed space. Co-motion candidates are associations, with unassigned value. No result establishes route causation or calibrated passing opportunity.',
            'validationScope':'Every bundled receiver series; every positive captured opening receives exact defender allocation and association-budget checks; all bundled curated numerical claims are executed.'}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',type=Path,default=ROOT/'data/demo.json')
    parser.add_argument('--output',type=Path,default=ROOT/'data/metric-validation.json')
    args=parser.parse_args(argv)
    try:
        contents=args.data.read_bytes();data=json.loads(contents);report=validate(data)
        report['datasetSha256']=hashlib.sha256(contents).hexdigest()
        report['engineSha256']=hashlib.sha256((ROOT/'metrics.py').read_bytes()).hexdigest()
        report['javascriptEngineSha256']=hashlib.sha256((ROOT/'web/src/metrics.js').read_bytes()).hexdigest()
        args.output.parent.mkdir(parents=True,exist_ok=True)
        temporary=args.output.with_suffix(args.output.suffix+'.tmp')
        temporary.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
        temporary.replace(args.output)
    except (OSError,ValueError,KeyError,TypeError) as error:
        print(f'Metric validation failed: {error}',file=sys.stderr);return 1
    print(f"Coverage Lift {report['status']}: {report['counts']['validDecompositions']} decompositions, {report['counts']['openingEvents']} opening events, {len(report['curatedClaims'])} curated claims; report {args.output}")
    for failure in report['failures']:print(json.dumps(failure),file=sys.stderr)
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
