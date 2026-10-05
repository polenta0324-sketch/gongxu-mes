const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];

let TOKEN = localStorage.getItem('mes_token') || '';
let USER = JSON.parse(localStorage.getItem('mes_user') || 'null');
let products = [];
let processes = [];
let currentPage = 'dashboard';

const STATUS = { pending:'待开始', in_progress:'进行中', done:'已完工', cancelled:'已取消' };
const PRIORITY = { low:'低', normal:'普通', high:'高', urgent:'紧急' };

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function pad(n){ return String(n).padStart(2,'0'); }
function fmt(ts){ if(!ts) return ''; const d=new Date(ts); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes()); }
function fmtDate(ts){ if(!ts) return ''; const d=new Date(ts); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }

async function api(path, opts={}){
  const headers = {};
  if(opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if(TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch('/api'+path, { ...opts, headers: { ...headers, ...(opts.headers||{}) } });
  if(res.status === 401){ doLogout(); throw new Error('登录已过期，请重新登录'); }
  const ct = res.headers.get('content-type')||'';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if(!res.ok) throw new Error((data && data.error) || ('请求失败 '+res.status));
  return data;
}

function toast(msg, isErr){
  let t = $('#toast');
  if(!t){ t = document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._tm); t._tm = setTimeout(()=>{ t.className='toast'; }, 2600);
}

function modal(html, wide){
  $('#modal-root').innerHTML = '<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal'+(wide?' wide':'')+'">'+html+'</div></div>';
}
function closeModal(){ $('#modal-root').innerHTML=''; }

async function doLogin(){
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  if(!username || !password){ toast('请输入账号和密码', true); return; }
  try {
    const r = await api('/login', { method:'POST', body: JSON.stringify({ username, password }) });
    TOKEN = r.token; USER = r.user;
    localStorage.setItem('mes_token', TOKEN); localStorage.setItem('mes_user', JSON.stringify(USER));
    enterApp();
  } catch(e){ toast(e.message, true); }
}
function doLogout(){
  try { api('/logout', { method:'POST' }); } catch(e){}
  TOKEN=''; USER=null; localStorage.removeItem('mes_token'); localStorage.removeItem('mes_user');
  $('#app').classList.add('hidden'); $('#login-page').classList.remove('hidden');
}
function enterApp(){
  $('#login-page').classList.add('hidden'); $('#app').classList.remove('hidden');
  renderNav(); renderSidebarUser(); showPage('dashboard');
}

const NAV = [
  { key:'dashboard', label:'工作台', icon:'📊' },
  { key:'workorders', label:'工单管理', icon:'📋' },
  { key:'processes', label:'工艺路线', icon:'🔀' },
  { key:'products', label:'产品物料', icon:'📦' },
  { key:'sales', label:'销售订单', icon:'🧾' },
  { key:'inventory', label:'库存管理', icon:'🏬' },
  { key:'board', label:'车间看板', icon:'🖥️' },
  { key:'report', label:'报表分析', icon:'📈' },
  { key:'settings', label:'系统设置', icon:'⚙️', admin:true }
];
function renderNav(){
  $('#nav').innerHTML = NAV.filter(n => !n.admin || (USER && USER.role==='admin'))
    .map(n => '<div class="nav-item'+(n.key===currentPage?' active':'')+'" data-key="'+n.key+'"><span>'+n.icon+'</span>'+n.label+'</div>').join('');
  $$('#nav .nav-item').forEach(el => el.addEventListener('click', () => showPage(el.dataset.key)));
}
function renderSidebarUser(){
  $('#sidebar-user').innerHTML = (USER ? esc(USER.name||USER.username) : '') + '<br><span style="color:#4b5563">'+(USER.role==='admin'?'管理员':'操作员')+'</span>';
  $('#top-user').textContent = USER ? (USER.name||USER.username) : '';
}
const PAGE_TITLE = { dashboard:'工作台', workorders:'工单管理', processes:'工艺路线', products:'产品物料', sales:'销售订单', inventory:'库存管理', board:'车间看板', report:'报表分析', settings:'系统设置' };

async function showPage(key){
  currentPage = key;
  $('#crumb').textContent = PAGE_TITLE[key] || '';
  renderNav();
  const c = $('#content');
  c.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    if(key === 'dashboard') await pageDashboard(c);
    else if(key === 'workorders') await pageWorkOrders(c);
    else if(key === 'processes') await pageProcesses(c);
    else if(key === 'products') await pageProducts(c);
    else if(key === 'sales') await pageSales(c);
    else if(key === 'inventory') await pageInventory(c);
    else if(key === 'board') await pageBoard(c);
    else if(key === 'report') await pageReport(c);
    else if(key === 'settings') await pageSettings(c);
  } catch(e){ c.innerHTML = '<div class="empty-tip">加载失败：'+esc(e.message)+'</div>'; }
}

async function refreshProducts(){ products = await api('/products'); }
async function refreshProcesses(){ processes = await api('/processes'); }
function productOptions(sel){
  return '<option value="">— 选择产品 —</option>' + products.map(p => '<option value="'+p.id+'"'+(Number(sel)===p.id?' selected':'')+'>'+esc(p.name)+'（'+esc(p.code)+'）</option>').join('');
}

async function pageDashboard(c){
  const ov = await api('/stats/overview');
  const bp = await api('/stats/by-process');
  const recent = await api('/work-orders');
  let html = '<div class="stats">'
    + '<div class="stat c-blue"><div class="n">'+ov.total+'</div><div class="t">工单总数</div></div>'
    + '<div class="stat c-orange"><div class="n">'+ov.active+'</div><div class="t">执行中</div></div>'
    + '<div class="stat c-green"><div class="n">'+ov.done+'</div><div class="t">已完工</div></div>'
    + '<div class="stat c-red"><div class="n">'+ov.cancelled+'</div><div class="t">已取消</div></div>'
    + '<div class="stat"><div class="n">'+ov.today+'</div><div class="t">今日新增</div></div>'
    + '</div>';
  html += '<div class="panel"><h3>各工序在制情况</h3><div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));">';
  bp.forEach(p => { html += '<div class="stat"><div class="n">'+p.active+'</div><div class="t">'+esc(p.name)+'</div></div>'; });
  html += '</div></div>';
  html += '<div class="panel"><h3>最近工单</h3>' + workOrderTable(recent.slice(0,10)) + '</div>';
  c.innerHTML = html;
}

function workOrderTable(rows){
  if(!rows.length) return '<div class="empty-tip">暂无工单</div>';
  let h = '<table class="table"><thead><tr><th>工单号</th><th>产品名称</th><th>订单号</th><th>数量</th><th>优先级</th><th>进度</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>';
  rows.forEach(w => {
    const pct = w.progress_total ? Math.round(w.progress_done/w.progress_total*100) : 0;
    h += '<tr>'
      + '<td>'+esc(w.work_order_no)+'</td>'
      + '<td>'+esc(w.product_name||'—')+'</td>'
      + '<td>'+esc(w.sales_order_no||'—')+'</td>'
      + '<td>'+w.qty+'</td>'
      + '<td>'+esc(PRIORITY[w.priority]||w.priority)+'</td>'
      + '<td><div class="progress"><i style="width:'+pct+'%"></i></div><span class="muted">'+w.progress_done+'/'+w.progress_total+'</span></td>'
      + '<td><span class="tag '+w.status+'">'+STATUS[w.status]+'</span></td>'
      + '<td>'+fmt(w.created_at)+'</td>'
      + '<td><button class="sm" onclick="openWorkOrder('+w.id+')">详情/流转</button></td>'
      + '</tr>';
  });
  return h + '</tbody></table>';
}

let woFilter = { status:'', q:'' };
async function pageWorkOrders(c){
  await Promise.all([refreshProducts(), refreshProcesses()]);
  c.innerHTML = '<div class="toolbar">'
    + '<div class="tabs" id="wo-tabs">'
    + '<button class="tab'+(woFilter.status===''?' active':'')+'" data-status="">全部</button>'
    + '<button class="tab'+(woFilter.status==='active'?' active':'')+'" data-status="active">执行中</button>'
    + '<button class="tab'+(woFilter.status==='done'?' active':'')+'" data-status="done">已完工</button>'
    + '<button class="tab'+(woFilter.status==='cancelled'?' active':'')+'" data-status="cancelled">已取消</button>'
    + '</div>'
    + '<input class="grow" id="wo-q" placeholder="搜索工单号 / 产品 / 客户 / 订单号" value="'+esc(woFilter.q)+'" style="max-width:320px">'
    + '<button class="primary" onclick="newWorkOrder()">＋ 创建工单</button>'
    + '<button onclick="exportCSV()">导出 CSV</button>'
    + '</div><div id="wo-list"></div>';
  $('#wo-q').addEventListener('keydown', e => { if(e.key==='Enter'){ woFilter.q=e.target.value; loadWorkOrders(); } });
  $('#wo-q').addEventListener('change', e => { woFilter.q=e.target.value; });
  $$('#wo-tabs .tab').forEach(t => t.addEventListener('click', () => { woFilter.status=t.dataset.status; pageWorkOrders(c); }));
  await loadWorkOrders();
}
async function loadWorkOrders(){
  const q = new URLSearchParams(); if(woFilter.status) q.set('status', woFilter.status); if(woFilter.q) q.set('q', woFilter.q);
  const rows = await api('/work-orders?' + q.toString());
  $('#wo-list').innerHTML = workOrderTable(rows);
}

async function newWorkOrder(){
  await refreshProducts();
  modal('<h3>创建工单</h3>'
    + '<div class="form-row"><div class="field"><label>产品 *</label><select id="f-product">'+productOptions()+'</select></div>'
    + '<div class="field"><label>数量 *</label><input id="f-qty" type="number" min="1" value="1"></div></div>'
    + '<div class="form-row"><div class="field"><label>订单号</label><input id="f-sono" placeholder="可选"></div>'
    + '<div class="field"><label>客户</label><input id="f-customer" placeholder="可选"></div></div>'
    + '<div class="form-row"><div class="field"><label>优先级</label><select id="f-priority"><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option><option value="low">低</option></select></div>'
    + '<div class="field"><label>备注</label><input id="f-note" placeholder="可选"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveWorkOrder()">保存</button></div>');
}
async function saveWorkOrder(){
  const body = { product_id: $('#f-product').value?Number($('#f-product').value):null, qty: Number($('#f-qty').value||0), sales_order_no: $('#f-sono').value.trim(), customer: $('#f-customer').value.trim(), priority: $('#f-priority').value, note: $('#f-note').value.trim() };
  if(!body.product_id){ toast('请选择产品', true); return; }
  if(body.qty<=0){ toast('数量必须大于 0', true); return; }
  try { await api('/work-orders', { method:'POST', body: JSON.stringify(body) }); closeModal(); toast('工单已创建'); await loadWorkOrders(); } catch(e){ toast(e.message,true); }
}

async function openWorkOrder(id){
  const w = await api('/work-orders/'+id);
  const pct = w.progress_total ? Math.round(w.progress_done/w.progress_total*100) : 0;
  let stepsHtml = '<ul class="steps">';
  w.steps.forEach((s,i) => {
    const cls = s.status==='active' ? 'active' : (s.status==='done' ? 'done' : '');
    stepsHtml += '<li class="'+cls+'"><span class="idx">'+(i+1)+'</span><span class="info"><div class="name">'+esc(processName(s.process_id))+'</div><div class="meta">'
      + (s.status==='done' ? '完工 '+fmt(s.finished_at)+' · 良品'+s.qty_ok+' · 不良'+s.qty_ng+' · '+esc(s.operator||'') : (s.status==='active' ? '进行中' : '等待中'))
      + '</div></span><span class="tag '+(s.status==='active'?'active':(s.status==='done'?'step-done':'waiting'))+'">'+(s.status==='active'?'进行中':(s.status==='done'?'完成':'待做'))+'</span></li>';
  });
  stepsHtml += '</ul>';

  let actions = '';
  const activeStep = w.steps.find(s => s.status==='active');
  if(w.status === 'pending'){
    actions += '<button class="primary" onclick="startWorkOrder('+w.id+')">开始生产</button>';
  } else if(w.status === 'in_progress' && activeStep){
    actions += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding:10px;background:#f8fafc;border-radius:8px;">'
      + '<span>良品</span><input id="step-ok" type="number" value="'+w.qty+'" style="width:90px">'
      + '<span>不良</span><input id="step-ng" type="number" value="0" style="width:90px">'
      + '<button class="primary" onclick="advanceStep('+w.id+')">完成进入下一道 ▶</button>'
      + '<button onclick="backStep('+w.id+')">退回上一道</button>'
      + '</div>';
  } else if(w.status === 'done'){
    actions += '<button onclick="reopenWorkOrder('+w.id+')">重新开工</button>';
  }
  if(w.status === 'cancelled'){ actions += '<button class="primary" onclick="reopenWorkOrder('+w.id+')">恢复工单</button>'; }

  modal('<h3>'+esc(w.work_order_no)+' · '+esc(w.product_name||'—')+'</h3>'
    + '<div class="stats" style="grid-template-columns:repeat(4,1fr);">'
    + '<div class="stat"><div class="n">'+w.qty+'</div><div class="t">数量</div></div>'
    + '<div class="stat"><div class="n">'+pct+'%</div><div class="t">进度</div></div>'
    + '<div class="stat"><div class="n"><span class="tag '+w.status+'">'+STATUS[w.status]+'</span></div><div class="t">状态</div></div>'
    + '<div class="stat"><div class="n">'+esc(w.customer||'—')+'</div><div class="t">客户</div></div>'
    + '</div>'
    + (w.note ? '<p class="muted" style="margin-bottom:8px">备注：'+esc(w.note)+'</p>' : '')
    + stepsHtml
    + '<div class="actions" style="justify-content:space-between;">'
    + '<span>' + (w.status==='pending'||w.status==='in_progress' ? '<button class="danger sm" onclick="cancelWorkOrder('+w.id+')">取消工单</button>' : '')
    + (USER && USER.role==='admin' ? '<button class="danger sm" onclick="deleteWorkOrder('+w.id+')" style="margin-left:6px">删除</button>' : '') + '</span>'
    + '<span><button onclick="closeModal()">关闭</button> ' + actions + '</span></div>', true);
}
function processName(id){ const p = processes.find(x => x.id===id); return p ? p.name : '—'; }

async function startWorkOrder(id){ await api('/work-orders/'+id+'/start', { method:'POST' }); toast('已开始'); closeModal(); await loadWorkOrders(); }
async function advanceStep(id){
  const ok = Number($('#step-ok').value||0), ng = Number($('#step-ng').value||0);
  await api('/work-orders/'+id+'/advance', { method:'POST', body: JSON.stringify({ qty_ok: ok, qty_ng: ng }) });
  toast('已流转到下一道'); closeModal(); await loadWorkOrders();
}
async function backStep(id){ await api('/work-orders/'+id+'/back', { method:'POST' }); toast('已退回'); closeModal(); await loadWorkOrders(); }
async function cancelWorkOrder(id){ if(!confirm('确认取消该工单？')) return; await api('/work-orders/'+id+'/cancel', { method:'POST' }); toast('已取消'); closeModal(); await loadWorkOrders(); }
async function reopenWorkOrder(id){ await api('/work-orders/'+id+'/reopen', { method:'POST' }); toast('已恢复'); closeModal(); await loadWorkOrders(); }
async function deleteWorkOrder(id){ if(!confirm('确认删除该工单？此操作不可恢复')) return; await api('/work-orders/'+id, { method:'DELETE' }); toast('已删除'); closeModal(); await loadWorkOrders(); }

async function exportCSV(){
  const res = await fetch('/api/export/work-orders', { headers: { 'Authorization':'Bearer '+TOKEN } });
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '工单_'+fmtDate(Date.now())+'.csv'; a.click();
}
// ============ 工艺路线 ============
async function pageProcesses(c){
  const rows = await api('/processes');
  processes = rows;
  let h = '<div class="toolbar"><span class="muted">共 '+rows.length+' 道工序，按顺序流转</span><span class="grow"></span><button class="primary" onclick="newProcess()">＋ 添加工序</button></div>';
  h += '<div class="panel"><table class="table"><thead><tr><th style="width:60px">顺序</th><th>工序名称</th><th>负责岗位</th><th style="width:180px">操作</th></tr></thead><tbody>';
  rows.forEach((p,i) => {
    h += '<tr><td>'+p.sort_order+'</td><td><b>'+esc(p.name)+'</b></td><td>'+esc(p.role_group||'—')+'</td><td>'
      + '<button class="sm" onclick="moveProcess('+p.id+',-1)">↑</button> '
      + '<button class="sm" onclick="moveProcess('+p.id+',1)">↓</button> '
      + '<button class="sm" onclick="editProcess('+p.id+')">编辑</button> '
      + '<button class="sm danger" onclick="deleteProcess('+p.id+')">删除</button></td></tr>';
  });
  h += '</tbody></table></div>';
  c.innerHTML = h;
}
function processForm(p){
  return '<h3>'+(p?'编辑工序':'添加工序')+'</h3>'
    + '<div class="form-row"><div class="field"><label>工序名称 *</label><input id="f-name" value="'+esc(p?p.name:'')+'"></div>'
    + '<div class="field"><label>负责岗位（可选）</label><input id="f-role" value="'+esc(p?(p.role_group||''):'')+'" placeholder="例：检验组"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveProcess('+(p?p.id:'null')+')">保存</button></div>';
}
function newProcess(){ modal(processForm(null)); }
function editProcess(id){ const p = processes.find(x=>x.id===id); modal(processForm(p)); }
async function saveProcess(id){
  const body = { name: $('#f-name').value.trim(), role_group: $('#f-role').value.trim() };
  if(!body.name){ toast('请输入工序名称', true); return; }
  if(id){ await api('/processes/'+id, { method:'PUT', body: JSON.stringify(body) }); }
  else { await api('/processes', { method:'POST', body: JSON.stringify(body) }); }
  closeModal(); await showPage('processes');
}
async function deleteProcess(id){ if(!confirm('确认删除该工序？')) return; await api('/processes/'+id, { method:'DELETE' }); await showPage('processes'); }
async function moveProcess(id, dir){
  const idx = processes.findIndex(x=>x.id===id);
  const target = idx+dir;
  if(target<0 || target>=processes.length) return;
  const ids = processes.map(x=>x.id);
  const tmp = ids[idx]; ids[idx]=ids[target]; ids[target]=tmp;
  await api('/processes-order', { method:'PUT', body: JSON.stringify({ ids }) });
  await showPage('processes');
}

// ============ 产品物料 ============
async function pageProducts(c){
  const rows = await api('/products');
  products = rows;
  let h = '<div class="toolbar"><input id="p-q" placeholder="搜索产品名称/编码" style="max-width:260px"><span class="grow"></span><button class="primary" onclick="newProduct()">＋ 新增产品</button></div>';
  h += '<div class="panel"><table class="table"><thead><tr><th>编码</th><th>名称</th><th>规格</th><th>单位</th><th style="width:130px">操作</th></tr></thead><tbody>';
  rows.forEach(p => { h += '<tr><td>'+esc(p.code)+'</td><td><b>'+esc(p.name)+'</b></td><td>'+esc(p.spec||'—')+'</td><td>'+esc(p.unit)+'</td><td><button class="sm" onclick="editProduct('+p.id+')">编辑</button> <button class="sm danger" onclick="deleteProduct('+p.id+')">删除</button></td></tr>'; });
  h += '</tbody></table></div>';
  c.innerHTML = h;
  $('#p-q').addEventListener('keydown', async e => { if(e.key==='Enter'){ const rows2=await api('/products?q='+encodeURIComponent(e.target.value)); products=rows2; pageProducts(c); } });
}
function productForm(p){
  return '<h3>'+(p?'编辑产品':'新增产品')+'</h3>'
    + '<div class="form-row"><div class="field"><label>编码 *</label><input id="f-code" value="'+esc(p?p.code:'')+'"></div>'
    + '<div class="field"><label>名称 *</label><input id="f-name" value="'+esc(p?p.name:'')+'"></div></div>'
    + '<div class="form-row"><div class="field"><label>规格</label><input id="f-spec" value="'+esc(p?p.spec||'':'')+'"></div>'
    + '<div class="field"><label>单位</label><input id="f-unit" value="'+esc(p?p.unit||'件':'')+'"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveProduct('+(p?p.id:'null')+')">保存</button></div>';
}
function newProduct(){ modal(productForm(null)); }
function editProduct(id){ const p = products.find(x=>x.id===id); modal(productForm(p)); }
async function saveProduct(id){
  const body = { code: $('#f-code').value.trim(), name: $('#f-name').value.trim(), spec: $('#f-spec').value.trim(), unit: $('#f-unit').value.trim()||'件' };
  if(!body.code || !body.name){ toast('编码和名称必填', true); return; }
  if(id){ await api('/products/'+id, { method:'PUT', body: JSON.stringify(body) }); }
  else { await api('/products', { method:'POST', body: JSON.stringify(body) }); }
  closeModal(); await showPage('products');
}
async function deleteProduct(id){ if(!confirm('确认删除该产品？')) return; await api('/products/'+id, { method:'DELETE' }); await showPage('products'); }

// ============ 销售订单 ============
async function pageSales(c){
  await refreshProducts();
  const rows = await api('/sales-orders');
  let h = '<div class="toolbar"><span class="grow"></span><button class="primary" onclick="newSales()">＋ 新增订单</button></div>';
  h += '<div class="panel"><table class="table"><thead><tr><th>订单号</th><th>客户</th><th>产品</th><th>数量</th><th>交期</th><th>状态</th><th style="width:130px">操作</th></tr></thead><tbody>';
  rows.forEach(s => { h += '<tr><td>'+esc(s.order_no)+'</td><td>'+esc(s.customer||'—')+'</td><td>'+esc(s.product_name||'—')+'</td><td>'+s.qty+'</td><td>'+esc(s.due_date||'—')+'</td><td>'+esc(s.status==='closed'?'已关闭':'进行中')+'</td><td><button class="sm" onclick="editSales('+s.id+')">编辑</button> <button class="sm danger" onclick="deleteSales('+s.id+')">删除</button></td></tr>'; });
  h += '</tbody></table></div>';
  c.innerHTML = h;
}
function salesForm(s){
  return '<h3>'+(s?'编辑订单':'新增订单')+'</h3>'
    + '<div class="form-row"><div class="field"><label>订单号 *</label><input id="f-ono" value="'+esc(s?s.order_no:'')+'"></div>'
    + '<div class="field"><label>客户</label><input id="f-cust" value="'+esc(s?s.customer||'':'')+'"></div></div>'
    + '<div class="form-row"><div class="field"><label>产品</label><select id="f-prod">'+productOptions(s?s.product_id:null)+'</select></div>'
    + '<div class="field"><label>数量</label><input id="f-qty" type="number" value="'+esc(s?s.qty:'')+'"></div></div>'
    + '<div class="form-row"><div class="field"><label>交期</label><input id="f-due" type="date" value="'+esc(s?s.due_date:'')+'"></div>'
    + '<div class="field"><label>状态</label><select id="f-st"><option value="open"'+(s&&s.status!=='closed'?' selected':'')+'>进行中</option><option value="closed"'+(s&&s.status==='closed'?' selected':'')+'>已关闭</option></select></div></div>'
    + '<div class="form-row"><div class="field full"><label>备注</label><input id="f-note" value="'+esc(s?s.note||'':'')+'"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveSales('+(s?s.id:'null')+')">保存</button></div>';
}
function newSales(){ modal(salesForm(null)); }
function editSales(id){ api('/sales-orders').then(rows => { const s = rows.find(x=>x.id===id); modal(salesForm(s)); }); }
async function saveSales(id){
  const body = { order_no: $('#f-ono').value.trim(), customer: $('#f-cust').value.trim(), product_id: $('#f-prod').value?Number($('#f-prod').value):null, qty: Number($('#f-qty').value||0), due_date: $('#f-due').value, status: $('#f-st').value, note: $('#f-note').value.trim() };
  if(!body.order_no){ toast('请输入订单号', true); return; }
  if(id){ await api('/sales-orders/'+id, { method:'PUT', body: JSON.stringify(body) }); }
  else { await api('/sales-orders', { method:'POST', body: JSON.stringify(body) }); }
  closeModal(); await showPage('sales');
}
async function deleteSales(id){ if(!confirm('确认删除该订单？')) return; await api('/sales-orders/'+id, { method:'DELETE' }); await showPage('sales'); }
// ============ 库存 ============
async function pageInventory(c){
  await refreshProducts();
  const data = await api('/inventory');
  let h = '<div class="toolbar"><span class="grow"></span><button class="primary" onclick="newInventory()">＋ 出入库</button></div>';
  h += '<div class="panel"><h3>当前库存</h3><table class="table"><thead><tr><th>产品</th><th>编码</th><th>单位</th><th>库存数量</th></tr></thead><tbody>';
  data.stock.forEach(s => { h += '<tr><td><b>'+esc(s.product_name||'—')+'</b></td><td>'+esc(s.product_code||'')+'</td><td>'+esc(s.unit||'')+'</td><td>'+s.qty+'</td></tr>'; });
  h += '</tbody></table></div>';
  h += '<div class="panel"><h3>出入库记录</h3><table class="table"><thead><tr><th>时间</th><th>产品</th><th>类型</th><th>数量</th><th>备注</th><th>操作人</th></tr></thead><tbody>';
  data.records.slice(0,200).forEach(r => { h += '<tr><td>'+fmt(r.created_at)+'</td><td>'+esc(r.product_name||'—')+'</td><td>'+(r.type==='in'?'<span class="tag done">入库</span>':'<span class="tag pending">出库</span>')+'</td><td>'+r.qty+'</td><td>'+esc(r.note||'')+'</td><td>'+esc(r.operator||'')+'</td></tr>'; });
  h += '</tbody></table></div>';
  c.innerHTML = h;
}
function newInventory(){
  modal('<h3>出入库</h3>'
    + '<div class="form-row"><div class="field"><label>产品</label><select id="f-prod">'+productOptions()+'</select></div>'
    + '<div class="field"><label>类型</label><select id="f-type"><option value="in">入库</option><option value="out">出库</option></select></div></div>'
    + '<div class="form-row"><div class="field"><label>数量 *</label><input id="f-qty" type="number" min="1" value="1"></div>'
    + '<div class="field"><label>备注</label><input id="f-note"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveInventory()">保存</button></div>');
}
async function saveInventory(){
  const body = { product_id: $('#f-prod').value?Number($('#f-prod').value):null, type: $('#f-type').value, qty: Number($('#f-qty').value||0), note: $('#f-note').value.trim() };
  if(body.qty<=0){ toast('数量必须大于 0', true); return; }
  await api('/inventory', { method:'POST', body: JSON.stringify(body) });
  closeModal(); await showPage('inventory');
}

// ============ 车间看板 ============
async function pageBoard(c){
  const data = await api('/stats/board');
  c.innerHTML = '<div class="stats" style="grid-template-columns:repeat(3,1fr);">'
    + '<div class="stat c-blue"><div class="n">'+data.overview.total+'</div><div class="t">工单总数</div></div>'
    + '<div class="stat c-orange"><div class="n">'+data.overview.active+'</div><div class="t">执行中</div></div>'
    + '<div class="stat c-green"><div class="n">'+data.overview.done+'</div><div class="t">已完工</div></div></div>'
    + '<div class="board">' + data.processes.map(p => '<div class="col"><div class="col-head"><span>'+esc(p.name)+'</span><span class="badge">'+p.cards.length+'</span></div>'
      + (p.cards.length ? p.cards.map(w => '<div class="card"><div class="wo">'+esc(w.work_order_no)+'</div><div class="p">'+esc(w.product_name||'—')+'</div><div class="muted">数量 '+w.qty+'</div></div>').join('') : '<div class="empty">—</div>')
      + '</div>').join('') + '</div>';
}

// ============ 报表 ============
async function pageReport(c){
  const from = fmtDate(Date.now()-30*86400000), to = fmtDate(Date.now());
  c.innerHTML = '<div class="toolbar"><input id="r-from" type="date" value="'+from+'"><span>至</span><input id="r-to" type="date" value="'+to+'"><button class="primary" onclick="loadReport()">查询</button></div><div id="r-body"></div>';
  await loadReport();
}
async function loadReport(){
  const from = $('#r-from').value, to = $('#r-to').value;
  const rows = await api('/stats/report?from='+from+'&to='+to);
  let totalOk=0, totalNg=0;
  let h = '<div class="panel"><h3>完工统计（'+from+' ~ '+to+'）</h3><table class="table"><thead><tr><th>工单号</th><th>产品</th><th>计划数量</th><th>良品</th><th>不良</th><th>良率</th></tr></thead><tbody>';
  rows.forEach(r => {
    totalOk += (r.ok||0); totalNg += (r.ng||0);
    const sum=(r.ok||0)+(r.ng||0); const rate = sum? Math.round(r.ok/sum*100):0;
    h += '<tr><td>'+esc(r.work_order_no)+'</td><td>'+esc(r.product_name||'—')+'</td><td>'+r.qty+'</td><td>'+(r.ok||0)+'</td><td>'+(r.ng||0)+'</td><td>'+rate+'%</td></tr>';
  });
  h += '</tbody></table></div>';
  h = '<div class="stats" style="grid-template-columns:repeat(3,1fr);"><div class="stat"><div class="n">'+rows.length+'</div><div class="t">工单数</div></div><div class="stat c-green"><div class="n">'+totalOk+'</div><div class="t">总良品</div></div><div class="stat c-red"><div class="n">'+totalNg+'</div><div class="t">总不良</div></div></div>' + h;
  $('#r-body').innerHTML = h;
}

// ============ 系统设置 ============
async function pageSettings(c){
  const users = await api('/users');
  let h = '<div class="grid2"><div class="panel"><h3>用户管理</h3><div class="toolbar"><span class="grow"></span><button class="primary sm" onclick="newUser()">＋ 新增用户</button></div>'
    + '<table class="table"><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th style="width:120px">操作</th></tr></thead><tbody>';
  users.forEach(u => { h += '<tr><td>'+esc(u.username)+'</td><td>'+esc(u.name||'')+'</td><td>'+(u.role==='admin'?'<span class="tag in_progress">管理员</span>':'<span class="tag waiting">操作员</span>')+'</td><td><button class="sm" onclick="editUser('+u.id+')">编辑</button> <button class="sm danger" onclick="deleteUser('+u.id+')">删除</button></td></tr>'; });
  h += '</tbody></table></div>';
  h += '<div class="panel"><h3>数据备份</h3><p class="muted" style="margin-bottom:12px">备份包含工单、产品、订单、库存、工序等全部数据（不含用户密码）。</p>'
    + '<button class="primary" onclick="downloadBackup()">下载备份文件</button> '
    + '<button onclick="document.getElementById(\'restore-file\').click()">恢复备份</button>'
    + '<input type="file" id="restore-file" accept=".json" style="display:none" onchange="doRestore(event)"></div>';
  h += '<div class="panel"><h3>关于</h3><p class="muted">工序流转 / 生产管理系统 · 数据存储在本机 SQLite 数据库 · 支持局域网多终端访问</p></div></div>';
  c.innerHTML = h;
}
function userForm(u){
  return '<h3>'+(u?'编辑用户':'新增用户')+'</h3>'
    + '<div class="form-row"><div class="field"><label>账号 *</label><input id="f-uname" value="'+esc(u?u.username:'')+'" '+(u?'disabled':'')+'></div>'
    + '<div class="field"><label>姓名</label><input id="f-name" value="'+esc(u?u.name||'':'')+'"></div></div>'
    + '<div class="form-row"><div class="field"><label>角色</label><select id="f-role"><option value="worker"'+(u&&u.role==='worker'?' selected':'')+'>操作员</option><option value="admin"'+(u&&u.role==='admin'?' selected':'')+'>管理员</option></select></div>'
    + '<div class="field"><label>密码'+(u?'（留空则不修改）':'')+'</label><input id="f-pass" type="password" placeholder="'+(u?'不修改请留空':'必填')+'"></div></div>'
    + '<div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="saveUser('+(u?u.id:'null')+')">保存</button></div>';
}
function newUser(){ modal(userForm(null)); }
function editUser(id){ api('/users').then(us => modal(userForm(us.find(x=>x.id===id)))); }
async function saveUser(id){
  const body = { username: $('#f-uname').value.trim(), name: $('#f-name').value.trim(), role: $('#f-role').value, password: $('#f-pass').value };
  if(!id && !body.password){ toast('请设置初始密码', true); return; }
  if(!body.password) delete body.password;
  if(id){ await api('/users/'+id, { method:'PUT', body: JSON.stringify(body) }); }
  else { await api('/users', { method:'POST', body: JSON.stringify(body) }); }
  closeModal(); await showPage('settings');
}
async function deleteUser(id){ if(!confirm('确认删除该用户？')) return; await api('/users/'+id, { method:'DELETE' }); await showPage('settings'); }
async function downloadBackup(){
  const res = await fetch('/api/backup', { headers: { 'Authorization':'Bearer '+TOKEN } });
  const blob = await res.blob();
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='生产系统备份_'+fmtDate(Date.now())+'.json'; a.click();
}
async function doRestore(ev){
  const f = ev.target.files[0]; if(!f) return;
  if(!confirm('恢复将覆盖当前全部数据，确认继续？')) { ev.target.value=''; return; }
  const txt = await f.text();
  try { await api('/restore', { method:'POST', body: txt }); toast('恢复成功'); setTimeout(()=>location.reload(), 800); }
  catch(e){ toast(e.message, true); }
  ev.target.value='';
}

// ============ 启动 ============
$('#login-btn').addEventListener('click', doLogin);
$('#login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
$('#logout-btn').addEventListener('click', doLogout);

if(TOKEN){
  api('/me').then(u => { USER = u; localStorage.setItem('mes_user', JSON.stringify(u)); enterApp(); }).catch(()=>{ doLogout(); });
} else {
  $('#login-page').classList.remove('hidden');
}