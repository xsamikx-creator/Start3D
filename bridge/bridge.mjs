// Start3D workshop bridge.
// Reads print status and camera frames from printers on the local network
// and sends them to the Start3D server. Run: node bridge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import dgram from 'node:dgram';
import net from 'node:net';
import mqtt from 'mqtt';

const cfgPath = new URL('./config.json', import.meta.url);
if (!fs.existsSync(cfgPath)) {
  console.error('Нет файла config.json. Скопируйте config.example.json в config.json и заполните его.');
  process.exit(1);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) {
  const m = String(e.message).match(/line (\d+)/);
  console.error(`\nОшибка в config.json${m ? `, строка ${m[1]}` : ''}: ${e.message}`);
  console.error('Чаще всего не хватает запятой между блоками принтеров: «},» перед следующим «{». Исправьте файл и сохраните — мост перезапустится сам.\n');
  process.exit(1);
}
// The old *.workers.dev address is switched off: use the site's own domain (and fix config.json once).
if (/workers\.dev/i.test(String(cfg.server || ''))) {
  cfg.server = 'https://start3d.az';
  try { const raw = fs.readFileSync(cfgPath, 'utf8'); fs.writeFileSync(cfgPath, raw.replace(/"server"\s*:\s*"[^"]*"/, '"server": "https://start3d.az"')); } catch {}
}
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
const BRIDGE_START = Date.now();
// Updates: only a version the owner approved in the bot (/bridge update), downloaded at that exact commit and
// checked against the SHA-256 fingerprints the server computed. start.bat installs the checked files on restart.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256f = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const MY_SHA = sha256f(path.join(HERE, 'bridge.mjs'));
let updTried = '';
async function applyUpdate(u) {
  if (!/^[0-9a-f]{40}$/.test(u.sha || '') || updTried === u.sha) return false;
  updTried = u.sha;
  const get = async (f) => { const r = await fetch(`https://raw.githubusercontent.com/xsamikx-creator/Start3D/${u.sha}/bridge/${f}`); if (!r.ok) throw new Error(f + ': ' + r.status); return Buffer.from(await r.arrayBuffer()); };
  try {
    const b = await get('bridge.mjs'), st = await get('start.bat');
    const hb = crypto.createHash('sha256').update(b).digest('hex'), hs = crypto.createHash('sha256').update(st).digest('hex');
    if (hb !== u.hb || hs !== u.hs) { console.log(new Date().toLocaleTimeString(), '⛔ Обновление отклонено: отпечатки файлов не совпали с одобренными'); return false; }
    fs.writeFileSync(path.join(HERE, 'bridge-new.mjs'), b);
    if (hs !== sha256f(path.join(HERE, 'start.bat'))) fs.writeFileSync(path.join(HERE, 'start.new'), st);
    console.log(new Date().toLocaleTimeString(), `Обновление ${u.sha.slice(0, 7)} проверено — устанавливаю`);
    return true;
  } catch (e) { console.log(new Date().toLocaleTimeString(), 'Обновление не скачалось:', e.message); return false; }
}
const ORDERS = {}; // printer id → order printing on it now (from the site)
const ROTATE = {}; // printer id → '0' | 'ccw' | 'cw' | '180' (set from the bot with /rotate, or "rotate" in config.json)
async function pollBusy() {
  try {
    const r = await fetch(SERVER + '/api/bridge/busy', { headers: { authorization: `Bearer ${KEY}`, 'x-bridge-start': String(BRIDGE_START), 'x-bridge-sha': MY_SHA } });
    if (r.ok){ const j = await r.json();
      if (j.update && (await applyUpdate(j.update))) process.exit(0); BUSY.clear(); (j.busy || []).forEach((id) => BUSY.add(id)); Object.assign(ROTATE, j.rotate || {});
      if (j.restart === true) { console.log(new Date().toLocaleTimeString(), 'Команда из бота: перезапуск моста'); process.exit(0); } for (const k of Object.keys(ORDERS)) delete ORDERS[k]; Object.assign(ORDERS, j.orders || {}); for (const k of Object.keys(CAMFOR)) delete CAMFOR[k]; Object.assign(CAMFOR, j.camfor || {}); if (cfg.autoPrint === true) for (const jb of j.jobs || []) autoJob(jb); } // auto print only if switched on in config.json
  } catch {}
}
const rotOf = (p) => ROTATE[p.id] && ROTATE[p.id] !== '0' ? ROTATE[p.id] : (p.rotate || '0');
const rotFilter = (p) => ({ ccw: 'transpose=2', cw: 'transpose=1', '180': 'hflip,vflip' })[rotOf(p)] || '';
// A camera moved to another printer (/camto k2) follows that printer: its state starts and stops video and timelapses.
const CAMFOR = {};
const camState = (p) => (CAMFOR[p.id] && (cfg.printers || []).find((x) => x.id === CAMFOR[p.id])?._state) || p._state;
const isPrinting = (p) => p.stream === 'always' || PRINTING.includes(camState(p)?.gcode_state) || BUSY.has(p.id);

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
  p._send = (obj) => new Promise((res, rej) => client.publish(request, JSON.stringify(obj), (e) => (e ? rej(e) : res())));
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
function ffmpegSnapshot(url, vf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', ...videoInput(url), '-frames:v', '1', ...(vf ? ['-vf', vf] : []), '-q:v', '7', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1']);
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
  const rec = streamer(p), record = (img) => { rec(img); p._tl?.feed(img); };
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
      try { latest = await ffmpegSnapshot(rtspUrl, [rotFilter(p), "scale='if(gte(iw,ih),min(960,iw),-2)':'if(gte(iw,ih),-2,min(960,ih))'"].filter(Boolean).join(',')); record(latest); } catch (e) { log(p.id, 'камера ffmpeg:', e.message); }
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
  let ff = null, sess = 0, dir = '', idle = 0, lastSeg = 0, initSent = false, done = new Set(), queue = [], busy = false, stopping = false;
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
      done.add(lines[i + 1]); lastSeg = Date.now(); queue.push({ kind: 'vseg', sess, dur: (+m[1]).toFixed(3), file: path.join(dir, lines[i + 1].trim()) });
    }
    pump();
  };
  const start = () => {
    sess = Date.now(); lastSeg = sess; initSent = false; done = new Set(); stopping = false;
    dir = path.join(os.tmpdir(), `start3d-video-${p.id}-${sess}`); fs.mkdirSync(dir, { recursive: true });
    const args = ['-loglevel', 'error', ...videoInput(p.video), '-an',
      // rotate if needed, then fit the long side into videoWidth (portrait keeps the same pixel budget)
      '-vf', [rotFilter(p), `scale='if(gte(iw,ih),min(${p.videoWidth || 1280},iw),-2)':'if(gte(iw,ih),-2,min(${p.videoWidth || 1280},ih))'`, `fps=${p.videoFps || 15}`].filter(Boolean).join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1', '-pix_fmt', 'yuv420p',
      '-b:v', `${p.videoKbps || 1000}k`, '-maxrate', `${Math.round((p.videoKbps || 1000) * 1.4)}k`, '-bufsize', `${Math.round((p.videoKbps || 1000) * 2.8)}k`,
      '-g', String((p.videoFps || 15) * 2), '-keyint_min', String((p.videoFps || 15) * 2), '-sc_threshold', '0',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '12', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 's%06d.m4s'), path.join(dir, 'live.m3u8')];
    const me = spawn('ffmpeg', args, { cwd: dir }); ff = me; const myDir = dir;
    let errText = '';
    me.stderr.on('data', (d) => { errText = (errText + d).slice(-400); });
    me.on('close', (code) => {
      if (ff !== me) return; // already replaced by the watchdog
      ff = null;
      if (!stopping) log(p.id, `видео: ffmpeg остановился (${code}) ${errText.trim().split('\n').pop() || ''} — перезапуск`);
      setTimeout(() => { try { fs.rmSync(myDir, { recursive: true, force: true }); } catch {} }, 60000);
    });
    log(p.id, 'видео: запись началась');
  };
  setInterval(scan, 1000);
  let rotAt = rotOf(p);
  setInterval(() => {
    const want = isPrinting(p);
    if (ff && rotOf(p) !== rotAt) { stopping = true; ff.kill('SIGINT'); log(p.id, 'видео: поворот изменён, перезапускаю запись'); }
    if (!ff) rotAt = rotOf(p);
    // ffmpeg can hang without exiting when the camera stream drops (after a print error, Wi‑Fi blip): restart it
    if (ff && Date.now() - lastSeg > 25000) { const f = ff, d0 = dir; ff = null; log(p.id, 'видео: камера не присылает картинку 25 с — перезапускаю запись'); try { f.kill('SIGKILL'); } catch {} setTimeout(() => { try { fs.rmSync(d0, { recursive: true, force: true }); } catch {} }, 60000); }
    if (want) { idle = 0; if (!ff) start(); }
    else if (ff && ++idle > 30) { stopping = true; ff.kill('SIGINT'); log(p.id, 'видео: печати нет, запись остановлена'); }
  }, 2000);
}

