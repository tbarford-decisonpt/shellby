// Visual overlay test: puts an opaque window over the critter, triggers mood
// changes, and checks the real screen pixels for Shellby's colours bleeding
// through. Detects compositor-level overlay (z-order can be fine while DWM still
// paints a transparent window on top).
//   node scripts/overlay-visual-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9339;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  return { ev, close: () => ws.close() };
}

// DPI-aware PowerShell helper: shows a grey cover window at a physical rect and
// samples the screen there on request, printing how many "Shellby-coloured"
// pixels it sees (coral body / sea-glass shell).
const PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[D]::SetProcessDPIAware() | Out-Null
$x,$y,$w,$h = $args[0..3] | ForEach-Object { [int]$_ }
$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false
$f.BackColor = [Drawing.Color]::FromArgb(90,90,90); $f.Bounds = New-Object Drawing.Rectangle($x,$y,$w,$h)
$f.Text = 'shellby-cover'
$f.Show(); $f.Activate(); [Windows.Forms.Application]::DoEvents()
function Count { $b = New-Object Drawing.Bitmap $w,$h; $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x,$y,0,0,$b.Size); $n=0
  for ($i=0; $i -lt $w; $i+=3) { for ($j=0; $j -lt $h; $j+=3) { $c=$b.GetPixel($i,$j); if (($c.R -gt 200 -and $c.G -lt 150 -and $c.B -lt 120) -or ($c.G -gt 150 -and $c.B -gt 130 -and $c.R -lt 140)) { $n++ } } }
  $g.Dispose(); $b.Dispose(); return $n }
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null -or $line -eq 'quit') { break }
  if ($line -eq 'hide') { $f.Hide() } elseif ($line -eq 'show') { $f.Show(); $f.BringToFront(); $f.Activate() }; Start-Sleep -Milliseconds 150
  [Windows.Forms.Application]::DoEvents(); [Console]::Out.WriteLine("count " + (Count)); [Console]::Out.Flush() }
$f.Close()
`;

(async () => {
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let critter, cover;
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('critter.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    critter = await cdp(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    await wait(3000);
    const b = JSON.parse(await critter.ev('JSON.stringify({x:screenX,y:screenY,w:outerWidth,h:outerHeight,dpr:devicePixelRatio})'));
    const rect = [b.x * b.dpr, b.y * b.dpr, b.w * b.dpr, b.h * b.dpr].map(Math.round);
    const psFile = path.join(os.tmpdir(), 'shellby-cover.ps1');
    fs.writeFileSync(psFile, PS);
    cover = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, ...rect.map(String)], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const lines = [];
    cover.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
    const next = async () => { const n = lines.length; for (let i = 0; i < 100 && lines.length === n; i++) await wait(50); return lines[lines.length - 1]; };
    while (!lines.includes('ready')) await wait(100);
    await wait(600);
    const measure = async () => { cover.stdin.write('m\n'); return Number((await next()).split(' ')[1]); };

    cover.stdin.write('hide' + String.fromCharCode(10)); await next();
    const control = await measure();
    console.log('control, uncovered: shellby-coloured pixels visible =', control, control > 20 ? '(detector works)' : '(DETECTOR BROKEN)');
    cover.stdin.write('show' + String.fromCharCode(10)); await next();
    const base = await measure();
    console.log('covered, idle: shellby-coloured pixels visible =', base);
    const results = [];
    for (const s of ['working', 'asking', 'success', 'learned', 'error', 'sleeping', 'idle']) {
      await critter.ev(`document.body.className = 'state-${s} bubble-on'`);
      let peak = 0;
      for (let k = 0; k < 6; k++) { peak = Math.max(peak, await measure()); }
      results.push([s, peak]);
      console.log(`covered, ${s.padEnd(8)}: peak visible = ${peak}`);
    }
    const leaked = results.filter(([, n]) => n > base + 20);
    console.log(leaked.length ? `OVERLAY BUG: Shellby painted over the cover during ${leaked.map(r => r[0]).join(', ')}` : 'no overlay: the covering window stayed on top in every mood');
    cover.stdin.write('quit\n');
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    critter?.close();
    setTimeout(() => { try { cover?.kill(); } catch { /* gone */ } spawn('taskkill', ['/PID', String(app.pid), '/T', '/F']); process.exit(0); }, 800);
  }
})();
