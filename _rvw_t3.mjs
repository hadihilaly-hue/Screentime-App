import { chromium } from 'playwright'
import http from 'node:http'

const srv = http.createServer((req, res) => {
  res.writeHead(200, {'content-type':'text/html'})
  res.end('<h1>REAL SNAPCHAT</h1>')
})
await new Promise(r => srv.listen(8099, '127.0.0.1', r))

const EXT = '/home/user/Screentime-App/extension'
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/-home-user-Screentime-App/7618e8e6-de32-5ec8-8c56-e6303e5084d9/scratchpad/prof3', {
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
         '--host-resolver-rules=MAP snapchat.com 127.0.0.1:8099, MAP www.snapchat.com 127.0.0.1:8099'],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
await new Promise(r => setTimeout(r, 2500))

const cases = [
  'http://snapchat.com/watch?v=abc&t=42',
  'http://snapchat.com/watch?v=abc#section-3',
  'http://snapchat.com/app#/route/deep?x=1',
  'http://snapchat.com/p?q=a%20b%23c&z=%2F',
  'http://snapchat.com/p?next=https://evil.example/#/x',
  'http://www.snapchat.com/sub/path',
  'http://snapchat.com/p?a=1&b=2&c=%26%3F',
]
const page = await ctx.newPage()
for (const target of cases) {
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 })
  } catch (e) { console.log('GOTO ERR', target, e.message.split('\n')[0]) }
  await new Promise(r => setTimeout(r, 400))
  const info = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    parsed: location.hash.startsWith('#from=') ? location.hash.slice(6) : null,
    dest: document.getElementById('destination')?.textContent ?? null,
  })).catch(e => ({err: e.message}))
  console.log('\nREQUESTED:', target)
  console.log('  landed  :', info.href)
  console.log('  parsed  :', info.parsed)
  console.log('  MATCH   :', info.parsed === target ? 'exact' : `DIFFERS (lost: ${target.replace(info.parsed ?? '', '') || 'n/a'})`)
}
await ctx.close(); srv.close()
