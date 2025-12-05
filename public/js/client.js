// client.js - shared for admin & worker pages
(() => {
  const socket = io();

  // helper: format datetime-ish
  function fmtDate(dStr) {
    if (!dStr) return '-';
    const d = new Date(dStr);
    return d.toLocaleString();
  }

  // ----- ADMIN SIDE -----
  const addWorkForm = document.getElementById('addWorkForm');
  if (addWorkForm) {
    const workTypeSelect = document.getElementById('workTypeSelect');
    const newBlock = document.getElementById('newWorkTypeBlock');
    const newWorkName = document.getElementById('newWorkName');

    workTypeSelect && workTypeSelect.addEventListener('change', (e) => {
      if (e.target.value === '__new') newBlock.classList.remove('hidden');
      else newBlock.classList.add('hidden');
    });

    addWorkForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const data = new FormData(form);
      const work_type_id = data.get('work_type_id');
      let workTypeId = null;
      if (work_type_id === '__new') {
        const name = (document.getElementById('newWorkName').value || '').trim();
        if (!name) return alert('Enter new work name');
        // create new work type
        const res = await fetch('/api/work-types', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name })});
        const json = await res.json();
        if (!res.ok) return alert(json.error || 'Failed');
        workTypeId = json.id;
      } else {
        workTypeId = work_type_id || null;
      }

      const qty = Number(document.getElementById('qty').value) || 1;
      const deadline = document.getElementById('deadline').value || null;
      const customer = document.getElementById('customer').value || '';
      // create task
      const payload = {
        work_type_id: workTypeId,
        custom_work: null,
        qty, deadline, customer_name: customer
      };
      const r = await fetch('/api/tasks', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      const jr = await r.json();
      if (!r.ok) return alert(jr.error || 'Failed to create');
      form.reset();
      newBlock.classList.add('hidden');
      // UI will update via socket event
    });
  }

  // ----- TASK RENDER HELPERS -----
  function buildTaskNode(t) {
    const div = document.createElement('div');
    div.className = 'task-item';
    div.dataset.id = t.id;
    div.innerHTML = `
      <div class="task-meta">
        <div class="title">${escapeHtml(t.title || t.custom_work || 'Work')}</div>
        <div class="muted">Customer: ${escapeHtml(t.customer_name || '-') } &nbsp; | &nbsp; Qty: ${t.qty || 1}</div>
        <div class="muted">Deadline: ${fmtDate(t.deadline)} &nbsp; | &nbsp; Status: ${t.status}</div>
      </div>
      <div class="task-actions"></div>
    `;
    const actions = div.querySelector('.task-actions');

    // Admin: show assign button if unassigned
    if (window.IS_ADMIN) {
      if (!t.assigned_to) {
        const btn = document.createElement('button'); btn.className='btn small'; btn.textContent='Assign';
        btn.onclick = async () => {
          const res = await fetch(`/api/tasks/${t.id}/assign`, { method: 'POST' });
          const j = await res.json();
          if (!res.ok) return alert(j.error||'Assign failed');
          // UI will update by socket
        };
        actions.appendChild(btn);
      } else {
        actions.innerHTML = `<div class="muted">Assigned to: ${escapeHtml(t.assigned_name || t.assigned_to)}</div>`;
      }
    }

    // Worker: show complete checkbox if assigned to this worker
    if (window.IS_WORKER && t.assigned_to_me) {
      const btn = document.createElement('button'); btn.className='btn'; btn.textContent='✅ Complete';
      btn.onclick = async () => {
        // ask for username + password confirmation before marking complete
        const username = prompt('Confirm username to complete task:');
        if (!username) return;
        const password = prompt('Enter password:');
        if (!password) return;
        const res = await fetch(`/api/tasks/${t.id}/complete`, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ username, password })
        });
        const j = await res.json();
        if (!res.ok) return alert(j.error || 'Complete failed');
        // UI will update via socket
      };
      actions.appendChild(btn);
    }

    return div;
  }

  function renderTasksList(containerId, tasks) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    if (!tasks || tasks.length === 0) {
      c.innerHTML = '<div class="muted">No tasks found</div>';
      return;
    }
    tasks.forEach(t => {
      c.appendChild(buildTaskNode(t));
    });
  }

  // Escape helper
  function escapeHtml(s = '') {
    return s.replaceAll && s.replaceAll(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]));
  }

  // ----- SOCKET EVENTS -----
  socket.on('connect', () => {
    // console.log('socket connected');
  });

  socket.on('task-created', (task) => {
    // refresh view or add to list
    if (window.IS_ADMIN) fetchAndRenderAllTasks();
    if (window.IS_WORKER) fetchAndRenderWorkerTasks();
  });

  socket.on('task-updated', (task) => {
    if (window.IS_ADMIN) fetchAndRenderAllTasks();
    if (window.IS_WORKER) fetchAndRenderWorkerTasks();
  });

  socket.on('task-completed', (task) => {
    if (window.IS_ADMIN) fetchAndRenderAllTasks();
    if (window.IS_WORKER) fetchAndRenderWorkerTasks();
  });

  // ----- FETCH & INIT -----
  async function fetchAndRenderAllTasks() {
    const res = await fetch('/api/tasks');
    const j = await res.json();
    renderTasksList('tasksList', j.tasks || []);
  }

  async function fetchAndRenderWorkerTasks() {
    const res = await fetch('/api/tasks/assigned');
    const j = await res.json();
    // add assigned_to_me flag for rendering
    const tasks = (j.tasks || []).map(t => ({...t, assigned_to_me: true}));
    renderTasksList('workerTasks', tasks);
  }

  // when page loads, fetch tasks appropriately
  document.addEventListener('DOMContentLoaded', () => {
    if (window.IS_ADMIN) fetchAndRenderAllTasks();
    if (window.IS_WORKER) fetchAndRenderWorkerTasks();
  });

})();
