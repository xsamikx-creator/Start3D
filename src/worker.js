// Start3D server: site assets + order API + Telegram bot webhook.
// Runs on Cloudflare Workers with a D1 database bound as DB.
//
// Secrets (Workers → Settings → Variables and Secrets):
//   BOT_TOKEN       — token from @BotFather
//   WEBHOOK_SECRET  — any long random string, protects /tg/webhook and /tg/setup
// Variables (wrangler.jsonc "vars"):
//   BOT_USERNAME    — bot username without @
//   ADMIN_TG_ID     — Telegram user ID of the owner (who may bind the operator chat)
//   CARD_TEXT       — card details shown to clients for the 50% deposit
//   DEPOSIT_PCT     — deposit percent

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY, code TEXT NOT NULL, status TEXT NOT NULL,
     client TEXT NOT NULL, contact TEXT, ch TEXT, email TEXT, lang TEXT,
     tg_chat_id INTEGER, op_msg_id INTEGER,
     price INTEGER, lo INTEGER, hi INTEGER, reason TEXT,
     data TEXT, created_at INTEGER, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS orders_chat ON orders(tg_chat_id)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
];
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const now = () => Date.now();
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const LANGS = ['az', 'ru', 'uk', 'en'];

/* ---------- bot texts [az, ru, uk, en] ---------- */
const TX = {
  hello: ['Salam! Bu Start3D botudur. Sifarişinizin statusları bura gələcək.\nSizin Telegram ID: {id}', 'Привет! Это бот Start3D. Сюда будут приходить статусы ваших заказов.\nВаш Telegram ID: {id}', 'Привіт! Це бот Start3D. Сюди надходитимуть статуси ваших замовлень.\nВаш Telegram ID: {id}', 'Hi! This is the Start3D bot. Your order updates will arrive here.\nYour Telegram ID: {id}'],
  linked: ['✅ Bot {id} sifarişinə qoşuldu. Hazırkı status: {st}.', '✅ Бот подключён к заказу {id}. Сейчас: {st}.', '✅ Бот підключено до замовлення {id}. Зараз: {st}.', '✅ The bot is linked to order {id}. Current status: {st}.'],
  bad_link: ['Bu link köhnədir və ya səhvdir. Sifariş səhifəsindən yenidən açın.', 'Ссылка устарела или неверна. Откройте её заново со страницы заказа.', 'Посилання застаріле або неправильне. Відкрийте його знову зі сторінки замовлення.', 'This link is outdated or wrong. Open it again from your order page.'],
  confirmed: ['💬 {id}: qiymət {p} AZN.\nÇapa başlamaq üçün {d} AZN köçürün:\n{card}\nTəyinatda yazın: {id}\nKöçürdükdən sonra çekin şəklini bura göndərin.', '💬 {id}: цена {p} AZN.\nЧтобы начать печать, переведите {d} AZN:\n{card}\nВ назначении укажите: {id}\nПосле перевода пришлите сюда фото чека.', '💬 {id}: ціна {p} AZN.\nЩоб почати друк, переказуйте {d} AZN:\n{card}\nУ призначенні вкажіть: {id}\nПісля переказу надішліть сюди фото чека.', '💬 {id}: price {p} AZN.\nTo start printing, transfer {d} AZN:\n{card}\nReference: {id}\nThen send a photo of the receipt here.'],
  receipt_ok: ['🧾 Çek alındı, operator yoxlayır.', '🧾 Чек получен, оператор проверяет.', '🧾 Чек отримано, оператор перевіряє.', '🧾 Receipt received; the operator is checking it.'],
  no_pay: ['Ödəniş gözləyən sifariş tapılmadı.', 'Не нашёл заказа, который ждёт оплаты.', 'Не знайшов замовлення, яке чекає оплати.', 'No order is waiting for payment.'],
  paid: ['✅ {id}: ödəniş alındı, sifariş növbədədir.', '✅ {id}: оплата получена, заказ в очереди.', '✅ {id}: оплату отримано, замовлення в черзі.', '✅ {id}: payment received, your order is queued.'],
  printing: ['🖨 {id}: çap başladı! Canlı baxın: {link}', '🖨 {id}: печать началась! Смотрите вживую: {link}', '🖨 {id}: друк почався! Дивіться наживо: {link}', '🖨 {id}: printing started! Watch live: {link}'],
  ready: ['📦 {id} hazırdır! Təhvil zamanı qalıq: {r} AZN.', '📦 {id} готов! Остаток при получении: {r} AZN.', '📦 {id} готове! Залишок під час отримання: {r} AZN.', '📦 {id} is ready! Balance on collection: {r} AZN.'],
  done: ['🙏 {id} təhvil verildi. Təşəkkür edirik!', '🙏 {id} выдан. Спасибо!', '🙏 {id} видано. Дякуємо!', '🙏 {id} collected. Thank you!'],
  rejected: ['❌ {id} rədd edildi: {w}.', '❌ {id} отклонён: {w}.', '❌ {id} відхилено: {w}.', '❌ {id} rejected: {w}.'],
  hello_hint: ['Sifarişi qoşmaq üçün sifariş səhifəsindəki düyməni basın və ya mənə sifariş kodunu göndərin, məsələn: S3D-1032 abc123', 'Чтобы подключить заказ, нажмите кнопку на странице заказа или пришлите мне код заказа, например: S3D-1032 abc123', 'Щоб підключити замовлення, натисніть кнопку на сторінці замовлення або надішліть мені код, наприклад: S3D-1032 abc123', 'To link an order, press the button on the order page or send me the order code, e.g. S3D-1032 abc123'],
  ready_photo: ['📦 {id} hazırdır! Budur hazır detal. Təhvil zamanı qalıq: {r} AZN.', '📦 {id} готов! Вот ваша деталь. Остаток при получении: {r} AZN.', '📦 {id} готове! Ось ваша деталь. Залишок під час отримання: {r} AZN.', '📦 {id} is ready! Here is your part. Balance on collection: {r} AZN.'],
  none: ['Hələ sifarişiniz yoxdur.', 'Заказов пока нет.', 'Замовлень поки немає.', 'No orders yet.'],
  open: ['Sifarişi aç', 'Открыть заказ', 'Відкрити замовлення', 'Open order'],
  st_review: ['yoxlamada', 'на проверке', 'на перевірці', 'in review'],
  st_pay: ['ödəniş gözləyir', 'ждёт оплаты', 'чекає оплати', 'awaiting payment'],
  st_paycheck: ['ödəniş yoxlanır', 'проверка оплаты', 'перевірка оплати', 'checking payment'],
  st_queue: ['növbədə', 'в очереди', 'у черзі', 'queued'],
  st_printing: ['çap olunur', 'печатается', 'друкується', 'printing'],
  st_post: ['emal', 'постобработка', 'обробка', 'finishing'],
  st_ready: ['hazır', 'готов', 'готове', 'ready'],
  st_done: ['təhvil verildi', 'выдан', 'видано', 'collected'],
  st_rejected: ['rədd edildi', 'отклонён', 'відхилено', 'rejected'],
  rj_geo: ['model çapa yararsızdır', 'модель непригодна для печати', 'модель непридатна для друку', 'model is not printable'],
};
const tx = (k, lang, v = {}) => {
  let s = (TX[k] || [k])[Math.max(0, LANGS.indexOf(lang))] ?? TX[k][1];
  for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(b);
  return s;
};
const langOf = (code) => (LANGS.includes((code || '').slice(0, 2)) ? code.slice(0, 2) : 'ru');

