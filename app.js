// ============================================================
// 学习追踪器 — app.js
// 数据层：所有读写通过 Flask API，不再使用 localStorage
// ============================================================

// ============================================================
// SETTINGS SYSTEM
// ============================================================
const DEFAULT_SETTINGS = {
  // 外观
  themeColors: { hp: '#4fc3f7', pol: '#69f0ae', word: '#ce93d8', thesis: '#ffb74d', code: '#ef9a9a', other: '#78909c', red: '#f44336', green: '#66bb6a', sleep: '#b388ff', wake: '#ffd54f', clock: '#80deea', nominal: '#4fc3f7', actual: '#69f0ae' },
  fontSize: 14,
  actColors: [
    { color: '#69f0ae', cls: 'pol' },
    { color: '#4fc3f7', cls: 'hp' },
    { color: '#ce93d8', cls: 'word' },
    { color: '#ffb74d', cls: 'thesis' },
    { color: '#ef9a9a', cls: 'code' },
    { color: '#78909c', cls: 'other' },
    { color: '#80deea', cls: 'clock' },
    { color: '#b388ff', cls: 'sleep' },
    { color: '#ffd54f', cls: 'wake' },
  ],
  // 时间与计算规则
  dailyGoalHours: 8,
  wakeGoalHour: 7,
  sleepGoalHour: 0,
  utilPassPct: 50,
  focusGoodPct: 80,
  focusOkPct: 60,
  weekStartDay: 1, // 1=周一, 0=周日
  // 数据存储
  autosaveInterval: 3000,
  useLocalStorageCache: true,
  // 评分规则
  ratingActualMin: 480,       // 实际专注>=480min(8h)得1分
  ratingDeviationPct: -10,    // 偏差>=-10%得1分
  ratingWakeLimit: 480,       // 起床<=480min(8:00)得1分
  ratingUtilPct: 50,          // 利用率>=50%得1分
  ratingStarThreshold: 3,     // >=3分⭐
  ratingOkThreshold: 2,       // >=2分👌
  ratingWarnThreshold: 1,     // >=1分⚠️
  // 作息颜色阈值
  wakeGoodMinute: 420,        // <=7:00 绿色
  wakeWarnMinute: 480,        // <=8:00 黄色, >8:00 红色
  sleepGoodHour: 0,           // <=0:00 绿色
  sleepWarnHour: 0.5,         // <=0:30 黄色, >0:30 红色
};

const SETTINGS_KEY = 'tracker_settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (e) { console.warn('加载设置失败', e); }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { console.warn('保存设置失败', e); }
  // Apply theme colors to CSS variables
  applyThemeColors(s);
  // Update autosave interval
  startDraftAutoSave();
}

function applyThemeColors(s) {
  const root = document.documentElement;
  if (s.themeColors) {
    Object.keys(s.themeColors).forEach(k => {
      root.style.setProperty('--' + k, s.themeColors[k]);
    });
  }
  if (s.fontSize) {
    root.style.setProperty('font-size', s.fontSize + 'px');
  }
}

let SETTINGS = loadSettings();

// ============================================================
// TOOLTIP SYSTEM
// ============================================================
const TIPS = {
  clock: '⏱ 时钟时长（原始）\n每个时段从「开始时间」到「结束时间」的原始时间跨度，包含休息、分心等所有时间。\n\n公式：结束时间 − 开始时间（跨午夜自动 +1440 分钟）',
  effectiveClock: '⏱ 有效时钟\n普通专注时段扣除休息后，再加上特殊学习时段中的真实学习分钟。它是衡量专注效率的分母。\n\n公式：普通专注时钟 − 休息时间 + 特殊学习实际分钟',
  nominal: '📋 名义时长\n你预先设定的计划专注时长，手动录入。代表「打算专注多久」，是自己定下的目标基准。\n\n公式：∑ 各时段名义时长（手动输入合计）',
  actual: '✅ 实际专注\n剔除分心和休息后，真正高效专注的时长，手动录入。代表「实际学了多久」，是最能反映学习成果的指标。\n\n公式：∑ 各时段实际专注分钟数（手动输入合计）',
  efficiency: '🎯 专注效率\n实际专注占有效时段时长的比例，衡量这段时间的专注密度。数值越高代表越少走神。\n\n≥80% 优秀 · ≥60% 合格 · <60% 需改善\n\n公式：实际专注 ÷ (时钟时长 − 休息时间) × 100%',
  rest: '😴 休息时间\n该时段内的计划休息时长（如番茄钟间隔休息、课间休息等），手动录入。\n\n公式：∑ 各时段休息分钟数（手动输入合计）',
  distract: '😶 分心时间\n时钟时长中扣除实际专注和休息后的剩余时间，反映走神/摸鱼的时长。\n\n公式：时钟时长 − 实际专注 − 休息时间',
  awake: '🌤 清醒时长\n从起床到睡觉的总时长，是当天可用于学习与生活的全部时间。需要录入起床和睡觉时间后才能计算。\n\n公式：睡觉时间 − 起床时间（跨午夜自动修正）',
  util: '📊 时间利用率\n实际专注占可支配时长的比例，衡量真正可用于学习的时间中有多少真正专注。\n\n≥50% 合格\n\n公式：实际专注 ÷ 可支配时长 × 100%\n可支配时长 = 清醒时长 − 不可用时间\n不可用时间包括普通特殊时段的完整跨度，以及特殊学习时段中没有学习的部分。\n特殊学习时段中的实际学习仍计入实际专注。',
  deviation: '📉 偏差率（实际 vs 名义）\n实际专注与名义时长的差值比，反映真实专注量 vs 计划目标的差距。\n\n正值 = 超额完成计划\n负值 = 未达计划（走神多或提前结束）\n\n公式：(实际专注 − 名义时长) ÷ 名义时长 × 100%',
  clockDev: '⚡ 时钟偏差（学习口径时钟 vs 名义）\n普通专注跨度与特殊学习实际分钟之和，与名义时长相比的偏差。完全不可用时段不会混入计划偏差。\n\n正值 = 学习口径时钟超过计划\n负值 = 比计划提前结束\n\n公式：(普通专注时钟 + 特殊学习实际分钟 − 名义时长) ÷ 名义时长 × 100%',
  sessRate: '🎯 专注率（单时段）\n该时段的实际专注占有效时段时长的比例，反映单次时段的专注密度。\n\n公式：实际专注 ÷ (时钟时长 − 休息时间) × 100%',
  taskMin: '📝 任务记录时长\n任务记录板中所有任务的时长总和。任务板与时段统计相互独立，用于记录具体的学习内容和数量。',
  // 堆积图专用
  stackAwake: '🌤 清醒总时长\n所选时间范围内每天清醒时长（起床→睡觉）的总和。\n只计算同时录入了起床和睡觉时间的天数。\n\n公式：∑ (睡觉时间 − 起床时间)',
  stackTask: '📝 任务记录总时长\n所选时间范围内「任务记录板」中所有任务时长的总和。\n按活动类别（一级分类）分组后堆叠在面积图最底层。\n\n公式：∑ 所有任务的 minutes 字段',
  stackSpecial: '🔸 不可用时段总时长\n所选时间范围内完全不可学习的特殊时段，以及特殊学习时段中未学习部分的总和。\n包括吃饭、通勤、外出等，按名称分组堆叠。',
  stackRest: '😴 休息时间\n所选时间范围内所有「普通专注时段」中录入的休息时长总和。\n例如番茄钟间隔、课间休息等计划内休息。\n不包括特殊时段。\n\n公式：∑ (type≠special 的 session 的 restMinutes)',
  stackDistract: '😶 分心时间\n所选时间范围内所有「普通专注时段」中，时钟时长扣除实际专注和休息后的剩余时间。\n反映在专注时段内走神、摸鱼、看手机等非计划消耗。\n\n公式：∑ (时钟时长 − 实际专注 − 休息时间)\n仅统计 type≠special 的普通 session',
  stackIdle: '⬜ 空闲/未记录时间\n清醒时长中，扣除「任务记录时长 + 特殊时段 + 休息 + 分心」后的剩余时间。\n代表没有被任何记录覆盖的时间段，可能是：\n· 忘记录入的学习时间\n· 日常琐事（洗漱、整理等）\n· 真正的空闲放松时间\n\n公式：清醒时长 − 任务时长 − 特殊时段 − 休息 − 分心\n\n注意：如果任务和专注时段有重叠记录，\n空闲时间可能被低估甚至出现负值（会被截断为0）',
  // 统计指标
  stdDev: '📏 标准差 (σ)\n衡量数据围绕均值的分散程度。\n标准差越大，说明每天的波动越大。\n\n公式：σ = √(Σ(xi − μ)² / n)',
  cv: '📊 变异系数 (CV)\n标准差与均值的比值，用百分比表示。\n消除了量纲影响，可以跨指标比较稳定性。\n\nCV < 15% → 非常稳定\nCV 15-30% → 较稳定\nCV 30-50% → 波动较大\nCV > 50% → 波动很大\n\n公式：CV = σ / μ × 100%',
};

/** 返回一个带 hover 提示的 ⓘ 图标 HTML */
function tipIcon(key) {
  const text = TIPS[key];
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<span class="tip-icon" data-tip="${escaped}" onmouseenter="showTip(event,this)" onmouseleave="hideTip()" onmousemove="_moveTip(event)">ⓘ</span>`;
}

function showTip(e, el) {
  let tip = document.getElementById('_gTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = '_gTip';
    tip.className = 'global-tip';
    document.body.appendChild(tip);
  }
  // textContent preserves \n via white-space:pre-line
  tip.textContent = el.dataset.tip;
  tip.style.display = 'block';
  _moveTip(e);
}
function _moveTip(e) {
  const tip = document.getElementById('_gTip');
  if (!tip || tip.style.display === 'none') return;
  const x = e.clientX + 16, y = e.clientY + 16;
  const w = tip.offsetWidth || 290, h = tip.offsetHeight || 100;
  tip.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
  tip.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
}
function hideTip() {
  const tip = document.getElementById('_gTip');
  if (tip) tip.style.display = 'none';
}

const chartReg = {};

const state = {
  data: {},
  selectedDate: getTodayStr(),
  tab: 'entry',
  cal: { year: new Date().getFullYear(), month: new Date().getMonth() },
  weekStart: getMondayOfDate(new Date()),
  monthView: { year: new Date().getFullYear(), month: new Date().getMonth() },
  _editingSessionId: null,
  _editingTaskId: null,
  _taskFilter: {},  // { entry: '类别', day: '类别', week: '类别', month: '类别' }
  stackedMode: 'week', // 'week' or 'month'
  stackedWeekStart: getMondayOfDate(new Date()),
  stackedMonth: { year: new Date().getFullYear(), month: new Date().getMonth() },
  stackedGroupLevel: 1, // 1=一级, 2=二级, 3=三级
  sessAna: { mode: 'week', weekStart: getMondayOfDate(new Date()), month: { year: new Date().getFullYear(), month: new Date().getMonth() }, catFilter: '' },
  taskAna: { mode: 'week', weekStart: getMondayOfDate(new Date()), month: { year: new Date().getFullYear(), month: new Date().getMonth() }, level: 1, effScale: 'linear', effYMax: '', catFilter: '', effCatFilter: '' },
};

// ============================================================
// TASK FILTER HELPERS
// ============================================================
function getTaskFilterTypes(tasks) {
  const types = new Set();
  let hasUncat = false;
  tasks.forEach(t => {
    if (t.activityType) types.add(t.activityType);
    else hasUncat = true;
  });
  const sorted = [...types].sort();
  if (hasUncat) sorted.push('未分类');
  return sorted;
}

function taskFilterHtml(viewId, tasks) {
  const types = getTaskFilterTypes(tasks);
  if (types.length <= 1) return '';
  const cur = state._taskFilter[viewId] || '';
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
    <span style="font-size:12px;color:var(--muted)">类别筛选：</span>
    <select onchange="applyTaskFilter('${viewId}',this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px">
      <option value="">全部 (${tasks.length})</option>
      ${types.map(t => {
    const cnt = t === '未分类'
      ? tasks.filter(x => !x.activityType).length
      : tasks.filter(x => x.activityType === t).length;
    return `<option value="${escHtmlApp(t)}" ${cur === t ? 'selected' : ''}>${escHtmlApp(t)} (${cnt})</option>`;
  }).join('')}
    </select>
    ${cur ? `<button class="btn btn-ghost btn-sm" onclick="applyTaskFilter('${viewId}','')" style="font-size:11px;padding:2px 6px">✕ 清除</button>` : ''}
  </div>`;
}

function filterTasksByView(tasks, viewId) {
  const f = state._taskFilter[viewId];
  if (!f) return tasks;
  if (f === '未分类') return tasks.filter(t => !t.activityType);
  return tasks.filter(t => t.activityType === f);
}

function applyTaskFilter(viewId, value) {
  state._taskFilter[viewId] = value || '';
  const renders = { entry: renderEntry, day: renderDayOverview, week: renderWeekOverview, month: renderMonthOverview };
  if (renders[viewId]) renders[viewId]();
}

// ============================================================
// API HELPERS
// ============================================================
async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

const CACHE_KEY = 'tracker_data';
const DRAFT_KEY_PREFIX = 'tracker_draft_';

function cacheToLocal() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.data)); } catch (e) { console.warn('localStorage写入失败', e); }
}
function loadFromLocal() {
  try { const s = localStorage.getItem(CACHE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

async function loadStorage() {
  // 1. 先从 localStorage 恢复（保证离线/崩溃后有数据）
  const cached = loadFromLocal();
  if (cached) state.data = cached;
  // 2. 再从 API 拉取最新
  try {
    state.data = await apiFetch('/api/data');
    cacheToLocal();
  } catch (e) {
    console.error('加载数据失败，使用本地缓存', e);
    if (!cached) state.data = {};
  }
}

async function saveAllStorage() {
  cacheToLocal();
  try { await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) }); } catch (e) { console.error('API保存失败，已缓存到本地', e); }
}

// ── 表单草稿缓存 ─────────────────────────────────────────────
function saveDraft(dateStr, draftData) {
  try { localStorage.setItem(DRAFT_KEY_PREFIX + dateStr, JSON.stringify(draftData)); } catch (e) { }
}
function loadDraft(dateStr) {
  try { const s = localStorage.getItem(DRAFT_KEY_PREFIX + dateStr); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function clearDraft(dateStr) {
  try { localStorage.removeItem(DRAFT_KEY_PREFIX + dateStr); } catch (e) { }
}

// 自动保存当前页面表单草稿（每3秒）
let _draftTimer = null;
function startDraftAutoSave() {
  if (_draftTimer) clearInterval(_draftTimer);
  _draftTimer = setInterval(() => {
    if (state.tab !== 'entry') return;
    const dateStr = state.selectedDate;
    const draft = {};
    // 起床/睡觉时间
    const wh = document.getElementById('wakeInput_h'), wm = document.getElementById('wakeInput_m');
    if (wh) draft.wakeH = wh.value;
    if (wm) draft.wakeM = wm.value;
    const sh = document.getElementById('sleepInput_h'), sm = document.getElementById('sleepInput_m');
    if (sh) draft.sleepH = sh.value;
    if (sm) draft.sleepM = sm.value;
    // 备注
    const noteEl = document.getElementById('dayNoteInput');
    if (noteEl) draft.dayNote = noteEl.value;
    // 专注时段表单
    ['sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note'].forEach(id => {
      const el = document.getElementById(id); if (el) draft[id] = el.value;
    });
    // 任务表单
    ['task_name', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom', 'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit', 'task_acc', 'task_note'].forEach(id => {
      const el = document.getElementById(id); if (el) draft[id] = el.value;
    });
    saveDraft(dateStr, draft);
  }, 3000);
}

function restoreDraft(dateStr) {
  const draft = loadDraft(dateStr);
  if (!draft) return;
  setTimeout(() => {
    if (draft.wakeH) { const el = document.getElementById('wakeInput_h'); if (el && !el.value) el.value = draft.wakeH; }
    if (draft.wakeM) { const el = document.getElementById('wakeInput_m'); if (el && !el.value) el.value = draft.wakeM; }
    if (draft.sleepH) { const el = document.getElementById('sleepInput_h'); if (el && !el.value) el.value = draft.sleepH; }
    if (draft.sleepM) { const el = document.getElementById('sleepInput_m'); if (el && !el.value) el.value = draft.sleepM; }
    if (draft.dayNote) { const el = document.getElementById('dayNoteInput'); if (el && !el.value) el.value = draft.dayNote; }
    ['sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note',
      'task_name', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom', 'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit', 'task_acc', 'task_note'].forEach(id => {
        if (draft[id]) { const el = document.getElementById(id); if (el && !el.value) el.value = draft[id]; }
      });
  }, 50);
}

// ============================================================
// DATE UTILITIES
// ============================================================
function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getMondayOfDate(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return dateToStr(date);
}
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function strToDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(dateStr, n) {
  const d = strToDate(dateStr);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}