/* ---------- Creality K2 Plus / K1 (Creality OS): status over the printer's WebSocket on port 9999 ---------- */
// A tiny WebSocket client (text frames, ping/pong) so no extra package is needed.
function wsOpen(host, port, onText, onOpen, onClose) {
  const sock = net.connect({ host, port, timeout: 15000 });
  const key = crypto.randomBytes(16).toString('base64');
  let buf = Buffer.alloc(0), open = false, closed = false;
  const close = (why) => { if (closed) return; closed = true; try { sock.destroy(); } catch {} onClose(why); };
  const frame = (op, payload) => {
    const mask = crypto.randomBytes(4), n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : null;
    if (!head) return;
    const body = Buffer.from(payload); for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
    sock.write(Buffer.concat([head, mask, body]));
  };
  const send = (text) => { if (open) frame(1, Buffer.from(text)); };
  sock.on('connect', () => sock.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  sock.on('timeout', () => { if (!open) close('нет ответа'); });
  sock.on('error', (e) => close(e.message));
  sock.on('close', () => close('соединение закрыто'));
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.toString('latin1', 0, 12))) return close('принтер не принял WebSocket');
      buf = buf.subarray(i + 4); open = true; sock.setTimeout(0); onOpen(send);
    }
    while (buf.length >= 2) {
      const op = buf[0] & 15; let n = buf[1] & 127, off = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128; if (masked) off += 4;
      if (buf.length < off + n) return;
      let pl = buf.subarray(off, off + n);
      if (masked) { const m = buf.subarray(off - 4, off); pl = Buffer.from(pl); for (let i = 0; i < n; i++) pl[i] ^= m[i & 3]; }
      buf = buf.subarray(off + n);
      if (op === 1) onText(pl.toString('utf8')); else if (op === 9) frame(10, pl); else if (op === 8) return close('принтер закрыл соединение');
    }
  });
  return { close: () => close('stop') };
}
// Creality "state" codes → the same states the Bambu printers report (the site and timelapses understand those)
const CR_STATE = { 0: 'IDLE', 1: 'RUNNING', 2: 'FINISH', 3: 'FAILED', 4: 'FAILED', 5: 'PAUSE' };
function crealityStatus(p) {
  const state = {}; p._state = state;
  let lastSent = '', lastAt = 0, seenKeys = false, alive = 0;
  const connect = () => {
    wsOpen(p.ip, p.wsPort || 9999, (text) => {
      if (text === 'ok') return;
      let j; try { j = JSON.parse(text); } catch { return; }
      alive = Date.now();
      if (j.ModeCode === 'heart_beat') { ws.send?.('ok'); return; }
      if (!seenKeys && Object.keys(j).length > 3) { seenKeys = true; log(p.id, 'данные принтера:', Object.keys(j).slice(0, 40).join(', ')); }
      const prog = j.printProgress ?? j.dProgress, layer = j.layer ?? j.curLayer, total = j.TotalLayer ?? j.totalLayer, left = j.printLeftTime;
      if (prog !== undefined) state.mc_percent = Math.round(+prog);
      if (layer !== undefined) state.layer_num = +layer;
      if (total !== undefined) state.total_layer_num = +total;
      if (left !== undefined) state.mc_remaining_time = Math.round(+left / 60);
      if (j.printFileName) state.subtask_name = String(j.printFileName).split('/').pop().replace(/\.gcode$/i, '');
      if (j.state !== undefined) state.gcode_state = CR_STATE[j.state] || (+j.state > 0 ? 'RUNNING' : 'IDLE');
      else if (!state.gcode_state && prog !== undefined) state.gcode_state = +prog > 0 && +prog < 100 ? 'RUNNING' : 'IDLE';
      if (j.err && j.err.errcode) state.print_error = j.err.errcode;
    }, (send) => {
      ws.send = send; log(p.id, 'Creality подключён (порт ' + (p.wsPort || 9999) + ')');
      send(JSON.stringify({ method: 'get', params: { ReqPrinterPara: 1 } }));
    }, (why) => {
      ws.send = null; if (why !== 'stop') { log(p.id, 'Creality: ' + why + ', переподключаюсь…'); setTimeout(connect, 5000); }
    });
  };
  const ws = {}; connect();
  setInterval(() => { if (ws.send && Date.now() - alive > 20000) ws.send(JSON.stringify({ method: 'get', params: { ReqPrinterPara: 1 } })); }, 10000);
  setInterval(async () => {
    if (!state.gcode_state) return;
    const body = { state: state.gcode_state, percent: state.mc_percent ?? 0, layer: state.layer_num ?? 0, layers: state.total_layer_num ?? 0,
      remaining: state.mc_remaining_time ?? 0, task: state.subtask_name || '', error: state.print_error ? String(state.print_error) : null };
    const sig = JSON.stringify(body);
    if (sig === lastSent && Date.now() - lastAt < 30000) return;
    try {
      await post(`/api/bridge/status/${p.id}`, body);
      if (sig !== lastSent) log(p.id, `${body.state} ${body.percent}% слой ${body.layer}/${body.layers}, осталось ${body.remaining} мин`);
      lastSent = sig; lastAt = Date.now();
    } catch (e) { log(p.id, 'не отправил статус:', e.message); }
  }, 3000);
}

