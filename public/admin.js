'use strict';
const mem = {};
const store = {
  get(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return mem[k] || null; } },
  set(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
  remove(k) { try { window.sessionStorage.removeItem(k); } catch (e) { delete mem[k]; } }
};
let token = store.get('jos_admin_token') || '';
const $ = id => document.getElementById(id);
const BASE_TITLE = document.title;

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const PAYMENT_STATUSES = ['Unpaid', 'Pending Verification', 'Paid', 'Rejected', 'Refunded'];
const COD_PAYMENT_STATUSES = ['Unpaid', 'Paid', 'Refunded'];
const ART_KINDS = ['jar', 'candle', 'box', 'ring'];
const ART_ICONS = { jar: '🫙', candle: '🕯️', box: '🎁', ring: '💍' };
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const LOW_STOCK = 5;
const POLL_MS = 5000;
const POLL_MAX_MS = 60000;
const FLASH_MS = 6000;
const TABS = ['products', 'orders', 'customers', 'settings', 'notifications'];

/* Every dynamic value that reaches an HTML template goes through esc(); URLs in src also go through safeImg(). */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"'`]/g, c => ESC_MAP[c]); }
function safeImg(u) {
  const s = String(u === null || u === undefined ? '' : u);
  if (/^\/uploads\/products\/[^\s"'<>\\?#]+$/.test(s) && !s.includes('..')) return s;
  if (/^data:image\/(jpeg|png|webp|gif)[;,]/i.test(s)) return s;
  if (/^blob:/.test(s)) return s;
  return '';
}
function imgTag(u, cls) { const s = safeImg(u); return s ? `<img class="${esc(cls)}" src="${esc(s)}" alt="">` : ''; }
function fmtDate(v) { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleString(); }
const fmt = n => 'PKR ' + Number(n || 0).toLocaleString('en-PK');
const errHtml = e => `<div class="error">${esc(e && e.message)}</div>`;
const pill = s => `<span class="pill st-${esc(String(s).toLowerCase().replace(/[^a-z]+/g, '-'))}">${esc(s)}</span>`;
const payMethodLabel = m => (m === 'cod' ? 'Cash on Delivery' : 'Online Transfer');
const options = (list, selected) => list.map(s => `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('');

let toastTimer = null;
function toast(m, ms) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms || 3200); }
function fail(e) { if (!e.sessionExpired) toast(e.message, 5000); }

/* Writes a list only when its markup changed, so a poll keeps scroll position and half-tapped buttons. */
function render(el, html) {
  if (el._html === html) return;
  const scroller = el.querySelector('.table-wrap');
  const left = scroller ? scroller.scrollLeft : 0;
  el._html = html; el.innerHTML = html;
  const next = el.querySelector('.table-wrap');
  if (next) next.scrollLeft = left;
}

function apiError(message, status, code) { const e = new Error(message); e.status = status; e.code = code; e.isApi = true; return e; }
async function request(p, opts, read) {
  const sent = token;
  const { timeoutMs, ...init } = opts;
  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(p, { ...init, ...(ctl ? { signal: ctl.signal } : {}), headers: { ...(sent ? { Authorization: 'Bearer ' + sent } : {}), ...(init.headers || {}) } });
    if (r.status === 401 && sent) {
      if (sent === token) expireSession();
      const e = new Error('Your session has expired.'); e.sessionExpired = true; throw e;
    }
    return await read(r);
  } catch (e) {
    if (e.sessionExpired || e.isApi) throw e;
    throw new Error(e.name === 'AbortError' ? 'The server took too long to respond.' : 'Could not reach the server. Check your connection.');
  } finally { clearTimeout(timer); }
}
function api(p, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  return request(p, { timeoutMs: isGet ? 20000 : 0, ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }, async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw apiError(d.error || ('HTTP ' + r.status), r.status, d.code);
    return d;
  });
}

/* Auth */
function showAuth(needsSetup, message) {
  $('authView').style.display = 'block'; $('dashView').style.display = 'none'; $('logoutBtn').style.display = 'none';
  $('setupBox').style.display = needsSetup ? 'block' : 'none';
  $('loginBox').style.display = needsSetup ? 'none' : 'block';
  $(needsSetup ? 'setupError' : 'loginError').innerHTML = message ? `<div class="error">${esc(message)}</div>` : '';
}
function startSession(d) { token = d.token; store.set('jos_admin_token', token); showDash(); }
function expireSession() {
  token = ''; store.remove('jos_admin_token');
  stopPolling(); closeOrderModal(); clearDashboard();
  $('loginForm').reset();
  showAuth(false, 'Your session has expired. Please log in again.');
}
async function initAuth() {
  let s = null;
  try { s = await (await fetch('/api/admin/status')).json(); } catch (e) {}
  if (token) {
    /* A network failure keeps the session; the live indicator shows the outage. A 401 has already moved to login. */
    try { await api('/api/admin/stats'); } catch (e) { if (e.sessionExpired) return; }
    return showDash();
  }
  showAuth(!!(s && s.needsSetup), s ? '' : 'Could not reach the server. Please reload the page.');
}
$('setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('setupError').innerHTML = '';
  try { startSession(await api('/api/admin/setup', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password'), setupCode: String(fd.get('setupCode')).trim() }) })); e.target.reset(); }
  catch (err) {
    if (err.code === 'SETUP_COMPLETE') showAuth(false, err.message);
    else $('setupError').innerHTML = errHtml(err);
  }
});
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('loginError').innerHTML = '';
  try { startSession(await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) })); e.target.reset(); }
  catch (err) { $('loginError').innerHTML = errHtml(err); }
});
$('logoutBtn').onclick = async () => {
  const t = token;
  token = ''; store.remove('jos_admin_token'); stopPolling();
  try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: '{}' }); } catch (e) {}
  location.reload();
};

function showDash() {
  $('authView').style.display = 'none'; $('dashView').style.display = 'block'; $('logoutBtn').style.display = 'inline-block';
  openTab(activeTab);
  loadStats();
  startPolling();
}
function clearDashboard() {
  ['statsRow', 'productList', 'orderList', 'customerList', 'notifList'].forEach(id => render($(id), ''));
  allProducts = []; allOrders = []; flash.clear();
  resetProductForm();
  $('settingsForm').reset(); settingsDirty = false; $('settingsMsg').innerHTML = ''; $('tokenHint').style.display = 'none';
  $('orderSearch').value = ''; $('orderStatusFilter').value = ''; $('orderPaymentFilter').value = ''; $('customerSearch').value = '';
  setUnseen(0); setTabVisible('products');
}

/* Tabs */
let activeTab = 'products';
function setTabVisible(name) {
  activeTab = name;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  TABS.forEach(t => { $('tab-' + t).style.display = t === name ? 'block' : 'none'; });
}
function openTab(name) {
  setTabVisible(name);
  if (name === 'orders') setUnseen(0);
  if (name === 'settings') loadSettings(); else refreshVisible();
}
document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => openTab(b.dataset.tab); });
/* Reloads the list on screen. Resolves false on failure; with silent the current list stays on screen. */
function refreshVisible(silent) {
  if (activeTab === 'products') return loadProducts(silent);
  if (activeTab === 'orders') return loadOrders(silent);
  if (activeTab === 'customers') return loadCustomers(silent);
  if (activeTab === 'notifications') return loadNotifs(silent);
  return Promise.resolve(true);
}
const seq = { products: 0, orders: 0, customers: 0, notifications: 0, settings: 0 };

/* Stats */
function renderStats(s) {
  if (!s) return;
  const tiles = [
    ['Total Orders', s.orders], ['Pending', s.pending], ['Confirmed', s.confirmed], ['Processing', s.processing],
    ['Shipped', s.shipped], ['Completed', s.completed], ['Cancelled', s.cancelled],
    ['Total Sales', fmt(s.totalSales)], ['Paid Sales', fmt(s.paidSales)],
    ['Payments to Verify', s.pendingVerification, s.pendingVerification > 0],
    ['Products (active / total)', `${s.activeProducts} / ${s.products}`],
    ['Low Stock', s.lowStock, s.lowStock > 0]
  ];
  render($('statsRow'), tiles.map(([k, v, attn]) => `<div class="stat${attn ? ' attn' : ''}"><div class="num">${esc(v)}</div><div class="muted small">${esc(k)}</div></div>`).join(''));
}
async function loadStats() {
  try { const d = await api('/api/admin/stats'); if (token) renderStats(d.stats); } catch (e) {}
}

/* Live updates */
const live = { running: false, gen: 0, timer: null, inFlight: false, failures: 0, primed: false, revision: null, latestOrderId: null, orders: 0, unseen: 0, clearTimer: null };
const flash = new Map(); /* order id -> true while a row awaits or shows its highlight */
function setLive(state, text) { const el = $('liveStatus'); el.dataset.state = state; el.textContent = text; }
function setUnseen(n) {
  live.unseen = n;
  $('ordersCount').textContent = n ? ` (${n})` : '';
  document.title = (n ? `(${n}) ` : '') + BASE_TITLE;
}
function startPolling() {
  stopPolling();
  live.running = true; live.failures = 0; live.primed = false; live.revision = null; live.latestOrderId = null; live.orders = 0;
  setLive('wait', 'Connecting…');
  poll();
}
function stopPolling() { live.running = false; live.gen++; live.inFlight = false; clearTimeout(live.timer); clearTimeout(live.clearTimer); }
function schedulePoll() {
  clearTimeout(live.timer);
  if (!live.running || document.hidden) return;
  const delay = live.failures ? Math.min(POLL_MS * Math.pow(2, live.failures), POLL_MAX_MS) : POLL_MS;
  live.timer = setTimeout(poll, delay);
}
async function poll() {
  if (!live.running || live.inFlight || document.hidden) return;
  clearTimeout(live.timer);
  live.inFlight = true;
  const gen = live.gen;
  try {
    const d = await api('/api/admin/sync', { timeoutMs: 10000 });
    if (gen !== live.gen) return;
    await applySync(d, gen);
    if (gen !== live.gen) return;
    live.failures = 0;
    setLive('ok', 'Live · updated ' + new Date().toLocaleTimeString('en-GB'));
  } catch (e) {
    if (gen !== live.gen) return;
    live.failures++;
    setLive('down', 'Reconnecting…');
  }
  live.inFlight = false;
  schedulePoll();
}
async function applySync(d, gen) {
  renderStats(d.stats);
  const orderCount = d.stats ? Number(d.stats.orders) || 0 : 0;
  const isNew = live.primed && d.latestOrderId && d.latestOrderId !== live.latestOrderId;
  if (isNew) await noteNewOrders(d.latestOrderId, Math.max(1, orderCount - live.orders));
  if (gen !== live.gen) return;
  live.latestOrderId = d.latestOrderId; live.orders = orderCount; live.primed = true;
  if (isNew || d.revision !== live.revision) {
    /* The revision is recorded only after a good fetch, so a failed refresh is retried by the next poll. */
    if (!await refreshVisible(true)) throw new Error('refresh failed');
    if (gen === live.gen) live.revision = d.revision;
  }
}
async function noteNewOrders(latestId, added) {
  flash.set(latestId, false);
  if (added > 1) {
    try { (await api('/api/admin/orders?limit=' + Math.min(added, 50))).orders.forEach(o => flash.set(o.id, false)); } catch (e) { if (e.sessionExpired) throw e; }
  }
  setUnseen(live.unseen + added);
  toast(added > 1 ? `${added} new orders. Latest: ${latestId}` : `New order: ${latestId}`, FLASH_MS);
  /* Already on the Orders tab, the rows are in view: the counter shows briefly, then clears itself. */
  if (activeTab === 'orders') {
    clearTimeout(live.clearTimer);
    live.clearTimer = setTimeout(() => { if (activeTab === 'orders' && !orderModalOpen()) setUnseen(0); }, FLASH_MS);
  }
}
document.addEventListener('visibilitychange', () => {
  if (!live.running) return;
  if (document.hidden) clearTimeout(live.timer); else poll();
});

/* Products */
let allProducts = [];
let productImages = []; /* slots: { src, reading } in display order; src is null until its FileReader finishes */
let editingArt = null;

function setArtSelect(art, editing) {
  const sel = $('productForm').elements['artKind'];
  const old = sel.querySelector('[data-unset]'); if (old) old.remove();
  const kind = art && art.kind;
  if (ART_KINDS.includes(kind)) { sel.value = kind; return; }
  if (!editing) { sel.value = 'jar'; return; }
  /* An existing product with no artwork stays that way unless the admin picks one. */
  const o = document.createElement('option');
  o.value = ''; o.textContent = 'Not chosen yet (store default)'; o.dataset.unset = '1';
  sel.insertBefore(o, sel.firstChild); sel.value = '';
}
function renderImagePreviews() {
  $('productImagePreview').innerHTML = productImages.map((s, i) => `<div class="img-slot">${s.src ? (imgTag(s.src, '') || '<span class="small muted">Unavailable</span>') : '<span class="small muted">Reading…</span>'}<button type="button" class="img-remove" data-rm="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join('');
}
function readImage(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read ' + f.name));
    r.readAsDataURL(f);
  });
}
$('productImages').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  const problems = [];
  files.forEach(f => {
    if (productImages.length >= MAX_IMAGES) { problems.push(`${f.name}: a product can have at most ${MAX_IMAGES} photos.`); return; }
    if (!IMAGE_TYPES.includes(f.type)) { problems.push(`${f.name}: only JPG, PNG or WebP images are allowed.`); return; }
    if (f.size > MAX_IMAGE_BYTES) { problems.push(`${f.name}: larger than 5 MB.`); return; }
    if (!f.size) { problems.push(`${f.name}: the file is empty.`); return; }
    const slot = { src: null, reading: null };
    slot.reading = readImage(f).then(src => { slot.src = src; }).catch(err => {
      productImages = productImages.filter(s => s !== slot);
      $('productImageMsg').textContent = err.message;
    }).then(() => { slot.reading = null; renderImagePreviews(); });
    productImages.push(slot);
  });
  $('productImageMsg').textContent = problems.join(' ');
  renderImagePreviews();
});
$('productImagePreview').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  productImages.splice(Number(b.dataset.rm), 1);
  $('productImageMsg').textContent = '';
  renderImagePreviews();
});
async function imagesReady() {
  for (;;) {
    const pending = productImages.filter(s => s.reading).map(s => s.reading);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}
$('productForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('saveProductBtn');
  if (btn.disabled) return;
  const fd = new FormData(e.target);
  const id = fd.get('id');
  const kind = fd.get('artKind');
  const body = { name: String(fd.get('name')).trim(), price: Number(fd.get('price')), category: fd.get('category') || 'General', stock: Number(fd.get('stock')), shortDescription: fd.get('shortDescription'), description: fd.get('description'), specifications: fd.get('specifications'), enabled: !!fd.get('enabled') };
  if (kind) body.art = { kind, color: editingArt && editingArt.color ? editingArt.color : null, label: editingArt && editingArt.label ? editingArt.label : null };
  $('productFormMsg').innerHTML = '';
  btn.disabled = true; $('cancelEdit').disabled = true; btn.textContent = 'Saving…';
  try {
    await imagesReady();
    body.images = productImages.map(s => s.src);
    if (id) await api('/api/admin/products/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/products', { method: 'POST', body: JSON.stringify(body) });
    toast('Product saved'); resetProductForm(); loadProducts(); loadStats();
  } catch (err) {
    if (!err.sessionExpired) { $('productFormMsg').innerHTML = errHtml(err); toast(err.message, 5000); }
  } finally { btn.disabled = false; $('cancelEdit').disabled = false; btn.textContent = 'Save Product'; }
});
function resetProductForm() {
  const f = $('productForm'); editingArt = null; setArtSelect(null, false); f.reset(); f.elements['id'].value = '';
  $('productFormTitle').textContent = 'Add Product'; $('cancelEdit').style.display = 'none';
  productImages = []; renderImagePreviews();
  $('productImageMsg').textContent = ''; $('productFormMsg').innerHTML = '';
}
$('cancelEdit').onclick = resetProductForm;
function stockBadge(p) {
  const n = Number(p.stock);
  if (n <= 0) return ' <span class="pill st-out">Out of stock</span>';
  if (n <= LOW_STOCK) return ' <span class="pill st-low">Low stock</span>';
  return '';
}
function productRow(p) {
  const on = p.enabled !== false;
  const art = p.art && ART_ICONS[p.art.kind] ? ART_ICONS[p.art.kind] : '🫙';
  const thumb = (p.images && p.images.length && imgTag(p.images[0], 'thumb')) || `<span class="thumb thumb-art">${esc(art)}</span>`;
  return `<tr class="${on ? '' : 'row-off'}"><td><div class="prod-cell">${thumb}<div>${esc(p.name)}<br><span class="small muted">${esc(p.category)}</span></div></div></td><td>${esc(fmt(p.price))}</td><td>${esc(p.stock)}${stockBadge(p)}</td><td>${pill(on ? 'Enabled' : 'Disabled')}</td><td class="actions"><button class="btn small secondary" data-edit="${esc(p.id)}">Edit</button> <button class="btn small secondary" data-toggle="${esc(p.id)}">${on ? 'Disable' : 'Enable'}</button> <button class="btn small danger" data-del="${esc(p.id)}">Delete</button></td></tr>`;
}
async function loadProducts(silent) {
  const my = ++seq.products;
  try {
    const d = await api('/api/admin/products');
    if (my !== seq.products || !token) return true;
    allProducts = d.products;
    render($('productList'), allProducts.length ? `<div class="table-wrap"><table class="wide-md"><tr><th>Product</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr>${allProducts.map(productRow).join('')}</table></div>` : '<div class="panel">No products yet.</div>');
    return true;
  } catch (e) {
    if (my === seq.products && !silent && !e.sessionExpired) render($('productList'), errHtml(e));
    return false;
  }
}
$('productList').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.edit) return editProduct(allProducts.find(p => p.id === b.dataset.edit));
  if (b.dataset.toggle) {
    const p = allProducts.find(x => x.id === b.dataset.toggle); if (!p) return;
    const next = p.enabled === false;
    b.disabled = true;
    try {
      await api('/api/admin/products/' + encodeURIComponent(p.id), { method: 'PUT', body: JSON.stringify({ enabled: next }) });
      if ($('productForm').elements['id'].value === p.id) $('productForm').elements['enabled'].checked = next;
      toast(next ? 'Product enabled' : 'Product disabled');
      loadProducts(); loadStats();
    } catch (err) { fail(err); b.disabled = false; }
    return;
  }
  if (b.dataset.del) {
    if (!b.dataset.confirm) {
      b.dataset.confirm = '1'; b.textContent = 'Tap again to confirm';
      setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Delete'; }, 3000);
      return;
    }
    const id = b.dataset.del;
    b.disabled = true;
    try {
      await api('/api/admin/products/' + encodeURIComponent(id), { method: 'DELETE' });
      if ($('productForm').elements['id'].value === id) resetProductForm();
      toast('Product deleted'); loadProducts(); loadStats();
    } catch (err) { fail(err); b.disabled = false; }
  }
});
function editProduct(p) {
  if (!p) return; const el = $('productForm').elements;
  el['id'].value = p.id; el['name'].value = p.name; el['price'].value = p.price; el['category'].value = p.category || ''; el['stock'].value = p.stock;
  el['shortDescription'].value = p.shortDescription || ''; el['description'].value = p.description || ''; el['specifications'].value = p.specifications || ''; el['enabled'].checked = p.enabled !== false;
  editingArt = p.art || null; setArtSelect(p.art, true);
  productImages = (p.images || []).map(src => ({ src, reading: null })); renderImagePreviews();
  $('productImageMsg').textContent = ''; $('productFormMsg').innerHTML = '';
  $('productFormTitle').textContent = 'Edit Product'; $('cancelEdit').style.display = 'inline-block'; window.scrollTo(0, 0);
}

