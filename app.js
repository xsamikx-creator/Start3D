const home = document.querySelector('.hero');
const screen = document.getElementById('screen');
const screenContent = document.getElementById('screenContent');
const backBtn = document.getElementById('backBtn');
const STORAGE_KEY = 'start3d_orders_v1';

const MATERIALS = {
  PLA: { density: 1.24, gram: 0.055, label: 'PLA' },
  PETG: { density: 1.27, gram: 0.065, label: 'PETG' },
  ABS: { density: 1.04, gram: 0.07, label: 'ABS' },
  TPU: { density: 1.21, gram: 0.095, label: 'TPU' }
};

const QUALITY = {
  draft: { label: 'Черновое · 0.28 мм', factor: .82 },
  standard: { label: 'Стандарт · 0.20 мм', factor: 1 },
  fine: { label: 'Детально · 0.12 мм', factor: 1.45 }
};

const STATUS_LABELS = {
  new: 'Новая заявка',
  review: 'Проверка оператором',
  approved: 'Цена подтверждена',
  paid: 'Предоплата получена',
  queued: 'В очереди',
  printing: 'Печатается',
  post: 'Постобработка',
  ready: 'Готово',
  completed: 'Выдано'
};

function getOrders() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function saveOrders(orders) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function upsertOrder(order) {
  const orders = getOrders();
  const i = orders.findIndex(x => x.id === order.id);
  if (i >= 0) orders[i] = order; else orders.unshift(order);
  saveOrders(orders);
}