function formatDisplay(dateStr) {
  const d = strToDate(dateStr);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日（周${weekdays[d.getDay()]}）`;
}
function formatShort(dateStr) {
  const d = strToDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function getWeekDays(mondayStr) {
  return Array.from({ length: 7 }, (_, i) => addDays(mondayStr, i));
}
function getMonthDays(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = firstDay.getDay();
  const start = new Date(firstDay);
  start.setDate(start.getDate() - (startDow === 0 ? 6 : startDow - 1));
  const days = [];
  const cur = new Date(start);
  while (cur <= lastDay || days.length % 7 !== 0) {
    days.push({ dateStr: dateToStr(cur), inMonth: cur.getMonth() === month });
    cur.setDate(cur.getDate() + 1);
    if (days.length > 42) break;
  }
  return days;
}

// ============================================================
// TIME UTILITIES
// ============================================================
function parseMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
function fmtMin(m, showZero) {
  if (m == null || (m === 0 && !showZero)) return '-';
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60), mn = abs % 60;
  if (h === 0) return `${sign}${mn}m`;
  if (mn === 0) return `${sign}${h}h`;
  return `${sign}${h}h${mn}m`;
}
function fmtHrs(m) { return (m / 60).toFixed(1) + 'h'; }

// ── 统计工具函数 ──
/** 计算一组数值的均值、方差、标准差、变异系数 */
function calcStats(values) {
  const vals = values.filter(v => v != null && v > 0);
  const n = vals.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0, stdDev: 0, cv: null };
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : null;
  return { n, mean, variance, stdDev, cv };
}

/** 格式化变异系数 */
function fmtCV(cv) { return cv != null ? (cv * 100).toFixed(1) + '%' : '-'; }
/** 格式化标准差（分钟→时分） */
function fmtSD(sd) { return fmtMin(Math.round(sd)); }
function sessionClock(s) {
  const a = parseMin(s.startTime), b = parseMin(s.endTime);
  if (a == null || b == null) return 0;
  let d = b - a; if (d < 0) d += 1440; return d;
}
function isUnavailableSession(s) { return s?.type === 'special'; }
function isSpecialStudySession(s) { return s?.type === 'special-study'; }
function sessionTypeMeta(s) {
  if (isSpecialStudySession(s)) return { label: s.name || '特殊学习', short: '特学', color: '#80deea', bg: 'rgba(128,222,234,.08)' };
  if (isUnavailableSession(s)) return { label: s.name || '特殊时段', short: '特殊', color: '#ce93d8', bg: 'rgba(206,147,216,.06)' };
  return { label: '普通', short: '', color: 'var(--text)', bg: '' };
}
function devClass(pct) {
  if (pct == null) return 'c-muted';
  if (pct > 5) return 'dev-pos'; if (pct < -5) return 'dev-neg'; return 'dev-zero';
}
function devStr(pct) {
  if (pct == null) return '-';
  return (pct >= 0 ? '+' : '') + pct + '%';
}

// ============================================================
// TIME INPUT HELPERS
// ============================================================
function timeInputHtml(idPrefix, timeStr) {
  let h = '', m = '';
  if (timeStr) {
    const parts = timeStr.split(':');
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
  }
  return `<div class="time-input-group">
    <input type="number" id="${idPrefix}_h" min="0" max="23" placeholder="时" value="${h !== '' ? h : ''}" onchange="clampTimeInput(this,0,23)">
    <span class="time-sep">:</span>
    <input type="number" id="${idPrefix}_m" min="0" max="59" placeholder="分" value="${m !== '' ? m : ''}" onchange="clampTimeInput(this,0,59)">
  </div>`;
}
function readTimeInput(idPrefix) {
  const hEl = document.getElementById(idPrefix + '_h');
  const mEl = document.getElementById(idPrefix + '_m');
  if (!hEl || !mEl) return '';
  const h = hEl.value, m = mEl.value;
  if (h === '' && m === '') return '';
  const hh = String(parseInt(h, 10) || 0).padStart(2, '0');
  const mm = String(parseInt(m, 10) || 0).padStart(2, '0');
  return hh + ':' + mm;
}
function clampTimeInput(el, min, max) {
  let v = parseInt(el.value, 10);
  if (isNaN(v)) return;
  if (v < min) el.value = min;
  if (v > max) el.value = max;
}

// ============================================================
// ACTIVITY CATEGORY CONFIG (3 independent flat lists)
// ============================================================
// Three independent stores:
//   state.data.__catLevel1__ = ["政治", "英语", "数学"]
//   state.data.__catLevel2__ = ["阅读", "背诵", "刷题"]
//   state.data.__catLevel3__ = ["真题", "模拟题", "单词"]
// Task stores activityType as "一级 > 二级 > 三级" path string

function getCatList(level) {
  const key = `__catLevel${level}__`;
  if (!state.data[key]) state.data[key] = [];
  return state.data[key];
}

// Migrate old tree __activityCategories__ and flat __activityTypes__ to new flat lists
function migrateOldTypes() {
  // Migrate old flat __activityTypes__
  if (state.data.__activityTypes__ && Array.isArray(state.data.__activityTypes__)) {
    const l1 = getCatList(1);
    state.data.__activityTypes__.forEach(name => {
      if (!l1.includes(name)) l1.push(name);
    });
    delete state.data.__activityTypes__;
  }
  // Migrate old tree __activityCategories__
  if (state.data.__activityCategories__ && Array.isArray(state.data.__activityCategories__)) {
    const l1 = getCatList(1);
    const l2 = getCatList(2);
    const l3 = getCatList(3);
    state.data.__activityCategories__.forEach(cat => {
      if (cat.name && !l1.includes(cat.name)) l1.push(cat.name);
      (cat.children || []).forEach(sub => {
        if (sub.name && !l2.includes(sub.name)) l2.push(sub.name);
        (sub.children || []).forEach(item => {
          if (item.name && !l3.includes(item.name)) l3.push(item.name);
        });
      });
    });
    delete state.data.__activityCategories__;
  }
}

function getLevel1Names() { return getCatList(1); }
function getLevel2Names() { return getCatList(2); }
function getLevel3Names() { return getCatList(3); }
// Aliases for compatibility
function getAllLevel2Names() { return getCatList(2); }
function getAllLevel3Names() { return getCatList(3); }

async function addCatItem(level, name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  const list = getCatList(level);
  if (!list.includes(name)) list.push(name);
  await saveAllStorage();
}

async function deleteCatItem(level, name) {
  if (!name) return;
  const key = `__catLevel${level}__`;
  state.data[key] = (state.data[key] || []).filter(n => n !== name);
  await saveAllStorage();
}

// ============================================================
// UNIT LIBRARY (数量单位库)
// ============================================================
function getUnitList() {
  if (!state.data.__unitList__) state.data.__unitList__ = ['个', '个单词', '道题', '页', '行', '篇', '套'];
  return state.data.__unitList__;
}

async function addUnitItem(name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  const list = getUnitList();
  if (!list.includes(name)) list.push(name);
  await saveAllStorage();
}

async function deleteUnitItem(name) {
  if (!name) return;
  state.data.__unitList__ = (state.data.__unitList__ || []).filter(n => n !== name);
  await saveAllStorage();
}

/**
 * 生成单位增强选择器 HTML
 */
function unitSelectorHtml(inputId, currentValue, msgId) {
  return `
    <div class="cat-selector" id="${inputId}_wrap">
      <div class="cat-selector-input-row">
        <div class="cat-selector-field" style="position:relative;flex:1">
          <input type="text" id="${inputId}" value="${escHtmlApp(currentValue || '')}"
            placeholder="输入搜索或新建单位"
            autocomplete="off"
            onfocus="unitSelOpen('${inputId}')"
            oninput="unitSelFilter('${inputId}')"
            style="width:100%;box-sizing:border-box">
          <div class="cat-sel-dropdown" id="${inputId}_dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
            max-height:200px;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;
            box-shadow:0 8px 24px rgba(0,0,0,.3)">
          </div>
        </div>
        <button class="btn btn-success btn-sm" onclick="unitSelSave('${inputId}','${msgId}')" title="保存到单位库" style="min-width:32px">＋</button>
        <button class="btn btn-ghost btn-sm" onclick="unitSelDelete('${inputId}','${msgId}')" title="从单位库删除" style="color:var(--red);min-width:32px">🗑</button>
      </div>
    </div>`;
}

function unitSelOpen(inputId) {
  unitSelFilter(inputId);
  const dd = document.getElementById(inputId + '_dd');
  if (dd) dd.style.display = 'block';
  setTimeout(() => {
    const close = (e) => {
      const wrap = document.getElementById(inputId + '_wrap');
      if (wrap && !wrap.contains(e.target)) {
        dd.style.display = 'none';
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

function unitSelFilter(inputId) {
  const input = document.getElementById(inputId);
  const dd = document.getElementById(inputId + '_dd');
  if (!input || !dd) return;
  const query = input.value.trim().toLowerCase();
  const items = getUnitList();
  const filtered = query ? items.filter(it => it.toLowerCase().includes(query)) : items;
  const exactMatch = items.some(it => it.toLowerCase() === query);
  let html = '';
  if (filtered.length === 0 && !query) {
    html = '<div style="padding:8px 12px;font-size:11px;color:var(--dim)">暂无单位，输入后点 ＋ 添加</div>';
  } else {
    filtered.forEach(it => {
      const isSelected = it === input.value;
      html += `<div style="padding:6px 12px;cursor:pointer;font-size:12px;
        ${isSelected ? 'background:rgba(105,240,174,.1);color:var(--pol);font-weight:600' : 'color:var(--text)'};"
        onmousedown="catSelPick('${inputId}','${escHtmlApp(it)}')"
        onmouseenter="this.style.background='rgba(79,195,247,.1)'"
        onmouseleave="this.style.background='${isSelected ? 'rgba(105,240,174,.1)' : ''}'">
        ${escHtmlApp(it)}
      </div>`;
    });
    if (query && !exactMatch) {
      html += `<div style="padding:6px 12px;font-size:11px;color:var(--pol);border-top:1px solid var(--border);cursor:pointer"
        onmousedown="catSelPick('${inputId}','${escHtmlApp(query)}')"
        onmouseenter="this.style.background='rgba(105,240,174,.08)'"
        onmouseleave="this.style.background=''">
        ＋ 新建「${escHtmlApp(query)}」
      </div>`;
    }
  }
  dd.innerHTML = html;
  dd.style.display = 'block';
}

async function unitSelSave(inputId, msgId) {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  if (!name) { _showCatMsg(msgId, '⚠️ 请先输入单位名称', 'var(--red)'); return; }
  const list = getUnitList();
  if (list.includes(name)) { _showCatMsg(msgId, `「${name}」已存在`, 'var(--muted)'); return; }
  await addUnitItem(name);
  _showCatMsg(msgId, `✅ 已保存「${name}」`, 'var(--pol)');
}

async function unitSelDelete(inputId, msgId) {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  if (!name) { _showCatMsg(msgId, '⚠️ 请先输入或选择要删除的单位', 'var(--red)'); return; }
  if (!getUnitList().includes(name)) { _showCatMsg(msgId, `「${name}」不在单位库中`, 'var(--muted)'); return; }
  if (!confirm(`确定从单位库中删除「${name}」？`)) return;
  await deleteUnitItem(name);
  if (el) el.value = '';
  _showCatMsg(msgId, `🗑️ 已删除「${name}」`, 'var(--muted)');
}

// Build display string from parts
function buildActPath(l1, l2, l3) {
  const parts = [l1, l2, l3].filter(Boolean);
  return parts.join(' > ');
}
// Parse path back to parts
function parseActPath(path) {
  if (!path) return ['', '', ''];
  const parts = path.split(' > ');
  return [parts[0] || '', parts[1] || '', parts[2] || ''];
}
// Get top-level category from path (for color)
function getActL1(path) { return parseActPath(path)[0]; }

// Backward compat: getActivityTypes returns flat list of all L1 names
function getActivityTypes() { return getLevel1Names(); }

// ============================================================
// SESSION TEMPLATES (特殊专注时段模板)
// ============================================================
function getSessionTemplates() {
  if (!state.data.__sessionTemplates__) state.data.__sessionTemplates__ = [];
  return state.data.__sessionTemplates__;
}

async function addSessionTemplate(tmpl) {
  tmpl.id = uid();
  getSessionTemplates().push(tmpl);
  await saveAllStorage();
}

async function deleteSessionTemplate(id) {
  state.data.__sessionTemplates__ = getSessionTemplates().filter(t => t.id !== id);
  await saveAllStorage();
}

async function saveSessionTemplate(tmpl) {
  const list = getSessionTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
}

// ============================================================
// DAY TYPE TEMPLATES (日期类型模板)
// ============================================================
function getDayTypeTemplates() {
  if (!state.data.__dayTypeTemplates__) state.data.__dayTypeTemplates__ = [];
  return state.data.__dayTypeTemplates__;
}

async function notifyDayTypeTemplatesChanged() {
  if (typeof aiInvalidateDayTypeReviews === 'function') {
    await aiInvalidateDayTypeReviews();
  }
}

async function addDayTypeTemplate(tmpl) {
  tmpl.id = uid();
  getDayTypeTemplates().push(tmpl);
  await saveAllStorage();
  await notifyDayTypeTemplatesChanged();
}

async function deleteDayTypeTemplate(id) {
  state.data.__dayTypeTemplates__ = getDayTypeTemplates().filter(t => t.id !== id);
  await saveAllStorage();
  await notifyDayTypeTemplatesChanged();
}

async function saveDayTypeTemplate(tmpl) {
  const list = getDayTypeTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
  await notifyDayTypeTemplatesChanged();
}

/** Switch session type between normal and special */
function switchSessionType(type) {
  const normalBtn = document.getElementById('sessTypeNormal');
  const specialBtn = document.getElementById('sessTypeSpecial');
  const specialStudyBtn = document.getElementById('sessTypeSpecialStudy');
  const nameGroup = document.getElementById('sessNameGroup');
  const nominalGroup = document.getElementById('sessNominalGroup');
  const actualGroup = document.getElementById('sessActualGroup');
  const restGroup = document.getElementById('sessRestGroup');
  const buttons = { normal: normalBtn, special: specialBtn, 'special-study': specialStudyBtn };
  Object.entries(buttons).forEach(([key, btn]) => {
    if (!btn) return;
    const active = key === type;
    btn.style.background = active ? 'var(--pol)' : '';
    btn.style.color = active ? '#000' : '';
    btn.style.fontWeight = active ? '600' : '';
    btn.className = active ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
  });
  if (nameGroup) nameGroup.style.display = type === 'normal' ? 'none' : 'block';
  if (nominalGroup) nominalGroup.style.display = type === 'normal' ? 'block' : 'none';
  if (actualGroup) actualGroup.style.display = type === 'special' ? 'none' : 'block';
  if (restGroup) restGroup.style.display = type === 'normal' ? 'block' : 'none';
  state._sessType = type;
}

/** Pre-fill the session entry form from a session template */
function applySessionTemplate(id) {
  if (!id) return;
  const tmpl = getSessionTemplates().find(t => t.id === id);
  if (!tmpl) return;
  // Auto-switch to special mode and fill name
  switchSessionType('special');
  const nameEl = document.getElementById('sess_name');
  if (nameEl && tmpl.name) nameEl.value = tmpl.name;
  if (tmpl.note) {
    const el = document.getElementById('sess_note'); if (el) el.value = tmpl.note;
  }
}

// ============================================================
// TASK TEMPLATES
// ============================================================
// Structure: { id, name, activityType, keywords:[], aiPrompt, defaultMinutes, quantityUnit, note }
function getTaskTemplates() {
  if (!state.data.__taskTemplates__) state.data.__taskTemplates__ = [];
  return state.data.__taskTemplates__;
}

async function addTaskTemplate(tmpl) {
  tmpl.id = uid();
  getTaskTemplates().push(tmpl);
  await saveAllStorage();
}

async function deleteTaskTemplate(id) {
  state.data.__taskTemplates__ = getTaskTemplates().filter(t => t.id !== id);
  await saveAllStorage();
}

async function saveTaskTemplate(tmpl) {
  const list = getTaskTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
}

/** Pre-fill the task entry form from a template */
function applyTemplate(id) {
  if (!id) return;
  const tmpl = getTaskTemplates().find(t => t.id === id);
  if (!tmpl) return;
  const nameEl = document.getElementById('task_name');
  if (nameEl && tmpl.name) nameEl.value = tmpl.name;
  const [l1, l2, l3] = parseActPath(tmpl.activityType || '');
  const l1el = document.getElementById('task_l1');
  if (l1el) l1el.value = l1;
  const l2el = document.getElementById('task_l2');
  if (l2el) l2el.value = l2;
  const l3el = document.getElementById('task_l3');
  if (l3el) l3el.value = l3;
  if (tmpl.defaultMinutes) { const el = document.getElementById('task_min'); if (el) el.value = tmpl.defaultMinutes; }
  if (tmpl.quantityUnit) { const el = document.getElementById('task_unit'); if (el) el.value = tmpl.quantityUnit; }
  if (tmpl.note) { const el = document.getElementById('task_note'); if (el) el.value = tmpl.note; }
}

// ── Template Management Tab ──────────────────────────────────
function renderTemplates() {
  const templates = getTaskTemplates();

  document.getElementById('tab-templates').innerHTML = `
    <div style="max-width:900px">

      <!-- 说明 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">📋 任务模板库</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.7;margin:0">
          在这里预定义常用任务模板，与活动类别三级联动绑定。<br>
          · 录入任务时可一键套用，自动填充类别、时长、单位等字段。<br>
          · <b>AI 录入（Step 2）会优先理解模板专属提示词</b>，再结合关键词和上下文决定是否套用；
          全部未命中时才回退到活动分类推断，若仍无法判断则在 note 中标注 <code>[待分类]</code>。
        </p>
      </div>

      <!-- 新建模板表单 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="cursor:pointer" onclick="tmplToggleForm()">
          <div class="card-title">＋ 新建模板</div>
          <span id="tmpl-form-toggle" style="font-size:12px;color:var(--muted)">▼ 展开</span>
        </div>
        <div id="tmpl-form-body" style="display:none;margin-top:14px">
          <div class="form-grid" style="grid-template-columns:1fr 1fr">
            <div class="form-group" style="grid-column:span 2">
              <label>模板名称 <span style="font-size:10px;color:var(--muted)">（可选，留空时 AI 根据原文命名）</span></label>
              <input type="text" id="tmpl_name" placeholder="留空则只套用活动类别等模板字段">
            </div>
          </div>

          <!-- 三级联动（模板：增强选择器） -->
          <div class="form-group">
            <label>绑定活动类别（可自由组合）</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
              <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:140px">
                <span style="font-size:10px;color:var(--muted)">一级</span>
                ${catSelectorHtml(1, 'tmpl_l1', '', 'tmpl_cat_msg')}
              </div>
              <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:140px">
                <span style="font-size:10px;color:var(--muted)">二级</span>
                ${catSelectorHtml(2, 'tmpl_l2', '', 'tmpl_cat_msg')}
              </div>
              <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:140px">
                <span style="font-size:10px;color:var(--muted)">三级</span>
                ${catSelectorHtml(3, 'tmpl_l3', '', 'tmpl_cat_msg')}
              </div>
            </div>
            <div style="margin-top:2px;font-size:11px;font-family:var(--mono)" id="tmpl_cat_msg"></div>
            <div class="form-hint" style="margin-top:2px">＋ 保存到库 · 🗑 从库删除（不影响已有模板/记录）</div>
          </div>

          <!-- 关键词 -->
          <div class="form-group">
            <label>AI 匹配关键词（逗号分隔）</label>
            <input type="text" id="tmpl_keywords"
              placeholder="例：英语,精读,reading,阅读,泛读">
            <div class="form-hint">AI 解析时会逐词比对任务描述；关键词越精准，匹配越准确</div>
          </div>

          <div class="form-group">
            <label>模板专属 AI 提示词</label>
            <textarea id="tmpl_ai_prompt" rows="4"
              placeholder="详细说明这个模板适用于什么、还可以套用哪些表达、哪些情况不要套用，以及需要特别注意的判断规则。"></textarea>
            <div class="form-hint">AI 选择模板时优先理解这里的说明，再结合关键词和整日上下文判断</div>
          </div>

          <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="form-group">
              <label>默认时长(分钟)</label>
              <input type="number" id="tmpl_minutes" min="1" placeholder="60">
            </div>
            <div class="form-group">
              <label>默认数量单位</label>
              ${unitSelectorHtml('tmpl_unit', '', 'tmpl_unit_msg')}
              <div style="font-size:11px;font-family:var(--mono)" id="tmpl_unit_msg"></div>
            </div>
            <div class="form-group">
              <label>备注模板</label>
              <input type="text" id="tmpl_note" placeholder="可选默认备注">
            </div>
          </div>

          <div style="display:flex;gap:8px">
            <button class="btn btn-success" onclick="tmplSaveNew()">✓ 保存模板</button>
            <button class="btn btn-ghost btn-sm" onclick="tmplToggleForm()">取消</button>
            <span id="tmpl-save-msg" style="font-size:12px;font-family:var(--mono);color:var(--pol)"></span>
          </div>
        </div>
      </div>

      <!-- 模板列表 -->
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">🗂 已保存的模板（${templates.length} 个）</div>
        ${templates.length === 0
      ? `<div class="empty-state"><p>暂无模板，点击上方「新建模板」开始添加</p></div>`
      : `<div style="display:grid;gap:10px">
              ${templates.map(t => tmplCardHtml(t)).join('')}
            </div>`
    }
      </div>

      <!-- ═══════════════════════════════════════════════ -->
      <!-- ⏱ 时段模板库 -->
      <!-- ═══════════════════════════════════════════════ -->
      ${renderSessionTemplatesSection()}

      <!-- 🗓 日期类型模板库 -->
      <!-- ═══════════════════════════════════════════════ -->
      ${renderDayTypeTemplatesSection()}
    </div>
  `;
}

// ── Session Template Section (rendered inside templates tab) ──
function renderSessionTemplatesSection() {
  const sTmpls = getSessionTemplates();
  return `
    <div style="margin-top:28px;border-top:2px solid var(--border);padding-top:20px">

      <!-- 说明 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">⏱ 特殊时段模板库</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.7;margin:0">
          预定义特殊的时段模板（如吃饭、活动、休息等非学习时段）。<br>
          · 特殊时段只有时钟时长（开始→结束的时间跨度），没有名义时长和实际专注。<br>
          · 录入时可一键套用，自动切换为特殊时段模式并填充名称和备注。<br>
          · <b>AI 录入（Step 2）会优先理解模板专属提示词</b>，再结合关键词和上下文决定是否采用模板名称。
        </p>
      </div>

      <!-- 新建时段模板表单 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="cursor:pointer" onclick="sessTmplToggleForm()">
          <div class="card-title">＋ 新建时段模板</div>
          <span id="sess-tmpl-form-toggle" style="font-size:12px;color:var(--muted)">▼ 展开</span>
        </div>
        <div id="sess-tmpl-form-body" style="display:none;margin-top:14px">
          <div class="form-grid" style="grid-template-columns:1fr 1fr">
            <div class="form-group" style="grid-column:span 2">
              <label>模板名称 <span style="font-size:10px;color:var(--muted)">（如"午饭"、"社团活动"、"午休"）</span></label>
              <input type="text" id="sess_tmpl_name" placeholder="例：午饭">
            </div>
          </div>

          <!-- 关键词 -->
          <div class="form-group">
            <label>AI 匹配关键词（逗号分隔）</label>
            <input type="text" id="sess_tmpl_keywords" placeholder="例：午饭,吃饭,午餐,lunch">
            <div class="form-hint">AI 解析时段时会逐词比对描述；关键词越精准，匹配越准确</div>
          </div>

          <div class="form-group">
            <label>模板专属 AI 提示词</label>
            <textarea id="sess_tmpl_ai_prompt" rows="4"
              placeholder="详细说明这个特殊时段适用于什么、还可以套用哪些表达、哪些情况不要套用，以及需要特别注意的判断规则。"></textarea>
            <div class="form-hint">AI 选择模板时优先理解这里的说明，再结合关键词和整日上下文判断</div>
          </div>


          <div class="form-group">
            <label>备注模板</label>
            <input type="text" id="sess_tmpl_note" placeholder="可选默认备注">
          </div>

          <div style="display:flex;gap:8px">
            <button class="btn btn-success" onclick="sessTmplSaveNew()">✓ 保存时段模板</button>
            <button class="btn btn-ghost btn-sm" onclick="sessTmplToggleForm()">取消</button>
            <span id="sess-tmpl-save-msg" style="font-size:12px;font-family:var(--mono);color:var(--pol)"></span>
          </div>
        </div>
      </div>

      <!-- 时段模板列表 -->
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">🗂 已保存的时段模板（${sTmpls.length} 个）</div>
        ${sTmpls.length === 0
      ? `<div class="empty-state"><p>暂无时段模板，点击上方「新建时段模板」开始添加</p></div>`
      : `<div style="display:grid;gap:10px">
            ${sTmpls.map(t => sessTmplCardHtml(t)).join('')}
          </div>`}
      </div>
    </div>`;
}

function sessTmplToggleForm() {
  const body = document.getElementById('sess-tmpl-form-body');
  const tog = document.getElementById('sess-tmpl-form-toggle');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  if (tog) tog.textContent = open ? '▲ 收起' : '▼ 展开';
}

async function sessTmplSaveNew() {
  const name = document.getElementById('sess_tmpl_name').value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  const kwRaw = document.getElementById('sess_tmpl_keywords').value;
  const keywords = kwRaw.split(/[,，]/).map(k => k.trim()).filter(Boolean);
  const tmpl = {
    name,
    keywords,
    aiPrompt: document.getElementById('sess_tmpl_ai_prompt').value.trim(),
    note: document.getElementById('sess_tmpl_note').value.trim(),
  };
  await addSessionTemplate(tmpl);
  const msg = document.getElementById('sess-tmpl-save-msg');
  if (msg) { msg.textContent = `✅ 已保存「${name}」`; setTimeout(() => msg.textContent = '', 2500); }
  renderTemplates();
}

function sessTmplCardHtml(t) {
  const kws = (t.keywords || []).join('、');
  return `
    <div id="sess-tmpl-card-${t.id}" style="border:1px solid var(--border);border-radius:8px;padding:12px;background:rgba(255,255,255,.015)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
        <div>
          <span style="font-weight:600;font-size:14px">⏱ ${escHtmlApp(t.name)}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="sessTmplStartEdit('${t.id}')">✏️ 编辑</button>
          <button class="btn btn-danger btn-sm" onclick="sessTmplDelete('${t.id}')">删除</button>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap">
        ${kws ? `<span>🔑 关键词：<span style="color:var(--text)">${escHtmlApp(kws)}</span></span>` : '<span style="color:var(--dim)">无关键词</span>'}
        ${t.note ? `<span>📝 ${escHtmlApp(t.note)}</span>` : ''}
      </div>
      ${t.aiPrompt ? `<div class="template-ai-prompt"><b>AI 提示词</b><span>${escHtmlApp(t.aiPrompt)}</span></div>` : ''}
      <div id="sess-tmpl-edit-${t.id}" style="display:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        ${sessTmplEditFormHtml(t)}
      </div>
    </div>`;
}

function sessTmplEditFormHtml(t) {
  return `
    <div class="form-group">
      <label>模板名称</label>
      <input type="text" id="sess-tmpl-edit-name-${t.id}" value="${escHtmlApp(t.name)}">
    </div>
    <div class="form-group">
      <label>关键词（逗号分隔）</label>
      <input type="text" id="sess-tmpl-edit-kw-${t.id}" value="${escHtmlApp((t.keywords || []).join(','))}">
    </div>
    <div class="form-group">
      <label>模板专属 AI 提示词</label>
      <textarea id="sess-tmpl-edit-ai-prompt-${t.id}" rows="4"
        placeholder="说明适用范围、可套用表达、排除情况和注意事项">${escHtmlApp(t.aiPrompt || '')}</textarea>
    </div>
    <div class="form-group">
      <label>备注模板</label>
      <input type="text" id="sess-tmpl-edit-note-${t.id}" value="${escHtmlApp(t.note || '')}">
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-success btn-sm" onclick="sessTmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="sessTmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

function sessTmplStartEdit(id) {
  document.getElementById(`sess-tmpl-edit-${id}`).style.display = 'block';
}
function sessTmplCancelEdit(id) {
  document.getElementById(`sess-tmpl-edit-${id}`).style.display = 'none';
}

async function sessTmplSaveEdit(id) {
  const name = document.getElementById(`sess-tmpl-edit-name-${id}`).value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  const kwRaw = document.getElementById(`sess-tmpl-edit-kw-${id}`).value;
  const keywords = kwRaw.split(/[,，]/).map(k => k.trim()).filter(Boolean);
  const tmpl = {
    id, name, keywords,
    aiPrompt: document.getElementById(`sess-tmpl-edit-ai-prompt-${id}`).value.trim(),
    note: document.getElementById(`sess-tmpl-edit-note-${id}`).value.trim(),
  };
  await saveSessionTemplate(tmpl);
  renderTemplates();
}

async function sessTmplDelete(id) {
  const tmpl = getSessionTemplates().find(t => t.id === id);
  if (!tmpl) return;
  if (!confirm(`删除时段模板「${tmpl.name}」？`)) return;
  await deleteSessionTemplate(id);
  renderTemplates();
}

function renderDayTypeTemplatesSection() {
  const templates = getDayTypeTemplates();
  return `
    <div style="margin-top:28px;border-top:2px solid var(--border);padding-top:20px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">🗓 日期类型模板库</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.7;margin:0">
          AI 在每日最终复查时阅读整日原文，选择至多一个日期类型。<br>
          · 专属 AI 提示词优先于关键词；不明确符合任何模板时允许不分类。<br>
          · 模板决定是否标记特殊天、是否不参与评分，结果先进入待审核草稿。
        </p>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="cursor:pointer" onclick="dayTypeTmplToggleForm()">
          <div class="card-title">＋ 新建日期类型模板</div>
          <span id="day-type-tmpl-form-toggle" style="font-size:12px;color:var(--muted)">▼ 展开</span>
        </div>
        <div id="day-type-tmpl-form-body" style="display:none;margin-top:14px">
          <div class="form-group">
            <label>类型名称</label>
            <input type="text" id="day_type_tmpl_name" placeholder="例：旅行日、生病休息日、考试日">
          </div>
          <div class="form-group">
            <label>AI 匹配关键词（逗号分隔）</label>
            <input type="text" id="day_type_tmpl_keywords" placeholder="例：旅行,出门,酒店,景点">
          </div>
          <div class="form-group">
            <label>模板专属 AI 提示词</label>
            <textarea id="day_type_tmpl_ai_prompt" rows="4"
              placeholder="说明怎样判断整天属于这个类型、可包含哪些场景、哪些情况不要归入，以及需要注意的上下文。"></textarea>
          </div>
          <div class="day-type-template-flags">
            <label class="ai-checkbox"><input type="checkbox" id="day_type_tmpl_special"> 标记为特殊天</label>
            <label class="ai-checkbox"><input type="checkbox" id="day_type_tmpl_exclude"> 不参与评分</label>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-success" onclick="dayTypeTmplSaveNew()">✓ 保存日期类型</button>
            <button class="btn btn-ghost btn-sm" onclick="dayTypeTmplToggleForm()">取消</button>
            <span id="day-type-tmpl-save-msg" style="font-size:12px;font-family:var(--mono);color:var(--pol)"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">🗂 已保存的日期类型（${templates.length} 个）</div>
        ${templates.length === 0
      ? '<div class="empty-state"><p>暂无日期类型模板</p></div>'
      : `<div style="display:grid;gap:10px">${templates.map(dayTypeTmplCardHtml).join('')}</div>`}
      </div>
    </div>`;
}

function dayTypeTmplToggleForm() {
  const body = document.getElementById('day-type-tmpl-form-body');
  const toggle = document.getElementById('day-type-tmpl-form-toggle');
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  if (toggle) toggle.textContent = open ? '▲ 收起' : '▼ 展开';
}

function readDayTypeTemplateForm(prefix) {
  const name = document.getElementById(`${prefix}name`)?.value.trim() || '';
  const keywords = (document.getElementById(`${prefix}keywords`)?.value || '')
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
  return {
    name,
    keywords,
    aiPrompt: document.getElementById(`${prefix}ai_prompt`)?.value.trim() || '',
    specialDay: Boolean(document.getElementById(`${prefix}special`)?.checked),
    excludeFromRating: Boolean(document.getElementById(`${prefix}exclude`)?.checked),
  };
}

async function dayTypeTmplSaveNew() {
  const tmpl = readDayTypeTemplateForm('day_type_tmpl_');
  if (!tmpl.name) {
    alert('请填写日期类型名称');
    return;
  }
  await addDayTypeTemplate(tmpl);
  const msg = document.getElementById('day-type-tmpl-save-msg');
  if (msg) {
    msg.textContent = `✅ 已保存「${tmpl.name}」`;
    setTimeout(() => { msg.textContent = ''; }, 2500);
  }
  renderTemplates();
}

function dayTypeTmplCardHtml(t) {
  const keywords = (t.keywords || []).join('、');
  return `
    <div id="day-type-tmpl-card-${t.id}" style="border:1px solid var(--border);border-radius:8px;padding:12px;background:rgba(255,255,255,.015)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <b>${escHtmlApp(t.name || '未命名类型')}</b>
          <span class="day-type-flag ${t.specialDay ? 'active' : ''}">特殊天：${t.specialDay ? '是' : '否'}</span>
          <span class="day-type-flag ${t.excludeFromRating ? 'active' : ''}">不评分：${t.excludeFromRating ? '是' : '否'}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="dayTypeTmplStartEdit('${t.id}')">✏️ 编辑</button>
          <button class="btn btn-danger btn-sm" onclick="dayTypeTmplDelete('${t.id}')">删除</button>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted)">
        ${keywords ? `🔑 关键词：<span style="color:var(--text)">${escHtmlApp(keywords)}</span>` : '<span style="color:var(--dim)">无关键词</span>'}
      </div>
      ${t.aiPrompt ? `<div class="template-ai-prompt"><b>AI 提示词</b><span>${escHtmlApp(t.aiPrompt)}</span></div>` : ''}
      <div id="day-type-tmpl-edit-${t.id}" style="display:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        ${dayTypeTmplEditFormHtml(t)}
      </div>
    </div>`;
}

function dayTypeTmplEditFormHtml(t) {
  return `
    <div class="form-group">
      <label>类型名称</label>
      <input type="text" id="day-type-tmpl-edit-${t.id}-name" value="${escHtmlApp(t.name || '')}">
    </div>
    <div class="form-group">
      <label>关键词（逗号分隔）</label>
      <input type="text" id="day-type-tmpl-edit-${t.id}-keywords" value="${escHtmlApp((t.keywords || []).join(','))}">
    </div>
    <div class="form-group">
      <label>模板专属 AI 提示词</label>
      <textarea id="day-type-tmpl-edit-${t.id}-ai_prompt" rows="4">${escHtmlApp(t.aiPrompt || '')}</textarea>
    </div>
    <div class="day-type-template-flags">
      <label class="ai-checkbox"><input type="checkbox" id="day-type-tmpl-edit-${t.id}-special" ${t.specialDay ? 'checked' : ''}> 标记为特殊天</label>
      <label class="ai-checkbox"><input type="checkbox" id="day-type-tmpl-edit-${t.id}-exclude" ${t.excludeFromRating ? 'checked' : ''}> 不参与评分</label>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-success btn-sm" onclick="dayTypeTmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="dayTypeTmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

function dayTypeTmplStartEdit(id) {
  const el = document.getElementById(`day-type-tmpl-edit-${id}`);
  if (el) el.style.display = 'block';
}

function dayTypeTmplCancelEdit(id) {
  const el = document.getElementById(`day-type-tmpl-edit-${id}`);
  if (el) el.style.display = 'none';
}

async function dayTypeTmplSaveEdit(id) {
  const tmpl = { id, ...readDayTypeTemplateForm(`day-type-tmpl-edit-${id}-`) };
  if (!tmpl.name) {
    alert('请填写日期类型名称');
    return;
  }
  await saveDayTypeTemplate(tmpl);
  renderTemplates();
}

async function dayTypeTmplDelete(id) {
  const tmpl = getDayTypeTemplates().find(item => item.id === id);
  if (!tmpl) return;
  if (!confirm(`删除日期类型模板「${tmpl.name}」？`)) return;
  await deleteDayTypeTemplate(id);
  renderTemplates();
}

function tmplCardHtml(t) {
  const actColor = getActColor(t.activityType || '');
  const kws = (t.keywords || []).join('、');
  return `
    <div id="tmpl-card-${t.id}" style="border:1px solid var(--border);border-radius:8px;padding:12px;background:rgba(255,255,255,.015)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
        <div>
          <span style="font-weight:600;font-size:14px">${t.name ? escHtmlApp(t.name) : '<span style="color:var(--muted);font-style:italic">未命名模板</span>'}</span>
          <span class="badge" style="margin-left:8px;background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">
            ${escHtmlApp(t.activityType || '—')}
          </span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="tmplStartEdit('${t.id}')">✏️ 编辑</button>
          <button class="btn btn-danger btn-sm" onclick="tmplDelete('${t.id}')">删除</button>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap">
        ${kws ? `<span>🔑 关键词：<span style="color:var(--text)">${escHtmlApp(kws)}</span></span>` : '<span style="color:var(--dim)">无关键词</span>'}
        ${t.defaultMinutes ? `<span>⏱ 默认 ${t.defaultMinutes} 分钟</span>` : ''}
        ${t.quantityUnit ? `<span>📏 单位：${escHtmlApp(t.quantityUnit)}</span>` : ''}
        ${t.note ? `<span>📝 备注：${escHtmlApp(t.note)}</span>` : ''}
      </div>
      ${t.aiPrompt ? `<div class="template-ai-prompt"><b>AI 提示词</b><span>${escHtmlApp(t.aiPrompt)}</span></div>` : ''}
      <!-- 编辑内嵌区 -->
      <div id="tmpl-edit-${t.id}" style="display:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        ${tmplEditFormHtml(t)}
      </div>
    </div>`;
}

function tmplEditFormHtml(t) {
  const [l1, l2, l3] = parseActPath(t.activityType || '');
  return `
    <div class="form-grid" style="grid-template-columns:1fr 1fr">
      <div class="form-group" style="grid-column:span 2">
        <label>模板名称</label>
        <input type="text" id="tmpl-edit-name-${t.id}" value="${escHtmlApp(t.name)}">
      </div>
    </div>
    <div class="form-group">
      <label>绑定活动类别（可自由组合）</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:120px">
          <span style="font-size:10px;color:var(--muted)">一级</span>
          ${catSelectorHtml(1, 'tmpl-edit-l1-' + t.id, l1, 'tmpl-edit-cat-msg-' + t.id)}
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:120px">
          <span style="font-size:10px;color:var(--muted)">二级</span>
          ${catSelectorHtml(2, 'tmpl-edit-l2-' + t.id, l2, 'tmpl-edit-cat-msg-' + t.id)}
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:120px">
          <span style="font-size:10px;color:var(--muted)">三级</span>
          ${catSelectorHtml(3, 'tmpl-edit-l3-' + t.id, l3, 'tmpl-edit-cat-msg-' + t.id)}
        </div>
      </div>
      <div style="margin-top:2px;font-size:11px;font-family:var(--mono)" id="tmpl-edit-cat-msg-${t.id}"></div>
      <div class="form-hint" style="margin-top:2px">＋ 保存到库 · 🗑 从库删除（不影响已有模板/记录）</div>
    </div>
    <div class="form-group">
      <label>关键词（逗号分隔）</label>
      <input type="text" id="tmpl-edit-kw-${t.id}" value="${escHtmlApp((t.keywords || []).join(','))}">
    </div>
    <div class="form-group">
      <label>模板专属 AI 提示词</label>
      <textarea id="tmpl-edit-ai-prompt-${t.id}" rows="4"
        placeholder="说明适用范围、可套用表达、排除情况和注意事项">${escHtmlApp(t.aiPrompt || '')}</textarea>
    </div>
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="form-group"><label>默认时长(分钟)</label>
        <input type="number" id="tmpl-edit-min-${t.id}" value="${t.defaultMinutes || ''}"></div>
      <div class="form-group"><label>数量单位</label>
        ${unitSelectorHtml('tmpl-edit-unit-' + t.id, t.quantityUnit || '', 'tmpl-edit-unit-msg-' + t.id)}
        <div style="font-size:11px;font-family:var(--mono)" id="tmpl-edit-unit-msg-${t.id}"></div></div>
      <div class="form-group"><label>备注模板</label>
        <input type="text" id="tmpl-edit-note-${t.id}" value="${escHtmlApp(t.note || '')}"></div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-success btn-sm" onclick="tmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="tmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

// ── Template helpers ──────────────────────────────────────────
function tmplToggleForm() {
  const body = document.getElementById('tmpl-form-body');
  const tog = document.getElementById('tmpl-form-toggle');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  if (tog) tog.textContent = open ? '▲ 收起' : '▼ 展开';
}

function _showCatMsg(msgId, text, color) {
  if (!msgId) return;
  const el = document.getElementById(msgId);
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

// Refresh all datalists and select elements in the current DOM after category changes
function _refreshAllDataLists() {
  const l1 = getLevel1Names();
  const l2 = getAllLevel2Names();
  const l3 = getAllLevel3Names();
  // Refresh datalists (for template pages that still use input+datalist)
  document.querySelectorAll('[id$="_l1_list"],[id*="-l1-list"]').forEach(dl => {
    dl.innerHTML = l1.map(a => `<option value="${a}">`).join('');
  });
  document.querySelectorAll('[id$="_l2_list"],[id*="-l2-list"]').forEach(dl => {
    dl.innerHTML = l2.map(a => `<option value="${a}">`).join('');
  });
  document.querySelectorAll('[id$="_l3_list"],[id*="-l3-list"]').forEach(dl => {
    dl.innerHTML = l3.map(a => `<option value="${a}">`).join('');
  });
  // Refresh select elements (for entry page)
  _refreshSelect('task_l1', l1);
  _refreshSelect('task_l2', l2);
  _refreshSelect('task_l3', l3);
}

function _refreshSelect(id, items) {
  const sel = document.getElementById(id);
  if (!sel || sel.tagName !== 'SELECT') return;
  const curVal = sel.value;
  sel.innerHTML = '<option value="">-- 选择 --</option>' + items.map(a => `<option value="${escHtmlApp(a)}">${escHtmlApp(a)}</option>`).join('');
  sel.value = curVal; // restore selection if still valid
}


async function tmplSaveNew() {
  let name = document.getElementById('tmpl_name').value.trim();
  const l1 = document.getElementById('tmpl_l1').value;
  const l2 = document.getElementById('tmpl_l2').value;
  const l3 = document.getElementById('tmpl_l3').value;
  const activityType = buildActPath(l1, l2, l3);
  const kwRaw = document.getElementById('tmpl_keywords').value;
  const keywords = kwRaw.split(/[,，]/).map(k => k.trim()).filter(Boolean);
  // 名称可选：留空即可，不自动生成
  const tmpl = {
    name,
    activityType,
    keywords,
    aiPrompt: document.getElementById('tmpl_ai_prompt').value.trim(),
    defaultMinutes: parseInt(document.getElementById('tmpl_minutes').value) || null,
    quantityUnit: document.getElementById('tmpl_unit').value.trim(),
    note: document.getElementById('tmpl_note').value.trim(),
  };
  await addTaskTemplate(tmpl);
  const msg = document.getElementById('tmpl-save-msg');
  if (msg) { msg.textContent = `✅ 已保存「${name}」`; setTimeout(() => msg.textContent = '', 2500); }
  renderTemplates();
  // auto-expand form stays closed after save
}

async function tmplDelete(id) {
  const tmpl = getTaskTemplates().find(t => t.id === id);
  if (!tmpl) return;
  if (!confirm(`删除模板「${tmpl.name}」？`)) return;
  await deleteTaskTemplate(id);
  renderTemplates();
}

function tmplStartEdit(id) {
  document.getElementById(`tmpl-edit-${id}`).style.display = 'block';
}
function tmplCancelEdit(id) {
  document.getElementById(`tmpl-edit-${id}`).style.display = 'none';
}

async function tmplSaveEdit(id) {
  const name = document.getElementById(`tmpl-edit-name-${id}`).value.trim();
  const l1 = document.getElementById(`tmpl-edit-l1-${id}`).value;
  const l2 = document.getElementById(`tmpl-edit-l2-${id}`).value;
  const l3 = document.getElementById(`tmpl-edit-l3-${id}`).value;
  const kwRaw = document.getElementById(`tmpl-edit-kw-${id}`).value;
  const keywords = kwRaw.split(/[,，]/).map(k => k.trim()).filter(Boolean);
  const tmpl = {
    id,
    name,
    activityType: buildActPath(l1, l2, l3),
    keywords,
    aiPrompt: document.getElementById(`tmpl-edit-ai-prompt-${id}`).value.trim(),
    defaultMinutes: parseInt(document.getElementById(`tmpl-edit-min-${id}`).value) || null,
    quantityUnit: document.getElementById(`tmpl-edit-unit-${id}`).value.trim(),
    note: document.getElementById(`tmpl-edit-note-${id}`).value.trim(),
  };
  await saveTaskTemplate(tmpl);
  renderTemplates();
}

/** Escape HTML for use in app.js (avoids dependency on ai_module escHtml) */
function escHtmlApp(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// ENHANCED CATEGORY SELECTOR COMPONENT
// ============================================================
/**
 * 生成增强型分类选择器 HTML
 * @param {number} level - 分类级别 (1/2/3)
 * @param {string} inputId - 输入框 ID
 * @param {string} currentValue - 当前值
 * @param {string} msgId - 消息提示 ID
 * @returns {string} HTML
 */
function catSelectorHtml(level, inputId, currentValue, msgId) {
  const labels = { 1: '一级', 2: '二级', 3: '三级' };
  return `
    <div class="cat-selector" id="${inputId}_wrap">
      <div class="cat-selector-input-row">
        <div class="cat-selector-field" style="position:relative;flex:1">
          <input type="text" id="${inputId}" value="${escHtmlApp(currentValue || '')}"
            placeholder="输入搜索或新建${labels[level]}类别"
            autocomplete="off"
            onfocus="catSelOpen('${inputId}',${level})"
            oninput="catSelFilter('${inputId}',${level})"
            style="width:100%;box-sizing:border-box">
          <div class="cat-sel-dropdown" id="${inputId}_dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
            max-height:200px;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;
            box-shadow:0 8px 24px rgba(0,0,0,.3)">
          </div>
        </div>
        <button class="btn btn-success btn-sm" onclick="catSelSave(${level},'${inputId}','${msgId}')" title="保存到类别库" style="min-width:32px">＋</button>
        <button class="btn btn-ghost btn-sm" onclick="catSelDelete(${level},'${inputId}','${msgId}')" title="从类别库删除" style="color:var(--red);min-width:32px">🗑</button>
      </div>
    </div>`;
}

/** 打开下拉列表 */
function catSelOpen(inputId, level) {
  catSelFilter(inputId, level);
  const dd = document.getElementById(inputId + '_dd');
  if (dd) dd.style.display = 'block';
  // 点击外部关闭
  setTimeout(() => {
    const close = (e) => {
      const wrap = document.getElementById(inputId + '_wrap');
      if (wrap && !wrap.contains(e.target)) {
        dd.style.display = 'none';
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

/** 过滤下拉列表 */
function catSelFilter(inputId, level) {
  const input = document.getElementById(inputId);
  const dd = document.getElementById(inputId + '_dd');
  if (!input || !dd) return;
  const query = input.value.trim().toLowerCase();
  const items = getCatList(level);
  const filtered = query ? items.filter(it => it.toLowerCase().includes(query)) : items;
  const exactMatch = items.some(it => it.toLowerCase() === query);

  let html = '';
  if (filtered.length === 0 && !query) {
    html = '<div style="padding:8px 12px;font-size:11px;color:var(--dim)">暂无类别，输入名称后点 ＋ 添加</div>';
  } else {
    filtered.forEach(it => {
      const isSelected = it === input.value;
      html += `<div class="cat-sel-item" style="padding:6px 12px;cursor:pointer;font-size:12px;
        ${isSelected ? 'background:rgba(105,240,174,.1);color:var(--pol);font-weight:600' : 'color:var(--text)'};"
        onmousedown="catSelPick('${inputId}','${escHtmlApp(it)}')"
        onmouseenter="this.style.background='rgba(79,195,247,.1)'"
        onmouseleave="this.style.background='${isSelected ? 'rgba(105,240,174,.1)' : ''}'">
        ${escHtmlApp(it)}
      </div>`;
    });
    if (query && !exactMatch) {
      html += `<div style="padding:6px 12px;font-size:11px;color:var(--pol);border-top:1px solid var(--border);cursor:pointer"
        onmousedown="catSelPick('${inputId}','${escHtmlApp(query)}')"
        onmouseenter="this.style.background='rgba(105,240,174,.08)'"
        onmouseleave="this.style.background=''">
        ＋ 新建「${escHtmlApp(query)}」
      </div>`;
    }
  }
  dd.innerHTML = html;
  dd.style.display = 'block';
}

/** 选中某项 */
function catSelPick(inputId, value) {
  const input = document.getElementById(inputId);
  if (input) input.value = value;
  const dd = document.getElementById(inputId + '_dd');
  if (dd) dd.style.display = 'none';
}

/** 保存分类 */
async function catSelSave(level, inputId, msgId) {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  if (!name) { _showCatMsg(msgId, '⚠️ 请先输入名称', 'var(--red)'); return; }
  const list = getCatList(level);
  if (list.includes(name)) { _showCatMsg(msgId, `「${name}」已存在`, 'var(--muted)'); return; }
  await addCatItem(level, name);
  _showCatMsg(msgId, `✅ 已保存「${name}」`, 'var(--pol)');
  _refreshAllDataLists();
}

/** 删除分类 */
async function catSelDelete(level, inputId, msgId) {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  const labels = { 1: '一级', 2: '二级', 3: '三级' };
  if (!name) { _showCatMsg(msgId, `⚠️ 请先输入或选择要删除的类别`, 'var(--red)'); return; }
  if (!getCatList(level).includes(name)) { _showCatMsg(msgId, `「${name}」不在类别库中`, 'var(--muted)'); return; }
  if (!confirm(`确定从类别库中删除${labels[level]}「${name}」？`)) return;
  await deleteCatItem(level, name);
  if (el) el.value = '';
  _showCatMsg(msgId, `🗑️ 已删除「${name}」`, 'var(--muted)');
  _refreshAllDataLists();
}

/** 从增强选择器获取值 */
function catSelValue(inputId) {
  const el = document.getElementById(inputId);
  return (el?.value || '').trim();
}

// Color palette for activity types (cycles by L1)
const ACT_COLORS = [
  { color: '#69f0ae', cls: 'pol' },
  { color: '#4fc3f7', cls: 'hp' },
  { color: '#ce93d8', cls: 'word' },
  { color: '#ffb74d', cls: 'thesis' },
  { color: '#ef9a9a', cls: 'code' },
  { color: '#78909c', cls: 'other' },
  { color: '#80deea', cls: 'clock' },
  { color: '#b388ff', cls: 'sleep' },
  { color: '#ffd54f', cls: 'wake' },
];

function getActColor(actName) {
  const l1 = getActL1(actName);
  const types = getLevel1Names();
  const idx = types.indexOf(l1);
  if (idx >= 0) return ACT_COLORS[idx % ACT_COLORS.length];
  return ACT_COLORS[5]; // default grey
}

// ============================================================
// DATA HELPERS
// ============================================================
function getDay(dateStr) {
  if (!state.data[dateStr])
    state.data[dateStr] = { wakeTime: '', sleepTime: '', sessions: [], tasks: [] };
  return state.data[dateStr];
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function computeDay(dateStr) {
  const day = getDay(dateStr);
  const sessions = day.sessions || [], tasks = day.tasks || [];
  let clockMin = 0, trackedSpanMin = 0, studyClockMin = 0, normalClockMin = 0, nominalMin = 0, actualMin = 0;
  let specialMin = 0, specialStudyClockMin = 0, specialStudyActualMin = 0, unavailableMin = 0, restMin = 0, distractMin = 0;
  sessions.forEach(s => {
    const clk = sessionClock(s);
    const actual = Number(s.actualMinutes) || 0;
    const rest = Number(s.restMinutes) || 0;
    trackedSpanMin += clk;
    clockMin += clk;
    if (isUnavailableSession(s)) {
      specialMin += clk;
      unavailableMin += clk;
      return;
    }
    if (isSpecialStudySession(s)) {
      specialStudyClockMin += clk;
      specialStudyActualMin += actual;
      studyClockMin += actual;
      actualMin += actual;
      unavailableMin += Math.max(0, clk - actual);
      return;
    }
    studyClockMin += clk;
    normalClockMin += clk;
    nominalMin += Number(s.nominalMinutes) || 0;
    actualMin += actual;
    restMin += rest;
    distractMin += Math.max(0, clk - actual - rest);
  });
  const taskMin = tasks.reduce((s, t) => s + (Number(t.minutes) || 0), 0);
  const wakeMin = parseMin(day.wakeTime), sleepMin = parseMin(day.sleepTime);
  let awakeMin = null;
  if (wakeMin != null && sleepMin != null) {
    // 修正12小时制输入：如果睡觉时间为12:00-12:59，视为00:00-00:59（次日凌晨）
    let adjSleepMin = sleepMin;
    if (adjSleepMin >= 720 && adjSleepMin < 780) adjSleepMin -= 720;
    awakeMin = adjSleepMin - wakeMin;
    if (awakeMin <= 0) awakeMin += 1440;
  }
  // 可支配时长 = 清醒时长 − 完全不可用时间。
  // 特殊学习时段只扣除其中未学习的部分，保留实际学习片段。
  const disposableMin = awakeMin != null ? Math.max(0, awakeMin - unavailableMin) : null;
  const utilPct = (disposableMin != null && disposableMin > 0 && actualMin)
    ? Math.round(actualMin / disposableMin * 100)
    : null;
  const clockVsNominal = nominalMin > 0 ? Math.round((studyClockMin - nominalMin) / nominalMin * 100) : null;
  const actualVsNominal = nominalMin > 0 ? Math.round((actualMin - nominalMin) / nominalMin * 100) : null;
  const effectiveClockMin = Math.max(0, normalClockMin - restMin + specialStudyActualMin);
  const focusEfficiency = effectiveClockMin > 0 ? Math.round(actualMin / effectiveClockMin * 100) : null;
  const actMin = {};
  tasks.forEach(t => {
    const act = t.activityType || '未分类';
    actMin[act] = (actMin[act] || 0) + (Number(t.minutes) || 0);
  });
  return {
    clockMin, trackedSpanMin, studyClockMin, normalClockMin, effectiveClockMin, nominalMin, actualMin, restMin, distractMin,
    taskMin, awakeMin, specialMin, specialStudyClockMin, specialStudyActualMin, unavailableMin,
    disposableMin, utilPct, clockVsNominal, actualVsNominal, focusEfficiency, actMin, sessions, tasks
  };
}

function computeRange(dateStrs) {
  const days = dateStrs.map(d => ({ dateStr: d, ...computeDay(d) }));
  const daysWithData = days.filter(d => d.clockMin > 0 || d.actualMin > 0 || d.taskMin > 0);
  const n = daysWithData.length || 1;
  const totals = {
    clockMin: days.reduce((s, d) => s + d.clockMin, 0),
    studyClockMin: days.reduce((s, d) => s + d.studyClockMin, 0),
    nominalMin: days.reduce((s, d) => s + d.nominalMin, 0),
    actualMin: days.reduce((s, d) => s + d.actualMin, 0),
    restMin: days.reduce((s, d) => s + d.restMin, 0),
    unavailableMin: days.reduce((s, d) => s + d.unavailableMin, 0),
    specialStudyActualMin: days.reduce((s, d) => s + d.specialStudyActualMin, 0),
    taskMin: days.reduce((s, d) => s + d.taskMin, 0),
    daysWithData: daysWithData.length,
  };
  totals.effectiveClockMin = days.reduce((s, d) => s + d.effectiveClockMin, 0);
  totals.distractMin = days.reduce((s, d) => s + d.distractMin, 0);
  totals.clockVsNominal = totals.nominalMin > 0 ? Math.round((totals.studyClockMin - totals.nominalMin) / totals.nominalMin * 100) : null;
  totals.actualVsNominal = totals.nominalMin > 0 ? Math.round((totals.actualMin - totals.nominalMin) / totals.nominalMin * 100) : null;
  totals.focusEfficiency = totals.effectiveClockMin > 0 ? Math.round(totals.actualMin / totals.effectiveClockMin * 100) : null;
  // 日均
  totals.avgClock = Math.round(totals.clockMin / n);
  totals.avgEffClock = Math.round(totals.effectiveClockMin / n);
  totals.avgNominal = Math.round(totals.nominalMin / n);
  totals.avgActual = Math.round(totals.actualMin / n);
  totals.avgRest = Math.round(totals.restMin / n);
  totals.avgTask = Math.round(totals.taskMin / n);
  return { days, totals };
}

function getAllDates() {
  return Object.keys(state.data).filter(k => {
    if (k.startsWith('__')) return false;
    const d = state.data[k];
    return (d.sessions && d.sessions.length > 0) || (d.tasks && d.tasks.length > 0) || d.wakeTime;
  }).sort();
}

// ============================================================
// CHART UTILITIES
// ============================================================
const GRID_COLOR = 'rgba(30,36,56,1)';
const gridCfg = { color: GRID_COLOR };

function destroyChart(id) { if (chartReg[id]) { chartReg[id].destroy(); delete chartReg[id]; } }
function destroyAll() { Object.keys(chartReg).forEach(destroyChart); }
function mkChart(id, cfg) {
  destroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  chartReg[id] = new Chart(el, cfg);
  return chartReg[id];
}
function chartDefaults() {
  Chart.defaults.color = '#6b7a9e';
  Chart.defaults.borderColor = GRID_COLOR;
  Chart.defaults.font.family = "'Noto Sans SC', sans-serif";
}

// ============================================================
// GLOBAL HEADER / STATS BAR
// ============================================================
function renderHeader() {
  const dates = getAllDates();
  if (dates.length === 0) {
    document.getElementById('statsGrid').innerHTML = '';
    document.getElementById('headerPeriod').textContent = '暂无数据';
    return;
  }
  const all = computeRange(dates);
  const t = all.totals;
  const today = getTodayStr();
  const todayStats = computeDay(today);

  document.getElementById('headerPeriod').textContent =
    `${formatShort(dates[0])} — ${formatShort(dates[dates.length - 1])}`;

  const cards = [
    { label: '记录天数', value: dates.length, unit: '天', sub: '有数据', color: 'var(--hp)' },
    { label: `今日·时钟${tipIcon('clock')}`, value: fmtHrs(todayStats.clockMin), unit: '', sub: `有效${fmtMin(todayStats.effectiveClockMin)} · 休息${fmtMin(todayStats.restMin)}`, color: 'var(--clock)' },
    { label: `今日·名义${tipIcon('nominal')}`, value: fmtHrs(todayStats.nominalMin), unit: '', sub: '今日名义时长', color: 'var(--nominal)' },
    { label: `今日·实际${tipIcon('actual')}`, value: fmtHrs(todayStats.actualMin), unit: '', sub: '今日实际专注', color: 'var(--actual)' },
    { label: `总·实际专注${tipIcon('actual')}`, value: fmtHrs(t.actualMin), unit: '', sub: '所有记录日', color: 'var(--pol)' },
    { label: `总·时钟${tipIcon('clock')}`, value: fmtHrs(t.clockMin), unit: '', sub: `有效${fmtHrs(t.effectiveClockMin)} · 休息${fmtHrs(t.restMin)}`, color: 'var(--clock)' },
    {
      label: `今日利用率${tipIcon('util')}`, value: todayStats.utilPct != null ? todayStats.utilPct + '%' : '-', unit: '', sub: `实际/可支配时长${todayStats.disposableMin != null ? ' (' + fmtMin(todayStats.disposableMin) + ')' : ''}`,
      color: todayStats.utilPct >= 50 ? 'var(--green)' : 'var(--red)'
    },
  ];

  document.getElementById('statsGrid').innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value" style="color:${c.color}">${c.value}<span class="stat-unit">${c.unit}</span></div>
      <div class="stat-sub">${c.sub}</div>
    </div>
  `).join('');
}

// ============================================================
// TAB SWITCHING
// ============================================================
function showTab(id) {
  destroyAll();
  state.tab = id;
  document.querySelectorAll('.tab').forEach((t, i) => {
    const ids = ['entry', 'calendar', 'day', 'week', 'month', 'stacked', 'sessAnalysis', 'taskAnalysis', 'sleep', 'export', 'templates'];
    t.classList.toggle('active', ids[i] === id);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'tab-' + id);
  });
  const renders = {
    entry: renderEntry, calendar: renderCalendar, day: renderDayOverview,
    week: renderWeekOverview, month: renderMonthOverview, stacked: renderStackedArea,
    sessAnalysis: renderSessAnalysis, taskAnalysis: renderTaskAnalysis,
    sleep: renderSleep,
    export: renderExport, templates: renderTemplates
  };
  if (renders[id]) renders[id]();
  renderHeader();
}

// ============================================================
// ENTRY TAB
// ============================================================
function renderEntry() {
  const dateStr = state.selectedDate;
  const day = getDay(dateStr);
  const stats = computeDay(dateStr);
  const sessions = day.sessions || [];
  const tasks = day.tasks || [];

  document.getElementById('tab-entry').innerHTML = `
    <div class="date-nav">
      <button class="btn btn-ghost btn-sm" onclick="changeDate(-1)">← 前一天</button>
      <span class="date-display">${formatDisplay(dateStr)}</span>
      <button class="btn btn-ghost btn-sm" onclick="changeDate(1)">后一天 →</button>
      <input type="date" value="${dateStr}" onchange="jumpDate(this.value)" style="margin-left:8px">
      <button class="btn btn-ghost btn-sm" onclick="jumpDate('${getTodayStr()}')">今天</button>
    </div>

    <div class="three-time">
      <div class="time-block clock"><div class="label">⏱ 时钟时长${tipIcon('clock')}</div><div class="value">${fmtMin(stats.clockMin, true)}</div><div class="sub">有效${tipIcon('effectiveClock')} ${fmtMin(stats.effectiveClockMin)} · 休息 ${fmtMin(stats.restMin)}</div></div>
      <div class="time-block nominal"><div class="label">📋 名义时长${tipIcon('nominal')}</div><div class="value">${fmtMin(stats.nominalMin, true)}</div><div class="sub">计划专注时长 <span class="c-muted">${devStr(stats.clockVsNominal)}</span></div></div>
      <div class="time-block actual"><div class="label">✅ 实际专注${tipIcon('actual')}</div><div class="value">${fmtMin(stats.actualMin, true)}</div><div class="sub">真实专注 <span class="${devClass(stats.actualVsNominal)}">${devStr(stats.actualVsNominal)}</span></div></div>
    </div>

    <!-- ☀️ WAKE TIME (top) -->
    <div class="card entry-wake-card">
      <div class="card-header"><div><div class="card-title">☀️ 起床时间</div></div></div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${timeInputHtml('wakeInput', day.wakeTime || '')}
        <button class="btn btn-success btn-sm" onclick="saveSleep('${dateStr}')">保存</button>
        ${day.wakeTime ? `<span class="fw-mono" style="font-size:12px;color:var(--wake)">${day.wakeTime}</span>` : ''}
      </div>
    </div>

    <!-- 🏷️ SPECIAL DAY -->
    <div class="card" style="margin-bottom:0;${day.specialDay ? 'border-color:rgba(255,183,77,.4);background:rgba(255,183,77,.04)' : ''}">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">
          日期类型
          <input id="dayTypeInput" list="dayTypeOptions" value="${escHtmlApp(day.dayType || '')}"
            placeholder="可选" onchange="applyDayTypeTemplateToEntry(this.value)"
            style="min-width:140px;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:5px">
          <datalist id="dayTypeOptions">
            ${getDayTypeTemplates().map(t => `<option value="${escHtmlApp(t.name || '')}">`).join('')}
          </datalist>
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;user-select:none">
          <input type="checkbox" id="specialDayCheck" ${day.specialDay ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--thesis);cursor:pointer">
          <span style="color:${day.specialDay ? 'var(--thesis)' : 'var(--muted)'}">🏷️ 标记为特殊天</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--muted)">
          <input type="checkbox" id="excludeFromRatingCheck" ${day.excludeFromRating ? 'checked' : ''} style="accent-color:var(--thesis)">
          不参与评分
        </label>
        <span style="font-size:11px;color:var(--dim)">特殊日仍可记录学习内容；是否参与评分单独控制</span>
      </div>
      <div id="specialDayReasonWrap" style="margin-top:${day.specialDay ? '10' : '0'}px;display:${day.specialDay ? 'block' : 'none'}">
        <input type="text" id="specialDayReason" value="${escHtmlApp(day.specialDayReason || '')}" placeholder="原因（可选，如：出门办事、旅行、生病…）"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:12px">
      </div>
      <script>document.getElementById('specialDayCheck')?.addEventListener('change',function(){var w=document.getElementById('specialDayReasonWrap');w.style.display=this.checked?'block':'none';w.style.marginTop=this.checked?'10px':'0';})<\/script>
    </div>

    <!-- 📝 DAY NOTE -->
    <div class="card" style="margin-bottom:0">
      <div class="card-header"><div><div class="card-title">📝 今日备注</div><div class="card-sub">对一整天的总结、感受、计划等</div></div></div>
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <textarea id="dayNoteInput" placeholder="可选：记���今天的整体感受、总结或备忘…"
          style="flex:1;min-height:60px;resize:vertical;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px;font-size:12px;line-height:1.6;font-family:var(--mono);box-sizing:border-box"
        >${escHtmlApp(day.dayNote || '')}</textarea>
        <button class="btn btn-success btn-sm" onclick="saveDayNote('${dateStr}')">保存</button>
      </div>
    </div>

    <!-- ⏱ SESSIONS TABLE -->
    <div class="card entry-table-card">
      <div class="card-header">
        <div><div class="card-title">⏱ 专注时段${state._editingSessionId ? ' <span style="color:var(--wake);font-size:12px">✏️ 编辑中</span>' : ''}</div><div class="card-sub">记录时钟/名义/实际三维时间</div></div>
        <button class="btn btn-primary btn-sm" onclick="state._editingSessionId=null;toggleForm('sessionForm')">+ 添加时段</button>
      </div>
      <div class="form-panel" id="sessionForm">
        <!-- 时段类型切换 -->
        <div class="form-group" style="margin-bottom:12px">
          <label>时段类型</label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" id="sessTypeNormal" onclick="switchSessionType('normal')" style="background:var(--pol);color:#000;font-weight:600">📋 普通时段</button>
            <button class="btn btn-ghost btn-sm" id="sessTypeSpecial" onclick="switchSessionType('special')">⏱ 不可用时段</button>
            <button class="btn btn-ghost btn-sm" id="sessTypeSpecialStudy" onclick="switchSessionType('special-study')">🧩 特殊学习时段</button>
          </div>
          <div class="form-hint">普通时段：连续专注 · 不可用时段：吃饭、午睡、通勤等完全无法学习 · 特殊学习时段：长时间外出，但其中包含零散学习</div>
        </div>
        <!-- 特殊时段名称（仅特殊时段显示） -->
        <div class="form-group" id="sessNameGroup" style="display:none;margin-bottom:10px">
          <label>时段名称 <span style="color:var(--red)">*</span> <span style="font-size:10px;color:var(--muted)">（如“午饭”、“回学校”、“外出上课”）</span></label>
          <input type="text" id="sess_name" placeholder="输入时段名称">
        </div>
        <!-- 套用时段模板 -->
        ${(function () {
      const sTmpls = getSessionTemplates();
      if (!sTmpls.length) return `<div class="form-group" style="margin-bottom:10px">
            <label>⏱ 套用时段模板 <span style="font-size:10px;color:var(--muted)">（<a href="#" onclick="showTab('templates');return false" style="color:var(--hp)">前往模板库</a>添加后可快速填充）</span></label>
            <span style="font-size:11px;color:var(--dim)">暂无时段模板</span>
          </div>`;
      return `<div class="form-group" style="margin-bottom:10px">
            <label>⏱ 套用时段模板 <span style="font-size:10px;color:var(--muted)">（选择后自动切换为特殊时段并填充名称/备注）</span></label>
            <div style="display:flex;gap:8px;align-items:center">
              <select onchange="applySessionTemplate(this.value)" style="flex:1">
                <option value="">-- 不套用 --</option>
                ${sTmpls.map(t => `<option value="${t.id}">⏱ ${escHtmlApp(t.name)}</option>`).join('')}
              </select>
              <a href="#" onclick="showTab('templates');return false" class="btn btn-ghost btn-sm" style="white-space:nowrap">管理模板</a>
            </div>
          </div>`;
    })()}
        <div class="form-grid">
          <div class="form-group"><label>开始时间</label>${timeInputHtml('sess_start', '')}</div>
          <div class="form-group"><label>结束时间</label>${timeInputHtml('sess_end', '')}</div>
          <div class="form-group" id="sessNominalGroup"><label>名义时长(分钟)${tipIcon('nominal')}</label><input type="number" id="sess_nominal" min="1"><div class="form-hint">计划专注多少分钟</div></div>
          <div class="form-group" id="sessActualGroup"><label>实际专注(分钟)${tipIcon('actual')}</label><input type="number" id="sess_actual" min="1"><div class="form-hint">真正专注的分钟数</div></div>
          <div class="form-group" id="sessRestGroup"><label>休息时间(分钟)${tipIcon('rest')}</label><input type="number" id="sess_rest" min="0"><div class="form-hint">该时段内的计划休息时长</div></div>
          <div class="form-group" style="grid-column:span 2"><label>备注</label><input type="text" id="sess_note" placeholder="可选备注"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-success" id="sessFormSaveBtn" onclick="saveSession('${dateStr}')">${state._editingSessionId ? '✓ 更新时段' : '✓ 保存时段'}</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelSessionForm()">${state._editingSessionId ? '取消编辑' : '取消'}</button>
        </div>
      </div>
      ${sessions.length === 0
      ? '<div class="empty-state"><p>暂无时段记录</p></div>'
      : `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>开始</th><th>结束</th><th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th><th>休息${tipIcon('rest')}</th><th>专注率${tipIcon('sessRate')}</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${sessions.map((s, i) => {
        const cl = sessionClock(s);
        const isSpec = isUnavailableSession(s);
        const isSpecialStudy = isSpecialStudySession(s);
        const typeMeta = sessionTypeMeta(s);
        const rest = Number(s.restMinutes) || 0;
        const eff = (!isSpec && !isSpecialStudy && (cl - rest) > 0) ? Math.round((Number(s.actualMinutes) || 0) / (cl - rest) * 100) : null;
        const isEditing = state._editingSessionId === s.id;
        return `<tr${isEditing ? ' style="background:rgba(255,213,79,.1);outline:1px solid rgba(255,213,79,.3)"' : typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}>
          <td class="fw-mono c-muted">${i + 1}${typeMeta.short ? `<br><span style="font-size:9px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 4px;border-radius:3px">${typeMeta.short}</span>` : ''}</td>
          <td class="fw-mono">${s.type !== 'normal' && s.name ? `<span style="color:${typeMeta.color};font-weight:600">${escHtmlApp(s.name)}</span><br>` : ''}${s.startTime || '-'}</td><td class="fw-mono">${s.endTime || '-'}</td>
          <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
          <td class="fw-mono c-nominal">${isSpec || isSpecialStudy ? '<span class="c-muted">-</span>' : fmtMin(Number(s.nominalMinutes) || 0, true)}</td>
          <td class="fw-mono c-actual">${isSpec ? '<span class="c-muted">-</span>' : fmtMin(Number(s.actualMinutes) || 0, true)}</td>
          <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
          <td class="fw-mono ${eff >= 80 ? 'c-green' : eff >= 60 ? 'c-wake' : eff != null ? 'c-red' : ''}">${eff != null ? eff + '%' : '-'}</td>
          <td class="c-muted" style="font-size:11px">${s.note || ''}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editSession('${dateStr}','${s.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="deleteSession('${dateStr}','${s.id}')">删除</button></td>
        </tr>`;
      }).join('')}</tbody>
          <tfoot><tr><td colspan="3">合计</td><td class="c-clock">${fmtMin(stats.clockMin, true)}</td><td class="c-nominal">${fmtMin(stats.nominalMin, true)}</td><td class="c-actual">${fmtMin(stats.actualMin, true)}</td><td>${fmtMin(stats.restMin, true)}</td><td class="${devClass(stats.actualVsNominal)}">${devStr(stats.actualVsNominal)}</td><td></td><td></td></tr></tfoot>
        </table></div>`}
    </div>

    <!-- 📝 TASKS TABLE -->
    <div class="card entry-table-card">
      <div class="card-header">
        <div><div class="card-title">📝 任务记录${state._editingTaskId ? ' <span style="color:var(--wake);font-size:12px">✏️ 编辑中</span>' : ''}</div><div class="card-sub">每项具体学习内容 · 效率自动计算</div></div>
        <button class="btn btn-primary btn-sm" onclick="state._editingTaskId=null;toggleForm('taskForm')">+ 添加任务</button>
      </div>
      <div class="form-panel" id="taskForm">
        <div class="task-form-grid">
          <div class="form-group full-row"><label>任务名称</label><input type="text" id="task_name" placeholder="任务名称"></div>

          <!-- 套用模板 -->
          ${(function () {
      const tmpls = getTaskTemplates();
      if (!tmpls.length) return `<div class="form-group full-row">
              <label>🗂 套用模板 <span style="font-size:10px;color:var(--muted)">（<a href="#" onclick="showTab('templates');return false" style="color:var(--hp)">前往模板库</a>添加模板后可快速填充）</span></label>
              <span style="font-size:11px;color:var(--dim)">暂无模板</span>
            </div>`;
      return `<div class="form-group full-row">
              <label>🗂 套用模板 <span style="font-size:10px;color:var(--muted)">（选择后自动填充类别/时长/单位）</span></label>
              <div style="display:flex;gap:8px;align-items:center">
                <select id="task_tmpl" onchange="applyTemplate(this.value)" style="flex:1">
                  <option value="">-- 不套用 --</option>
                  ${tmpls.map(t => `<option value="${t.id}">${escHtmlApp(t.name)}${t.activityType ? ' (' + escHtmlApp(t.activityType) + ')' : ''}</option>`).join('')}
                </select>
                <a href="#" onclick="showTab('templates');return false" class="btn btn-ghost btn-sm" style="white-space:nowrap">管理模板库</a>
              </div>
            </div>`;
    })()}

          <div class="form-group full-row">
            <label>活动类别（三级）</label>
            <div class="cat-three-cols">
              <div class="cat-col">
                <span class="cat-col-label">一级类别</span>
                ${catSelectorHtml(1, 'task_l1', '', 'entry_cat_msg')}
              </div>
              <div class="cat-col">
                <span class="cat-col-label">二级类别</span>
                ${catSelectorHtml(2, 'task_l2', '', 'entry_cat_msg')}
              </div>
              <div class="cat-col">
                <span class="cat-col-label">三级类别</span>
                ${catSelectorHtml(3, 'task_l3', '', 'entry_cat_msg')}
              </div>
            </div>
            <div style="margin-top:6px;font-size:11px;font-family:var(--mono)" id="entry_cat_msg"></div>
            <div class="form-hint" style="margin-top:2px">＋ 保存到库 · 🗑 从库删除（不影响已有记录）· 输入可搜索过滤</div>
          </div>

          <div class="form-group"><label>时长(分钟)</label><input type="number" id="task_min" min="1" oninput="autoCalcRate()"></div>
          <div class="form-group"><label>数量(可选)</label><input type="number" id="task_qty" oninput="autoCalcRate()"></div>
          <div class="form-group"><label>数量单位</label>${unitSelectorHtml('task_unit', '', 'entry_unit_msg')}<div style="font-size:11px;font-family:var(--mono)" id="entry_unit_msg"></div></div>
          <div class="form-group"><label>效率(自动计算)</label><input type="text" id="task_rate" readonly style="background:var(--card);color:var(--muted)"><div class="form-hint">数量÷时长 自动算</div></div>
          <div class="form-group"><label>正确率%(可选)</label><input type="number" id="task_acc" min="0" max="100"></div>
          <div class="form-group full-row"><label>备注</label><input type="text" id="task_note" placeholder="可选备注"></div>
        </div>
        <datalist id="unitList"><option value="个"><option value="个单词"><option value="道题"><option value="页"><option value="行"></datalist>
        <div style="display:flex;gap:8px">
          <button class="btn btn-success" id="taskFormSaveBtn" onclick="saveTask('${dateStr}')">${state._editingTaskId ? '✓ 更新任务' : '✓ 保存任务'}</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelTaskForm()">${state._editingTaskId ? '取消编辑' : '取消'}</button>
        </div>
      </div>
      ${tasks.length === 0
      ? '<div class="empty-state"><p>暂无任务记录</p></div>'
      : `${taskFilterHtml('entry', tasks)}
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>任务名称</th><th>活动类型</th><th>时长</th><th>数量</th><th>效率</th><th>正确率</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${filterTasksByView(tasks, 'entry').map((t, i) => {
        const rate = t.quantity && t.minutes ? (Number(t.quantity) / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        const isEditingTask = state._editingTaskId === t.id;
        return `<tr${isEditingTask ? ' style="background:rgba(255,213,79,.1);outline:1px solid rgba(255,213,79,.3)"' : ''}>
          <td class="fw-mono c-muted">${i + 1}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t.name}">${t.name}</td>
          <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
          <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
          <td class="fw-mono">${t.quantity ? t.quantity + (t.quantityUnit ? ' ' + t.quantityUnit : '') : '-'}</td>
          <td class="fw-mono">${rate ? rate + (t.quantityUnit ? ' ' + t.quantityUnit + '/min' : '/min') : '-'}</td>
          <td class="fw-mono ${t.accuracy >= 80 ? 'c-green' : t.accuracy >= 60 ? 'c-wake' : t.accuracy ? 'c-red' : ''}">${t.accuracy != null && t.accuracy !== '' ? t.accuracy + '%' : '-'}</td>
          <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editTask('${dateStr}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="deleteTask('${dateStr}','${t.id}')">删除</button></td>
        </tr>`;
      }).join('')}</tbody>
          <tfoot><tr><td colspan="3">合计</td><td class="fw-mono">${fmtMin(filterTasksByView(tasks, 'entry').reduce((s, t) => s + (Number(t.minutes) || 0), 0), true)}</td><td colspan="5"><span class="c-muted" style="font-size:10px">任务总时长 vs 实际专注: <span class="${devClass(stats.actualMin > 0 ? Math.round((stats.taskMin - stats.actualMin) / stats.actualMin * 100) : null)}">${stats.actualMin > 0 ? devStr(Math.round((stats.taskMin - stats.actualMin) / stats.actualMin * 100)) : '-'}</span></span></td></tr></tfoot>
        </table></div>`}
    </div>

    <!-- 🌙 SLEEP TIME (bottom) -->
    <div class="card entry-sleep-card">
      <div class="card-header"><div><div class="card-title">🌙 睡觉时间</div></div></div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${timeInputHtml('sleepInput', day.sleepTime || '')}
        <button class="btn btn-success btn-sm" onclick="saveSleep('${dateStr}')">保存</button>
        ${day.sleepTime ? `<span class="fw-mono" style="font-size:12px;color:var(--sleep)">${day.sleepTime}</span>` : ''}
        <span class="form-hint" style="margin:0">填次日凌晨时间如 00:30</span>
      </div>
      ${day.wakeTime && day.sleepTime ? `
        <div style="margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--muted)">
          清醒时长${tipIcon('awake')}: <span style="color:var(--text)">${fmtMin(stats.awakeMin)}</span>${stats.unavailableMin ? ` · 不可用: <span style="color:var(--muted)">${fmtMin(stats.unavailableMin)}</span>` : ''}${stats.specialStudyActualMin ? ` · 特殊学习: <span style="color:var(--clock)">${fmtMin(stats.specialStudyActualMin)}</span>` : ''} · 可支配: <span style="color:var(--text)">${fmtMin(stats.disposableMin)}</span> ·
          利用率${tipIcon('util')}: <span style="color:${stats.utilPct >= 50 ? 'var(--green)' : 'var(--red)'}">${stats.utilPct != null ? stats.utilPct + '%' : '-'}</span>
        </div>` : ''}
    </div>
  `;
}

function autoCalcRate() {
  const qty = parseFloat(document.getElementById('task_qty')?.value);
  const mins = parseFloat(document.getElementById('task_min')?.value);
  const unit = document.getElementById('task_unit')?.value || '';
  const rateEl = document.getElementById('task_rate');
  if (rateEl) {
    if (qty && mins && mins > 0) {
      rateEl.value = (qty / mins).toFixed(2) + (unit ? ' ' + unit + '/min' : '/min');
    } else {
      rateEl.value = '';
    }
  }
}

function toggleForm(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}
function changeDate(n) { state._editingSessionId = null; state._editingTaskId = null; state.selectedDate = addDays(state.selectedDate, n); showTab('entry'); }
function jumpDate(d) { if (d) { state._editingSessionId = null; state._editingTaskId = null; state.selectedDate = d; showTab('entry'); } }

async function saveDayNote(dateStr) {
  const note = document.getElementById('dayNoteInput')?.value || '';
  const day = getDay(dateStr);
  day.dayNote = note;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/dayNote`, { method: 'PUT', body: JSON.stringify({ dayNote: note }) });
  renderEntry(); restoreDraft(dateStr);
}

function applyDayTypeTemplateToEntry(name) {
  const tmpl = getDayTypeTemplates().find(item => item.name === String(name || '').trim());
  if (!tmpl) return;
  const special = document.getElementById('specialDayCheck');
  const exclude = document.getElementById('excludeFromRatingCheck');
  if (special) special.checked = Boolean(tmpl.specialDay);
  if (exclude) exclude.checked = Boolean(tmpl.excludeFromRating);
  const reasonWrap = document.getElementById('specialDayReasonWrap');
  if (reasonWrap) {
    reasonWrap.style.display = tmpl.specialDay ? 'block' : 'none';
    reasonWrap.style.marginTop = tmpl.specialDay ? '10px' : '0';
  }
}

async function saveSleep(dateStr) {
  const wakeTime = readTimeInput('wakeInput');
  const sleepTime = readTimeInput('sleepInput');
  const dayType = document.getElementById('dayTypeInput')?.value?.trim() || '';
  const specialDay = document.getElementById('specialDayCheck')?.checked || false;
  const specialDayReason = document.getElementById('specialDayReason')?.value?.trim() || '';
  const excludeFromRating = document.getElementById('excludeFromRatingCheck')?.checked || false;
  const day = getDay(dateStr);
  day.wakeTime = wakeTime;
  day.sleepTime = sleepTime;
  day.dayType = dayType;
  day.specialDay = specialDay;
  day.specialDayReason = specialDayReason;
  day.excludeFromRating = excludeFromRating;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sleep`, { method: 'PUT', body: JSON.stringify({ wakeTime, sleepTime, dayType, specialDay, specialDayReason, excludeFromRating }) });
  renderEntry(); renderHeader(); restoreDraft(dateStr);
}

async function saveSession(dateStr) {
  const sessionType = state._sessType || 'normal';
  const isSpecial = sessionType === 'special';
  const isSpecialStudy = sessionType === 'special-study';
  const sessName = (document.getElementById('sess_name')?.value || '').trim();
  const start = readTimeInput('sess_start');
  const end = readTimeInput('sess_end');
  const nominal = parseInt(document.getElementById('sess_nominal').value) || 0;
  const actual = parseInt(document.getElementById('sess_actual').value) || 0;
  const rest = parseInt(document.getElementById('sess_rest').value) || 0;
  const note = document.getElementById('sess_note')?.value || '';
  if ((isSpecial || isSpecialStudy) && !sessName) { alert('请填写时段名称'); return; }
  if (!start || !end) { alert('请填写开始和结束时间'); return; }
  if (isSpecialStudy && actual <= 0) { alert('特殊学习时段请填写其中实际学习的分钟数'); return; }

  const editId = state._editingSessionId;
  const day = getDay(dateStr);

  if (editId) {
    // ── 编辑模式：原地更新 ──
    const idx = day.sessions.findIndex(s => s.id === editId);
    if (idx < 0) { alert('找不到要编辑的时段'); state._editingSessionId = null; return; }
    const session = day.sessions[idx];
    session.startTime = start;
    session.endTime = end;
    session.note = note;
    if (isSpecial || isSpecialStudy) {
      session.type = sessionType;
      session.name = sessName;
      session.nominalMinutes = 0;
      session.actualMinutes = isSpecialStudy ? actual : 0;
      session.restMinutes = 0;
    } else {
      delete session.type;
      delete session.name;
      session.nominalMinutes = nominal;
      session.actualMinutes = actual;
      session.restMinutes = rest;
    }
    state._editingSessionId = null;
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}`, { method: 'PUT', body: JSON.stringify(day) });
  } else {
    // ── 新增模式 ──
    const session = { id: uid(), startTime: start, endTime: end, note };
    if (isSpecial || isSpecialStudy) {
      session.type = sessionType;
      session.name = sessName;
      session.nominalMinutes = 0;
      session.actualMinutes = isSpecialStudy ? actual : 0;
      session.restMinutes = 0;
    } else {
      session.nominalMinutes = nominal;
      session.actualMinutes = actual;
      session.restMinutes = rest;
    }
    day.sessions.push(session);
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}/sessions`, { method: 'POST', body: JSON.stringify(session) });
  }
  showTab('entry');
}

function editSession(dateStr, sessionId) {
  const day = getDay(dateStr);
  const s = (day.sessions || []).find(x => x.id === sessionId);
  if (!s) return;
  state._editingSessionId = sessionId;
  // 重新渲染以更新按钮文字
  renderEntry();
  // 打开表单
  const form = document.getElementById('sessionForm');
  if (form) form.classList.add('open');
  // 切换时段类型
  const isSpec = s.type === 'special';
  const isSpecialStudy = s.type === 'special-study';
  switchSessionType(isSpecialStudy ? 'special-study' : isSpec ? 'special' : 'normal');
  // 填充数据
  setTimeout(() => {
    if ((isSpec || isSpecialStudy) && s.name) {
      const nameEl = document.getElementById('sess_name');
      if (nameEl) nameEl.value = s.name;
    }
    if (s.startTime) {
      const parts = s.startTime.split(':');
      const hEl = document.getElementById('sess_start_h'), mEl = document.getElementById('sess_start_m');
      if (hEl) hEl.value = parseInt(parts[0], 10);
      if (mEl) mEl.value = parseInt(parts[1], 10);
    }
    if (s.endTime) {
      const parts = s.endTime.split(':');
      const hEl = document.getElementById('sess_end_h'), mEl = document.getElementById('sess_end_m');
      if (hEl) hEl.value = parseInt(parts[0], 10);
      if (mEl) mEl.value = parseInt(parts[1], 10);
    }
    if (!isSpec) {
      const nomEl = document.getElementById('sess_nominal');
      if (nomEl && s.nominalMinutes) nomEl.value = s.nominalMinutes;
      const actEl = document.getElementById('sess_actual');
      if (actEl && s.actualMinutes) actEl.value = s.actualMinutes;
      const restEl = document.getElementById('sess_rest');
      if (restEl && (Number(s.restMinutes) || 0)) restEl.value = s.restMinutes;
    }
    const noteEl = document.getElementById('sess_note');
    if (noteEl && s.note) noteEl.value = s.note;
  }, 60);
}

function cancelSessionForm() {
  state._editingSessionId = null;
  const form = document.getElementById('sessionForm');
  if (form) form.classList.remove('open');
  renderEntry();
}

async function deleteSession(dateStr, id) {
  const day = getDay(dateStr);
  day.sessions = day.sessions.filter(s => s.id !== id);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${id}`, { method: 'DELETE' });
  renderEntry(); renderHeader();
}

async function saveTask(dateStr) {
  const name = document.getElementById('task_name').value.trim();
  const mins = parseInt(document.getElementById('task_min').value) || 0;
  if (!name) { alert('请填写任务名称'); return; }
  if (!mins) { alert('请填写时长'); return; }
  const qty = document.getElementById('task_qty').value;
  const acc = document.getElementById('task_acc').value;
  const activityType = buildActPath(catSelValue('task_l1'), catSelValue('task_l2'), catSelValue('task_l3'));
  const quantityUnit = document.getElementById('task_unit').value;
  const note = document.getElementById('task_note').value;

  const editId = state._editingTaskId;
  const day = getDay(dateStr);

  if (editId) {
    // ── 编辑模式：原地更新 ──
    const idx = day.tasks.findIndex(t => t.id === editId);
    if (idx < 0) { alert('找不到要编辑的任务'); state._editingTaskId = null; return; }
    const task = day.tasks[idx];
    task.name = name;
    task.activityType = activityType;
    task.minutes = mins;
    task.quantity = qty ? Number(qty) : null;
    task.quantityUnit = quantityUnit;
    task.accuracy = acc !== '' ? Number(acc) : null;
    task.note = note;
    state._editingTaskId = null;
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}`, { method: 'PUT', body: JSON.stringify(day) });
  } else {
    // ── 新增模式 ──
    const task = {
      id: uid(), name, activityType, minutes: mins,
      quantity: qty ? Number(qty) : null, quantityUnit,
      accuracy: acc !== '' ? Number(acc) : null, note,
    };
    day.tasks.push(task);
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}/tasks`, { method: 'POST', body: JSON.stringify(task) });
  }
  showTab('entry');
}

function editTask(dateStr, taskId) {
  const day = getDay(dateStr);
  const t = (day.tasks || []).find(x => x.id === taskId);
  if (!t) return;
  state._editingTaskId = taskId;
  // 重新渲染以更新按钮文字
  renderEntry();
  // 打开表单
  const form = document.getElementById('taskForm');
  if (form) form.classList.add('open');
  // 填充数据
  setTimeout(() => {
    const nameEl = document.getElementById('task_name');
    if (nameEl) nameEl.value = t.name || '';
    // 解析三级类别并填入
    const [l1, l2, l3] = parseActPath(t.activityType);
    const l1El = document.getElementById('task_l1');
    if (l1El) l1El.value = l1;
    const l2El = document.getElementById('task_l2');
    if (l2El) l2El.value = l2;
    const l3El = document.getElementById('task_l3');
    if (l3El) l3El.value = l3;
    const minEl = document.getElementById('task_min');
    if (minEl) minEl.value = t.minutes || '';
    const qtyEl = document.getElementById('task_qty');
    if (qtyEl) qtyEl.value = t.quantity != null ? t.quantity : '';
    const unitEl = document.getElementById('task_unit');
    if (unitEl) unitEl.value = t.quantityUnit || '';
    const accEl = document.getElementById('task_acc');
    if (accEl) accEl.value = t.accuracy != null ? t.accuracy : '';
    const noteEl = document.getElementById('task_note');
    if (noteEl) noteEl.value = t.note || '';
    autoCalcRate();
  }, 60);
}

function cancelTaskForm() {
  state._editingTaskId = null;
  const form = document.getElementById('taskForm');
  if (form) form.classList.remove('open');
  renderEntry();
}

async function deleteTask(dateStr, id) {
  const day = getDay(dateStr);
  day.tasks = day.tasks.filter(t => t.id !== id);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/tasks/${id}`, { method: 'DELETE' });
  renderEntry(); renderHeader();
}

async function dayDeleteTask(dateStr, taskId) {
  if (!confirm('确定删除该任务？')) return;
  const day = getDay(dateStr);
  day.tasks = day.tasks.filter(t => t.id !== taskId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/tasks/${taskId}`, { method: 'DELETE' });
  renderDayOverview(); renderHeader();
}

async function weekDeleteTask(dateStr, taskId) {
  if (!confirm('确定删除该任务？')) return;
  const day = getDay(dateStr);
  day.tasks = day.tasks.filter(t => t.id !== taskId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/tasks/${taskId}`, { method: 'DELETE' });
  renderWeekOverview(); renderHeader();
}

async function weekDeleteSession(dateStr, sessionId) {
  if (!confirm('确定删除该专注时段？')) return;
  const day = getDay(dateStr);
  day.sessions = day.sessions.filter(s => s.id !== sessionId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${sessionId}`, { method: 'DELETE' });
  renderWeekOverview(); renderHeader();
}

function weekEditSession(dateStr, sessionId) {
  state.selectedDate = dateStr;
  showTab('entry');
  setTimeout(() => editSession(dateStr, sessionId), 100);
}

async function monthDeleteSession(dateStr, sessionId) {
  if (!confirm('确定删除该专注时段？')) return;
  const day = getDay(dateStr);
  day.sessions = day.sessions.filter(s => s.id !== sessionId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${sessionId}`, { method: 'DELETE' });
  renderMonthOverview(); renderHeader();
}

function monthEditSession(dateStr, sessionId) {
  state.selectedDate = dateStr;
  showTab('entry');
  setTimeout(() => editSession(dateStr, sessionId), 100);
}

async function dayDeleteSession(dateStr, sessionId) {
  if (!confirm('确定删除该专注时段？')) return;
  const day = getDay(dateStr);
  day.sessions = day.sessions.filter(s => s.id !== sessionId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${sessionId}`, { method: 'DELETE' });
  renderDayOverview(); renderHeader();
}

function dayEditSession(dateStr, sessionId) {
  state.selectedDate = dateStr;
  showTab('entry');
  setTimeout(() => editSession(dateStr, sessionId), 100);
}

// ============================================================
// CALENDAR TAB
// ============================================================
function renderCalendar() {
  const { year, month } = state.cal;
  const days = getMonthDays(year, month);
  const todayStr = getTodayStr();
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const maxActual = Math.max(...days.map(d => computeDay(d.dateStr).actualMin), 1);

  document.getElementById('tab-calendar').innerHTML = `
    <div class="cal-header">
      <button class="btn btn-ghost btn-sm" onclick="calNav(-1)">← 上月</button>
      <span class="cal-month">${year}年 ${monthNames[month]}</span>
      <button class="btn btn-ghost btn-sm" onclick="calNav(1)">下月 →</button>
      <button class="btn btn-ghost btn-sm" onclick="calGoToday()" style="margin-left:8px">今天</button>
    </div>
    <div class="cal-grid">
      ${weekdayNames.map(w => `<div class="cal-weekday">${w}</div>`).join('')}
      ${days.map(({ dateStr, inMonth }) => {
    const s = computeDay(dateStr);
    const isToday = dateStr === todayStr;
    const isSel = dateStr === state.selectedDate;
    const hasData = s.actualMin > 0 || s.taskMin > 0 || state.data[dateStr]?.wakeTime;
    const pct = Math.round(s.actualMin / maxActual * 100);
    const hourColor = s.actualMin >= 360 ? 'var(--pol)' : s.actualMin >= 240 ? 'var(--hp)' : s.actualMin >= 120 ? 'var(--wake)' : s.actualMin > 0 ? 'var(--red)' : 'var(--dim)';
    const actKeys = Object.keys(s.actMin || {}).filter(k => s.actMin[k] > 0);
    const dots = actKeys
      .map(k => { const c = getActColor(k); return `<div class="cal-dot" style="background:${c.color}" title="${k}: ${fmtMin(s.actMin[k])}"></div>`; })
      .join('');
    return `<div class="cal-day ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''} ${!inMonth ? 'other-month' : ''} ${hasData ? 'has-data' : ''}"
          onclick="calSelectDay('${dateStr}')">
          <div class="cal-day-num">${strToDate(dateStr).getDate()}</div>
          ${hasData ? `
            <div class="cal-day-hours" style="color:${hourColor}">${fmtHrs(s.actualMin)}</div>
            <div class="cal-day-bar"><div style="width:${pct}%;height:100%;border-radius:2px;background:${hourColor}"></div></div>
            <div class="cal-day-indicator">${dots}</div>
          ` : ''}
        </div>`;
  }).join('')}
    </div>
    <div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      ${getActivityTypes().map(a => { const c = getActColor(a); return `<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><span class="cal-dot" style="background:${c.color}"></span>${a}</span>`; }).join('')}
      <span style="font-size:11px;color:var(--muted);margin-left:8px">点击日期→录入/日览</span>
    </div>
  `;
}

function calNav(n) {
  state.cal.month += n;
  if (state.cal.month < 0) { state.cal.month = 11; state.cal.year--; }
  if (state.cal.month > 11) { state.cal.month = 0; state.cal.year++; }
  renderCalendar();
}
function calGoToday() {
  const d = new Date();
  state.cal = { year: d.getFullYear(), month: d.getMonth() };
  renderCalendar();
}
function calSelectDay(dateStr) {
  state.selectedDate = dateStr;
  showTab('day');
}

// ============================================================
// DAY OVERVIEW TAB
// ============================================================
function renderDayOverview() {
  const dateStr = state.selectedDate;
  const s = computeDay(dateStr);
  const day = getDay(dateStr);
  const actData = Object.keys(s.actMin || {}).filter(k => s.actMin[k] > 0);

  document.getElementById('tab-day').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--hp)">${formatDisplay(dateStr)}</div>
      <button class="btn btn-ghost btn-sm" onclick="state.selectedDate=addDays('${dateStr}',-1);showTab('day')">←</button>
      <button class="btn btn-ghost btn-sm" onclick="state.selectedDate=addDays('${dateStr}',1);showTab('day')">→</button>
      <button class="btn btn-primary btn-sm" onclick="state.selectedDate='${dateStr}';showTab('entry')">✏️ 编辑</button>
    </div>

    <div class="three-time" style="margin-bottom:16px">
      <div class="time-block clock">
        <div class="label">⏱ 时钟时长${tipIcon('clock')}</div>
        <div class="value">${fmtMin(s.clockMin, true)}</div>
        <div class="sub">有效${tipIcon('effectiveClock')} ${fmtMin(s.effectiveClockMin)} · 休息 ${fmtMin(s.restMin)}</div>
      </div>
      <div class="time-block nominal">
        <div class="label">📋 名义时长${tipIcon('nominal')}</div>
        <div class="value">${fmtMin(s.nominalMin, true)}</div>
        <div class="sub">计划目标</div>
      </div>
      <div class="time-block actual">
        <div class="label">✅ 实际专注${tipIcon('actual')}</div>
        <div class="value">${fmtMin(s.actualMin, true)}</div>
        <div class="sub">真实专注 <span class="${devClass(s.actualVsNominal)}">${devStr(s.actualVsNominal)}</span></div>
      </div>
    </div>

    <div class="mini-grid">
      <div class="mini-card"><div class="lbl">有效时钟${tipIcon('effectiveClock')}</div><div class="val c-clock">${fmtMin(s.effectiveClockMin, true)}</div><div class="sub">时钟 − 休息</div></div>
      <div class="mini-card"><div class="lbl">任务记录${tipIcon('taskMin')}</div><div class="val" style="color:var(--word)">${fmtMin(s.taskMin, true)}</div><div class="sub">所有任务合计</div></div>
      <div class="mini-card"><div class="lbl">专注效率${tipIcon('efficiency')}</div><div class="val" style="color:${s.focusEfficiency >= 80 ? 'var(--green)' : s.focusEfficiency >= 60 ? 'var(--wake)' : 'var(--red)'}">${s.focusEfficiency != null ? s.focusEfficiency + '%' : '-'}</div><div class="sub">实际/(时钟−休息)</div></div>
      <div class="mini-card"><div class="lbl">休息时间${tipIcon('rest')}</div><div class="val" style="color:var(--sleep)">${fmtMin(s.restMin, true)}</div><div class="sub">计划休息合计</div></div>
      <div class="mini-card"><div class="lbl">分心时间${tipIcon('distract')}</div><div class="val" style="color:var(--red)">${fmtMin(s.distractMin, true)}</div><div class="sub">时钟−实际−休息</div></div>
      <div class="mini-card"><div class="lbl">清醒时长${tipIcon('awake')}</div><div class="val" style="color:var(--wake)">${fmtMin(s.awakeMin)}</div><div class="sub">${day.wakeTime || '?'} → ${day.sleepTime || '?'}</div></div>
      <div class="mini-card"><div class="lbl">可支配时长</div><div class="val" style="color:var(--clock)">${s.disposableMin != null ? fmtMin(s.disposableMin) : '-'}</div><div class="sub">清醒${s.unavailableMin ? ' − 不可用' + fmtMin(s.unavailableMin) : ' (无不可用时段)'}</div></div>
      <div class="mini-card"><div class="lbl">时间利用率${tipIcon('util')}</div><div class="val" style="color:${s.utilPct >= 50 ? 'var(--green)' : s.utilPct >= 30 ? 'var(--wake)' : 'var(--red)'}">${s.utilPct != null ? s.utilPct + '%' : '-'}</div><div class="sub">实际专注/可支配</div></div>
      <div class="mini-card"><div class="lbl">时段数量</div><div class="val" style="color:var(--hp)">${s.sessions.length}</div><div class="sub">专注时段</div></div>
      <div class="mini-card"><div class="lbl">任务数量</div><div class="val" style="color:var(--pol)">${s.tasks.length}</div><div class="sub">已记录任务</div></div>
    </div>

    ${day.dayNote ? `<div class="card" style="margin-bottom:16px">
      <div class="card-title" style="margin-bottom:6px">📝 今日备注</div>
      <div style="font-size:13px;color:var(--text);line-height:1.8;white-space:pre-wrap">${escHtmlApp(day.dayNote)}</div>
    </div>` : ''}

    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-title">三维时间对比</div>
        <div class="chart-sub">时钟 / 有效时钟 / 名义 / 实际 对比（分钟）</div>
        <canvas id="dayThreeChart" height="180"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">类别时间分布</div>
        <div class="chart-sub">任务时长按类别</div>
        <canvas id="dayCatChart" height="180"></canvas>
      </div>
      ${s.sessions.length > 0 ? `
      <div class="chart-card full">
        <div class="chart-title">专注时段明细</div>
        <div class="chart-sub">时钟 · 名义 · 实际 · 休息 · 分心 · 专注率</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>#</th><th>开始</th><th>结束</th>
              <th class="c-clock">时钟</th><th class="c-nominal">名义</th><th class="c-actual">实际</th>
              <th>休息${tipIcon('rest')}</th><th>分心${tipIcon('distract')}</th>
              <th>专注率</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${s.sessions.map((sess, i) => {
    const cl = sessionClock(sess);
    const isSpec = isUnavailableSession(sess);
    const isSpecialStudy = isSpecialStudySession(sess);
    const typeMeta = sessionTypeMeta(sess);
    const actual = Number(sess.actualMinutes) || 0;
    const rest = Number(sess.restMinutes) || 0;
    const distract = isSpec || isSpecialStudy ? 0 : Math.max(0, cl - actual - rest);
    const eff = (!isSpec && !isSpecialStudy && (cl - rest) > 0) ? Math.round(actual / (cl - rest) * 100) : null;
    return `<tr${typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}>
                  <td class="fw-mono c-muted">${i + 1}${typeMeta.short ? `<br><span style="font-size:9px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 4px;border-radius:3px">${typeMeta.short}</span>` : ''}</td>
                  <td class="fw-mono">${sess.type !== 'normal' && sess.name ? `<span style="color:${typeMeta.color};font-weight:600">${escHtmlApp(sess.name)}</span><br>` : ''}${sess.startTime || '-'}</td><td class="fw-mono">${sess.endTime || '-'}</td>
                  <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
                  <td class="fw-mono c-nominal">${fmtMin(Number(sess.nominalMinutes) || 0, true)}</td>
                  <td class="fw-mono c-actual">${fmtMin(actual, true)}</td>
                  <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
                  <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(distract, true)}</td>
                  <td class="fw-mono ${eff >= 80 ? 'c-green' : eff >= 60 ? 'c-wake' : 'c-red'}">${eff != null ? eff + '%' : '-'}</td>
                  <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="dayEditSession('${dateStr}','${sess.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="dayDeleteSession('${dateStr}','${sess.id}')">删除</button></td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
      ${s.tasks.length > 0 ? `
      <div class="chart-card full">
        <div class="chart-title">任务明细</div>
        <div class="chart-sub">类别 · 时长 · 数量 · 效率 · 共 ${s.tasks.length} 条</div>
        ${taskFilterHtml('day', s.tasks)}
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>任务</th><th>活动类型</th>
              <th>时长</th><th>数量</th><th>效率</th><th>正确率</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${filterTasksByView(s.tasks, 'day').map(t => {
    const actColor = getActColor(t.activityType);
    const rate = t.quantity && t.minutes ? (Number(t.quantity) / Number(t.minutes)).toFixed(2) : null;
    return `<tr>
                  <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtmlApp(t.name)}</td>
                  <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
                  <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
                  <td class="fw-mono">${t.quantity ? (t.quantity + (t.quantityUnit ? ' ' + t.quantityUnit : '')) : '-'}</td>
                  <td class="fw-mono">${rate ? (rate + (t.quantityUnit ? ' ' + t.quantityUnit + '/min' : '/min')) : '-'}</td>
                  <td class="fw-mono ${t.accuracy >= 80 ? 'c-green' : t.accuracy >= 60 ? 'c-wake' : t.accuracy ? 'c-red' : ''}">${t.accuracy != null && t.accuracy !== '' ? t.accuracy + '%' : '-'}</td>
                  <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
                  <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="monthEditTask('${dateStr}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="dayDeleteTask('${dateStr}','${t.id}')">删除</button></td>
                </tr>`;
  }).join('')}
            </tbody>
            <tfoot><tr><td colspan="2">合计</td><td class="fw-mono">${fmtMin(filterTasksByView(s.tasks, 'day').reduce((a, t) => a + (Number(t.minutes) || 0), 0), true)}</td><td colspan="5"></td></tr></tfoot>
          </table>
        </div>
      </div>` : ''}
    </div>
  `;

  mkChart('dayThreeChart', {
    type: 'bar',
    data: {
      labels: ['时钟时长', '有效时钟', '名义时长', '实际专注'],
      datasets: [{
        data: [s.clockMin, s.effectiveClockMin, s.nominalMin, s.actualMin],
        backgroundColor: ['rgba(128,222,234,.15)', 'rgba(128,222,234,.3)', 'rgba(79,195,247,.3)', 'rgba(105,240,174,.3)'],
        borderColor: ['#80deea', '#80deea', '#4fc3f7', '#69f0ae'], borderWidth: 2, borderRadius: 4
      }]
    },
    options: {
      responsive: true, indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmtMin(ctx.raw) } } },
      scales: { x: { ticks: { color: '#6b7a9e', callback: v => fmtMin(v) }, grid: gridCfg }, y: { ticks: { color: '#c8d4f0' }, grid: { display: false } } }
    }
  });

  if (actData.length > 0) {
    mkChart('dayCatChart', {
      type: 'doughnut',
      data: { labels: actData, datasets: [{ data: actData.map(k => s.actMin[k]), backgroundColor: actData.map(k => getActColor(k).color + 'cc'), borderColor: actData.map(k => getActColor(k).color), borderWidth: 1 }] },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)}` } } } }
    });
  }
}

