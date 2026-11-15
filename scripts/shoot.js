// Documentation screenshots of the demo data through the Chromium debug port:
// electron . --demo --remote-debugging-port=9333  then  node scripts/shoot.js <mode> <out.png>
const fs = require('fs');
const [, , mode, out] = process.argv;
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = list.find((x) => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = {};
  const send = (method, params = {}) => new Promise((r) => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (pending[d.id]) pending[d.id](d.result); };
  await new Promise((r) => (ws.onopen = r));
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = async (sel) => {
    const r = await ev(`(()=>{const b=document.querySelector('${sel}').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  await wait(1800);
  let clip;
  if (mode === 'wide') { await click('.row[data-id=claude] .bot'); await click('.row[data-id=codex] .bot'); await wait(1200); }
  if (mode === 'settings') { await click('#toggle'); await wait(900); clip = { x: 0, y: 0, width: await ev('innerWidth'), height: 560, scale: 1 }; }
  if (mode === 'gallery') {
    // every mascot on its own, in the three states, without the panel around it
    const box = await ev(`(()=>{const ids=Object.keys(SPEC);const st=['working','waiting','done'];
      document.body.style.padding='0';document.body.style.overflow='visible';
      document.body.innerHTML='<div id="gal" style="display:inline-grid;grid-template-columns:repeat(7,86px);gap:10px 6px;padding:18px 14px;background:rgba(20,22,27,.94);border-radius:24px">'+ids.map((id,i)=>'<div class="row '+st[i%3]+'" style="text-align:center;--m:64px;display:grid;justify-items:center;gap:4px">'+mascot(id,st[i%3])+'<div style="font:11px Segoe UI,sans-serif;color:#8b919c">'+id+'</div></div>').join('')+'</div>';
      const r=document.getElementById('gal').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()`);
    await wait(600);
    clip = { ...box, scale: 1 };
  }
  if (!clip) clip = { x: 0, y: 0, width: await ev('innerWidth'), height: await ev('innerHeight'), scale: 1 };
  clip.scale = 2; // retina-sharp images for the README
  const shot = await send('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, await ev('innerWidth + "x" + innerHeight'));
  process.exit(0);
})();