function money(v) { return `${Number(v || 0).toFixed(2)} AZN`; }
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function fmtDate(v) { return new Date(v).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function makeId() { return `ST-${String(Date.now()).slice(-6)}`; }

function openScreen(name, payload) {
  home.hidden = true;
  screen.hidden = false;
  if (name === 'order') renderOrder();
  if (name === 'my-order') renderMyOrder(payload);
  if (name === 'operator') renderOperator();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-screen]').forEach(btn => btn.addEventListener('click', () => openScreen(btn.dataset.screen)));
backBtn.addEventListener('click', () => { screen.hidden = true; home.hidden = false; screenContent.innerHTML = ''; window.scrollTo({top:0,behavior:'smooth'}); });

function renderOrder() {
  screenContent.innerHTML = `
    <div class="screen-head"><div><p class="eyebrow">NEW ORDER</p><h2>Заказать печать</h2></div><span class="step-pill">01 / расчёт</span></div>
    <div class="work-grid">
      <form class="panel form-panel" id="orderForm">
        <div class="field wide"><label>3D-модель</label><label class="dropzone" id="dropzone"><input id="modelFile" type="file" accept=".stl,.3mf,.obj" hidden><span class="drop-icon">＋</span><b id="fileTitle">Загрузить STL / 3MF / OBJ</b><small id="fileMeta">или нажми сюда для выбора файла</small></label></div>
        <div class="divider"><span>или</span></div>
        <div class="field wide"><label>Ссылка на модель</label><input id="modelLink" type="url" placeholder="MakerWorld / Printables / Thingiverse"></div>
        <div class="field"><label>Материал</label><select id="material"><option>PLA</option><option>PETG</option><option>ABS</option><option>TPU</option></select></div>
        <div class="field"><label>Качество</label><select id="quality"><option value="draft">Черновое · 0.28 мм</option><option value="standard" selected>Стандарт · 0.20 мм</option><option value="fine">Детально · 0.12 мм</option></select></div>
        <div class="field"><label>Цвет</label><input id="color" placeholder="Например: чёрный"></div>
        <div class="field"><label>Количество</label><input id="qty" type="number" min="1" max="100" value="1"></div>
        <div class="field"><label>Имя</label><input id="customerName" required placeholder="Как к вам обращаться"></div>
        <div class="field"><label>Телефон / WhatsApp</label><input id="phone" required placeholder="+994 ..."></div>
        <div class="field wide"><label>Комментарий</label><textarea id="note" rows="3" placeholder="Размер, прочность, срок, особые пожелания"></textarea></div>
        <button class="cta wide" type="submit">Создать заказ <span>→</span></button>
      </form>
      <aside class="panel estimate-panel">
        <p class="eyebrow">LIVE ESTIMATE</p><h3>Ориентировочный расчёт</h3>
        <div class="estimate-price" id="estimatePrice">—</div>
        <p class="estimate-note" id="estimateNote">Загрузи STL, чтобы мы оценили объём, вес и время печати. Для 3MF/OBJ цену проверит оператор.</p>
        <div class="stats"><div><small>Вес</small><b id="estWeight">—</b></div><div><small>Время</small><b id="estTime">—</b></div><div><small>Размер</small><b id="estSize">—</b></div></div>
        <div class="info-box">Это предварительная цена. Финальную стоимость оператор подтверждает после проверки ориентации, поддержек и сложности модели.</div>
      </aside>
    </div>`;

  const file = document.getElementById('modelFile');
  const dropzone = document.getElementById('dropzone');
  const controls = ['material','quality','qty'];
  let analysis = null;

  dropzone.addEventListener('click', () => file.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('drag'); if (e.dataTransfer.files[0]) { file.files = e.dataTransfer.files; handleFile(e.dataTransfer.files[0]); } });
  file.addEventListener('change', () => file.files[0] && handleFile(file.files[0]));
  controls.forEach(id => document.getElementById(id).addEventListener('change', updateEstimate));

  async function handleFile(f) {
    document.getElementById('fileTitle').textContent = f.name;
    document.getElementById('fileMeta').textContent = `${(f.size/1024/1024).toFixed(2)} MB · анализируем…`;
    if (f.name.toLowerCase().endsWith('.stl')) {
      try {
        const buf = await f.arrayBuffer();
        analysis = analyzeSTL(buf);
        document.getElementById('fileMeta').textContent = `${(f.size/1024/1024).toFixed(2)} MB · STL проанализирован`;
      } catch {
        analysis = null;
        document.getElementById('fileMeta').textContent = 'Файл выбран · геометрию не удалось прочитать';
      }
    } else {
      analysis = null;
      document.getElementById('fileMeta').textContent = `${(f.size/1024/1024).toFixed(2)} MB · цена после проверки оператором`;
    }
    updateEstimate();
  }

  function updateEstimate() {
    if (!analysis) { document.getElementById('estimatePrice').textContent='—'; document.getElementById('estWeight').textContent='—'; document.getElementById('estTime').textContent='—'; document.getElementById('estSize').textContent='—'; return; }
    const material = MATERIALS[document.getElementById('material').value];
    const quality = QUALITY[document.getElementById('quality').value];
    const qty = Math.max(1, Number(document.getElementById('qty').value)||1);
    const shellFactor = Math.min(.62, .18 + 7 / Math.max(12, Math.min(...analysis.size)));
    const effectiveVolume = analysis.volume * shellFactor;
    const gramsOne = effectiveVolume * material.density;
    const grams = gramsOne * qty;
    const hoursOne = Math.max(.45, (gramsOne / 16) * quality.factor);
    const hours = hoursOne * qty;
    const base = 3.5 + grams * material.gram + hours * 1.35;
    const min = Math.max(5, base * .92);
    const max = base * 1.16;
    analysis.estimate = { grams, hours, min, max };
    document.getElementById('estimatePrice').textContent = `${min.toFixed(0)}–${max.toFixed(0)} AZN`;
    document.getElementById('estWeight').textContent = `${grams.toFixed(0)} г`;
    document.getElementById('estTime').textContent = `${hours.toFixed(1)} ч`;
    document.getElementById('estSize').textContent = analysis.size.map(v => v.toFixed(0)).join('×') + ' мм';
    document.getElementById('estimateNote').textContent = `Расчёт по геометрии STL, ${material.label}, ${quality.label.toLowerCase()}, ${qty} шт.`;
  }

  document.getElementById('orderForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = file.files[0];
    const link = document.getElementById('modelLink').value.trim();
    if (!f && !link) return alert('Загрузите модель или вставьте ссылку.');
    const estimate = analysis?.estimate || null;
    const order = {
      id: makeId(), createdAt: new Date().toISOString(),
      customer: document.getElementById('customerName').value.trim(), phone: document.getElementById('phone').value.trim(),
      fileName: f?.name || '', modelLink: link, material: document.getElementById('material').value,
      quality: document.getElementById('quality').value, color: document.getElementById('color').value.trim() || 'Не указан',
      qty: Math.max(1,Number(document.getElementById('qty').value)||1), note: document.getElementById('note').value.trim(),
      estimateMin: estimate?.min || null, estimateMax: estimate?.max || null, weight: estimate?.grams || null, time: estimate?.hours || null,
      finalPrice: null, prepaid: false, status: 'new', progress: 0, printer: null
    };
    upsertOrder(order);
    renderOrderSuccess(order);
  });
}

function renderOrderSuccess(order) {
  screenContent.innerHTML = `<div class="success-wrap panel"><div class="success-icon">✓</div><p class="eyebrow">ORDER CREATED</p><h2>Заказ принят</h2><p>Сохрани номер заказа. По нему можно открыть статус в разделе «Мой заказ».</p><div class="order-code">${order.id}</div>${order.estimateMin ? `<p class="soft">Ориентир: <b>${order.estimateMin.toFixed(0)}–${order.estimateMax.toFixed(0)} AZN</b>. Оператор подтвердит финальную цену.</p>` : `<p class="soft">Модель отправлена оператору на ручной расчёт.</p>`}<div class="button-row"><button class="cta" id="trackCreated">Открыть заказ →</button><button class="secondary" id="newOrder">Новый заказ</button></div></div>`;
  document.getElementById('trackCreated').onclick = () => openScreen('my-order', order.id);
  document.getElementById('newOrder').onclick = renderOrder;
}

