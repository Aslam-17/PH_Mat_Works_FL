// public/main.js
const api = {
  login: '/api/login',
  getState: '/api/state',
  addPred: '/api/predetermined',
  addWork: '/api/work',
  completeWork: (id) => `/api/work/${id}/complete`,
  deleteWork: (id) => `/api/work/${id}`
};

let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', onLogin);

  const addPredForm = document.getElementById('add-pred-form');
  if (addPredForm) addPredForm.addEventListener('submit', onAddPred);

  const addWorkForm = document.getElementById('add-work-form');
  if (addWorkForm) addWorkForm.addEventListener('submit', onAddWork);

  const logoutAdmin = document.getElementById('logout-admin');
  if (logoutAdmin) logoutAdmin.addEventListener('click', logout);
  const logoutWorker = document.getElementById('logout-worker');
  if (logoutWorker) logoutWorker.addEventListener('click', logout);

  // Attach delegated listeners for admin/worker actions once
  attachDelegatedListeners();

  // initial state load (will show only login until someone logs in)
  loadStateToUI();
});

async function onLogin(e) {
  e.preventDefault();
  const role = document.querySelector('input[name="role"]:checked')?.value;
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  const res = await fetch(api.login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });

  const data = await res.json();
  const msg = document.getElementById('login-msg');

  if (!res.ok) {
    msg.textContent = data?.error || 'Login failed';
    return;
  }

  currentUser = data.user;
  msg.textContent = `Welcome ${currentUser.username} (${currentUser.role})`;

  // HIDE intro & login
  document.getElementById('login-section').classList.add('hidden');
  document.querySelector('.panel-left').classList.add('hidden');

  // SHOW correct dashboard layout
  if (currentUser.role === 'admin') {
    document.getElementById('admin-wrapper').classList.remove('hidden');
  } else {
    document.getElementById('worker-wrapper').classList.remove('hidden');
    document.getElementById('worker-welcome').textContent = `Hello ${currentUser.username}`;
  }

  await loadStateToUI();
}


async function loadStateToUI() {
  const res = await fetch(api.getState);
  if (!res.ok) return;
  const state = await res.json();

  // Predetermined list
  const predList = document.getElementById('pred-list');
  predList.innerHTML = '';
  (state.predetermined || []).forEach(p => {
    const li = document.createElement('li');
    li.textContent = p;
    predList.appendChild(li);
  });

  // populate select
  const sel = document.getElementById('work-type-select');
  if (sel) {
    sel.innerHTML = '';
    (state.predetermined || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    });
  }

  // Render admin table
  renderAdminTable(state.works || []);

  // Render worker table
  renderWorkerTable(state.works || []);
}

function renderAdminTable(works) {
  const adminBody = document.querySelector('#admin-work-table tbody');
  adminBody.innerHTML = '';

  works.forEach(w => {
    const tr = document.createElement('tr');
    const deleteBtnHtml = `<button class="delete-btn" data-id="${w.id}">Delete</button>`;
    tr.innerHTML = `
      <td>${w.id}</td>
      <td>${escapeHtml(w.type)}</td>
      <td>${w.qty}</td>
      <td>${escapeHtml(w.deadline)}</td>
      <td>${escapeHtml(w.customer)}</td>
      <td>${escapeHtml(w.assignee)}</td>
      <td>${w.status === 'completed' ? '<span class="badge done">Completed</span>' : '<span class="badge inprogress">In Progress</span>'}</td>
      <td>${deleteBtnHtml}</td>
    `;
    adminBody.appendChild(tr);
  });
}

function renderWorkerTable(works) {
  const workerBody = document.querySelector('#worker-work-table tbody');
  workerBody.innerHTML = '';
  if (!currentUser || currentUser.role !== 'worker') return;

  const assigned = works.filter(w => w.assignee === currentUser.username);
  assigned.forEach(w => {
    const tr = document.createElement('tr');

    const completeBtn = w.status !== 'completed'
      ? `<button class="complete-btn" data-id="${w.id}">Mark complete</button>`
      : '';

    tr.innerHTML = `
      <td>${w.id}</td>
      <td>${escapeHtml(w.type)}</td>
      <td>${w.qty}</td>
      <td>${escapeHtml(w.deadline)}</td>
      <td>${escapeHtml(w.customer)}</td>
      <td>${completeBtn}</td>
    `;
    workerBody.appendChild(tr);
  });
}

