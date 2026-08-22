const express = require('express');
const crypto = require('crypto');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PORTAL = 'https://www.ilportaledellautomobilista.it/interrogazionistoricorevisioni/spa/';
const sessions = new Map();
let browserPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function cleanPlate(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-zygote', '--disable-features=site-per-process'
      ]
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

async function visibleFormSnapshot(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll('input,select,button,img,canvas')].filter(visible).map((el, i) => ({
      i, tag: el.tagName.toLowerCase(), id: el.id || '', name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '', placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '', text: (el.innerText || el.alt || '').trim().slice(0,120),
      src: el.tagName === 'IMG' ? (el.getAttribute('src') || '').slice(0,200) : ''
    }));
  });
}

async function fillPlate(page, plate) {
  const ok = await page.evaluate(value => {
    const visible = el => { const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    const score = el => {
      const blob=[el.id,el.name,el.placeholder,el.getAttribute('aria-label')].join(' ').toLowerCase();
      let n=0; if(blob.includes('targa')) n+=100; if(blob.includes('captcha')) n-=200; if((el.type||'').toLowerCase()==='text') n+=5; return n;
    };
    const el=inputs.sort((a,b)=>score(b)-score(a))[0]; if(!el || score(el)<0) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;
  }, plate);
  if (!ok) throw new Error('Campo targa non trovato sul Portale.');
}

async function setVehicleType(page) {
  await page.evaluate(() => {
    const selects=[...document.querySelectorAll('select')];
    for(const s of selects){
      const opt=[...s.options].find(o=>/autoveicolo/i.test(o.textContent||''));
      if(opt){s.value=opt.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;}
    }
    return false;
  }).catch(()=>false);
}

async function findCaptchaInput(page) {
  const handles = await page.$$('input');
  let fallback = null;
  for (const h of handles) {
    const meta = await h.evaluate(el => {
      const s=getComputedStyle(el),r=el.getBoundingClientRect();
      return {visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,
        blob:[el.id,el.name,el.placeholder,el.getAttribute('aria-label')].join(' ').toLowerCase()};
    }).catch(()=>({visible:false,blob:''}));
    if (!meta.visible) continue;
    if (meta.blob.includes('captcha')) return h;
    if (!meta.blob.includes('targa') && !fallback) fallback = h;
  }
  return fallback;
}

async function clickButton(page, regex) {
  const buttons = await page.$$('button,input[type=button],input[type=submit],a');
  for (const h of buttons) {
    const t = await h.evaluate(el => ((el.innerText||el.value||el.getAttribute('aria-label')||'').trim())).catch(()=> '');
    if (regex.test(t)) { try { await h.click(); return true; } catch {} }
  }
  return false;
}

async function captchaScreenshot(page) {
  await sleep(700);
  const candidates = await page.$$('img,canvas');
  for (const h of candidates) {
    const m = await h.evaluate(el => {
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      const blob=[el.id,el.className,el.getAttribute('alt'),el.getAttribute('src')].join(' ').toLowerCase();
      return {visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>=80&&r.height>=25,w:r.width,h:r.height,blob};
    }).catch(()=>({visible:false,blob:''}));
    if (m.visible && (m.blob.includes('captcha') || (m.w>=100 && m.w<=600 && m.h<=220))) {
      try { return await h.screenshot({ type:'png' }); } catch {}
    }
  }
  const input = await findCaptchaInput(page);
  if (input) {
    const b = await input.boundingBox();
    if (b) {
      const vp = page.viewport(); const y=Math.max(0,b.y-220); const h=Math.min(360,(vp?.height||900)-y);
      return page.screenshot({type:'png',clip:{x:0,y,width:vp?.width||900,height:h}});
    }
  }
  return page.screenshot({type:'png',fullPage:false});
}

function dataUrl(buf) { return 'data:image/png;base64,' + Buffer.from(buf).toString('base64'); }
function normalizeDate(s) {
  const m=String(s).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/); if(!m) return null;
  const d=m[1].padStart(2,'0'),mo=m[2].padStart(2,'0'),y=m[3]; return {display:`${d}/${mo}/${y}`,iso:`${y}-${mo}-${d}`};
}
function numberFromToken(s){const x=String(s).replace(/[^0-9]/g,'');if(!x)return null;const n=Number(x);return Number.isFinite(n)?n:null;}
function parseRevisionLines(lines){
  const out=[];
  for(const line of lines){
    const text=String(line||'').replace(/\s+/g,' ').trim(); const dt=normalizeDate(text); if(!dt) continue;
    let km=null;
    const kmMatch=text.match(/(?:km|chilometri|contachilometri)[^0-9]{0,25}([0-9][0-9.\s]{1,12})/i)||text.match(/([0-9][0-9.\s]{2,12})\s*(?:km|chilometri)/i);
    if(kmMatch) km=numberFromToken(kmMatch[1]);
    if(km==null){const nums=[...text.matchAll(/\b([0-9]{1,3}(?:[.\s][0-9]{3})+|[0-9]{4,7})\b/g)].map(m=>numberFromToken(m[1])).filter(n=>n!=null&&n<2000000&&(n<1900||n>2100));if(nums.length)km=nums[nums.length-1];}
    if(km==null) continue;
    let outcome='registrata'; if(/regolare|positivo|ok/i.test(text))outcome='regolare';else if(/ripetere|sospeso|negativo/i.test(text))outcome='da verificare';
    if(!out.some(r=>r.isoDate===dt.iso&&r.km===km))out.push({date:dt.display,isoDate:dt.iso,km,outcome,sourceLine:text});
  }
  return out.sort((a,b)=>a.isoDate.localeCompare(b.isoDate));
}
async function extractResult(page){
  await sleep(1200);
  const bodyText=await page.evaluate(()=>document.body.innerText.replace(/\u00a0/g,' '));
  const lines=bodyText.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const tableLines=await page.evaluate(()=>[...document.querySelectorAll('table tr')].map(tr=>(tr.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean));
  let revisions=parseRevisionLines(tableLines); if(!revisions.length)revisions=parseRevisionLines(lines);
  return {revisions,rawText:bodyText.slice(0,18000)};
}
function looksCaptchaRejected(text){return /captcha.{0,50}(errat|non valid|sbagli)|codice.{0,35}(errat|non valid)/i.test(text||'');}

app.get('/api/health', async (req,res) => {
  res.json({ok:true,service:'AutoVerifica',runtime:'node-puppeteer'});
});

app.get('/api/browser-health', async (req,res) => {
  try { const b=await getBrowser(); res.json({ok:!!b.connected}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/check/start', async (req,res) => {
  const plate=cleanPlate(req.body?.plate); if(plate.length<5)return res.status(400).json({error:'Targa non valida.'});
  let context;
  try{
    const browser=await getBrowser(); context=await browser.createBrowserContext(); const page=await context.newPage();
    await page.setViewport({width:900,height:920,deviceScaleFactor:1});
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36');
    await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});
    await sleep(1800); await setVehicleType(page); await fillPlate(page,plate); await sleep(500);
    const img=await captchaScreenshot(page); const id=crypto.randomUUID(); sessions.set(id,{context,page,plate,created:Date.now()});
    res.json({sessionId:id,plate,captchaImage:dataUrl(img)});
  }catch(e){if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}
});

app.post('/api/check/solve', async (req,res) => {
  const id=String(req.body?.sessionId||''),code=String(req.body?.captcha||'').trim(),s=sessions.get(id);
  if(!s)return res.status(410).json({error:'Sessione scaduta. Inserisci di nuovo la targa.'});
  if(code.length<3)return res.status(400).json({error:'Inserisci il CAPTCHA.'});
  try{
    const input=await findCaptchaInput(s.page); if(!input)throw new Error('Campo CAPTCHA non trovato sul Portale.');
    await input.click({clickCount:3}); await input.type(code,{delay:25});
    const validated=await clickButton(s.page,/^valida$|valida captcha/i); if(!validated)await sleep(400);
    await sleep(1100); let text=await s.page.evaluate(()=>document.body.innerText);
    if(looksCaptchaRejected(text))return res.json({captchaRejected:true});
    const searched=await clickButton(s.page,/avvia ricerca|cerca|ricerca/i);
    if(!searched){ if(looksCaptchaRejected(text))return res.json({captchaRejected:true}); throw new Error('Il Portale non ha abilitato la ricerca dopo il CAPTCHA.'); }
    await sleep(2200); const result=await extractResult(s.page); const plate=s.plate; await closeSession(id); res.json({plate,...result});
  }catch(e){res.status(502).json({error:'La verifica non è stata completata: '+e.message});}
});

app.delete('/api/check/session/:id',async(req,res)=>{await closeSession(req.params.id);res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

setInterval(()=>{const now=Date.now();for(const [id,s] of sessions)if(now-s.created>5*60*1000)closeSession(id);},60000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`AutoVerifica listening on ${PORT}`));
process.on('SIGTERM',async()=>{try{if(browserPromise)(await browserPromise).close()}catch{}finally{process.exit(0)}});
