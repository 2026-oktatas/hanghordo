/* HH_BUILD: 2025-12-14_01 */
// 01 ==============================================
// KONFIGURÁCIÓS KONSTANSOK
// ==============================================

const SUPABASE_URL = 'https://ojteekuqtapjgodbnskg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CqZQ4XGEdP720q8Avg6jig_D3Yc4aSi'; 

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TOKEN_VALIDITY_DAYS = 30;
const LOCAL_QUEUE_KEY = 'hanghordo_offline_queue';

const DEFAULT_COORDS = [47.4979, 19.0402];

// LocalStorage kulcsok
const LAST_TOKEN_KEY = 'hanghordo_last_token';
const LAST_ALIAS_KEY = 'hanghordo_last_alias';
const LAST_LOCALITY_KEY = 'hanghordo_last_locality';
const LAST_RO_TOKENS_KEY = 'hanghordo_last_ro_tokens';

// Színek
const COLOR_PRIMARY_UPLOADED = '#2e7d32'; // zöld
const COLOR_RO_UPLOADED = '#1565c0';      // kék
const COLOR_PENDING = '#D4A017';          // sárga

// 02 ==============================================
// GLOBÁLIS ÁLLAPOT
// ==============================================

let map = null;

let uploadedGroup = null;  // feltöltött szakaszok (zöld/kék)
let pendingGroup = null;   // helyi (még nem feltöltött) szakaszok (sárga)
let drawControl = null;

let currentMissionToken = null;  // fő token
let currentAlias = null;
let currentLocalityName = null;

let readOnlyTokens = [];         // max 3, csatlakozáskor

let cityDataCache = null;
let tokenEditedManually = false;

// 03 ==============================================
// IDÉZETEK (FELTÖLTÉS UTÁN POPUP)
// ==============================================

const QUOTES = [
  { text: '„Árad a Tisza.”' },
  { text: '„Lépésről lépésre, tégláról téglára visszavesszük a hazánkat.”'},
  { text: '„Nincs jobb, nincs bal, csak magyar.”' },
  { text: '„A TISZA minden magyar kormánya lesz.”'},
  { text: '„Miniszterelnök úr, vége van!”' },
  { text: '„Egynek minden nehéz; soknak semmi sem lehetetlen.”' },
];

function pickRandomQuote() {
  const idx = Math.floor(Math.random() * QUOTES.length);
  return QUOTES[idx];
}

function showQuoteModal() {
  const modal = document.getElementById('quote-modal');
  const textEl = document.getElementById('quote-text');
  const authorEl = document.getElementById('quote-author');

  if (!modal || !textEl || !authorEl) return;

  const q = pickRandomQuote();
  textEl.textContent = q.text;
  authorEl.textContent = q.author || '';

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function hideQuoteModal() {
  const modal = document.getElementById('quote-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// 04 ==============================================
// SPLASH
// ==============================================

function setupSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    splash.classList.add('hidden');
    splash.setAttribute('aria-hidden', 'true');
    splash.removeEventListener('click', finish);
    splash.removeEventListener('touchstart', finish);
  };

  splash.addEventListener('click', finish, { passive: true });
  splash.addEventListener('touchstart', finish, { passive: true });
  setTimeout(finish, 3000);
}

// 05 ==============================================
// SEGÉD
// ==============================================

function log(msg, level = 'INFO') {
  console.log(`[${level}]`, msg);
}

function setStatusMessage(elementId, message, isError) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden', 'error', 'ok');
  el.classList.add(isError ? 'error' : 'ok');
}

function getISOWeekNumber(date) {
  const tempDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tempDate.getUTCDay() || 7;
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  return Math.ceil((((tempDate - yearStart) / 86400000) + 1) / 7);
}