/* ---------- printer IP changed (router gave a new address): find it by serial number and restart ---------- */
// Bambu printers announce themselves on the local network (SSDP on UDP 2021) with their serial number and IP,
// the same way Bambu Studio finds them. When a printer shows up with a new IP, the bridge saves it to config.json and restarts.
function watchPrinterIps() {
  const bambu = (cfg.printers || []).filter((p) => p.type === 'bambu' && p.serial);
  if (!bambu.length) return;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => log('сеть', 'поиск принтеров недоступен:', e.message));
  sock.on('message', (msg, rinfo) => {
    const t = msg.toString();
    const usn = (t.match(/^USN:\s*(\S+)/im) || [])[1], loc = (t.match(/^Location:\s*([\d.]+)/im) || [])[1] || rinfo.address;
    const p = bambu.find((x) => x.serial === usn);
    if (!p || !loc || loc === p.ip) return;
    log(p.id, `принтер теперь по адресу ${loc} (был ${p.ip}) — сохраняю в config.json и перезапускаю мост`);
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const fixed = raw.split(`"${p.ip}"`).join(`"${loc}"`); // only the "ip" value; a separate camera keeps its own address
      fs.writeFileSync(cfgPath, fixed);
    } catch (e) { log(p.id, 'не смог записать config.json:', e.message); return; }
    setTimeout(() => process.exit(0), 500);
  });
  sock.bind(2021, () => { try { sock.setBroadcast(true); sock.addMembership('239.255.255.250'); } catch {} });
}

/* ---------- auto print: the operator presses "Печать" → slice with Bambu Studio → upload to the printer → start ---------- */
const SL = cfg.slicer || {};
const SLICER_EXE = SL.exe || 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe';
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const JOB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobs');
const JOBS = new Map(); // job id → { state, file3mf, ... } while this bridge works on it
const jobPost = (id, body) => post(`/api/bridge/job/${id}`, body).catch((e) => ({ error: e.message }));

