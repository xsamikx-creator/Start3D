// Start3D workshop bridge.
// Reads print status and camera frames from printers on the local network
// and sends them to the Start3D server. Run: node bridge.mjs
import fs from 'node:fs';
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

const FAST_MS = 2500;   // frame interval while someone watches
const SLOW_MS = 60000;  // otherwise
const log = (id, ...a) => console.log(new Date().toLocaleTimeString(), `[${id}]`, ...a);

async function post(path, body, type = 'application/json') {
  const r = await fetch(SERVER + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });
  if (r.status === 403) throw new Error('сервер отклонил ключ: проверьте bridgeKey и BRIDGE_KEY в Cloudflare');
  if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
  return r.json();
}

/* ---------- Bambu Lab: status over MQTT ---------- */
function bambuStatus(p) {
  const state = {};
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

function camera(p) {
  if (p.camera === 'off') return;
  let latest = null, sentAt = 0, watched = false, mode = null;
  const send = async () => {
    if (!latest || Date.now() - sentAt < (watched ? FAST_MS : SLOW_MS)) return;
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
      try { latest = await ffmpegSnapshot(rtspUrl); } catch (e) { log(p.id, 'камера ffmpeg:', e.message); }
      setTimeout(loop, watched ? FAST_MS : 20000);
    };
    loop();
  };
  if (p.rtsp || p.camera === 'rtsp') return useFfmpeg();
  if (p.type === 'bambu') {
    bambuCamera6000(p, (img) => { if (mode !== '6000') { mode = '6000'; log(p.id, 'камера подключена (порт 6000)'); } latest = img; },
      (e) => { log(p.id, `камера порт 6000 недоступна (${e.message}), пробую RTSPS`); useFfmpeg(); });
  }
}

/* ---------- start ---------- */
console.log(`Start3D мост → ${SERVER}`);
for (const p of cfg.printers || []) {
  if (!p.id || !p.ip) continue;
  log(p.id, `${p.type} ${p.ip}`);
  if (p.type === 'bambu') bambuStatus(p);
  camera(p);
}
