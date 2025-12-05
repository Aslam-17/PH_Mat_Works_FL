// index.js - minimal prototype (in-memory) for testing UI + sockets
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const cookieParser = require('cookie-parser'); // small helper for simple cookie auth

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

// --- App config ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory "DB" (temporary) ---
const users = [
  // sample users (passwords are plain text for prototype)
  { id: 'u-admin', username: 'admin', password: 'admin123', role: 'admin' },
  { id: 'u-worker1', username: 'worker1', password: 'w1pass', role: 'worker' },
  { id: 'u-worker2', username: 'worker2', password: 'w2pass', role: 'worker' }
];

const workTypes = [
  { id: 'wt-plain', name: 'Plain Mat' },
  { id: 'wt-nspl', name: 'NSPL Mat' }
];

const tasks = []; // will hold { id, title, work_type_id, custom_work, qty, deadline, customer_name, status, assigned_to, created_by, created_at }

// --- Simple helpers ---
function findUserByUsername(un) { return users.find(u => u.username === un); }
function requireAuth(req, res, next) {
  const uid = req.cookies.__uid;
  if (!uid) return res.redirect('/auth/login');
  const user = users.find(u => u.id === uid);
  if (!user) return res.redirect('/auth/login');
  req.user = user;
  next();
}

// --- Views routes ---
app.get('/', (req, res) => res.redirect('/auth/login'));

// Login page
app.get('/auth/login', (req, res) => {
  res.render('login');
});

// Login handler (simple)
app.post('/auth/login', (req, res) => {
  const { username, password, role } = req.body;
  const user = users.find(u => u.username === username && u.password === password && u.role === role);
  if (!user) {
    return res.render('login', { error: 'Invalid credentials or role' });
  }
  // set cookie (simple)
  res.cookie('__uid', user.id, { httpOnly: true });
  if (user.role === 'admin') return res.redirect('/admin');
  return res.redirect('/worker');
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('__uid');
  res.redirect('/auth/login');
});

// Admin page
app.get('/admin', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).send('Forbidden');
  res.render('admin', { user: req.user, workTypes });
});

// Worker page
app.get('/worker', requireAuth, (req, res) => {
  if (req.user.role !== 'worker') return res.status(403).send('Forbidden');
  // worker tasks
  const assigned = tasks.filter(t => t.assigned_to === req.user.id && t.status !== 'completed');
  res.render('worker', { user: req.user, tasks: assigned });
});

// --- API routes (JSON) ---

// GET all work types
app.get('/api/work-types', requireAuth, (req, res) => {
  res.json({ workTypes });
});

// create work type
app.post('/api/work-types', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const wt = { id: 'wt-' + Date.now(), name };
  workTypes.push(wt);
  return res.json(wt);
});

// GET tasks (admin)
app.get('/api/tasks', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  // enrich assigned_name
  const list = tasks.map(t => ({
    ...t,
    assigned_name: t.assigned_to ? (users.find(u => u.id === t.assigned_to)||{}).username : null
  }));
  res.json({ tasks: list });
});

// GET assigned tasks for logged-in worker
app.get('/api/tasks/assigned', requireAuth, (req, res) => {
  if (req.user.role !== 'worker') return res.status(403).json({ error: 'forbidden' });
  const assigned = tasks.filter(t => t.assigned_to === req.user.id && t.status !== 'completed');
  res.json({ tasks: assigned });
});

// POST /api/tasks - create new task (admin)
app.post('/api/tasks', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { work_type_id, custom_work, qty = 1, deadline = null, customer_name = '' } = req.body;
  const title = custom_work || (workTypes.find(w => w.id === work_type_id) || {}).name || 'Work';
  const t = {
    id: 't-' + Date.now(),
    title,
    work_type_id: work_type_id || null,
    custom_work: custom_work || null,
    qty: Number(qty) || 1,
    deadline: deadline || null,
    customer_name: customer_name || null,
    status: 'pending',
    assigned_to: null,
    created_by: req.user.id,
    created_at: new Date().toISOString()
  };
  tasks.unshift(t);
  // emit socket
  io.emit('task-created', t);
  return res.json(t);
});

// POST /api/tasks/:id/assign - simple auto-assign or assign to any worker (admin)
app.post('/api/tasks/:id/assign', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const id = req.params.id;
  const task = tasks.find(x => x.id === id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // simple assign: pick first active worker (in-memory)
  const worker = users.find(u => u.role === 'worker');
  if (!worker) return res.status(400).json({ error: 'no worker available' });
  task.assigned_to = worker.id;
  task.status = 'in_progress';
  io.emit('task-updated', task);
  return res.json({ ok: true, task });
});

// POST /api/tasks/:id/complete - re-auth required (username/password)
app.post('/api/tasks/:id/complete', async (req, res) => {
  const id = req.params.id;
  const { username, password } = req.body;
  // basic verify
  const user = findUserByUsername(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const task = tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // check authorization: only assigned worker OR an admin can complete
  if (user.role === 'worker' && task.assigned_to !== user.id) {
    return res.status(403).json({ error: 'Not allowed to complete this task' });
  }
  task.status = 'completed';
  task.completed_at = new Date().toISOString();
  io.emit('task-completed', task);
  return res.json({ ok: true, task });
});

// --- Socket.io (basic connection log) ---
io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);
  socket.on('disconnect', () => console.log('Socket disconnected', socket.id));
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
