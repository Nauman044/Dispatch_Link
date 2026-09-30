/* =====================================================================
   Dispatch Link – admin.js
   Reads ONLY the signed-in company's own Firebase database.
   ===================================================================== */
const DB_URLS = [
    "https://data-scrapper-eddcf-default-rtdb.firebaseio.com/",
    "https://data-scraper-2-default-rtdb.firebaseio.com/",
    "https://data-scraper-3-default-rtdb.firebaseio.com/"
];
const MASTER_ADMIN_PASS = "admin7654";
const ONLINE_MS = 30000;                       // agent heartbeat is every 5 s
const STATUSES = ["Hung up", "Voicemail", "Not interested", "Do not Call", "Follow up", "Sale Closed"];
const STATUS_CLASS = { "Hung up": "s-red", "Voicemail": "s-purple", "Not interested": "s-orange", "Do not Call": "s-blue", "Follow up": "s-green", "Sale Closed": "s-teal" };

let allowedUsers = {}, currentClient = "", activeTab = 'online';
let sessions = {}, reports = {}, callLogs = {};
let listening = false, picker = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeKey = s => String(s || "").replace(/[.#$\/\[\]]/g, "_");
const fmtTime = ts => { const d = new Date(ts); return isNaN(d) ? 'N/A' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }); };

/* ---------- USA shift date (shift changes at 3 AM New York time) ---------- */
function shiftKey(offsetDays = 0) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
        .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
    const d = new Date(`${p.year}-${p.month}-${p.day}T00:00:00`);
    if (parseInt(p.hour) < 3) d.setDate(d.getDate() - 1);
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let startDate = shiftKey(), endDate = shiftKey();
const inRange = v => { const d = String(v || "").substring(0, 10); return d >= startDate && d <= endDate; };

/* ---------- auth ---------- */
async function fetchAllowedUsers() {
    const res = await Promise.all(DB_URLS.map(u => fetch(`${u}allowedUsers.json`).then(r => r.json()).catch(() => null)));
    allowedUsers = {};
    res.forEach((users, i) => {
        if (!users) return;
        Object.keys(users).forEach(k => allowedUsers[k] = Object.assign({}, users[k], { dbUrl: users[k].dbUrl || DB_URLS[i] }));
    });
}

window.onload = () => {
    picker = flatpickr("#unifiedDateRangePicker", {
        mode: "range", dateFormat: "Y-m-d", defaultDate: [startDate, endDate],
        onChange: (dates, _s, inst) => {
            if (!dates.length) return;
            startDate = inst.formatDate(dates[0], "Y-m-d");
            endDate = dates.length === 2 ? inst.formatDate(dates[1], "Y-m-d") : startDate;
            ['presetToday', 'presetWeek'].forEach(id => $(id).classList.remove('active'));
            renderContent();
        }
    });
};

function togglePasswordVisibility() {
    const p = $('adminPasswordInput'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('togglePasswordBtn').innerText = show ? '🙈' : '👁️';
}

async function verifyAdminPassword() {
    const company = $('adminCompanyInput').value.trim(), pass = $('adminPasswordInput').value;
    await fetchAllowedUsers();
    const cfg = allowedUsers[company];
    if (!cfg || pass !== MASTER_ADMIN_PASS) { $('authErrorMsg').style.display = 'block'; return; }
    currentClient = company;
    $('authOverlay').style.display = 'none';
    $('brandTitle').innerText = company.toUpperCase();
    $('sidebarMaxLimit').innerText = cfg.maxLaptops || "Unlimited";
    setDateFilterPreset('today');
    listen(cfg.dbUrl);
}

/* ---------- realtime data from the company's own DB ---------- */
function listen(url) {
    if (listening) return;
    listening = true;
    const name = 'admin_' + currentClient;
    let app;
    try { app = firebase.initializeApp({ databaseURL: url }, name); } catch (e) { app = firebase.app(name); }
    const db = app.database();
    const bind = (node, set) => db.ref(`${node}/${currentClient}`).on('value', s => { set(s.val() || {}); renderContent(); });
    bind('sessions', v => sessions = v);
    bind('shift_reports', v => reports = v);
    bind('call_logs', v => callLogs = v);
    setInterval(renderContent, 15000);          // keeps online/offline fresh
}

/* ---------- UI plumbing ---------- */
function toggleSidebar() { $('appSidebar').classList.toggle('open'); $('sidebarOverlay').classList.toggle('active'); }

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    $('tab' + tab[0].toUpperCase() + tab.slice(1)).classList.add('active');
    if (window.innerWidth <= 900 && $('appSidebar').classList.contains('open')) toggleSidebar();
    $('filterBar').style.display = tab === 'online' ? 'none' : 'flex';
    $('exportBtn').style.display = tab === 'reports' ? 'inline-flex' : 'none';
    $('pageTitle').innerText = { online: 'Online Users', leaderboard: 'Top Calling Leaderboard', reports: 'Shift Reports & Ratios (USA Time)' }[tab];
    renderContent();
}

