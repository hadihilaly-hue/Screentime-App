import { chromium } from 'playwright'
import fs from 'node:fs'
const EXT = '/home/user/Screentime-App/extension'
const dir = '/var/tmp/cp3-' + Date.now()
const ctx = await chromium.launchPersistentContext(dir, {
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }))
await new Promise((r) => setTimeout(r, 2500))

const rules = await sw.evaluate(async () => {
  const r = await chrome.declarativeNetRequest.getDynamicRules()
  return r.map((x) => ({ id: x.id, sub: x.action.redirect.regexSubstitution, rt: x.condition.resourceTypes }))
})
console.log('rule count:', rules.length)
for (const r of rules) console.log(' ', r.id, r.rt.join(), '->', r.sub)

const page = await ctx.newPage()
const url = 'https://www.youtube.com/watch?v=abc&t=42'
await page.goto(url, { timeout: 12000, waitUntil: 'commit' }).catch(() => {})
await page.waitForTimeout(1200)
console.log('\nrequested :', url)
console.log('landed on :', page.url())
const from = await page.evaluate(() => location.hash)
console.log('hash      :', from)
console.log('parsed from:', from.startsWith('#from=') ? from.slice(6) : '(none)')
console.log('round-trips exactly:', (from.startsWith('#from=') ? from.slice(6) : null) === url)
await page.waitForTimeout(1500)
console.log('destination shown:', await page.locator('#destination').innerText().catch(() => '(hidden)'))
console.log('note             :', await page.locator('#note').innerText())
console.log('retry button     :', await page.locator('#retry').isVisible())
await ctx.close(); fs.rmSync(dir, { recursive: true, force: true })
