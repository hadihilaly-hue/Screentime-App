import { chromium } from 'playwright'
const EXT = '/home/user/Screentime-App/extension'
const P = '/tmp/claude-0/-home-user-Screentime-App/7618e8e6-de32-5ec8-8c56-e6303e5084d9/scratchpad/prof2'
const ctx = await chromium.launchPersistentContext(P, {
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
console.log('extId', new URL(sw.url()).host)
await new Promise(r => setTimeout(r, 3000))
const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())
console.log('COUNT', rules.length)
for (const r of rules) console.log(r.id, JSON.stringify(r.action), JSON.stringify(r.condition))
// try adding the exact rule shape manually to see if chrome accepts it
const res = await sw.evaluate(async () => {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9001], addRules: [{
      id: 9001, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: chrome.runtime.getURL('blocked.html') + '?site=youtube.com#from=\\0' } },
      condition: { requestDomains: ['youtube.com'], resourceTypes: ['main_frame'], regexFilter: '^.*$' },
    }]})
    return 'ACCEPTED'
  } catch (e) { return 'REJECTED: ' + e.message }
})
console.log('manual regexSubstitution rule:', res)
await ctx.close()
