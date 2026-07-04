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
  utilPassPct: 50,            // 不可用时间占比警戒线
  focusGoodPct: 80,
  focusOkPct: 60,
  weekStartDay: 1, // 1=周一, 0=周日
  // 数据存储
  snapshotInterval: 30000,
  useLocalStorageCache: true,
  // 评分规则
  ratingActualMin: 480,       // 实际专注>=480min(8h)得1分
  ratingDeviationPct: -10,    // 偏差>=-10%得1分
  ratingWakeLimit: 480,       // 起床<=480min(8:00)得1分
  ratingUtilPct: 50,          // 不可用时间占比<=50%得1分
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
      const settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!Object.prototype.hasOwnProperty.call(saved, 'snapshotInterval')) {
        settings.snapshotInterval = [30000, 60000].includes(Number(saved.autosaveInterval))
          ? Number(saved.autosaveInterval)
          : 30000;
      }
      if (![0, 30000, 60000].includes(Number(settings.snapshotInterval))) settings.snapshotInterval = 30000;
      delete settings.autosaveInterval;
      return settings;
    }
  } catch (e) { console.warn('加载设置失败', e); }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { console.warn('保存设置失败', e); }
  // Apply theme colors to CSS variables
  applyThemeColors(s);
  // Update local draft and backend snapshot timers
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
  util: '📊 不可用时间占比\n不可用时长占清醒时长的比例，表示一天清醒时间中有多少被吃饭、通勤、外出等特殊时段占用。数值越低，代表可支配时间越多；它不用于衡量专注效率。\n\n≤30% 较低 · ≤50% 中等 · >50% 较高\n\n公式：不可用时长 ÷ 清醒时长 × 100%\n不可用时长包括普通特殊时段的完整跨度，以及特殊学习时段中未学习的部分。',
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

function showPersistentSaveNotice(message = '备注已保存') {
  let notice = document.getElementById('persistent-save-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'persistent-save-notice';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:10000;display:flex;align-items:center;gap:12px;max-width:min(420px,calc(100vw - 36px));padding:11px 13px;border:1px solid rgba(102,187,106,.6);border-radius:9px;background:#18251d;color:#b9f6ca;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:12px';
    notice.innerHTML = '<span class="persistent-save-notice-text"></span><button type="button" aria-label="关闭提示" style="border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;padding:0 2px">×</button>';
    notice.querySelector('button').onclick = () => notice.remove();
    document.body.appendChild(notice);
  }
  notice.querySelector('.persistent-save-notice-text').textContent = `✓ ${message}`;
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
  _sessType: 'normal',
  _editingTaskId: null,
  forecastEditingId: null,
  workbookReviewId: null,
  workbookDraft: null,
  _serverSnapshot: null,
  _pendingSnapshotRestore: false,
  _taskFilter: {},  // { entry: '类别', day: '类别', week: '类别', month: '类别' }
  stackedMode: 'week', // 'week' or 'month'
  stackedWeekStart: getMondayOfDate(new Date()),
  stackedMonth: { year: new Date().getFullYear(), month: new Date().getMonth() },
  stackedGroupLevel: 1, // 1=一级, 2=二级, 3=三级
  sessAna: { mode: 'week', weekStart: getMondayOfDate(new Date()), month: { year: new Date().getFullYear(), month: new Date().getMonth() }, catFilter: '' },
  taskAna: { mode: 'week', weekStart: getMondayOfDate(new Date()), month: { year: new Date().getFullYear(), month: new Date().getMonth() }, level: 1, effScale: 'linear', effYMax: '', catFilter: '', effCatFilter: '', chapterEffTemplateId: '' },
};

// ============================================================
// TASK FILTER HELPERS
// ============================================================
function isTaskUnclassified(task) {
  const activityType = String(task?.activityType || '').trim();
  return !activityType || activityType === '未分类';
}

function getTaskFilterTypes(tasks) {
  const types = new Set();
  let hasUncat = false;
  tasks.forEach(t => {
    if (!isTaskUnclassified(t)) types.add(t.activityType);
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
      ? tasks.filter(isTaskUnclassified).length
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
  if (f === '未分类') return tasks.filter(isTaskUnclassified);
  return tasks.filter(t => t.activityType === f);
}

function applyTaskFilter(viewId, value) {
  state._taskFilter[viewId] = value || '';
  const renders = { entry: renderEntry, day: renderDayOverview, week: renderWeekOverview, month: renderMonthOverview };
  if (renders[viewId]) renders[viewId]();
}

function initEntryTaskColumnResize() {
  const table = document.getElementById('entryTaskTable');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')];
  if (!headers.length) return;

  const colgroup = document.createElement('colgroup');
  const cols = headers.map(() => {
    const col = document.createElement('col');
    colgroup.appendChild(col);
    return col;
  });
  table.insertBefore(colgroup, table.firstChild);

  const savedWidths = Array.isArray(state._entryTaskColumnWidths)
    && state._entryTaskColumnWidths.length === headers.length
    ? state._entryTaskColumnWidths
    : headers.map(header => Math.ceil(header.getBoundingClientRect().width));
  savedWidths.forEach((width, index) => { cols[index].style.width = `${width}px`; });
  table.style.width = `${savedWidths.reduce((sum, width) => sum + width, 0)}px`;

  headers.forEach((header, index) => {
    const handle = document.createElement('span');
    handle.className = 'task-column-resizer';
    handle.title = '拖动调整列宽';
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = header.getBoundingClientRect().width;
      const startTableWidth = table.getBoundingClientRect().width;
      const minWidth = index === 0 ? 46 : 64;
      document.body.classList.add('resizing-task-column');

      const onMove = moveEvent => {
        const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX));
        cols[index].style.width = `${nextWidth}px`;
        table.style.width = `${Math.max(1, startTableWidth + nextWidth - startWidth)}px`;
      };
      const onEnd = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
        document.body.classList.remove('resizing-task-column');
        state._entryTaskColumnWidths = headers.map(item => Math.round(item.getBoundingClientRect().width));
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    });
    header.appendChild(handle);
  });
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
const SNAPSHOT_CACHE_KEY = 'tracker_ui_snapshot';

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
  const saved = { ...draftData, _savedAt: draftData._savedAt || new Date().toISOString() };
  try { localStorage.setItem(DRAFT_KEY_PREFIX + dateStr, JSON.stringify(saved)); } catch (e) { }
}
function loadDraft(dateStr) {
  let localDraft = null;
  try {
    const saved = localStorage.getItem(DRAFT_KEY_PREFIX + dateStr);
    localDraft = saved ? JSON.parse(saved) : null;
  } catch (e) { }
  const snapshot = state._serverSnapshot;
  const remoteDraft = snapshot?.entryDraftDate === dateStr ? snapshot.entryDraft : null;
  if (!remoteDraft) return localDraft;
  if (!localDraft) return remoteDraft;
  return String(remoteDraft._savedAt || snapshot.updatedAt || '') > String(localDraft._savedAt || '')
    ? remoteDraft
    : localDraft;
}
function clearDraft(dateStr) {
  try { localStorage.removeItem(DRAFT_KEY_PREFIX + dateStr); } catch (e) { }
  if (state._serverSnapshot?.entryDraftDate === dateStr) {
    state._serverSnapshot.entryDraft = null;
  }
}

function clearAllLocalDrafts() {
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith(DRAFT_KEY_PREFIX))
      .forEach(key => localStorage.removeItem(key));
  } catch (e) { }
}

function collectEntryDraft() {
  const draft = { _savedAt: new Date().toISOString() };
  const wh = document.getElementById('wakeInput_h'), wm = document.getElementById('wakeInput_m');
  if (wh) draft.wakeH = wh.value;
  if (wm) draft.wakeM = wm.value;
  const sh = document.getElementById('sleepInput_h'), sm = document.getElementById('sleepInput_m');
  if (sh) draft.sleepH = sh.value;
  if (sm) draft.sleepM = sm.value;
  const noteEl = document.getElementById('dayNoteInput');
  if (noteEl) draft.dayNote = noteEl.value;
  ['sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note'].forEach(id => {
    const el = document.getElementById(id); if (el) draft[id] = el.value;
  });
  ['task_name', 'task_tmpl', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom', 'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit', 'task_new_ordinal_unit', 'task_template_ordinal_unit', 'task_wrong', 'task_acc', 'task_note'].forEach(id => {
    const el = document.getElementById(id); if (el) draft[id] = el.value;
  });
  draft.task_new_ordinal_enabled = Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  draft.task_new_quantity_enabled = Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
  draft.task_ordinal_numbers = forecastSelectedChapters('.task-chapter-involved');
  draft.task_completed_ordinals = forecastSelectedChapters('.task-chapter-completed');
  draft.task_named_item_allocations = taskCollectNamedItemAllocations(false) || [];
  return draft;
}

function collectActiveTabFields() {
  const host = document.getElementById('tab-' + state.tab);
  if (!host) return {};
  const fields = {};
  host.querySelectorAll('input[id],select[id],textarea[id]').forEach(element => {
    if (element.type === 'file') return;
    fields[element.id] = element.type === 'checkbox' || element.type === 'radio'
      ? { checked: element.checked }
      : { value: element.value };
  });
  return fields;
}

function collectOpenPanelIds() {
  const ids = [];
  document.querySelectorAll('.form-panel.open[id]').forEach(element => ids.push(element.id));
  ['tmpl-form-body', 'sess-tmpl-form-body', 'day-type-tmpl-form-body'].forEach(id => {
    const element = document.getElementById(id);
    if (element && element.style.display !== 'none') ids.push(id);
  });
  return ids;
}

function buildServerSnapshot() {
  let entryDraft = loadDraft(state.selectedDate);
  if (state.tab === 'entry') {
    entryDraft = collectEntryDraft();
    saveDraft(state.selectedDate, entryDraft);
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    tab: state.tab,
    selectedDate: state.selectedDate,
    entryDraftDate: state.selectedDate,
    entryDraft,
    editingSessionId: state._editingSessionId,
    editingTaskId: state._editingTaskId,
    sessionType: state._sessType || 'normal',
    forecastEditingId: state.forecastEditingId,
    workbookReviewId: state.workbookReviewId,
    workbookDraft: state.workbookDraft,
    activeFields: collectActiveTabFields(),
    openPanelIds: collectOpenPanelIds(),
  };
}

function saveLocalSnapshotCache(snapshot) {
  try { localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot)); } catch (error) { }
}

function loadLocalSnapshotCache() {
  try {
    const saved = localStorage.getItem(SNAPSHOT_CACHE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    return null;
  }
}

function applyLoadedSnapshot(snapshot) {
  if (!snapshot || !snapshot.updatedAt) return;
  state._serverSnapshot = snapshot;
  state._pendingSnapshotRestore = true;
  if (typeof snapshot.selectedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.selectedDate)) {
    state.selectedDate = snapshot.selectedDate;
  }
  const validTabs = ['entry', 'calendar', 'day', 'week', 'month', 'stacked', 'sessAnalysis', 'taskAnalysis', 'sleep', 'export', 'templates', 'forecast', 'workbookReview', 'settings'];
  if (validTabs.includes(snapshot.tab)) state.tab = snapshot.tab;
  state._editingSessionId = snapshot.editingSessionId || null;
  state._editingTaskId = snapshot.editingTaskId || null;
  state._sessType = snapshot.sessionType || 'normal';
  state.forecastEditingId = snapshot.forecastEditingId || null;
  state.workbookReviewId = snapshot.workbookReviewId || null;
  if (snapshot.workbookDraft) state.workbookDraft = snapshot.workbookDraft;
}

async function saveServerSnapshot(showMessage = false) {
  const snapshot = buildServerSnapshot();
  saveLocalSnapshotCache(snapshot);
  state._serverSnapshot = snapshot;
  try {
    await apiFetch('/api/snapshot', { method: 'PUT', body: JSON.stringify(snapshot) });
    if (showMessage) {
      const message = document.getElementById('snapshot-status');
      if (message) message.textContent = `✅ 已保存：${new Date(snapshot.updatedAt).toLocaleString()}`;
    }
  } catch (error) {
    console.error('后端快照保存失败，本地草稿仍然保留', error);
    if (showMessage) {
      const message = document.getElementById('snapshot-status');
      if (message) message.textContent = '❌ 后端快照保存失败，本地草稿仍保留';
    }
  }
}

async function loadServerSnapshot() {
  if (Number(SETTINGS.snapshotInterval) === 0) return;
  const localSnapshot = loadLocalSnapshotCache();
  let remoteSnapshot = null;
  try {
    remoteSnapshot = await apiFetch('/api/snapshot');
  } catch (error) {
    console.warn('后端快照读取失败，继续使用本地草稿', error);
  }
  const snapshot = String(localSnapshot?.updatedAt || '') > String(remoteSnapshot?.updatedAt || '')
    ? localSnapshot
    : remoteSnapshot?.updatedAt
      ? remoteSnapshot
      : localSnapshot;
  applyLoadedSnapshot(snapshot);
}

async function clearServerSnapshot(showMessage = true) {
  try {
    await apiFetch('/api/snapshot', { method: 'DELETE' });
    try { localStorage.removeItem(SNAPSHOT_CACHE_KEY); } catch (error) { }
    state._serverSnapshot = null;
    state._pendingSnapshotRestore = false;
    if (showMessage) {
      const message = document.getElementById('snapshot-status');
      if (message) message.textContent = '🗑️ 后端快照已清除';
    }
  } catch (error) {
    console.error('清除后端快照失败', error);
  }
}

function restorePendingSnapshotUi() {
  const snapshot = state._serverSnapshot;
  if (!state._pendingSnapshotRestore || !snapshot || snapshot.tab !== state.tab) return;
  setTimeout(() => {
    Object.entries(snapshot.activeFields || {}).forEach(([id, saved]) => {
      const element = document.getElementById(id);
      if (!element) return;
      if (Object.prototype.hasOwnProperty.call(saved, 'checked')) element.checked = Boolean(saved.checked);
      if (Object.prototype.hasOwnProperty.call(saved, 'value')) element.value = saved.value;
    });
    (snapshot.openPanelIds || []).forEach(id => {
      const element = document.getElementById(id);
      if (!element) return;
      if (element.classList.contains('form-panel')) element.classList.add('open');
      else element.style.display = 'block';
    });
    if (state.tab === 'entry') taskTemplateMonitor();
    state._pendingSnapshotRestore = false;
  }, 80);
}

// 本地草稿每3秒保存；后端快照按设置保存
let _draftTimer = null;
let _snapshotTimer = null;
function startDraftAutoSave() {
  if (_draftTimer) clearInterval(_draftTimer);
  if (_snapshotTimer) clearInterval(_snapshotTimer);
  _draftTimer = setInterval(() => {
    if (state.tab !== 'entry') return;
    saveDraft(state.selectedDate, collectEntryDraft());
  }, 3000);
  const snapshotInterval = Number(SETTINGS.snapshotInterval);
  if ([30000, 60000].includes(snapshotInterval)) {
    _snapshotTimer = setInterval(() => {
      if (document.visibilityState === 'visible') saveServerSnapshot();
    }, snapshotInterval);
  }
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
    if (draft.task_tmpl) {
      const templateEl = document.getElementById('task_tmpl');
      if (templateEl) {
        templateEl.value = draft.task_tmpl;
        renderForecastTaskFields(draft.task_tmpl, {
          ordinalNumbers: draft.task_ordinal_numbers || draft.task_chapter_numbers || [],
          completedOrdinals: draft.task_completed_ordinals || draft.task_completed_chapters || [],
        });
        configureTaskUnitFields(draft.task_tmpl);
      }
    } else if (draft.task_new_ordinal_enabled || draft.task_new_quantity_enabled ||
      (draft.task_ordinal_numbers || []).length) {
      renderForecastTaskFields('', {
        ordinalEnabled: draft.task_new_ordinal_enabled,
        namedItemEnabled: draft.task_new_ordinal_enabled,
        quantityEnabled: draft.task_new_quantity_enabled,
        ordinalUnit: draft.task_new_ordinal_unit || '',
        ordinalNumbers: draft.task_ordinal_numbers || draft.task_chapter_numbers || [],
        completedOrdinals: draft.task_completed_ordinals || draft.task_completed_chapters || [],
        namedItemAllocations: draft.task_named_item_allocations || [],
      });
      configureTaskUnitFields('');
    }
    ['sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note',
      'task_name', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom', 'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit', 'task_new_ordinal_unit', 'task_template_ordinal_unit', 'task_wrong', 'task_acc', 'task_note'].forEach(id => {
        if (draft[id] !== undefined) { const el = document.getElementById(id); if (el) el.value = draft[id]; }
      });
    autoCalcRate();
    taskTemplateMonitor();
    updateTaskCategorySequenceUi();
  }, 50);
}

// ============================================================
// DATE UTILITIES
// ============================================================
function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeEditableDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function setEditableDateSegments(id, value) {
  const normalized = normalizeEditableDate(value);
  if (!normalized) return false;
  const [year, month, day] = normalized.split('-');
  const input = document.getElementById(id);
  const wrap = document.getElementById(`${id}_wrap`);
  const yearInput = document.getElementById(`${id}_year`);
  const monthInput = document.getElementById(`${id}_month`);
  const dayInput = document.getElementById(`${id}_day`);
  const picker = document.getElementById(`${id}_picker`);
  if (input) input.value = normalized;
  if (wrap) wrap.dataset.lastDate = normalized;
  if (yearInput) yearInput.value = year;
  if (monthInput) monthInput.value = month;
  if (dayInput) dayInput.value = day;
  if (picker) picker.value = normalized;
  return true;
}

function editableDateSegmentChanged(id, changedPart) {
  const wrap = document.getElementById(`${id}_wrap`);
  const yearInput = document.getElementById(`${id}_year`);
  const monthInput = document.getElementById(`${id}_month`);
  const dayInput = document.getElementById(`${id}_day`);
  if (!wrap || !yearInput || !monthInput || !dayInput) return false;
  const normalized = normalizeEditableDate(`${yearInput.value}-${monthInput.value}-${dayInput.value}`);
  if (normalized) return setEditableDateSegments(id, normalized);

  setEditableDateSegments(id, wrap.dataset.lastDate);
  const changedInput = document.getElementById(`${id}_${changedPart}`);
  if (changedInput) {
    changedInput.classList.add('invalid');
    setTimeout(() => changedInput.classList.remove('invalid'), 900);
  }
  return false;
}

function editableDatePicked(id, value) {
  if (!value) return;
  setEditableDateSegments(id, value);
}

function openEditableDatePicker(id) {
  const picker = document.getElementById(`${id}_picker`);
  if (!picker) return;
  if (typeof picker.showPicker === 'function') picker.showPicker();
  else picker.click();
}