function setDateFilterPreset(p) {
    ['presetToday', 'presetWeek'].forEach(id => $(id).classList.remove('active'));
    $('preset' + p[0].toUpperCase() + p.slice(1)).classList.add('active');
    endDate = shiftKey();
    startDate = p === 'week' ? shiftKey(-6) : endDate;
    if (picker) picker.setDate([startDate, endDate], false);
    renderContent();
}

/* ---------- log helpers ---------- */
const toArray = v => !v ? [] : (Array.isArray(v) ? v : Object.values(v));

/* all calls of one agent (call_logs + shift_reports), de-duplicated, inside the date range */
function logsFor(agent) {
    let all = toArray(callLogs[agent]);
    toArray(reports[agent]).forEach(r => {
        if (r.logs) all = all.concat(toArray(r.logs));
        else if (r.date && r.status) all.push(r);
    });
    const seen = new Set();
    return all.filter(l => {
        if (!l || !inRange(l.shiftDate || l.date)) return false;
        const k = l.id || `${l.phone}|${l.timestamp || l.date}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
    });
}
const agentNames = () => [...new Set([...Object.keys(callLogs), ...Object.keys(reports)])];
const lastTime = logs => logs.length ? fmtTime(Math.max(...logs.map(l => l.timestamp || new Date(l.date).getTime() || 0))) : 'N/A';
function countStatuses(logs) {
    const c = Object.fromEntries(STATUSES.map(s => [s, 0]));
    logs.forEach(l => { c[STATUSES.includes(l.status) ? l.status : "Hung up"]++; });
    return c;
}
const statChips = c => STATUSES.map(s => `<span class="stat ${STATUS_CLASS[s]}">${s}: ${c[s]}</span>`).join('');
const kpi = (icon, label, val) => `<div class="kpi"><i>${icon}</i><div><small>${label}</small><b>${val}</b></div></div>`;

function activeSessions() {
    const now = Date.now();
    return Object.values(sessions).filter(s => s && s.timestamp && now - s.timestamp < ONLINE_MS);
}
function updateLicenseWidget() {
    const max = (allowedUsers[currentClient] || {}).maxLaptops || 0, n = activeSessions().length;
    const el = $('sidebarActiveSessions');
    el.innerText = `${n} / ${max || '∞'} active`;
    el.style.color = (max && n > max) ? '#f87171' : '#38bdf8';
}

/* ---------- renderers ---------- */
function renderContent() {
    if (!currentClient) return;
    updateLicenseWidget();
    const box = $('adminBodyContent');
    if (activeTab === 'online') box.innerHTML = renderOnline();
    else if (activeTab === 'leaderboard') box.innerHTML = renderLeaderboard();
    else box.innerHTML = renderReports();
}

const emptyMsg = t => `<div class="empty">${t}</div>`;

function renderOnline() {
    const live = activeSessions(), byName = {};
    live.forEach(s => { const n = s.nickname || 'Unknown'; (byName[n] = byName[n] || []).push(s); });
    const names = Object.keys(byName);
    if (!names.length) return emptyMsg(`No users online right now for <b>${esc(currentClient)}</b>.`);

    const today = shiftKey(), saveS = startDate, saveE = endDate;
    startDate = endDate = today;                                   // "calls today" on each card
    const cards = names.map(n => {
        const tabs = byName[n], calls = logsFor(safeKey(n)).length, dbl = tabs.length > 1;
        const login = tabs[0].loginTime || 'N/A';
        return `<div class="card agent ${dbl ? 'warn' : ''}">
          <div class="agent-top"><div class="avatar">${esc(n[0].toUpperCase())}</div>
            <div><b>${esc(n)}</b><small>Login: ${esc(login)}</small></div>
            ${dbl ? `<span class="pill red">⚠️ Double tab (${tabs.length})</span>` : `<span class="pill green"><i class="dot"></i>Online</span>`}</div>
          <div class="agent-calls"><span>Calls this shift</span><b>${calls}</b></div></div>`;
    }).join('');
    startDate = saveS; endDate = saveE;

    return `<div class="kpis">${kpi('🟢', 'Online agents', names.length)}${kpi('💻', 'Active tabs', live.length)}</div><div class="grid">${cards}</div>`;
}

function renderLeaderboard() {
    const rows = agentNames().map(n => ({ n, logs: logsFor(n) })).filter(r => r.logs.length).sort((a, b) => b.logs.length - a.logs.length);
    if (!rows.length) return emptyMsg('No calling data found for the selected date range.');
    const total = rows.reduce((s, r) => s + r.logs.length, 0);
    const sales = rows.reduce((s, r) => s + r.logs.filter(l => l.status === 'Sale Closed').length, 0);
    const medal = ['#f59e0b', '#94a3b8', '#b45309'];
    return `<div class="kpis">${kpi('📞', 'Total calls', total)}${kpi('🤝', 'Sales closed', sales)}${kpi('👥', 'Active callers', rows.length)}</div>
      <div class="note">USA range: <b>${startDate}</b> to <b>${endDate}</b></div>
      <div class="list">${rows.map((r, i) => `
        <div class="card rank">
          <div class="rank-no" style="background:${medal[i] || '#cbd5e1'}">${i + 1}</div>
          <div class="rank-info"><b>${esc(r.n)}</b><small>Last call: ${lastTime(r.logs)}</small>
            <div class="stats">${statChips(countStatuses(r.logs))}</div></div>
          <div class="rank-calls">${r.logs.length}<small>calls</small></div></div>`).join('')}</div>`;
}

function reportRows() {
    const out = [];
    agentNames().forEach(n => {
        const byDate = {};
        logsFor(n).forEach(l => { const d = String(l.shiftDate || l.date).substring(0, 10); (byDate[d] = byDate[d] || []).push(l); });
        Object.keys(byDate).sort().reverse().forEach(d => {
            const logs = byDate[d], c = countStatuses(logs);
            out.push({ n, d, logs, c, total: logs.length, ratio: Math.round(((logs.length - c["Voicemail"]) / logs.length) * 100) });
        });
    });
    return out;
}

function renderReports() {
    const rows = reportRows();
    if (!rows.length) return emptyMsg('No shift reports found for the selected date range.');
    const total = rows.reduce((s, r) => s + r.total, 0);
    return `<div class="kpis">${kpi('📞', 'Total calls', total)}${kpi('📅', 'Agent-shifts', rows.length)}</div>
      <div class="list">${rows.map(r => `
        <div class="card report">
          <div class="report-top"><b>Agent: ${esc(r.n)}</b>
            <span><em class="tag blue">Last call: ${lastTime(r.logs)}</em><em class="tag">USA date: ${r.d}</em></span></div>
          <div class="report-total">Total calls: <b>${r.total}</b></div>
          <div class="stats">${statChips(r.c)}<span class="stat dark push">Ratio: ${r.ratio}%</span></div></div>`).join('')}</div>`;
}

/* ---------- summary & export ---------- */
function summaryData() {
    const per = agentNames().map(n => { const l = logsFor(n); return { n, calls: l.length, sales: l.filter(x => x.status === 'Sale Closed').length }; }).sort((a, b) => b.calls - a.calls);
    return { per, calls: per.reduce((s, p) => s + p.calls, 0), sales: per.reduce((s, p) => s + p.sales, 0) };
}
function openSummaryModal() {
    const s = summaryData(), top = s.per[0];
    $('modalSummaryBody').innerHTML = `
      <b>Company:</b> ${esc(currentClient.toUpperCase())}<br><b>USA shift range:</b> ${startDate} to ${endDate}<br>
      <b>Total calls:</b> ${s.calls}<br><b>Total sales:</b> ${s.sales}<br>
      <b>Top performer:</b> ${top ? `${esc(top.n)} (${top.calls} calls)` : 'None'}`;
    $('summaryModal').style.display = 'flex';
}
function closeSummaryModal() { $('summaryModal').style.display = 'none'; }
function copySummaryText() { navigator.clipboard.writeText($('modalSummaryBody').innerText); alert("Summary copied to clipboard!"); }

function exportCSV() {
    let csv = "Agent Name,USA Shift Date,Total Calls," + STATUSES.join(",") + ",Pickup Ratio\n";
    reportRows().forEach(r => { csv += `"${r.n}","${r.d}",${r.total},${STATUSES.map(s => r.c[s]).join(",")},"${r.ratio}%"\n`; });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `${currentClient}_USA_Reports_${startDate}_to_${endDate}.csv`;
    a.click();
}
