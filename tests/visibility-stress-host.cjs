// Dedicated host for lifecycle stress. Never discovers or controls Codex.
const { app, BrowserWindow, dialog, screen } = require('electron');
const path = require('node:path');
const readline = require('node:readline');
const net = require('node:net');
const directory = process.argv.find(v => v.startsWith('--fixture-dir='))?.slice(14);
if (!directory || !path.isAbsolute(directory)) app.exit(1);
app.setPath('userData', path.join(directory, 'visibility-host-profile'));
let host, peer;
let control;
const pipe = '\\\\.\\pipe\\whale-visibility-fixture-' + process.pid;
const send = value => (control && !control.destroyed ? control : process.stdout).write(JSON.stringify(value) + '\n');
const server = net.createServer(socket => {
control = socket; socket.on('error', () => {});
readline.createInterface({ input: socket }).on('line', async line => {
  try {
    const request = JSON.parse(line);
    if (request.command === 'minimize') { host.minimize(); send({ id: request.id, ok: true }); }
    if (request.command === 'restore') { host.restore(); host.show(); send({ id: request.id, ok: true }); }
    if (request.command === 'focus-away') {
      if(!peer){const b=host.getBounds();peer=new BrowserWindow({x:b.x,y:b.y,width:180,height:100,show:false,skipTaskbar:true,webPreferences:{sandbox:true}});await peer.loadURL('data:text/html,Isolated focus fixture');}
      peer.show();peer.focus();send({id:request.id,ok:true});
    }
    if (request.command === 'focus-host') { host.focus();if(peer)peer.hide();send({id:request.id,ok:true}); }
    if (request.command === 'save') {
      const result = await dialog.showSaveDialog(host, { title: 'Whale isolated Save As stress', defaultPath: path.join(directory, 'CANCEL-ONLY-no-file-created.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
      send({ id: request.id, cancelled: result.canceled });
    }
    if (request.command === 'close') { send({ id: request.id, ok: true }); app.quit(); }
  } catch (error) { send({ error: error.message }); }
});
});
app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  host = new BrowserWindow({ x: area.x + Math.max(20,area.width-540), y: area.y + Math.max(20,area.height-440), width: Math.min(500, area.width - 80), height: Math.min(400, area.height - 80), frame: false, show: false, skipTaskbar:true, title: 'Whale isolated visibility stress', backgroundColor: '#e7f0f5', webPreferences: { sandbox: true } });
  await host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#e7f0f5"><p style="position:absolute;bottom:10px;left:15px;font:18px Segoe UI">小鲸鱼独立窗口压力测试 — 自动关闭</p></body>'));
  // Match the production owner: ordinary non-topmost window. Show/focus once
  // during setup; screen sampling never raises, re-shows or activates it.
  host.show(); host.focus();
  server.listen(pipe, () => process.stdout.write(JSON.stringify({ ready: true, pipe, pid: process.pid, handle: host.getNativeWindowHandle().readBigUInt64LE().toString(), bounds: screen.dipToScreenRect(null, host.getContentBounds()), dpi: screen.getDisplayMatching(host.getBounds()).scaleFactor * 96 }) + '\n'));
}).catch(error => { send({ error: error.message }); app.exit(1); });
app.on('window-all-closed', () => app.quit());