function renderMyOrder(prefill='') {
  screenContent.innerHTML = `<div class="screen-head"><div><p class="eyebrow">TRACK ORDER</p><h2>Мой заказ</h2></div></div><div class="track-search panel"><label>Номер заказа</label><div class="search-row"><input id="trackId" placeholder="Например ST-123456" value="${escapeHtml(prefill)}"><button class="cta" id="trackBtn">Найти →</button></div><small>Номер выдаётся после оформления заказа.</small></div><div id="trackResult"></div>`;
  const run = () => {
    const id = document.getElementById('trackId').value.trim().toUpperCase();
    const order = getOrders().find(o => o.id.toUpperCase() === id);
    const box = document.getElementById('trackResult');
    if (!order) { box.innerHTML = `<div class="empty panel">Заказ <b>${escapeHtml(id || '—')}</b> не найден в этом браузере.</div>`; return; }
    const price = order.finalPrice ? money(order.finalPrice) : order.estimateMin ? `${order.estimateMin.toFixed(0)}–${order.estimateMax.toFixed(0)} AZN` : 'На расчёте';
    box.innerHTML = `<div class="tracking panel"><div class="tracking-top"><div><p class="eyebrow">${order.id}</p><h3>${STATUS_LABELS[order.status] || order.status}</h3><p class="soft">${escapeHtml(order.fileName || order.modelLink || 'Модель')} · ${order.material} · ${order.qty} шт.</p></div><div class="big-price">${price}<small>${order.finalPrice ? 'финальная цена' : 'предварительно'}</small></div></div>
      <div class="progress-line"><i style="width:${Math.max(3,Number(order.progress)||0)}%"></i></div><div class="progress-meta"><span>${order.status === 'printing' ? `${order.progress || 0}% печати` : 'Статус заказа'}</span><span>${order.printer ? `Принтер: ${escapeHtml(order.printer)}` : 'Принтер ещё не назначен'}</span></div>
      <div class="timeline">${['new','review','approved','paid','queued','printing','post','ready'].map((s,i,arr) => { const current = arr.indexOf(order.status); return `<div class="timeline-item ${i<=current?'done':''}"><i></i><span>${STATUS_LABELS[s]}</span></div>`; }).join('')}</div>
      ${order.status === 'printing' ? `<div class="camera"><div class="camera-head"><b>LIVE CAMERA</b><span><i></i> ONLINE</span></div><div class="camera-view"><span>Камера принтера появится здесь после подключения Bambu API / RTSP</span></div></div>` : ''}
      <div class="order-details"><div><small>Создан</small><b>${fmtDate(order.createdAt)}</b></div><div><small>Материал</small><b>${order.material} · ${escapeHtml(order.color)}</b></div><div><small>Предоплата</small><b>${order.prepaid ? '50% оплачено' : 'Не оплачена'}</b></div></div></div>`;
  };
  document.getElementById('trackBtn').onclick = run;
  document.getElementById('trackId').addEventListener('keydown', e => e.key === 'Enter' && run());
  if (prefill) run();
}

function renderOperator(selectedId='') {
  const orders = getOrders();
  const selected = orders.find(o => o.id === selectedId) || orders[0];
  screenContent.innerHTML = `<div class="screen-head"><div><p class="eyebrow">OPERATOR DESK</p><h2>Панель оператора</h2></div><span class="step-pill">${orders.length} заказов</span></div>
    <div class="operator-layout"><div class="orders-list panel"><div class="list-head"><b>Заявки</b><button class="mini" id="seedDemo">+ demo</button></div>${orders.length ? orders.map(o => `<button class="order-row ${selected?.id===o.id?'active':''}" data-order-id="${o.id}"><span><b>${o.id}</b><small>${escapeHtml(o.customer)} · ${escapeHtml(o.fileName || 'по ссылке')}</small></span><em>${STATUS_LABELS[o.status]}</em></button>`).join('') : `<div class="empty">Пока нет заявок</div>`}</div><div id="operatorDetail">${selected ? operatorDetail(selected) : `<div class="panel empty">Создай тестовый заказ или оформи заказ с главной страницы.</div>`}</div></div>`;
  document.querySelectorAll('[data-order-id]').forEach(b => b.onclick = () => renderOperator(b.dataset.orderId));
  document.getElementById('seedDemo').onclick = () => { const demo={id:makeId(),createdAt:new Date().toISOString(),customer:'Demo client',phone:'+994 00 000 00 00',fileName:'gearbox_case.stl',modelLink:'',material:'PETG',quality:'standard',color:'Black',qty:1,note:'Проверить поддержки',estimateMin:18,estimateMax:23,weight:126,time:4.7,finalPrice:null,prepaid:false,status:'new',progress:0,printer:null}; upsertOrder(demo); renderOperator(demo.id); };
  bindOperatorDetail(selected);
}

