"""Python/browser agreement on real packs and corrupt shared import fixtures."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(Path(__file__).parent))
from schema import validate_dataset
from test_schema import dataset_fixture


class BrowserSchemaTests(unittest.TestCase):
    def node_results(self,cases):
        node=os.environ.get('OPEN_FIELD_NODE') or shutil.which('node')
        if not node:self.skipTest('Node is required for browser schema parity; available in JavaScript CI')
        process=subprocess.run([node,str(ROOT/'tests/schema_js.cjs')],input=json.dumps(cases),
                               text=True,capture_output=True,timeout=45)
        self.assertEqual(process.returncode,0,process.stderr)
        return json.loads(process.stdout)

    def test_shared_corruption_cases_rejected_by_both_validators(self):
        fixture=dataset_fixture()
        mutations=json.loads((ROOT/'tests/fixtures/schema_cases.json').read_text(encoding='utf-8'))
        cases=[]
        for mutation in mutations:
            data=copy.deepcopy(fixture);target=data
            for segment in mutation['path'][:-1]:target=target[segment]
            target[mutation['path'][-1]]=mutation['value']
            cases.append({'name':mutation['name'],'data':data})
            with self.subTest(name=mutation['name']),self.assertRaises(ValueError):validate_dataset(data)
        for result in self.node_results(cases):
            with self.subTest(name=result['name']):
                self.assertFalse(result['valid'],result)
                self.assertTrue(result['unchanged'],result)
                self.assertIn(':',result['error'])

    def test_legacy_extended_tracks_and_unknown_json_extensions_are_preserved(self):
        extended=dataset_fixture()
        extended['extension']={'nested':[None,True,1.5,'preserved']}
        legacy=copy.deepcopy(extended)
        for player in legacy['plays'][0]['players']:player['track']=[row[:5] for row in player['track']]
        nullable=copy.deepcopy(extended)
        for player in nullable['plays'][0]['players']:player['track']=[row[:5]+[None,None] for row in player['track']]
        cases=[{'name':name,'data':data} for name,data in [('extended',extended),('legacy',legacy),('nullable_acceleration',nullable)]]
        for case in cases:self.assertIs(validate_dataset(case['data']),case['data'])
        for result in self.node_results(cases):
            self.assertTrue(result['valid'],result)
            self.assertTrue(result['sameObject'],result)
            self.assertTrue(result['unchanged'],result)

    def test_both_complete_real_packs_pass_without_mutation(self):
        paths=[ROOT/'data/demo.json',ROOT/'data/packs/week-1-additional/demo.json']
        cases=[]
        for path in paths:
            data=json.loads(path.read_text(encoding='utf-8'))
            self.assertIs(validate_dataset(data),data)
            cases.append({'name':str(path.relative_to(ROOT)),'data':data})
        for result in self.node_results(cases):
            self.assertTrue(result['valid'],result)
            self.assertTrue(result['sameObject'],result)
            self.assertTrue(result['unchanged'],result)


if __name__=='__main__':unittest.main()