// Attach delegated listeners (one-time)
function attachDelegatedListeners() {
  // admin delete (delegated)
  const adminBody = document.querySelector('#admin-work-table tbody');
  if (adminBody && !adminBody._listenersAttached) {
    adminBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!id) return;
      if (!confirm('Delete this work?')) return;

      try {
        btn.disabled = true;
        btn.textContent = 'Deleting...';
        const res = await fetch(api.deleteWork(id), { method: 'DELETE' });
        const text = await res.text();
        if (!res.ok) {
          alert(`Delete failed: ${res.status}\n\n${text}`);
          btn.disabled = false;
          btn.textContent = 'Delete';
          return;
        }
        await loadStateToUI();
      } catch (err) {
        console.error('Delete error', err);
        alert('Network or server error while deleting.');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
    adminBody._listenersAttached = true;
  }

  // worker complete (delegated)
  const workerBody = document.querySelector('#worker-work-table tbody');
  if (workerBody && !workerBody._listenersAttached) {
    workerBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.complete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!id) return;

      // ask for worker credentials to confirm
      const username = prompt('Confirm username to complete:');
      if (!username) return alert('Username required');
      const password = prompt('Enter password:');
      if (!password) return alert('Password required');

      try {
        btn.disabled = true;
        btn.textContent = 'Marking...';
        const res = await fetch(api.completeWork(id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const dataText = await res.text();
        let data;
        try { data = JSON.parse(dataText); } catch { data = { message: dataText }; }

        if (!res.ok) {
          alert(data.error || data.message || 'Failed to mark complete');
          btn.disabled = false;
          btn.textContent = 'Mark complete';
          return;
        }

        // refresh UI (button will disappear because status changed)
        await loadStateToUI();
      } catch (err) {
        console.error('Complete error', err);
        alert('Network or server error while marking complete.');
        btn.disabled = false;
        btn.textContent = 'Mark complete';
      }
    });
    workerBody._listenersAttached = true;
  }
}

// add predetermined
async function onAddPred(e) {
  e.preventDefault();
  const name = document.getElementById('pred-name').value.trim();
  if (!name) return;
  const res = await fetch(api.addPred, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('pred-name').value = '';
    await loadStateToUI();
  } else {
    alert(data.error || 'Could not add predetermined type');
  }
}

// add work
async function onAddWork(e) {
  e.preventDefault();
  const type = document.getElementById('work-type-select').value;
  const qty = Number(document.getElementById('work-qty').value);
  const deadline = document.getElementById('work-deadline').value;
  const customer = document.getElementById('work-customer').value.trim();
  const assignee = document.getElementById('work-assignee').value.trim();

  if (!type || !qty || !deadline || !customer || !assignee) {
    alert('Fill all fields');
    return;
  }

  const res = await fetch(api.addWork, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, qty, deadline, customer, assignee })
  });

  const data = await res.json();
  if (res.ok) {
    // clear inputs
    document.getElementById('work-qty').value = '';
    document.getElementById('work-deadline').value = '';
    document.getElementById('work-customer').value = '';
    document.getElementById('work-assignee').value = '';
    // Immediately reload state so admin and worker see the new assignment
    await loadStateToUI();
  } else {
    alert(data.error || 'Could not add work');
  }
}

function logout() {
  currentUser = null;
  document.getElementById('login-section').classList.remove('hidden');
  document.getElementById('admin-section').classList.add('hidden');
  document.getElementById('worker-section').classList.add('hidden');
  document.getElementById('login-msg').textContent = '';
}

// small helper to avoid XSS in table rendering
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