// ============================================================
// WEEK OVERVIEW TAB
// ============================================================
function renderWeekOverview() {
  const days = getWeekDays(state.weekStart);
  const { days: dayStats, totals } = computeRange(days);
  const todayStr = getTodayStr();

  // 统计指标
  const wkStatsClock = calcStats(dayStats.map(d => d.clockMin));
  const wkStatsActual = calcStats(dayStats.map(d => d.actualMin));
  const wkStatsNominal = calcStats(dayStats.map(d => d.nominalMin));
  const wkStatsRest = calcStats(dayStats.map(d => d.restMin));
  const wkStatsEffClock = calcStats(dayStats.map(d => d.effectiveClockMin));
  const wkStatsTask = calcStats(dayStats.map(d => d.taskMin));

  // 收集本周所有任务
  const allWeekTasks = [];
  days.forEach(dateStr => {
    const day = getDay(dateStr);
    (day.tasks || []).forEach(t => { allWeekTasks.push({ ...t, _date: dateStr }); });
  });
  const weekTaskTotalMin = allWeekTasks.reduce((s, t) => s + (Number(t.minutes) || 0), 0);

  // 收集本周所有专注时段
  const allWeekSessions = [];
  days.forEach(dateStr => {
    const day = getDay(dateStr);
    (day.sessions || []).forEach(s => { allWeekSessions.push({ ...s, _date: dateStr }); });
  });
  const weekSessTotalClock = allWeekSessions.reduce((s, sess) => s + sessionClock(sess), 0);
  const weekSessTotalActual = allWeekSessions.filter(s => s.type !== 'special').reduce((s, sess) => s + (Number(sess.actualMinutes) || 0), 0);

  document.getElementById('tab-week').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="weekNav(-7)">← 上周</button>
      <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--hp)">${formatShort(days[0])} — ${formatShort(days[6])}</span>
      <button class="btn btn-ghost btn-sm" onclick="weekNav(7)">下周 →</button>
      <button class="btn btn-ghost btn-sm" onclick="weekGoToday()">本周</button>
    </div>

    <div class="week-row">
      ${dayStats.map(d => {
    const isToday = d.dateStr === todayStr;
    const isSel = d.dateStr === state.selectedDate;
    const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const idx = days.indexOf(d.dateStr);
    const hasAny = d.actualMin > 0 || d.taskMin > 0;
    return `<div class="week-day-card ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''}" onclick="weekSelectDay('${d.dateStr}')">
          <div class="week-day-lbl">${dayNames[idx]}</div>
          <div class="week-day-date" style="color:${isToday ? 'var(--hp)' : 'var(--text)'}">${formatShort(d.dateStr)}</div>
          <div class="week-day-hours" style="color:${d.actualMin >= 360 ? 'var(--pol)' : d.actualMin >= 180 ? 'var(--hp)' : d.actualMin > 0 ? 'var(--wake)' : 'var(--dim)'}">${hasAny ? fmtHrs(d.actualMin) : '—'}</div>
        </div>`;
  }).join('')}
    </div>

    <div class="mini-grid" style="margin-bottom:16px">
      <div class="mini-card"><div class="lbl">有效天数</div><div class="val" style="color:var(--hp)">${totals.daysWithData}<span style="font-size:12px;opacity:.6">/7天</span></div></div>
      <div class="mini-card"><div class="lbl">总时钟${tipIcon('clock')}</div><div class="val c-clock">${fmtMin(totals.clockMin, true)}</div><div class="sub">休息 ${fmtMin(totals.restMin)} · 日均 ${fmtMin(totals.avgClock)} · CV ${fmtCV(wkStatsClock.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总有效时钟${tipIcon('effectiveClock')}</div><div class="val c-clock">${fmtMin(totals.effectiveClockMin, true)}</div><div class="sub">日均 ${fmtMin(totals.avgEffClock)} · CV ${fmtCV(wkStatsEffClock.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总名义${tipIcon('nominal')}</div><div class="val c-nominal">${fmtMin(totals.nominalMin, true)}</div><div class="sub">日均 ${fmtMin(totals.avgNominal)} · CV ${fmtCV(wkStatsNominal.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总实际专注${tipIcon('actual')}</div><div class="val c-actual">${fmtMin(totals.actualMin, true)}</div><div class="sub">日均 ${fmtMin(totals.avgActual)} · CV ${fmtCV(wkStatsActual.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总任务时长${tipIcon('taskMin')}</div><div class="val" style="color:var(--word)">${fmtMin(totals.taskMin, true)}</div><div class="sub">日均 ${fmtMin(totals.avgTask)} · CV ${fmtCV(wkStatsTask.cv)}</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">每日三维时间对比</div>
        <div class="chart-sub">填充折线图 · 时钟（虚线）/ 有效时钟 / 名义（蓝）/ 实际（绿）</div>
        <canvas id="weekThreeChart" height="90"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">类别时间分布</div>
        <div class="chart-sub">本周各类别累计</div>
        <canvas id="weekCatChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">每日专注效率</div>
        <div class="chart-sub">实际专注/有效时钟 %</div>
        <canvas id="weekEffChart" height="200"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">每日汇总表</div>
        <div class="chart-sub">时钟 + 有效时钟 + 休息 + 名义 + 实际 + 偏差 + 效率 + 利用率</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>日期</th><th>起床</th><th>睡觉</th>
              <th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-clock">有效${tipIcon('effectiveClock')}</th><th>休息${tipIcon('rest')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th>
              <th>偏差率${tipIcon('deviation')}</th><th>效率${tipIcon('efficiency')}</th><th>利用率${tipIcon('util')}</th>
            </tr></thead>
            <tbody>
              ${dayStats.map(d => {
    const dayObj = getDay(d.dateStr);
    return `<tr ${d.dateStr === todayStr ? 'style="background:rgba(79,195,247,.04)"' : ''}>
                  <td class="fw-mono ${d.dateStr === todayStr ? 'c-hp' : ''}">${formatShort(d.dateStr)}</td>
                  <td class="fw-mono c-wake">${dayObj.wakeTime || '-'}</td>
                  <td class="fw-mono c-sleep">${dayObj.sleepTime || '-'}</td>
                  <td class="fw-mono c-clock">${fmtMin(d.clockMin, true)}</td>
                  <td class="fw-mono c-clock">${fmtMin(d.effectiveClockMin, true)}</td>
                  <td class="fw-mono">${fmtMin(d.restMin, true)}</td>
                  <td class="fw-mono c-nominal">${fmtMin(d.nominalMin, true)}</td>
                  <td class="fw-mono c-actual">${fmtMin(d.actualMin, true)}</td>
                  <td class="fw-mono ${devClass(d.actualVsNominal)}">${devStr(d.actualVsNominal)}</td>
                  <td class="fw-mono ${d.focusEfficiency >= 80 ? 'c-green' : d.focusEfficiency >= 60 ? 'c-wake' : 'c-red'}">${d.focusEfficiency != null ? d.focusEfficiency + '%' : '-'}</td>
                  <td class="fw-mono ${d.utilPct >= 50 ? 'c-green' : d.utilPct >= 30 ? 'c-wake' : 'c-red'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
                </tr>`;
  }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="3">周合计</td>
              <td class="c-clock">${fmtMin(totals.clockMin, true)}</td>
              <td class="c-clock">${fmtMin(totals.effectiveClockMin, true)}</td>
              <td>${fmtMin(totals.restMin, true)}</td>
              <td class="c-nominal">${fmtMin(totals.nominalMin, true)}</td>
              <td class="c-actual">${fmtMin(totals.actualMin, true)}</td>
              <td class="${devClass(totals.actualVsNominal)}">${devStr(totals.actualVsNominal)}</td>
              <td class="${totals.focusEfficiency >= 80 ? 'c-green' : totals.focusEfficiency >= 60 ? 'c-wake' : 'c-red'}">${totals.focusEfficiency != null ? totals.focusEfficiency + '%' : '-'}</td>
              <td>-</td>
            </tr><tr style="color:var(--muted)">
              <td colspan="3">日均 (${totals.daysWithData}天)</td>
              <td>${fmtMin(totals.avgClock)}</td>
              <td>${fmtMin(totals.avgEffClock)}</td>
              <td>${fmtMin(totals.avgRest)}</td>
              <td>${fmtMin(totals.avgNominal)}</td>
              <td>${fmtMin(totals.avgActual)}</td>
              <td colspan="3"></td>
            </tr><tr style="color:var(--dim);font-size:11px">
              <td colspan="3">σ${tipIcon('stdDev')} / CV${tipIcon('cv')}</td>
              <td>${fmtSD(wkStatsClock.stdDev)} / ${fmtCV(wkStatsClock.cv)}</td>
              <td>${fmtSD(wkStatsEffClock.stdDev)} / ${fmtCV(wkStatsEffClock.cv)}</td>
              <td>${fmtSD(wkStatsRest.stdDev)} / ${fmtCV(wkStatsRest.cv)}</td>
              <td>${fmtSD(wkStatsNominal.stdDev)} / ${fmtCV(wkStatsNominal.cv)}</td>
              <td>${fmtSD(wkStatsActual.stdDev)} / ${fmtCV(wkStatsActual.cv)}</td>
              <td colspan="3"></td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>

    <!-- 📝 本周任务记录 -->
    <div class="card entry-table-card" style="margin-top:16px">
      <div class="card-header">
        <div><div class="card-title">📝 本周任务记录</div><div class="card-sub">共 ${allWeekTasks.length} 条 · ${fmtMin(weekTaskTotalMin)}</div></div>
      </div>
      ${allWeekTasks.length === 0
      ? '<div class="empty-state"><p>本周暂无任务记录</p></div>'
      : `${taskFilterHtml('week', allWeekTasks)}
        <div class="table-wrap" style="max-height:520px">
          <table>
            <thead><tr>
              <th>日期</th><th>任务名称</th><th>活动类型</th><th>时长</th><th>数量</th><th>效率</th><th>正确率</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${filterTasksByView(allWeekTasks, 'week').map(t => {
        const rate = t.quantity && t.minutes ? (Number(t.quantity) / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        return `<tr>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${t._date}';showTab('day')">${formatShort(t._date)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}</td>
              <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
              <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
              <td class="fw-mono">${t.quantity ? t.quantity + (t.quantityUnit ? ' ' + t.quantityUnit : '') : '-'}</td>
              <td class="fw-mono">${rate ? rate + (t.quantityUnit ? ' ' + t.quantityUnit + '/min' : '/min') : '-'}</td>
              <td class="fw-mono ${t.accuracy >= 80 ? 'c-green' : t.accuracy >= 60 ? 'c-wake' : t.accuracy ? 'c-red' : ''}">${t.accuracy != null && t.accuracy !== '' ? t.accuracy + '%' : '-'}</td>
              <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
              <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="monthEditTask('${t._date}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="weekDeleteTask('${t._date}','${t.id}')">删除</button></td>
            </tr>`;
      }).join('')}</tbody>
            <tfoot><tr>
              <td colspan="3">合计</td>
              <td class="fw-mono">${fmtMin(filterTasksByView(allWeekTasks, 'week').reduce((s, t) => s + (Number(t.minutes) || 0), 0), true)}</td>
              <td colspan="5"></td>
            </tr></tfoot>
          </table>
        </div>`}
    </div>

    <!-- ⏱ 本周专注时段 -->
    <div class="card entry-table-card" style="margin-top:16px">
      <div class="card-header">
        <div><div class="card-title">⏱ 本周专注时段</div><div class="card-sub">共 ${allWeekSessions.length} 段 · 时钟 ${fmtMin(weekSessTotalClock)} · 实际 ${fmtMin(weekSessTotalActual)}</div></div>
      </div>
      ${allWeekSessions.length === 0
      ? '<div class="empty-state"><p>本周暂无专注时段</p></div>'
      : `<div class="table-wrap" style="max-height:520px">
          <table>
            <thead><tr>
              <th>日期</th><th>类型</th><th>开始</th><th>结束</th>
              <th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th>
              <th>休息${tipIcon('rest')}</th><th>效率${tipIcon('efficiency')}</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${allWeekSessions.map(sess => {
        const cl = sessionClock(sess);
        const isSpec = isUnavailableSession(sess);
        const isSpecialStudy = isSpecialStudySession(sess);
        const typeMeta = sessionTypeMeta(sess);
        const actual = Number(sess.actualMinutes) || 0;
        const rest = Number(sess.restMinutes) || 0;
        const eff = (!isSpec && !isSpecialStudy && (cl - rest) > 0) ? Math.round(actual / (cl - rest) * 100) : null;
        return `<tr${typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${sess._date}';showTab('day')">${formatShort(sess._date)}</td>
              <td>${isSpec || isSpecialStudy ? `<span style="font-size:10px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 6px;border-radius:3px">${escHtmlApp(typeMeta.label)}</span>` : '普通'}</td>
              <td class="fw-mono">${sess.startTime || '-'}</td><td class="fw-mono">${sess.endTime || '-'}</td>
              <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
              <td class="fw-mono c-nominal">${isSpec || isSpecialStudy ? '-' : fmtMin(Number(sess.nominalMinutes) || 0, true)}</td>
              <td class="fw-mono c-actual">${isSpec ? '-' : fmtMin(actual, true)}</td>
              <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
              <td class="fw-mono ${eff >= 80 ? 'c-green' : eff >= 60 ? 'c-wake' : eff != null ? 'c-red' : ''}">${eff != null ? eff + '%' : '-'}</td>
              <td class="c-muted" style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sess.note || ''}</td>
              <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="weekEditSession('${sess._date}','${sess.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="weekDeleteSession('${sess._date}','${sess.id}')">删除</button></td>
            </tr>`;
      }).join('')}</tbody>
          </table>
        </div>`}
    </div>
  `;

  const labels = dayStats.map(d => formatShort(d.dateStr));
  mkChart('weekThreeChart', {
    type: 'line', data: {
      labels, datasets: [
        { label: '时钟', data: dayStats.map(d => +(d.clockMin / 60).toFixed(2)), borderColor: '#80deea', backgroundColor: 'rgba(128,222,234,.15)', borderWidth: 1.5, borderDash: [4, 4], pointRadius: 2, tension: .3, fill: 'origin' },
        { label: '有效时钟', data: dayStats.map(d => +(d.effectiveClockMin / 60).toFixed(2)), borderColor: '#80deea', backgroundColor: 'rgba(128,222,234,.2)', borderWidth: 1.5, pointRadius: 3, tension: .3, fill: 'origin' },
        { label: '名义', data: dayStats.map(d => +(d.nominalMin / 60).toFixed(2)), borderColor: '#4fc3f7', backgroundColor: 'rgba(79,195,247,.2)', borderWidth: 1.5, pointRadius: 3, tension: .3, fill: 'origin' },
        { label: '实际', data: dayStats.map(d => +(d.actualMin / 60).toFixed(2)), borderColor: '#69f0ae', backgroundColor: 'rgba(105,240,174,.25)', borderWidth: 2, pointRadius: 3, tension: .3, fill: 'origin' },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#6b7a9e' } }, filler: { propagate: false },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60))}`; } } }
      },
      scales: { x: { ticks: { color: '#6b7a9e' }, grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, title: { display: true, text: '小时', color: '#6b7a9e' }, min: 0 } }
    }
  });

  const weekActMin = {};
  dayStats.forEach(d => Object.keys(d.actMin || {}).forEach(k => weekActMin[k] = (weekActMin[k] || 0) + d.actMin[k]));
  const actDataW = Object.keys(weekActMin).filter(k => weekActMin[k] > 0);
  if (actDataW.length > 0) {
    mkChart('weekCatChart', {
      type: 'doughnut',
      data: { labels: actDataW, datasets: [{ data: actDataW.map(k => weekActMin[k]), backgroundColor: actDataW.map(k => getActColor(k).color + 'cc'), borderColor: actDataW.map(k => getActColor(k).color), borderWidth: 1 }] },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)}` } } } }
    });
  }

  mkChart('weekEffChart', {
    type: 'bar', data: {
      labels, datasets: [{
        label: '专注效率%',
        data: dayStats.map(d => d.focusEfficiency || 0),
        backgroundColor: dayStats.map(d => (d.focusEfficiency || 0) >= 80 ? 'rgba(105,240,174,.4)' : (d.focusEfficiency || 0) >= 60 ? 'rgba(255,213,79,.4)' : 'rgba(244,67,54,.3)'),
        borderColor: dayStats.map(d => (d.focusEfficiency || 0) >= 80 ? '#69f0ae' : (d.focusEfficiency || 0) >= 60 ? '#ffd54f' : '#f44336'),
        borderWidth: 1.5, borderRadius: 3
      }]
    },
    options: {
      responsive: true, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#6b7a9e' }, grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + '%' }, grid: gridCfg, min: 0, max: 100 } }
    }
  });
}
function weekNav(n) { state.weekStart = addDays(state.weekStart, n); renderWeekOverview(); }
function weekGoToday() { state.weekStart = getMondayOfDate(new Date()); renderWeekOverview(); }
function weekSelectDay(d) { state.selectedDate = d; showTab('day'); }

// ============================================================
// MONTH OVERVIEW TAB
// ============================================================
function renderMonthOverview() {
  const { year, month } = state.monthView;
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const lastDay = new Date(year, month + 1, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => {
    const m = String(month + 1).padStart(2, '0'), d = String(i + 1).padStart(2, '0');
    return `${year}-${m}-${d}`;
  });
  const { days: dayStats, totals } = computeRange(dates);
  const activeDays = dayStats.filter(d => d.clockMin > 0 || d.taskMin > 0);

  // 月度统计指标
  const moStatsClock = calcStats(dayStats.map(d => d.clockMin));
  const moStatsActual = calcStats(dayStats.map(d => d.actualMin));
  const moStatsNominal = calcStats(dayStats.map(d => d.nominalMin));
  const moStatsRest = calcStats(dayStats.map(d => d.restMin));
  const moStatsTask = calcStats(dayStats.map(d => d.taskMin));
  const moStatsEffClock = calcStats(dayStats.map(d => d.effectiveClockMin));
  const mActMin = {};
  dayStats.forEach(d => Object.keys(d.actMin || {}).forEach(k => mActMin[k] = (mActMin[k] || 0) + d.actMin[k]));
  const actDataM = Object.keys(mActMin).filter(k => mActMin[k] > 0);

  // 收集本月所有任务（带日期信息）
  const allMonthTasks = [];
  dates.forEach(dateStr => {
    const day = getDay(dateStr);
    (day.tasks || []).forEach(t => {
      allMonthTasks.push({ ...t, _date: dateStr });
    });
  });
  const monthTaskTotalMin = allMonthTasks.reduce((s, t) => s + (Number(t.minutes) || 0), 0);

  // 收集本月所有专注时段
  const allMonthSessions = [];
  dates.forEach(dateStr => {
    const day = getDay(dateStr);
    (day.sessions || []).forEach(s => { allMonthSessions.push({ ...s, _date: dateStr }); });
  });
  const monthSessTotalClock = allMonthSessions.reduce((s, sess) => s + sessionClock(sess), 0);
  const monthSessTotalActual = allMonthSessions.filter(s => s.type !== 'special').reduce((s, sess) => s + (Number(sess.actualMinutes) || 0), 0);

  document.getElementById('tab-month').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="monthNav(-1)">← 上月</button>
      <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--hp)">${year}年 ${monthNames[month]}</span>
      <button class="btn btn-ghost btn-sm" onclick="monthNav(1)">下月 →</button>
      <button class="btn btn-ghost btn-sm" onclick="monthGoToday()">本月</button>
    </div>

    <div class="mini-grid" style="margin-bottom:16px">
      <div class="mini-card"><div class="lbl">有效天数</div><div class="val" style="color:var(--hp)">${activeDays.length}<span style="font-size:12px;opacity:.6">/${lastDay}天</span></div></div>
      <div class="mini-card"><div class="lbl">总时钟${tipIcon('clock')}</div><div class="val c-clock">${fmtHrs(totals.clockMin)}</div><div class="sub">休息 ${fmtMin(totals.restMin)} · 日均 ${fmtMin(totals.avgClock)} · CV ${fmtCV(moStatsClock.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总有效时钟${tipIcon('effectiveClock')}</div><div class="val c-clock">${fmtHrs(totals.effectiveClockMin)}</div><div class="sub">日均 ${fmtMin(totals.avgEffClock)} · CV ${fmtCV(moStatsEffClock.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总名义${tipIcon('nominal')}</div><div class="val c-nominal">${fmtHrs(totals.nominalMin)}</div><div class="sub">日均 ${fmtMin(totals.avgNominal)} · CV ${fmtCV(moStatsNominal.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总实际专注${tipIcon('actual')}</div><div class="val c-actual">${fmtHrs(totals.actualMin)}</div><div class="sub">日均 ${fmtMin(totals.avgActual)} · CV ${fmtCV(moStatsActual.cv)}</div></div>
      <div class="mini-card"><div class="lbl">总任务时长${tipIcon('taskMin')}</div><div class="val" style="color:var(--word)">${fmtHrs(totals.taskMin)}</div><div class="sub">日均 ${fmtMin(totals.avgTask)} · CV ${fmtCV(moStatsTask.cv)}</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">每日三维时间趋势</div>
        <div class="chart-sub">填充折线图 · 时钟（虚线）/ 有效时钟 / 名义（蓝）/ 实际（绿）</div>
        <canvas id="monthThreeChart" height="80"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">月度类别分布</div>
        <div class="chart-sub">各类别累计时长</div>
        <canvas id="monthCatChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">每日实际专注分布</div>
        <div class="chart-sub">实际专注时长柱状图</div>
        <canvas id="monthActualChart" height="200"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">月度每日汇总表</div>
        <div class="chart-sub">点击行跳转日览</div>
        <div class="table-wrap" style="max-height:480px">
          <table>
            <thead><tr>
              <th>日期</th><th>起床</th><th>睡觉</th>
              <th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-clock">有效${tipIcon('effectiveClock')}</th><th>休息${tipIcon('rest')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th>
              <th>偏差率${tipIcon('deviation')}</th><th>效率${tipIcon('efficiency')}</th><th>利用率${tipIcon('util')}</th><th>评价</th>
            </tr></thead>
            <tbody>
              ${dayStats.filter(d => d.clockMin > 0 || d.taskMin > 0 || state.data[d.dateStr]?.wakeTime).map(d => {
    const dayObj = getDay(d.dateStr);
    let sc = 0;
    if (d.actualMin >= 480) sc++;
    if (d.actualVsNominal != null && d.actualVsNominal >= -10) sc++;
    if (dayObj.wakeTime && parseMin(dayObj.wakeTime) <= 8 * 60) sc++;
    if (d.utilPct != null && d.utilPct >= 50) sc++;
    const rating = dayObj.excludeFromRating ? '<span class="c-muted">不评分</span>' : sc >= 3 ? '⭐' : sc >= 2 ? '👌' : sc >= 1 ? '⚠️' : '';
    return `<tr style="cursor:pointer" onclick="state.selectedDate='${d.dateStr}';showTab('day')">
                  <td class="fw-mono">${formatShort(d.dateStr)}</td>
                  <td class="fw-mono c-wake">${dayObj.wakeTime || '-'}</td>
                  <td class="fw-mono c-sleep">${dayObj.sleepTime || '-'}</td>
                  <td class="fw-mono c-clock">${fmtMin(d.clockMin, true)}</td>
                  <td class="fw-mono c-clock">${fmtMin(d.effectiveClockMin, true)}</td>
                  <td class="fw-mono">${fmtMin(d.restMin, true)}</td>
                  <td class="fw-mono c-nominal">${fmtMin(d.nominalMin, true)}</td>
                  <td class="fw-mono c-actual">${fmtMin(d.actualMin, true)}</td>
                  <td class="fw-mono ${devClass(d.actualVsNominal)}">${devStr(d.actualVsNominal)}</td>
                  <td class="fw-mono ${d.focusEfficiency >= 80 ? 'c-green' : d.focusEfficiency >= 60 ? 'c-wake' : 'c-red'}">${d.focusEfficiency != null ? d.focusEfficiency + '%' : '-'}</td>
                  <td class="fw-mono ${d.utilPct >= 50 ? 'c-green' : d.utilPct >= 30 ? 'c-wake' : 'c-red'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
                  <td>${rating}</td>
                </tr>`;
  }).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="3">月合计</td>
              <td class="c-clock">${fmtMin(totals.clockMin, true)}</td>
              <td class="c-clock">${fmtMin(totals.effectiveClockMin, true)}</td>
              <td>${fmtMin(totals.restMin, true)}</td>
              <td class="c-nominal">${fmtMin(totals.nominalMin, true)}</td>
              <td class="c-actual">${fmtMin(totals.actualMin, true)}</td>
              <td class="${devClass(totals.actualVsNominal)}">${devStr(totals.actualVsNominal)}</td>
              <td class="${totals.focusEfficiency >= 80 ? 'c-green' : totals.focusEfficiency >= 60 ? 'c-wake' : 'c-red'}">${totals.focusEfficiency != null ? totals.focusEfficiency + '%' : '-'}</td>
              <td colspan="2"></td>
            </tr><tr style="color:var(--muted)">
              <td colspan="3">日均 (${totals.daysWithData}天)</td>
              <td>${fmtMin(totals.avgClock)}</td>
              <td>${fmtMin(totals.avgEffClock)}</td>
              <td>${fmtMin(totals.avgRest)}</td>
              <td>${fmtMin(totals.avgNominal)}</td>
              <td>${fmtMin(totals.avgActual)}</td>
              <td colspan="4"></td>
            </tr><tr style="color:var(--dim);font-size:11px">
              <td colspan="3">σ${tipIcon('stdDev')} / CV${tipIcon('cv')}</td>
              <td>${fmtSD(moStatsClock.stdDev)} / ${fmtCV(moStatsClock.cv)}</td>
              <td>${fmtSD(moStatsEffClock.stdDev)} / ${fmtCV(moStatsEffClock.cv)}</td>
              <td>${fmtSD(moStatsRest.stdDev)} / ${fmtCV(moStatsRest.cv)}</td>
              <td>${fmtSD(moStatsNominal.stdDev)} / ${fmtCV(moStatsNominal.cv)}</td>
              <td>${fmtSD(moStatsActual.stdDev)} / ${fmtCV(moStatsActual.cv)}</td>
              <td colspan="4"></td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>

    <!-- 📝 月度任务记录汇总 -->
    <div class="card entry-table-card" style="margin-top:16px">
      <div class="card-header">
        <div><div class="card-title">📝 本月任务记录</div><div class="card-sub">共 ${allMonthTasks.length} 条 · ${fmtMin(monthTaskTotalMin)}</div></div>
      </div>
      ${allMonthTasks.length === 0
      ? '<div class="empty-state"><p>本月暂无任务记录</p></div>'
      : `${taskFilterHtml('month', allMonthTasks)}
        <div class="table-wrap" style="max-height:520px">
          <table>
            <thead><tr>
              <th>日期</th><th>任务名称</th><th>活动类型</th><th>时长</th><th>数量</th><th>效率</th><th>正确率</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${filterTasksByView(allMonthTasks, 'month').map(t => {
        const rate = t.quantity && t.minutes ? (Number(t.quantity) / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        return `<tr>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${t._date}';showTab('day')">${formatShort(t._date)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}</td>
              <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
              <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
              <td class="fw-mono">${t.quantity ? t.quantity + (t.quantityUnit ? ' ' + t.quantityUnit : '') : '-'}</td>
              <td class="fw-mono">${rate ? rate + (t.quantityUnit ? ' ' + t.quantityUnit + '/min' : '/min') : '-'}</td>
              <td class="fw-mono ${t.accuracy >= 80 ? 'c-green' : t.accuracy >= 60 ? 'c-wake' : t.accuracy ? 'c-red' : ''}">${t.accuracy != null && t.accuracy !== '' ? t.accuracy + '%' : '-'}</td>
              <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
              <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="monthEditTask('${t._date}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="monthDeleteTask('${t._date}','${t.id}')">删除</button></td>
            </tr>`;
      }).join('')}</tbody>
            <tfoot><tr>
              <td colspan="3">合计</td>
              <td class="fw-mono">${fmtMin(filterTasksByView(allMonthTasks, 'month').reduce((s, t) => s + (Number(t.minutes) || 0), 0), true)}</td>
              <td colspan="5"></td>
            </tr></tfoot>
          </table>
        </div>`}
    </div>

    <!-- ⏱ 本月专注时段 -->
    <div class="card entry-table-card" style="margin-top:16px">
      <div class="card-header">
        <div><div class="card-title">⏱ 本月专注时段</div><div class="card-sub">共 ${allMonthSessions.length} 段 · 时钟 ${fmtMin(monthSessTotalClock)} · 实际 ${fmtMin(monthSessTotalActual)}</div></div>
      </div>
      ${allMonthSessions.length === 0
      ? '<div class="empty-state"><p>本月暂无专注时段</p></div>'
      : `<div class="table-wrap" style="max-height:520px">
          <table>
            <thead><tr>
              <th>日期</th><th>类型</th><th>开始</th><th>结束</th>
              <th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th>
              <th>休息${tipIcon('rest')}</th><th>效率${tipIcon('efficiency')}</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${allMonthSessions.map(sess => {
        const cl = sessionClock(sess);
        const isSpec = isUnavailableSession(sess);
        const isSpecialStudy = isSpecialStudySession(sess);
        const typeMeta = sessionTypeMeta(sess);
        const actual = Number(sess.actualMinutes) || 0;
        const rest = Number(sess.restMinutes) || 0;
        const eff = (!isSpec && !isSpecialStudy && (cl - rest) > 0) ? Math.round(actual / (cl - rest) * 100) : null;
        return `<tr${typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${sess._date}';showTab('day')">${formatShort(sess._date)}</td>
              <td>${isSpec || isSpecialStudy ? `<span style="font-size:10px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 6px;border-radius:3px">${escHtmlApp(typeMeta.label)}</span>` : '普通'}</td>
              <td class="fw-mono">${sess.startTime || '-'}</td><td class="fw-mono">${sess.endTime || '-'}</td>
              <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
              <td class="fw-mono c-nominal">${isSpec || isSpecialStudy ? '-' : fmtMin(Number(sess.nominalMinutes) || 0, true)}</td>
              <td class="fw-mono c-actual">${isSpec ? '-' : fmtMin(actual, true)}</td>
              <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
              <td class="fw-mono ${eff >= 80 ? 'c-green' : eff >= 60 ? 'c-wake' : eff != null ? 'c-red' : ''}">${eff != null ? eff + '%' : '-'}</td>
              <td class="c-muted" style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sess.note || ''}</td>
              <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="monthEditSession('${sess._date}','${sess.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="monthDeleteSession('${sess._date}','${sess.id}')">删除</button></td>
            </tr>`;
      }).join('')}</tbody>
          </table>
        </div>`}
    </div>
  `;

  const labels = dayStats.map(d => formatShort(d.dateStr));
  mkChart('monthThreeChart', {
    type: 'line', data: {
      labels, datasets: [
        { label: '时钟', data: dayStats.map(d => +(d.clockMin / 60).toFixed(2)), borderColor: '#80deea', backgroundColor: 'rgba(128,222,234,.12)', borderWidth: 1, borderDash: [4, 4], pointRadius: 1, tension: .3, fill: 'origin' },
        { label: '有效时钟', data: dayStats.map(d => +(d.effectiveClockMin / 60).toFixed(2)), borderColor: '#80deea', backgroundColor: 'rgba(128,222,234,.18)', borderWidth: 1.5, pointRadius: 2, tension: .3, fill: 'origin' },
        { label: '名义', data: dayStats.map(d => +(d.nominalMin / 60).toFixed(2)), borderColor: '#4fc3f7', backgroundColor: 'rgba(79,195,247,.18)', borderWidth: 1.5, pointRadius: 2, tension: .3, fill: 'origin' },
        { label: '实际', data: dayStats.map(d => +(d.actualMin / 60).toFixed(2)), borderColor: '#69f0ae', backgroundColor: 'rgba(105,240,174,.22)', borderWidth: 2, pointRadius: 2, tension: .3, fill: 'origin' },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#6b7a9e' } }, filler: { propagate: false },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60))}`; } } }
      },
      scales: { x: { ticks: { color: '#6b7a9e', maxRotation: 45 }, grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, title: { display: true, text: '小时', color: '#6b7a9e' }, min: 0 } }
    }
  });

  if (actDataM.length > 0) {
    mkChart('monthCatChart', {
      type: 'doughnut',
      data: { labels: actDataM, datasets: [{ data: actDataM.map(k => mActMin[k]), backgroundColor: actDataM.map(k => getActColor(k).color + 'cc'), borderColor: actDataM.map(k => getActColor(k).color), borderWidth: 1 }] },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)}` } } } }
    });
  }

  mkChart('monthActualChart', {
    type: 'bar', data: {
      labels, datasets: [
        {
          label: '实际专注(h)', data: dayStats.map(d => +(d.actualMin / 60).toFixed(2)),
          backgroundColor: dayStats.map(d => d.actualMin >= 480 ? 'rgba(105,240,174,.5)' : d.actualMin >= 300 ? 'rgba(79,195,247,.4)' : d.actualMin > 0 ? 'rgba(255,183,77,.4)' : 'rgba(120,144,156,.2)'),
          borderColor: dayStats.map(d => d.actualMin >= 480 ? '#69f0ae' : d.actualMin >= 300 ? '#4fc3f7' : d.actualMin > 0 ? '#ffb74d' : '#78909c'),
          borderWidth: 1, borderRadius: 3
        },
        { type: 'line', label: '目标8h', data: dayStats.map(() => 8), borderColor: 'rgba(105,240,174,.3)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true, plugins: { legend: { labels: { color: '#6b7a9e' } } },
      scales: { x: { ticks: { color: '#6b7a9e', maxRotation: 45 }, grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, min: 0 } }
    }
  });
}
function monthNav(n) {
  state.monthView.month += n;
  if (state.monthView.month < 0) { state.monthView.month = 11; state.monthView.year--; }
  if (state.monthView.month > 11) { state.monthView.month = 0; state.monthView.year++; }
  renderMonthOverview();
}
function monthGoToday() { const d = new Date(); state.monthView = { year: d.getFullYear(), month: d.getMonth() }; renderMonthOverview(); }

function monthEditTask(dateStr, taskId) {
  state.selectedDate = dateStr;
  state._editingTaskId = taskId;
  showTab('entry');
  // editTask will be triggered after render
  setTimeout(() => editTask(dateStr, taskId), 100);
}

async function monthDeleteTask(dateStr, taskId) {
  if (!confirm('确定删除该任务？')) return;
  const day = getDay(dateStr);
  day.tasks = day.tasks.filter(t => t.id !== taskId);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/tasks/${taskId}`, { method: 'DELETE' });
  renderMonthOverview();
  renderHeader();
}

// ============================================================
// SLEEP TAB
// ============================================================
function renderSleep() {
  const dates = getAllDates().filter(d => state.data[d]?.wakeTime);
  const sleepDays = dates.map(dateStr => {
    const day = state.data[dateStr];
    const wakeMin = parseMin(day.wakeTime);
    const sleepMin = parseMin(day.sleepTime);
    let awakeMin = null;
    if (wakeMin != null && sleepMin != null) {
      // 修正12小时制输入：如果睡觉时间为12:00-12:59，视为00:00-00:59（次日凌晨）
      let adjSleepMin = sleepMin;
      if (adjSleepMin >= 720 && adjSleepMin < 780) adjSleepMin -= 720;
      awakeMin = adjSleepMin - wakeMin;
      if (awakeMin <= 0) awakeMin += 1440;
    }
    const nextDate = addDays(dateStr, 1);
    const nextDay = state.data[nextDate];
    let sleepDur = null;
    if (sleepMin != null && nextDay?.wakeTime) {
      const nextWakeMin = parseMin(nextDay.wakeTime);
      sleepDur = 1440 - sleepMin + nextWakeMin;
    }
    const stats = computeDay(dateStr);
    return { dateStr, wakeTime: day.wakeTime, sleepTime: day.sleepTime, wakeMin, sleepMin, awakeMin, sleepDur, actualMin: stats.actualMin, utilPct: stats.utilPct };
  });

  document.getElementById('tab-sleep').innerHTML = `
    <div class="mini-grid" style="margin-bottom:16px">
      <div class="mini-card"><div class="lbl">记录天数</div><div class="val c-hp">${sleepDays.length}</div></div>
      <div class="mini-card"><div class="lbl">平均起床</div><div class="val c-wake">${sleepDays.length ? avgTime(sleepDays.map(d => d.wakeMin).filter(x => x != null)) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均睡觉</div><div class="val c-sleep">${sleepDays.length ? avgTime(sleepDays.map(d => d.sleepMin).filter(x => x != null)) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均清醒</div><div class="val" style="color:var(--muted)">${sleepDays.filter(d => d.awakeMin != null).length ? fmtMin(Math.round(sleepDays.filter(d => d.awakeMin != null).reduce((s, d) => s + d.awakeMin, 0) / sleepDays.filter(d => d.awakeMin != null).length)) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均利用率</div><div class="val c-pol">${sleepDays.filter(d => d.utilPct != null).length ? Math.round(sleepDays.filter(d => d.utilPct != null).reduce((s, d) => s + d.utilPct, 0) / sleepDays.filter(d => d.utilPct != null).length) + '%' : '-'}</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">起床 & 睡觉时间趋势</div>
        <div class="chart-sub">黄线=起床 · 紫线=睡觉 · 虚线=目标(7:00起/0:00睡)</div>
        <canvas id="sleepTimelineChart" height="90"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">起床时间分布</div>
        <div class="chart-sub">各时段起床次数</div>
        <canvas id="wakeDistChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">清醒时长 vs 学习时长</div>
        <div class="chart-sub">灰柱=清醒 · 蓝柱=实际专注 · 橙线=利用率%</div>
        <canvas id="awakeStudyChart" height="200"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">作息数据明细</div>
        <div class="chart-sub">包含起床/睡觉/清醒/学习/利用率</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>日期</th><th class="c-wake">起床</th><th class="c-sleep">睡觉</th>
              <th>清醒时长${tipIcon('awake')}</th><th class="c-actual">学习时长${tipIcon('actual')}</th><th>利用率${tipIcon('util')}</th><th>评价</th>
            </tr></thead>
            <tbody>
              ${sleepDays.map(d => {
    const wakeClass = d.wakeMin != null ? (d.wakeMin <= 7 * 60 ? 'c-green' : d.wakeMin <= 8 * 60 ? 'c-wake' : 'c-red') : '';
    const sleepClass = d.sleepMin != null ? (d.sleepMin <= 0 || d.sleepMin >= 23 * 60 ? 'c-green' : d.sleepMin <= 0.5 * 60 || d.sleepMin >= 22.5 * 60 ? 'c-wake' : 'c-red') : '';
    return `<tr>
                  <td class="fw-mono">${formatShort(d.dateStr)}</td>
                  <td class="fw-mono ${wakeClass}">${d.wakeTime || '-'}</td>
                  <td class="fw-mono ${sleepClass}">${d.sleepTime || '-'}</td>
                  <td class="fw-mono">${fmtMin(d.awakeMin)}</td>
                  <td class="fw-mono c-actual">${fmtMin(d.actualMin, true)}</td>
                  <td class="fw-mono ${d.utilPct >= 50 ? 'c-green' : d.utilPct >= 30 ? 'c-wake' : d.utilPct ? 'c-red' : 'c-muted'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
                  <td>${d.wakeMin != null && d.wakeMin <= 7 * 60 ? '🌅' : d.wakeMin != null && d.wakeMin <= 8 * 60 ? '☀️' : d.wakeMin != null ? '😴' : '-'}</td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  if (sleepDays.length === 0) return;

  const labels = sleepDays.map(d => formatShort(d.dateStr));
  // ── 作息时间趋势图：X轴=日期序号，Y轴=时间（支持超24小时避免跳跃） ──
  (function () {
    const wakeData = [];
    const sleepData = [];
    const wakeColors = [];
    const sleepColors = [];
    const goalWakeData = [];
    const goalSleepData = [];

    sleepDays.forEach((d, i) => {
      const label = formatShort(d.dateStr);

      // 起床时间点：Y = 小时数
      if (d.wakeMin != null) {
        const wH = d.wakeMin / 60;
        wakeData.push({ x: i, y: wH, label });
        wakeColors.push(d.wakeMin <= 7 * 60 ? '#69f0ae' : d.wakeMin <= 8 * 60 ? '#ffd54f' : '#f44336');
      }

      // 睡觉时间点：凌晨0-6点视为当天晚上(+24h)，避免跳跃
      // 同时修正12:00-12:59的输入（实为凌晨00:00-00:59）
      if (d.sleepMin != null) {
        let sH = d.sleepMin / 60;
        if (sH >= 12 && sH < 13) sH -= 12; // 12:30 → 0.5 (凌晨00:30)
        if (sH < 6) sH += 24; // 00:30 → 24.5
        sleepData.push({ x: i, y: sH, label });
        const absH = sH >= 24 ? sH - 24 : sH;
        sleepColors.push(absH <= 0.01 ? '#69f0ae' : absH <= 0.5 ? '#ffd54f' : '#f44336');
      }

      // 目标线数据点
      goalWakeData.push({ x: i, y: 7 });
      goalSleepData.push({ x: i, y: 24 });
    });

    // Y轴范围：紧贴数据，留 0.5h 余量
    const allY = [...wakeData.map(p => p.y), ...sleepData.map(p => p.y)];
    const yMin = allY.length ? Math.floor(Math.min(...allY) * 2) / 2 - 0.5 : 5;
    const yMax = allY.length ? Math.ceil(Math.max(...allY) * 2) / 2 + 0.5 : 26;

    /** 将小时数转为 HH:MM 字符串（支持 >24h 自动 mod 24） */
    function hToTime(h) {
      const hh = ((Math.floor(h) % 24) + 24) % 24;
      const mm = Math.round((h - Math.floor(h)) * 60);
      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    mkChart('sleepTimelineChart', {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: '起床', data: wakeData,
            showLine: true, borderColor: '#ffd54f', backgroundColor: 'rgba(255,213,79,.08)',
            borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: wakeColors,
            tension: .3, fill: false
          },
          {
            label: '睡觉', data: sleepData,
            showLine: true, borderColor: '#b388ff', backgroundColor: 'rgba(179,136,255,.08)',
            borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: sleepColors,
            tension: .3, fill: false
          },
          {
            label: '目标起床7:00', data: goalWakeData,
            showLine: true, borderColor: 'rgba(105,240,174,.3)', borderDash: [5, 4],
            borderWidth: 1, pointRadius: 0, fill: false
          },
          {
            label: '目标睡觉0:00', data: goalSleepData,
            showLine: true, borderColor: 'rgba(179,136,255,.3)', borderDash: [5, 4],
            borderWidth: 1, pointRadius: 0, fill: false
          },
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#6b7a9e' } },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const idx = items[0].dataIndex;
                const ds = items[0].dataset;
                const srcArr = ds.label === '起床' ? wakeData : sleepData;
                return srcArr[idx] ? srcArr[idx].label : '';
              },
              label: (item) => `${item.dataset.label}: ${hToTime(item.raw.y)}`
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: '#6b7a9e',
              maxRotation: 45,
              stepSize: 1,
              callback: function (v) {
                const idx = Math.round(v);
                if (idx >= 0 && idx < sleepDays.length && Math.abs(v - idx) < 0.01) {
                  return formatShort(sleepDays[idx].dateStr);
                }
                return '';
              }
            },
            grid: gridCfg,
            min: -0.5,
            max: sleepDays.length - 0.5
          },
          y: {
            type: 'linear',
            reverse: false,
            ticks: {
              color: '#6b7a9e',
              stepSize: 1,
              callback: function (v) { return hToTime(v); }
            },
            grid: gridCfg,
            title: { display: true, text: '时间', color: '#6b7a9e' },
            min: yMin,
            max: yMax
          }
        }
      }
    });
  })();

  const wakeBins = { '7:00前': 0, '7:00-7:59': 0, '8:00-8:59': 0, '9:00-9:59': 0, '10:00+': 0 };
  sleepDays.forEach(d => {
    if (d.wakeMin == null) return;
    const h = d.wakeMin / 60;
    if (h < 7) wakeBins['7:00前']++;
    else if (h < 8) wakeBins['7:00-7:59']++;
    else if (h < 9) wakeBins['8:00-8:59']++;
    else if (h < 10) wakeBins['9:00-9:59']++;
    else wakeBins['10:00+']++;
  });
  mkChart('wakeDistChart', {
    type: 'doughnut', data: {
      labels: Object.keys(wakeBins),
      datasets: [{ data: Object.values(wakeBins), backgroundColor: ['#69f0aecc', '#69f0ae88', '#ffd54fcc', '#ffb74dcc', '#f44336cc'], borderColor: ['#69f0ae', '#69f0ae', '#ffd54f', '#ffb74d', '#f44336'], borderWidth: 1 }]
    },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8 } } } }
  });

  mkChart('awakeStudyChart', {
    type: 'bar', data: {
      labels, datasets: [
        { label: '清醒时长(h)', data: sleepDays.map(d => d.awakeMin != null ? +(d.awakeMin / 60).toFixed(1) : 0), backgroundColor: 'rgba(120,144,156,.3)', borderColor: '#78909c', borderWidth: 1 },
        { label: '实际专注(h)', data: sleepDays.map(d => +(d.actualMin / 60).toFixed(1)), backgroundColor: 'rgba(79,195,247,.35)', borderColor: '#4fc3f7', borderWidth: 1 },
        { type: 'line', label: '利用率%', data: sleepDays.map(d => d.utilPct || 0), borderColor: '#ffb74d', borderWidth: 2, pointRadius: 4, pointBackgroundColor: sleepDays.map(d => (d.utilPct || 0) >= 50 ? '#69f0ae' : (d.utilPct || 0) >= 30 ? '#ffd54f' : '#f44336'), tension: .3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true, plugins: { legend: { labels: { color: '#6b7a9e' } } },
      scales: { x: { ticks: { color: '#6b7a9e', maxRotation: 45 }, grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, position: 'left' }, y1: { ticks: { color: '#ffb74d', callback: v => v + '%' }, grid: { drawOnChartArea: false }, position: 'right', min: 0, max: 100 } }
    }
  });
}
function avgTime(minutes) {
  if (!minutes.length) return '-';
  const avg = Math.round(minutes.reduce((s, v) => s + v, 0) / minutes.length);
  return `${Math.floor(avg / 60).toString().padStart(2, '0')}:${(avg % 60).toString().padStart(2, '0')}`;
}

// ============================================================
// EXPORT TAB
// ============================================================
function renderExport() {
  const dates = getAllDates();
  const firstDate = dates.length ? dates[0] : getTodayStr();
  const lastDate = dates.length ? dates[dates.length - 1] : getTodayStr();

  document.getElementById('tab-export').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:800px">
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">💾 导出数据 (JSON)</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">将所有数据导出为 JSON 文件，可保存到 OneDrive</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="downloadJSON()">📥 下载 JSON</button>
          <button class="btn btn-ghost" onclick="copyJSON()">📋 复制到剪贴板</button>
        </div>
        <div style="margin-top:12px;font-family:var(--mono);font-size:11px;color:var(--muted)">
          记录天数: ${dates.length} 天 · 数据大小: ~${Math.round(JSON.stringify(state.data).length / 1024)} KB
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">📤 导入数据 (JSON)</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">从 JSON 文件导入，可从 OneDrive 选取</p>
        <div class="import-drop" onclick="document.getElementById('importFile').click()">
          <div style="font-size:24px">📁</div>
          <p>点击选择 JSON 文件</p>
        </div>
        <input type="file" id="importFile" accept=".json" style="display:none" onchange="importJSON(this)">
        <p style="font-size:11px;color:var(--dim);margin-top:8px">导入将合并已有数据（相同日期会被覆盖）</p>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">🖨️ 打印报告</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">选择日期范围打印</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-group"><label>开始日期</label><input type="date" id="printFrom" value="${firstDate}"></div>
          <div class="form-group"><label>结束日期</label><input type="date" id="printTo" value="${lastDate}"></div>
        </div>
        <button class="btn btn-primary" style="margin-top:4px" onclick="window.print()">🖨️ 打印/导出PDF</button>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">📄 导出 HTML 报告</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">生成独立 HTML 文件，内含完整图表，浏览器直接打开即可查看（无需后端）</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-group"><label>开始日期</label><input type="date" id="htmlFrom" value="${firstDate}"></div>
          <div class="form-group"><label>结束日期</label><input type="date" id="htmlTo" value="${lastDate}"></div>
        </div>
        <button class="btn btn-success" style="margin-top:4px" onclick="exportHTMLReport()">📄 下载 HTML 报告</button>
      </div>


    </div>
    <div id="exportStatus" style="margin-top:12px;font-family:var(--mono);font-size:12px;color:var(--pol)"></div>
  `;
}

async function copyJSON() {
  await navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
  document.getElementById('exportStatus').textContent = '✅ 已复制到剪贴板';
}

function downloadJSON() {
  try {
    const content = JSON.stringify(state.data, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const today = getTodayStr();
    const a = document.createElement('a');
    a.href = url;
    a.download = `学习数据_${today}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById('exportStatus').textContent = '✅ JSON 文件已下载';
  } catch (e) {
    console.error('下载失败', e);
    document.getElementById('exportStatus').textContent = '❌ 下载失败: ' + e.message;
  }
}