function operatorDetail(o) {
  return `<div class="panel detail-panel"><div class="detail-title"><div><p class="eyebrow">${o.id}</p><h3>${escapeHtml(o.customer)}</h3><small>${escapeHtml(o.phone)}</small></div><span class="status-chip">${STATUS_LABELS[o.status]}</span></div>
    <div class="detail-grid"><div><small>Модель</small><b>${escapeHtml(o.fileName || o.modelLink || '—')}</b></div><div><small>Материал</small><b>${o.material} · ${escapeHtml(o.color)}</b></div><div><small>Количество</small><b>${o.qty} шт.</b></div><div><small>Оценка</small><b>${o.estimateMin ? `${o.estimateMin.toFixed(0)}–${o.estimateMax.toFixed(0)} AZN` : 'ручная'}</b></div><div><small>Вес</small><b>${o.weight ? `${o.weight.toFixed(0)} г`:'—'}</b></div><div><small>Время</small><b>${o.time ? `${o.time.toFixed(1)} ч`:'—'}</b></div></div>
    ${o.note ? `<div class="note-box">${escapeHtml(o.note)}</div>`:''}
    <div class="operator-form"><div class="field"><label>Финальная цена, AZN</label><input id="opPrice" type="number" step="0.01" value="${o.finalPrice ?? ''}" placeholder="Например 24"></div><div class="field"><label>Статус</label><select id="opStatus">${Object.entries(STATUS_LABELS).map(([k,v])=>`<option value="${k}" ${o.status===k?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Принтер</label><select id="opPrinter"><option value="">Не назначен</option>${[1,2,3,4].map(n=>`<option ${o.printer===`Printer ${n}`?'selected':''}>Printer ${n}</option>`).join('')}</select></div><div class="field"><label>Прогресс, %</label><input id="opProgress" type="number" min="0" max="100" value="${o.progress || 0}"></div><label class="check wide"><input id="opPaid" type="checkbox" ${o.prepaid?'checked':''}> Предоплата 50% получена</label><button class="cta wide" id="saveOperator">Сохранить изменения →</button></div></div>`;
}

function bindOperatorDetail(order) {
  if (!order) return;
  document.getElementById('saveOperator').onclick = () => {
    const fresh = getOrders().find(o=>o.id===order.id); if(!fresh) return;
    const price = Number(document.getElementById('opPrice').value);
    fresh.finalPrice = price > 0 ? price : null;
    fresh.status = document.getElementById('opStatus').value;
    fresh.printer = document.getElementById('opPrinter').value || null;
    fresh.progress = Math.max(0,Math.min(100,Number(document.getElementById('opProgress').value)||0));
    fresh.prepaid = document.getElementById('opPaid').checked;
    upsertOrder(fresh); renderOperator(fresh.id);
  };
}

function analyzeSTL(buffer) {
  const dv = new DataView(buffer);
  const isBinary = buffer.byteLength >= 84 && (84 + dv.getUint32(80,true)*50 === buffer.byteLength);
  let triangles=[];
  if (isBinary) {
    const count=dv.getUint32(80,true); let p=84;
    for(let i=0;i<count;i++,p+=50){ const t=[]; for(let v=0;v<3;v++){ const o=p+12+v*12; t.push([dv.getFloat32(o,true),dv.getFloat32(o+4,true),dv.getFloat32(o+8,true)]); } triangles.push(t); }
  } else {
    const txt=new TextDecoder().decode(buffer); const re=/vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g; let m,verts=[];
    while((m=re.exec(txt))) verts.push([+m[1],+m[2],+m[3]]); for(let i=0;i+2<verts.length;i+=3) triangles.push([verts[i],verts[i+1],verts[i+2]]);
  }
  if(!triangles.length) throw new Error('No triangles');
  let vol=0,min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const [a,b,c] of triangles){ vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]))/6; for(const v of [a,b,c]) for(let k=0;k<3;k++){min[k]=Math.min(min[k],v[k]);max[k]=Math.max(max[k],v[k]);}}
  return { volume: Math.abs(vol)/1000, size: max.map((v,i)=>v-min[i]) };
}
