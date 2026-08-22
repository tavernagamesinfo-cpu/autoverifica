const express = require('express');
const crypto = require('crypto');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const URLS = {
  revisions: 'https://www.ilportaledellautomobilista.it/web/portale-automobilista/verifica-revisioni-effettuate-x2345nmnmll',
  rca: 'https://www.ilportaledellautomobilista.it/web/portale-automobilista/ext/verifica-copertura-rc',
  environment: 'https://www.ilportaledellautomobilista.it/web/portale-automobilista/ext/verifica-classe-ambientale-veicolo',
  novice: 'https://www.ilportaledellautomobilista.it/web/portale-automobilista/ext/neopatentati'
};
const sessions = new Map();
let browserPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public-v4'), { extensions: ['html'] }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanPlate = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.context.close(); } catch {}
}

async function snapshot(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const controls = [...document.querySelectorAll('select,input,button,a,img')].filter(visible).map(el => ({
      tag: el.tagName.toLowerCase(), id: el.id || '', name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '', value: 'value' in el ? String(el.value || '').slice(0,100) : '',
      placeholder: el.getAttribute('placeholder') || '', alt: el.getAttribute('alt') || '',
      title: el.getAttribute('title') || '', text: (el.innerText || el.value || el.alt || '').trim().slice(0,140),
      cls: typeof el.className === 'string' ? el.className.slice(0,100) : '',
      src: el.tagName === 'IMG' ? (el.getAttribute('src') || '').slice(0,140) : ''
    }));
    return { url: location.href, controls, text: (document.body.innerText || '').replace(/\u00a0/g,' ').slice(0,5000) };
  });
}

async function openOfficial(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1400);
}

async function chooseAutoveicolo(page) {
  const selected = await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    for (const s of [...document.querySelectorAll('select')].filter(visible)) {
      const opt = [...s.options].find(o => /autoveicolo/i.test(o.textContent || ''));
      if (opt) {
        s.value = opt.value;
        s.dispatchEvent(new Event('input',{bubbles:true}));
        s.dispatchEvent(new Event('change',{bubbles:true}));
        return { ok:true, mode:'select', value:opt.value };
      }
    }
    const candidates = [...document.querySelectorAll('button,a,label,li,input[type=button],input[type=submit],input[type=radio]')]
      .filter(visible)
      .map(el => ({ el, text:(el.innerText||el.value||el.title||el.getAttribute('aria-label')||'').trim() }))
      .filter(x => /^autoveicolo$/i.test(x.text) || /\bautoveicolo\b/i.test(x.text));
    if (!candidates.length) return { ok:false };
    const x = candidates[0].el;
    x.setAttribute('data-av-autoveicolo','1');
    return { ok:true, mode:'click' };
  });
  if (selected.ok && selected.mode === 'click') {
    const nav = page.waitForNavigation({waitUntil:'domcontentloaded',timeout:7000}).catch(()=>null);
    await page.click('[data-av-autoveicolo="1"]').catch(()=>{});
    await nav;
    await sleep(700);
  }
  return selected.ok;
}

async function fillField(page, kind, value) {
  const result = await page.evaluate(({kind,value}) => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const inputs=[...document.querySelectorAll('input')].filter(visible).filter(el=>!['hidden','submit','button','image','reset','radio','checkbox'].includes((el.type||'').toLowerCase()));
    const blob = el => {
      const label=el.id?document.querySelector(`label[for="${CSS.escape(el.id)}"]`):null;
      const parent=el.parentElement?.innerText||'';
      return [el.id,el.name,el.placeholder,el.getAttribute('aria-label'),label?.innerText,parent].join(' ').toLowerCase();
    };
    const score = el => {
      const b=blob(el); let n=0;
      if(kind==='plate'){if(/targa/.test(b))n+=300;if(/captcha|caratteri|identificare/.test(b))n-=500;}
      if(kind==='captcha'){if(/captcha|caratteri|identificare/.test(b))n+=300;if(/targa/.test(b))n-=500;}
      if((el.type||'text').toLowerCase()==='text')n+=5;
      return n;
    };
    const ranked=inputs.map(el=>({el,n:score(el),b:blob(el)})).sort((a,b)=>b.n-a.n);
    const x=ranked[0];
    if(!x || x.n<0) return {ok:false,candidates:ranked.map(r=>({n:r.n,b:r.b,value:r.el.value}))};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(setter)setter.call(x.el,value);else x.el.value=value;
    x.el.dispatchEvent(new Event('input',{bubbles:true}));
    x.el.dispatchEvent(new Event('change',{bubbles:true}));
    x.el.dispatchEvent(new Event('blur',{bubbles:true}));
    x.el.setAttribute(`data-av-${kind}`,'1');
    return {ok:true,score:x.n,blob:x.b};
  }, {kind,value});
  if(!result.ok) throw new Error(kind==='plate'?'Campo targa non trovato.':'Campo CAPTCHA non trovato.');
  return result;
}