/* ---------- Telegram API ---------- */
async function tg(env, method, body) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is not set' };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false }));
}
async function kvGet(env, k) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? r.v : null; }
async function kvSet(env, k, v) { await env.DB.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run(); }

const deposit = (env, price) => Math.round((price * (Number(env.DEPOSIT_PCT) || 50)) / 100);
const orderUrl = (origin, o) => `${origin}/#track-${o.id}-${o.code}`;

async function getOrder(env, id) { return env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first(); }
async function setStatus(env, id, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE orders SET ${keys.map((k) => k + '=?').join(', ')}, updated_at=? WHERE id=?`)
    .bind(...keys.map((k) => fields[k]), now(), id).run();
  return getOrder(env, id);
}

async function notifyClient(env, origin, o, key, extra = {}) {
  if (!o.tg_chat_id) return;
  const rest = o.price ? o.price - deposit(env, o.price) : 0;
  const text = tx(key, o.lang, {
    id: o.id, p: o.price ?? '', d: o.price ? deposit(env, o.price) : '', r: rest,
    card: env.CARD_TEXT || '(реквизиты уточнит оператор)', link: orderUrl(origin, o), ...extra,
  });
  await tg(env, 'sendMessage', {
    chat_id: o.tg_chat_id, text,
    reply_markup: { inline_keyboard: [[{ text: tx('open', o.lang), url: orderUrl(origin, o) }]] },
  });
}

/* ---------- operator chat ---------- */
function opText(o) {
  const d = JSON.parse(o.data || '{}');
  const price = o.price ? `${o.price} AZN` : o.lo ? `${o.lo}–${o.hi} AZN (расчёт)` : 'считает оператор';
  return [
    `<b>${esc(o.id)}</b> · ${esc(statusRu(o.status))}`,
    `${esc(d.name || '—')} · ${esc(d.mat || '')} ${esc(d.colorName || '')} · ${d.qty || 1} шт.`,
    d.grams ? `≈ ${Math.round(d.grams)} г · ≈ ${(d.hours || 0).toFixed(1)} ч` : '',
    d.check ? `Проверка: ${esc(d.check)}` : '',
    d.comment ? `Комментарий: «${esc(d.comment)}»` : '',
    `Клиент: ${esc(o.client)} · ${esc(o.contact || '')}`,
    `Уведомления: ${o.ch === 'email' ? 'email ' + esc(o.email || '') : o.tg_chat_id ? 'Telegram ✓' : 'Telegram (бот ещё не подключён)'}`,
    `Цена: <b>${price}</b>`,
    o.reason ? `Причина отказа: ${esc(o.reason)}` : '',
  ].filter(Boolean).join('\n');
}
const STATUS_RU = { review: 'ждёт проверки', pay: 'ждёт оплаты', paycheck: 'проверить оплату', queue: 'в очереди', printing: 'печатается', post: 'постобработка', ready: 'готов к выдаче', done: 'выдан', rejected: 'отклонён' };
const statusRu = (s) => STATUS_RU[s] || s;
function opButtons(o) {
  const b = (text, data) => ({ text, callback_data: `${data}:${o.id}` });
  const p = o.price || (o.lo ? Math.round((o.lo + o.hi) / 2) : 20);
  switch (o.status) {
    case 'review': return [[b('−2', 'm'), b(`✅ Подтвердить ${p} AZN`, 'c'), b('+2', 'pl')], [b('❌ Отклонить', 'r')]];
    case 'pay': case 'paycheck': return [[b('💰 Оплата получена', 'p')]];
    case 'queue': return [[b('🖨 Печать началась', 's')]];
    case 'printing': return [[b('📸 Готово — сделать фото', 'd')]];
    case 'post': return [[b('📸 Готово — сделать фото', 'd'), b('Без фото', 'dn')]];
    case 'ready': return [[b('🙏 Выдан', 'g')]];
    default: return [];
  }
}
async function postToOperators(env, o) {
  const chat = await kvGet(env, 'operator_chat');
  if (!chat) return;
  const r = await tg(env, 'sendMessage', { chat_id: Number(chat), text: opText(o), parse_mode: 'HTML', reply_markup: { inline_keyboard: opButtons(o) } });
  if (r.ok) await env.DB.prepare('UPDATE orders SET op_msg_id=? WHERE id=?').bind(r.result.message_id, o.id).run();
}
async function refreshOperatorMsg(env, o) {
  const chat = await kvGet(env, 'operator_chat');
  if (!chat || !o.op_msg_id) return postToOperators(env, o);
  await tg(env, 'editMessageText', { chat_id: Number(chat), message_id: o.op_msg_id, text: opText(o), parse_mode: 'HTML', reply_markup: { inline_keyboard: opButtons(o) } });
}

/* ---------- API ---------- */
async function createOrder(env, req, origin) {
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'bad_json' }, 400);
  const client = clip(b.client, 16), contact = clip(b.contact, 40);
  if (!client) return json({ error: 'need_name' }, 400);
  if (contact.replace(/\D/g, '').length < 7) return json({ error: 'need_contact' }, 400);
  const ch = b.ch === 'email' ? 'email' : 'tg';
  const email = ch === 'email' ? clip(b.email, 120) : null;
  if (ch === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'need_email' }, 400);
  const fixed = Number.isFinite(+b.price) && b.catalog ? Math.round(+b.price) : null;
  const seq = await env.DB.prepare("INSERT INTO kv(k,v) VALUES('seq','1031') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1 RETURNING v").first();
  const id = 'S3D-' + seq.v, code = rnd(6), t = now();
  const data = {
    name: clip(b.name, 80), mat: clip(b.mat, 8), colorName: clip(b.colorName, 20), color: Math.max(0, Math.min(6, +b.color || 0)), layers: Math.max(1, Math.min(5000, +b.layers || 200)), qty: Math.max(1, Math.min(50, +b.qty || 1)),
    grams: +b.grams || 0, hours: +b.hours || 0, check: clip(b.check, 200), comment: clip(b.comment, 500),
    pub: !!b.pub, copy: !!b.copy, gift: b.gift ? clip(b.gift, 16) : null, urgent: !!b.urgent, student: !!b.student,
    deliv: !!b.deliv, kind: b.kind === 'photo' ? 'photo' : 'file', file: clip(b.file, 120),
  };
  await env.DB.prepare(`INSERT INTO orders (id, code, status, client, contact, ch, email, lang, price, lo, hi, data, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, code, fixed ? 'pay' : 'review', client, contact, ch, email, langOf(b.lang), fixed,
    Number.isFinite(+b.lo) ? Math.round(+b.lo) : null, Number.isFinite(+b.hi) ? Math.round(+b.hi) : null,
    JSON.stringify(data), t, t).run();
  const o = await getOrder(env, id);
  await postToOperators(env, o);
  return json({ id, code, status: o.status, bot: env.BOT_USERNAME || null });
}

