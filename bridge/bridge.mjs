// Start3D workshop bridge.
// Reads print status and camera frames from printers on the local network
// and sends them to the Start3D server. Run: node bridge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import mqtt from 'mqtt';

const cfgPath = new URL('./config.json', import.meta.url);
if (!fs.existsSync(cfgPath)) {
  console.error('Нет файла config.json. Скопируйте config.example.json в config.json и заполните его.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const SERVER = String(cfg.server || '').replace(/\/$/, '');
const KEY = cfg.bridgeKey;
if (!SERVER || !KEY || KEY.includes('ВСТАВЬТЕ')) {
  console.error('В config.json не заполнены server или bridgeKey.');
  process.exit(1);
}

const FAST_MS = 2500;   // still-frame interval while someone watches
const SLOW_MS = 60000;  // otherwise
// While a print runs the camera is also recorded as a smooth delayed stream:
// frames are packed into chunks of a few seconds and uploaded; the site plays them back 2 minutes behind.
const CHUNK_MS = 4000, MAX_FPS = 5, CHUNK_MAX = 1600000;
const PRINTING = ['RUNNING', 'PREPARE', 'PAUSE', 'SLICING'];
const log = (id, ...a) => console.log(new Date().toLocaleTimeString(), `[${id}]`, ...a);

async function post(url, body, type = 'application/json') {
  const r = await fetch(SERVER + url, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });
  if (r.status === 403) throw new Error('сервер отклонил ключ: проверьте bridgeKey и BRIDGE_KEY в Cloudflare');
  if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
  return r.json();
}

// Printers with an order in "printing" on the site (used for cameras of printers without a status connection).
const BUSY = new Set();
async function pollBusy() {
  try {
    const r = await fetch(SERVER + '/api/bridge/busy', { headers: { authorization: `Bearer ${KEY}` } });
    if (r.ok){ const j = await r.json(); BUSY.clear(); (j.busy || []).forEach((id) => BUSY.add(id)); }
  } catch {}
}
const isPrinting = (p) => p.stream === 'always' || PRINTING.includes(p._state?.gcode_state) || BUSY.has(p.id);

/* ---------- Bambu Lab: status over MQTT ---------- */
function bambuStatus(p) {
  const state = {};
  p._state = state;
  let lastSent = '', lastAt = 0;
  const client = mqtt.connect(`mqtts://${p.ip}:8883`, {
    username: 'bblp', password: p.accessCode, rejectUnauthorized: false,
    reconnectPeriod: 5000, connectTimeout: 10000, clientId: 'start3d-' + p.id + '-' + Math.random().toString(16).slice(2, 8),
  });
  const report = `device/${p.serial}/report`, request = `device/${p.serial}/request`;
  client.on('connect', () => {
    log(p.id, 'MQTT подключён');
    client.subscribe(report);
    client.publish(request, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } }));
  });
  client.on('error', (e) => log(p.id, 'MQTT ошибка:', e.message));
  client.on('offline', () => log(p.id, 'MQTT нет связи с принтером, переподключаюсь…'));
  client.on('message', (_t, msg) => {
    let j; try { j = JSON.parse(msg.toString()); } catch { return; }
    if (j.print) Object.assign(state, j.print);
  });
  setInterval(async () => {
    if (!state.gcode_state) return;
    const body = {
      state: state.gcode_state, percent: state.mc_percent ?? 0, layer: state.layer_num ?? 0, layers: state.total_layer_num ?? 0,
      remaining: state.mc_remaining_time ?? 0, task: state.subtask_name || '', error: state.print_error ? String(state.print_error) : null,
    };
    const sig = JSON.stringify(body);
    if (sig === lastSent && Date.now() - lastAt < 30000) return;
    try {
      await post(`/api/bridge/status/${p.id}`, body);
      if (sig !== lastSent) log(p.id, `${body.state} ${body.percent}% слой ${body.layer}/${body.layers}, осталось ${body.remaining} мин`);
      lastSent = sig; lastAt = Date.now();
    } catch (e) { log(p.id, 'не отправил статус:', e.message); }
  }, 3000);
}

/* ---------- Bambu Lab A1/P1: camera over TLS port 6000 (JPEG frames) ---------- */
function bambuCamera6000(p, onFrame, onFail) {
  let buf = Buffer.alloc(0), got = false;
  const sock = tls.connect({ host: p.ip, port: 6000, rejectUnauthorized: false, timeout: 15000 }, () => {
    const auth = Buffer.alloc(80);
    auth.writeUInt32LE(0x40, 0); auth.writeUInt32LE(0x3000, 4);
    auth.write('bblp', 16, 'ascii'); auth.write(String(p.accessCode), 48, 'ascii');
    sock.write(auth);
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) {
      const size = buf.readUInt32LE(0);
      if (size <= 0 || size > 5e6) { buf = Buffer.alloc(0); break; }
      if (buf.length < 16 + size) break;
      const img = buf.subarray(16, 16 + size);
      buf = buf.subarray(16 + size);
      if (img[0] === 0xff && img[1] === 0xd8) { got = true; onFrame(Buffer.from(img)); }
    }
  });
  sock.on('timeout', () => sock.destroy(new Error('нет ответа')));
  sock.on('error', (e) => { if (!got) onFail(e); else log(p.id, 'камера: обрыв, переподключаюсь'); });
  sock.on('close', () => setTimeout(() => (got ? bambuCamera6000(p, onFrame, onFail) : null), 3000));
}

