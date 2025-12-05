// server.js
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
const VOLUME_MOUNT = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.VOLUME_MOUNT_PATH || null;
const DATA_DIR = VOLUME_MOUNT ? VOLUME_MOUNT : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json')
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// initialize data.json if missing (won't overwrite existing)
async function initData() {
  if (!existsSync(DATA_FILE)) {
    const initial = {
      users: [
        { username: 'admin', password: 'admin123', role: 'admin' },
        { username: 'worker1', password: 'w1pass', role: 'worker' },
        { username: 'worker2', password: 'w2pass', role: 'worker' }
      ],
      predetermined: ['plain mat', 'cutting', 'polish'],
      works: [],
      nextWorkId: 1
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
    console.log('Created initial data.json');
  }
}

async function readData() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeData(obj) {
  await fs.writeFile(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// Pages
app.get('/', (req, res) => {
  res.render('login');
});

// APIs

// login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: 'missing fields' });

    const data = await readData();
    const user = data.users.find(u => u.username === username && u.role === role);
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials or role' });
    }

    return res.json({ user: { username: user.username, role: user.role } });
  } catch (err) {
    console.error('/api/login error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// get state (predetermined + works)
app.get('/api/state', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      predetermined: data.predetermined || [],
      works: data.works || []
    });
  } catch (err) {
    console.error('/api/state error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// add predetermined
app.post('/api/predetermined', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const data = await readData();
    data.predetermined = data.predetermined || [];
    if (!data.predetermined.includes(name)) {
      data.predetermined.push(name);
      await writeData(data);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('/api/predetermined error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// add work (assign)
app.post('/api/work', async (req, res) => {
  try {
    const { type, qty, deadline, customer, assignee } = req.body;
    if (!type || !qty || !deadline || !customer || !assignee) return res.status(400).json({ error: 'missing fields' });

    const data = await readData();
    const worker = data.users.find(u => u.username === assignee && u.role === 'worker');
    if (!worker) return res.status(400).json({ error: 'Assignee worker not found' });

    data.nextWorkId = data.nextWorkId || 1;
    const newWork = {
      id: data.nextWorkId++,
      type,
      qty,
      deadline,
      customer,
      assignee,
      status: 'in-progress'
    };

    data.works = data.works || [];
    data.works.push(newWork);
    await writeData(data);

    // respond with the created work
    res.json({ success: true, work: newWork });
  } catch (err) {
    console.error('/api/work error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// worker marks complete
app.post('/api/work/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });

    const data = await readData();
    const user = data.users.find(u => u.username === username && u.password === password);
    if (!user || user.role !== 'worker') return res.status(401).json({ error: 'invalid worker credentials' });

    const work = data.works.find(w => String(w.id) === String(id));
    if (!work) return res.status(404).json({ error: 'work not found' });
    if (work.assignee !== username) return res.status(403).json({ error: 'not assigned to this worker' });

    work.status = 'completed';
    await writeData(data);
    res.json({ success: true, work });
  } catch (err) {
    console.error('/api/work/:id/complete error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// delete work (DELETE) -- admin
app.delete('/api/work/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] request for id=${id}`);
    const data = await readData();
    const idx = data.works.findIndex(w => String(w.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Work not found' });

    // allow deleting any work (per your requirement)
    const removed = data.works.splice(idx, 1);
    await writeData(data);
    console.log('[DELETE] removed', removed);
    res.json({ success: true });
  } catch (err) {
    console.error('/api/work/:id DELETE error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// optional POST alias for older clients
app.post('/api/work/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readData();
    const idx = data.works.findIndex(w => String(w.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'Work not found' });

    const removed = data.works.splice(idx, 1);
    await writeData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('/api/work/:id/delete POST error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// start
const PORT = process.env.PORT || 3000;
await initData();
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