function editableDateInputHtml(id, value, onChange = '') {
  const normalized = normalizeEditableDate(value) || getTodayStr();
  const [year, month, day] = normalized.split('-');
  const segmentChange = part => onChange
    ? `if(editableDateSegmentChanged('${id}','${part}')){${onChange}}`
    : `editableDateSegmentChanged('${id}','${part}')`;
  const pickerChange = `editableDatePicked('${id}',this.value);${onChange}`;
  return `<div class="editable-date" id="${id}_wrap" data-last-date="${normalized}">
    <input type="hidden" id="${id}" value="${normalized}">
    <input type="text" id="${id}_year" class="editable-date-segment year" value="${year}"
      inputmode="numeric" autocomplete="off" maxlength="4" aria-label="年"
      onfocus="this.select()" onchange="${segmentChange('year')}">
    <span>年</span>
    <input type="text" id="${id}_month" class="editable-date-segment" value="${month}"
      inputmode="numeric" autocomplete="off" maxlength="2" aria-label="月"
      onfocus="this.select()" onchange="${segmentChange('month')}">
    <span>月</span>
    <input type="text" id="${id}_day" class="editable-date-segment" value="${day}"
      inputmode="numeric" autocomplete="off" maxlength="2" aria-label="日"
      onfocus="this.select()" onchange="${segmentChange('day')}">
    <span>日</span>
    <input type="date" id="${id}_picker" class="editable-date-picker" value="${normalized}"
      tabindex="-1" aria-hidden="true" onchange="${pickerChange}">
    <button type="button" class="editable-date-button" onclick="openEditableDatePicker('${id}')" title="打开日历">📅</button>
  </div>`;
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
function sortSessionsByStart(sessions = []) {
  return sessions
    .map((session, originalIndex) => ({ session, originalIndex }))
    .sort((a, b) => {
      const aStart = parseMin(a.session?.startTime);
      const bStart = parseMin(b.session?.startTime);
      const startDiff = (aStart == null ? Infinity : aStart) - (bStart == null ? Infinity : bStart);
      if (startDiff) return startDiff;
      const aEnd = parseMin(a.session?.endTime);
      const bEnd = parseMin(b.session?.endTime);
      const endDiff = (aEnd == null ? Infinity : aEnd) - (bEnd == null ? Infinity : bEnd);
      return endDiff || a.originalIndex - b.originalIndex;
    })
    .map(({ session }) => session);
}
function sessionTimeSegments(s) {
  const start = parseMin(s?.startTime);
  const end = parseMin(s?.endTime);
  if (start == null || end == null || start === end) return [];
  return end > start
    ? [[start, end]]
    : [[start, 1440], [0, end]];
}
function sessionsOverlap(first, second) {
  const firstSegments = sessionTimeSegments(first);
  const secondSegments = sessionTimeSegments(second);
  return firstSegments.some(([firstStart, firstEnd]) =>
    secondSegments.some(([secondStart, secondEnd]) =>
      firstStart < secondEnd && secondStart < firstEnd
    )
  );
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
    h = String(Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0))).padStart(2, '0');
    m = String(Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0))).padStart(2, '0');
  }
  return `<div class="time-input-group" onfocusout="normalizeTimeInputGroupOnExit(event,'${idPrefix}')">
    <input type="text" inputmode="numeric" maxlength="2" autocomplete="off" aria-autocomplete="none"
      id="${idPrefix}_h" placeholder="时" value="${h}"
      oninput="sanitizeTimeDigits(this)">
    <span class="time-sep">:</span>
    <input type="text" inputmode="numeric" maxlength="2" autocomplete="off" aria-autocomplete="none"
      id="${idPrefix}_m" placeholder="分" value="${m}"
      oninput="sanitizeTimeDigits(this)">
  </div>`;
}
function readTimeInput(idPrefix) {
  const hEl = document.getElementById(idPrefix + '_h');
  const mEl = document.getElementById(idPrefix + '_m');
  if (!hEl || !mEl) return '';
  normalizeTimeInputPair(idPrefix);
  const h = hEl.value, m = mEl.value;
  if (h === '' && m === '') return '';
  return h + ':' + m;
}
function sanitizeTimeDigits(el) {
  el.value = String(el.value || '').replace(/\D/g, '').slice(0, 2);
}
function normalizeTimeInputGroupOnExit(event, idPrefix) {
  const nextTarget = event.relatedTarget;
  if (nextTarget && event.currentTarget.contains(nextTarget)) return;
  normalizeTimeInputPair(idPrefix);
}
function normalizeTimeInputPair(idPrefix) {
  const hEl = document.getElementById(idPrefix + '_h');
  const mEl = document.getElementById(idPrefix + '_m');
  if (!hEl || !mEl) return;
  sanitizeTimeDigits(hEl);
  sanitizeTimeDigits(mEl);
  const hasHour = hEl.value !== '';
  const hasMinute = mEl.value !== '';
  if (!hasHour && !hasMinute) return;
  const hour = hasHour ? Math.min(23, Math.max(0, parseInt(hEl.value, 10) || 0)) : 0;
  const minute = hasMinute ? Math.min(59, Math.max(0, parseInt(mEl.value, 10) || 0)) : 0;
  hEl.value = String(hour).padStart(2, '0');
  mEl.value = String(minute).padStart(2, '0');
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
// UNIT LIBRARIES (数量单位库 / 序数单位库)
// ============================================================
function getOrdinalUnitList() {
  if (!Array.isArray(state.data.__ordinalUnitList__)) {
    const templates = Array.isArray(state.data.__taskTemplates__) ? state.data.__taskTemplates__ : [];
    state.data.__ordinalUnitList__ = [...new Set(templates
      .map(template => String(template.ordinalUnit || '').trim())
      .filter(Boolean))];
  }
  return state.data.__ordinalUnitList__;
}

function getUnitList(library = 'quantity') {
  if (library === 'ordinal') return getOrdinalUnitList();
  if (!Array.isArray(state.data.__unitList__)) {
    state.data.__unitList__ = ['个', '个单词', '道题', '页', '行', '篇', '套'];
  }
  return state.data.__unitList__;
}

async function addUnitItem(name, library = 'quantity') {
  if (!name || !name.trim()) return;
  name = name.trim();
  const list = getUnitList(library);
  if (!list.includes(name)) list.push(name);
  await saveAllStorage();
}

async function deleteUnitItem(name, library = 'quantity') {
  if (!name) return;
  const key = library === 'ordinal' ? '__ordinalUnitList__' : '__unitList__';
  state.data[key] = getUnitList(library).filter(n => n !== name);
  await saveAllStorage();
}

/**
 * 生成单位增强选择器 HTML
 */
function unitSelectorHtml(inputId, currentValue, msgId, library = 'quantity') {
  return `
    <div class="cat-selector" id="${inputId}_wrap">
      <div class="cat-selector-input-row">
        <div class="cat-selector-field" style="position:relative;flex:1">
          <input type="text" id="${inputId}" value="${escHtmlApp(currentValue || '')}"
            placeholder="输入搜索或新建单位"
            autocomplete="off"
            onfocus="unitSelOpen('${inputId}','${msgId}','${library}')"
            oninput="unitSelFilter('${inputId}','${msgId}','${library}')"
            style="width:100%;box-sizing:border-box">
          <div class="cat-sel-dropdown" id="${inputId}_dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
            max-height:200px;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;
            box-shadow:0 8px 24px rgba(0,0,0,.3)">
          </div>
        </div>
        <button class="btn btn-success btn-sm" onclick="unitSelSave('${inputId}','${msgId}','${library}')" title="保存到单位库" style="min-width:32px">＋</button>
        <button class="btn btn-ghost btn-sm" onclick="unitSelDelete('${inputId}','${msgId}','${library}')" title="从单位库删除" style="color:var(--red);min-width:32px">🗑</button>
      </div>
    </div>`;
}

function unitSelOpen(inputId, msgId, library = 'quantity') {
  unitSelFilter(inputId, msgId, library);
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

function unitSelFilter(inputId, msgId, library = 'quantity') {
  const input = document.getElementById(inputId);
  const dd = document.getElementById(inputId + '_dd');
  if (!input || !dd) return;
  const query = input.value.trim().toLowerCase();
  if (inputId === 'task_unit') {
    const unitText = input.value.trim();
    const label = document.getElementById('task_qty_label');
    const wrongLabel = document.getElementById('task_wrong_label');
    if (label) label.textContent = unitText ? `数量（${unitText}，可选）` : '数量（可选）';
    if (wrongLabel) wrongLabel.textContent = unitText ? `错误数量（${unitText}，可选）` : '错误数量（可选）';
  }
  if (inputId === 'task_template_ordinal_unit' || inputId === 'task_new_ordinal_unit') {
    taskUpdateOrdinalUnitPreview(input.value.trim());
  }
  const items = getUnitList(library);
  const matched = query ? items.filter(it => it.toLowerCase().includes(query)) : items;
  const remaining = query ? items.filter(it => !it.toLowerCase().includes(query)) : [];
  const exactMatch = items.some(it => it === input.value.trim());
  let html = '';
  const renderItems = list => list.map(it => {
    const isSelected = it === input.value;
    return `<div style="padding:6px 12px;cursor:pointer;font-size:12px;
      ${isSelected ? 'background:rgba(105,240,174,.1);color:var(--pol);font-weight:600' : 'color:var(--text)'};"
      onmousedown="catSelPick('${inputId}','${escHtmlApp(it)}')"
      onmouseenter="this.style.background='rgba(79,195,247,.1)'"
      onmouseleave="this.style.background='${isSelected ? 'rgba(105,240,174,.1)' : ''}'">
      ${escHtmlApp(it)}
    </div>`;
  }).join('');

  if (items.length === 0) {
    html = '<div style="padding:8px 12px;font-size:11px;color:var(--dim)">暂无单位，输入后点 ＋ 添加</div>';
  } else {
    if (query && matched.length) {
      html += '<div style="padding:5px 12px;font-size:10px;color:var(--dim)">匹配单位</div>';
    }
    html += renderItems(matched);
    if (query && remaining.length) {
      html += '<div style="padding:5px 12px;font-size:10px;color:var(--dim);border-top:1px solid var(--border)">其他已保存单位</div>';
      html += renderItems(remaining);
    }
  }
  if (query && !exactMatch) {
    html += `<div style="padding:6px 12px;font-size:11px;color:var(--pol);border-top:1px solid var(--border);cursor:pointer"
      onmousedown="event.preventDefault();unitSelSaveNew('${inputId}','${msgId}','${library}')"
      onmouseenter="this.style.background='rgba(105,240,174,.08)'"
      onmouseleave="this.style.background=''">
      ＋ 保存为新单位「${escHtmlApp(input.value.trim())}」
    </div>`;
  }
  dd.innerHTML = html;
  dd.style.display = 'block';
}

async function unitSelSave(inputId, msgId, library = 'quantity') {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  if (!name) { _showCatMsg(msgId, '⚠️ 请先输入单位名称', 'var(--red)'); return false; }
  const list = getUnitList(library);
  if (list.includes(name)) { _showCatMsg(msgId, `「${name}」已存在`, 'var(--muted)'); return false; }
  await addUnitItem(name, library);
  _showCatMsg(msgId, `✅ 已保存「${name}」`, 'var(--pol)');
  return true;
}

async function unitSelSaveNew(inputId, msgId, library = 'quantity') {
  const saved = await unitSelSave(inputId, msgId, library);
  if (saved) {
    const dd = document.getElementById(inputId + '_dd');
    if (dd) dd.style.display = 'none';
  }
}

async function unitSelDelete(inputId, msgId, library = 'quantity') {
  const el = document.getElementById(inputId);
  const name = (el?.value || '').trim();
  if (!name) { _showCatMsg(msgId, '⚠️ 请先输入或选择要删除的单位', 'var(--red)'); return; }
  if (!getUnitList(library).includes(name)) { _showCatMsg(msgId, `「${name}」不在单位库中`, 'var(--muted)'); return; }
  if (!confirm(`确定从单位库中删除「${name}」？`)) return;
  await deleteUnitItem(name, library);
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

async function addDayTypeTemplate(tmpl) {
  tmpl.id = uid();
  getDayTypeTemplates().push(tmpl);
  await saveAllStorage();
}

async function deleteDayTypeTemplate(id) {
  state.data.__dayTypeTemplates__ = getDayTypeTemplates().filter(t => t.id !== id);
  await saveAllStorage();
}

async function saveDayTypeTemplate(tmpl) {
  const list = getDayTypeTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
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
// Structure: { id, activityType, defaultMinutes, ordinalEnabled, ordinalUnit, quantityEnabled, quantityUnit, note }
function getTaskTemplates() {
  if (!state.data.__taskTemplates__) state.data.__taskTemplates__ = [];
  return state.data.__taskTemplates__;
}

function getTaskTemplateById(id) {
  return getTaskTemplates().find(template => template.id === id) || null;
}

function getTaskTemplateForTask(task) {
  return getTaskTemplateById(resolveTaskTemplateId(task));
}

function forEachStoredTask(callback) {
  Object.entries(state.data).forEach(([dateStr, day]) => {
    if (dateStr.startsWith('__') || !day || !Array.isArray(day.tasks)) return;
    day.tasks.forEach(task => callback(task, dateStr, day));
  });
}

function getTasksForTemplate(templateId) {
  const tasks = [];
  forEachStoredTask((task, dateStr, day) => {
    if (resolveTaskTemplateId(task) === templateId) tasks.push({ task, dateStr, day });
  });
  return tasks;
}

function taskQuantityIsVisible(task) {
  const template = getTaskTemplateForTask(task);
  return template ? Boolean(template.quantityEnabled) : true;
}

function taskOrdinalIsVisible(task) {
  const template = getTaskTemplateForTask(task);
  return template ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled) : true;
}

function visibleTaskQuantity(task) {
  return taskQuantityIsVisible(task) ? Number(task?.quantity) || 0 : 0;
}

function visibleTaskQuantityUnit(task) {
  return taskQuantityIsVisible(task) ? String(task?.quantityUnit || '') : '';
}

async function addTaskTemplate(tmpl) {
  tmpl.id = uid();
  getTaskTemplates().push(tmpl);
  await saveAllStorage();
}

async function deleteTaskTemplate(id) {
  if (getForecastGoals().some(goal => goal.templateId === id)) {
    alert('该模板已绑定完成预测目标。请先删除对应预测目标，再删除模板。');
    return;
  }
  state.data.__taskTemplates__ = getTaskTemplates().filter(t => t.id !== id);
  await saveAllStorage();
}

async function saveTaskTemplate(tmpl) {
  const list = getTaskTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  const previous = idx >= 0 ? list[idx] : null;
  if (previous && previous.quantityUnit !== tmpl.quantityUnit) {
    getTasksForTemplate(tmpl.id).forEach(({ task }) => {
      if (task.quantity != null) task.quantityUnit = tmpl.quantityUnit || '';
    });
  }
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
}

async function commitTaskTemplateUnitChanges(template, ordinalUnit, quantityUnit) {
  if (!template) return true;
  const nextOrdinal = String(ordinalUnit || '').trim();
  const nextQuantity = String(quantityUnit || '').trim();
  const ordinalChanged = template.ordinalUnit !== nextOrdinal;
  const quantityChanged = template.quantityUnit !== nextQuantity;
  if (!ordinalChanged && !quantityChanged) return true;
  if (template.ordinalEnabled && !nextOrdinal) {
    alert('序数记录已开启，序数单位不能为空。');
    return false;
  }
  if (template.quantityEnabled && !nextQuantity) {
    alert('数量记录已开启，数量单位不能为空。');
    return false;
  }
  const affected = getTasksForTemplate(template.id).length;
  const changes = [
    ordinalChanged ? `序数单位：${template.ordinalUnit || '空'} → ${nextOrdinal || '空'}` : '',
    quantityChanged ? `数量单位：${template.quantityUnit || '空'} → ${nextQuantity || '空'}` : '',
  ].filter(Boolean).join('\n');
  if (!confirm(`这会全局修改模板「${forecastTemplateLabel(template)}」并影响 ${affected} 条关联任务：\n${changes}\n是否继续？`)) {
    return false;
  }
  const updated = { ...template, ordinalUnit: nextOrdinal, quantityUnit: nextQuantity };
  await saveTaskTemplate(updated);
  Object.assign(template, updated);
  return true;
}

/** Pre-fill the task entry form from a template */
function applyTemplate(id) {
  renderForecastTaskFields(id);
  configureTaskUnitFields(id);
  const message = document.getElementById('task_template_match_msg');
  if (!id) {
    const unit = document.getElementById('task_unit');
    if (unit) unit.value = '';
    configureTaskUnitFields('');
    if (message) message.textContent = '当前未套用模板；保存时会按完整类别重新匹配或创建模板。';
    return;
  }
  const tmpl = getTaskTemplates().find(t => t.id === id);
  if (!tmpl) return;
  const [l1, l2, l3] = parseActPath(tmpl.activityType || '');
  const l1el = document.getElementById('task_l1');
  if (l1el) l1el.value = l1;
  const l2el = document.getElementById('task_l2');
  if (l2el) l2el.value = l2;
  const l3el = document.getElementById('task_l3');
  if (l3el) l3el.value = l3;
  if (tmpl.defaultMinutes) { const el = document.getElementById('task_min'); if (el) el.value = tmpl.defaultMinutes; }
  if (tmpl.quantityEnabled && tmpl.quantityUnit) {
    const el = document.getElementById('task_unit'); if (el) el.value = tmpl.quantityUnit;
  }
  if (tmpl.note) { const el = document.getElementById('task_note'); if (el) el.value = tmpl.note; }
  if (message) message.textContent = `正在套用模板「${forecastTemplateLabel(tmpl)}」；修改类别后会自动脱离并重新匹配。`;
  updateTaskCategorySequenceUi();
}

function taskCurrentDimensionValues(sourceTemplate = null) {
  return {
    ordinalEnabled: sourceTemplate
      ? Boolean(sourceTemplate.namedItemEnabled ?? sourceTemplate.ordinalEnabled)
      : Boolean(document.getElementById('task_new_ordinal_enabled')?.checked),
    namedItemEnabled: sourceTemplate
      ? Boolean(sourceTemplate.namedItemEnabled ?? sourceTemplate.ordinalEnabled)
      : Boolean(document.getElementById('task_new_ordinal_enabled')?.checked),
    quantityEnabled: sourceTemplate
      ? Boolean(sourceTemplate.quantityEnabled)
      : Boolean(document.getElementById('task_new_quantity_enabled')?.checked),
    ordinalUnit: document.getElementById('task_template_ordinal_unit')?.value.trim() ||
      sourceTemplate?.ordinalUnit || document.getElementById('task_new_ordinal_unit')?.value.trim() || '',
    ordinalNumbers: forecastSelectedChapters('.task-chapter-involved'),
    completedOrdinals: forecastSelectedChapters('.task-chapter-completed'),
    namedItemAllocations: taskCollectNamedItemAllocations(false) || [],
  };
}

function taskAutoLinkFromCategories(preservedValues = null) {
  const select = document.getElementById('task_tmpl');
  if (!select || select.value) return;
  const activityType = buildActPath(catSelValue('task_l1'), catSelValue('task_l2'), catSelValue('task_l3'));
  const message = document.getElementById('task_template_match_msg');
  if (!activityType) {
    if (message) message.textContent = '当前完整类别为空，不会继续绑定原模板。';
    return;
  }
  const matches = getTaskTemplates().filter(template => template.activityType === activityType);
  if (matches.length === 1) {
    const values = preservedValues || taskCurrentDimensionValues();
    select.value = matches[0].id;
    renderForecastTaskFields(matches[0].id, values);
    configureTaskUnitFields(matches[0].id);
    if (message) message.textContent = `已按完整类别自动关联模板「${forecastTemplateLabel(matches[0])}」`;
  } else if (matches.length > 1) {
    if (message) message.textContent = '该完整类别对应多个模板，请手动选择正确模板。';
  } else if (message) {
    message.textContent = '保存任务时将按当前配置自动建立新模板。';
  }
}

function taskTemplateMonitor() {
  const select = document.getElementById('task_tmpl');
  if (!select) return;
  const selectedTemplate = getTaskTemplateById(select.value);
  const activityType = buildActPath(catSelValue('task_l1'), catSelValue('task_l2'), catSelValue('task_l3'));
  const message = document.getElementById('task_template_match_msg');
  if (!selectedTemplate) {
    taskAutoLinkFromCategories();
    return;
  }
  if (selectedTemplate.activityType === activityType) {
    if (message) message.textContent = `类别与模板「${forecastTemplateLabel(selectedTemplate)}」完全一致，继续使用原模板。`;
    return;
  }

  const values = taskCurrentDimensionValues(selectedTemplate);
  const quantityUnit = document.getElementById('task_unit')?.value.trim() || selectedTemplate.quantityUnit || '';
  select.value = '';
  renderForecastTaskFields('', values);
  const unit = document.getElementById('task_unit');
  if (unit) unit.value = quantityUnit;
  configureTaskUnitFields('');
  if (message) {
    message.textContent = `检测到类别已修改，已脱离原模板「${forecastTemplateLabel(selectedTemplate)}」，正在按新类别重新匹配。`;
  }
  taskAutoLinkFromCategories(values);
}

function configureTaskUnitFields(templateId) {
  const template = getTaskTemplateById(templateId);
  const manualEnabled = Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
  const showQuantity = template ? Boolean(template.quantityEnabled) : manualEnabled;
  const quantity = document.getElementById('task_qty');
  const unit = document.getElementById('task_unit');
  const rate = document.getElementById('task_rate');
  const quantityGroup = document.getElementById('task_qty_group');
  const unitGroup = document.getElementById('task_unit_group');
  const rateGroup = document.getElementById('task_rate_group');
  const wrongGroup = document.getElementById('task_wrong_group');
  const accuracyGroup = document.getElementById('task_accuracy_group');
  const quantityLabel = document.getElementById('task_qty_label');
  const wrongLabel = document.getElementById('task_wrong_label');
  const unitLabel = document.getElementById('task_unit_label');
  if (quantityGroup) quantityGroup.style.display = showQuantity ? '' : 'none';
  if (unitGroup) unitGroup.style.display = showQuantity ? '' : 'none';
  if (rateGroup) rateGroup.style.display = showQuantity ? '' : 'none';
  if (wrongGroup) wrongGroup.style.display = showQuantity ? '' : 'none';
  if (accuracyGroup) accuracyGroup.style.display = showQuantity ? '' : 'none';
  if (template && unit && unit.dataset.templateId !== template.id) {
    unit.value = template.quantityUnit || '';
    unit.dataset.templateId = template.id;
  } else if (!template && unit) {
    delete unit.dataset.templateId;
  }
  if (quantityLabel) {
    const unitText = (unit?.value || template?.quantityUnit || '').trim();
    quantityLabel.textContent = unitText ? `数量（${unitText}，可选）` : '数量（可选）';
    if (wrongLabel) wrongLabel.textContent = unitText ? `错误数量（${unitText}，可选）` : '错误数量（可选）';
  }
  if (unitLabel) unitLabel.textContent = template ? '模板数量单位（全局）' : '新模板数量单位';
  unitGroup?.querySelectorAll('input,select,button').forEach(control => {
    control.disabled = false;
  });
  if (!showQuantity && rate) rate.value = '';
  if (showQuantity) autoCalcRate();
}

function taskUpdateOrdinalUnitPreview(unit) {
  const suffix = document.getElementById('task_ordinal_unit_suffix');
  if (suffix) suffix.textContent = unit;
  document.querySelectorAll('.task-ordinal-card').forEach(card => {
    const label = card.querySelector('b');
    if (label) label.textContent = `第${card.dataset.ordinal}${unit}`;
  });
}

function taskNewUnitToggle() {
  const ordinalEnabled = Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  const ordinalConfig = document.getElementById('task_new_ordinal_config');
  const ordinalEditor = document.getElementById('task_ordinal_editor');
  if (ordinalConfig) ordinalConfig.style.display = ordinalEnabled ? '' : 'none';
  if (ordinalEditor) ordinalEditor.style.display = ordinalEnabled ? '' : 'none';
  const minutesInput = document.getElementById('task_min');
  const quantityInput = document.getElementById('task_qty');
  if (minutesInput) minutesInput.readOnly = false;
  if (quantityInput) quantityInput.readOnly = false;
  configureTaskUnitFields('');
  if (ordinalEnabled) taskRecalculateNamedItemTotals();
}

async function taskTemplateToggleFeature(templateId, feature, checkbox) {
  const template = getTaskTemplateById(templateId);
  const key = feature === 'ordinal' ? 'namedItemEnabled' : 'quantityEnabled';
  if (!template || !checkbox) return;
  const previous = feature === 'ordinal'
    ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
    : Boolean(template[key]);
  const next = Boolean(checkbox.checked);
  if (previous === next) return;
  const enteredOrdinalUnit = document.getElementById('task_template_ordinal_unit')?.value.trim() || template.ordinalUnit || '';
  const enteredQuantityUnit = document.getElementById('task_unit')?.value.trim() || template.quantityUnit || '';
  const unit = feature === 'ordinal' ? enteredOrdinalUnit : enteredQuantityUnit;
  if (feature !== 'ordinal' && next && !unit) {
    checkbox.checked = previous;
    alert('请先在当前任务表单中设置数量单位。');
    return;
  }
  const affected = getTasksForTemplate(templateId).length;
  const action = next ? '开启' : '关闭';
  const effect = next ? '恢复显示并重新纳入统计' : '隐藏但不删除历史数据，并停止相关统计';
  if (!confirm(`${action}模板「${forecastTemplateLabel(template)}」的${feature === 'ordinal' ? '命名章节' : '数量'}记录？\n将影响 ${affected} 条关联任务：${effect}。`)) {
    checkbox.checked = previous;
    return;
  }
  const values = {
    ordinalNumbers: forecastSelectedChapters('.task-chapter-involved'),
    completedOrdinals: forecastSelectedChapters('.task-chapter-completed'),
    namedItemAllocations: taskCollectNamedItemAllocations(false) || [],
  };
  const updated = {
    ...template,
    [key]: next,
    ordinalEnabled: feature === 'ordinal' ? next : template.ordinalEnabled,
    ordinalUnit: enteredOrdinalUnit,
    quantityUnit: enteredQuantityUnit,
  };
  await saveTaskTemplate(updated);
  Object.assign(template, updated);
  renderForecastTaskFields(templateId, values);
  configureTaskUnitFields(templateId);
  refreshCurrentTaskVisibility();
}

function refreshCurrentTaskVisibility() {
  const day = getDay(state.selectedDate);
  (day.tasks || []).forEach(task => {
    const row = document.querySelector(`#tab-entry tr[data-task-id="${task.id}"]`);
    if (!row) return;
    const nameCell = row.querySelector('.task-name-cell');
    const quantityCell = row.querySelector('.task-quantity-cell');
    const rateCell = row.querySelector('.task-rate-cell');
    const quantity = visibleTaskQuantity(task);
    const unit = visibleTaskQuantityUnit(task);
    const rate = quantity && Number(task.minutes) > 0 ? (quantity / Number(task.minutes)).toFixed(2) : '';
    if (nameCell) nameCell.innerHTML = `${escHtmlApp(task.name || '')}${taskOrdinalBadgeHtml(task)}`;
    if (quantityCell) quantityCell.textContent = quantity ? `${quantity}${unit ? ` ${unit}` : ''}` : '-';
    if (rateCell) rateCell.textContent = rate ? `${rate}${unit ? ` ${unit}/min` : '/min'}` : '-';
  });
}

function setTemplateCategoryFilter(level, value) {
  if (!state._templateCategoryFilter) {
    state._templateCategoryFilter = { level1: '', level2: '', level3: '' };
  }
  const filter = state._templateCategoryFilter;
  filter[`level${level}`] = value || '';
  if (level <= 1) {
    filter.level2 = '';
    filter.level3 = '';
  } else if (level === 2) {
    filter.level3 = '';
  }
  renderTemplates();
}

function clearTemplateCategoryFilter() {
  state._templateCategoryFilter = { level1: '', level2: '', level3: '' };
  renderTemplates();
}

// ── Template Management Tab ──────────────────────────────────
function renderTemplates() {
  const templates = getTaskTemplates();
  const filter = state._templateCategoryFilter ||= { level1: '', level2: '', level3: '' };
  const templateParts = templates.map(template => ({
    template,
    parts: parseActPath(template.activityType),
  }));
  const uniqueValues = values => [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const level1Options = uniqueValues(templateParts.map(item => item.parts[0]));
  if (filter.level1 && !level1Options.includes(filter.level1)) {
    filter.level1 = '';
    filter.level2 = '';
    filter.level3 = '';
  }
  const level2Options = filter.level1
    ? uniqueValues(templateParts
      .filter(item => item.parts[0] === filter.level1)
      .map(item => item.parts[1]))
    : [];
  if (filter.level2 && !level2Options.includes(filter.level2)) {
    filter.level2 = '';
    filter.level3 = '';
  }
  const level3Options = filter.level1 && filter.level2
    ? uniqueValues(templateParts
      .filter(item => item.parts[0] === filter.level1 && item.parts[1] === filter.level2)
      .map(item => item.parts[2]))
    : [];
  if (filter.level3 && !level3Options.includes(filter.level3)) filter.level3 = '';
  const filteredTemplates = templateParts
    .filter(item =>
      (!filter.level1 || item.parts[0] === filter.level1)
      && (!filter.level2 || item.parts[1] === filter.level2)
      && (!filter.level3 || item.parts[2] === filter.level3)
    )
    .map(item => item.template);

  document.getElementById('tab-templates').innerHTML = `
    <div style="max-width:900px">

      <!-- 说明 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">📋 任务模板库</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.7;margin:0">
          在这里预定义常用任务模板，与活动类别三级联动绑定。<br>
          · 录入任务时可一键套用，自动填充类别、时长、单位等字段。<br>
          · 命名章节库由模板统一保存，并与完成预测共用同一份数据。<br>
        </p>
      </div>

      <div id="template-named-items-manager"></div>

      <!-- 新建模板表单 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="cursor:pointer" onclick="tmplToggleForm()">
          <div class="card-title">＋ 新建模板</div>
          <span id="tmpl-form-toggle" style="font-size:12px;color:var(--muted)">▼ 展开</span>
        </div>
        <div id="tmpl-form-body" style="display:none;margin-top:14px">
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

          <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="form-group">
              <label>默认时长(分钟)</label>
              <input type="number" id="tmpl_minutes" min="1" placeholder="60">
            </div>
            <div class="form-group template-unit-config">
              <label><input type="checkbox" id="tmpl_quantity_enabled"> 开启数量单位</label>
              ${unitSelectorHtml('tmpl_unit', '', 'tmpl_unit_msg')}
              <div style="font-size:11px;font-family:var(--mono)" id="tmpl_unit_msg"></div>
              <div class="form-hint">关闭时保留单位文字，但不参与录入和预测。</div>
            </div>
            <div class="form-group">
              <label>备注模板</label>
              <input type="text" id="tmpl_note" placeholder="可选默认备注">
            </div>
            <div class="form-group template-unit-config">
              <label><input type="checkbox" id="tmpl_ordinal_enabled"> 开启命名章节记录</label>
              <div class="form-hint">保存模板后可在共享章节库中提前录入完整章节名称。</div>
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
        <div class="card-title" style="margin-bottom:12px">🗂 已保存的模板（${filteredTemplates.length}/${templates.length} 个）</div>
        ${templates.length ? `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;padding:10px;background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:7px">
          <label style="display:flex;flex-direction:column;gap:4px;min-width:150px;font-size:10px;color:var(--muted)">
            一级分类
            <select onchange="setTemplateCategoryFilter(1,this.value)" style="font-size:12px">
              <option value="">全部模板</option>
              ${level1Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level1 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:150px;font-size:10px;color:var(--muted)">
            二级分类
            <select onchange="setTemplateCategoryFilter(2,this.value)" ${filter.level1 ? '' : 'disabled'} style="font-size:12px">
              <option value="">全部二级</option>
              ${level2Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level2 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:150px;font-size:10px;color:var(--muted)">
            三级分类
            <select onchange="setTemplateCategoryFilter(3,this.value)" ${filter.level1 && filter.level2 ? '' : 'disabled'} style="font-size:12px">
              <option value="">全部三级</option>
              ${level3Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level3 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
            </select>
          </label>
          ${filter.level1 || filter.level2 || filter.level3
            ? `<button class="btn btn-ghost btn-sm" onclick="clearTemplateCategoryFilter()">✕ 清除筛选</button>`
            : ''}
        </div>` : ''}
        ${templates.length === 0
      ? `<div class="empty-state"><p>暂无模板，点击上方「新建模板」开始添加</p></div>`
      : filteredTemplates.length === 0
        ? `<div class="empty-state"><p>当前分类组合下没有已保存模板</p><button class="btn btn-ghost btn-sm" onclick="clearTemplateCategoryFilter()">显示全部模板</button></div>`
        : `<div style="display:grid;gap:10px">
              ${filteredTemplates.map(t => tmplCardHtml(t)).join('')}
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
  // renderEntry 会因保存任务、恢复快照等操作重新生成表单。
  // 重绘后必须按当前状态恢复时段类型，避免界面显示“普通时段”
  // 但保存逻辑仍沿用旧的特殊时段类型。
  switchSessionType(
    ['normal', 'special', 'special-study'].includes(state._sessType)
      ? state._sessType
      : 'normal'
  );
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
  const tmpl = {
    name,
    note: document.getElementById('sess_tmpl_note').value.trim(),
  };
  await addSessionTemplate(tmpl);
  const msg = document.getElementById('sess-tmpl-save-msg');
  if (msg) { msg.textContent = `✅ 已保存「${name}」`; setTimeout(() => msg.textContent = '', 2500); }
  renderTemplates();
  if (tmpl.note) showPersistentSaveNotice('时段模板备注已保存');
}

function sessTmplCardHtml(t) {
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
        ${t.note ? `<span>📝 ${escHtmlApp(t.note)}</span>` : ''}
      </div>
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
  const previous = getSessionTemplates().find(template => template.id === id);
  const name = document.getElementById(`sess-tmpl-edit-name-${id}`).value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  const tmpl = {
    id, name,
    note: document.getElementById(`sess-tmpl-edit-note-${id}`).value.trim(),
  };
  await saveSessionTemplate(tmpl);
  renderTemplates();
  if (tmpl.note || previous?.note) showPersistentSaveNotice('时段模板备注已保存');
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
          <div class="day-type-template-flags">
            <label><input type="checkbox" id="day_type_tmpl_special"> 标记为特殊天</label>
            <label><input type="checkbox" id="day_type_tmpl_exclude"> 不参与评分</label>
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
  return {
    name,
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
    <div class="day-type-template-flags">
      <label><input type="checkbox" id="day-type-tmpl-edit-${t.id}-special" ${t.specialDay ? 'checked' : ''}> 标记为特殊天</label>
      <label><input type="checkbox" id="day-type-tmpl-edit-${t.id}-exclude" ${t.excludeFromRating ? 'checked' : ''}> 不参与评分</label>
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
  const libraryProgress = namedItemLibraryProgress(t.id);
  const activeItemCount = (t.namedItems || []).filter(item => !item.archived).length;
  return `
    <div id="tmpl-card-${t.id}" style="border:1px solid var(--border);border-radius:8px;padding:12px;background:rgba(255,255,255,.015)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
        <div>
          <span style="font-weight:600;font-size:14px">${escHtmlApp(t.activityType || '未分类模板')}</span>
          <span class="badge" style="margin-left:8px;background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">
            ${escHtmlApp(t.activityType || '—')}
          </span>
        </div>
        <div style="display:flex;gap:6px">
          ${(t.namedItemEnabled ?? t.ordinalEnabled) ? `<button class="btn btn-ghost btn-sm" onclick="tmplManageNamedItems('${t.id}')">📚 章节库</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="tmplStartEdit('${t.id}')">✏️ 编辑</button>
          <button class="btn btn-ghost btn-sm" onclick="tmplClearHistoricalDimension('${t.id}','ordinal')" title="永久删除该模板全部历史序数数据">清除序数</button>
          <button class="btn btn-ghost btn-sm" onclick="tmplClearHistoricalDimension('${t.id}','quantity')" title="永久删除该模板全部历史数量数据">清除数量</button>
          <button class="btn btn-danger btn-sm" onclick="tmplDelete('${t.id}')">删除</button>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap">
        ${t.defaultMinutes ? `<span>⏱ 默认 ${t.defaultMinutes} 分钟</span>` : ''}
        ${(t.namedItemEnabled ?? t.ordinalEnabled) ? `<span>📚 命名章节：${activeItemCount} 项 · 完成 ${libraryProgress.completedActive}/${activeItemCount}${t.quantityEnabled ? ` · 已录入 ${forecastDisplayMetric(libraryProgress.totalQuantity)} ${escHtmlApp(t.quantityUnit || '数量')}` : ''}</span>` : '<span>📚 命名章节已关闭</span>'}
        ${t.quantityEnabled ? `<span>📏 数量：${escHtmlApp(t.quantityUnit)}</span>` : `<span>📏 数量已关闭${t.quantityUnit ? `（${escHtmlApp(t.quantityUnit)}数据隐藏）` : ''}</span>`}
        ${!(t.namedItemEnabled ?? t.ordinalEnabled) && !t.quantityEnabled ? '<span>📅 不参与预测</span>' : ''}
      </div>
      <details style="margin-top:9px;border:1px solid var(--border);border-radius:7px;background:rgba(255,255,255,.01)">
        <summary style="cursor:pointer;padding:8px 10px;font-size:11px;color:var(--muted)">
          📝 模板备注${t.note ? ` · ${escHtmlApp(String(t.note).slice(0, 45))}${String(t.note).length > 45 ? '…' : ''}` : ' · 未填写'}
        </summary>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end;padding:0 10px 10px">
          <label style="margin:0"><span class="form-hint">备注内容</span>
            <textarea id="tmpl-inline-note-${t.id}" rows="3" maxlength="500" placeholder="填写这个模板的用途、范围或其他说明"
              onkeydown="if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();tmplSaveInlineNote('${t.id}')}">${escHtmlApp(t.note || '')}</textarea>
          </label>
          <button type="button" class="btn btn-ghost btn-sm" onclick="tmplSaveInlineNote('${t.id}')">保存备注</button>
        </div>
      </details>
      <!-- 编辑内嵌区 -->
      <div id="tmpl-edit-${t.id}" style="display:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        ${tmplEditFormHtml(t)}
      </div>
  </div>`;
}

async function tmplSaveInlineNote(id) {
  const template = getTaskTemplateById(id);
  const input = document.getElementById(`tmpl-inline-note-${id}`);
  if (!template || !input) return;
  template.note = input.value.trim();
  await saveAllStorage();
  renderTemplates();
  showPersistentSaveNotice('模板备注已保存');
}

function tmplEditFormHtml(t) {
  const [l1, l2, l3] = parseActPath(t.activityType || '');
  return `
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
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="form-group"><label>默认时长(分钟)</label>
        <input type="number" id="tmpl-edit-min-${t.id}" value="${t.defaultMinutes || ''}"></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-quantity-enabled-${t.id}" ${t.quantityEnabled ? 'checked' : ''}> 开启数量单位</label>
        ${unitSelectorHtml('tmpl-edit-unit-' + t.id, t.quantityUnit || '', 'tmpl-edit-unit-msg-' + t.id)}
        <div style="font-size:11px;font-family:var(--mono)" id="tmpl-edit-unit-msg-${t.id}"></div>
        <div class="form-hint">关闭时保留单位文字，但不参与录入和预测。</div></div>
      <div class="form-group"><label>备注模板</label>
        <input type="text" id="tmpl-edit-note-${t.id}" value="${escHtmlApp(t.note || '')}"></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-ordinal-enabled-${t.id}" ${(t.namedItemEnabled ?? t.ordinalEnabled) ? 'checked' : ''}> 开启命名章节记录</label>
        <div class="form-hint">章节名称在共享章节库中维护，不再使用“第N单位”。</div></div>
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
  const l1 = document.getElementById('tmpl_l1').value;
  const l2 = document.getElementById('tmpl_l2').value;
  const l3 = document.getElementById('tmpl_l3').value;
  const activityType = buildActPath(l1, l2, l3);
  if (!activityType) {
    alert('任务模板不再使用名称，请至少填写一个活动类别。');
    return;
  }
  if (getTaskTemplates().some(template => template.activityType === activityType)) {
    alert('该完整活动类别已经存在一个模板，请直接编辑现有模板。');
    return;
  }
  const namedItemEnabled = document.getElementById('tmpl_ordinal_enabled').checked;
  const tmpl = {
    activityType,
    defaultMinutes: parseInt(document.getElementById('tmpl_minutes').value) || null,
    quantityUnit: document.getElementById('tmpl_unit').value.trim(),
    namedItemEnabled,
    namedItems: [],
    ordinalEnabled: namedItemEnabled,
    ordinalUnit: namedItemEnabled ? '项' : '',
    quantityEnabled: document.getElementById('tmpl_quantity_enabled').checked,
    note: document.getElementById('tmpl_note').value.trim(),
  };
  if (tmpl.quantityEnabled && !tmpl.quantityUnit) {
    alert('开启数量单位后必须填写数量单位。');
    return;
  }
  await addTaskTemplate(tmpl);
  const msg = document.getElementById('tmpl-save-msg');
  if (msg) { msg.textContent = `✅ 已保存模板「${activityType || '未分类'}」`; setTimeout(() => msg.textContent = '', 2500); }
  renderTemplates();
  // auto-expand form stays closed after save
}

async function tmplDelete(id) {
  const tmpl = getTaskTemplates().find(t => t.id === id);
  if (!tmpl) return;
  if (!confirm(`删除模板「${forecastTemplateLabel(tmpl)}」？`)) return;
  await deleteTaskTemplate(id);
  renderTemplates();
}

async function tmplClearHistoricalDimension(id, dimension) {
  const template = getTaskTemplateById(id);
  if (!template) return;
  const entries = getTasksForTemplate(id).filter(({ task }) => {
    if (dimension === 'ordinal') {
      return taskOrdinalNumbers(task).length > 0 || taskCompletedOrdinals(task).length > 0;
    }
    return task.quantity != null || Boolean(task.quantityUnit);
  });
  const label = dimension === 'ordinal' ? '序数及完成状态' : '数量及数量单位';
  if (!entries.length) {
    alert(`模板「${forecastTemplateLabel(template)}」没有可清除的历史${label}数据。`);
    return;
  }
  if (!confirm(`将永久清除模板「${forecastTemplateLabel(template)}」关联的 ${entries.length} 条任务中的${label}。\n关闭开关只是隐藏；此操作是真正删除。是否继续？`)) return;
  if (!confirm(`再次确认：永久删除这些${label}数据后，即使重新开启模板开关也无法恢复。`)) return;
  entries.forEach(({ task }) => {
    if (dimension === 'ordinal') {
      delete task.ordinalNumbers;
      delete task.completedOrdinals;
      delete task.chapterNumbers;
      delete task.completedChapters;
      delete task.chapterNumber;
      delete task.chapterCompleted;
    } else {
      delete task.quantity;
      delete task.quantityUnit;
    }
  });
  await saveAllStorage();
  renderTemplates();
}

function tmplStartEdit(id) {
  document.getElementById(`tmpl-edit-${id}`).style.display = 'block';
}
function tmplCancelEdit(id) {
  document.getElementById(`tmpl-edit-${id}`).style.display = 'none';
}

function tmplManageNamedItems(id) {
  const template = getTaskTemplateById(id);
  const host = document.getElementById('template-named-items-manager');
  if (!template || !host) return;
  const forecastTab = document.getElementById('tab-forecast');
  if (forecastTab) forecastTab.innerHTML = '';
  host.innerHTML = `<div class="card" style="margin-bottom:16px;border-color:rgba(79,195,247,.35)">
    <div class="card-header">
      <div>
        <div class="card-title">📚 共享章节库 · ${escHtmlApp(forecastTemplateLabel(template))}</div>
        <div class="card-sub">这里保存的章节会同步用于完成预测和任务录入。</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="tmplCloseNamedItemsManager()">关闭</button>
    </div>
    ${forecastNamedItemsEditorHtml(template.namedItems || [], template.id)}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-success" onclick="tmplSaveNamedItems('${id}')">✓ 保存共享章节库</button>
      <button class="btn btn-ghost" onclick="tmplCloseNamedItemsManager()">取消</button>
    </div>
    ${tmplNamedItemsTransferPanelHtml(template)}
  </div>`;
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function tmplNamedItemsTransferPanelHtml(sourceTemplate) {
  const targets = getTaskTemplates().filter(template => template.id !== sourceTemplate.id);
  const activeCount = (sourceTemplate.namedItems || []).filter(item => !item.archived).length;
  return `<details style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
    <summary style="cursor:pointer;font-weight:600">📤 复制／覆盖章节库到其他模板</summary>
    <div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,.015)">
      <div class="form-hint" style="margin-bottom:10px">
        源模板：${escHtmlApp(forecastTemplateLabel(sourceTemplate))} · ${activeCount} 个活动章节。只复制活动章节，不复制归档项目和完成进度。
      </div>
      <div class="form-group">
        <label>操作方式</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <label><input type="radio" name="tmpl_named_items_transfer_mode" value="merge" checked> 合并复制</label>
          <label><input type="radio" name="tmpl_named_items_transfer_mode" value="overwrite"> 覆盖活动章节</label>
        </div>
        <div class="form-hint">合并会保留目标顺序并追加缺少项；覆盖会让目标活动清单采用源模板顺序。</div>
      </div>
      <div class="form-group">
        <label>目标模板（可多选）</label>
        ${targets.length
          ? `<div style="display:grid;gap:7px;max-height:220px;overflow-y:auto;padding:8px;border:1px solid var(--border);border-radius:7px">
              ${targets.map(target => `<label style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" class="tmpl-named-items-transfer-target" value="${escHtmlApp(target.id)}">
                <span>${escHtmlApp(forecastTemplateLabel(target))}</span>
                <span class="c-muted" style="font-size:11px">（${(target.namedItems || []).filter(item => !item.archived).length} 个活动章节）</span>
              </label>`).join('')}
            </div>`
          : '<div class="form-hint">没有可选择的其他任务模板。</div>'}
      </div>
      <button type="button" class="btn btn-primary btn-sm" onclick="tmplTransferNamedItems('${sourceTemplate.id}')" ${targets.length ? '' : 'disabled'}>
        执行复制／覆盖
      </button>
    </div>
  </details>`;
}

function tmplCloseNamedItemsManager() {
  const host = document.getElementById('template-named-items-manager');
  if (host) host.innerHTML = '';
}

function tmplCanonicalNamedItems(items) {
  const normalized = (Array.isArray(items) ? items : []).map((item, index) => ({
    id: String(item?.id || ''),
    name: String(item?.name || '').trim(),
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
    archived: Boolean(item?.archived),
  }));
  const active = normalized.filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const archived = normalized.filter(item => item.archived).sort((a, b) => a.order - b.order);
  return [...active, ...archived].map(item => ({
    id: item.id,
    name: item.name,
    archived: item.archived,
  }));
}

function tmplNamedItemsEditorHasUnsavedChanges(template) {
  if (forecastNamedItemRows().some(row => row.dataset.draft === 'true')) return true;
  const current = forecastCollectNamedItems().map(item => ({
    id: item.id,
    name: item.name,
    archived: item.archived,
  }));
  return JSON.stringify(current) !== JSON.stringify(tmplCanonicalNamedItems(template?.namedItems));
}

function tmplNamedItemIsReferenced(templateId, itemId) {
  return getTasksForTemplate(templateId).some(({ task }) =>
    Array.isArray(task.namedItemAllocations) &&
    task.namedItemAllocations.some(allocation => allocation?.itemId === itemId)
  );
}

function tmplNormalizeTransferredNamedItems(active, archived) {
  return [...active, ...archived].map((item, index) => ({
    ...item,
    name: String(item.name || '').trim(),
    order: index,
    archived: index >= active.length,
  }));
}

function tmplMergeNamedItemsIntoTarget(sourceActive, target) {
  const targetItems = tmplCanonicalNamedItems(target.namedItems).map(item => ({ ...item }));
  const active = targetItems.filter(item => !item.archived);
  const archived = targetItems.filter(item => item.archived);
  const activeNames = new Set(active.map(item => item.name.toLocaleLowerCase()));

  sourceActive.forEach(sourceItem => {
    const key = sourceItem.name.toLocaleLowerCase();
    if (activeNames.has(key)) return;
    const archivedIndex = archived.findIndex(item => item.name.toLocaleLowerCase() === key);
    if (archivedIndex >= 0) {
      const restored = archived.splice(archivedIndex, 1)[0];
      active.push({ ...restored, archived: false });
    } else {
      active.push({ id: uid(), name: sourceItem.name, archived: false });
    }
    activeNames.add(key);
  });

  return tmplNormalizeTransferredNamedItems(active, archived);
}

function tmplOverwriteNamedItemsInTarget(sourceActive, target) {
  const targetItems = tmplCanonicalNamedItems(target.namedItems).map(item => ({ ...item }));
  const targetByName = new Map();
  targetItems.filter(item => !item.archived).forEach(item => targetByName.set(item.name.toLocaleLowerCase(), item));
  targetItems.filter(item => item.archived).forEach(item => {
    const key = item.name.toLocaleLowerCase();
    if (!targetByName.has(key)) targetByName.set(key, item);
  });

  const usedIds = new Set();
  const active = sourceActive.map(sourceItem => {
    const matched = targetByName.get(sourceItem.name.toLocaleLowerCase());
    if (matched) {
      usedIds.add(matched.id);
      return { ...matched, name: sourceItem.name, archived: false };
    }
    return { id: uid(), name: sourceItem.name, archived: false };
  });

  const archived = [];
  targetItems.forEach(item => {
    if (usedIds.has(item.id)) return;
    if (item.archived || tmplNamedItemIsReferenced(target.id, item.id)) {
      archived.push({ ...item, archived: true });
    }
  });
  return tmplNormalizeTransferredNamedItems(active, archived);
}

async function tmplTransferNamedItems(sourceId) {
  const source = getTaskTemplateById(sourceId);
  if (!source) return;
  if (tmplNamedItemsEditorHasUnsavedChanges(source)) {
    alert('共享章节库存在未保存的新增、改名、排序或归档修改。请先保存章节库，再执行复制或覆盖。');
    return;
  }
  const sourceActive = tmplCanonicalNamedItems(source.namedItems).filter(item => !item.archived);
  if (!sourceActive.length) {
    alert('源模板没有可复制的活动章节。');
    return;
  }
  const selectedIds = [...document.querySelectorAll('.tmpl-named-items-transfer-target:checked')]
    .map(input => input.value);
  const targets = selectedIds.map(getTaskTemplateById).filter(Boolean);
  if (!targets.length) {
    alert('请至少选择一个目标模板。');
    return;
  }
  const mode = document.querySelector('input[name="tmpl_named_items_transfer_mode"]:checked')?.value || 'merge';
  const modeLabel = mode === 'overwrite' ? '覆盖活动章节' : '合并复制';
  const targetLabels = targets.map(forecastTemplateLabel);
  const confirmText = `${modeLabel}：将源模板的 ${sourceActive.length} 个活动章节处理到以下 ${targets.length} 个模板：\n` +
    targetLabels.map(label => `• ${label}`).join('\n') +
    `\n\n源模板保持不变；归档章节和完成进度不会复制。是否继续？`;
  if (!confirm(confirmText)) return;

  targets.forEach(target => {
    target.namedItems = mode === 'overwrite'
      ? tmplOverwriteNamedItemsInTarget(sourceActive, target)
      : tmplMergeNamedItemsIntoTarget(sourceActive, target);
    target.namedItemEnabled = true;
    target.ordinalEnabled = true;
  });
  await saveAllStorage();
  alert(`已将章节库${modeLabel}到 ${targets.length} 个目标模板。`);
  renderTemplates();
  if (tmpl.note) showPersistentSaveNotice('任务模板备注已保存');
}

async function tmplSaveNamedItems(id) {
  const template = getTaskTemplateById(id);
  if (!template) return;
  const namedItems = forecastCollectNamedItems();
  if (namedItems.some(item => !item.name)) {
    alert('章节名称不能为空。');
    return;
  }
  const normalizedNames = namedItems.map(item => item.name.toLocaleLowerCase());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    alert('同一个模板内不能存在完全同名的章节。');
    return;
  }
  template.namedItems = namedItems;
  template.namedItemEnabled = true;
  template.ordinalEnabled = true;
  await saveAllStorage();
  renderTemplates();
}

async function tmplSaveEdit(id) {
  const previous = getTaskTemplateById(id);
  const l1 = document.getElementById(`tmpl-edit-l1-${id}`).value;
  const l2 = document.getElementById(`tmpl-edit-l2-${id}`).value;
  const l3 = document.getElementById(`tmpl-edit-l3-${id}`).value;
  const activityType = buildActPath(l1, l2, l3);
  if (!activityType) {
    alert('任务模板不再使用名称，请至少填写一个活动类别。');
    return;
  }
  if (getTaskTemplates().some(template => template.id !== id && template.activityType === activityType)) {
    alert('该完整活动类别已经存在一个模板，请使用不同的类别组合。');
    return;
  }
  const namedItemEnabled = document.getElementById(`tmpl-edit-ordinal-enabled-${id}`).checked;
  const tmpl = {
    id,
    activityType,
    defaultMinutes: parseInt(document.getElementById(`tmpl-edit-min-${id}`).value) || null,
    quantityUnit: document.getElementById(`tmpl-edit-unit-${id}`).value.trim(),
    namedItemEnabled,
    namedItems: Array.isArray(previous?.namedItems) ? previous.namedItems : [],
    ordinalEnabled: namedItemEnabled,
    ordinalUnit: previous?.ordinalUnit || (namedItemEnabled ? '项' : ''),
    quantityEnabled: document.getElementById(`tmpl-edit-quantity-enabled-${id}`).checked,
    note: document.getElementById(`tmpl-edit-note-${id}`).value.trim(),
  };
  if (tmpl.quantityEnabled && !tmpl.quantityUnit) {
    alert('开启数量单位后必须填写数量单位。');
    return;
  }
  const changed = [];
  if (previous && Boolean(previous.namedItemEnabled ?? previous.ordinalEnabled) !== tmpl.namedItemEnabled) changed.push(`命名章节记录${tmpl.namedItemEnabled ? '开启' : '关闭'}`);
  if (previous && previous.quantityEnabled !== tmpl.quantityEnabled) changed.push(`数量记录${tmpl.quantityEnabled ? '开启' : '关闭'}`);
  if (previous && previous.quantityUnit !== tmpl.quantityUnit) changed.push(`数量单位改为“${tmpl.quantityUnit || '空'}”`);
  if (changed.length) {
    const affected = getTasksForTemplate(id).length;
    if (!confirm(`保存后将全局${changed.join('、')}，联动 ${affected} 条历史任务的显示、统计和预测。\n关闭只隐藏数据，不会删除。是否继续？`)) return;
  }
  await saveTaskTemplate(tmpl);
  renderTemplates();
  if (tmpl.note || previous?.note) showPersistentSaveNotice('任务模板备注已保存');
}

/** Escape HTML for use in app.js. */
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
  if (/^task_l[123]$/.test(inputId)) {
    taskTemplateMonitor();
    updateTaskCategorySequenceUi();
  }
}

/** 选中某项 */
function catSelPick(inputId, value) {
  const input = document.getElementById(inputId);
  if (input) input.value = value;
  const dd = document.getElementById(inputId + '_dd');
  if (dd) dd.style.display = 'none';
  if (inputId === 'task_unit') {
    const label = document.getElementById('task_qty_label');
    const wrongLabel = document.getElementById('task_wrong_label');
    if (label) label.textContent = value ? `数量（${value}，可选）` : '数量（可选）';
    if (wrongLabel) wrongLabel.textContent = value ? `错误数量（${value}，可选）` : '错误数量（可选）';
    autoCalcRate();
  }
  if (inputId === 'task_template_ordinal_unit' || inputId === 'task_new_ordinal_unit') {
    taskUpdateOrdinalUnitPreview(value);
  }
  if (/^task_l[123]$/.test(inputId)) {
    updateTaskCategorySequenceUi();
    setTimeout(taskTemplateMonitor, 0);
  }
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
  if (/^task_l[123]$/.test(inputId)) taskTemplateMonitor();
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

/** 任务类别必须从一级开始连续填写；未满足前置层级时禁用后续输入。 */
function updateTaskCategorySequenceUi() {
  const level1 = catSelValue('task_l1');
  const level2 = catSelValue('task_l2');
  const setEnabled = (inputId, enabled, title) => {
    const wrap = document.getElementById(`${inputId}_wrap`);
    if (!wrap) return;
    wrap.querySelectorAll('input, button').forEach(element => {
      element.disabled = !enabled;
    });
    wrap.style.opacity = enabled ? '' : '.5';
    wrap.title = enabled ? '' : title;
  };
  setEnabled('task_l1', true, '');
  setEnabled('task_l2', Boolean(level1), '请先填写一级类别');
  setEnabled('task_l3', Boolean(level1 && level2), '请先依次填写一级和二级类别');
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
  const utilPct = (awakeMin != null && awakeMin > 0)
    ? Math.round(unavailableMin / awakeMin * 100)
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
      label: `今日不可用占比${tipIcon('util')}`, value: todayStats.utilPct != null ? todayStats.utilPct + '%' : '-', unit: '', sub: `不可用${fmtMin(todayStats.unavailableMin)} / 清醒${fmtMin(todayStats.awakeMin)}`,
      color: todayStats.utilPct == null ? 'var(--muted)' : todayStats.utilPct <= 30 ? 'var(--green)' : todayStats.utilPct <= 50 ? 'var(--wake)' : 'var(--red)'
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
  if (state.tab === 'entry' && id !== 'entry' && document.getElementById('taskForm')) {
    saveDraft(state.selectedDate, collectEntryDraft());
  }
  destroyAll();
  state.tab = id;
  document.querySelectorAll('.tab').forEach((t, i) => {
    const ids = ['entry', 'calendar', 'day', 'week', 'month', 'stacked', 'sessAnalysis', 'taskAnalysis', 'sleep', 'export', 'templates', 'forecast', 'workbookReview', 'settings'];
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
    export: renderExport, templates: renderTemplates,
    forecast: renderForecast,
    workbookReview: renderWorkbookReview, settings: renderSettings
  };
  if (renders[id]) renders[id]();
  renderHeader();
  if (id === 'entry') restoreDraft(state.selectedDate);
  restorePendingSnapshotUi();
}

// ============================================================
// ENTRY TAB
// ============================================================
function dayMigrationPanelHtml(dateStr, day, sessions, tasks) {
  const scalarItems = [
    day.wakeTime ? `<label><input type="checkbox" class="day-move-item" data-kind="wakeTime"> ☀️ 起床时间：${escHtmlApp(day.wakeTime)}</label>` : '',
    day.dayNote ? `<label><input type="checkbox" class="day-move-item" data-kind="dayNote"> 📝 今日备注：${escHtmlApp(String(day.dayNote).slice(0, 60))}</label>` : '',
    day.sleepTime ? `<label><input type="checkbox" class="day-move-item" data-kind="sleepTime"> 🌙 睡觉时间：${escHtmlApp(day.sleepTime)}</label>` : '',
  ].filter(Boolean);
  const sessionItems = sessions.map((session, index) => `<label>
    <input type="checkbox" class="day-move-item" data-kind="session" data-id="${escHtmlApp(session.id)}">
    ⏱ 时段${index + 1}：${session.name ? `${escHtmlApp(session.name)} · ` : ''}${escHtmlApp(session.startTime || '?')}–${escHtmlApp(session.endTime || '?')}
  </label>`);
  const taskItems = tasks.map((task, index) => `<label>
    <input type="checkbox" class="day-move-item" data-kind="task" data-id="${escHtmlApp(task.id)}">
    📌 任务${index + 1}：${escHtmlApp(task.name || '未命名任务')}${task.activityType ? ` · ${escHtmlApp(task.activityType)}` : ''}
  </label>`);
  const total = scalarItems.length + sessionItems.length + taskItems.length;
  return `<div class="form-panel" id="dayMovePanel">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <b>迁移本日数据</b>
      <button type="button" class="btn btn-ghost btn-sm" id="day_move_select_all" onclick="toggleDayMoveSelection()">全选</button>
      <span class="form-hint">共 ${total} 项可选；再次点击“全选”会变成“全取消”。</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
      ${scalarItems.length ? `<div style="display:flex;flex-direction:column;gap:6px"><b style="font-size:12px">单值数据</b>${scalarItems.join('')}</div>` : ''}
      ${sessionItems.length ? `<div style="display:flex;flex-direction:column;gap:6px"><b style="font-size:12px">专注时段</b>${sessionItems.join('')}</div>` : ''}
      ${taskItems.length ? `<div style="display:flex;flex-direction:column;gap:6px"><b style="font-size:12px">任务记录</b>${taskItems.join('')}</div>` : ''}
      ${!total ? '<div class="form-hint">当天没有可迁移的数据。</div>' : ''}
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px">
      <span style="font-size:12px;color:var(--muted)">目标日期：</span>
      ${editableDateInputHtml('day_move_target', addDays(dateStr, 1))}
      <button class="btn btn-primary btn-sm" onclick="moveSelectedDayData('${dateStr}','append')" ${total ? '' : 'disabled'}>迁移所选并追加</button>
      <button class="btn btn-danger btn-sm" onclick="moveSelectedDayData('${dateStr}','overwrite')" ${total ? '' : 'disabled'}>迁移所选并覆盖同类</button>
    </div>
    <div class="form-hint" style="margin-top:6px">追加：所选时段和任务追加到目标日；覆盖同类：只要选择了时段或任务，就替换目标日对应列表。起床、备注、睡觉选中后始终覆盖目标日对应值。</div>
  </div>`;
}

function renderEntry() {
  const dateStr = state.selectedDate;
  const day = getDay(dateStr);
  const stats = computeDay(dateStr);
  const sessions = sortSessionsByStart(day.sessions || []);
  const tasks = day.tasks || [];

  document.getElementById('tab-entry').innerHTML = `
    <div class="date-nav">
      <button class="btn btn-ghost btn-sm" onclick="changeDate(-1)">← 前一天</button>
      <span class="date-display">${formatDisplay(dateStr)}</span>
      <button class="btn btn-ghost btn-sm" onclick="changeDate(1)">后一天 →</button>
      <div style="margin-left:8px">${editableDateInputHtml('entry_date', dateStr, "jumpDate(document.getElementById('entry_date').value)")}</div>
      <button class="btn btn-ghost btn-sm" onclick="jumpDate('${getTodayStr()}')">今天</button>
      <button class="btn btn-primary btn-sm" onclick="toggleForm('dayMovePanel')">⇄ 迁移本日数据</button>
    </div>

    ${dayMigrationPanelHtml(dateStr, day, sessions, tasks)}

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
        ${day.wakeTime ? `<button class="btn btn-danger btn-sm" onclick="clearSavedSleepTime('${dateStr}','wake')">删除起床时间</button>` : ''}
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
          <div class="form-group" id="sessRestGroup"><label>休息时间(分钟)${tipIcon('rest')}</label><input type="number" id="sess_rest" min="0"><div class="form-hint">名义时长 + 休息时间不能超过时钟时长</div></div>
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
    <div class="card entry-table-card" id="entry-task-records">
      <div class="card-header">
        <div><div class="card-title">📝 任务记录${state._editingTaskId ? ' <span style="color:var(--wake);font-size:12px">✏️ 编辑中</span>' : ''}</div><div class="card-sub">每项具体学习内容 · 效率自动计算</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="state._editingTaskId=null;toggleForm('taskForm')">+ 添加任务</button>
        </div>
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
                  ${tmpls.map(t => `<option value="${t.id}">${escHtmlApp(t.activityType || '未分类模板')}</option>`).join('')}
                </select>
                <a href="#" onclick="showTab('templates');return false" class="btn btn-ghost btn-sm" style="white-space:nowrap">管理模板库</a>
              </div>
              <div id="task_template_match_msg" class="form-hint"></div>
            </div>`;
    })()}

          <div id="task_forecast_fields" class="form-group full-row">
            ${taskDimensionPanelHtml('', {})}
          </div>

          <div class="form-group full-row">
            <label>活动类别（一级必填，按顺序填写）*</label>
            <div class="cat-three-cols">
              <div class="cat-col">
                <span class="cat-col-label">一级类别 *</span>
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
            <div class="form-hint" style="margin-top:2px">一级类别必填；填写二级后才能填写三级。＋ 保存到库 · 🗑 从库删除（不影响已有记录）</div>
          </div>

          <div class="form-group"><label>时长(分钟)</label><input type="number" id="task_min" min="1" oninput="autoCalcRate()"></div>
          <div class="form-group" id="task_qty_group" style="display:none"><label id="task_qty_label">数量（可选）</label><input type="number" id="task_qty" min="0" step="1" oninput="autoCalcRate()"></div>
          <div class="form-group" id="task_unit_group" style="display:none"><label id="task_unit_label">新模板数量单位</label>${unitSelectorHtml('task_unit', '', 'entry_unit_msg')}<div style="font-size:11px;font-family:var(--mono)" id="entry_unit_msg"></div></div>
          <div class="form-group" id="task_rate_group" style="display:none"><label>效率(自动计算)</label><input type="text" id="task_rate" readonly style="background:var(--card);color:var(--muted)"><div class="form-hint">数量÷时长 自动算</div></div>
          <div class="form-group" id="task_wrong_group" style="display:none"><label id="task_wrong_label">错误数量（可选）</label><input type="number" id="task_wrong" min="0" step="1" oninput="autoCalcRate()"><div class="form-hint">填写错误数量，不能超过本次总数量</div></div>
          <div class="form-group" id="task_accuracy_group" style="display:none"><label>正确率（自动计算）</label><input type="text" id="task_acc" readonly style="background:var(--card);color:var(--muted)"><div class="form-hint">（总数量－错题数）÷总数量</div></div>
          <div class="form-group full-row"><label>备注</label><input type="text" id="task_note" placeholder="可选备注"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-success" id="taskFormSaveBtn" onclick="saveTask('${dateStr}')">${state._editingTaskId ? '✓ 更新任务' : '✓ 保存任务'}</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelTaskForm()">${state._editingTaskId ? '取消编辑' : '取消'}</button>
        </div>
      </div>
      ${tasks.length === 0
      ? '<div class="empty-state"><p>暂无任务记录</p></div>'
      : `${taskFilterHtml('entry', tasks)}
        <div class="table-wrap"><table id="entryTaskTable" class="resizable-task-table">
          <thead><tr><th>#</th><th>任务名称</th><th>活动类型</th><th>时长</th><th>数量</th><th>效率</th><th>正确率</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${filterTasksByView(tasks, 'entry').map((t, i) => {
        const visibleQty = visibleTaskQuantity(t);
        const visibleUnit = visibleTaskQuantityUnit(t);
        const rate = visibleQty && t.minutes ? (visibleQty / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        const isEditingTask = state._editingTaskId === t.id;
        return `<tr data-task-id="${t.id}"${isEditingTask ? ' style="background:rgba(255,213,79,.1);outline:1px solid rgba(255,213,79,.3)"' : ''}>
          <td class="fw-mono c-muted">${i + 1}</td>
          <td class="task-name-cell" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}${taskOrdinalBadgeHtml(t)}</td>
          <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
          <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
          <td class="fw-mono task-quantity-cell">${visibleQty ? visibleQty + (visibleUnit ? ' ' + visibleUnit : '') : '-'}</td>
          <td class="fw-mono task-rate-cell">${rate ? rate + (visibleUnit ? ' ' + visibleUnit + '/min' : '/min') : '-'}</td>
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
        ${day.sleepTime ? `<button class="btn btn-danger btn-sm" onclick="clearSavedSleepTime('${dateStr}','sleep')">删除睡觉时间</button>` : ''}
        ${day.sleepTime ? `<span class="fw-mono" style="font-size:12px;color:var(--sleep)">${day.sleepTime}</span>` : ''}
        <span class="form-hint" style="margin:0">填次日凌晨时间如 00:30</span>
      </div>
      ${day.wakeTime && day.sleepTime ? `
        <div style="margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--muted)">
          清醒时长${tipIcon('awake')}: <span style="color:var(--text)">${fmtMin(stats.awakeMin)}</span>${stats.unavailableMin ? ` · 不可用: <span style="color:var(--muted)">${fmtMin(stats.unavailableMin)}</span>` : ''}${stats.specialStudyActualMin ? ` · 特殊学习: <span style="color:var(--clock)">${fmtMin(stats.specialStudyActualMin)}</span>` : ''} · 可支配: <span style="color:var(--text)">${fmtMin(stats.disposableMin)}</span> ·
          不可用时间占比${tipIcon('util')}: <span style="color:${stats.utilPct == null ? 'var(--muted)' : stats.utilPct <= 30 ? 'var(--green)' : stats.utilPct <= 50 ? 'var(--wake)' : 'var(--red)'}">${stats.utilPct != null ? stats.utilPct + '%' : '-'}</span>
        </div>` : ''}
    </div>
  `;
  requestAnimationFrame(() => {
    updateTaskCategorySequenceUi();
    initEntryTaskColumnResize();
  });
}

function autoCalcRate() {
  const qty = parseFloat(document.getElementById('task_qty')?.value);
  const mins = parseFloat(document.getElementById('task_min')?.value);
  const wrongRaw = document.getElementById('task_wrong')?.value ?? '';
  const wrong = Number(wrongRaw);
  const unit = document.getElementById('task_unit')?.value || '';
  const rateEl = document.getElementById('task_rate');
  const accuracyEl = document.getElementById('task_acc');
  if (rateEl) {
    if (qty && mins && mins > 0) {
      rateEl.value = (qty / mins).toFixed(2) + (unit ? ' ' + unit + '/min' : '/min');
    } else {
      rateEl.value = '';
    }
  }
  if (accuracyEl) {
    if (qty > 0 && wrongRaw !== '' && Number.isInteger(wrong) && wrong >= 0 && wrong <= qty) {
      const accuracy = (qty - wrong) / qty * 100;
      accuracyEl.value = `${Number(accuracy.toFixed(2))}%`;
    } else {
      accuracyEl.value = '';
    }
  }
}

function toggleForm(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}
function changeDate(n) {
  if (document.getElementById('taskForm')) saveDraft(state.selectedDate, collectEntryDraft());
  state._editingSessionId = null;
  state._editingTaskId = null;
  state.selectedDate = addDays(state.selectedDate, n);
  showTab('entry');
}
function jumpDate(d) {
  if (d) {
    if (document.getElementById('taskForm')) saveDraft(state.selectedDate, collectEntryDraft());
    state._editingSessionId = null;
    state._editingTaskId = null;
    state.selectedDate = d;
    showTab('entry');
  }
}

async function saveDayNote(dateStr) {
  const note = document.getElementById('dayNoteInput')?.value || '';
  const day = getDay(dateStr);
  day.dayNote = note;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/dayNote`, { method: 'PUT', body: JSON.stringify({ dayNote: note }) });
  renderEntry(); restoreDraft(dateStr);
  showPersistentSaveNotice(note.trim() ? '今日备注已保存' : '今日备注已清空并保存');
}

function applyDayTypeTemplateToEntry(name) {
  const tmpl = getDayTypeTemplates().find(item => item.name === String(name || '').trim());
  if (!tmpl) return;
  const special = document.getElementById('specialDayCheck');
  const exclude = document.getElementById('excludeFromRatingCheck');
  if (special) special.checked = Boolean(tmpl.specialDay);
  if (exclude) exclude.checked = Boolean(tmpl.excludeFromRating);
}

async function saveSleep(dateStr) {
  const wakeTime = readTimeInput('wakeInput');
  const sleepTime = readTimeInput('sleepInput');
  const dayType = document.getElementById('dayTypeInput')?.value?.trim() || '';
  const specialDay = document.getElementById('specialDayCheck')?.checked || false;
  const excludeFromRating = document.getElementById('excludeFromRatingCheck')?.checked || false;
  const day = getDay(dateStr);
  day.wakeTime = wakeTime;
  day.sleepTime = sleepTime;
  day.dayType = dayType;
  day.specialDay = specialDay;
  day.excludeFromRating = excludeFromRating;
  updateSleepDraft(dateStr, wakeTime, sleepTime);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sleep`, { method: 'PUT', body: JSON.stringify({ wakeTime, sleepTime, dayType, specialDay, excludeFromRating }) });
  renderEntry(); renderHeader(); restoreDraft(dateStr);
}

function updateSleepDraft(dateStr, wakeTime, sleepTime) {
  const draft = loadDraft(dateStr) || {};
  const wakeParts = String(wakeTime || '').split(':');
  const sleepParts = String(sleepTime || '').split(':');
  draft.wakeH = wakeTime ? wakeParts[0] || '' : '';
  draft.wakeM = wakeTime ? wakeParts[1] || '' : '';
  draft.sleepH = sleepTime ? sleepParts[0] || '' : '';
  draft.sleepM = sleepTime ? sleepParts[1] || '' : '';
  draft._savedAt = new Date().toISOString();
  saveDraft(dateStr, draft);
}

async function clearSavedSleepTime(dateStr, type) {
  const day = getDay(dateStr);
  const isWake = type === 'wake';
  const label = isWake ? '起床时间' : '睡觉时间';
  if (!confirm(`确定删除 ${dateStr} 的${label}？当天其他记录不会受影响。`)) return;
  if (isWake) day.wakeTime = '';
  else day.sleepTime = '';
  updateSleepDraft(dateStr, day.wakeTime || '', day.sleepTime || '');
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sleep`, {
    method: 'PUT',
    body: JSON.stringify({ wakeTime: day.wakeTime || '', sleepTime: day.sleepTime || '' }),
  });
  renderEntry();
  renderHeader();
  if (Number(SETTINGS.snapshotInterval) > 0) saveServerSnapshot();
}

async function saveSession(dateStr) {
  const sessionType = state._sessType || 'normal';
  const isSpecial = sessionType === 'special';
  const isSpecialStudy = sessionType === 'special-study';
  const sessName = (document.getElementById('sess_name')?.value || '').trim();
  const start = readTimeInput('sess_start');
  const end = readTimeInput('sess_end');
  const nominal = Number(document.getElementById('sess_nominal').value || 0);
  const actual = Number(document.getElementById('sess_actual').value || 0);
  const rest = Number(document.getElementById('sess_rest').value || 0);
  const note = document.getElementById('sess_note')?.value || '';
  if ((isSpecial || isSpecialStudy) && !sessName) { alert('请填写时段名称'); return; }
  if (!start || !end) { alert('请填写开始和结束时间'); return; }
  if (isSpecialStudy && actual <= 0) { alert('特殊学习时段请填写其中实际学习的分钟数'); return; }
  const clockMinutes = sessionClock({ startTime: start, endTime: end });
  if (clockMinutes <= 0) {
    alert('时段数据不合法：开始时间和结束时间不能相同。');
    return;
  }
  if (!isSpecial && !isSpecialStudy) {
    if (!Number.isInteger(nominal) || !Number.isInteger(actual) || !Number.isInteger(rest) ||
      nominal <= 0 || actual <= 0 || rest < 0) {
      alert('普通时段的名义时长和实际专注必须是正整数，休息时间必须是非负整数。');
      return;
    }
    if (clockMinutes < nominal) {
      alert(`时段数据不合法：时钟时长 ${clockMinutes} 分钟必须大于或等于名义时长 ${nominal} 分钟。`);
      return;
    }
    if (nominal < actual) {
      alert(`时段数据不合法：名义时长 ${nominal} 分钟必须大于或等于实际专注 ${actual} 分钟。`);
      return;
    }
    if (nominal + rest > clockMinutes) {
      alert(`时段数据不合法：时钟时长为 ${clockMinutes} 分钟，但名义时长 ${nominal} 分钟 + 休息 ${rest} 分钟 = ${nominal + rest} 分钟。\n名义时长与休息时间之和不能超过时钟时长。`);
      return;
    }
  }
  if (isSpecialStudy && actual > clockMinutes) {
    alert(`时段数据不合法：时钟时长为 ${clockMinutes} 分钟，但实际学习填写了 ${actual} 分钟。\n实际学习不能超过时钟时长。`);
    return;
  }

  const editId = state._editingSessionId;
  const day = getDay(dateStr);
  const previousNote = editId ? String(day.sessions.find(session => session.id === editId)?.note || '') : '';
  const candidateSession = {
    id: editId || uid(),
    startTime: start,
    endTime: end,
    note,
    type: isSpecial || isSpecialStudy ? sessionType : 'normal',
    name: isSpecial || isSpecialStudy ? sessName : '',
    nominalMinutes: isSpecial || isSpecialStudy ? 0 : nominal,
    actualMinutes: isSpecialStudy ? actual : isSpecial ? 0 : actual,
    restMinutes: isSpecial || isSpecialStudy ? 0 : rest,
  };
  const candidateSessions = editId
    ? day.sessions.map(session => session.id === editId ? candidateSession : session)
    : [...day.sessions, candidateSession];
  const conflictingSession = day.sessions.find(session =>
    session.id !== editId && sessionsOverlap(candidateSession, session)
  );
  if (conflictingSession) {
    const conflictLabel = sessionTypeMeta(conflictingSession).label;
    alert(`不能保存：${start}–${end} 与已有${conflictLabel}时段 ${conflictingSession.startTime}–${conflictingSession.endTime} 重叠。\n时段可以首尾相接，但不能交叉或相互包含。`);
    return;
  }
  if (!canApplyNormalSessionCapacityChange(day, candidateSessions)) return;

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
  state._sessType = 'normal';
  showTab('entry');
  if (note.trim() || previousNote.trim()) {
    showPersistentSaveNotice(note.trim() ? '时段备注已保存' : '时段备注已清空并保存');
  }
  if (Number(SETTINGS.snapshotInterval) > 0) saveServerSnapshot();
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
  state._sessType = 'normal';
  const form = document.getElementById('sessionForm');
  if (form) form.classList.remove('open');
  renderEntry();
}

async function deleteSession(dateStr, id) {
  const day = getDay(dateStr);
  const candidateSessions = day.sessions.filter(s => s.id !== id);
  if (!canApplyNormalSessionCapacityChange(day, candidateSessions)) return;
  day.sessions = candidateSessions;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${id}`, { method: 'DELETE' });
  renderEntry(); renderHeader();
}

function normalSessionActualTotal(sessions = []) {
  return sessions.reduce((sum, session) => {
    const isNormal = !session.type || session.type === 'normal';
    return isNormal ? sum + Math.max(0, Number(session.actualMinutes) || 0) : sum;
  }, 0);
}

function taskMinutesTotal(tasks = [], excludedTaskId = null) {
  return tasks.reduce((sum, task) => {
    if (excludedTaskId && task.id === excludedTaskId) return sum;
    return sum + Math.max(0, Number(task.minutes) || 0);
  }, 0);
}

function canApplyNormalSessionCapacityChange(day, candidateSessions) {
  const taskTotal = taskMinutesTotal(day.tasks);
  const currentCapacity = normalSessionActualTotal(day.sessions);
  const nextCapacity = normalSessionActualTotal(candidateSessions);
  if (nextCapacity < taskTotal && nextCapacity < currentCapacity) {
    alert(`不能保存：当天任务总时长为 ${taskTotal} 分钟，修改后普通时段的实际专注总时长只有 ${nextCapacity} 分钟。\n普通时段容量不能低于任务总时长。`);
    return false;
  }
  return true;
}

async function saveTask(dateStr) {
  taskRecalculateNamedItemTotals();
  const name = document.getElementById('task_name').value.trim();
  const mins = Number(document.getElementById('task_min').value || 0);
  if (!name) { alert('请填写任务名称'); return; }
  if (!Number.isInteger(mins) || mins <= 0) { alert('任务时长必须是大于 0 的整数分钟。'); return; }
  const qty = document.getElementById('task_qty')?.value || '';
  const wrongRaw = document.getElementById('task_wrong')?.value ?? '';
  const level1 = catSelValue('task_l1');
  const level2 = catSelValue('task_l2');
  const level3 = catSelValue('task_l3');
  if (!level1) {
    alert('活动类别为必填项，请先填写一级类别。');
    return;
  }
  if (level3 && !level2) {
    alert('活动类别必须按顺序填写：填写三级类别前必须先填写二级类别。');
    return;
  }
  const activityType = buildActPath(level1, level2, level3);
  const note = document.getElementById('task_note').value;
  let templateId = document.getElementById('task_tmpl')?.value || '';
  const selectedTemplateId = templateId;
  let template = getTaskTemplateById(templateId);
  let pendingTemplate = null;
  let inheritedTemplateConfig = null;

  if (template && template.activityType !== activityType) {
    inheritedTemplateConfig = template;
    template = null;
    templateId = '';
  }

  if (!template && activityType) {
    const matches = getTaskTemplates().filter(item => item.activityType === activityType);
    if (matches.length > 1) {
      alert('该完整活动类别对应多个模板，请先在“套用模板”中明确选择一个模板。');
      return;
    }
    if (matches.length === 1) {
      template = matches[0];
      templateId = template.id;
    } else {
      const ordinalEnabled = inheritedTemplateConfig
        ? Boolean(inheritedTemplateConfig.namedItemEnabled ?? inheritedTemplateConfig.ordinalEnabled)
        : Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
      const quantityEnabled = inheritedTemplateConfig
        ? Boolean(inheritedTemplateConfig.quantityEnabled)
        : Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
      const ordinalUnit = inheritedTemplateConfig?.ordinalUnit || (ordinalEnabled ? '项' : '');
      const quantityUnit = inheritedTemplateConfig?.quantityUnit ||
        document.getElementById('task_unit')?.value.trim() || '';
      if (quantityEnabled && !quantityUnit) {
        alert('新模板开启了数量记录，请先选择数量单位。');
        return;
      }
      template = {
        id: uid(),
        activityType,
        defaultMinutes: mins,
        namedItemEnabled: ordinalEnabled,
        namedItems: [],
        ordinalEnabled,
        ordinalUnit,
        quantityEnabled,
        quantityUnit,
        note: '',
      };
      pendingTemplate = template;
      templateId = template.id;
    }
  }

  if (template && selectedTemplateId === template.id && !inheritedTemplateConfig) {
    const enteredOrdinalUnit = document.getElementById('task_template_ordinal_unit')?.value.trim() || template.ordinalUnit || '';
    const enteredQuantityUnit = document.getElementById('task_unit')?.value.trim() || template.quantityUnit || '';
    const committed = await commitTaskTemplateUnitChanges(template, enteredOrdinalUnit, enteredQuantityUnit);
    if (!committed) return;
  }

  const ordinalEnabled = template
    ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
    : inheritedTemplateConfig
      ? Boolean(inheritedTemplateConfig.namedItemEnabled ?? inheritedTemplateConfig.ordinalEnabled)
    : Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  const quantityEnabled = template
    ? Boolean(template.quantityEnabled)
    : inheritedTemplateConfig
      ? Boolean(inheritedTemplateConfig.quantityEnabled)
    : Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
  const ordinalUnit = template?.ordinalUnit || inheritedTemplateConfig?.ordinalUnit ||
    document.getElementById('task_new_ordinal_unit')?.value.trim() || '';
  const quantityUnit = template?.quantityUnit || inheritedTemplateConfig?.quantityUnit ||
    document.getElementById('task_unit')?.value.trim() || '';
  if (!template && (ordinalEnabled || quantityEnabled)) {
    alert('使用命名章节或数量记录时必须填写活动类别，以便建立并绑定模板。');
    return;
  }
  const forecastGoal = getForecastGoalByTemplate(templateId);
  let ordinalNumbers = [];
  let completedOrdinals = [];
  const namedItemAllocations = ordinalEnabled ? taskCollectNamedItemAllocations(true) : [];
  if (ordinalEnabled && namedItemAllocations === null) return;
  if (ordinalEnabled && !namedItemAllocations.length) {
    alert('请至少添加一个命名章节。');
    return;
  }
  if (ordinalEnabled && namedItemAllocations.length > 1 &&
    namedItemAllocations.some(item => !item.completed)) {
    alert('一条任务选择多个章节时，所有章节都必须标记为“本次完成”。如有未完成章节，请拆分为单章节任务分别记录。');
    return;
  }
  if (ordinalEnabled && !taskValidateNamedItemTimeline(templateId, namedItemAllocations, dateStr)) {
    return;
  }

  if (quantityEnabled && qty !== '') {
    const quantityNumber = Number(qty);
    if (!Number.isInteger(quantityNumber) || quantityNumber < 0) {
      alert(`数量必须是非负整数${quantityUnit ? `（单位：${quantityUnit}）` : ''}。`);
      return;
    }
  }
  if (quantityEnabled && (forecastGoal?.mode === 'quantity' || forecastGoal?.mode === 'chapterQuantity')) {
    const quantityNumber = Number(qty);
    if (!Number.isInteger(quantityNumber) || quantityNumber <= 0) {
      alert(`该预测目标要求本次任务填写大于 0 的整数数量（单位：${quantityUnit}）。`);
      return;
    }
    if (quantityUnit !== forecastGoal.quantityUnit) {
      alert(`数量单位必须与预测目标一致：${forecastGoal.quantityUnit}`);
      return;
    }
  }
  let wrongCount = null;
  let calculatedAccuracy = null;
  if (quantityEnabled && wrongRaw !== '') {
    const quantityNumber = Number(qty);
    const wrongNumber = Number(wrongRaw);
    if (!Number.isInteger(quantityNumber) || quantityNumber <= 0) {
      alert('填写错题数前，必须先填写大于 0 的整数总数量。');
      return;
    }
    if (!Number.isInteger(wrongNumber) || wrongNumber < 0 || wrongNumber > quantityNumber) {
      alert(`错题数必须是 0 到 ${quantityNumber} 之间的整数。`);
      return;
    }
    wrongCount = wrongNumber;
    calculatedAccuracy = Number((((quantityNumber - wrongNumber) / quantityNumber) * 100).toFixed(2));
  }
  const editId = state._editingTaskId;
  const day = getDay(dateStr);
  const previousNote = editId ? String(day.tasks.find(task => task.id === editId)?.note || '') : '';
  const otherTaskMinutes = taskMinutesTotal(day.tasks, editId);
  const taskTotalAfterSave = otherTaskMinutes + mins;
  const normalCapacity = normalSessionActualTotal(day.sessions);
  if (taskTotalAfterSave > normalCapacity) {
    alert(`不能保存：保存后当天任务总时长为 ${taskTotalAfterSave} 分钟，但普通时段的实际专注总时长只有 ${normalCapacity} 分钟。\n请先增加或调整普通专注时段。`);
    return;
  }

  const namedItemsChanged = ordinalEnabled ? taskCommitDraftNamedItems(template, namedItemAllocations) : false;
  if (pendingTemplate) {
    getTaskTemplates().push(pendingTemplate);
    await saveAllStorage();
  } else if (namedItemsChanged) {
    await saveAllStorage();
  }

  if (editId) {
    // ── 编辑模式：原地更新 ──
    const idx = day.tasks.findIndex(t => t.id === editId);
    if (idx < 0) { alert('找不到要编辑的任务'); state._editingTaskId = null; return; }
    const task = day.tasks[idx];
    task.name = name;
    task.activityType = activityType;
    task.minutes = mins;
    if (quantityEnabled) {
      task.quantity = qty !== '' ? Number(qty) : null;
      task.quantityUnit = quantityUnit;
      task.wrongCount = wrongCount;
      task.accuracy = calculatedAccuracy;
    }
    task.note = note;
    task.templateId = templateId || null;
    if (ordinalEnabled) {
      task.namedItemAllocations = namedItemAllocations.map(item => ({
        itemId: item.itemId,
        itemName: item.itemName,
        minutes: item.minutes,
        quantity: quantityEnabled ? item.quantity : null,
        completed: item.completed,
      }));
      delete task.ordinalNumbers;
      delete task.completedOrdinals;
      delete task.chapterNumbers;
      delete task.completedChapters;
      delete task.chapterNumber;
      delete task.chapterCompleted;
    }
    state._editingTaskId = null;
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}`, { method: 'PUT', body: JSON.stringify(day) });
  } else {
    // ── 新增模式 ──
    const task = {
      id: uid(), name, activityType, minutes: mins,
      quantity: quantityEnabled && qty !== '' ? Number(qty) : null,
      quantityUnit: quantityEnabled ? quantityUnit : '',
      wrongCount: quantityEnabled ? wrongCount : null,
      accuracy: quantityEnabled ? calculatedAccuracy : null, note,
      templateId: templateId || null,
      namedItemAllocations: ordinalEnabled ? namedItemAllocations.map(item => ({
        itemId: item.itemId,
        itemName: item.itemName,
        minutes: item.minutes,
        quantity: quantityEnabled ? item.quantity : null,
        completed: item.completed,
      })) : [],
    };
    day.tasks.push(task);
    cacheToLocal(); clearDraft(dateStr);
    await apiFetch(`/api/data/${dateStr}/tasks`, { method: 'POST', body: JSON.stringify(task) });
  }
  showTab('entry');
  if (note.trim() || previousNote.trim()) {
    showPersistentSaveNotice(note.trim() ? '任务备注已保存' : '任务备注已清空并保存');
  }
  if (Number(SETTINGS.snapshotInterval) > 0) saveServerSnapshot();
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
    const templateId = resolveTaskTemplateId(t);
    const template = getTaskTemplateById(templateId);
    const templateEl = document.getElementById('task_tmpl');
    if (templateEl) templateEl.value = templateId || '';
    renderForecastTaskFields(templateId, t);
    configureTaskUnitFields(templateId);
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
    if (unitEl) unitEl.value = template?.quantityUnit || t.quantityUnit || '';
    let wrongValue = t.wrongCount;
    if (wrongValue == null && t.quantity != null && t.accuracy != null) {
      const estimatedWrong = Number(t.quantity) * (100 - Number(t.accuracy)) / 100;
      const roundedWrong = Math.round(estimatedWrong);
      if (Math.abs(estimatedWrong - roundedWrong) < 1e-8) wrongValue = roundedWrong;
    }
    const wrongEl = document.getElementById('task_wrong');
    if (wrongEl) wrongEl.value = wrongValue != null ? wrongValue : '';
    const accEl = document.getElementById('task_acc');
    const noteEl = document.getElementById('task_note');
    if (noteEl) noteEl.value = t.note || '';
    autoCalcRate();
    if (accEl && wrongValue == null && t.accuracy != null) accEl.value = `${t.accuracy}%`;
    updateTaskCategorySequenceUi();
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

function toggleDayMoveSelection() {
  const items = [...document.querySelectorAll('.day-move-item')];
  const shouldSelect = items.some(item => !item.checked);
  items.forEach(item => { item.checked = shouldSelect; });
  const button = document.getElementById('day_move_select_all');
  if (button) button.textContent = shouldSelect ? '全取消' : '全选';
}

async function moveSelectedDayData(sourceDate, mode) {
  const targetDate = document.getElementById('day_move_target')?.value || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    alert('请选择有效的目标日期。');
    return;
  }
  if (targetDate === sourceDate) {
    alert('目标日期不能与来源日期相同。');
    return;
  }
  const selected = [...document.querySelectorAll('.day-move-item:checked')];
  if (!selected.length) {
    alert('请至少选择一项需要迁移的数据。');
    return;
  }
  const selection = {
    wakeTime: selected.some(item => item.dataset.kind === 'wakeTime'),
    dayNote: selected.some(item => item.dataset.kind === 'dayNote'),
    sleepTime: selected.some(item => item.dataset.kind === 'sleepTime'),
    sessionIds: selected.filter(item => item.dataset.kind === 'session').map(item => item.dataset.id),
    taskIds: selected.filter(item => item.dataset.kind === 'task').map(item => item.dataset.id),
  };
  const targetSessionCount = state.data[targetDate]?.sessions?.length || 0;
  const targetTaskCount = state.data[targetDate]?.tasks?.length || 0;
  const action = mode === 'overwrite' ? '覆盖同类' : '追加';
  const warning = mode === 'overwrite'
    ? `若选择了专注时段，将替换目标日 ${targetSessionCount} 条时段；若选择了任务，将替换目标日 ${targetTaskCount} 条任务。`
    : `所选专注时段和任务会追加到目标日现有 ${targetSessionCount} 条时段、${targetTaskCount} 条任务之后。`;
  if (!confirm(`把 ${sourceDate} 选中的 ${selected.length} 项迁移到 ${targetDate}（${action}）？\n${warning}\n起床时间、今日备注和睡觉时间选中后会覆盖目标日对应值；来源日只删除已选内容。`)) return;
  try {
    const result = await apiFetch('/api/day/move', {
      method: 'POST',
      body: JSON.stringify({ sourceDate, targetDate, mode, selection }),
    });
    state.data[sourceDate] = result.sourceDay;
    state.data[targetDate] = result.targetDay;
    if (selection.sessionIds.includes(state._editingSessionId)) state._editingSessionId = null;
    if (selection.taskIds.includes(state._editingTaskId)) state._editingTaskId = null;
    const draft = loadDraft(sourceDate) || {};
    if (selection.wakeTime) { draft.wakeH = ''; draft.wakeM = ''; }
    if (selection.dayNote) draft.dayNote = '';
    if (selection.sleepTime) { draft.sleepH = ''; draft.sleepM = ''; }
    draft._savedAt = new Date().toISOString();
    saveDraft(sourceDate, draft);
    state.selectedDate = targetDate;
    cacheToLocal();
    alert(`已迁移 ${result.moved} 项数据到 ${targetDate}，其中专注时段 ${result.movedSessions} 条、任务 ${result.movedTasks} 条。`);
    showTab('entry');
    if (Number(SETTINGS.snapshotInterval) > 0) saveServerSnapshot();
  } catch (error) {
    console.error('迁移日数据失败', error);
    alert('迁移失败，来源和目标数据未在前端改动。请反馈后端日志中的关键错误。');
  }
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
    const unclassifiedTasks = (state.data[dateStr]?.tasks || []).filter(isTaskUnclassified);
    const unclassifiedTitle = unclassifiedTasks.map(task => task.name || '未命名任务').join('、');
    const dots = actKeys
      .map(k => { const c = getActColor(k); return `<div class="cal-dot" style="background:${c.color}" title="${k}: ${fmtMin(s.actMin[k])}"></div>`; })
      .join('');
    return `<div class="cal-day ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''} ${!inMonth ? 'other-month' : ''} ${hasData ? 'has-data' : ''}"
          style="${unclassifiedTasks.length ? 'box-shadow:inset 0 0 0 2px rgba(255,82,82,.82);background:rgba(255,82,82,.06)' : ''}"
          onclick="calSelectDay('${dateStr}')">
          <div class="cal-day-num">${strToDate(dateStr).getDate()}</div>
          ${unclassifiedTasks.length ? `<button type="button" title="未分类任务：${escHtmlApp(unclassifiedTitle)}"
            onclick="event.stopPropagation();calOpenUnclassified('${dateStr}')"
            style="display:block;width:100%;margin:4px 0;padding:3px 5px;border:1px solid rgba(255,82,82,.8);border-radius:5px;background:rgba(255,82,82,.18);color:#ff8a80;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ⚠ 未分类 ${unclassifiedTasks.length}
          </button>` : ''}
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
      <span style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ff8a80"><span style="width:10px;height:10px;border:2px solid rgba(255,82,82,.82);border-radius:3px"></span>存在未分类任务</span>
      <span style="font-size:11px;color:var(--muted);margin-left:8px">点击日期→录入/日览</span>
    </div>
  `;
}

function calOpenUnclassified(dateStr) {
  state.selectedDate = dateStr;
  state._taskFilter.entry = '未分类';
  showTab('entry');
  setTimeout(() => {
    document.getElementById('entry-task-records')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 0);
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
      <div class="mini-card"><div class="lbl">不可用时间占比${tipIcon('util')}</div><div class="val" style="color:${s.utilPct == null ? 'var(--muted)' : s.utilPct <= 30 ? 'var(--green)' : s.utilPct <= 50 ? 'var(--wake)' : 'var(--red)'}">${s.utilPct != null ? s.utilPct + '%' : '-'}</div><div class="sub">不可用时长/清醒时长</div></div>
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
              ${sortSessionsByStart(s.sessions).map((sess, i) => {
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
    const visibleQty = visibleTaskQuantity(t);
    const visibleUnit = visibleTaskQuantityUnit(t);
    const rate = visibleQty && t.minutes ? (visibleQty / Number(t.minutes)).toFixed(2) : null;
    return `<tr>
                  <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtmlApp(t.name)}</td>
                  <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
                  <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
                  <td class="fw-mono">${visibleQty ? (visibleQty + (visibleUnit ? ' ' + visibleUnit : '')) : '-'}</td>
                  <td class="fw-mono">${rate ? (rate + (visibleUnit ? ' ' + visibleUnit + '/min' : '/min')) : '-'}</td>
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
    sortSessionsByStart(day.sessions || []).forEach(s => { allWeekSessions.push({ ...s, _date: dateStr }); });
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
        <div class="chart-sub">时钟 + 有效时钟 + 休息 + 名义 + 实际 + 偏差 + 效率 + 不可用时间占比</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>日期</th><th>起床</th><th>睡觉</th>
              <th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-clock">有效${tipIcon('effectiveClock')}</th><th>休息${tipIcon('rest')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th>
              <th>偏差率${tipIcon('deviation')}</th><th>效率${tipIcon('efficiency')}</th><th>不可用占比${tipIcon('util')}</th>
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
                  <td class="fw-mono ${d.utilPct == null ? 'c-muted' : d.utilPct <= 30 ? 'c-green' : d.utilPct <= 50 ? 'c-wake' : 'c-red'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
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
        const visibleQty = visibleTaskQuantity(t);
        const visibleUnit = visibleTaskQuantityUnit(t);
        const rate = visibleQty && t.minutes ? (visibleQty / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        return `<tr>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${t._date}';showTab('day')">${formatShort(t._date)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}</td>
              <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
              <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
              <td class="fw-mono">${visibleQty ? visibleQty + (visibleUnit ? ' ' + visibleUnit : '') : '-'}</td>
              <td class="fw-mono">${rate ? rate + (visibleUnit ? ' ' + visibleUnit + '/min' : '/min') : '-'}</td>
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
  const monthDayStatuses = dayStats.map(d => {
    const day = getDay(d.dateStr);
    if (day.specialDay && day.excludeFromRating) return 'special-excluded';
    if (day.excludeFromRating) return 'excluded';
    if (day.specialDay) return 'special';
    return 'normal';
  });

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
    sortSessionsByStart(day.sessions || []).forEach(s => { allMonthSessions.push({ ...s, _date: dateStr }); });
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
        <div class="chart-sub">填充折线图 · 时钟（虚线）/ 有效时钟 / 名义（蓝）/ 实际（绿）· ◆特殊天 · ▲不评分 · ★特殊天且不评分</div>
        <canvas id="monthThreeChart" height="80"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">月度类别分布</div>
        <div class="chart-sub">各类别累计时长</div>
        <canvas id="monthCatChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">每日实际专注分布</div>
        <div class="chart-sub">实际专注时长柱状图 · ◆特殊天 · ▲不评分 · ★特殊天且不评分</div>
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
              <th>偏差率${tipIcon('deviation')}</th><th>效率${tipIcon('efficiency')}</th><th>不可用占比${tipIcon('util')}</th><th>评价</th>
            </tr></thead>
            <tbody>
              ${dayStats.filter(d => d.clockMin > 0 || d.taskMin > 0 || state.data[d.dateStr]?.wakeTime).map(d => {
    const dayObj = getDay(d.dateStr);
    let sc = 0;
    if (d.actualMin >= 480) sc++;
    if (d.actualVsNominal != null && d.actualVsNominal >= -10) sc++;
    if (dayObj.wakeTime && parseMin(dayObj.wakeTime) <= 8 * 60) sc++;
    if (d.utilPct != null && d.utilPct <= SETTINGS.ratingUtilPct) sc++;
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
                  <td class="fw-mono ${d.utilPct == null ? 'c-muted' : d.utilPct <= 30 ? 'c-green' : d.utilPct <= 50 ? 'c-wake' : 'c-red'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
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
        const visibleQty = visibleTaskQuantity(t);
        const visibleUnit = visibleTaskQuantityUnit(t);
        const rate = visibleQty && t.minutes ? (visibleQty / Number(t.minutes)).toFixed(2) : null;
        const actColor = getActColor(t.activityType);
        return `<tr>
              <td class="fw-mono" style="white-space:nowrap;cursor:pointer;color:var(--hp)" onclick="state.selectedDate='${t._date}';showTab('day')">${formatShort(t._date)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}</td>
              <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
              <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
              <td class="fw-mono">${visibleQty ? visibleQty + (visibleUnit ? ' ' + visibleUnit : '') : '-'}</td>
              <td class="fw-mono">${rate ? rate + (visibleUnit ? ' ' + visibleUnit + '/min' : '/min') : '-'}</td>
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
  const monthStatusMeta = {
    normal: { symbol: '', label: '', color: '', background: '' },
    special: { symbol: '◆', label: '特殊天', color: '#b388ff', background: 'rgba(179,136,255,.5)', rank: 1 },
    excluded: { symbol: '▲', label: '不参与评分', color: '#ffb74d', background: 'rgba(255,183,77,.5)', rank: 2 },
    'special-excluded': { symbol: '★', label: '特殊天且不参与评分', color: '#ef9a9a', background: 'rgba(239,154,154,.55)', rank: 3 },
  };
  const monthMetaAt = index => monthStatusMeta[monthDayStatuses[index]] || monthStatusMeta.normal;
  const monthSegmentMeta = context => {
    const first = monthMetaAt(context.p0DataIndex);
    const second = monthMetaAt(context.p1DataIndex);
    return (first.rank || 0) >= (second.rank || 0) ? first : second;
  };
  const monthTrendAccent = baseColor => ({
    pointRadius: monthDayStatuses.map(status => status === 'normal' ? 2 : 4),
    pointStyle: monthDayStatuses.map(status =>
      status === 'special-excluded' ? 'star' : status === 'excluded' ? 'triangle' : status === 'special' ? 'rectRot' : 'circle'),
    pointBackgroundColor: monthDayStatuses.map((status, index) => monthMetaAt(index).color || baseColor),
    pointBorderColor: monthDayStatuses.map((status, index) => monthMetaAt(index).color || baseColor),
    segment: {
      borderColor: context => monthSegmentMeta(context).color || baseColor,
    },
  });
  const monthXAxisTicks = () => ({
    color: context => monthMetaAt(context.index).color || '#6b7a9e',
    callback: (value, index) => {
      const meta = monthMetaAt(index);
      return `${meta.symbol ? `${meta.symbol} ` : ''}${labels[index]}`;
    },
    maxRotation: 45,
  });
  mkChart('monthThreeChart', {
    type: 'line', data: {
      labels, datasets: [
        {
          label: '时钟',
          data: dayStats.map(d => +(d.clockMin / 60).toFixed(2)),
          borderColor: '#80deea',
          backgroundColor: 'rgba(128,222,234,.12)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          ...monthTrendAccent('#80deea'),
          tension: .3,
          fill: 'origin',
          spanGaps: false
        },
        { label: '有效时钟', data: dayStats.map(d => +(d.effectiveClockMin / 60).toFixed(2)), borderColor: '#80deea', backgroundColor: 'rgba(128,222,234,.18)', borderWidth: 1.5, ...monthTrendAccent('#80deea'), tension: .3, fill: 'origin', spanGaps: false },
        { label: '名义', data: dayStats.map(d => +(d.nominalMin / 60).toFixed(2)), borderColor: '#4fc3f7', backgroundColor: 'rgba(79,195,247,.18)', borderWidth: 1.5, ...monthTrendAccent('#4fc3f7'), tension: .3, fill: 'origin', spanGaps: false },
        { label: '实际', data: dayStats.map(d => +(d.actualMin / 60).toFixed(2)), borderColor: '#69f0ae', backgroundColor: 'rgba(105,240,174,.22)', borderWidth: 2, ...monthTrendAccent('#69f0ae'), tension: .3, fill: 'origin', spanGaps: false },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#6b7a9e' } }, filler: { propagate: false },
        tooltip: {
          callbacks: {
            title: items => {
              if (!items.length) return '';
              const index = items[0].dataIndex;
              const meta = monthMetaAt(index);
              return meta.label ? `${labels[index]} · ${meta.symbol} ${meta.label}` : labels[index];
            },
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              return `${ctx.dataset.label}: ${fmtMin(Math.round(v * 60), true)}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: monthXAxisTicks(),
          grid: gridCfg
        },
        y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, title: { display: true, text: '小时', color: '#6b7a9e' }, min: 0 }
      }
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
          backgroundColor: dayStats.map((d, index) => monthMetaAt(index).background || (d.actualMin >= 480 ? 'rgba(105,240,174,.5)' : d.actualMin >= 300 ? 'rgba(79,195,247,.4)' : d.actualMin > 0 ? 'rgba(255,183,77,.4)' : 'rgba(120,144,156,.2)')),
          borderColor: dayStats.map((d, index) => monthMetaAt(index).color || (d.actualMin >= 480 ? '#69f0ae' : d.actualMin >= 300 ? '#4fc3f7' : d.actualMin > 0 ? '#ffb74d' : '#78909c')),
          borderWidth: 1, borderRadius: 3
        },
        { type: 'line', label: '目标8h', data: dayStats.map(() => 8), borderColor: 'rgba(105,240,174,.3)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true, plugins: { legend: { labels: { color: '#6b7a9e' } } },
      scales: { x: { ticks: monthXAxisTicks(), grid: gridCfg }, y: { ticks: { color: '#6b7a9e', callback: v => v + 'h' }, grid: gridCfg, min: 0 } }
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
  // 作息页保留所有单边记录：只填起床或只填睡觉的日期也必须展示。
  const dates = getAllDates().filter(d => state.data[d]?.wakeTime || state.data[d]?.sleepTime);
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

  // 一个图表点代表“一晚”：前一日记录的睡觉时间 + 次日记录的起床时间。
  // 以起床日期作为横轴日期，避免把同一天早晨起床和当天深夜睡觉误画成一个睡眠周期。
  const cycleByWakeDate = new Map();
  function ensureSleepCycle(wakeDate) {
    if (!cycleByWakeDate.has(wakeDate)) {
      cycleByWakeDate.set(wakeDate, {
        wakeDate,
        sleepDate: addDays(wakeDate, -1),
        wakeTime: '',
        sleepTime: '',
        wakeMin: null,
        sleepMin: null,
      });
    }
    return cycleByWakeDate.get(wakeDate);
  }
  dates.forEach(dateStr => {
    const day = state.data[dateStr] || {};
    if (day.wakeTime) {
      const cycle = ensureSleepCycle(dateStr);
      cycle.wakeTime = day.wakeTime;
      cycle.wakeMin = parseMin(day.wakeTime);
    }
    if (day.sleepTime) {
      const cycle = ensureSleepCycle(addDays(dateStr, 1));
      cycle.sleepTime = day.sleepTime;
      cycle.sleepMin = parseMin(day.sleepTime);
      cycle.sleepDate = dateStr;
    }
  });
  const sleepCycles = Array.from(cycleByWakeDate.values())
    .sort((a, b) => a.wakeDate.localeCompare(b.wakeDate));

  document.getElementById('tab-sleep').innerHTML = `
    <div class="mini-grid" style="margin-bottom:16px">
      <div class="mini-card"><div class="lbl">记录天数</div><div class="val c-hp">${sleepDays.length}</div></div>
      <div class="mini-card"><div class="lbl">平均起床</div><div class="val c-wake">${sleepDays.length ? avgTime(sleepDays.map(d => d.wakeMin).filter(x => x != null)) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均睡觉</div><div class="val c-sleep">${sleepDays.length ? avgTime(sleepDays.map(d => d.sleepMin).filter(x => x != null), 18 * 60) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均清醒</div><div class="val" style="color:var(--muted)">${sleepDays.filter(d => d.awakeMin != null).length ? fmtMin(Math.round(sleepDays.filter(d => d.awakeMin != null).reduce((s, d) => s + d.awakeMin, 0) / sleepDays.filter(d => d.awakeMin != null).length)) : '-'}</div></div>
      <div class="mini-card"><div class="lbl">平均不可用占比</div><div class="val c-pol">${sleepDays.filter(d => d.utilPct != null).length ? Math.round(sleepDays.filter(d => d.utilPct != null).reduce((s, d) => s + d.utilPct, 0) / sleepDays.filter(d => d.utilPct != null).length) + '%' : '-'}</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-title">每晚睡眠与次日起床趋势</div>
        <div class="chart-sub">横轴按起床日期归属 · 紫线=前一晚睡觉 · 黄线=次日起床 · 半透明柱=完整睡眠区间 · 单边记录仍会显示</div>
        <canvas id="sleepTimelineChart" height="120"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">起床时间分布</div>
        <div class="chart-sub">各时段起床次数</div>
        <canvas id="wakeDistChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">清醒时长 vs 学习时长</div>
        <div class="chart-sub">灰柱=清醒 · 蓝柱=实际专注 · 橙线=不可用时间占比%</div>
        <canvas id="awakeStudyChart" height="200"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">作息数据明细</div>
        <div class="chart-sub">包含起床/睡觉/清醒/学习/不可用时间占比</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>日期</th><th class="c-wake">起床</th><th class="c-sleep">睡觉</th>
              <th>清醒时长${tipIcon('awake')}</th><th class="c-actual">学习时长${tipIcon('actual')}</th><th>不可用占比${tipIcon('util')}</th><th>评价</th>
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
                  <td class="fw-mono ${d.utilPct == null ? 'c-muted' : d.utilPct <= 30 ? 'c-green' : d.utilPct <= 50 ? 'c-wake' : 'c-red'}">${d.utilPct != null ? d.utilPct + '%' : '-'}</td>
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
  // ── 夜间作息趋势图：前一晚睡觉在下，次日起床在上 ──
  (function () {
    // 睡觉时间属于前一晚：18:00 后保持原值，凌晨时间顺延到 24:00 以后。
    const sleepHour = min => {
      const hour = min / 60;
      return hour < 18 ? hour + 24 : hour;
    };
    // 起床发生在次日，因此统一顺延 24 小时。
    const wakeHour = min => min / 60 + 24;
    const sleepData = sleepCycles.map(c => c.sleepMin == null ? null : sleepHour(c.sleepMin));
    const wakeData = sleepCycles.map(c => c.wakeMin == null ? null : wakeHour(c.wakeMin));
    const intervalData = sleepCycles.map((c, i) => {
      if (sleepData[i] == null || wakeData[i] == null || wakeData[i] < sleepData[i]) return null;
      return [sleepData[i], wakeData[i]];
    });
    const wakeColors = sleepCycles.map(c => c.wakeMin == null ? 'transparent' : c.wakeMin <= 7 * 60 ? '#69f0ae' : c.wakeMin <= 8 * 60 ? '#ffd54f' : '#f44336');
    const sleepColors = sleepCycles.map(c => {
      if (c.sleepMin == null) return 'transparent';
      const hour = sleepHour(c.sleepMin);
      return hour <= 24.01 ? '#69f0ae' : hour <= 24.5 ? '#ffd54f' : '#f44336';
    });
    const goalWakeData = sleepCycles.map(() => 31);
    const goalSleepData = sleepCycles.map(() => 24);
    const cycleLabels = sleepCycles.map(c => formatShort(c.wakeDate));

    // 默认展示 21:00 至次日 09:00；异常早睡或晚起数据会自动扩展范围，不会被裁掉。
    const allY = [...sleepData, ...wakeData].filter(v => v != null);
    const yMin = Math.floor((Math.min(21, ...allY) - 0.5) * 2) / 2;
    const yMax = Math.ceil((Math.max(33, ...allY) + 0.5) * 2) / 2;

    /** 将小时数转为 HH:MM 字符串（支持 >24h 自动 mod 24） */
    function hToTime(h) {
      const hh = ((Math.floor(h) % 24) + 24) % 24;
      const mm = Math.round((h - Math.floor(h)) * 60);
      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    mkChart('sleepTimelineChart', {
      type: 'line',
      data: {
        labels: cycleLabels,
        datasets: [
          {
            type: 'bar',
            label: '睡眠区间',
            data: intervalData,
            backgroundColor: 'rgba(179,136,255,.12)',
            borderColor: 'rgba(179,136,255,.28)',
            borderWidth: 1,
            borderSkipped: false,
            borderRadius: 5,
            barThickness: 12,
            order: 4
          },
          {
            label: '起床', data: wakeData,
            borderColor: '#ffd54f', backgroundColor: 'rgba(255,213,79,.08)',
            borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: wakeColors,
            tension: .3, fill: false, spanGaps: false, order: 1
          },
          {
            label: '睡觉', data: sleepData,
            borderColor: '#b388ff', backgroundColor: 'rgba(179,136,255,.08)',
            borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: sleepColors,
            tension: .3, fill: false, spanGaps: false, order: 1
          },
          {
            label: '目标起床7:00', data: goalWakeData,
            borderColor: 'rgba(105,240,174,.3)', borderDash: [5, 4],
            borderWidth: 1, pointRadius: 0, fill: false, order: 2
          },
          {
            label: '目标睡觉0:00', data: goalSleepData,
            borderColor: 'rgba(179,136,255,.3)', borderDash: [5, 4],
            borderWidth: 1, pointRadius: 0, fill: false, order: 2
          },
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#6b7a9e' } },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const cycle = sleepCycles[items[0].dataIndex];
                return cycle ? `${formatShort(cycle.sleepDate)} 夜 → ${formatShort(cycle.wakeDate)} 晨` : '';
              },
              label: (item) => {
                if (item.raw == null) return null;
                if (item.dataset.label === '睡眠区间' && Array.isArray(item.raw)) {
                  const duration = Math.round((item.raw[1] - item.raw[0]) * 60);
                  return `睡眠区间: ${hToTime(item.raw[0])} → ${hToTime(item.raw[1])}（${fmtMin(duration)}）`;
                }
                return `${item.dataset.label}: ${hToTime(Number(item.raw))}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#6b7a9e',
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 15
            },
            grid: gridCfg,
            title: { display: true, text: '起床日期', color: '#6b7a9e' }
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
        { type: 'line', label: '不可用占比%', data: sleepDays.map(d => d.utilPct ?? 0), borderColor: '#ffb74d', borderWidth: 2, pointRadius: 4, pointBackgroundColor: sleepDays.map(d => d.utilPct == null ? '#78909c' : d.utilPct <= 30 ? '#69f0ae' : d.utilPct <= 50 ? '#ffd54f' : '#f44336'), tension: .3, yAxisID: 'y1' },
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
  const wrapStartMin = arguments.length > 1 ? arguments[1] : null;
  const normalized = wrapStartMin == null
    ? minutes
    : minutes.map(value => value < wrapStartMin ? value + 1440 : value);
  const avg = Math.round(normalized.reduce((s, v) => s + v, 0) / normalized.length) % 1440;
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
          <div class="form-group"><label>开始日期</label>${editableDateInputHtml('printFrom', firstDate)}</div>
          <div class="form-group"><label>结束日期</label>${editableDateInputHtml('printTo', lastDate)}</div>
        </div>
        <button class="btn btn-primary" style="margin-top:4px" onclick="window.print()">🖨️ 打印/导出PDF</button>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">📄 导出 HTML 报告</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">生成独立 HTML 文件，内含完整图表，浏览器直接打开即可查看（无需后端）</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-group"><label>开始日期</label>${editableDateInputHtml('htmlFrom', firstDate)}</div>
          <div class="form-group"><label>结束日期</label>${editableDateInputHtml('htmlTo', lastDate)}</div>
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
      if (!Object.prototype.hasOwnProperty.call(imported, '__ordinalUnitList__')) {
        delete state.data.__ordinalUnitList__;
      }
      migrateForecastUnitModel();
      migrateTaskTemplateIds();
      state.forecastEditingId = null;
      state.workbookReviewId = null;
      state.workbookDraft = null;
      cacheToLocal();
      await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) });
      renderExport(); renderHeader();
      document.getElementById('exportStatus').textContent = `✅ 导入成功！合并了 ${Object.keys(imported).length} 天的数据`;
    } catch { alert('JSON 格式错误，请检查文件'); }
  };
  reader.readAsText(file);
}

