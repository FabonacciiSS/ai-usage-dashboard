const p = await context.newPage();
await p.goto('https://opencode.ai/workspace/wrk_01KSVWVJFY30ZT3N8X3X8PSVDS/go', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
const info = await p.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 300) }));
return JSON.stringify(info);