function publicOrder(env, o) {
  const d = JSON.parse(o.data || '{}');
  return {
    id: o.id, status: o.status, price: o.price, lo: o.lo, hi: o.hi, reason: o.reason,
    deposit: o.price ? deposit(env, o.price) : null, tgLinked: !!o.tg_chat_id, ch: o.ch, updated: o.updated_at,
    name: d.name, mat: d.mat, color: d.color ?? 0, qty: d.qty, layers: d.layers, hours: d.hours, grams: d.grams,
    pub: !!d.pub, client: o.client, created: o.created_at, photos: (d.photos || []).length,
    card: ['pay', 'paycheck'].includes(o.status) ? (env.CARD_TEXT || null) : null,
  };
}
async function readOrder(env, id, code) {
  const o = await getOrder(env, id);
  if (!o || o.code !== code) return json({ error: 'not_found' }, 404);
  return json(publicOrder(env, o));
}
async function orderPhoto(env, id, code, n) {
  const o = await getOrder(env, id);
  if (!o || o.code !== code) return json({ error: 'not_found' }, 404);
  const fileId = (JSON.parse(o.data || '{}').photos || [])[n];
  if (!fileId) return json({ error: 'not_found' }, 404);
  const f = await tg(env, 'getFile', { file_id: fileId });
  if (!f.ok) return json({ error: 'not_found' }, 404);
  const img = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  return new Response(img.body, { headers: { 'content-type': img.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
}

async function clientPaid(env, id, code) {
  const o = await getOrder(env, id);
  if (!o || o.code !== code) return json({ error: 'not_found' }, 404);
  if (o.status !== 'pay') return json(publicOrder(env, o));
  const n = await setStatus(env, id, { status: 'paycheck' });
  await refreshOperatorMsg(env, n);
  return json(publicOrder(env, n));
}

/* ---------- Telegram webhook ---------- */
async function onUpdate(env, u, origin) {
  if (u.callback_query) return onCallback(env, u.callback_query, origin);
  const m = u.message;
  if (!m) return;
  const chat = m.chat, from = m.from || {}, lang = langOf(from.language_code);
  const text = (m.text || '').trim();
  const say = (t, extra = {}) => tg(env, 'sendMessage', { chat_id: chat.id, text: t, ...extra });

  if (/^\/admin(@\w+)?$/.test(text) && chat.type === 'private') {
    const cur = await adminId(env);
    if (cur && String(cur) !== String(from.id)) return say('Владелец уже назначен.');
    if (!cur) await kvSet(env, 'admin', from.id);
    return say('✅ Вы владелец Start3D.\nТеперь создайте группу для операторов, добавьте туда бота и напишите в группе /operator');
  }
  if (/^\/operator(@\w+)?$/.test(text)) {
    if (String(from.id) !== String(await adminId(env))) return say('Только владелец может назначить операторский чат. Сначала напишите боту в личку /admin');
    await kvSet(env, 'operator_chat', chat.id);
    return say('✅ Этот чат теперь операторский. Новые заказы будут приходить сюда.');
  }
  if (/^\/id(@\w+)?$/.test(text)) return say(`Telegram ID: ${from.id}\nChat ID: ${chat.id}`);
  if (chat.type !== 'private') {
    const opChat = await kvGet(env, 'operator_chat');
    if (String(chat.id) !== String(opChat) || !m.photo) return;
    let id = m.reply_to_message ? await kvGet(env, 'photo_wait:' + m.reply_to_message.message_id) : null;
    if (!id) { const c = (m.caption || '').match(/S3D-\d+/i); id = c ? c[0].toUpperCase() : null; }
    if (!id) return;
    return operatorPhoto(env, origin, id, m.photo[m.photo.length - 1].file_id, say);
  }

  if (text.startsWith('/start')) console.log('start', JSON.stringify(text));
  // An order code in any form: "/start S3D-1032_abc123", "S3D-1032 abc123", "S3D-1032-abc123".
  const code = text.match(/(S3D-\d+)[\s_-]+([a-z0-9]{6})\b/i);
  if (code) {
    const o = await getOrder(env, code[1].toUpperCase());
    if (!o || o.code !== code[2].toLowerCase()) return say(tx('bad_link', lang));
    const n = await setStatus(env, o.id, { tg_chat_id: chat.id });
    await refreshOperatorMsg(env, n);
    await say(tx('linked', n.lang, { id: n.id, st: tx('st_' + n.status, n.lang) }),
      { reply_markup: { inline_keyboard: [[{ text: tx('open', n.lang), url: orderUrl(origin, n) }]] } });
    if (n.status === 'pay') await notifyClient(env, origin, n, 'confirmed');
    if (n.status === 'printing') await notifyClient(env, origin, n, 'printing');
    return;
  }
  if (/^\/start/.test(text)) {
    const has = await env.DB.prepare('SELECT COUNT(*) AS c FROM orders WHERE tg_chat_id=?').bind(chat.id).first();
    if (!has.c) return say(tx('hello', lang, { id: from.id }) + '\n\n' + tx('hello_hint', lang));
  }
  if (/^\/(orders|start)/.test(text)) {
    const rs = await env.DB.prepare('SELECT * FROM orders WHERE tg_chat_id=? ORDER BY created_at DESC LIMIT 10').bind(chat.id).all();
    if (!rs.results.length) return say(tx('none', lang));
    return say(rs.results.map((o) => `${o.id} · ${JSON.parse(o.data || '{}').name || ''} — ${tx('st_' + o.status, o.lang)}${o.price ? ` · ${o.price} AZN` : ''}`).join('\n'));
  }
  if (m.photo || m.document) {
    const o = await env.DB.prepare("SELECT * FROM orders WHERE tg_chat_id=? AND status IN ('pay','paycheck') ORDER BY created_at DESC LIMIT 1").bind(chat.id).first();
    if (!o) return say(tx('no_pay', lang));
    const n = await setStatus(env, o.id, { status: 'paycheck' });
    const opChat = await kvGet(env, 'operator_chat');
    if (opChat) {
      await tg(env, 'forwardMessage', { chat_id: Number(opChat), from_chat_id: chat.id, message_id: m.message_id });
      await tg(env, 'sendMessage', { chat_id: Number(opChat), text: `🧾 Чек по ${n.id} от ${n.client}`, reply_markup: { inline_keyboard: [[{ text: '💰 Оплата получена', callback_data: `p:${n.id}` }]] } });
    }
    await refreshOperatorMsg(env, n);
    return say(tx('receipt_ok', n.lang));
  }
  return say(tx('hello', lang, { id: from.id }));
}

async function operatorPhoto(env, origin, id, fileId, say) {
  const o = await getOrder(env, id);
  if (!o) return say('Заказ не найден');
  const d = JSON.parse(o.data || '{}');
  d.photos = (d.photos || []).concat(fileId).slice(-5);
  const first = o.status !== 'ready' && o.status !== 'done';
  const n = await setStatus(env, id, first ? { data: JSON.stringify(d), status: 'ready' } : { data: JSON.stringify(d) });
  if (n.tg_chat_id) {
    const rest = n.price ? n.price - deposit(env, n.price) : 0;
    await tg(env, 'sendPhoto', {
      chat_id: n.tg_chat_id, photo: fileId,
      caption: first ? tx('ready_photo', n.lang, { id: n.id, r: rest }) : n.id,
      reply_markup: first ? { inline_keyboard: [[{ text: tx('open', n.lang), url: orderUrl(origin, n) }]] } : undefined,
    });
  }
  await refreshOperatorMsg(env, n);
  return say(`✅ Фото ${d.photos.length} добавлено к ${n.id}` + (n.tg_chat_id ? ' и отправлено клиенту' : ' (клиент ещё не подключил бота, фото будет видно на сайте)'));
}

async function onCallback(env, q, origin) {
  const [act, id] = String(q.data || '').split(/:(.+)/);
  const opChat = await kvGet(env, 'operator_chat');
  const allowed = (opChat && String(q.message?.chat?.id) === String(opChat)) || String(q.from.id) === String(await adminId(env));
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text });
  if (!allowed) return answer('Нет доступа');
  const o = await getOrder(env, id);
  if (!o) return answer('Заказ не найден');
  const base = o.price || (o.lo ? Math.round((o.lo + o.hi) / 2) : 20);
  let n = o, note = '';
  if (act === 'm' || act === 'pl') {
    if (o.status !== 'review') return answer('Цена уже подтверждена');
    n = await setStatus(env, id, { price: Math.max(1, base + (act === 'm' ? -2 : 2)) });
    n = { ...n, status: 'review' };
    await refreshOperatorMsg(env, n);
    return answer(`Цена: ${n.price} AZN`);
  }
  if (act === 'c' && o.status === 'review') { n = await setStatus(env, id, { status: 'pay', price: base }); await notifyClient(env, origin, n, 'confirmed'); note = 'Цена подтверждена'; }
  else if (act === 'r' && o.status === 'review') { n = await setStatus(env, id, { status: 'rejected', reason: TX.rj_geo[1] }); await notifyClient(env, origin, n, 'rejected', { w: tx('rj_geo', n.lang) }); note = 'Отклонён'; }
  else if (act === 'p' && ['pay', 'paycheck'].includes(o.status)) { n = await setStatus(env, id, { status: 'queue' }); await notifyClient(env, origin, n, 'paid'); note = 'Оплата отмечена'; }
  else if (act === 's' && o.status === 'queue') { n = await setStatus(env, id, { status: 'printing' }); await notifyClient(env, origin, n, 'printing'); note = 'Печать началась'; }
  else if (act === 'd' && ['printing', 'post'].includes(o.status)) {
    n = await setStatus(env, id, { status: 'post' });
    const r = await tg(env, 'sendMessage', { chat_id: q.message.chat.id,
      text: `📸 ${id}: пришлите 1–3 фото готовой детали ОТВЕТОМ на это сообщение (свайп влево по сообщению → фото). Первое фото сразу уйдёт клиенту.`,
      reply_markup: { inline_keyboard: [[{ text: 'Готово без фото', callback_data: `dn:${id}` }]] } });
    if (r.ok) await kvSet(env, 'photo_wait:' + r.result.message_id, id);
    note = 'Жду фото';
  }
  else if (act === 'dn' && ['printing', 'post'].includes(o.status)) { n = await setStatus(env, id, { status: 'ready' }); await notifyClient(env, origin, n, 'ready'); note = 'Готов'; }
  else if (act === 'g' && o.status === 'ready') { n = await setStatus(env, id, { status: 'done' }); await notifyClient(env, origin, n, 'done'); note = 'Выдан'; }
  else return answer('Статус уже изменился');
  await refreshOperatorMsg(env, n);
  return answer(note);
}

// Registers the webhook once per origin, so no manual /tg/setup call is needed.
async function ensureWebhook(env, origin) {
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || origin.includes('localhost')) return;
  if ((await kvGet(env, 'webhook')) === origin) return;
  const r = await tg(env, 'setWebhook', { url: `${origin}/tg/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
  if (!r.ok) return console.error('setWebhook failed', r.description);
  await tg(env, 'setMyCommands', { commands: [
    { command: 'orders', description: 'Мои заказы' },
    { command: 'id', description: 'Мой Telegram ID' },
  ] });
  const me = await tg(env, 'getMe', {});
  if (me.ok) await kvSet(env, 'bot_username', me.result.username);
  await kvSet(env, 'webhook', origin);
}
// Owner: ADMIN_TG_ID var, or the first person who sends /admin to the bot.
async function adminId(env) { return env.ADMIN_TG_ID || (await kvGet(env, 'admin')); }

async function setup(env, origin) {
  const hook = await tg(env, 'setWebhook', {
    url: `${origin}/tg/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
  });
  const cmds = await tg(env, 'setMyCommands', { commands: [
    { command: 'orders', description: 'Мои заказы' },
    { command: 'id', description: 'Мой Telegram ID' },
  ] });
  const me = await tg(env, 'getMe', {});
  return json({ webhook: hook, commands: cmds.ok, bot: me.result ? '@' + me.result.username : me.description, operator_chat: (await kvGet(env, 'operator_chat')) ? 'set' : 'not set' });
}