function generateToken(localityName) {
  const telepules = (localityName || 'MSSN').toUpperCase();
  const now = new Date();
  const isoWeek = getISOWeekNumber(now);
  const yearShort = now.getFullYear().toString().slice(-2);
  const day = now.getDate().toString().padStart(2, '0');
  const randomNum = Math.floor(Math.random() * 900 + 100);
  return `${telepules.slice(0, 4)}_${yearShort}W${isoWeek}${day}_${randomNum}`;
}

function setMissionDefaultDate() {
  const input = document.getElementById('valid-until');
  if (!input) return;
  const now = new Date();
  const maxDate = new Date(now.getTime() + TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const yyyy = maxDate.getFullYear();
  const mm = String(maxDate.getMonth() + 1).padStart(2, '0');
  const dd = String(maxDate.getDate()).padStart(2, '0');
  input.value = `${yyyy}-${mm}-${dd}`;
}

function formatDate(dateStr) {
  if (!dateStr) return 'ismeretlen';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleString('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function normalizeToken(s) {
  return (s || '').trim();
}

function uniqueNonEmptyTokens(tokens) {
  const set = new Set();
  (tokens || []).forEach(t => {
    const v = normalizeToken(t);
    if (v) set.add(v);
  });
  return Array.from(set);
}

// 06 ==============================================
// TELEPÜLÉS ADATOK (cities tábla)
// ==============================================

async function fetchAndCacheCityData() {
  if (cityDataCache) return cityDataCache;

  log('Településlista betöltése Supabase-ből (chunkokban)...', 'INFO');

  const allCities = [];
  const chunkSize = 1000;

  for (let offset = 0; offset < 5000; offset += chunkSize) {
    const { data, error } = await supabaseClient
      .from('cities')
      .select('city_name, latitude, longitude')
      .order('city_name', { ascending: true })
      .range(offset, offset + chunkSize - 1);

    if (error) {
      console.error('Cities lekérés hiba (chunk):', error);
      break;
    }

    if (!data || data.length === 0) break;
    allCities.push(...data);
    if (data.length < chunkSize) break;
  }

  log(`[INFO] Települések betöltve: ${allCities.length} db`);

  cityDataCache = {};
  allCities.forEach(city => {
    if (!city.city_name) return;
    cityDataCache[city.city_name.toUpperCase()] = {
      coords: [city.latitude, city.longitude]
    };
  });

  cityDataCache.DEFAULT = { coords: DEFAULT_COORDS };
  return cityDataCache;
}

function getCityCoords(localityName) {
  if (cityDataCache && localityName) {
    const key = localityName.toUpperCase();
    if (cityDataCache[key]) return cityDataCache[key].coords;
  }
  return DEFAULT_COORDS;
}

// 07 ==============================================
// OFFLINE QUEUE
// ==============================================

function loadOfflineQueue() {
  try {
    const raw = localStorage.getItem(LOCAL_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOfflineQueue(queue) {
  try {
    localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('Offline queue mentési hiba:', e);
  }
}

function addToOfflineQueue(featureGeoJson) {
  const q = loadOfflineQueue();
  q.push(featureGeoJson);
  saveOfflineQueue(q);
}

function clearOfflineQueue() {
  saveOfflineQueue([]);
}

// 08 ==============================================
// AUTOCOMPLETE
// ==============================================

function setupLocalityAutocomplete(inputId, suggestionId, onPick) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(suggestionId);
  if (!input || !list) return;

  input.addEventListener('input', () => {
    const query = input.value.trim().toUpperCase();
    list.innerHTML = '';

    if (!query || !cityDataCache) {
      list.classList.add('hidden');
      return;
    }

    const matches = Object.keys(cityDataCache)
      .filter(name => name !== 'DEFAULT' && name.includes(query))
      .slice(0, 20);

    if (!matches.length) {
      list.classList.add('hidden');
      return;
    }

    matches.forEach(name => {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      const pretty = name.charAt(0) + name.slice(1).toLowerCase();
      div.textContent = pretty;

      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = pretty;
        list.classList.add('hidden');
        if (typeof onPick === 'function') onPick(pretty);
      });

      list.appendChild(div);
    });

    list.classList.remove('hidden');
  });

  input.addEventListener('blur', () => {
    setTimeout(() => list.classList.add('hidden'), 200);
  });
}

// 09 ==============================================
// TOKEN AUTO-FILL (Create)
// ==============================================

function autoFillToken() {
  const tokenInput = document.getElementById('create-token');
  const localityInput = document.getElementById('create-locality');

  if (!tokenInput) return;
  if (tokenEditedManually) return;

  const baseName = (localityInput && localityInput.value.trim()) ? localityInput.value.trim() : 'MSSN';
  const gen = generateToken(baseName);
  tokenInput.value = gen;
}

// 10 ==============================================
// READ-ONLY TOKEN UI (Join)
// ==============================================

function readOnlyTokenRows() {
  return Array.from(document.querySelectorAll('.ro-token-input')).map(i => i.value);
}

function renderReadOnlyTokenUI(tokens) {
  const container = document.getElementById('readonly-token-container');
  const addBtn = document.getElementById('btn-add-ro-token');
  if (!container || !addBtn) return;

  container.innerHTML = '';

  tokens.forEach((t, idx) => {
    const row = document.createElement('div');
    row.className = 'ro-row';

    const input = document.createElement('input');
    input.className = 'ro-token-input';
    input.type = 'text';
    input.placeholder = `Read-only kód #${idx + 1}`;
    input.value = t || '';

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.type = 'button';
    remove.textContent = 'X';
    remove.title = 'Eltávolítás';

    remove.addEventListener('click', () => {
      const current = readOnlyTokenRows();
      current.splice(idx, 1);
      readOnlyTokens = current;
      renderReadOnlyTokenUI(readOnlyTokens);
      persistJoinDefaults();
    });

    input.addEventListener('input', () => persistJoinDefaults());

    row.appendChild(input);
    row.appendChild(remove);
    container.appendChild(row);
  });

  addBtn.disabled = tokens.length >= 3;
}

function addReadOnlyTokenRow() {
  if (readOnlyTokens.length >= 3) return;
  readOnlyTokens.push('');
  renderReadOnlyTokenUI(readOnlyTokens);
  persistJoinDefaults();
}

function persistJoinDefaults() {
  try {
    const joinToken = document.getElementById('join-token')?.value || '';
    const joinAlias = document.getElementById('join-alias')?.value || '';
    const joinLocality = document.getElementById('join-locality')?.value || '';

    localStorage.setItem(LAST_TOKEN_KEY, joinToken);
    localStorage.setItem(LAST_ALIAS_KEY, joinAlias);
    localStorage.setItem(LAST_LOCALITY_KEY, joinLocality);

    const ro = uniqueNonEmptyTokens(readOnlyTokenRows()).slice(0, 3);
    localStorage.setItem(LAST_RO_TOKENS_KEY, JSON.stringify(ro));
  } catch {}
}

function restoreJoinDefaults() {
  try {
    const t = localStorage.getItem(LAST_TOKEN_KEY);
    const a = localStorage.getItem(LAST_ALIAS_KEY);
    const l = localStorage.getItem(LAST_LOCALITY_KEY);
    const roRaw = localStorage.getItem(LAST_RO_TOKENS_KEY);

    if (t && document.getElementById('join-token')) document.getElementById('join-token').value = t;
    if (a && document.getElementById('join-alias')) document.getElementById('join-alias').value = a;
    if (l && document.getElementById('join-locality')) document.getElementById('join-locality').value = l;

    if (roRaw) {
      const parsed = JSON.parse(roRaw);
      readOnlyTokens = Array.isArray(parsed) ? parsed.slice(0, 3) : [];
    } else {
      readOnlyTokens = [];
    }

    renderReadOnlyTokenUI(readOnlyTokens);
  } catch {
    readOnlyTokens = [];
    renderReadOnlyTokenUI(readOnlyTokens);
  }
}

// 11 ==============================================
// TÉRKÉP + DRAW
// ==============================================
function applyLeafletDrawHuLabels() {
  if (!window.L || !L.drawLocal) return;

  // 1) Toolbar gomb felirat (hover tooltip / aria)
  if (L.drawLocal.draw?.toolbar?.buttons) {
    L.drawLocal.draw.toolbar.buttons.polyline = 'Szakasz rajzolása';
  }

  // 2) Rajzolás közbeni felső akciógombok (Finish / Delete last point / Cancel)
  //    Ezek NEM a handlers.* alatt vannak, hanem a draw.toolbar.* alatt.
  if (L.drawLocal.draw?.toolbar) {
    // Finish
    L.drawLocal.draw.toolbar.finish = L.drawLocal.draw.toolbar.finish || {};
    L.drawLocal.draw.toolbar.finish.title = 'Rajzolás befejezése';
    L.drawLocal.draw.toolbar.finish.text = 'Befejezés';

    // Undo (Delete last point)
    L.drawLocal.draw.toolbar.undo = L.drawLocal.draw.toolbar.undo || {};
    L.drawLocal.draw.toolbar.undo.title = 'Utolsó pont törlése';
    L.drawLocal.draw.toolbar.undo.text = 'Utolsó pont törlése';

    // Cancel
    L.drawLocal.draw.toolbar.actions = L.drawLocal.draw.toolbar.actions || {};
    L.drawLocal.draw.toolbar.actions.title = 'Rajzolás megszakítása';
    L.drawLocal.draw.toolbar.actions.text = 'Mégse';
  }

  // 3) Tooltip szövegek (best-effort)
  if (L.drawLocal.draw?.handlers?.polyline?.tooltip) {
    L.drawLocal.draw.handlers.polyline.tooltip.start = 'Kattints a rajzolás indításához.';
    L.drawLocal.draw.handlers.polyline.tooltip.cont = 'Kattints a folytatáshoz.';
    L.drawLocal.draw.handlers.polyline.tooltip.end = 'Kattints az utolsó pontra a befejezéshez.';
  }
}


function initializeMap(centerCoords) {
  if (map) {
    map.setView(centerCoords, 14);
    return;
  }

  applyLeafletDrawHuLabels();

  map = L.map('map').setView(centerCoords, 14);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap közreműködők'
  }).addTo(map);

  uploadedGroup = L.featureGroup().addTo(map);
  pendingGroup = L.featureGroup().addTo(map);

  drawControl = new L.Control.Draw({
    edit: {
      featureGroup: pendingGroup,
      edit: false,
      remove: false
    },
    draw: {
      polyline: {
        shapeOptions: {
          color: COLOR_PENDING,
          weight: 4
        }
      },
      polygon: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false
    }
  });

  map.addControl(drawControl);

  map.on('draw:created', (e) => {
    const layer = e.layer;
    pendingGroup.addLayer(layer);

    const isDone = window.confirm(
      'Ezt a szakaszt készre jelölöd?\n\nOK = kész\nMégse = még folyamatban'
    );
    const status = isDone ? 'kész' : 'folyamatban';

    const feature = layer.toGeoJSON();
    feature.properties = {
      token: currentMissionToken,
      alias: currentAlias || 'ismeretlen',
      status,
      created_at: new Date().toISOString(),
      pending: true
    };

    addToOfflineQueue(feature);

    layer.bindPopup(
      `Saját rajz (még nincs feltöltve)\nÁllapot: ${status}\nAlias: ${feature.properties.alias}`
    );

    alert('Szakasz elmentve helyben.\n\nFeltöltéshez: Menü → „Szórólapozás manuális feltöltése”.');
  });

  log('Térkép inicializálva.');
}