async function clearRecordData() {
  if (confirm('确定清空所有已录入数据（时段、任务、作息记录）？\n模板库、活动分类、完成预测、整册复盘等将保留。\n此操作不可恢复！')) {
    const preserved = {};
    Object.keys(state.data).forEach(k => {
      if (k.startsWith('__')) preserved[k] = state.data[k];
    });
    state.data = preserved;
    cacheToLocal();
    await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) });
    clearAllLocalDrafts();
    await clearServerSnapshot(false);
    renderHeader(); renderSettings();
    const msg = document.getElementById('settings-danger-msg');
    if (msg) { msg.textContent = '🗑️ 已录入数据已清空（模板/分类已保留）'; msg.style.color = 'var(--pol)'; setTimeout(() => msg.textContent = '', 4000); }
  }
}

async function clearAllData() {
  if (confirm('确定清空所有数据（包括模板、分类等）？此操作不可恢复！')) {
    state.data = {};
    state.forecastEditingId = null;
    state.workbookReviewId = null;
    state.workbookDraft = null;
    cacheToLocal();
    await apiFetch('/api/data', { method: 'POST', body: JSON.stringify({}) });
    clearAllLocalDrafts();
    await clearServerSnapshot(false);
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
var TIPS={clock:'\u23F1 时钟时长',effectiveClock:'\u23F1 有效时钟=时钟\u2212休息',nominal:'\u{1F4CB} 名义=计划时长',actual:'\u2705 实际=真实专注',efficiency:'\u{1F3AF} 效率=实际/(时钟\u2212休息)',rest:'\u{1F634} 休息',distract:'\u{1F636} 分心=时钟\u2212实际\u2212休息',awake:'\u{1F324} 清醒=睡觉\u2212起床',util:'\u{1F4CA} 不可用时间占比=不可用时长/清醒时长，越低表示可支配时间越多',taskMin:'\u{1F4DD} 任务时长',cv:'\u{1F4CA} CV=\u03C3/\u03BC',stdDev:'\u{1F4CF} \u03C3',stackAwake:'\u{1F324} 清醒',stackTask:'\u{1F4DD} 任务',stackSpecial:'\u{1F538} 特殊',stackRest:'\u{1F634} 休息',stackDistract:'\u{1F636} 分心',stackIdle:'\u2B1C 空闲'};
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
var computeDayBase=computeDay;computeDay=function(ds){var result=computeDayBase(ds);result.utilPct=result.awakeMin!=null&&result.awakeMin>0?Math.round(result.unavailableMin/result.awakeMin*100):null;return result;};
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
document.getElementById('tab-daily').innerHTML='<div class="card"><div class="card-title" style="margin-bottom:8px">\u{1F4DD} \u4EFB\u52A1\u8BB0\u5F55 <span style="color:var(--muted);font-size:12px">'+aT.length+' \u6761 \xB7 '+fmtMin(tTt)+'</span></div>'+(aT.length===0?'<p style="color:var(--dim)">\u6682\u65E0</p>':'<div class="table-wrap"><table><thead><tr><th>\u65E5\u671F</th><th>\u540D\u79F0</th><th>\u7C7B\u578B</th><th>\u65F6\u957F</th><th>\u6570\u91CF</th><th>\u6548\u7387</th><th>\u6B63\u786E\u7387</th><th>\u5907\u6CE8</th></tr></thead><tbody>'+aT.map(function(t){var c=getActColor(t.activityType),q=visibleTaskQuantity(t),u=visibleTaskQuantityUnit(t),r=(q&&t.minutes)?(q/Number(t.minutes)).toFixed(2):null;return '<tr><td class="fw-mono">'+fmtShort(t._d)+'</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis">'+(t.name||'')+'</td><td><span class="badge" style="background:'+hexRgba(c,.13)+';color:'+c+';border:1px solid '+hexRgba(c,.27)+'">'+(t.activityType||'-')+'</span></td><td class="fw-mono">'+fmtMin(Number(t.minutes)||0,true)+'</td><td class="fw-mono">'+(q?q+(u?' '+u:''):'-')+'</td><td class="fw-mono">'+(r?r+(u?' '+u+'/min':'/min'):'-')+'</td><td class="fw-mono '+(t.accuracy>=80?'c-green':t.accuracy>=60?'c-wake':t.accuracy?'c-red':'')+'">'+(t.accuracy!=null&&t.accuracy!==''?t.accuracy+'%':'-')+'</td><td class="c-muted" style="font-size:11px">'+(t.note||'')+'</td></tr>';}).join('')+'</tbody></table></div>')+'</div>';


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
  dates.forEach(function(ds){(DATA[ds].tasks||[]).forEach(function(t){totC++;var mn=Number(t.minutes)||0,qt=visibleTaskQuantity(t),qu=visibleTaskQuantityUnit(t);totM+=mn;var cat=truncAct(t.activityType,lv);if(!cm[cat])cm[cat]={};if(!cm[cat][ds])cm[cat][ds]={mn:0,qt:0,ct:0,u:''};cm[cat][ds].mn+=mn;cm[cat][ds].qt+=qt;cm[cat][ds].ct++;if(qu)cm[cat][ds].u=qu;});});
  var cats=Object.keys(cm).sort(),dwT2=dates.filter(function(ds){return(DATA[ds].tasks||[]).length>0;}).length;
  var cL2,cDS2;
  if(cf&&cm[cf]){var fd2=dates.filter(function(ds){return cm[cf][ds];});cL2=fd2.map(fmtShort);var hx=lv===1?getActColor(cf):SP[cats.indexOf(cf)%SP.length];cDS2=[{label:cf,data:fd2.map(function(ds){return +(cm[cf][ds].mn/60).toFixed(2);}),borderColor:hx,borderWidth:2,pointRadius:4,tension:.3,fill:false}];
  }else{cL2=labels;cDS2=cats.map(function(cat,ci){var hx=lv===1?getActColor(cat):SP[ci%SP.length];return{label:cat,data:dates.map(function(ds){return +((cm[cat]&&cm[cat][ds]?cm[cat][ds].mn:0)/60).toFixed(2);}),borderColor:hx,borderWidth:2,pointRadius:dates.length>14?1:3,tension:.3,fill:false};});}
  var cs2=cats.map(function(cat){var ct=0,mn=0,qt=0,u='';Object.values(cm[cat]).forEach(function(v){ct+=v.ct;mn+=v.mn;qt+=v.qt;if(v.u)u=v.u;});var st=calcS(dates.map(function(ds){return cm[cat]&&cm[cat][ds]?cm[cat][ds].mn:0;}));return{cat:cat,ct:ct,mn:mn,qt:qt,u:u,avgMn:ct>0?Math.round(mn/ct):0,avgD:dwT2>0?Math.round(mn/dwT2):0,avgE:(qt&&mn)?+(qt/mn).toFixed(2):null,cv:st.cv};});
  var pieD=cats.map(function(c){return cs2.find(function(x){return x.cat===c;}).mn;}),pieC=cats.map(function(c){return hexRgba(lv===1?getActColor(c):SP[cats.indexOf(c)%SP.length],.75);});
  var dcnt=dates.map(function(ds){return(DATA[ds].tasks||[]).length;}),dmin=dates.map(function(ds){return +((DATA[ds].tasks||[]).reduce(function(s,t){return s+(Number(t.minutes)||0);},0)/60).toFixed(2);});
  var em={};dates.forEach(function(ds){(DATA[ds].tasks||[]).forEach(function(t){var qt=visibleTaskQuantity(t),qu=visibleTaskQuantityUnit(t),mn=Number(t.minutes)||0;if(!qt||!mn)return;var c3=truncAct(t.activityType,3);if(!em[c3])em[c3]={};if(!em[c3][ds])em[c3][ds]={qt:0,mn:0,u:''};em[c3][ds].qt+=qt;em[c3][ds].mn+=mn;if(qu)em[c3][ds].u=qu;});});
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

  document.getElementById('tab-settings').innerHTML = `
    <div style="max-width:900px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">⚙️ 全局设置</div>
        <p style="font-size:12px;color:var(--muted);margin:0">界面偏好保存在当前浏览器；启用后端快照后，当前页面和未提交内容可跨浏览器恢复。</p>
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
          <div class="form-group"><label>不可用占比警戒线(%)</label><input type="number" id="set_utilPassPct" value="${s.utilPassPct}" min="0" max="100"></div>
          <div class="form-group"><label>专注效率-优秀(%)</label><input type="number" id="set_focusGoodPct" value="${s.focusGoodPct}" min="0" max="100"></div>
          <div class="form-group"><label>专注效率-及格(%)</label><input type="number" id="set_focusOkPct" value="${s.focusOkPct}" min="0" max="100"></div>
          <div class="form-group"><label>周起始日</label><select id="set_weekStartDay"><option value="1" ${s.weekStartDay === 1 ? 'selected' : ''}>周一</option><option value="0" ${s.weekStartDay === 0 ? 'selected' : ''}>周日</option></select></div>
        </div>
      </div>

      <!-- 3. 数据存储 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">💾 数据存储</div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-group"><label>后端快照保存模式</label>
            <select id="set_snapshotInterval">
              <option value="0" ${Number(s.snapshotInterval) === 0 ? 'selected' : ''}>关闭</option>
              <option value="30000" ${Number(s.snapshotInterval) === 30000 ? 'selected' : ''}>每30秒</option>
              <option value="60000" ${Number(s.snapshotInterval) === 60000 ? 'selected' : ''}>每1分钟</option>
            </select>
          </div>
          <div class="form-group"><label>localStorage 缓存</label><select id="set_useLocalStorageCache"><option value="true" ${s.useLocalStorageCache ? 'selected' : ''}>开启</option><option value="false" ${!s.useLocalStorageCache ? 'selected' : ''}>关闭</option></select></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-primary btn-sm" onclick="saveServerSnapshot(true)">立即保存快照</button>
          <button class="btn btn-ghost btn-sm" onclick="clearServerSnapshot(true)">清除后端快照</button>
          <span id="snapshot-status" class="form-hint">${state._serverSnapshot?.updatedAt ? `最后快照：${new Date(state._serverSnapshot.updatedAt).toLocaleString()}` : '后端暂无快照'}</span>
        </div>
        <div class="form-hint">本地草稿仍每3秒保存作为断网兜底；共享快照独立存放在后端 <code>draft_snapshot.json</code>，不会覆盖学习数据。</div>
      </div>

      <!-- 5. 评分与评价规则 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">📊 评分与评价规则</div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:10px">月览表格中每天评分 = 满足以下条件的数量：</p>
        <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
          <div class="form-group"><label>条件1: 实际专注≥(分钟)</label><input type="number" id="set_ratingActualMin" value="${s.ratingActualMin}" min="0"></div>
          <div class="form-group"><label>条件2: 偏差率≥(%)</label><input type="number" id="set_ratingDeviationPct" value="${s.ratingDeviationPct}"></div>
          <div class="form-group"><label>条件3: 起床≤(分钟,480=8:00)</label><input type="number" id="set_ratingWakeLimit" value="${s.ratingWakeLimit}" min="0"></div>
          <div class="form-group"><label>条件4: 不可用占比≤(%)</label><input type="number" id="set_ratingUtilPct" value="${s.ratingUtilPct}" min="0" max="100"></div>
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
          <span style="font-size:11px;color:var(--muted)">仅清除日历中的时段/任务/作息记录，保留模板库、分类等</span>
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

async function settingsSaveAll() {
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
  s.snapshotInterval = Number(document.getElementById('set_snapshotInterval')?.value);
  if (![0, 30000, 60000].includes(s.snapshotInterval)) s.snapshotInterval = 30000;
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

  SETTINGS = s;
  saveSettings(s);

  const msg = document.getElementById('settings-msg');
  if (msg) {
    msg.textContent = '✅ 设置已保存';
    msg.style.color = 'var(--pol)';
    setTimeout(() => msg.textContent = '', 5000);
  }
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
      const qty = visibleTaskQuantity(t);
      const qtyUnit = visibleTaskQuantityUnit(t);
      totalMin += min; totalQty += qty;
      const cat = truncateActPath(t.activityType, level);
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][ds]) catMap[cat][ds] = { min: 0, qty: 0, count: 0, qtyUnit: '', wrong: 0, errorQty: 0, errorTaskCount: 0 };
      catMap[cat][ds].min += min;
      catMap[cat][ds].qty += qty;
      catMap[cat][ds].count++;
      if (qtyUnit) catMap[cat][ds].qtyUnit = qtyUnit;
      const wrong = Number(t.wrongCount);
      const hasExplicitWrong = t.wrongCount != null && t.wrongCount !== '' &&
        Number.isFinite(wrong) && wrong >= 0 && qty > 0 && wrong <= qty;
      if (hasExplicitWrong) {
        catMap[cat][ds].wrong += wrong;
        catMap[cat][ds].errorQty += qty;
        catMap[cat][ds].errorTaskCount++;
      }
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
    let count = 0, min = 0, qty = 0, qtyUnit = '', wrong = 0, errorQty = 0, errorTaskCount = 0;
    Object.values(catMap[cat]).forEach(v => {
      count += v.count;
      min += v.min;
      qty += v.qty;
      wrong += v.wrong || 0;
      errorQty += v.errorQty || 0;
      errorTaskCount += v.errorTaskCount || 0;
      if (v.qtyUnit) qtyUnit = v.qtyUnit;
    });
    const avgPerDay = daysWithTasks > 0 ? Math.round(min / daysWithTasks) : 0;
    const avgEff = (qty && min) ? +(qty / min).toFixed(2) : null;
    const errorRate = errorQty > 0 ? wrong / errorQty * 100 : null;
    const dailyVals = dateStrs.map(ds => catMap[cat][ds]?.min || 0);
    const stats = calcStats(dailyVals);
    return { cat, count, min, qty, qtyUnit, wrong, errorQty, errorTaskCount, errorRate, avgMin: count > 0 ? Math.round(min / count) : 0, avgPerDay, avgEff, cv: stats.cv, stdDev: stats.stdDev };
  });
  // 章节效率：横轴按模板章节顺序；周/月只筛选首次完成日，累计值包含此前跨天投入。
  const analysisDateSet = new Set(dateStrs);
  const chapterTemplates = getTaskTemplates()
    .filter(template => Boolean(template.namedItemEnabled ?? template.ordinalEnabled))
    .sort((a, b) => forecastTemplateLabel(a).localeCompare(forecastTemplateLabel(b)));
  const chapterTemplateData = new Map();
  chapterTemplates.forEach(template => {
    const orderedItems = [...(template.namedItems || [])]
      .filter(item => item.id && String(item.name || '').trim())
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map((item, index) => ({
        id: item.id,
        name: String(item.name || '').trim(),
        order: index,
        archived: Boolean(item.archived),
      }));
    chapterTemplateData.set(template.id, {
      template,
      items: orderedItems,
      byId: new Map(orderedItems.map(item => [item.id, item])),
      byName: new Map(orderedItems.map(item => [item.name.toLocaleLowerCase(), item])),
      progress: new Map(orderedItems.map(item => [item.id, {
        item,
        minutes: 0,
        quantity: 0,
        completed: false,
        completionDate: '',
      }])),
    });
  });
  getForecastTaskEntries()
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(({ date, task }) => {
      const templateId = resolveTaskTemplateId(task);
      const templateData = chapterTemplateData.get(templateId);
      if (!templateData) return;
      taskNamedItemAllocations(task).forEach(allocation => {
        const normalizedName = String(allocation.itemName || '').trim().toLocaleLowerCase();
        let item = templateData.byId.get(allocation.itemId) || templateData.byName.get(normalizedName);
        if (!item) {
          item = {
            id: allocation.itemId || `historical-${templateId}-${normalizedName}`,
            name: allocation.itemName || '历史章节',
            order: templateData.items.length,
            archived: true,
          };
          templateData.items.push(item);
          templateData.byId.set(item.id, item);
          if (normalizedName) templateData.byName.set(normalizedName, item);
          templateData.progress.set(item.id, {
            item,
            minutes: 0,
            quantity: 0,
            completed: false,
            completionDate: '',
          });
        }
        const progress = templateData.progress.get(item.id);
        if (progress.completed) return;
        progress.minutes += Math.max(0, Number(allocation.minutes) || 0);
        progress.quantity += Math.max(0, Number(allocation.quantity) || 0);
        if (allocation.completed) {
          progress.completed = true;
          progress.completionDate = date;
        }
      });
    });

  const chapterTemplateStats = chapterTemplates.map(template => {
    const templateData = chapterTemplateData.get(template.id);
    const items = [...templateData.progress.values()]
      .filter(progress => progress.completed && analysisDateSet.has(progress.completionDate))
      .sort((a, b) => a.item.order - b.item.order);
    const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
    const quantityItems = template.quantityEnabled
      ? items.filter(item => item.minutes > 0 && item.quantity > 0)
      : [];
    const quantityMinutes = quantityItems.reduce((sum, item) => sum + item.minutes, 0);
    const totalQuantity = quantityItems.reduce((sum, item) => sum + item.quantity, 0);
    const stats = calcStats(items.map(item => item.minutes));
    return {
      template,
      id: template.id,
      label: forecastTemplateLabel(template),
      items,
      totalMinutes,
      totalQuantity,
      completedChapters: items.length,
      avgMinutes: items.length ? totalMinutes / items.length : null,
      questionSpeed: quantityMinutes > 0 ? totalQuantity / quantityMinutes : null,
      cv: stats.cv,
      n: stats.n,
    };
  });
  const chapterModeCats = new Set(chapterTemplates.map(template => truncateActPath(template.activityType, 3)));
  const firstChapterTemplateWithData = chapterTemplateStats.find(item => item.items.length) || chapterTemplateStats[0] || null;
  if (!chapterTemplateStats.some(item => item.id === s.chapterEffTemplateId)) {
    s.chapterEffTemplateId = firstChapterTemplateWithData?.id || '';
  }
  const selectedChapterTemplateStats = chapterTemplateStats.find(item => item.id === s.chapterEffTemplateId) ||
    firstChapterTemplateWithData;
  const selectedChapterItems = selectedChapterTemplateStats?.items || [];
  const chapterChartLabels = selectedChapterItems.map(item =>
    `${item.item.name}${item.item.archived ? '（已归档）' : ''}`
  );
  const chapterEffCatStats = [...chapterModeCats].map(cat => {
    const related = chapterTemplateStats.filter(item => truncateActPath(item.template.activityType, 3) === cat);
    const items = related.flatMap(item => item.items);
    const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
    const quantityItems = related.flatMap(item =>
      item.template.quantityEnabled ? item.items.filter(chapter => chapter.minutes > 0 && chapter.quantity > 0) : []
    );
    const quantityMinutes = quantityItems.reduce((sum, item) => sum + item.minutes, 0);
    const totalQuantity = quantityItems.reduce((sum, item) => sum + item.quantity, 0);
    const stats = calcStats(items.map(item => item.minutes));
    const unit = related.find(item => item.template.quantityEnabled)?.template.quantityUnit || '';
    return {
      cat,
      avgEff: items.length ? totalMinutes / items.length : null,
      questionSpeed: quantityMinutes > 0 ? totalQuantity / quantityMinutes : null,
      unit,
      chapters: items.length,
      cv: stats.cv,
      n: stats.n,
    };
  });

  // 纯数量效率趋势；开启章节的模板优先使用上面的“分钟/章”口径。
  const effCatMap = {};
  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.tasks || []).forEach(t => {
      const template = getTaskTemplateForTask(t);
      const namedEnabled = template
        ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
        : taskNamedItemAllocations(t).length > 0;
      if (namedEnabled) return;
      const qty = visibleTaskQuantity(t);
      const qtyUnit = visibleTaskQuantityUnit(t);
      const min = Number(t.minutes) || 0;
      if (!qty || !min) return;
      const cat3 = truncateActPath(t.activityType, 3);
      if (!effCatMap[cat3]) effCatMap[cat3] = {};
      if (!effCatMap[cat3][ds]) effCatMap[cat3][ds] = { qty: 0, min: 0, qtyUnit: '' };
      effCatMap[cat3][ds].qty += qty;
      effCatMap[cat3][ds].min += min;
      if (qtyUnit) effCatMap[cat3][ds].qtyUnit = qtyUnit;
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
      ${chapterTemplateStats.length > 0 ? `
      <div class="chart-card full">
        <div class="chart-title">按章节分析</div>
        <div class="chart-sub">周/月范围按首次完成日期筛选；每章数值包含完成前全部跨天投入</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px">
          <span style="font-size:11px;color:var(--muted)">章节模板：</span>
          <select onchange="taskAnaNav('chapterEffTemplateId',this.value)" style="min-width:220px;font-size:12px;padding:4px 8px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px">
            ${chapterTemplateStats.map(item => `<option value="${escHtmlApp(item.id)}" ${selectedChapterTemplateStats?.id === item.id ? 'selected' : ''}>${escHtmlApp(item.label)}（完成 ${item.completedChapters} 章）</option>`).join('')}
          </select>
        </div>
        ${selectedChapterTemplateStats ? `<div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;font-size:12px">
          <span style="color:var(--muted)">平均完成耗时：<b style="color:var(--text)">${selectedChapterTemplateStats.avgMinutes == null ? '-' : `${forecastDisplayMetric(selectedChapterTemplateStats.avgMinutes)} 分钟/章`}</b></span>
          ${selectedChapterTemplateStats.template.quantityEnabled ? `<span style="color:var(--muted)">平均题目效率：<b style="color:var(--text)">${selectedChapterTemplateStats.questionSpeed == null ? '-' : `${selectedChapterTemplateStats.questionSpeed.toFixed(3)} ${escHtmlApp(selectedChapterTemplateStats.template.quantityUnit || '题')}/分钟`}</b></span>` : ''}
          <span style="color:var(--muted)">已完成：<b style="color:var(--text)">${selectedChapterTemplateStats.completedChapters} 章</b></span>
          <span style="color:var(--muted)">耗时CV${tipIcon('cv')}：<b style="color:${selectedChapterTemplateStats.cv != null && selectedChapterTemplateStats.cv < 0.3 ? 'var(--green)' : 'var(--wake)'}">${fmtCV(selectedChapterTemplateStats.cv)}</b></span>
        </div>` : ''}
      </div>
      <div class="chart-card full">
        <div class="chart-title">每章完成耗时</div>
        <div class="chart-sub">柱状图 · 横轴=章节 · 纵轴=完成该章累计分钟</div>
        ${selectedChapterItems.length ? `<div style="overflow-x:auto"><div style="min-width:${Math.max(720, selectedChapterItems.length * 90)}px"><canvas id="taskAnaChapterMinutesChart" height="${s.mode === 'week' ? '100' : '120'}"></canvas></div></div>` : '<div class="empty-state"><p>当前范围没有已完成章节。</p></div>'}
      </div>
      ${selectedChapterTemplateStats?.template.quantityEnabled ? `<div class="chart-card full">
        <div class="chart-title">每章题目效率</div>
        <div class="chart-sub">折线图 · 横轴=章节 · 纵轴=${escHtmlApp(selectedChapterTemplateStats.template.quantityUnit || '题')}/分钟</div>
        ${selectedChapterItems.length ? `<div style="overflow-x:auto"><div style="min-width:${Math.max(720, selectedChapterItems.length * 90)}px"><canvas id="taskAnaChapterQuantityEffChart" height="${s.mode === 'week' ? '100' : '120'}"></canvas></div></div>` : '<div class="empty-state"><p>当前范围没有已完成章节。</p></div>'}
      </div>` : ''}` : ''}
      ${effCats.length > 0 ? `<div class="chart-card full">
        <div class="chart-title">纯数量效率趋势（按三级分类）${effCatFilter ? ' — ' + escHtmlApp(effCatFilter) : ''}</div>
        <div class="chart-sub">仅统计未开启章节的模板 · 效率 = 数量 ÷ 时长(分钟)${effCatFilter ? ' · 仅显示有数据的天' : ''}</div>
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
            <thead><tr><th>类别</th><th>任务数</th><th>总时长</th><th>每条平均</th><th>日均</th>${level === 3 ? '<th>总数量</th><th>综合错误率</th><th>平均效率</th><th>效率CV' + tipIcon('cv') + '</th>' : ''}</tr></thead>
            <tbody>${catStats.map(c => {
    const hex = level === 1 ? (getActColor(c.cat).color || '#78909c') : '#78909c';
    const ecs = level === 3 ? effCatStats.find(e => e.cat === c.cat) : null;
    const chapterEcs = level === 3 ? chapterEffCatStats.find(e => e.cat === c.cat) : null;
    const usesChapterEfficiency = level === 3 && chapterModeCats.has(c.cat);
    const displayedEfficiencyStats = usesChapterEfficiency ? chapterEcs : ecs;
    return `<tr>
              <td><span class="badge" style="background:${hexRgba(hex, 0.13)};color:${hex};border:1px solid ${hexRgba(hex, 0.3)}">${escHtmlApp(c.cat)}</span></td>
              <td class="fw-mono">${c.count}</td>
              <td class="fw-mono c-actual">${fmtMin(c.min, true)}</td>
              <td class="fw-mono">${fmtMin(c.avgMin)}</td>
              <td class="fw-mono" style="color:var(--muted)">${fmtMin(c.avgPerDay)}</td>
              ${level === 3 ? `<td class="fw-mono">${c.qty ? c.qty + (c.qtyUnit ? ' ' + c.qtyUnit : '') : '-'}</td>
              <td class="fw-mono ${c.errorRate == null ? 'c-muted' : c.errorRate <= 10 ? 'c-green' : c.errorRate <= 30 ? 'c-wake' : 'c-red'}" title="${c.errorRate == null ? '没有明确填写错题数的任务' : `错 ${forecastDisplayMetric(c.wrong)} / ${forecastDisplayMetric(c.errorQty)} · ${c.errorTaskCount} 条有效任务`}">${c.errorRate == null ? '-' : `${c.errorRate.toFixed(2)}%`}</td>
              <td class="fw-mono">${usesChapterEfficiency
                ? chapterEcs?.avgEff != null
                  ? `${forecastDisplayMetric(chapterEcs.avgEff)} 分钟/章${chapterEcs.questionSpeed != null ? `<br><span class="c-muted">${chapterEcs.questionSpeed.toFixed(3)} ${escHtmlApp(chapterEcs.unit || '题')}/分钟</span>` : ''}`
                  : '-'
                : c.avgEff != null ? c.avgEff + (c.qtyUnit ? ' ' + c.qtyUnit + '/min' : '/min') : '-'}</td>
              <td class="fw-mono" style="color:${displayedEfficiencyStats && displayedEfficiencyStats.cv != null && displayedEfficiencyStats.cv < 0.3 ? 'var(--green)' : displayedEfficiencyStats && displayedEfficiencyStats.cv != null && displayedEfficiencyStats.cv < 0.5 ? 'var(--wake)' : displayedEfficiencyStats && displayedEfficiencyStats.cv != null ? 'var(--red)' : 'var(--muted)'}">${displayedEfficiencyStats ? fmtCV(displayedEfficiencyStats.cv) : '-'}</td>` : ''}
            </tr>`;
  }).join('')}</tbody>
            <tfoot><tr><td>合计</td><td class="fw-mono">${totalCount}</td><td class="fw-mono c-actual">${fmtMin(totalMin, true)}</td><td class="fw-mono">${totalCount > 0 ? fmtMin(Math.round(totalMin / totalCount)) : '-'}</td><td class="fw-mono" style="color:var(--muted)">${fmtMin(avgMinPerDay)}</td>${level === 3 ? '<td colspan="4"></td>' : ''}</tr></tfoot>
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

  // 按章节完成耗时柱状图
  if (selectedChapterItems.length > 0) {
    mkChart('taskAnaChapterMinutesChart', {
      type: 'bar',
      data: {
        labels: chapterChartLabels,
        datasets: [{
          label: '完成耗时（分钟）',
          data: selectedChapterItems.map(item => +item.minutes.toFixed(1)),
          backgroundColor: selectedChapterItems.map(item => item.item.archived ? 'rgba(158,158,158,.45)' : 'rgba(79,195,247,.45)'),
          borderColor: selectedChapterItems.map(item => item.item.archived ? '#9e9e9e' : '#4fc3f7'),
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const item = selectedChapterItems[ctx.dataIndex];
                return `累计耗时：${forecastDisplayMetric(item.minutes)} 分钟`;
              },
              afterLabel: ctx => {
                const item = selectedChapterItems[ctx.dataIndex];
                const lines = [`首次完成：${item.completionDate}`];
                if (item.quantity > 0) {
                  lines.push(`累计数量：${forecastDisplayMetric(item.quantity)} ${selectedChapterTemplateStats?.template.quantityUnit || '题'}`);
                }
                return lines;
              },
            }
          }
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', maxRotation: 45, minRotation: 0, autoSkip: false }, grid: gridCfg },
          y: {
            ticks: { color: '#6b7a9e', callback: value => `${value}分` },
            grid: gridCfg,
            min: 0,
            title: { display: true, text: '完成耗时（分钟）', color: '#6b7a9e' }
          }
        }
      }
    });
  }

  // 章节＋数量模板：按章节题目效率折线图
  if (selectedChapterItems.length > 0 && selectedChapterTemplateStats?.template.quantityEnabled) {
    mkChart('taskAnaChapterQuantityEffChart', {
      type: 'line',
      data: {
        labels: chapterChartLabels,
        datasets: [{
          label: `${selectedChapterTemplateStats.template.quantityUnit || '题'}/分钟`,
          data: selectedChapterItems.map(item =>
            item.minutes > 0 && item.quantity > 0 ? +(item.quantity / item.minutes).toFixed(3) : null
          ),
          borderColor: '#69f0ae',
          backgroundColor: '#69f0ae',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#69f0ae',
          tension: 0.25,
          fill: false,
          spanGaps: false,
        }]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const item = selectedChapterItems[ctx.dataIndex];
                return ctx.parsed.y == null
                  ? '题目效率：数据不足'
                  : `题目效率：${ctx.parsed.y.toFixed(3)} ${selectedChapterTemplateStats.template.quantityUnit || '题'}/分钟`;
              },
              afterLabel: ctx => {
                const item = selectedChapterItems[ctx.dataIndex];
                return [
                  `累计数量：${forecastDisplayMetric(item.quantity)} ${selectedChapterTemplateStats.template.quantityUnit || '题'}`,
                  `累计耗时：${forecastDisplayMetric(item.minutes)} 分钟`,
                  `首次完成：${item.completionDate}`,
                ];
              },
            }
          }
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', maxRotation: 45, minRotation: 0, autoSkip: false }, grid: gridCfg },
          y: {
            ticks: { color: '#6b7a9e' },
            grid: gridCfg,
            min: 0,
            title: { display: true, text: `${selectedChapterTemplateStats.template.quantityUnit || '题'}/分钟`, color: '#6b7a9e' }
          }
        }
      }
    });
  }

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
  else if (action === 'chapterEffTemplateId') { s.chapterEffTemplateId = val; }
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
// COMPLETION FORECAST TAB
// ============================================================
function getForecastGoals() {
  if (!Array.isArray(state.data.__forecastGoals__)) state.data.__forecastGoals__ = [];
  return state.data.__forecastGoals__;
}

