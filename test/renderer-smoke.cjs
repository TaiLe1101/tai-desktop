// Renderer smoke test with local fixtures. No network or persisted user settings.
const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = join(__dirname, '..');
app.setName('TAI Renderer Smoke');
app.whenReady().then(async () => {
  const chunks = Array.from({length: 8}, (_, id) => ({id, start: id*5, end: id*5+4.5, text: `Subtitle pack ${id+1}: A story from around the world.`, ready: id<3}));
  const state = {videoId:'abcdefghijk',title:'YouTube · Caption translation preview',phase:'IDLE',error:'',chunks:[],ready:0,total:0,initialRequired:0,time:4.8,paused:true,rate:1,volume:1,muted:false,cached:false};
  let starts = 0;
  ipcMain.handle('tai:start-translation', (_event, id) => {
    assert.equal(id, state.videoId); starts++;
    Object.assign(state, { phase:'PLAYING', chunks, ready:3, total:8, initialRequired:2 });
  });
  const data = { 'settings': {workerUrl:'', targetLang:'vi', launchAtLogin:false, hasApiKey:false}, 'status': {cachePath:'C:/TAI/audio'}, 'session':state };
  for (const name of ['settings','status','session','bounds','navigate','voice','playback','save','retry','open-cache','choose-audio-directory']) ipcMain.handle(`tai:${name}`, () => data[name]);
  const win = new BrowserWindow({width:1440,height:920,show:false,webPreferences:{preload:join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
  const errors=[];
  win.webContents.on('console-message', (_e, level, message) => { if(level===3) errors.push(message); });
  await win.loadFile(join(root,'out/renderer/index.html'));
  async function until(text) {
    for(let i=0;i<100;i++) { if(await win.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(text)})`)) return; await new Promise(r=>setTimeout(r,50)); }
    throw new Error(`Missing UI text: ${text}`);
  }
  await until('YouTube'); await mkdir(join(root,'out/smoke'),{recursive:true});
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Nền tảng"]') !== null`), true);
  await new Promise(r=>setTimeout(r,200));
  await require('node:fs/promises').writeFile(join(root,'out/smoke/home.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="Mở YouTube"]').click()`);
  await until('Phụ đề & tiến trình'); await until('Nhấn Dịch');
  await new Promise(r=>setTimeout(r,500));
  assert.equal(starts, 0, 'opening a platform must not start translation');
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('TAI Desktop') || document.querySelector('input') !== null`), false, 'platform header and address bar must be absent');
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent === 'Dịch').click()`);
  await until('Subtitle pack 1');
  assert.equal(starts, 1);
  await new Promise(r=>setTimeout(r,200));
  await require('node:fs/promises').writeFile(join(root,'out/smoke/youtube.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="Cấu hình"]').click()`);
  await until('URL worker');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('input').length >= 3`),true);
  assert.equal(errors.length,0,errors.join('\n'));
  await require('node:fs/promises').writeFile(join(root,'out/smoke/result.json'), JSON.stringify({passed:true, screens:['home','youtube','settings'], errors}));
  win.destroy(); app.exit(0);
}).catch(error => { require('node:fs').writeFileSync(join(root,'out/smoke/result.json'), JSON.stringify({passed:false,error:String(error)})); app.exit(1); });
