/* MongoExplorer front-end controller. Vanilla JS, no build step.
 *
 * The server sends documents as relaxed Extended JSON (ObjectId -> {"$oid"},
 * Date -> {"$date"}), so we can display them with JSON.stringify directly and
 * send edited EJSON text straight back for the server to parse. */

const state = {
  connected: false,
  selectedDb: null,
  selectedColl: null,
  documents: [],
  total: 0,
  page: 0,
  limit: 50,
  baseSkip: 0,
  // EJSON-stringified _id keys of documents checked on the current page.
  selectedIds: new Set(),
};

/* ---------- DOM helpers ---------- */

function byId(id) {
  return document.getElementById(id);
}

/**
 * Build a DOM element safely. Text and children are added via textContent /
 * createTextNode so server data is never interpreted as HTML.
 */
function elem(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseJsonArray(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
  return value;
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(message, type = 'info') {
  const t = byId('toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}

/* ---------- Modal ---------- */

let modalSaveHandler = null;
function openModal(title, bodyHtml, onSave) {
  byId('modalTitle').textContent = title;
  byId('modalBody').innerHTML = bodyHtml;
  setModalError('');
  modalSaveHandler = onSave;
  byId('modal').classList.remove('hidden');
  const first = byId('modalBody').querySelector('input, textarea');
  if (first) first.focus();
}

function closeModal() {
  byId('modal').classList.add('hidden');
  byId('modalBody').innerHTML = '';
  modalSaveHandler = null;
}

function setModalError(message) {
  byId('modalError').textContent = message || '';
}

async function onModalSave() {
  if (!modalSaveHandler) return;
  setModalError('');
  setBusy(byId('modalSave'), true);
  try {
    await modalSaveHandler();
  } catch (err) {
    setModalError(err.message);
  } finally {
    setBusy(byId('modalSave'), false);
  }
}

/* ---------- Path helpers ---------- */

function docPath(...extra) {
  return Api.path('api', 'databases', state.selectedDb, 'collections', state.selectedColl, ...extra);
}

function requireSelection() {
  if (!state.selectedDb || !state.selectedColl) {
    toast('Select a collection first.', 'info');
    return false;
  }
  return true;
}

/* ---------- Auth ---------- */

function setAuthError(message) {
  byId('authError').textContent = message || '';
}

function showGate(message) {
  byId('topbar').classList.add('hidden');
  byId('appMain').classList.add('hidden');
  byId('authGate').classList.remove('hidden');
  setAuthError(message || '');
  const key = byId('authKey');
  if (key) {
    key.value = '';
    key.focus();
  }
}

function showApp() {
  byId('authGate').classList.add('hidden');
  byId('topbar').classList.remove('hidden');
  byId('appMain').classList.remove('hidden');
  // Resume the normal connection bootstrap now that we are authenticated.
  checkStatus();
}

// Decide which screen to show on load based on whether a valid session exists.
async function bootstrapAuth() {
  try {
    const data = await Api.get('/api/auth/status');
    if (data.authenticated) showApp();
    else showGate();
  } catch {
    showGate();
  }
}

async function submitAuth(e) {
  if (e) e.preventDefault();
  const key = byId('authKey').value;
  if (!key) {
    setAuthError('Enter your access key.');
    return;
  }
  setBusy(byId('authSubmit'), true);
  setAuthError('');
  try {
    await Api.post('/api/auth/login', { key });
    toast('Signed in.', 'success');
    showApp();
  } catch (err) {
    setAuthError(err.message || 'Invalid access key.');
  } finally {
    setBusy(byId('authSubmit'), false);
  }
}

async function signOut() {
  // Drop the live DB connection first (while still authorized), then end the
  // session so no credentials linger server-side.
  try {
    if (state.connected) await Api.post('/api/disconnect');
  } catch {
    /* ignore */
  }
  try {
    await Api.post('/api/auth/logout');
  } catch {
    /* ignore */
  }
  onDisconnected();
  showGate();
  toast('Signed out.', 'info');
}

/* ---------- Connection ---------- */

async function connect() {
  const uri = byId('connString').value.trim();
  if (!uri) {
    toast('Enter a connection string.', 'info');
    return;
  }
  setBusy(byId('connectBtn'), true);
  try {
    const data = await Api.post('/api/connect', { uri });
    onConnected(data.label);
    toast('Connected.', 'success');
    loadDatabases();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(byId('connectBtn'), false);
  }
}

async function disconnect() {
  try {
    await Api.post('/api/disconnect');
  } catch {
    /* ignore — we disconnect locally regardless */
  }
  onDisconnected();
  toast('Disconnected.', 'info');
}

function onConnected(label) {
  state.connected = true;
  byId('connStatus').textContent = label || 'Connected';
  byId('connStatus').className = 'status connected';
  byId('connectBtn').classList.add('hidden');
  byId('disconnectBtn').classList.remove('hidden');
  byId('newDbBtn').disabled = false;
  byId('refreshDbBtn').disabled = false;
}

function onDisconnected() {
  state.connected = false;
  clearSelection();
  byId('connStatus').textContent = 'Disconnected';
  byId('connStatus').className = 'status disconnected';
  byId('connectBtn').classList.remove('hidden');
  byId('disconnectBtn').classList.add('hidden');
  byId('newDbBtn').disabled = true;
  byId('refreshDbBtn').disabled = true;
  const tree = byId('dbTree');
  tree.innerHTML = '';
  tree.append(elem('li', { class: 'empty-hint', text: 'Connect to view databases.' }));
}

async function checkStatus() {
  try {
    const data = await Api.get('/api/status');
    if (data.connected) {
      onConnected(data.label);
      loadDatabases();
    }
  } catch {
    /* not connected */
  }
}

/* ---------- Sidebar: databases & collections ---------- */

async function loadDatabases() {
  const tree = byId('dbTree');
  tree.innerHTML = '';
  tree.append(elem('li', { class: 'spinner', text: 'Loading databases…' }));
  try {
    const data = await Api.get('/api/databases');
    tree.innerHTML = '';
    const dbs = data.databases || [];
    if (!dbs.length) {
      tree.append(elem('li', { class: 'empty-hint', text: 'No databases.' }));
      return;
    }
    dbs.forEach((db) => tree.append(buildDbNode(db.name)));
  } catch (err) {
    tree.innerHTML = '';
    tree.append(elem('li', { class: 'empty-hint', text: err.message }));
  }
}

function buildDbNode(name) {
  const caret = elem('span', { class: 'caret', text: '\u25B8' });
  const label = elem('span', { class: 'node-label', text: name, title: name });
  const addColl = elem('button', { title: 'New collection', text: '+' });
  const dropDb = elem('button', { class: 'danger-text', title: 'Drop database', text: '\u00D7' });
  const actions = elem('span', { class: 'node-actions' }, addColl, dropDb);
  const row = elem('div', { class: 'node-row' }, caret, label, actions);
  const collList = elem('ul', { class: 'coll-list hidden' });
  const node = elem('li', { class: 'db-node' }, row, collList);

  row.addEventListener('click', (e) => {
    if (e.target === addColl || e.target === dropDb) return;
    toggleDb(node, name, collList);
  });
  addColl.addEventListener('click', (e) => {
    e.stopPropagation();
    openCreateCollection(name);
  });
  dropDb.addEventListener('click', (e) => {
    e.stopPropagation();
    dropDatabase(name);
  });
  return node;
}

async function toggleDb(node, dbName, collList) {
  if (node.classList.contains('open')) {
    node.classList.remove('open');
    collList.classList.add('hidden');
    return;
  }
  node.classList.add('open');
  collList.classList.remove('hidden');
  if (collList.dataset.loaded === 'true') return;

  collList.innerHTML = '';
  collList.append(elem('li', { class: 'spinner', text: 'Loading…' }));
  try {
    const data = await Api.get(Api.path('api', 'databases', dbName, 'collections'));
    collList.innerHTML = '';
    const colls = data.collections || [];
    if (!colls.length) {
      collList.append(elem('li', { class: 'empty-hint', text: '(no collections)' }));
    } else {
      colls.forEach((c) => collList.append(buildCollNode(dbName, c.name)));
    }
    collList.dataset.loaded = 'true';
  } catch (err) {
    collList.innerHTML = '';
    collList.append(elem('li', { class: 'empty-hint', text: err.message }));
  }
}

function buildCollNode(dbName, collName) {
  const label = elem('span', { class: 'node-label', text: collName, title: collName });
  const dropColl = elem('button', { class: 'danger-text', title: 'Drop collection', text: '\u00D7' });
  const actions = elem('span', { class: 'node-actions' }, dropColl);
  const li = elem('li', { class: 'coll-node', dataset: { db: dbName, coll: collName } }, label, actions);
  li.addEventListener('click', (e) => {
    if (e.target === dropColl) return;
    selectCollection(dbName, collName, li);
  });
  dropColl.addEventListener('click', (e) => {
    e.stopPropagation();
    dropCollection(dbName, collName);
  });
  return li;
}

function selectCollection(dbName, collName, li) {
  state.selectedDb = dbName;
  state.selectedColl = collName;
  document.querySelectorAll('.coll-node.selected').forEach((n) => n.classList.remove('selected'));
  if (li) li.classList.add('selected');

  const label = byId('selectionLabel');
  label.innerHTML = '';
  label.append(elem('strong', { text: dbName }), document.createTextNode('.'), elem('strong', { text: collName }));

  if (!byId('userDbInput').value) byId('userDbInput').value = dbName;
  switchTab('documents');
  runQuery(true);
}

function clearSelection() {
  state.selectedDb = null;
  state.selectedColl = null;
  byId('selectionLabel').textContent = 'No collection selected';
  const list = byId('docList');
  list.innerHTML = '';
  list.append(elem('p', { class: 'empty-hint', text: 'Select a collection to browse documents.' }));
  byId('resultsCount').textContent = '';
  byId('pageInfo').textContent = '';
}

/* ---------- Databases / collections: create & drop ---------- */

function openCreateDatabase() {
  if (!state.connected) {
    toast('Connect first.', 'info');
    return;
  }
  openModal(
    'Create Database',
    `<div class="form-row"><label>Database name</label><input id="mDbName" /></div>
     <div class="form-row"><label>First collection name</label><input id="mCollName" value="default" /></div>
     <span class="hint">MongoDB creates a database once it contains its first collection.</span>`,
    async () => {
      const name = byId('mDbName').value.trim();
      const collection = byId('mCollName').value.trim() || 'default';
      if (!name) throw new Error('Database name is required.');
      await Api.post('/api/databases', { name, collection });
      closeModal();
      toast(`Database "${name}" created.`, 'success');
      loadDatabases();
    }
  );
}

async function dropDatabase(name) {
  if (!window.confirm(`Drop database "${name}" and ALL its collections? This cannot be undone.`)) return;
  try {
    await Api.del(Api.path('api', 'databases', name));
    toast(`Database "${name}" dropped.`, 'success');
    if (state.selectedDb === name) clearSelection();
    loadDatabases();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openCreateCollection(dbName) {
  openModal(
    `Create Collection in "${dbName}"`,
    `<div class="form-row"><label>Collection name</label><input id="mCollName" /></div>`,
    async () => {
      const name = byId('mCollName').value.trim();
      if (!name) throw new Error('Collection name is required.');
      await Api.post(Api.path('api', 'databases', dbName, 'collections'), { name });
      closeModal();
      toast(`Collection "${name}" created.`, 'success');
      loadDatabases();
    }
  );
}

async function dropCollection(dbName, collName) {
  if (!window.confirm(`Drop collection "${dbName}.${collName}"? This cannot be undone.`)) return;
  try {
    await Api.del(Api.path('api', 'databases', dbName, 'collections', collName));
    toast('Collection dropped.', 'success');
    if (state.selectedDb === dbName && state.selectedColl === collName) clearSelection();
    loadDatabases();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Documents ---------- */

async function runQuery(reset) {
  if (!requireSelection()) return;
  state.selectedIds.clear();
  if (reset) {
    state.page = 0;
    state.limit = clampInt(byId('qLimit').value, 1, 1000, 50);
    state.baseSkip = clampInt(byId('qSkip').value, 0, Number.MAX_SAFE_INTEGER, 0);
  }
  const skip = state.baseSkip + state.page * state.limit;
  const list = byId('docList');
  list.innerHTML = '';
  list.append(elem('p', { class: 'spinner', text: 'Running query…' }));

  try {
    const data = await Api.post(docPath('documents', 'find'), {
      filter: byId('qFilter').value,
      projection: byId('qProjection').value,
      sort: byId('qSort').value,
      limit: state.limit,
      skip,
    });
    state.documents = data.documents || [];
    state.total = data.total || 0;
    renderDocuments(state.documents);
    updatePager(skip);
  } catch (err) {
    list.innerHTML = '';
    list.append(elem('p', { class: 'empty-hint', text: err.message }));
    byId('resultsCount').textContent = '';
    byId('pageInfo').textContent = '';
    byId('prevPageBtn').disabled = true;
    byId('nextPageBtn').disabled = true;
    syncSelectAllState();
    updateBulkUI();
    toast(err.message, 'error');
  }
}

// Search a single value across every indexed field: bypasses the filter box and
// asks the server to match the value (as text, number, boolean or ObjectId)
// against all indexed fields. Results show as a single page with paging disabled.
async function searchIndexed() {
  if (!requireSelection()) return;
  const value = byId('indexSearchInput').value.trim();
  if (!value) {
    toast('Enter a value to search.', 'info');
    return;
  }
  state.selectedIds.clear();
  const list = byId('docList');
  list.innerHTML = '';
  list.append(elem('p', { class: 'spinner', text: 'Searching…' }));
  setBusy(byId('indexSearchBtn'), true);
  try {
    const data = await Api.post(docPath('documents', 'search-indexed'), { value });
    state.documents = data.documents || [];
    state.total = data.total || 0;
    renderDocuments(state.documents);
    byId('resultsCount').textContent = `${state.total} document(s)`;
    byId('pageInfo').textContent = state.total ? `1\u2013${state.total} of ${state.total}` : '';
    byId('prevPageBtn').disabled = true;
    byId('nextPageBtn').disabled = true;
    if (!state.total) {
      const fields = (data.fields || []).join(', ');
      toast(fields ? `No match in indexed fields: ${fields}` : 'This collection has no indexed fields to search.', 'info');
    }
  } catch (err) {
    list.innerHTML = '';
    list.append(elem('p', { class: 'empty-hint', text: err.message }));
    byId('resultsCount').textContent = '';
    byId('pageInfo').textContent = '';
    toast(err.message, 'error');
  } finally {
    setBusy(byId('indexSearchBtn'), false);
  }
}

// Clear the search box and return to the normal filtered query view.
function clearIndexSearch() {
  byId('indexSearchInput').value = '';
  runQuery(true);
}

function renderDocuments(docs) {
  const list = byId('docList');
  list.innerHTML = '';
  if (!docs.length) {
    list.append(elem('p', { class: 'empty-hint', text: 'No documents match this query.' }));
    syncSelectAllState();
    updateBulkUI();
    return;
  }
  docs.forEach((doc, idx) => {
    const idKey = doc._id !== undefined ? JSON.stringify(doc._id) : null;
    const checkbox = elem('input', { type: 'checkbox', class: 'doc-select' });
    if (idKey === null) {
      checkbox.disabled = true;
      checkbox.title = 'No _id in projection — cannot select';
    } else {
      checkbox.dataset.idkey = idKey;
      checkbox.checked = state.selectedIds.has(idKey);
    }
    const actions = elem(
      'div',
      { class: 'doc-actions' },
      elem('button', { class: 'small secondary', text: 'Edit', dataset: { action: 'edit', idx } }),
      elem('button', { class: 'small danger', text: 'Delete', dataset: { action: 'delete', idx } })
    );
    const head = elem('div', { class: 'doc-card-head' }, checkbox, actions);
    const pre = elem('pre', { class: 'doc-json', text: JSON.stringify(doc, null, 2) });
    list.append(elem('div', { class: 'doc-card' }, head, pre));
  });
  syncSelectAllState();
  updateBulkUI();
}

function updatePager(skip) {
  const from = state.total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + state.documents.length, state.total);
  byId('resultsCount').textContent = `${state.total} document(s)`;
  byId('pageInfo').textContent = `${from}\u2013${to} of ${state.total}`;
  byId('prevPageBtn').disabled = state.page <= 0;
  byId('nextPageBtn').disabled = skip + state.documents.length >= state.total;
}

function onDocListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const doc = state.documents[Number(btn.dataset.idx)];
  if (!doc) return;
  if (btn.dataset.action === 'edit') openEditDocument(doc);
  else deleteDocument(doc);
}

/* ---------- Bulk selection & delete ---------- */

// Toggle a single document's checkbox into the selection set.
function onDocListChange(e) {
  const cb = e.target.closest('input.doc-select');
  if (!cb || !cb.dataset.idkey) return;
  if (cb.checked) state.selectedIds.add(cb.dataset.idkey);
  else state.selectedIds.delete(cb.dataset.idkey);
  syncSelectAllState();
  updateBulkUI();
}

// Select or clear every selectable document on the current page.
function toggleSelectAll(e) {
  const checked = e.target.checked;
  document.querySelectorAll('#docList input.doc-select:not(:disabled)').forEach((cb) => {
    cb.checked = checked;
    if (checked) state.selectedIds.add(cb.dataset.idkey);
    else state.selectedIds.delete(cb.dataset.idkey);
  });
  e.target.indeterminate = false;
  updateBulkUI();
}

// Reflect the page's checkbox state on the "select all" control.
function syncSelectAllState() {
  const boxes = [...document.querySelectorAll('#docList input.doc-select:not(:disabled)')];
  const checked = boxes.filter((b) => b.checked).length;
  const all = byId('selectAllDocs');
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

function updateBulkUI() {
  const n = state.selectedIds.size;
  const btn = byId('deleteSelectedBtn');
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Delete Selected (${n})` : 'Delete Selected';
  byId('selectionInfo').textContent = n > 0 ? `${n} selected` : '';
}

// Map the selected id keys back to their actual _id values for an $in filter.
function collectSelectedIds() {
  const ids = [];
  state.documents.forEach((doc) => {
    if (doc._id === undefined) return;
    if (state.selectedIds.has(JSON.stringify(doc._id))) ids.push(doc._id);
  });
  return ids;
}

async function deleteSelected() {
  if (!requireSelection()) return;
  const ids = collectSelectedIds();
  if (!ids.length) {
    toast('No documents selected.', 'info');
    return;
  }
  if (!window.confirm(`Delete ${ids.length} selected document(s)? This cannot be undone.`)) return;
  setBusy(byId('deleteSelectedBtn'), true);
  try {
    const filter = JSON.stringify({ _id: { $in: ids } });
    const res = await Api.del(docPath('documents'), { filter, many: true });
    toast(`Deleted ${res.deletedCount} document(s).`, 'success');
    runQuery(false);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(byId('deleteSelectedBtn'), false);
  }
}

// Delete every document matching the current filter box (server-side
// deleteMany). An empty filter triggers a stronger confirmation and the
// explicit delete-all path.
async function deleteMatching() {
  if (!requireSelection()) return;
  const filterText = byId('qFilter').value.trim();
  const isEmpty = filterText === '' || filterText === '{}';
  let count;
  try {
    const res = await Api.post(docPath('documents', 'count'), { filter: filterText });
    count = res.count;
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (count === 0) {
    toast('No documents match the current filter.', 'info');
    return;
  }
  const target = `${state.selectedDb}.${state.selectedColl}`;
  const message = isEmpty
    ? `Delete ALL ${count} document(s) in ${target}? This empties the collection and cannot be undone.`
    : `Delete ${count} document(s) matching the filter in ${target}? This cannot be undone.`;
  if (!window.confirm(message)) return;
  setBusy(byId('deleteMatchingBtn'), true);
  try {
    const body = { filter: isEmpty ? '{}' : filterText, many: true };
    if (isEmpty) body.confirmDeleteAll = true;
    const res = await Api.del(docPath('documents'), body);
    toast(`Deleted ${res.deletedCount} document(s).`, 'success');
    runQuery(true);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(byId('deleteMatchingBtn'), false);
  }
}

// Download every document matching the current filter (or the whole collection
// when the filter is empty) as a CSV file. Uses fetch so server errors surface
// as a toast instead of downloading an error page.
async function downloadCsv() {
  if (!requireSelection()) return;
  const btn = byId('downloadCsvBtn');
  setBusy(btn, true);
  try {
    const params = new URLSearchParams();
    const filter = byId('qFilter').value.trim();
    const projection = byId('qProjection').value.trim();
    const sort = byId('qSort').value.trim();
    if (filter) params.set('filter', filter);
    if (projection) params.set('projection', projection);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    const url = docPath('documents', 'export') + (qs ? `?${qs}` : '');

    const res = await fetch(url);
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch {
        /* response was not JSON */
      }
      throw new Error(msg);
    }

    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = elem('a', { href: objUrl, download: `${state.selectedColl}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
    toast('CSV downloaded.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function openInsertDocument() {
  if (!requireSelection()) return;
  openModal(
    'Insert Document',
    `<div class="form-row"><label>Document (EJSON)</label><textarea id="mDocText"></textarea>
       <span class="hint">Example: { "name": "Ada", "createdAt": { "$date": "2024-01-01T00:00:00Z" } }</span></div>`,
    async () => {
      await Api.post(docPath('documents'), { document: byId('mDocText').value });
      closeModal();
      toast('Document inserted.', 'success');
      runQuery(false);
    }
  );
  byId('mDocText').value = '{\n  \n}';
}

function openEditDocument(doc) {
  if (doc._id === undefined) {
    toast('Document has no _id (adjust projection to edit).', 'error');
    return;
  }
  openModal(
    'Edit Document',
    `<div class="form-row"><label>Document (EJSON) — saved as a full replacement</label>
       <textarea id="mDocText"></textarea></div>`,
    async () => {
      const filter = JSON.stringify({ _id: doc._id });
      await Api.put(docPath('documents'), { filter, update: byId('mDocText').value, many: false });
      closeModal();
      toast('Document updated.', 'success');
      runQuery(false);
    }
  );
  byId('mDocText').value = JSON.stringify(doc, null, 2);
}

async function deleteDocument(doc) {
  if (doc._id === undefined) {
    toast('Document has no _id (adjust projection to delete).', 'error');
    return;
  }
  if (!window.confirm('Delete this document? This cannot be undone.')) return;
  try {
    const filter = JSON.stringify({ _id: doc._id });
    await Api.del(docPath('documents'), { filter, many: false });
    toast('Document deleted.', 'success');
    runQuery(false);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Indexes ---------- */

async function loadIndexes() {
  if (!requireSelection()) return;
  const container = byId('indexContainer');
  container.innerHTML = '';
  container.append(elem('p', { class: 'spinner', text: 'Loading indexes…' }));
  try {
    const data = await Api.get(docPath('indexes'));
    renderIndexes(data.indexes || []);
  } catch (err) {
    container.innerHTML = '';
    container.append(elem('p', { class: 'empty-hint', text: err.message }));
  }
}

function renderIndexes(indexes) {
  const container = byId('indexContainer');
  container.innerHTML = '';
  const table = elem('table', { class: 'data-table' });
  table.append(
    elem(
      'thead',
      {},
      elem(
        'tr',
        {},
        elem('th', { text: 'Name' }),
        elem('th', { text: 'Keys' }),
        elem('th', { text: 'Properties' }),
        elem('th', { text: '' })
      )
    )
  );
  const tbody = elem('tbody');
  indexes.forEach((ix) => {
    const props = [];
    if (ix.unique) props.push('unique');
    if (ix.sparse) props.push('sparse');
    if (ix.expireAfterSeconds !== undefined) props.push(`ttl=${ix.expireAfterSeconds}s`);
    const dropBtn = elem('button', { class: 'small danger', text: 'Drop' });
    if (ix.name === '_id_') dropBtn.disabled = true;
    else dropBtn.addEventListener('click', () => dropIndex(ix.name));
    tbody.append(
      elem(
        'tr',
        {},
        elem('td', { class: 'mono', text: ix.name }),
        elem('td', { class: 'mono', text: JSON.stringify(ix.key) }),
        elem('td', { text: props.join(', ') }),
        elem('td', {}, elem('div', { class: 'row-actions' }, dropBtn))
      )
    );
  });
  table.append(tbody);
  container.append(table);
}

function openCreateIndex() {
  if (!requireSelection()) return;
  openModal(
    'Create Index',
    `<div class="form-row"><label>Keys (EJSON)</label><textarea id="mIdxKeys"></textarea>
       <span class="hint">Example: { "email": 1 } or { "lastName": 1, "firstName": 1 }</span></div>
     <div class="form-row"><label>Options (EJSON, optional)</label><textarea id="mIdxOpts"></textarea>
       <span class="hint">Example: { "unique": true } or { "expireAfterSeconds": 3600 }</span></div>`,
    async () => {
      await Api.post(docPath('indexes'), {
        keys: byId('mIdxKeys').value,
        options: byId('mIdxOpts').value,
      });
      closeModal();
      toast('Index created.', 'success');
      loadIndexes();
    }
  );
  byId('mIdxKeys').value = '{\n  \n}';
}

async function dropIndex(name) {
  if (!window.confirm(`Drop index "${name}"?`)) return;
  try {
    await Api.del(docPath('indexes', name));
    toast('Index dropped.', 'success');
    loadIndexes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Users & roles ---------- */

async function loadUsers() {
  const db = byId('userDbInput').value.trim();
  if (!db) {
    toast('Enter a database name.', 'info');
    return;
  }
  const container = byId('userContainer');
  container.innerHTML = '';
  container.append(elem('p', { class: 'spinner', text: 'Loading users…' }));
  try {
    const data = await Api.get(Api.path('api', 'users', db));
    renderUsers(db, data.users || []);
  } catch (err) {
    container.innerHTML = '';
    container.append(elem('p', { class: 'empty-hint', text: err.message }));
  }
}

function renderUsers(db, users) {
  const container = byId('userContainer');
  container.innerHTML = '';
  if (!users.length) {
    container.append(elem('p', { class: 'empty-hint', text: 'No users on this database.' }));
    return;
  }
  const table = elem('table', { class: 'data-table' });
  table.append(
    elem(
      'thead',
      {},
      elem(
        'tr',
        {},
        elem('th', { text: 'User' }),
        elem('th', { text: 'DB' }),
        elem('th', { text: 'Roles' }),
        elem('th', { text: '' })
      )
    )
  );
  const tbody = elem('tbody');
  users.forEach((u) => {
    const roles = (u.roles || []).map((r) => `${r.role}@${r.db}`).join(', ');
    const rolesBtn = elem('button', { class: 'small secondary', text: 'Roles' });
    rolesBtn.addEventListener('click', () => openEditRoles(db, u.user, u.roles || []));
    const dropBtn = elem('button', { class: 'small danger', text: 'Drop' });
    dropBtn.addEventListener('click', () => dropUser(db, u.user));
    tbody.append(
      elem(
        'tr',
        {},
        elem('td', { class: 'mono', text: u.user }),
        elem('td', { class: 'mono', text: u.db }),
        elem('td', { text: roles }),
        elem('td', {}, elem('div', { class: 'row-actions' }, rolesBtn, dropBtn))
      )
    );
  });
  table.append(tbody);
  container.append(table);
}

function openCreateUser() {
  const db = byId('userDbInput').value.trim();
  if (!db) {
    toast('Enter a database name first.', 'info');
    return;
  }
  openModal(
    `Create User on "${db}"`,
    `<div class="form-row"><label>Username</label><input id="mUser" /></div>
     <div class="form-row"><label>Password</label><input id="mPass" type="password" /></div>
     <div class="form-row"><label>Roles (JSON array)</label><textarea id="mRoles"></textarea>
       <span class="hint">Example: [ { "role": "readWrite", "db": "mydb" } ] or [ "readWrite" ]</span></div>`,
    async () => {
      const username = byId('mUser').value.trim();
      const password = byId('mPass').value;
      if (!username) throw new Error('Username is required.');
      if (!password) throw new Error('Password is required.');
      const roles = parseJsonArray(byId('mRoles').value, 'Roles');
      await Api.post(Api.path('api', 'users', db), { username, password, roles });
      closeModal();
      toast(`User "${username}" created.`, 'success');
      loadUsers();
    }
  );
  // Set via .value (not innerHTML) so the db name cannot inject markup.
  byId('mRoles').value = JSON.stringify([{ role: 'readWrite', db }], null, 2);
}

function openEditRoles(db, username, currentRoles) {
  openModal(
    `Roles: ${username}`,
    `<div class="form-row"><label>Current roles</label><textarea id="mCurRoles" readonly></textarea></div>
     <div class="form-row"><label>Grant (JSON array)</label><textarea id="mGrant"></textarea></div>
     <div class="form-row"><label>Revoke (JSON array)</label><textarea id="mRevoke"></textarea></div>`,
    async () => {
      const grant = byId('mGrant').value.trim() ? parseJsonArray(byId('mGrant').value, 'Grant') : [];
      const revoke = byId('mRevoke').value.trim() ? parseJsonArray(byId('mRevoke').value, 'Revoke') : [];
      if (!grant.length && !revoke.length) throw new Error('Specify roles to grant or revoke.');
      await Api.put(Api.path('api', 'users', db, username, 'roles'), { grant, revoke });
      closeModal();
      toast('Roles updated.', 'success');
      loadUsers();
    }
  );
  byId('mCurRoles').value = JSON.stringify(currentRoles, null, 2);
  byId('mGrant').value = '[]';
  byId('mRevoke').value = '[]';
}

async function dropUser(db, username) {
  if (!window.confirm(`Drop user "${username}" on "${db}"?`)) return;
  try {
    await Api.del(Api.path('api', 'users', db, username));
    toast('User dropped.', 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Stats ---------- */

async function showStats(url, pick) {
  const out = byId('statsOutput');
  out.textContent = 'Loading…';
  try {
    const data = await Api.get(url);
    out.textContent = JSON.stringify(pick(data), null, 2);
  } catch (err) {
    out.textContent = err.message;
    toast(err.message, 'error');
  }
}

function loadDbStats() {
  let db = state.selectedDb;
  if (!db) db = (window.prompt('Database name for stats:', 'admin') || '').trim();
  if (!db) return;
  showStats(Api.path('api', 'stats', db), (d) => d.stats);
}

function loadServerStatus() {
  showStats('/api/stats/server', (d) => d.status);
}

function loadOverview() {
  showStats('/api/stats/databases', (d) => d);
}

/* ---------- Tabs ---------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'indexes' && state.selectedColl) loadIndexes();
}

/* ---------- Init ---------- */

document.addEventListener('DOMContentLoaded', () => {
  // Auth gate wiring.
  byId('authForm').addEventListener('submit', submitAuth);
  byId('showAuthKey').addEventListener('change', (e) => {
    byId('authKey').type = e.target.checked ? 'text' : 'password';
  });
  byId('signOutBtn').addEventListener('click', signOut);
  Api.onUnauthorized(() => {
    if (state.connected) onDisconnected();
    showGate('Your session expired. Please sign in again.');
  });

  byId('connectBtn').addEventListener('click', connect);
  byId('disconnectBtn').addEventListener('click', disconnect);
  byId('connString').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
  });
  byId('showConn').addEventListener('change', (e) => {
    byId('connString').type = e.target.checked ? 'text' : 'password';
  });
  byId('newDbBtn').addEventListener('click', openCreateDatabase);
  byId('refreshDbBtn').addEventListener('click', loadDatabases);

  byId('runQueryBtn').addEventListener('click', () => runQuery(true));
  byId('indexSearchBtn').addEventListener('click', searchIndexed);
  byId('indexSearchClearBtn').addEventListener('click', clearIndexSearch);
  byId('indexSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchIndexed();
  });
  byId('insertDocBtn').addEventListener('click', openInsertDocument);
  byId('downloadCsvBtn').addEventListener('click', downloadCsv);
  byId('prevPageBtn').addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      runQuery(false);
    }
  });
  byId('nextPageBtn').addEventListener('click', () => {
    state.page += 1;
    runQuery(false);
  });
  byId('docList').addEventListener('click', onDocListClick);
  byId('docList').addEventListener('change', onDocListChange);
  byId('selectAllDocs').addEventListener('change', toggleSelectAll);
  byId('deleteSelectedBtn').addEventListener('click', deleteSelected);
  byId('deleteMatchingBtn').addEventListener('click', deleteMatching);

  byId('refreshIndexesBtn').addEventListener('click', loadIndexes);
  byId('newIndexBtn').addEventListener('click', openCreateIndex);

  byId('loadUsersBtn').addEventListener('click', loadUsers);
  byId('newUserBtn').addEventListener('click', openCreateUser);

  byId('loadDbStatsBtn').addEventListener('click', loadDbStats);
  byId('loadServerStatusBtn').addEventListener('click', loadServerStatus);
  byId('loadOverviewBtn').addEventListener('click', loadOverview);

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  byId('modalClose').addEventListener('click', closeModal);
  byId('modalCancel').addEventListener('click', closeModal);
  byId('modalSave').addEventListener('click', onModalSave);
  byId('modal').addEventListener('click', (e) => {
    if (e.target === byId('modal')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !byId('modal').classList.contains('hidden')) closeModal();
  });

  bootstrapAuth();
});