function getForecastSettings() {
  if (!state.data.__forecastSettings__ || typeof state.data.__forecastSettings__ !== 'object') {
    state.data.__forecastSettings__ = {};
  }
  const settings = state.data.__forecastSettings__;
  const legacyDailyMinutes = Number(settings.dailyMinutes);
  if ((!Number.isFinite(Number(settings.manualDailyMinutes)) || Number(settings.manualDailyMinutes) <= 0) &&
    Number.isFinite(legacyDailyMinutes) && legacyDailyMinutes > 0) {
    settings.manualDailyMinutes = Math.round(legacyDailyMinutes);
  }
  delete settings.dailyMinutes;
  const dates = getAllDates();
  const fallbackStart = dates[0] || getTodayStr();
  const fallbackEnd = dates[dates.length - 1] || getTodayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.capacityStartDate || '')) {
    settings.capacityStartDate = fallbackStart;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.capacityEndDate || '')) {
    settings.capacityEndDate = fallbackEnd;
  }
  settings.capacityTrackLatest = settings.capacityTrackLatest === true;
  settings.capacityMode = settings.capacityMode === 'manual' ? 'manual' : 'range';
  settings.manualDailyMinutes = Number.isFinite(Number(settings.manualDailyMinutes))
    ? Math.max(0, Math.round(Number(settings.manualDailyMinutes)))
    : 0;
  return settings;
}