async function importJSON(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const imported = JSON.parse(e.target.result);
      Object.assign(state.data, imported);
      cacheToLocal();
      await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) });
      renderExport(); renderHeader();
      document.getElementById('exportStatus').textContent = `✅ 导入成功！合并了 ${Object.keys(imported).length} 天的数据`;
    } catch { alert('JSON 格式错误，请检查文件'); }
  };
  reader.readAsText(file);
}

async function clearRecordData() {
  if (confirm('确定清空所有已录入数据（时段、任务、作息记录）？\n模板库、活动分类、AI配置等将保留。\n此操作不可恢复！')) {
    const preserved = {};
    Object.keys(state.data).forEach(k => {
      if (k.startsWith('__')) preserved[k] = state.data[k];
    });
    state.data = preserved;
    cacheToLocal();
    await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) });
    renderHeader(); renderSettings();
    const msg = document.getElementById('settings-danger-msg');
    if (msg) { msg.textContent = '🗑️ 已录入数据已清空（模板/分类已保留）'; msg.style.color = 'var(--pol)'; setTimeout(() => msg.textContent = '', 4000); }
  }
}

async function clearAllData() {
  if (confirm('确定清空所有数据（包括模板、分类等）？此操作不可恢复！')) {
    state.data = {};
    cacheToLocal();
    await apiFetch('/api/data', { method: 'POST', body: JSON.stringify({}) });
    renderHeader(); renderExport();
    document.getElementById('exportStatus').textContent = '🗑️ 数据已清空';
  }
}

