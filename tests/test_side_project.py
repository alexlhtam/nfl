"""Offline side-project payload integrity and local asset boundaries."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import app

TEMPLATE='<!doctype html><script>const SIDE_PROJECT=__SIDE_PROJECT_DATA__;</script><script>const DATA=__ROUTE_DATA__;</script>'


class SideProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.folder=self.root/'web/side-projects/fruit-fly-in-the-pocket'
        self.folder.mkdir(parents=True)
        self.metadata={'title':'Fruit fly in the pocket','description':'Independent project','slideCount':14,
                       'presentation':'slides.pptx','preview':'preview.png','summary':'Deck overview',
                       'sections':[{'title':'Methods','description':'Observed examples'}]}
        self.deck=b'PK\x03\x04fixture-deck\x00\xff'
        self.preview=b'\x89PNG\r\n\x1a\nfixture-preview'
        self.write_metadata()
        (self.folder/'slides.pptx').write_bytes(self.deck)
        (self.folder/'preview.png').write_bytes(self.preview)
        self.template=self.root/'web/index.html';self.template.write_text(TEMPLATE,encoding='utf-8')
        self.root_patch=patch.object(app,'ROOT',self.root);self.root_patch.start();self.addCleanup(self.root_patch.stop)
        self.template_patch=patch.object(app,'TEMPLATE',self.template);self.template_patch.start();self.addCleanup(self.template_patch.stop)

    def write_metadata(self):
        (self.folder/'project.json').write_text(json.dumps(self.metadata),encoding='utf-8')

    def render(self):return app.render_html({'meta':{},'plays':[]})

    def application(self,html):
        return json.loads(re.search(r'const DATA=(.*?);</script>',html).group(1))['meta']['application']

    def test_embedded_binary_bytes_and_digest_are_exact(self):
        html=self.render()
        payload=json.loads(re.search(r'const SIDE_PROJECT=(.*?);</script>',html).group(1))
        self.assertEqual(base64.b64decode(payload['presentationBase64']),self.deck)
        self.assertEqual(payload['presentationSha256'],hashlib.sha256(self.deck).hexdigest())
        self.assertEqual(base64.b64decode(payload['previewDataUrl'].split(',',1)[1]),self.preview)
        self.assertEqual(payload['slideCount'],14)
        self.assertNotIn('__SIDE_PROJECT_DATA__',html)
        self.assertEqual(self.application(html)['version'],'2.1.0')
        self.assertEqual(self.application(html)['metricVersion'],'2.0.0')

    def test_side_project_text_cannot_terminate_embedded_script(self):
        self.metadata['summary']='</script><script>bad()</script>\u2028 & <';self.write_metadata()
        html=self.render()
        embedded=re.search(r'const SIDE_PROJECT=(.*?);</script>',html).group(1)
        self.assertNotIn('<',embedded)
        self.assertEqual(json.loads(embedded)['summary'],self.metadata['summary'])
        self.assertEqual(html.count('</script>'),2)

    def test_payload_text_is_not_reinterpreted_as_another_template_token(self):
        self.metadata['summary']='Literal __ROUTE_DATA__ and __SIDE_PROJECT_DATA__';self.write_metadata()
        html=app.render_html({'meta':{},'label':'Literal __SIDE_PROJECT_DATA__'})
        side=json.loads(re.search(r'const SIDE_PROJECT=(.*?);</script>',html).group(1))
        data=json.loads(re.search(r'const DATA=(.*?);</script>',html).group(1))
        self.assertEqual(side['summary'],self.metadata['summary'])
        self.assertEqual(data['label'],'Literal __SIDE_PROJECT_DATA__')

    def test_all_asset_bytes_contribute_to_application_source_hash(self):
        before=self.application(self.render())['sourceHash']
        for name in ('project.json','slides.pptx','preview.png'):
            path=self.folder/name;original=path.read_bytes()
            path.write_bytes(original+b' ')
            changed=self.application(self.render())['sourceHash']
            self.assertNotEqual(before,changed,name)
            path.write_bytes(original)
        self.assertEqual(self.application(self.render())['sourceHash'],before)

    def test_missing_required_assets_fail_clearly(self):
        for name in ('project.json','slides.pptx','preview.png'):
            path=self.folder/name;original=path.read_bytes();path.unlink()
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'Required side-project asset is missing'):
                self.render()
            path.write_bytes(original)

    def test_asset_paths_cannot_escape_the_bundle(self):
        for name in ('../outside.pptx','sub/../../outside.pptx','..\\outside.pptx','C:\\outside.pptx','/outside.pptx'):
            self.metadata['presentation']=name;self.write_metadata()
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'within its asset folder'):
                self.render()

    def test_malformed_metadata_rejected_before_dead_ui_is_created(self):
        for key,value in (('title',''),('slideCount',True),('sections',[{'title':'Missing description'}]),('preview',None)):
            original=self.metadata[key];self.metadata[key]=value;self.write_metadata()
            with self.subTest(key=key),self.assertRaises(ValueError):self.render()
            self.metadata[key]=original;self.write_metadata()

    def test_custom_template_does_not_require_side_project_files(self):
        (self.folder/'project.json').unlink()
        result=app.render_html({'value':1},template_text='<script>const DATA=__ROUTE_DATA__;</script>')
        self.assertEqual(result,'<script>const DATA={"value":1};</script>')


if __name__=='__main__':unittest.main()