function forecastTemplateLabel(template) {
  return String(template?.activityType || '未分类模板');
}

function resolveTaskTemplateId(task) {
  if (task?.templateId && getTaskTemplates().some(template => template.id === task.templateId)) {
    return task.templateId;
  }
  const matches = getTaskTemplates().filter(template =>
    template.activityType && template.activityType === task?.activityType
  );
  return matches.length === 1 ? matches[0].id : '';
}

function taskOrdinalNumbers(task) {
  const values = Array.isArray(task?.ordinalNumbers)
    ? task.ordinalNumbers
    : Array.isArray(task?.chapterNumbers)
      ? task.chapterNumbers
      : (Number.isInteger(Number(task?.chapterNumber)) ? [Number(task.chapterNumber)] : []);
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function taskCompletedOrdinals(task) {
  const values = Array.isArray(task?.completedOrdinals)
    ? task.completedOrdinals
    : Array.isArray(task?.completedChapters)
      ? task.completedChapters
      : (task?.chapterCompleted && Number.isInteger(Number(task?.chapterNumber)) ? [Number(task.chapterNumber)] : []);
  const involved = new Set(taskOrdinalNumbers(task));
  return [...new Set(values.map(Number).filter(value => Number.isInteger(value) && involved.has(value)))].sort((a, b) => a - b);
}

function taskOrdinalBadgeHtml(task) {
  if (!taskOrdinalIsVisible(task)) return '';
  const namedAllocations = taskNamedItemAllocations(task);
  if (namedAllocations.length) {
    const template = getTaskTemplateById(resolveTaskTemplateId(task));
    const itemMap = new Map((template?.namedItems || []).map(item => [item.id, item.name]));
    return ` <span class="forecast-chapter-badge">${namedAllocations.map(item => {
      const label = itemMap.get(item.itemId) || item.itemName;
      return `${escHtmlApp(label)}${item.completed ? ' ✓' : ''}`;
    }).join('、')}</span>`;
  }
  const values = taskOrdinalNumbers(task);
  if (!values.length) return '';
  const template = getTaskTemplates().find(item => item.id === resolveTaskTemplateId(task));
  const unit = template?.ordinalUnit || '';
  const completed = taskCompletedOrdinals(task);
  return ` <span class="forecast-chapter-badge">${values.map(value => `第${value}${escHtmlApp(unit)}`).join('、')}${completed.length ? ` · 完成${completed.map(value => `第${value}${escHtmlApp(unit)}`).join('、')}` : ''}</span>`;
}

function forecastModeFromTemplate(template) {
  const namedItemEnabled = template?.namedItemEnabled ?? template?.ordinalEnabled;
  if (namedItemEnabled) return template.quantityEnabled ? 'chapterQuantity' : 'chapter';
  if (template?.quantityEnabled) return 'quantity';
  return '';
}

function migrateForecastUnitModel() {
  getTaskTemplates().forEach(template => {
    const oldMode = template.forecastMode || '';
    if (typeof template.ordinalEnabled !== 'boolean') {
      template.ordinalEnabled = oldMode === 'chapter' || oldMode === 'chapterQuantity';
    }
    if (typeof template.quantityEnabled !== 'boolean') {
      template.quantityEnabled = oldMode === 'quantity' || oldMode === 'chapterQuantity' ||
        (!oldMode && Boolean(template.quantityUnit));
    }
    if (typeof template.namedItemEnabled !== 'boolean') {
      template.namedItemEnabled = Boolean(template.ordinalEnabled);
    }
    if (!Array.isArray(template.namedItems)) template.namedItems = [];
    if (!template.ordinalUnit) template.ordinalUnit = template.ordinalEnabled ? '章' : '';
    delete template.name;
    delete template.forecastMode;
  });
  getOrdinalUnitList();
  getForecastGoals().forEach(goal => {
    if (goal.startOrdinal == null && goal.startChapter != null) goal.startOrdinal = goal.startChapter;
    if (goal.endOrdinal == null && goal.endChapter != null) goal.endOrdinal = goal.endChapter;
    const template = getTaskTemplates().find(item => item.id === goal.templateId);
    const namedItemEnabled = template?.namedItemEnabled ?? template?.ordinalEnabled;
    if (namedItemEnabled && template) {
      const start = Number(goal.startOrdinal);
      const end = Number(goal.endOrdinal);
      const unit = template?.ordinalUnit || '项';
      const legacyItems = Array.isArray(goal.namedItems)
        ? goal.namedItems
        : Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start
        ? Array.from({ length: end - start + 1 }, (_, index) => {
          const value = start + index;
          return {
            id: `legacy-${value}`,
            name: `第${value}${unit}`,
            order: index,
            archived: false,
          };
        })
        : [];
      const merged = [...template.namedItems];
      const knownIds = new Set(merged.map(item => String(item.id)));
      const knownNames = new Set(merged.map(item => String(item.name || '').trim().toLocaleLowerCase()));
      legacyItems.forEach(item => {
        const id = String(item?.id || uid());
        const name = String(item?.name || '').trim();
        const normalizedName = name.toLocaleLowerCase();
        if (!name || knownIds.has(id) || knownNames.has(normalizedName)) return;
        merged.push({ id, name, order: merged.length, archived: Boolean(item?.archived) });
        knownIds.add(id);
        knownNames.add(normalizedName);
      });
      template.namedItems = merged.map((item, index) => ({ ...item, order: index }));
    }
    delete goal.namedItems;
    delete goal.startChapter;
    delete goal.endChapter;
    delete goal.startOrdinal;
    delete goal.endOrdinal;
    delete goal.mode;
    delete goal.quantityUnit;
  });
}

function migrateTaskTemplateIds() {
  Object.entries(state.data).forEach(([key, day]) => {
    if (key.startsWith('__') || !day || !Array.isArray(day.tasks)) return;
    day.tasks.forEach(task => {
      if (!task.templateId) {
        const templateId = resolveTaskTemplateId(task);
        if (templateId) task.templateId = templateId;
      }
      const legacyOrdinals = taskOrdinalNumbers(task);
      const legacyCompleted = new Set(taskCompletedOrdinals(task));
      const template = getTaskTemplateById(task.templateId);
      if ((!Array.isArray(task.namedItemAllocations) || !task.namedItemAllocations.length) &&
        legacyOrdinals.length && template) {
        if (!Array.isArray(template.namedItems)) template.namedItems = [];
        const minuteShare = Number(task.minutes) > 0 ? Number(task.minutes) / legacyOrdinals.length : 0;
        const validQuantity = Number(task.quantity) > 0;
        const quantityShare = validQuantity ? Number(task.quantity) / legacyOrdinals.length : null;
        task.namedItemAllocations = legacyOrdinals.map(value => {
          const legacyName = `第${value}${template.ordinalUnit || '项'}`;
          let item = template.namedItems.find(candidate =>
            candidate.id === `legacy-${value}` ||
            String(candidate.name || '').trim().toLocaleLowerCase() === legacyName.toLocaleLowerCase()
          );
          if (!item) {
            item = {
              id: `legacy-${template.id}-${value}`,
              name: legacyName,
              order: template.namedItems.length,
              archived: false,
            };
            template.namedItems.push(item);
          }
          return {
            itemId: item.id,
            itemName: item.name,
            minutes: minuteShare,
            quantity: quantityShare,
            completed: legacyCompleted.has(value),
          };
        });
      }
      if (!Array.isArray(task.namedItemAllocations)) task.namedItemAllocations = [];
      if (!legacyOrdinals.length || task.namedItemAllocations.length) {
        delete task.ordinalNumbers;
        delete task.completedOrdinals;
        delete task.chapterNumbers;
        delete task.completedChapters;
        delete task.chapterNumber;
        delete task.chapterCompleted;
      }
    });
  });
}

function getForecastTaskEntries() {
  const entries = [];
  Object.entries(state.data).forEach(([date, day]) => {
    if (date.startsWith('__') || !day || !Array.isArray(day.tasks)) return;
    day.tasks.forEach(task => entries.push({ date, task }));
  });
  return entries;
}

function getForecastGoalByTemplate(templateId) {
  const goal = getForecastGoals().find(item => item.templateId === templateId);
  return goal ? forecastGoalContext(goal) : null;
}

function forecastGoalContext(goal) {
  const template = getTaskTemplates().find(item => item.id === goal?.templateId);
  return {
    ...goal,
    mode: forecastModeFromTemplate(template),
    namedItems: Array.isArray(template?.namedItems) ? template.namedItems : [],
    ordinalUnit: template?.ordinalUnit || '',
    quantityUnit: template?.quantityUnit || '',
  };
}

function taskOrdinalCardHtml(value, unit, completed) {
  return `<div class="forecast-chapter-chip task-ordinal-card" data-ordinal="${value}" style="display:flex;align-items:center;gap:8px">
    <input type="checkbox" class="task-chapter-involved" value="${value}" checked hidden>
    <b>第${value}${escHtmlApp(unit)}</b>
    <label style="display:flex;align-items:center;gap:4px;font-weight:400">
      <input type="checkbox" class="task-chapter-completed" value="${value}" ${completed ? 'checked' : ''}> 本次完成
    </label>
    <button type="button" class="btn btn-ghost btn-sm" onclick="taskOrdinalRemove(${value})" title="移除">×</button>
  </div>`;
}

function taskOrdinalCardsHtml(values, unit) {
  const involved = taskOrdinalNumbers(values);
  const completed = new Set(taskCompletedOrdinals(values));
  return involved.map(value => taskOrdinalCardHtml(value, unit, completed.has(value))).join('');
}

function taskNamedItemAllocations(task) {
  return Array.isArray(task?.namedItemAllocations)
    ? task.namedItemAllocations.map(item => ({
      itemId: String(item?.itemId || ''),
      itemName: String(item?.itemName || '').trim(),
      minutes: Number(item?.minutes) || 0,
      quantity: item?.quantity == null ? null : Number(item.quantity),
      completed: Boolean(item?.completed),
      isNew: Boolean(item?.isNew),
    })).filter(item => (item.itemId || item.itemName) && item.itemName)
    : [];
}

function taskNamedItemCardHtml(allocation, quantityEnabled) {
  const completed = Boolean(allocation.completed);
  return `<div class="task-named-item-card" data-item-id="${escHtmlApp(allocation.itemId)}"
    data-item-name="${escHtmlApp(allocation.itemName)}" data-new="${allocation.isNew ? 'true' : 'false'}"
    data-completed="${completed ? 'true' : 'false'}" role="button" tabindex="0"
    onclick="taskToggleNamedItemCompleted(event,this)"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();taskToggleNamedItemCompleted(event,this)}"
    style="display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:10px;align-items:center;padding:10px;border:1px solid ${completed ? 'rgba(102,187,106,.65)' : 'var(--border)'};border-radius:7px;background:${completed ? 'rgba(102,187,106,.10)' : 'rgba(255,255,255,.015)'};cursor:pointer">
    <div>
      <div class="form-hint">章节</div>
      <b>${escHtmlApp(allocation.itemName)}</b>
      ${allocation.isNew ? '<span class="c-wake" style="font-size:10px;margin-left:5px">保存任务后入库</span>' : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="task-named-completed-status" style="font-size:11px;color:${completed ? '#66bb6a' : 'var(--muted)'}">${completed ? '✓ 本次完成' : '进行中'}</span>
      <input type="checkbox" class="task-named-completed" ${completed ? 'checked' : ''} hidden>
      <button type="button" class="btn btn-danger btn-sm" onclick="event.stopPropagation();taskNamedItemRemove('${allocation.itemId}')">移除</button>
    </div>
  </div>`;
}

function taskNamedItemsEditorHtml(template, values, quantityEnabled) {
  const templateItems = Array.isArray(template?.namedItems) ? template.namedItems : [];
  const allocations = taskNamedItemAllocations(values).map(allocation => {
    const idMatch = templateItems.find(item => item.id === allocation.itemId);
    const nameMatch = templateItems.find(item =>
      String(item.name || '').trim().toLocaleLowerCase() === allocation.itemName.toLocaleLowerCase());
    const match = idMatch || nameMatch;
    return match
      ? { ...allocation, itemId: match.id, itemName: match.name, isNew: false }
      : { ...allocation, isNew: true };
  });
  const activeItems = [...(template?.namedItems || [])].filter(item => !item.archived).sort((a, b) => a.order - b.order);
  return `<div id="task_named_item_editor" style="margin-top:12px" data-template-id="${template?.id || ''}" data-quantity-enabled="${quantityEnabled ? 'true' : 'false'}">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <label>本次涉及的命名章节 *</label>
      ${template ? `<button type="button" class="btn btn-ghost btn-sm" onclick="taskManageSharedNamedItems('${template.id}')">管理共享章节库</button>` : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:6px 0">
      <input id="task_named_item_input" list="task_named_item_options" placeholder="搜索已有章节或输入新章节名称"
        onkeydown="if(event.key==='Enter'){event.preventDefault();taskNamedItemAdd('${template?.id || ''}')}">
      <datalist id="task_named_item_options">${activeItems.map(item => `<option value="${escHtmlApp(item.name)}">`).join('')}</datalist>
      <button type="button" class="btn btn-primary btn-sm" onclick="taskNamedItemAdd('${template?.id || ''}')">添加</button>
    </div>
    <div id="task_named_item_suggestion" style="display:none;margin:6px 0"></div>
    <div id="task_named_item_cards" style="display:grid;gap:8px">${allocations.map(item => taskNamedItemCardHtml(item, quantityEnabled)).join('')}</div>
    <div class="form-hint" style="margin-top:6px">时长${quantityEnabled ? '和数量' : ''}请在下方任务字段填写；选择多个章节时系统会在后台平均分配，且所有章节必须全部标记为“本次完成”。点击已添加章节可切换状态。新名称只在保存任务后同步到共享章节库。</div>
  </div>`;
}

function taskManageSharedNamedItems(templateId) {
  showTab('templates');
  setTimeout(() => tmplManageNamedItems(templateId), 0);
}

function taskDimensionPanelHtml(templateId, values = {}) {
  const template = getTaskTemplateById(templateId);
  const goal = template ? getForecastGoalByTemplate(templateId) : null;
  const ordinalEnabled = template ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled) : Boolean(values.namedItemEnabled ?? values.ordinalEnabled);
  const quantityEnabled = template ? Boolean(template.quantityEnabled) : Boolean(values.quantityEnabled);
  const switchHtml = template
    ? `<label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" ${ordinalEnabled ? 'checked' : ''}
          onchange="taskTemplateToggleFeature('${template.id}','ordinal',this)">
        命名章节记录
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" ${quantityEnabled ? 'checked' : ''}
          onchange="taskTemplateToggleFeature('${template.id}','quantity',this)">
        数量记录：${escHtmlApp(template.quantityUnit || '（未设置单位）')}
      </label>`
    : `<label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_ordinal_enabled" ${ordinalEnabled ? 'checked' : ''} onchange="taskNewUnitToggle()">
        新模板开启命名章节记录
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_quantity_enabled" ${quantityEnabled ? 'checked' : ''} onchange="taskNewUnitToggle()">
        新模板开启数量记录
      </label>`;
  return `<div class="forecast-task-fields">
    <div style="display:flex;gap:18px;flex-wrap:wrap;padding:8px 0">${switchHtml}</div>
    <div class="form-hint">${template ? '命名章节来自模板共享章节库；本次新建名称会在保存任务后入库。' : '保存任务时会按完整类别自动建立模板和章节库。'}</div>
    <div id="task_ordinal_editor" style="${ordinalEnabled ? '' : 'display:none'};margin-top:12px">
      ${taskNamedItemsEditorHtml(template, values, quantityEnabled)}
    </div>
  </div>`;
}