async function captchaImage(page) {
  const found = await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const imgs=[...document.querySelectorAll('img')].filter(visible);
    const score=el=>{
      const r=el.getBoundingClientRect();
      const blob=[el.alt,el.title,el.id,typeof el.className==='string'?el.className:'',el.getAttribute('src')].join(' ').toLowerCase();
      let n=0;
      if(/captcha|testo da identificare|caratteri/.test(blob))n+=500;
      if(/logo|facebook|minister|portale/.test(blob))n-=500;
      if(r.width>=80&&r.width<=650&&r.height>=20&&r.height<=220)n+=20;
      return n;
    };
    const ranked=imgs.map(el=>({el,n:score(el)})).sort((a,b)=>b.n-a.n);
    const x=ranked[0];
    if(!x || x.n<100) return null;
    x.el.setAttribute('data-av-captcha-image','1');
    return {src:x.el.getAttribute('src')||x.el.src||'',alt:x.el.alt||'',title:x.el.title||''};
  });
  if(!found) return null;
  if(found.src.startsWith('data:image/')){
    const m=found.src.match(/^data:image\/[^;]+;base64,(.+)$/);if(m)return Buffer.from(m[1],'base64');
  }
  const h=await page.$('[data-av-captcha-image="1"]');
  return h ? h.screenshot({type:'png'}) : null;
}

async function submit(page) {
  const marked=await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const plate=document.querySelector('[data-av-plate="1"]');
    const form=plate?.closest('form')||document;
    let els=[...form.querySelectorAll('button,input[type=submit],input[type=button],input[type=image]')].filter(visible);
    if(!els.length)els=[...document.querySelectorAll('button,input[type=submit],input[type=button],input[type=image]')].filter(visible);
    const ranked=els.map(el=>{
      const t=(el.innerText||el.value||el.alt||el.title||'').trim();
      let n=0;
      if(/verifica|cerca|ricerca|invia|conferma|continua|valida/i.test(t))n+=200;
      if(/svuota|reset|cambia|annulla/i.test(t))n-=500;
      if((el.type||'').toLowerCase()==='submit')n+=40;
      return {el,t,n};
    }).sort((a,b)=>b.n-a.n);
    const x=ranked[0];
    if(!x||x.n<0)return {ok:false,buttons:ranked.map(r=>({t:r.t,n:r.n}))};
    x.el.setAttribute('data-av-submit','1');return {ok:true,t:x.t,n:x.n};
  });
  if(!marked.ok)throw new Error('Pulsante di ricerca non trovato.');
  const nav=page.waitForNavigation({waitUntil:'domcontentloaded',timeout:12000}).catch(()=>null);
  await page.click('[data-av-submit="1"]');
  await nav;
  await page.waitForNetworkIdle({idleTime:500,timeout:8000}).catch(()=>{});
  await sleep(700);
  return marked;
}

function normalizeDate(s){const m=String(s).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);if(!m)return null;const d=m[1].padStart(2,'0'),mo=m[2].padStart(2,'0'),y=m[3];return{display:`${d}/${mo}/${y}`,iso:`${y}-${mo}-${d}`};}
function num(s){const x=String(s||'').replace(/[^0-9]/g,'');if(!x)return null;const n=Number(x);return Number.isFinite(n)?n:null;}

