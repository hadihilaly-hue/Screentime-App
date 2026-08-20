import { chromium } from 'playwright'
const EXT = '/home/user/Screentime-App/extension'
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/-home-user-Screentime-App/7618e8e6-de32-5ec8-8c56-e6303e5084d9/scratchpad/prof1', {
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const extId = new URL(sw.url()).host
console.log('extId', extId)
await new Promise(r => setTimeout(r, 2500))
const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())
console.log('RULES:', JSON.stringify(rules, null, 1))
await ctx.close()