// ============================================================
// HTML REPORT EXPORT
// ============================================================
function exportHTMLReport() {
  const fromDate = document.getElementById('htmlFrom')?.value;
  const toDate = document.getElementById('htmlTo')?.value;
  if (!fromDate || !toDate) { alert('请选择日期范围'); return; }
  if (fromDate > toDate) { alert('开始日期不能晚于结束日期'); return; }

  // 收集日期范围内的数据
  const exportData = {};
  const allDates = [];
  const cur = new Date(fromDate);
  const end = new Date(toDate);
  while (cur <= end) {
    const ds = dateToStr(cur);
    const day = state.data[ds];
    if (day && ((day.sessions && day.sessions.length) || (day.tasks && day.tasks.length) || day.wakeTime || day.sleepTime)) {
      exportData[ds] = JSON.parse(JSON.stringify(day));
    }
    allDates.push(ds);
    cur.setDate(cur.getDate() + 1);
  }

  const datesWithData = Object.keys(exportData).sort();
  if (datesWithData.length === 0) {
    alert('所选日期范围内没有数据');
    return;
  }

  const dataJSON = JSON.stringify(exportData);
  const title = fromDate.slice(0, 7) === toDate.slice(0, 7)
    ? fromDate.slice(0, 4) + '年' + parseInt(fromDate.slice(5, 7)) + '月 学习数据报告'
    : fromDate + ' — ' + toDate + ' 学习数据报告';

  // 收集活动类别颜色映射
  const actColorMap = {};
  const ACT_COLORS_EXPORT = [
    '#69f0ae', '#4fc3f7', '#ce93d8', '#ffb74d', '#ef9a9a',
    '#78909c', '#80deea', '#b388ff', '#ffd54f'
  ];
  const l1Names = getLevel1Names();
  l1Names.forEach((name, i) => {
    actColorMap[name] = ACT_COLORS_EXPORT[i % ACT_COLORS_EXPORT.length];
  });

  const html = buildReportHTML(title, fromDate, toDate, dataJSON, JSON.stringify(actColorMap));

  // 下载
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/\s/g, '_') + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const st = document.getElementById('exportStatus');
  if (st) { st.textContent = '✅ HTML 报告已下载'; st.style.color = 'var(--pol)'; }
}

function buildReportHTML(title, fromDate, toDate, dataJSON, colorMapJSON) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
:root{--bg:#07090f;--bg2:#0d1018;--card:#111520;--card2:#161b2a;--border:#1e2438;--border2:#2a3050;--text:#dce4f5;--muted:#6b7a9e;--dim:#3d4a6a;--hp:#4fc3f7;--pol:#69f0ae;--word:#ce93d8;--thesis:#ffb74d;--code:#ef9a9a;--other:#78909c;--red:#f44336;--green:#66bb6a;--sleep:#b388ff;--wake:#ffd54f;--clock:#80deea;--nominal:#4fc3f7;--actual:#69f0ae;--mono:'Space Mono',monospace;--sans:'Noto Sans SC',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;min-height:100vh;line-height:1.6}
.header{background:linear-gradient(135deg,#0d1018 0%,#111828 50%,#0d1018 100%);border-bottom:1px solid var(--border);padding:24px 32px 20px;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-60px;right:-60px;width:300px;height:300px;background:radial-gradient(circle,rgba(79,195,247,.06) 0%,transparent 70%);pointer-events:none}
.header h1{font-size:22px;font-weight:700;margin-bottom:4px}.header-meta{font-size:12px;color:var(--muted)}
.period-badge{background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:6px 14px;font-family:var(--mono);font-size:13px;color:var(--hp);font-weight:700}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:16px 32px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center}
.stat-label{font-size:11px;color:var(--muted);margin-bottom:3px}.stat-value{font-size:20px;font-weight:700;font-family:var(--mono)}.stat-sub{font-size:9px;color:var(--dim);margin-top:2px}
.tabs-wrapper{display:flex;gap:4px;padding:8px 32px;background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--muted);transition:all .2s;white-space:nowrap;user-select:none}
.tab:hover{background:var(--card);color:var(--text)}.tab.active{background:var(--card2);color:var(--hp);font-weight:500;border:1px solid var(--border2)}
.tab-content{display:none;padding:24px 32px}.tab-content.active{display:block}
.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.chart-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px}.chart-card.full{grid-column:1/-1}
.chart-title{font-size:14px;font-weight:600;margin-bottom:4px}.chart-sub{font-size:11px;color:var(--dim);margin-bottom:12px}
.mini-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.mini-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center}
.mini-card .lbl{font-size:10px;color:var(--muted);margin-bottom:2px}.mini-card .val{font-size:18px;font-weight:700;font-family:var(--mono)}.mini-card .sub{font-size:9px;color:var(--dim);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 10px;border:1px solid var(--border);text-align:center;white-space:nowrap}
th{background:var(--card2);color:var(--muted);font-weight:500;font-size:11px;position:sticky;top:0;z-index:1}td{color:var(--text)}tfoot td{background:var(--card2);font-weight:600}
.table-wrap{overflow-x:auto;max-height:600px;overflow-y:auto;border-radius:8px;border:1px solid var(--border)}
.fw-mono{font-family:var(--mono)}.c-green{color:var(--green)}.c-red{color:var(--red)}.c-wake{color:var(--wake)}.c-hp{color:var(--hp)}
.c-clock{color:var(--clock)}.c-nominal{color:var(--nominal)}.c-actual{color:var(--actual)}.c-muted{color:var(--muted)}
.dev-pos{color:var(--green)}.dev-neg{color:var(--red)}.dev-zero{color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.card-title{font-size:14px;font-weight:600}.card-sub{font-size:11px;color:var(--dim)}
.tip-icon{display:inline-block;cursor:help;font-size:12px;color:var(--dim);margin-left:3px;vertical-align:middle;opacity:.7}.tip-icon:hover{opacity:1;color:var(--hp)}
.global-tip{position:fixed;z-index:9999;max-width:320px;padding:12px 16px;background:var(--card2);border:1px solid var(--border2);border-radius:8px;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-line;box-shadow:0 8px 32px rgba(0,0,0,.5);pointer-events:none;display:none}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:8px}
.cal-hdr{text-align:center;font-size:11px;color:var(--muted);padding:4px 0;font-weight:500}
.cal-day{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:6px 4px;text-align:center;font-size:11px;font-family:var(--mono);min-height:48px}
.cal-day.has-data{border-color:var(--hp);background:rgba(79,195,247,.05)}.cal-day .cal-d{font-weight:600;margin-bottom:2px}.cal-day .cal-v{font-size:10px;color:var(--pol)}
.generated-note{text-align:center;padding:24px;font-size:11px;color:var(--dim);border-top:1px solid var(--border)}
@media(max-width:768px){.stats-grid,.mini-grid{grid-template-columns:1fr 1fr}.chart-grid{grid-template-columns:1fr}.tab-content{padding:16px}}
</style>
</head>
<body>
<div class="header"><div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
<div><h1>\u{1F4CA} ${title}</h1><div class="header-meta">数据报告 \xB7 三维时间分析 \xB7 效率可视化 \xB7 只读模式</div></div>
<div class="period-badge">${fromDate} \u2014 ${toDate}</div></div></div>
<div class="stats-grid" id="statsGrid"></div>
<div class="tabs-wrapper">
  <div class="tab active" onclick="showTab('overview')">\u{1F4CA} 总览</div>
  <div class="tab" onclick="showTab('calendar')">\u{1F4C6} 日历</div>
  <div class="tab" onclick="showTab('sessions')">\u23F1 专注时段</div>
  <div class="tab" onclick="showTab('daily')">\u{1F4CB} 任务记录</div>
  <div class="tab" onclick="showTab('sessAna')">\u23F1 时段分析</div>
  <div class="tab" onclick="showTab('taskAna')">\u{1F4DD} 任务分析</div>
  <div class="tab" onclick="showTab('stacked')">\u{1F4CA} 堆积图</div>
  <div class="tab" onclick="showTab('sleep')">\u{1F319} 作息</div>
