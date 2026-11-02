// Start3D workshop bridge.
// Reads print status and camera frames from printers on the local network
// and sends them to the Start3D server. Run: node bridge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

const cfgPath = new URL('./config.json', import.meta.url);
if (!fs.existsSync(cfgPath)) {
  console.error('Нет файла config.json. Скопируйте config.example.json в config.json и заполните его.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
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
const ORDERS = {}; // printer id → order printing on it now (from the site)
const ROTATE = {}; // printer id → '0' | 'ccw' | 'cw' | '180' (set from the bot with /rotate, or "rotate" in config.json)
async function pollBusy() {
  try {
    const r = await fetch(SERVER + '/api/bridge/busy', { headers: { authorization: `Bearer ${KEY}` } });
    if (r.ok){ const j = await r.json(); BUSY.clear(); (j.busy || []).forEach((id) => BUSY.add(id)); Object.assign(ROTATE, j.rotate || {}); for (const k of Object.keys(ORDERS)) delete ORDERS[k]; Object.assign(ORDERS, j.orders || {}); }
  } catch {}
}
const rotOf = (p) => ROTATE[p.id] && ROTATE[p.id] !== '0' ? ROTATE[p.id] : (p.rotate || '0');
const rotFilter = (p) => ({ ccw: 'transpose=2', cw: 'transpose=1', '180': 'hflip,vflip' })[rotOf(p)] || '';
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
      // rotate if needed, then fit the long side into videoWidth (portrait keeps the same pixel budget)
      '-vf', [rotFilter(p), `scale='if(gte(iw,ih),min(${p.videoWidth || 1280},iw),-2)':'if(gte(iw,ih),-2,min(${p.videoWidth || 1280},ih))'`, `fps=${p.videoFps || 15}`].filter(Boolean).join(','),
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
  let rotAt = rotOf(p);
  setInterval(() => {
    const want = isPrinting(p);
    if (ff && rotOf(p) !== rotAt) { stopping = true; ff.kill('SIGINT'); log(p.id, 'видео: поворот изменён, перезапускаю запись'); }
    if (!ff) rotAt = rotOf(p);
    if (want) { idle = 0; if (!ff) start(); }
    else if (ff && ++idle > 30) { stopping = true; ff.kill('SIGINT'); log(p.id, 'видео: печати нет, запись остановлена'); }
  }, 2000);
}

/* ---------- timelapse: a frame per layer while printing → MP4 after the print → server (Telegram) ---------- */
const TL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'timelapses');
const TL_EVERY_MS = (cfg.timelapseSeconds || 8) * 1000; // fallback when the printer reports no layers
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
  const printing = () => PRINTING.includes(p._state?.gcode_state) || BUSY.has(p.id);
  const running = () => p._state?.gcode_state ? p._state.gcode_state === 'RUNNING' : BUSY.has(p.id);
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
    const task = p._state?.subtask_name || '', t = Date.now();
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
    if (state === 'FINISH') { await new Promise((r) => setTimeout(r, 8000)); sess = s0; await grab(); sess = null; }
    if (s0.n < 15) { log(p.id, `таймлапс: слишком мало кадров (${s0.n}), ролик не собираю`); fs.rmSync(s0.dir, { recursive: true, force: true }); return; }
    const fps = Math.max(8, Math.min(30, Math.round(s0.n / 15)));
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
    const st = p._state?.gcode_state;
    if (printing()) {
      offSince = 0;
      if (!sess) begin();
      if (sess && !sess.order && ORDERS[p.id]) sess.order = ORDERS[p.id];
      if (!running()) return;
      const layer = p._state?.layer_num;
      if (layer > 0) { if (layer !== sess.lastLayer && (layer % sess.every === 0 || layer - sess.lastLayer >= sess.every)) { sess.lastLayer = layer; grab(); } }
      else if (Date.now() - sess.lastAt >= TL_EVERY_MS * sess.every) grab();
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
pollBusy(); setInterval(pollBusy, 5000);
for (const p of cfg.printers || []) {
  if (!p.id || (!p.ip && !p.video)) continue;
  log(p.id, [p.ip && `${p.type || 'bambu'} ${p.ip}`, p.video && 'видеокамера'].filter(Boolean).join(' + '));
  if (p.ip && p.type === 'bambu') bambuStatus(p);
  if (p.video) videoStreamer(p);
  // a printer with a separate video camera uses only that camera (stills too); the built-in one is ignored
  if (p.video) p.rtsp = p.video;
  if (p.timelapse !== false && p.camera !== 'off') timelapse(p);
  camera(p);
}
setInterval(tlUploadPending, 60000); setTimeout(tlUploadPending, 5000); tlCleanup();