function renderPendingFromQueue() {
  if (!pendingGroup) return;
  pendingGroup.clearLayers();

  const queue = loadOfflineQueue();
  queue.forEach(f => {
    if (!f?.geometry) return;
    const layer = L.geoJSON(f, {
      style: { color: COLOR_PENDING, weight: 4 }
    }).getLayers()[0];
    if (layer) pendingGroup.addLayer(layer);
  });
}

// 12 ==============================================
// ROUTE BETÖLTÉS
// ==============================================

function parseStatusFromComment(comment) {
  const c = (comment || '');
  return c.includes('status=folyamatban') ? 'folyamatban' : 'kész';
}

async function loadRoutesForToken(token, color, label) {
  const pattern = `token=${token}%`;

  const { data, error } = await supabaseClient
    .from('kihordott_utvonalak')
    .select('*')
    .like('comment', pattern);

  if (error) {
    console.error(`Hiba az útvonalak lekérésekor (${token}):`, error);
    return;
  }

  (data || []).forEach(row => {
    if (!row.route_geom) return;

    const status = parseStatusFromComment(row.comment);

    const geo = {
      type: 'Feature',
      properties: {
        token,
        token_label: label,
        alias: row.reporter_name || 'ismeretlen',
        status,
        done_date: row.done_date
      },
      geometry: row.route_geom
    };

    const dashed = status === 'folyamatban';
    const layer = L.geoJSON(geo, {
      style: {
        color,
        weight: 4,
        dashArray: dashed ? '6,6' : null
      }
    }).getLayers()[0];

    if (!layer) return;

    const doneFormatted = formatDate(row.done_date);
    const popupText =
      `${label}\n` +
      `Feltöltő: ${geo.properties.alias}\n` +
      `Állapot: ${geo.properties.status}\n` +
      `Dátum: ${doneFormatted}`;

    layer.bindPopup(popupText);
    uploadedGroup.addLayer(layer);
  });
}