</div>
<div class="tab-content active" id="tab-overview"></div>
<div class="tab-content" id="tab-calendar"></div>
<div class="tab-content" id="tab-sessions"></div>
<div class="tab-content" id="tab-daily"></div>
<div class="tab-content" id="tab-sessAna"></div>
<div class="tab-content" id="tab-taskAna"></div>
<div class="tab-content" id="tab-stacked"></div>
<div class="tab-content" id="tab-sleep"></div>
<div class="generated-note">此报告由「学习追踪器」自动生成 \xB7 生成时间：${new Date().toLocaleString('zh-CN')}</div>
<script>
var DATA=${dataJSON},ACT_COLOR_MAP=${colorMapJSON};
var GC='rgba(30,36,56,1)',gridCfg={color:GC},cReg={};
var TIPS={clock:'\u23F1 时钟时长',effectiveClock:'\u23F1 有效时钟=时钟\u2212休息',nominal:'\u{1F4CB} 名义=计划时长',actual:'\u2705 实际=真实专注',efficiency:'\u{1F3AF} 效率=实际/(时钟\u2212休息)',rest:'\u{1F634} 休息',distract:'\u{1F636} 分心=时钟\u2212实际\u2212休息',awake:'\u{1F324} 清醒=睡觉\u2212起床',util:'\u{1F4CA} 利用率=实际/可支配',taskMin:'\u{1F4DD} 任务时长',cv:'\u{1F4CA} CV=\u03C3/\u03BC',stdDev:'\u{1F4CF} \u03C3',stackAwake:'\u{1F324} 清醒',stackTask:'\u{1F4DD} 任务',stackSpecial:'\u{1F538} 特殊',stackRest:'\u{1F634} 休息',stackDistract:'\u{1F636} 分心',stackIdle:'\u2B1C 空闲'};
function tipIcon(k){var t=TIPS[k];if(!t)return '';return '<span class="tip-icon" data-tip="'+t+'" onmouseenter="showTip(event,this)" onmouseleave="hideTip()" onmousemove="moveTip(event)">\u24D8</span>';}
function showTip(e,el){var t=document.getElementById('_gTip');if(!t){t=document.createElement('div');t.id='_gTip';t.className='global-tip';document.body.appendChild(t);}t.textContent=el.dataset.tip;t.style.display='block';moveTip(e);}
function moveTip(e){var t=document.getElementById('_gTip');if(!t||t.style.display==='none')return;t.style.left=Math.min(e.clientX+16,window.innerWidth-300)+'px';t.style.top=Math.min(e.clientY+16,window.innerHeight-120)+'px';}
function hideTip(){var t=document.getElementById('_gTip');if(t)t.style.display='none';}
function destroyChart(id){if(cReg[id]){cReg[id].destroy();delete cReg[id];}}
function mkChart(id,cfg){destroyChart(id);var el=document.getElementById(id);if(!el)return;cReg[id]=new Chart(el,cfg);return cReg[id];}
function parseMin(t){if(!t)return null;var p=t.split(':').map(Number);return p[0]*60+(p[1]||0);}
function fmtMin(m,z){if(m==null||(m===0&&!z))return '-';var s=m<0?'-':'',a=Math.abs(m),h=Math.floor(a/60),n=a%60;if(h===0)return s+n+'m';if(n===0)return s+h+'h';return s+h+'h'+n+'m';}
function fmtHrs(m){return (m/60).toFixed(1)+'h';}
function sessionClock(s){var a=parseMin(s.startTime),b=parseMin(s.endTime);if(a==null||b==null)return 0;var d=b-a;if(d<0)d+=1440;return d;}
function devClass(p){if(p==null)return 'c-muted';return p>5?'dev-pos':p<-5?'dev-neg':'dev-zero';}
function devStr(p){if(p==null)return '-';return(p>=0?'+':'')+p+'%';}
function fmtShort(ds){var p=ds.split('-').map(Number);return p[1]+'/'+p[2];}
function getActColor(n){if(!n)return '#78909c';return ACT_COLOR_MAP[n.split(' > ')[0]]||'#78909c';}
function hexRgba(h,a){if(!h||h[0]!=='#')return 'rgba(120,144,156,'+a+')';return 'rgba('+parseInt(h.slice(1,3),16)+','+parseInt(h.slice(3,5),16)+','+parseInt(h.slice(5,7),16)+','+a+')';}
function calcS(vals){var v=vals.filter(function(x){return x>0;}),n=v.length;if(!n)return{n:0,mean:0,sd:0,cv:null};var m=v.reduce(function(s,x){return s+x;},0)/n;var vr=v.reduce(function(s,x){return s+Math.pow(x-m,2);},0)/n;var sd=Math.sqrt(vr);return{n:n,mean:m,sd:sd,cv:m>0?(sd/m*100).toFixed(1)+'%':'-'};}
function fmtCV(s){return s.cv||'-';}
var SP=['#4fc3f7','#69f0ae','#ce93d8','#ffb74d','#ef9a9a','#80deea','#ffd54f','#a5d6a7','#f48fb1','#90caf9','#b39ddb','#ffcc80','#80cbc4'];
function computeDay(ds){var day=DATA[ds]||{sessions:[],tasks:[]},ss=day.sessions||[],ts=day.tasks||[];var ck=0,study=0,nm=0,ac=0,sp=0,ssc=0,ssa=0,un=0,rs=0,di=0,span=0;ss.forEach(function(s){var sc=sessionClock(s),actual=Number(s.actualMinutes)||0,rest=Number(s.restMinutes)||0;span+=sc;ck+=sc;if(s.type==='special'){sp+=sc;un+=sc;return;}if(s.type==='special-study'){ssc+=sc;ssa+=actual;study+=actual;ac+=actual;un+=Math.max(0,sc-actual);return;}study+=sc;nm+=Number(s.nominalMinutes)||0;ac+=actual;rs+=rest;di+=Math.max(0,sc-actual-rest);});var tk=ts.reduce(function(s,t){return s+(Number(t.minutes)||0);},0);var wm=parseMin(day.wakeTime),sm=parseMin(day.sleepTime),aw=null;if(wm!=null&&sm!=null){var aj=sm;if(aj>=720&&aj<780)aj-=720;aw=aj-wm;if(aw<=0)aw+=1440;}var dp=aw!=null?Math.max(0,aw-un):null;var ut=(dp&&ac)?Math.round(ac/dp*100):null;var ec=Math.max(0,study-rs);var fe=ec>0?Math.round(ac/ec*100):null;var av=nm>0?Math.round((ac-nm)/nm*100):null;var am={};ts.forEach(function(t){var a=t.activityType||'';am[a]=(am[a]||0)+(Number(t.minutes)||0);});var tm={},spm={},frs=0,fdi=0;ts.forEach(function(t){var a=t.activityType||'';tm[a]=(tm[a]||0)+(Number(t.minutes)||0);});ss.forEach(function(s){var sc=sessionClock(s),actual=Number(s.actualMinutes)||0,rest=Number(s.restMinutes)||0;if(s.type==='special'){spm[s.name||'\u7279\u6B8A']=(spm[s.name||'\u7279\u6B8A']||0)+sc;}else if(s.type==='special-study'){var k=(s.name||'\u7279\u6B8A\u5B66\u4E60')+'\uFF08\u4E0D\u53EF\u7528\u90E8\u5206\uFF09';spm[k]=(spm[k]||0)+Math.max(0,sc-actual);}else{frs+=rest;fdi+=Math.max(0,sc-actual-rest);}});var id=aw!=null?Math.max(0,aw-tk-un-frs-fdi):0;return{clockMin:ck,trackedSpanMin:span,studyClockMin:study,effectiveClockMin:ec,nominalMin:nm,actualMin:ac,restMin:rs,distractMin:di,taskMin:tk,awakeMin:aw,specialMin:sp,specialStudyClockMin:ssc,specialStudyActualMin:ssa,unavailableMin:un,disposableMin:dp,utilPct:ut,actualVsNominal:av,focusEfficiency:fe,actMin:am,taskMap:tm,specialMap:spm,focusRestMin:frs,focusDistractMin:fdi,totalTaskMin:tk,totalSpecialMin:un,idleMin:id,wakeTime:day.wakeTime,sleepTime:day.sleepTime,sessions:ss,tasks:ts};}
var TAB_IDS=['overview','calendar','sessions','daily','sessAna','taskAna','stacked','sleep'];
function showTab(id){TAB_IDS.forEach(function(t){var el=document.getElementById('tab-'+t);if(el)el.classList.toggle('active',t===id);});document.querySelectorAll('.tab').forEach(function(t,i){t.classList.toggle('active',TAB_IDS[i]===id);});}
document.addEventListener('DOMContentLoaded',function(){
Chart.defaults.color='#6b7a9e';Chart.defaults.borderColor=GC;Chart.defaults.font.family="'Noto Sans SC',sans-serif";
var dates=Object.keys(DATA).sort(),dayStats=dates.map(function(ds){return Object.assign({dateStr:ds},computeDay(ds));}),dwd=dayStats.filter(function(d){return d.clockMin>0||d.actualMin>0||d.taskMin>0;}),n=dwd.length||1;
var tCk=0,tNm=0,tAc=0,tRs=0,tEf=0,tTk=0;dayStats.forEach(function(d){tCk+=d.clockMin;tNm+=d.nominalMin;tAc+=d.actualMin;tRs+=d.restMin;tEf+=d.effectiveClockMin;tTk+=d.taskMin;});
var fp=tEf>0?Math.round(tAc/tEf*100):null;
var sCk=calcS(dayStats.map(function(d){return d.clockMin;})),sEf=calcS(dayStats.map(function(d){return d.effectiveClockMin;})),sNm=calcS(dayStats.map(function(d){return d.nominalMin;})),sAc=calcS(dayStats.map(function(d){return d.actualMin;})),sTk=calcS(dayStats.map(function(d){return d.taskMin;}));
var labels=dates.map(fmtShort);
document.getElementById('statsGrid').innerHTML='<div class="stat-card"><div class="stat-label">\u8BB0\u5F55\u5929\u6570</div><div class="stat-value" style="color:var(--hp)">'+dwd.length+'</div></div><div class="stat-card"><div class="stat-label">\u603B\u65F6\u949F'+tipIcon('clock')+'</div><div class="stat-value" style="color:var(--clock)">'+fmtHrs(tCk)+'</div><div class="stat-sub">\u4F11\u606F '+fmtMin(tRs)+' \xB7 \u65E5\u5747 '+fmtMin(Math.round(tCk/n))+' \xB7 CV '+fmtCV(sCk)+'</div></div><div class="stat-card"><div class="stat-label">\u603B\u6709\u6548\u65F6\u949F'+tipIcon('effectiveClock')+'</div><div class="stat-value" style="color:var(--clock)">'+fmtHrs(tEf)+'</div><div class="stat-sub">\u65E5\u5747 '+fmtMin(Math.round(tEf/n))+' \xB7 CV '+fmtCV(sEf)+'</div></div><div class="stat-card"><div class="stat-label">\u603B\u540D\u4E49'+tipIcon('nominal')+'</div><div class="stat-value" style="color:var(--nominal)">'+fmtHrs(tNm)+'</div><div class="stat-sub">\u65E5\u5747 '+fmtMin(Math.round(tNm/n))+' \xB7 CV '+fmtCV(sNm)+'</div></div><div class="stat-card"><div class="stat-label">\u603B\u5B9E\u9645'+tipIcon('actual')+'</div><div class="stat-value" style="color:var(--actual)">'+fmtHrs(tAc)+'</div><div class="stat-sub">\u65E5\u5747 '+fmtMin(Math.round(tAc/n))+' \xB7 CV '+fmtCV(sAc)+'</div></div><div class="stat-card"><div class="stat-label">\u603B\u4EFB\u52A1'+tipIcon('taskMin')+'</div><div class="stat-value" style="color:var(--word)">'+fmtHrs(tTk)+'</div><div class="stat-sub">\u65E5\u5747 '+fmtMin(Math.round(tTk/n))+' \xB7 CV '+fmtCV(sTk)+'</div></div><div class="stat-card"><div class="stat-label">\u4E13\u6CE8\u6548\u7387'+tipIcon('efficiency')+'</div><div class="stat-value" style="color:'+(fp>=80?'var(--green)':fp>=60?'var(--wake)':'var(--red)')+'">'+((fp!=null)?fp+'%':'-')+'</div></div>';
var aAM={};dayStats.forEach(function(d){Object.keys(d.actMin).forEach(function(k){aAM[k]=(aAM[k]||0)+d.actMin[k];});});var aK=Object.keys(aAM).filter(function(k){return aAM[k]>0;}).sort(function(a,b){return aAM[b]-aAM[a];});
document.getElementById('tab-overview').innerHTML='<div class="chart-grid"><div class="chart-card full"><div class="chart-title">\u6BCF\u65E5\u4E09\u7EF4\u65F6\u95F4\u8D8B\u52BF</div><div class="chart-sub">\u586B\u5145\u6298\u7EBF\u56FE \xB7 \u65F6\u949F\uFF08\u865A\u7EBF\uFF09/ \u6709\u6548\u65F6\u949F / \u540D\u4E49\uFF08\u84DD\uFF09/ \u5B9E\u9645\uFF08\u7EFF\uFF09</div><canvas id="rC1" height="80"></canvas></div><div class="chart-card"><div class="chart-title">\u7C7B\u522B\u65F6\u95F4\u5206\u5E03</div><div class="chart-sub">\u5404\u7C7B\u522B\u7D2F\u8BA1</div><canvas id="rC2" height="200"></canvas></div><div class="chart-card"><div class="chart-title">\u6BCF\u65E5\u4E13\u6CE8\u6548\u7387</div><div class="chart-sub">\u5B9E\u9645/\u6709\u6548\u65F6\u949F %</div><canvas id="rC3" height="200"></canvas></div><div class="chart-card full"><div class="chart-title">\u6BCF\u65E5\u6C47\u603B\u8868</div><div class="table-wrap"><table><thead><tr><th>\u65E5\u671F</th><th>\u8D77\u5E8A</th><th>\u7761\u89C9</th><th class="c-clock">\u65F6\u949F</th><th class="c-clock">\u6709\u6548</th><th>\u4F11\u606F</th><th class="c-nominal">\u540D\u4E49</th><th class="c-actual">\u5B9E\u9645</th><th>\u504F\u5DEE</th><th>\u6548\u7387</th><th>\u5229\u7528\u7387</th></tr></thead><tbody>'+dayStats.map(function(d){return '<tr><td class="fw-mono">'+fmtShort(d.dateStr)+'</td><td class="fw-mono c-wake">'+(d.wakeTime||'-')+'</td><td class="fw-mono" style="color:var(--sleep)">'+(d.sleepTime||'-')+'</td><td class="fw-mono c-clock">'+fmtMin(d.clockMin,true)+'</td><td class="fw-mono c-clock">'+fmtMin(d.effectiveClockMin,true)+'</td><td class="fw-mono">'+fmtMin(d.restMin,true)+'</td><td class="fw-mono c-nominal">'+fmtMin(d.nominalMin,true)+'</td><td class="fw-mono c-actual">'+fmtMin(d.actualMin,true)+'</td><td class="fw-mono '+devClass(d.actualVsNominal)+'">'+devStr(d.actualVsNominal)+'</td><td class="fw-mono '+(d.focusEfficiency>=80?'c-green':d.focusEfficiency>=60?'c-wake':'c-red')+'">'+(d.focusEfficiency!=null?d.focusEfficiency+'%':'-')+'</td><td class="fw-mono '+(d.utilPct>=50?'c-green':d.utilPct>=30?'c-wake':'c-red')+'">'+(d.utilPct!=null?d.utilPct+'%':'-')+'</td></tr>';}).join('')+'</tbody><tfoot><tr><td colspan="3">\u5408\u8BA1/\u65E5\u5747</td><td class="c-clock">'+fmtMin(tCk,true)+'</td><td class="c-clock">'+fmtMin(tEf,true)+'</td><td>'+fmtMin(tRs,true)+'</td><td class="c-nominal">'+fmtMin(tNm,true)+'</td><td class="c-actual">'+fmtMin(tAc,true)+'</td><td colspan="3"></td></tr><tr style="color:var(--dim);font-size:11px"><td colspan="3">\u03C3 / CV</td><td>'+fmtMin(Math.round(sCk.sd))+' / '+fmtCV(sCk)+'</td><td>'+fmtMin(Math.round(sEf.sd))+' / '+fmtCV(sEf)+'</td><td></td><td>'+fmtMin(Math.round(sNm.sd))+' / '+fmtCV(sNm)+'</td><td>'+fmtMin(Math.round(sAc.sd))+' / '+fmtCV(sAc)+'</td><td colspan="3"></td></tr></tfoot></table></div></div></div>';
mkChart('rC1',{type:'line',data:{labels:labels,datasets:[{label:'\u65F6\u949F',data:dayStats.map(function(d){return +(d.clockMin/60).toFixed(2);}),borderColor:'#80deea',backgroundColor:'rgba(128,222,234,.15)',borderWidth:1.5,borderDash:[4,4],pointRadius:dates.length>14?1:2,tension:.3,fill:'origin'},{label:'\u6709\u6548\u65F6\u949F',data:dayStats.map(function(d){return +(d.effectiveClockMin/60).toFixed(2);}),borderColor:'#80deea',backgroundColor:'rgba(128,222,234,.2)',borderWidth:1.5,pointRadius:dates.length>14?1:3,tension:.3,fill:'origin'},{label:'\u540D\u4E49',data:dayStats.map(function(d){return +(d.nominalMin/60).toFixed(2);}),borderColor:'#4fc3f7',backgroundColor:'rgba(79,195,247,.2)',borderWidth:1.5,pointRadius:dates.length>14?1:3,tension:.3,fill:'origin'},{label:'\u5B9E\u9645',data:dayStats.map(function(d){return +(d.actualMin/60).toFixed(2);}),borderColor:'#69f0ae',backgroundColor:'rgba(105,240,174,.25)',borderWidth:2,pointRadius:dates.length>14?1:3,tension:.3,fill:'origin'}]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#6b7a9e'}},filler:{propagate:false},tooltip:{callbacks:{label:function(c){var v=c.parsed.y;if(!v)return null;return c.dataset.label+': '+fmtMin(Math.round(v*60));}}}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:dates.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e',callback:function(v){return v+'h';}},grid:gridCfg,min:0}}}});
if(aK.length>0)mkChart('rC2',{type:'doughnut',data:{labels:aK,datasets:[{data:aK.map(function(k){return aAM[k];}),backgroundColor:aK.map(function(k){return hexRgba(getActColor(k),.75);}),borderWidth:1}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{color:'#6b7a9e',boxWidth:10}},tooltip:{callbacks:{label:function(c){return c.label+': '+fmtMin(c.raw);}}}}}});
mkChart('rC3',{type:'bar',data:{labels:labels,datasets:[{label:'%',data:dayStats.map(function(d){return d.focusEfficiency||0;}),backgroundColor:dayStats.map(function(d){return(d.focusEfficiency||0)>=80?'rgba(105,240,174,.4)':(d.focusEfficiency||0)>=60?'rgba(255,213,79,.4)':'rgba(244,67,54,.3)';}),borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:dates.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e',callback:function(v){return v+'%';}},grid:gridCfg,min:0,max:100}}}});
var fy=parseInt(dates[0]),fm=parseInt(dates[0].slice(5,7))-1,ly=parseInt(dates[dates.length-1]),lm=parseInt(dates[dates.length-1].slice(5,7))-1;
var cH='';for(var cy=fy;cy<=ly;cy++){var sm=cy===fy?fm:0,em=cy===ly?lm:11;for(var cm=sm;cm<=em;cm++){cH+='<div class="card"><div class="card-title">'+cy+'\u5E74'+(cm+1)+'\u6708</div><div class="cal-grid"><div class="cal-hdr">\u4E00</div><div class="cal-hdr">\u4E8C</div><div class="cal-hdr">\u4E09</div><div class="cal-hdr">\u56DB</div><div class="cal-hdr">\u4E94</div><div class="cal-hdr">\u516D</div><div class="cal-hdr">\u65E5</div>';var f1=new Date(cy,cm,1),ld=new Date(cy,cm+1,0),sd=f1.getDay();sd=sd===0?6:sd-1;for(var p=0;p<sd;p++)cH+='<div class="cal-day" style="opacity:.1"></div>';for(var di=1;di<=ld.getDate();di++){var dds=cy+'-'+(cm+1<10?'0':'')+(cm+1)+'-'+(di<10?'0':'')+di;var dd=DATA[dds],hd=dd&&((dd.sessions&&dd.sessions.length)||(dd.tasks&&dd.tasks.length)||dd.wakeTime),dS=hd?computeDay(dds):null;cH+='<div class="cal-day'+(hd?' has-data':'')+'"><div class="cal-d">'+di+'</div>';if(dS&&dS.actualMin>0)cH+='<div class="cal-v">'+fmtMin(dS.actualMin)+'</div>';cH+='</div>';}cH+='</div></div>';}}
document.getElementById('tab-calendar').innerHTML=cH;
var aS=[];dates.forEach(function(ds){(DATA[ds].sessions||[]).forEach(function(s){aS.push(Object.assign({},s,{_d:ds}));});});var stC=aS.reduce(function(s,x){return s+sessionClock(x);},0),stA=aS.filter(function(x){return x.type!=='special';}).reduce(function(s,x){return s+(Number(x.actualMinutes)||0);},0);
document.getElementById('tab-sessions').innerHTML='<div class="card"><div class="card-title" style="margin-bottom:8px">\u23F1 \u4E13\u6CE8\u65F6\u6BB5\u660E\u7EC6 <span style="color:var(--muted);font-size:12px">'+aS.length+' \u6BB5 \xB7 \u65F6\u949F '+fmtMin(stC)+' \xB7 \u5B9E\u9645 '+fmtMin(stA)+'</span></div>'+(aS.length===0?'<p style="color:var(--dim)">\u6682\u65E0</p>':'<div class="table-wrap"><table><thead><tr><th>\u65E5\u671F</th><th>\u7C7B\u578B</th><th>\u5F00\u59CB</th><th>\u7ED3\u675F</th><th class="c-clock">\u65F6\u949F</th><th class="c-nominal">\u540D\u4E49</th><th class="c-actual">\u5B9E\u9645</th><th>\u4F11\u606F</th><th>\u6548\u7387</th><th>\u5907\u6CE8</th></tr></thead><tbody>'+aS.map(function(s){var cl=sessionClock(s),sp=s.type==='special',ss=s.type==='special-study',ac=Number(s.actualMinutes)||0,rs=Number(s.restMinutes)||0,ef=(!sp&&(ss?ac:(cl-rs))>0)?Math.round(ac/(ss?ac:(cl-rs))*100):null;var ty=sp?'<span style="font-size:10px;background:rgba(206,147,216,.2);color:#ce93d8;padding:1px 6px;border-radius:3px">'+(s.name||'\u7279\u6B8A')+'</span>':ss?'<span style="font-size:10px;background:rgba(105,240,174,.15);color:#69f0ae;padding:1px 6px;border-radius:3px">\u7279\u6B8A\u5B66\u4E60\xB7'+(s.name||'\u672A\u547D\u540D')+'</span>':'\u666E\u901A';return '<tr'+((sp||ss)?' style="background:rgba(206,147,216,.06)"':'')+'><td class="fw-mono">'+fmtShort(s._d)+'</td><td>'+ty+'</td><td class="fw-mono">'+(s.startTime||'-')+'</td><td class="fw-mono">'+(s.endTime||'-')+'</td><td class="fw-mono c-clock">'+fmtMin(cl,true)+'</td><td class="fw-mono c-nominal">'+((sp||ss)?'-':fmtMin(Number(s.nominalMinutes)||0,true))+'</td><td class="fw-mono c-actual">'+(sp?'-':fmtMin(ac,true))+'</td><td class="fw-mono">'+((sp||ss)?'-':fmtMin(rs,true))+'</td><td class="fw-mono '+(ef>=80?'c-green':ef>=60?'c-wake':ef!=null?'c-red':'')+'">'+(ef!=null?ef+'%':'-')+'</td><td class="c-muted" style="font-size:11px">'+(s.note||'')+'</td></tr>';}).join('')+'</tbody></table></div>')+'</div>';
var aT=[];dates.forEach(function(ds){(DATA[ds].tasks||[]).forEach(function(t){aT.push(Object.assign({},t,{_d:ds}));});});var tTt=aT.reduce(function(s,t){return s+(Number(t.minutes)||0);},0);
document.getElementById('tab-daily').innerHTML='<div class="card"><div class="card-title" style="margin-bottom:8px">\u{1F4DD} \u4EFB\u52A1\u8BB0\u5F55 <span style="color:var(--muted);font-size:12px">'+aT.length+' \u6761 \xB7 '+fmtMin(tTt)+'</span></div>'+(aT.length===0?'<p style="color:var(--dim)">\u6682\u65E0</p>':'<div class="table-wrap"><table><thead><tr><th>\u65E5\u671F</th><th>\u540D\u79F0</th><th>\u7C7B\u578B</th><th>\u65F6\u957F</th><th>\u6570\u91CF</th><th>\u6548\u7387</th><th>\u6B63\u786E\u7387</th><th>\u5907\u6CE8</th></tr></thead><tbody>'+aT.map(function(t){var c=getActColor(t.activityType),r=(t.quantity&&t.minutes)?(Number(t.quantity)/Number(t.minutes)).toFixed(2):null;return '<tr><td class="fw-mono">'+fmtShort(t._d)+'</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis">'+(t.name||'')+'</td><td><span class="badge" style="background:'+hexRgba(c,.13)+';color:'+c+';border:1px solid '+hexRgba(c,.27)+'">'+(t.activityType||'-')+'</span></td><td class="fw-mono">'+fmtMin(Number(t.minutes)||0,true)+'</td><td class="fw-mono">'+(t.quantity?t.quantity+(t.quantityUnit?' '+t.quantityUnit:''):'-')+'</td><td class="fw-mono">'+(r?r+(t.quantityUnit?' '+t.quantityUnit+'/min':'/min'):'-')+'</td><td class="fw-mono '+(t.accuracy>=80?'c-green':t.accuracy>=60?'c-wake':t.accuracy?'c-red':'')+'">'+(t.accuracy!=null&&t.accuracy!==''?t.accuracy+'%':'-')+'</td><td class="c-muted" style="font-size:11px">'+(t.note||'')+'</td></tr>';}).join('')+'</tbody></table></div>')+'</div>';


// ═══ TAB: 时段分析 (interactive) ═══
var sessCatMap={};var totSC=0,totSCk=0,totSAc=0,totSRs=0;
dates.forEach(function(ds){var day=DATA[ds]||{};(day.sessions||[]).forEach(function(s){totSC++;var ck=sessionClock(s),nm=Number(s.nominalMinutes)||0,ac=Number(s.actualMinutes)||0,rs=Number(s.restMinutes)||0;var cat=s.type==='special'?(s.name||'\u7279\u6B8A'):s.type==='special-study'?'\u7279\u6B8A\u5B66\u4E60\xB7'+(s.name||'\u672A\u547D\u540D'):'\u666E\u901A\u4E13\u6CE8';totSCk+=ck;totSAc+=ac;totSRs+=rs;if(!sessCatMap[cat])sessCatMap[cat]={};if(!sessCatMap[cat][ds])sessCatMap[cat][ds]={ck:0,nm:0,ac:0,rs:0,ct:0};sessCatMap[cat][ds].ck+=ck;sessCatMap[cat][ds].nm+=nm;sessCatMap[cat][ds].ac+=ac;sessCatMap[cat][ds].rs+=rs;sessCatMap[cat][ds].ct++;});});
var sessCats=Object.keys(sessCatMap).sort(function(a,b){return a==='\u666E\u901A\u4E13\u6CE8'?-1:b==='\u666E\u901A\u4E13\u6CE8'?1:a.localeCompare(b);});
var dwS=dates.filter(function(ds){return(DATA[ds].sessions||[]).length>0;}).length;
var sessEff=(totSCk-totSRs)>0?Math.round(totSAc/(totSCk-totSRs)*100):null;
var sessCatStats=sessCats.map(function(cat){var ct=0,ck=0,nm=0,ac=0,rs=0;Object.values(sessCatMap[cat]).forEach(function(v){ct+=v.ct;ck+=v.ck;nm+=v.nm;ac+=v.ac;rs+=v.rs;});var isSp=ac===0&&ck>0,met=isSp?ck:ac;var ef=!isSp&&(ck-rs)>0?Math.round(ac/(ck-rs)*100):null;var avg=dwS>0?Math.round(met/dwS):0;var dv=dates.map(function(ds){var d=sessCatMap[cat][ds];return d?(isSp?d.ck:d.ac):0;});var st=calcS(dv);return{cat:cat,ct:ct,ck:ck,nm:nm,ac:ac,rs:rs,ef:ef,isSp:isSp,avgAct:ct>0?Math.round(met/ct):0,avgDay:avg,cv:st.cv};});
function renderSessAna(filt){
  var cL,cDS;
  if(filt&&sessCatMap[filt]){var fd=dates.filter(function(ds){return sessCatMap[filt][ds];});cL=fd.map(fmtShort);var ci=sessCats.indexOf(filt);var hex=filt==='\u666E\u901A\u4E13\u6CE8'?'#69f0ae':SP[ci%SP.length];cDS=[{label:filt,data:fd.map(function(ds){var d=sessCatMap[filt][ds];return +((d.ac||d.ck)/60).toFixed(2);}),borderColor:hex,backgroundColor:hexRgba(hex,.2),borderWidth:2,pointRadius:4,tension:.3,fill:'origin'}];
  }else{cL=labels;cDS=sessCats.map(function(cat,ci){var hex=cat==='\u666E\u901A\u4E13\u6CE8'?'#69f0ae':SP[ci%SP.length];return{label:cat,data:dates.map(function(ds){var d=sessCatMap[cat][ds];if(!d)return 0;return +((d.ac||d.ck)/60).toFixed(2);}),borderColor:hex,backgroundColor:hexRgba(hex,.2),borderWidth:2,pointRadius:dates.length>14?1:3,tension:.3,fill:'origin'};});}
  var fS=filt?calcS(dates.map(function(ds){var d=sessCatMap[filt]?sessCatMap[filt][ds]:null;if(!d)return 0;return d.ac||d.ck;})):null;
  var opts=sessCats.map(function(c){return '<option value="'+c+'"'+(filt===c?' selected':'')+'>'+c+'</option>';}).join('');
  var cvI=filt&&fS?'<span style="font-size:11px;color:var(--muted)">CV: <b>'+fmtCV(fS)+'</b> (n='+fS.n+')</span>':'';
  var tbl=sessCatStats.map(function(c){return '<tr><td style="font-weight:500">'+c.cat+'</td><td class="fw-mono">'+c.ct+'</td><td class="fw-mono c-clock">'+fmtMin(c.ck,true)+'</td><td class="fw-mono c-nominal">'+fmtMin(c.nm,true)+'</td><td class="fw-mono c-actual">'+fmtMin(c.ac,true)+'</td><td class="fw-mono">'+fmtMin(c.rs,true)+'</td><td class="fw-mono '+(c.ef>=80?'c-green':c.ef>=60?'c-wake':c.ef!=null?'c-red':'')+'">'+(c.ef!=null?c.ef+'%':'-')+'</td><td class="fw-mono">'+fmtMin(c.avgAct)+'</td><td class="fw-mono c-muted">'+fmtMin(c.avgDay)+'</td><td class="fw-mono">'+(c.cv||'-')+'</td></tr>';}).join('');
  document.getElementById('tab-sessAna').innerHTML='<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap"><span style="font-size:11px;color:var(--muted)">\u7C7B\u522B\uFF1A</span><select onchange="renderSessAna(this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px"><option value="">\u5168\u90E8 ('+sessCats.length+')</option>'+opts+'</select>'+cvI+'</div><div class="mini-grid" style="margin-bottom:16px"><div class="mini-card"><div class="lbl">\u65F6\u6BB5\u6570</div><div class="val c-hp">'+totSC+'</div><div class="sub">'+dwS+'\u5929</div></div><div class="mini-card"><div class="lbl">\u603B\u5B9E\u9645</div><div class="val c-actual">'+fmtMin(totSAc,true)+'</div><div class="sub">\u65E5\u5747 '+fmtMin(dwS>0?Math.round(totSAc/dwS):0)+'</div></div><div class="mini-card"><div class="lbl">\u603B\u65F6\u949F</div><div class="val c-clock">'+fmtMin(totSCk,true)+'</div></div><div class="mini-card"><div class="lbl">\u6548\u7387</div><div class="val '+(sessEff>=80?'c-green':sessEff>=60?'c-wake':'c-red')+'">'+(sessEff!=null?sessEff+'%':'-')+'</div></div></div><div class="chart-grid"><div class="chart-card full"><div class="chart-title">\u6BCF\u65E5\u4E13\u6CE8\u65F6\u957F'+(filt?'\uFF08'+filt+'\uFF09':'\uFF08\u6309\u7C7B\u522B\uFF09')+'</div><div class="chart-sub">'+(filt?'\u4EC5\u663E\u793A\u6709\u6570\u636E\u7684\u5929':'\u586B\u5145\u6298\u7EBF\u56FE')+'</div><canvas id="rSessTrend" height="100"></canvas></div><div class="chart-card full"><div class="chart-title">\u7C7B\u522B\u6C47\u603B\u660E\u7EC6</div><div class="table-wrap"><table><thead><tr><th>\u7C7B\u522B</th><th>\u65F6\u6BB5\u6570</th><th>\u65F6\u949F</th><th>\u540D\u4E49</th><th>\u5B9E\u9645</th><th>\u4F11\u606F</th><th>\u6548\u7387</th><th>\u6BCF\u6BB5\u5E73\u5747</th><th>\u65E5\u5747</th><th>CV</th></tr></thead><tbody>'+tbl+'</tbody></table></div></div></div>';
  mkChart('rSessTrend',{type:'line',data:{labels:cL,datasets:cDS},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#6b7a9e',boxWidth:12}},filler:{propagate:false}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:cL.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e',callback:function(v){return v+'h';}},grid:gridCfg,min:0}}}});
}
renderSessAna('');
window.renderSessAna=renderSessAna;

// ═══ TAB: 任务分析 (interactive) ═══
function truncAct(s,lv){if(!s)return '\u672A\u5206\u7C7B';var p=s.split(' > ');return p.slice(0,lv).join(' > ');}
var _tkS={level:1,cf:'',es:'linear',ey:'',ecf:''};
function tkSetLevel(l){_tkS.level=l;_tkS.cf='';renderTaskAna();}
function tkSetCF(v){_tkS.cf=v;renderTaskAna();}
function tkSetES(v){_tkS.es=v;renderTaskAna();}
function tkSetEY(v){_tkS.ey=v;renderTaskAna();}
function tkSetECF(v){_tkS.ecf=v;renderTaskAna();}
function renderTaskAna(){
  var lv=_tkS.level,cf=_tkS.cf,es=_tkS.es,ey=_tkS.ey,ecf=_tkS.ecf;
  var cm={},totC=0,totM=0;
  dates.forEach(function(ds){(DATA[ds].tasks||[]).forEach(function(t){totC++;var mn=Number(t.minutes)||0;totM+=mn;var cat=truncAct(t.activityType,lv);if(!cm[cat])cm[cat]={};if(!cm[cat][ds])cm[cat][ds]={mn:0,qt:0,ct:0,u:''};cm[cat][ds].mn+=mn;cm[cat][ds].qt+=Number(t.quantity)||0;cm[cat][ds].ct++;if(t.quantityUnit)cm[cat][ds].u=t.quantityUnit;});});
  var cats=Object.keys(cm).sort(),dwT2=dates.filter(function(ds){return(DATA[ds].tasks||[]).length>0;}).length;
  var cL2,cDS2;
  if(cf&&cm[cf]){var fd2=dates.filter(function(ds){return cm[cf][ds];});cL2=fd2.map(fmtShort);var hx=lv===1?getActColor(cf):SP[cats.indexOf(cf)%SP.length];cDS2=[{label:cf,data:fd2.map(function(ds){return +(cm[cf][ds].mn/60).toFixed(2);}),borderColor:hx,borderWidth:2,pointRadius:4,tension:.3,fill:false}];
  }else{cL2=labels;cDS2=cats.map(function(cat,ci){var hx=lv===1?getActColor(cat):SP[ci%SP.length];return{label:cat,data:dates.map(function(ds){return +((cm[cat]&&cm[cat][ds]?cm[cat][ds].mn:0)/60).toFixed(2);}),borderColor:hx,borderWidth:2,pointRadius:dates.length>14?1:3,tension:.3,fill:false};});}
  var cs2=cats.map(function(cat){var ct=0,mn=0,qt=0,u='';Object.values(cm[cat]).forEach(function(v){ct+=v.ct;mn+=v.mn;qt+=v.qt;if(v.u)u=v.u;});var st=calcS(dates.map(function(ds){return cm[cat]&&cm[cat][ds]?cm[cat][ds].mn:0;}));return{cat:cat,ct:ct,mn:mn,qt:qt,u:u,avgMn:ct>0?Math.round(mn/ct):0,avgD:dwT2>0?Math.round(mn/dwT2):0,avgE:(qt&&mn)?+(qt/mn).toFixed(2):null,cv:st.cv};});
  var pieD=cats.map(function(c){return cs2.find(function(x){return x.cat===c;}).mn;}),pieC=cats.map(function(c){return hexRgba(lv===1?getActColor(c):SP[cats.indexOf(c)%SP.length],.75);});
  var dcnt=dates.map(function(ds){return(DATA[ds].tasks||[]).length;}),dmin=dates.map(function(ds){return +((DATA[ds].tasks||[]).reduce(function(s,t){return s+(Number(t.minutes)||0);},0)/60).toFixed(2);});
  var em={};dates.forEach(function(ds){(DATA[ds].tasks||[]).forEach(function(t){var qt=Number(t.quantity)||0,mn=Number(t.minutes)||0;if(!qt||!mn)return;var c3=truncAct(t.activityType,3);if(!em[c3])em[c3]={};if(!em[c3][ds])em[c3][ds]={qt:0,mn:0,u:''};em[c3][ds].qt+=qt;em[c3][ds].mn+=mn;if(t.quantityUnit)em[c3][ds].u=t.quantityUnit;});});
  var eC=Object.keys(em).sort(),eCL,eDS;
  if(ecf&&em[ecf]){var efd=dates.filter(function(ds){return em[ecf][ds];});eCL=efd.map(fmtShort);var eh=SP[eC.indexOf(ecf)%SP.length],eu='';Object.values(em[ecf]).forEach(function(v){if(v.u)eu=v.u;});eDS=[{label:ecf+(eu?' ('+eu+'/min)':' (/min)'),data:efd.map(function(ds){return +(em[ecf][ds].qt/em[ecf][ds].mn).toFixed(3);}),borderColor:eh,backgroundColor:eh,borderWidth:2,pointRadius:4,tension:.3,fill:false}];
  }else{eCL=labels;eDS=eC.map(function(cat,ci){var eh=SP[ci%SP.length],eu='';Object.values(em[cat]).forEach(function(v){if(v.u)eu=v.u;});return{label:cat+(eu?' ('+eu+'/min)':' (/min)'),data:dates.map(function(ds){var d=em[cat]?em[cat][ds]:null;if(!d)return null;return +(d.qt/d.mn).toFixed(3);}),borderColor:eh,backgroundColor:eh,borderWidth:2,pointRadius:3,tension:.3,fill:false,spanGaps:true};});}
  var effDisp=ecf?calcS(dates.map(function(ds){var d=em[ecf]?em[ecf][ds]:null;return d?d.qt/d.mn:0;})):null;
  var eChDS=eDS,yTit='\u6548\u7387(\u6570\u91CF/\u5206\u949F)',yTy='linear',yMn2=0,yMx3=ey?parseFloat(ey):undefined;
  var eFmt=function(c){var v=c.parsed.y;if(v==null)return null;return c.dataset.label+': '+v.toFixed(3);};
  if(es==='log'){yTy='logarithmic';yMn2=undefined;yMx3=undefined;yTit+='\xB7\u5BF9\u6570';}
  else if(es==='normalize'){yTit='\u5F52\u4E00\u5316(% of max)';yMx3=105;eChDS=eDS.map(function(ds){var vals=ds.data.filter(function(v){return v!=null;});var mx=vals.length?Math.max.apply(null,vals):1;return Object.assign({},ds,{data:ds.data.map(function(v){return v==null?null:+(v/mx*100).toFixed(1);})});});eFmt=function(c){var v=c.parsed.y;if(v==null)return null;return c.dataset.label+': '+v.toFixed(1)+'%';};}
  var bc=function(v,cur){return 'style="padding:3px 10px;border-radius:6px;border:1px solid var(--border);cursor:pointer;font-size:11px;'+(v===cur?'background:var(--hp);color:#000;font-weight:600':'background:var(--card);color:var(--muted)')+'"';};
  var h='<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap"><span style="font-size:11px;color:var(--muted)">\u5C42\u7EA7\uFF1A</span>';
  h+='<span '+bc(1,lv)+' onclick="tkSetLevel(1)">\u4E00\u7EA7</span><span '+bc(2,lv)+' onclick="tkSetLevel(2)">\u4E8C\u7EA7</span><span '+bc(3,lv)+' onclick="tkSetLevel(3)">\u4E09\u7EA7</span>';
  h+='<span style="color:var(--dim);font-size:11px">\u2502</span><span style="font-size:11px;color:var(--muted)">\u7B5B\u9009\uFF1A</span><select onchange="tkSetCF(this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px"><option value="">\u5168\u90E8 ('+cats.length+')</option>';
  cats.forEach(function(c){h+='<option value="'+c+'"'+(cf===c?' selected':'')+'>'+c+'</option>';});h+='</select></div>';
  h+='<div class="mini-grid" style="margin-bottom:16px"><div class="mini-card"><div class="lbl">\u4EFB\u52A1\u603B\u6570</div><div class="val c-hp">'+totC+'</div><div class="sub">'+dwT2+'\u5929 \xB7 '+cats.length+'\u7C7B</div></div><div class="mini-card"><div class="lbl">\u603B\u65F6\u957F</div><div class="val c-actual">'+fmtMin(totM,true)+'</div><div class="sub">\u65E5\u5747 '+fmtMin(dwT2>0?Math.round(totM/dwT2):0)+'</div></div><div class="mini-card"><div class="lbl">\u6BCF\u6761\u5E73\u5747</div><div class="val c-muted">'+fmtMin(totC>0?Math.round(totM/totC):0)+'</div></div></div>';
  h+='<div class="chart-grid"><div class="chart-card full"><div class="chart-title">\u6BCF\u65E5\u4EFB\u52A1\u65F6\u957F'+(cf?'\uFF08'+cf+'\uFF09':'\uFF08\u6309\u7C7B\u522B\uFF09')+'</div><div class="chart-sub">'+(cf?'\u4EC5\u663E\u793A\u6709\u6570\u636E\u7684\u5929':'\u6298\u7EBF\u56FE')+'</div><canvas id="rTkTrend" height="100"></canvas></div>';
  h+='<div class="chart-card"><div class="chart-title">\u7C7B\u522B\u65F6\u95F4\u5360\u6BD4</div><canvas id="rTkPie" height="200"></canvas></div><div class="chart-card"><div class="chart-title">\u6BCF\u65E5\u4EFB\u52A1\u6570\u91CF</div><canvas id="rTkCount" height="200"></canvas></div>';
  if(eC.length>0){h+='<div class="chart-card full"><div class="chart-title">\u6548\u7387\u8D8B\u52BF\uFF08\u4E09\u7EA7\u5206\u7C7B\uFF09'+(ecf?' \u2014 '+ecf:'')+'</div><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap"><span style="font-size:11px;color:var(--muted)">\u7EB5\u8F74\uFF1A</span>';
  h+='<span '+bc('linear',es)+' onclick="tkSetES(&#39;linear&#39;)">\u7EBF\u6027</span><span '+bc('log',es)+' onclick="tkSetES(&#39;log&#39;)">\u5BF9\u6570</span><span '+bc('normalize',es)+' onclick="tkSetES(&#39;normalize&#39;)">\u5F52\u4E00\u5316</span>';
  if(es==='linear')h+='<span style="font-size:11px;color:var(--muted)">Y\u4E0A\u9650\uFF1A</span><input type="number" value="'+ey+'" placeholder="\u81EA\u52A8" min="0" step="0.5" style="width:60px;padding:3px 6px;font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px" onchange="tkSetEY(this.value)">';
  if(eC.length>1){h+='<span style="color:var(--dim);font-size:11px">\u2502</span><span style="font-size:11px;color:var(--muted)">\u7B5B\u9009\uFF1A</span><select onchange="tkSetECF(this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px"><option value="">\u5168\u90E8 ('+eC.length+')</option>';eC.forEach(function(c){h+='<option value="'+c+'"'+(ecf===c?' selected':'')+'>'+c+'</option>';});h+='</select>';}
  h+='</div>';
  if(effDisp)h+='<div style="font-size:12px;margin-bottom:8px;color:var(--muted)">CV: <b>'+fmtCV(effDisp)+'</b> (n='+effDisp.n+')</div>';
  h+='<canvas id="rTkEff" height="100"></canvas></div>';}
  h+='<div class="chart-card full"><div class="chart-title">\u7C7B\u522B\u6C47\u603B\u660E\u7EC6</div><div class="table-wrap"><table><thead><tr><th>\u7C7B\u522B</th><th>\u4EFB\u52A1\u6570</th><th>\u603B\u65F6\u957F</th><th>\u6BCF\u6761\u5E73\u5747</th><th>\u65E5\u5747</th>'+(lv===3?'<th>CV</th><th>\u603B\u6570\u91CF</th><th>\u5E73\u5747\u6548\u7387</th><th>\u6548\u7387CV</th>':'')+'</tr></thead><tbody>';
  cs2.forEach(function(c){var hx=lv===1?getActColor(c.cat):SP[cats.indexOf(c.cat)%SP.length];var eCS=null;if(lv===3){var evs=[];dates.forEach(function(ds){var d=em[c.cat]?em[c.cat][ds]:null;if(d&&d.mn>0)evs.push(d.qt/d.mn);});if(evs.length)eCS=calcS(evs);}
  h+='<tr><td><span class="badge" style="background:'+hexRgba(hx,.13)+';color:'+hx+'">'+c.cat+'</span></td><td class="fw-mono">'+c.ct+'</td><td class="fw-mono c-actual">'+fmtMin(c.mn,true)+'</td><td class="fw-mono">'+fmtMin(c.avgMn)+'</td><td class="fw-mono c-muted">'+fmtMin(c.avgD)+'</td>';
  if(lv===3)h+='<td class="fw-mono">'+(c.cv||'-')+'</td><td class="fw-mono">'+(c.qt?c.qt+(c.u?' '+c.u:''):'-')+'</td><td class="fw-mono">'+(c.avgE!=null?c.avgE+(c.u?' '+c.u+'/min':'/min'):'-')+'</td><td class="fw-mono">'+(eCS?fmtCV(eCS):'-')+'</td>';
  h+='</tr>';});
  h+='</tbody></table></div></div></div>';
  document.getElementById('tab-taskAna').innerHTML=h;
  mkChart('rTkTrend',{type:'line',data:{labels:cL2,datasets:cDS2},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#6b7a9e',boxWidth:12}}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:cL2.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e',callback:function(v){return v+'h';}},grid:gridCfg,min:0}}}});
  if(cats.length>0)mkChart('rTkPie',{type:'doughnut',data:{labels:cats,datasets:[{data:pieD,backgroundColor:pieC,borderWidth:1}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{color:'#6b7a9e',boxWidth:10}},tooltip:{callbacks:{label:function(c){return c.label+': '+fmtMin(c.raw);}}}}}});
  mkChart('rTkCount',{type:'bar',data:{labels:labels,datasets:[{label:'\u6761\u6570',data:dcnt,backgroundColor:'rgba(79,195,247,.35)',borderRadius:3,yAxisID:'y'},{type:'line',label:'h',data:dmin,borderColor:'#69f0ae',borderWidth:2,pointRadius:2,tension:.3,yAxisID:'y1'}]},options:{responsive:true,scales:{x:{ticks:{color:'#6b7a9e',maxRotation:dates.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e'},grid:gridCfg,min:0},y1:{ticks:{color:'#69f0ae',callback:function(v){return v+'h';}},grid:{drawOnChartArea:false},position:'right',min:0}}}});
  if(eC.length>0)mkChart('rTkEff',{type:'line',data:{labels:eCL,datasets:eChDS},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#6b7a9e',boxWidth:12}},tooltip:{callbacks:{label:eFmt}}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:eCL.length>14?45:0},grid:gridCfg},y:{type:yTy,ticks:{color:'#6b7a9e'},grid:gridCfg,min:yMn2,max:yMx3,title:{display:true,text:yTit,color:'#6b7a9e'}}}}});
}
renderTaskAna();
window.renderTaskAna=renderTaskAna;window.tkSetLevel=tkSetLevel;window.tkSetCF=tkSetCF;window.tkSetES=tkSetES;window.tkSetEY=tkSetEY;window.tkSetECF=tkSetECF;
var tcM={},scM={};dayStats.forEach(function(d){Object.keys(d.taskMap).forEach(function(k){tcM[k]=1;});Object.keys(d.specialMap).forEach(function(k){scM[k]=1;});});var stK=Object.keys(tcM).sort(),spK=Object.keys(scM).sort();
var abD=[],pcD=[],ci2=0;stK.forEach(function(c){var h=getActColor(c);abD.push({label:c,data:dayStats.map(function(d){return +((d.taskMap[c]||0)/60).toFixed(2);}),backgroundColor:hexRgba(h,.75),borderColor:hexRgba(h,.9),borderWidth:.5,fill:'origin',pointRadius:0,tension:.35});pcD.push({label:c,data:dayStats.map(function(d){return d.taskMap[c]||0;}),backgroundColor:hexRgba(h,.75),borderColor:hexRgba(h,.9),borderWidth:.5,fill:'origin',pointRadius:0,tension:.35});ci2++;});
spK.forEach(function(c){var h=SP[ci2%SP.length];abD.push({label:'\u{1F538}'+c,data:dayStats.map(function(d){return +((d.specialMap[c]||0)/60).toFixed(2);}),backgroundColor:hexRgba(h,.6),borderColor:hexRgba(h,.8),borderWidth:.5,fill:'origin',pointRadius:0,tension:.35});pcD.push({label:'\u{1F538}'+c,data:dayStats.map(function(d){return d.specialMap[c]||0;}),backgroundColor:hexRgba(h,.6),borderColor:hexRgba(h,.8),borderWidth:.5,fill:'origin',pointRadius:0,tension:.35});ci2++;});
abD.push({label:'\u{1F634} \u4F11\u606F',data:dayStats.map(function(d){return +(d.focusRestMin/60).toFixed(2);}),backgroundColor:'rgba(179,136,255,.55)',fill:'origin',pointRadius:0,tension:.35},{label:'\u{1F636} \u5206\u5FC3',data:dayStats.map(function(d){return +(d.focusDistractMin/60).toFixed(2);}),backgroundColor:'rgba(244,67,54,.45)',fill:'origin',pointRadius:0,tension:.35},{label:'\u2B1C \u7A7A\u95F2',data:dayStats.map(function(d){return +(d.idleMin/60).toFixed(2);}),backgroundColor:'rgba(61,74,106,.45)',fill:'origin',pointRadius:0,tension:.35});
abD.push({label:'\u2500\u2500 \u6E05\u9192',data:dayStats.map(function(d){return d.awakeMin!=null?+(d.awakeMin/60).toFixed(1):null;}),borderColor:'#ffd54f',borderWidth:2.5,borderDash:[8,4],backgroundColor:'transparent',fill:false,pointRadius:3,pointBackgroundColor:'#ffd54f',tension:.35,yAxisID:'yR'});
pcD.push({label:'\u{1F634} \u4F11\u606F',data:dayStats.map(function(d){return d.focusRestMin;}),backgroundColor:'rgba(179,136,255,.55)',fill:'origin',pointRadius:0,tension:.35},{label:'\u{1F636} \u5206\u5FC3',data:dayStats.map(function(d){return d.focusDistractMin;}),backgroundColor:'rgba(244,67,54,.45)',fill:'origin',pointRadius:0,tension:.35},{label:'\u2B1C \u7A7A\u95F2',data:dayStats.map(function(d){return d.idleMin;}),backgroundColor:'rgba(61,74,106,.45)',fill:'origin',pointRadius:0,tension:.35});
pcD.forEach(function(ds){ds._rawData=ds.data.slice();});
(function(){var ln=pcD[0]?pcD[0].data.length:0;for(var i=0;i<ln;i++){var sm2=0;pcD.forEach(function(ds){if(ds._rawData)sm2+=ds._rawData[i]||0;});pcD.forEach(function(ds){if(!ds._rawData)return;ds.data[i]=sm2>0?+((ds._rawData[i]/sm2)*100).toFixed(1):0;});}})();
function rpc(ch){var dl=ch.data.datasets,ln=dl[0]?dl[0].data.length:0;for(var i=0;i<ln;i++){var sm2=0;dl.forEach(function(ds,di){if(!ds._rawData)return;if(!ch.getDatasetMeta(di).hidden)sm2+=ds._rawData[i]||0;});dl.forEach(function(ds,di){if(!ds._rawData)return;if(ch.getDatasetMeta(di).hidden)ds.data[i]=0;else ds.data[i]=sm2>0?+((ds._rawData[i]/sm2)*100).toFixed(1):0;});}ch.update('none');}
var mxAw=Math.max.apply(null,dayStats.map(function(d){return(d.awakeMin||0)/60;}))||18,yU=Math.ceil(mxAw+1);
var tAw=dayStats.reduce(function(s,d){return s+(d.awakeMin||0);},0),tTkS=dayStats.reduce(function(s,d){return s+d.totalTaskMin;},0),tSpS=dayStats.reduce(function(s,d){return s+d.totalSpecialMin;},0),tRsS=dayStats.reduce(function(s,d){return s+d.focusRestMin;},0),tDiS=dayStats.reduce(function(s,d){return s+d.focusDistractMin;},0),tIdS=dayStats.reduce(function(s,d){return s+d.idleMin;},0);
function pOf(v){return tAw>0?Math.round(v/tAw*100):0;}
document.getElementById('tab-stacked').innerHTML='<div class="mini-grid" style="margin-bottom:16px"><div class="mini-card"><div class="lbl">\u6E05\u9192\u603B\u65F6\u957F'+tipIcon('stackAwake')+'</div><div class="val" style="color:var(--wake)">'+fmtMin(tAw,true)+'</div></div><div class="mini-card"><div class="lbl">\u4EFB\u52A1\u8BB0\u5F55'+tipIcon('stackTask')+'</div><div class="val c-actual">'+fmtMin(tTkS,true)+'</div><div class="sub">'+pOf(tTkS)+'%</div></div><div class="mini-card"><div class="lbl">\u7279\u6B8A\u65F6\u6BB5'+tipIcon('stackSpecial')+'</div><div class="val c-nominal">'+fmtMin(tSpS,true)+'</div><div class="sub">'+pOf(tSpS)+'%</div></div><div class="mini-card"><div class="lbl">\u4F11\u606F'+tipIcon('stackRest')+'</div><div class="val" style="color:var(--sleep)">'+fmtMin(tRsS,true)+'</div><div class="sub">'+pOf(tRsS)+'%</div></div><div class="mini-card"><div class="lbl">\u5206\u5FC3'+tipIcon('stackDistract')+'</div><div class="val" style="color:var(--red)">'+fmtMin(tDiS,true)+'</div><div class="sub">'+pOf(tDiS)+'%</div></div><div class="mini-card"><div class="lbl">\u7A7A\u95F2'+tipIcon('stackIdle')+'</div><div class="val" style="color:var(--dim)">'+fmtMin(tIdS,true)+'</div><div class="sub">'+pOf(tIdS)+'%</div></div></div><div class="chart-grid"><div class="chart-card full"><div class="chart-title">\u7EDD\u5BF9\u503C</div><div class="chart-sub">\u7EB5\u8F74=\u5C0F\u65F6 \xB7 \u9EC4\u8272\u865A\u7EBF=\u6E05\u9192</div><canvas id="rSA" height="'+(dates.length>14?'160':'120')+'"></canvas></div><div class="chart-card full"><div class="chart-title">\u767E\u5206\u6BD4</div><div class="chart-sub">\u7EB5\u8F74=\u5360\u6E05\u9192%</div><canvas id="rSP" height="'+(dates.length>14?'160':'120')+'"></canvas></div></div>';
mkChart('rSA',{type:'line',data:{labels:labels,datasets:abD},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#6b7a9e',boxWidth:12,font:{size:11}}},tooltip:{callbacks:{label:function(c){var v=c.parsed.y;if(!v)return null;return c.dataset.label+': '+fmtMin(Math.round(v*60));}}},filler:{propagate:true}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:dates.length>14?45:0},grid:gridCfg},y:{stacked:true,ticks:{color:'#6b7a9e',callback:function(v){return v+'h';}},grid:gridCfg,min:0,max:yU},yR:{display:false,stacked:false,min:0,max:yU}}}});
mkChart('rSP',{type:'line',data:{labels:labels,datasets:pcD},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#6b7a9e',boxWidth:12,font:{size:11}},onClick:function(e,li,lg){var m=lg.chart.getDatasetMeta(li.datasetIndex);m.hidden=m.hidden===null?!lg.chart.data.datasets[li.datasetIndex].hidden:null;rpc(lg.chart);}},tooltip:{callbacks:{label:function(c){var v=c.parsed.y;if(!v)return null;return c.dataset.label+': '+v.toFixed(1)+'%';}}},filler:{propagate:true}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:dates.length>14?45:0},grid:gridCfg},y:{stacked:true,ticks:{color:'#6b7a9e',callback:function(v){return v+'%';}},grid:gridCfg,min:0,max:100}}}});
var slD=dates.map(function(ds){var d=computeDay(ds);return{ds:ds,wt:d.wakeTime,st:d.sleepTime,wm:parseMin(d.wakeTime),sm:parseMin(d.sleepTime),am:d.awakeMin,ac:d.actualMin,ut:d.utilPct};}).filter(function(d){return d.wm!=null||d.sm!=null;});
var aW=slD.filter(function(d){return d.wm!=null;}),aSl=slD.filter(function(d){return d.sm!=null;}),aAw=slD.filter(function(d){return d.am!=null;});
var avW=aW.length?Math.round(aW.reduce(function(s,d){return s+d.wm;},0)/aW.length):null,avS=aSl.length?Math.round(aSl.reduce(function(s,d){return s+d.sm;},0)/aSl.length):null,avA=aAw.length?Math.round(aAw.reduce(function(s,d){return s+d.am;},0)/aAw.length):null;
function mt(m){if(m==null)return '-';var h=Math.floor(m/60)%24,n2=m%60;return(h<10?'0':'')+h+':'+(n2<10?'0':'')+n2;}
function hToT(h){var hh=((Math.floor(h)%24)+24)%24,mm=Math.round((h-Math.floor(h))*60);return(hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;}
document.getElementById('tab-sleep').innerHTML='<div class="mini-grid" style="margin-bottom:16px"><div class="mini-card"><div class="lbl">\u5E73\u5747\u8D77\u5E8A</div><div class="val" style="color:var(--wake)">'+mt(avW)+'</div></div><div class="mini-card"><div class="lbl">\u5E73\u5747\u7761\u89C9</div><div class="val" style="color:var(--sleep)">'+mt(avS)+'</div></div><div class="mini-card"><div class="lbl">\u5E73\u5747\u6E05\u9192</div><div class="val">'+(avA!=null?fmtMin(avA):'-')+'</div></div></div><div class="chart-grid"><div class="chart-card full"><div class="chart-title">\u8D77\u5E8A / \u7761\u89C9\u65F6\u95F4\u8D70\u52BF</div><div class="chart-sub">\u7EB5\u8F74=24h \xB7 mod-24\u6EDA\u52A8</div><canvas id="rSL" height="100"></canvas></div></div><div class="card" style="margin-top:16px"><div class="card-title" style="margin-bottom:8px">\u4F5C\u606F\u660E\u7EC6</div><div class="table-wrap"><table><thead><tr><th>\u65E5\u671F</th><th>\u8D77\u5E8A</th><th>\u7761\u89C9</th><th>\u6E05\u9192</th><th>\u5B9E\u9645</th><th>\u5229\u7528\u7387</th></tr></thead><tbody>'+slD.map(function(d){return '<tr><td class="fw-mono">'+fmtShort(d.ds)+'</td><td class="fw-mono" style="color:var(--wake)">'+(d.wt||'-')+'</td><td class="fw-mono" style="color:var(--sleep)">'+(d.st||'-')+'</td><td class="fw-mono">'+fmtMin(d.am)+'</td><td class="fw-mono c-actual">'+fmtMin(d.ac)+'</td><td class="fw-mono '+(d.ut>=50?'c-green':d.ut>=30?'c-wake':'c-red')+'">'+(d.ut!=null?d.ut+'%':'-')+'</td></tr>';}).join('')+'</tbody></table></div></div>';
if(slD.length>0){var sL=slD.map(function(d){return fmtShort(d.ds);}),wD=slD.map(function(d){return d.wm!=null?+(d.wm/60).toFixed(2):null;}),sD2=slD.map(function(d){if(d.sm==null)return null;var h=d.sm/60;if(h<6)h+=24;return +h.toFixed(2);});var allY=wD.concat(sD2).filter(function(v){return v!=null;}),yMn=allY.length?Math.floor(Math.min.apply(null,allY)*2)/2-0.5:5,yMx2=allY.length?Math.ceil(Math.max.apply(null,allY)*2)/2+0.5:26;
mkChart('rSL',{type:'line',data:{labels:sL,datasets:[{label:'\u8D77\u5E8A',data:wD,borderColor:'#ffd54f',backgroundColor:'#ffd54f',pointRadius:4,showLine:true,borderWidth:1.5,tension:.3,fill:false},{label:'\u7761\u89C9',data:sD2,borderColor:'#b388ff',backgroundColor:'#b388ff',pointRadius:4,showLine:true,borderWidth:1.5,tension:.3,fill:false}]},options:{responsive:true,plugins:{legend:{labels:{color:'#6b7a9e'}},tooltip:{callbacks:{label:function(c){var v=c.parsed.y;if(v==null)return null;return c.dataset.label+': '+hToT(v);}}}},scales:{x:{ticks:{color:'#6b7a9e',maxRotation:slD.length>14?45:0},grid:gridCfg},y:{ticks:{color:'#6b7a9e',stepSize:1,callback:function(v){return hToT(v);}},grid:gridCfg,min:yMn,max:yMx2}}}});}
});
<\/script>
</body>
</html>`;
}

// ============================================================
// SETTINGS TAB
// ============================================================
function renderSettings() {
  const s = SETTINGS;
  const tc = s.themeColors;
  const aiCfg = (typeof aiLoadConfig === 'function') ? aiLoadConfig() : { split: {}, parse: {}, useSameConfig: true };

  document.getElementById('tab-settings').innerHTML = `
    <div style="max-width:900px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">⚙️ 全局设置</div>
        <p style="font-size:12px;color:var(--muted);margin:0">所有设置保存在浏览器 localStorage 中，修改后点击底部「保存全部设置」生效。</p>
      </div>

      <!-- 1. 外观与显示 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">🎨 外观与显示</div>
        <div class="form-grid" style="grid-template-columns:repeat(4,1fr)">
          <div class="form-group"><label>主色 (hp)</label><input type="color" id="set_tc_hp" value="${tc.hp}"></div>
          <div class="form-group"><label>绿色 (pol)</label><input type="color" id="set_tc_pol" value="${tc.pol}"></div>
          <div class="form-group"><label>紫色 (word)</label><input type="color" id="set_tc_word" value="${tc.word}"></div>
          <div class="form-group"><label>橙色 (thesis)</label><input type="color" id="set_tc_thesis" value="${tc.thesis}"></div>
          <div class="form-group"><label>红色 (code)</label><input type="color" id="set_tc_code" value="${tc.code}"></div>
          <div class="form-group"><label>灰色 (other)</label><input type="color" id="set_tc_other" value="${tc.other}"></div>
          <div class="form-group"><label>睡觉 (sleep)</label><input type="color" id="set_tc_sleep" value="${tc.sleep}"></div>
          <div class="form-group"><label>起床 (wake)</label><input type="color" id="set_tc_wake" value="${tc.wake}"></div>
        </div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px">
          <div class="form-group"><label>字体大小 (px)</label><input type="number" id="set_fontSize" value="${s.fontSize}" min="10" max="24"></div>
        </div>
        <div style="margin-top:8px">
          <div class="card-sub" style="margin-bottom:6px">活动类别颜色（按一级类别循环分配）</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="set_actColors">
            ${s.actColors.map((c, i) => `<div style="display:flex;align-items:center;gap:4px">
              <input type="color" id="set_ac_${i}" value="${c.color}" style="width:32px;height:24px;padding:0;border:none;cursor:pointer">
              <span style="font-size:10px;color:var(--muted)">${i + 1}</span>
            </div>`).join('')}
            <button class="btn btn-ghost btn-sm" onclick="settingsAddActColor()">+ 添加</button>
          </div>
        </div>
      </div>

      <!-- 2. 时间与计算规则 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">⏰ 时间与计算规则</div>
        <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
          <div class="form-group"><label>每日目标学习时长(h)</label><input type="number" id="set_dailyGoalHours" value="${s.dailyGoalHours}" min="1" max="24" step="0.5"></div>
          <div class="form-group"><label>起床目标时间(时)</label><input type="number" id="set_wakeGoalHour" value="${s.wakeGoalHour}" min="0" max="12" step="0.5"></div>
          <div class="form-group"><label>睡觉目标时间(时,0=0:00)</label><input type="number" id="set_sleepGoalHour" value="${s.sleepGoalHour}" min="-2" max="3" step="0.5"></div>
          <div class="form-group"><label>利用率达标线(%)</label><input type="number" id="set_utilPassPct" value="${s.utilPassPct}" min="0" max="100"></div>
          <div class="form-group"><label>专注效率-优秀(%)</label><input type="number" id="set_focusGoodPct" value="${s.focusGoodPct}" min="0" max="100"></div>
          <div class="form-group"><label>专注效率-及格(%)</label><input type="number" id="set_focusOkPct" value="${s.focusOkPct}" min="0" max="100"></div>
          <div class="form-group"><label>周起始日</label><select id="set_weekStartDay"><option value="1" ${s.weekStartDay === 1 ? 'selected' : ''}>周一</option><option value="0" ${s.weekStartDay === 0 ? 'selected' : ''}>周日</option></select></div>
        </div>
      </div>

      <!-- 3. AI 配置 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">🤖 AI 配置</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:10px">AI 接口配置与额外解析指令均在「🤖 AI录入」页管理；Step 2 并发数可在这里快速调整。</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:10px">
          <div class="form-group">
            <label>Step 2 同时解析本日项目数</label>
            <input type="number" id="set_aiParseConcurrency" value="${typeof aiNormalizeParseConcurrency === 'function' ? aiNormalizeParseConcurrency(aiCfg.parseConcurrency) : (parseInt(aiCfg.parseConcurrency) || 1)}" min="1" max="10" step="1">
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:10px">日期始终逐日处理；并发数仅控制当前日期相邻项目，范围 1-10。收到 429 会立即停止。</div>
        <button class="btn btn-primary btn-sm" onclick="showTab('ai')">前往 AI 录入页配置 →</button>
      </div>

      <!-- 4. 数据存储 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">💾 数据存储</div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-group"><label>自动保存草稿间隔(ms)</label><input type="number" id="set_autosaveInterval" value="${s.autosaveInterval}" min="1000" max="60000" step="1000"></div>
          <div class="form-group"><label>localStorage 缓存</label><select id="set_useLocalStorageCache"><option value="true" ${s.useLocalStorageCache ? 'selected' : ''}>开启</option><option value="false" ${!s.useLocalStorageCache ? 'selected' : ''}>关闭</option></select></div>
        </div>
        <div class="form-hint">数据文件路径在 app.py 中配置（DATA_DIR），当前：<code>C:\\Users\\24805\\OneDrive\\学习追踪器数据</code></div>
      </div>

      <!-- 5. 评分与评价规则 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">📊 评分与评价规则</div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:10px">月览表格中每天评分 = 满足以下条件的数量：</p>
        <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
          <div class="form-group"><label>条件1: 实际专注≥(分钟)</label><input type="number" id="set_ratingActualMin" value="${s.ratingActualMin}" min="0"></div>
          <div class="form-group"><label>条件2: 偏差率≥(%)</label><input type="number" id="set_ratingDeviationPct" value="${s.ratingDeviationPct}"></div>
          <div class="form-group"><label>条件3: 起床≤(分钟,480=8:00)</label><input type="number" id="set_ratingWakeLimit" value="${s.ratingWakeLimit}" min="0"></div>
          <div class="form-group"><label>条件4: 利用率≥(%)</label><input type="number" id="set_ratingUtilPct" value="${s.ratingUtilPct}" min="0" max="100"></div>
          <div class="form-group"><label>⭐ 需满足条件数≥</label><input type="number" id="set_ratingStarThreshold" value="${s.ratingStarThreshold}" min="1" max="4"></div>
          <div class="form-group"><label>👌 需满足条件数≥</label><input type="number" id="set_ratingOkThreshold" value="${s.ratingOkThreshold}" min="1" max="4"></div>
          <div class="form-group"><label>⚠️ 需满足条件数≥</label><input type="number" id="set_ratingWarnThreshold" value="${s.ratingWarnThreshold}" min="1" max="4"></div>
        </div>
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
          <div class="card-sub" style="margin-bottom:8px">作息颜色阈值</div>
          <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
            <div class="form-group"><label>起床绿色≤(分钟,420=7:00)</label><input type="number" id="set_wakeGoodMinute" value="${s.wakeGoodMinute}" min="0"></div>
            <div class="form-group"><label>起床黄色≤(分钟,480=8:00)</label><input type="number" id="set_wakeWarnMinute" value="${s.wakeWarnMinute}" min="0"></div>
            <div class="form-group"><label>睡觉绿色≤(小时,0=0:00)</label><input type="number" id="set_sleepGoodHour" value="${s.sleepGoodHour}" step="0.5"></div>
            <div class="form-group"><label>睡觉黄色≤(小时,0.5=0:30)</label><input type="number" id="set_sleepWarnHour" value="${s.sleepWarnHour}" step="0.5"></div>
          </div>
        </div>
      </div>

      <!-- 6. 活动类别管理 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">🏷️ 活动类别管理</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:10px">类别在「📋 模板库」页面和「✏️ 录入」页面均可管理，点击下方按钮前往。</p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="showTab('templates')">前往模板库管理 →</button>
          <button class="btn btn-ghost btn-sm" onclick="showTab('entry')">前往录入页 →</button>
        </div>
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">
          当前类别：一级 <b style="color:var(--text)">${getLevel1Names().length}</b> 个 · 二级 <b style="color:var(--text)">${getLevel2Names().length}</b> 个 · 三级 <b style="color:var(--text)">${getLevel3Names().length}</b> 个
        </div>
      </div>

      <!-- 7. 危险操作 -->
      <div class="card" style="margin-bottom:16px;border-color:rgba(244,67,54,.2)">
        <div class="card-title" style="margin-bottom:12px;color:var(--code)">⚠️ 危险操作</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-danger" onclick="clearRecordData()">🗑️ 清空已录入数据</button>
          <span style="font-size:11px;color:var(--muted)">仅清除日历中的时段/任务/作息记录，保留模板库、分类、AI配置等</span>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px">
          <button class="btn btn-danger" onclick="clearAllData()">🗑️ 清空所有数据</button>
          <span style="font-size:11px;color:var(--muted)">清空全部数据（包括模板、分类等），此操作不可恢复</span>
        </div>
        <div id="settings-danger-msg" style="margin-top:8px;font-family:var(--mono);font-size:12px"></div>
      </div>

      <!-- 操作按钮 -->
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-success" onclick="settingsSaveAll()">💾 保存全部设置</button>
        <button class="btn btn-danger btn-sm" onclick="settingsResetAll()">🔄 恢复默认设置</button>
        <span id="settings-msg" style="font-size:12px;font-family:var(--mono)"></span>
      </div>
    </div>
  `;
}

function settingsAddActColor() {
  SETTINGS.actColors.push({ color: '#ffffff', cls: 'custom' });
  renderSettings();
}

function settingsSaveAll() {
  const s = SETTINGS;
  // 外观
  const tcKeys = ['hp', 'pol', 'word', 'thesis', 'code', 'other', 'sleep', 'wake'];
  tcKeys.forEach(k => {
    const el = document.getElementById('set_tc_' + k);
    if (el) s.themeColors[k] = el.value;
  });
  s.fontSize = parseInt(document.getElementById('set_fontSize')?.value) || 14;
  // actColors
  const acEls = document.querySelectorAll('[id^="set_ac_"]');
  s.actColors = Array.from(acEls).map((el, i) => ({ color: el.value, cls: (DEFAULT_SETTINGS.actColors[i]?.cls || 'custom') }));

  // 时间规则
  s.dailyGoalHours = parseFloat(document.getElementById('set_dailyGoalHours')?.value) || 8;
  s.wakeGoalHour = parseFloat(document.getElementById('set_wakeGoalHour')?.value) || 7;
  s.sleepGoalHour = parseFloat(document.getElementById('set_sleepGoalHour')?.value) || 0;
  s.utilPassPct = parseInt(document.getElementById('set_utilPassPct')?.value) || 50;
  s.focusGoodPct = parseInt(document.getElementById('set_focusGoodPct')?.value) || 80;
  s.focusOkPct = parseInt(document.getElementById('set_focusOkPct')?.value) || 60;
  s.weekStartDay = parseInt(document.getElementById('set_weekStartDay')?.value) || 1;

  // 数据
  s.autosaveInterval = parseInt(document.getElementById('set_autosaveInterval')?.value) || 3000;
  s.useLocalStorageCache = document.getElementById('set_useLocalStorageCache')?.value === 'true';

  // 评分
  s.ratingActualMin = parseInt(document.getElementById('set_ratingActualMin')?.value) || 480;
  s.ratingDeviationPct = parseInt(document.getElementById('set_ratingDeviationPct')?.value) ?? -10;
  s.ratingWakeLimit = parseInt(document.getElementById('set_ratingWakeLimit')?.value) || 480;
  s.ratingUtilPct = parseInt(document.getElementById('set_ratingUtilPct')?.value) || 50;
  s.ratingStarThreshold = parseInt(document.getElementById('set_ratingStarThreshold')?.value) || 3;
  s.ratingOkThreshold = parseInt(document.getElementById('set_ratingOkThreshold')?.value) || 2;
  s.ratingWarnThreshold = parseInt(document.getElementById('set_ratingWarnThreshold')?.value) || 1;
  s.wakeGoodMinute = parseInt(document.getElementById('set_wakeGoodMinute')?.value) || 420;
  s.wakeWarnMinute = parseInt(document.getElementById('set_wakeWarnMinute')?.value) || 480;
  s.sleepGoodHour = parseFloat(document.getElementById('set_sleepGoodHour')?.value) || 0;
  s.sleepWarnHour = parseFloat(document.getElementById('set_sleepWarnHour')?.value) || 0.5;

  // AI quick settings
  if (typeof aiLoadConfig === 'function') {
    const aiCfg = aiLoadConfig();
    const aiExtraEl = document.getElementById('set_aiExtraPrompt');
    if (aiExtraEl) aiCfg.extraParsePrompt = aiExtraEl.value || '';
    const concurrencyEl = document.getElementById('set_aiParseConcurrency');
    if (concurrencyEl) {
      aiCfg.parseConcurrency = typeof aiNormalizeParseConcurrency === 'function'
        ? aiNormalizeParseConcurrency(concurrencyEl.value)
        : Math.min(10, Math.max(1, parseInt(concurrencyEl.value, 10) || 1));
    }
    aiPersistConfig(aiCfg);
  }

  SETTINGS = s;
  saveSettings(s);

  const msg = document.getElementById('settings-msg');
  if (msg) { msg.textContent = '✅ 设置已保存'; msg.style.color = 'var(--pol)'; setTimeout(() => msg.textContent = '', 3000); }
}

function settingsResetAll() {
  if (!confirm('确定恢复所有设置为默认值？')) return;
  SETTINGS = { ...DEFAULT_SETTINGS };
  saveSettings(SETTINGS);
  renderSettings();
  const msg = document.getElementById('settings-msg');
  if (msg) { msg.textContent = '🔄 已恢复默认设置'; msg.style.color = 'var(--muted)'; setTimeout(() => msg.textContent = '', 3000); }
}

// ============================================================
// SESSION ANALYSIS TAB (专注时段分析)
// ============================================================
function sessAnaGetDates() {
  const s = state.sessAna;
  if (s.mode === 'week') {
    return getWeekDays(s.weekStart);
  }
  const y = s.month.year, m = s.month.month;
  const dim = new Date(y, m + 1, 0).getDate();
  return Array.from({ length: dim }, (_, i) => `${y}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
}

function renderSessAnalysis() {
  const s = state.sessAna;
  const dateStrs = sessAnaGetDates();
  const labels = dateStrs.map(d => formatShort(d));
  const rangeLabel = s.mode === 'week'
    ? `${formatShort(dateStrs[0])} — ${formatShort(dateStrs[dateStrs.length - 1])}`
    : `${s.month.year}年${s.month.month + 1}月`;

  // 收集每天的 session 分类数据
  // 分类：特殊时段按 name 分组，普通时段归为"普通专注"
  const catMap = {}; // { catName: [{dateStr, clock, nominal, actual, rest}] }
  let totalSessCount = 0, totalClock = 0, totalNominal = 0, totalActual = 0, totalRest = 0, totalSpecial = 0, totalEffectiveClock = 0;

  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.sessions || []).forEach(sess => {
      totalSessCount++;
      const clk = sessionClock(sess);
      const nom = Number(sess.nominalMinutes) || 0;
      const act = Number(sess.actualMinutes) || 0;
      const rst = Number(sess.restMinutes) || 0;
      const cat = isUnavailableSession(sess) ? (sess.name || '特殊时段')
        : isSpecialStudySession(sess) ? `🧩 ${sess.name || '特殊学习'}` : '普通专注';
      if (isUnavailableSession(sess)) totalSpecial += clk;
      else if (isSpecialStudySession(sess)) {
        totalSpecial += Math.max(0, clk - act);
        totalEffectiveClock += act;
      } else {
        totalEffectiveClock += Math.max(0, clk - rst);
      }
      totalClock += clk; totalNominal += nom; totalActual += act; totalRest += rst;
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][ds]) catMap[cat][ds] = { clock: 0, nominal: 0, actual: 0, rest: 0, count: 0 };
      catMap[cat][ds].clock += clk;
      catMap[cat][ds].nominal += nom;
      catMap[cat][ds].actual += act;
      catMap[cat][ds].rest += rst;
      catMap[cat][ds].count++;
    });
  });

  const cats = Object.keys(catMap).sort((a, b) => a === '普通专注' ? -1 : b === '普通专注' ? 1 : a.localeCompare(b));
  const daysWithSess = dateStrs.filter(ds => (getDay(ds).sessions || []).length > 0).length;
  const avgActPerDay = daysWithSess > 0 ? Math.round(totalActual / daysWithSess) : 0;
  const eff = totalEffectiveClock > 0 ? Math.round(totalActual / totalEffectiveClock * 100) : null;

  // 每日折线图 datasets — 根据筛选决定显示方式
  const sessCatFilter = s.catFilter || '';
  let sessChartLabels, sessDayDS;

  if (sessCatFilter && catMap[sessCatFilter]) {
    // 单类别模式：只显示有数据的天，折线连续
    const filteredDays = dateStrs.filter(ds => catMap[sessCatFilter][ds]);
    sessChartLabels = filteredDays.map(d => formatShort(d));
    const isNormal = sessCatFilter === '普通专注';
    const hex = isNormal ? '#69f0ae' : getStackedColor(cats.indexOf(sessCatFilter));
    sessDayDS = [{
      label: sessCatFilter,
      data: filteredDays.map(ds => {
        const d = catMap[sessCatFilter][ds];
        return +((d.actual || d.clock || 0) / 60).toFixed(2);
      }),
      borderColor: hex, backgroundColor: hex,
      borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
      tension: 0.3, fill: false,
    }];
  } else {
    // 全部模式：所有类别、所有天
    sessChartLabels = labels;
    sessDayDS = cats.map((cat, ci) => {
      const isNormal = cat === '普通专注';
      const hex = isNormal ? '#69f0ae' : getStackedColor(ci);
      return {
        label: cat,
        data: dateStrs.map(ds => +((catMap[cat][ds]?.actual || (catMap[cat][ds]?.clock || 0)) / 60).toFixed(2)),
        borderColor: hex, backgroundColor: hex,
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: hex,
        tension: 0.3, fill: false,
      };
    });
  }

  // 每类别汇总
  const catStats = cats.map(cat => {
    let count = 0, clock = 0, nominal = 0, actual = 0, rest = 0;
    Object.values(catMap[cat]).forEach(v => { count += v.count; clock += v.clock; nominal += v.nominal; actual += v.actual; rest += v.rest; });
    const isSpecial = actual === 0 && clock > 0;
    const metric = isSpecial ? clock : actual;
    const effCat = !isSpecial && (clock - rest) > 0 ? Math.round(actual / (clock - rest) * 100) : null;
    const avgPerDay = daysWithSess > 0 ? Math.round(metric / daysWithSess) : 0;
    // 每天该类别的 metric 值数组（用于算 CV）
    const dailyVals = dateStrs.map(ds => {
      const d = catMap[cat][ds];
      if (!d) return 0;
      return isSpecial ? d.clock : d.actual;
    });
    const stats = calcStats(dailyVals);
    return { cat, count, clock, nominal, actual, rest, eff: effCat, isSpecial, avgAct: count > 0 ? Math.round(metric / count) : 0, avgPerDay, cv: stats.cv, stdDev: stats.stdDev };
  });
  // 总体每日实际专注的统计
  const sessOverallStats = calcStats(dateStrs.map(ds => {
    let a = 0;
    (getDay(ds).sessions || []).forEach(x => { if (x.type !== 'special') a += Number(x.actualMinutes) || 0; });
    return a;
  }));

  // 统计指标（根据筛选计算）
  let sessDisplayStats;
  if (sessCatFilter && catMap[sessCatFilter]) {
    const catDailyVals = dateStrs.map(ds => {
      const d = catMap[sessCatFilter][ds];
      if (!d) return 0;
      const isSpec = (d.actual === 0 && d.clock > 0);
      return isSpec ? d.clock : d.actual;
    });
    sessDisplayStats = calcStats(catDailyVals);
  } else {
    sessDisplayStats = sessOverallStats;
  }

  document.getElementById('tab-sessAnalysis').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
        <button class="btn btn-sm ${s.mode === 'week' ? 'btn-primary' : 'btn-ghost'}" onclick="sessAnaNav('mode','week')">周览</button>
        <button class="btn btn-sm ${s.mode === 'month' ? 'btn-primary' : 'btn-ghost'}" onclick="sessAnaNav('mode','month')">月览</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="sessAnaNav('prev')">← ${s.mode === 'week' ? '上周' : '上月'}</button>
      <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--hp)">${rangeLabel}</span>
      <button class="btn btn-ghost btn-sm" onclick="sessAnaNav('next')">${s.mode === 'week' ? '下周' : '下月'} →</button>
      <button class="btn btn-ghost btn-sm" onclick="sessAnaNav('today')">${s.mode === 'week' ? '本周' : '本月'}</button>
      ${cats.length > 1 ? `<span style="color:var(--dim);font-size:11px">│</span>
      <span style="font-size:11px;color:var(--muted)">类别：</span>
      <select onchange="sessAnaNav('catFilter',this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px">
        <option value="">全部 (${cats.length})</option>
        ${cats.map(c => `<option value="${escHtmlApp(c)}" ${sessCatFilter === c ? 'selected' : ''}>${escHtmlApp(c)}</option>`).join('')}
      </select>` : ''}
    </div>

    <div class="three-time" style="margin-bottom:16px">
      <div class="time-block clock"><div class="label">时段数</div><div class="value">${totalSessCount}</div><div class="sub">${daysWithSess} 天有记录</div></div>
      <div class="time-block actual"><div class="label">总·实际专注${tipIcon('actual')}</div><div class="value">${fmtMin(totalActual, true)}</div><div class="sub">日均 ${fmtMin(avgActPerDay)}</div></div>
      <div class="time-block nominal"><div class="label">总·名义${tipIcon('nominal')}</div><div class="value">${fmtMin(totalNominal, true)}</div><div class="sub">日均 ${fmtMin(daysWithSess > 0 ? Math.round(totalNominal / daysWithSess) : 0)}</div></div>
    </div>
    <div class="three-time" style="margin-bottom:20px">
      <div class="time-block clock"><div class="label">总·时钟${tipIcon('clock')}</div><div class="value">${fmtMin(totalClock, true)}</div><div class="sub">有效 ${fmtMin(totalClock - totalRest)} · 日均 ${fmtMin(daysWithSess > 0 ? Math.round(totalClock / daysWithSess) : 0)}</div></div>
      <div class="time-block" style="border-color:var(--sleep)"><div class="label">总·休息${tipIcon('rest')}</div><div class="value" style="color:var(--sleep)">${fmtMin(totalRest, true)}</div><div class="sub">日均 ${fmtMin(daysWithSess > 0 ? Math.round(totalRest / daysWithSess) : 0)}</div></div>
      <div class="time-block" style="border-color:${eff != null && eff >= 80 ? 'var(--green)' : 'var(--wake)'}"><div class="label">专注效率${tipIcon('efficiency')}</div><div class="value" style="color:${eff >= 80 ? 'var(--green)' : eff >= 60 ? 'var(--wake)' : 'var(--red)'}">${eff != null ? eff + '%' : '-'}</div></div>
    </div>
    <div class="three-time" style="margin-bottom:20px">
      ${sessCatFilter ? `<div class="time-block" style="border-color:var(--dim)"><div class="label">${escHtmlApp(sessCatFilter)}·CV${tipIcon('cv')}</div><div class="value" style="color:${sessDisplayStats.cv != null && sessDisplayStats.cv < 0.3 ? 'var(--green)' : 'var(--wake)'}">${fmtCV(sessDisplayStats.cv)}</div><div class="sub">σ = ${fmtSD(sessDisplayStats.stdDev)} · n=${sessDisplayStats.n}</div></div>` : ''}
      <div class="time-block" style="border-color:var(--dim)"><div class="label">数据天数</div><div class="value" style="color:var(--muted)">${sessCatFilter ? sessDisplayStats.n : daysWithSess}</div><div class="sub">共 ${dateStrs.length} 天</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">每日专注时长趋势${sessCatFilter ? '（' + escHtmlApp(sessCatFilter) + '）' : '（按类别）'}</div>
        <div class="chart-sub">折线图${sessCatFilter ? ' · 仅显示有数据的天' : ''} · 普通专注=实际分钟 · 特殊时段=时钟时长</div>
        <canvas id="sessAnaDailyChart" height="${s.mode === 'week' ? '100' : '120'}"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">类别汇总明细</div>
        <div class="chart-sub">每种时段的统计数据</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>类别</th><th>时段数</th><th>时钟${tipIcon('clock')}</th><th>名义${tipIcon('nominal')}</th><th>实际${tipIcon('actual')}</th><th>休息${tipIcon('rest')}</th><th>效率${tipIcon('efficiency')}</th><th>每段平均</th><th>日均</th><th>CV${tipIcon('cv')}</th></tr></thead>
            <tbody>${catStats.map(c => `<tr>
              <td style="font-weight:500">${escHtmlApp(c.cat)}</td>
              <td class="fw-mono">${c.count}</td>
              <td class="fw-mono c-clock">${fmtMin(c.clock, true)}</td>
              <td class="fw-mono c-nominal">${fmtMin(c.nominal, true)}</td>
              <td class="fw-mono c-actual">${fmtMin(c.actual, true)}</td>
              <td class="fw-mono">${fmtMin(c.rest, true)}</td>
              <td class="fw-mono ${c.eff >= 80 ? 'c-green' : c.eff >= 60 ? 'c-wake' : 'c-red'}">${c.eff != null ? c.eff + '%' : '-'}</td>
              <td class="fw-mono">${fmtMin(c.avgAct)}</td>
              <td class="fw-mono" style="color:var(--muted)">${fmtMin(c.avgPerDay)}</td>
              <td class="fw-mono" style="color:${c.cv != null && c.cv < 0.3 ? 'var(--green)' : c.cv != null && c.cv < 0.5 ? 'var(--wake)' : 'var(--red)'}">${fmtCV(c.cv)}</td>
            </tr>`).join('')}</tbody>
            <tfoot><tr><td>合计</td><td class="fw-mono">${totalSessCount}</td><td class="fw-mono c-clock">${fmtMin(totalClock, true)}</td><td class="fw-mono c-nominal">${fmtMin(totalNominal, true)}</td><td class="fw-mono c-actual">${fmtMin(totalActual, true)}</td><td class="fw-mono">${fmtMin(totalRest, true)}</td><td class="fw-mono">${eff != null ? eff + '%' : '-'}</td><td></td><td class="fw-mono" style="color:var(--muted)">${fmtMin(avgActPerDay)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  `;

  mkChart('sessAnaDailyChart', {
    type: 'line', data: { labels: sessChartLabels, datasets: sessDayDS },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6b7a9e', boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60))}`; } } }
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'month' ? 45 : 0 }, grid: gridCfg },
        y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, min: 0 }
      }
    }
  });
}

function sessAnaNav(action, val) {
  const s = state.sessAna;
  if (action === 'mode') { s.mode = val; }
  else if (action === 'catFilter') { s.catFilter = val; }
  else if (action === 'prev') { if (s.mode === 'week') s.weekStart = addDays(s.weekStart, -7); else { s.month.month--; if (s.month.month < 0) { s.month.month = 11; s.month.year--; } } }
  else if (action === 'next') { if (s.mode === 'week') s.weekStart = addDays(s.weekStart, 7); else { s.month.month++; if (s.month.month > 11) { s.month.month = 0; s.month.year++; } } }
  else if (action === 'today') { const n = new Date(); if (s.mode === 'week') s.weekStart = getMondayOfDate(n); else { s.month.year = n.getFullYear(); s.month.month = n.getMonth(); } }
  renderSessAnalysis();
}

// ============================================================
// TASK ANALYSIS TAB (任务记录分析)
// ============================================================
function taskAnaGetDates() {
  const s = state.taskAna;
  if (s.mode === 'week') return getWeekDays(s.weekStart);
  const y = s.month.year, m = s.month.month;
  const dim = new Date(y, m + 1, 0).getDate();
  return Array.from({ length: dim }, (_, i) => `${y}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
}

function renderTaskAnalysis() {
  const s = state.taskAna;
  const dateStrs = taskAnaGetDates();
  const labels = dateStrs.map(d => formatShort(d));
  const level = s.level || 1;
  const rangeLabel = s.mode === 'week'
    ? `${formatShort(dateStrs[0])} — ${formatShort(dateStrs[dateStrs.length - 1])}`
    : `${s.month.year}年${s.month.month + 1}月`;

  // 收集任务按类别分组
  const catMap = {}; // { catName: { [dateStr]: { min, qty, count } } }
  let totalCount = 0, totalMin = 0, totalQty = 0;

  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.tasks || []).forEach(t => {
      totalCount++;
      const min = Number(t.minutes) || 0;
      const qty = Number(t.quantity) || 0;
      totalMin += min; totalQty += qty;
      const cat = truncateActPath(t.activityType, level);
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][ds]) catMap[cat][ds] = { min: 0, qty: 0, count: 0, qtyUnit: '' };
      catMap[cat][ds].min += min;
      catMap[cat][ds].qty += qty;
      catMap[cat][ds].count++;
      if (t.quantityUnit) catMap[cat][ds].qtyUnit = t.quantityUnit;
    });
  });

  const cats = Object.keys(catMap).sort();
  const daysWithTasks = dateStrs.filter(ds => (getDay(ds).tasks || []).length > 0).length;
  const avgMinPerDay = daysWithTasks > 0 ? Math.round(totalMin / daysWithTasks) : 0;

  // 折线图 datasets — 根据筛选决定显示方式
  const taskCatFilter = s.catFilter || '';
  let taskChartLabels, taskDayDS;

  if (taskCatFilter && catMap[taskCatFilter]) {
    // 单类别模式：只显示有数据的天
    const filteredDays = dateStrs.filter(ds => catMap[taskCatFilter][ds]);
    taskChartLabels = filteredDays.map(d => formatShort(d));
    const hex = level === 1 ? (getActColor(taskCatFilter).color || getStackedColor(0)) : getStackedColor(cats.indexOf(taskCatFilter));
    taskDayDS = [{
      label: taskCatFilter,
      data: filteredDays.map(ds => +((catMap[taskCatFilter][ds].min || 0) / 60).toFixed(2)),
      borderColor: hex, backgroundColor: hex,
      borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
      tension: 0.3, fill: false,
    }];
  } else {
    // 全部模式
    taskChartLabels = labels;
    taskDayDS = cats.map((cat, ci) => {
      const hex = level === 1 ? (getActColor(cat).color || getStackedColor(ci)) : getStackedColor(ci);
      return {
        label: cat,
        data: dateStrs.map(ds => +((catMap[cat][ds]?.min || 0) / 60).toFixed(2)),
        borderColor: hex, backgroundColor: hex,
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: hex,
        tension: 0.3, fill: false,
      };
    });
  }

  // 每类别汇总
  const catStats = cats.map(cat => {
    let count = 0, min = 0, qty = 0, qtyUnit = '';
    Object.values(catMap[cat]).forEach(v => { count += v.count; min += v.min; qty += v.qty; if (v.qtyUnit) qtyUnit = v.qtyUnit; });
    const avgPerDay = daysWithTasks > 0 ? Math.round(min / daysWithTasks) : 0;
    const avgEff = (qty && min) ? +(qty / min).toFixed(2) : null;
    const dailyVals = dateStrs.map(ds => catMap[cat][ds]?.min || 0);
    const stats = calcStats(dailyVals);
    return { cat, count, min, qty, qtyUnit, avgMin: count > 0 ? Math.round(min / count) : 0, avgPerDay, avgEff, cv: stats.cv, stdDev: stats.stdDev };
  });
  // 效率趋势折线图 — 固定按三级分类（避免不同单位混淆）
  const effCatMap = {};
  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.tasks || []).forEach(t => {
      const qty = Number(t.quantity) || 0;
      const min = Number(t.minutes) || 0;
      if (!qty || !min) return;
      const cat3 = truncateActPath(t.activityType, 3);
      if (!effCatMap[cat3]) effCatMap[cat3] = {};
      if (!effCatMap[cat3][ds]) effCatMap[cat3][ds] = { qty: 0, min: 0, qtyUnit: '' };
      effCatMap[cat3][ds].qty += qty;
      effCatMap[cat3][ds].min += min;
      if (t.quantityUnit) effCatMap[cat3][ds].qtyUnit = t.quantityUnit;
    });
  });
  const effCats = Object.keys(effCatMap).sort();
  const effCatFilter = s.effCatFilter || '';

  // 根据筛选构建效率 datasets
  let effChartLabels, effDayDS;
  if (effCatFilter && effCatMap[effCatFilter]) {
    // 单类别：只显示有数据的天
    const filteredDays = dateStrs.filter(ds => effCatMap[effCatFilter][ds]);
    effChartLabels = filteredDays.map(d => formatShort(d));
    const hex = getStackedColor(effCats.indexOf(effCatFilter));
    let unit = '';
    Object.values(effCatMap[effCatFilter]).forEach(v => { if (v.qtyUnit) unit = v.qtyUnit; });
    effDayDS = [{
      label: effCatFilter + (unit ? ' (' + unit + '/min)' : ' (/min)'),
      data: filteredDays.map(ds => {
        const d = effCatMap[effCatFilter][ds];
        return +(d.qty / d.min).toFixed(3);
      }),
      borderColor: hex, backgroundColor: hex,
      borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
      tension: 0.3, fill: false,
    }];
  } else {
    // 全部类别
    effChartLabels = labels;
    effDayDS = effCats.map((cat, ci) => {
      const hex = getStackedColor(ci);
      let unit = '';
      Object.values(effCatMap[cat]).forEach(v => { if (v.qtyUnit) unit = v.qtyUnit; });
      return {
        label: cat + (unit ? ' (' + unit + '/min)' : ' (/min)'),
        data: dateStrs.map(ds => {
          const d = effCatMap[cat][ds];
          if (!d) return null;
          return +(d.qty / d.min).toFixed(3);
        }),
        borderColor: hex, backgroundColor: hex,
        borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
        tension: 0.3, fill: false, spanGaps: true,
      };
    });
  }

  // 效率统计（每个三级类别的效率 CV）
  const effCatStats = effCats.map(cat => {
    let unit = '', totalQty = 0, totalMin = 0;
    const dailyEffVals = [];
    Object.values(effCatMap[cat]).forEach(v => { totalQty += v.qty; totalMin += v.min; if (v.qtyUnit) unit = v.qtyUnit; });
    dateStrs.forEach(ds => {
      const d = effCatMap[cat][ds];
      if (d && d.min > 0) dailyEffVals.push(d.qty / d.min);
    });
    const stats = calcStats(dailyEffVals);
    const avgEff = totalMin > 0 ? +(totalQty / totalMin).toFixed(3) : null;
    return { cat, unit, avgEff, cv: stats.cv, stdDev: stats.stdDev, n: stats.n };
  });

  // 当前筛选的效率统计
  let effDisplayStats = null;
  if (effCatFilter) {
    effDisplayStats = effCatStats.find(c => c.cat === effCatFilter) || null;
  }

  document.getElementById('tab-taskAnalysis').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
        <button class="btn btn-sm ${s.mode === 'week' ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('mode','week')">周览</button>
        <button class="btn btn-sm ${s.mode === 'month' ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('mode','month')">月览</button>
      </div>
      <span style="color:var(--dim);font-size:11px">│</span>
      <span style="font-size:11px;color:var(--muted)">类别层级：</span>
      <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
        <button class="btn btn-sm ${level === 1 ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('level',1)">一级</button>
        <button class="btn btn-sm ${level === 2 ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('level',2)">二级</button>
        <button class="btn btn-sm ${level === 3 ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('level',3)">三级</button>
      </div>
      <span style="color:var(--dim);font-size:11px">│</span>
      <button class="btn btn-ghost btn-sm" onclick="taskAnaNav('prev')">← ${s.mode === 'week' ? '上周' : '上月'}</button>
      <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--hp)">${rangeLabel}</span>
      <button class="btn btn-ghost btn-sm" onclick="taskAnaNav('next')">${s.mode === 'week' ? '下周' : '下月'} →</button>
      <button class="btn btn-ghost btn-sm" onclick="taskAnaNav('today')">${s.mode === 'week' ? '本周' : '本月'}</button>
      ${cats.length > 1 ? `<span style="color:var(--dim);font-size:11px">│</span>
      <span style="font-size:11px;color:var(--muted)">筛选：</span>
      <select onchange="taskAnaNav('catFilter',this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px">
        <option value="">全部 (${cats.length})</option>
        ${cats.map(c => `<option value="${escHtmlApp(c)}" ${taskCatFilter === c ? 'selected' : ''}>${escHtmlApp(c)}</option>`).join('')}
      </select>` : ''}
    </div>

    <div class="three-time" style="margin-bottom:16px">
      <div class="time-block actual"><div class="label">任务总数</div><div class="value">${totalCount}</div><div class="sub">${daysWithTasks} 天 · ${cats.length} 个类别 · 日均 ${daysWithTasks > 0 ? (totalCount / daysWithTasks).toFixed(1) : 0} 条</div></div>
      <div class="time-block nominal"><div class="label">总时长${tipIcon('taskMin')}</div><div class="value">${fmtMin(totalMin, true)}</div><div class="sub">日均 ${fmtMin(avgMinPerDay)}</div></div>
      <div class="time-block clock"><div class="label">每条平均</div><div class="value">${totalCount > 0 ? fmtMin(Math.round(totalMin / totalCount)) : '-'}</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">每日任务时长趋势${taskCatFilter ? '（' + escHtmlApp(taskCatFilter) + '）' : '（按类别）'}</div>
        <div class="chart-sub">折线图${taskCatFilter ? ' · 仅显示有数据的天' : ''} · 纵轴=小时</div>
        <canvas id="taskAnaDailyChart" height="${s.mode === 'week' ? '100' : '120'}"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">类别时间占比</div>
        <div class="chart-sub">各类别累计时长</div>
        <canvas id="taskAnaPieChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">每日任务数量</div>
        <div class="chart-sub">柱图=条数 · 折线=时长(h)</div>
        <canvas id="taskAnaCountChart" height="200"></canvas>
      </div>
      ${effCats.length > 0 ? `<div class="chart-card full">
        <div class="chart-title">各类别效率趋势（按三级分类）${effCatFilter ? ' — ' + escHtmlApp(effCatFilter) : ''}</div>
        <div class="chart-sub">折线图 · 效率 = 数量 ÷ 时长(分钟)${effCatFilter ? ' · 仅显示有数据的天' : ''}</div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--muted)">纵轴：</span>
          <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
            <button class="btn btn-sm ${s.effScale === 'linear' ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('effScale','linear')">线性</button>
            <button class="btn btn-sm ${s.effScale === 'log' ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('effScale','log')">对数</button>
            <button class="btn btn-sm ${s.effScale === 'normalize' ? 'btn-primary' : 'btn-ghost'}" onclick="taskAnaNav('effScale','normalize')">归一化</button>
          </div>
          ${s.effScale === 'linear' ? `<span style="font-size:11px;color:var(--muted)">Y轴上限：</span>
          <input type="number" id="effYMaxInput" value="${s.effYMax}" placeholder="自动" min="0" step="0.5"
            style="width:70px;padding:3px 8px;font-size:12px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px"
            onchange="state.taskAna.effYMax=this.value;renderTaskAnalysis()">` : ''}
          ${s.effScale === 'normalize' ? '<span style="font-size:10px;color:var(--dim)">归一化到自身最大值百分比</span>' : ''}
          ${effCats.length > 1 ? `<span style="color:var(--dim);font-size:11px">│</span>
          <span style="font-size:11px;color:var(--muted)">筛选：</span>
          <select onchange="taskAnaNav('effCatFilter',this.value)" style="font-size:12px;padding:3px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px">
            <option value="">全部 (${effCats.length})</option>
            ${effCats.map(c => `<option value="${escHtmlApp(c)}" ${effCatFilter === c ? 'selected' : ''}>${escHtmlApp(c)}</option>`).join('')}
          </select>` : ''}
        </div>
        ${effDisplayStats ? `<div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;font-size:12px">
          <span style="color:var(--muted)">平均效率: <b style="color:var(--text)">${effDisplayStats.avgEff}${effDisplayStats.unit ? ' ' + effDisplayStats.unit + '/min' : '/min'}</b></span>
          <span style="color:var(--muted)">CV${tipIcon('cv')}: <b style="color:${effDisplayStats.cv != null && effDisplayStats.cv < 0.3 ? 'var(--green)' : 'var(--wake)'}">${fmtCV(effDisplayStats.cv)}</b> (n=${effDisplayStats.n})</span>
        </div>` : ''}
        <canvas id="taskAnaEffChart" height="${s.mode === 'week' ? '100' : '120'}"></canvas>
      </div>` : ''}
      <div class="chart-card full">
        <div class="chart-title">类别汇总明细</div>
        <div class="chart-sub">每种活动类别的统计</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>类别</th><th>任务数</th><th>总时长</th><th>每条平均</th><th>日均</th>${level === 3 ? '<th>总数量</th><th>平均效率</th><th>效率CV' + tipIcon('cv') + '</th>' : ''}</tr></thead>
            <tbody>${catStats.map(c => {
    const hex = level === 1 ? (getActColor(c.cat).color || '#78909c') : '#78909c';
    const ecs = level === 3 ? effCatStats.find(e => e.cat === c.cat) : null;
    return `<tr>
              <td><span class="badge" style="background:${hexRgba(hex, 0.13)};color:${hex};border:1px solid ${hexRgba(hex, 0.3)}">${escHtmlApp(c.cat)}</span></td>
              <td class="fw-mono">${c.count}</td>
              <td class="fw-mono c-actual">${fmtMin(c.min, true)}</td>
              <td class="fw-mono">${fmtMin(c.avgMin)}</td>
              <td class="fw-mono" style="color:var(--muted)">${fmtMin(c.avgPerDay)}</td>
              ${level === 3 ? `<td class="fw-mono">${c.qty ? c.qty + (c.qtyUnit ? ' ' + c.qtyUnit : '') : '-'}</td>
              <td class="fw-mono">${c.avgEff != null ? c.avgEff + (c.qtyUnit ? ' ' + c.qtyUnit + '/min' : '/min') : '-'}</td>
              <td class="fw-mono" style="color:${ecs && ecs.cv != null && ecs.cv < 0.3 ? 'var(--green)' : ecs && ecs.cv != null && ecs.cv < 0.5 ? 'var(--wake)' : ecs && ecs.cv != null ? 'var(--red)' : 'var(--muted)'}">${ecs ? fmtCV(ecs.cv) : '-'}</td>` : ''}
            </tr>`;
  }).join('')}</tbody>
            <tfoot><tr><td>合计</td><td class="fw-mono">${totalCount}</td><td class="fw-mono c-actual">${fmtMin(totalMin, true)}</td><td class="fw-mono">${totalCount > 0 ? fmtMin(Math.round(totalMin / totalCount)) : '-'}</td><td class="fw-mono" style="color:var(--muted)">${fmtMin(avgMinPerDay)}</td>${level === 3 ? '<td colspan="3"></td>' : ''}</tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  `;

  // 堆叠柱图
  mkChart('taskAnaDailyChart', {
    type: 'line', data: { labels: taskChartLabels, datasets: taskDayDS },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6b7a9e', boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60))}`; } } }
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'month' ? 45 : 0 }, grid: gridCfg },
        y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, min: 0 }
      }
    }
  });

  // 饼图
  const pieData = catStats.filter(c => c.min > 0);
  if (pieData.length > 0) {
    mkChart('taskAnaPieChart', {
      type: 'doughnut', data: {
        labels: pieData.map(c => c.cat),
        datasets: [{ data: pieData.map(c => c.min), backgroundColor: pieData.map((c, i) => hexRgba(level === 1 ? (getActColor(c.cat).color || getStackedColor(i)) : getStackedColor(i), 0.75)), borderWidth: 1 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)}` } } } }
    });
  }

  // 每日条数+时长
  const dayCounts = dateStrs.map(ds => (getDay(ds).tasks || []).length);
  const dayMins = dateStrs.map(ds => +((getDay(ds).tasks || []).reduce((s, t) => s + (Number(t.minutes) || 0), 0) / 60).toFixed(2));
  mkChart('taskAnaCountChart', {
    type: 'bar', data: {
      labels, datasets: [
        { label: '任务条数', data: dayCounts, backgroundColor: 'rgba(79,195,247,.35)', borderColor: '#4fc3f7', borderWidth: 1, borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: '时长(h)', data: dayMins, borderColor: '#69f0ae', borderWidth: 2, pointRadius: 3, tension: .3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true, plugins: { legend: { labels: { color: '#6b7a9e' } } },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'month' ? 45 : 0 }, grid: gridCfg },
        y: { ticks: { color: '#6b7a9e' }, grid: gridCfg, min: 0, title: { display: true, text: '条数', color: '#6b7a9e' } },
        y1: { ticks: { color: '#69f0ae', callback: v => v + 'h' }, grid: { drawOnChartArea: false }, position: 'right', min: 0 }
      }
    }
  });

  // 效率趋势图
  if (effDayDS.length > 0) {
    const effScale = s.effScale || 'linear';
    let chartDS = effDayDS;
    let yTitle = '效率 (数量/分钟)';
    let yType = 'linear';
    let yMin = 0;
    let yMax = s.effYMax ? parseFloat(s.effYMax) : undefined;
    let tooltipFmt = (ctx) => { const v = ctx.parsed.y; if (v == null) return null; return `${ctx.dataset.label}: ${v.toFixed(3)}`; };

    if (effScale === 'log') {
      yType = 'logarithmic';
      yMin = undefined; // log 轴不能从 0 开始
      yMax = undefined;
      yTitle = '效率 · 对数轴 (数量/分钟)';
    } else if (effScale === 'normalize') {
      yTitle = '归一化效率 (% of 自身最大值)';
      yMax = 105;
      chartDS = effDayDS.map(ds => {
        const vals = ds.data.filter(v => v != null);
        const maxVal = vals.length > 0 ? Math.max(...vals) : 1;
        return {
          ...ds,
          data: ds.data.map(v => v == null ? null : +(v / maxVal * 100).toFixed(1)),
        };
      });
      tooltipFmt = (ctx) => { const v = ctx.parsed.y; if (v == null) return null; return `${ctx.dataset.label}: ${v.toFixed(1)}%`; };
    }

    mkChart('taskAnaEffChart', {
      type: 'line', data: { labels: effChartLabels, datasets: chartDS },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: '#6b7a9e', boxWidth: 12 } },
          tooltip: { callbacks: { label: tooltipFmt } }
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'month' ? 45 : 0 }, grid: gridCfg },
          y: { type: yType, ticks: { color: '#6b7a9e' }, grid: gridCfg, min: yMin, max: yMax, title: { display: true, text: yTitle, color: '#6b7a9e' } }
        }
      }
    });
  }
}

function taskAnaNav(action, val) {
  const s = state.taskAna;
  if (action === 'mode') { s.mode = val; }
  else if (action === 'level') { s.level = val; s.catFilter = ''; }
  else if (action === 'effScale') { s.effScale = val; }
  else if (action === 'catFilter') { s.catFilter = val; }
  else if (action === 'effCatFilter') { s.effCatFilter = val; }
  else if (action === 'prev') { if (s.mode === 'week') s.weekStart = addDays(s.weekStart, -7); else { s.month.month--; if (s.month.month < 0) { s.month.month = 11; s.month.year--; } } }
  else if (action === 'next') { if (s.mode === 'week') s.weekStart = addDays(s.weekStart, 7); else { s.month.month++; if (s.month.month > 11) { s.month.month = 0; s.month.year++; } } }
  else if (action === 'today') { const n = new Date(); if (s.mode === 'week') s.weekStart = getMondayOfDate(n); else { s.month.year = n.getFullYear(); s.month.month = n.getMonth(); } }
  renderTaskAnalysis();
}

// ============================================================
// STACKED AREA CHART TAB
// ============================================================

/**
 * 收集一天的时间分解数据：
 * 返回 { awakeHrs, categories: { '政治': hrs, '吃饭(特殊)': hrs, ... }, idleHrs }
 */
function computeDayBreakdown(dateStr) {
  const day = getDay(dateStr);
  const sessions = day.sessions || [];
  const tasks = day.tasks || [];

  // 清醒时长
  const wakeMin = parseMin(day.wakeTime), sleepMin = parseMin(day.sleepTime);
  let awakeMin = null;
  if (wakeMin != null && sleepMin != null) {
    let adjSleepMin = sleepMin;
    if (adjSleepMin >= 720 && adjSleepMin < 780) adjSleepMin -= 720;
    awakeMin = adjSleepMin - wakeMin;
    if (awakeMin <= 0) awakeMin += 1440;
  }

  // 特殊时段按名称分组
  const specialMap = {};
  let totalSpecialMin = 0;
  sessions.forEach(s => {
    if (isUnavailableSession(s)) {
      const name = s.name || '特殊时段';
      const dur = sessionClock(s);
      specialMap[name] = (specialMap[name] || 0) + dur;
      totalSpecialMin += dur;
    } else if (isSpecialStudySession(s)) {
      const name = `${s.name || '特殊学习'}（不可用部分）`;
      const dur = Math.max(0, sessionClock(s) - (Number(s.actualMinutes) || 0));
      specialMap[name] = (specialMap[name] || 0) + dur;
      totalSpecialMin += dur;
    }
  });

  // 普通 session 的实际专注总时长
  let focusActualMin = 0;
  let focusRestMin = 0;
  let focusDistractMin = 0;
  sessions.forEach(s => {
    if (isSpecialStudySession(s)) {
      focusActualMin += Number(s.actualMinutes) || 0;
    } else if (!isUnavailableSession(s)) {
      focusActualMin += Number(s.actualMinutes) || 0;
      focusRestMin += Number(s.restMinutes) || 0;
      const clk = sessionClock(s);
      const actual = Number(s.actualMinutes) || 0;
      const rest = Number(s.restMinutes) || 0;
      focusDistractMin += Math.max(0, clk - actual - rest);
    }
  });

  // 任务按活动类型分组
  const taskMap = {};
  let totalTaskMin = 0;
  tasks.forEach(t => {
    const act = t.activityType || '未分类';
    const min = Number(t.minutes) || 0;
    taskMap[act] = (taskMap[act] || 0) + min;
    totalTaskMin += min;
  });

  // 已占用时间 = 任务时长 + 特殊时段 + 专注时段中的休息 + 分心
  // 注意：任务时长和专注时段可能有重叠，但用户录入时是独立的
  // 我们把所有可识别的时间加起来，剩余的算作"空闲/未记录"
  const accountedMin = totalTaskMin + totalSpecialMin + focusRestMin + focusDistractMin;

  let idleMin = 0;
  if (awakeMin != null) {
    idleMin = Math.max(0, awakeMin - accountedMin);
  }

  return {
    awakeMin,
    taskMap,        // { '政治': 120, '英语': 90, ... }
    specialMap,     // { '吃饭': 60, '通勤': 30, ... }
    focusRestMin,
    focusDistractMin,
    totalTaskMin,
    totalSpecialMin,
    idleMin,
  };
}

/**
 * 从多天数据中收集所有出现过的类别（任务类别 + 特殊时段名）
 */
function collectAllCategories(dateStrs) {
  const taskCats = new Set();
  const specialCats = new Set();
  dateStrs.forEach(d => {
    const bd = computeDayBreakdown(d);
    Object.keys(bd.taskMap).forEach(k => taskCats.add(k));
    Object.keys(bd.specialMap).forEach(k => specialCats.add(k));
  });
  return { taskCats: [...taskCats].sort(), specialCats: [...specialCats].sort() };
}

/** 截断 activityType 路径到指定层级 */
function truncateActPath(path, level) {
  if (!path) return '未分类';
  const parts = path.split(' > ');
  return parts.slice(0, level).join(' > ') || '未分类';
}

/** 按指定层级重新分组 taskMap */
function regroupTaskMap(taskMap, level) {
  if (level >= 3) return { ...taskMap }; // 三级=原样
  const grouped = {};
  Object.keys(taskMap).forEach(fullPath => {
    const key = truncateActPath(fullPath, level);
    grouped[key] = (grouped[key] || 0) + taskMap[fullPath];
  });
  return grouped;
}

// 堆积图配色方案（与主题色系一致但区分度更高）
const STACKED_PALETTE = [
  '#4fc3f7', '#69f0ae', '#ce93d8', '#ffb74d', '#ef9a9a',
  '#80deea', '#ffd54f', '#a5d6a7', '#f48fb1', '#90caf9',
  '#b39ddb', '#ffcc80', '#80cbc4', '#e6ee9c', '#bcaaa4',
];

function getStackedColor(index) {
  return STACKED_PALETTE[index % STACKED_PALETTE.length];
}

function hexRgba(hex, a) {
  if (!hex || hex[0] !== '#') return `rgba(120,144,156,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function renderStackedArea() {
  const mode = state.stackedMode || 'week';
  let dateStrs, rangeLabel, prevAction, nextAction, todayAction;

  if (mode === 'week') {
    dateStrs = getWeekDays(state.stackedWeekStart);
    rangeLabel = `${formatShort(dateStrs[0])} — ${formatShort(dateStrs[6])}`;
    prevAction = `stackedNav('week', -7)`;
    nextAction = `stackedNav('week', 7)`;
    todayAction = `stackedGoToday('week')`;
  } else {
    const y = state.stackedMonth.year, m = state.stackedMonth.month;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    dateStrs = [];
    for (let i = 1; i <= daysInMonth; i++) {
      dateStrs.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
    }
    rangeLabel = `${y}年${m + 1}月`;
    prevAction = `stackedNav('month', -1)`;
    nextAction = `stackedNav('month', 1)`;
    todayAction = `stackedGoToday('month')`;
  }

  const { specialCats } = collectAllCategories(dateStrs);
  const rawBreakdowns = dateStrs.map(d => computeDayBreakdown(d));
  const groupLevel = state.stackedGroupLevel || 1;

  // 按选定层级重新分组每天的 taskMap
  const breakdowns = rawBreakdowns.map(bd => ({
    ...bd,
    taskMap: regroupTaskMap(bd.taskMap, groupLevel),
    totalTaskMin: bd.totalTaskMin, // 不变
  }));

  // 收集重新分组后的所有任务类别
  const taskCatsSet = new Set();
  breakdowns.forEach(bd => Object.keys(bd.taskMap).forEach(k => taskCatsSet.add(k)));
  const taskCats = [...taskCatsSet].sort();

  const labels = dateStrs.map(d => formatShort(d));

  // ── 构建堆积 datasets（绝对值 + 百分比共用逻辑） ──
  function buildDatasets(valueFn) {
    const ds = [];
    let ci = 0;
    // 任务类别
    taskCats.forEach(cat => {
      // 一级用主题色，二/三级用调色板保证同父类的子类颜色可区分
      const hex = groupLevel === 1
        ? (getActColor(cat).color || getStackedColor(ci))
        : getStackedColor(ci);
      ds.push({
        label: cat,
        data: breakdowns.map(bd => valueFn(bd.taskMap[cat] || 0, bd)),
        backgroundColor: hexRgba(hex, 0.75),
        borderColor: hexRgba(hex, 0.9),
        borderWidth: 0.5,
        fill: 'origin',
        pointRadius: 0,
        tension: 0.35,
      });
      ci++;
    });
    // 特殊时段
    specialCats.forEach(cat => {
      const hex = getStackedColor(ci);
      ds.push({
        label: '🔸' + cat,
        data: breakdowns.map(bd => valueFn(bd.specialMap[cat] || 0, bd)),
        backgroundColor: hexRgba(hex, 0.6),
        borderColor: hexRgba(hex, 0.8),
        borderWidth: 0.5,
        fill: 'origin',
        pointRadius: 0,
        tension: 0.35,
      });
      ci++;
    });
    // 休息
    ds.push({
      label: '😴 休息',
      data: breakdowns.map(bd => valueFn(bd.focusRestMin, bd)),
      backgroundColor: 'rgba(179,136,255,0.55)',
      borderColor: 'rgba(179,136,255,0.8)',
      borderWidth: 0.5,
      fill: 'origin', pointRadius: 0, tension: 0.35,
    });
    // 分心
    ds.push({
      label: '😶 分心',
      data: breakdowns.map(bd => valueFn(bd.focusDistractMin, bd)),
      backgroundColor: 'rgba(244,67,54,0.45)',
      borderColor: 'rgba(244,67,54,0.7)',
      borderWidth: 0.5,
      fill: 'origin', pointRadius: 0, tension: 0.35,
    });
    // 空闲
    ds.push({
      label: '⬜ 空闲/未记录',
      data: breakdowns.map(bd => valueFn(bd.idleMin, bd)),
      backgroundColor: 'rgba(61,74,106,0.45)',
      borderColor: 'rgba(61,74,106,0.7)',
      borderWidth: 0.5,
      fill: 'origin', pointRadius: 0, tension: 0.35,
    });
    return ds;
  }

  // 绝对值 datasets（单位：小时）
  const absDatasets = buildDatasets((min, _bd) => +(min / 60).toFixed(2));
  // 清醒参考线（独立 y 轴，不参与堆积）
  absDatasets.push({
    label: '── 清醒时长',
    data: breakdowns.map(bd => bd.awakeMin != null ? +(bd.awakeMin / 60).toFixed(1) : null),
    borderColor: '#ffd54f',
    borderWidth: 2.5,
    borderDash: [8, 4],
    backgroundColor: 'transparent',
    fill: false,
    pointRadius: 3,
    pointBackgroundColor: '#ffd54f',
    tension: 0.35,
    yAxisID: 'yRef',
  });

  // 百分比 datasets — 存储原始分钟数，动态归一化到 100%
  const pctDatasets = buildDatasets((min, _bd) => min); // 原始分钟值
  // 在每个 dataset 上保存一份原始数据副本
  pctDatasets.forEach(ds => { ds._rawData = [...ds.data]; });

  /** 根据可见 dataset 动态重算百分比，保证可见部分始终堆满 100% */
  function recalcPctData(chart) {
    const dsList = chart.data.datasets;
    const len = dsList[0]?.data?.length || 0;
    for (let i = 0; i < len; i++) {
      let sum = 0;
      dsList.forEach((ds, di) => {
        if (!ds._rawData) return;
        if (!chart.getDatasetMeta(di).hidden) sum += ds._rawData[i] || 0;
      });
      dsList.forEach((ds, di) => {
        if (!ds._rawData) return;
        if (chart.getDatasetMeta(di).hidden) {
          ds.data[i] = 0;
        } else {
          ds.data[i] = sum > 0 ? +((ds._rawData[i] / sum) * 100).toFixed(1) : 0;
        }
      });
    }
    chart.update('none');
  }

  // 创建图表前先归一化（避免首帧用原始分钟数渲染）
  (function preNormalize() {
    const len = pctDatasets[0]?.data?.length || 0;
    for (let i = 0; i < len; i++) {
      let sum = 0;
      pctDatasets.forEach(ds => { if (ds._rawData) sum += ds._rawData[i] || 0; });
      pctDatasets.forEach(ds => {
        if (!ds._rawData) return;
        ds.data[i] = sum > 0 ? +((ds._rawData[i] / sum) * 100).toFixed(1) : 0;
      });
    }
  })();

  // ── 汇总统计 ──
  const totalAwake = breakdowns.reduce((s, bd) => s + (bd.awakeMin || 0), 0);
  const totalTask = breakdowns.reduce((s, bd) => s + bd.totalTaskMin, 0);
  const totalSpecial = breakdowns.reduce((s, bd) => s + bd.totalSpecialMin, 0);
  const totalRest = breakdowns.reduce((s, bd) => s + bd.focusRestMin, 0);
  const totalDistract = breakdowns.reduce((s, bd) => s + bd.focusDistractMin, 0);
  const totalIdle = breakdowns.reduce((s, bd) => s + bd.idleMin, 0);
  const daysWithData = breakdowns.filter(bd => bd.awakeMin != null && (bd.totalTaskMin > 0 || bd.totalSpecialMin > 0)).length;
  const pctOf = (part) => totalAwake > 0 ? Math.round(part / totalAwake * 100) : 0;

  document.getElementById('tab-stacked').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
        <button class="btn btn-sm ${mode === 'week' ? 'btn-primary' : 'btn-ghost'}" onclick="switchStackedMode('week')">周览</button>
        <button class="btn btn-sm ${mode === 'month' ? 'btn-primary' : 'btn-ghost'}" onclick="switchStackedMode('month')">月览</button>
      </div>
      <span style="color:var(--dim);font-size:11px">│</span>
      <span style="font-size:11px;color:var(--muted)">类别层级：</span>
      <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
        <button class="btn btn-sm ${groupLevel === 1 ? 'btn-primary' : 'btn-ghost'}" onclick="switchStackedLevel(1)">一级</button>
        <button class="btn btn-sm ${groupLevel === 2 ? 'btn-primary' : 'btn-ghost'}" onclick="switchStackedLevel(2)">二级</button>
        <button class="btn btn-sm ${groupLevel === 3 ? 'btn-primary' : 'btn-ghost'}" onclick="switchStackedLevel(3)">三级</button>
      </div>
      <span style="color:var(--dim);font-size:11px">│</span>
      <button class="btn btn-ghost btn-sm" onclick="${prevAction}">← ${mode === 'week' ? '上周' : '上月'}</button>
      <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--hp)">${rangeLabel}</span>
      <button class="btn btn-ghost btn-sm" onclick="${nextAction}">${mode === 'week' ? '下周' : '下月'} →</button>
      <button class="btn btn-ghost btn-sm" onclick="${todayAction}">${mode === 'week' ? '本周' : '本月'}</button>
    </div>

    <div class="three-time" style="margin-bottom:16px">
      <div class="time-block clock"><div class="label">清醒总时长${tipIcon('stackAwake')}</div><div class="value">${fmtMin(totalAwake, true)}</div><div class="sub">${daysWithData} 天有数据</div></div>
      <div class="time-block actual"><div class="label">任务记录总时长${tipIcon('stackTask')}</div><div class="value">${fmtMin(totalTask, true)}</div><div class="sub">占清醒 ${pctOf(totalTask)}%</div></div>
      <div class="time-block nominal"><div class="label">特殊时段总时长${tipIcon('stackSpecial')}</div><div class="value">${fmtMin(totalSpecial, true)}</div><div class="sub">占清醒 ${pctOf(totalSpecial)}%</div></div>
    </div>
    <div class="three-time" style="margin-bottom:20px">
      <div class="time-block" style="border-color:var(--sleep)"><div class="label">休息时间${tipIcon('stackRest')}</div><div class="value" style="color:var(--sleep)">${fmtMin(totalRest, true)}</div><div class="sub">占清醒 ${pctOf(totalRest)}%</div></div>
      <div class="time-block" style="border-color:var(--red)"><div class="label">分心时间${tipIcon('stackDistract')}</div><div class="value" style="color:var(--red)">${fmtMin(totalDistract, true)}</div><div class="sub">占清醒 ${pctOf(totalDistract)}%</div></div>
      <div class="time-block" style="border-color:var(--dim)"><div class="label">空闲/未记录${tipIcon('stackIdle')}</div><div class="value" style="color:var(--dim)">${fmtMin(totalIdle, true)}</div><div class="sub">占清醒 ${pctOf(totalIdle)}%</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">时间分解 · 堆积面积图（绝对值）</div>
        <div class="chart-sub">纵轴=小时 · 每天清醒时段的时间去向 · 黄色虚线为清醒总时长</div>
        <canvas id="stackedAbsChart" height="${mode === 'week' ? '140' : '160'}"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">时间分解 · 百分比堆积面积图</div>
        <div class="chart-sub">纵轴=占清醒时长百分比 · 各部分占比随时间变化趋势</div>
        <canvas id="stackedPctChart" height="${mode === 'week' ? '140' : '160'}"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">每日时间分解明细</div>
        <div class="chart-sub">清醒时长 → 各类别占用 → 空闲</div>
        <div class="table-wrap" style="max-height:520px">
          <table>
            <thead><tr>
              <th>日期</th><th>清醒</th>
              ${taskCats.map((c, ci) => {
    const thColor = groupLevel === 1 ? (getActColor(c).color || 'var(--text)') : getStackedColor(ci);
    return `<th style="color:${thColor}">${escHtmlApp(c)}</th>`;
  }).join('')}
              ${specialCats.map(c => `<th style="color:var(--thesis)">🔸${escHtmlApp(c)}</th>`).join('')}
              <th style="color:var(--sleep)">休息${tipIcon('stackRest')}</th>
              <th style="color:var(--red)">分心${tipIcon('stackDistract')}</th>
              <th style="color:var(--dim)">空闲${tipIcon('stackIdle')}</th>
            </tr></thead>
            <tbody>
              ${breakdowns.map((bd, i) => {
    const ds = dateStrs[i];
    const hasData = bd.awakeMin != null;
    return `<tr>
                  <td class="fw-mono" style="white-space:nowrap">${formatShort(ds)}</td>
                  <td class="fw-mono" style="color:var(--wake)">${hasData ? fmtMin(bd.awakeMin) : '-'}</td>
                  ${taskCats.map(c => `<td class="fw-mono">${bd.taskMap[c] ? fmtMin(bd.taskMap[c]) : '-'}</td>`).join('')}
                  ${specialCats.map(c => `<td class="fw-mono">${bd.specialMap[c] ? fmtMin(bd.specialMap[c]) : '-'}</td>`).join('')}
                  <td class="fw-mono">${bd.focusRestMin ? fmtMin(bd.focusRestMin) : '-'}</td>
                  <td class="fw-mono">${bd.focusDistractMin ? fmtMin(bd.focusDistractMin) : '-'}</td>
                  <td class="fw-mono">${hasData ? fmtMin(bd.idleMin) : '-'}</td>
                </tr>`;
  }).join('')}
            </tbody>
            <tfoot><tr>
              <td>合计</td>
              <td class="fw-mono" style="color:var(--wake)">${fmtMin(totalAwake, true)}</td>
              ${taskCats.map(c => {
    const sum = breakdowns.reduce((s, bd) => s + (bd.taskMap[c] || 0), 0);
    return `<td class="fw-mono">${sum ? fmtMin(sum) : '-'}</td>`;
  }).join('')}
              ${specialCats.map(c => {
    const sum = breakdowns.reduce((s, bd) => s + (bd.specialMap[c] || 0), 0);
    return `<td class="fw-mono">${sum ? fmtMin(sum) : '-'}</td>`;
  }).join('')}
              <td class="fw-mono">${fmtMin(totalRest, true)}</td>
              <td class="fw-mono">${fmtMin(totalDistract, true)}</td>
              <td class="fw-mono">${fmtMin(totalIdle, true)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  `;

  // ── 计算 y 轴上限（取最大清醒时长向上取整） ──
  const maxAwakeHrs = Math.max(...breakdowns.map(bd => bd.awakeMin || 0)) / 60;
  const yMax = Math.ceil(maxAwakeHrs + 1);

  // ── 绝对值堆积面积图 ──
  mkChart('stackedAbsChart', {
    type: 'line',
    data: { labels, datasets: absDatasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6b7a9e', boxWidth: 12, padding: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60))}`; } } },
        filler: { propagate: true },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: mode === 'month' ? 45 : 0 }, grid: gridCfg },
        y: {
          stacked: true,
          ticks: { color: '#6b7a9e', callback: v => v + 'h' },
          grid: gridCfg,
          title: { display: true, text: '小时', color: '#6b7a9e' },
          min: 0, max: yMax > 0 ? yMax : undefined,
        },
        yRef: {
          display: false,
          stacked: false,
          min: 0, max: yMax > 0 ? yMax : undefined,
        }
      }
    }
  });

  // ── 百分比堆积面积图 ──
  mkChart('stackedPctChart', {
    type: 'line',
    data: { labels, datasets: pctDatasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#6b7a9e', boxWidth: 12, padding: 8, font: { size: 11 } },
          onClick: function (e, legendItem, legend) {
            // 默认行为：切换 dataset 可见性
            const idx = legendItem.datasetIndex;
            const meta = legend.chart.getDatasetMeta(idx);
            meta.hidden = meta.hidden === null ? !legend.chart.data.datasets[idx].hidden : null;
            // 重新归一化
            recalcPctData(legend.chart);
          }
        },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (!v) return null; return `${ctx.dataset.label}: ${v.toFixed(1)}%`; } } },
        filler: { propagate: true },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: mode === 'month' ? 45 : 0 }, grid: gridCfg },
        y: {
          stacked: true,
          ticks: { color: '#6b7a9e', callback: v => v + '%' },
          grid: gridCfg,
          title: { display: true, text: '占清醒时长 %', color: '#6b7a9e' },
          min: 0, max: 100,
        }
      }
    }
  });
  // recalcPctData 只在图例点击时触发，初始数据已在创建前归一化
}