function renderForecastTaskFields(templateId, values = {}) {
  const host = document.getElementById('task_forecast_fields');
  if (!host) return;
  host.innerHTML = taskDimensionPanelHtml(templateId, values);
  const namedWrapper = document.getElementById('task_ordinal_editor');
  const hasNamedEditor = Boolean(namedWrapper && namedWrapper.style.display !== 'none');
  const minutesInput = document.getElementById('task_min');
  const quantityInput = document.getElementById('task_qty');
  if (minutesInput) minutesInput.readOnly = false;
  if (quantityInput) quantityInput.readOnly = false;
  taskRecalculateNamedItemTotals();
  if (hasNamedEditor) taskUpdateNamedItemSuggestion(templateId);
}

function taskCompletedNamedItemIds(templateId) {
  const completed = new Set();
  getForecastTaskEntries().forEach(({ task }) => {
    if (resolveTaskTemplateId(task) !== templateId) return;
    taskNamedItemAllocations(task).forEach(item => {
      if (item.completed) completed.add(item.itemId);
    });
  });
  return completed;
}

function namedItemLibraryProgress(templateId) {
  const template = getTaskTemplateById(templateId);
  const items = Array.isArray(template?.namedItems) ? template.namedItems : [];
  const byId = new Map(items.map(item => [item.id, item]));
  const byName = new Map(items.map(item => [String(item.name || '').trim().toLocaleLowerCase(), item]));
  const progress = new Map(items.map(item => [item.id, {
    minutes: 0,
    quantity: 0,
    completed: false,
    completionDate: '',
    completionTaskName: '',
    records: [],
  }]));
  getForecastTaskEntries()
    .filter(({ task }) => resolveTaskTemplateId(task) === templateId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(({ date, task }) => {
      taskNamedItemAllocations(task).forEach(allocation => {
        const item = byId.get(allocation.itemId) ||
          byName.get(String(allocation.itemName || '').trim().toLocaleLowerCase());
        if (!item) return;
        const itemProgress = progress.get(item.id);
        const allocatedMinutes = Math.max(0, Number(allocation.minutes) || 0);
        const allocatedQuantity = Math.max(0, Number(allocation.quantity) || 0);
        itemProgress.minutes += allocatedMinutes;
        itemProgress.quantity += allocatedQuantity;
        itemProgress.records.push({
          date,
          taskId: task.id,
          taskName: task.name || '未命名任务',
          activityType: task.activityType || '',
          minutes: allocatedMinutes,
          quantity: allocation.quantity != null && Number.isFinite(Number(allocation.quantity)) ? allocatedQuantity : null,
          taskTotalQuantity: task.quantity != null && Number.isFinite(Number(task.quantity)) ? Number(task.quantity) : null,
          quantityUnit: task.quantityUnit || template?.quantityUnit || '',
          completed: Boolean(allocation.completed),
        });
        if (allocation.completed && !itemProgress.completed) {
          itemProgress.completed = true;
          itemProgress.completionDate = date;
          itemProgress.completionTaskName = task.name || '未命名任务';
        }
      });
    });
  const activeItems = items.filter(item => !item.archived);
  return {
    progress,
    completedActive: activeItems.filter(item => progress.get(item.id)?.completed).length,
    totalQuantity: activeItems.reduce((sum, item) => sum + (progress.get(item.id)?.quantity || 0), 0),
  };
}

function taskNamedItemCompletionInfo(templateId, itemId, itemName) {
  const normalizedName = String(itemName || '').trim().toLocaleLowerCase();
  const excludedTaskId = state._editingTaskId || '';
  const matches = getForecastTaskEntries()
    .filter(({ task }) => resolveTaskTemplateId(task) === templateId && task.id !== excludedTaskId)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const { date, task } of matches) {
    const allocation = taskNamedItemAllocations(task).find(item =>
      item.completed && (
        (itemId && item.itemId === itemId) ||
        String(item.itemName || '').trim().toLocaleLowerCase() === normalizedName
      )
    );
    if (allocation) return { date, taskId: task.id, taskName: task.name || '未命名任务' };
  }
  return null;
}

function taskOriginalNamedItemAllocation(itemId, itemName) {
  const editingTaskId = state._editingTaskId || '';
  if (!editingTaskId) return null;
  const normalizedName = String(itemName || '').trim().toLocaleLowerCase();
  const entry = getForecastTaskEntries().find(({ task }) => task.id === editingTaskId);
  if (!entry) return null;
  return taskNamedItemAllocations(entry.task).find(item =>
    (itemId && item.itemId === itemId) ||
    String(item.itemName || '').trim().toLocaleLowerCase() === normalizedName
  ) || null;
}

function taskValidateNamedItemTimeline(templateId, allocations, dateStr) {
  for (const allocation of allocations) {
    const original = taskOriginalNamedItemAllocation(allocation.itemId, allocation.itemName);
    const completionInfo = taskNamedItemCompletionInfo(
      templateId,
      allocation.itemId,
      allocation.itemName
    );
    if (!completionInfo) continue;
    if (original?.completed) {
      if (allocation.completed && dateStr >= completionInfo.date) {
        alert(`章节“${allocation.itemName}”已经在 ${completionInfo.date} 的任务“${completionInfo.taskName}”中更早完成。\n当前重复完成记录必须取消“本次完成”。`);
        return false;
      }
      continue;
    }
    if (dateStr >= completionInfo.date) {
      alert(`章节“${allocation.itemName}”已于 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成。\n完成日当天及之后不能再添加该章节。`);
      return false;
    }
    if (allocation.completed) {
      alert(`章节“${allocation.itemName}”已经在 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成。\n完成日前的任务可以记录该章节，但不能提前或重复标记完成。`);
      return false;
    }
  }
  return true;
}

function taskNamedItemAdd(templateId, suppliedName = '') {
  const input = document.getElementById('task_named_item_input');
  const name = String(suppliedName || input?.value || '').trim();
  if (!name) {
    alert('请输入或选择章节名称。');
    return;
  }
  const template = getTaskTemplateById(templateId);
  const allItems = Array.isArray(template?.namedItems) ? template.namedItems : [];
  const normalized = name.toLocaleLowerCase();
  const matched = allItems.find(item => String(item.name || '').trim().toLocaleLowerCase() === normalized);
  if (matched?.archived) {
    alert(`章节“${matched.name}”已归档，请先在共享章节库中恢复。`);
    return;
  }
  if (matched) {
    const completionInfo = taskNamedItemCompletionInfo(templateId, matched.id, matched.name);
    if (completionInfo && state.selectedDate >= completionInfo.date) {
      alert(`章节“${matched.name}”已于 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成。\n完成日当天及之后不能再添加；完成日前仍可添加为“进行中”。`);
      return;
    }
  }
  const itemId = matched?.id || `draft-${uid()}`;
  const cards = document.getElementById('task_named_item_cards');
  if (!cards) return;
  if ([...cards.querySelectorAll('.task-named-item-card')].some(card =>
    card.dataset.itemId === itemId || String(card.dataset.itemName || '').trim().toLocaleLowerCase() === normalized)) {
    alert(`章节“${name}”已经加入本次任务。`);
    return;
  }
  const quantityEnabled = document.getElementById('task_named_item_editor')?.dataset.quantityEnabled === 'true';
  const holder = document.createElement('div');
  holder.innerHTML = taskNamedItemCardHtml({
    itemId,
    itemName: matched?.name || name,
    minutes: 0,
    quantity: null,
    completed: false,
    isNew: !matched,
  }, quantityEnabled);
  cards.appendChild(holder.firstElementChild);
  if (input) input.value = '';
  taskRecalculateNamedItemTotals();
  taskUpdateNamedItemSuggestion(templateId, itemId, matched?.name || name);
}

function taskToggleNamedItemCompleted(event, card) {
  if (!card || event?.target?.closest('button')) return;
  const checkbox = card.querySelector('.task-named-completed');
  const status = card.querySelector('.task-named-completed-status');
  if (!checkbox) return;
  if (!checkbox.checked) {
    const itemId = card.dataset.itemId || '';
    const itemName = card.dataset.itemName || '';
    const original = taskOriginalNamedItemAllocation(itemId, itemName);
    const templateId = document.getElementById('task_named_item_editor')?.dataset.templateId || '';
    const completionInfo = taskNamedItemCompletionInfo(templateId, itemId, itemName);
    const restoringEarliestOriginal = Boolean(
      completionInfo && original?.completed && state.selectedDate < completionInfo.date
    );
    if (completionInfo && !restoringEarliestOriginal) {
      alert(`章节“${itemName}”已经在 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成。\n其他任务不能再次标记该章节完成。`);
      return;
    }
  }
  checkbox.checked = !checkbox.checked;
  card.dataset.completed = checkbox.checked ? 'true' : 'false';
  card.style.borderColor = checkbox.checked ? 'rgba(102,187,106,.65)' : 'var(--border)';
  card.style.background = checkbox.checked ? 'rgba(102,187,106,.10)' : 'rgba(255,255,255,.015)';
  if (status) {
    status.textContent = checkbox.checked ? '✓ 本次完成' : '进行中';
    status.style.color = checkbox.checked ? '#66bb6a' : 'var(--muted)';
  }
}

function taskNamedItemRemove(itemId) {
  document.querySelector(`.task-named-item-card[data-item-id="${itemId}"]`)?.remove();
  taskRecalculateNamedItemTotals();
  const templateId = document.getElementById('task_named_item_editor')?.dataset.templateId || '';
  taskUpdateNamedItemSuggestion(templateId);
}

function taskUpdateNamedItemSuggestion(templateId, sourceItemId = '', sourceName = '') {
  const host = document.getElementById('task_named_item_suggestion');
  if (!host) return;
  const template = getTaskTemplateById(templateId);
  const activeItems = [...(template?.namedItems || [])].filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const selectedCards = [...document.querySelectorAll('.task-named-item-card')];
  const selectedIds = new Set(selectedCards.map(card => card.dataset.itemId));
  const completedIds = taskCompletedNamedItemIds(templateId);
  const lastCard = selectedCards[selectedCards.length - 1];
  const anchorId = sourceItemId || lastCard?.dataset.itemId || '';
  const anchorName = sourceName || lastCard?.dataset.itemName || '';
  const anchorIndex = activeItems.findIndex(item => item.id === anchorId);
  let suggestion = anchorIndex >= 0
    ? activeItems.slice(anchorIndex + 1).find(item => !selectedIds.has(item.id) && !completedIds.has(item.id))
    : null;
  let inferred = false;
  if (!suggestion && anchorName) {
    const nextName = inferNextNamedItemName(anchorName, (template?.namedItems || []).map(item => item.name));
    if (nextName) {
      suggestion = { id: '', name: nextName };
      inferred = true;
    }
  }
  if (!suggestion) {
    host.style.display = 'none';
    host.innerHTML = '';
    delete host.dataset.suggestionName;
    delete host.dataset.templateId;
    return;
  }
  host.dataset.suggestionName = suggestion.name;
  host.dataset.templateId = templateId;
  host.style.display = '';
  host.innerHTML = `<button type="button" class="btn btn-ghost btn-sm"
    onclick="taskAcceptNamedItemSuggestion()">
    💡 建议下一项：${escHtmlApp(suggestion.name)}${inferred ? '（名称推测）' : ''}
  </button>`;
}

function taskAcceptNamedItemSuggestion() {
  const host = document.getElementById('task_named_item_suggestion');
  if (!host?.dataset.suggestionName) return;
  taskNamedItemAdd(host.dataset.templateId || '', host.dataset.suggestionName);
}

function taskCollectNamedItemAllocations(validate = true) {
  const editor = document.getElementById('task_named_item_editor');
  if (!editor) return [];
  const quantityEnabled = editor.dataset.quantityEnabled === 'true';
  const rows = [...document.querySelectorAll('.task-named-item-card')];
  if (!rows.length) return [];
  const totalMinutes = Number(document.getElementById('task_min')?.value);
  const quantityRaw = document.getElementById('task_qty')?.value ?? '';
  const totalQuantity = quantityRaw === '' ? null : Number(quantityRaw);
  const minuteShare = Number.isFinite(totalMinutes) && totalMinutes > 0 ? totalMinutes / rows.length : 0;
  const quantityShare = quantityEnabled && Number.isFinite(totalQuantity) && totalQuantity > 0
    ? totalQuantity / rows.length
    : null;
  return rows.map(row => ({
      itemId: row.dataset.itemId,
      itemName: row.dataset.itemName,
      minutes: minuteShare,
      quantity: quantityShare,
      completed: Boolean(row.querySelector('.task-named-completed')?.checked),
      isNew: row.dataset.new === 'true',
    }));
}

function taskRecalculateNamedItemTotals() {
  const editor = document.getElementById('task_named_item_editor');
  const wrapper = document.getElementById('task_ordinal_editor');
  if (!editor || !wrapper || wrapper.style.display === 'none') return;
  const minutesInput = document.getElementById('task_min');
  const quantityInput = document.getElementById('task_qty');
  if (minutesInput) {
    minutesInput.readOnly = false;
    minutesInput.title = '';
  }
  if (quantityInput && editor.dataset.quantityEnabled === 'true') {
    quantityInput.readOnly = false;
    quantityInput.title = '';
  }
  autoCalcRate();
}

function taskCommitDraftNamedItems(template, allocations) {
  if (!template || !Array.isArray(allocations)) return false;
  const items = [...(template.namedItems || [])].sort((a, b) => a.order - b.order);
  let changed = false;
  allocations.forEach((allocation, allocationIndex) => {
    if (!allocation.isNew || items.some(item => item.id === allocation.itemId)) return;
    const previousAllocation = allocations.slice(0, allocationIndex).reverse()
      .find(item => items.some(existing => existing.id === item.itemId));
    const previousIndex = previousAllocation ? items.findIndex(item => item.id === previousAllocation.itemId) : -1;
    const insertAt = previousIndex >= 0 ? previousIndex + 1 : items.length;
    items.splice(insertAt, 0, {
      id: allocation.itemId,
      name: allocation.itemName,
      order: insertAt,
      archived: false,
    });
    changed = true;
  });
  if (changed) template.namedItems = items.map((item, index) => ({ ...item, order: index }));
  return changed;
}

function taskOrdinalAdd(templateId) {
  const input = document.getElementById('task_ordinal_input');
  const raw = String(input?.value || '').trim();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value <= 0) {
    alert('序数必须是大于 0 的整数。');
    return;
  }
  const template = getTaskTemplateById(templateId);
  const goal = template ? getForecastGoalByTemplate(templateId) : null;
  if ((goal?.mode === 'chapter' || goal?.mode === 'chapterQuantity') &&
    (value < goal.startOrdinal || value > goal.endOrdinal)) {
    alert(`序数必须在预测目标范围第 ${goal.startOrdinal}-${goal.endOrdinal}${goal.ordinalUnit}内。`);
    return;
  }
  const existing = forecastSelectedChapters('.task-chapter-involved');
  const currentUnit = document.getElementById('task_template_ordinal_unit')?.value.trim() ||
    document.getElementById('task_new_ordinal_unit')?.value.trim() || template?.ordinalUnit || '';
  if (existing.includes(value)) {
    alert(`第${value}${currentUnit}已经添加。`);
    return;
  }
  const completed = forecastSelectedChapters('.task-chapter-completed');
  const cards = document.getElementById('task_ordinal_cards');
  if (cards) {
    const values = [...existing, value].sort((a, b) => a - b);
    cards.innerHTML = values.map(item => taskOrdinalCardHtml(item, currentUnit, completed.includes(item))).join('');
  }
  if (input) input.value = '';
}

function taskOrdinalRemove(value) {
  document.querySelector(`.task-ordinal-card[data-ordinal="${value}"]`)?.remove();
}

function forecastChapterCheckboxChanged(chapter, kind, checked) {
  const involved = [...document.querySelectorAll('.task-chapter-involved')]
    .find(input => Number(input.value) === chapter);
  const completed = [...document.querySelectorAll('.task-chapter-completed')]
    .find(input => Number(input.value) === chapter);
  if (kind === 'completed' && checked && involved) {
    involved.checked = true;
    if (completed) completed.disabled = false;
  }
  if (kind === 'involved' && completed) {
    completed.disabled = !checked;
    if (!checked) completed.checked = false;
  }
}