async function loadAllRoutes() {
  if (!map || !uploadedGroup) return;
  uploadedGroup.clearLayers();

  await loadRoutesForToken(currentMissionToken, COLOR_PRIMARY_UPLOADED, 'Fő kód (zöld)');

  const ro = uniqueNonEmptyTokens(readOnlyTokens)
    .filter(t => t !== currentMissionToken)
    .slice(0, 3);

  for (const t of ro) {
    await loadRoutesForToken(t, COLOR_RO_UPLOADED, 'Read-only (kék)');
  }

  renderPendingFromQueue();
}

// 13 ==============================================
// FELTÖLTÉS (csak fő token)
// ==============================================

let __isUploading = false;

async function handleBatchUpload() {
  if (__isUploading) return;
  __isUploading = true;

  try {
    const queue = loadOfflineQueue();

    if (!queue.length) {
      alert('Nincs feltöltésre váró útvonal.');
      __isUploading = false;
      return;
    }

    if (!currentMissionToken || !currentAlias) {
      alert('Nincs aktív szórólapozás. Előbb csatlakozz vagy hozz létre egyet.');
      __isUploading = false;
      return;
    }

    const nowIso = new Date().toISOString();

    const payload = queue.map(feature => {
      const status = feature.properties?.status || 'kész';
      const comment = `token=${currentMissionToken}; status=${status}`;

      return {
        route_geom: feature.geometry,
        done_date: nowIso,
        comment,
        reporter_name: currentAlias,
      };
    });

    const { error } = await supabaseClient
      .from('kihordott_utvonalak')
      .insert(payload);

    if (error) {
      console.error('Hiba a batch feltöltésnél:', error);
      alert('Hiba történt a feltöltés során. A munka helyben marad.');
      __isUploading = false;
      return;
    }

    clearOfflineQueue();

    // Feltöltés után: frissítés + idézet popup
    await loadAllRoutes();
    showQuoteModal();
  } catch (e) {
    console.error('Váratlan hiba batch feltöltés közben:', e);
    alert('Kritikus hiba. A munka helyben elmentve maradt.');
  }

  __isUploading = false;
}