// Bambu Studio presets: system ones (bundled + updated) and the user's own; a user preset only stores what differs.
function presetIndex() {
  const roots = [path.join(path.dirname(SLICER_EXE), 'resources', 'profiles', 'BBL'), path.join(APPDATA, 'BambuStudio', 'system', 'BBL')];
  const userRoot = path.join(APPDATA, 'BambuStudio', 'user');
  const idx = { machine: new Map(), process: new Map(), filament: new Map(), user: { machine: new Map(), process: new Map(), filament: new Map() } };
  const walk = (dir, put) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, put); else if (e.name.endsWith('.json')) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.name) put(j, f); } catch {} } } };
  for (const r of roots) for (const t of ['machine', 'process', 'filament']) walk(path.join(r, t), (j) => idx[t].set(j.name, j)); // later root (updated copy) wins
  let users = []; try { users = fs.readdirSync(userRoot); } catch {}
  users.sort((a, b) => (a === 'default') - (b === 'default'));
  for (const u of users) for (const t of ['machine', 'process', 'filament']) walk(path.join(userRoot, u, t), (j) => { if (!idx.user[t].has(j.name)) idx.user[t].set(j.name, j); });
  return idx;
}
function flatten(idx, type, name) {
  const chain = []; let cur = idx.user[type].get(name) || idx[type].get(name), guard = 0;
  if (!cur) throw new Error(`нет профиля «${name}»`);
  while (cur && guard++ < 20) { chain.unshift(cur); const inh = cur.inherits; cur = inh ? (idx.user[type].get(inh) || idx[type].get(inh)) : null; if (inh && !cur) throw new Error(`нет родительского профиля «${inh}»`); }
  const out = {};
  for (const c of chain) Object.assign(out, c);
  out.name = name; out.from = chain.at(-1).from === 'User' ? 'User' : 'system'; out.inherits = chain.at(-1).inherits || '';
  if (!out.type) out.type = type;
  return out;
}
// The filament preset for an AMS tray: the user's own preset for this filament (if any), else Bambu's system one for the A1.
function filamentFor(idx, tray) {
  const machine = SL.machine || 'Bambu Lab A1 0.4 nozzle';
  const ok = (j) => !j.compatible_printers || !j.compatible_printers.length || j.compatible_printers.includes(machine);
  const fid = tray.tray_info_idx;
  const over = (SL.filaments || {})[fid] || (SL.filaments || {})[String(tray.tray_type || '').toUpperCase()];
  if (over) return over;
  let sys = null;
  if (fid) for (const [n, j] of idx.filament) { if (j.instantiation === 'false' || !/@BBL A1$/.test(n)) continue; try { const fl = flatten(idx, 'filament', n); if (fl.filament_id === fid && ok(fl)) { sys = n; break; } } catch {} }
  if (!sys) for (const [n, j] of idx.filament) if (/@BBL A1$/.test(n) && j.instantiation !== 'false' && String(n).toUpperCase().startsWith('GENERIC ' + String(tray.tray_type || 'PLA').toUpperCase() + ' ')) { sys = n; break; }
  if (!sys) throw new Error(`нет профиля пластика для ${tray.tray_type || '?'} (${fid || 'без кода'})`);
  let best = null;
  for (const [n, j] of idx.user.filament) if (j.inherits === sys && j.instantiation !== 'false') { if (!best || (j.updated_time || 0) > (best.updated_time || 0)) best = { ...j, n }; }
  return best ? best.n : sys;
}
const hexRgb = (h) => { const m = String(h || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i); return m ? m.slice(1).map((x) => parseInt(x, 16)) : null; };
const colDist = (a, b) => (a && b ? Math.sqrt(2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2) / 3 : 999);
// Pick the AMS slot with the order's material and the closest colour.
function pickTray(p, mat, color) {
  const want = String(mat || 'PLA').toUpperCase(), rgb = hexRgb(color), trays = [];
  for (const a of p._state?.ams?.ams || []) for (const t of a.tray || []) if (t.tray_type) trays.push({ ...t, slot: +a.id * 4 + +t.id });
  if (!trays.length && p._state?.vt_tray?.tray_type) trays.push({ ...p._state.vt_tray, slot: 254 });
  const exact = trays.filter((t) => String(t.tray_type).toUpperCase() === want);
  const same = exact.length ? exact : trays.filter((t) => String(t.tray_type).toUpperCase().split(/[-\s+]/)[0] === want.split(/[-\s+]/)[0]);
  if (!same.length) throw new Error(`в AMS нет ${want}` + (trays.length ? ` (есть: ${trays.map((t) => t.tray_type).join(', ')})` : ''));
  same.forEach((t) => { t.d = colDist(hexRgb(t.tray_color), rgb); });
  same.sort((a, b) => a.d - b.d);
  if (rgb && same[0].d > (SL.colorTolerance || 70)) throw new Error(`в AMS нет нужного цвета ${color} для ${want} (ближайший слот ${same[0].slot % 4 + 1}: #${String(same[0].tray_color).slice(0, 6)})`);
  return same[0];
}
// Minimal reader for the sliced .3mf (a zip): returns one file's text.
function zipRead(buf, name) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return null;
  let off = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), fl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const fname = buf.toString('utf8', off + 46, off + 46 + fl);
    if (fname === name) { const s0 = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), data = buf.subarray(s0, s0 + csize); return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'); }
    off += 46 + fl + xl + cl;
  }
  return null;
}
function runSlicer(args, cwd) {
  return new Promise((resolve, reject) => {
    const sp = spawn(SLICER_EXE, args, { cwd, windowsHide: true }); let out = '';
    const t = setTimeout(() => sp.kill('SIGKILL'), (SL.timeoutMin || 15) * 60e3);
    sp.stdout?.on('data', (d) => { out = (out + d).slice(-2000); }); sp.stderr?.on('data', (d) => { out = (out + d).slice(-2000); });
    sp.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    sp.on('error', (e) => { clearTimeout(t); reject(new Error('Bambu Studio не запустился: ' + e.message)); });
  });
}
async function slice(job, p, tray, dir, model) {
  const idx = presetIndex();
  const machine = SL.machine || 'Bambu Lab A1 0.4 nozzle', proc = SL.process || '0.20mm Standard @BBL A1', fil = filamentFor(idx, tray);
  const m = flatten(idx, 'machine', machine), pr = flatten(idx, 'process', proc), f = flatten(idx, 'filament', fil);
  if (SL.supports !== 'off') { pr.enable_support = '1'; pr.support_type = pr.support_type && /tree|normal/.test(pr.support_type) && /auto/.test(pr.support_type) ? pr.support_type : 'tree(auto)'; }
  pr.curr_bed_type = SL.bedType || 'Textured PEI Plate';
  const files = { m: path.join(dir, 'machine.json'), p: path.join(dir, 'process.json'), f: path.join(dir, 'filament.json') };
  fs.writeFileSync(files.m, JSON.stringify(m)); fs.writeFileSync(files.p, JSON.stringify(pr)); fs.writeFileSync(files.f, JSON.stringify(f));
  const out = path.join(dir, 'out'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const name = `${job.order}.3mf`;
  const args = ['--orient', String(SL.orient ?? 0), '--arrange', '1', ...(job.qty > 1 ? ['--repetitions', String(job.qty)] : []),
    '--load-settings', `${files.m};${files.p}`, '--load-filaments', files.f, '--slice', '0', '--outputdir', out, '--export-3mf', name, model];
  log(p.id, `автопечать ${job.order}: нарезаю (${proc}, ${fil})…`);
  const r = await runSlicer(args, dir);
  let res = {}; try { res = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8')); } catch {}
  const f3 = path.join(out, name);
  if (r.code !== 0 || res.return_code || !fs.existsSync(f3)) throw new Error(`слайсер: ${res.error_string || 'ошибка ' + (res.return_code ?? r.code)}${res.sliced_plates?.[0]?.warning_message ? ' · ' + res.sliced_plates[0].warning_message : ''}`);
  const buf = fs.readFileSync(f3), info = zipRead(buf, 'Metadata/slice_info.config') || '';
  const meta = (k) => { const mm = info.match(new RegExp(`key="${k}" value="([^"]*)"`)); return mm ? mm[1] : null; };
  const grams = +meta('weight') || +((info.match(/used_g="([\d.]+)"/) || [])[1]) || 0, sec = +meta('prediction') || res.sliced_plates?.[0]?.total_predication || 0;
  return { file: f3, name, grams: Math.round(grams * 10) / 10, minutes: Math.round(sec / 60), md5: crypto.createHash('md5').update(buf).digest('hex').toUpperCase(), process: proc, filament: fil };
}
// Implicit FTPS (port 990) to the printer's storage, as Bambu Studio does in LAN mode.
function ftpsUpload(p, local, remote) {
  return new Promise((resolve, reject) => {
    const ctl = tls.connect({ host: p.ip, port: p.ftpPort || 990, rejectUnauthorized: false, timeout: 20000 });
    let buf = '', step = 0, done = false;
    const fail = (e) => { if (done) return; done = true; try { ctl.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const send = (c) => ctl.write(c + '\r\n');
    const cmds = [['USER bblp', /^331|^230/], ['PASS ' + p.accessCode, /^230/], ['PBSZ 0', /^200/], ['PROT P', /^200/], ['TYPE I', /^200/], ['PASV', /^227/]];
    ctl.on('timeout', () => fail(new Error('FTP: нет ответа')));
    ctl.on('error', fail);
    ctl.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (/^\d{3}-/.test(line) || !/^\d{3}/.test(line)) continue;
        if (step === 0) { if (!/^220/.test(line)) return fail(new Error('FTP: ' + line)); send(cmds[0][0]); step = 1; continue; }
        if (step <= cmds.length) {
          if (!cmds[step - 1][1].test(line)) return fail(new Error('FTP: ' + line.replace(p.accessCode, '***')));
          if (step < cmds.length) { send(cmds[step][0]); step++; continue; }
          const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/); if (!m) return fail(new Error('FTP PASV: ' + line));
          const port = +m[5] * 256 + +m[6];
          const data = tls.connect({ host: p.ip, port, rejectUnauthorized: false, session: ctl.getSession(), timeout: 60000 });
          data.on('error', fail); data.on('timeout', () => fail(new Error('FTP: передача зависла')));
          data.on('secureConnect', () => { send('STOR ' + remote); step = cmds.length + 1; });
          ctl._data = data; continue;
        }
        if (step === cmds.length + 1) { // 150 → send the file
          if (!/^1\d\d/.test(line)) return fail(new Error('FTP STOR: ' + line));
          fs.createReadStream(local).pipe(ctl._data); step++; continue;
        }
        if (step === cmds.length + 2) { if (!/^226/.test(line)) return fail(new Error('FTP: ' + line)); done = true; send('QUIT'); ctl.end(); return resolve(); }
      }
    });
  });
}
const IDLE_STATES = ['IDLE', 'FINISH', 'FAILED', ''];
async function autoJob(jb) {
  const p = (cfg.printers || []).find((x) => x.id === jb.pid);
  const cur = JOBS.get(jb.id);
  if (!p) return;
  if (cur && (cur.busy || cur.state === 'printing' || cur.state === 'error')) return;
  if (jb.status === 'go' && cur?.sliced) return startJob(jb, p, cur);
  if (cur || !['new', 'go'].includes(jb.status)) return;
  if (p.type === 'bambu' && p._send && !p._state?.gcode_state) return; // status from the printer not received yet: try on the next poll // 'go' without a sliced file: the bridge was restarted, slice again
  const st = { busy: true, state: 'taken' }; JOBS.set(jb.id, st);
  const fail = async (e) => { st.state = 'error'; st.busy = false; log(p.id, `автопечать ${jb.order}: ${e.message}`); await jobPost(jb.id, { state: 'error', msg: e.message }); };
  try {
    if (p.type !== 'bambu' || !p._send) throw new Error('этот принтер не подключён к мосту по сети');
    if (!IDLE_STATES.includes(p._state?.gcode_state || '')) throw new Error(`принтер занят (${p._state?.gcode_state})`);
    if (!hasSlicer()) throw new Error(`не найден Bambu Studio: ${SLICER_EXE}`);
    const tray = pickTray(p, jb.mat, jb.color);
    await jobPost(jb.id, { state: 'slicing', msg: `слот AMS ${tray.slot === 254 ? 'внешняя катушка' : tray.slot % 4 + 1}, ${tray.tray_type} #${String(tray.tray_color).slice(0, 6)}` });
    const dir = path.join(JOB_DIR, String(jb.id)); fs.mkdirSync(dir, { recursive: true });
    const r = await fetch(`${SERVER}/api/bridge/jobfile/${jb.id}`, { headers: { authorization: `Bearer ${KEY}` } });
    if (!r.ok) throw new Error(`не скачал файл модели (${r.status})`);
    const ext = (String(jb.file || '').match(/\.(stl|3mf|obj|step|stp)$/i) || ['', 'stl'])[1].toLowerCase();
    const model = path.join(dir, 'model.' + ext); fs.writeFileSync(model, Buffer.from(await r.arrayBuffer()));
    const s = await slice(jb, p, tray, dir, model);
    Object.assign(st, { sliced: s, tray });
    const ans = await jobPost(jb.id, { state: 'sliced', grams: s.grams, minutes: s.minutes, msg: `${s.process} · ${s.filament}` });
    st.busy = false;
    if (ans?.go) return startJob(jb, p, st);
    st.state = 'hold'; log(p.id, `автопечать ${jb.order}: жду решения оператора (вес ${s.grams} г)`);
  } catch (e) { await fail(e); }
}
async function startJob(jb, p, st) {
  if (st.busy) return; st.busy = true;
  try {
    if (!IDLE_STATES.includes(p._state?.gcode_state || '')) throw new Error(`принтер занят (${p._state?.gcode_state})`);
    const s = st.sliced, remote = s.name;
    await jobPost(jb.id, { state: 'uploading' });
    log(p.id, `автопечать ${jb.order}: отправляю на принтер…`);
    await ftpsUpload(p, s.file, remote);
    const slot = st.tray.slot;
    await p._send({ print: { sequence_id: String(Date.now() % 1e8), command: 'project_file', param: 'Metadata/plate_1.gcode', project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0',
      subtask_name: jb.order, file: remote, url: `ftp:///${remote}`, md5: s.md5, timelapse: false, bed_type: 'auto', bed_levelling: true, bed_leveling: true,
      flow_cali: false, vibration_cali: true, layer_inspect: false, use_ams: slot !== 254, ams_mapping: [slot === 254 ? 254 : slot] } });
    // wait until the printer really starts this job
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await new Promise((r) => setTimeout(r, 3000));
      const g = p._state?.gcode_state;
      if (['PREPARE', 'RUNNING'].includes(g)) { st.state = 'printing'; await jobPost(jb.id, { state: 'printing' }); log(p.id, `автопечать ${jb.order}: печать началась`); fs.rmSync(path.join(JOB_DIR, String(jb.id)), { recursive: true, force: true }); return; }
      if (g === 'FAILED' && p._state?.print_error) throw new Error(`принтер отказал: ошибка ${p._state.print_error}`);
    }
    throw new Error('принтер не начал печать за 2 минуты (включён ли режим разработчика в LAN?)');
  } catch (e) { st.state = 'error'; log(p.id, `автопечать ${jb.order}: ${e.message}`); await jobPost(jb.id, { state: 'error', msg: e.message }); }
  finally { st.busy = false; }
}
const hasSlicer = () => fs.existsSync(SLICER_EXE);

