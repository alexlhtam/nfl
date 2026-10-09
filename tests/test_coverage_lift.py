"""Metric contract, geometry invariants, observed event accounting, and JS parity."""
from __future__ import annotations
import copy
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import metrics as M

FIXTURES=json.loads((ROOT/'tests/fixtures/metric_cases.json').read_text(encoding='utf-8'))


class CoverageLiftTests(unittest.TestCase):
    def fixture(self,name):
        return copy.deepcopy(next(c for c in FIXTURES['cases'] if c['name']==name))

    def test_shared_synthetic_cases(self):
        for case in FIXTURES['cases']:
            with self.subTest(case=case['name']):
                result=M.coverage_lift(case['play'],case['receiverId'],case['frame'],case['options'])
                for key,expected in case['expected'].items():
                    if key=='shapley':
                        actual=M.defender_contributions(case['play'],case['receiverId'],case['frame'],case['options'])
                        values={d['id']:d['value'] for d in actual['contributions']}
                        for player,value in expected.items():self.assertAlmostEqual(values[player],value,places=8)
                    elif key=='eventCount':self.assertEqual(len(M.events(case['play'],case['receiverId'],case['options'])),expected)
                    elif isinstance(expected,bool):self.assertIs(result[key],expected)
                    elif isinstance(expected,(int,float)):self.assertAlmostEqual(result[key],expected,places=8)
                    else:self.assertEqual(result[key],expected)

    def test_identical_separation_gains_have_different_motion_components(self):
        a,b=self.fixture('defender_only'),self.fixture('receiver_only')
        x,y=[M.coverage_lift(c['play'],'r',5) for c in (a,b)]
        self.assertEqual(x['gain'],y['gain'])
        self.assertEqual((x['coverage'],x['receiver']),(2,0))
        self.assertEqual((y['coverage'],y['receiver']),(0,2))

    def test_random_geometry_additivity_and_capture_bounds(self):
        rng=random.Random(7812)
        for _ in range(150):
            c=self.fixture('joint_withdrawal');p=c['play']
            for entity in p['players']:
                start=[rng.uniform(20,50),rng.uniform(10,40)]
                end=[start[0]+rng.uniform(-5,5),start[1]+rng.uniform(-5,5)]
                for i,row in enumerate(entity['track']):row[:2]=[start[k]+(end[k]-start[k])*min(i/5,1) for k in (0,1)]
            v=M.coverage_lift(p,'r',5)
            self.assertAlmostEqual(v['coverage']+v['receiver'],v['gain'],places=11)
            self.assertTrue(0<=v['captured']<=max(0,v['gain'])+1e-12)

    def test_rotation_translation_reflection_and_order_invariance(self):
        original=self.fixture('joint_withdrawal')['play']
        reference=M.coverage_lift(original,'r',5,{'downfieldOnly':False,'inBoundsOnly':False})
        for transform in (lambda x,y:(x+8,y-2),lambda x,y:(-y,x),lambda x,y:(120-x,53.3-y)):
            play=copy.deepcopy(original)
            for entity in play['players']:
                for row in entity['track']:row[:2]=transform(*row[:2])
            play['players'].reverse()
            value=M.coverage_lift(play,'r',5,{'downfieldOnly':False,'inBoundsOnly':False})
            for field in ('coverage','receiver','gain','captured'):
                self.assertAlmostEqual(value[field],reference[field],places=10)

    def test_exact_defender_allocation_efficiency_symmetry_and_dummy(self):
        for name in ('joint_withdrawal','symmetric_defenders','replacement_coverage'):
            c=self.fixture(name);value=M.defender_contributions(c['play'],'r',5)
            self.assertAlmostEqual(value['total'],value['coverage'],places=10)
            self.assertAlmostEqual(value['residual'],0,places=10)
            if name=='symmetric_defenders':self.assertAlmostEqual(value['contributions'][0]['value'],value['contributions'][1]['value'])
            if name=='replacement_coverage':self.assertEqual(next(x['value'] for x in value['contributions'] if x['id']=='d2'),0)

    def test_exact_work_is_bounded_at_eleven_defenders(self):
        p=self.fixture('defender_only')['play']
        for i in range(11):
            d=copy.deepcopy(p['players'][1]);d['id']=f'extra-{i}';p['players'].append(d)
        result=M.defender_contributions(p,'r',5)
        self.assertFalse(result['valid']);self.assertEqual(result['coalitions'],0)

    def test_upcrossing_confirmation_cannot_use_future_observations(self):
        p=self.fixture('observed_event')['play']
        self.assertEqual(M.events(p,'r',{'throughTime':.7}),[])
        actual=M.events(p,'r',{'throughTime':.8})
        self.assertEqual(len(actual),1)
        self.assertAlmostEqual(actual[0]['onset'],.6)
        self.assertAlmostEqual(actual[0]['confirmedAt'],.8)
        self.assertTrue(actual[0]['rightCensored'])

    def test_already_open_is_left_censored_not_a_new_opening(self):
        p=self.fixture('already_open')['play']
        w=M.windows(p,'r')
        self.assertEqual(len(w['intervals']),1)
        self.assertTrue(w['intervals'][0]['leftCensored'])
        self.assertTrue(w['intervals'][0]['rightCensored'])
        self.assertAlmostEqual(w['total'],.7)
        self.assertEqual(w['percentEligible'],100)
        self.assertIsNone(w['timeToFirst'])
        self.assertEqual(M.events(p,'r'),[])

    def test_scope_entry_does_not_manufacture_threshold_upcrossing(self):
        p=self.fixture('already_open')['play'];p['los']=30.3
        for i,row in enumerate(p['players'][0]['track']):row[0]=30+i*.1
        w=M.windows(p,'r')
        self.assertTrue(w['intervals'][0]['leftCensored'])
        self.assertEqual(M.events(p,'r'),[])

    def test_one_observation_has_no_interval_duration(self):
        p=self.fixture('already_open')['play']
        w=M.windows(p,'r',{'throughFrame':0})
        self.assertEqual(w['total'],0);self.assertEqual(w['eligibleSeconds'],0)
        self.assertIsNone(w['percentEligible'])

    def test_minimum_hold_filters_windows_without_erasing_raw_observations(self):
        p=self.fixture('observed_event')['play']
        partial=M.windows(p,'r',{'throughTime':.7})
        self.assertEqual(partial['intervals'],[])
        self.assertEqual(partial['total'],0)
        self.assertAlmostEqual(partial['rawTotal'],.1)
        self.assertTrue(partial['rawIntervals'][0]['rightCensored'])
        confirmed=M.windows(p,'r',{'throughTime':.8})
        self.assertAlmostEqual(confirmed['total'],.2)
        self.assertEqual(len(confirmed['intervals']),1)
        longer=M.windows(p,'r',{'throughTime':.8,'minDuration':.3})
        self.assertEqual(longer['intervals'],[])
        self.assertEqual(longer['rawIntervals'],confirmed['rawIntervals'])
        raw=M.windows(p,'r',{'throughTime':.7,'minDuration':0})
        self.assertEqual(raw['intervals'],raw['rawIntervals'])
        # A closing observation at exactly the hold endpoint cannot confirm it.
        p['players'][1]['track'][8][:2]=[32,20]
        closed=M.windows(p,'r',{'throughTime':.8})
        self.assertAlmostEqual(closed['rawTotal'],.2)
        self.assertEqual(closed['intervals'],[])

    def test_full_precision_threshold_not_display_rounding(self):
        p=self.fixture('already_open')['play']
        for row in p['players'][1]['track']:row[:2]=[34.4997,20]
        self.assertEqual(M.windows(p,'r',{'threshold':4.5})['total'],0)
        self.assertAlmostEqual(M.windows(p,'r',{'threshold':4.499})['total'],.7)

    def test_fixed_point_change_is_not_receiver_motion(self):
        a=self.fixture('receiver_only')['play'];b=self.fixture('defender_only')['play']
        self.assertEqual(M.inspect_point(a,{'x':30,'y':20},5)['change'],0)
        self.assertEqual(M.inspect_point(b,{'x':30,'y':20},5)['change'],2)

    def test_regional_geometry_reports_area_and_arrival_separately(self):
        p=self.fixture('defender_only')['play']
        result=M.region_series(p,{'xMin':29,'xMax':31,'yMin':19,'yMax':21},{'gridStep':1})
        self.assertTrue(result['valid']);self.assertEqual(result['area'],4)
        self.assertEqual(result['points'],4)
        self.assertTrue(result['series'][0]['arrivals'][0]['leftCensored'])
        self.assertFalse(result['series'][0]['arrivals'][0]['entered'])
        self.assertGreater(result['series'][5]['meanChange'],0)
        for row in result['series']:
            self.assertTrue(0<=row['openArea']<=4)
            self.assertAlmostEqual(row['openArea'],4*row['openFraction'])

    def test_jitter_is_reproducible_stress_test_and_zero_amplitude_identity(self):
        p=self.fixture('defender_only')['play']
        a=M.sensitivity(p,'r',5,{'jitterSamples':8})
        self.assertEqual(a,M.sensitivity(p,'r',5,{'jitterSamples':8}))
        zero=M.sensitivity(p,'r',5,{'jitter':0,'jitterSamples':8})
        self.assertEqual(zero['jitter']['min'],zero['baseline']['coverage'])
        self.assertEqual(zero['jitter']['max'],zero['baseline']['coverage'])

    def test_regional_scope_entry_is_not_a_geometric_arrival(self):
        p=self.fixture('regional_scope_entry')['play']
        result=M.region_series(p,{'xMin':28,'xMax':32,'yMin':18,'yMax':22})
        arrivals=[arrival for row in result['series'] for arrival in row['arrivals']]
        self.assertTrue(arrivals)
        self.assertFalse(any(arrival['entered'] for arrival in arrivals))
        self.assertTrue(arrivals[0]['scopeEntered'])
        self.assertTrue(arrivals[0]['leftCensored'])
        self.assertIsNone(arrivals[0]['openingToArrival'])
        result=M.region_series(p,{'xMin':30.4,'xMax':32,'yMin':18,'yMax':22})
        arrivals=[arrival for row in result['series'] for arrival in row['arrivals'] if arrival['entered']]
        self.assertEqual(len(arrivals),1)
        self.assertFalse(arrivals[0]['scopeEntered'])
        self.assertFalse(arrivals[0]['leftCensored'])

    def test_association_never_forces_credit_or_exceeds_budget(self):
        p=self.fixture('defender_only')['play']
        alone=M.assist_candidates(p,'r',5)
        self.assertEqual(alone['candidates'],[])
        self.assertEqual(alone['unassigned'],alone['allocationBudget'])
        follower=copy.deepcopy(p['players'][1]);follower.update(id='a',name='Route A',side='offense',role='route')
        for row in follower['track']:row[1]+=1
        p['players'].append(follower)
        one=M.assist_candidates(p,'r',5)
        self.assertGreater(one['candidates'][0]['associatedValue'],0)
        self.assertGreater(one['unassigned'],0)
        twin=copy.deepcopy(follower);twin['id']='b';p['players'].append(twin)
        ambiguous=M.assist_candidates(p,'r',5)
        self.assertAlmostEqual(sum(c['associatedValue'] for c in ambiguous['candidates']),0)
        self.assertAlmostEqual(ambiguous['unassigned'],ambiguous['allocationBudget'])

    def test_comparison_reports_matching_and_mismatching_context(self):
        p=self.fixture('defender_only')['play'];same=copy.deepcopy(p);same['id']='same'
        different=copy.deepcopy(p);different.update(id='different',coverage='Cover-1',formation='EMPTY',down=4,yardsToGo=15)
        result=M.compare_matches(p,[p,different,same])
        self.assertEqual(result[0]['playId'],'same')
        self.assertEqual(result[0]['score'],1)
        self.assertLess(result[1]['score'],1)
        self.assertIn('coverage',{m['field'] for m in result[1]['mismatches']})

    def test_real_engram_and_hill_distinguish_opening_mechanisms(self):
        data=json.loads((ROOT/'data/demo.json').read_text(encoding='utf-8'))
        for case in FIXTURES['realCases']:
            p=next(p for p in data['plays'] if p['id']==case['playId'])
            result=M.coverage_lift(p,case['receiverId'],M.frame_at(p,case['time']))
            for key,value in case['expected'].items():self.assertAlmostEqual(result[key],value,places=8)

    def test_javascript_python_full_result_parity(self):
        node=os.environ.get('OPEN_FIELD_NODE') or shutil.which('node')
        if not node:self.skipTest('Node is optional; run node tests/metrics_js.cjs in JavaScript CI')
        process=subprocess.run([node,str(ROOT/'tests/metrics_js.cjs'),'--json'],capture_output=True,text=True,timeout=40)
        self.assertEqual(process.returncode,0,process.stderr)
        actual=json.loads(process.stdout)
        expected=[]
        for c in FIXTURES['cases']:
            p,r,f,o=c['play'],c['receiverId'],c['frame'],c['options']
            expected.append({'name':c['name'],'lift':M.coverage_lift(p,r,f,o),'nearest':M.nearest(p,r,f,o),
                             'windows':M.windows(p,r,o),'events':M.events(p,r,o),'series':M.series(p,r,o),
                             'contribution':M.defender_contributions(p,r,f,o),'assist':M.assist_candidates(p,r,f,o),
                             'sensitivity':M.sensitivity(p,r,f,{**o,'jitterSamples':8}),
                             'point':M.inspect_point(p,{'x':30,'y':20},f,o),
                             'region':M.region_series(p,{'xMin':28,'xMax':32,'yMin':18,'yMax':22},{**o,'gridStep':2})})
        data=json.loads((ROOT/'data/demo.json').read_text(encoding='utf-8'))
        for c in FIXTURES['realCases']:
            p=next(p for p in data['plays'] if p['id']==c['playId']);f=M.frame_at(p,c['time']);r=c['receiverId']
            expected.append({'name':c['name'],'lift':M.coverage_lift(p,r,f),'contribution':M.defender_contributions(p,r,f),'assist':M.assist_candidates(p,r,f)})
        def compare(a,b,where='root'):
            if isinstance(a,dict):
                self.assertEqual(set(a),set(b),where)
                for key in a:compare(a[key],b[key],where+'.'+key)
            elif isinstance(a,list):
                self.assertEqual(len(a),len(b),where)
                for i,(x,y) in enumerate(zip(a,b)):compare(x,y,f'{where}[{i}]')
            elif isinstance(a,bool) or a is None or isinstance(a,str):self.assertEqual(a,b,where)
            else:self.assertAlmostEqual(a,b,delta=1e-8,msg=where)
        compare(actual,expected)


if __name__=='__main__':unittest.main()