// 14 ==============================================
// APP INDÍTÁS
// ==============================================

function updateTopbarInfo() {
  const el = document.getElementById('current-mission-info');
  if (!el) return;

  const roCount = uniqueNonEmptyTokens(readOnlyTokens)
    .filter(t => t !== currentMissionToken).length;

  el.textContent =
    `Fő kód: ${currentMissionToken} | Alias: ${currentAlias} | Település: ${currentLocalityName}` +
    (roCount ? ` | Read-only: ${roCount} db` : '');
}

function startApp(token, alias, localityName, roTokens) {
  currentMissionToken = normalizeToken(token);
  currentAlias = (alias || '').trim();
  currentLocalityName = (localityName || '').trim();
  readOnlyTokens = Array.isArray(roTokens) ? roTokens.slice(0, 3) : [];

  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');

  updateTopbarInfo();

  const coords = getCityCoords(currentLocalityName);

  setTimeout(async () => {
    initializeMap(coords);
    map.setView(coords, 14);
    await loadAllRoutes();
  }, 150);
}

// 15 ==============================================
// NAVIGÁCIÓ
// ==============================================

function showScreen(screenId) {
  const ids = ['main-menu', 'create-screen', 'join-screen', 'settings-screen'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === screenId) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });

  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

// 16 ==============================================
// CREATE / JOIN
// ==============================================