/* ---------- timelapse: a frame per layer while printing → MP4 after the print → server (Telegram) ---------- */
const TL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'timelapses');
// Nov 2026 the A1 ids were swapped to match the names (a1-1 = A1 .107, a1-2 = A2 .111). Recordings on disk are named
// by id, so rename them once — a print that was being recorded keeps its timelapse after the restart.
try {
  const mark = path.join(TL_DIR, '.a1-ids-swapped');
  if (fs.existsSync(TL_DIR) && !fs.existsSync(mark)) {
    const ents = fs.readdirSync(TL_DIR).filter((f) => /^a1-[12]_/.test(f));
    for (const f of ents) fs.renameSync(path.join(TL_DIR, f), path.join(TL_DIR, '__' + f));
    for (const f of ents) fs.renameSync(path.join(TL_DIR, '__' + f), path.join(TL_DIR, f.replace(/^a1-([12])_/, (m, n) => `a1-${n === '1' ? '2' : '1'}_`)));
    fs.writeFileSync(mark, new Date().toISOString());
    if (ents.length) console.log('Таймлапсы: переименовал записи под новые номера принтеров (' + ents.length + ')');
  } else if (!fs.existsSync(TL_DIR)) { fs.mkdirSync(TL_DIR, { recursive: true }); fs.writeFileSync(mark, new Date().toISOString()); }
} catch (e) { console.log('Таймлапсы: не смог переименовать записи:', e.message); }
const TL_EVERY_MS = (cfg.timelapseSeconds || 8) * 1000; // fallback when the printer reports no layers
const TL_SHORT_MIN = cfg.timelapseShortMinutes || 45, TL_SHORT_FRAMES = cfg.timelapseShortFrames || 240;
const TL_MAX_FRAMES = 1500, TL_KEEP_DAYS = cfg.timelapseKeepDays || 30;
const stamp = (t) => { const d = new Date(t), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}`; };
function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', ...args]); let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'ffmpeg ' + c))));
    ff.on('error', reject);
  });
}
function timelapse(p) {
  if (!hasFfmpeg()) { log(p.id, 'таймлапс: нужен ffmpeg (winget install Gyan.FFmpeg)'); return; }
  fs.mkdirSync(TL_DIR, { recursive: true });
  let sess = null, latest = null, grabbing = false, offSince = 0;
  const S = () => camState(p) || {};
  const printing = () => PRINTING.includes(S().gcode_state) || BUSY.has(p.id);
  const running = () => S().gcode_state ? S().gcode_state === 'RUNNING' && (S().layer_num || 0) > 0 || (S().gcode_state === 'RUNNING' && !CAMFOR[p.id]) : BUSY.has(p.id);
  const save = (img) => {
    if (!sess || !img) return;
    if (sess.n >= TL_MAX_FRAMES) { // very long print: keep every second frame and carry on
      const files = fs.readdirSync(sess.dir).filter((f) => f.endsWith('.jpg')).sort();
      files.forEach((f, i) => { if (i % 2) fs.rmSync(path.join(sess.dir, f)); });
      files.filter((_, i) => !(i % 2)).forEach((f, i) => fs.renameSync(path.join(sess.dir, f), path.join(sess.dir, `f${String(i).padStart(6, '0')}.jpg`)));
      sess.n = Math.ceil(files.length / 2); sess.every *= 2;
    }
    fs.writeFileSync(path.join(sess.dir, `f${String(sess.n++).padStart(6, '0')}.jpg`), img);
    sess.lastAt = Date.now(); fs.writeFileSync(path.join(sess.dir, 'meta.json'), JSON.stringify({ ...sess, dir: undefined }));
  };
  const grab = async () => {
    if (grabbing) return; grabbing = true;
    try {
      if (p.video) save(await ffmpegSnapshot(p.video, [rotFilter(p), "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'"].filter(Boolean).join(',')));
      else save(latest);
    } catch (e) { log(p.id, 'таймлапс: кадр не снят:', e.message); }
    grabbing = false;
  };
  p._tl = { feed: (img) => { latest = img; } };
  const begin = () => {
    const task = S().subtask_name || '', t = Date.now();
    // the bridge was restarted mid-print: continue the unfinished recording of the same job
    for (const d of fs.readdirSync(TL_DIR)) {
      const mp = path.join(TL_DIR, d, 'meta.json');
      if (!d.startsWith(p.id + '_') || !fs.existsSync(mp)) continue;
      try { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (m.task === task && t - m.lastAt < 30 * 60e3) { sess = { ...m, dir: path.join(TL_DIR, d) }; log(p.id, `таймлапс: продолжаю запись (${m.n} кадров)`); return; } } catch {}
    }
    sess = { dir: path.join(TL_DIR, `${p.id}_${stamp(t)}`), n: 0, started: t, lastAt: 0, lastLayer: -1, task, order: ORDERS[p.id] || null, every: 1 };
    fs.mkdirSync(sess.dir, { recursive: true });
    log(p.id, 'таймлапс: запись началась' + (task ? ` (${task})` : ''));
  };
  const finish = async (state) => {
    const s0 = sess; sess = null; if (!s0) return;
    // a last look at the finished part once the head has moved away
    if (state === 'FINISH') {
      await new Promise((r) => setTimeout(r, 8000)); sess = s0; await grab(); sess = null;
      // …and send that frame to the order, so operators see how the print ended without opening the camera
      const lastF = path.join(s0.dir, `f${String(s0.n - 1).padStart(6, '0')}.jpg`);
      if (s0.n > 0 && fs.existsSync(lastF)) fetch(`${SERVER}/api/bridge/shot/${p.id}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'image/jpeg', 'x-order': s0.order || ORDERS[p.id] || '' }, body: fs.readFileSync(lastF) })
        .then(async (r) => { const j = await r.json().catch(() => ({})); if (r.ok && j.order) log(p.id, `кадр конца печати отправлен к заказу ${j.order}`); else if (!r.ok) log(p.id, `кадр конца печати: сервер ответил ${r.status}`); }).catch((e) => log(p.id, 'кадр конца печати не отправлен:', e.message));
    }
    if (s0.n < 15) { log(p.id, `таймлапс: слишком мало кадров (${s0.n}), ролик не собираю`); fs.rmSync(s0.dir, { recursive: true, force: true }); return; }
    const fps = Math.max(12, Math.min(30, Math.round(s0.n / 15)));
    const name = `${p.id}_${stamp(s0.started)}${s0.order ? '_' + s0.order : ''}`, out = path.join(TL_DIR, name + '.mp4');
    const vf = [!p.video && rotFilter(p), "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'", 'format=yuv420p', 'tpad=stop_mode=clone:stop_duration=2'].filter(Boolean).join(',');
    try {
      log(p.id, `таймлапс: собираю ролик из ${s0.n} кадров…`);
      await ffmpegRun(['-framerate', String(fps), '-i', path.join(s0.dir, 'f%06d.jpg'), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'main', '-movflags', '+faststart', out]);
      const last = path.join(s0.dir, `f${String(s0.n - 1).padStart(6, '0')}.jpg`);
      await ffmpegRun(['-i', last, '-vf', [!p.video && rotFilter(p), 'scale=320:-2'].filter(Boolean).join(','), '-q:v', '5', path.join(TL_DIR, name + '.jpg')]).catch(() => {});
      fs.writeFileSync(path.join(TL_DIR, name + '.pending.json'), JSON.stringify({ pid: p.id, order: s0.order || ORDERS[p.id] || null, started: s0.started, ended: Date.now(), state, task: s0.task, dur: s0.n / fps + 2 }));
      fs.rmSync(s0.dir, { recursive: true, force: true });
      log(p.id, `таймлапс готов: ${out}`);
      tlUploadPending();
    } catch (e) { log(p.id, 'таймлапс: ffmpeg не собрал ролик:', e.message, '— кадры оставлены в', s0.dir); }
  };
  setInterval(() => {
    const st = S().gcode_state;
    if (printing()) {
      offSince = 0;
      if (!sess) begin();
      if (sess && !sess.order && ORDERS[p.id]) sess.order = ORDERS[p.id];
      if (!running()) return;
      const layer = S().layer_num;
      // Short prints have few layers, so one frame per layer looks jerky: for a print under ~45 min we also take frames
      // by time, aiming at ~TL_SHORT_FRAMES frames over the whole print (but not more often than every 3 s).
      const left = +S().mc_remaining_time || 0, total = (Date.now() - sess.started) / 60e3 + left;
      const every = left > 0 && total <= TL_SHORT_MIN ? Math.max(3000, (total * 60e3) / TL_SHORT_FRAMES) : 0;
      if (layer > 0 && layer !== sess.lastLayer && (layer % sess.every === 0 || layer - sess.lastLayer >= sess.every)) { sess.lastLayer = layer; grab(); }
      else if (every && Date.now() - sess.lastAt >= every) grab();
      else if (!(layer > 0) && Date.now() - sess.lastAt >= TL_EVERY_MS * sess.every) grab();
    } else if (sess) {
      if (['FINISH', 'FAILED'].includes(st)) finish(st);
      else if (!offSince) offSince = Date.now();
      else if (Date.now() - offSince > 60000) finish(st === 'IDLE' || !st ? 'FINISH' : st);
    }
  }, 1500);
}
let tlUploading = false;
async function tlUploadPending() {
  if (tlUploading || !fs.existsSync(TL_DIR)) return; tlUploading = true;
  try {
    for (const f of fs.readdirSync(TL_DIR).filter((x) => x.endsWith('.pending.json')).sort()) {
      const base = f.slice(0, -'.pending.json'.length), mp4 = path.join(TL_DIR, base + '.mp4'), jpg = path.join(TL_DIR, base + '.jpg');
      const meta = JSON.parse(fs.readFileSync(path.join(TL_DIR, f), 'utf8'));
      if (!fs.existsSync(mp4)) { fs.rmSync(path.join(TL_DIR, f)); continue; }
      const fd = new FormData();
      for (const [k, v] of Object.entries(meta)) if (v !== null && v !== undefined && k !== 'pid') fd.append(k, String(v));
      fd.append('video', new Blob([fs.readFileSync(mp4)], { type: 'video/mp4' }), base + '.mp4');
      if (fs.existsSync(jpg)) fd.append('poster', new Blob([fs.readFileSync(jpg)], { type: 'image/jpeg' }), base + '.jpg');
      try {
        const r = await fetch(`${SERVER}/api/bridge/tl/${meta.pid}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { log(meta.pid, `таймлапс: сервер не принял (${r.status}${j.error ? ' ' + j.error : ''}), попробую позже`); continue; }
        fs.renameSync(path.join(TL_DIR, f), path.join(TL_DIR, base + '.sent.json'));
        log(meta.pid, `таймлапс отправлен${j.order ? ' к заказу ' + j.order : ''}`);
      } catch (e) { log(meta.pid, 'таймлапс: не отправил:', e.message); }
    }
  } finally { tlUploading = false; }
}
function tlCleanup() {
  if (!fs.existsSync(TL_DIR)) return;
  const old = Date.now() - TL_KEEP_DAYS * 864e5;
  for (const f of fs.readdirSync(TL_DIR)) {
    const fp = path.join(TL_DIR, f);
    try { const st = fs.statSync(fp); if (st.isFile() && st.mtimeMs < old && !f.endsWith('.pending.json')) fs.rmSync(fp); } catch {}
  }
}

/* ---------- start ---------- */
console.log(`Start3D мост → ${SERVER}`);
watchPrinterIps();
pollBusy(); setInterval(pollBusy, 10000); // each request counts against the Cloudflare daily limit
for (const p of cfg.printers || []) {
  if (!p.id || (!p.ip && !p.video)) continue;
  log(p.id, [p.ip && `${p.type || 'bambu'} ${p.ip}`, p.video && 'видеокамера'].filter(Boolean).join(' + '));
  if (p.ip && p.type === 'bambu') bambuStatus(p);
  if (p.ip && p.type === 'creality') crealityStatus(p);
  if (p.video) videoStreamer(p);
  // a printer with a separate video camera uses only that camera (stills too); the built-in one is ignored
  if (p.video) p.rtsp = p.video;
  if (p.timelapse !== false && p.camera !== 'off' && (p.type === 'bambu' || p.rtsp)) timelapse(p); // needs a camera of its own
  camera(p);
}
setInterval(tlUploadPending, 60000); setTimeout(tlUploadPending, 5000); tlCleanup();
