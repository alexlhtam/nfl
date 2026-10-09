"""Guard game-level independence, current-only predictors, and release cutoffs."""
from __future__ import annotations
import copy
from dataclasses import replace
import math
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from research.evaluate_motion import Sample,current_features,project,prediction,samples_from_play,fit_velocity_scale,evaluate_samples,summarize


def sample(game,scale=1,frame=0,vx=2):
    return Sample(game_id=game,play_id=f'{game}_1',player_id='p',role='route',frame=frame,time=frame*.1,
                  target_frame=frame+5,target_time=frame*.1+.5,horizon=.5,x=30,y=20,vx=vx,vy=0,
                  target_x=30+vx*.5*scale,target_y=20)


def play_fixture():
    return {'id':'1_1','gameId':1,'times':[i/10 for i in range(11)],
            'events':['ball_snap']+['']*7+['pass_forward','','pass_outcome_caught'],
            'players':[{'id':'p','side':'offense','role':'route',
                        'track':[[30+i/10,20,1,90,0,900+i] for i in range(11)]},
                       {'id':'ball','side':'ball','role':'ball','track':[[30,20,0,0,0]]*11}]}


class MotionEvaluationTests(unittest.TestCase):
    def test_direction_convention_and_stationary_baseline(self):
        east=current_features([10,20,4,90,123,999])
        north=current_features([10,20,4,0,-300,999])
        self.assertAlmostEqual(project(east,.5)[0],12);self.assertAlmostEqual(project(east,.5)[1],20)
        self.assertEqual(project(north,.5),(10,22))
        self.assertEqual(project(east,.5,0),(10,20))

    def test_features_read_only_current_x_y_speed_direction(self):
        row=[10,20,4,90,15,900]
        base=current_features(row)
        changed=row[:4]+[float('nan'),-999,'post-throw-information']
        self.assertEqual(base,current_features(changed))
        p=play_fixture();before,_=samples_from_play(p)
        altered=copy.deepcopy(p)
        for row in altered['players'][0]['track'][5:]:row[0]+=1000
        after,_=samples_from_play(altered)
        self.assertEqual(prediction(before[0],'constant_velocity'),prediction(after[0],'constant_velocity'))
        self.assertNotEqual(before[0].target_x,after[0].target_x)

    def test_targets_and_inputs_never_cross_recorded_release(self):
        p=play_fixture();samples,counts=samples_from_play(p)
        self.assertEqual(len(samples),4)
        self.assertTrue(all(s.frame<=3 and s.target_frame<=8 for s in samples))
        self.assertTrue(all(s.target_time<=.8 for s in samples))
        self.assertTrue(all(s.player_id!='ball' for s in samples))
        self.assertEqual(counts['insufficient_horizon'],5)

    def test_exact_horizon_required_no_target_interpolation(self):
        p=play_fixture();p['times'][5]=.51
        samples,counts=samples_from_play(p)
        self.assertFalse(any(s.frame==0 for s in samples))
        self.assertGreater(counts['insufficient_horizon'],0)

    def test_training_filter_ignores_held_out_targets(self):
        samples=[sample(1,.4,i) for i in range(3)]+[sample(2,.7,i) for i in range(3)]
        fit=fit_velocity_scale(samples,[1],[2])
        poisoned=[replace(s,target_x=1e12) if s.game_id==2 else s for s in samples]
        other=fit_velocity_scale(poisoned,[1],[2])
        self.assertEqual(fit,other)
        self.assertAlmostEqual(fit['scale'],.4)
        self.assertEqual(fit['trainingSamples'],3)

    def test_training_holdout_overlap_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'disjoint'):fit_velocity_scale([sample(1)],[1],[1])
        with self.assertRaisesRegex(ValueError,'no usable'):fit_velocity_scale([sample(1)],[2],[1])

    def test_each_game_and_every_play_stay_in_one_test_fold(self):
        samples=[sample(game,.2*game,frame) for game in (1,2,3,4) for frame in range(3)]
        result=evaluate_samples(samples)
        self.assertEqual(len(result['folds']),4)
        observed=set()
        for fold in result['folds']:
            test=set(fold['testGameIds']);train=set(fold['trainingGameIds'])
            self.assertFalse(test&train);self.assertEqual(test|train,{1,2,3,4})
            self.assertFalse(set(fold['fit']['trainingGameIds'])&test)
            self.assertEqual(fold['models']['constant_velocity']['samples'],3)
            self.assertFalse(observed&set(fold['testPlays']));observed.update(fold['testPlays'])
        self.assertEqual(len(observed),4)

    def test_fit_is_shrinkage_bounded_and_handles_zero_velocity(self):
        self.assertEqual(fit_velocity_scale([sample(1,3)],[1],[2])['scale'],1)
        self.assertEqual(fit_velocity_scale([sample(1,-3)],[1],[2])['scale'],0)
        result=fit_velocity_scale([sample(1,vx=0)],[1],[2])
        self.assertFalse(result['identifiable']);self.assertEqual(result['scale'],0)

    def test_known_error_and_residual_values(self):
        s=sample(1,1)
        static=summarize([s],'stationary')
        self.assertEqual(static['meanErrorYards'],1);self.assertEqual(static['rmseYards'],1)
        self.assertEqual(static['meanResidualX'],-1)
        self.assertEqual(summarize([s],'constant_velocity')['meanErrorYards'],0)

    def test_equal_game_reporting_does_not_weight_big_game_more(self):
        samples=[sample(1,0)]+[sample(2,1,i) for i in range(10)]
        report=evaluate_samples(samples,include_trained=False)
        self.assertEqual(report['macroByGame']['stationary']['equalGameMeanErrorYards'],.5)
        self.assertAlmostEqual(report['macroByGame']['stationary']['equalGameRMSEYards'],math.sqrt(.5))
        self.assertNotIn('confidenceInterval',str(report))


if __name__=='__main__':unittest.main()