function forecastSelectedChapters(selector) {
  return [...document.querySelectorAll(selector)]
    .filter(input => input.checked)
    .map(input => Number(input.value))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

function forecastPrimaryTargetLabel(goal) {
  if (!goal.mode) return '模板单位均已关闭 · 需要重新配置';
  if (goal.mode === 'quantity') return `数量目标 · ${goal.quantityUnit}`;
  return `命名章节目标${goal.mode === 'chapterQuantity' ? ' · 题数辅助估算' : ''}`;
}

function forecastLinkedTasks(goal) {
  return getForecastTaskEntries().filter(entry => resolveTaskTemplateId(entry.task) === goal.templateId);
}

function forecastQuantityResult(goal, entries) {
  const valid = entries.filter(({ task }) =>
    Number.isInteger(Number(task.quantity)) &&
    Number(task.quantity) > 0 &&
    Number.isInteger(Number(task.minutes)) &&
    Number(task.minutes) > 0 &&
    task.quantityUnit === goal.quantityUnit
  );
  const completed = valid.reduce((sum, entry) => sum + Number(entry.task.quantity), 0);
  const minutes = valid.reduce((sum, entry) => sum + Number(entry.task.minutes), 0);
  const speed = minutes > 0 ? completed / minutes : 0;
  const remaining = Math.max(0, Number(goal.totalQuantity) - completed);
  const complete = remaining === 0;
  return {
    goal,
    complete,
    ready: complete || speed > 0,
    reason: complete || speed > 0 ? '' : '至少需要一条题数、单位和时长都有效的任务记录。',
    requiredMinutes: complete ? 0 : remaining / speed,
    progress: Number(goal.totalQuantity) > 0 ? Math.min(100, completed / Number(goal.totalQuantity) * 100) : 0,
    completed,
    remaining,
    speed,
    excluded: entries.length - valid.length,
    summary: `已完成 ${completed} / ${goal.totalQuantity} ${goal.quantityUnit}`,
    efficiency: speed > 0 ? `${speed.toFixed(2)} ${goal.quantityUnit}/分钟` : '数据不足',
  };
}

function forecastActiveNamedItems(goal) {
  return [...(Array.isArray(goal.namedItems) ? goal.namedItems : [])]
    .filter(item => !item.archived && item.id && String(item.name || '').trim())
    .sort((a, b) => Number(a.order) - Number(b.order));
}

function forecastNamedItemGroups(goal, entries, requireQuantity = false) {
  const items = forecastActiveNamedItems(goal);
  const groups = new Map(items.map((item, index) => [item.id, {
    itemId: item.id,
    name: String(item.name || '').trim(),
    order: index,
    minutes: 0,
    quantity: 0,
    quantityMinutes: 0,
    speedQuantity: 0,
    completed: false,
  }]));
  const byName = new Map(items.map(item => [String(item.name || '').trim().toLocaleLowerCase(), item.id]));
  let excluded = 0;
  entries.forEach(({ task }) => {
    let contributed = false;
    taskNamedItemAllocations(task).forEach(allocation => {
      const fallbackId = byName.get(allocation.itemName.toLocaleLowerCase());
      const group = groups.get(allocation.itemId) || groups.get(fallbackId);
      if (!group) return;
      const minutes = Number(allocation.minutes);
      const quantity = Number(allocation.quantity);
      const validMinutes = Number.isFinite(minutes) && minutes > 0;
      const validQuantity = Number.isFinite(quantity) && quantity > 0 &&
        task.quantityUnit === goal.quantityUnit;
      if (validMinutes) group.minutes += minutes;
      if (validQuantity) group.quantity += quantity;
      if (validMinutes && validQuantity) {
        group.quantityMinutes += minutes;
        group.speedQuantity += quantity;
      }
      if (allocation.completed) group.completed = true;
      if (validMinutes && (!requireQuantity || validQuantity)) contributed = true;
    });
    if (!contributed) excluded++;
  });
  return { groups: [...groups.values()].sort((a, b) => a.order - b.order), excluded };
}

function forecastChapterResult(goal, entries) {
  const { groups, excluded } = forecastNamedItemGroups(goal, entries, false);
  const chapterCount = groups.length;
  const completedGroups = groups.filter(group => group.completed);
  const validCompletedGroups = completedGroups.filter(group => group.minutes > 0);
  const completed = completedGroups.length;
  const remaining = chapterCount - completed;
  const complete = chapterCount > 0 && remaining === 0;
  const baseItems = groups.map(group => ({ ...group, estimatedRemainingMinutes: 0, estimatedRemainingQuantity: null }));
  if (complete) {
    return {
      goal, complete: true, ready: true, reason: '', warning: '', requiredMinutes: 0,
      progress: 100, completed, remaining: 0, speed: 0, excluded, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: '目标已完成',
    };
  }
  if (!validCompletedGroups.length) {
    return {
      goal, complete: false, ready: false,
      reason: '至少需要完成并勾选一个具有有效时长的章节后才能估算。',
      warning: '', requiredMinutes: null, progress: chapterCount ? completed / chapterCount * 100 : 0,
      completed, remaining, speed: 0, excluded, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: '数据不足',
    };
  }
  const averageMinutes = validCompletedGroups.reduce((sum, group) => sum + group.minutes, 0) / validCompletedGroups.length;
  const items = groups.map(group => ({
    ...group,
    estimatedRemainingMinutes: group.completed ? 0 : Math.max(0, averageMinutes - group.minutes),
    estimatedRemainingQuantity: null,
  }));
  const requiredMinutes = items.reduce((sum, item) => sum + item.estimatedRemainingMinutes, 0);
  return {
    goal, complete: false, ready: true, reason: '', warning: '', requiredMinutes,
    progress: chapterCount ? completed / chapterCount * 100 : 0, completed, remaining,
    speed: averageMinutes > 0 ? 1 / averageMinutes : 0, excluded, items,
    averageMinutes,
    summary: `已完成 ${completed} / ${chapterCount} 个章节`,
    efficiency: `平均 ${averageMinutes.toFixed(1)} 分钟/章节`,
  };
}

function forecastChapterQuantityResult(goal, entries) {
  const { groups, excluded } = forecastNamedItemGroups(goal, entries, true);
  const chapterCount = groups.length;
  const completedGroups = groups.filter(group => group.completed);
  const validCompletedGroups = completedGroups.filter(group => group.quantity > 0 && group.quantityMinutes > 0);
  const completed = completedGroups.length;
  const remaining = chapterCount - completed;
  const complete = chapterCount > 0 && remaining === 0;
  const baseItems = groups.map(group => ({ ...group, estimatedRemainingMinutes: 0, estimatedRemainingQuantity: 0 }));
  if (complete) {
    return {
      goal, complete: true, ready: true, reason: '', warning: '', requiredMinutes: 0,
      progress: 100, completed, remaining: 0, speed: 0, excluded, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: '目标已完成',
    };
  }
  const totalQuestions = groups.reduce((sum, group) => sum + group.speedQuantity, 0);
  const questionMinutes = groups.reduce((sum, group) => sum + group.quantityMinutes, 0);
  const questionSpeed = questionMinutes > 0 ? totalQuestions / questionMinutes : 0;
  if (!validCompletedGroups.length || !questionSpeed) {
    return {
      goal, complete: false, ready: false,
      reason: `至少需要完成一个章节，并为它记录有效的${goal.quantityUnit || '数量'}和时长。`,
      warning: '', requiredMinutes: null, progress: chapterCount ? completed / chapterCount * 100 : 0,
      completed, remaining, speed: questionSpeed, excluded, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: questionSpeed > 0 ? `${questionSpeed.toFixed(2)} ${goal.quantityUnit}/分钟` : '数据不足',
    };
  }
  const averageQuestions = validCompletedGroups.reduce((sum, group) => sum + group.quantity, 0) / validCompletedGroups.length;
  const averageMinutes = validCompletedGroups.reduce((sum, group) => sum + group.minutes, 0) / validCompletedGroups.length;
  const items = groups.map(group => {
    const estimatedRemainingQuantity = group.completed ? 0 : Math.max(0, averageQuestions - group.quantity);
    return {
      ...group,
      estimatedRemainingQuantity,
      estimatedRemainingMinutes: estimatedRemainingQuantity / questionSpeed,
      quantityExceededAverage: !group.completed && group.quantity >= averageQuestions,
    };
  });
  const exceededCount = items.filter(item => item.quantityExceededAverage).length;
  const requiredMinutes = items.reduce((sum, item) => sum + item.estimatedRemainingMinutes, 0);
  return {
    goal, complete: false, ready: true, reason: '',
    warning: exceededCount
      ? `${exceededCount} 个未完成章节的累计${goal.quantityUnit || '数量'}已达到或超过已完成章节平均值，这些章节暂按剩余 0 分钟估算，请确认是否应勾选完成。`
      : '',
    requiredMinutes,
    progress: chapterCount ? completed / chapterCount * 100 : 0, completed, remaining,
    speed: questionSpeed, excluded, items, averageQuestions, averageMinutes,
    summary: `已完成 ${completed} / ${chapterCount} 个章节 · 平均 ${averageQuestions.toFixed(1)} ${goal.quantityUnit}/章节`,
    efficiency: `${questionSpeed.toFixed(2)} ${goal.quantityUnit}/分钟 · 平均 ${averageMinutes.toFixed(1)} 分钟/章节`,
  };
}

function calculateForecastGoal(goal) {
  const context = forecastGoalContext(goal);
  const invalid = reason => ({
    goal: context,
    complete: false,
    ready: false,
    configurationInvalid: true,
    reason,
    requiredMinutes: null,
    progress: 0,
    completed: 0,
    remaining: 0,
    speed: 0,
    excluded: 0,
    items: [],
    warning: '',
    summary: '预测配置不完整',
    efficiency: '暂停计算',
  });
  if (!context.mode) return invalid('模板的序数和数量开关均已关闭，请先开启至少一个单位并重新配置目标。');
  if (context.mode === 'quantity' &&
    (!Number.isInteger(Number(context.totalQuantity)) || Number(context.totalQuantity) <= 0)) {
    return invalid('当前主目标已切换为数量，请编辑目标并填写总任务量。');
  }
  if ((context.mode === 'chapter' || context.mode === 'chapterQuantity') &&
    !forecastActiveNamedItems(context).length) {
    return invalid('当前模板没有活动章节，请先在共享章节库中建立或恢复章节。');
  }
  const entries = forecastLinkedTasks(context);
  if (context.mode === 'quantity') return forecastQuantityResult(context, entries);
  if (context.mode === 'chapter') return forecastChapterResult(context, entries);
  return forecastChapterQuantityResult(context, entries);
}

function forecastDateAfter(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function forecastActualMinutesForDay(dateStr) {
  const day = state.data[dateStr];
  if (!day || !Array.isArray(day.sessions)) return 0;
  return day.sessions.reduce((sum, session) => {
    if (isUnavailableSession(session)) return sum;
    return sum + (Number(session.actualMinutes) || 0);
  }, 0);
}

function forecastCapacityStats(settings = getForecastSettings()) {
  if (settings.capacityMode === 'manual') {
    const averageMinutes = Number(settings.manualDailyMinutes) || 0;
    return {
      source: 'manual',
      valid: averageMinutes > 0,
      startDate: '',
      endDate: '',
      averageMinutes,
      eligibleDays: 0,
      excludedDays: 0,
      totalActualMinutes: 0,
    };
  }
  const start = settings.capacityStartDate;
  const end = settings.capacityTrackLatest ? getTodayStr() : settings.capacityEndDate;
  if (!start || !end || start > end) {
    return { source: 'range', valid: false, startDate: start, endDate: end, averageMinutes: 0, eligibleDays: 0, excludedDays: 0, totalActualMinutes: 0 };
  }
  let cursor = start;
  let eligibleDays = 0;
  let excludedDays = 0;
  let totalActualMinutes = 0;
  while (cursor <= end) {
    const day = state.data[cursor];
    if (day?.excludeFromRating) {
      excludedDays++;
    } else {
      eligibleDays++;
      totalActualMinutes += forecastActualMinutesForDay(cursor);
    }
    cursor = forecastDateAfter(cursor, 1);
  }
  return {
    source: 'range',
    valid: eligibleDays > 0,
    startDate: start,
    endDate: end,
    averageMinutes: eligibleDays > 0 ? totalActualMinutes / eligibleDays : 0,
    eligibleDays,
    excludedDays,
    totalActualMinutes,
  };
}

function calculateForecastOverall(results) {
  const settings = getForecastSettings();
  const capacity = forecastCapacityStats(settings);
  const unfinished = results.filter(result => !result.complete);
  const insufficient = unfinished.filter(result => !result.ready);
  const today = getTodayStr();
  const todayExcluded = Boolean(state.data[today]?.excludeFromRating);
  const todayUsed = todayExcluded ? 0 : forecastActualMinutesForDay(today);
  if (!unfinished.length) {
    return { label: '全部目标已完成', totalMinutes: 0, todayUsed, insufficient: 0, capacity };
  }
  if (insufficient.length) {
    const needsConfiguration = insufficient.filter(result => result.configurationInvalid).length;
    return {
      label: needsConfiguration
        ? `${needsConfiguration} 个目标需要重新配置`
        : `${insufficient.length} 个目标数据不足`,
      totalMinutes: null,
      todayUsed,
      insufficient: insufficient.length,
      capacity,
    };
  }
  if (!capacity.valid || capacity.averageMinutes <= 0) {
    return {
      label: capacity.source === 'manual' ? '请设置有效的每日学习时长' : '历史日均实际学习时间不足',
      totalMinutes: null,
      todayUsed,
      insufficient: 0,
      capacity,
    };
  }
  const totalMinutes = unfinished.reduce((sum, result) => sum + result.requiredMinutes, 0);
  const availableToday = todayExcluded ? 0 : Math.max(0, capacity.averageMinutes - todayUsed);
  if (totalMinutes <= availableToday) {
    return { label: today, totalMinutes, todayUsed, insufficient: 0, capacity };
  }
  // 从明天起逐日分配学习能力；已标记“不参与评分”的日期不分配时长，也不计入完成天数。
  let remainingMinutes = totalMinutes - availableToday;
  let completionDate = today;
  let guard = 0;
  while (remainingMinutes > 0 && guard < 36600) {
    completionDate = forecastDateAfter(completionDate, 1);
    if (!state.data[completionDate]?.excludeFromRating) {
      remainingMinutes -= capacity.averageMinutes;
    }
    guard++;
  }
  return {
    label: completionDate,
    totalMinutes,
    todayUsed,
    insufficient: 0,
    capacity,
  };
}

function forecastStartNew() {
  state.forecastEditingId = null;
  renderForecast();
}

function forecastEdit(id) {
  state.forecastEditingId = id;
  renderForecast();
}

function forecastNamedItemRecordsHtml(records = [], quantityUnit = '') {
  if (!records.length) {
    return '<div class="form-hint">该章节还没有关联的任务记录。</div>';
  }
  return `<div style="max-height:240px;overflow:auto">
    <table style="width:100%;font-size:11px">
      <thead><tr><th>日期</th><th>任务</th><th>活动类别</th><th>本章分钟</th><th>本章数量</th><th>任务总数量</th><th>状态</th></tr></thead>
      <tbody>${records.map(record => `<tr>
        <td class="fw-mono">${escHtmlApp(record.date)}</td>
        <td>${escHtmlApp(record.taskName)}</td>
        <td class="c-muted">${escHtmlApp(record.activityType || '-')}</td>
        <td class="fw-mono">${forecastDisplayMetric(record.minutes)} 分钟</td>
        <td class="fw-mono">${record.quantity == null ? '-' : `${forecastDisplayMetric(record.quantity)} ${escHtmlApp(record.quantityUnit || quantityUnit || '')}`}</td>
        <td class="fw-mono">${record.taskTotalQuantity == null ? '-' : `${forecastDisplayMetric(record.taskTotalQuantity)} ${escHtmlApp(record.quantityUnit || quantityUnit || '')}`}</td>
        <td style="color:${record.completed ? '#66bb6a' : 'var(--muted)'}">${record.completed ? '✓ 本次完成' : '进行中'}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>
  <div class="form-hint" style="margin-top:6px">“本章数量”是该任务分配给本章节的数量；一条任务选择多个章节时，任务总数量会平均分配。</div>`;
}

function forecastToggleNamedItemDetails(button) {
  const details = button?.closest('.forecast-named-item-row')?.querySelector('.forecast-named-item-details');
  if (!details) return;
  const opening = details.style.display === 'none';
  details.style.display = opening ? '' : 'none';
  button.textContent = opening ? '收起明细' : `录入明细（${button.dataset.count || '0'}）`;
}

function forecastNamedItemRowHtml(item, itemProgress = null, quantityEnabled = false, quantityUnit = '') {
  const archived = Boolean(item.archived);
  const draft = Boolean(item.draft);
  const hasProgress = Boolean(itemProgress && (itemProgress.minutes > 0 || itemProgress.quantity > 0));
  const statusText = itemProgress?.completed ? '✓ 已完成' : hasProgress ? '进行中' : '未开始';
  const statusColor = itemProgress?.completed ? '#66bb6a' : hasProgress ? 'var(--wake)' : 'var(--muted)';
  return `<div class="forecast-named-item-row" data-item-id="${escHtmlApp(item.id)}" data-archived="${archived ? 'true' : 'false'}" data-draft="${draft ? 'true' : 'false'}"
    style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:7px;background:rgba(255,255,255,.02)">
    <input class="forecast-named-item-name" value="${escHtmlApp(item.name || '')}" maxlength="160"
      ${archived ? 'disabled' : ''}
      oninput="forecastRefreshNamedItemEditorState()"
      onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
      aria-label="命名章节名称">
    <div style="display:flex;gap:5px;align-items:center">
      ${!draft ? `<div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:5px;font-size:10px;white-space:nowrap">
        <span style="color:${statusColor}">${statusText}</span>
        ${itemProgress?.completed ? `<span class="c-muted">${escHtmlApp(itemProgress.completionDate)} · ${escHtmlApp(itemProgress.completionTaskName)}</span>` : ''}
        ${quantityEnabled ? `<span class="c-muted">已录入 ${forecastDisplayMetric(itemProgress?.quantity || 0)} ${escHtmlApp(quantityUnit || '数量')}</span>` : ''}
      </div>` : ''}
      ${quantityEnabled && !draft ? `<button type="button" class="btn btn-ghost btn-sm" data-count="${itemProgress?.records?.length || 0}" onclick="forecastToggleNamedItemDetails(this)">录入明细（${itemProgress?.records?.length || 0}）</button>` : ''}
      ${archived
        ? `<span class="c-muted" style="font-size:11px">已归档</span>
           <button type="button" class="btn btn-ghost btn-sm" onclick="forecastRestoreNamedItem('${item.id}')">恢复</button>`
        : `<button type="button" class="btn btn-ghost btn-sm" onclick="forecastMoveNamedItem('${item.id}',-1)" title="上移">↑</button>
           <button type="button" class="btn btn-ghost btn-sm" onclick="forecastMoveNamedItem('${item.id}',1)" title="下移">↓</button>
           <button type="button" class="btn btn-danger btn-sm" onclick="forecastRemoveNamedItem('${item.id}')" title="移除" aria-label="移除章节">－</button>`}
    </div>
    ${quantityEnabled && !draft ? `<div class="forecast-named-item-details" style="display:none;grid-column:1/-1;padding-top:8px;border-top:1px solid var(--border)">
      ${forecastNamedItemRecordsHtml(itemProgress?.records || [], quantityUnit)}
    </div>` : ''}
  </div>`;
}

function forecastNamedItemsEditorHtml(items = [], templateId = '') {
  const normalized = Array.isArray(items) ? items
    .map((item, index) => ({
      id: String(item?.id || uid()),
      name: String(item?.name || '').trim(),
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
      archived: Boolean(item?.archived),
    }))
    .filter(item => item.name)
    : [];
  const active = normalized.filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const archived = normalized.filter(item => item.archived).sort((a, b) => a.order - b.order);
  const template = getTaskTemplateById(templateId);
  const libraryProgress = templateId ? namedItemLibraryProgress(templateId) : { progress: new Map(), completedActive: 0, totalQuantity: 0 };
  const lastActiveName = [...active].reverse().find(item => item.name)?.name || '';
  const predictedName = inferNextNamedItemName(lastActiveName, normalized.map(item => item.name));
  return `<div class="forecast-named-items-editor">
    <label>命名章节清单 *</label>
    ${template ? `<div class="form-hint" style="margin-top:5px">活动章节完成 ${libraryProgress.completedActive}/${active.length}${template.quantityEnabled ? ` · 已录入 ${forecastDisplayMetric(libraryProgress.totalQuantity)} ${escHtmlApp(template.quantityUnit || '数量')}` : ''}</div>` : ''}
    <div style="max-height:min(45vh,360px);overflow-y:auto;margin-top:6px;border:1px solid var(--border);border-radius:8px;background:rgba(0,0,0,.08)">
      <div id="forecast_named_items_active" style="display:grid;gap:7px;padding:8px">
        ${active.map(item => forecastNamedItemRowHtml(item, libraryProgress.progress.get(item.id), Boolean(template?.quantityEnabled), template?.quantityUnit || '')).join('')}
        <div id="forecast_named_items_empty" class="form-hint" style="${active.length ? 'display:none' : ''}">尚未添加章节。点击“＋”新增空白行。</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg, var(--surface))">
      <button type="button" class="btn btn-primary btn-sm" onclick="forecastAddBlankNamedItem()" title="新增空白章节" aria-label="新增空白章节">＋</button>
      <button type="button" id="forecast_named_item_predict" class="btn btn-ghost btn-sm"
        onclick="forecastAddPredictedNamedItem()" ${predictedName ? '' : 'disabled'}>
        ${predictedName ? `⚡＋ ${escHtmlApp(predictedName)}` : '⚡＋预测下一项'}
      </button>
      <span id="forecast_named_item_predict_hint" class="form-hint" style="margin:0">
        ${predictedName ? '' : (lastActiveName ? '当前名称无法推测下一项' : '请先添加并填写一个章节')}
      </span>
    </div>
    <details id="forecast_named_items_archived_wrap" style="margin-top:10px;${archived.length ? '' : 'display:none'}">
      <summary style="cursor:pointer;color:var(--muted);font-size:12px">已归档章节（<span id="forecast_named_items_archived_count">${archived.length}</span>）</summary>
      <div id="forecast_named_items_archived" style="display:grid;gap:7px;margin-top:7px">
        ${archived.map(item => forecastNamedItemRowHtml(item, libraryProgress.progress.get(item.id), Boolean(template?.quantityEnabled), template?.quantityUnit || '')).join('')}
      </div>
    </details>
    <div class="form-hint" style="margin-top:7px">名称在同一模板内不可重复；清单顺序会同步到完成预测和任务录入。已被历史任务引用的章节只能归档，不能物理删除。</div>
  </div>`;
}

function forecastNamedItemRows() {
  return [...document.querySelectorAll('.forecast-named-item-row')];
}

function forecastNamedItemNameExists(name, exceptId = '') {
  const normalized = String(name || '').trim().toLocaleLowerCase();
  return forecastNamedItemRows().some(row =>
    row.dataset.itemId !== exceptId &&
    String(row.querySelector('.forecast-named-item-name')?.value || '').trim().toLocaleLowerCase() === normalized
  );
}

function forecastRefreshNamedItemEditorState() {
  const activeHost = document.getElementById('forecast_named_items_active');
  const archivedHost = document.getElementById('forecast_named_items_archived');
  const empty = document.getElementById('forecast_named_items_empty');
  const archivedWrap = document.getElementById('forecast_named_items_archived_wrap');
  const archivedCount = document.getElementById('forecast_named_items_archived_count');
  const predictButton = document.getElementById('forecast_named_item_predict');
  const predictHint = document.getElementById('forecast_named_item_predict_hint');
  const activeCount = activeHost?.querySelectorAll('.forecast-named-item-row').length || 0;
  const archivedTotal = archivedHost?.querySelectorAll('.forecast-named-item-row').length || 0;
  if (empty) empty.style.display = activeCount ? 'none' : '';
  if (archivedWrap) archivedWrap.style.display = archivedTotal ? '' : 'none';
  if (archivedCount) archivedCount.textContent = String(archivedTotal);
  const activeRows = [...(activeHost?.querySelectorAll('.forecast-named-item-row') || [])];
  const lastName = activeRows
    .map(row => String(row.querySelector('.forecast-named-item-name')?.value || '').trim())
    .reverse()
    .find(Boolean) || '';
  const existingNames = forecastNamedItemRows()
    .map(row => String(row.querySelector('.forecast-named-item-name')?.value || '').trim())
    .filter(Boolean);
  const predictedName = inferNextNamedItemName(lastName, existingNames);
  if (predictButton) {
    predictButton.disabled = !predictedName;
    predictButton.textContent = predictedName ? `⚡＋ ${predictedName}` : '⚡＋预测下一项';
  }
  if (predictHint) {
    predictHint.textContent = predictedName ? '' : (lastName ? '当前名称无法推测下一项' : '请先添加并填写一个章节');
  }
}

function chineseNamedItemNumberToValue(text) {
  const digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const units = { '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000 };
  const chars = [...String(text || '')];
  if (!chars.length || chars.some(char => digits[char] === undefined && units[char] === undefined)) return null;
  if (!chars.some(char => units[char] !== undefined)) {
    const value = Number(chars.map(char => digits[char]).join(''));
    return Number.isSafeInteger(value) ? value : null;
  }
  let total = 0;
  let section = 0;
  let number = 0;
  chars.forEach(char => {
    if (digits[char] !== undefined) {
      number = digits[char];
      return;
    }
    const unit = units[char];
    if (unit < 10000) {
      section += (number || 1) * unit;
    } else {
      section += number;
      total += (section || 1) * unit;
      section = 0;
    }
    number = 0;
  });
  const value = total + section + number;
  return Number.isSafeInteger(value) ? value : null;
}

function namedItemValueToChineseNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const underTenThousand = number => {
    const places = [
      { value: 1000, label: '千' },
      { value: 100, label: '百' },
      { value: 10, label: '十' },
      { value: 1, label: '' },
    ];
    let result = '';
    let remainder = number;
    let pendingZero = false;
    places.forEach(place => {
      const digit = Math.floor(remainder / place.value);
      remainder %= place.value;
      if (digit) {
        if (pendingZero && result) result += '零';
        result += digits[digit] + place.label;
        pendingZero = false;
      } else if (result && remainder) {
        pendingZero = true;
      }
    });
    return result.replace(/^一十/, '十');
  };
  const convert = number => {
    if (number < 10000) return underTenThousand(number);
    if (number < 100000000) {
      const high = Math.floor(number / 10000);
      const low = number % 10000;
      return convert(high) + '万' + (low ? `${low < 1000 ? '零' : ''}${underTenThousand(low)}` : '');
    }
    const high = Math.floor(number / 100000000);
    const low = number % 100000000;
    return convert(high) + '亿' + (low ? `${low < 10000000 ? '零' : ''}${convert(low)}` : '');
  };
  if (!Number.isSafeInteger(value) || value < 0) return '';
  return value === 0 ? '零' : convert(value);
}

function inferNextNamedItemName(name, existingNames = []) {
  const source = String(name || '').trim();
  const matches = [...source.matchAll(/\d+|[零〇一二两三四五六七八九十百千万亿]+/g)];
  const match = matches[matches.length - 1];
  if (!match) return '';
  const token = match[0];
  const isArabic = /^\d+$/.test(token);
  const start = isArabic ? Number(token) : chineseNamedItemNumberToValue(token);
  if (!Number.isSafeInteger(start)) return '';
  const used = new Set(existingNames.map(value => String(value || '').trim().toLocaleLowerCase()));
  for (let offset = 1; offset <= 1000; offset++) {
    const nextNumber = isArabic
      ? String(start + offset).padStart(token.length, '0')
      : namedItemValueToChineseNumber(start + offset);
    if (!nextNumber) return '';
    const candidate = source.slice(0, match.index) + nextNumber + source.slice(match.index + token.length);
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return '';
}

function forecastAppendNamedItem(name = '') {
  const host = document.getElementById('forecast_named_items_active');
  if (!host) return;
  const holder = document.createElement('div');
  holder.innerHTML = forecastNamedItemRowHtml({ id: uid(), name, archived: false, draft: true });
  const row = holder.firstElementChild;
  const empty = document.getElementById('forecast_named_items_empty');
  host.insertBefore(row, empty || null);
  forecastRefreshNamedItemEditorState();
  const input = row.querySelector('.forecast-named-item-name');
  input?.focus();
  if (name) input?.select();
  row.scrollIntoView({ block: 'nearest' });
}

function forecastAddBlankNamedItem() {
  forecastAppendNamedItem('');
}

function forecastAddPredictedNamedItem() {
  const activeHost = document.getElementById('forecast_named_items_active');
  const activeRows = [...(activeHost?.querySelectorAll('.forecast-named-item-row') || [])];
  const lastName = activeRows
    .map(row => String(row.querySelector('.forecast-named-item-name')?.value || '').trim())
    .reverse()
    .find(Boolean) || '';
  const existingNames = forecastNamedItemRows()
    .map(row => String(row.querySelector('.forecast-named-item-name')?.value || '').trim())
    .filter(Boolean);
  const predictedName = inferNextNamedItemName(lastName, existingNames);
  if (!predictedName) return;
  forecastAppendNamedItem(predictedName);
}

function forecastMoveNamedItem(id, direction) {
  const row = forecastNamedItemRows().find(item => item.dataset.itemId === id && item.dataset.archived !== 'true');
  if (!row || !row.parentElement) return;
  if (direction < 0) {
    const previous = row.previousElementSibling;
    if (previous?.classList.contains('forecast-named-item-row')) row.parentElement.insertBefore(row, previous);
  } else {
    const next = row.nextElementSibling;
    if (next?.classList.contains('forecast-named-item-row')) row.parentElement.insertBefore(next, row);
  }
}

function forecastNamedItemIsReferenced(id) {
  return getForecastTaskEntries().some(({ task }) =>
    Array.isArray(task.namedItemAllocations) &&
    task.namedItemAllocations.some(allocation => allocation?.itemId === id)
  );
}

function forecastRemoveNamedItem(id) {
  const row = forecastNamedItemRows().find(item => item.dataset.itemId === id);
  if (!row) return;
  if (!forecastNamedItemIsReferenced(id)) {
    row.remove();
    forecastRefreshNamedItemEditorState();
    return;
  }
  const archivedHost = document.getElementById('forecast_named_items_archived');
  if (!archivedHost) return;
  row.dataset.archived = 'true';
  const input = row.querySelector('.forecast-named-item-name');
  if (input) input.disabled = true;
  const actions = row.lastElementChild;
  if (actions) {
    actions.innerHTML = `<span class="c-muted" style="font-size:11px">已归档</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="forecastRestoreNamedItem('${id}')">恢复</button>`;
  }
  archivedHost.appendChild(row);
  forecastRefreshNamedItemEditorState();
}

function forecastRestoreNamedItem(id) {
  const row = forecastNamedItemRows().find(item => item.dataset.itemId === id && item.dataset.archived === 'true');
  if (!row) return;
  const name = String(row.querySelector('.forecast-named-item-name')?.value || '').trim();
  if (forecastNamedItemNameExists(name, id)) {
    alert(`活动清单中已经存在“${name}”，请先处理重名章节。`);
    return;
  }
  const activeHost = document.getElementById('forecast_named_items_active');
  if (!activeHost) return;
  row.dataset.archived = 'false';
  const input = row.querySelector('.forecast-named-item-name');
  if (input) input.disabled = false;
  const actions = row.lastElementChild;
  if (actions) {
    actions.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" onclick="forecastMoveNamedItem('${id}',-1)" title="上移">↑</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="forecastMoveNamedItem('${id}',1)" title="下移">↓</button>
      <button type="button" class="btn btn-danger btn-sm" onclick="forecastRemoveNamedItem('${id}')">移除</button>`;
  }
  const empty = document.getElementById('forecast_named_items_empty');
  activeHost.insertBefore(row, empty || null);
  forecastRefreshNamedItemEditorState();
}

function forecastCollectNamedItems() {
  const activeHost = document.getElementById('forecast_named_items_active');
  const archivedHost = document.getElementById('forecast_named_items_archived');
  const active = [...(activeHost?.querySelectorAll('.forecast-named-item-row') || [])];
  const archived = [...(archivedHost?.querySelectorAll('.forecast-named-item-row') || [])];
  return [...active, ...archived]
    .map(row => ({
      id: row.dataset.itemId,
      name: String(row.querySelector('.forecast-named-item-name')?.value || '').trim(),
      archived: row.dataset.archived === 'true',
      draft: row.dataset.draft === 'true',
    }))
    .filter(item => item.name || !item.draft)
    .map((item, index) => ({
      id: item.id,
      name: item.name,
      order: index,
      archived: item.archived,
    }));
}

function forecastUpdateGoalFields(updateName = false) {
  const templateId = document.getElementById('forecast_goal_template')?.value || '';
  const template = getTaskTemplates().find(item => item.id === templateId);
  const mode = forecastModeFromTemplate(template);
  const modeLabel = document.getElementById('forecast_goal_primary_label');
  if (modeLabel) {
    const namedItemEnabled = template?.namedItemEnabled ?? template?.ordinalEnabled;
    modeLabel.value = namedItemEnabled
      ? `命名章节主目标${template.quantityEnabled ? '（题数辅助估算）' : ''}`
      : template?.quantityEnabled
        ? `数量主目标：${template.quantityUnit}`
        : '请先在模板库开启单位';
  }
  const quantityGroup = document.getElementById('forecast_quantity_group');
  const totalField = document.getElementById('forecast_total_field');
  const chapterGroup = document.getElementById('forecast_chapter_group');
  if (quantityGroup) quantityGroup.style.display = mode === 'quantity' || mode === 'chapterQuantity' ? 'grid' : 'none';
  if (totalField) totalField.style.display = mode === 'quantity' ? '' : 'none';
  if (chapterGroup) chapterGroup.style.display = mode === 'chapter' || mode === 'chapterQuantity' ? 'grid' : 'none';
  if (chapterGroup && (mode === 'chapter' || mode === 'chapterQuantity') && updateName) {
    chapterGroup.innerHTML = forecastNamedItemsEditorHtml(template?.namedItems || [], template?.id || '');
  }
  const unit = document.getElementById('forecast_goal_unit');
  if (unit) unit.value = template?.quantityUnit || '';
  if (updateName) {
    const name = document.getElementById('forecast_goal_name');
    if (name && !name.value.trim() && template) name.value = forecastTemplateLabel(template);
  }
}

async function forecastSaveCapacityRange() {
  const capacityMode = document.getElementById('forecast_capacity_mode')?.value === 'manual'
    ? 'manual'
    : 'range';
  const manualDailyMinutes = Number(document.getElementById('forecast_manual_daily_minutes')?.value);
  const startDate = document.getElementById('forecast_capacity_start')?.value || '';
  const trackLatest = Boolean(document.getElementById('forecast_capacity_track_latest')?.checked);
  const endDate = trackLatest
    ? getTodayStr()
    : document.getElementById('forecast_capacity_end')?.value || '';
  if (capacityMode === 'manual' &&
    (!Number.isInteger(manualDailyMinutes) || manualDailyMinutes <= 0 || manualDailyMinutes > 1440)) {
    alert('手动每日学习时长必须是 1 至 1440 之间的整数分钟。');
    return;
  }
  if (capacityMode === 'range' && (!startDate || !endDate || startDate > endDate)) {
    alert('请选择有效的统计起止日期，结束日期不能早于开始日期。');
    return;
  }
  const settings = getForecastSettings();
  settings.capacityMode = capacityMode;
  if (capacityMode === 'manual') settings.manualDailyMinutes = manualDailyMinutes;
  settings.capacityStartDate = startDate;
  settings.capacityEndDate = endDate;
  settings.capacityTrackLatest = trackLatest;
  await saveAllStorage();
  renderForecast();
}

function forecastToggleCapacityMode() {
  const manual = document.getElementById('forecast_capacity_mode')?.value === 'manual';
  const rangePanel = document.getElementById('forecast_capacity_range_panel');
  const manualPanel = document.getElementById('forecast_capacity_manual_panel');
  if (rangePanel) rangePanel.style.display = manual ? 'none' : '';
  if (manualPanel) manualPanel.style.display = manual ? '' : 'none';
  if (!manual) forecastApplyCapacityTrackingUi();
}