function switchStackedMode(mode) {
  state.stackedMode = mode;
  renderStackedArea();
}

function switchStackedLevel(level) {
  state.stackedGroupLevel = level;
  renderStackedArea();
}

function stackedNav(mode, delta) {
  if (mode === 'week') {
    state.stackedWeekStart = addDays(state.stackedWeekStart, delta);
  } else {
    let m = state.stackedMonth.month + delta;
    let y = state.stackedMonth.year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.stackedMonth = { year: y, month: m };
  }
  renderStackedArea();
}

function stackedGoToday(mode) {
  const now = new Date();
  if (mode === 'week') {
    state.stackedWeekStart = getMondayOfDate(now);
  } else {
    state.stackedMonth = { year: now.getFullYear(), month: now.getMonth() };
  }
  renderStackedArea();
}

// ============================================================
// INIT
// ============================================================
async function init() {
  chartDefaults();
  applyThemeColors(SETTINGS);
  await loadStorage();
  migrateOldTypes();
  await saveAllStorage();

  const sd = strToDate(state.selectedDate);
  state.cal = { year: sd.getFullYear(), month: sd.getMonth() };
  state.monthView = { year: sd.getFullYear(), month: sd.getMonth() };

  renderHeader();
  renderEntry();
  startDraftAutoSave();
}

document.addEventListener('DOMContentLoaded', init);