/* ---------- any camera via ffmpeg (Bambu RTSPS 322, Tapo RTSP, …) ---------- */
const hasFfmpeg = () => { try { return spawnSync('ffmpeg', ['-version']).status === 0; } catch { return false; } };
function ffmpegSnapshot(url) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1']);
    const chunks = []; const t = setTimeout(() => ff.kill('SIGKILL'), 15000);
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => { clearTimeout(t); const b = Buffer.concat(chunks); b.length > 100 ? resolve(b) : reject(new Error('ffmpeg code ' + code)); });
    ff.on('error', reject);
  });
}

/* ---------- delayed stream: chunks of JPEG frames ---------- */
function streamer(p) {
  let frames = [], t0 = 0, size = 0, lastKept = 0, busy = false, seen = 0, seenAt = Date.now(), fpsLogged = false;
  const queue = [];
  const live = () => !p.video && isPrinting(p);
  const pump = async () => {
    if (busy || !queue.length) return;
    busy = true;
    const c = queue[0];
    try { await post(`/api/bridge/chunk/${p.id}?t0=${c.t0}&dur=${c.dur}`, c.buf, 'application/octet-stream'); queue.shift(); }
    catch (e) { log(p.id, 'эфир: не отправил кусок:', e.message); if (queue.length > 12) queue.shift(); await new Promise((r) => setTimeout(r, 2000)); }
    busy = false; pump();
  };
  const flush = () => {
    if (!frames.length) return;
    const head = Buffer.alloc(6); head.write('S3D1', 0, 'ascii'); head.writeUInt16LE(frames.length, 4);
    const parts = [head];
    for (const f of frames) { const h = Buffer.alloc(8); h.writeUInt32LE(f.t - t0, 0); h.writeUInt32LE(f.img.length, 4); parts.push(h, f.img); }
    queue.push({ t0, dur: frames[frames.length - 1].t - t0 + Math.round(1000 / MAX_FPS), buf: Buffer.concat(parts) });
    frames = []; size = 0; t0 = 0; pump();
  };
  setInterval(() => { if (frames.length && Date.now() - t0 > CHUNK_MS + 1500) flush(); }, 1000);
  return (img) => {
    const now = Date.now();
    seen++;
    if (!fpsLogged && now - seenAt > 30000) { fpsLogged = true; log(p.id, `камера даёт ~${(seen * 1000 / (now - seenAt)).toFixed(1)} кадр/с`); }
    if (!live()) { if (frames.length) flush(); return; }
    if (now - lastKept < 1000 / MAX_FPS) return;
    lastKept = now;
    if (!t0) t0 = now;
    frames.push({ t: now, img }); size += img.length + 8;
    if (now - t0 >= CHUNK_MS || size > CHUNK_MAX) flush();
  };
}

function camera(p) {
  if (p.camera === 'off') return;
  let latest = null, sentAt = 0, watched = false, mode = null;
  const record = streamer(p);
  const send = async () => {
    const streaming = isPrinting(p);
    if (!latest || Date.now() - sentAt < (streaming ? 30000 : watched ? FAST_MS : SLOW_MS)) return;
    const img = latest; sentAt = Date.now();
    try { watched = (await post(`/api/bridge/frame/${p.id}`, img, 'image/jpeg')).watched; }
    catch (e) { log(p.id, 'не отправил кадр:', e.message); }
  };
  setInterval(send, 500);
  const rtspUrl = p.rtsp || (p.type === 'bambu' ? `rtsps://bblp:${p.accessCode}@${p.ip}:322/streaming/live/1` : null);
  const useFfmpeg = () => {
    if (!rtspUrl) return log(p.id, 'камера: нет адреса потока');
    if (!hasFfmpeg()) return log(p.id, 'камера: нужен ffmpeg (winget install ffmpeg) или другой способ подключения');
    mode = 'ffmpeg'; log(p.id, 'камера: беру кадры через ffmpeg');
    const loop = async () => {
      try { latest = await ffmpegSnapshot(rtspUrl); record(latest); } catch (e) { log(p.id, 'камера ffmpeg:', e.message); }
      setTimeout(loop, p.video ? 30000 : isPrinting(p) ? 300 : watched ? FAST_MS : 20000);
    };
    loop();
  };
  if (p.rtsp || p.camera === 'rtsp') return useFfmpeg();
  if (p.type === 'bambu') {
    bambuCamera6000(p, (img) => { if (mode !== '6000') { mode = '6000'; log(p.id, 'камера подключена (порт 6000)'); } latest = img; record(img); },
      (e) => { log(p.id, `камера порт 6000 недоступна (${e.message}), пробую RTSPS`); useFfmpeg(); });
  }
}