function forecastToggleCapacityTracking() {
  const trackLatest = Boolean(document.getElementById('forecast_capacity_track_latest')?.checked);
  if (trackLatest) editableDatePicked('forecast_capacity_end', getTodayStr());
  forecastApplyCapacityTrackingUi();
}

function forecastApplyCapacityTrackingUi() {
  const trackLatest = Boolean(document.getElementById('forecast_capacity_track_latest')?.checked);
  const wrap = document.getElementById('forecast_capacity_end_wrap');
  if (!wrap) return;
  wrap.querySelectorAll('input:not([type="hidden"]), button').forEach(element => {
    element.disabled = trackLatest;
  });
  wrap.style.opacity = trackLatest ? '.6' : '';
  wrap.title = trackLatest ? '已跟踪今天，结束日期会每天自动更新' : '';
}

async function forecastSaveGoal() {
  const templateId = document.getElementById('forecast_goal_template')?.value || '';
  const template = getTaskTemplates().find(item => item.id === templateId);
  const name = document.getElementById('forecast_goal_name')?.value.trim() || '';
  const mode = forecastModeFromTemplate(template);
  const goals = getForecastGoals();
  const existingIndex = goals.findIndex(goal => goal.id === state.forecastEditingId);
  const existing = existingIndex >= 0 ? goals[existingIndex] : null;
  if (!template) { alert('请选择任务模板。'); return; }
  if (!name) { alert('请填写目标名称。'); return; }
  if (!mode) {
    alert('该模板没有开启命名章节记录或数量记录，不能创建完成预测目标。');
    return;
  }
  if (goals.some(goal => goal.templateId === templateId && goal.id !== existing?.id)) {
    alert('该模板已经绑定一个完成预测目标。每个模板只能绑定一个目标。');
    return;
  }
  if ((mode === 'quantity' || mode === 'chapterQuantity') && !template.quantityUnit) {
    alert('该模式要求模板先设置数量单位。请到模板库补充后再创建目标。');
    return;
  }

  const totalQuantity = Number(document.getElementById('forecast_goal_total')?.value);
  const namedMode = mode === 'chapter' || mode === 'chapterQuantity';
  const namedItems = namedMode ? forecastCollectNamedItems() : [];
  const activeNamedItems = namedItems.filter(item => !item.archived);
  if (mode === 'quantity' && (!Number.isInteger(totalQuantity) || totalQuantity <= 0)) {
    alert('总任务量必须是大于 0 的整数。');
    return;
  }
  if (namedMode) {
    if (!activeNamedItems.length) {
      alert('命名章节目标必须至少保留一个未归档章节。');
      return;
    }
    if (namedItems.some(item => !item.name)) {
      alert('章节名称不能为空。');
      return;
    }
    const normalizedNames = namedItems.map(item => item.name.toLocaleLowerCase());
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      alert('同一个预测目标内不能存在完全同名的章节。');
      return;
    }
  }

  const now = new Date().toISOString();
  const saved = {
    id: existing?.id || uid(),
    templateId,
    name,
    totalQuantity: mode === 'quantity' ? totalQuantity : null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (namedMode) {
    template.namedItems = namedItems;
    template.namedItemEnabled = true;
    template.ordinalEnabled = true;
  }
  if (existingIndex >= 0) goals[existingIndex] = saved;
  else goals.push(saved);
  state.forecastEditingId = saved.id;
  await saveAllStorage();
  renderForecast();
}

async function forecastDelete(id) {
  const goal = getForecastGoals().find(item => item.id === id);
  if (!goal || !confirm(`确定删除完成预测目标「${goal.name}」？任务记录不会被删除。`)) return;
  state.data.__forecastGoals__ = getForecastGoals().filter(item => item.id !== id);
  if (state.forecastEditingId === id) state.forecastEditingId = null;
  await saveAllStorage();
  renderForecast();
}

function forecastGoalFormHtml() {
  const goals = getForecastGoals();
  const editing = goals.find(goal => goal.id === state.forecastEditingId) || null;
  const templates = getTaskTemplates();
  const boundIds = new Set(goals.filter(goal => goal.id !== editing?.id).map(goal => goal.templateId));
  const editingTemplate = getTaskTemplates().find(template => template.id === editing?.templateId);
  const mode = forecastModeFromTemplate(editingTemplate);
  return `<div class="card forecast-editor">
    <div class="card-title">${editing ? '编辑预测目标' : '新建预测目标'}</div>
    ${templates.length ? `<div class="form-grid forecast-goal-grid">
      <div class="form-group">
        <label>任务模板 *</label>
        <select id="forecast_goal_template" onchange="forecastUpdateGoalFields(true)" ${editing ? 'disabled' : ''}>
          <option value="">-- 选择模板 --</option>
          ${templates.map(template => `<option value="${template.id}"
            ${template.id === editing?.templateId ? 'selected' : ''}
            ${boundIds.has(template.id) || !forecastModeFromTemplate(template) ? 'disabled' : ''}>${escHtmlApp(forecastTemplateLabel(template))}${boundIds.has(template.id) ? '（已绑定）' : !forecastModeFromTemplate(template) ? '（未开启单位）' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>目标名称 *</label>
        <input id="forecast_goal_name" value="${escHtmlApp(editing?.name || '')}" placeholder="例：完成数学800题">
      </div>
      <div class="form-group">
        <label>预测主目标</label>
        <input id="forecast_goal_primary_label" readonly value="${(editingTemplate?.namedItemEnabled ?? editingTemplate?.ordinalEnabled) ? `命名章节主目标${editingTemplate.quantityEnabled ? '（题数辅助估算）' : ''}` : editingTemplate?.quantityEnabled ? `数量主目标：${escHtmlApp(editingTemplate.quantityUnit)}` : '请先在模板库开启单位'}">
        <div class="form-hint">命名章节开启时始终以章节清单为主目标。</div>
      </div>
    </div>
    <div id="forecast_quantity_group" class="form-grid forecast-goal-grid">
      <div class="form-group" id="forecast_total_field">
        <label>总任务量 *</label>
        <input type="number" id="forecast_goal_total" min="1" step="1" value="${editing?.totalQuantity ?? ''}">
      </div>
      <div class="form-group">
        <label>数量单位</label>
        <input id="forecast_goal_unit" readonly value="${escHtmlApp(editingTemplate?.quantityUnit || '')}">
      </div>
    </div>
    <div id="forecast_chapter_group">
      ${forecastNamedItemsEditorHtml(editingTemplate?.namedItems || [], editingTemplate?.id || '')}
    </div>
    <div class="forecast-editor-actions">
      <button class="btn btn-success" onclick="forecastSaveGoal()">💾 保存预测目标</button>
      <button class="btn btn-ghost" onclick="forecastStartNew()">新建空白目标</button>
    </div>` : '<div class="empty-state"><p>请先在模板库建立任务模板。</p></div>'}
  </div>`;
}

function forecastDisplayMetric(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function forecastNamedItemProgressHtml(result) {
  if (!['chapter', 'chapterQuantity'].includes(result.goal.mode) || !Array.isArray(result.items)) return '';
  const quantityEnabled = result.goal.mode === 'chapterQuantity';
  return `<details style="margin-top:10px">
    <summary style="cursor:pointer;font-size:12px;color:var(--muted)">逐章进度（${result.items.length} 项）</summary>
    <div style="display:grid;gap:6px;max-height:360px;overflow-y:auto;margin-top:8px;padding-right:3px">
      ${result.items.map(item => {
        const hasProgress = item.minutes > 0 || item.quantity > 0;
        const stateLabel = item.completed ? '✓ 已完成' : hasProgress ? '进行中' : '未开始';
        const stateColor = item.completed ? 'var(--success)' : hasProgress ? 'var(--wake)' : 'var(--muted)';
        let estimate = '';
        if (!item.completed && result.ready) {
          estimate = quantityEnabled
            ? `预计剩余 ${forecastDisplayMetric(item.estimatedRemainingQuantity)} ${escHtmlApp(result.goal.quantityUnit)} · ${fmtMin(Math.ceil(item.estimatedRemainingMinutes), true)}`
            : `预计剩余 ${fmtMin(Math.ceil(item.estimatedRemainingMinutes), true)}`;
        }
        return `<div style="display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:8px;padding:8px;border:1px solid var(--border);border-radius:7px">
          <div>
            <b style="font-size:12px">${escHtmlApp(item.name)}</b>
            ${item.quantityExceededAverage ? '<div class="c-wake" style="font-size:10px;margin-top:3px">累计数量已达到平均值，但尚未勾选完成</div>' : ''}
          </div>
          <div style="text-align:right;font-size:11px">
            <div style="color:${stateColor}">${stateLabel}</div>
            <div class="c-muted">累计 ${forecastDisplayMetric(item.minutes)} 分钟${quantityEnabled ? ` · ${forecastDisplayMetric(item.quantity)} ${escHtmlApp(result.goal.quantityUnit)}` : ''}</div>
            ${estimate ? `<div>${estimate}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </details>`;
}

function forecastGoalCardsHtml(results) {
  if (!results.length) return '<div class="empty-state"><p>暂无预测目标。</p></div>';
  return `<div class="forecast-goal-list">${results.map(result => {
    const status = result.complete
      ? '<span class="forecast-status complete">已完成</span>'
      : result.ready
        ? `<span class="forecast-status ready">预计还需 ${fmtMin(Math.ceil(result.requiredMinutes), true)}</span>`
        : result.configurationInvalid
          ? '<span class="forecast-status insufficient">需要重新配置</span>'
          : '<span class="forecast-status insufficient">数据不足</span>';
    return `<div class="card forecast-goal-card">
      <div class="forecast-goal-head">
        <div>
          <b>${escHtmlApp(result.goal.name)}</b>
          <span>${escHtmlApp(forecastPrimaryTargetLabel(result.goal))}</span>
        </div>
        <div class="forecast-goal-actions">
          <button class="btn btn-ghost btn-sm" onclick="forecastEdit('${result.goal.id}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="forecastDelete('${result.goal.id}')">删除</button>
        </div>
      </div>
      <div class="forecast-progress"><span style="width:${Math.max(0, Math.min(100, result.progress)).toFixed(2)}%"></span></div>
      <div class="forecast-goal-stats">
        <span>${escHtmlApp(result.summary)}</span>
        <span>当前效率：${escHtmlApp(result.efficiency)}</span>
        ${result.excluded ? `<span class="c-wake">${result.excluded} 条记录未计入</span>` : ''}
      </div>
      ${status}
      ${result.warning ? `<div class="forecast-reason c-wake">${escHtmlApp(result.warning)}</div>` : ''}
      ${result.reason ? `<div class="forecast-reason">${escHtmlApp(result.reason)}</div>` : ''}
      ${forecastNamedItemProgressHtml(result)}
    </div>`;
  }).join('')}</div>`;
}

function renderForecast() {
  const host = document.getElementById('tab-forecast');
  if (!host) return;
  const templateManager = document.getElementById('template-named-items-manager');
  if (templateManager) templateManager.innerHTML = '';
  const settings = getForecastSettings();
  const capacityEndDate = settings.capacityTrackLatest ? getTodayStr() : settings.capacityEndDate;
  const results = getForecastGoals().map(calculateForecastGoal);
  const overall = calculateForecastOverall(results);
  const capacity = overall.capacity;
  host.innerHTML = `<div class="forecast-page">
    <div class="forecast-heading">
      <div>
        <h2>📅 完成预测</h2>
        <p>按模板隔离历史进度和效率，将全部目标换算为剩余时间。</p>
      </div>
    </div>
    <div class="forecast-overall-grid">
      <div class="card forecast-overall-primary">
        <div class="stat-label">全部目标预计完成日</div>
        <div class="forecast-date">${escHtmlApp(overall.label)}</div>
        <div class="stat-sub">${overall.totalMinutes == null ? '请先补足目标所需历史数据' : `剩余约 ${fmtMin(Math.ceil(overall.totalMinutes), true)}`}</div>
      </div>
      <div class="card">
        <div class="form-group">
          <label>每日可用学习时长来源</label>
          <select id="forecast_capacity_mode" onchange="forecastToggleCapacityMode()" style="margin-bottom:10px">
            <option value="range" ${settings.capacityMode === 'range' ? 'selected' : ''}>按统计范围计算日均</option>
            <option value="manual" ${settings.capacityMode === 'manual' ? 'selected' : ''}>手动设置每日时长</option>
          </select>
          <div id="forecast_capacity_range_panel" style="${settings.capacityMode === 'manual' ? 'display:none' : ''}">
            <label style="display:flex;align-items:center;gap:7px;margin:2px 0 9px;font-weight:400">
              <input type="checkbox" id="forecast_capacity_track_latest"
                ${settings.capacityTrackLatest ? 'checked' : ''}
                onchange="forecastToggleCapacityTracking()">
              跟踪今天（结束日期每天自动更新）
            </label>
            <div class="forecast-capacity-range">
              ${editableDateInputHtml('forecast_capacity_start', settings.capacityStartDate)}
              <span>至</span>
              ${editableDateInputHtml('forecast_capacity_end', capacityEndDate)}
              <button class="btn btn-primary btn-sm" onclick="forecastSaveCapacityRange()">计算并保存</button>
            </div>
            <div class="form-hint">
              当前统计 ${capacity.source === 'range' ? capacity.startDate || '-' : settings.capacityStartDate} 至 ${capacity.source === 'range' ? capacity.endDate || '-' : capacityEndDate} ·
              有效 ${capacity.source === 'range' ? capacity.eligibleDays : '-'} 天 · 排除不评分 ${capacity.source === 'range' ? capacity.excludedDays : '-'} 天 ·
              累计实际 ${capacity.source === 'range' ? fmtMin(Math.round(capacity.totalActualMinutes), true) : '-'} ·
              日均实际 ${capacity.source === 'range' ? fmtMin(Math.round(capacity.averageMinutes), true) : '切换并保存后计算'}
            </div>
            <div class="form-hint">${settings.capacityTrackLatest ? '正在持续跟踪：开始日期保持不变，结束日期会在每天打开本页时自动变为当天。' : '当前为固定范围；启用“跟踪今天”后结束日期将自动前移。'}</div>
          </div>
          <div id="forecast_capacity_manual_panel" style="${settings.capacityMode === 'manual' ? '' : 'display:none'}">
            <div class="forecast-capacity-range">
              <input type="number" id="forecast_manual_daily_minutes" min="1" max="1440" step="1"
                value="${settings.manualDailyMinutes || ''}" placeholder="例如 480">
              <span>分钟 / 天</span>
              <button class="btn btn-primary btn-sm" onclick="forecastSaveCapacityRange()">保存并计算</button>
            </div>
            <div class="form-hint">当前手动每日时长：${settings.manualDailyMinutes > 0 ? fmtMin(settings.manualDailyMinutes, true) : '尚未设置'}。</div>
          </div>
          <div class="form-hint">标记为“不参与评分”的日期不会进入历史日均，也不会分配预测学习时长。</div>
          <div class="form-hint">今天已完成实际学习 ${overall.todayUsed} 分钟；预测会先扣除今天已经使用的时间。</div>
        </div>
      </div>
    </div>
    ${forecastGoalFormHtml()}
    ${forecastGoalCardsHtml(results)}
  </div>`;
  requestAnimationFrame(() => {
    forecastUpdateGoalFields();
    forecastToggleCapacityMode();
    forecastApplyCapacityTrackingUi();
  });
}

// ============================================================
// WORKBOOK REVIEW TAB
// ============================================================
function getWorkbookReviews() {
  if (!Array.isArray(state.data.__workbookReviews__)) state.data.__workbookReviews__ = [];
  return state.data.__workbookReviews__;
}

function createWorkbookDraft() {
  return {
    title: '',
    subject: '',
    completedDate: getTodayStr(),
    note: '',
    sections: [createWorkbookSection()],
  };
}

function createWorkbookSection() {
  return { id: uid(), name: '', totalQuestions: '', wrongAnswers: '', note: '' };
}

function cloneWorkbookReview(review) {
  return JSON.parse(JSON.stringify(review));
}

function ensureWorkbookDraft() {
  if (state.workbookDraft) return;
  const reviews = getWorkbookReviews();
  const selected = reviews.find(review => review.id === state.workbookReviewId) || reviews[0];
  if (selected) {
    state.workbookReviewId = selected.id;
    state.workbookDraft = cloneWorkbookReview(selected);
  } else {
    state.workbookReviewId = null;
    state.workbookDraft = createWorkbookDraft();
  }
}

function workbookMetric(section) {
  const total = Number(section?.totalQuestions) || 0;
  // 旧版输入框名为 correctAnswers，但用户实际按错题数录入；兼容读取后统一保存为 wrongAnswers。
  const wrong = Number(section?.wrongAnswers ?? section?.correctAnswers) || 0;
  const correct = Math.max(0, total - wrong);
  return {
    total,
    correct,
    wrong,
    accuracy: total > 0 ? correct / total * 100 : 0,
    errorRate: total > 0 ? wrong / total * 100 : 0,
  };
}

function workbookTotals(sections) {
  const totals = (sections || []).reduce((sum, section) => {
    const metric = workbookMetric(section);
    sum.total += metric.total;
    sum.correct += metric.correct;
    sum.wrong += metric.wrong;
    return sum;
  }, { total: 0, correct: 0, wrong: 0 });
  totals.accuracy = totals.total > 0 ? totals.correct / totals.total * 100 : 0;
  totals.errorRate = totals.total > 0 ? totals.wrong / totals.total * 100 : 0;
  return totals;
}

function workbookPct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function workbookUniqueTitle(requestedTitle, editingId = null) {
  const titles = new Set(
    getWorkbookReviews()
      .filter(review => review.id !== editingId)
      .map(review => String(review.title || '').trim())
      .filter(Boolean)
  );
  if (!titles.has(requestedTitle)) return requestedTitle;
  const baseTitle = requestedTitle.replace(/（副本\d+）$/, '');
  let copyNumber = 1;
  while (titles.has(`${baseTitle}（副本${copyNumber}）`)) copyNumber++;
  return `${baseTitle}（副本${copyNumber}）`;
}

function workbookSetMeta(field, value) {
  ensureWorkbookDraft();
  state.workbookDraft[field] = value;
}

function workbookSetSection(index, field, value) {
  ensureWorkbookDraft();
  const section = state.workbookDraft.sections[index];
  if (!section) return;
  section[field] = value;
  updateWorkbookCalculations();
  if (field === 'name') workbookRefreshSectionPrediction();
}

function workbookAddSection(name = '') {
  ensureWorkbookDraft();
  const section = createWorkbookSection();
  section.name = String(name || '');
  state.workbookDraft.sections.push(section);
  renderWorkbookReview();
  setTimeout(() => {
    const input = document.getElementById(`workbook-section-name-${state.workbookDraft.sections.length - 1}`);
    input?.focus();
    if (name) input?.select();
  }, 0);
}

function workbookSectionPrediction() {
  ensureWorkbookDraft();
  const names = state.workbookDraft.sections
    .map(section => String(section?.name || '').trim())
    .filter(Boolean);
  const lastName = names[names.length - 1] || '';
  return {
    lastName,
    predictedName: inferNextNamedItemName(lastName, names),
  };
}

function workbookRefreshSectionPrediction() {
  const button = document.getElementById('workbook-section-predict');
  const hint = document.getElementById('workbook-section-predict-hint');
  if (!button || !hint) return;
  const { lastName, predictedName } = workbookSectionPrediction();
  button.disabled = !predictedName;
  button.textContent = predictedName ? `⚡＋ ${predictedName}` : '⚡＋预测下一项';
  hint.textContent = predictedName ? '' : (lastName ? '当前名称无法推测下一项' : '请先填写一个分段名称');
}

function workbookAddPredictedSection() {
  const { predictedName } = workbookSectionPrediction();
  if (predictedName) workbookAddSection(predictedName);
}

function workbookRemoveSection(index) {
  ensureWorkbookDraft();
  if (state.workbookDraft.sections.length <= 1) {
    alert('每份整册复盘至少需要一个分段。');
    return;
  }
  state.workbookDraft.sections.splice(index, 1);
  renderWorkbookReview();
}

function workbookStartNew() {
  state.workbookReviewId = null;
  state.workbookDraft = createWorkbookDraft();
  renderWorkbookReview();
}

function workbookOpenReview(id) {
  const review = getWorkbookReviews().find(item => item.id === id);
  if (!review) return;
  state.workbookReviewId = id;
  state.workbookDraft = cloneWorkbookReview(review);
  renderWorkbookReview();
}

function workbookResetDraft() {
  const review = getWorkbookReviews().find(item => item.id === state.workbookReviewId);
  state.workbookDraft = review ? cloneWorkbookReview(review) : createWorkbookDraft();
  if (!review) state.workbookReviewId = null;
  renderWorkbookReview();
}

function workbookValidateDraft(draft) {
  if (!String(draft.title || '').trim()) return '请填写资料标题。';
  if (!String(draft.subject || '').trim()) return '请填写学科。';
  if (!String(draft.completedDate || '').trim()) return '请选择完成日期。';
  if (!Array.isArray(draft.sections) || draft.sections.length === 0) return '至少需要一个分段。';

  for (let index = 0; index < draft.sections.length; index++) {
    const section = draft.sections[index];
    const total = Number(section.totalQuestions);
    const wrong = Number(section.wrongAnswers ?? section.correctAnswers);
    const label = `第 ${index + 1} 行`;
    if (!String(section.name || '').trim()) return `${label}缺少分段名称。`;
    if (!Number.isInteger(total) || total <= 0) return `${label}的总题数必须是大于 0 的整数。`;
    if (!Number.isInteger(wrong) || wrong < 0) return `${label}的错误数必须是非负整数。`;
    if (wrong > total) return `${label}的错误数不能超过总题数。`;
  }
  return '';
}

async function workbookSave() {
  ensureWorkbookDraft();
  const validationError = workbookValidateDraft(state.workbookDraft);
  if (validationError) {
    alert(validationError);
    return;
  }

  const reviews = getWorkbookReviews();
  const existingIndex = reviews.findIndex(review => review.id === state.workbookReviewId);
  const existing = existingIndex >= 0 ? reviews[existingIndex] : null;
  const now = new Date().toISOString();
  const requestedTitle = String(state.workbookDraft.title).trim();
  const title = workbookUniqueTitle(requestedTitle, existing?.id || null);
  const saved = {
    id: existing?.id || uid(),
    title,
    subject: String(state.workbookDraft.subject).trim(),
    completedDate: String(state.workbookDraft.completedDate).trim(),
    note: String(state.workbookDraft.note || '').trim(),
    sections: state.workbookDraft.sections.map(section => ({
      id: section.id || uid(),
      name: String(section.name).trim(),
      totalQuestions: Number(section.totalQuestions),
      wrongAnswers: Number(section.wrongAnswers ?? section.correctAnswers),
      note: String(section.note || '').trim(),
    })),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex >= 0) reviews[existingIndex] = saved;
  else reviews.push(saved);
  state.workbookReviewId = saved.id;
  state.workbookDraft = cloneWorkbookReview(saved);
  await saveAllStorage();
  renderWorkbookReview();
  const message = document.getElementById('workbook-save-message');
  if (message) {
    message.textContent = title === requestedTitle
      ? '✅ 整册复盘已保存'
      : `✅ 已保存为「${title}」`;
    setTimeout(() => { message.textContent = ''; }, 3500);
  }
}

async function workbookDelete(id) {
  const review = getWorkbookReviews().find(item => item.id === id);
  if (!review || !confirm(`确定删除整册复盘「${review.title}」？`)) return;
  state.data.__workbookReviews__ = getWorkbookReviews().filter(item => item.id !== id);
  if (state.workbookReviewId === id) {
    state.workbookReviewId = null;
    state.workbookDraft = null;
  }
  await saveAllStorage();
  renderWorkbookReview();
}

function workbookCardsHtml(reviews) {
  if (!reviews.length) {
    return '<div class="empty-state workbook-empty"><p>暂无整册复盘，点击右上角新建第一份。</p></div>';
  }
  return reviews.map(review => {
    const totals = workbookTotals(review.sections);
    const active = review.id === state.workbookReviewId;
    return `<div class="workbook-card ${active ? 'active' : ''}">
      <button class="workbook-card-main" onclick="workbookOpenReview('${review.id}')">
        <b>${escHtmlApp(review.title || '未命名资料')}</b>
        <span>${escHtmlApp(review.subject || '未填写学科')} · ${escHtmlApp(review.completedDate || '-')}</span>
        <span>${totals.total} 题 · 错 ${totals.wrong} 题 · 错误率 ${workbookPct(totals.errorRate)}</span>
      </button>
      <button class="btn btn-danger btn-sm" onclick="workbookDelete('${review.id}')">删除</button>
    </div>`;
  }).join('');
}

function workbookSectionsHtml(sections) {
  return sections.map((section, index) => {
    const metric = workbookMetric(section);
    return `<tr>
      <td class="fw-mono c-muted">${index + 1}</td>
      <td><input id="workbook-section-name-${index}" value="${escHtmlApp(section.name || '')}" placeholder="例：第一章、卷二、P20-35" oninput="workbookSetSection(${index},'name',this.value)"></td>
      <td><input type="number" min="1" step="1" value="${section.totalQuestions ?? ''}" oninput="workbookSetSection(${index},'totalQuestions',this.value)"></td>
      <td><input type="number" min="0" step="1" value="${section.wrongAnswers ?? section.correctAnswers ?? ''}" oninput="workbookSetSection(${index},'wrongAnswers',this.value)"></td>
      <td class="fw-mono" id="workbook-correct-${index}">${metric.correct}</td>
      <td class="fw-mono" id="workbook-accuracy-${index}">${workbookPct(metric.accuracy)}</td>
      <td class="fw-mono" id="workbook-error-rate-${index}">${workbookPct(metric.errorRate)}</td>
      <td><input value="${escHtmlApp(section.note || '')}" placeholder="可选" oninput="workbookSetSection(${index},'note',this.value)"></td>
      <td><button class="btn btn-danger btn-sm" onclick="workbookRemoveSection(${index})">删除</button></td>
    </tr>`;
  }).join('');
}

function renderWorkbookReview() {
  ensureWorkbookDraft();
  const reviews = getWorkbookReviews();
  const draft = state.workbookDraft;
  const totals = workbookTotals(draft.sections);
  const sectionPrediction = workbookSectionPrediction();
  const host = document.getElementById('tab-workbookReview');
  if (!host) return;

  host.innerHTML = `
    <div class="workbook-page">
      <div class="workbook-heading">
        <div>
          <h2>📚 整册复盘</h2>
          <p>整本练习册、教材或题库完成后，按章节、单元、试卷或页段汇总题量和错题情况。</p>
        </div>
        <button class="btn btn-primary" onclick="workbookStartNew()">＋ 新建复盘</button>
      </div>

      <div class="workbook-list">${workbookCardsHtml(reviews)}</div>

      <div class="card workbook-editor">
        <div class="card-title">${state.workbookReviewId ? '编辑整册复盘' : '新建整册复盘'}</div>
        <div class="form-grid workbook-meta-grid">
          <div class="form-group">
            <label>资料标题 *</label>
            <input value="${escHtmlApp(draft.title || '')}" placeholder="例：肖秀荣1000题" oninput="workbookSetMeta('title',this.value)">
          </div>
          <div class="form-group">
            <label>学科 *</label>
            <input value="${escHtmlApp(draft.subject || '')}" placeholder="例：政治、数学" oninput="workbookSetMeta('subject',this.value)">
          </div>
          <div class="form-group">
            <label>完成日期 *</label>
            ${editableDateInputHtml('workbook_completed_date', draft.completedDate || '', "workbookSetMeta('completedDate',document.getElementById('workbook_completed_date').value)")}
          </div>
          <div class="form-group">
            <label>整册备注</label>
            <input value="${escHtmlApp(draft.note || '')}" placeholder="可选" oninput="workbookSetMeta('note',this.value)">
          </div>
        </div>

        <div class="workbook-summary-grid">
          <div class="mini-card"><div class="lbl">总题数</div><div class="val" id="workbook-total">${totals.total}</div></div>
          <div class="mini-card"><div class="lbl">正确数</div><div class="val c-green" id="workbook-correct">${totals.correct}</div></div>
          <div class="mini-card"><div class="lbl">错题数</div><div class="val c-red" id="workbook-wrong">${totals.wrong}</div></div>
          <div class="mini-card"><div class="lbl">正确率</div><div class="val c-green" id="workbook-accuracy">${workbookPct(totals.accuracy)}</div></div>
          <div class="mini-card"><div class="lbl">错误率</div><div class="val c-red" id="workbook-error-rate">${workbookPct(totals.errorRate)}</div></div>
        </div>

        <div class="table-wrap workbook-table-wrap">
          <table class="workbook-table">
            <thead><tr><th>#</th><th>分段名称 *</th><th>总题数 *</th><th>错误数 *</th><th>正确数</th><th>正确率</th><th>错误率</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>${workbookSectionsHtml(draft.sections)}</tbody>
          </table>
        </div>
        <div class="workbook-editor-actions">
          <button class="btn btn-primary btn-sm" onclick="workbookAddSection()" title="新增空白分段">＋ 新增空白分段</button>
          <button type="button" id="workbook-section-predict" class="btn btn-ghost btn-sm"
            onclick="workbookAddPredictedSection()" ${sectionPrediction.predictedName ? '' : 'disabled'}>
            ${sectionPrediction.predictedName ? `⚡＋ ${escHtmlApp(sectionPrediction.predictedName)}` : '⚡＋预测下一项'}
          </button>
          <span id="workbook-section-predict-hint" class="form-hint" style="margin:0">
            ${sectionPrediction.predictedName ? '' : (sectionPrediction.lastName ? '当前名称无法推测下一项' : '请先填写一个分段名称')}
          </span>
          <button class="btn btn-success" onclick="workbookSave()">💾 保存整册复盘</button>
          <button class="btn btn-ghost" onclick="workbookResetDraft()">撤销未保存修改</button>
          <span id="workbook-save-message"></span>
        </div>
      </div>

      <div class="card workbook-chart-card">
        <div class="card-title">章节题量与错误率</div>
        <canvas id="workbookReviewChart" height="110"></canvas>
      </div>
    </div>`;

  requestAnimationFrame(renderWorkbookChart);
}

function updateWorkbookCalculations() {
  ensureWorkbookDraft();
  state.workbookDraft.sections.forEach((section, index) => {
    const metric = workbookMetric(section);
    const correct = document.getElementById(`workbook-correct-${index}`);
    const accuracy = document.getElementById(`workbook-accuracy-${index}`);
    const errorRate = document.getElementById(`workbook-error-rate-${index}`);
    if (correct) correct.textContent = metric.correct;
    if (accuracy) accuracy.textContent = workbookPct(metric.accuracy);
    if (errorRate) errorRate.textContent = workbookPct(metric.errorRate);
  });
  const totals = workbookTotals(state.workbookDraft.sections);
  const values = {
    'workbook-total': totals.total,
    'workbook-correct': totals.correct,
    'workbook-wrong': totals.wrong,
    'workbook-accuracy': workbookPct(totals.accuracy),
    'workbook-error-rate': workbookPct(totals.errorRate),
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  renderWorkbookChart();
}

function renderWorkbookChart() {
  if (!document.getElementById('workbookReviewChart') || !state.workbookDraft) return;
  const sections = state.workbookDraft.sections || [];
  mkChart('workbookReviewChart', {
    type: 'bar',
    data: {
      labels: sections.map((section, index) => String(section.name || '').trim() || `分段 ${index + 1}`),
      datasets: [
        {
          label: '总题数',
          data: sections.map(section => workbookMetric(section).total),
          backgroundColor: 'rgba(79,195,247,.45)',
          borderColor: '#4fc3f7',
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: '错误率',
          data: sections.map(section => Number(workbookMetric(section).errorRate.toFixed(2))),
          borderColor: '#ef9a9a',
          backgroundColor: '#ef9a9a',
          pointRadius: 4,
          borderWidth: 2,
          tension: .25,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label(context) {
              return context.dataset.yAxisID === 'y1'
                ? `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)}%`
                : `${context.dataset.label}: ${context.parsed.y} 题`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e' }, grid: gridCfg },
        y: {
          beginAtZero: true,
          position: 'left',
          title: { display: true, text: '题数' },
          ticks: { precision: 0 },
          grid: gridCfg,
        },
        y1: {
          beginAtZero: true,
          min: 0,
          max: 100,
          position: 'right',
          title: { display: true, text: '错误率 (%)' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// ============================================================
// INIT
// ============================================================
async function init() {
  chartDefaults();
  applyThemeColors(SETTINGS);
  await loadStorage();
  migrateOldTypes();
  migrateForecastUnitModel();
  migrateTaskTemplateIds();
  await saveAllStorage();
  await loadServerSnapshot();

  const sd = strToDate(state.selectedDate);
  state.cal = { year: sd.getFullYear(), month: sd.getMonth() };
  state.monthView = { year: sd.getFullYear(), month: sd.getMonth() };

  showTab(state.tab || 'entry');
  startDraftAutoSave();
}

document.addEventListener('DOMContentLoaded', init);
let _lastSnapshotFlush = 0;
function flushSnapshotOnExit() {
  if (![30000, 60000].includes(Number(SETTINGS.snapshotInterval))) return;
  const now = Date.now();
  if (now - _lastSnapshotFlush < 250) return;
  _lastSnapshotFlush = now;
  try {
    const snapshot = buildServerSnapshot();
    saveLocalSnapshotCache(snapshot);
    state._serverSnapshot = snapshot;
    const payload = JSON.stringify(snapshot);
    navigator.sendBeacon('/api/snapshot', new Blob([payload], { type: 'application/json' }));
  } catch (error) { }
}
window.addEventListener('beforeunload', flushSnapshotOnExit);
window.addEventListener('pagehide', flushSnapshotOnExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSnapshotOnExit();
});