/* Orders */
let allOrders = [];
function orderRow(o) {
  const c = o.customer || {};
  return `<tr class="${flash.has(o.id) ? 'row-new' : ''}" data-row="${esc(o.id)}">
      <td>${esc(o.id)}</td><td>${esc(c.name)}</td><td>${esc(c.mobile)}</td>
      <td>${(o.items || []).map(i => `${esc(i.name)} × ${esc(i.quantity)}`).join('<br>')}</td>
      <td>${esc(fmt(o.total))}</td><td>${esc(payMethodLabel(o.paymentMethod))}<br>${pill(o.paymentStatus)}</td>
      <td>${o.screenshot ? 'Uploaded' : '—'}</td>
      <td class="small">${esc(fmtDate(o.createdAt))}</td><td>${pill(o.orderStatus)}</td>
      <td><button class="btn small" data-order="${esc(o.id)}">View</button></td></tr>`;
}
function orderQuery() {
  const qs = new URLSearchParams();
  if ($('orderStatusFilter').value) qs.set('status', $('orderStatusFilter').value);
  if ($('orderPaymentFilter').value) qs.set('paymentStatus', $('orderPaymentFilter').value);
  if ($('orderSearch').value.trim()) qs.set('q', $('orderSearch').value.trim());
  return qs.toString();
}
async function loadOrders(silent) {
  const my = ++seq.orders;
  const query = orderQuery();
  try {
    const d = await api('/api/admin/orders' + (query ? '?' + query : ''));
    if (my !== seq.orders || !token) return true;
    allOrders = d.orders;
    const total = Number(d.total);
    if (!allOrders.length) render($('orderList'), `<div class="panel">${query ? 'No orders match these filters.' : 'No orders yet.'}</div>`);
    else render($('orderList'), `${total > allOrders.length ? `<p class="small muted">Showing ${esc(allOrders.length)} of ${esc(total)}. Use the filters or search to narrow the list.</p>` : ''}<div class="table-wrap"><table class="wide-lg"><tr><th>Order ID</th><th>Customer</th><th>Phone</th><th>Products</th><th>Total</th><th>Payment</th><th>Screenshot</th><th>Date</th><th>Status</th><th>View</th></tr>${allOrders.map(orderRow).join('')}</table></div>`);
    armFlash();
    return true;
  } catch (e) {
    if (my === seq.orders && !silent && !e.sessionExpired) render($('orderList'), errHtml(e));
    return false;
  }
}
/* A highlight starts its timer only once the row can be seen: Orders tab open, nothing covering it. */
function armFlash() {
  if (activeTab !== 'orders' || orderModalOpen()) return;
  flash.forEach((armed, id) => {
    if (armed) return;
    flash.set(id, true);
    setTimeout(() => {
      flash.delete(id);
      $('orderList').querySelectorAll('[data-row]').forEach(r => { if (r.dataset.row === id) r.classList.remove('row-new'); });
    }, FLASH_MS);
  });
}
$('orderList').addEventListener('click', e => { const b = e.target.closest('[data-order]'); if (b) openOrder(b.dataset.order); });
$('orderStatusFilter').insertAdjacentHTML('beforeend', options(ORDER_STATUSES));
$('orderPaymentFilter').insertAdjacentHTML('beforeend', options(PAYMENT_STATUSES));
$('orderStatusFilter').onchange = () => loadOrders();
$('orderPaymentFilter').onchange = () => loadOrders();
function debounce(fn, ms) { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
$('orderSearch').addEventListener('input', debounce(() => loadOrders(), 250));
$('orderClearFilters').onclick = () => { $('orderSearch').value = ''; $('orderStatusFilter').value = ''; $('orderPaymentFilter').value = ''; loadOrders(); };

/* Order modal. The server rendered list is never used here: the modal shows GET /orders/:id. */
const modal = { seq: 0, order: null, shotUrl: null };
const orderModalOpen = () => $('orderModal').classList.contains('open');
function closeOrderModal() {
  modal.seq++; modal.order = null;
  if (modal.shotUrl) { URL.revokeObjectURL(modal.shotUrl); modal.shotUrl = null; }
  $('orderModal').classList.remove('open');
  $('orderDetail').innerHTML = '';
  if (activeTab === 'orders' && token) { setUnseen(0); armFlash(); }
}
$('closeModal').onclick = closeOrderModal;
async function openOrder(id) {
  closeOrderModal();
  const my = modal.seq;
  $('orderDetail').innerHTML = '<p class="muted">Loading order…</p>';
  $('orderModal').classList.add('open');
  try {
    const d = await api('/api/admin/orders/' + encodeURIComponent(id));
    if (my !== modal.seq) return;
    modal.order = d.order;
    const o = d.order;
    $('orderDetail').innerHTML = `
      <h3>Order ${esc(o.id)}</h3>
      <div id="ordSummary"></div>
      ${o.screenshot ? `<h4>Payment Screenshot</h4><div id="shotBox"><p class="muted small">Loading securely…</p></div>` : ''}
      <h4>Update</h4>
      <form id="orderForm"></form>
      <h4>History</h4>
      <div id="ordHistory"></div>`;
    renderOrderSections();
    if (o.screenshot) loadShot(o, my);
  } catch (e) {
    if (my === modal.seq && !e.sessionExpired) $('orderDetail').innerHTML = errHtml(e);
  }
}
function contactLink(scheme, value) {
  const raw = String(value === null || value === undefined ? '' : value);
  if (!raw) return '—';
  let target = '';
  if (scheme === 'tel') { const n = raw.replace(/[^\d+]/g, ''); if (/^\+?\d{5,}$/.test(n)) target = 'tel:' + n; }
  else if (/^[^\s@<>"']+@[^\s@<>"']+$/.test(raw)) target = 'mailto:' + encodeURIComponent(raw).replace(/%40/g, '@');
  return target ? `<a href="${esc(target)}">${esc(raw)}</a>` : esc(raw);
}
function orderSummaryHtml(o) {
  const c = o.customer || {};
  return `
    <p><strong>Customer:</strong> ${esc(c.name)}<br><strong>Mobile:</strong> ${contactLink('tel', c.mobile)}<br><strong>WhatsApp:</strong> ${contactLink('tel', c.whatsapp)}<br><strong>Email:</strong> ${contactLink('mailto', c.email)}<br><strong>Delivery Address:</strong> ${esc(c.address)}, ${esc(c.city)}<br><strong>Date:</strong> ${esc(fmtDate(o.createdAt))}</p>
    <h4>Items</h4>
    <div class="table-wrap"><table class="wide-sm"><tr><th>Item</th><th>Price</th><th>Qty</th><th>Line Total</th></tr>${(o.items || []).map(i => `<tr><td><div class="prod-cell">${imgTag(i.image, 'thumb')}<div>${esc(i.name)}</div></div></td><td>${esc(fmt(i.price))}</td><td>${esc(i.quantity)}</td><td>${esc(fmt(i.lineTotal))}</td></tr>`).join('')}</table></div>
    <p>Subtotal: ${esc(fmt(o.subtotal))} · Delivery: ${esc(fmt(o.deliveryFee))} · <strong>Total: ${esc(fmt(o.total))}</strong></p>
    <p><strong>Payment:</strong> ${esc(o.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Online Bank Transfer')} ${pill(o.paymentStatus)} · <strong>Order:</strong> ${pill(o.orderStatus)}</p>`;
}
function orderControlsHtml(o) {
  const allowed = o.paymentMethod === 'cod' ? COD_PAYMENT_STATUSES : PAYMENT_STATUSES;
  const payList = allowed.includes(o.paymentStatus) ? allowed : [o.paymentStatus, ...allowed];
  const canVerify = o.paymentMethod === 'online' && o.paymentStatus === 'Pending Verification';
  return `
    <div class="field"><label>Order Status</label><select id="ordStatus">${options(ORDER_STATUSES, o.orderStatus)}</select>${o.orderStatus === 'Cancelled' ? '<div class="small muted">Reopening this order deducts its items from stock again.</div>' : ''}</div>
    <div class="field"><label>Payment Status</label><select id="payStatus">${options(payList, o.paymentStatus)}</select></div>
    ${canVerify ? '<p><button type="button" class="btn small" id="payVerify">Verify Payment</button> <button type="button" class="btn small danger" id="payReject">Reject Payment</button></p>' : ''}
    <div class="field"><label>Note (optional, saved in the history with a change)</label><textarea id="ordNote" rows="2" maxlength="500"></textarea></div>
    <div id="ordError"></div>
    <div id="cancelConfirm" class="confirm-box" style="display:none">
      <p><strong>Confirm cancellation.</strong> Cancelling order ${esc(o.id)} restores its items to stock.</p>
      <button type="button" class="btn small danger" id="confirmCancel">Confirm Cancel Order</button> <button type="button" class="btn small secondary" id="keepOrder">Keep Order</button>
    </div>
    <p><button class="btn" id="saveOrder">Save Changes</button></p>`;
}
const HISTORY_LABELS = { created: 'Order placed', orderStatus: 'Order status', paymentStatus: 'Payment status' };
function historyHtml(list) {
  if (!list || !list.length) return '<p class="muted small">No history yet.</p>';
  return `<ol class="timeline">${list.map(h => {
    const change = h.from ? `${esc(h.from)} → ${esc(h.to)}` : esc(h.to);
    return `<li><div class="small muted">${esc(fmtDate(h.at))} · ${esc(h.actor || 'system')}</div><div><strong>${esc(HISTORY_LABELS[h.field] || h.field)}</strong>${change ? ': ' + change : ''}</div>${h.note ? `<div class="small note">${esc(h.note)}</div>` : ''}</li>`;
  }).join('')}</ol>`;
}
function renderOrderSections() {
  const o = modal.order;
  $('ordSummary').innerHTML = orderSummaryHtml(o);
  $('orderForm').innerHTML = orderControlsHtml(o);
  $('ordHistory').innerHTML = historyHtml(o.history);
  $('orderForm').onsubmit = e => { e.preventDefault(); saveOrder(false); };
  $('ordStatus').onchange = () => { $('cancelConfirm').style.display = 'none'; };
  $('confirmCancel').onclick = () => saveOrder(true);
  $('keepOrder').onclick = () => { $('cancelConfirm').style.display = 'none'; $('ordStatus').value = modal.order.orderStatus; };
  const v = $('payVerify'); if (v) v.onclick = () => patchOrder({ paymentAction: 'verify' }, 'Payment verified');
  const rj = $('payReject'); if (rj) rj.onclick = () => patchOrder({ paymentAction: 'reject' }, 'Payment rejected');
}
function saveOrder(confirmed) {
  const o = modal.order; if (!o) return;
  const body = {};
  if ($('ordStatus').value !== o.orderStatus) body.orderStatus = $('ordStatus').value;
  if ($('payStatus').value !== o.paymentStatus) body.paymentStatus = $('payStatus').value;
  $('ordError').innerHTML = '';
  if (!Object.keys(body).length) {
    /* The contract records a note only alongside a change, so a lone note must not look saved. */
    $('ordError').innerHTML = `<div class="error">${$('ordNote').value.trim() ? 'A note is saved together with a status change. Change a status, or clear the note.' : 'Nothing to save. No status was changed.'}</div>`;
    return;
  }
  if (body.orderStatus === 'Cancelled' && !confirmed) { $('cancelConfirm').style.display = 'block'; return; }
  patchOrder(body, 'Order updated');
}
async function patchOrder(body, okMessage) {
  const o = modal.order; if (!o) return;
  const my = modal.seq;
  const note = $('ordNote').value.trim();
  if (note) body.note = note;
  const buttons = $('orderForm').querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  $('ordError').innerHTML = '';
  try {
    const d = await api('/api/admin/orders/' + encodeURIComponent(o.id), { method: 'PATCH', body: JSON.stringify(body) });
    toast(okMessage);
    if (my === modal.seq) { modal.order = d.order; renderOrderSections(); }
    refreshVisible(true); loadStats();
  } catch (e) {
    if (e.sessionExpired) return;
    toast(e.message, 5000);
    if (my === modal.seq) {
      $('ordError').innerHTML = errHtml(e);
      $('cancelConfirm').style.display = 'none';
      buttons.forEach(b => { b.disabled = false; });
    }
  }
}
/* Reads the file's own signature; the result decides how it may be shown. Anything else is never opened. */
async function sniffType(blob) {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const has = (...sig) => sig.every((x, i) => b[i] === x);
  if (has(0x25, 0x50, 0x44, 0x46)) return { type: 'application/pdf', ext: 'pdf' };
  if (has(0x89, 0x50, 0x4E, 0x47)) return { type: 'image/png', ext: 'png' };
  if (has(0xFF, 0xD8, 0xFF)) return { type: 'image/jpeg', ext: 'jpg' };
  if (has(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
  return null;
}
async function loadShot(o, my) {
  try {
    const raw = await request('/api/admin/orders/' + encodeURIComponent(o.id) + '/screenshot', { timeoutMs: 60000 }, async r => {
      if (!r.ok) throw apiError('Screenshot not available', r.status);
      return r.blob();
    });
    const kind = await sniffType(raw);
    if (my !== modal.seq) return;
    if (!kind) { $('shotBox').innerHTML = '<p class="error">This file is not a JPG, PNG or PDF, so it was not opened.</p>'; return; }
    const url = URL.createObjectURL(new Blob([raw], { type: kind.type }));
    modal.shotUrl = url;
    const href = esc(safeImg(url));
    const fileName = esc(`payment-${String(o.id).replace(/[^A-Za-z0-9_-]/g, '')}.${kind.ext}`);
    const preview = kind.ext === 'pdf'
      ? '<p>📄 This payment proof is a PDF.</p>'
      : `<a href="${href}" target="_blank" rel="noopener"><img class="shot" src="${href}" alt="Payment screenshot"></a>`;
    $('shotBox').innerHTML = `${preview}<p><a class="btn small secondary" href="${href}" target="_blank" rel="noopener">${kind.ext === 'pdf' ? 'Open PDF' : 'Open full size'}</a> <a class="btn small secondary" href="${href}" download="${fileName}">Download</a></p>`;
  } catch (e) {
    if (my === modal.seq && !e.sessionExpired) $('shotBox').innerHTML = '<p class="error">Could not load screenshot.</p>';
  }
}

/* Customers */
async function loadCustomers(silent) {
  const my = ++seq.customers;
  const q = $('customerSearch').value.trim();
  try {
    const d = await api('/api/admin/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (my !== seq.customers || !token) return true;
    render($('customerList'), d.customers.length ? `<div class="table-wrap"><table class="wide-lg"><tr><th>Name</th><th>Mobile</th><th>WhatsApp</th><th>Email</th><th>Address</th><th>Orders</th><th>Total Spent</th><th>Last Order</th></tr>${d.customers.map(c => `<tr class="clickable" data-mobile="${esc(c.mobile)}"><td><button type="button" class="link-btn">${esc(c.name)}</button></td><td>${esc(c.mobile)}</td><td>${esc(c.whatsapp)}</td><td>${esc(c.email)}</td><td>${esc(c.address)}${c.city ? ', ' + esc(c.city) : ''}</td><td>${esc(c.orderCount)}</td><td>${esc(fmt(c.totalSpent))}</td><td class="small">${esc(fmtDate(c.lastOrderAt))}</td></tr>`).join('')}</table></div>` : `<div class="panel">${q ? 'No customers match this search.' : 'No customers yet. Customers appear here after their first order.'}</div>`);
    return true;
  } catch (e) {
    if (my === seq.customers && !silent && !e.sessionExpired) render($('customerList'), errHtml(e));
    return false;
  }
}
$('customerSearch').addEventListener('input', debounce(() => loadCustomers(), 250));
$('customerList').addEventListener('click', e => {
  const row = e.target.closest('[data-mobile]'); if (!row) return;
  $('orderSearch').value = row.dataset.mobile;
  $('orderStatusFilter').value = ''; $('orderPaymentFilter').value = '';
  openTab('orders');
  window.scrollTo(0, 0);
});

/* Settings */
let settingsDirty = false;
$('settingsForm').addEventListener('input', () => { settingsDirty = true; });
async function loadSettings() {
  if (settingsDirty) return;
  const my = ++seq.settings;
  try {
    const d = await api('/api/admin/settings');
    if (my !== seq.settings || !token || settingsDirty) return;
    const f = $('settingsForm');
    for (const k in d.settings) if (f.elements[k] && k !== 'whatsappApiToken') f.elements[k].value = d.settings[k] === null || d.settings[k] === undefined ? '' : d.settings[k];
    f.elements['whatsappApiToken'].value = '';
    $('tokenHint').style.display = d.settings.whatsappApiTokenSet ? 'block' : 'none';
  } catch (e) { if (!e.sessionExpired) $('settingsMsg').innerHTML = errHtml(e); }
}
$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault(); const fd = new FormData(e.target); const body = {};
  for (const [k, v] of fd.entries()) body[k] = k === 'deliveryFee' ? Number(v) : v;
  if (!body.whatsappApiToken) delete body.whatsappApiToken;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
    $('settingsMsg').innerHTML = '<div class="success">Settings saved.</div>';
    settingsDirty = false; loadSettings();
  } catch (err) { if (!err.sessionExpired) { $('settingsMsg').innerHTML = errHtml(err); toast(err.message, 5000); } }
});

/* Notifications */
async function loadNotifs(silent) {
  const my = ++seq.notifications;
  try {
    const d = await api('/api/admin/notifications');
    if (my !== seq.notifications || !token) return true;
    render($('notifList'), d.notifications.length ? d.notifications.map(n => `<div class="panel"><strong>${esc(String(n.channel || '').toUpperCase())}</strong> · Order ${esc(n.orderId)} · Status: <strong>${esc(n.status)}</strong> · <span class="small muted">${esc(fmtDate(n.createdAt))}</span>${n.to ? `<br><span class="small">To: ${esc(n.to)}</span>` : ''}${n.error ? `<br><span class="small muted">${esc(n.error)}</span>` : ''}<pre style="white-space:pre-wrap;font-family:inherit" class="small">${esc(n.body)}</pre></div>`).join('') : '<div class="panel">No notifications yet. Every order creates a WhatsApp + email log entry here.</div>');
    return true;
  } catch (e) {
    if (my === seq.notifications && !silent && !e.sessionExpired) render($('notifList'), errHtml(e));
    return false;
  }
}

initAuth();