async function pageData(page){
  return page.evaluate(()=>({
    text:(document.body.innerText||'').replace(/\u00a0/g,' ').slice(0,18000),
    alerts:[...document.querySelectorAll('.alert,[class*="message"],[class*="result"],[class*="esito"],.portlet-msg-info,.portlet-msg-error,.portlet-msg-success')]
      .map(x=>(x.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,30),
    tables:[...document.querySelectorAll('table')].map(t=>({
      headers:[...t.querySelectorAll('thead th,tr:first-child th')].map(x=>(x.innerText||'').replace(/\s+/g,' ').trim()),
      rows:[...t.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\s+/g,' ').trim())).filter(r=>r.length)
    }))
  }));
}

function captchaRejected(text){return /captcha|caratteri/i.test(text||'')&&/errat|non valid|sbagli|riprova|non corret/i.test(text||'');}
function dataUrl(buf){return 'data:image/png;base64,'+Buffer.from(buf).toString('base64');}

async function extractRevisions(page){
  const data=await pageData(page);const out=[];
  for(const table of data.tables){
    const hs=table.headers.map(x=>x.toLowerCase());
    let di=hs.findIndex(x=>/data|revisione/.test(x));
    let ki=hs.findIndex(x=>/km|chilometr/.test(x));
    let oi=hs.findIndex(x=>/esito|risultato/.test(x));
    let pi=hs.findIndex(x=>/targa/.test(x));
    for(const cells of table.rows){
      let dt=di>=0?normalizeDate(cells[di]):null;if(!dt){const c=cells.find(x=>normalizeDate(x));dt=c?normalizeDate(c):null;}if(!dt)continue;
      let km=ki>=0?num(cells[ki]):null;
      if(km==null){const c=cells.map(num).filter(n=>n!=null&&n>=100&&n<2000000&&(n<1900||n>2100));km=c.length?c[c.length-1]:null;}
      if(km==null)continue;
      const outcome=oi>=0?(cells[oi]||'registrata'):(cells.find(x=>/regolare|positivo|ripetere|sospes|negativ/i.test(x))||'registrata');
      const plateAtRevision=pi>=0?(cells[pi]||''):'';
      if(!out.some(r=>r.isoDate===dt.iso&&r.km===km))out.push({date:dt.display,isoDate:dt.iso,km,outcome:String(outcome).toLowerCase(),plateAtRevision:String(plateAtRevision).toUpperCase()});
    }
  }
  out.sort((a,b)=>a.isoDate.localeCompare(b.isoDate));
  return {revisions:out,rawText:data.text};
}

