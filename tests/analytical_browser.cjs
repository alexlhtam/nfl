/* Independent browser acceptance: numerical and observational behavior, not
 * merely the presence of controls. Run against a freshly exported offline app.
 * node tests/analytical_browser.cjs submission [--firefox]
 */
'use strict';
const playwright=require(process.env.OPEN_FIELD_PLAYWRIGHT||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const M=require('../web/src/metrics.js');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/demo.json'),'utf8'));
const OUT=path.resolve(process.argv[2]||path.join(__dirname,'../submission'));
const QA=path.join(OUT,'qa');fs.mkdirSync(QA,{recursive:true});
const firefox=process.argv.includes('--firefox');
const checks=[],failures=[];
const close=(a,b,tolerance=1e-8,message='numerical equality')=>assert(Math.abs(a-b)<=tolerance,`${message}: ${a} != ${b}`);
const numeric=text=>Number(String(text).replace(/−/g,'-').match(/[+-]?\d+(?:\.\d+)?/)?.[0]);
const signed=value=>(value>0?'+':'')+value.toFixed(2);
const source=id=>data.plays.find(p=>p.id===id);
const DEFAULTS={scope:'coverage',threshold:3,lookback:.5,minDuration:.2,downfieldOnly:true,inBoundsOnly:true};

(async()=>{
  const browser=await(firefox?playwright.firefox:playwright.chromium).launch({headless:true,...(!firefox&&process.env.OPEN_FIELD_BROWSER?{executablePath:process.env.OPEN_FIELD_BROWSER}:{})});
  const context=await browser.newContext({viewport:{width:1560,height:1100},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  try {
    await page.goto(pathToFileURL(path.join(OUT,'Open-Field.html')).href);
    await page.waitForFunction(()=>window.OpenFieldApp&&window.OpenFieldWorkspace&&window.OFMetrics);
    async function setup({id='2021110100_2120',receiver='44835',time=2.1,other=null,otherReceiver=null,ui={},metricOptions={},layers={},alignment='snap'}={}) {
      await page.evaluate(config=>{
        const app=OpenFieldApp,s=app.getSnapshot();
        app.setSnapshot({...s,a:config.id,b:config.other,t:config.time,alignment:config.alignment,
          receivers:{a:config.receiver,b:config.otherReceiver},focusPlayers:{a:config.receiver,b:config.otherReceiver},pairReceivers:{a:null,b:null},
          metricOptions:{scope:'coverage',threshold:3,lookback:.5,minDuration:.2,downfieldOnly:true,inBoundsOnly:true,...config.metricOptions},
          ui:{...s.ui,tab:'replay',blind:false,baseline:false,statsMode:'full',studyBoard:'a',chart:'separation',zoom:1,expanded:false,...config.ui},
          layers:{...s.layers,heat:true,ghosts:true,links:true,contours:false,lane:false,trail:'.65',...config.layers},
          point:null,region:null,preSnap:null,loop:{enabled:false,start:0,end:1}});
      },{id,receiver,time,other,otherReceiver,ui,metricOptions,layers,alignment});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }
    async function check(name,fn) {
      try {await fn();checks.push(name);}
      catch(error){failures.push({name,error:String(error.stack||error)});await page.screenshot({path:path.join(QA,`analytical-failure-${failures.length}.png`),fullPage:true}).catch(()=>{});}
    }
    async function nativeEvidence() {
      return page.evaluate(()=>{
        const labels=[],prototype=CanvasRenderingContext2D.prototype,original=prototype.fillText;
        prototype.fillText=function(text,...args){labels.push({text:String(text),width:this.canvas.width,height:this.canvas.height});return original.call(this,text,...args);};
        try {const canvas=OpenFieldWorkspace.renderEvidenceCanvas();return {width:canvas.width,height:canvas.height,labels,bytes:canvas.toDataURL().length};}
        finally {prototype.fillText=original;}
      });
    }

    await check('Engram four displayed distances and signed components match unrounded geometry',async()=>{
      await setup();await page.locator('[data-tab="routes"]').click();
      const values=await page.locator('#fourDistances .four-grid strong').allTextContents();
      const expected=[2.4045373775427135,.7696752561957554,4.950474724710751,3.498942697444474];
      assert.equal(values.length,4);
      values.forEach((value,i)=>close(numeric(value),expected[i],.00501,`hybrid distance ${i}`));
      const lift=M.coverageLift(source('2021110100_2120'),'44835',21,DEFAULTS);
      const actual=await page.evaluate(()=>OpenFieldApp.getContext('a'));
      for(const key of ['coverage','receiver','gain','captured'])close(actual[key],lift[key]);
      close(numeric(await page.locator('[data-board="a"] .coverage-lift').textContent()),lift.coverage,.05001);
      close(lift.coverage+lift.receiver,lift.gain);
    });

    await check('Hill negative defense component remains negative while receiver separation grows',async()=>{
      await setup({id:'2021110100_1396',receiver:'43454',time:2.3});
      const lift=M.coverageLift(source('2021110100_1396'),'43454',23,DEFAULTS);
      assert(lift.coverage<0&&lift.receiver>0&&lift.gain>0);
      const card=page.locator('[data-board="a"] .coverage-lift');
      assert.match(await card.getAttribute('class'),/negative/);
      close(numeric(await card.innerText()),lift.coverage,.05001);
      const actual=await page.evaluate(()=>OpenFieldApp.getContext('a'));
      close(actual.captured,0);close(actual.coverage,lift.coverage);
    });

    await check('Minimum hold changes real observed-so-far windows, table totals and timeline shading',async()=>{
      const p=source('2021090900_97'),r='41233';
      await setup({id:p.id,receiver:r,time:3,ui:{statsMode:'sofar'}});
      await page.locator('[data-tab="routes"]').click();
      async function inspect(hold){
        await page.locator('#minDuration').selectOption(String(hold).replace(/^0\./,'.'));
        return page.evaluate(()=>({
          total:document.querySelector('[data-board="a"] .total-window').textContent,
          row:[...document.querySelectorAll('#allRoutesTable tbody tr')].find(r=>r.textContent.includes('Mike Evans')).cells[5].textContent,
          image:document.querySelector('#allRoutesTimeline').toDataURL(),
          value:OpenFieldApp.getWindows(OpenFieldApp.getPlay('a'),OpenFieldApp.state.receivers.a,OpenFieldApp.getObservedTime('a'))
        }));
      }
      const short=await inspect(.2),long=await inspect(.5);
      const expectedShort=M.windows(p,r,{...DEFAULTS,throughTime:3,minDuration:.2}),expectedLong=M.windows(p,r,{...DEFAULTS,throughTime:3,minDuration:.5});
      close(short.value.total,expectedShort.total);close(long.value.total,expectedLong.total);
      close(numeric(short.total),expectedShort.total,.05001);close(numeric(long.total),expectedLong.total,.05001);
      close(numeric(short.row),expectedShort.total,.05001);close(numeric(long.row),expectedLong.total,.05001);
      assert(short.value.total>0);assert.equal(long.value.total,0);
      assert.notEqual(short.image,long.image,'Qualified shading must change with the hold setting');
      assert.deepEqual(short.value.rawIntervals,long.value.rawIntervals,'Filtering must preserve raw observations');
      // The earlier 1.4–1.6s interval closes at the confirmation endpoint.
      assert(!M.windows(p,r,DEFAULTS).intervals.some(w=>w.start===1.4));
    });

    await check('Coverage/all-defender scope changes actual participant counts and measurement values',async()=>{
      await setup();const p=source('2021110100_2120');
      for(const scope of ['coverage','all']){
        await page.locator('#roleScope').selectOption(scope);
        const expected=M.nearest(p,'44835',21,{...DEFAULTS,scope});
        const result=await page.evaluate(()=>({count:OpenFieldApp.metrics.defenders(OpenFieldApp.getPlay('a'),OpenFieldApp.state.metricOptions.scope).length,
          context:OpenFieldApp.getContext('a'),label:document.querySelector('[data-board="a"] .scope-label').textContent}));
        assert.equal(result.count,M.defenders(p,scope).length);assert.match(result.label,new RegExp(`^${result.count} `));
        if(scope==='all')assert.equal(result.count,11);
        close(result.context.distance,expected.distance);assert.equal(result.context.nearestId,expected.nearestId);
        close(numeric(await page.locator('[data-board="a"] .current-sep').textContent()),expected.distance,.05001);
      }
    });

    await check('Comparison preserves physical distance scale and aligns actual observed endpoints',async()=>{
      await setup({other:'2021110100_1396',otherReceiver:'43454',time:1});
      const scales=await page.evaluate(()=>Object.entries(OpenFieldApp.getBoards()).map(([key,b])=>({key,x:b.transform.X(1)-b.transform.X(0),y:Math.abs(b.transform.Y(1)-b.transform.Y(0)),duration:b.timelineTransform.duration,chart:document.querySelector(`[data-board="${key}"] .chart-scale`).textContent})));
      assert.equal(scales.length,2);close(scales[0].x,scales[0].y);close(scales[1].x,scales[1].y);close(scales[0].x,scales[1].x,.01);
      assert.equal(scales[0].duration,scales[1].duration);assert.equal(scales[0].chart,scales[1].chart);
      await page.locator('#alignment').selectOption('release');
      const alignment=await page.evaluate(()=>{
        const app=OpenFieldApp;app.seek(app.getDuration());
        return ['a','b'].map(key=>({key,end:app.getPlay(key).times.at(-1),time:app.getObservedTime(key),offset:app.getTimeOffset(key),clock:app.getSnapshot().t}));
      });
      alignment.forEach(row=>{close(row.time,row.end);close(row.clock+row.offset,row.end);});
      await page.locator('#alignment').selectOption('snap');
      const smaller=Math.min(...alignment.map(r=>r.end));await page.evaluate(t=>OpenFieldApp.seek(t+.2),smaller);
      const shortKey=alignment.find(r=>r.end===smaller).key;
      assert.match(await page.locator(`[data-board="${shortKey}"] .field-clock`).innerText(),/ended/i);
      close(await page.evaluate(key=>OpenFieldApp.getObservedTime(key),shortKey),smaller);
    });

    await check('Native evidence and full-precision exported rows retain the same current metric',async()=>{
      await setup();const expected=M.coverageLift(source('2021110100_2120'),'44835',21,DEFAULTS);
      const evidence=await nativeEvidence();assert.equal(evidence.width,2000);assert.equal(evidence.height,1500);assert(evidence.bytes>50000);
      const labels=evidence.labels.filter(l=>l.width===2000).map(l=>l.text);
      assert(labels.includes(`Coverage Lift ${signed(expected.coverage)} yd`));
      assert(labels.includes(`Receiver movement ${signed(expected.receiver)} yd · Net ${signed(expected.gain)} yd`));
      const row=await page.evaluate(()=>OpenFieldWorkspace.selectedRows().find(r=>r.receiverId==='44835'&&r.frame===21));
      assert(row);for(const key of ['coverage','receiver','gain'])close(row[key],expected[key]);
      assert.equal(row.scope,'coverage');close(row.lookback,.5);
    });

    await check('Blind mode restricts tables, events, diagnostics, export rows and future-derived controls',async()=>{
      await setup({time:1.7,ui:{blind:true},alignment:'release',other:'2021110100_1396',otherReceiver:'43454'});
      assert.equal(await page.evaluate(()=>OpenFieldApp.getSnapshot().alignment),'snap');
      assert(await page.locator('#jumpRelease').isDisabled());assert(await page.locator('#statsMode').isDisabled());
      assert(!(await page.locator('#storyBar').isVisible()));
      for(const value of ['release','firstWindow','firstDownfield'])assert(await page.locator(`#alignment option[value="${value}"]`).evaluate(option=>option.disabled));
      const rows=await page.evaluate(()=>OpenFieldWorkspace.selectedRows());
      assert(rows.length);assert(rows.every(r=>r.time<=1.7+1e-9),'CSV cannot reveal future frames');
      await page.locator('[data-tab="routes"]').click();
      const p=source('2021110100_2120'),expected=M.windows(p,'44835',{...DEFAULTS,throughTime:1.7});
      close(numeric(await page.locator('[data-board="a"] .total-window').textContent()),expected.total,.05001);
      const eventExpected=M.events(p,'44835',{...DEFAULTS,throughTime:1.7});
      assert.equal(await page.locator('#eventList [data-event]').count(),eventExpected.length);
      await page.locator('#analyzeSensitivity').evaluate(e=>{e.closest('details').open=true;});await page.locator('#analyzeSensitivity').click();
      await page.waitForSelector('#sensitivityResults .diagnostic-result');
      const sensitivity=M.sensitivity(p,'44835',17,{...DEFAULTS,throughTime:1.7});
      const actual=await page.locator('#sensitivityResults table').first().locator('tbody tr').evaluateAll(rows=>rows.map(r=>[...r.cells].map(c=>c.textContent)));
      actual.forEach((row,i)=>{assert.equal(numeric(row[1]),sensitivity.thresholds[i].eventCount);close(numeric(row[2]),sensitivity.thresholds[i].total,.05001);});
      const evidence=await nativeEvidence(),labels=evidence.labels.filter(l=>l.width===2000).map(l=>l.text);
      assert(!labels.some(l=>l.includes(`Aligned clock: 0 to ${Math.max(p.times.at(-1),source('2021110100_1396').times.at(-1)).toFixed(1)} s`)),'Blind export must not reveal the future endpoint on its axis');
    });

    await check('Blind field, timelines and route table are invariant to unseen future coordinates',async()=>{
      await setup({time:1.7,ui:{blind:true},layers:{trail:'whole'}});
      await page.locator('[data-tab="routes"]').click();
      const invariant=await page.evaluate(()=>{
        const app=OpenFieldApp,s=app.getSnapshot(),p=app.getPlay('a'),frame=app.getFrame('a');
        const original=p.players.map(e=>structuredClone(e.track));
        function capture(){return {field:app.getBoards().a.canvas.toDataURL(),timeline:app.getBoards().a.timeline.toDataURL(),routes:document.querySelector('#allRoutesTimeline').toDataURL(),table:document.querySelector('#allRoutesTable').innerText};}
        const before=capture();
        try {
          for(const entity of p.players)for(let i=frame+1;i<entity.track.length;i++){entity.track[i][0]+=15+(i%3);entity.track[i][1]-=10;}
          app.setSnapshot(s);const after=capture();return {same:Object.fromEntries(Object.keys(before).map(k=>[k,before[k]===after[k]]))};
        }finally{p.players.forEach((e,i)=>e.track=original[i]);app.setSnapshot(s);}
      });
      assert.deepEqual(invariant.same,{field:true,timeline:true,routes:true,table:true});
    });

    await check('Ordinary replay hides analytical numbers and exports no metric values',async()=>{
      await setup({ui:{baseline:true}});
      for(const selector of ['.coverage-lift','.receiver-lift','.net-lift','.metric-equation','.total-window','.nearest-context','.heat-key','.timeline']){
        assert(!(await page.locator(`[data-board="a"] ${selector}`).isVisible()),`${selector} must be hidden in ordinary replay`);
      }
      const evidence=await nativeEvidence();assert(!evidence.labels.some(l=>/Coverage Lift [+-]?\d|Receiver movement [+-]?\d|Signed contribution ±\d/.test(l.text)));
      assert(evidence.labels.some(l=>/Ordinary replay/.test(l.text)));
    });

    await check('Frame, receiver and scope changes invalidate computed diagnostics',async()=>{
      await setup();await page.locator('[data-tab="routes"]').click();
      for(const change of ['frame','receiver','scope']){
        await page.locator('#analyzeContributions').evaluate(e=>{e.closest('details').open=true;});await page.locator('#analyzeContributions').click();
        await page.waitForSelector('#contributionResults .diagnostic-result');
        if(change==='frame')await page.evaluate(()=>OpenFieldApp.seek(2.2));
        if(change==='receiver')await page.evaluate(()=>OpenFieldApp.chooseReceiver('a',OpenFieldApp.getPlay('a').players.find(p=>p.role==='route'&&p.id!==OpenFieldApp.state.receivers.a).id));
        if(change==='scope')await page.locator('#roleScope').selectOption('all');
        assert.equal(await page.locator('#contributionResults .diagnostic-result').count(),0,`Stale diagnostic survived ${change} change`);
      }
    });

    await check('No unexpected script failures or external runtime requests',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);});
  } finally {await browser.close();}
  const result={status:failures.length?'failed':'passed',browser:firefox?'firefox':'chromium',checks,failures};
  fs.writeFileSync(path.join(QA,`analytical-${result.browser}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