/* ---------- router ---------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, origin = url.origin;
    if (!p.startsWith('/api/') && !p.startsWith('/tg/')) return env.ASSETS.fetch(req);
    try {
      await init(env);
      ctx.waitUntil(ensureWebhook(env, origin).catch((e) => console.error('webhook', e)));
      if (p === '/api/health') {
        const bot = await kvGet(env, 'bot_username');
        return json({ ok: true, bot: bot || env.BOT_USERNAME || null, tg: !!env.BOT_TOKEN, webhook: (await kvGet(env, 'webhook')) === origin, admin: !!(await adminId(env)), operators: !!(await kvGet(env, 'operator_chat')) });
      }
      if (p === '/api/orders' && req.method === 'POST') return createOrder(env, req, origin);
      let m = p.match(/^\/api\/orders\/(S3D-\d+)$/);
      if (m && req.method === 'GET') return readOrder(env, m[1], url.searchParams.get('code'));
      m = p.match(/^\/api\/orders\/(S3D-\d+)\/photo\/(\d)$/);
      if (m) return orderPhoto(env, m[1], url.searchParams.get('code'), +m[2]);
      m = p.match(/^\/api\/orders\/(S3D-\d+)\/paid$/);
      if (m && req.method === 'POST') return clientPaid(env, m[1], url.searchParams.get('code'));
      if (p === '/tg/setup') {
        if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
        return setup(env, origin);
      }
      if (p === '/tg/webhook' && req.method === 'POST') {
        if (!env.WEBHOOK_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
        const u = await req.json();
        ctx.waitUntil(onUpdate(env, u, origin).catch((e) => console.error('update failed', e)));
        return new Response('ok');
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  },
};