async function handleCreateMission() {
  const tokenInput = document.getElementById('create-token');
  const aliasInput = document.getElementById('create-alias');
  const localityInput = document.getElementById('create-locality');
  const validUntilInput = document.getElementById('valid-until');

  const statusId = 'create-status';

  let token = normalizeToken(tokenInput?.value);
  const alias = (aliasInput?.value || '').trim();
  const localityName = (localityInput?.value || '').trim();
  const validUntil = validUntilInput?.value;

  if (!alias || !localityName || !validUntil) {
    setStatusMessage(statusId, 'Minden mezőt kötelező kitölteni (kód automatikusan generálható).', true);
    return;
  }

  if (!token) {
    token = generateToken(localityName || 'MSSN');
    if (tokenInput) tokenInput.value = token;
  }

  setStatusMessage(statusId, 'Belépés...', false);

  try {
    localStorage.setItem(LAST_TOKEN_KEY, token);
    localStorage.setItem(LAST_ALIAS_KEY, alias);
    localStorage.setItem(LAST_LOCALITY_KEY, localityName);
    localStorage.setItem(LAST_RO_TOKENS_KEY, JSON.stringify([]));
  } catch {}

  startApp(token, alias, localityName, []);
}

async function handleJoinMission() {
  const token = normalizeToken(document.getElementById('join-token')?.value);
  const alias = (document.getElementById('join-alias')?.value || '').trim();
  const localityName = (document.getElementById('join-locality')?.value || '').trim();
  const statusId = 'join-status';

  const ro = uniqueNonEmptyTokens(readOnlyTokenRows()).slice(0, 3);

  if (!alias || !localityName || !token) {
    setStatusMessage(statusId, 'A becenév, település és fő kód megadása kötelező.', true);
    return;
  }

  setStatusMessage(statusId, 'Belépés...', false);

  try {
    localStorage.setItem(LAST_TOKEN_KEY, token);
    localStorage.setItem(LAST_ALIAS_KEY, alias);
    localStorage.setItem(LAST_LOCALITY_KEY, localityName);
    localStorage.setItem(LAST_RO_TOKENS_KEY, JSON.stringify(ro));
  } catch {}

  startApp(token, alias, localityName, ro);
}

// 17 ==============================================
// ÖSSZESÍTÉS
// ==============================================

function showSummary() {
  const queue = loadOfflineQueue();
  const pendingCount = queue.length;

  alert(
    `Aktív fő kód: ${currentMissionToken || 'nincs'}\n` +
    `Read-only kódok: ${uniqueNonEmptyTokens(readOnlyTokens).filter(t => t !== currentMissionToken).length} db\n\n` +
    `Feltöltésre váró (sárga) szakaszok: ${pendingCount} db\n\n` +
    `Feltöltés: Menü → „Szórólapozás manuális feltöltése”.`
  );
}

