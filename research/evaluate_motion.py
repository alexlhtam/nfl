#!/usr/bin/env python3
"""EXPERIMENTAL: independent-game evaluation of simple motion projections.

This research command never changes the coaching metric or makes predictions in
the app. It compares stationary and constant-velocity baselines against a single
velocity scale learned only on other games, using a fixed 0.5-second horizon.
Each prediction consumes only the current x, y, speed, and movement direction.
Future coordinates are read solely as evaluation/training targets. Inputs and
targets stop at the first recorded pass release, or the recorded endpoint for
non-passes. All observations of a game remain in one fold.

Example:
 python research/evaluate_motion.py --data data/demo.json data/packs/week-1-additional/demo.json

Errors are endpoint errors in yards. Overlapping frames are correlated: the
report supplies game/role summaries and equal-game means, not frame-independent
confidence intervals, significance claims, or evidence of causal route value.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
import hashlib
import json
import math
from pathlib import Path
from statistics import median
import sys

ROOT=Path(__file__).resolve().parents[1]
VERSION='experimental-motion-baselines-1.0.0'
EPS=1e-8


@dataclass(frozen=True)
class Sample:
    game_id: int
    play_id: str
    player_id: str
    role: str
    frame: int
    time: float
    target_frame: int
    target_time: float
    horizon: float
    x: float
    y: float
    vx: float
    vy: float
    target_x: float
    target_y: float
    cohort_eligible: bool = True


def current_features(row):
    """Read precisely current x/y/speed/direction; ignore every other column."""
    if not isinstance(row,(list,tuple)) or len(row)<4:
        raise ValueError('A current tracking row needs x, y, speed, direction')
    x,y,speed,direction=row[:4]
    if not all(isinstance(value,(int,float)) and math.isfinite(value) for value in (x,y,speed,direction)) or speed<0:
        raise ValueError('Current features must be finite and speed nonnegative')
    angle=math.radians(direction)
    return {'x':x,'y':y,'vx':speed*math.sin(angle),'vy':speed*math.cos(angle)}


def project(features,horizon,scale=1.0):
    """Constant current velocity, with an optional training-only shrink factor."""
    if not math.isfinite(horizon) or horizon<=0 or not math.isfinite(scale) or not 0<=scale<=1:
        raise ValueError('Horizon must be positive and velocity scale within [0,1]')
    return (features['x']+scale*features['vx']*horizon,
            features['y']+scale*features['vy']*horizon)


def observation_endpoint(play):
    times=play.get('times',[])
    if not times:return -1
    release=[i for i,event in enumerate(play.get('events',[])) if event=='pass_forward' and i<len(times)]
    return min(release) if release else len(times)-1


def samples_from_play(play,horizon=.5):
    """Return supervised samples, keeping future target values separate."""
    if not math.isfinite(horizon) or horizon<=0:raise ValueError('Horizon must be positive')
    times=play.get('times',[]);end=observation_endpoint(play)
    time_index={round(t,8):i for i,t in enumerate(times[:end+1])}
    samples=[];excluded=Counter()
    for entity in play.get('players',[]):
        if entity.get('side')=='ball' or entity.get('role')=='ball':continue
        track=entity.get('track',[])
        for frame in range(max(0,end+1)):
            t=times[frame];target_frame=time_index.get(round(t+horizon,8))
            if target_frame is None or target_frame<=frame:
                excluded['insufficient_horizon']+=1;continue
            if abs(times[target_frame]-t-horizon)>EPS or t<0:
                excluded['nonmatching_time']+=1;continue
            if any(not 0<times[j+1]-times[j]<=.15+EPS for j in range(frame,target_frame)):
                excluded['observation_gap']+=1;continue
            if frame>=len(track) or target_frame>=len(track):
                excluded['missing_track']+=1;continue
            try:features=current_features(track[frame])
            except ValueError:
                excluded['invalid_current_features']+=1;continue
            target=track[target_frame]
            if not isinstance(target,(list,tuple)) or len(target)<2 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in target[:2]):
                excluded['invalid_target']+=1;continue
            samples.append(Sample(game_id=int(play['gameId']),play_id=str(play['id']),player_id=str(entity['id']),
                                  role=entity.get('role','other'),frame=frame,time=t,target_frame=target_frame,
                                  target_time=times[target_frame],horizon=horizon,**features,
                                  target_x=target[0],target_y=target[1],cohort_eligible=play.get('cohortEligible',True)))
    return samples,dict(excluded)


def fit_velocity_scale(samples,training_game_ids,held_out_game_ids=()):
    """Fit one constrained least-squares coefficient, filtering by game IDs.

    The explicit holdout argument is an executable leakage guard, not metadata.
    Passing held-out samples in the collection cannot affect the fit.
    """
    training=set(map(int,training_game_ids));held=set(map(int,held_out_game_ids))
    if not training:raise ValueError('At least one training game is required')
    if training&held:raise ValueError('Training and held-out games must be disjoint')
    numerator=denominator=0.0;count=0;used=set();plays=set()
    for sample in samples:
        if sample.game_id not in training:continue
        dx,dy=sample.vx*sample.horizon,sample.vy*sample.horizon
        numerator+=dx*(sample.target_x-sample.x)+dy*(sample.target_y-sample.y)
        denominator+=dx*dx+dy*dy
        count+=1;used.add(sample.game_id);plays.add(sample.play_id)
    if used!=training:raise ValueError('A requested training game has no usable observations')
    unconstrained=numerator/denominator if denominator>0 else 0.0
    return {'scale':max(0.0,min(1.0,unconstrained)),'unconstrainedScale':unconstrained,
            'identifiable':denominator>0,'trainingGameIds':sorted(used),'heldOutGameIds':sorted(held),
            'trainingSamples':count,'trainingPlays':len(plays),'fitWeighting':'Equal weight per observed player-frame; no held-out observations enter fitting.'}


def prediction(sample,model,scale=1.0):
    if model not in {'stationary','constant_velocity','trained_shrinkage'}:raise ValueError('Unknown projection model')
    factor=0.0 if model=='stationary' else 1.0 if model=='constant_velocity' else scale
    return project({'x':sample.x,'y':sample.y,'vx':sample.vx,'vy':sample.vy},sample.horizon,factor)


def summarize(samples,model,scale=1.0):
    errors=[];dxs=[];dys=[];plays=set();players=set()
    for sample in samples:
        x,y=prediction(sample,model,scale);dx=x-sample.target_x;dy=y-sample.target_y
        errors.append(math.hypot(dx,dy));dxs.append(dx);dys.append(dy);plays.add(sample.play_id);players.add(sample.player_id)
    if not errors:return {'samples':0,'plays':0,'players':0,'meanErrorYards':None,'rmseYards':None,'medianErrorYards':None,'p90ErrorYards':None,'meanResidualX':None,'meanResidualY':None}
    errors.sort();n=len(errors)
    return {'samples':n,'plays':len(plays),'players':len(players),'meanErrorYards':sum(errors)/n,
            'rmseYards':math.sqrt(sum(e*e for e in errors)/n),'medianErrorYards':median(errors),
            'p90ErrorYards':errors[int((n-1)*.9)],'meanResidualX':sum(dxs)/n,'meanResidualY':sum(dys)/n}


def evaluate_samples(samples,include_trained=True):
    """Leave one complete game out; report every fold and every role."""
    games=sorted({s.game_id for s in samples})
    if len(games)<2:raise ValueError('Independent-game evaluation requires at least two games')
    roles=sorted({s.role for s in samples});models=['stationary','constant_velocity']+(['trained_shrinkage'] if include_trained else [])
    folds=[]
    for held_out in games:
        training=[g for g in games if g!=held_out];test=[s for s in samples if s.game_id==held_out]
        fit=fit_velocity_scale(samples,training,[held_out]) if include_trained else None
        if fit and held_out in fit['trainingGameIds']:raise AssertionError('Held-out game leaked into fit')
        by_role={}
        for role in roles:
            group=[s for s in test if s.role==role]
            if group:by_role[role]={model:summarize(group,model,fit['scale'] if fit else 1) for model in models}
        summary={model:summarize(test,model,fit['scale'] if fit else 1) for model in models}
        quality={}
        for label,flag in (('cohortEligible',True),('diagnosticFlagged',False)):
            group=[s for s in test if s.cohort_eligible==flag]
            quality[label]={model:summarize(group,model,fit['scale'] if fit else 1) for model in models}
        folds.append({'heldOutGameId':held_out,'trainingGameIds':training,'testGameIds':[held_out],
                      'testPlays':sorted({s.play_id for s in test}),'fit':fit,'models':summary,'byRole':by_role,'byQuality':quality})
    macro={}
    for model in models:
        macro[model]={'equalGameMeanErrorYards':sum(f['models'][model]['meanErrorYards'] for f in folds)/len(folds),
                      'equalGameRMSEYards':math.sqrt(sum(f['models'][model]['rmseYards']**2 for f in folds)/len(folds)),
                      'gameCount':len(folds),'observationCount':len(samples)}
    return {'folds':folds,'gameIds':games,'roles':roles,'models':models,'macroByGame':macro,
            'sampleCount':len(samples),'playCount':len({s.play_id for s in samples}),
            'splitGuarantee':'One entire game is held out per fold. No frame, player track, or play from that game enters coefficient fitting.',
            'uncertaintyPolicy':'No frame-independent confidence intervals or significance tests. Adjacent and same-play observations are correlated; game-level results are the reporting units.'}


def load_datasets(paths):
    plays={};sources=[]
    for path in paths:
        path=Path(path);contents=path.read_bytes();data=json.loads(contents)
        if data.get('schemaVersion')!=1 or not isinstance(data.get('plays'),list):raise ValueError(f'Unsupported data schema: {path}')
        try:source_path=path.resolve().relative_to(ROOT).as_posix()
        except ValueError:source_path=path.name
        sources.append({'file':source_path,'sha256':hashlib.sha256(contents).hexdigest(),'sourceRevision':data.get('meta',{}).get('sourceRevision'),
                        'season':data.get('meta',{}).get('season'),'gameIds':sorted({int(p['gameId']) for p in data['plays']}),
                        'playCount':len(data['plays'])})
        for play in data['plays']:
            key=str(play['id'])
            if key in plays and play!=plays[key]:raise ValueError(f'Conflicting duplicate play {key}')
            plays[key]=play
    return list(plays.values()),sources


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',nargs='+',type=Path,default=[ROOT/'data/demo.json',ROOT/'data/packs/week-1-additional/demo.json'])
    parser.add_argument('--output',type=Path,default=ROOT/'data/model-validation.json')
    parser.add_argument('--horizon',type=float,default=.5)
    parser.add_argument('--no-trained',action='store_true',help='Evaluate the two fixed baselines only')
    args=parser.parse_args(argv)
    try:
        plays,sources=load_datasets(args.data);samples=[];exclusions=Counter()
        for play in plays:
            produced,excluded=samples_from_play(play,args.horizon);samples.extend(produced);exclusions.update(excluded)
        report=evaluate_samples(samples,not args.no_trained)
        report.update({'status':'experimental_evaluation_complete','version':VERSION,'horizonSeconds':args.horizon,
                       'featureContract':['current_x','current_y','current_speed','current_movement_direction'],
                       'targetContract':'Observed x/y exactly one horizon later, no later than first pass_forward or recorded endpoint.',
                       'trainingObjective':'Global scalar alpha in [0,1] minimizing squared two-dimensional displacement error on training games only.',
                       'sources':sources,'excludedSamples':dict(exclusions),'engineSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       'deployment':'Research-only report. No projection, learned parameter, catch probability, or time-to-reach model is enabled in the coaching app.',
                       'limitations':['The four-game cohort is small and not a representative season sample.',
                                      'Overlapping observations are correlated; training uses per-observation weighting, while headline error averages games equally.',
                                      'A lower trajectory error does not validate causal route attribution, catchability, coverage responsibility, or coaching decisions.',
                                      'The same source season supplies training and held-out games; these results do not establish generalization to another season or tracking provider.',
                                      'Release/endpoint availability limits the evaluated horizons; no unobserved future target is fabricated.']})
        args.output.parent.mkdir(parents=True,exist_ok=True);temporary=args.output.with_suffix(args.output.suffix+'.tmp')
        temporary.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8');temporary.replace(args.output)
    except (OSError,ValueError,KeyError,TypeError) as error:
        print(f'Experimental evaluation failed: {error}',file=sys.stderr);return 1
    print(f"Experimental motion evaluation: {len(report['gameIds'])} disjoint game folds, {report['playCount']} plays, {report['sampleCount']} observed targets.")
    for model,values in report['macroByGame'].items():print(f"  {model}: equal-game mean endpoint error {values['equalGameMeanErrorYards']:.4f} yd")
    print(f'Report: {args.output}')
    return 0


if __name__=='__main__':raise SystemExit(main())
