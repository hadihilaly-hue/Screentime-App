import { chromium } from 'playwright'
import http from 'node:http'
const S='/tmp/claude-0/-home-user-Screentime-App/7618e8e6-de32-5ec8-8c56-e6303e5084d9/scratchpad'
let sessions=[], sessionsFail=false, reqLog=[]
const supa=http.createServer((req,res)=>{reqLog.push([Date.now(),req.url])
  const send=(c,o)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(o))}
  if(req.url.startsWith('/auth/v1/token'))return send(200,{access_token:'tok',refresh_token:'rt',expires_in:3600,user:{email:'x@y.z',id:'u1'}})
  if(req.url.startsWith('/rest/v1/sessions'))return sessionsFail?send(500,{msg:'boom'}):send(200,sessions)
  if(req.url.startsWith('/rest/v1/balances'))return send(200,[{minutes_available:25}])
  send(404,{})})
await new Promise(r=>supa.listen(8098,'127.0.0.1',r))
const site=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<h1>REAL SITE</h1>')})
await new Promise(r=>site.listen(8099,'127.0.0.1',r))
const EXT=S+'/ext'
const ctx=await chromium.launchPersistentContext(S+'/prof5',{headless:true,executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-sandbox','--host-resolver-rules=MAP snapchat.com 127.0.0.1:8099']})
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker',{timeout:20000})
const extId=new URL(sw.url()).host
await new Promise(r=>setTimeout(r,2000))
await sw.evaluate(()=>chrome.storage.local.set({et_session:{access_token:'tok',refresh_token:'rt',expires_at:Date.now()+3600000,email:'x@y.z',user_id:'u1'}}))
const helper=await ctx.newPage(); await helper.goto(`chrome-extension://${extId}/popup.html`)
const forceSync=()=>helper.evaluate(()=>chrome.runtime.sendMessage({type:'sync'}))
await forceSync()
const T='http://snapchat.com/watch?v=abc'
const page=await ctx.newPage()
const errs=[]; page.on('pageerror',e=>errs.push('pageerror: '+e.message)); page.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())})

// --- A: button while Supabase is erroring ---
await page.goto(T,{waitUntil:'domcontentloaded'}).catch(()=>{})
await new Promise(r=>setTimeout(r,800))
sessionsFail=true
await page.click('#retry'); await new Promise(r=>setTimeout(r,1500))
console.log('[A] Supabase 500, click button -> note:',JSON.stringify(await page.locator('#note').textContent()))
console.log('    balance shows:',JSON.stringify(await page.locator('#balance').textContent()))

// --- B: button while signed out ---
sessionsFail=false
await sw.evaluate(()=>chrome.storage.local.remove('et_session'))
await page.reload({waitUntil:'domcontentloaded'}); await new Promise(r=>setTimeout(r,800))
await page.click('#retry'); await new Promise(r=>setTimeout(r,1500))
console.log('[B] signed out, click button -> note:',JSON.stringify(await page.locator('#note').textContent()))

// --- C: sendMessage rejects (worker unreachable) ---
await sw.evaluate(()=>chrome.storage.local.set({et_session:{access_token:'tok',refresh_token:'rt',expires_at:Date.now()+3600000,email:'x@y.z',user_id:'u1'}}))
sessions=[{app_name:'Snapchat',minutes:5,started_at:new Date().toISOString()}]
const p2=await ctx.newPage()
await p2.addInitScript(()=>{ const o=chrome.runtime.sendMessage.bind(chrome.runtime)
  chrome.runtime.sendMessage=(...a)=>Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) })
const e2=[]; p2.on('pageerror',e=>e2.push(e.message))
await p2.goto(`chrome-extension://${extId}/blocked.html?site=snapchat.com#from=${T}`,{waitUntil:'domcontentloaded'})
await new Promise(r=>setTimeout(r,600))
await p2.click('#retry'); await new Promise(r=>setTimeout(r,2500))
console.log('[C] sendMessage rejects, click button -> note:',JSON.stringify(await p2.locator('#note').textContent()))
console.log('    balance:',JSON.stringify(await p2.locator('#balance').textContent()),' url:',p2.url().slice(0,60))
console.log('    page errors:',JSON.stringify(e2.slice(0,3)))

// --- D: transient Supabase error during a live session ---
await page.goto(T,{waitUntil:'domcontentloaded'}).catch(()=>{})
await new Promise(r=>setTimeout(r,7000))
console.log('[D] with live session, page is at:',page.url().startsWith('http://snapchat')?'REAL SITE':'block page')
sessionsFail=true                       // one blip
await forceSync()
await new Promise(r=>setTimeout(r,1500))
console.log('    after ONE failed poll mid-session, tab is at:',page.url().startsWith('http://snapchat')?'REAL SITE':'BLOCK PAGE (evicted)')
sessionsFail=false

// --- E: request rate from an idle block page ---
const p3=await ctx.newPage()
await p3.goto(`chrome-extension://${extId}/blocked.html?site=instagram.com`,{waitUntil:'domcontentloaded'})
reqLog=[]; await new Promise(r=>setTimeout(r,20000))
console.log('[E] requests to Supabase in 20s with one idle block page open:',reqLog.length, reqLog.map(r=>r[1].split('?')[0]).join(' '))
await ctx.close(); supa.close(); site.close()
