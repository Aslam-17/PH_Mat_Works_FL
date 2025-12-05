// server.js
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, 'data.json');
const TEMP_FILE = path.join(__dirname, 'data.json.tmp');
const BACKUP_DIR = path.join(__dirname, 'backups');

const SALT_ROUNDS = 10;

// write queue to serialize writes
let writeQueue = Promise.resolve();

// --- Atomic write helper ---
async function atomicWrite(obj, makeBackup = true) {
  writeQueue = writeQueue.then(async () => {
    const json = JSON.stringify(obj, null, 2);
    // ensure backup dir exists
    try { await fs.mkdir(BACKUP_DIR, { recursive: true }); } catch(e) {}
    // make a quick backup of existing file if exists
    try {
      if (existsSync(DATA_FILE) && makeBackup) {
        const bname = path.join(BACKUP_DIR, `data-${Date.now()}.json`);
        await fs.copyFile(DATA_FILE, bname);
      }
    } catch (err) {
      console.warn('Failed to create backup:', err.message);
    }

    await fs.writeFile(TEMP_FILE, json, { encoding: 'utf8' });
    await fs.rename(TEMP_FILE, DATA_FILE);
  }).catch(err => {
    console.error('Write queue error:', err);
  });
  return writeQueue;
}

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Failed to read/parse data.json — ' + err.message);
  }
}

// --- Initialize data.json if missing (with hashed passwords) ---
async function initDataIfMissing(initial = null) {
  if (!existsSync(DATA_FILE)) {
    const initialData = initial ?? {
      users: [
        { username: 'admin', password: 'admin123', role: 'admin' },
        { username: 'worker1', password: 'w1pass', role: 'worker' },
        { username: 'worker2', password: 'w2pass', role: 'worker' }
      ],
      predetermined: ['plain mat', 'cutting', 'polish'],
      works: [],
      nextWorkId: 1
    };

    // Hash all passwords before writing
    for (const u of initialData.users) {
      if (!u.password.startsWith('$2')) {
        // hash only if not already hashed
        u.password = await bcrypt.hash(u.password, SALT_ROUNDS);
      }
    }

    await atomicWrite(initialData, false);
    console.log('Created initial data.json with hashed passwords.');
  }
}

// --- Migrate existing plaintext passwords to bcrypt hashes if needed ---
async function migratePlaintextPasswords() {
  try {
    if (!existsSync(DATA_FILE)) return;
    const data = await readData();
    let changed = false;

    for (const user of data.users || []) {
      if (!user.password || typeof user.password !== 'string') continue;
      // bcrypt hash strings usually start with $2a$ or $2b$ or $2y$
      if (!user.password.startsWith('$2')) {
        console.log(`Hashing password for user: ${user.username}`);
        user.password = await bcrypt.hash(user.password, SALT_ROUNDS);
        changed = true;
      }
    }

    if (changed) {
      await atomicWrite(data);
      console.log('Migrated plaintext passwords to bcrypt hashes.');
    }
  } catch (err) {
    console.error('Password migration failed:', err);
  }
}

// --- Express app setup ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Routes/pages ---
app.get('/', (req, res) => {
  res.render('login');
});

// --- API endpoints ---
// login: verify username, role, bcrypt password
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: 'missing fields' });

    const data = await readData();
    const user = (data.users || []).find(u => u.username === username && u.role === role);
    if (!user) return res.status(401).json({ error: 'Invalid credentials or role' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Minimal user info to client
    return res.json({ user: { username: user.username, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

// get whole state (predetermined + works)
// passwords are not returned
app.get('/api/state', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      predetermined: data.predetermined || [],
      works: data.works || []
    });
  } catch (err) {
    console.error(err);
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
    if (!data.predetermined.includes(name)) data.predetermined.push(name);
    await atomicWrite(data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// add work
app.post('/api/work', async (req, res) => {
  try {
    const { type, qty, deadline, customer, assignee } = req.body;
    if (!type || !qty || !deadline || !customer || !assignee) return res.status(400).json({ error: 'missing fields' });

    const data = await readData();
    const worker = (data.users || []).find(u => u.username === assignee && u.role === 'worker');
    if (!worker) return res.status(400).json({ error: 'Assignee worker not found' });

    data.nextWorkId = data.nextWorkId || 1;
    const newWork = {
      id: data.nextWorkId++,
      type, qty, deadline, customer, assignee,
      status: 'in-progress'
    };

    data.works = data.works || [];
    data.works.push(newWork);
    await atomicWrite(data);
    res.json({ success: true, work: newWork });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// complete work (worker must supply username+password)
app.post('/api/work/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });

    const data = await readData();
    const user = (data.users || []).find(u => u.username === username);
    if (!user) return res.status(401).json({ error: 'invalid worker credentials' });
    if (user.role !== 'worker') return res.status(403).json({ error: 'not a worker' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'invalid worker credentials' });

    const work = (data.works || []).find(w => String(w.id) === String(id));
    if (!work) return res.status(404).json({ error: 'work not found' });
    if (work.assignee !== username) return res.status(403).json({ error: 'not assigned to this worker' });

    work.status = 'completed';
    await atomicWrite(data);
    res.json({ success: true, work });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// --- Start server after init & migration ---
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDataIfMissing();
    await migratePlaintextPasswords();
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
