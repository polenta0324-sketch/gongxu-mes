const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'app.db');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ================= 数据表 =================
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'worker',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  role_group TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  spec TEXT DEFAULT '',
  unit TEXT DEFAULT '件'
);
CREATE TABLE IF NOT EXISTS sales_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  customer TEXT DEFAULT '',
  product_id INTEGER,
  qty INTEGER DEFAULT 0,
  due_date TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_no TEXT NOT NULL,
  product_id INTEGER,
  sales_order_no TEXT DEFAULT '',
  customer TEXT DEFAULT '',
  qty INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS work_order_steps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL,
  process_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT DEFAULT 'waiting',
  qty_ok INTEGER DEFAULT 0,
  qty_ng INTEGER DEFAULT 0,
  operator TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS inventory(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  type TEXT DEFAULT 'in',
  qty INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_wo ON work_order_steps(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
`);

// ================= 工具函数 =================
function hashPassword(pw){
  const salt = 'gongxu-mes-salt';
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function genToken(){
  return crypto.randomBytes(24).toString('hex');
}
function now(){
  return Date.now();
}
function json(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if(data.length > 20*1024*1024){ req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e){ resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function readRawBody(req){
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}
function pad(n){ return String(n).padStart(2,'0'); }
function fmtDate(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}
function fmtDateTime(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function genWorkOrderNo(){
  const d = new Date();
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth()+1) + pad(d.getDate());
  const n = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c + 1;
  return 'GD' + ymd + '-' + String(n).padStart(4, '0');
}

// ================= 初始化数据 =================
function seed(){
  const uc = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if(uc === 0){
    db.prepare('INSERT INTO users(username,password_hash,name,role,created_at) VALUES(?,?,?,?,?)')
      .run('admin', hashPassword('admin123'), '管理员', 'admin', now());
    db.prepare('INSERT INTO users(username,password_hash,name,role,created_at) VALUES(?,?,?,?,?)')
      .run('worker', hashPassword('123456'), '操作员', 'worker', now());
  }
  const pc = db.prepare('SELECT COUNT(*) c FROM processes').get().c;
  if(pc === 0){
    const names = ['来料检','放码','调色','造模','刷胶','贴膜','开缝','包装','检验'];
    const ins = db.prepare('INSERT INTO processes(name,sort_order) VALUES(?,?)');
    names.forEach((n,i) => ins.run(n, i+1));
  }
}
seed();

// ================= 权限 =================
function getUser(req){
  const auth = req.headers['authorization'] || '';
  if(!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if(!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  return row || null;
}
function requireAuth(req, res, role){
  const u = getUser(req);
  if(!u){ json(res, 401, { error: '未登录或登录已过期' }); return null; }
  if(role && u.role !== 'admin'){ json(res, 403, { error: '无权限，需要管理员' }); return null; }
  return u;
}

// ================= 业务查询 =================
function getWorkOrders(filter){
  const conds = [];
  const params = [];
  if(filter.status){
    if(filter.status === 'active'){ conds.push("w.status IN ('pending','in_progress')"); }
    else { conds.push('w.status = ?'); params.push(filter.status); }
  }
  if(filter.q){
    conds.push('(w.work_order_no LIKE ? OR p.name LIKE ? OR p.code LIKE ? OR w.customer LIKE ? OR w.sales_order_no LIKE ?)');
    const q = '%' + filter.q + '%';
    params.push(q,q,q,q,q);
  }
  if(filter.product_id){ conds.push('w.product_id = ?'); params.push(filter.product_id); }
  if(filter.from){ conds.push('w.created_at >= ?'); params.push(filter.from); }
  if(filter.to){ conds.push('w.created_at <= ?'); params.push(filter.to); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.prepare(`
    SELECT w.*, p.name AS product_name, p.code AS product_code, p.spec AS product_spec, p.unit AS unit
    FROM work_orders w LEFT JOIN products p ON p.id = w.product_id
    ${where} ORDER BY w.created_at DESC`).all(...params);
}
function workOrderProgress(woId){
  const steps = db.prepare('SELECT * FROM work_order_steps WHERE work_order_id = ? ORDER BY step_index').all(woId);
  const total = steps.length;
  const done = steps.filter(s => s.status === 'done').length;
  return { total, done, steps };
}
function serializeWorkOrder(w){
  const prog = workOrderProgress(w.id);
  return { ...w, progress_total: prog.total, progress_done: prog.done, steps: prog.steps };
}

// ================= 路由 =================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  // API
  if(pathname.startsWith('/api/')){
    try { await handleApi(req, res, method, pathname, url); }
    catch(e){ json(res, 500, { error: e.message || '服务器错误' }); }
    return;
  }

  // 静态文件
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC, filePath);
  if(!full.startsWith(PUBLIC)){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if(err){ res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(full).toLowerCase();
    const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

async function handleApi(req, res, method, pathname, url){
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const base = '/' + seg.slice(0,2).join('/');     // '/api/login' 等两级

  // 登录（无需鉴权）
  if(method === 'POST' && pathname === '/api/login'){
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username||''));
    if(!u || u.password_hash !== hashPassword(String(b.password||''))){
      return json(res, 401, { error: '账号或密码错误' });
    }
    const token = genToken();
    db.prepare('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(token, u.id, now());
    return json(res, 200, { token, user: { id:u.id, username:u.username, name:u.name, role:u.role } });
  }
  if(method === 'POST' && pathname === '/api/logout'){
    const auth = (req.headers['authorization']||'').slice(7).trim();
    if(auth) db.prepare('DELETE FROM sessions WHERE token = ?').run(auth);
    return json(res, 200, { ok: true });
  }
  if(method === 'GET' && pathname === '/api/me'){
    const u = requireAuth(req,res); if(!u) return;
    return json(res, 200, u);
  }
  if(method === 'GET' && pathname === '/api/health'){
    return json(res, 200, { ok: true, time: now() });
  }

  const user = requireAuth(req, res); if(!user) return;

  // ---------- 工艺路线 ----------
  if(method === 'GET' && pathname === '/api/processes'){
    return json(res, 200, db.prepare('SELECT * FROM processes ORDER BY sort_order').all());
  }
  if(method === 'POST' && pathname === '/api/processes'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const b = await readBody(req);
    const max = db.prepare('SELECT IFNULL(MAX(sort_order),0) m FROM processes').get().m;
    const r = db.prepare('INSERT INTO processes(name,sort_order,role_group) VALUES(?,?,?)').run(String(b.name||'').trim(), max+1, String(b.role_group||''));
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if(method === 'PUT' && pathname.startsWith('/api/processes/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    const b = await readBody(req);
    db.prepare('UPDATE processes SET name=?, role_group=? WHERE id=?').run(String(b.name||'').trim(), String(b.role_group||''), id);
    return json(res, 200, { ok: true });
  }
  if(method === 'DELETE' && pathname.startsWith('/api/processes/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    db.prepare('DELETE FROM processes WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }
  if(method === 'PUT' && pathname === '/api/processes-order'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const b = await readBody(req);
    const ids = b.ids || [];
    const up = db.prepare('UPDATE processes SET sort_order=? WHERE id=?');
    ids.forEach((id, i) => up.run(i+1, Number(id)));
    return json(res, 200, { ok: true });
  }

  // ---------- 产品/物料 ----------
  if(method === 'GET' && pathname === '/api/products'){
    const q = url.searchParams.get('q') || '';
    let rows;
    if(q){ rows = db.prepare('SELECT * FROM products WHERE name LIKE ? OR code LIKE ? ORDER BY id DESC').all('%'+q+'%','%'+q+'%'); }
    else { rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all(); }
    return json(res, 200, rows);
  }
  if(method === 'POST' && pathname === '/api/products'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const b = await readBody(req);
    try {
      const r = db.prepare('INSERT INTO products(code,name,spec,unit) VALUES(?,?,?,?)').run(String(b.code||'').trim(), String(b.name||'').trim(), String(b.spec||''), String(b.unit||'件'));
      return json(res, 200, { id: Number(r.lastInsertRowid) });
    } catch(e){ return json(res, 400, { error: '编码可能已存在' }); }
  }
  if(method === 'PUT' && pathname.startsWith('/api/products/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    const b = await readBody(req);
    db.prepare('UPDATE products SET code=?,name=?,spec=?,unit=? WHERE id=?').run(String(b.code||'').trim(), String(b.name||'').trim(), String(b.spec||''), String(b.unit||'件'), id);
    return json(res, 200, { ok: true });
  }
  if(method === 'DELETE' && pathname.startsWith('/api/products/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    db.prepare('DELETE FROM products WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  // ---------- 销售订单 ----------
  if(method === 'GET' && pathname === '/api/sales-orders'){
    const q = url.searchParams.get('q') || '';
    let rows;
    if(q){ rows = db.prepare(`SELECT s.*, p.name product_name FROM sales_orders s LEFT JOIN products p ON p.id=s.product_id WHERE s.order_no LIKE ? OR s.customer LIKE ? ORDER BY s.id DESC`).all('%'+q+'%','%'+q+'%'); }
    else { rows = db.prepare(`SELECT s.*, p.name product_name FROM sales_orders s LEFT JOIN products p ON p.id=s.product_id ORDER BY s.id DESC`).all(); }
    return json(res, 200, rows);
  }
  if(method === 'POST' && pathname === '/api/sales-orders'){
    const b = await readBody(req);
    const r = db.prepare('INSERT INTO sales_orders(order_no,customer,product_id,qty,due_date,status,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(b.order_no||'').trim(), String(b.customer||''), b.product_id?Number(b.product_id):null, Number(b.qty||0), String(b.due_date||''), String(b.status||'open'), String(b.note||''), now());
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if(method === 'PUT' && pathname.startsWith('/api/sales-orders/')){
    const id = Number(seg[2]);
    const b = await readBody(req);
    db.prepare('UPDATE sales_orders SET order_no=?,customer=?,product_id=?,qty=?,due_date=?,status=?,note=? WHERE id=?')
      .run(String(b.order_no||'').trim(), String(b.customer||''), b.product_id?Number(b.product_id):null, Number(b.qty||0), String(b.due_date||''), String(b.status||'open'), String(b.note||''), id);
    return json(res, 200, { ok: true });
  }
  if(method === 'DELETE' && pathname.startsWith('/api/sales-orders/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    db.prepare('DELETE FROM sales_orders WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  // ---------- 工单 ----------
  if(method === 'GET' && pathname === '/api/work-orders'){
    const filter = {
      status: url.searchParams.get('status') || '',
      q: url.searchParams.get('q') || '',
      product_id: url.searchParams.get('product_id') || '',
      from: url.searchParams.get('from') ? new Date(url.searchParams.get('from')).getTime() : null,
      to: url.searchParams.get('to') ? new Date(url.searchParams.get('to')).getTime() + 86400000 : null
    };
    const rows = getWorkOrders(filter).map(serializeWorkOrder);
    return json(res, 200, rows);
  }
  if(method === 'GET' && pathname.startsWith('/api/work-orders/')){
    const id = Number(seg[2]);
    const w = db.prepare(`SELECT w.*, p.name product_name, p.code product_code, p.spec product_spec, p.unit unit FROM work_orders w LEFT JOIN products p ON p.id=w.product_id WHERE w.id=?`).get(id);
    if(!w) return json(res, 404, { error: '工单不存在' });
    return json(res, 200, serializeWorkOrder(w));
  }
  if(method === 'POST' && pathname === '/api/work-orders'){
    const b = await readBody(req);
    const woNo = String(b.work_order_no||'').trim() || genWorkOrderNo();
    const procList = db.prepare('SELECT * FROM processes ORDER BY sort_order').all();
    const insert = db.prepare('INSERT INTO work_orders(work_order_no,product_id,sales_order_no,customer,qty,priority,status,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const r = insert.run(woNo, b.product_id?Number(b.product_id):null, String(b.sales_order_no||''), String(b.customer||''), Number(b.qty||0), String(b.priority||'normal'), 'pending', String(b.note||''), user.name || user.username, now());
    const woId = Number(r.lastInsertRowid);
    const insStep = db.prepare('INSERT INTO work_order_steps(work_order_id,process_id,step_index,status) VALUES(?,?,?,?)');
    procList.forEach((p, i) => insStep.run(woId, p.id, i+1, i===0 ? 'active' : 'waiting'));
    return json(res, 200, { id: woId });
  }
  if(method === 'PUT' && pathname.startsWith('/api/work-orders/')){
    const id = Number(seg[2]);
    const b = await readBody(req);
    db.prepare('UPDATE work_orders SET product_id=?,sales_order_no=?,customer=?,qty=?,priority=?,note=? WHERE id=?')
      .run(b.product_id?Number(b.product_id):null, String(b.sales_order_no||''), String(b.customer||''), Number(b.qty||0), String(b.priority||'normal'), String(b.note||''), id);
    return json(res, 200, { ok: true });
  }
  if(method === 'DELETE' && pathname.startsWith('/api/work-orders/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    db.prepare('DELETE FROM work_order_steps WHERE work_order_id=?').run(id);
    db.prepare('DELETE FROM work_orders WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  // 工单流转
  if(method === 'POST' && pathname.match(/^\/api\/work-orders\/\d+\/advance$/)){
    const id = Number(seg[2]);
    const b = await readBody(req);
    const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);
    if(!w) return json(res, 404, { error: '工单不存在' });
    if(w.status === 'cancelled') return json(res, 400, { error: '已取消的工单不能流转' });
    const steps = db.prepare('SELECT * FROM work_order_steps WHERE work_order_id=? ORDER BY step_index').all(id);
    const cur = steps.find(s => s.status === 'active');
    if(!cur) return json(res, 400, { error: '当前没有进行中的工序' });
    const qtyOk = Math.max(0, Number(b.qty_ok||0));
    const qtyNg = Math.max(0, Number(b.qty_ng||0));
    db.prepare("UPDATE work_order_steps SET status='done', qty_ok=?, qty_ng=?, operator=?, finished_at=? WHERE id=?").run(qtyOk, qtyNg, String(b.operator||user.name||user.username), now(), cur.id);
    const next = steps.find(s => s.step_index === cur.step_index + 1);
    if(next){
      db.prepare("UPDATE work_order_steps SET status='active', started_at=? WHERE id=?").run(now(), next.id);
      db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(id);
    } else {
      db.prepare("UPDATE work_orders SET status='done', finished_at=? WHERE id=?").run(now(), id);
    }
    return json(res, 200, { ok: true });
  }
  if(method === 'POST' && pathname.match(/^\/api\/work-orders\/\d+\/back$/)){
    const id = Number(seg[2]);
    const b = await readBody(req);
    const steps = db.prepare('SELECT * FROM work_order_steps WHERE work_order_id=? ORDER BY step_index').all(id);
    const cur = steps.find(s => s.status === 'active');
    let target = null;
    if(cur){ target = steps.find(s => s.step_index === cur.step_index - 1); if(target){ db.prepare("UPDATE work_order_steps SET status='waiting', started_at=NULL WHERE id=?").run(cur.id); } }
    else { target = steps[steps.length-1]; db.prepare("UPDATE work_orders SET status='in_progress', finished_at=NULL WHERE id=?").run(id); }
    if(!target) return json(res, 400, { error: '没有可退回的工序' });
    db.prepare("UPDATE work_order_steps SET status='active', operator=?, finished_at=NULL, started_at=? WHERE id=?").run(String(b.operator||user.name||user.username), now(), target.id);
    return json(res, 200, { ok: true });
  }
  if(method === 'POST' && pathname.match(/^\/api\/work-orders\/\d+\/cancel$/)){
    const id = Number(seg[2]);
    db.prepare("UPDATE work_orders SET status='cancelled' WHERE id=?").run(id);
    return json(res, 200, { ok: true });
  }
  if(method === 'POST' && pathname.match(/^\/api\/work-orders\/\d+\/reopen$/)){
    const id = Number(seg[2]);
    const steps = db.prepare('SELECT * FROM work_order_steps WHERE work_order_id=? ORDER BY step_index').all(id);
    const active = steps.find(s => s.status === 'active');
    if(!active){ db.prepare("UPDATE work_order_steps SET status='active', started_at=? WHERE id=?").run(now(), steps[0].id); }
    db.prepare("UPDATE work_orders SET status='in_progress', finished_at=NULL WHERE id=?").run(id);
    return json(res, 200, { ok: true });
  }
  if(method === 'POST' && pathname.match(/^\/api\/work-orders\/\d+\/start$/)){
    const id = Number(seg[2]);
    const steps = db.prepare('SELECT * FROM work_order_steps WHERE work_order_id=? ORDER BY step_index').all(id);
    const active = steps.find(s => s.status === 'active');
    if(!active){ db.prepare("UPDATE work_order_steps SET status='active', started_at=? WHERE id=?").run(now(), steps[0].id); }
    db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(id);
    return json(res, 200, { ok: true });
  }

  // ---------- 库存 ----------
  if(method === 'GET' && pathname === '/api/inventory'){
    const rows = db.prepare('SELECT i.*, p.name product_name, p.code product_code, p.unit unit FROM inventory i LEFT JOIN products p ON p.id=i.product_id ORDER BY i.id DESC LIMIT 500').all();
    const stock = {};
    rows.forEach(r => { const key = r.product_id || 0; if(!stock[key]) stock[key] = { product_id: r.product_id, product_name: r.product_name, product_code: r.product_code, unit: r.unit, qty: 0 }; stock[key].qty += (r.type === 'in' ? r.qty : -r.qty); });
    return json(res, 200, { records: rows, stock: Object.values(stock) });
  }
  if(method === 'POST' && pathname === '/api/inventory'){
    const b = await readBody(req);
    db.prepare('INSERT INTO inventory(product_id,type,qty,note,operator,created_at) VALUES(?,?,?,?,?,?)')
      .run(b.product_id?Number(b.product_id):null, String(b.type||'in'), Number(b.qty||0), String(b.note||''), String(b.operator||user.name||user.username), now());
    return json(res, 200, { ok: true });
  }

  // ---------- 统计 ----------
  if(method === 'GET' && pathname === '/api/stats/overview'){
    const total = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c;
    const pending = db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status='pending'").get().c;
    const inprog = db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status='in_progress'").get().c;
    const done = db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status='done'").get().c;
    const cancelled = db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status='cancelled'").get().c;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = db.prepare('SELECT COUNT(*) c FROM work_orders WHERE created_at >= ?').get(todayStart.getTime()).c;
    return json(res, 200, { total, pending, in_progress: inprog, done, cancelled, today, active: pending+inprog });
  }
  if(method === 'GET' && pathname === '/api/stats/by-process'){
    const procs = db.prepare('SELECT * FROM processes ORDER BY sort_order').all();
    const result = procs.map(p => {
      const c = db.prepare('SELECT COUNT(*) c FROM work_order_steps WHERE process_id=? AND status=?').get(p.id, 'active').c;
      const w = db.prepare(`SELECT COUNT(*) c FROM work_orders w JOIN work_order_steps s ON s.work_order_id=w.id WHERE s.process_id=? AND s.status='active' AND w.status<>'cancelled'`).get(p.id).c;
      return { id:p.id, name:p.name, active: c, waiting_wo: w };
    });
    return json(res, 200, result);
  }
  if(method === 'GET' && pathname === '/api/stats/report'){
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')).getTime() : (now()-30*86400000);
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')).getTime()+86400000 : now();
    const rows = db.prepare(`
      SELECT p.name AS product_name, w.work_order_no, w.qty,
             SUM(s.qty_ok) ok, SUM(s.qty_ng) ng
      FROM work_orders w
      LEFT JOIN products p ON p.id = w.product_id
      LEFT JOIN work_order_steps s ON s.work_order_id = w.id AND s.status='done'
      WHERE w.created_at >= ? AND w.created_at <= ?
      GROUP BY w.id ORDER BY w.created_at DESC`).all(from, to);
    return json(res, 200, rows);
  }
  if(method === 'GET' && pathname === '/api/stats/board'){
    const procs = db.prepare('SELECT * FROM processes ORDER BY sort_order').all();
    const result = procs.map(p => {
      const cards = db.prepare(`
        SELECT w.work_order_no, w.qty, p.name product_name, s.started_at
        FROM work_order_steps s
        JOIN work_orders w ON w.id = s.work_order_id
        LEFT JOIN products p ON p.id = w.product_id
        WHERE s.process_id=? AND s.status='active' AND w.status<>'cancelled'
        ORDER BY s.started_at`).all(p.id);
      return { id:p.id, name:p.name, cards };
    });
    const overview = {
      total: db.prepare('SELECT COUNT(*) c FROM work_orders').get().c,
      active: db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status IN ('pending','in_progress')").get().c,
      done: db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status='done'").get().c
    };
    return json(res, 200, { processes: result, overview });
  }

  // ---------- 用户管理 ----------
  if(method === 'GET' && pathname === '/api/users'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    return json(res, 200, db.prepare('SELECT id,username,name,role,created_at FROM users ORDER BY id').all());
  }
  if(method === 'POST' && pathname === '/api/users'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const b = await readBody(req);
    if(!String(b.username||'').trim() || !String(b.password||'')) return json(res, 400, { error: '账号和密码必填' });
    try {
      db.prepare('INSERT INTO users(username,password_hash,name,role,created_at) VALUES(?,?,?,?,?)')
        .run(String(b.username).trim(), hashPassword(String(b.password)), String(b.name||''), String(b.role||'worker'), now());
      return json(res, 200, { ok: true });
    } catch(e){ return json(res, 400, { error: '账号已存在' }); }
  }
  if(method === 'PUT' && pathname.startsWith('/api/users/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    const b = await readBody(req);
    if(b.password){
      db.prepare('UPDATE users SET name=?, role=?, password_hash=? WHERE id=?').run(String(b.name||''), String(b.role||'worker'), hashPassword(String(b.password)), id);
    } else {
      db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(String(b.name||''), String(b.role||'worker'), id);
    }
    return json(res, 200, { ok: true });
  }
  if(method === 'DELETE' && pathname.startsWith('/api/users/')){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const id = Number(seg[2]);
    if(id === user.id) return json(res, 400, { error: '不能删除自己' });
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  // ---------- 导出/备份 ----------
  if(method === 'GET' && pathname === '/api/export/work-orders'){
    const rows = getWorkOrders({});
    let csv = '\uFEFF工单号,产品名称,产品编码,规格,订单号,客户,数量,优先级,状态,创建时间,完工时间,备注\n';
    const statusMap = { pending:'待开始', in_progress:'进行中', done:'已完工', cancelled:'已取消' };
    for(const w of rows){
      csv += [w.work_order_no, (w.product_name||''), (w.product_code||''), (w.product_spec||''), (w.sales_order_no||''), (w.customer||''), w.qty, (w.priority||''), (statusMap[w.status]||w.status), fmtDateTime(w.created_at), fmtDateTime(w.finished_at), (w.note||'')].map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',') + '\n';
    }
    res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="work_orders.csv"' });
    return res.end(csv);
  }
  if(method === 'GET' && pathname === '/api/backup'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const dump = {
      version: 1, exported_at: fmtDateTime(now()),
      users: db.prepare('SELECT id,username,name,role,created_at FROM users').all(),
      processes: db.prepare('SELECT * FROM processes').all(),
      products: db.prepare('SELECT * FROM products').all(),
      sales_orders: db.prepare('SELECT * FROM sales_orders').all(),
      work_orders: db.prepare('SELECT * FROM work_orders').all(),
      work_order_steps: db.prepare('SELECT * FROM work_order_steps').all(),
      inventory: db.prepare('SELECT * FROM inventory').all()
    };
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Content-Disposition':'attachment; filename="mes_backup.json"' });
    return res.end(JSON.stringify(dump, null, 2));
  }
  if(method === 'POST' && pathname === '/api/restore'){
    if(user.role !== 'admin') return json(res, 403, { error: '需要管理员' });
    const raw = await readRawBody(req);
    let d; try { d = JSON.parse(raw); } catch(e){ return json(res, 400, { error: '备份文件格式错误' }); }
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM work_order_steps; DELETE FROM work_orders; DELETE FROM inventory; DELETE FROM sales_orders; DELETE FROM products; DELETE FROM processes;');
      const insP = db.prepare('INSERT INTO processes(id,name,sort_order,role_group) VALUES(?,?,?,?)');
      (d.processes||[]).forEach(x => insP.run(x.id, x.name, x.sort_order, x.role_group||''));
      const insPr = db.prepare('INSERT INTO products(id,code,name,spec,unit) VALUES(?,?,?,?,?)');
      (d.products||[]).forEach(x => insPr.run(x.id, x.code, x.name, x.spec||'', x.unit||'件'));
      const insSo = db.prepare('INSERT INTO sales_orders(id,order_no,customer,product_id,qty,due_date,status,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
      (d.sales_orders||[]).forEach(x => insSo.run(x.id, x.order_no, x.customer||'', x.product_id, x.qty, x.due_date||'', x.status||'open', x.note||'', x.created_at));
      const insW = db.prepare('INSERT INTO work_orders(id,work_order_no,product_id,sales_order_no,customer,qty,priority,status,note,created_by,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      (d.work_orders||[]).forEach(x => insW.run(x.id, x.work_order_no, x.product_id, x.sales_order_no||'', x.customer||'', x.qty, x.priority||'normal', x.status||'pending', x.note||'', x.created_by||'', x.created_at, x.finished_at));
      const insS = db.prepare('INSERT INTO work_order_steps(id,work_order_id,process_id,step_index,status,qty_ok,qty_ng,operator,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      (d.work_order_steps||[]).forEach(x => insS.run(x.id, x.work_order_id, x.process_id, x.step_index, x.status, x.qty_ok, x.qty_ng, x.operator||'', x.started_at, x.finished_at));
      const insI = db.prepare('INSERT INTO inventory(id,product_id,type,qty,note,operator,created_at) VALUES(?,?,?,?,?,?,?)');
      (d.inventory||[]).forEach(x => insI.run(x.id, x.product_id, x.type, x.qty, x.note||'', x.operator||'', x.created_at));
      db.exec('COMMIT');
      return json(res, 200, { ok: true });
    } catch(e){ db.exec('ROLLBACK'); return json(res, 400, { error: e.message }); }
  }

  json(res, 404, { error: '接口不存在' });
}

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for(const name in ifaces){ for(const it of ifaces[name]){ if(it.family === 'IPv4' && !it.internal) ips.push(it.address); } }
  console.log('==============================================');
  console.log('  工序流转 / 生产管理系统 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  ips.forEach(ip => console.log('  局域网访问: http://' + ip + ':' + PORT));
  console.log('  默认账号:   admin / admin123');
  console.log('==============================================');
});