// 18 ==============================================
// DOM READY
// ==============================================

document.addEventListener('DOMContentLoaded', async () => {
  setupSplash();

  // Quote modal kezelők (nincs X)
  document.getElementById('quote-ok')?.addEventListener('click', hideQuoteModal);
  document.getElementById('quote-backdrop')?.addEventListener('click', hideQuoteModal);

  setMissionDefaultDate();
  await fetchAndCacheCityData();

  setupLocalityAutocomplete('create-locality', 'locality-suggestions', () => {
    tokenEditedManually = false;
    autoFillToken();
  });

  setupLocalityAutocomplete('join-locality', 'join-locality-suggestions', () => {});

  const btnMainCreate = document.getElementById('btn-main-create');
  const btnMainJoin = document.getElementById('btn-main-join');
  const btnMainSettings = document.getElementById('btn-main-settings');

  const btnBackFromCreate = document.getElementById('btn-back-from-create');
  const btnBackFromJoin = document.getElementById('btn-back-from-join');
  const btnBackFromSettings = document.getElementById('btn-back-from-settings');

  btnMainCreate?.addEventListener('click', () => {
    showScreen('create-screen');
    setMissionDefaultDate();
    tokenEditedManually = false;
    autoFillToken();
  });

  btnMainJoin?.addEventListener('click', () => {
    showScreen('join-screen');
    restoreJoinDefaults();
  });

  btnMainSettings?.addEventListener('click', () => showScreen('settings-screen'));

  btnBackFromCreate?.addEventListener('click', () => showScreen('main-menu'));
  btnBackFromJoin?.addEventListener('click', () => showScreen('main-menu'));
  btnBackFromSettings?.addEventListener('click', () => showScreen('main-menu'));

  const createTokenInput = document.getElementById('create-token');
  createTokenInput?.addEventListener('input', () => { tokenEditedManually = true; });

  document.getElementById('btn-copy-token')?.addEventListener('click', async () => {
    const tokenVal = normalizeToken(document.getElementById('create-token')?.value);
    if (!tokenVal) return alert('Nincs kód, amit másolni lehetne.');
    try {
      await navigator.clipboard.writeText(tokenVal);
      alert('Kód vágólapra másolva.');
    } catch {
      alert('Nem sikerült a vágólapra másolni. Másold ki kézzel.');
    }
  });

  document.getElementById('btn-add-ro-token')?.addEventListener('click', () => {
    addReadOnlyTokenRow();
  });

  document.getElementById('create-button')?.addEventListener('click', handleCreateMission);
  document.getElementById('join-button')?.addEventListener('click', handleJoinMission);

  document.getElementById('gps-toggle')?.addEventListener('change', (e) => {
    const checked = !!e.target.checked;
    log(checked ? 'GPS bekapcsolva (placeholder).' : 'GPS kikapcsolva.');
  });

  const menuButton = document.getElementById('menu-button');
  const appMenu = document.getElementById('app-menu');
  const closeMenuButton = document.getElementById('close-menu-button');

  menuButton?.addEventListener('click', () => appMenu?.classList.add('open'));
  closeMenuButton?.addEventListener('click', () => appMenu?.classList.remove('open'));

  document.getElementById('menu-refresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    appMenu?.classList.remove('open');
    await loadAllRoutes();
  });

  document.getElementById('menu-upload')?.addEventListener('click', async (e) => {
    e.preventDefault();
    appMenu?.classList.remove('open');
    await handleBatchUpload();
  });

  document.getElementById('menu-summary')?.addEventListener('click', (e) => {
    e.preventDefault();
    appMenu?.classList.remove('open');
    showSummary();
  });

  document.getElementById('menu-back-main')?.addEventListener('click', (e) => {
    e.preventDefault();
    appMenu?.classList.remove('open');

    document.getElementById('app-container')?.classList.add('hidden');
    document.getElementById('login-screen')?.classList.remove('hidden');
    showScreen('main-menu');
  });

  restoreJoinDefaults();
});