async function extractRca(page, plate){
  const data=await pageData(page);
  const compact=[...data.alerts,...data.tables.flatMap(t=>t.rows.map(r=>r.join(' | ')))].join('\n');
  const resultText=(compact||data.text).replace(/\s+/g,' ').trim();
  let status='unknown';
  if(/non\s+(?:risulta\s+)?assicur|non\s+(?:è|e')\s+in\s+regola|privo\s+di\s+copertura|scopert[oa]/i.test(compact))status='not_insured';
  else if(/risulta\s+assicur|copertura\s+(?:rca\s+)?(?:attiva|valida|regolare)|(?:è|e')\s+in\s+regola/i.test(compact))status='insured';
  const expiry=(resultText.match(/(?:scadenza|valida\s+fino\s+al)[^0-9]{0,20}(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i)||[])[1]||null;
  const company=(resultText.match(/(?:compagnia|impresa|assicurazione)\s*[:\-]?\s*([^|\n]{3,80})/i)||[])[1]?.trim()||null;
  return {status,expiry,company,plate,raw:resultText.slice(0,1200)};
}

async function extractEnvironment(page){
  const data=await pageData(page);const text=[...data.alerts,...data.tables.flatMap(t=>t.rows.map(r=>r.join(' | '))),data.text].join('\n');
  if(/temporaneamente\s+non\s+disponibile/i.test(text))return {status:'unavailable',euro:null,co2:null};
  const euro=(text.match(/\b(EURO\s*(?:[0-9]+|[IVX]+)(?:\s*[A-Z0-9\-./]+)?)/i)||[])[1]?.replace(/\s+/g,' ').trim()||null;
  const co2m=text.match(/(?:CO\s*2|CO₂|emissione[^\n]{0,25}CO\s*2)[^0-9]{0,30}(\d{1,3}(?:[.,]\d+)?)\s*(?:g\/?km)?/i);
  const co2=co2m?Number(co2m[1].replace(',','.')):null;
  return {status:(euro||co2!=null)?'ok':'unknown',euro,co2,raw:text.replace(/\s+/g,' ').slice(0,1200)};
}

async function extractNovice(page){
  const data=await pageData(page);const compact=[...data.alerts,...data.tables.flatMap(t=>t.rows.map(r=>r.join(' | ')))].join('\n');const text=(compact||data.text).replace(/\s+/g,' ').trim();
  let allowed=null;
  if(/non\s+(?:pu[oò]|e')\s+essere\s+guidat|non\s+consentit|non\s+autorizzat|supera\s+i\s+limiti/i.test(compact))allowed=false;
  else if(/pu[oò]\s+essere\s+guidat|consentit[oa]\s+ai\s+neopatentat|autorizzat[oa]\s+alla\s+guida|rientra\s+nei\s+limiti/i.test(compact))allowed=true;
  return {status:allowed===null?'unknown':'ok',allowed,raw:text.slice(0,1000)};
}

async function prepareModule(s, module){
  await openOfficial(s.page, URLS[module]);
  if(module==='revisions'||module==='environment'||module==='rca')await chooseAutoveicolo(s.page).catch(()=>false);
  await fillField(s.page,'plate',s.plate);
  await sleep(350);
  const img=await captchaImage(s.page);
  s.stage=module;
  if(img)return {challenge:{type:module,captchaImage:dataUrl(img)}};
  await submit(s.page);
  const snap=await snapshot(s.page);
  if(module==='rca')s.data.rca=await extractRca(s.page,s.plate);
  if(module==='environment')s.data.environment=await extractEnvironment(s.page);
  if(module==='novice')s.data.novice=await extractNovice(s.page);
  console.log('AUTO_MODULE_RESULT',module,JSON.stringify(s.data[module==='novice'?'novice':module]||{}),snap.url);
  return {challenge:null};
}

async function solveCurrentCaptcha(s, captcha){
  await fillField(s.page,'captcha',captcha);
  await submit(s.page);
  const snap=await snapshot(s.page);
  if(captchaRejected(snap.text))return {captchaRejected:true};
  if(s.stage==='revisions')s.data.revisions=(await extractRevisions(s.page)).revisions;
  if(s.stage==='rca')s.data.rca=await extractRca(s.page,s.plate);
  if(s.stage==='environment')s.data.environment=await extractEnvironment(s.page);
  return {captchaRejected:false};
}

async function advanceExtras(s){
  const order=['rca','environment','novice'];
  let start=0;
  if(s.stage==='revisions')start=0;
  else {const i=order.indexOf(s.stage);start=i<0?0:i+1;}
  for(let i=start;i<order.length;i++){
    const module=order[i];
    try{
      const p=await prepareModule(s,module);
      if(p.challenge)return p;
    }catch(e){
      console.error('OPTIONAL_MODULE_ERROR',module,e.stack||e);
      const key=module==='novice'?'novice':module;
      s.data[key]={status:'unavailable',reason:e.message};
      s.stage=module;
    }
  }
  return {done:true};
}

function publicData(s){return {plate:s.plate,revisions:s.data.revisions||[],rca:s.data.rca||null,environment:s.data.environment||null,novice:s.data.novice||null};}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'AutoVerifica',version:'4.0-test'}));
app.get('/api/browser-health',async(req,res)=>{try{const b=await getBrowser();res.json({ok:!!b.connected});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.get('/api/debug/module/:name',async(req,res)=>{
  const name=req.params.name;if(!URLS[name])return res.status(404).json({error:'Modulo sconosciuto'});
  let context;
  try{
    const browser=await getBrowser();context=await browser.createBrowserContext();const page=await context.newPage();
    await page.setViewport({width:1200,height:1000});await openOfficial(page,URLS[name]);
    if(['revisions','environment','rca'].includes(name))await chooseAutoveicolo(page).catch(()=>false);
    await fillField(page,'plate',cleanPlate(req.query.plate||'AB123CD')).catch(()=>{});await sleep(300);
    const snap=await snapshot(page);res.json(snap);
  }catch(e){res.status(500).json({error:e.message});}
  finally{if(context)try{await context.close()}catch{}}
});

app.post('/api/analysis/start',async(req,res)=>{
  const plate=cleanPlate(req.body?.plate);if(plate.length<5)return res.status(400).json({error:'Targa non valida.'});
  let context;
  try{
    const browser=await getBrowser();context=await browser.createBrowserContext();const page=await context.newPage();
    await page.setViewport({width:1200,height:1000,deviceScaleFactor:1});
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36');
    const id=crypto.randomUUID();const s={id,context,page,plate,created:Date.now(),stage:'revisions',data:{revisions:[],rca:null,environment:null,novice:null}};sessions.set(id,s);
    const p=await prepareModule(s,'revisions');
    if(!p.challenge)throw new Error('Il Portale non ha richiesto il CAPTCHA revisioni previsto.');
    res.json({sessionId:id,plate,data:publicData(s),challenge:p.challenge});
  }catch(e){console.error('ANALYSIS_START_ERROR',e.stack||e);if(context)try{await context.close()}catch{};res.status(502).json({error:'Impossibile avviare il controllo: '+e.message});}
});

app.post('/api/analysis/continue',async(req,res)=>{
  const id=String(req.body?.sessionId||''),captcha=String(req.body?.captcha||'').trim(),s=sessions.get(id);
  if(!s)return res.status(410).json({error:'Sessione scaduta. Riparti dalla targa.'});
  if(captcha.length<3)return res.status(400).json({error:'Inserisci il CAPTCHA.'});
  try{
    const solved=await solveCurrentCaptcha(s,captcha);
    if(solved.captchaRejected){const img=await captchaImage(s.page);return res.json({sessionId:id,data:publicData(s),captchaRejected:true,challenge:{type:s.stage,captchaImage:img?dataUrl(img):null}});}
    if(s.stage==='revisions'&&(!s.data.revisions||!Array.isArray(s.data.revisions)))throw new Error('Storico revisioni non leggibile.');
    const next=await advanceExtras(s);
    if(next.challenge)return res.json({sessionId:id,data:publicData(s),challenge:next.challenge});
    const data=publicData(s);await closeSession(id);res.json({done:true,data});
  }catch(e){console.error('ANALYSIS_CONTINUE_ERROR',s.stage,e.stack||e);res.status(502).json({error:'Controllo non completato: '+e.message});}
});

app.post('/api/analysis/skip',async(req,res)=>{
  const id=String(req.body?.sessionId||''),s=sessions.get(id);if(!s)return res.status(410).json({error:'Sessione scaduta.'});
  if(s.stage==='revisions')return res.status(400).json({error:'Lo storico revisioni è il controllo principale e non può essere saltato.'});
  const key=s.stage==='novice'?'novice':s.stage;s.data[key]={status:'skipped'};
  try{
    const next=await advanceExtras(s);
    if(next.challenge)return res.json({sessionId:id,data:publicData(s),challenge:next.challenge});
    const data=publicData(s);await closeSession(id);res.json({done:true,data});
  }catch(e){res.status(502).json({error:e.message});}
});

app.delete('/api/analysis/:id',async(req,res)=>{await closeSession(req.params.id);res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public-v4','index.html')));

setInterval(()=>{const now=Date.now();for(const [id,s] of sessions)if(now-s.created>8*60*1000)closeSession(id);},60000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`AutoVerifica v4 listening on ${PORT}`));
process.on('SIGTERM',async()=>{try{if(browserPromise)(await browserPromise).close()}catch{}finally{process.exit(0)}});
