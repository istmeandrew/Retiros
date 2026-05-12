const DB_NAME = "retiros-local-db";
const DB_VERSION = 1;
const STORE_NAME = "withdrawals";
const DELETE_PIN = "4818";
const LIBRERIA_SEED_STATUS_KEY = "retiros-libreria-seed-status-v2";

let db;
let pendingPinResolver = null;
let importedSeedCount = 0;
let refreshing = false;
let state = {
  withdrawals: [],
  selectedMethod: "efectivo"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const nextDb = request.result;
      if (!nextDb.objectStoreNames.contains(STORE_NAME)) {
        nextDb.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode = "readonly") {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAll() {
  return new Promise((resolve, reject) => {
    const request = tx().getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function put(value) {
  return new Promise((resolve, reject) => {
    const request = tx("readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function deleteById(id) {
  return new Promise((resolve, reject) => {
    const request = tx("readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearAll() {
  return new Promise((resolve, reject) => {
    const request = tx("readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function uid() {
  return `retiro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function money(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(Math.round(Number(value) || 0));
}

function todayInputValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function inputDateToIso(value) {
  if (!value) return new Date().toISOString();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

function dateTime(value) {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function dayLabel(value) {
  return new Intl.DateTimeFormat("es-CL", {
    weekday: "short",
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

function nextMonth(date) {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

function isInPeriod(date, start, end) {
  const time = new Date(date).getTime();
  return time >= start.getTime() && time < end.getTime();
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function monthRange(key) {
  const [year, month] = key.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  return { start, end: nextMonth(start) };
}

function availableMonthKeys() {
  const keys = new Set([monthKey(new Date())]);
  for (const row of state.withdrawals) keys.add(monthKey(row.date));
  return [...keys].sort((a, b) => b.localeCompare(a));
}

function rowsBetween(start, end) {
  return state.withdrawals.filter((row) => isInPeriod(row.date, start, end));
}

function rowsForMonth(key) {
  const { start, end } = monthRange(key);
  return rowsBetween(start, end);
}

function summaryMonthKey() {
  const selectedMonth = $("#dashboardMonth")?.value;
  if (selectedMonth) return selectedMonth;
  const currentMonth = monthKey(new Date());
  if (rowsForMonth(currentMonth).length) return currentMonth;
  const lastMonthWithRows = availableMonthKeys().find((key) => rowsForMonth(key).length);
  return lastMonthWithRows || currentMonth;
}

function summarize(rows) {
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const cash = rows.filter((row) => row.method === "efectivo").reduce((sum, row) => sum + row.amount, 0);
  const card = rows.filter((row) => row.method === "tarjeta").reduce((sum, row) => sum + row.amount, 0);
  const byDay = new Map();
  for (const row of rows) {
    const key = row.date.slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + row.amount);
  }
  const topDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    cash,
    card,
    count: rows.length,
    average: rows.length ? total / rows.length : 0,
    topDay: topDay ? `${dayLabel(topDay[0])} · ${money(topDay[1])}` : "-"
  };
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function requestPin(message) {
  return new Promise((resolve) => {
    pendingPinResolver = resolve;
    $("#pinMessage").textContent = message;
    $("#pinInput").value = "";
    $("#pinModal").hidden = false;
    setTimeout(() => $("#pinInput").focus(), 50);
  });
}

function closePinModal(result) {
  $("#pinModal").hidden = true;
  if (pendingPinResolver) {
    pendingPinResolver(result);
    pendingPinResolver = null;
  }
}

async function authorizeDeletion(message) {
  const pin = await requestPin(message);
  if (pin === null) return false;
  if (pin !== DELETE_PIN) {
    showToast("Clave incorrecta");
    return false;
  }
  return true;
}

async function loadState() {
  state.withdrawals = (await getAll()).sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function importLibreriaSeedOnce() {
  const seed = window.RETIROS_LIBRERIA_SEED;
  if (!Array.isArray(seed) || !seed.length) return;
  const seedStatus = localStorage.getItem(LIBRERIA_SEED_STATUS_KEY);
  if (seedStatus === "cleared") return;
  const existingRows = await getAll();
  if (seedStatus === "done" && existingRows.length) return;
  const existingIds = new Set(existingRows.map((row) => row.id));
  const missingRows = seed.filter((row) => !existingIds.has(row.id));
  for (const row of missingRows) await put(row);
  importedSeedCount = missingRows.length;
  localStorage.setItem(LIBRERIA_SEED_STATUS_KEY, "done");
}

function setTab(tab) {
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#${tab}View`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setDefaultDate() {
  const input = $("#withdrawDate");
  if (!input.value) input.value = todayInputValue();
}

function updatePreview() {
  $("#withdrawPreview").textContent = money(Number($("#withdrawAmount").value) || 0);
}

function selectMethod(method) {
  state.selectedMethod = method;
  $$(".method-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.method === method);
  });
}

async function registerWithdrawal(event) {
  event.preventDefault();
  const amount = Number($("#withdrawAmount").value) || 0;
  if (amount <= 0) return showToast("Ingresa una cantidad válida");
  await put({
    id: uid(),
    date: inputDateToIso($("#withdrawDate").value),
    amount,
    method: state.selectedMethod,
    note: $("#withdrawNote").value.trim(),
    createdAt: new Date().toISOString()
  });
  $("#withdrawAmount").value = "";
  $("#withdrawNote").value = "";
  updatePreview();
  await refresh();
  showToast("Retiro guardado");
}

async function deleteWithdrawal(id) {
  const authorized = await authorizeDeletion("Ingresa la clave para eliminar este retiro.");
  if (!authorized) return;
  await deleteById(id);
  await refresh();
  showToast("Retiro eliminado");
}

function renderSummary() {
  const now = new Date();
  const todayRows = rowsBetween(startOfDay(now), new Date(startOfDay(now).getTime() + 86400000));
  const key = summaryMonthKey();
  const monthRows = rowsForMonth(key);
  const month = summarize(monthRows);
  $("#todayTotal").textContent = money(summarize(todayRows).total);
  $("#summaryMonthLabel").textContent = monthLabel(key);
  $("#summaryCountLabel").textContent = `Registros ${monthLabel(key)}`;
  $("#monthTotal").textContent = money(month.total);
  $("#monthCount").textContent = month.count;
}

function renderRecent() {
  const rows = state.withdrawals.slice(0, 6);
  $("#recentWithdrawals").innerHTML = rows.length ? rows.map(renderRow).join("") : `<div class="empty">Aún no hay retiros.</div>`;
}

function renderRow(row) {
  const methodClass = row.method === "efectivo" ? "cash" : "card-method";
  const methodLabel = row.method === "efectivo" ? "Efectivo" : "Tarjeta";
  return `
    <div class="list-item">
      <div class="item-main">
        <strong>${methodLabel}</strong>
        <span class="item-meta">${dateTime(row.date)}${row.note ? ` · ${escapeHtml(row.note)}` : ""}</span>
      </div>
      <div class="amount ${methodClass}">
        <div>${money(row.amount)}</div>
        <button class="text-button" type="button" data-delete-id="${row.id}">Eliminar</button>
      </div>
    </div>
  `;
}

function renderDashboard() {
  const keys = availableMonthKeys();
  const current = $("#dashboardMonth").value;
  $("#dashboardMonth").innerHTML = keys.map((key) => `<option value="${key}">${monthLabel(key)}</option>`).join("");
  $("#dashboardMonth").value = keys.includes(current) ? current : keys[0];
  renderSelectedMonth();
  renderMonthList(keys);
}

function renderSelectedMonth() {
  const key = $("#dashboardMonth").value || monthKey(new Date());
  const { start, end } = monthRange(key);
  const data = summarize(rowsBetween(start, end));
  renderSummary();
  $("#selectedTotal").textContent = money(data.total);
  $("#selectedCount").textContent = data.count;
  $("#selectedCash").textContent = money(data.cash);
  $("#selectedCard").textContent = money(data.card);
  $("#selectedAverage").textContent = money(data.average);
  $("#selectedTopDay").textContent = data.topDay;
  const cashPercent = data.total ? Math.round((data.cash / data.total) * 100) : 0;
  const cardPercent = data.total ? Math.round((data.card / data.total) * 100) : 0;
  $("#cashPercent").textContent = `${cashPercent}%`;
  $("#cardPercent").textContent = `${cardPercent}%`;
  $("#cashBar").style.width = `${cashPercent}%`;
  $("#cardBar").style.width = `${cardPercent}%`;
}

function renderMonthList(keys) {
  $("#monthList").innerHTML = keys.map((key) => {
    const { start, end } = monthRange(key);
    const data = summarize(rowsBetween(start, end));
    return `
      <div class="list-item">
        <div class="item-main">
          <strong>${monthLabel(key)}</strong>
          <span class="item-meta">${data.count} retiros · efectivo ${money(data.cash)} · tarjeta ${money(data.card)}</span>
        </div>
        <span class="amount">${money(data.total)}</span>
      </div>
    `;
  }).join("");
}

function renderHistory() {
  const filter = $("#historyFilter").value;
  const rows = filter === "all" ? state.withdrawals : state.withdrawals.filter((row) => row.method === filter);
  $("#historyList").innerHTML = rows.length ? rows.map(renderRow).join("") : `<div class="empty">Sin registros.</div>`;
}

function buildBackupPayload() {
  return {
    exportedAt: new Date().toISOString(),
    app: "retiros-local",
    version: 1,
    data: {
      withdrawals: state.withdrawals
    }
  };
}

function backupText() {
  return JSON.stringify(buildBackupPayload(), null, 2);
}

function putBackupOnScreen(text = backupText()) {
  $("#backupText").value = text;
  $("#backupText").textContent = text;
}

function exportData() {
  const text = backupText();
  putBackupOnScreen(text);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `respaldo-retiros-${todayInputValue()}.json`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Respaldo listo");
}

function showBackupText() {
  putBackupOnScreen();
  showToast("Respaldo generado en pantalla");
}

async function copyBackupText() {
  const text = backupText();
  putBackupOnScreen(text);
  try {
    await navigator.clipboard.writeText(text);
    showToast("Respaldo copiado");
  } catch {
    $("#backupText").focus();
    $("#backupText").select();
    showToast("Selecciona y copia el respaldo");
  }
}

async function importData(file) {
  if (!file) return;
  const payload = JSON.parse(await file.text());
  const imported = payload.data || payload;
  if (!Array.isArray(imported.withdrawals)) throw new Error("Respaldo inválido");
  await clearAll();
  for (const row of imported.withdrawals) await put(row);
  localStorage.setItem(LIBRERIA_SEED_STATUS_KEY, "done");
  await refresh();
}

async function resetData() {
  const authorized = await authorizeDeletion("Ingresa la clave para borrar todos los retiros.");
  if (!authorized) return;
  await clearAll();
  localStorage.setItem(LIBRERIA_SEED_STATUS_KEY, "cleared");
  await refresh();
  showToast("Datos borrados");
}

function render() {
  setDefaultDate();
  selectMethod(state.selectedMethod);
  renderSummary();
  renderRecent();
  renderDashboard();
  renderHistory();
  updatePreview();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadState();
    render();
  } finally {
    refreshing = false;
  }
}

function bind() {
  $$(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $$("[data-tab-target]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tabTarget)));
  $$(".method-option").forEach((button) => {
    button.addEventListener("click", () => selectMethod(button.dataset.method));
  });
  $("#withdrawForm").addEventListener("submit", registerWithdrawal);
  $("#withdrawAmount").addEventListener("input", updatePreview);
  $("#dashboardMonth").addEventListener("change", renderSelectedMonth);
  $("#historyFilter").addEventListener("change", renderHistory);
  $("#historyList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (button) deleteWithdrawal(button.dataset.deleteId);
  });
  $("#recentWithdrawals").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (button) deleteWithdrawal(button.dataset.deleteId);
  });
  $("#backupBtn").addEventListener("click", exportData);
  $("#exportBtn").addEventListener("click", exportData);
  $("#showBackupBtn").addEventListener("click", showBackupText);
  $("#copyBackupBtn").addEventListener("click", copyBackupText);
  $("#pinCancel").addEventListener("click", () => closePinModal(null));
  $("#pinConfirm").addEventListener("click", () => closePinModal($("#pinInput").value.trim()));
  $("#pinInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") closePinModal($("#pinInput").value.trim());
    if (event.key === "Escape") closePinModal(null);
  });
  $("#pinModal").addEventListener("click", (event) => {
    if (event.target.id === "pinModal") closePinModal(null);
  });
  $("#importFile").addEventListener("change", async (event) => {
    try {
      await importData(event.target.files[0]);
      showToast("Respaldo importado");
    } catch {
      showToast("No se pudo importar");
    }
  });
  $("#resetBtn").addEventListener("click", resetData);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

async function init() {
  db = await openDb();
  await importLibreriaSeedOnce();
  bind();
  await refresh();
  if (importedSeedCount) showToast(`${importedSeedCount} retiros importados`);
}

init().catch(() => {
  document.body.innerHTML = "<main class='app'><section class='card'><h1>No se pudo iniciar</h1><p>El navegador no permitió abrir la base local.</p></section></main>";
});