/* ---------- real video from an IP camera: ffmpeg → fragmented MP4 segments → server ---------- */
function videoInput(url) {
  if (String(url).startsWith('lavfi:')) return ['-re', '-f', 'lavfi', '-i', String(url).slice(6)]; // test pattern
  return [...(String(url).startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), '-i', url];
}
function videoStreamer(p) {
  if (!hasFfmpeg()) { log(p.id, 'видео: нужен ffmpeg — выполните в PowerShell: winget install Gyan.FFmpeg, затем перезапустите мост'); return; }
  let ff = null, sess = 0, dir = '', idle = 0, initSent = false, done = new Set(), queue = [], busy = false, stopping = false;
  const pump = async () => {
    if (busy || !queue.length) return;
    busy = true;
    const it = queue[0];
    try {
      const data = fs.readFileSync(it.file);
      await post(`/api/bridge/${it.kind}/${p.id}?sess=${it.sess}${it.dur ? '&dur=' + it.dur : ''}`, data, 'application/octet-stream');
      queue.shift(); if (it.kind === 'vseg') fs.rmSync(it.file, { force: true });
    } catch (e) { log(p.id, 'видео: не отправил кусок:', e.message); if (queue.length > 15) queue.splice(1, 1); await new Promise((r) => setTimeout(r, 2000)); }
    busy = false; pump();
  };
  const scan = () => {
    if (!dir) return;
    const init = path.join(dir, 'init.mp4');
    if (!initSent && fs.existsSync(init)) { initSent = true; queue.unshift({ kind: 'vinit', sess, file: init }); }
    let pl; try { pl = fs.readFileSync(path.join(dir, 'live.m3u8'), 'utf8'); } catch { return; }
    if (!initSent) return;
    const lines = pl.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#EXTINF:([\d.]+)/);
      if (!m || !lines[i + 1] || done.has(lines[i + 1])) continue;
      done.add(lines[i + 1]); queue.push({ kind: 'vseg', sess, dur: (+m[1]).toFixed(3), file: path.join(dir, lines[i + 1].trim()) });
    }
    pump();
  };
  const start = () => {
    sess = Date.now(); initSent = false; done = new Set(); stopping = false;
    dir = path.join(os.tmpdir(), `start3d-video-${p.id}-${sess}`); fs.mkdirSync(dir, { recursive: true });
    const args = ['-loglevel', 'error', ...videoInput(p.video), '-an',
      '-vf', `scale='min(${p.videoWidth || 1280},iw)':-2,fps=${p.videoFps || 15}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1', '-pix_fmt', 'yuv420p',
      '-b:v', `${p.videoKbps || 1000}k`, '-maxrate', `${Math.round((p.videoKbps || 1000) * 1.4)}k`, '-bufsize', `${Math.round((p.videoKbps || 1000) * 2.8)}k`,
      '-g', String((p.videoFps || 15) * 2), '-keyint_min', String((p.videoFps || 15) * 2), '-sc_threshold', '0',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '12', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 's%06d.m4s'), path.join(dir, 'live.m3u8')];
    ff = spawn('ffmpeg', args, { cwd: dir });
    let errText = '';
    ff.stderr.on('data', (d) => { errText = (errText + d).slice(-400); });
    ff.on('close', (code) => {
      const was = ff; ff = null;
      if (!stopping) log(p.id, `видео: ffmpeg остановился (${code}) ${errText.trim().split('\n').pop() || ''} — перезапуск`);
      setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 60000);
    });
    log(p.id, 'видео: запись началась');
  };
  setInterval(scan, 1000);
  setInterval(() => {
    const want = isPrinting(p);
    if (want) { idle = 0; if (!ff) start(); }
    else if (ff && ++idle > 30) { stopping = true; ff.kill('SIGINT'); log(p.id, 'видео: печати нет, запись остановлена'); }
  }, 2000);
}

/* ---------- start ---------- */
console.log(`Start3D мост → ${SERVER}`);
pollBusy(); setInterval(pollBusy, 5000);
for (const p of cfg.printers || []) {
  if (!p.id || (!p.ip && !p.video)) continue;
  log(p.id, [p.ip && `${p.type || 'bambu'} ${p.ip}`, p.video && 'видеокамера'].filter(Boolean).join(' + '));
  if (p.ip && p.type === 'bambu') bambuStatus(p);
  if (p.video) videoStreamer(p);
  // still frames for thumbnails: the printer's own camera if it has one, otherwise snapshots from the video camera
  if (!p.ip && p.video) p.rtsp = p.video;
  camera(p);
}
