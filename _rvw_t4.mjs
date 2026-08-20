import { chromium } from 'playwright'
import http from 'node:http'
const S='/tmp/claude-0/-home-user-Screentime-App/7618e8e6-de32-5ec8-8c56-e6303e5084d9/scratchpad'

// ---- state controllable by the test ----
let sessions = []            // rows returned for the sessions query
let sessionsFail = false     // make the sessions query 500
let reqLog = []

const supa = http.createServer((req,res)=>{
  reqLog.push(req.url)
  const send=(code,obj)=>{res.writeHead(code,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify(obj))}
  if (req.url.startsWith('/auth/v1/token')) return send(200,{access_token:'tok',refresh_token:'rt',expires_in:3600,user:{email:'x@y.z',id:'uid-1'}})
  if (req.url.startsWith('/rest/v1/sessions')) return sessionsFail ? send(500,{msg:'boom'}) : send(200,sessions)
  if (req.url.startsWith('/rest/v1/balances')) return send(200,[{minutes_available:25}])
  send(404,{})
})
await new Promise(r=>supa.listen(8098,'127.0.0.1',r))

const site = http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<h1 id=real>REAL SITE</h1>')})
await new Promise(r=>site.listen(8099,'127.0.0.1',r))

const EXT=S+'/ext'
const ctx = await chromium.launchPersistentContext(S+'/prof4',{
  headless:true, executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-sandbox',
        '--host-resolver-rules=MAP snapchat.com 127.0.0.1:8099, MAP www.snapchat.com 127.0.0.1:8099'],
})
let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker',{timeout:20000})
const extId=new URL(sw.url()).host
await new Promise(r=>setTimeout(r,2000))

// sign the extension in
await sw.evaluate(()=>chrome.storage.local.set({et_session:{access_token:'tok',refresh_token:'rt',expires_at:Date.now()+3600000,email:'x@y.z',user_id:'uid-1'}}))
const helper = await ctx.newPage(); await helper.goto(`chrome-extension://${extId}/popup.html`)
const forceSync = () => helper.evaluate(()=>chrome.runtime.sendMessage({type:'sync'}))
console.log('forceSync ->', JSON.stringify(await forceSync()))
console.log('rules while blocked:',(await sw.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())).length)

const page=await ctx.newPage()
const nav=[]
page.on('framenavigated',f=>{if(f===page.mainFrame())nav.push(f.url())})
const TARGET='http://snapchat.com/watch?v=abc&t=42'
await page.goto(TARGET,{waitUntil:'domcontentloaded'}).catch(e=>console.log('goto err',e.message.split('\n')[0]))
await new Promise(r=>setTimeout(r,1200))
console.log('\n[1] blocked, no session -> landed:',page.url())
console.log('    note text:',await page.locator('#note').textContent())
console.log('    balance  :',await page.locator('#balance').textContent())

// ---- now "start a session" in the app ----
sessions=[{app_name:'Snapchat',minutes:5,started_at:new Date().toISOString()}]
console.log('\n[2] session started; waiting for the 5s interval to release...')
await page.waitForURL(u=>!u.toString().startsWith('chrome-extension://'),{timeout:20000}).catch(e=>console.log('    NEVER RELEASED:',e.message.split('\n')[0]))
await new Promise(r=>setTimeout(r,1500))
console.log('    landed:',page.url())
console.log('    body  :',(await page.content()).includes('REAL SITE')?'REAL SITE (unlocked)':'still block page')
console.log('    nav chain:',JSON.stringify(nav,null,0))
console.log('    rules now:',(await sw.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())).map(r=>r.id))

// ---- session ends -> eviction with URL ----
sessions=[]
console.log('    forceSync ->', JSON.stringify(await forceSync()))
await new Promise(r=>setTimeout(r,1500))
console.log('\n[3] session ended -> tab evicted to:',page.url())
console.log('    dest shown:',await page.locator('#destination').textContent().catch(()=>'(none)'))
await ctx.close(); supa.close(); site.close()
