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
  // 数据存储
  snapshotInterval: 30000,
  useLocalStorageCache: true,
  carrySessionEndToStart: false,
  durationDisplayUnit: 'hours',
  questionEfficiencyDisplay: 'perMinute',
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
      settings.useLocalStorageCache = true;
      settings.carrySessionEndToStart = settings.carrySessionEndToStart === true;
      if (!['hours', 'minutes'].includes(settings.durationDisplayUnit)) settings.durationDisplayUnit = 'hours';
      if (!['perMinute', 'minutesPerQuestion'].includes(settings.questionEfficiencyDisplay)) settings.questionEfficiencyDisplay = 'perMinute';
      delete settings.autosaveInterval;
      [
        'utilPassPct', 'focusGoodPct', 'focusOkPct',
        'ratingActualMin', 'ratingDeviationPct', 'ratingWakeLimit', 'ratingUtilPct',
        'ratingStarThreshold', 'ratingOkThreshold', 'ratingWarnThreshold',
        'wakeGoodMinute', 'wakeWarnMinute', 'sleepGoodHour', 'sleepWarnHour',
        'dailyGoalHours', 'wakeGoalHour', 'sleepGoalHour', 'weekStartDay',
      ].forEach(key => delete settings[key]);
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
  efficiency: '🎯 专注效率\n实际专注占有效时段时长的比例，用于描述这段时间中实际专注所占的比重。\n\n普通时段：实际专注 ÷ (时钟时长 − 休息时间)\n特殊学习时段：只用实际专注进入分母，不用完整时钟跨度\n不可用时段：不参与专注效率',
  rest: '😴 休息时间\n该时段内的计划休息时长（如番茄钟间隔休息、课间休息等），手动录入。\n\n公式：∑ 各时段休息分钟数（手动输入合计）',
  distract: '😶 分心时间\n时钟时长中扣除实际专注和休息后的剩余时间，反映走神/摸鱼的时长。\n\n公式：时钟时长 − 实际专注 − 休息时间',
  awake: '🌤 清醒时长\n从起床到睡觉的总时长，是当天可用于学习与生活的全部时间。需要录入起床和睡觉时间后才能计算。\n\n公式：睡觉时间 − 起床时间（跨午夜自动修正）',
  util: '📊 不可用时间占比\n不可用时长占清醒时长的比例，表示一天清醒时间中有多少被吃饭、通勤、外出等特殊时段占用；它不用于衡量专注效率。\n\n公式：不可用时长 ÷ 清醒时长 × 100%\n不可用时长包括普通特殊时段的完整跨度，以及特殊学习时段中未学习的部分。',
  deviation: '📉 偏差率（实际 vs 名义）\n实际专注与名义时长的差值比，反映真实专注量 vs 计划目标的差距。\n\n正值 = 超额完成计划\n负值 = 未达计划（走神多或提前结束）\n\n公式：(实际专注 − 名义时长) ÷ 名义时长 × 100%',
  clockDev: '⚡ 时钟偏差（学习口径时钟 vs 名义）\n普通专注跨度与特殊学习实际分钟之和，与名义时长相比的偏差。完全不可用时段不会混入计划偏差。\n\n正值 = 学习口径时钟超过计划\n负值 = 比计划提前结束\n\n公式：(普通专注时钟 + 特殊学习实际分钟 − 名义时长) ÷ 名义时长 × 100%',
  sessRate: '🎯 专注率（单时段）\n该时段的实际专注占有效时段时长的比例，反映单次时段的专注密度。\n\n普通时段：实际专注 ÷ (时钟时长 − 休息时间)\n特殊学习时段：只计实际专注，完整时钟跨度不进入分母\n不可用时段：不参与专注率',
  taskMin: '📝 任务记录时长\n任务记录板中所有任务的时长总和。任务板与时段统计相互独立，用于记录具体的学习内容和数量。',
  taskActualDeviation: '📐 任务/实际误差\n比较每天任务记录总时长与实际专注总时长。正值表示任务时长高于实际专注，负值表示任务时长低于实际专注。实际专注为 0 的日期不参与统计。\n\n每日误差率：(任务时长 − 实际专注) ÷ 实际专注 × 100%\n平均误差率：有效日期的每日误差率算术平均\nCV：标准差 ÷ |平均误差率|',
  // 堆积图专用
  stackAwake: '🌤 清醒总时长\n所选时间范围内每天清醒时长（起床→睡觉）的总和。\n只计算同时录入了起床和睡觉时间的天数。\n\n公式：∑ (睡觉时间 − 起床时间)',
  stackTask: '📝 任务记录总时长\n所选时间范围内「任务记录板」中所有任务时长的总和。\n按活动类别（一级分类）分组后堆叠在面积图最底层。\n\n公式：∑ 所有任务的 minutes 字段',
  stackSpecial: '🔸 不可用时段总时长\n所选时间范围内完全不可学习的特殊时段，以及特殊学习时段中未学习部分的总和。\n包括吃饭、通勤、外出等，按名称分组堆叠。',
  stackRest: '😴 休息时间\n所选时间范围内所有「普通专注时段」中录入的休息时长总和。\n例如番茄钟间隔、课间休息等计划内休息。\n不包括特殊时段。\n\n公式：∑ (type≠special 的 session 的 restMinutes)',
  stackDistract: '😶 分心时间\n所选时间范围内所有「普通专注时段」中，时钟时长扣除实际专注和休息后的剩余时间。\n反映在专注时段内走神、摸鱼、看手机等非计划消耗。\n\n公式：∑ (时钟时长 − 实际专注 − 休息时间)\n仅统计 type≠special 的普通 session',
  stackIdle: '⬜ 空闲/未记录时间\n清醒时长中，扣除「任务记录时长 + 特殊时段 + 休息 + 分心」后的剩余时间。\n代表没有被任何记录覆盖的时间段，可能是：\n· 忘记录入的学习时间\n· 日常琐事（洗漱、整理等）\n· 真正的空闲放松时间\n\n公式：清醒时长 − 任务时长 − 特殊时段 − 休息 − 分心\n\n注意：如果任务和专注时段有重叠记录，\n空闲时间可能被低估甚至出现负值（会被截断为0）',
  // 统计指标
  stdDev: '📏 标准差 (σ)\n衡量数据围绕均值的分散程度。\n标准差越大，说明每天的波动越大。\n\n公式：σ = √(Σ(xi − μ)² / n)',
  cv: '📊 变异系数 (CV)\n标准差与均值的比值，用百分比表示，可用于比较不同指标的相对离散程度。\n\n公式：CV = σ / μ × 100%',
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
const TABLE_SORT_STATE = Object.create(null);
let tableSortObserver = null;

function sortableTableHeaderHtml(tableId, key, labelHtml, type = 'number', className = '') {
  const active = TABLE_SORT_STATE[tableId]?.key === key ? TABLE_SORT_STATE[tableId] : null;
  const indicator = active ? (active.direction === 'asc' ? '↑' : '↓') : '';
  const ariaSort = active ? (active.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th${className ? ` class="${className}"` : ''} data-sort-key="${key}" data-sort-type="${type}" aria-sort="${ariaSort}"><button type="button" class="table-sort-button${active ? ' active' : ''}" onclick="cycleTableSort('${tableId}','${key}','${type}')"><span class="table-sort-label">${labelHtml}</span><span class="table-sort-indicator" aria-hidden="true">${indicator}</span></button></th>`;
}

function sortableTableRowAttrs(values, origin) {
  return `data-sort-values="${encodeURIComponent(JSON.stringify(values || {}))}" data-sort-origin="${origin}"`;
}

function tableSortRowValues(row) {
  try { return JSON.parse(decodeURIComponent(row.dataset.sortValues || '%7B%7D')); }
  catch (error) { return {}; }
}

function tableSortValueMissing(value) {
  if (Array.isArray(value)) return value.length === 0 || tableSortValueMissing(value[0]);
  return value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
}

function compareTableSortValues(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? left : [left];
    const rightValues = Array.isArray(right) ? right : [right];
    const length = Math.max(leftValues.length, rightValues.length);
    for (let index = 0; index < length; index++) {
      const leftValue = leftValues[index];
      const rightValue = rightValues[index];
      const leftMissing = tableSortValueMissing(leftValue);
      const rightMissing = tableSortValueMissing(rightValue);
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (leftMissing) continue;
      const compared = compareTableSortValues(leftValue, rightValue);
      if (compared) return compared;
    }
    return 0;
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).localeCompare(String(right), 'zh-Hans', { numeric: true });
  }
  return Number(left) - Number(right);
}

function applyTableSort(table) {
  if (!table?.tBodies?.length) return;
  const tableId = table.dataset.sortTable;
  let current = TABLE_SORT_STATE[tableId] || null;
  if (current && ![...table.querySelectorAll('thead th[data-sort-key]')].some(header => header.dataset.sortKey === current.key)) {
    delete TABLE_SORT_STATE[tableId];
    current = null;
  }
  const rows = [...table.tBodies[0].rows].map((row, index) => {
    if (!row.hasAttribute('data-sort-origin')) row.dataset.sortOrigin = String(index);
    return { row, origin: Number(row.dataset.sortOrigin) || 0, values: tableSortRowValues(row) };
  });
  rows.sort((left, right) => {
    if (!current) return left.origin - right.origin;
    const leftValue = left.values[current.key];
    const rightValue = right.values[current.key];
    const leftMissing = tableSortValueMissing(leftValue);
    const rightMissing = tableSortValueMissing(rightValue);
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return left.origin - right.origin;
    const compared = compareTableSortValues(leftValue, rightValue);
    return compared ? (current.direction === 'asc' ? compared : -compared) : left.origin - right.origin;
  });
  rows.forEach(item => table.tBodies[0].appendChild(item.row));
  table.querySelectorAll('thead th[data-sort-key]').forEach(header => {
    const active = current?.key === header.dataset.sortKey;
    header.setAttribute('aria-sort', active ? (current.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    const button = header.querySelector('.table-sort-button');
    const indicator = header.querySelector('.table-sort-indicator');
    button?.classList.toggle('active', active);
    if (indicator) indicator.textContent = active ? (current.direction === 'asc' ? '↑' : '↓') : '';
  });
}

function cycleTableSort(tableId, key, type = 'number') {
  const firstDirection = type === 'number' ? 'desc' : 'asc';
  const current = TABLE_SORT_STATE[tableId];
  if (!current || current.key !== key) {
    TABLE_SORT_STATE[tableId] = { key, type, direction: firstDirection };
  } else if (current.direction === firstDirection) {
    TABLE_SORT_STATE[tableId] = { key, type, direction: firstDirection === 'asc' ? 'desc' : 'asc' };
  } else {
    delete TABLE_SORT_STATE[tableId];
  }
  const table = [...document.querySelectorAll('table[data-sort-table]')].find(item => item.dataset.sortTable === tableId);
  applyTableSort(table);
}

function restoreSortableTablesIn(root) {
  if (!root || root.nodeType !== 1) return;
  const tables = new Set();
  if (root.matches?.('table[data-sort-table]')) tables.add(root);
  root.querySelectorAll?.('table[data-sort-table]').forEach(table => tables.add(table));
  tables.forEach(table => {
    if (TABLE_SORT_STATE[table.dataset.sortTable]) applyTableSort(table);
  });
}

function startSortableTableObserver() {
  if (tableSortObserver || typeof MutationObserver === 'undefined') return;
  tableSortObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => mutation.addedNodes.forEach(node => restoreSortableTablesIn(node)));
  });
  tableSortObserver.observe(document.body, { childList: true, subtree: true });
}

const state = {
  data: {},
  selectedDate: getTodayStr(),
  tab: 'entry',
  cal: { year: new Date().getFullYear(), month: new Date().getMonth() },
  rangeChartViews: {
    overview: { time: 'daily', task: 'daily' },
  },
  analysisRanges: {
    overview: { mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false, hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(), hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '' },
    stacked: { mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false, hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(), hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '' },
    session: { mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false, hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(), hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '' },
    task: { mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false, hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(), hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '' },
    sleep: { mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false, hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(), hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '' },
  },
  exportDataRange: '30d',
  exportCustomStart: '',
  exportCustomEnd: '',
  sleepWakeDistributionGranularity: 3,
  sleepBedtimeDistributionGranularity: 3,
  sleepWakeDistributionView: 'pie',
  sleepBedtimeDistributionView: 'pie',
  sleepTimelineView: 'daily',
  sleepFocusView: 'duration',
  sleepUtilView: 'daily',
  _editingSessionId: null,
  _sessType: 'normal',
  _editingTaskId: null,
  forecastEditingId: null,
  forecastCategoryFilter: { level1: '', level2: '', level3: '' },
  workbookReviewId: null,
  workbookDraft: null,
  workbookReviewQuery: '',
  workbookReviewSort: 'updatedDesc',
  workbookChartView: 'questions',
  visualColorEditorGroup: 'level1',
  visualColorEditorParentL1: '',
  visualColorEditorParentL2: '',
  visualColorEditorDraft: null,
  visualColorEditorDirty: false,
  templateLibraryView: 'task',
  templateAuditOpen: false,
  _serverSnapshot: null,
  _pendingSnapshotRestore: false,
  _taskFilter: {},  // { entry: '类别', day: '类别' }
  stackedGroupLevel: 1, // 1=一级, 2=二级, 3=三级
  stackedMergeTasks: false,
  stackedMergeSpecials: false,
  stackedChartView: 'absolute',
  stackedHiddenSeries: [],
  sessAna: {
    mode: 'week',
    typeFilter: '',
    catFilter: '',
    trendView: 'daily',
    durationBasis: 'clock',
    durationCategory: '',
    durationBinSize: 30,
    detailCategory: '',
    hiddenSeries: [],
  },
  taskAna: {
    mode: 'week',
    level: 1,
    effScale: 'linear',
    effYMax: '',
    catFilter: '',
    effCatFilter: '',
    effLevel1: '',
    effLevel2: '',
    effLevel3: '',
    chapterEffTemplateId: '',
    durationView: 'daily',
    countView: 'daily',
    chapterMetric: 'minutes',
    chapterView: 'single',
    efficiencyView: 'daily',
    hiddenSeries: { duration: [], efficiency: [] },
    taskDetailLevel1: '',
    taskDetailLevel2: '',
    taskDetailLevel3: '',
    distributionLevel1: '',
    distributionLevel2: '',
    distributionLevel3: '',
    distributionMetric: 'duration',
    distributionUnit: '',
    distributionGranularity: 3,
  },
  analysis: {
    startDate: '',
    endDate: '',
    includeExcluded: false,
    dayTypeFilter: '',
    createStartDate: '',
    createEndDate: '',
    createDayTypeFilter: '',
    createIncludeExcluded: false,
    createLoading: false,
    scoreTrendView: 'daily',
    config: null,
    cards: [],
    activeCardId: '',
    trackingCards: [],
    activeTrackingCardId: '',
    activeTrackingPlanEndDate: '',
    trackingCardSaveOpen: false,
    trackingCardName: '',
    savingTrackingCard: false,
    trackingCardStorageSupported: null,
    cardStorageSupported: null,
    cardSaveOpen: false,
    cardName: '',
    savingCard: false,
    snapshotDraft: null,
    result: null,
    loading: false,
    message: '',
  },
};

// ============================================================
// TASK FILTER HELPERS
// ============================================================
function isTaskUnclassified(task) {
  const activityType = String(task?.activityType || '').trim();
  const storedTemplateId = String(task?.templateId || '').trim();
  const missingTemplate = Boolean(storedTemplateId) && !resolveTaskTemplateId(task);
  return !activityType || activityType === '未分类' || missingTemplate;
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
  const renders = { entry: renderEntry, day: renderDayOverview };
  if (renders[viewId]) renders[viewId]();
}

function initEntryTaskColumnResize() {
  const table = document.getElementById('entryTaskTable');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')];
  if (!headers.length) return;
  const minWidths = [46, 120, 120, 72, 72, 80, 96, 80, 100, 112];
  const preferredWidths = [56, 260, 220, 100, 110, 130, 150, 110, 220, 140];
  const maxWidths = [72, 360, 300, 150, 160, 180, 200, 160, 320, 180];

  const colgroup = document.createElement('colgroup');
  const cols = headers.map(() => {
    const col = document.createElement('col');
    colgroup.appendChild(col);
    return col;
  });
  table.insertBefore(colgroup, table.firstChild);

  const storedWidths = Array.isArray(state._entryTaskColumnWidths)
    && state._entryTaskColumnWidths.length === headers.length
    ? state._entryTaskColumnWidths
    : preferredWidths;
  const savedWidths = headers.map((header, index) => {
    const fallback = preferredWidths[index] || Math.ceil(header.getBoundingClientRect().width);
    const width = Number(storedWidths[index]) || fallback;
    return Math.min(maxWidths[index] || 320, Math.max(minWidths[index] || 64, Math.round(width)));
  });
  state._entryTaskColumnWidths = [...savedWidths];
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
      const minWidth = minWidths[index] || 64;
      const maxWidth = maxWidths[index] || 320;
      document.body.classList.add('resizing-task-column');

      const onMove = moveEvent => {
        const nextWidth = Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX)));
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
const ENTRY_SESSION_DRAFT_KEYS = [
  'sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m',
  'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note',
];
const ENTRY_TASK_DRAFT_KEYS = [
  'task_name', 'task_tmpl', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom',
  'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit',
  'task_new_ordinal_unit', 'task_template_ordinal_unit', 'task_wrong', 'task_acc', 'task_new_score_max',
  'task_note', 'task_new_ordinal_enabled', 'task_new_quantity_enabled', 'task_new_accuracy_enabled', 'task_new_score_enabled',
  'task_ordinal_numbers', 'task_completed_ordinals', 'task_named_item_allocations',
  'task_chapter_numbers', 'task_completed_chapters',
];

function saveCurrentEntryDraft(dateStr = state.selectedDate) {
  if (state.tab === 'entry' && document.getElementById('taskForm')) {
    saveDraft(dateStr, collectEntryDraft());
  }
}

function clearEntryDraftFields(dateStr, fieldKeys) {
  const draft = state.tab === 'entry' && document.getElementById('taskForm')
    ? collectEntryDraft()
    : (loadDraft(dateStr) || {});
  fieldKeys.forEach(key => { delete draft[key]; });
  draft._savedAt = new Date().toISOString();
  saveDraft(dateStr, draft);
  if (state._serverSnapshot?.entryDraftDate === dateStr) {
    state._serverSnapshot.entryDraft = draft;
  }
}

function setNextSessionStartDraft(dateStr, timeStr) {
  const parts = String(timeStr || '').split(':');
  if (parts.length < 2) return;
  const draft = loadDraft(dateStr) || {};
  draft.sess_start_h = String(parts[0] || '').padStart(2, '0');
  draft.sess_start_m = String(parts[1] || '').padStart(2, '0');
  draft._savedAt = new Date().toISOString();
  saveDraft(dateStr, draft);
  if (state._serverSnapshot?.entryDraftDate === dateStr) {
    state._serverSnapshot.entryDraft = draft;
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
  const wakeNoteEl = document.getElementById('wakeNoteInput');
  if (wakeNoteEl) draft.wakeNote = wakeNoteEl.value;
  const sleepNoteEl = document.getElementById('sleepNoteInput');
  if (sleepNoteEl) draft.sleepNote = sleepNoteEl.value;
  const noteEl = document.getElementById('dayNoteInput');
  if (noteEl) draft.dayNote = noteEl.value;
  ['sess_name', 'sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest', 'sess_note'].forEach(id => {
    const el = document.getElementById(id); if (el) draft[id] = el.value;
  });
  ['task_name', 'task_tmpl', 'task_l1', 'task_l1_custom', 'task_l2', 'task_l2_custom', 'task_l3', 'task_l3_custom', 'task_min', 'task_qty', 'task_unit', 'task_new_ordinal_unit', 'task_template_ordinal_unit', 'task_wrong', 'task_acc', 'task_new_score_max', 'task_note'].forEach(id => {
    const el = document.getElementById(id); if (el) draft[id] = el.value;
  });
  draft.task_new_ordinal_enabled = Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  draft.task_new_quantity_enabled = Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
  draft.task_new_accuracy_enabled = Boolean(document.getElementById('task_new_accuracy_enabled')?.checked);
  draft.task_new_score_enabled = Boolean(document.getElementById('task_new_score_enabled')?.checked);
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
  ['tmpl-form-body', 'sess-tmpl-form-body-unavailable', 'sess-tmpl-form-body-special-study', 'day-type-tmpl-form-body'].forEach(id => {
    const element = document.getElementById(id);
    if (element && element.style.display !== 'none') ids.push(id);
  });
  return ids;
}

function buildAnalysisSnapshotDraft() {
  const analysis = state.analysis;
  if (!analysis) return null;
  const hasDraft = Boolean(
    analysis.config
    || analysis.startDate
    || analysis.endDate
    || analysis.dayTypeFilter
    || analysis.createStartDate
    || analysis.createEndDate
    || analysis.createDayTypeFilter
    || analysis.activeCardId
    || analysis.cardName,
  );
  if (!hasDraft) return null;
  return {
    version: 1,
    startDate: analysis.startDate || '',
    endDate: analysis.endDate || '',
    includeExcluded: analysis.includeExcluded === true,
    dayTypeFilter: analysis.dayTypeFilter || '',
    createStartDate: analysis.createStartDate || '',
    createEndDate: analysis.createEndDate || '',
    createDayTypeFilter: analysis.createDayTypeFilter || '',
    createIncludeExcluded: analysis.createIncludeExcluded === true,
    scoreTrendView: analysis.scoreTrendView === 'cumulative' ? 'cumulative' : 'daily',
    activeCardId: analysis.activeCardId || '',
    activeTrackingCardId: analysis.activeTrackingCardId || '',
    activeTrackingPlanEndDate: analysis.activeTrackingPlanEndDate || '',
    trackingCardName: analysis.trackingCardName || '',
    trackingCardSaveOpen: analysis.trackingCardSaveOpen === true,
    cardName: analysis.cardName || '',
    cardSaveOpen: analysis.cardSaveOpen === true,
    config: analysis.config ? analysisCloneConfig(analysis.config) : null,
  };
}

function restoreAnalysisSnapshotDraft(draft) {
  if (!draft || typeof draft !== 'object') return false;
  const analysis = state.analysis;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  if (validDate(draft.startDate)) analysis.startDate = draft.startDate;
  if (validDate(draft.endDate)) analysis.endDate = draft.endDate;
  if (validDate(draft.createStartDate)) analysis.createStartDate = draft.createStartDate;
  if (validDate(draft.createEndDate)) analysis.createEndDate = draft.createEndDate;
  analysis.includeExcluded = draft.includeExcluded === true;
  analysis.dayTypeFilter = typeof draft.dayTypeFilter === 'string'
    ? draft.dayTypeFilter
    : (analysis.includeExcluded ? DAY_TYPE_ALL_FILTER : '');
  analysis.createDayTypeFilter = typeof draft.createDayTypeFilter === 'string'
    ? normalizeAnalysisDayTypeFilter(draft.createDayTypeFilter)
    : '';
  analysis.createIncludeExcluded = draft.createIncludeExcluded === true;
  analysis.scoreTrendView = draft.scoreTrendView === 'cumulative' ? 'cumulative' : 'daily';
  const restoredCard = typeof draft.activeCardId === 'string' ? analysisCardById(draft.activeCardId) : null;
  const restoredTrackingCard = typeof draft.activeTrackingCardId === 'string' ? analysisTrackingCardById(draft.activeTrackingCardId) : null;
  analysis.activeCardId = restoredCard?.id || '';
  analysis.activeTrackingCardId = restoredTrackingCard?.id || '';
  analysis.activeTrackingPlanEndDate = restoredTrackingCard?.endDate || '';
  if (analysis.activeTrackingCardId && analysis.activeTrackingPlanEndDate) {
    analysis.endDate = analysisTrackingEffectiveEnd(restoredTrackingCard);
  }
  if (typeof draft.trackingCardName === 'string') analysis.trackingCardName = draft.trackingCardName;
  analysis.trackingCardSaveOpen = draft.trackingCardSaveOpen === true;
  if (typeof draft.cardName === 'string') analysis.cardName = draft.cardName;
  analysis.cardSaveOpen = draft.cardSaveOpen === true;
  if (draft.config && typeof draft.config === 'object') {
    analysis.config = analysisCloneConfig(draft.config);
  }
  analysis.result = null;
  return Boolean(analysis.config);
}

function buildServerSnapshot() {
  let entryDraft = loadDraft(state.selectedDate);
  if (state.tab === 'entry') {
    entryDraft = collectEntryDraft();
    saveDraft(state.selectedDate, entryDraft);
  }
  return {
    version: 2,
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
    analysisDraft: buildAnalysisSnapshotDraft(),
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
  const restoredTab = ['week', 'month'].includes(snapshot.tab) ? 'overview' : snapshot.tab;
  const validTabs = ['entry', 'calendar', 'day', 'overview', 'stacked', 'sessAnalysis', 'taskAnalysis', 'sleep', 'export', 'templates', 'forecast', 'workbookReview', 'analysis', 'settings'];
  if (validTabs.includes(restoredTab)) state.tab = restoredTab;
  state._editingSessionId = snapshot.editingSessionId || null;
  state._editingTaskId = snapshot.editingTaskId || null;
  state._sessType = snapshot.sessionType || 'normal';
  state.forecastEditingId = snapshot.forecastEditingId || null;
  state.workbookReviewId = snapshot.workbookReviewId || null;
  if (snapshot.workbookDraft) state.workbookDraft = snapshot.workbookDraft;
  if (snapshot.analysisDraft && typeof snapshot.analysisDraft === 'object') {
    state.analysis.snapshotDraft = snapshot.analysisDraft;
  }
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
  const localSnapshot = loadLocalSnapshotCache();
  let remoteSnapshot = null;
  if (Number(SETTINGS.snapshotInterval) !== 0) {
    try {
      remoteSnapshot = await apiFetch('/api/snapshot');
    } catch (error) {
      console.warn('后端快照读取失败，继续使用本地草稿', error);
    }
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
    if (draft.wakeNote) { const el = document.getElementById('wakeNoteInput'); if (el && !el.value) el.value = draft.wakeNote; }
    if (draft.sleepNote) { const el = document.getElementById('sleepNoteInput'); if (el && !el.value) el.value = draft.sleepNote; }
    if (draft.dayNote) { const el = document.getElementById('dayNoteInput'); if (el && !el.value) el.value = draft.dayNote; }
    if (draft.task_tmpl) {
      const templateEl = document.getElementById('task_tmpl');
      if (templateEl) {
        templateEl.value = draft.task_tmpl;
        renderForecastTaskFields(draft.task_tmpl, {
          ordinalNumbers: draft.task_ordinal_numbers || draft.task_chapter_numbers || [],
          completedOrdinals: draft.task_completed_ordinals || draft.task_completed_chapters || [],
          namedItemAllocations: draft.task_named_item_allocations || [],
        });
        configureTaskUnitFields(draft.task_tmpl);
      }
    } else if (draft.task_new_ordinal_enabled || draft.task_new_quantity_enabled || draft.task_new_accuracy_enabled || draft.task_new_score_enabled ||
      (draft.task_ordinal_numbers || []).length) {
      renderForecastTaskFields('', {
        ordinalEnabled: draft.task_new_ordinal_enabled,
        namedItemEnabled: draft.task_new_ordinal_enabled,
        quantityEnabled: draft.task_new_quantity_enabled,
        accuracyEnabled: draft.task_new_accuracy_enabled,
        scoreEnabled: draft.task_new_score_enabled,
        scoreMax: draft.task_new_score_max,
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
    updateSessionClockPreview();
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
  openCustomDatePicker(picker);
}

const customDatePickerState = {
  input: null,
  year: 0,
  month: 0,
  initialized: false,
};

function customDatePickerPanel() {
  let panel = document.getElementById('custom-date-picker');
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = 'custom-date-picker';
  panel.className = 'custom-date-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '选择日期');
  document.body.appendChild(panel);
  return panel;
}

function customDatePickerDayInfo(dateStr) {
  const day = state.data?.[dateStr] || {};
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  const sessions = Array.isArray(day.sessions) ? day.sessions : [];
  const typeMeta = dayTypeDisplayMeta(day);
  // Keep this aligned with calendarDayMeta: opening a calendar month creates
  // blank day placeholders, which must never be shown as recorded content.
  const hasData = Boolean(
    sessions.length
    || tasks.length
    || day.wakeTime
    || day.sleepTime
    || typeMeta.name
    || day.excludeFromRating
  );
  return { day, hasData, typeMeta };
}

function customDatePickerDateAllowed(dateStr) {
  const input = customDatePickerState.input;
  if (!input) return false;
  if (input.min && dateStr < input.min) return false;
  if (input.max && dateStr > input.max) return false;
  return true;
}

function customDatePickerTypeLegendHtml(typeOptions) {
  if (!typeOptions.length) return '<div class="custom-date-picker-type-list empty">尚未设置日期类型</div>';
  return `<div class="custom-date-picker-type-list"><b>日期类型</b>${typeOptions.map(option => `<span class="custom-date-picker-type-key" style="--date-type-color:${escHtmlApp(option.color)}"><i>${escHtmlApp(option.symbol)}</i><strong>${escHtmlApp(option.name)}</strong>${option.excluded ? '<small class="excluded">不参与评分</small>' : ''}</span>`).join('')}</div>`;
}

function customDatePickerYears() {
  const input = customDatePickerState.input;
  const selectedYear = Number((normalizeEditableDate(input?.value) || getTodayStr()).slice(0, 4));
  const currentYear = new Date().getFullYear();
  const storedYears = Object.keys(state.data || {})
    .filter(dateStr => /^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    .map(dateStr => Number(dateStr.slice(0, 4)));
  const knownYears = [selectedYear, currentYear, ...storedYears].filter(Number.isFinite);
  const minYear = input?.min ? Number(input.min.slice(0, 4)) : Math.min(...knownYears, currentYear - 5);
  const maxYear = input?.max ? Number(input.max.slice(0, 4)) : Math.max(...knownYears, currentYear + 5);
  return Array.from({ length: Math.max(1, maxYear - minYear + 1) }, (_, index) => minYear + index);
}

function customDatePickerRender() {
  const input = customDatePickerState.input;
  if (!input) return;
  const panel = customDatePickerPanel();
  const selected = normalizeEditableDate(input.value) || getTodayStr();
  const today = getTodayStr();
  const cursor = new Date(customDatePickerState.year, customDatePickerState.month, 1);
  const firstOffset = (cursor.getDay() + 6) % 7;
  const typeOptions = dayTypeFilterOptions();
  const yearOptions = customDatePickerYears();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), index - firstOffset + 1);
    const dateStr = dateToStr(date);
    const info = customDatePickerDayInfo(dateStr);
    const outside = date.getMonth() !== cursor.getMonth();
    const unavailable = !customDatePickerDateAllowed(dateStr);
    const titleParts = [formatDisplay(dateStr)];
    if (info.hasData) titleParts.push('已录入');
    if (info.typeMeta.name) titleParts.push(`${info.typeMeta.symbol} ${info.typeMeta.name}${info.typeMeta.excluded ? ' · 不评分' : ''}`);
    const classes = [
      'custom-date-picker-day',
      outside ? 'outside' : '',
      dateStr === selected ? 'selected' : '',
      dateStr === today ? 'today' : '',
      info.hasData ? 'has-data' : '',
      info.typeMeta.name ? 'typed' : '',
      info.typeMeta.excluded ? 'excluded' : '',
      unavailable ? 'filtered' : '',
    ].filter(Boolean).join(' ');
    const markers = [
      info.hasData ? '<i class="custom-date-picker-record" aria-label="已录入"></i>' : '',
      info.typeMeta.name ? `<span class="custom-date-picker-type" style="--date-type-color:${escHtmlApp(info.typeMeta.color)}" title="${escHtmlApp(info.typeMeta.symbol)} ${escHtmlApp(info.typeMeta.name)}">${escHtmlApp(info.typeMeta.symbol)}</span>` : '',
    ].join('');
    return `<button type="button" class="${classes}" title="${escHtmlApp(titleParts.join(' · '))}" ${unavailable ? 'disabled' : ''} onclick="customDatePickerSelect('${dateStr}')"><span>${date.getDate()}</span><em>${markers}</em></button>`;
  }).join('');
  panel.innerHTML = `<header class="custom-date-picker-head"><button type="button" class="custom-date-picker-nav" aria-label="上个月" onclick="customDatePickerMoveMonth(-1)">‹</button><div class="custom-date-picker-jump"><select aria-label="选择年份" onchange="customDatePickerSetYear(this.value)">${yearOptions.map(year => `<option value="${year}" ${year === cursor.getFullYear() ? 'selected' : ''}>${year} 年</option>`).join('')}</select><select aria-label="选择月份" onchange="customDatePickerSetMonth(this.value)">${Array.from({ length: 12 }, (_, month) => `<option value="${month}" ${month === cursor.getMonth() ? 'selected' : ''}>${month + 1} 月</option>`).join('')}</select></div><div><button type="button" class="custom-date-picker-today" onclick="customDatePickerGoToday()">今天</button><button type="button" class="custom-date-picker-nav" aria-label="下个月" onclick="customDatePickerMoveMonth(1)">›</button></div></header><div class="custom-date-picker-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="custom-date-picker-grid">${cells}</div><footer class="custom-date-picker-legend"><div class="custom-date-picker-basic-legend"><span><i class="custom-date-picker-record"></i>已录入</span></div>${customDatePickerTypeLegendHtml(typeOptions)}<small>点击日期即可选择</small></footer>`;
}

function customDatePickerPosition() {
  const input = customDatePickerState.input;
  const panel = document.getElementById('custom-date-picker');
  if (!input || !panel) return;
  const rect = input.getBoundingClientRect();
  panel.style.visibility = 'hidden';
  panel.style.left = '0px';
  panel.style.top = '0px';
  const width = panel.offsetWidth || 350;
  const height = panel.offsetHeight || 420;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  const below = rect.bottom + 8;
  const top = below + height <= window.innerHeight ? below : Math.max(8, rect.top - height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.visibility = 'visible';
}

function openCustomDatePicker(input) {
  if (!input || input.disabled) return;
  const selected = normalizeEditableDate(input.value) || getTodayStr();
  const date = strToDate(selected);
  customDatePickerState.input = input;
  customDatePickerState.year = date.getFullYear();
  customDatePickerState.month = date.getMonth();
  customDatePickerRender();
  customDatePickerPosition();
}

function closeCustomDatePicker() {
  customDatePickerState.input = null;
  document.getElementById('custom-date-picker')?.remove();
}

function customDatePickerMoveMonth(delta) {
  const cursor = new Date(customDatePickerState.year, customDatePickerState.month + Number(delta || 0), 1);
  customDatePickerState.year = cursor.getFullYear();
  customDatePickerState.month = cursor.getMonth();
  customDatePickerRender();
  customDatePickerPosition();
}

function customDatePickerGoToday() {
  const date = strToDate(getTodayStr());
  customDatePickerState.year = date.getFullYear();
  customDatePickerState.month = date.getMonth();
  customDatePickerRender();
  customDatePickerPosition();
}

function customDatePickerSetYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return;
  customDatePickerState.year = year;
  customDatePickerRender();
  customDatePickerPosition();
}

function customDatePickerSetMonth(value) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 0 || month > 11) return;
  customDatePickerState.month = month;
  customDatePickerRender();
  customDatePickerPosition();
}

function customDatePickerSelect(dateStr) {
  if (!customDatePickerDateAllowed(dateStr)) return;
  const input = customDatePickerState.input;
  closeCustomDatePicker();
  if (!input) return;
  input.value = dateStr;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function initCustomDatePicker() {
  if (customDatePickerState.initialized) return;
  customDatePickerState.initialized = true;
  const interceptNativeDateInput = event => {
    const input = event.target instanceof Element ? event.target.closest('input[type="date"]') : null;
    if (!input || input.disabled) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (customDatePickerState.input !== input) openCustomDatePicker(input);
    return true;
  };
  document.addEventListener('pointerdown', event => {
    const panel = document.getElementById('custom-date-picker');
    if (panel?.contains(event.target)) return;
    if (interceptNativeDateInput(event)) return;
    closeCustomDatePicker();
  }, true);
  // Chromium may schedule the built-in picker after pointerdown. Block every
  // mouse activation phase so only the application picker can open.
  document.addEventListener('mousedown', interceptNativeDateInput, true);
  document.addEventListener('click', interceptNativeDateInput, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && customDatePickerState.input) {
      event.preventDefault();
      closeCustomDatePicker();
      return;
    }
    const input = event.target instanceof Element ? event.target.closest('input[type="date"]') : null;
    if (input && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      openCustomDatePicker(input);
    }
  }, true);
  document.addEventListener('scroll', () => closeCustomDatePicker(), true);
  window.addEventListener('resize', () => closeCustomDatePicker());
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
  if (SETTINGS.durationDisplayUnit === 'minutes') return `${sign}${Number(abs.toFixed(2))}m`;
  return `${sign}${Number((abs / 60).toFixed(2))}h`;
}
function fmtHrs(m) { return fmtMin(m, true); }

function durationDisplayUnitLabel() {
  return SETTINGS.durationDisplayUnit === 'minutes' ? '分钟' : '小时';
}

function durationDisplayUnitSuffix() {
  return SETTINGS.durationDisplayUnit === 'minutes' ? 'm' : 'h';
}

function durationDisplayValue(minutes, digits = 2) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return null;
  const converted = SETTINGS.durationDisplayUnit === 'minutes' ? value : value / 60;
  return Number(converted.toFixed(digits));
}

function durationDisplayValueToMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return SETTINGS.durationDisplayUnit === 'minutes' ? number : number * 60;
}

function questionEfficiencyUsesMinutesPerQuestion() {
  return SETTINGS.questionEfficiencyDisplay === 'minutesPerQuestion';
}

function questionEfficiencyUnitLabel(unit = '题') {
  const itemUnit = String(unit || '题').trim() || '题';
  return questionEfficiencyUsesMinutesPerQuestion() ? `分钟/${itemUnit}` : `${itemUnit}/分钟`;
}

function questionEfficiencyDisplayValue(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return null;
  return questionEfficiencyUsesMinutesPerQuestion() ? 1 / value : value;
}

function formatQuestionEfficiency(rate, unit = '题', digits = 3) {
  const displayValue = questionEfficiencyDisplayValue(rate);
  return displayValue == null ? '-' : `${displayValue.toFixed(digits)} ${questionEfficiencyUnitLabel(unit)}`;
}

function questionEfficiencyInputValue(rate) {
  const displayValue = questionEfficiencyDisplayValue(rate);
  return displayValue == null ? '' : Number(displayValue.toFixed(3));
}

function storedQuestionEfficiencyValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (!questionEfficiencyUsesMinutesPerQuestion() || number === 0) return number;
  return 1 / number;
}

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
function sessionClock(s) {
  const a = parseMin(s.startTime), b = parseMin(s.endTime);
  if (a == null || b == null) return 0;
  let d = b - a; if (d < 0) d += 1440; return d;
}

function sessionTimingValidationIssues({
  sessionType = 'normal',
  startTime = '',
  endTime = '',
  nominalMinutes = null,
  actualMinutes = null,
  restMinutes = null,
} = {}) {
  const issues = [];
  if (!startTime || !endTime || startTime === endTime) {
    issues.push('开始时间和结束时间必须有效且不能相同');
    return issues;
  }
  const clockMinutes = sessionClock({ startTime, endTime });
  if (clockMinutes <= 0) {
    issues.push('无法计算有效的时钟时长');
    return issues;
  }
  if (sessionType === 'normal') {
    const hasRestMinutes = restMinutes !== null && restMinutes !== undefined && restMinutes !== '';
    const effectiveRestMinutes = hasRestMinutes ? restMinutes : 0;
    if (!Number.isInteger(nominalMinutes) || nominalMinutes <= 0) {
      issues.push('名义专注必须是大于 0 的整数分钟');
    }
    if (!Number.isInteger(actualMinutes) || actualMinutes <= 0) {
      issues.push('实际专注必须是大于 0 的整数分钟');
    }
    if (hasRestMinutes && (!Number.isInteger(restMinutes) || restMinutes < 0)) {
      issues.push('休息时间如有填写，必须是非负整数分钟');
    }
    if (Number.isInteger(actualMinutes) && actualMinutes > clockMinutes) {
      issues.push(`实际专注 ${actualMinutes} 分钟不能超过时钟时长 ${clockMinutes} 分钟`);
    }
    if (Number.isInteger(nominalMinutes) && nominalMinutes > clockMinutes) {
      issues.push(`名义专注 ${nominalMinutes} 分钟不能超过时钟时长 ${clockMinutes} 分钟`);
    }
    if (Number.isInteger(nominalMinutes) && Number.isInteger(actualMinutes) &&
      actualMinutes > nominalMinutes) {
      issues.push(`实际专注 ${actualMinutes} 分钟不能超过名义专注 ${nominalMinutes} 分钟`);
    }
    if (Number.isInteger(nominalMinutes) && Number.isInteger(effectiveRestMinutes) &&
      nominalMinutes + effectiveRestMinutes > clockMinutes) {
      issues.push(
        `名义专注 ${nominalMinutes} 分钟加休息 ${effectiveRestMinutes} 分钟不能超过时钟时长 ${clockMinutes} 分钟`
      );
    }
  } else if (sessionType === 'special-study') {
    if (!Number.isInteger(actualMinutes) || actualMinutes <= 0) {
      issues.push('特殊学习时段必须填写大于 0 的整数实际专注分钟');
    } else if (actualMinutes > clockMinutes) {
      issues.push(`实际专注 ${actualMinutes} 分钟不能超过时钟时长 ${clockMinutes} 分钟`);
    }
  }
  return issues;
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
  return pct == null ? 'c-muted' : 'c-text';
}
function devStr(pct) {
  if (pct == null) return '-';
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function actualFocusDeviationPct(actualMinutes, averageActualMinutes) {
  const actual = Number(actualMinutes);
  const average = Number(averageActualMinutes);
  if (!Number.isFinite(actual) || !Number.isFinite(average) || average <= 0) return null;
  return (actual / average - 1) * 100;
}

function actualFocusAverageBeforeDate(dateStr) {
  const priorDates = getAllDates().filter(date => date < dateStr && isEffectiveRecordDay(date));
  if (!priorDates.length) return null;
  const totalActual = priorDates.reduce((sum, date) => sum + (Number(computeDay(date).actualMin) || 0), 0);
  return totalActual / priorDates.length;
}

function actualFocusDeviationBoxHtml(pct, averageActualMinutes) {
  if (!Number.isFinite(pct)) return '<span class="actual-focus-deviation-box c-muted">—</span>';
  const rounded = Math.round(pct * 10) / 10;
  const className = rounded > 0 ? 'c-green' : rounded < 0 ? 'c-red' : 'c-muted';
  const title = `比较基准：日均实际专注 ${fmtMin(Math.round(Number(averageActualMinutes) || 0), true)}`;
  return `<span class="actual-focus-deviation-box ${className}" title="${title}">${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}%</span>`;
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
      oninput="sanitizeTimeDigits(this);updateSessionClockPreview('${idPrefix}')"
      onkeydown="handleTimeInputKeydown(event,'${idPrefix}','h')">
    <span class="time-sep">:</span>
    <input type="text" inputmode="numeric" maxlength="2" autocomplete="off" aria-autocomplete="none"
      id="${idPrefix}_m" placeholder="分" value="${m}"
      oninput="sanitizeTimeDigits(this);updateSessionClockPreview('${idPrefix}')"
      onkeydown="handleTimeInputKeydown(event,'${idPrefix}','m')">
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
  updateSessionClockPreview(idPrefix);
}

function currentTimeInputValue(idPrefix) {
  const hourInput = document.getElementById(`${idPrefix}_h`);
  const minuteInput = document.getElementById(`${idPrefix}_m`);
  if (!hourInput || !minuteInput || hourInput.value === '' || minuteInput.value === '') return '';
  const hour = Number(hourInput.value);
  const minute = Number(minuteInput.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function updateSessionClockPreview(changedPrefix = '') {
  if (changedPrefix && !['sess_start', 'sess_end'].includes(changedPrefix)) return;
  const value = document.getElementById('sess_clock_preview_value');
  const detail = document.getElementById('sess_clock_preview_detail');
  const host = document.getElementById('sess_clock_preview');
  if (!value || !detail || !host) return;
  const startTime = currentTimeInputValue('sess_start');
  const endTime = currentTimeInputValue('sess_end');
  host.classList.remove('valid', 'invalid');
  if (!startTime || !endTime) {
    value.textContent = '—';
    detail.textContent = '填完开始和结束时间后自动计算';
    return;
  }
  if (startTime === endTime) {
    host.classList.add('invalid');
    value.textContent = '无效';
    detail.textContent = '开始时间和结束时间不能相同';
    return;
  }
  const minutes = sessionClock({ startTime, endTime });
  const crossesMidnight = parseMin(endTime) < parseMin(startTime);
  host.classList.add('valid');
  value.textContent = fmtMin(minutes, true);
  detail.textContent = `${fmtMin(minutes, true)}${crossesMidnight ? ' · 跨午夜' : ''}`;
}
function handleTimeInputKeydown(event, idPrefix, part) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const target = event.target;
  const value = String(target?.value || '');
  const atStart = Number(target?.selectionStart) === 0 && Number(target?.selectionEnd) === 0;
  const atEnd = Number(target?.selectionStart) === value.length && Number(target?.selectionEnd) === value.length;
  const nextPart = event.key === 'ArrowRight' && part === 'h' && atEnd
    ? 'm'
    : event.key === 'ArrowLeft' && part === 'm' && atStart
      ? 'h'
      : '';
  if (!nextPart) return;
  event.preventDefault();
  normalizeTimeInputPair(idPrefix);
  const next = document.getElementById(`${idPrefix}_${nextPart}`);
  if (!next) return;
  next.focus();
  if (typeof next.select === 'function') next.select();
}
function handleSessionTimingKeydown(event) {
  if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const sequence = ['sess_start_h', 'sess_start_m', 'sess_end_h', 'sess_end_m', 'sess_nominal', 'sess_actual', 'sess_rest'];
  const currentId = event.target?.id || '';
  const currentIndex = sequence.indexOf(currentId);
  if (currentIndex < 0) return;
  const target = event.target;
  const value = String(target?.value || '');
  const hasTextSelection = typeof target?.selectionStart === 'number' && typeof target?.selectionEnd === 'number';
  const atStart = hasTextSelection ? target.selectionStart === 0 && target.selectionEnd === 0 : true;
  const atEnd = hasTextSelection ? target.selectionStart === value.length && target.selectionEnd === value.length : true;
  const nextIndex = event.key === 'ArrowRight' && atEnd
    ? currentIndex + 1
    : event.key === 'ArrowLeft' && atStart
      ? currentIndex - 1
      : currentIndex;
  if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= sequence.length) return;
  event.preventDefault();
  const timePrefix = currentId.startsWith('sess_start') ? 'sess_start' : currentId.startsWith('sess_end') ? 'sess_end' : '';
  if (timePrefix) normalizeTimeInputPair(timePrefix);
  const next = document.getElementById(sequence[nextIndex]);
  if (!next) return;
  next.focus();
  if (typeof next.select === 'function') next.select();
}

function isVisibleSaveButton(button) {
  if (!button || button.disabled) return false;
  if (button.offsetParent === null && getComputedStyle(button).position !== 'fixed') return false;
  return /(保存|更新)/.test(String(button.textContent || ''));
}

function findNearestSaveButton(element) {
  const scopes = [
    '.form-panel',
    '.entry-inline-panel',
    '.template-editor-panel',
    '.forecast-editor-panel',
    '.forecast-capacity-panel',
    '.workbook-editor-panel',
    '.settings-card',
    '.card',
    'section',
    'aside',
  ];
  for (const selector of scopes) {
    const scope = element.closest?.(selector);
    if (!scope) continue;
    const button = [...scope.querySelectorAll('button')].find(isVisibleSaveButton);
    if (button) return button;
  }
  return null;
}

function handleGlobalEnterSave(event) {
  if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const target = event.target;
  if (!target || target.closest?.('[data-enter-save-disabled="true"]')) return;
  const tagName = String(target.tagName || '').toLowerCase();
  if (tagName !== 'input') return;
  if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(String(target.type || '').toLowerCase())) return;
  const saveButton = findNearestSaveButton(target);
  if (!saveButton) return;
  event.preventDefault();
  saveButton.click();
}

document.addEventListener('keydown', handleGlobalEnterSave);

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
// Aliases for compatibility
function getAllLevel2Names() { return getCatList(2); }
function getAllLevel3Names() { return getCatList(3); }

async function addCatItem(level, name) {
  if (!name || !name.trim()) return;
  name = name.trim();
  const list = getCatList(level);
  if (!list.includes(name)) {
    list.push(name);
    ensureVisualCategoryColor(level, name, list.length - 1);
  }
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
// Backward compat: getActivityTypes returns flat list of all L1 names
function getActivityTypes() { return getLevel1Names(); }

// ============================================================
// SESSION TEMPLATES (特殊专注时段模板)
// ============================================================
function getSessionTemplates() {
  if (!state.data.__sessionTemplates__) state.data.__sessionTemplates__ = [];
  return state.data.__sessionTemplates__;
}

function normalizeSessionTemplateType(value) {
  return value === 'special-study' ? 'special-study' : 'special';
}

function migrateSessionTemplateTypes() {
  const usage = new Map();
  Object.entries(state.data).forEach(([dateStr, day]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Array.isArray(day?.sessions)) return;
    day.sessions.forEach(sessionRecord => {
      if (!isUnavailableSession(sessionRecord) && !isSpecialStudySession(sessionRecord)) return;
      const name = String(sessionRecord.name || '').trim();
      if (!name) return;
      if (!usage.has(name)) usage.set(name, new Set());
      usage.get(name).add(isSpecialStudySession(sessionRecord) ? 'special-study' : 'special');
    });
  });
  let changed = false;
  getSessionTemplates().forEach(template => {
    if (['special', 'special-study'].includes(template.sessionType)) return;
    const types = usage.get(String(template.name || '').trim()) || new Set();
    template.sessionType = types.size === 1 && types.has('special-study') ? 'special-study' : 'special';
    changed = true;
  });
  return changed;
}

async function addSessionTemplate(tmpl) {
  tmpl.id = uid();
  tmpl.sessionType = normalizeSessionTemplateType(tmpl.sessionType);
  getSessionTemplates().push(tmpl);
  await saveAllStorage();
}

async function deleteSessionTemplate(id) {
  state.data.__sessionTemplates__ = getSessionTemplates().filter(t => t.id !== id);
  await saveAllStorage();
}

async function saveSessionTemplate(tmpl) {
  tmpl.sessionType = normalizeSessionTemplateType(tmpl.sessionType);
  const list = getSessionTemplates();
  const idx = list.findIndex(t => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  await saveAllStorage();
}

// ============================================================
// DAY TYPE TEMPLATES (日期类型模板)
// ============================================================
const DAY_TYPE_SYMBOLS = [
  { key: 'diamond', glyph: '◆', label: '菱形' },
  { key: 'star', glyph: '★', label: '星形' },
  { key: 'triangle', glyph: '▲', label: '三角' },
  { key: 'square', glyph: '■', label: '方形' },
  { key: 'circle', glyph: '●', label: '圆形' },
  { key: 'cross', glyph: '✚', label: '十字' },
  { key: 'spark', glyph: '✦', label: '闪光' },
  { key: 'hexagon', glyph: '⬢', label: '六边形' },
  { key: 'hollowDiamond', glyph: '◇', label: '空心菱形' },
  { key: 'hollowStar', glyph: '☆', label: '空心星形' },
  { key: 'hollowCircle', glyph: '○', label: '空心圆形' },
  { key: 'hollowSquare', glyph: '□', label: '空心方形' },
];

function getDayTypeTemplates() {
  if (!state.data.__dayTypeTemplates__) state.data.__dayTypeTemplates__ = [];
  return state.data.__dayTypeTemplates__;
}

function dayTypeSymbolMeta(symbolKey) {
  return DAY_TYPE_SYMBOLS.find(item => item.key === symbolKey) || DAY_TYPE_SYMBOLS[0];
}

function nextAvailableDayTypeSymbol(excludedId = '') {
  const used = new Set(getDayTypeTemplates()
    .filter(template => template.id !== excludedId && template.symbolKey)
    .map(template => template.symbolKey));
  return DAY_TYPE_SYMBOLS.find(item => !used.has(item.key))?.key || DAY_TYPE_SYMBOLS[0].key;
}

function dayTypeSymbolOptionsHtml(selectedKey, excludedId = '') {
  const usedBy = new Map(getDayTypeTemplates()
    .filter(template => template.id !== excludedId && template.symbolKey)
    .map(template => [template.symbolKey, template.name || '其他模板']));
  return DAY_TYPE_SYMBOLS.map(item => `<option value="${item.key}" ${selectedKey === item.key ? 'selected' : ''} ${usedBy.has(item.key) ? 'disabled' : ''}>${item.glyph} ${item.label}${usedBy.has(item.key) ? ` · 已用于${escHtmlApp(usedBy.get(item.key))}` : ''}</option>`).join('');
}

function migrateDayTypeModel() {
  let needsUntypedTemplate = false;
  Object.entries(state.data).forEach(([dateStr, day]) => {
    if (dateStr.startsWith('__') || !day || typeof day !== 'object') return;
    let dayType = String(day.dayType || '').trim();
    if (!dayType && day.specialDay) {
      dayType = '未分类日期类型';
      needsUntypedTemplate = true;
    }
    day.dayType = dayType;
    day.excludeFromRating = Boolean(dayType && day.excludeFromRating);
    delete day.specialDay;
  });
  const templates = getDayTypeTemplates();
  if (needsUntypedTemplate && !templates.some(template => String(template.name || '').trim() === '未分类日期类型')) {
    templates.push({ id: uid(), name: '未分类日期类型', symbolKey: '', excludeFromRating: false });
  }
  const used = new Set();
  templates.forEach(template => {
    delete template.specialDay;
    template.excludeFromRating = Boolean(template.excludeFromRating);
    const valid = DAY_TYPE_SYMBOLS.some(item => item.key === template.symbolKey);
    if (!valid || used.has(template.symbolKey)) template.symbolKey = '';
    if (template.symbolKey) used.add(template.symbolKey);
  });
  templates.forEach(template => {
    if (template.symbolKey) return;
    const available = DAY_TYPE_SYMBOLS.find(item => !used.has(item.key)) || DAY_TYPE_SYMBOLS[0];
    template.symbolKey = available.key;
    used.add(available.key);
  });
}

function validateDayTypeTemplate(template, editingId = '') {
  const normalizedName = String(template.name || '').trim().toLocaleLowerCase();
  if (getDayTypeTemplates().some(item => item.id !== editingId && String(item.name || '').trim().toLocaleLowerCase() === normalizedName)) {
    alert('日期类型名称不能重复');
    return false;
  }
  if (!DAY_TYPE_SYMBOLS.some(item => item.key === template.symbolKey)) {
    alert('请选择日期类型符号');
    return false;
  }
  if (getDayTypeTemplates().some(item => item.id !== editingId && item.symbolKey === template.symbolKey)) {
    alert('这个符号已被其他日期类型使用，请选择不同符号');
    return false;
  }
  return true;
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
  const setVisible = (element, visible) => {
    if (!element) return;
    element.style.display = visible ? '' : 'none';
  };
  setVisible(nameGroup, type !== 'normal');
  setVisible(nominalGroup, type === 'normal');
  setVisible(actualGroup, type !== 'special');
  setVisible(restGroup, type === 'normal');
  state._sessType = type;
}

/** Pre-fill the session entry form from a session template */
function applySessionTemplate(id) {
  if (!id) return;
  const tmpl = getSessionTemplates().find(t => t.id === id);
  if (!tmpl) return;
  switchSessionType(normalizeSessionTemplateType(tmpl.sessionType));
  const nameEl = document.getElementById('sess_name');
  if (nameEl && tmpl.name) nameEl.value = tmpl.name;
  if (tmpl.note) {
    const el = document.getElementById('sess_note'); if (el) el.value = tmpl.note;
  }
}

// ============================================================
// TASK TEMPLATES
// ============================================================
// Structure: { id, activityType, defaultMinutes, ordinalEnabled, ordinalUnit, quantityEnabled, quantityUnit, accuracyEnabled, scoreEnabled, scoreMax, note }
// note 仅作为模板库中的说明文字，不应带入任务记录。
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

function taskEfficiencyScopeKey(task) {
  const templateId = resolveTaskTemplateId(task);
  const unit = visibleTaskQuantityUnit(task).trim();
  return templateId
    ? `template:${templateId}\u0000${unit}`
    : `category:${String(task?.activityType || '未分类').trim()}\u0000${unit}`;
}

function taskUsesChapterEfficiency(task) {
  const template = getTaskTemplateForTask(task);
  if (templateUsesChapterQuestionCounts(template)) return false;
  return Boolean(template && (template.namedItemEnabled ?? template.ordinalEnabled)) ||
    taskNamedItemAllocations(task).length > 0 || taskOrdinalNumbers(task).length > 0;
}

const TASK_CHAPTER_EFFICIENCY_WEIGHT = 0.50;
const TASK_QUANTITY_EFFICIENCY_WEIGHT = 0.50;

function taskEfficiencyKind(task) {
  if (!taskUsesChapterEfficiency(task)) return 'task';
  return taskQuantityIsVisible(task) ? 'chapterQuantity' : 'chapter';
}

function taskEfficiencyRecordKey(dateStr, task) {
  return task?.id ? `${dateStr}\u0000${task.id}` : '';
}

function buildTaskEfficiencyComparisonIndex() {
  const rows = Object.entries(state.data)
    .filter(([dateStr, day]) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && Array.isArray(day?.tasks))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([dateStr, day]) => day.tasks.map((task, sourceIndex) => ({ dateStr, task, sourceIndex })))
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.sourceIndex - b.sourceIndex);
  const aggregates = new Map();
  const chapterProgress = new Map();
  const chapterQuantityReferences = new Map();
  const byTask = new WeakMap();
  const byKey = new Map();
  const addSample = (samples, row, output, minutes, kind, scopeKey, unit, extra = {}) => {
    if (!(output > 0) || !(minutes > 0)) return;
    const aggregateKey = `${kind}\u0000${scopeKey}`;
    samples.push({ row, output, minutes, kind, aggregateKey, unit, ...extra });
  };
  const commitSample = sample => {
    if (!aggregates.has(sample.aggregateKey)) {
      aggregates.set(sample.aggregateKey, { output: 0, minutes: 0, count: 0 });
    }
    const aggregate = aggregates.get(sample.aggregateKey);
    aggregate.output += sample.output;
    aggregate.minutes += sample.minutes;
    aggregate.count++;
  };
  const compareSample = sample => {
    const aggregate = aggregates.get(sample.aggregateKey);
    const efficiency = sample.output / sample.minutes;
    const average = aggregate && aggregate.output > 0 && aggregate.minutes > 0
      ? aggregate.output / aggregate.minutes
      : null;
    const comparison = {
      efficiency,
      average,
      deltaPct: average > 0 ? (efficiency / average - 1) * 100 : null,
      quantity: sample.output,
      minutes: sample.minutes,
      kind: sample.kind,
      sampleCount: aggregate?.count || 0,
      unit: sample.unit,
      referenceDate: sample.row.dateStr,
    };
    byTask.set(sample.row.task, comparison);
    const key = taskEfficiencyRecordKey(sample.row.dateStr, sample.row.task);
    if (key) byKey.set(key, comparison);
  };
  const quantityReferenceFor = scopeKey => {
    const reference = chapterQuantityReferences.get(scopeKey);
    return reference && reference.count > 0 && reference.quantity > 0
      ? reference.quantity / reference.count
      : 0;
  };
  const commitChapterQuantityReference = (scopeKey, quantities) => {
    quantities.forEach(quantity => {
      if (!(quantity > 0)) return;
      if (!chapterQuantityReferences.has(scopeKey)) {
        chapterQuantityReferences.set(scopeKey, { quantity: 0, count: 0 });
      }
      const reference = chapterQuantityReferences.get(scopeKey);
      reference.quantity += quantity;
      reference.count++;
    });
  };
  let currentDate = '';
  let dateSamples = [];
  const flushDateSamples = () => {
    dateSamples.forEach(compareSample);
    dateSamples.forEach(commitSample);
    dateSamples = [];
  };

  rows.forEach(row => {
    if (row.dateStr !== currentDate) {
      flushDateSamples();
      currentDate = row.dateStr;
    }
    const task = row.task;
    const minutes = Math.max(0, Number(task?.minutes) || 0);
    const quantity = visibleTaskQuantity(task);
    const scopeKey = taskEfficiencyScopeKey(task);
    const kind = taskEfficiencyKind(task);
    if (kind === 'task') {
      addSample(dateSamples, row, quantity, minutes, 'task', scopeKey, visibleTaskQuantityUnit(task));
      return;
    }

    let allocations = taskNamedItemAllocations(task);
    if (!allocations.length) {
      const ordinals = taskOrdinalNumbers(task);
      const completed = new Set(taskCompletedOrdinals(task));
      allocations = ordinals.map(value => ({
        itemId: `ordinal:${value}`,
        itemName: String(value),
        minutes: ordinals.length ? minutes / ordinals.length : 0,
        quantity: ordinals.length && quantity > 0 ? quantity / ordinals.length : null,
        completed: completed.has(value),
      }));
    }
    if (!allocations.length) return;
    if (!chapterProgress.has(scopeKey)) chapterProgress.set(scopeKey, new Map());
    const progressByItem = chapterProgress.get(scopeKey);
    const quantityReference = kind === 'chapterQuantity' ? quantityReferenceFor(scopeKey) : 0;
    let completedOutput = 0;
    let completedMinutes = 0;
    const completedChapterQuantities = [];
    allocations.forEach(allocation => {
      const itemKey = allocation.itemId || String(allocation.itemName || '').trim().toLocaleLowerCase();
      if (!itemKey) return;
      if (!progressByItem.has(itemKey)) progressByItem.set(itemKey, { quantity: 0, minutes: 0, completed: false });
      const progress = progressByItem.get(itemKey);
      if (progress.completed) return;
      progress.minutes += Math.max(0, Number(allocation.minutes) || 0);
      const allocationQuantity = taskQuantityIsVisible(task) ? Number(allocation.quantity) : NaN;
      if (Number.isFinite(allocationQuantity) && allocationQuantity > 0) {
        progress.quantity += allocationQuantity;
      }
      if (!allocation.completed) return;
      progress.completed = true;
      if (!(progress.minutes > 0)) return;
      if (kind === 'chapter') {
        completedOutput += 1;
        completedMinutes += progress.minutes;
        return;
      }
      const quantityFactor = quantityReference > 0
        ? progress.quantity / quantityReference
        : progress.quantity > 0 ? 1 : 0;
      completedOutput += TASK_CHAPTER_EFFICIENCY_WEIGHT +
        TASK_QUANTITY_EFFICIENCY_WEIGHT * quantityFactor;
      completedMinutes += progress.minutes;
      completedChapterQuantities.push(progress.quantity);
    });
    const unit = kind === 'chapter' ? '章' : '章节当量';
    addSample(dateSamples, row, completedOutput, completedMinutes, kind, scopeKey, unit, {
      completedChapterQuantities,
    });
    if (kind === 'chapterQuantity' && completedOutput > 0 && completedMinutes > 0) {
      commitChapterQuantityReference(scopeKey, completedChapterQuantities);
    }
  });
  flushDateSamples();

  return { byTask, byKey };
}

function taskEfficiencyComparisonFor(index, task, dateStr) {
  if (!index || !task) return null;
  return index.byTask.get(task) || index.byKey.get(taskEfficiencyRecordKey(dateStr, task)) || null;
}

function taskEfficiencyDeltaHtml(comparison) {
  if (!comparison || !Number.isFinite(comparison.deltaPct)) return '-';
  const delta = Math.round(comparison.deltaPct * 10) / 10;
  const basis = comparison.kind === 'chapterQuantity'
    ? '本次完成章节的综合产出'
    : comparison.kind === 'chapter' ? '本次完成章节' : '本条任务';
  const averageBasis = comparison.kind === 'chapterQuantity'
    ? '同模板已完成章节的综合效率'
    : comparison.kind === 'chapter' ? '同模板已完成章节' : '同模板/分类任务';
  const dateBasis = comparison.referenceDate ? `${comparison.referenceDate} 之前` : '该日期之前';
  const unit = comparison.unit || '题';
  const title = `${basis}效率 ${formatQuestionEfficiency(comparison.efficiency, unit)}；${dateBasis}${averageBasis}加权平均 ${formatQuestionEfficiency(comparison.average, unit)}（${comparison.sampleCount} 个有效样本）`;
  const className = delta > 0 ? 'c-green' : delta < 0 ? 'c-red' : 'c-muted';
  return `<span class="${className}" title="${escHtmlApp(title)}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span>`;
}

function taskEfficiencyRateText(task, comparison) {
  if (comparison && Number.isFinite(comparison.efficiency)) {
    const decimals = comparison.kind === 'task' ? 2 : 3;
    return formatQuestionEfficiency(comparison.efficiency, comparison.unit || '题', decimals);
  }
  const kind = taskEfficiencyKind(task);
  if (kind === 'chapterQuantity') return '待完成章节';
  if (kind === 'chapter') return '待完成章节';
  const quantity = visibleTaskQuantity(task);
  const minutes = Number(task?.minutes) || 0;
  if (!(quantity > 0) || !(minutes > 0)) return '-';
  return formatQuestionEfficiency(quantity / minutes, visibleTaskQuantityUnit(task) || '题', 2);
}

function taskEfficiencySortValue(task, comparison) {
  if (comparison && Number.isFinite(comparison.efficiency)) return comparison.efficiency;
  if (taskEfficiencyKind(task) !== 'task') return null;
  const quantity = visibleTaskQuantity(task);
  const minutes = Number(task?.minutes) || 0;
  return quantity > 0 && minutes > 0 ? quantity / minutes : null;
}

function taskOutputDeviationForDates(dateStrs, efficiencyIndex = buildTaskEfficiencyComparisonIndex()) {
  let equivalentMinutes = 0;
  let baselineMinutes = 0;
  let sampleCount = 0;
  (dateStrs || []).forEach(dateStr => {
    const day = state.data[dateStr];
    (day?.tasks || []).forEach(task => {
      const comparison = taskEfficiencyComparisonFor(efficiencyIndex, task, dateStr);
      if (!comparison || !(comparison.average > 0) || !(comparison.quantity > 0) || !(comparison.minutes > 0)) return;
      equivalentMinutes += comparison.quantity / comparison.average;
      baselineMinutes += comparison.minutes;
      sampleCount++;
    });
  });
  if (!sampleCount || !(baselineMinutes > 0)) return null;
  return {
    deltaPct: (equivalentMinutes / baselineMinutes - 1) * 100,
    equivalentMinutes,
    baselineMinutes,
    sampleCount,
  };
}

function taskOutputDeviationHtml(summary) {
  if (!summary || !Number.isFinite(summary.deltaPct)) return '-';
  const delta = Math.round(summary.deltaPct * 10) / 10;
  const className = delta > 0 ? 'c-green' : delta < 0 ? 'c-red' : 'c-muted';
  const title = `共 ${summary.sampleCount} 个有效效率样本；按各自日期之前的历史平均效率换算，实际产出相当于 ${fmtMin(summary.equivalentMinutes, true)} 标准时长，基准投入 ${fmtMin(summary.baselineMinutes, true)}。章节样本只归入完成日。`;
  return `<span class="${className}" title="${escHtmlApp(title)}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span>`;
}

function taskAccuracyIsVisible(task) {
  const template = getTaskTemplateForTask(task);
  if (template) return Boolean(template.accuracyEnabled);
  return task?.wrongCount != null && task?.wrongCount !== '';
}

function visibleTaskWrongCount(task) {
  if (!taskAccuracyIsVisible(task)) return null;
  const quantity = visibleTaskQuantity(task);
  const wrong = Number(task?.wrongCount);
  return Number.isInteger(quantity) && quantity > 0 && Number.isInteger(wrong) && wrong >= 0 && wrong <= quantity
    ? wrong
    : null;
}

function visibleTaskAccuracy(task) {
  const quantity = visibleTaskQuantity(task);
  const wrong = visibleTaskWrongCount(task);
  return wrong == null || quantity <= 0 ? null : Number((((quantity - wrong) / quantity) * 100).toFixed(2));
}

function taskAccuracyEvidence(task, backfillWrongCount = false) {
  const quantity = Number(task?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  let wrong = Number(task?.wrongCount);
  const explicitWrong = task?.wrongCount != null && task.wrongCount !== '' &&
    Number.isInteger(wrong) && wrong >= 0 && wrong <= quantity;
  if (!explicitWrong) {
    const accuracy = Number(task?.accuracy);
    if (task?.accuracy == null || task.accuracy === '' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) return null;
    const estimatedWrong = quantity * (100 - accuracy) / 100;
    const candidate = Math.round(estimatedWrong);
    if (candidate < 0 || candidate > quantity) return null;
    const accuracyText = String(task.accuracy);
    const decimals = accuracyText.includes('e') ? 8 : Math.min((accuracyText.split('.')[1] || '').length, 8);
    const tolerance = 0.5 * (10 ** -decimals) + 1e-9;
    const candidateAccuracy = (quantity - candidate) / quantity * 100;
    if (Math.abs(candidateAccuracy - accuracy) > tolerance) return null;
    const ambiguous = [candidate - 1, candidate + 1].some(other =>
      other >= 0 && other <= quantity && Math.abs(((quantity - other) / quantity * 100) - accuracy) <= tolerance);
    if (ambiguous) return null;
    wrong = candidate;
    if (backfillWrongCount) task.wrongCount = candidate;
  }
  return {
    quantity,
    wrong,
    accuracy: Number((((quantity - wrong) / quantity) * 100).toFixed(2)),
    quantityUnit: String(task?.quantityUnit || '').trim(),
  };
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
    accuracyEnabled: sourceTemplate
      ? Boolean(sourceTemplate.accuracyEnabled)
      : Boolean(document.getElementById('task_new_accuracy_enabled')?.checked),
    scoreEnabled: sourceTemplate
      ? Boolean(sourceTemplate.scoreEnabled)
      : Boolean(document.getElementById('task_new_score_enabled')?.checked),
    scoreMax: sourceTemplate?.scoreMax ?? (Number(document.getElementById('task_new_score_max')?.value) || null),
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

function syncTemplateAccuracyControls(quantityId, accuracyId, source = '') {
  const quantity = document.getElementById(quantityId);
  const accuracy = document.getElementById(accuracyId);
  if (!quantity || !accuracy) return;
  if (source === 'quantity' && !quantity.checked && accuracy.checked) {
    quantity.checked = true;
    alert('正确率记录已开启，请先关闭正确率记录，再关闭数量记录。');
  } else if (source === 'accuracy' && accuracy.checked && !quantity.checked) {
    accuracy.checked = false;
    alert('开启正确率记录前必须先开启数量记录。');
  }
  accuracy.disabled = !quantity.checked;
  if (!quantity.checked) accuracy.checked = false;
}

function syncTemplatePerformanceControls(accuracyId, scoreId, source = '') {
  const accuracy = document.getElementById(accuracyId);
  const score = document.getElementById(scoreId);
  if (!accuracy || !score) return;
  if (source === 'accuracy' && accuracy.checked) score.checked = false;
  if (source === 'score' && score.checked) accuracy.checked = false;
}

function configureTaskUnitFields(templateId) {
  const template = getTaskTemplateById(templateId);
  const manualEnabled = Boolean(document.getElementById('task_new_quantity_enabled')?.checked);
  const showQuantity = template ? Boolean(template.quantityEnabled) : manualEnabled;
  const manualAccuracyEnabled = Boolean(document.getElementById('task_new_accuracy_enabled')?.checked);
  const showAccuracy = showQuantity && (template ? Boolean(template.accuracyEnabled) : manualAccuracyEnabled);
  const showScore = template ? Boolean(template.scoreEnabled) : Boolean(document.getElementById('task_new_score_enabled')?.checked);
  const quantity = document.getElementById('task_qty');
  const unit = document.getElementById('task_unit');
  const rate = document.getElementById('task_rate');
  const rateLabel = document.getElementById('task_rate_label');
  const rateHint = document.getElementById('task_rate_hint');
  const quantityGroup = document.getElementById('task_qty_group');
  const unitGroup = document.getElementById('task_unit_group');
  const rateGroup = document.getElementById('task_rate_group');
  const wrongGroup = document.getElementById('task_wrong_group');
  const accuracyGroup = document.getElementById('task_accuracy_group');
  const wrong = document.getElementById('task_wrong');
  const quantityLabel = document.getElementById('task_qty_label');
  const wrongLabel = document.getElementById('task_wrong_label');
  const unitLabel = document.getElementById('task_unit_label');
  const chapterEnabled = template
    ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
    : Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  const chapterQuantity = showQuantity && chapterEnabled && !templateUsesChapterQuestionCounts(template);
  if (quantityGroup) quantityGroup.style.display = showQuantity ? '' : 'none';
  if (unitGroup) unitGroup.style.display = showQuantity ? '' : 'none';
  if (rateGroup) rateGroup.style.display = showQuantity ? '' : 'none';
  if (wrongGroup) wrongGroup.style.display = showAccuracy ? '' : 'none';
  if (accuracyGroup) accuracyGroup.style.display = showAccuracy ? '' : 'none';
  if (template && unit && unit.dataset.templateId !== template.id) {
    unit.value = template.quantityUnit || '';
    unit.dataset.templateId = template.id;
  } else if (!template && unit) {
    delete unit.dataset.templateId;
  }
  if (quantityLabel) {
    const unitText = (unit?.value || template?.quantityUnit || '').trim();
    quantityLabel.textContent = unitText ? `数量（${unitText}，${showAccuracy ? '必填' : '可选'}）` : `数量（${showAccuracy ? '必填' : '可选'}）`;
    if (wrongLabel) wrongLabel.textContent = unitText ? `错误数量（${unitText}，必填）` : '错误数量（必填）';
  }
  if (quantity) {
    quantity.required = showAccuracy;
    quantity.setAttribute('aria-required', showAccuracy ? 'true' : 'false');
  }
  if (wrong) {
    wrong.required = showAccuracy;
    wrong.setAttribute('aria-required', showAccuracy ? 'true' : 'false');
  }
  if (unitLabel) unitLabel.textContent = template ? '模板数量单位（全局）' : '新模板数量单位';
  if (rateLabel) rateLabel.textContent = chapterQuantity ? '数量效率（参考）' : '效率（自动计算）';
  if (rateHint) {
    rateHint.textContent = chapterQuantity
      ? '章节标记完成后，任务表会按章节 50% + 数量 50% 计算综合效率。'
      : '数量÷时长 自动算';
  }
  const editor = document.getElementById('task_named_item_editor');
  const perChapterMax = Number(template?.scoreMax ?? document.getElementById('task_new_score_max')?.value);
  if (editor) {
    editor.dataset.scoreEnabled = showScore && chapterEnabled ? 'true' : 'false';
    editor.dataset.scoreMax = Number.isFinite(perChapterMax) && perChapterMax > 0 ? String(perChapterMax) : '';
    editor.querySelectorAll('.task-named-item-card').forEach(card => {
      const active = showScore && chapterEnabled && Boolean(card.querySelector('.task-named-completed')?.checked);
      const label = card.querySelector('.task-named-score-field');
      const input = card.querySelector('.task-named-score');
      if (label) label.style.display = active ? 'flex' : 'none';
      if (input) {
        input.disabled = !active;
        input.required = active;
        input.max = editor.dataset.scoreMax;
        input.placeholder = editor.dataset.scoreMax ? `0-${editor.dataset.scoreMax}` : '得分';
      }
    });
  }
  const manualScoreMax = document.getElementById('task_new_score_max_field');
  if (manualScoreMax) manualScoreMax.style.display = showScore ? '' : 'none';
  unitGroup?.querySelectorAll('input,select,button').forEach(control => {
    control.disabled = false;
  });
  if (!showQuantity && rate) rate.value = '';
  if (showQuantity) autoCalcRate();
}

function taskNewUnitToggle(source = '') {
  const ordinalEnabled = Boolean(document.getElementById('task_new_ordinal_enabled')?.checked);
  const scoreToggle = document.getElementById('task_new_score_enabled');
  if (scoreToggle) {
    scoreToggle.disabled = !ordinalEnabled;
    if (!ordinalEnabled) scoreToggle.checked = false;
  }
  syncTemplateAccuracyControls('task_new_quantity_enabled', 'task_new_accuracy_enabled', source);
  syncTemplatePerformanceControls('task_new_accuracy_enabled', 'task_new_score_enabled', source);
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
  const key = feature === 'ordinal' ? 'namedItemEnabled' : feature === 'accuracy' ? 'accuracyEnabled' : feature === 'score' ? 'scoreEnabled' : 'quantityEnabled';
  if (!template || !checkbox) return;
  const previous = feature === 'ordinal'
    ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
    : Boolean(template[key]);
  const next = Boolean(checkbox.checked);
  if (previous === next) return;
  if (feature === 'accuracy' && next && !template.quantityEnabled) {
    checkbox.checked = previous;
    alert('开启正确率记录前必须先开启数量记录。');
    return;
  }
  if (feature === 'quantity' && !next && template.accuracyEnabled) {
    checkbox.checked = previous;
    alert('正确率记录已开启，请先关闭正确率记录，再关闭数量记录。');
    return;
  }
  if (feature === 'ordinal' && !next && template.scoreEnabled) {
    checkbox.checked = previous;
    alert('分数记录已开启，必须保留命名章节记录。');
    return;
  }
  if (feature === 'score' && next && !(template.namedItemEnabled ?? template.ordinalEnabled)) {
    checkbox.checked = previous;
    alert('请先开启命名章节记录，再开启分数记录。');
    return;
  }
  if (feature === 'score' && next && template.accuracyEnabled) {
    checkbox.checked = previous;
    alert('正确率记录已开启，请先关闭正确率记录。');
    return;
  }
  if (feature === 'score' && next && (!Number.isFinite(Number(template.scoreMax)) || Number(template.scoreMax) <= 0)) {
    checkbox.checked = previous;
    alert('请先在模板库设置大于 0 的每章满分，再开启分数记录。');
    return;
  }
  const enteredOrdinalUnit = document.getElementById('task_template_ordinal_unit')?.value.trim() || template.ordinalUnit || '';
  const enteredQuantityUnit = document.getElementById('task_unit')?.value.trim() || template.quantityUnit || '';
  const unit = feature === 'ordinal' ? enteredOrdinalUnit : enteredQuantityUnit;
  if (feature === 'quantity' && next && !unit) {
    checkbox.checked = previous;
    alert('请先在当前任务表单中设置数量单位。');
    return;
  }
  const affected = getTasksForTemplate(templateId).length;
  const action = next ? '开启' : '关闭';
  const effect = next ? '恢复显示并重新纳入统计' : '隐藏但不删除历史数据，并停止相关统计';
  const featureLabel = feature === 'ordinal' ? '命名章节' : feature === 'accuracy' ? '正确率' : feature === 'score' ? '分数' : '数量';
  if (!confirm(`${action}模板「${forecastTemplateLabel(template)}」的${featureLabel}记录？\n将影响 ${affected} 条关联任务：${effect}。`)) {
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
  const efficiencyIndex = buildTaskEfficiencyComparisonIndex();
  (day.tasks || []).forEach(task => {
    const row = document.querySelector(`#tab-entry tr[data-task-id="${task.id}"]`);
    if (!row) return;
    const nameCell = row.querySelector('.task-name-cell');
    const quantityCell = row.querySelector('.task-quantity-cell');
    const rateCell = row.querySelector('.task-rate-cell');
    const efficiencyDeltaCell = row.querySelector('.task-efficiency-delta-cell');
    const accuracyCell = row.querySelector('.task-accuracy-cell');
    const quantity = visibleTaskQuantity(task);
    const unit = visibleTaskQuantityUnit(task);
    const efficiencyComparison = taskEfficiencyComparisonFor(efficiencyIndex, task, state.selectedDate);
    const efficiencyRate = taskEfficiencyRateText(task, efficiencyComparison);
    if (nameCell) nameCell.innerHTML = `${escHtmlApp(task.name || '')}${taskOrdinalBadgeHtml(task)}`;
    if (quantityCell) quantityCell.textContent = quantity ? `${quantity}${unit ? ` ${unit}` : ''}` : '-';
    if (rateCell) rateCell.textContent = efficiencyRate;
    if (efficiencyDeltaCell) efficiencyDeltaCell.innerHTML = taskEfficiencyDeltaHtml(efficiencyComparison);
    if (accuracyCell) {
      const accuracy = visibleTaskAccuracy(task);
      accuracyCell.textContent = accuracy == null ? '-' : `${accuracy}%`;
    }
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

function templateAuditScan() {
  const taskTemplates = new Set(getTaskTemplates().map(template => String(template.activityType || '').trim()).filter(Boolean));
  const taskGroups = new Map();
  forEachStoredTask((task, dateStr) => {
    const activityType = String(task.activityType || '').trim();
    if (!activityType || activityType === '未分类' || taskTemplates.has(activityType)) return;
    if (!taskGroups.has(activityType)) taskGroups.set(activityType, []);
    taskGroups.get(activityType).push({ task, dateStr });
  });
  const task = [...taskGroups.entries()].map(([activityType, records]) => {
    const sorted = records.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const positiveMinutes = sorted.map(record => Number(record.task.minutes)).filter(value => Number.isFinite(value) && value > 0);
    const quantityRecords = sorted.filter(record => Number(record.task.quantity) > 0);
    const chapterRecords = sorted.filter(record => taskNamedItemAllocations(record.task).length > 0);
    const units = quantityRecords.map(record => String(record.task.quantityUnit || '').trim()).filter(Boolean);
    return {
      activityType,
      records: sorted,
      count: sorted.length,
      firstDate: sorted[0]?.dateStr || '',
      lastDate: sorted[sorted.length - 1]?.dateStr || '',
      totalMinutes: positiveMinutes.reduce((sum, value) => sum + value, 0),
      averageMinutes: positiveMinutes.length ? Math.round(positiveMinutes.reduce((sum, value) => sum + value, 0) / positiveMinutes.length) : null,
      quantityCount: quantityRecords.length,
      chapterCount: chapterRecords.length,
      unit: units.sort((a, b) => units.filter(value => value === b).length - units.filter(value => value === a).length)[0] || '',
    };
  }).sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate));

  const sessionTemplates = new Set(getSessionTemplates().map(template => `${normalizeSessionTemplateType(template.sessionType)}\u0000${String(template.name || '').trim()}`).filter(key => !key.endsWith('\u0000')));
  const sessionGroups = new Map();
  Object.entries(state.data).forEach(([dateStr, day]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Array.isArray(day?.sessions)) return;
    day.sessions.forEach(sessionRecord => {
      if (!isUnavailableSession(sessionRecord) && !isSpecialStudySession(sessionRecord)) return;
      const name = String(sessionRecord.name || '').trim();
      const sessionType = isSpecialStudySession(sessionRecord) ? 'special-study' : 'special';
      const key = `${sessionType}\u0000${name}`;
      if (!name || sessionTemplates.has(key)) return;
      if (!sessionGroups.has(key)) sessionGroups.set(key, { name, sessionType, records: [] });
      sessionGroups.get(key).records.push({ session: sessionRecord, dateStr });
    });
  });
  const allMissingSessions = [...sessionGroups.values()].map(group => {
    const { name, sessionType, records } = group;
    const sorted = records.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    return {
      name,
      sessionType,
      records: sorted,
      count: sorted.length,
      firstDate: sorted[0]?.dateStr || '',
      lastDate: sorted[sorted.length - 1]?.dateStr || '',
      totalMinutes: sorted.reduce((sum, record) => sum + sessionClock(record.session), 0),
    };
  }).sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate));
  const session = allMissingSessions.filter(item => item.sessionType === 'special');
  const specialStudy = allMissingSessions.filter(item => item.sessionType === 'special-study');
  return { task, session, specialStudy, total: task.length + session.length + specialStudy.length };
}

function toggleTemplateAudit() {
  state.templateAuditOpen = !state.templateAuditOpen;
  renderTemplates();
}

function templateAuditTaskDetailsHtml(item) {
  const rows = item.records.map(record => {
    const task = record.task;
    const allocations = taskNamedItemAllocations(task);
    const quantity = Number(task.quantity);
    const unit = String(task.quantityUnit || item.unit || '').trim();
    const encodedId = task.id ? encodeURIComponent(task.id).replace(/'/g, '%27') : '';
    return `<tr>
      <td><button type="button" class="template-task-date" onclick="openEntryDate('${record.dateStr}')">${formatShort(record.dateStr)}</button></td>
      <td>${templateTaskLinkHtml(record.dateStr, task)}</td>
      <td class="fw-mono">${fmtMin(Number(task.minutes) || 0, true)}</td>
      <td>${allocations.length ? allocations.map(allocation => `<span class="template-audit-allocation"><b>${escHtmlApp(allocation.itemName)}</b><small>${allocation.minutes ? fmtMin(allocation.minutes, true) : '未分配时长'}${allocation.quantity != null ? ` · ${forecastDisplayMetric(allocation.quantity)} ${escHtmlApp(unit || '数量')}` : ''}${allocation.completed ? ' · 本次完成' : ''}</small></span>`).join('') : '-'}</td>
      <td class="fw-mono">${Number.isFinite(quantity) && quantity > 0 ? `${forecastDisplayMetric(quantity)} ${escHtmlApp(unit || '数量')}` : '-'}</td>
      <td class="template-audit-note" title="${escHtmlApp(task.note || '')}">${escHtmlApp(task.note || '-')}</td>
      <td>${encodedId ? `<button type="button" class="btn btn-ghost btn-sm" onclick="templateOpenTask('${record.dateStr}','${encodedId}')">编辑</button>` : '<button type="button" class="btn btn-ghost btn-sm" disabled>不可编辑</button>'}</td>
    </tr>`;
  }).join('');
  return `<div class="template-audit-detail-wrap"><table class="template-audit-detail-table task"><thead><tr><th>日期</th><th>任务</th><th>时长</th><th>章节贡献</th><th>数量</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function templateAuditSessionDetailsHtml(item) {
  const rows = item.records.map(record => {
    const sessionRecord = record.session;
    const typeLabel = isSpecialStudySession(sessionRecord) ? '特殊学习' : '特殊时段';
    const encodedId = sessionRecord.id ? encodeURIComponent(sessionRecord.id).replace(/'/g, '%27') : '';
    return `<tr>
      <td><button type="button" class="template-task-date" onclick="openEntryDate('${record.dateStr}')">${formatShort(record.dateStr)}</button></td>
      <td>${typeLabel}</td>
      <td class="fw-mono">${encodedId ? `<button type="button" class="template-task-link" onclick="templateAuditOpenSession('${record.dateStr}','${encodedId}')">${sessionRecord.startTime || '-'} — ${sessionRecord.endTime || '-'}</button>` : `${sessionRecord.startTime || '-'} — ${sessionRecord.endTime || '-'}`}</td>
      <td class="fw-mono">${fmtMin(sessionClock(sessionRecord), true)}</td>
      <td class="fw-mono c-actual">${isUnavailableSession(sessionRecord) ? '-' : fmtMin(Number(sessionRecord.actualMinutes) || 0, true)}</td>
      <td class="template-audit-note" title="${escHtmlApp(sessionRecord.note || '')}">${escHtmlApp(sessionRecord.note || '-')}</td>
      <td>${encodedId ? `<button type="button" class="btn btn-ghost btn-sm" onclick="templateAuditOpenSession('${record.dateStr}','${encodedId}')">编辑</button>` : '<button type="button" class="btn btn-ghost btn-sm" disabled>不可编辑</button>'}</td>
    </tr>`;
  }).join('');
  return `<div class="template-audit-detail-wrap"><table class="template-audit-detail-table session"><thead><tr><th>日期</th><th>类型</th><th>起止时间</th><th>时钟</th><th>实际</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function templateAuditOpenSession(dateStr, encodedSessionId) {
  const sessionId = decodeURIComponent(encodedSessionId || '');
  if (!dateStr || !sessionId) return;
  monthEditSession(dateStr, sessionId);
}

function templateAuditPanelHtml(audit) {
  if (!state.templateAuditOpen) return '';
  const taskRows = audit.task.map(item => {
    const encoded = encodeURIComponent(item.activityType).replace(/'/g, '%27');
    return `<article class="template-audit-item"><details><summary class="template-audit-row"><div class="template-audit-row-main"><i style="--audit-color:${getCategoryColor(item.activityType, 'auto')}"></i><div><b>${escHtmlApp(item.activityType)}</b><span>${item.firstDate} 至 ${item.lastDate}</span></div></div><div class="template-audit-metrics"><span>${item.count} 条任务</span><span>${fmtMin(item.totalMinutes, true)}</span>${item.chapterCount ? `<span>${item.chapterCount} 条含章节</span>` : ''}${item.quantityCount ? `<span>${item.quantityCount} 条含数量${item.unit ? ` · ${escHtmlApp(item.unit)}` : ''}</span>` : ''}</div><span class="template-audit-expand">展开明细</span></summary>${templateAuditTaskDetailsHtml(item)}</details><div class="template-audit-restore"><button type="button" class="btn btn-primary btn-sm" onclick="templateRestoreMissingTask('${encoded}')">恢复模板</button></div></article>`;
  }).join('');
  const sessionRows = audit.session.map(item => {
    const encoded = encodeURIComponent(item.name).replace(/'/g, '%27');
    return `<article class="template-audit-item"><details><summary class="template-audit-row"><div class="template-audit-row-main"><i style="--audit-color:${getSpecialSeriesColor(item.name)}"></i><div><b>${escHtmlApp(item.name)}</b><span>不可用时段 · ${item.firstDate} 至 ${item.lastDate}</span></div></div><div class="template-audit-metrics"><span>${item.count} 个时段</span><span>${fmtMin(item.totalMinutes, true)}</span></div><span class="template-audit-expand">展开明细</span></summary>${templateAuditSessionDetailsHtml(item)}</details><div class="template-audit-restore"><button type="button" class="btn btn-primary btn-sm" onclick="templateRestoreMissingSession('special','${encoded}')">恢复模板</button></div></article>`;
  }).join('');
  const specialStudyRows = audit.specialStudy.map(item => {
    const encoded = encodeURIComponent(item.name).replace(/'/g, '%27');
    return `<article class="template-audit-item"><details><summary class="template-audit-row"><div class="template-audit-row-main"><i style="--audit-color:${getSpecialSeriesColor(item.name)}"></i><div><b>${escHtmlApp(item.name)}</b><span>特殊学习时段 · ${item.firstDate} 至 ${item.lastDate}</span></div></div><div class="template-audit-metrics"><span>${item.count} 个时段</span><span>${fmtMin(item.totalMinutes, true)}</span></div><span class="template-audit-expand">展开明细</span></summary>${templateAuditSessionDetailsHtml(item)}</details><div class="template-audit-restore"><button type="button" class="btn btn-primary btn-sm" onclick="templateRestoreMissingSession('special-study','${encoded}')">恢复模板</button></div></article>`;
  }).join('');
  return `<section class="template-audit-panel">
    <div class="template-audit-head"><div><div class="template-eyebrow">HISTORY AUDIT</div><h3>历史记录模板抽查</h3><p>仅列出历史记录中仍在使用、但当前模板库已经缺失的项目。</p></div><button type="button" class="btn btn-ghost btn-sm" onclick="toggleTemplateAudit()">关闭</button></div>
    ${audit.total ? `<div class="template-audit-group"><div class="template-audit-group-title"><b>缺失的任务模板</b><span>${audit.task.length} 项</span></div>${taskRows || '<div class="template-audit-empty">没有缺失的任务模板</div>'}</div><div class="template-audit-group"><div class="template-audit-group-title"><b>缺失的不可用时段模板</b><span>${audit.session.length} 项</span></div>${sessionRows || '<div class="template-audit-empty">没有缺失的不可用时段模板</div>'}</div><div class="template-audit-group"><div class="template-audit-group-title"><b>缺失的特殊学习模板</b><span>${audit.specialStudy.length} 项</span></div>${specialStudyRows || '<div class="template-audit-empty">没有缺失的特殊学习模板</div>'}</div>` : '<div class="template-audit-success"><b>抽查完成，没有发现缺失模板</b><span>当前历史任务、不可用时段和特殊学习都能找到对应模板。</span></div>'}
  </section>`;
}

async function templateRestoreMissingTask(encodedActivityType) {
  const activityType = decodeURIComponent(encodedActivityType || '');
  const item = templateAuditScan().task.find(entry => entry.activityType === activityType);
  if (!item) { alert('该模板已经恢复，或历史记录已发生变化。'); renderTemplates(); return; }
  const featureText = [item.chapterCount ? '命名章节' : '', item.quantityCount ? `数量记录${item.unit ? `（${item.unit}）` : ''}` : ''].filter(Boolean).join('、') || '仅时长';
  if (!confirm(`从 ${item.count} 条历史任务恢复模板“${activityType}”？\n将恢复：${featureText}\n并把这些历史任务重新绑定到新模板。`)) return;
  const namedItemsByName = new Map();
  item.records.forEach(record => {
    taskNamedItemAllocations(record.task).forEach(allocation => {
      const key = allocation.itemName.toLocaleLowerCase();
      if (!namedItemsByName.has(key)) namedItemsByName.set(key, { id: allocation.itemId || uid(), name: allocation.itemName, archived: false });
    });
  });
  const namedItems = [...namedItemsByName.values()];
  let accuracyEnabled = false;
  item.records.forEach(record => {
    const evidence = taskAccuracyEvidence(record.task, true);
    if (!evidence) return;
    record.task.accuracy = evidence.accuracy;
    accuracyEnabled = true;
  });
  const quantityEnabled = item.quantityCount > 0 || accuracyEnabled;
  const quantityUnit = quantityEnabled ? (item.unit || '数量') : '';
  const template = {
    id: uid(),
    activityType,
    defaultMinutes: item.averageMinutes,
    namedItemEnabled: namedItems.length > 0,
    namedItems,
    ordinalEnabled: namedItems.length > 0,
    ordinalUnit: namedItems.length > 0 ? '项' : '',
    quantityEnabled,
    quantityUnit,
    accuracyEnabled,
    note: '',
  };
  getTaskTemplates().push(template);
  parseActPath(activityType).forEach((name, index) => {
    if (!name) return;
    const list = getCatList(index + 1);
    if (!list.includes(name)) list.push(name);
  });
  item.records.forEach(record => {
    record.task.templateId = template.id;
    if (quantityEnabled && Number(record.task.quantity) > 0 && !String(record.task.quantityUnit || '').trim()) record.task.quantityUnit = quantityUnit;
    if (Array.isArray(record.task.namedItemAllocations)) {
      record.task.namedItemAllocations = record.task.namedItemAllocations.map(allocation => {
        const restored = namedItemsByName.get(String(allocation?.itemName || '').trim().toLocaleLowerCase());
        return restored ? { ...allocation, itemId: restored.id, itemName: restored.name } : allocation;
      });
    }
  });
  await saveAllStorage();
  state.templateLibraryView = 'task';
  state.templateAuditOpen = true;
  renderTemplates();
  showPersistentSaveNotice(`已恢复任务模板“${activityType}”`);
}

async function templateRestoreMissingSession(sessionType, encodedName) {
  sessionType = normalizeSessionTemplateType(sessionType);
  const name = decodeURIComponent(encodedName || '');
  const audit = templateAuditScan();
  const source = sessionType === 'special-study' ? audit.specialStudy : audit.session;
  const item = source.find(entry => entry.name === name);
  if (!item) { alert('该模板已经恢复，或历史记录已发生变化。'); renderTemplates(); return; }
  const typeLabel = sessionType === 'special-study' ? '特殊学习' : '不可用时段';
  if (!confirm(`从 ${item.count} 条历史记录恢复${typeLabel}模板“${name}”？`)) return;
  getSessionTemplates().push({ id: uid(), name, note: '', sessionType });
  await saveAllStorage();
  state.templateLibraryView = sessionType === 'special-study' ? 'specialStudy' : 'session';
  state.templateAuditOpen = true;
  renderTemplates();
  showPersistentSaveNotice(`已恢复${typeLabel}模板“${name}”`);
}

function templateHeroHtml(taskTemplates, sessionTemplates, dayTypeTemplates, audit) {
  const chapterCount = taskTemplates.filter(template => template.namedItemEnabled ?? template.ordinalEnabled).length;
  const quantityCount = taskTemplates.filter(template => template.quantityEnabled).length;
  const unavailableCount = sessionTemplates.filter(template => normalizeSessionTemplateType(template.sessionType) === 'special').length;
  const specialStudyCount = sessionTemplates.filter(template => normalizeSessionTemplateType(template.sessionType) === 'special-study').length;
  return `<section class="template-hero">
    <div class="template-hero-copy">
      <div class="template-eyebrow">TEMPLATE WORKSPACE</div>
      <h2>模板库</h2>
      <p>集中管理任务、不可用时段、特殊学习和日期类型，录入与分析继续使用同一份模板数据。</p>
      <button type="button" class="btn btn-ghost btn-sm template-audit-trigger" onclick="toggleTemplateAudit()">抽查缺失模板${audit.total ? ` · ${audit.total}` : ''}</button>
    </div>
    <div class="template-summary-strip">
      <div><span>任务模板</span><strong>${taskTemplates.length}</strong></div>
      <div><span>不可用时段</span><strong>${unavailableCount}</strong></div>
      <div><span>特殊学习</span><strong>${specialStudyCount}</strong></div>
      <div><span>日期类型</span><strong>${dayTypeTemplates.length}</strong></div>
      <div><span>开启章节</span><strong>${chapterCount}</strong></div>
      <div><span>开启数量</span><strong>${quantityCount}</strong></div>
    </div>
  </section>`;
}

function templateViewTabsHtml(taskCount, sessionCount, specialStudyCount, dayTypeCount) {
  const active = ['task', 'session', 'specialStudy', 'dayType'].includes(state.templateLibraryView)
    ? state.templateLibraryView
    : 'task';
  state.templateLibraryView = active;
  return `<nav class="template-view-tabs" aria-label="模板类型">
    <button type="button" data-template-view="task" class="${active === 'task' ? 'active' : ''}" onclick="switchTemplateLibraryView('task')">任务模板 <span>${taskCount}</span></button>
    <button type="button" data-template-view="session" class="${active === 'session' ? 'active' : ''}" onclick="switchTemplateLibraryView('session')">不可用时段 <span>${sessionCount}</span></button>
    <button type="button" data-template-view="specialStudy" class="${active === 'specialStudy' ? 'active' : ''}" onclick="switchTemplateLibraryView('specialStudy')">特殊学习 <span>${specialStudyCount}</span></button>
    <button type="button" data-template-view="dayType" class="${active === 'dayType' ? 'active' : ''}" onclick="switchTemplateLibraryView('dayType')">日期类型 <span>${dayTypeCount}</span></button>
  </nav>`;
}

function switchTemplateLibraryView(view) {
  state.templateLibraryView = ['task', 'session', 'specialStudy', 'dayType'].includes(view) ? view : 'task';
  document.querySelectorAll('[data-template-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.templateView === state.templateLibraryView);
  });
  document.querySelectorAll('.template-view').forEach(section => {
    section.classList.toggle('active', section.dataset.templateView === state.templateLibraryView);
  });
}

function templateEditorPanelHtml(title, subtitle, body, className = '') {
  return `<section class="template-editor-panel ${className}">
    <div class="template-editor-head">
      <div>
        <div class="template-eyebrow">EDITOR</div>
        <h3>${title}</h3>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
    </div>
    <div class="template-editor-body">${body}</div>
  </section>`;
}

function taskTemplateNewEditorHtml() {
  const body = `<div class="template-editor-section">
      <div class="template-editor-section-head"><b>绑定活动类别</b><span>按一级、二级、三级组成完整模板路径</span></div>
      <div class="template-category-grid">
        <label><span>一级</span>${catSelectorHtml(1, 'tmpl_l1', '', 'tmpl_cat_msg')}</label>
        <label><span>二级</span>${catSelectorHtml(2, 'tmpl_l2', '', 'tmpl_cat_msg')}</label>
        <label><span>三级</span>${catSelectorHtml(3, 'tmpl_l3', '', 'tmpl_cat_msg')}</label>
      </div>
      <div class="template-inline-message" id="tmpl_cat_msg"></div>
      <div class="form-hint">＋ 保存到库 · 🗑 从库删除（不影响已有模板和记录）</div>
    </div>
    <div class="template-editor-section">
      <div class="template-editor-section-head"><b>默认设置</b><span>控制录入时自动带入的模板能力</span></div>
      <div class="template-editor-grid">
        <div class="form-group"><label>默认时长（分钟）</label><input type="number" id="tmpl_minutes" min="1" placeholder="60"></div>
        <div class="form-group template-unit-config">
          <label><input type="checkbox" id="tmpl_quantity_enabled" onchange="syncTemplateAccuracyControls('tmpl_quantity_enabled','tmpl_accuracy_enabled','quantity');syncTaskTemplateChapterScoringControls('tmpl')"> 开启数量单位</label>
          ${unitSelectorHtml('tmpl_unit', '', 'tmpl_unit_msg')}
          <div class="template-inline-message" id="tmpl_unit_msg"></div>
          <div class="form-hint">关闭时保留单位文字，但不参与录入和预测。</div>
        </div>
        <div class="form-group template-unit-config">
          <label><input type="checkbox" id="tmpl_ordinal_enabled" onchange="syncTaskTemplateChapterScoringControls('tmpl')"> 开启命名章节记录</label>
          <div class="form-hint">保存模板后可在共享章节库中维护完整章节名称。</div>
        </div>
        <div class="form-group template-unit-config">
          <label><input type="checkbox" id="tmpl_accuracy_enabled" disabled onchange="syncTemplateAccuracyControls('tmpl_quantity_enabled','tmpl_accuracy_enabled','accuracy');syncTemplatePerformanceControls('tmpl_accuracy_enabled','tmpl_score_enabled','accuracy')"> 开启正确率记录</label>
          <div class="form-hint">开启后，录入任务时总数量和错误数量均为必填。</div>
        </div>
        <div class="form-group template-unit-config">
          <label><input type="checkbox" id="tmpl_score_enabled" onchange="syncTemplatePerformanceControls('tmpl_accuracy_enabled','tmpl_score_enabled','score')"> 开启分数记录</label>
          <label for="tmpl_score_max">每章满分</label>
          <input type="number" id="tmpl_score_max" min="0.1" step="0.1" placeholder="例如 100">
        </div>
      </div>
    </div>
    <div class="template-editor-section">
      <div class="form-group"><label>模板说明</label><textarea id="tmpl_note" rows="3" maxlength="500" placeholder="仅在模板库中显示，不会带入任务记录"></textarea></div>
    </div>
    <div class="template-editor-actions">
      <button class="btn btn-success" onclick="tmplSaveNew()">✓ 保存模板</button>
      <button class="btn btn-ghost" onclick="tmplToggleForm()">取消</button>
      <span id="tmpl-save-msg"></span>
    </div>`;
  return `<section class="template-editor-panel template-new-editor" id="task-template-new-panel">
    <button type="button" class="template-editor-toggle" onclick="tmplToggleForm()">
      <span><b>新建任务模板</b><small>建立可在录入中一键套用的任务预设</small></span>
      <span id="tmpl-form-toggle">展开</span>
    </button>
    <div class="template-editor-body" id="tmpl-form-body" style="display:none">${body}</div>
  </section>`;
}

function taskTemplateFilterHtml(context) {
  const { templates, filteredTemplates, filter, level1Options, level2Options, level3Options } = context;
  if (!templates.length) return '';
  return `<div class="template-filter-grid">
    <label><span>一级分类</span><select onchange="setTemplateCategoryFilter(1,this.value)">
      <option value="">全部模板</option>
      ${level1Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level1 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <label><span>二级分类</span><select onchange="setTemplateCategoryFilter(2,this.value)" ${filter.level1 ? '' : 'disabled'}>
      <option value="">全部二级</option>
      ${level2Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level2 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <label><span>三级分类</span><select onchange="setTemplateCategoryFilter(3,this.value)" ${filter.level1 && filter.level2 ? '' : 'disabled'}>
      <option value="">全部三级</option>
      ${level3Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level3 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <span class="template-filter-count">显示 ${filteredTemplates.length}/${templates.length}</span>
    ${filter.level1 || filter.level2 || filter.level3 ? '<button class="btn btn-ghost btn-sm" onclick="clearTemplateCategoryFilter()">清除筛选</button>' : ''}
  </div>`;
}

function taskTemplateViewHtml(context) {
  const active = state.templateLibraryView === 'task' ? 'active' : '';
  const { templates, filteredTemplates } = context;
  return `<section class="template-view ${active}" data-template-view="task">
    <div class="template-view-toolbar">
      <div><div class="template-eyebrow">TASK PRESETS</div><h3>任务模板</h3><p>管理分类、默认时长、数量单位和共享章节。</p></div>
      <button class="btn btn-primary" onclick="tmplToggleForm()">＋ 新建任务模板</button>
    </div>
    ${taskTemplateFilterHtml(context)}
    ${taskTemplateNewEditorHtml()}
    <div id="task-template-edit-host"></div>
    ${templates.length === 0
      ? '<div class="template-empty-state"><b>暂无任务模板</b><span>点击“新建任务模板”建立第一个预设。</span></div>'
      : filteredTemplates.length === 0
        ? '<div class="template-empty-state"><b>当前分类组合没有模板</b><button class="btn btn-ghost btn-sm" onclick="clearTemplateCategoryFilter()">显示全部模板</button></div>'
        : `<div class="template-card-grid task-template-grid">
            ${filteredTemplates.map(tmplCardHtml).join('')}
            <div id="template-named-items-manager" class="template-card-chapter-host"></div>
          </div>`}
  </section>`;
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

  const sessionTemplates = getSessionTemplates();
  const unavailableTemplates = sessionTemplates.filter(template => normalizeSessionTemplateType(template.sessionType) === 'special');
  const specialStudyTemplates = sessionTemplates.filter(template => normalizeSessionTemplateType(template.sessionType) === 'special-study');
  const dayTypeTemplates = getDayTypeTemplates();
  const audit = templateAuditScan();
  const context = { templates, filteredTemplates, filter, level1Options, level2Options, level3Options };
  document.getElementById('tab-templates').innerHTML = `<div class="template-page">
    ${templateHeroHtml(templates, sessionTemplates, dayTypeTemplates, audit)}
    ${templateAuditPanelHtml(audit)}
    ${templateViewTabsHtml(templates.length, unavailableTemplates.length, specialStudyTemplates.length, dayTypeTemplates.length)}
    ${taskTemplateViewHtml(context)}
    ${renderSessionTemplatesSection('special')}
    ${renderSessionTemplatesSection('special-study')}
    ${renderDayTypeTemplatesSection()}
  </div>`;
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
function renderSessionTemplatesSection(sessionType = 'special') {
  sessionType = normalizeSessionTemplateType(sessionType);
  const specialStudy = sessionType === 'special-study';
  const viewKey = specialStudy ? 'specialStudy' : 'session';
  const slug = specialStudy ? 'special-study' : 'unavailable';
  const title = specialStudy ? '特殊学习' : '不可用时段';
  const sTmpls = getSessionTemplates().filter(template => normalizeSessionTemplateType(template.sessionType) === sessionType);
  const active = state.templateLibraryView === viewKey ? 'active' : '';
  return `<section class="template-view ${active}" data-template-view="${viewKey}">
    <div class="template-view-toolbar">
      <div><div class="template-eyebrow">${specialStudy ? 'SPECIAL STUDY PRESETS' : 'UNAVAILABLE PRESETS'}</div><h3>${title}</h3><p>${specialStudy ? '保存外出上课、通勤学习等包含零散专注的特殊学习名称。' : '保存吃饭、午休、通勤等完全不可学习时段的名称和默认备注。'}</p></div>
      <button class="btn btn-primary" onclick="sessTmplToggleForm('${sessionType}')">＋ 新建${title}</button>
    </div>
    <section class="template-editor-panel template-new-editor" id="session-template-new-panel-${slug}">
      <button type="button" class="template-editor-toggle" onclick="sessTmplToggleForm('${sessionType}')">
        <span><b>新建${title}模板</b><small>录入时会自动切换到正确的时段类型</small></span>
        <span id="sess-tmpl-form-toggle-${slug}">展开</span>
      </button>
      <div class="template-editor-body" id="sess-tmpl-form-body-${slug}" style="display:none">
        <div class="template-editor-grid compact">
          <div class="form-group"><label>模板名称</label><input type="text" id="sess_tmpl_name_${slug}" placeholder="${specialStudy ? '例：外出上课、通勤学习' : '例：午饭、通勤、午休'}"></div>
          <div class="form-group"><label>备注模板</label><input type="text" id="sess_tmpl_note_${slug}" placeholder="可选默认备注"></div>
        </div>
        <div class="template-editor-actions">
          <button class="btn btn-success" onclick="sessTmplSaveNew('${sessionType}')">✓ 保存${title}模板</button>
          <button class="btn btn-ghost" onclick="sessTmplToggleForm('${sessionType}')">取消</button>
          <span id="sess-tmpl-save-msg-${slug}"></span>
        </div>
      </div>
    </section>
    <div id="session-template-edit-host-${slug}"></div>
    ${sTmpls.length === 0
      ? `<div class="template-empty-state"><b>暂无${title}模板</b><span>建立常用模板后，录入时可以直接套用。</span></div>`
      : `<div class="template-card-grid simple-template-grid">${sTmpls.map(t => sessTmplCardHtml(t)).join('')}</div>`}
  </section>`;
}

function sessTmplToggleForm(sessionType = 'special') {
  sessionType = normalizeSessionTemplateType(sessionType);
  const slug = sessionType === 'special-study' ? 'special-study' : 'unavailable';
  const body = document.getElementById(`sess-tmpl-form-body-${slug}`);
  const tog = document.getElementById(`sess-tmpl-form-toggle-${slug}`);
  const panel = document.getElementById(`session-template-new-panel-${slug}`);
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  panel?.classList.toggle('open', open);
  if (open) {
    const editHost = document.getElementById(`session-template-edit-host-${slug}`);
    if (editHost) editHost.innerHTML = '';
  }
  if (tog) tog.textContent = open ? '收起' : '展开';
}

async function sessTmplSaveNew(sessionType = 'special') {
  sessionType = normalizeSessionTemplateType(sessionType);
  const slug = sessionType === 'special-study' ? 'special-study' : 'unavailable';
  const name = document.getElementById(`sess_tmpl_name_${slug}`).value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  if (getSessionTemplates().some(template => normalizeSessionTemplateType(template.sessionType) === sessionType && template.name === name)) {
    alert('当前时段类型中已经存在同名模板。');
    return;
  }
  const tmpl = {
    name,
    note: document.getElementById(`sess_tmpl_note_${slug}`).value.trim(),
    sessionType,
  };
  await addSessionTemplate(tmpl);
  const msg = document.getElementById(`sess-tmpl-save-msg-${slug}`);
  if (msg) { msg.textContent = `✅ 已保存「${name}」`; setTimeout(() => msg.textContent = '', 2500); }
  renderTemplates();
  if (tmpl.note) showPersistentSaveNotice('时段模板备注已保存');
}

function sessTmplCardHtml(t) {
  const color = getSpecialSeriesColor(t.name);
  const specialStudy = normalizeSessionTemplateType(t.sessionType) === 'special-study';
  return `<article class="template-card simple-template-card session" id="sess-tmpl-card-${t.id}" style="--template-color:${color}">
    <div class="template-card-head">
      <div class="template-card-title"><i></i><div><b>${escHtmlApp(t.name)}</b><small>${specialStudy ? '特殊学习模板' : '不可用时段模板'}</small></div></div>
    </div>
    <p class="template-card-note ${t.note ? '' : 'muted'}">${t.note ? escHtmlApp(t.note) : '未填写默认备注'}</p>
    <div class="template-card-actions">
      <button class="btn btn-ghost btn-sm" onclick="sessTmplStartEdit('${t.id}')">编辑</button>
      <button class="btn btn-danger btn-sm" onclick="sessTmplDelete('${t.id}')">删除</button>
    </div>
  </article>`;
}

function sessTmplEditFormHtml(t) {
  return `<div class="template-editor-grid compact">
    <div class="form-group"><label>模板名称</label><input type="text" id="sess-tmpl-edit-name-${t.id}" value="${escHtmlApp(t.name)}"></div>
    <div class="form-group"><label>备注模板</label><input type="text" id="sess-tmpl-edit-note-${t.id}" value="${escHtmlApp(t.note || '')}"></div>
    <div class="form-group"><label>时段类型</label><select id="sess-tmpl-edit-type-${t.id}"><option value="special" ${normalizeSessionTemplateType(t.sessionType) === 'special' ? 'selected' : ''}>不可用时段</option><option value="special-study" ${normalizeSessionTemplateType(t.sessionType) === 'special-study' ? 'selected' : ''}>特殊学习时段</option></select></div>
  </div>
    <div class="template-editor-actions">
      <button class="btn btn-success btn-sm" onclick="sessTmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="sessTmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

function sessTmplStartEdit(id) {
  const template = getSessionTemplates().find(item => item.id === id);
  const sessionType = normalizeSessionTemplateType(template?.sessionType);
  const slug = sessionType === 'special-study' ? 'special-study' : 'unavailable';
  const host = document.getElementById(`session-template-edit-host-${slug}`);
  if (!template || !host) return;
  const newBody = document.getElementById(`sess-tmpl-form-body-${slug}`);
  if (newBody) newBody.style.display = 'none';
  document.getElementById(`session-template-new-panel-${slug}`)?.classList.remove('open');
  const toggle = document.getElementById(`sess-tmpl-form-toggle-${slug}`);
  if (toggle) toggle.textContent = '展开';
  host.innerHTML = templateEditorPanelHtml(`编辑${sessionType === 'special-study' ? '特殊学习' : '不可用时段'} · ${escHtmlApp(template.name)}`, '修改名称、类型和默认备注，不影响已有时段记录。', sessTmplEditFormHtml(template), 'session-template-editor');
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function sessTmplCancelEdit(id) {
  const template = getSessionTemplates().find(item => item.id === id);
  const slug = normalizeSessionTemplateType(template?.sessionType) === 'special-study' ? 'special-study' : 'unavailable';
  const host = document.getElementById(`session-template-edit-host-${slug}`);
  if (host) host.innerHTML = '';
}

async function sessTmplSaveEdit(id) {
  const previous = getSessionTemplates().find(template => template.id === id);
  const name = document.getElementById(`sess-tmpl-edit-name-${id}`).value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  const sessionType = normalizeSessionTemplateType(document.getElementById(`sess-tmpl-edit-type-${id}`)?.value);
  if (getSessionTemplates().some(template => template.id !== id && normalizeSessionTemplateType(template.sessionType) === sessionType && template.name === name)) {
    alert('目标时段类型中已经存在同名模板。');
    return;
  }
  const tmpl = {
    id, name,
    note: document.getElementById(`sess-tmpl-edit-note-${id}`).value.trim(),
    sessionType,
  };
  await saveSessionTemplate(tmpl);
  state.templateLibraryView = sessionType === 'special-study' ? 'specialStudy' : 'session';
  renderTemplates();
  if (tmpl.note || previous?.note) showPersistentSaveNotice('时段模板备注已保存');
}

async function sessTmplDelete(id) {
  const tmpl = getSessionTemplates().find(t => t.id === id);
  if (!tmpl) return;
  if (!confirm(`删除${normalizeSessionTemplateType(tmpl.sessionType) === 'special-study' ? '特殊学习' : '不可用时段'}模板「${tmpl.name}」？`)) return;
  await deleteSessionTemplate(id);
  renderTemplates();
}

function renderDayTypeTemplatesSection() {
  const templates = getDayTypeTemplates();
  const active = state.templateLibraryView === 'dayType' ? 'active' : '';
  return `<section class="template-view ${active}" data-template-view="dayType">
    <div class="template-view-toolbar">
      <div><div class="template-eyebrow">DAY PRESETS</div><h3>日期类型</h3><p>预设日期类型、识别符号和评分默认规则，具体日期仍可覆盖评分设置。</p></div>
      <button class="btn btn-primary" onclick="dayTypeTmplToggleForm()">＋ 新建日期类型</button>
    </div>
    <section class="template-editor-panel template-new-editor" id="day-type-template-new-panel">
      <button type="button" class="template-editor-toggle" onclick="dayTypeTmplToggleForm()">
        <span><b>新建日期类型模板</b><small>定义类型符号以及是否默认计入评分</small></span>
        <span id="day-type-tmpl-form-toggle">展开</span>
      </button>
      <div class="template-editor-body" id="day-type-tmpl-form-body" style="display:none">
        <div class="template-editor-grid compact">
          <div class="form-group"><label>类型名称</label><input type="text" id="day_type_tmpl_name" placeholder="例：旅行日、生病休息日、考试日"></div>
          <div class="form-group"><label>日期类型符号</label><select id="day_type_tmpl_symbol">${dayTypeSymbolOptionsHtml(nextAvailableDayTypeSymbol())}</select></div>
          <div class="template-option-panel">
            <label><input type="checkbox" id="day_type_tmpl_exclude"> 默认不参与评分（排除范围汇总）</label>
          </div>
        </div>
        <div class="template-editor-actions">
          <button class="btn btn-success" onclick="dayTypeTmplSaveNew()">✓ 保存日期类型</button>
          <button class="btn btn-ghost" onclick="dayTypeTmplToggleForm()">取消</button>
          <span id="day-type-tmpl-save-msg"></span>
        </div>
      </div>
    </section>
    <div id="day-type-template-edit-host"></div>
    ${templates.length === 0
      ? '<div class="template-empty-state"><b>暂无日期类型模板</b><span>建立旅行、考试或休息等日期预设。</span></div>'
      : `<div class="template-card-grid simple-template-grid">${templates.map(dayTypeTmplCardHtml).join('')}</div>`}
  </section>`;
}

function dayTypeTmplToggleForm() {
  const body = document.getElementById('day-type-tmpl-form-body');
  const toggle = document.getElementById('day-type-tmpl-form-toggle');
  const panel = document.getElementById('day-type-template-new-panel');
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  panel?.classList.toggle('open', open);
  if (open) {
    const editHost = document.getElementById('day-type-template-edit-host');
    if (editHost) editHost.innerHTML = '';
  }
  if (toggle) toggle.textContent = open ? '收起' : '展开';
}

function readDayTypeTemplateForm(prefix) {
  const name = document.getElementById(`${prefix}name`)?.value.trim() || '';
  return {
    name,
    symbolKey: document.getElementById(`${prefix}symbol`)?.value || '',
    excludeFromRating: Boolean(document.getElementById(`${prefix}exclude`)?.checked),
  };
}

async function dayTypeTmplSaveNew() {
  const tmpl = readDayTypeTemplateForm('day_type_tmpl_');
  if (!tmpl.name) {
    alert('请填写日期类型名称');
    return;
  }
  if (!validateDayTypeTemplate(tmpl)) return;
  await addDayTypeTemplate(tmpl);
  const msg = document.getElementById('day-type-tmpl-save-msg');
  if (msg) {
    msg.textContent = `✅ 已保存「${tmpl.name}」`;
    setTimeout(() => { msg.textContent = ''; }, 2500);
  }
  renderTemplates();
}

function dayTypeTmplCardHtml(t) {
  const color = dayTypeDisplayMeta(t.name).color;
  const symbol = dayTypeSymbolMeta(t.symbolKey).glyph;
  return `<article class="template-card simple-template-card day-type" id="day-type-tmpl-card-${t.id}" style="--template-color:${color}">
    <div class="template-card-head">
      <div class="template-card-title"><i></i><div><b><span class="day-type-template-symbol">${symbol}</span>${escHtmlApp(t.name || '未命名类型')}</b><small>日期类型模板</small></div></div>
    </div>
    <div class="template-status-list">
      <span class="${t.excludeFromRating ? 'active warning' : 'muted'}">${t.excludeFromRating ? '不参与评分' : '参与评分'}</span>
    </div>
    <div class="template-card-actions">
      <button class="btn btn-ghost btn-sm" onclick="dayTypeTmplStartEdit('${t.id}')">编辑</button>
      <button class="btn btn-danger btn-sm" onclick="dayTypeTmplDelete('${t.id}')">删除</button>
    </div>
  </article>`;
}

function dayTypeTmplEditFormHtml(t) {
  return `<div class="template-editor-grid compact">
    <div class="form-group"><label>类型名称</label><input type="text" id="day-type-tmpl-edit-${t.id}-name" value="${escHtmlApp(t.name || '')}"></div>
    <div class="form-group"><label>日期类型符号</label><select id="day-type-tmpl-edit-${t.id}-symbol">${dayTypeSymbolOptionsHtml(t.symbolKey || nextAvailableDayTypeSymbol(t.id), t.id)}</select></div>
    <div class="template-option-panel">
      <label><input type="checkbox" id="day-type-tmpl-edit-${t.id}-exclude" ${t.excludeFromRating ? 'checked' : ''}> 默认不参与评分（排除范围汇总）</label>
    </div></div>
    <div class="template-editor-actions">
      <button class="btn btn-success btn-sm" onclick="dayTypeTmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="dayTypeTmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

function dayTypeTmplStartEdit(id) {
  const template = getDayTypeTemplates().find(item => item.id === id);
  const host = document.getElementById('day-type-template-edit-host');
  if (!template || !host) return;
  const newBody = document.getElementById('day-type-tmpl-form-body');
  if (newBody) newBody.style.display = 'none';
  document.getElementById('day-type-template-new-panel')?.classList.remove('open');
  const toggle = document.getElementById('day-type-tmpl-form-toggle');
  if (toggle) toggle.textContent = '展开';
  host.innerHTML = templateEditorPanelHtml(`编辑日期类型 · ${escHtmlApp(template.name || '未命名类型')}`, '修改日期类型符号和评分默认规则。', dayTypeTmplEditFormHtml(template), 'day-type-template-editor');
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function dayTypeTmplCancelEdit(id) {
  const host = document.getElementById('day-type-template-edit-host');
  if (host) host.innerHTML = '';
}

async function dayTypeTmplSaveEdit(id) {
  const tmpl = { id, ...readDayTypeTemplateForm(`day-type-tmpl-edit-${id}-`) };
  if (!tmpl.name) {
    alert('请填写日期类型名称');
    return;
  }
  if (!validateDayTypeTemplate(tmpl, id)) return;
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

function templateQuantityProgress(template) {
  const unit = String(template?.quantityUnit || '').trim();
  let totalQuantity = 0;
  let totalMinutes = 0;
  let excluded = 0;
  const records = getForecastTaskEntries()
    .filter(({ task }) => resolveTaskTemplateId(task) === template?.id)
    .sort((a, b) => a.date.localeCompare(b.date))
    .reduce((list, { date, task }) => {
      const quantity = Number(task.quantity);
      const taskUnit = String(task.quantityUnit || unit || '').trim();
      if (!Number.isFinite(quantity) || quantity <= 0) return list;
      if (unit && taskUnit && taskUnit !== unit) {
        excluded += 1;
        return list;
      }
      const minutes = Number(task.minutes) || 0;
      totalQuantity += quantity;
      totalMinutes += minutes;
      list.push({
        date,
        taskId: task.id || '',
        taskName: task.name || '未命名任务',
        activityType: task.activityType || '',
        minutes,
        quantity,
        cumulative: totalQuantity,
        unit: taskUnit || unit || '数量',
        accuracy: visibleTaskAccuracy(task),
        wrong: visibleTaskWrongCount(task),
        note: task.note || '',
      });
      return list;
    }, []);
  return {
    unit: unit || '数量',
    totalQuantity,
    totalMinutes,
    averageRate: totalMinutes > 0 ? totalQuantity / totalMinutes : null,
    records,
    excluded,
  };
}

function templateOpenTask(dateStr, encodedTaskId) {
  const taskId = decodeURIComponent(encodedTaskId || '');
  if (!dateStr || !taskId) return;
  monthEditTask(dateStr, taskId);
}

function templateTaskLinkHtml(dateStr, task) {
  const taskName = escHtmlApp(task?.name || '未命名任务');
  if (!task?.id) return `<span class="template-task-link disabled" title="该历史任务缺少ID，无法编辑">${taskName}</span>`;
  const encodedId = encodeURIComponent(task.id).replace(/'/g, '%27');
  return `<button type="button" class="template-task-link" onclick="templateOpenTask('${dateStr}','${encodedId}')">${taskName}</button>`;
}

function templateTaskHistoryHtml(template) {
  const chapterEnabled = Boolean(template.namedItemEnabled ?? template.ordinalEnabled);
  const quantityEnabled = Boolean(template.quantityEnabled);
  const templateUnit = String(template.quantityUnit || '').trim();
  let cumulativeQuantity = 0;
  const records = getTasksForTemplate(template.id)
    .map((record, sourceOrder) => ({ ...record, sourceOrder }))
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.sourceOrder - b.sourceOrder)
    .map(record => {
      const task = record.task;
      const minutes = Math.max(0, Number(task.minutes) || 0);
      const quantity = Number(task.quantity);
      const taskUnit = String(task.quantityUnit || templateUnit || '').trim();
      const validQuantity = quantityEnabled && Number.isFinite(quantity) && quantity > 0 && (!templateUnit || !taskUnit || taskUnit === templateUnit);
      if (validQuantity) cumulativeQuantity += quantity;
      return {
        ...record,
        minutes,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        taskUnit: taskUnit || templateUnit || '数量',
        validQuantity,
        cumulativeQuantity: validQuantity ? cumulativeQuantity : null,
        allocations: chapterEnabled ? taskNamedItemAllocations(task) : [],
      };
    });
  const totalMinutes = records.reduce((sum, record) => sum + record.minutes, 0);
  const columnCount = 4 + (chapterEnabled ? 1 : 0) + (quantityEnabled ? 3 : 0);
  const rows = records.map(record => {
    const encodedId = record.task.id ? encodeURIComponent(record.task.id).replace(/'/g, '%27') : '';
    const chapterHtml = chapterEnabled
      ? `<td class="template-task-chapters">${record.allocations.length ? record.allocations.map(allocation => `<span><b>${escHtmlApp(allocation.itemName)}</b><small>${allocation.minutes > 0 ? fmtMin(allocation.minutes, true) : '未分配时长'}${quantityEnabled && allocation.quantity != null ? ` · +${forecastDisplayMetric(allocation.quantity)} ${escHtmlApp(record.taskUnit)}` : ''}${allocation.completed ? ' · 本次完成' : ''}</small></span>`).join('') : '<span class="c-muted">未关联章节</span>'}</td>`
      : '';
    const quantityHtml = quantityEnabled
      ? `<td class="fw-mono">${record.quantity == null ? '-' : `+${forecastDisplayMetric(record.quantity)} ${escHtmlApp(record.taskUnit)}`}${record.quantity != null && !record.validQuantity ? '<small class="template-task-warning">单位不匹配，未累计</small>' : ''}</td><td class="fw-mono c-actual">${record.cumulativeQuantity == null ? '-' : `${forecastDisplayMetric(record.cumulativeQuantity)} ${escHtmlApp(record.taskUnit)}`}</td><td class="fw-mono">${record.validQuantity && record.minutes > 0 ? formatQuestionEfficiency(record.quantity / record.minutes, record.taskUnit, 2) : '-'}</td>`
      : '';
    return `<tr>
      <td><button type="button" class="template-task-date" onclick="openEntryDate('${record.dateStr}')">${formatShort(record.dateStr)}</button></td>
      <td>${templateTaskLinkHtml(record.dateStr, record.task)}</td>
      <td class="fw-mono">${fmtMin(record.minutes, true)}</td>
      ${chapterHtml}${quantityHtml}
      <td>${encodedId ? `<button type="button" class="btn btn-ghost btn-sm" onclick="templateOpenTask('${record.dateStr}','${encodedId}')">编辑</button>` : '<button type="button" class="btn btn-ghost btn-sm" disabled>不可编辑</button>'}</td>
    </tr>`;
  }).join('');
  return `<details class="template-detail-panel template-task-history">
    <summary>关联任务明细 <span>${records.length} 条 · ${fmtMin(totalMinutes, true)}${quantityEnabled && cumulativeQuantity > 0 ? ` · ${forecastDisplayMetric(cumulativeQuantity)} ${escHtmlApp(templateUnit || '数量')}` : ''}</span></summary>
    <div class="template-task-ledger-wrap"><table class="template-task-ledger ${chapterEnabled ? 'has-chapters' : ''} ${quantityEnabled ? 'has-quantity' : ''}">
      <colgroup><col class="template-ledger-date"><col class="template-ledger-name"><col class="template-ledger-duration">${chapterEnabled ? '<col class="template-ledger-chapters">' : ''}${quantityEnabled ? '<col class="template-ledger-quantity"><col class="template-ledger-cumulative"><col class="template-ledger-efficiency">' : ''}<col class="template-ledger-action"></colgroup>
      <thead><tr><th>日期</th><th>任务</th><th>时长</th>${chapterEnabled ? '<th>章节贡献</th>' : ''}${quantityEnabled ? '<th>本次数量</th><th>累计数量</th><th>效率</th>' : ''}<th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${columnCount}" class="template-task-empty">该模板目前没有关联任务。</td></tr>`}</tbody>
    </table></div>
  </details>`;
}

function templateCardMetricsHtml(t, libraryProgress, quantityProgress) {
  const chapterEnabled = Boolean(t.namedItemEnabled ?? t.ordinalEnabled);
  const activeItemCount = (t.namedItems || []).filter(item => !item.archived).length;
  return `<div class="template-metric-grid">
    <div><span>默认时长</span><strong>${t.defaultMinutes ? fmtMin(Number(t.defaultMinutes), true) : '-'}</strong><small>录入时自动带入</small></div>
    <div><span>章节进度</span><strong>${chapterEnabled ? `${libraryProgress.completedActive}/${activeItemCount}` : '-'}</strong><small>${chapterEnabled ? `${activeItemCount} 个活动章节` : '未开启命名章节'}</small></div>
    <div><span>数量累计</span><strong>${t.quantityEnabled ? `${forecastDisplayMetric(quantityProgress.totalQuantity)} ${escHtmlApp(quantityProgress.unit)}` : '-'}</strong><small>${t.quantityEnabled ? `${quantityProgress.records.length} 条任务记录` : '未开启数量记录'}</small></div>
  </div>`;
}

function templateCardActionsHtml(t) {
  const chapterEnabled = Boolean(t.namedItemEnabled ?? t.ordinalEnabled);
  return `<div class="template-card-actions">
    ${chapterEnabled ? `<button class="btn btn-primary btn-sm" onclick="tmplManageNamedItems('${t.id}')">章节库</button>` : ''}
    <button class="btn btn-ghost btn-sm" onclick="tmplStartEdit('${t.id}')">编辑</button>
    <details class="template-more-menu">
      <summary class="btn btn-ghost btn-sm">更多操作</summary>
      <div>
        <button type="button" onclick="tmplClearHistoricalDimension('${t.id}','ordinal')">清除章节历史数据</button>
        <button type="button" onclick="tmplClearHistoricalDimension('${t.id}','quantity')">清除数量历史数据</button>
        <button type="button" class="danger" onclick="tmplDelete('${t.id}')">删除模板</button>
      </div>
    </details>
  </div>`;
}

function tmplCardHtml(t) {
  const actColor = getActColor(t.activityType || '');
  const libraryProgress = namedItemLibraryProgress(t.id);
  const quantityProgress = t.quantityEnabled ? templateQuantityProgress(t) : null;
  const activeItemCount = (t.namedItems || []).filter(item => !item.archived).length;
  const chapterEnabled = Boolean(t.namedItemEnabled ?? t.ordinalEnabled);
  return `<article class="template-card task-template-card" id="tmpl-card-${t.id}" style="--template-color:${actColor.color}">
    <div class="template-card-head">
      <div class="template-card-title"><i></i><div><b>${escHtmlApp(t.activityType || '未分类模板')}</b><small>任务模板</small></div></div>
      <div class="template-status-list">
        <span class="${chapterEnabled ? 'active' : 'muted'}">${chapterEnabled ? '命名章节' : '章节关闭'}</span>
        <span class="${t.quantityEnabled ? 'active' : 'muted'}">${t.quantityEnabled ? `数量 · ${escHtmlApp(t.quantityUnit || '未设置单位')}` : '数量关闭'}</span>
        <span class="${t.accuracyEnabled ? 'active' : 'muted'}">${t.accuracyEnabled ? '正确率开启' : '正确率关闭'}</span>
        <span class="${t.scoreEnabled ? 'active' : 'muted'}">${t.scoreEnabled ? `分数 · 每章满分 ${Number(t.scoreMax)}` : '分数关闭'}</span>
        ${!chapterEnabled && !t.quantityEnabled ? '<span class="muted">不参与预测</span>' : ''}
      </div>
    </div>
    ${templateCardMetricsHtml(t, libraryProgress, quantityProgress || { totalQuantity: 0, unit: t.quantityUnit || '数量', records: [] })}
    <p class="template-card-note ${t.note ? '' : 'muted'}">${t.note ? escHtmlApp(t.note) : '未填写模板说明'}</p>
    ${templateCardActionsHtml(t)}
    <div class="template-card-details">
      ${templateTaskHistoryHtml(t)}
      <details class="template-detail-panel">
        <summary>模板说明 <span>${t.note ? '已填写' : '未填写'}</span></summary>
        <div class="template-note-editor">
          <label><span class="form-hint">说明仅在模板库中显示</span><textarea id="tmpl-inline-note-${t.id}" rows="3" maxlength="500" placeholder="填写用途、范围或其他说明">${escHtmlApp(t.note || '')}</textarea></label>
          <button type="button" class="btn btn-ghost btn-sm" onclick="tmplSaveInlineNote('${t.id}')">保存备注</button>
        </div>
      </details>
    </div>
  </article>`;
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
  return `<div class="template-editor-section">
    <div class="template-editor-section-head"><b>绑定活动类别</b><span>修改完整分类路径</span></div>
    <div class="template-category-grid">
      <label><span>一级</span>${catSelectorHtml(1, 'tmpl-edit-l1-' + t.id, l1, 'tmpl-edit-cat-msg-' + t.id)}</label>
      <label><span>二级</span>${catSelectorHtml(2, 'tmpl-edit-l2-' + t.id, l2, 'tmpl-edit-cat-msg-' + t.id)}</label>
      <label><span>三级</span>${catSelectorHtml(3, 'tmpl-edit-l3-' + t.id, l3, 'tmpl-edit-cat-msg-' + t.id)}</label>
    </div>
    <div class="template-inline-message" id="tmpl-edit-cat-msg-${t.id}"></div>
  </div>
  <div class="template-editor-section">
    <div class="template-editor-section-head"><b>默认设置</b><span>控制录入和预测使用的模板能力</span></div>
    <div class="template-editor-grid">
      <div class="form-group"><label>默认时长(分钟)</label>
        <input type="number" id="tmpl-edit-min-${t.id}" value="${t.defaultMinutes || ''}"></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-quantity-enabled-${t.id}" ${t.quantityEnabled ? 'checked' : ''} onchange="syncTemplateAccuracyControls('tmpl-edit-quantity-enabled-${t.id}','tmpl-edit-accuracy-enabled-${t.id}','quantity');syncTaskTemplateChapterScoringControls('tmpl-edit','${t.id}')"> 开启数量单位</label>
        ${unitSelectorHtml('tmpl-edit-unit-' + t.id, t.quantityUnit || '', 'tmpl-edit-unit-msg-' + t.id)}
        <div style="font-size:11px;font-family:var(--mono)" id="tmpl-edit-unit-msg-${t.id}"></div>
        <div class="form-hint">关闭时保留单位文字，但不参与录入和预测。</div></div>
      <div class="form-group"><label>模板说明（不会带入任务记录）</label>
        <textarea id="tmpl-edit-note-${t.id}" rows="3" maxlength="500">${escHtmlApp(t.note || '')}</textarea></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-ordinal-enabled-${t.id}" ${(t.namedItemEnabled ?? t.ordinalEnabled) ? 'checked' : ''} onchange="syncTaskTemplateChapterScoringControls('tmpl-edit','${t.id}')"> 开启命名章节记录</label>
        <div class="form-hint">章节名称在共享章节库中维护，不再使用“第N单位”。</div></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-accuracy-enabled-${t.id}" ${t.accuracyEnabled ? 'checked' : ''} ${t.quantityEnabled ? '' : 'disabled'} onchange="syncTemplateAccuracyControls('tmpl-edit-quantity-enabled-${t.id}','tmpl-edit-accuracy-enabled-${t.id}','accuracy');syncTemplatePerformanceControls('tmpl-edit-accuracy-enabled-${t.id}','tmpl-edit-score-enabled-${t.id}','accuracy')"> 开启正确率记录</label>
        <div class="form-hint">开启后，总数量和错误数量在任务录入时均为必填。</div></div>
      <div class="form-group template-unit-config"><label>
        <input type="checkbox" id="tmpl-edit-score-enabled-${t.id}" ${t.scoreEnabled ? 'checked' : ''} onchange="syncTemplatePerformanceControls('tmpl-edit-accuracy-enabled-${t.id}','tmpl-edit-score-enabled-${t.id}','score')"> 开启分数记录</label>
        <label for="tmpl-edit-score-max-${t.id}">每章满分</label>
        <input type="number" id="tmpl-edit-score-max-${t.id}" min="0.1" step="0.1" value="${t.scoreMax ?? ''}" placeholder="例如 100"></div>
    </div></div>
    <div class="template-editor-actions">
      <button class="btn btn-success btn-sm" onclick="tmplSaveEdit('${t.id}')">✓ 保存修改</button>
      <button class="btn btn-ghost btn-sm" onclick="tmplCancelEdit('${t.id}')">取消</button>
    </div>`;
}

// ── Template helpers ──────────────────────────────────────────
function syncTaskTemplateChapterScoringControls(prefix = 'tmpl', templateId = '') {
  const edit = prefix === 'tmpl-edit';
  const ordinalId = edit ? `tmpl-edit-ordinal-enabled-${templateId}` : 'tmpl_ordinal_enabled';
  const scoringId = edit ? `tmpl-edit-score-enabled-${templateId}` : 'tmpl_score_enabled';
  const maxId = edit ? `tmpl-edit-score-max-${templateId}` : 'tmpl_score_max';
  const show = Boolean(document.getElementById(ordinalId)?.checked);
  const scoring = document.getElementById(scoringId);
  const max = document.getElementById(maxId);
  if (scoring) {
    scoring.disabled = !show;
    if (!show) scoring.checked = false;
  }
  if (max) max.disabled = !show;
}

function taskScoreIsVisible(task) {
  const template = getTaskTemplateForTask(task);
  return template ? Boolean(template.scoreEnabled) : task?.score != null && task?.score !== '';
}

function visibleTaskScore(task) {
  if (!taskScoreIsVisible(task)) return null;
  const template = getTaskTemplateForTask(task);
  const scoredItems = taskNamedItemAllocations(task).filter(item =>
    item.completed && item.score != null && Number.isFinite(item.score) && item.score >= 0);
  const hasTotal = task?.score != null && task.score !== '';
  if (!hasTotal && !scoredItems.length) return null;
  const score = hasTotal ? Number(task.score) : scoredItems.reduce((total, item) => total + item.score, 0);
  const perChapterMax = Number(template?.scoreMax);
  // Persisted totals retain the scoring scope of historical records.
  const max = hasTotal && task?.scoreMax != null
    ? Number(task.scoreMax)
    : perChapterMax * Math.max(1, hasTotal
      ? taskNamedItemAllocations(task).filter(item => item.completed).length : scoredItems.length);
  if (!hasTotal && scoredItems.some(item => item.score > perChapterMax)) return null;
  return Number.isFinite(score) && Number.isFinite(max) && max > 0 && score >= 0 && score <= max
    ? { score, max, rate: Number((score / max * 100).toFixed(2)) }
    : null;
}

function tmplToggleForm() {
  const body = document.getElementById('tmpl-form-body');
  const tog = document.getElementById('tmpl-form-toggle');
  const panel = document.getElementById('task-template-new-panel');
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  panel?.classList.toggle('open', open);
  if (open) {
    const editHost = document.getElementById('task-template-edit-host');
    if (editHost) editHost.innerHTML = '';
  }
  if (tog) tog.textContent = open ? '收起' : '展开';
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
  const quantityEnabled = document.getElementById('tmpl_quantity_enabled').checked;
  const scoreEnabled = document.getElementById('tmpl_score_enabled').checked;
  const scoreMax = Number(document.getElementById('tmpl_score_max').value) || null;
  if (scoreEnabled && !namedItemEnabled) { alert('分数记录必须与命名章节记录一起开启。'); return; }
  if (scoreEnabled && (!Number.isFinite(scoreMax) || scoreMax <= 0)) { alert('开启分数记录后，请填写大于 0 的每章满分。'); return; }
  const tmpl = {
    activityType,
    defaultMinutes: parseInt(document.getElementById('tmpl_minutes').value) || null,
    quantityUnit: document.getElementById('tmpl_unit').value.trim(),
    namedItemEnabled,
    namedItems: [],
    ordinalEnabled: namedItemEnabled,
    ordinalUnit: namedItemEnabled ? '项' : '',
    quantityEnabled,
    accuracyEnabled: document.getElementById('tmpl_accuracy_enabled').checked,
    scoreEnabled,
    scoreMax,
    note: document.getElementById('tmpl_note').value.trim(),
  };
  if (tmpl.quantityEnabled && !tmpl.quantityUnit) {
    alert('开启数量单位后必须填写数量单位。');
    return;
  }
  if (tmpl.accuracyEnabled && !tmpl.quantityEnabled) {
    alert('开启正确率记录前必须先开启数量记录。');
    return;
  }
  if (tmpl.accuracyEnabled && tmpl.scoreEnabled) {
    alert('正确率记录和分数记录不能同时开启。');
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
  const template = getTaskTemplateById(id);
  const host = document.getElementById('task-template-edit-host');
  if (!template || !host) return;
  const newBody = document.getElementById('tmpl-form-body');
  if (newBody) newBody.style.display = 'none';
  document.getElementById('task-template-new-panel')?.classList.remove('open');
  const toggle = document.getElementById('tmpl-form-toggle');
  if (toggle) toggle.textContent = '展开';
  const color = getActColor(template.activityType || '').color;
  host.innerHTML = templateEditorPanelHtml(`编辑任务模板 · ${escHtmlApp(template.activityType || '未分类模板')}`, '修改分类、默认时长、数量单位和章节能力。', tmplEditFormHtml(template), 'task-template-editor');
  host.firstElementChild?.style.setProperty('--template-color', color);
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function tmplCancelEdit(id) {
  const host = document.getElementById('task-template-edit-host');
  if (host) host.innerHTML = '';
}

function tmplPositionNamedItemsManager(id) {
  const host = document.getElementById('template-named-items-manager');
  const card = document.getElementById(`tmpl-card-${id}`);
  const grid = card?.closest('.task-template-grid');
  if (!host || !card || !grid) return false;
  const cards = [...grid.children].filter(child => child.classList.contains('task-template-card'));
  const cardIndex = cards.indexOf(card);
  if (cardIndex < 0) return false;
  const columnCount = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  const rowEndIndex = Math.min(cards.length - 1, Math.floor(cardIndex / columnCount) * columnCount + columnCount - 1);
  cards[rowEndIndex].insertAdjacentElement('afterend', host);
  return true;
}

function tmplManageNamedItems(id, options = {}) {
  const template = getTaskTemplateById(id);
  const host = document.getElementById('template-named-items-manager');
  if (!template || !host) return;
  if (!tmplPositionNamedItemsManager(id)) return;
  document.querySelectorAll('.task-template-card.chapter-open').forEach(card => card.classList.remove('chapter-open'));
  document.getElementById(`tmpl-card-${id}`)?.classList.add('chapter-open');
  state._templateNamedItemsOpenId = id;
  const forecastTab = document.getElementById('tab-forecast');
  if (forecastTab) forecastTab.innerHTML = '';
  const libraryProgress = namedItemLibraryProgress(template.id);
  const activeCount = (template.namedItems || []).filter(item => !item.archived).length;
  const color = getActColor(template.activityType || '').color;
  host.innerHTML = `<section class="template-chapter-workspace" style="--template-color:${color}">
    <div class="template-chapter-head">
      <div>
        <div class="template-eyebrow">SHARED CHAPTER LIBRARY</div>
        <h3>${escHtmlApp(forecastTemplateLabel(template))}</h3>
        <p>章节顺序、归档状态和完成进度会同步到任务录入与完成预测。</p>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="tmplCloseNamedItemsManager('${id}')">关闭章节库</button>
    </div>
    <div class="template-chapter-summary">
      <div><span>活动章节</span><strong>${activeCount}</strong></div>
      <div><span>已完成</span><strong>${libraryProgress.completedActive}/${activeCount}</strong></div>
      <div><span>已录入数量</span><strong>${template.quantityEnabled ? `${forecastDisplayMetric(libraryProgress.totalQuantity)} ${escHtmlApp(template.quantityUnit || '数量')}` : '-'}</strong></div>
    </div>
    ${forecastNamedItemsEditorHtml(template.namedItems || [], template.id)}
    <div class="template-chapter-actions">
      <button class="btn btn-success" onclick="tmplSaveNamedItems('${id}')">✓ 保存共享章节库</button>
      <button class="btn btn-ghost" onclick="tmplCloseNamedItemsManager('${id}')">取消</button>
    </div>
    ${tmplNamedItemsTransferPanelHtml(template)}
  </section>`;
  host.classList.add('open');
  if (options.scroll !== false) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tmplNamedItemsTransferPanelHtml(sourceTemplate) {
  const targets = getTaskTemplates().filter(template => template.id !== sourceTemplate.id);
  const activeCount = (sourceTemplate.namedItems || []).filter(item => !item.archived).length;
  return `<details class="template-transfer-panel">
    <summary>复制或覆盖章节库到其他模板</summary>
    <div class="template-transfer-body">
      <div class="form-hint template-transfer-note">
        源模板：${escHtmlApp(forecastTemplateLabel(sourceTemplate))} · ${activeCount} 个活动章节。只复制活动章节，不复制归档项目和完成进度。
      </div>
      <div class="form-group">
        <label>操作方式</label>
        <div class="template-choice-row">
          <label><input type="radio" name="tmpl_named_items_transfer_mode" value="merge" checked> 合并复制</label>
          <label><input type="radio" name="tmpl_named_items_transfer_mode" value="overwrite"> 覆盖活动章节</label>
        </div>
        <div class="form-hint">合并会保留目标顺序并追加缺少项；覆盖会让目标活动清单采用源模板顺序。</div>
      </div>
      <div class="form-group">
        <label>目标模板（可多选）</label>
        ${targets.length
          ? `<div class="template-transfer-targets">
              ${targets.map(target => `<label>
                <input type="checkbox" class="tmpl-named-items-transfer-target" value="${escHtmlApp(target.id)}">
                <span>${escHtmlApp(forecastTemplateLabel(target))}</span>
                <small>${(target.namedItems || []).filter(item => !item.archived).length} 个活动章节</small>
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

function tmplCloseNamedItemsManager(id = state._templateNamedItemsOpenId) {
  const host = document.getElementById('template-named-items-manager');
  if (host) {
    host.innerHTML = '';
    host.classList.remove('open');
  }
  if (id) document.getElementById(`tmpl-card-${id}`)?.classList.remove('chapter-open');
  state._templateNamedItemsOpenId = null;
}

let templateNamedItemsResizeTimer = null;
window.addEventListener('resize', () => {
  if (!state._templateNamedItemsOpenId) return;
  clearTimeout(templateNamedItemsResizeTimer);
  templateNamedItemsResizeTimer = setTimeout(() => {
    tmplPositionNamedItemsManager(state._templateNamedItemsOpenId);
  }, 120);
});

function tmplCanonicalNamedItems(items) {
  const normalized = (Array.isArray(items) ? items : []).map((item, index) => ({
    id: String(item?.id || ''),
    name: String(item?.name || '').trim(),
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
    archived: Boolean(item?.archived),
    questionCount: item?.questionCount ?? null,
  }));
  const active = normalized.filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const archived = normalized.filter(item => item.archived).sort((a, b) => a.order - b.order);
  return [...active, ...archived].map(item => ({
    id: item.id,
    name: item.name,
    archived: item.archived,
    questionCount: item.questionCount,
  }));
}

function tmplNamedItemsEditorHasUnsavedChanges(template) {
  if (Boolean(document.getElementById('forecast_chapter_quantity_only')?.checked) !== Boolean(template?.chapterQuantityOnly)) return true;
  if (forecastNamedItemRows().some(row => row.dataset.draft === 'true')) return true;
  const current = forecastCollectNamedItems().map(item => ({
    id: item.id,
    name: item.name,
    archived: item.archived,
    questionCount: item.questionCount,
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
      active.push({ id: uid(), name: sourceItem.name, archived: false, questionCount: sourceItem.questionCount });
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
      return { ...matched, name: sourceItem.name, archived: false, questionCount: sourceItem.questionCount };
    }
    return { id: uid(), name: sourceItem.name, archived: false, questionCount: sourceItem.questionCount };
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
    alert('共享章节库存在未保存的新增、改名、题数、排序或归档修改。请先保存章节库，再执行复制或覆盖。');
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
  tmplManageNamedItems(sourceId, { scroll: false });
}

async function tmplSaveNamedItems(id) {
  const template = getTaskTemplateById(id);
  if (!template) return;
  if (!forecastValidateNamedItemQuestionCounts()) return;
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
  template.chapterQuantityOnly = Boolean(document.getElementById('forecast_chapter_quantity_only')?.checked);
  template.namedItemEnabled = true;
  template.ordinalEnabled = true;
  await saveAllStorage();
  renderTemplates();
  tmplManageNamedItems(id, { scroll: false });
  showPersistentSaveNotice('共享章节库已保存');
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
  const quantityEnabled = document.getElementById(`tmpl-edit-quantity-enabled-${id}`).checked;
  const scoreEnabled = document.getElementById(`tmpl-edit-score-enabled-${id}`).checked;
  const scoreMax = Number(document.getElementById(`tmpl-edit-score-max-${id}`).value) || null;
  if (scoreEnabled && !namedItemEnabled) { alert('分数记录必须与命名章节记录一起开启。'); return; }
  if (scoreEnabled && (!Number.isFinite(scoreMax) || scoreMax <= 0)) { alert('开启分数记录后，请填写大于 0 的每章满分。'); return; }
  const tmpl = {
    id,
    activityType,
    defaultMinutes: parseInt(document.getElementById(`tmpl-edit-min-${id}`).value) || null,
    quantityUnit: document.getElementById(`tmpl-edit-unit-${id}`).value.trim(),
    namedItemEnabled,
    namedItems: Array.isArray(previous?.namedItems) ? previous.namedItems : [],
    chapterQuantityOnly: Boolean(previous?.chapterQuantityOnly),
    ordinalEnabled: namedItemEnabled,
    ordinalUnit: previous?.ordinalUnit || (namedItemEnabled ? '项' : ''),
    quantityEnabled,
    chapterMaxScore: previous?.chapterMaxScore ?? null,
    accuracyEnabled: document.getElementById(`tmpl-edit-accuracy-enabled-${id}`).checked,
    scoreEnabled,
    scoreMax,
    note: document.getElementById(`tmpl-edit-note-${id}`).value.trim(),
  };
  if (tmpl.quantityEnabled && !tmpl.quantityUnit) {
    alert('开启数量单位后必须填写数量单位。');
    return;
  }
  if (tmpl.accuracyEnabled && !tmpl.quantityEnabled) {
    alert('开启正确率记录前必须先开启数量记录。');
    return;
  }
  if (tmpl.accuracyEnabled && tmpl.scoreEnabled) {
    alert('正确率记录和分数记录不能同时开启。');
    return;
  }
  const changed = [];
  if (previous && Boolean(previous.namedItemEnabled ?? previous.ordinalEnabled) !== tmpl.namedItemEnabled) changed.push(`命名章节记录${tmpl.namedItemEnabled ? '开启' : '关闭'}`);
  if (previous && previous.quantityEnabled !== tmpl.quantityEnabled) changed.push(`数量记录${tmpl.quantityEnabled ? '开启' : '关闭'}`);
  if (previous && Boolean(previous.accuracyEnabled) !== tmpl.accuracyEnabled) changed.push(`正确率记录${tmpl.accuracyEnabled ? '开启' : '关闭'}`);
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

const VISUAL_COLOR_PALETTE = [
  '#69f0ae', '#4fc3f7', '#ce93d8', '#ffb74d', '#ef9a9a',
  '#80deea', '#ffd54f', '#a5d6a7', '#f48fb1', '#90caf9',
  '#b39ddb', '#ffcc80', '#80cbc4', '#e6ee9c', '#bcaaa4',
];

const VISUAL_SPECIAL_PALETTE = [
  '#ffb74d', '#ffcc80', '#ef9a9a', '#f48fb1', '#bcaaa4', '#e6ee9c',
];

const VISUAL_SYSTEM_DEFAULTS = {
  unclassified: '#78909c',
  specialDefault: '#ffb74d',
  taskTotal: '#69f0ae',
  specialTotal: '#ffb74d',
  rest: '#b388ff',
  distract: '#ef5350',
  idle: '#78909c',
  awake: '#ffd54f',
};

const VISUAL_CHART_DEFAULTS = {
  clock: '#80deea',
  effectiveClock: '#38d7ff',
  nominal: '#4fc3f7',
  actual: '#69f0ae',
  taskDuration: '#ce93d8',
  bedtime: '#b388ff',
  wake: '#ffd54f',
  sleepBand: '#80deea',
  unavailable: '#ffb74d',
  chapterDuration: '#4fc3f7',
  chapterEfficiency: '#69f0ae',
  archived: '#9e9e9e',
  workbookQuestions: '#4fc3f7',
  workbookCumulativeQuestions: '#69f0ae',
  workbookErrorRate: '#ef9a9a',
  workbookCumulativeErrorRate: '#ffb74d',
  workbookAverageErrorRate: '#ffd54f',
  distribution1: '#80deea',
  distribution2: '#4fc3f7',
  distribution3: '#78909c',
  distribution4: '#b388ff',
  distribution5: '#ce93d8',
  distribution6: '#ffb74d',
  distribution7: '#69f0ae',
  distribution8: '#ef9a9a',
};

function isVisualHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

function visualColorHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function visualDefaultColor(scope, name, index = null) {
  if (scope === 'special') {
    if (name === '特殊时段') return VISUAL_SYSTEM_DEFAULTS.specialDefault;
    return VISUAL_SPECIAL_PALETTE[visualColorHash(`special:${name}`) % VISUAL_SPECIAL_PALETTE.length];
  }
  if (scope === 'level1' && Number.isInteger(index) && index >= 0) {
    return VISUAL_COLOR_PALETTE[index % VISUAL_COLOR_PALETTE.length];
  }
  return VISUAL_COLOR_PALETTE[visualColorHash(`${scope}:${name}`) % VISUAL_COLOR_PALETTE.length];
}

function visualColorBaseConfig() {
  return {
    version: 3,
    task: { level1: {}, level2: {}, level3: {} },
    special: {},
    system: { ...VISUAL_SYSTEM_DEFAULTS },
    chart: { ...VISUAL_CHART_DEFAULTS },
  };
}

function getVisualColorConfig() {
  const current = state.data.__visualColors__;
  const config = current && typeof current === 'object' ? current : visualColorBaseConfig();
  if (!config.task || typeof config.task !== 'object') config.task = {};
  ['level1', 'level2', 'level3'].forEach(group => {
    if (!config.task[group] || typeof config.task[group] !== 'object') config.task[group] = {};
  });
  if (!config.special || typeof config.special !== 'object') config.special = {};
  if (!config.system || typeof config.system !== 'object') config.system = {};
  if (!config.chart || typeof config.chart !== 'object') config.chart = {};
  Object.entries(VISUAL_SYSTEM_DEFAULTS).forEach(([key, color]) => {
    if (!isVisualHexColor(config.system[key])) config.system[key] = color;
  });
  Object.entries(VISUAL_CHART_DEFAULTS).forEach(([key, color]) => {
    if (!isVisualHexColor(config.chart[key])) config.chart[key] = color;
  });
  if (!Number.isFinite(Number(config.version))) config.version = 1;
  state.data.__visualColors__ = config;
  return config;
}

function visualColorRecordDays() {
  return Object.entries(state.data)
    .filter(([key, day]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && day && typeof day === 'object')
    .map(([, day]) => day);
}

function collectVisualTaskPathSources(level) {
  const sources = new Map();
  const addPath = (activityType, source) => {
    const parts = parseActPath(activityType || '').slice(0, level);
    if (parts.length < level || parts.some(part => !part || part === '未分类')) return;
    const path = parts.join(' > ');
    if (!sources.has(path)) sources.set(path, { library: false, template: false, history: false });
    sources.get(path)[source] = true;
  };
  if (level === 1) getCatList(1).forEach(name => addPath(name, 'library'));
  getTaskTemplates().forEach(template => addPath(template.activityType, 'template'));
  visualColorRecordDays().forEach(day => {
    (day.tasks || []).forEach(task => addPath(task.activityType, 'history'));
  });
  return sources;
}

function collectVisualTaskPaths(level) {
  return [...collectVisualTaskPathSources(level).keys()];
}

function normalizeSpecialColorName(name) {
  return String(name || '')
    .replace(/^[🔸🧩]\s*/, '')
    .replace(/（不可用部分）$/, '')
    .trim() || '特殊时段';
}

function collectVisualSpecialNames() {
  const names = new Set(getSessionTemplates().map(template => normalizeSpecialColorName(template.name)));
  visualColorRecordDays().forEach(day => {
    (day.sessions || []).forEach(session => {
      if (isUnavailableSession(session) || isSpecialStudySession(session)) {
        names.add(normalizeSpecialColorName(session.name || (isSpecialStudySession(session) ? '特殊学习' : '特殊时段')));
      }
    });
  });
  return [...names].filter(Boolean);
}

function ensureVisualCategoryColor(level, name, index = null, config = getVisualColorConfig()) {
  const group = `level${level}`;
  if (level !== 1 || !name || !config.task[group]) return;
  if (!isVisualHexColor(config.task[group][name])) {
    config.task[group][name] = visualDefaultColor(group, name, index);
  }
}

function migrateVisualColors() {
  const config = getVisualColorConfig();
  const level1Library = getCatList(1);
  collectVisualTaskPaths(1).forEach((name, index) => {
    if (isVisualHexColor(config.task.level1[name])) return;
    const libraryIndex = level1Library.indexOf(name);
    config.task.level1[name] = libraryIndex >= 0 && isVisualHexColor(SETTINGS.actColors?.[libraryIndex]?.color)
      ? SETTINGS.actColors[libraryIndex].color
      : visualDefaultColor('level1', name, libraryIndex >= 0 ? libraryIndex : index);
  });
  [2, 3].forEach(level => {
    const group = `level${level}`;
    const previous = { ...(config.task[group] || {}) };
    const migrated = {};
    Object.entries(previous).forEach(([key, color]) => {
      if (key.includes(' > ') && isVisualHexColor(color)) migrated[key] = color;
    });
    collectVisualTaskPaths(level).forEach(path => {
      if (isVisualHexColor(migrated[path])) return;
      const leaf = parseActPath(path)[level - 1];
      migrated[path] = isVisualHexColor(previous[leaf])
        ? previous[leaf]
        : visualDefaultColor(group, path);
    });
    config.task[group] = migrated;
  });
  collectVisualSpecialNames().forEach(name => {
    if (!isVisualHexColor(config.special[name])) {
      config.special[name] = name === '特殊时段'
        ? config.system.specialDefault
        : visualDefaultColor('special', name);
    }
  });
  config.version = 3;
  return config;
}

function getCategoryColor(path, level = 'auto') {
  if (!String(path || '').trim() || String(path).trim() === '未分类') {
    return getSystemSeriesColor('unclassified');
  }
  const parts = parseActPath(path);
  const config = getVisualColorConfig();
  const availableLevel = parts[2] ? 3 : parts[1] ? 2 : parts[0] ? 1 : 0;
  const targetLevel = level === 'auto'
    ? (parts[2] ? 3 : parts[1] ? 2 : parts[0] ? 1 : 0)
    : Math.min(availableLevel, Math.max(1, Math.min(3, Number(level) || 1)));
  if (!targetLevel) return config.system.unclassified;
  const key = parts.slice(0, targetLevel).join(' > ');
  const color = config.task[`level${targetLevel}`]?.[key];
  return isVisualHexColor(color) ? color : visualDefaultColor(`level${targetLevel}`, key);
}

function getSpecialSeriesColor(name) {
  const normalized = normalizeSpecialColorName(name);
  const config = getVisualColorConfig();
  return isVisualHexColor(config.special[normalized])
    ? config.special[normalized]
    : normalized === '特殊时段'
      ? config.system.specialDefault
      : visualDefaultColor('special', normalized);
}

function getSystemSeriesColor(key) {
  const config = getVisualColorConfig();
  return isVisualHexColor(config.system[key]) ? config.system[key] : VISUAL_SYSTEM_DEFAULTS[key] || '#78909c';
}

function getChartSeriesColor(key) {
  const config = getVisualColorConfig();
  return isVisualHexColor(config.chart[key]) ? config.chart[key] : VISUAL_CHART_DEFAULTS[key] || '#78909c';
}

function getActColor(actName) {
  return { color: getCategoryColor(actName), cls: 'custom' };
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
  const daysWithData = days.filter(d => isEffectiveRecordDay(d.dateStr));
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

function isEffectiveRecordDay(dateStr) {
  const day = state.data[dateStr];
  if (!day) return false;
  return Boolean(
    (Array.isArray(day.sessions) && day.sessions.length > 0) ||
    (Array.isArray(day.tasks) && day.tasks.length > 0) ||
    day.wakeTime ||
    day.sleepTime ||
    day.dayType ||
    day.excludeFromRating
  );
}

function hasAnyRecordedContent(dateStr) {
  const day = state.data[dateStr];
  if (!day || typeof day !== 'object') return false;
  return Boolean(
    (Array.isArray(day.sessions) && day.sessions.length > 0) ||
    (Array.isArray(day.tasks) && day.tasks.length > 0) ||
    day.wakeTime ||
    day.sleepTime ||
    String(day.wakeNote || '').trim() ||
    String(day.sleepNote || '').trim() ||
    day.dayType ||
    day.excludeFromRating ||
    String(day.dayNote || '').trim()
  );
}

function getAllChartRecordDates() {
  return Object.keys(state.data)
    .filter(dateStr => /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && hasAnyRecordedContent(dateStr))
    .sort();
}

function chartDateStatus(dateStr) {
  if (hasAnyRecordedContent(dateStr)) return 'recorded';
  return dateStr > getTodayStr() ? 'future' : 'missing';
}

function chartMaskRecordedValues(dateStrs, values) {
  return (values || []).map((value, index) => chartDateStatus(dateStrs[index]) === 'recorded' ? value : null);
}

function noRecordRegionPlugin(dateStrs = [], statusResolver = chartDateStatus) {
  const statuses = dateStrs.map((dateStr, index) => statusResolver(dateStr, index));
  return {
    id: 'noRecordRegions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const xScale = scales?.x;
      if (!ctx || !chartArea || !xScale || !statuses.length) return;
      const xAt = index => xScale.getPixelForValue(index);
      let start = 0;
      while (start < statuses.length) {
        const status = statuses[start];
        if (status === 'recorded') { start += 1; continue; }
        let end = start;
        while (end + 1 < statuses.length && statuses[end + 1] === status) end += 1;
        const startX = xAt(start);
        const endX = xAt(end);
        const left = start === 0 ? chartArea.left : (xAt(start - 1) + startX) / 2;
        const right = end === statuses.length - 1 ? chartArea.right : (endX + xAt(end + 1)) / 2;
        if (Number.isFinite(left) && Number.isFinite(right) && right > left) {
          ctx.save();
          ctx.fillStyle = status === 'future' ? 'rgba(120,144,156,.055)' : 'rgba(120,144,156,.12)';
          ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
          ctx.beginPath();
          ctx.rect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
          ctx.clip();
          ctx.strokeStyle = status === 'future' ? 'rgba(120,144,156,.10)' : 'rgba(120,144,156,.22)';
          ctx.lineWidth = 1;
          const height = chartArea.bottom - chartArea.top;
          for (let x = left - height; x < right + height; x += 12) {
            ctx.beginPath();
            ctx.moveTo(x, chartArea.bottom);
            ctx.lineTo(x + height, chartArea.top);
            ctx.stroke();
          }
          ctx.restore();
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = status === 'future' ? 'rgba(120,144,156,.26)' : 'rgba(120,144,156,.48)';
          ctx.beginPath();
          ctx.moveTo(left, chartArea.top);
          ctx.lineTo(left, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = status === 'future' ? 'rgba(168,181,208,.62)' : 'rgba(168,181,208,.9)';
          ctx.font = '600 10px "Noto Sans SC", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(status === 'future' ? '尚未到达' : '无记录', (left + right) / 2, chartArea.top + 7, Math.max(18, right - left - 6));
          ctx.restore();
        }
        start = end + 1;
      }
    },
  };
}

function calcRangeKpiStats(values) {
  const vals = values.map(Number).filter(value => Number.isFinite(value));
  const n = vals.length;
  if (!n) return { n: 0, mean: 0, stdDev: 0, cv: null };
  const mean = vals.reduce((sum, value) => sum + value, 0) / n;
  const variance = vals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  return { n, mean, stdDev, cv: mean > 0 ? stdDev / mean : null };
}

function rangeKpiDurationSub(total, count, stats) {
  if (!count) return '日均 - · σ - · CV -';
  return `日均 ${fmtMin(Math.round(total / count), true)} · σ ${fmtMin(Math.round(stats.stdDev), true)} · CV ${fmtCV(stats.cv)}`;
}

function rangeKpiPercentSub(values) {
  const stats = calcRangeKpiStats(values);
  if (!stats.n) return '日均 - · σ - · CV -';
  return `日均 ${Math.round(stats.mean)}% · σ ${Math.round(stats.stdDev)}pp · CV ${fmtCV(stats.cv)}`;
}

function rangeKpiCountSub(values) {
  const stats = calcRangeKpiStats(values);
  if (!stats.n) return '日均 - · σ - · CV -';
  return `日均 ${stats.mean.toFixed(1)} · σ ${stats.stdDev.toFixed(1)} · CV ${fmtCV(stats.cv)}`;
}

function rangeKpiCardHtml({ group, label, value, sub = '', valueClass = '', valueStyle = '' }) {
  const styleAttr = valueStyle ? ` style="${valueStyle}"` : '';
  return `<div class="mini-card range-kpi-card range-kpi-${group}">
    <div class="lbl">${label}</div>
    <div class="val ${valueClass}"${styleAttr}>${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

function countDayTypes(dateStrs) {
  const effectiveDates = dateStrs.filter(dateStr => isEffectiveRecordDay(dateStr));
  const typedCount = effectiveDates.filter(dateStr => Boolean(String((state.data[dateStr] || {}).dayType || '').trim())).length;
  const excludedCount = effectiveDates.filter(dateStr => Boolean((state.data[dateStr] || {}).excludeFromRating)).length;
  return {
    total: effectiveDates.length,
    normal: effectiveDates.length - typedCount,
    typed: typedCount,
    excluded: excludedCount,
  };
}

function renderRangeKpiStatus(dayStats, options = {}) {
  const totalDays = options.totalDays ?? dayStats.length;
  const allEffectiveDays = dayStats.filter(day => isEffectiveRecordDay(day.dateStr));
  const dayTypeCounts = countDayTypes(allEffectiveDays.map(day => day.dateStr));
  const effectiveDays = options.excludeFromRating
    ? allEffectiveDays.filter(day => !state.data[day.dateStr]?.excludeFromRating)
    : allEffectiveDays;
  const effectiveCount = effectiveDays.length;
  const durationCard = ({ group = 'study', label, tip, key, valueClass = '', valueStyle = '' }) => {
    const values = effectiveDays.map(day => Math.max(0, Number(day[key]) || 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    return rangeKpiCardHtml({
      group,
      label: `${label}${tip ? tipIcon(tip) : ''}`,
      value: fmtHrs(total),
      sub: rangeKpiDurationSub(total, effectiveCount, calcRangeKpiStats(values)),
      valueClass,
      valueStyle,
    });
  };
  const countCard = ({ label, values, valueClass = '', valueStyle = '' }) => {
    const total = values.reduce((sum, value) => sum + value, 0);
    return rangeKpiCardHtml({
      group: 'count',
      label,
      value: String(total),
      sub: rangeKpiCountSub(values),
      valueClass,
      valueStyle,
    });
  };
  const focusDays = effectiveDays.filter(day => Number(day.effectiveClockMin) > 0 && day.focusEfficiency != null);
  const focusActual = focusDays.reduce((sum, day) => sum + (Number(day.actualMin) || 0), 0);
  const focusClock = focusDays.reduce((sum, day) => sum + (Number(day.effectiveClockMin) || 0), 0);
  const focusPct = focusClock > 0 ? Math.round(focusActual / focusClock * 100) : null;
  const awakeDays = effectiveDays.filter(day => day.awakeMin != null);
  const disposableDays = effectiveDays.filter(day => day.disposableMin != null);
  const awakeValues = awakeDays.map(day => Math.max(0, Number(day.awakeMin) || 0));
  const disposableValues = disposableDays.map(day => Math.max(0, Number(day.disposableMin) || 0));
  const totalAwake = awakeValues.reduce((sum, value) => sum + value, 0);
  const totalDisposable = disposableValues.reduce((sum, value) => sum + value, 0);
  const sessionCounts = effectiveDays.map(day => (day.sessions || []).length);
  const taskCounts = effectiveDays.map(day => (day.tasks || []).length);
  const taskActualDeviationValues = effectiveDays
    .filter(day => Number(day.actualMin) > 0)
    .map(day => ((Number(day.taskMin) || 0) - Number(day.actualMin)) / Number(day.actualMin) * 100);
  const taskActualDeviationStats = calcRangeKpiStats(taskActualDeviationValues);
  taskActualDeviationStats.cv = Math.abs(taskActualDeviationStats.mean) > Number.EPSILON
    ? taskActualDeviationStats.stdDev / Math.abs(taskActualDeviationStats.mean)
    : null;
  return `<div class="mini-grid range-kpi-grid ${options.className || ''}">
    ${rangeKpiCardHtml({
    group: 'days',
    label: '有效天数',
    value: `${effectiveCount}<span style="font-size:12px;opacity:.6">/${totalDays}天</span>`,
    sub: options.dayTypeFilterName
      ? `仅统计 ${escHtmlApp(options.dayTypeFilterName)} · 包含不评分日期`
      : options.includeAllDayTypes
        ? `完全统计 · 普通 ${dayTypeCounts.normal} · 类型日 ${dayTypeCounts.typed} · 含不评分 ${dayTypeCounts.excluded}`
      : options.excludedShellCount != null
        ? `计入统计 ${effectiveCount} · 不评分日期壳 ${options.excludedShellCount} · 类型日 ${dayTypeCounts.typed}`
        : options.excludeFromRating
          ? `计入汇总 ${effectiveCount} · 排除 ${dayTypeCounts.excluded} · 类型日 ${dayTypeCounts.typed}`
          : `普通 ${dayTypeCounts.normal} · 类型日 ${dayTypeCounts.typed}`,
    valueStyle: 'color:var(--hp)',
  })}
    ${durationCard({ label: '总时钟', tip: 'clock', key: 'clockMin', valueClass: 'c-clock' })}
    ${durationCard({ label: '总有效时钟', tip: 'effectiveClock', key: 'effectiveClockMin', valueClass: 'c-clock' })}
    ${durationCard({ label: '总名义', tip: 'nominal', key: 'nominalMin', valueClass: 'c-nominal' })}
    ${durationCard({ label: '总实际专注', tip: 'actual', key: 'actualMin', valueClass: 'c-actual' })}
    ${rangeKpiCardHtml({
    group: 'study',
    label: `任务/实际误差${tipIcon('taskActualDeviation')}`,
    value: taskActualDeviationStats.n ? devStr(Math.round(taskActualDeviationStats.mean)) : '-',
    sub: taskActualDeviationStats.n
      ? `${taskActualDeviationStats.n} 个有效日 · σ ${Math.round(taskActualDeviationStats.stdDev)}pp · CV ${fmtCV(taskActualDeviationStats.cv)}`
      : '平均误差 - · σ - · CV -',
    valueStyle: `color:${taskActualDeviationStats.n ? (taskActualDeviationStats.mean > 0 ? 'var(--thesis)' : taskActualDeviationStats.mean < 0 ? 'var(--red)' : 'var(--actual)') : 'var(--muted)'}`,
  })}
    ${durationCard({ label: '休息时间', tip: 'rest', key: 'restMin', valueStyle: 'color:var(--sleep)' })}
    ${durationCard({ label: '分心时间', tip: 'distract', key: 'distractMin', valueStyle: 'color:var(--red)' })}
    ${rangeKpiCardHtml({
    group: 'study',
    label: `专注率${tipIcon('efficiency')}`,
    value: focusPct != null ? `${focusPct}%` : '-',
    sub: rangeKpiPercentSub(focusDays.map(day => day.focusEfficiency)),
    valueStyle: `color:${focusPct == null ? 'var(--muted)' : 'var(--actual)'}`,
  })}
    ${rangeKpiCardHtml({
    group: 'life',
    label: `清醒时长${tipIcon('awake')}`,
    value: fmtHrs(totalAwake),
    sub: rangeKpiDurationSub(totalAwake, awakeValues.length, calcRangeKpiStats(awakeValues)),
    valueStyle: 'color:var(--wake)',
  })}
    ${rangeKpiCardHtml({
    group: 'life',
    label: '可支配时长',
    value: fmtHrs(totalDisposable),
    sub: rangeKpiDurationSub(totalDisposable, disposableValues.length, calcRangeKpiStats(disposableValues)),
    valueClass: 'c-clock',
  })}
    ${durationCard({ label: '不可用时间', key: 'unavailableMin', valueStyle: 'color:var(--thesis)' })}
    ${countCard({ label: '时段数量', values: sessionCounts, valueStyle: 'color:var(--hp)' })}
    ${countCard({ label: '任务数量', values: taskCounts, valueStyle: 'color:var(--pol)' })}
  </div>`;
}

const DAY_TYPE_COLORS = ['#b388ff', '#ffb74d', '#69f0ae', '#4fc3f7', '#ef9a9a', '#ce93d8', '#80deea', '#ffd54f'];

function dayTypeName(day) {
  return String(day?.dayType || '').trim();
}

function dayTypeStableIndex(value, length) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % Math.max(1, length);
}

function dayTypeDisplayMeta(dayOrType) {
  const day = typeof dayOrType === 'string' ? { dayType: dayOrType } : dayOrType;
  const name = dayTypeName(day);
  if (!name) return { name: '', symbol: '', color: '', historical: false, excluded: false };
  const template = getDayTypeTemplates().find(item => item.name === name);
  const fallbackSymbol = DAY_TYPE_SYMBOLS[dayTypeStableIndex(name, DAY_TYPE_SYMBOLS.length)];
  return {
    name,
    symbol: dayTypeSymbolMeta(template?.symbolKey || fallbackSymbol.key).glyph,
    color: DAY_TYPE_COLORS[dayTypeStableIndex(name, DAY_TYPE_COLORS.length)],
    historical: !template,
    excluded: Boolean(day?.excludeFromRating),
  };
}

function dayTypeBadgeHtml(day, emptyText = '-') {
  const meta = dayTypeDisplayMeta(day);
  if (!meta.name) return emptyText;
  const notes = [meta.historical ? '历史' : '', meta.excluded ? '不评分' : '评分'].filter(Boolean).join(' · ');
  return `<span class="day-type-flag active" style="--day-type-color:${meta.color}" title="日期类型：${escHtmlApp(meta.name)}${meta.historical ? '（历史类型）' : ''} · ${meta.excluded ? '不评分' : '评分'}"><i>${meta.symbol}</i>${escHtmlApp(meta.name)}<small>${notes}</small></span>`;
}

function dayTypeFilterOptions() {
  const options = new Map();
  getDayTypeTemplates().filter(template => template.name).forEach(template => {
    options.set(template.name, {
      ...dayTypeDisplayMeta(template.name),
      historical: false,
      // The legend represents the type definition, so retain the template's
      // default rating status instead of relying on an arbitrary date record.
      excluded: Boolean(template.excludeFromRating),
    });
  });
  Object.keys(state.data).filter(dateStr => !dateStr.startsWith('__')).forEach(dateStr => {
    const day = state.data[dateStr];
    const name = dayTypeName(day);
    if (name && !options.has(name)) options.set(name, dayTypeDisplayMeta(day));
  });
  return [...options.values()].sort((a, b) => Number(a.historical) - Number(b.historical) || a.name.localeCompare(b.name, 'zh-Hans'));
}

const DAY_TYPE_ALL_FILTER = '__all_day_types__';

function dayTypeRangeContext(baseDates, selectedType = '') {
  const options = dayTypeFilterOptions();
  if (selectedType === DAY_TYPE_ALL_FILTER) {
    return {
      baseDates,
      analysisDates: baseDates,
      displayDates: baseDates,
      shellDates: [],
      selection: DAY_TYPE_ALL_FILTER,
      selectedType: '',
      filtered: false,
      complete: true,
      includeExcluded: true,
      options,
    };
  }
  const validType = options.some(option => option.name === selectedType) ? selectedType : '';
  if (validType) {
    const analysisDates = baseDates.filter(dateStr => dayTypeName(state.data[dateStr]) === validType);
    return { baseDates, analysisDates, displayDates: analysisDates, shellDates: [], selection: validType, selectedType: validType, filtered: true, complete: false, includeExcluded: true, options };
  }
  const shellDates = baseDates.filter(dateStr => Boolean(dayTypeName(state.data[dateStr]) && state.data[dateStr]?.excludeFromRating));
  const shellSet = new Set(shellDates);
  return {
    baseDates,
    analysisDates: baseDates.filter(dateStr => !shellSet.has(dateStr)),
    displayDates: baseDates,
    shellDates,
    selection: '',
    selectedType: '',
    filtered: false,
    complete: false,
    includeExcluded: false,
    options,
  };
}

const ANALYSIS_RANGE_SCOPES = ['overview', 'stacked', 'session', 'task', 'sleep'];

function analysisRangeState(scope) {
  if (!ANALYSIS_RANGE_SCOPES.includes(scope)) return null;
  if (!state.analysisRanges) state.analysisRanges = {};
  if (!state.analysisRanges[scope]) {
    state.analysisRanges[scope] = {
      mode: '30d', start: '', end: '', dayTypeFilter: '', pickerOpen: false,
      hierarchyLevel: 'year', hierarchyYear: new Date().getFullYear(),
      hierarchyMonth: new Date().getMonth(), hierarchyWeekStart: '', hierarchyLabel: '',
    };
  }
  return state.analysisRanges[scope];
}

function analysisRangeRecordDates(scope) {
  return Object.keys(state.data).filter(dateStr => {
    if (dateStr.startsWith('__')) return false;
    const day = state.data[dateStr] || {};
    if (scope === 'overview') return hasAnyRecordedContent(dateStr);
    if (scope === 'session') return Array.isArray(day.sessions) && day.sessions.length > 0;
    if (scope === 'task') return Array.isArray(day.tasks) && day.tasks.length > 0;
    if (scope === 'sleep') return Boolean(day.wakeTime || day.sleepTime || String(day.wakeNote || '').trim() || String(day.sleepNote || '').trim());
    if (scope === 'stacked') {
      const breakdown = computeDayBreakdown(dateStr);
      return breakdown.awakeMin != null || breakdown.totalTaskMin > 0 || breakdown.totalSpecialMin > 0 ||
        breakdown.focusRestMin > 0 || breakdown.focusDistractMin > 0;
    }
    return false;
  }).sort();
}

function analysisRangeBaseDates(scope) {
  const range = analysisRangeState(scope);
  const today = getTodayStr();
  const records = analysisRangeRecordDates(scope);
  let start = addDays(today, -29);
  let end = today;
  if (range.mode === '7d') start = addDays(today, -6);
  else if (range.mode === '90d') start = addDays(today, -89);
  else if (range.mode === 'year') start = `${today.slice(0, 4)}-01-01`;
  else if (range.mode === 'all') start = records[0] || '';
  else if (range.mode === 'custom' || range.mode === 'hierarchy') {
    start = range.start;
    end = range.end;
  }
  return start && end ? overviewCalendarDates(start, end) : [];
}

function analysisRangeModeLabel(range) {
  return ({ '7d': '近7天', '30d': '近30天', '90d': '近90天', year: '本年度', all: '全部历史', custom: '自定义', hierarchy: range.hierarchyLabel || '层级选择' })[range.mode] || '近30天';
}

function analysisRangeMeta(scope) {
  const range = analysisRangeState(scope);
  const baseDates = analysisRangeBaseDates(scope);
  const context = dayTypeRangeContext(baseDates, range.dayTypeFilter);
  range.dayTypeFilter = context.selection;
  const relevantSet = new Set(analysisRangeRecordDates(scope));
  const recordedCount = context.analysisDates.filter(dateStr => relevantSet.has(dateStr)).length;
  const first = baseDates[0] || '';
  const last = baseDates[baseDates.length - 1] || '';
  return {
    scope, range, baseDates, context,
    analysisDates: context.analysisDates,
    displayDates: context.displayDates,
    start: first, end: last,
    label: `${analysisRangeModeLabel(range)}${first && last ? ` · ${formatShort(first)} — ${formatShort(last)}` : ' · 暂无相关记录'}`,
    recordedCount,
  };
}

function analysisRangeRender(scope) {
  const renderers = { overview: renderOverallOverview, stacked: renderStackedArea, session: renderSessAnalysis, task: renderTaskAnalysis, sleep: renderSleep };
  renderers[scope]?.();
}

function analysisRangeSetMode(scope, mode) {
  if (!['7d', '30d', '90d', 'year', 'all', 'custom'].includes(mode)) return;
  const range = analysisRangeState(scope);
  const today = getTodayStr();
  if (mode === 'custom' && (!range.start || !range.end)) {
    range.start = addDays(today, -29);
    range.end = today;
  }
  range.mode = mode;
  range.pickerOpen = false;
  analysisRangeRender(scope);
}

function analysisRangeApplyCustom(scope) {
  const range = analysisRangeState(scope);
  const start = document.getElementById(`analysis_range_${scope}_start`)?.value || '';
  const end = document.getElementById(`analysis_range_${scope}_end`)?.value || '';
  if (!start || !end) return alert('请选择自定义范围的开始日期和结束日期。');
  if (start > end) return alert('自定义范围的开始日期不能晚于结束日期。');
  if (start === end) return alert('自定义范围至少需要包含两天，开始日期不能等于结束日期。');
  range.start = start;
  range.end = end;
  range.mode = 'custom';
  analysisRangeRender(scope);
}

function analysisRangeSetDayType(scope, value) {
  const range = analysisRangeState(scope);
  if (!range) return;
  range.dayTypeFilter = value || '';
  analysisRangeRender(scope);
}

function analysisRangeTogglePicker(scope) {
  const range = analysisRangeState(scope);
  range.pickerOpen = !range.pickerOpen;
  if (range.pickerOpen && !['year', 'month', 'week', 'day'].includes(range.hierarchyLevel)) range.hierarchyLevel = 'year';
  if (range.pickerOpen && scope !== 'overview' && range.hierarchyLevel === 'day') range.hierarchyLevel = 'week';
  analysisRangeRender(scope);
}

function analysisRangeDrill(scope, level, year, month = 0, weekStart = '') {
  if (scope !== 'overview' && level === 'day') return;
  const range = analysisRangeState(scope);
  range.pickerOpen = true;
  range.hierarchyLevel = level;
  range.hierarchyYear = Number(year);
  range.hierarchyMonth = Number(month);
  range.hierarchyWeekStart = weekStart || '';
  analysisRangeRender(scope);
}

function analysisRangeChoose(scope, start, end, encodedLabel) {
  if (scope === 'overview' && start === end) {
    const range = analysisRangeState(scope);
    range.pickerOpen = false;
    state.selectedDate = start;
    showTab('day');
    return;
  }
  if (start === end) return alert('分析范围至少需要包含两天；请改选整周或更长范围。');
  const range = analysisRangeState(scope);
  range.mode = 'hierarchy';
  range.start = start;
  range.end = end;
  range.hierarchyLabel = decodeURIComponent(encodedLabel || '') || '层级选择';
  range.pickerOpen = false;
  analysisRangeRender(scope);
}

function analysisRangeChooseButton(scope, start, end, label, text = '选择') {
  return `<button type="button" class="btn btn-primary btn-sm" onclick="analysisRangeChoose('${scope}','${start}','${end}','${encodeURIComponent(label)}')">${text}</button>`;
}

function analysisRangePickerHtml(scope, meta) {
  const range = meta.range;
  if (!range.pickerOpen) return '';
  if (!['year', 'month', 'week', 'day'].includes(range.hierarchyLevel)) range.hierarchyLevel = 'year';
  if (scope !== 'overview' && range.hierarchyLevel === 'day') range.hierarchyLevel = 'week';
  const records = analysisRangeRecordDates(scope);
  const currentYear = new Date().getFullYear();
  const firstYear = records.length ? Number(records[0].slice(0, 4)) : currentYear;
  const years = Array.from({ length: Math.max(1, currentYear - firstYear + 1) }, (_, index) => currentYear - index);
  const year = Number(range.hierarchyYear) || currentYear;
  const month = Math.min(11, Math.max(0, Number(range.hierarchyMonth) || 0));
  const breadcrumbs = [`<button type="button" onclick="analysisRangeDrill('${scope}','year',${year})">年份</button>`];
  if (range.hierarchyLevel !== 'year') breadcrumbs.push(`<button type="button" onclick="analysisRangeDrill('${scope}','month',${year})">${year}年</button>`);
  if (['week', 'day'].includes(range.hierarchyLevel)) breadcrumbs.push(`<button type="button" onclick="analysisRangeDrill('${scope}','week',${year},${month})">${month + 1}月</button>`);
  if (range.hierarchyLevel === 'day') breadcrumbs.push(`<span>${formatShort(range.hierarchyWeekStart)} 起</span>`);

  let cards = '';
  if (range.hierarchyLevel === 'year') {
    cards = years.map(value => {
      const start = `${value}-01-01`, end = `${value}-12-31`, label = `${value}年`;
      return `<article class="analysis-range-card"><b>${label}</b><small>${value === currentYear ? '当前年份 · 保留未来日期' : '自然年度'}</small><div>${analysisRangeChooseButton(scope, start, end, label, '选择全年')}<button type="button" class="btn btn-ghost btn-sm" onclick="analysisRangeDrill('${scope}','month',${value})">查看月份 →</button></div></article>`;
    }).join('');
  } else if (range.hierarchyLevel === 'month') {
    cards = Array.from({ length: 12 }, (_, value) => {
      const start = `${year}-${String(value + 1).padStart(2, '0')}-01`;
      const end = dateToStr(new Date(year, value + 1, 0));
      const label = `${year}年${value + 1}月`;
      return `<article class="analysis-range-card"><b>${value + 1}月</b><small>${formatShort(start)} — ${formatShort(end)}</small><div>${analysisRangeChooseButton(scope, start, end, label, '选择整月')}<button type="button" class="btn btn-ghost btn-sm" onclick="analysisRangeDrill('${scope}','week',${year},${value})">查看周次 →</button></div></article>`;
    }).join('');
  } else if (range.hierarchyLevel === 'week') {
    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const monthEnd = dateToStr(new Date(year, month + 1, 0));
    const firstMonday = getMondayOfDate(strToDate(monthStart));
    const weeks = [];
    for (let monday = firstMonday; monday <= monthEnd; monday = addDays(monday, 7)) weeks.push(monday);
    cards = weeks.map((monday, index) => {
      const sunday = addDays(monday, 6);
      const label = `${year}年${month + 1}月第${index + 1}周`;
      const dayButton = scope === 'overview' ? `<button type="button" class="btn btn-ghost btn-sm" onclick="analysisRangeDrill('${scope}','day',${year},${month},'${monday}')">查看日期 →</button>` : '';
      return `<article class="analysis-range-card"><b>第${index + 1}周</b><small>${formatShort(monday)} — ${formatShort(sunday)}${monday < monthStart || sunday > monthEnd ? ' · 跨月' : ''}</small><div>${analysisRangeChooseButton(scope, monday, sunday, label, '选择整周')}${dayButton}</div></article>`;
    }).join('');
  } else {
    const monday = range.hierarchyWeekStart || getMondayOfDate(new Date());
    cards = getWeekDays(monday).map(dateStr => {
      const date = strToDate(dateStr);
      const label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
      return `<article class="analysis-range-card analysis-range-day"><b>${formatDisplay(dateStr)}</b><small>${dateStr}</small>${analysisRangeChooseButton(scope, dateStr, dateStr, label, scope === 'overview' ? '进入日览' : '选择这一天')}</article>`;
    }).join('');
  }
  return `<div class="analysis-range-picker"><div class="analysis-range-picker-head"><div class="analysis-range-breadcrumbs">${breadcrumbs.join('<i>›</i>')}</div><button type="button" class="btn btn-ghost btn-sm" onclick="analysisRangeTogglePicker('${scope}')">收起</button></div><div class="analysis-range-grid">${cards}</div></div>`;
}

function analysisRangePlannerHtml(scope, meta) {
  const range = meta.range;
  const options = [['7d', '7天'], ['30d', '30天'], ['90d', '90天'], ['year', '本年度'], ['all', '全部历史'], ['custom', '自定义']];
  const selectedMeta = meta.context.selectedType ? dayTypeDisplayMeta(meta.context.selectedType) : null;
  return `<section class="analysis-range-planner" data-range-scope="${scope}">
    <div class="analysis-range-main"><div class="analysis-range-presets">${options.map(([value, label]) => `<button type="button" class="${range.mode === value ? 'active' : ''}" onclick="analysisRangeSetMode('${scope}','${value}')">${label}</button>`).join('')}<button type="button" class="${range.mode === 'hierarchy' || range.pickerOpen ? 'active' : ''}" onclick="analysisRangeTogglePicker('${scope}')">层级选择</button></div><div class="analysis-range-summary"><span>当前范围</span><b>${escHtmlApp(meta.label)}</b><small>${meta.recordedCount} 个相关记录日 · 共 ${meta.baseDates.length} 天</small></div></div>
    ${range.mode === 'custom' ? `<div class="analysis-range-custom"><label><span>开始日期</span><input type="date" id="analysis_range_${scope}_start" value="${escHtmlApp(range.start)}"></label><label><span>结束日期</span><input type="date" id="analysis_range_${scope}_end" value="${escHtmlApp(range.end)}"></label><button type="button" class="btn btn-primary btn-sm" onclick="analysisRangeApplyCustom('${scope}')">应用范围</button></div>` : ''}
    <div class="analysis-range-filter-row"><label><span>日期类型筛选</span><select onchange="analysisRangeSetDayType('${scope}',this.value)"><option value="">常规统计（排除不评分数据）</option><option value="${DAY_TYPE_ALL_FILTER}" ${meta.context.complete ? 'selected' : ''}>完全统计（包含全部日期）</option>${meta.context.options.map(option => `<option value="${escHtmlApp(option.name)}" ${meta.context.selectedType === option.name ? 'selected' : ''}>${option.symbol} ${escHtmlApp(option.name)}${option.historical ? ' · 历史类型' : ''}</option>`).join('')}</select><small>${selectedMeta ? `仅显示 ${selectedMeta.symbol} ${escHtmlApp(selectedMeta.name)}` : meta.context.complete ? '全部日期均纳入统计' : `${meta.context.shellDates.length} 个不评分日期仅保留日期位置`}</small></label></div>
    ${analysisRangePickerHtml(scope, meta)}
  </section>`;
}

function dayTypeShellRowHtml(day, columnCount, filtered = false, sortValues = null, origin = 0) {
  const meta = dayTypeDisplayMeta(day);
  const sortAttrs = sortValues ? ` ${sortableTableRowAttrs(sortValues, origin)}` : '';
  return `<tr class="day-type-shell-row range-summary-clickable"${sortAttrs} onclick="openEntryDate('${day.dateStr || ''}')"><td class="fw-mono">${formatShort(day.dateStr || '')}<br>${dayTypeBadgeHtml(day)}</td><td colspan="${Math.max(1, columnCount - 1)}"><span class="day-type-shell-status">${escHtmlApp(meta.name)} · ${filtered ? '不评分 · 当前类型筛选中已纳入' : '不评分 · 已从统计数据排除'}</span></td></tr>`;
}

function getAllDates() {
  return Object.keys(state.data).filter(k => {
    if (k.startsWith('__')) return false;
    return isEffectiveRecordDay(k);
  }).sort();
}

// ============================================================
// CHART UTILITIES
// ============================================================
const GRID_COLOR = 'rgba(30,36,56,1)';
const gridCfg = { color: GRID_COLOR };

function destroyChart(id) { if (chartReg[id]) { chartReg[id].destroy(); delete chartReg[id]; } }
function destroyAll() { Object.keys(chartReg).forEach(destroyChart); }
function replaceRenderPanels(host, html, panelKeys) {
  const keys = Array.isArray(panelKeys) ? panelKeys.filter(Boolean) : [panelKeys].filter(Boolean);
  if (!host || !keys.length) return false;
  const template = document.createElement('template');
  template.innerHTML = String(html || '').trim();
  const replacements = keys.map(key => {
    const selector = `[data-render-panel="${key}"]`;
    return {
      current: host.querySelector(selector),
      next: template.content.querySelector(selector),
    };
  });
  if (replacements.some(item => !item.current || !item.next)) return false;
  replacements.forEach(item => item.current.replaceWith(item.next));
  return true;
}
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

function cumulativePositiveAverage(values, dateStrs = []) {
  let total = 0;
  let count = 0;
  return values.map((value, index) => {
    if (dateStrs.length && chartDateStatus(dateStrs[index]) !== 'recorded') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      total += numeric;
      count++;
    }
    return count ? Number((total / count).toFixed(2)) : null;
  });
}

function cumulativeFiniteAverage(values, dateStrs = []) {
  let total = 0;
  let count = 0;
  return values.map((value, index) => {
    if (dateStrs.length && chartDateStatus(dateStrs[index]) !== 'recorded') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      total += numeric;
      count++;
    }
    return count ? Number((total / count).toFixed(2)) : null;
  });
}

function rangeChartView(scope, chartKey) {
  const value = state.rangeChartViews?.[scope]?.[chartKey];
  return value === 'cumulativeAverage' ? value : 'daily';
}

function rangeChartViewTabsHtml(scope, chartKey) {
  const view = rangeChartView(scope, chartKey);
  return `<div class="task-analysis-view-tabs range-chart-view-tabs"><button type="button" class="${view === 'daily' ? 'active' : ''}" onclick="setRangeChartView('${scope}','${chartKey}','daily')">每日趋势</button><button type="button" class="${view === 'cumulativeAverage' ? 'active' : ''}" onclick="setRangeChartView('${scope}','${chartKey}','cumulativeAverage')">累计平均</button></div>`;
}

function setRangeChartView(scope, chartKey, view) {
  const valid =
    (scope === 'overview' && ['time', 'task', 'actual'].includes(chartKey)) ||
    (scope === 'task' && chartKey === 'task');
  if (!valid || !['daily', 'cumulativeAverage'].includes(view)) return;
  if (!state.rangeChartViews[scope]) state.rangeChartViews[scope] = { time: 'daily', task: 'daily' };
  state.rangeChartViews[scope][chartKey] = view;
  if (scope === 'task') renderTaskAnalysis('range-task');
  else renderOverallOverview(chartKey);
}

function threeDimTrendDatasets(items, view = 'daily') {
  const dateStrs = items.map(item => item.dateStr);
  const makePoints = (baseColor, baseRadius) => ({
    pointRadius: baseRadius,
    pointHoverRadius: baseRadius + 2,
    pointStyle: 'circle',
    pointBackgroundColor: baseColor,
    pointBorderColor: baseColor,
    pointBorderWidth: 1,
  });
  const series = [
    { label: '时钟', key: 'clockMin', color: getChartSeriesColor('clock'), alpha: .08, width: 1.4, dash: [6, 5], radius: 1.8, fill: false },
    { label: '有效时钟', key: 'effectiveClockMin', color: getChartSeriesColor('effectiveClock'), alpha: .1, width: 1.8, radius: 2.3, fill: 'origin' },
    { label: '名义', key: 'nominalMin', color: getChartSeriesColor('nominal'), alpha: .08, width: 1.8, radius: 2.3, fill: false },
    { label: '实际', key: 'actualMin', color: getChartSeriesColor('actual'), alpha: .16, width: 2.8, radius: 3, fill: 'origin' },
  ];
  return series.map(item => {
    const rawDailyData = items.map(row => durationDisplayValue(Number(row[item.key]) || 0));
    const dailyData = chartMaskRecordedValues(dateStrs, rawDailyData);
    return {
    label: view === 'cumulativeAverage' ? `累计平均${item.label}` : item.label,
    data: view === 'cumulativeAverage' ? cumulativePositiveAverage(rawDailyData, dateStrs) : dailyData,
    borderColor: item.color,
    backgroundColor: hexRgba(item.color, item.alpha),
    borderWidth: item.width,
    borderDash: item.dash || [],
    tension: .34,
    fill: item.fill,
    spanGaps: false,
    cubicInterpolationMode: 'monotone',
    ...makePoints(item.color, item.radius),
  };
  });
}

function threeDimStatusMarkerPlugin(items) {
  const metas = items.map(item => dayTypeDisplayMeta(state.data[item.dateStr]));
  return {
    id: 'threeDimStatusMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const xScale = scales?.x;
      if (!ctx || !chartArea || !xScale) return;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 11px "Noto Sans SC", sans-serif';

      metas.forEach((meta, index) => {
        if (!meta.symbol) return;

        const x = xScale.getPixelForValue(index);
        if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) return;
        const y = chartArea.bottom - 10;

        ctx.fillStyle = 'rgba(10,16,30,.76)';
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(220,232,255,.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = meta.color;
        ctx.fillText(meta.symbol, x, y + .5);
      });

      ctx.restore();
    },
  };
}

function threeDimTrendOptions(items, labels, mode = '') {
  const dayTypeMetas = items.map(item => dayTypeDisplayMeta(state.data[item.dateStr]));
  const xMaxRotation = items.length > 12 ? 45 : 0;
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: '#9fb0d6', boxWidth: 10, padding: 14, usePointStyle: true },
      },
      filler: { propagate: false },
      tooltip: {
        backgroundColor: 'rgba(10,16,30,.94)',
        borderColor: 'rgba(128,222,234,.32)',
        borderWidth: 1,
        titleColor: '#dce8ff',
        bodyColor: '#c8d4f0',
        callbacks: {
          title: tooltipItems => {
            if (!tooltipItems.length) return '';
            const index = tooltipItems[0].dataIndex;
            const meta = dayTypeMetas[index];
            if (!meta?.name) return labels[index];
            const status = meta.excluded ? (items[index]?._dayTypeFilterActive ? '不评分 · 筛选中纳入' : '不评分') : '评分';
            return `${labels[index]} · ${meta.symbol} ${meta.name} · ${status}`;
          },
          label: context => `${context.dataset.label}: ${fmtMin(Math.round(durationDisplayValueToMinutes(context.parsed.y)), true)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: '#7f8fb3',
          callback: function (value) {
            const index = Number(value);
            const label = labels[index] || this.getLabelForValue(value);
            return label;
          },
          autoSkip: true,
          maxTicksLimit: mode === 'overview' ? 24 : 14,
          maxRotation: xMaxRotation,
        },
        grid: { color: 'rgba(79,195,247,.08)' },
      },
      y: {
        min: 0,
        ticks: { color: '#7f8fb3', callback: value => `${value}${durationDisplayUnitSuffix()}` },
        grid: { color: 'rgba(30,36,56,.85)' },
        title: { display: true, text: durationDisplayUnitLabel(), color: '#7f8fb3' },
      },
    },
  };
}

function renderThreeDimTrendChart(chartId, items, labelFn, mode = '') {
  const labels = items.map((item, index) => labelFn ? labelFn(item, index) : formatShort(item.dateStr));
  const view = rangeChartView(mode, 'time');
  const dateStrs = items.map(item => item.dateStr);
  return mkChart(chartId, {
    type: 'line',
    data: { labels, datasets: threeDimTrendDatasets(items, view) },
    options: threeDimTrendOptions(items, labels, mode),
    plugins: [noRecordRegionPlugin(dateStrs), threeDimStatusMarkerPlugin(items)],
  });
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
  const today = getTodayStr();
  const todayStats = computeDay(today);
  const dayTypeCounts = countDayTypes(dates);

  document.getElementById('headerPeriod').textContent =
    `${formatShort(dates[0])} — ${formatShort(dates[dates.length - 1])}`;

  const cards = [
    { label: '有效天数', value: dayTypeCounts.total, unit: '天', sub: `普通 ${dayTypeCounts.normal} · 类型日 ${dayTypeCounts.typed} · 不评分 ${dayTypeCounts.excluded}`, color: 'var(--hp)' },
    { label: `今日·时钟${tipIcon('clock')}`, value: fmtHrs(todayStats.clockMin), unit: '', sub: `有效${fmtMin(todayStats.effectiveClockMin)} · 休息${fmtMin(todayStats.restMin)}`, color: 'var(--clock)' },
    { label: `今日·名义${tipIcon('nominal')}`, value: fmtHrs(todayStats.nominalMin), unit: '', sub: '今日名义时长', color: 'var(--nominal)' },
    { label: `今日·实际${tipIcon('actual')}`, value: fmtHrs(todayStats.actualMin), unit: '', sub: '今日实际专注', color: 'var(--actual)' },
    { label: `今日·休息${tipIcon('rest')}`, value: fmtHrs(todayStats.restMin), unit: '', sub: '普通专注时段休息', color: 'var(--sleep)' },
    { label: `今日·分心${tipIcon('distract')}`, value: fmtHrs(todayStats.distractMin), unit: '', sub: '时钟−实际−休息', color: 'var(--red)' },
    {
      label: `今日·专注率${tipIcon('efficiency')}`, value: todayStats.focusEfficiency != null ? todayStats.focusEfficiency + '%' : '-', unit: '', sub: '实际/有效时钟',
      color: todayStats.focusEfficiency == null ? 'var(--muted)' : 'var(--actual)'
    },
    { label: `今日·清醒${tipIcon('awake')}`, value: todayStats.awakeMin != null ? fmtHrs(todayStats.awakeMin) : '-', unit: '', sub: `${getDay(today).wakeTime || '?'} → ${getDay(today).sleepTime || '?'}`, color: 'var(--wake)' },
    { label: '今日·可支配', value: todayStats.disposableMin != null ? fmtHrs(todayStats.disposableMin) : '-', unit: '', sub: `清醒−不可用 ${fmtMin(todayStats.unavailableMin)}`, color: 'var(--clock)' },
    { label: '今日·不可用', value: fmtHrs(todayStats.unavailableMin), unit: '', sub: todayStats.utilPct != null ? `占清醒 ${todayStats.utilPct}%` : '缺少完整作息', color: todayStats.utilPct == null ? 'var(--muted)' : 'var(--thesis)' },
    { label: '今日·时段数量', value: todayStats.sessions.length, unit: '段', sub: `时钟 ${fmtHrs(todayStats.clockMin)}`, color: 'var(--hp)' },
    { label: `今日·任务量${tipIcon('taskMin')}`, value: todayStats.tasks.length, unit: '条', sub: `任务时长 ${fmtHrs(todayStats.taskMin)}`, color: 'var(--word)' },
    {
      label: `今日不可用占比${tipIcon('util')}`, value: todayStats.utilPct != null ? todayStats.utilPct + '%' : '-', unit: '', sub: `不可用${fmtMin(todayStats.unavailableMin)} / 清醒${fmtMin(todayStats.awakeMin)}`,
      color: todayStats.utilPct == null ? 'var(--muted)' : 'var(--thesis)'
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
const TAB_DEFINITIONS = [
  ['entry', '✏️ 录入'], ['calendar', '📆 日历'], ['day', '📊 日览'], ['overview', '🌐 总览'], ['stacked', '📊 堆积图'],
  ['sessAnalysis', '⏱️ 时段分析'], ['taskAnalysis', '📝 任务分析'], ['sleep', '🌙 作息'],
  ['export', '💾 导出'], ['templates', '📋 模板库'], ['forecast', '📅 完成预测'],
  ['workbookReview', '📚 整册复盘'], ['analysis', '⌁ 分析评分'], ['settings', '⚙️ 设置'],
];

let primaryTabsResizeObserver = null;

function updatePrimaryNavigationMode() {
  const wrapper = document.getElementById('primaryTabs');
  const list = document.getElementById('primaryTabsList');
  if (!wrapper || !list) return;
  wrapper.classList.toggle('is-compact', list.scrollWidth > Math.max(0, wrapper.clientWidth - 48));
}

function setupPrimaryNavigation() {
  const wrapper = document.getElementById('primaryTabs');
  if (!wrapper) return;
  wrapper.innerHTML = `<div class="tabs-list" id="primaryTabsList">${TAB_DEFINITIONS.map(([id, label]) =>
    `<button type="button" class="tab" data-tab-id="${id}" onclick="showTab('${id}')">${label}</button>`).join('')}</div>
    <label class="compact-tab-control"><span>当前页面</span><select id="compactTabSelect" onchange="showTab(this.value)">${TAB_DEFINITIONS.map(([id, label]) =>
      `<option value="${id}">${label}</option>`).join('')}</select></label>`;
  primaryTabsResizeObserver?.disconnect();
  primaryTabsResizeObserver = new ResizeObserver(() => requestAnimationFrame(updatePrimaryNavigationMode));
  primaryTabsResizeObserver.observe(wrapper);
  requestAnimationFrame(updatePrimaryNavigationMode);
}

function showTab(id) {
  if (id === 'week' || id === 'month') id = 'overview';
  if (state.tab === 'entry' && id !== 'entry' && document.getElementById('taskForm')) {
    saveDraft(state.selectedDate, collectEntryDraft());
  }
  destroyAll();
  state.tab = id;
  document.querySelectorAll('.tab[data-tab-id]').forEach(t => {
    const active = t.dataset.tabId === id;
    t.classList.toggle('active', active);
    if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const compactSelect = document.getElementById('compactTabSelect');
  if (compactSelect) compactSelect.value = id;
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'tab-' + id);
  });
  const renders = {
    entry: renderEntry, calendar: renderCalendar, day: renderDayOverview,
    overview: renderOverallOverview,
    stacked: renderStackedArea,
    sessAnalysis: renderSessAnalysis, taskAnalysis: renderTaskAnalysis,
    sleep: renderSleep,
    export: renderExport, templates: renderTemplates,
    forecast: renderForecast,
    workbookReview: renderWorkbookReview, analysis: renderAnalysis, settings: renderSettings
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
    day.wakeTime || day.wakeNote ? `<label><input type="checkbox" class="day-move-item" data-kind="wakeTime"> ☀️ 起床记录：${escHtmlApp(day.wakeTime || '无时间')}${day.wakeNote ? ` · ${escHtmlApp(String(day.wakeNote).slice(0, 36))}` : ''}</label>` : '',
    day.dayNote ? `<label><input type="checkbox" class="day-move-item" data-kind="dayNote"> 📝 今日备注：${escHtmlApp(String(day.dayNote).slice(0, 60))}</label>` : '',
    day.sleepTime || day.sleepNote ? `<label><input type="checkbox" class="day-move-item" data-kind="sleepTime"> 🌙 睡觉记录：${escHtmlApp(day.sleepTime || '无时间')}${day.sleepNote ? ` · ${escHtmlApp(String(day.sleepNote).slice(0, 36))}` : ''}</label>` : '',
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
      <button class="btn btn-primary btn-sm" onclick="moveSelectedDayData('${dateStr}','append')" ${total ? '' : 'disabled'}>迁移并追加</button>
      <button class="btn btn-danger btn-sm" onclick="moveSelectedDayData('${dateStr}','overwrite')" ${total ? '' : 'disabled'}>迁移并覆盖</button>
    </div>
    <div class="form-hint" style="margin-top:6px">追加：任务和不冲突的目标日旧时段会保留；若迁入时段与目标日旧时段重叠，会先删除目标日重叠旧时段，再追加新时段；起床、备注、睡觉选中后仍覆盖对应值。覆盖：先清空目标日全部原有数据，再写入本次所选项目。</div>
  </div>`;
}

let entryTextImportDraft = {
  dateStr: '',
  source: '',
  result: null,
};

function entryTextImportNormalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function entryTextImportMatchKey(value) {
  return entryTextImportNormalizeText(value)
    .replace(/[＞>]/g, '>')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, '')
    .replace(/^个/, '')
    .toLocaleLowerCase();
}

const ENTRY_TEXT_IMPORT_DELIMITER_PAIRS = new Map([
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['【', '】'],
  ['{', '}'],
  ['｛', '｝'],
]);

function entryTextImportNormalizeRangeLabel(value) {
  let label = entryTextImportNormalizeText(value)
    .replace(/[\s:：,，、;；]+$/, '')
    .trim();

  // 结构化字段紧邻的开定界符属于字段边界，不属于前面的名称。
  while (label && ENTRY_TEXT_IMPORT_DELIMITER_PAIRS.has(label.at(-1))) {
    label = entryTextImportNormalizeText(label.slice(0, -1))
      .replace(/[\s:：,，、;；]+$/, '')
      .trim();
  }

  // 仅剥离包住整个名称的成对定界符；名称内部的定界符保持原样。
  let changed = true;
  while (label && changed) {
    changed = false;
    const opening = label[0];
    const closing = ENTRY_TEXT_IMPORT_DELIMITER_PAIRS.get(opening);
    if (closing && label.endsWith(closing)) {
      label = entryTextImportNormalizeText(label.slice(1, -1));
      changed = true;
    }
  }
  return label;
}

function entryTextImportChineseNumber(value) {
  const raw = String(value || '').trim().replace(/两/g, '二');
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const digitMap = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const normalized = raw.replace(/〇/g, '零');
  if (!normalized || /[^零一二三四五六七八九十百千万亿]/.test(normalized)) return null;
  if (!/[十百千万亿]/.test(normalized)) {
    const digits = [...normalized].map(char => digitMap[char]);
    return digits.some(digit => digit == null) ? null : Number(digits.join(''));
  }
  const smallUnits = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of normalized) {
    if (digitMap[char] != null) {
      number = digitMap[char];
    } else if (smallUnits[char]) {
      section += (number || 1) * smallUnits[char];
      number = 0;
    } else if (char === '万') {
      section += number;
      total += section * 10000;
      section = 0;
      number = 0;
    } else if (char === '亿') {
      section += number;
      total = (total + section) * 100000000;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

const ENTRY_TEXT_IMPORT_NUMBER_SOURCE = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿]+)';
const ENTRY_TEXT_IMPORT_CLOCK_SOURCE =
  `(?:${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*[:：]\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}|` +
  `${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*[点时](?:\\s*(?:半|一刻|三刻|${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*分?))?)`;
const ENTRY_TEXT_IMPORT_CHAPTER_ITEM_SOURCE =
  `(?:第\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*(?:部分|篇|编|单元)\\s*)?` +
  `第\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*章` +
  `(?:\\s*第\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*节)?`;

function entryTextImportChapterKey(value) {
  const normalized = entryTextImportMatchKey(value)
    .replace(/[０-９]/g, character => String(character.charCodeAt(0) - 0xFF10));
  return normalized.replace(
    new RegExp(`第(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})(?=(?:部分|篇|编|单元|章|节))`, 'g'),
    (whole, numberText) => {
      const number = entryTextImportChineseNumber(numberText);
      return number == null ? whole : `第${number}`;
    }
  );
}

function entryTextImportSplitChapterField(group) {
  const normalized = entryTextImportNormalizeText(group);
  const explicitlyMarked = /^(?:章节|命名章节)\s*[:：]?/.test(normalized);
  const body = normalized
    .replace(/^(?:章节|命名章节)\s*[:：]?\s*/, '')
    .trim();
  if (!body) return explicitlyMarked ? [] : null;
  const pattern = new RegExp(ENTRY_TEXT_IMPORT_CHAPTER_ITEM_SOURCE, 'g');
  const matches = [...body.matchAll(pattern)].map(match => entryTextImportNormalizeText(match[0]));
  const residue = body
    .replace(pattern, ' ')
    .replace(/[\s、，,;；/|]+/g, '')
    .trim();
  if (matches.length && !residue) return matches;
  if (explicitlyMarked) {
    return body.split(/[、，,;；/|\r\n]+/).map(entryTextImportNormalizeText).filter(Boolean);
  }
  return null;
}

function entryTextImportClock(value) {
  const raw = entryTextImportNormalizeText(value);
  const numeric = raw.match(new RegExp(`(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})\\s*[:：]\\s*(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})`));
  if (numeric) {
    const hour = entryTextImportChineseNumber(numeric[1]);
    const minute = entryTextImportChineseNumber(numeric[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    return '';
  }
  const chinese = raw.match(new RegExp(
    `(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})\\s*[点时]\\s*(半|一刻|三刻|${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*分?)?`
  ));
  if (!chinese) return '';
  const hour = entryTextImportChineseNumber(chinese[1]);
  let minute = 0;
  const minuteText = String(chinese[2] || '').replace(/\s|分/g, '');
  if (minuteText === '半') minute = 30;
  else if (minuteText === '一刻') minute = 15;
  else if (minuteText === '三刻') minute = 45;
  else if (minuteText) minute = entryTextImportChineseNumber(minuteText);
  if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function entryTextImportFindSessionTemplate(name) {
  const key = entryTextImportMatchKey(name);
  const matches = getSessionTemplates().filter(template =>
    entryTextImportMatchKey(template.name) === key);
  return matches.length === 1 ? matches[0] : null;
}

function entryTextImportCompactComparableText(value) {
  return entryTextImportMatchKey(value)
    .replace(/[^a-z0-9\u3400-\u9fff]/gi, '');
}

function entryTextImportTemplateLeafSegments(value) {
  const text = entryTextImportNormalizeText(value);
  const groups = entryTextImportDelimitedGroups(text);
  const outside = [...groups]
    .reverse()
    .reduce((result, group) =>
      result.slice(0, group.start) + result.slice(group.end), text);
  return [outside, ...groups.map(group => group.content)]
    .flatMap(part => String(part || '').split(/[>＞,，、;；/|]+/))
    .map(entryTextImportCompactComparableText)
    .filter(Boolean);
}

function entryTextImportApproximateSubstringDistance(source, target) {
  const sourceCharacters = [...entryTextImportCompactComparableText(source)];
  const targetCharacters = [...entryTextImportCompactComparableText(target)];
  if (!sourceCharacters.length || !targetCharacters.length) return Infinity;
  const sourceText = sourceCharacters.join('');
  const targetText = targetCharacters.join('');
  if (sourceText.includes(targetText)) return 0;
  if (targetCharacters.length < 2) return Infinity;

  const minimumLength = Math.max(1, targetCharacters.length - 1);
  const maximumLength = Math.min(sourceCharacters.length, targetCharacters.length + 1);
  for (let length = minimumLength; length <= maximumLength; length++) {
    for (let start = 0; start + length <= sourceCharacters.length; start++) {
      const window = sourceCharacters.slice(start, start + length).join('');
      if (entryTextImportEditDistance(window, targetText, 1) <= 1) return 1;
    }
  }
  return Infinity;
}

function entryTextImportStructuredLeafMatch(leaf, suppliedToken) {
  const segments = entryTextImportTemplateLeafSegments(leaf);
  if (!segments.length) return false;
  const distances = segments.map(segment =>
    entryTextImportApproximateSubstringDistance(suppliedToken, segment));
  return distances.every(distance => distance <= 1) &&
    distances.some(distance => distance === 0);
}

function entryTextImportFindTaskTemplate(tokens) {
  const normalizedGroups = tokens
    .map(token => entryTextImportMatchKey(token))
    .filter(Boolean);
  const normalizedTokens = [...new Set(normalizedGroups
    .flatMap(token => token.split('>'))
    .filter(Boolean))];
  if (!normalizedTokens.length) return null;

  const candidates = getTaskTemplates().map(template => {
    const path = entryTextImportMatchKey(template.activityType);
    const parts = path.split('>').filter(Boolean);
    const leaf = parts[parts.length - 1] || '';
    const suppliedTokensFitPath = normalizedTokens.every(token => parts.includes(token));
    const coversWholePath = suppliedTokensFitPath &&
      parts.every(part => normalizedTokens.includes(part));
    const namesLeafExactly = suppliedTokensFitPath && normalizedGroups.includes(leaf);
    return { template, parts, leaf, coversWholePath, namesLeafExactly };
  });

  // 完整分类路径是最高置信度；重复路径仍视为不唯一，不自动选择。
  const fullPathMatches = candidates.filter(candidate => candidate.coversWholePath);
  if (fullPathMatches.length === 1) return fullPathMatches[0].template;
  if (fullPathMatches.length > 1) return null;

  // 只写末级模板名称时，必须在全部模板中唯一；上级分类的部分命中不用于猜选。
  const exactLeafMatches = candidates.filter(candidate => candidate.namesLeafExactly);
  if (exactLeafMatches.length === 1) return exactLeafMatches[0].template;
  if (exactLeafMatches.length > 1) return null;

  // 完整上级路径均已精确给出时，才允许对末级名称做结构拆分和单字符纠错。
  // 所有末级片段都要命中，至少一个片段必须完全相同，并且最终候选仍须唯一。
  const structuredLeafMatches = candidates.filter(candidate => {
    if (candidate.parts.length < 2) return false;
    const ancestors = candidate.parts.slice(0, -1);
    if (!ancestors.every(part => normalizedTokens.includes(part))) return false;
    const suppliedLeafTokens = normalizedTokens.filter(token => !ancestors.includes(token));
    return suppliedLeafTokens.some(token =>
      entryTextImportStructuredLeafMatch(candidate.leaf, token));
  });
  return structuredLeafMatches.length === 1 ? structuredLeafMatches[0].template : null;
}

function entryTextImportDelimitedGroups(value) {
  const text = String(value || '');
  const closings = new Set(ENTRY_TEXT_IMPORT_DELIMITER_PAIRS.values());
  const groups = [];
  const expectedClosings = [];
  let start = -1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (ENTRY_TEXT_IMPORT_DELIMITER_PAIRS.has(character)) {
      if (!expectedClosings.length) start = index;
      expectedClosings.push(ENTRY_TEXT_IMPORT_DELIMITER_PAIRS.get(character));
      continue;
    }
    if (!closings.has(character) || !expectedClosings.length) continue;

    // 成对时正常关闭；混用闭合符时只在最外层容错，避免破坏内部嵌套结构。
    const expected = expectedClosings[expectedClosings.length - 1];
    if (character === expected || expectedClosings.length === 1) expectedClosings.pop();
    if (!expectedClosings.length && start >= 0) {
      groups.push({
        content: text.slice(start + 1, index),
        start,
        end: index + 1,
      });
      start = -1;
    }
  }
  return groups;
}

const ENTRY_TEXT_IMPORT_SESSION_FIELD_LABELS = {
  nominalMinutes: ['名义专注', '名义时长', '名义'],
  actualMinutes: ['实际专注', '实际时长', '实际'],
  restMinutes: ['休息时长', '休息时间', '休息'],
};

function entryTextImportEditDistance(first, second, maximum = 1) {
  const left = [...String(first || '')];
  const right = [...String(second || '')];
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let rowMinimum = current[0];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}

function entryTextImportResolveSessionFieldLabel(value) {
  const label = entryTextImportMatchKey(value);
  if (!label) return '';
  const entries = Object.entries(ENTRY_TEXT_IMPORT_SESSION_FIELD_LABELS);
  const exact = entries
    .filter(([, aliases]) => aliases.some(alias => entryTextImportMatchKey(alias) === label))
    .map(([field]) => field);
  if (exact.length === 1) return exact[0];

  // 受限纠错仅适用于较长的固定字段名；必须只有一个语义结果且编辑距离为 1。
  if ([...label].length < 4) return '';
  const fuzzy = entries
    .filter(([, aliases]) => aliases.some(alias => {
      const normalizedAlias = entryTextImportMatchKey(alias);
      return [...normalizedAlias].length >= 4 &&
        entryTextImportEditDistance(label, normalizedAlias, 1) === 1;
    }))
    .map(([field]) => field);
  return [...new Set(fuzzy)].length === 1 ? fuzzy[0] : '';
}

function entryTextImportSessionMinuteFields(value) {
  const fields = {
    nominalMinutes: null,
    actualMinutes: null,
    restMinutes: null,
  };
  const pattern = new RegExp(
    `([A-Za-z\\u3400-\\u9fff][A-Za-z\\u3400-\\u9fff\\s]{0,11}?)\\s*[:：]?\\s*` +
    `(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})\\s*分钟`,
    'g'
  );
  for (const match of String(value || '').matchAll(pattern)) {
    const field = entryTextImportResolveSessionFieldLabel(match[1]);
    if (field && fields[field] == null) {
      fields[field] = entryTextImportChineseNumber(match[2]);
    }
  }
  return fields;
}

function entryTextImportParseTask(line, lineNo) {
  const delimitedGroups = entryTextImportDelimitedGroups(line);
  const groups = delimitedGroups.map(group => entryTextImportNormalizeText(group.content));
  const minutesValues = [];
  const quantityValues = [];
  let wrongCount = null;
  let wrongUnit = '';
  let wrongFieldCount = 0;
  const chapterEntries = [];
  let taskCompletionStatus = null;
  let statusFieldCount = 0;
  const templateTokens = [];
  const issues = [];

  groups.forEach(group => {
    if (new RegExp(`^专注\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*次$`, 'i').test(group)) return;
    const standaloneStatus = group.match(/^(未完成|已完成)$/);
    if (standaloneStatus) {
      statusFieldCount++;
      taskCompletionStatus = standaloneStatus[1] === '已完成';
      return;
    }
    if (/(?:未完成|已完成)/.test(group)) {
      issues.push('章节名称和完成状态必须分别写在两个独立括号中');
      return;
    }
    const chapterNames = entryTextImportSplitChapterField(group);
    if (chapterNames) {
      if (chapterNames.length) {
        chapterNames.forEach(nameValue => chapterEntries.push({ name: nameValue }));
      } else {
        issues.push('章节字段缺少章节名称');
      }
      return;
    }

    const wrongPattern = new RegExp(
      `(?:错误(?:数量)?|错题(?:数量)?|错)\\s*[:：]?\\s*(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})\\s*(?:个\\s*)?([A-Za-z\\u4e00-\\u9fa5]+)?`,
      'g'
    );
    const wrongMatches = [...group.matchAll(wrongPattern)];
    wrongMatches.forEach(match => {
      wrongFieldCount++;
      wrongCount = entryTextImportChineseNumber(match[1]);
      wrongUnit = entryTextImportMatchKey(match[2] || '');
    });
    const metricGroup = group.replace(wrongPattern, ' ');
    const valuePattern = new RegExp(
      `(${ENTRY_TEXT_IMPORT_NUMBER_SOURCE})\\s*(?:个\\s*)?([A-Za-z\\u4e00-\\u9fa5]+)`,
      'g'
    );
    for (const match of metricGroup.matchAll(valuePattern)) {
      const value = entryTextImportChineseNumber(match[1]);
      const unit = entryTextImportMatchKey(match[2]);
      if (unit === '分钟') minutesValues.push(value);
      else quantityValues.push({ value, unit });
    }
    const residue = metricGroup
      .replace(new RegExp(`${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*分钟`, 'g'), '')
      .replace(new RegExp(`${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*(?:个\\s*)?[A-Za-z\\u4e00-\\u9fa5]+`, 'g'), '')
      .replace(/[，,、;；:：]/g, ' ')
      .trim();
    if (residue) templateTokens.push(residue);
    else if (!/\d/.test(group) && group) templateTokens.push(group);
  });

  const nameSource = [...delimitedGroups]
    .reverse()
    .reduce((text, group) => text.slice(0, group.start) + text.slice(group.end), line);
  const name = entryTextImportNormalizeText(nameSource);
  const template = entryTextImportFindTaskTemplate(templateTokens);
  const parsedTask = {
    lineNo,
    raw: line,
    name,
    note: '',
    minutes: minutesValues.length === 1 ? minutesValues[0] : null,
    quantity: quantityValues.length === 1 ? quantityValues[0].value : null,
    quantityUnit: quantityValues.length === 1 ? quantityValues[0].unit : '',
    wrongCount: wrongFieldCount === 1 ? wrongCount : null,
    wrongUnit: wrongFieldCount === 1 ? wrongUnit : '',
    chapterEntries,
    taskCompletionStatus: statusFieldCount === 1 ? taskCompletionStatus : null,
    templateTokens,
    templateId: template?.id || '',
    issues: [
      ...issues,
      ...(!name ? ['没有识别到任务名称'] : []),
      ...(minutesValues.length !== 1 ? [minutesValues.length ? '出现了多个“分钟”字段' : '缺少“×分钟”字段'] : []),
      ...(quantityValues.length > 1 ? ['出现了多个数量字段'] : []),
      ...(wrongFieldCount > 1 ? ['出现了多个错误数量字段'] : []),
      ...(wrongFieldCount === 1 && !wrongUnit ? ['错误数量缺少单位'] : []),
      ...(statusFieldCount > 1 ? ['一条任务只能填写一个完成状态'] : []),
      ...(chapterEntries.length && statusFieldCount === 0 ? ['填写章节后，必须另用一个独立括号填写“已完成”或“未完成”'] : []),
      ...(!chapterEntries.length && statusFieldCount > 0 ? ['填写完成状态前必须先填写章节'] : []),
      ...(chapterEntries.length > 1 && taskCompletionStatus === false ? ['多个章节不能标记为未完成'] : []),
    ],
  };
  entryTextImportRefreshTaskChapterIssues(parsedTask);
  return parsedTask;
}

function entryTextImportSplitInlineNote(line) {
  const text = String(line || '');
  const markers = [...text.matchAll(/注释\s*[:：]/g)];
  const marker = markers[markers.length - 1];
  if (!marker || marker.index <= 0) return { recordText: text, note: null };
  return {
    recordText: entryTextImportNormalizeText(text.slice(0, marker.index)),
    note: text.slice(marker.index + marker[0].length).trim(),
  };
}

function parseEntryTextImport(source) {
  const result = {
    wakeTime: '',
    wakeNote: '',
    wakeLineNo: null,
    sleepTime: '',
    sleepNote: '',
    sleepLineNo: null,
    dayNote: '',
    dayNoteLineNo: null,
    sessions: [],
    tasks: [],
    ignoredFocusCounts: [],
    unrecognized: [],
    issues: [],
  };
  let lastRecord = null;
  const attachNote = (target, note, lineNo) => {
    if (!note) {
      result.issues.push(`第 ${lineNo} 行：注释没有内容`);
      return;
    }
    if (!target) {
      result.issues.push(`第 ${lineNo} 行：注释前面没有可对应的任务、时段或作息记录`);
      return;
    }
    if (target.kind === 'task' || target.kind === 'session') {
      if (target.item.note) {
        result.issues.push(`第 ${lineNo} 行：同一条记录重复填写了注释`);
      } else {
        target.item.note = note;
      }
      return;
    }
    const noteKey = target.kind === 'wake' ? 'wakeNote' : 'sleepNote';
    if (result[noteKey]) {
      result.issues.push(`第 ${lineNo} 行：同一条${target.kind === 'wake' ? '起床' : '睡觉'}记录重复填写了注释`);
    } else {
      result[noteKey] = note;
    }
  };
  const lines = String(source || '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    let line = entryTextImportNormalizeText(rawLine);
    if (!line) return;

    const dayNoteMatch = line.match(/^全天注释\s*[:：]\s*(.*)$/);
    if (dayNoteMatch) {
      const note = dayNoteMatch[1].trim();
      if (!note) {
        result.issues.push(`第 ${lineNo} 行：全天注释没有内容`);
      } else if (result.dayNoteLineNo != null) {
        result.issues.push(`第 ${lineNo} 行：全天注释重复，只允许填写一次`);
      } else {
        result.dayNote = note;
        result.dayNoteLineNo = lineNo;
      }
      lastRecord = null;
      return;
    }
    if (/全天注释\s*[:：]/.test(line)) {
      result.issues.push(`第 ${lineNo} 行：全天注释必须单独占一行`);
      lastRecord = null;
      return;
    }
    const taskNoteMatch = line.match(/^注释\s*[:：]\s*(.*)$/);
    if (taskNoteMatch) {
      const note = taskNoteMatch[1].trim();
      attachNote(lastRecord, note, lineNo);
      return;
    }
    const inlineNote = entryTextImportSplitInlineNote(line);
    line = inlineNote.recordText;
    if (!line) {
      result.issues.push(`第 ${lineNo} 行：注释前面没有可识别的记录`);
      lastRecord = null;
      return;
    }

    const focusCountPattern = new RegExp(
      `[（(]?\\s*专注\\s*${ENTRY_TEXT_IMPORT_NUMBER_SOURCE}\\s*次\\s*[）)]?`,
      'g'
    );
    const focusMatches = [...line.matchAll(focusCountPattern)];
    focusMatches.forEach(match => result.ignoredFocusCounts.push({
      lineNo,
      value: entryTextImportNormalizeText(match[0]).replace(/^[（(]|[）)]$/g, ''),
    }));
    line = entryTextImportNormalizeText(
      line.replace(focusCountPattern, '')
    );
    if (!line) return;

    const wakeSleep = line.match(/^(起床|睡觉|入睡)\s*[:：]?\s*(.+)$/);
    if (wakeSleep) {
      const value = entryTextImportClock(wakeSleep[2]);
      const kind = wakeSleep[1] === '起床' ? 'wakeTime' : 'sleepTime';
      if (!value) {
        result.issues.push(`第 ${lineNo} 行：没有识别到有效的${kind === 'wakeTime' ? '起床' : '睡觉'}时间`);
      } else if (result[kind]) {
        result.issues.push(`第 ${lineNo} 行：${kind === 'wakeTime' ? '起床' : '睡觉'}时间重复`);
      } else {
        result[kind] = value;
        result[kind === 'wakeTime' ? 'wakeLineNo' : 'sleepLineNo'] = lineNo;
        lastRecord = { kind: kind === 'wakeTime' ? 'wake' : 'sleep' };
        if (inlineNote.note !== null) attachNote(lastRecord, inlineNote.note, lineNo);
      }
      return;
    }

    const range = line.match(new RegExp(
      `(${ENTRY_TEXT_IMPORT_CLOCK_SOURCE})\\s*(?:~|～|—|–|-|至|到)\\s*(${ENTRY_TEXT_IMPORT_CLOCK_SOURCE})`
    ));
    if (range) {
      const startTime = entryTextImportClock(range[1]);
      const endTime = entryTextImportClock(range[2]);
      const prefix = entryTextImportNormalizeRangeLabel(line.slice(0, range.index));
      const minuteFields = entryTextImportSessionMinuteFields(line);
      const specialTemplate = prefix ? entryTextImportFindSessionTemplate(prefix) : null;
      const isNamedSession = Boolean(prefix);
      const sessionItem = {
        lineNo,
        raw: rawLine.trim(),
        kind: isNamedSession ? 'named' : 'normal',
        name: specialTemplate?.name || prefix,
        startTime,
        endTime,
        nominalMinutes: minuteFields.nominalMinutes,
        actualMinutes: minuteFields.actualMinutes,
        restMinutes: minuteFields.restMinutes,
        templateId: specialTemplate?.id || '',
        note: '',
        issues: [],
      };
      entryTextImportRefreshSessionTimingIssues(sessionItem);
      result.sessions.push(sessionItem);
      lastRecord = { kind: 'session', item: sessionItem };
      if (inlineNote.note !== null) attachNote(lastRecord, inlineNote.note, lineNo);
      return;
    }

    if (entryTextImportDelimitedGroups(line).length) {
      const taskItem = entryTextImportParseTask(line, lineNo);
      result.tasks.push(taskItem);
      lastRecord = { kind: 'task', item: taskItem };
      if (inlineNote.note !== null) attachNote(lastRecord, inlineNote.note, lineNo);
      return;
    }
    result.unrecognized.push({ lineNo, raw: rawLine.trim() });
    lastRecord = null;
  });
  if (!result.wakeTime && !result.sleepTime && !result.dayNote && !result.sessions.length && !result.tasks.length) {
    result.issues.push('没有识别到可导入的起床、睡觉、时段或任务记录');
  }
  return result;
}

function entryTextImportSessionOptions(selectedId = '') {
  const templates = getSessionTemplates();
  return `<option value="">请选择时段模板</option>${templates.map(template =>
    `<option value="${escHtmlApp(template.id)}" ${template.id === selectedId ? 'selected' : ''}>${escHtmlApp(template.name)} · ${normalizeSessionTemplateType(template.sessionType) === 'special-study' ? '特殊学习' : '不可用'}</option>`
  ).join('')}`;
}

function entryTextImportTaskOptions(selectedId = '') {
  return `<option value="">请选择任务模板</option>${getTaskTemplates().map(template =>
    `<option value="${escHtmlApp(template.id)}" ${template.id === selectedId ? 'selected' : ''}>${escHtmlApp(template.activityType || '未分类模板')}</option>`
  ).join('')}`;
}

function entryTextImportCurrentResult(dateStr) {
  return entryTextImportDraft.dateStr === dateStr ? entryTextImportDraft.result : null;
}

function renderEntryTextImportPreview(dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const host = document.getElementById('entry_text_import_preview');
  if (host && result) host.innerHTML = entryTextImportPreviewHtml(result, dateStr);
}

const ENTRY_TEXT_IMPORT_SESSION_TIMING_PREFIX = '时段校验：';

function entryTextImportSessionType(item) {
  if (item?.kind === 'normal') return 'normal';
  const template = getSessionTemplates().find(value => value.id === item?.templateId);
  return template ? normalizeSessionTemplateType(template.sessionType) : '';
}

function entryTextImportRefreshSessionTimingIssues(item) {
  if (!item) return;
  item.issues = (Array.isArray(item.issues) ? item.issues : [])
    .filter(message => !String(message).startsWith(ENTRY_TEXT_IMPORT_SESSION_TIMING_PREFIX));
  const resolvedSessionType = entryTextImportSessionType(item);
  const sessionType = resolvedSessionType || 'special';
  sessionTimingValidationIssues({
    sessionType,
    startTime: item.startTime,
    endTime: item.endTime,
    nominalMinutes: item.nominalMinutes,
    actualMinutes: item.actualMinutes,
    restMinutes: item.restMinutes,
  }).forEach(message => item.issues.push(`${ENTRY_TEXT_IMPORT_SESSION_TIMING_PREFIX}${message}`));
  if (resolvedSessionType === 'special' && item.actualMinutes != null) {
    item.issues.push(
      `${ENTRY_TEXT_IMPORT_SESSION_TIMING_PREFIX}不可用时段不能填写实际专注；如包含学习时间，请选择特殊学习时段模板`
    );
  }
}

function entryTextImportSetTemplate(kind, index, templateId, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const list = kind === 'session' ? result?.sessions : result?.tasks;
  if (!list?.[index] || list[index].imported) return;
  list[index].templateId = templateId || '';
  if (kind === 'task') {
    entryTextImportRefreshTaskChapterIssues(list[index]);
  } else {
    entryTextImportRefreshSessionTimingIssues(list[index]);
  }
  renderEntryTextImportPreview(dateStr);
}

function entryTextImportCollectErrors(result, dateStr) {
  const sourceLines = entryTextImportDraft.dateStr === dateStr
    ? String(entryTextImportDraft.source || '').split(/\r?\n/)
    : [];
  const rows = [];
  const recordLabel = lineNo => {
    const task = result.tasks.find(item => item.lineNo === lineNo && !item.imported);
    if (task) return `任务：${task.name || '未命名任务'}`;
    const session = result.sessions.find(item => item.lineNo === lineNo && !item.imported);
    if (session) return `时段：${session.name || `${session.startTime || '?'}–${session.endTime || '?'}`}`;
    if (result.wakeLineNo === lineNo) return '起床记录';
    if (result.sleepLineNo === lineNo) return '睡觉记录';
    const raw = String(sourceLines[lineNo - 1] || '').trim();
    if (/^全天注释\s*[:：]/.test(raw)) return '全天注释';
    if (/^注释\s*[:：]/.test(raw)) return '注释';
    return raw ? `原始内容：${raw.slice(0, 30)}` : '整体解析';
  };
  const add = (lineNo, message, label = '') => {
    const normalizedLine = Number(lineNo) || null;
    const key = `${normalizedLine || 'all'}|${message}`;
    if (rows.some(row => row.key === key)) return;
    rows.push({
      key,
      lineNo: normalizedLine,
      record: label || (normalizedLine ? recordLabel(normalizedLine) : '整体解析'),
      message: String(message || ''),
    });
  };
  result.issues.forEach(issue => {
    const match = String(issue).match(/^第\s*(\d+)\s*行[：:]?\s*(.*)$/);
    add(match ? Number(match[1]) : null, match ? match[2] : issue);
  });
  result.sessions.forEach(item => {
    if (item.imported) return;
    item.issues.forEach(issue => add(item.lineNo, issue, `时段：${item.name || `${item.startTime || '?'}–${item.endTime || '?'}`}`));
    if (item.kind === 'named' && !item.templateId) {
      add(item.lineNo, '无法唯一确定时段模板，请在预览中选择。', `时段：${item.name || '未命名时段'}`);
    }
  });
  result.tasks.forEach(item => {
    if (item.imported) return;
    item.issues.forEach(issue => add(item.lineNo, issue, `任务：${item.name || '未命名任务'}`));
    if (!item.templateId) {
      const hasTemplateTokens = Array.isArray(item.templateTokens) && item.templateTokens.length > 0;
      add(
        item.lineNo,
        hasTemplateTokens
          ? '填写的分类或模板名称无法唯一匹配已有任务模板，请在预览中选择。'
          : '没有填写分类或模板名称，任务模板已保持空白，请在预览中选择。',
        `任务：${item.name || '未命名任务'}`
      );
    }
  });
  result.unrecognized.forEach(item =>
    add(item.lineNo, `无法识别这一整行：${item.raw}`, '未识别内容'));
  return rows;
}

function entryTextImportScalarRowHtml(result, dateStr, kind) {
  const isDayNote = kind === 'dayNote';
  const isWake = kind === 'wake';
  const title = isDayNote ? '全天注释' : isWake ? '起床' : '睡觉';
  const icon = isDayNote ? '✎' : isWake ? '☀' : '☾';
  const timeKey = isWake ? 'wakeTime' : 'sleepTime';
  const noteKey = isDayNote ? 'dayNote' : isWake ? 'wakeNote' : 'sleepNote';
  const importedKey = `${kind}Imported`;
  const hasValue = isDayNote ? Boolean(result.dayNote) : Boolean(result[timeKey]);
  if (!hasValue) return '';
  const imported = Boolean(result[importedKey]);
  const primary = isDayNote ? '全天说明' : result[timeKey] || '-';
  const secondary = isDayNote ? result.dayNote : result[noteKey] || '无注释';
  return `<article class="entry-text-import-foundation-card ${kind} ${imported ? 'is-imported' : ''}">
    <div class="entry-text-import-foundation-icon" aria-hidden="true">${icon}</div>
    <div class="entry-text-import-foundation-copy">
      <span>${title}${imported ? ' · 已导入' : ''}</span>
      <strong class="${isDayNote ? '' : 'fw-mono'}">${escHtmlApp(primary)}</strong>
      <p>${escHtmlApp(secondary)}</p>
    </div>
    <div class="entry-text-import-row-actions entry-text-import-foundation-actions">
      <button type="button" class="btn btn-ghost btn-sm" onclick="toggleEntryTextImportScalarEdit('${kind}','${dateStr}')" ${imported ? 'disabled' : ''}>修改</button>
      <button type="button" class="btn btn-success btn-sm" onclick="confirmEntryTextImport('${dateStr}','${kind}')" ${imported ? 'disabled' : ''}>${imported ? '已导入' : '导入'}</button>
    </div>
  </article>`;
}

function entryTextImportSessionRowHtml(item, index, dateStr) {
  const imported = Boolean(item.imported);
  const sessionType = entryTextImportSessionType(item);
  const showNamedActual = item.kind === 'named' &&
    (sessionType === 'special-study' || item.actualMinutes != null);
  const typeLabel = item.kind === 'normal'
    ? '普通专注'
    : sessionType === 'special-study'
      ? '特殊学习'
      : sessionType === 'special'
        ? '不可用'
        : '待匹配';
  return `<article class="entry-text-import-row entry-text-import-session-row ${item.issues.length ? 'has-error' : ''} ${imported ? 'is-imported' : ''}">
    <div class="entry-text-import-row-head">
      <div class="entry-text-import-row-identity">
        <span class="entry-text-import-line">第 ${item.lineNo} 行</span>
        <span class="entry-text-import-kind">${typeLabel}</span>
        <b>${escHtmlApp(item.name || '普通专注')}${imported ? ' · 已导入' : ''}</b>
      </div>
      <div class="entry-text-import-row-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="toggleEntryTextImportItemEdit('session',${index},'${dateStr}')" ${imported ? 'disabled' : ''}>修改</button>
        <button type="button" class="btn btn-success btn-sm" onclick="confirmEntryTextImport('${dateStr}','session',${index})" ${imported || item.issues.length || (item.kind === 'named' && !item.templateId) ? 'disabled' : ''}>${imported ? '已导入' : '导入'}</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteEntryTextImportItem('session',${index},'${dateStr}')" ${imported ? 'disabled' : ''}>删除</button>
      </div>
    </div>
    <div class="entry-text-import-record-fields">
      <span><small>开始时间</small><b class="fw-mono">${item.startTime || '?'}</b></span>
      <span><small>结束时间</small><b class="fw-mono">${item.endTime || '?'}</b></span>
      ${item.kind === 'normal' ? `
        <span><small>名义时长</small><b>${fmtMin(item.nominalMinutes, true)}</b></span>
        <span><small>实际时长</small><b>${fmtMin(item.actualMinutes, true)}</b></span>
        <span><small>休息时长</small><b>${fmtMin(item.restMinutes, true)}</b></span>
      ` : `
        <label class="entry-text-import-field-template"><small>时段模板</small><select id="entry_text_session_template_${index}" onchange="entryTextImportSetTemplate('session',${index},this.value,'${dateStr}')" ${imported ? 'disabled' : ''}>${entryTextImportSessionOptions(item.templateId)}</select></label>
        <span><small>时段类型</small><b>${sessionType === 'special-study' ? '特殊学习时段' : sessionType === 'special' ? '不可用时段' : '待选择模板'}</b></span>
        ${showNamedActual ? `<span><small>实际专注</small><b>${fmtMin(item.actualMinutes, true)}</b></span>` : ''}
      `}
      <span class="entry-text-import-field-note"><small>注释</small><b>${escHtmlApp(item.note || '无')}</b></span>
    </div>
  </article>`;
}

function entryTextImportTaskRowHtml(item, index, dateStr) {
  const imported = Boolean(item.imported);
  return `<article class="entry-text-import-row entry-text-import-task-row ${item.issues.length ? 'has-error' : ''} ${imported ? 'is-imported' : ''}">
    <div class="entry-text-import-row-head">
      <div class="entry-text-import-row-identity">
        <span class="entry-text-import-line">第 ${item.lineNo} 行</span>
        <span class="entry-text-import-kind">任务</span>
        <b>${escHtmlApp(item.name || '未识别')}${imported ? ' · 已导入' : ''}</b>
      </div>
      <div class="entry-text-import-row-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="toggleEntryTextImportItemEdit('task',${index},'${dateStr}')" ${imported ? 'disabled' : ''}>修改</button>
        <button type="button" class="btn btn-success btn-sm" onclick="confirmEntryTextImport('${dateStr}','task',${index})" ${imported || item.issues.length || !item.templateId ? 'disabled' : ''}>${imported ? '已导入' : '导入'}</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteEntryTextImportItem('task',${index},'${dateStr}')" ${imported ? 'disabled' : ''}>删除</button>
      </div>
    </div>
    <div class="entry-text-import-record-fields">
      <label class="entry-text-import-field-template"><small>任务模板</small><select id="entry_text_task_template_${index}" onchange="entryTextImportSetTemplate('task',${index},this.value,'${dateStr}')" ${imported ? 'disabled' : ''}>${entryTextImportTaskOptions(item.templateId)}</select></label>
      <span><small>时长</small><b>${fmtMin(item.minutes, true)}</b></span>
      <span><small>数量</small><b>${item.quantity != null ? `${item.quantity} ${escHtmlApp(item.quantityUnit)}` : '-'}</b></span>
      <span><small>错误数量</small><b>${item.wrongCount != null ? `${item.wrongCount} ${escHtmlApp(item.wrongUnit)}` : '-'}</b></span>
      <span class="entry-text-import-field-chapters"><small>章节</small><b>${item.chapterEntries.length ? item.chapterEntries.map(chapter => escHtmlApp(chapter.name)).join('；') : '-'}</b></span>
      <span><small>完成状态</small><b>${item.taskCompletionStatus === true ? '已完成' : item.taskCompletionStatus === false ? '未完成' : '-'}</b></span>
      <span class="entry-text-import-field-note"><small>注释</small><b>${escHtmlApp(item.note || '无')}</b></span>
    </div>
  </article>`;
}

function entryTextImportPreviewHtml(result, dateStr) {
  const day = getDay(dateStr);
  const errorRows = entryTextImportCollectErrors(result, dateStr);
  const hasScalarPreview = Boolean(result.wakeTime || result.sleepTime || result.dayNote);
  const specialStudyCount = result.sessions.filter(item =>
    entryTextImportSessionType(item) === 'special-study').length;
  const hasExisting = Boolean(
    day.wakeTime || day.wakeNote || day.sleepTime || day.sleepNote ||
    day.dayNote || day.sessions?.length || day.tasks?.length
  );
  const pendingCount =
    (result.wakeTime && !result.wakeImported ? 1 : 0) +
    (result.sleepTime && !result.sleepImported ? 1 : 0) +
    (result.dayNote && !result.dayNoteImported ? 1 : 0) +
    result.sessions.filter(item => !item.imported).length +
    result.tasks.filter(item => !item.imported).length;
  return `<div class="entry-text-import-preview">
    <div class="entry-text-import-preview-head">
      <div>
        <span class="entry-text-import-preview-eyebrow">PARSED DRAFT</span>
        <h3>解析暂存预览</h3>
        <p>先检查、修改或删除；只有点击导入才会写入当天。</p>
      </div>
      <span class="entry-text-import-validation-state ${errorRows.length ? 'error' : 'ready'}">
        <i></i>${errorRows.length ? `${errorRows.length} 个问题待处理` : '校验通过，可导入'}
      </span>
    </div>
    <div class="entry-text-import-summary">
      <span class="primary">待导入 <b>${pendingCount}</b></span>
      <span>起床 <b>${result.wakeTime || '-'}</b></span>
      <span>睡觉 <b>${result.sleepTime || '-'}</b></span>
      <span>时段 <b>${result.sessions.length}</b></span>
      <span>特殊学习 <b>${specialStudyCount}</b></span>
      <span>任务 <b>${result.tasks.length}</b></span>
      <span>已忽略 <b>${result.ignoredFocusCounts.length}</b></span>
    </div>
    ${hasExisting ? '<div class="entry-text-import-warning">当天已有记录：分项导入或统一导入都会保存到当天；已经单独导入的项目会自动从统一导入中排除。</div>' : ''}
    ${errorRows.length ? `<div class="entry-text-import-error-area">
      <div class="entry-text-import-error-title"><b>统一报错区</b><span>${errorRows.length ? `${errorRows.length} 个问题` : '没有待处理问题'}</span></div>
      <div class="entry-text-import-error-table">
        <div class="entry-text-import-error-head"><span>行号</span><span>记录 / 任务</span><span>错误说明</span></div>
        ${errorRows.map(row => `<div class="entry-text-import-error-row">
          <span>${row.lineNo ? `第 ${row.lineNo} 行` : '整体'}</span>
          <span>${escHtmlApp(row.record)}</span>
          <span>${escHtmlApp(row.message)}</span>
        </div>`).join('')}
      </div>
    </div>` : `<div class="entry-text-import-validation-ok">
      <span>✓</span><div><b>当前暂存内容没有发现解析错误</b><small>正式导入时仍会检查时段重叠、任务容量、单位、章节和正确率规则。</small></div>
    </div>`}
    ${hasScalarPreview ? `<section class="entry-text-import-block entry-text-import-foundation-block">
      <div class="entry-text-import-block-head"><div><span>FOUNDATION</span><h4>基础信息</h4></div><b>${[result.wakeTime, result.sleepTime, result.dayNote].filter(Boolean).length} 项</b></div>
      <div class="entry-text-import-foundation-grid">
        ${entryTextImportScalarRowHtml(result, dateStr, 'wake')}
        ${entryTextImportScalarRowHtml(result, dateStr, 'sleep')}
        ${entryTextImportScalarRowHtml(result, dateStr, 'dayNote')}
      </div>
    </section>` : ''}
    ${result.sessions.length ? `<section class="entry-text-import-block">
      <div class="entry-text-import-block-head"><div><span>SESSIONS</span><h4>时段预览</h4></div><b>${result.sessions.length} 段</b></div>
      <div class="entry-text-import-card-list">
        ${result.sessions.map((item, index) => entryTextImportSessionRowHtml(item, index, dateStr)).join('')}
      </div>
    </section>` : ''}
    ${result.tasks.length ? `<section class="entry-text-import-block">
      <div class="entry-text-import-block-head"><div><span>TASKS</span><h4>任务预览</h4></div><b>${result.tasks.length} 条</b></div>
      <div class="entry-text-import-card-list">
        ${result.tasks.map((item, index) => entryTextImportTaskRowHtml(item, index, dateStr)).join('')}
      </div>
    </section>` : ''}
    ${result.ignoredFocusCounts.length ? `<div class="entry-text-import-ignored"><b>已按规则忽略：</b>${result.ignoredFocusCounts.map(item => `第 ${item.lineNo} 行“${escHtmlApp(item.value)}”`).join('、')}</div>` : ''}
    <div class="entry-text-import-submit-bar">
      <div><b>${errorRows.length ? '请先处理错误' : `准备导入 ${pendingCount} 项`}</b><span>也可以在每张卡片上单独导入。</span></div>
      <button type="button" class="btn btn-success" onclick="confirmEntryTextImport('${dateStr}','all')" ${errorRows.length || !pendingCount ? 'disabled' : ''}>统一导入 ${pendingCount} 项</button>
    </div>
  </div>`;
}

function entryTextImportPanelHtml(dateStr) {
  const source = entryTextImportDraft.dateStr === dateStr ? entryTextImportDraft.source : '';
  return `<div class="card entry-section entry-text-import-card">
    <div class="entry-text-import-hero">
      <div>
        <span class="entry-text-import-eyebrow">STRUCTURED IMPORT</span>
        <h2>文本批量录入</h2>
        <p>粘贴一天的原始记录，先解析成可检查的暂存卡片，再决定如何导入。</p>
      </div>
      <div class="entry-text-import-feature-pills">
        <span>逐行识别</span><span>暂存可改</span><span>分项导入</span>
      </div>
    </div>
    <div class="entry-text-import-compose">
      <div class="entry-text-import-editor">
        <div class="entry-text-import-editor-head">
          <div><b>原始记录</b><span>每行只写一条记录</span></div>
          <span class="entry-text-import-draft-chip" id="entry_text_import_draft_chip">${source.trim() ? '已有暂存文字' : '等待输入'}</span>
        </div>
        <textarea id="entry_text_import_source" class="entry-text-import-source" placeholder="在这里粘贴当天的原始记录……" oninput="rememberEntryTextImport(this.value,'${dateStr}')">${escHtmlApp(source)}</textarea>
        <div class="entry-text-import-actions">
          <button type="button" class="btn btn-primary" onclick="previewEntryTextImport('${dateStr}')">解析并生成预览</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="clearEntryTextImport('${dateStr}')">清空输入</button>
          <span class="form-hint">解析不会直接写入当天。</span>
        </div>
      </div>
      <details class="entry-text-import-format-guide" open>
        <summary>
          <div><b>通用书写格式</b><small>支持中文数字、阿拉伯数字和中文时刻</small></div>
          <span>展开 / 收起</span>
        </summary>
        <div class="entry-text-import-format-body">
          <div class="entry-text-import-format-grid">
            <code>起床【时:分】</code>
            <code>睡觉【时:分或中文时刻】</code>
            <code>【开始时:分】~【结束时:分】（名义专注【分钟数】分钟）（实际专注【分钟数】分钟）[（休息【分钟数】分钟）]</code>
            <code>【特殊时段模板名称】【开始时:分】~【结束时:分】</code>
            <code>【特殊学习时段模板名称】【开始时:分】~【结束时:分】（实际专注【分钟数】分钟）</code>
            <code>【任务名称】（【分类或模板名称，可填写多项且顺序任意】）（【时长】分钟）（【数量】个【单位】）（错误【数量】个【单位】）（章节：【章节名称】）（【已完成或未完成】）</code>
            <code>【记录内容】 注释：【该记录的注释内容】（也可在后续单独一行填写）</code>
            <code>全天注释：【当天整体注释内容】</code>
          </div>
          <div class="entry-text-import-writing-notes">
            <b>书写说明</b>
            <ul>
              <li><strong>分行：</strong>每条起床、睡觉、时段和任务记录必须单独占一行，空行会被忽略；同一批文字中，起床、睡觉和全天注释各最多填写一次。</li>
              <li><strong>注释：</strong>普通“注释”既可接在所属记录末尾，也可在下一条有效记录出现前单独占一行，空行不会改变其归属。全天注释必须使用“全天注释：内容”并单独占一行，不能接在其他记录后面。</li>
              <li><strong>容错边界：</strong>系统会统一全角/半角兼容字符、多余空白和结构边界标点，并按成对定界符解析圆括号、方括号、书名式方括号和花括号，允许字段内部继续嵌套。固定时段字段名只在相差一个字符且语义唯一时纠错；模板名和分类名不做模糊纠错，不能唯一确定时仍会留空报错。</li>
              <li><strong>数字与时间：</strong>数字可用中文或阿拉伯数字；时刻可写“07:30”“七点半”“七时一刻”等 24 小时制格式。时段可用“~、～、—、–、-、至、到”连接开始和结束时间，也支持跨越零点，但不得与当天已有或本批其他时段重叠。</li>
              <li><strong>普通时段：</strong>必须填写大于 0 的整数“名义专注”和“实际专注”；“休息”可省略，填写时须为非负整数。实际专注不得超过名义专注或时钟时长，名义专注加休息不得超过时钟时长。</li>
              <li><strong>特殊时段：</strong>名称必须唯一匹配已有时段模板。不可用类特殊时段不填写实际专注；特殊学习时段必须填写大于 0 的整数实际专注，且不能超过时钟时长。无法唯一匹配时须在预览中选择模板。</li>
              <li><strong>任务：</strong>任务名称写在括号外，分类、模板和数据字段分别写在括号内；必须且只能填写一个大于 0 的整数分钟字段。分类层级的书写顺序可以变化；完整分类路径唯一匹配，或明确填写的末级模板名称在全库唯一时，系统会自动采用已有模板。若所有上级分类均已精确填写，末级名称还可按“主体名称＋括号修饰语”拆分匹配，但必须所有片段命中、至少一个片段完全相同且最终候选唯一。没有模板信息、匹配不唯一或置信度不足时，模板栏保持空白并报错，绝不会自动新建或猜选模板，须在预览中手动选择。</li>
              <li><strong>数量与错误：</strong>只有模板启用了相应功能时才可填写，数量和错误数均须为非负整数，单位必须与模板一致；启用正确率的模板必须同时填写总数量和错误数量，且错误数量不能大于总数量。若模板关联数量预测目标，数量还须大于 0 且单位与目标一致。</li>
              <li><strong>章节：</strong>章节与“已完成/未完成”必须放在不同括号中；章节必须唯一匹配该模板共享章节库中未归档的已有名称，不会自动新建。多个章节可用顿号、中文/英文逗号、中文/英文分号、半角斜杠或半角竖线分隔，但只能统一标记为已完成，分钟和数量会平均分配；已完成章节还须符合既有记录的完成时间顺序。</li>
              <li><strong>解析与导入：</strong>“专注 N 次”仅作兼容信息，会被忽略；其他无法识别的行、重复字段或不符合模板的字段会阻止统一导入。解析只生成暂存预览，可在预览中选择模板、修改或删除记录；修改原文字后必须重新解析。正式导入时任务与时段会追加，起床、睡觉和全天注释会覆盖当天对应内容，且任务总分钟不能超过可用的实际学习专注分钟。</li>
            </ul>
          </div>
        </div>
      </details>
    </div>
    <div id="entry_text_import_preview">${entryTextImportDraft.dateStr === dateStr && entryTextImportDraft.result
      ? entryTextImportPreviewHtml(entryTextImportDraft.result, dateStr)
      : ''}</div>
  </div>`;
}

function rememberEntryTextImport(value, dateStr) {
  if (entryTextImportDraft.dateStr !== dateStr) {
    entryTextImportDraft = { dateStr, source: '', result: null };
  }
  entryTextImportDraft.source = String(value || '');
  const chip = document.getElementById('entry_text_import_draft_chip');
  if (chip) chip.textContent = entryTextImportDraft.source.trim() ? '已有暂存文字' : '等待输入';
}

function previewEntryTextImport(dateStr) {
  const source = document.getElementById('entry_text_import_source')?.value || '';
  if (!source.trim()) {
    alert('请先粘贴要解析的文字。');
    return;
  }
  const result = parseEntryTextImport(source);
  entryTextImportDraft = { dateStr, source, result };
  const chip = document.getElementById('entry_text_import_draft_chip');
  if (chip) chip.textContent = '已生成解析预览';
  const host = document.getElementById('entry_text_import_preview');
  if (host) host.innerHTML = entryTextImportPreviewHtml(result, dateStr);
}

function clearEntryTextImport(dateStr) {
  entryTextImportDraft = { dateStr, source: '', result: null };
  const source = document.getElementById('entry_text_import_source');
  const preview = document.getElementById('entry_text_import_preview');
  if (source) source.value = '';
  if (preview) preview.innerHTML = '';
  const chip = document.getElementById('entry_text_import_draft_chip');
  if (chip) chip.textContent = '等待输入';
}

function setEntryTextImportTimeInput(prefix, value) {
  const [hour = '', minute = ''] = String(value || '').split(':');
  const hourInput = document.getElementById(`${prefix}_h`);
  const minuteInput = document.getElementById(`${prefix}_m`);
  if (hourInput) hourInput.value = hour;
  if (minuteInput) minuteInput.value = minute;
  updateSessionClockPreview(prefix);
}

function entryTextImportFormNotice(target, label) {
  document.getElementById('entry_text_import_form_notice')?.remove();
  if (!target) return;
  const notice = document.createElement('div');
  notice.id = 'entry_text_import_form_notice';
  notice.className = 'entry-text-import-form-notice';
  notice.innerHTML = `<b>正在修改暂存预览：${escHtmlApp(label)}</b>
    <span>这里复用正式录入表单，但“保存到预览”不会写入当天。</span>
    <button type="button" class="btn btn-ghost btn-sm" onclick="cancelEntryTextImportFormEdit()">取消修改</button>`;
  target.prepend(notice);
}

function cancelEntryTextImportFormEdit() {
  state._entryTextImportFormEdit = null;
  state._editingSessionId = null;
  state._editingTaskId = null;
  state._sessType = 'normal';
  renderEntry();
  renderHeader();
}

function toggleEntryTextImportScalarEdit(kind, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  if (!result || result[`${kind}Imported`]) return;
  state._entryTextImportFormEdit = { kind, index: null, dateStr };
  if (kind === 'wake') {
    setEntryTextImportTimeInput('wakeInput', result.wakeTime);
    const note = document.getElementById('wakeNoteInput');
    if (note) note.value = result.wakeNote || '';
    const button = document.getElementById('wakeSaveBtn');
    if (button) {
      button.textContent = '保存到预览';
      button.onclick = () => saveEntryTextImportScalarEdit('wake', dateStr);
    }
    const panel = document.querySelector('.entry-inline-panel.wake');
    entryTextImportFormNotice(panel, '起床记录');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (kind === 'sleep') {
    setEntryTextImportTimeInput('sleepInput', result.sleepTime);
    const note = document.getElementById('sleepNoteInput');
    if (note) note.value = result.sleepNote || '';
    const button = document.getElementById('sleepSaveBtn');
    if (button) {
      button.textContent = '保存到预览';
      button.onclick = () => saveEntryTextImportScalarEdit('sleep', dateStr);
    }
    const panel = document.querySelector('.entry-inline-panel.sleep');
    entryTextImportFormNotice(panel, '睡觉记录');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    const note = document.getElementById('dayNoteInput');
    if (note) note.value = result.dayNote || '';
    const button = document.getElementById('dayNoteSaveBtn');
    if (button) {
      button.textContent = '保存到预览';
      button.onclick = () => saveEntryTextImportScalarEdit('dayNote', dateStr);
    }
    const panel = document.querySelector('.entry-note-panel');
    entryTextImportFormNotice(panel, '全天注释');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function saveEntryTextImportScalarEdit(kind, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  if (!result || result[`${kind}Imported`]) return;
  if (kind === 'dayNote') {
    const note = document.getElementById('dayNoteInput')?.value.trim() || '';
    if (!note) { alert('全天注释不能为空。'); return; }
    result.dayNote = note;
  } else {
    const time = readTimeInput(kind === 'wake' ? 'wakeInput' : 'sleepInput');
    if (!time) { alert('请输入有效时间。'); return; }
    const isWake = kind === 'wake';
    result[isWake ? 'wakeTime' : 'sleepTime'] = time;
    result[isWake ? 'wakeNote' : 'sleepNote'] =
      document.getElementById(isWake ? 'wakeNoteInput' : 'sleepNoteInput')?.value.trim() || '';
  }
  state._entryTextImportFormEdit = null;
  renderEntry();
  renderHeader();
}

function toggleEntryTextImportItemEdit(kind, index, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const list = kind === 'session' ? result?.sessions : result?.tasks;
  const item = list?.[index];
  if (!item || item.imported) return;
  state._entryTextImportFormEdit = { kind, index, dateStr };
  if (kind === 'session') openEntryTextImportSessionForm(item, index, dateStr);
  else openEntryTextImportTaskForm(item, index, dateStr);
}

function openEntryTextImportSessionForm(item, index, dateStr) {
  state._editingSessionId = null;
  const form = document.getElementById('sessionForm');
  if (!form) return;
  form.classList.add('open');
  const template = getSessionTemplates().find(value => value.id === item.templateId);
  const sessionType = item.kind === 'normal'
    ? 'normal'
    : normalizeSessionTemplateType(template?.sessionType);
  switchSessionType(sessionType);
  const templateSelect = document.getElementById('session_template_select');
  if (templateSelect) templateSelect.value = item.templateId || '';
  const name = document.getElementById('sess_name');
  if (name) name.value = item.name || template?.name || '';
  setEntryTextImportTimeInput('sess_start', item.startTime);
  setEntryTextImportTimeInput('sess_end', item.endTime);
  const nominal = document.getElementById('sess_nominal');
  const actual = document.getElementById('sess_actual');
  const rest = document.getElementById('sess_rest');
  const note = document.getElementById('sess_note');
  if (nominal) nominal.value = item.nominalMinutes ?? '';
  if (actual) actual.value = item.actualMinutes ?? '';
  if (rest) rest.value = item.restMinutes ?? '';
  if (note) note.value = item.note || '';
  const save = document.getElementById('sessFormSaveBtn');
  if (save) {
    save.textContent = '保存到预览';
    save.onclick = () => saveEntryTextImportSessionEdit(index, dateStr);
  }
  entryTextImportFormNotice(form, `第 ${item.lineNo} 行时段`);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const ENTRY_TEXT_IMPORT_CHAPTER_ISSUE_PREFIX = '章节匹配：';

function entryTextImportResolveTaskChapters(item, template) {
  const chapters = Array.isArray(item.chapterEntries) ? item.chapterEntries : [];
  const activeItems = (template?.namedItems || []).filter(candidate => !candidate.archived);
  return chapters.map(chapter => {
    const matches = activeItems.filter(candidate =>
      entryTextImportChapterKey(candidate.name) === entryTextImportChapterKey(chapter.name));
    return { chapter, matches };
  });
}

function entryTextImportRefreshTaskChapterIssues(item) {
  if (!item) return;
  item.issues = (Array.isArray(item.issues) ? item.issues : [])
    .filter(message => !String(message).startsWith(ENTRY_TEXT_IMPORT_CHAPTER_ISSUE_PREFIX));
  const chapters = Array.isArray(item.chapterEntries) ? item.chapterEntries : [];
  const template = getTaskTemplateById(item.templateId);
  if (!chapters.length || !template) return;
  if (!Boolean(template.namedItemEnabled ?? template.ordinalEnabled)) {
    item.issues.push(`${ENTRY_TEXT_IMPORT_CHAPTER_ISSUE_PREFIX}所选模板没有开启命名章节记录`);
    return;
  }
  entryTextImportResolveTaskChapters(item, template).forEach(({ chapter, matches }) => {
    if (!matches.length) {
      item.issues.push(
        `${ENTRY_TEXT_IMPORT_CHAPTER_ISSUE_PREFIX}“${chapter.name}”未匹配到模板中的已有章节，不会自动新建`
      );
    } else if (matches.length > 1) {
      item.issues.push(
        `${ENTRY_TEXT_IMPORT_CHAPTER_ISSUE_PREFIX}“${chapter.name}”匹配到多个已有章节，请手动选择`
      );
    }
  });
}

function entryTextImportTaskAllocations(item, template) {
  const chapters = Array.isArray(item.chapterEntries) ? item.chapterEntries : [];
  return entryTextImportResolveTaskChapters(item, template)
    .filter(({ matches }) => matches.length === 1)
    .map(({ matches }) => {
      const matched = matches[0];
      return {
      itemId: matched.id,
      itemName: matched.name,
      minutes: chapters.length ? Number(item.minutes || 0) / chapters.length : 0,
      quantity: item.quantity == null || !chapters.length ? null : Number(item.quantity) / chapters.length,
      completed: item.taskCompletionStatus === true,
      isNew: false,
    };
  });
}

function openEntryTextImportTaskForm(item, index, dateStr) {
  state._editingTaskId = null;
  const form = document.getElementById('taskForm');
  if (!form) return;
  form.classList.add('open');
  const template = getTaskTemplateById(item.templateId);
  const previewTask = {
    ...item,
    templateId: item.templateId || null,
    activityType: template?.activityType || '',
    namedItemAllocations: entryTextImportTaskAllocations(item, template),
  };
  const templateSelect = document.getElementById('task_tmpl');
  if (templateSelect) templateSelect.value = item.templateId || '';
  renderForecastTaskFields(item.templateId || '', previewTask);
  configureTaskUnitFields(item.templateId || '');
  const [level1, level2, level3] = parseActPath(template?.activityType || '');
  const values = {
    task_name: item.name || '',
    task_l1: level1,
    task_l2: level2,
    task_l3: level3,
    task_min: item.minutes ?? '',
    task_qty: item.quantity ?? '',
    task_unit: template?.quantityUnit || item.quantityUnit || '',
    task_wrong: item.wrongCount ?? '',
    task_note: item.note || '',
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.value = value;
  });
  autoCalcRate();
  updateTaskCategorySequenceUi();
  const save = document.getElementById('taskFormSaveBtn');
  if (save) {
    save.textContent = '保存到预览';
    save.onclick = () => saveEntryTextImportTaskEdit(index, dateStr);
  }
  entryTextImportFormNotice(form, `第 ${item.lineNo} 行任务`);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deleteEntryTextImportItem(kind, index, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const list = kind === 'session' ? result?.sessions : result?.tasks;
  const item = list?.[index];
  if (!item || item.imported) return;
  const label = kind === 'session'
    ? `第 ${item.lineNo} 行时段`
    : `第 ${item.lineNo} 行任务“${item.name || '未命名任务'}”`;
  if (!confirm(`确定从暂存预览中删除${label}？\n这不会删除当天已经保存的数据；重新解析原文可以恢复。`)) return;
  list.splice(index, 1);
  renderEntryTextImportPreview(dateStr);
}

function saveEntryTextImportSessionEdit(index, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const item = result?.sessions?.[index];
  if (!item || item.imported) return;
  const sessionType = state._sessType || 'normal';
  const startTime = readTimeInput('sess_start');
  const endTime = readTimeInput('sess_end');
  const nominalMinutes = Number(document.getElementById('sess_nominal')?.value);
  const actualMinutes = Number(document.getElementById('sess_actual')?.value);
  const restMinutes = Number(document.getElementById('sess_rest')?.value);
  const templateId = document.getElementById('session_template_select')?.value || '';
  const template = getSessionTemplates().find(value => value.id === templateId);
  const issues = sessionTimingValidationIssues({
    sessionType,
    startTime,
    endTime,
    nominalMinutes,
    actualMinutes,
    restMinutes,
  });
  if (sessionType !== 'normal' && !template) issues.unshift('请选择一个时段模板');
  if (issues.length) {
    alert(`不能保存到预览：\n${issues.map(message => `• ${message}`).join('\n')}`);
    return;
  }
  item.kind = sessionType === 'normal' ? 'normal' : 'named';
  item.name = sessionType === 'normal'
    ? ''
    : template?.name || document.getElementById('sess_name')?.value.trim() || '';
  item.templateId = sessionType === 'normal' ? '' : templateId;
  item.startTime = startTime;
  item.endTime = endTime;
  item.nominalMinutes = sessionType === 'normal' ? nominalMinutes : null;
  item.actualMinutes = Number.isFinite(actualMinutes) ? actualMinutes : null;
  item.restMinutes = sessionType === 'normal' ? restMinutes : null;
  item.note = document.getElementById('sess_note')?.value.trim() || '';
  item.issues = [];
  entryTextImportRefreshSessionTimingIssues(item);
  state._entryTextImportFormEdit = null;
  state._sessType = 'normal';
  renderEntry();
  renderHeader();
}

function saveEntryTextImportTaskEdit(index, dateStr) {
  const result = entryTextImportCurrentResult(dateStr);
  const item = result?.tasks?.[index];
  if (!item || item.imported) return;
  const name = document.getElementById('task_name')?.value.trim() || '';
  const minutes = Number(document.getElementById('task_min')?.value);
  const quantityRaw = document.getElementById('task_qty')?.value ?? '';
  const wrongRaw = document.getElementById('task_wrong')?.value ?? '';
  const quantity = quantityRaw === '' ? null : Number(quantityRaw);
  const wrongCount = wrongRaw === '' ? null : Number(wrongRaw);
  let templateId = document.getElementById('task_tmpl')?.value || '';
  const activityType = buildActPath(catSelValue('task_l1'), catSelValue('task_l2'), catSelValue('task_l3'));
  if (!templateId && activityType) {
    const matches = getTaskTemplates().filter(template => template.activityType === activityType);
    if (matches.length === 1) templateId = matches[0].id;
  }
  const template = getTaskTemplateById(templateId);
  const allocations = taskCollectNamedItemAllocations(false) || [];
  const chapters = allocations.map(allocation => allocation.itemName).filter(Boolean);
  const completionValues = [...new Set(allocations.map(allocation => Boolean(allocation.completed)))];
  const taskCompletionStatus = completionValues.length === 1 ? completionValues[0] : null;
  const issues = [];
  if (!name) issues.push('没有识别到任务名称');
  if (!Number.isInteger(minutes) || minutes <= 0) issues.push('任务时长必须是大于 0 的整数分钟');
  if (quantity != null && (!Number.isInteger(quantity) || quantity < 0)) issues.push('数量必须是非负整数');
  if (wrongCount != null && (!Number.isInteger(wrongCount) || wrongCount < 0)) issues.push('错误数量必须是非负整数');
  if (!template) issues.push('请选择一个已有任务模板');
  if (chapters.length && taskCompletionStatus == null) issues.push('填写章节后必须选择完成状态');
  if (!chapters.length && taskCompletionStatus != null) issues.push('填写完成状态前必须先填写章节');
  if (chapters.length > 1 && taskCompletionStatus === false) issues.push('多个章节不能标记为未完成');
  if (completionValues.length > 1) issues.push('同一任务只能使用一个章节完成状态');
  if (new Set(chapters.map(entryTextImportMatchKey)).size !== chapters.length) issues.push('重复填写了同一个章节');
  item.name = name;
  item.templateId = templateId;
  item.templateTokens = template ? parseActPath(template.activityType) : parseActPath(activityType);
  item.minutes = minutes;
  item.quantity = quantity;
  item.quantityUnit = document.getElementById('task_unit')?.value.trim() || template?.quantityUnit || '';
  item.wrongCount = wrongCount;
  item.wrongUnit = template?.quantityUnit || item.quantityUnit;
  item.chapterEntries = chapters.map(nameValue => ({ name: nameValue }));
  item.taskCompletionStatus = taskCompletionStatus;
  item.note = document.getElementById('task_note')?.value.trim() || '';
  item.issues = issues;
  entryTextImportRefreshTaskChapterIssues(item);
  state._entryTextImportFormEdit = null;
  renderEntry();
  renderHeader();
}

function entryTextImportNamedItems(template, task) {
  const enabled = Boolean(template?.namedItemEnabled ?? template?.ordinalEnabled);
  if (!enabled) return (task.chapterEntries.length || task.taskCompletionStatus != null) ? undefined : [];
  const activeItems = [...(template.namedItems || [])]
    .filter(item => !item.archived)
    .sort((a, b) => Number(a.order) - Number(b.order));
  if (!task.chapterEntries.length || task.taskCompletionStatus == null) return null;
  const resolved = task.chapterEntries.map(entry => {
    const matches = activeItems.filter(item =>
      entryTextImportChapterKey(item.name) === entryTextImportChapterKey(entry.name));
    return matches.length === 1 ? matches[0] : null;
  });
  if (resolved.some(item => item === null)) return null;
  return resolved.map(item => ({
    itemId: item.id,
    itemName: item.name,
    minutes: task.minutes / resolved.length,
    quantity: task.quantity == null ? null : task.quantity / resolved.length,
    completed: task.taskCompletionStatus,
  }));
}

async function confirmEntryTextImport(dateStr, scope = 'all', itemIndex = -1) {
  const currentSource = document.getElementById('entry_text_import_source')?.value || '';
  const result = entryTextImportDraft.dateStr === dateStr ? entryTextImportDraft.result : null;
  if (!result || currentSource !== entryTextImportDraft.source) {
    alert('文字在预览后发生了变化，请重新点击“解析并预览”。');
    return;
  }
  const isAll = scope === 'all';
  const includeWake = Boolean(result.wakeTime && !result.wakeImported && (isAll || scope === 'wake'));
  const includeSleep = Boolean(result.sleepTime && !result.sleepImported && (isAll || scope === 'sleep'));
  const includeDayNote = Boolean(result.dayNote && !result.dayNoteImported && (isAll || scope === 'dayNote'));
  const sessionEntries = result.sessions
    .map((item, index) => ({ item, index }))
    .filter(entry => !entry.item.imported && (isAll || (scope === 'session' && entry.index === itemIndex)));
  const taskEntries = result.tasks
    .map((item, index) => ({ item, index }))
    .filter(entry => !entry.item.imported && (isAll || (scope === 'task' && entry.index === itemIndex)));
  const hasPending = includeWake || includeSleep || includeDayNote || sessionEntries.length || taskEntries.length;
  if (!hasPending) {
    alert('这部分内容已经导入，或者当前没有可导入内容。');
    return;
  }
  const hardIssues = isAll
    ? [
      ...result.issues,
      ...sessionEntries.flatMap(entry => entry.item.issues),
      ...taskEntries.flatMap(entry => entry.item.issues),
      ...result.unrecognized,
    ]
    : [
      ...sessionEntries.flatMap(entry => entry.item.issues),
      ...taskEntries.flatMap(entry => entry.item.issues),
    ];
  if (hardIssues.length) {
    alert(isAll
      ? '仍有未识别或不完整的内容，请先修改预览后再统一导入。'
      : '当前项目仍有错误，请先点击“修改”处理。');
    return;
  }

  const currentDay = getDay(dateStr);
  const candidate = JSON.parse(JSON.stringify(currentDay));
  candidate.sessions = Array.isArray(candidate.sessions) ? candidate.sessions : [];
  candidate.tasks = Array.isArray(candidate.tasks) ? candidate.tasks : [];
  const importedSessionLineById = new Map();
  if (includeWake) {
    candidate.wakeTime = result.wakeTime;
    candidate.wakeNote = result.wakeNote || '';
  }
  if (includeSleep) {
    candidate.sleepTime = result.sleepTime;
    candidate.sleepNote = result.sleepNote || '';
  }
  if (includeDayNote) candidate.dayNote = result.dayNote;

  for (const { item } of sessionEntries) {
    let session;
    if (item.kind === 'named') {
      const selectedId = item.templateId;
      const template = getSessionTemplates().find(value => value.id === selectedId);
      if (!template) {
        alert(`第 ${item.lineNo} 行“${item.name}”还没有选择时段模板。`);
        return;
      }
      const sessionType = normalizeSessionTemplateType(template.sessionType);
      session = {
        id: uid(),
        startTime: item.startTime,
        endTime: item.endTime,
        type: sessionType,
        name: template.name,
        nominalMinutes: 0,
        actualMinutes: sessionType === 'special-study' ? item.actualMinutes : 0,
        restMinutes: 0,
        note: item.note || template.note || '',
      };
    } else {
      session = {
        id: uid(),
        startTime: item.startTime,
        endTime: item.endTime,
        type: 'normal',
        name: '',
        nominalMinutes: item.nominalMinutes,
        actualMinutes: item.actualMinutes,
        restMinutes: Number.isInteger(item.restMinutes) ? item.restMinutes : 0,
        note: item.note || '',
      };
    }
    const timingIssues = sessionTimingValidationIssues({
      sessionType: session.type || 'normal',
      startTime: session.startTime,
      endTime: session.endTime,
      nominalMinutes: session.nominalMinutes,
      actualMinutes: session.actualMinutes,
      restMinutes: session.restMinutes,
    });
    if (timingIssues.length) {
      alert(`第 ${item.lineNo} 行不能导入：${timingIssues[0]}`);
      return;
    }
    const overlap = candidate.sessions.find(existing => sessionsOverlap(existing, session));
    if (overlap) {
      const overlapType = sessionTypeMeta(overlap).label;
      const overlapName = String(overlap.name || '').trim();
      const overlapLabel = overlapName ? `“${overlapName}”（${overlapType}）时段` : `${overlapType}时段`;
      const previousLine = importedSessionLineById.get(overlap.id);
      const overlapOrigin = previousLine ? `本次第 ${previousLine} 行的` : '当天已有的';
      alert(`第 ${item.lineNo} 行 ${session.startTime}–${session.endTime} 与${overlapOrigin}${overlapLabel} ${overlap.startTime}–${overlap.endTime} 重叠。`);
      return;
    }
    candidate.sessions.push(session);
    importedSessionLineById.set(session.id, item.lineNo);
  }

  for (const { item } of taskEntries) {
    const selectedId = item.templateId;
    const template = getTaskTemplateById(selectedId);
    if (!template) {
      alert(`第 ${item.lineNo} 行“${item.name}”还没有选择任务模板。`);
      return;
    }
    if (!Number.isInteger(item.minutes) || item.minutes <= 0) {
      alert(`第 ${item.lineNo} 行的任务时长必须是大于 0 的整数分钟。`);
      return;
    }
    const quantityEnabled = Boolean(template.quantityEnabled);
    const accuracyEnabled = Boolean(template.accuracyEnabled);
    const parsedUnit = entryTextImportMatchKey(item.quantityUnit);
    const parsedWrongUnit = entryTextImportMatchKey(item.wrongUnit);
    const templateUnit = entryTextImportMatchKey(template.quantityUnit);
    if (item.quantity != null && !quantityEnabled) {
      alert(`第 ${item.lineNo} 行包含数量，但模板“${template.activityType}”没有开启数量记录。`);
      return;
    }
    if (item.quantity != null &&
      (!Number.isInteger(item.quantity) || item.quantity < 0 || (parsedUnit && parsedUnit !== templateUnit))) {
      alert(`第 ${item.lineNo} 行的数量或单位与模板不一致（模板单位：${template.quantityUnit || '未设置'}）。`);
      return;
    }
    if (item.wrongCount != null && !accuracyEnabled) {
      alert(`第 ${item.lineNo} 行包含错误数量，但模板“${template.activityType}”没有开启正确率记录。`);
      return;
    }
    let wrongCount = null;
    let accuracy = null;
    if (accuracyEnabled) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isInteger(item.wrongCount) || item.wrongCount < 0 || item.wrongCount > item.quantity ||
        !parsedWrongUnit || parsedWrongUnit !== templateUnit) {
        alert(`第 ${item.lineNo} 行所选模板启用了正确率，请同时填写总数量、错误数量，并让两者单位与模板一致。`);
        return;
      }
      wrongCount = item.wrongCount;
      accuracy = Number((((item.quantity - wrongCount) / item.quantity) * 100).toFixed(2));
    }
    const goal = getForecastGoalByTemplate(template.id);
    if (goal && ['quantity', 'chapterQuantity'].includes(goal.mode)) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0 || template.quantityUnit !== goal.quantityUnit) {
        alert(`第 ${item.lineNo} 行未满足预测目标要求：数量必须大于 0，单位必须是“${goal.quantityUnit}”。`);
        return;
      }
    }
    const namedItemAllocations = entryTextImportNamedItems(template, item);
    if (namedItemAllocations === undefined) {
      alert(`第 ${item.lineNo} 行填写了章节，但模板“${template.activityType}”没有开启章节库。`);
      return;
    }
    if (namedItemAllocations === null) {
      alert(`第 ${item.lineNo} 行所选模板启用了章节库。请填写章节库中的准确名称，并在单独括号中填写唯一的完成状态。`);
      return;
    }
    if (new Set(namedItemAllocations.map(allocation => allocation.itemId)).size !== namedItemAllocations.length) {
      alert(`第 ${item.lineNo} 行重复填写了同一个章节。`);
      return;
    }
    if (!templateUsesChapterQuestionCounts(template) && namedItemAllocations.length > 1 && !item.taskCompletionStatus) {
      alert(`第 ${item.lineNo} 行包含多个章节，完成状态只能是“已完成”。`);
      return;
    }
    if (namedItemAllocations.length &&
      !taskValidateNamedItemTimeline(template.id, namedItemAllocations, dateStr)) return;
    candidate.tasks.push({
      id: uid(),
      name: item.name,
      activityType: template.activityType,
      minutes: item.minutes,
      quantity: quantityEnabled && item.quantity != null ? item.quantity : null,
      quantityUnit: quantityEnabled ? template.quantityUnit || '' : '',
      wrongCount,
      accuracy,
      note: item.note || '',
      templateId: template.id,
      namedItemAllocations,
    });
  }

  const taskMinutes = taskMinutesTotal(candidate.tasks);
  const studyCapacity = studySessionActualTotal(candidate.sessions);
  if (taskMinutes > studyCapacity) {
    alert(`不能导入：导入后任务总时长为 ${taskMinutes} 分钟，但普通时段和特殊学习时段的实际专注总时长只有 ${studyCapacity} 分钟。`);
    return;
  }
  const scopeLabel = isAll
    ? '全部未导入内容'
    : scope === 'session'
      ? '这个时段'
      : scope === 'task'
        ? '这个任务'
        : scope === 'wake'
          ? '起床时间和注释'
          : scope === 'sleep'
            ? '睡觉时间和注释'
            : '全天注释';
  if (!confirm(`确认把${scopeLabel}写入 ${dateStr}？\n时段和任务采用追加；基础信息会覆盖当天对应字段。`)) return;

  await apiFetch(`/api/data/${dateStr}`, { method: 'PUT', body: JSON.stringify(candidate) });
  state.data[dateStr] = candidate;
  updateSleepDraft(
    dateStr,
    candidate.wakeTime || '',
    candidate.sleepTime || '',
    candidate.wakeNote || '',
    candidate.sleepNote || ''
  );
  cacheToLocal();
  if (isAll) {
    entryTextImportDraft.result = null;
  } else {
    if (includeWake) {
      result.wakeTime = '';
      result.wakeNote = '';
      result.wakeLineNo = null;
      delete result.wakeImported;
      delete result.wakeEditing;
    }
    if (includeSleep) {
      result.sleepTime = '';
      result.sleepNote = '';
      result.sleepLineNo = null;
      delete result.sleepImported;
      delete result.sleepEditing;
    }
    if (includeDayNote) {
      result.dayNote = '';
      result.dayNoteLineNo = null;
      delete result.dayNoteImported;
      delete result.dayNoteEditing;
    }
    sessionEntries
      .map(entry => entry.index)
      .sort((left, right) => right - left)
      .forEach(index => result.sessions.splice(index, 1));
    taskEntries
      .map(entry => entry.index)
      .sort((left, right) => right - left)
      .forEach(index => result.tasks.splice(index, 1));
    const hasRemainingPreview = Boolean(
      result.wakeTime || result.sleepTime || result.dayNote ||
      result.sessions.length || result.tasks.length ||
      result.issues.length || result.unrecognized.length
    );
    if (!hasRemainingPreview) entryTextImportDraft.result = null;
  }
  renderEntry();
  renderHeader();
  showPersistentSaveNotice(
    entryTextImportDraft.result
      ? `已导入${scopeLabel}；成功项目已从暂存预览移除`
      : `已导入${scopeLabel}；暂存预览已清空`
  );
}

function renderEntry() {
  const dateStr = state.selectedDate;
  const day = getDay(dateStr);
  const stats = computeDay(dateStr);
  const sessions = sortSessionsByStart(day.sessions || []);
  const tasks = day.tasks || [];
  const taskEfficiencyIndex = buildTaskEfficiencyComparisonIndex();
  const dayTypeTemplates = getDayTypeTemplates();
  const entryDayTypeMeta = dayTypeDisplayMeta(day);
  const hasDayType = Boolean(entryDayTypeMeta.name);
  const dayStatus = hasDayType
    ? day.excludeFromRating
      ? { cls: 'excluded', symbol: entryDayTypeMeta.symbol, label: entryDayTypeMeta.name }
      : { cls: 'special', symbol: entryDayTypeMeta.symbol, label: entryDayTypeMeta.name }
    : { cls: 'normal', symbol: '', label: '普通日期' };
  const focusText = stats.focusEfficiency != null ? `${stats.focusEfficiency}%` : '-';
  const focusTone = stats.focusEfficiency == null ? 'muted' : 'actual';
  const utilText = stats.utilPct != null ? `${stats.utilPct}%` : '-';
  const utilTone = stats.utilPct == null ? 'muted' : 'clock';

  document.getElementById('tab-entry').innerHTML = `
    <div class="entry-workbench">
      <div class="entry-hero">
        <div class="entry-toolbar">
          <button class="btn btn-ghost btn-sm" onclick="changeDate(-1)">← 前一天</button>
          <div class="entry-date-picker">${editableDateInputHtml('entry_date', dateStr, "jumpDate(document.getElementById('entry_date').value)")}</div>
          <button class="btn btn-ghost btn-sm" onclick="changeDate(1)">后一天 →</button>
          <button class="btn btn-ghost btn-sm" onclick="jumpDate('${getTodayStr()}')">今天</button>
          <button class="btn btn-ghost btn-sm" onclick="jumpToLastUnrecordedDay('entry')" title="跳转到最后一个含记录日期之后的完全空白日">定位未记录日</button>
          <button class="btn btn-primary btn-sm" onclick="toggleForm('dayMovePanel')">⇄ 迁移本日数据</button>
          <button class="btn btn-danger btn-sm" onclick="resetEntireEntryDay('${dateStr}')">🗑 重置当天</button>
        </div>
        <div class="entry-hero-main">
          <div class="entry-date-stack">
            <div class="entry-eyebrow">每日记录工作台</div>
            <div class="entry-date-line">
              <span class="date-display">${formatDisplay(dateStr)}</span>
              <span class="entry-day-status ${dayStatus.cls}">${dayStatus.symbol ? `${dayStatus.symbol} ` : ''}${dayStatus.label}</span>
              ${hasDayType ? `<span class="entry-day-type-mini">${day.excludeFromRating ? '不评分' : '评分'}</span>` : ''}
            </div>
            <div class="entry-date-sub">时段 ${sessions.length} 段 · 任务 ${tasks.length} 条 · 任务时长 ${fmtMin(stats.taskMin, true)}</div>
          </div>
          <div class="entry-kpi-strip">
            <div class="entry-kpi-card clock"><span>时钟${tipIcon('clock')}</span><strong>${fmtMin(stats.clockMin, true)}</strong><small>全时段累计</small></div>
            <div class="entry-kpi-card clock"><span>有效${tipIcon('effectiveClock')}</span><strong>${fmtMin(stats.effectiveClockMin, true)}</strong><small>时钟 - 休息</small></div>
            <div class="entry-kpi-card nominal"><span>名义${tipIcon('nominal')}</span><strong>${fmtMin(stats.nominalMin, true)}</strong><small>${devStr(stats.clockVsNominal)}</small></div>
            <div class="entry-kpi-card actual"><span>实际${tipIcon('actual')}</span><strong>${fmtMin(stats.actualMin, true)}</strong><small class="${devClass(stats.actualVsNominal)}">${devStr(stats.actualVsNominal)}</small></div>
            <div class="entry-kpi-card rest"><span>休息${tipIcon('rest')}</span><strong>${fmtMin(stats.restMin, true)}</strong><small>普通时段休息</small></div>
            <div class="entry-kpi-card distract"><span>分心${tipIcon('distract')}</span><strong>${fmtMin(stats.distractMin, true)}</strong><small>时钟-实际-休息</small></div>
            <div class="entry-kpi-card ${focusTone}"><span>专注率${tipIcon('efficiency')}</span><strong>${focusText}</strong><small>实际 / 有效时钟</small></div>
            <div class="entry-kpi-card ${utilTone}"><span>清醒/可支配${tipIcon('awake')}</span><strong>${stats.awakeMin != null ? fmtMin(stats.awakeMin) : '-'}</strong><small>可支配 ${stats.disposableMin != null ? fmtMin(stats.disposableMin) : '-'}</small></div>
          </div>
        </div>
      </div>

      ${dayMigrationPanelHtml(dateStr, day, sessions, tasks)}

      ${entryTextImportPanelHtml(dateStr)}

      <div class="card entry-section entry-foundation-card">
        <div class="card-header entry-section-head">
          <div><div class="card-title">今日基础信息</div><div class="card-sub">作息、日期类型和整日备注</div></div>
        </div>
        <div class="entry-foundation-grid">
          <div class="entry-inline-panel wake">
            <div class="entry-panel-title">起床时间</div>
            <div class="entry-action-row">
              ${timeInputHtml('wakeInput', day.wakeTime || '')}
              <button class="btn btn-success btn-sm" id="wakeSaveBtn" onclick="saveSleep('${dateStr}')">保存</button>
              ${day.wakeTime ? `<button class="btn btn-danger btn-sm" onclick="clearSavedSleepTime('${dateStr}','wake')">删除起床时间</button>` : ''}
            </div>
            <textarea id="wakeNoteInput" class="entry-sleep-note" placeholder="可选：记录起床状态、感受或相关情况……">${escHtmlApp(day.wakeNote || '')}</textarea>
            <div class="entry-panel-meta">${day.wakeTime ? `<span class="fw-mono c-wake">${day.wakeTime}</span>` : '<span class="c-muted">尚未记录</span>'}</div>
          </div>

          <div class="entry-inline-panel sleep">
            <div class="entry-panel-title">睡觉时间</div>
            <div class="entry-action-row">
              ${timeInputHtml('sleepInput', day.sleepTime || '')}
              <button class="btn btn-success btn-sm" id="sleepSaveBtn" onclick="saveSleep('${dateStr}')">保存</button>
              ${day.sleepTime ? `<button class="btn btn-danger btn-sm" onclick="clearSavedSleepTime('${dateStr}','sleep')">删除睡觉时间</button>` : ''}
            </div>
            <textarea id="sleepNoteInput" class="entry-sleep-note" placeholder="可选：记录入睡状态、睡前情况或相关原因……">${escHtmlApp(day.sleepNote || '')}</textarea>
            <div class="entry-panel-meta">${day.sleepTime ? `<span class="fw-mono c-sleep">${day.sleepTime}</span>` : '<span class="c-muted">填次日凌晨时间如 00:30</span>'}</div>
          </div>

          <div class="entry-inline-panel entry-day-type-panel ${hasDayType ? 'has-type' : ''}">
            <div class="entry-panel-title">日期类型</div>
            <div class="entry-day-type-row">
              <label class="entry-field-compact">
                <span>日期类型模板</span>
                <select id="dayTypeInput" onchange="applyDayTypeTemplateToEntry(this.value)">
                  <option value="">普通日期（无日期类型）</option>
                  ${day.dayType && !dayTypeTemplates.some(template => template.name === day.dayType) ? `<option value="${escHtmlApp(day.dayType)}" selected disabled>历史类型 · ${escHtmlApp(day.dayType)}（请改选）</option>` : ''}
                  ${dayTypeTemplates.map(template => `<option value="${escHtmlApp(template.name || '')}" ${day.dayType === template.name ? 'selected' : ''}>${dayTypeSymbolMeta(template.symbolKey).glyph} ${escHtmlApp(template.name || '')}</option>`).join('')}
                </select>
              </label>
              <label class="entry-toggle">
                <input type="checkbox" id="excludeFromRatingCheck" ${hasDayType && day.excludeFromRating ? 'checked' : ''} ${hasDayType ? '' : 'disabled'}>
                <span><b>不参与评分</b><small>不计入周、月、总览顶部汇总</small></span>
              </label>
              <button class="btn btn-success btn-sm" onclick="saveDayType('${dateStr}')">保存日期类型</button>
            </div>
            <div class="entry-panel-meta">选择日期类型后自动应用评分默认值，并可在当天覆盖。当前：${hasDayType ? dayTypeBadgeHtml(day) : '<span class="c-muted">普通日期（无日期类型）</span>'}</div>
          </div>

          <div class="entry-inline-panel entry-note-panel">
            <div class="entry-panel-title">今日备注</div>
            <div class="entry-note-row">
              <textarea id="dayNoteInput" class="entry-note-input" placeholder="可选：记录今天的整体感受、总结或备忘...">${escHtmlApp(day.dayNote || '')}</textarea>
              <button class="btn btn-success btn-sm" id="dayNoteSaveBtn" onclick="saveDayNote('${dateStr}')">保存</button>
            </div>
            ${day.wakeTime && day.sleepTime ? `
              <div class="entry-panel-meta">
                清醒${tipIcon('awake')} <span class="c-text">${fmtMin(stats.awakeMin)}</span>
                ${stats.unavailableMin ? ` · 不可用 <span class="c-muted">${fmtMin(stats.unavailableMin)}</span>` : ''}
                ${stats.specialStudyActualMin ? ` · 特殊学习 <span class="c-clock">${fmtMin(stats.specialStudyActualMin)}</span>` : ''}
                · 可支配 <span class="c-text">${fmtMin(stats.disposableMin)}</span>
                · 不可用占比${tipIcon('util')} <span class="c-muted">${utilText}</span>
              </div>` : ''}
          </div>
        </div>
      </div>

    <!-- ⏱ SESSIONS TABLE -->
    <div class="card entry-section entry-table-card entry-main-panel">
      <div class="card-header">
        <div><div class="card-title">专注时段${state._editingSessionId ? ' <span class="entry-editing-pill">编辑中</span>' : ''}</div><div class="card-sub">记录时钟 / 名义 / 实际三维时间</div></div>
        <button class="btn btn-primary btn-sm" onclick="openNewSessionForm()">+ 添加时段</button>
      </div>
      <div class="form-panel" id="sessionForm">
        <div class="entry-form-block">
        <div class="entry-form-block-title">类型与模板</div>
        <div class="form-group">
          <label>时段类型</label>
          <div class="entry-segmented">
            <button class="btn btn-sm" id="sessTypeNormal" onclick="switchSessionType('normal')" style="background:var(--pol);color:#000;font-weight:600">普通时段</button>
            <button class="btn btn-ghost btn-sm" id="sessTypeSpecial" onclick="switchSessionType('special')">不可用时段</button>
            <button class="btn btn-ghost btn-sm" id="sessTypeSpecialStudy" onclick="switchSessionType('special-study')">特殊学习时段</button>
          </div>
          <div class="form-hint">普通时段：连续专注 · 不可用时段：吃饭、午睡、通勤等完全无法学习 · 特殊学习时段：长时间外出，但其中包含零散学习</div>
        </div>
        <div class="form-group" id="sessNameGroup" style="display:none">
          <label>时段名称 <span style="color:var(--red)">*</span> <span class="entry-label-note">如“午饭”、“回学校”、“外出上课”</span></label>
          <input type="text" id="sess_name" placeholder="输入时段名称">
        </div>
        ${(function () {
      const sTmpls = getSessionTemplates();
      if (!sTmpls.length) return `<div class="form-group" style="margin-bottom:10px">
            <label>套用时段模板 <span class="entry-label-note">（<a href="#" onclick="showTab('templates');return false" style="color:var(--hp)">前往模板库</a>添加后可快速填充）</span></label>
            <span style="font-size:11px;color:var(--dim)">暂无时段模板</span>
          </div>`;
      return `<div class="form-group" style="margin-bottom:10px">
            <label>套用时段模板 <span class="entry-label-note">（选择后自动切换为对应类型并填充名称/备注）</span></label>
            <div class="entry-action-row">
              <select id="session_template_select" onchange="applySessionTemplate(this.value)" style="flex:1">
                <option value="">-- 不套用 --</option>
                <optgroup label="不可用时段">${sTmpls.filter(t => normalizeSessionTemplateType(t.sessionType) === 'special').map(t => `<option value="${t.id}">${escHtmlApp(t.name)}</option>`).join('')}</optgroup>
                <optgroup label="特殊学习时段">${sTmpls.filter(t => normalizeSessionTemplateType(t.sessionType) === 'special-study').map(t => `<option value="${t.id}">${escHtmlApp(t.name)}</option>`).join('')}</optgroup>
              </select>
              <a href="#" onclick="showTab('templates');return false" class="btn btn-ghost btn-sm" style="white-space:nowrap">管理模板</a>
            </div>
          </div>`;
    })()}
        </div>
        <div class="entry-form-block">
        <div class="entry-form-block-title">时间与时长</div>
        <label class="entry-toggle entry-carry-session-toggle">
          <input type="checkbox" id="session_carry_end_to_start" ${SETTINGS.carrySessionEndToStart ? 'checked' : ''} onchange="toggleSessionCarryEndToStart(this.checked)">
          <span><b>承接上个时间点</b><small>保存新增时段后，把本次结束时间作为下一条开始时间</small></span>
        </label>
        <div class="form-grid entry-session-grid" onkeydown="handleSessionTimingKeydown(event)">
          <div class="form-group"><label>开始时间</label>${timeInputHtml('sess_start', '')}</div>
          <div class="form-group"><label>结束时间</label>${timeInputHtml('sess_end', '')}</div>
          <div class="form-group entry-session-clock-preview" id="sess_clock_preview">
            <label>当前时钟时长${tipIcon('clock')}</label>
            <div><b id="sess_clock_preview_value">—</b><span id="sess_clock_preview_detail">填完开始和结束时间后自动计算</span></div>
          </div>
          <div class="form-group" id="sessNominalGroup"><label>名义时长(分钟)${tipIcon('nominal')}</label><input type="number" id="sess_nominal" min="1"><div class="form-hint">计划专注多少分钟</div></div>
          <div class="form-group" id="sessActualGroup"><label>实际专注(分钟)${tipIcon('actual')}</label><input type="number" id="sess_actual" min="1"><div class="form-hint">真正专注的分钟数</div></div>
          <div class="form-group" id="sessRestGroup"><label>休息时间(分钟，可选)${tipIcon('rest')}</label><input type="number" id="sess_rest" min="0" placeholder="不填按 0 分钟"><div class="form-hint">如有填写，名义时长 + 休息时间不能超过时钟时长</div></div>
          <div class="form-group entry-wide"><label>备注</label><input type="text" id="sess_note" placeholder="可选备注"></div>
        </div>
        </div>
        <div class="entry-form-actions">
          <button class="btn btn-success" id="sessFormSaveBtn" onclick="saveSession('${dateStr}')">${state._editingSessionId ? '✓ 更新时段' : '✓ 保存时段'}</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelSessionForm()">${state._editingSessionId ? '取消编辑' : '取消'}</button>
        </div>
      </div>
      ${sessions.length === 0
      ? '<div class="empty-state"><p>暂无时段记录</p></div>'
      : `<div class="table-wrap entry-table-wrap"><table class="entry-data-table">
          <thead><tr><th>#</th><th>开始</th><th>结束</th><th class="c-clock">时钟${tipIcon('clock')}</th><th class="c-nominal">名义${tipIcon('nominal')}</th><th class="c-actual">实际${tipIcon('actual')}</th><th>休息${tipIcon('rest')}</th><th>专注率${tipIcon('sessRate')}</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${sessions.map((s, i) => {
        const cl = sessionClock(s);
        const isSpec = isUnavailableSession(s);
        const isSpecialStudy = isSpecialStudySession(s);
        const typeMeta = sessionTypeMeta(s);
        const rest = Number(s.restMinutes) || 0;
        const actual = Number(s.actualMinutes) || 0;
        const eff = isSpec ? null : isSpecialStudy ? (actual > 0 ? 100 : null) : ((cl - rest) > 0 ? Math.round(actual / (cl - rest) * 100) : null);
        const effCell = isSpecialStudy && eff != null
          ? `${eff}%<br><span class="c-muted" style="font-size:9px">只计实际</span>`
          : eff != null ? eff + '%' : '-';
        const isEditing = state._editingSessionId === s.id;
        return `<tr class="${isEditing ? 'is-editing' : isSpec ? 'is-unavailable' : isSpecialStudy ? 'is-special-study' : ''}">
          <td class="fw-mono c-muted">${i + 1}${typeMeta.short ? `<br><span style="font-size:9px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 4px;border-radius:3px">${typeMeta.short}</span>` : ''}</td>
          <td class="fw-mono">${s.type !== 'normal' && s.name ? `<span style="color:${typeMeta.color};font-weight:600">${escHtmlApp(s.name)}</span><br>` : ''}${s.startTime || '-'}</td><td class="fw-mono">${s.endTime || '-'}</td>
          <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
          <td class="fw-mono c-nominal">${isSpec || isSpecialStudy ? '<span class="c-muted">-</span>' : fmtMin(Number(s.nominalMinutes) || 0, true)}</td>
          <td class="fw-mono c-actual">${isSpec ? '<span class="c-muted">-</span>' : fmtMin(actual, true)}</td>
          <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
          <td class="fw-mono c-actual">${effCell}</td>
          <td class="c-muted" style="font-size:11px">${s.note || ''}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editSession('${dateStr}','${s.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="deleteSession('${dateStr}','${s.id}')">删除</button></td>
        </tr>`;
      }).join('')}</tbody>
          <tfoot><tr><td colspan="3">合计</td><td class="c-clock">${fmtMin(stats.clockMin, true)}</td><td class="c-nominal">${fmtMin(stats.nominalMin, true)}</td><td class="c-actual">${fmtMin(stats.actualMin, true)}</td><td>${fmtMin(stats.restMin, true)}</td><td class="c-actual">${stats.focusEfficiency != null ? stats.focusEfficiency + '%' : '-'}</td><td></td><td></td></tr></tfoot>
        </table></div>`}
    </div>

    <div class="card entry-section entry-table-card entry-main-panel" id="entry-task-records">
      <div class="card-header">
        <div><div class="card-title">任务记录${state._editingTaskId ? ' <span class="entry-editing-pill">编辑中</span>' : ''}</div><div class="card-sub">每项具体学习内容 · 效率自动计算</div></div>
        <div class="entry-action-row">
          <button class="btn btn-primary btn-sm" onclick="state._editingTaskId=null;toggleForm('taskForm')">+ 添加任务</button>
        </div>
      </div>
      <div class="form-panel" id="taskForm">
        <div class="entry-form-block">
          <div class="entry-form-block-title">任务与模板</div>
        <div class="task-form-grid">
          <div class="form-group full-row"><label>任务名称</label><input type="text" id="task_name" placeholder="任务名称"></div>

          <!-- 套用模板 -->
          ${(function () {
      const tmpls = getTaskTemplates();
      if (!tmpls.length) return `<div class="form-group full-row">
              <label>套用模板 <span class="entry-label-note">（<a href="#" onclick="showTab('templates');return false" style="color:var(--hp)">前往模板库</a>添加模板后可快速填充）</span></label>
              <span style="font-size:11px;color:var(--dim)">暂无模板</span>
            </div>`;
      return `<div class="form-group full-row">
              <label>套用模板 <span class="entry-label-note">（选择后自动填充类别/时长/单位）</span></label>
              <div class="entry-action-row">
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
        </div>
        </div>

        <div class="entry-form-block">
          <div class="entry-form-block-title">类别</div>
          <div class="task-form-grid">
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
          </div>
        </div>

        <div class="entry-form-block">
          <div class="entry-form-block-title">计量与备注</div>
          <div class="task-form-grid entry-task-metric-grid">
          <div class="form-group"><label>时长(分钟)</label><input type="number" id="task_min" min="1" oninput="autoCalcRate()"></div>
          <div class="form-group" id="task_qty_group" style="display:none"><label id="task_qty_label">数量（可选）</label><input type="number" id="task_qty" min="0" step="1" oninput="autoCalcRate()"></div>
          <div class="form-group" id="task_unit_group" style="display:none"><label id="task_unit_label">新模板数量单位</label>${unitSelectorHtml('task_unit', '', 'entry_unit_msg')}<div style="font-size:11px;font-family:var(--mono)" id="entry_unit_msg"></div></div>
          <div class="form-group" id="task_rate_group" style="display:none"><label id="task_rate_label">效率（自动计算）</label><input type="text" id="task_rate" readonly style="background:var(--card);color:var(--muted)"><div class="form-hint" id="task_rate_hint">数量÷时长 自动算</div></div>
          <div class="form-group" id="task_wrong_group" style="display:none"><label id="task_wrong_label">错误数量（可选）</label><input type="number" id="task_wrong" min="0" step="1" oninput="autoCalcRate()"><div class="form-hint">填写错误数量，不能超过本次总数量</div></div>
          <div class="form-group" id="task_accuracy_group" style="display:none"><label>正确率（自动计算）</label><input type="text" id="task_acc" readonly style="background:var(--card);color:var(--muted)"><div class="form-hint">（总数量－错题数）÷总数量</div></div>
          <div class="form-group full-row"><label>备注</label><input type="text" id="task_note" placeholder="可选备注"></div>
          </div>
        </div>
        <div class="entry-form-actions">
          <button class="btn btn-success" id="taskFormSaveBtn" onclick="saveTask('${dateStr}')">${state._editingTaskId ? '✓ 更新任务' : '✓ 保存任务'}</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelTaskForm()">${state._editingTaskId ? '取消编辑' : '取消'}</button>
        </div>
      </div>
      ${tasks.length === 0
      ? '<div class="empty-state"><p>暂无任务记录</p></div>'
      : `${taskFilterHtml('entry', tasks)}
        <div class="table-wrap entry-table-wrap"><table id="entryTaskTable" class="resizable-task-table entry-data-table">
          <thead><tr><th>#</th><th>任务名称</th><th>活动类型</th><th>时长</th><th>数量</th><th title="数量任务按${questionEfficiencyUnitLabel('数量')}；纯章节按${questionEfficiencyUnitLabel('章')}；章节+数量按章节50%与数量50%的综合效率">效率</th><th title="相对同模板或同分类历史加权平均效率">较平均效率</th><th>正确率</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${filterTasksByView(tasks, 'entry').map((t, i) => {
        const visibleQty = visibleTaskQuantity(t);
        const visibleUnit = visibleTaskQuantityUnit(t);
        const efficiencyComparison = taskEfficiencyComparisonFor(taskEfficiencyIndex, t, dateStr);
        const efficiencyRate = taskEfficiencyRateText(t, efficiencyComparison);
        const actColor = getActColor(t.activityType);
        const isEditingTask = state._editingTaskId === t.id;
        return `<tr data-task-id="${t.id}" class="${isEditingTask ? 'is-editing' : ''}">
          <td class="fw-mono c-muted">${i + 1}</td>
          <td class="task-name-cell" title="${escHtmlApp(t.name)}">${escHtmlApp(t.name)}${taskOrdinalBadgeHtml(t)}</td>
          <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
          <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
          <td class="fw-mono task-quantity-cell">${visibleQty ? visibleQty + (visibleUnit ? ' ' + visibleUnit : '') : '-'}</td>
          <td class="fw-mono task-rate-cell">${escHtmlApp(efficiencyRate)}</td>
          <td class="fw-mono task-efficiency-delta-cell">${taskEfficiencyDeltaHtml(efficiencyComparison)}</td>
          <td class="fw-mono c-text task-accuracy-cell">${visibleTaskAccuracy(t) == null ? '-' : `${visibleTaskAccuracy(t)}%`}</td>
          <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editTask('${dateStr}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="deleteTask('${dateStr}','${t.id}')">删除</button></td>
        </tr>`;
      }).join('')}</tbody>
          <tfoot><tr><td colspan="3">合计</td><td class="fw-mono">${fmtMin(filterTasksByView(tasks, 'entry').reduce((s, t) => s + (Number(t.minutes) || 0), 0), true)}</td><td colspan="6"><span class="c-muted" style="font-size:10px">任务总时长 vs 实际专注: <span class="${devClass(stats.actualMin > 0 ? Math.round((stats.taskMin - stats.actualMin) / stats.actualMin * 100) : null)}">${stats.actualMin > 0 ? devStr(Math.round((stats.taskMin - stats.actualMin) / stats.actualMin * 100)) : '-'}</span></span></td></tr></tfoot>
        </table></div>`}
    </div>
    </div>
  `;
  requestAnimationFrame(() => {
    updateTaskCategorySequenceUi();
    initEntryTaskColumnResize();
    syncEntryDayTypeRating();
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
      rateEl.value = formatQuestionEfficiency(qty / mins, unit || '题', 2);
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

function openNewSessionForm() {
  state._editingSessionId = null;
  const form = document.getElementById('sessionForm');
  if (!form) return;
  form.classList.toggle('open');
  if (!form.classList.contains('open')) return;
  requestAnimationFrame(() => {
    const startValue = readTimeInput('sess_start');
    const targetId = startValue ? 'sess_end_h' : 'sess_start_h';
    const target = document.getElementById(targetId);
    if (!target) return;
    target.focus();
    if (typeof target.select === 'function') target.select();
  });
}

function toggleSessionCarryEndToStart(checked) {
  SETTINGS.carrySessionEndToStart = checked === true;
  saveSettings(SETTINGS);
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

function entryDayResetSummary(day = {}) {
  const sessions = Array.isArray(day.sessions) ? day.sessions : [];
  const scalarLabels = [
    day.wakeTime || day.wakeNote ? '起床记录' : '',
    day.sleepTime || day.sleepNote ? '睡觉记录' : '',
    day.dayNote ? '全天注释' : '',
    day.dayType || day.excludeFromRating ? '日期类型' : '',
  ].filter(Boolean);
  return {
    scalarLabels,
    sessionCount: sessions.length,
    normalSessionCount: sessions.filter(session =>
      !isUnavailableSession(session) && !isSpecialStudySession(session)).length,
    unavailableSessionCount: sessions.filter(isUnavailableSession).length,
    specialStudySessionCount: sessions.filter(isSpecialStudySession).length,
    taskCount: Array.isArray(day.tasks) ? day.tasks.length : 0,
  };
}

async function resetEntireEntryDay(dateStr) {
  const day = state.data[dateStr] || {};
  const summary = entryDayResetSummary(day);
  const localDraft = loadDraft(dateStr);
  const hasTextPreview = entryTextImportDraft.dateStr === dateStr &&
    Boolean(entryTextImportDraft.source || entryTextImportDraft.result);
  const hasSavedData = Boolean(
    summary.scalarLabels.length || summary.sessionCount || summary.taskCount
  );
  const hasDraft = Boolean(localDraft && Object.keys(localDraft).some(key => key !== '_savedAt'));
  if (!hasSavedData && !hasDraft && !hasTextPreview) {
    alert(`${dateStr} 当前已经是未录入状态。`);
    return;
  }
  const contents = [
    summary.scalarLabels.length ? summary.scalarLabels.join('、') : '',
    summary.normalSessionCount ? `${summary.normalSessionCount} 段普通时段` : '',
    summary.unavailableSessionCount ? `${summary.unavailableSessionCount} 段不可用时段` : '',
    summary.specialStudySessionCount ? `${summary.specialStudySessionCount} 段特殊学习时段` : '',
    summary.taskCount ? `${summary.taskCount} 条任务` : '',
    hasDraft || hasTextPreview ? '未保存草稿和文字解析暂存' : '',
  ].filter(Boolean).join('、');
  if (!confirm(
    `确定把 ${dateStr} 重置为未录入吗？\n` +
    `将永久删除：${contents || '当天全部内容'}。\n此操作不能撤销。`
  )) return;
  if (!confirm(
    `最后确认：删除 ${dateStr} 的全天所有记录，并清除该日录入草稿？`
  )) return;

  const emptyDay = {
    wakeTime: '',
    sleepTime: '',
    wakeNote: '',
    sleepNote: '',
    dayNote: '',
    dayType: '',
    excludeFromRating: false,
    sessions: [],
    tasks: [],
  };
  try {
    await apiFetch(`/api/data/${dateStr}`, {
      method: 'PUT',
      body: JSON.stringify(emptyDay),
    });
  } catch (error) {
    console.error('重置全天记录失败', error);
    alert('重置失败：服务器没有确认删除，当天现有记录仍然保留。请反馈后端日志中的关键错误。');
    return;
  }

  delete state.data[dateStr];
  try { localStorage.removeItem(DRAFT_KEY_PREFIX + dateStr); } catch (error) { }
  if (entryTextImportDraft.dateStr === dateStr) {
    entryTextImportDraft = { dateStr, source: '', result: null };
  }
  if (state._serverSnapshot?.entryDraftDate === dateStr) {
    state._serverSnapshot.entryDraftDate = '';
    state._serverSnapshot.entryDraft = {};
  }
  state._editingSessionId = null;
  state._editingTaskId = null;
  state._entryTextImportFormEdit = null;
  state._sessType = 'normal';
  cacheToLocal();
  await clearServerSnapshot(false);
  renderEntry();
  renderHeader();
  showPersistentSaveNotice(`${dateStr} 已重置为未录入`);
}

async function saveDayNote(dateStr) {
  const note = document.getElementById('dayNoteInput')?.value || '';
  const day = getDay(dateStr);
  day.dayNote = note;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/dayNote`, { method: 'PUT', body: JSON.stringify({ dayNote: note }) });
  showPersistentSaveNotice(note.trim() ? '今日备注已保存' : '今日备注已清空并保存');
}

function applyDayTypeTemplateToEntry(name) {
  const tmpl = getDayTypeTemplates().find(item => item.name === String(name || '').trim());
  const exclude = document.getElementById('excludeFromRatingCheck');
  if (!tmpl) {
    if (exclude) exclude.checked = false;
    syncEntryDayTypeRating();
    return;
  }
  if (exclude) exclude.checked = Boolean(tmpl.excludeFromRating);
  syncEntryDayTypeRating();
}

function syncEntryDayTypeRating() {
  const type = document.getElementById('dayTypeInput');
  const exclude = document.getElementById('excludeFromRatingCheck');
  if (!exclude) return;
  const hasType = Boolean(type?.value?.trim());
  exclude.disabled = !hasType;
  if (!hasType) exclude.checked = false;
}

function readEntryDayTypeSelection() {
  const dayType = document.getElementById('dayTypeInput')?.value?.trim() || '';
  if (!dayType) {
    return { dayType: '', excludeFromRating: false };
  }
  const template = getDayTypeTemplates().find(item => item.name === dayType);
  if (!template) {
    const currentDay = getDay(state.selectedDate);
    if (dayTypeName(currentDay) === dayType) {
      return {
        dayType,
        excludeFromRating: Boolean(document.getElementById('excludeFromRatingCheck')?.checked),
      };
    }
    alert('请选择一个有效的日期类型模板');
    return null;
  }
  return {
    dayType: template.name,
    excludeFromRating: Boolean(document.getElementById('excludeFromRatingCheck')?.checked),
  };
}

async function saveDayType(dateStr) {
  const selection = readEntryDayTypeSelection();
  if (!selection) return;
  const { dayType, excludeFromRating } = selection;
  const day = getDay(dateStr);
  day.dayType = dayType;
  delete day.specialDay;
  day.excludeFromRating = excludeFromRating;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/dayType`, { method: 'PUT', body: JSON.stringify({ dayType, excludeFromRating }) });
  renderEntry(); renderHeader(); restoreDraft(dateStr);
  showPersistentSaveNotice('日期类型已保存');
}

async function saveSleep(dateStr) {
  const wakeTime = readTimeInput('wakeInput');
  const sleepTime = readTimeInput('sleepInput');
  const wakeNote = document.getElementById('wakeNoteInput')?.value || '';
  const sleepNote = document.getElementById('sleepNoteInput')?.value || '';
  const selection = readEntryDayTypeSelection();
  if (!selection) return;
  const { dayType, excludeFromRating } = selection;
  const day = getDay(dateStr);
  day.wakeTime = wakeTime;
  day.sleepTime = sleepTime;
  day.wakeNote = wakeNote;
  day.sleepNote = sleepNote;
  day.dayType = dayType;
  delete day.specialDay;
  day.excludeFromRating = excludeFromRating;
  updateSleepDraft(dateStr, wakeTime, sleepTime, wakeNote, sleepNote);
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sleep`, { method: 'PUT', body: JSON.stringify({ wakeTime, sleepTime, wakeNote, sleepNote, dayType, excludeFromRating }) });
  renderEntry(); renderHeader(); restoreDraft(dateStr);
}

function updateSleepDraft(dateStr, wakeTime, sleepTime, wakeNote = null, sleepNote = null) {
  const draft = loadDraft(dateStr) || {};
  const wakeParts = String(wakeTime || '').split(':');
  const sleepParts = String(sleepTime || '').split(':');
  draft.wakeH = wakeTime ? wakeParts[0] || '' : '';
  draft.wakeM = wakeTime ? wakeParts[1] || '' : '';
  draft.sleepH = sleepTime ? sleepParts[0] || '' : '';
  draft.sleepM = sleepTime ? sleepParts[1] || '' : '';
  if (wakeNote != null) draft.wakeNote = wakeNote;
  if (sleepNote != null) draft.sleepNote = sleepNote;
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
  if (state._savingSession) return;
  state._savingSession = true;
  const saveBtn = document.getElementById('sessFormSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await saveSessionCore(dateStr);
  } finally {
    state._savingSession = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function saveSessionCore(dateStr) {
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
  const timingIssues = sessionTimingValidationIssues({
    sessionType,
    startTime: start,
    endTime: end,
    nominalMinutes: nominal,
    actualMinutes: actual,
    restMinutes: rest,
  });
  if (timingIssues.length) {
    alert(`时段数据不合法：\n${timingIssues.map(message => `• ${message}`).join('\n')}`);
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
  if (!canApplyStudySessionCapacityChange(day, candidateSessions)) return;

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
    cacheToLocal();
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
    cacheToLocal();
    await apiFetch(`/api/data/${dateStr}/sessions`, { method: 'POST', body: JSON.stringify(session) });
  }
  const carryNextStart = !editId && SETTINGS.carrySessionEndToStart === true;
  clearEntryDraftFields(dateStr, ENTRY_SESSION_DRAFT_KEYS);
  if (carryNextStart) setNextSessionStartDraft(dateStr, end);
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
  saveCurrentEntryDraft(dateStr);
  state._editingSessionId = sessionId;
  // 重新渲染以更新按钮文字
  renderEntry();
  restoreDraft(dateStr);
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
    updateSessionClockPreview();
  }, 60);
}

function cancelSessionForm() {
  if (state._entryTextImportFormEdit?.kind === 'session') {
    cancelEntryTextImportFormEdit();
    return;
  }
  saveCurrentEntryDraft(state.selectedDate);
  clearEntryDraftFields(state.selectedDate, ENTRY_SESSION_DRAFT_KEYS);
  state._editingSessionId = null;
  state._sessType = 'normal';
  const form = document.getElementById('sessionForm');
  if (form) form.classList.remove('open');
  renderEntry();
  restoreDraft(state.selectedDate);
}

async function deleteSession(dateStr, id) {
  const day = getDay(dateStr);
  const candidateSessions = day.sessions.filter(s => s.id !== id);
  if (!canApplyStudySessionCapacityChange(day, candidateSessions)) return;
  day.sessions = candidateSessions;
  cacheToLocal();
  await apiFetch(`/api/data/${dateStr}/sessions/${id}`, { method: 'DELETE' });
  renderEntry(); renderHeader();
}

function studySessionActualTotal(sessions = []) {
  return sessions.reduce((sum, session) => {
    if (isUnavailableSession(session)) return sum;
    return sum + Math.max(0, Number(session.actualMinutes) || 0);
  }, 0);
}

function taskMinutesTotal(tasks = [], excludedTaskId = null) {
  return tasks.reduce((sum, task) => {
    if (excludedTaskId && task.id === excludedTaskId) return sum;
    return sum + Math.max(0, Number(task.minutes) || 0);
  }, 0);
}

function canApplyStudySessionCapacityChange(day, candidateSessions) {
  const taskTotal = taskMinutesTotal(day.tasks);
  const currentCapacity = studySessionActualTotal(day.sessions);
  const nextCapacity = studySessionActualTotal(candidateSessions);
  if (nextCapacity < taskTotal && nextCapacity < currentCapacity) {
    alert(`不能保存：当天任务总时长为 ${taskTotal} 分钟，修改后学习时段的实际专注总时长只有 ${nextCapacity} 分钟。\n普通时段和特殊学习时段的实际专注容量之和不能低于任务总时长。`);
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
      const accuracyEnabled = inheritedTemplateConfig
        ? Boolean(inheritedTemplateConfig.accuracyEnabled)
        : Boolean(document.getElementById('task_new_accuracy_enabled')?.checked);
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
        accuracyEnabled,
        scoreEnabled: inheritedTemplateConfig ? Boolean(inheritedTemplateConfig.scoreEnabled) : Boolean(document.getElementById('task_new_score_enabled')?.checked),
        scoreMax: inheritedTemplateConfig?.scoreMax ?? (Number(document.getElementById('task_new_score_max')?.value) || null),
        chapterQuantityOnly: Boolean(inheritedTemplateConfig?.chapterQuantityOnly),
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
  const accuracyEnabled = template
    ? Boolean(template.accuracyEnabled)
    : inheritedTemplateConfig
      ? Boolean(inheritedTemplateConfig.accuracyEnabled)
      : Boolean(document.getElementById('task_new_accuracy_enabled')?.checked);
  const scoreEnabled = template ? Boolean(template.scoreEnabled) : inheritedTemplateConfig ? Boolean(inheritedTemplateConfig.scoreEnabled) : Boolean(document.getElementById('task_new_score_enabled')?.checked);
  const ordinalUnit = template?.ordinalUnit || inheritedTemplateConfig?.ordinalUnit ||
    document.getElementById('task_new_ordinal_unit')?.value.trim() || '';
  const quantityUnit = template?.quantityUnit || inheritedTemplateConfig?.quantityUnit ||
    document.getElementById('task_unit')?.value.trim() || '';
  if (!template && (ordinalEnabled || quantityEnabled || accuracyEnabled)) {
    alert('使用命名章节或数量记录时必须填写活动类别，以便建立并绑定模板。');
    return;
  }
  if (accuracyEnabled && !quantityEnabled) {
    alert('正确率记录依赖数量记录，请先开启数量记录。');
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
  if (accuracyEnabled && scoreEnabled) { alert('正确率记录和分数记录不能同时开启。'); return; }
  if (ordinalEnabled && !templateUsesChapterQuestionCounts(template) && namedItemAllocations.length > 1 &&
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
  if (accuracyEnabled) {
    const quantityNumber = Number(qty);
    const wrongNumber = Number(wrongRaw);
    if (!Number.isInteger(quantityNumber) || quantityNumber <= 0) {
      alert('该模板已开启正确率记录，请填写大于 0 的整数总数量。');
      return;
    }
    if (wrongRaw === '') {
      alert('该模板已开启正确率记录，请填写错误数量；没有错题时请填写 0。');
      return;
    }
    if (!Number.isInteger(wrongNumber) || wrongNumber < 0 || wrongNumber > quantityNumber) {
      alert(`错题数必须是 0 到 ${quantityNumber} 之间的整数。`);
      return;
    }
    wrongCount = wrongNumber;
    calculatedAccuracy = Number((((quantityNumber - wrongNumber) / quantityNumber) * 100).toFixed(2));
  }
  let taskScore = null;
  let scoreMax = null;
  if (scoreEnabled) {
    const perChapterMax = Number(template?.scoreMax);
    if (!ordinalEnabled || !namedItemAllocations.length) {
      alert('分数记录必须至少选择一个命名章节。');
      return;
    }
    if (!Number.isFinite(perChapterMax) || perChapterMax <= 0) {
      alert('请先设置大于 0 的每章满分。');
      return;
    }
    const completedItems = namedItemAllocations.filter(item => item.completed);
    const invalidScore = completedItems.find(item => item.score == null ||
      !Number.isFinite(item.score) || item.score < 0 || item.score > perChapterMax);
    if (invalidScore) {
      alert(`完成章节“${invalidScore.itemName}”必须填写 0 到 ${perChapterMax} 之间的得分。`);
      return;
    }
    if (completedItems.length) {
      taskScore = completedItems.reduce((total, item) => total + item.score, 0);
      scoreMax = perChapterMax * completedItems.length;
    }
  }
  const editId = state._editingTaskId;
  const day = getDay(dateStr);
  const previousNote = editId ? String(day.tasks.find(task => task.id === editId)?.note || '') : '';
  const otherTaskMinutes = taskMinutesTotal(day.tasks, editId);
  const taskTotalAfterSave = otherTaskMinutes + mins;
  const studyCapacity = studySessionActualTotal(day.sessions);
  if (taskTotalAfterSave > studyCapacity) {
    alert(`不能保存：保存后当天任务总时长为 ${taskTotalAfterSave} 分钟，但普通时段和特殊学习时段的实际专注总时长只有 ${studyCapacity} 分钟。\n请先增加或调整学习时段。`);
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
    }
    if (accuracyEnabled) {
      task.wrongCount = wrongCount;
      task.accuracy = calculatedAccuracy;
    }
    if (scoreEnabled) {
      task.score = taskScore;
      task.scoreMax = scoreMax;
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
        score: scoreEnabled ? (item.completed ? item.score : null)
          : taskNamedItemAllocations(task).find(previous => previous.itemId === item.itemId)?.score ?? null,
      }));
      delete task.ordinalNumbers;
      delete task.completedOrdinals;
      delete task.chapterNumbers;
      delete task.completedChapters;
      delete task.chapterNumber;
      delete task.chapterCompleted;
    }
    state._editingTaskId = null;
    cacheToLocal();
    await apiFetch(`/api/data/${dateStr}`, { method: 'PUT', body: JSON.stringify(day) });
  } else {
    // ── 新增模式 ──
    const task = {
      id: uid(), name, activityType, minutes: mins,
      quantity: quantityEnabled && qty !== '' ? Number(qty) : null,
      quantityUnit: quantityEnabled ? quantityUnit : '',
      wrongCount: accuracyEnabled ? wrongCount : null,
      accuracy: accuracyEnabled ? calculatedAccuracy : null, note,
      score: scoreEnabled ? taskScore : null,
      scoreMax: scoreEnabled ? scoreMax : null,
      templateId: templateId || null,
      namedItemAllocations: ordinalEnabled ? namedItemAllocations.map(item => ({
        itemId: item.itemId,
        itemName: item.itemName,
        minutes: item.minutes,
        quantity: quantityEnabled ? item.quantity : null,
        completed: item.completed,
        score: scoreEnabled && item.completed ? item.score : null,
      })) : [],
    };
    day.tasks.push(task);
    cacheToLocal();
    await apiFetch(`/api/data/${dateStr}/tasks`, { method: 'POST', body: JSON.stringify(task) });
  }
  // 请求完成后再清当前表单草稿，避免等待网络时被 3 秒定时器重新保存旧表单。
  clearEntryDraftFields(dateStr, ENTRY_TASK_DRAFT_KEYS);
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
  saveCurrentEntryDraft(dateStr);
  state._editingTaskId = taskId;
  // 重新渲染以更新按钮文字
  renderEntry();
  restoreDraft(dateStr);
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
  if (state._entryTextImportFormEdit?.kind === 'task') {
    cancelEntryTextImportFormEdit();
    return;
  }
  saveCurrentEntryDraft(state.selectedDate);
  clearEntryDraftFields(state.selectedDate, ENTRY_TASK_DRAFT_KEYS);
  state._editingTaskId = null;
  const form = document.getElementById('taskForm');
  if (form) form.classList.remove('open');
  renderEntry();
  restoreDraft(state.selectedDate);
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
  const action = mode === 'overwrite' ? '覆盖' : '追加';
  const warning = mode === 'overwrite'
    ? `会先清空目标日全部原有数据（当前 ${targetSessionCount} 条时段、${targetTaskCount} 条任务），再写入本次所选项目。`
    : `所选任务和不冲突的目标日旧时段会保留；如果迁入时段与目标日旧时段重叠，会先删除目标日重叠旧时段以避免冲突。起床、今日备注、睡觉选中后仍覆盖对应值。`;
  if (!confirm(`把 ${sourceDate} 选中的 ${selected.length} 项迁移到 ${targetDate}（${action}）？\n${warning}\n来源日只删除已选内容。`)) return;
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
    if (selection.wakeTime) { draft.wakeH = ''; draft.wakeM = ''; draft.wakeNote = ''; }
    if (selection.dayNote) draft.dayNote = '';
    if (selection.sleepTime) { draft.sleepH = ''; draft.sleepM = ''; draft.sleepNote = ''; }
    draft._savedAt = new Date().toISOString();
    saveDraft(sourceDate, draft);
    state.selectedDate = targetDate;
    cacheToLocal();
    const replacedText = result.replacedTargetSessions ? `；已删除目标日重叠时段 ${result.replacedTargetSessions} 条` : '';
    alert(`已迁移 ${result.moved} 项数据到 ${targetDate}，其中专注时段 ${result.movedSessions} 条、任务 ${result.movedTasks} 条${replacedText}。`);
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
function calendarMonthDateStrs(year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, index) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
  );
}

function calendarFocusDate(year, month, days, todayStr) {
  const visibleDates = days.map(d => d.dateStr);
  if (visibleDates.includes(state.selectedDate)) return state.selectedDate;
  const monthDates = calendarMonthDateStrs(year, month);
  if (monthDates.includes(todayStr)) return todayStr;
  return monthDates[0];
}

function calendarHeatLevel(actualMin) {
  if (actualMin <= 0) return 0;
  if (actualMin < 120) return 1;
  if (actualMin < 240) return 2;
  if (actualMin < 360) return 3;
  return 4;
}

function calendarBuildMonthStats(monthDates) {
  const dayStats = monthDates.map(dateStr => ({ dateStr, ...computeDay(dateStr) }));
  const recordedDays = monthDates.filter(isEffectiveRecordDay);
  const totalActual = dayStats.reduce((sum, day) => sum + day.actualMin, 0);
  const totalTask = dayStats.reduce((sum, day) => sum + day.taskMin, 0);
  const typedCount = monthDates.filter(dateStr => Boolean(dayTypeName(state.data[dateStr]))).length;
  const excludedCount = monthDates.filter(dateStr => Boolean(state.data[dateStr]?.excludeFromRating)).length;
  const unclassifiedCount = monthDates.reduce((sum, dateStr) => {
    const day = state.data[dateStr] || {};
    return sum + ((day.tasks || []).filter(isTaskUnclassified).length);
  }, 0);
  return {
    totalActual,
    totalTask,
    recordedDays: recordedDays.length,
    avgActual: recordedDays.length ? Math.round(totalActual / recordedDays.length) : 0,
    typedCount,
    excludedCount,
    unclassifiedCount,
  };
}

function calendarSummaryCardHtml(label, value, sub, tone = '') {
  return `<div class="calendar-summary-card ${tone}">
    <span>${label}</span>
    <strong>${value}</strong>
    <small>${sub}</small>
  </div>`;
}

function calendarSummaryHtml(stats) {
  return `<div class="calendar-summary-grid">
    ${calendarSummaryCardHtml('本月实际专注', fmtMin(stats.totalActual, true), `${stats.recordedDays} 天有记录`, 'actual')}
    ${calendarSummaryCardHtml('任务记录时长', fmtMin(stats.totalTask, true), '任务板累计', 'task')}
    ${calendarSummaryCardHtml('日均实际专注', fmtMin(stats.avgActual, true), '按有记录日期均分', 'avg')}
    ${calendarSummaryCardHtml('日期类型日', `${stats.typedCount} 天`, `${stats.excludedCount} 天不参与评分`, 'typed')}
    ${calendarSummaryCardHtml('未分类任务', `${stats.unclassifiedCount} 条`, stats.unclassifiedCount ? '需要整理类别或模板关联' : '本月已整理', stats.unclassifiedCount ? 'warning' : 'clean')}
  </div>`;
}

function calendarDayMeta(dateStr, inMonth, todayStr, focusDate, maxActual) {
  const stats = computeDay(dateStr);
  const day = state.data[dateStr] || {};
  const tasks = day.tasks || [];
  const sessions = day.sessions || [];
  const unclassifiedTasks = tasks.filter(isTaskUnclassified);
  const actualPct = maxActual > 0 ? Math.round(stats.actualMin / maxActual * 100) : 0;
  return {
    dateStr,
    inMonth,
    day,
    stats,
    tasks,
    sessions,
    unclassifiedTasks,
    isToday: dateStr === todayStr,
    isSelected: dateStr === focusDate,
    isTypedDay: Boolean(dayTypeName(day)),
    isExcluded: Boolean(dayTypeName(day) && day.excludeFromRating),
    hasData: stats.actualMin > 0 || stats.taskMin > 0 || day.wakeTime || day.sleepTime || Boolean(dayTypeName(day)) || tasks.length > 0 || sessions.length > 0,
    heatLevel: calendarHeatLevel(stats.actualMin),
    heatPct: Math.max(0, Math.min(100, actualPct)),
    heatAlpha: stats.actualMin > 0 ? Math.min(.32, .08 + actualPct / 100 * .24).toFixed(3) : '0',
  };
}

function calendarDayTinySummary(meta) {
  const pieces = [];
  if (meta.sessions.length) pieces.push(`${meta.sessions.length} 段`);
  if (meta.tasks.length) pieces.push(`${meta.tasks.length} 项`);
  if (meta.day.wakeTime || meta.day.sleepTime) pieces.push('作息');
  return pieces.length ? pieces.join(' · ') : '无记录';
}

function calendarDayBadgesHtml(meta) {
  const badges = [];
  if (meta.isTypedDay) {
    const typeMeta = dayTypeDisplayMeta(meta.day);
    badges.push(`<span class="cal-day-badge type" style="--day-type-color:${typeMeta.color}">${typeMeta.symbol} ${escHtmlApp(typeMeta.name)}</span>`);
    badges.push(`<span class="cal-day-badge ${meta.isExcluded ? 'excluded' : 'scored'}">${meta.isExcluded ? '不评分' : '评分'}</span>`);
  }
  if (meta.unclassifiedTasks.length) badges.push('<span class="cal-day-badge warning">未分</span>');
  return badges.join('');
}

function calendarDayCellHtml(meta) {
  const actKeys = Object.keys(meta.stats.actMin || {})
    .filter(key => meta.stats.actMin[key] > 0)
    .sort((a, b) => meta.stats.actMin[b] - meta.stats.actMin[a]);
  const dots = actKeys.slice(0, 5).map(key => {
    const color = getActColor(key).color;
    return `<span class="cal-dot" style="--dot-color:${color}" title="${escHtmlApp(key)}: ${fmtMin(meta.stats.actMin[key])}"></span>`;
  }).join('');
  const extraDot = actKeys.length > 5 ? '<span class="cal-dot more" title="更多活动类型">+</span>' : '';
  const title = `${meta.dateStr}，实际${fmtMin(meta.stats.actualMin)}，任务${meta.tasks.length}项，时段${meta.sessions.length}段`;
  return `<button type="button"
      class="cal-day heat-${meta.heatLevel} ${meta.isToday ? 'today' : ''} ${meta.isSelected ? 'selected' : ''} ${!meta.inMonth ? 'other-month' : ''} ${meta.hasData ? 'has-data' : ''} ${meta.isTypedDay ? 'typed-day' : ''} ${meta.isExcluded ? 'excluded-day' : ''} ${meta.unclassifiedTasks.length ? 'has-warning' : ''}"
      data-calendar-date="${meta.dateStr}"
      aria-current="${meta.isToday ? 'date' : 'false'}"
      aria-pressed="${meta.isSelected ? 'true' : 'false'}"
      style="--cal-heat:${meta.heatAlpha};--cal-fill:${meta.heatPct}%"
      onclick="calSelectDay('${meta.dateStr}')"
      title="${escHtmlApp(title)}">
      <span class="cal-day-top">
        <span class="cal-day-num">${strToDate(meta.dateStr).getDate()}</span>
        <span class="cal-day-badges">${calendarDayBadgesHtml(meta)}</span>
      </span>
      <span class="cal-day-main">
        <span class="cal-day-hours">${meta.hasData ? fmtHrs(meta.stats.actualMin) : '—'}</span>
        <span class="cal-day-sub">${calendarDayTinySummary(meta)}</span>
      </span>
      <span class="cal-day-bar"><span></span></span>
      <span class="cal-day-indicator">${dots}${extraDot}</span>
    </button>`;
}

function calendarDayListHtml(meta) {
  const typeMeta = dayTypeDisplayMeta(meta.day);
  const typeHtml = typeMeta.name
    ? `<span class="calendar-list-type" style="--day-type-color:${typeMeta.color}">${typeMeta.symbol} ${escHtmlApp(typeMeta.name)}</span><span class="calendar-list-rating ${meta.isExcluded ? 'excluded' : 'scored'}">${meta.isExcluded ? '不评分' : '评分'}</span>`
    : '<span class="calendar-list-type normal">普通日期</span>';
  return `<button type="button" class="calendar-list-row ${meta.isToday ? 'today' : ''} ${meta.isSelected ? 'selected' : ''} ${meta.isExcluded ? 'excluded' : ''}" onclick="calSelectDay('${meta.dateStr}')">
    <span class="calendar-list-date"><b>${formatShort(meta.dateStr)}</b><small>${meta.dateStr}</small></span>
    <span class="calendar-list-status">${typeHtml}</span>
    <span class="calendar-list-metrics"><b>${fmtMin(meta.stats.actualMin, true)}</b><small>${meta.tasks.length} 项任务 · ${meta.sessions.length} 段时段</small></span>
  </button>`;
}

function calendarFocusMetricHtml(label, value, tone = '') {
  return `<div class="calendar-focus-metric ${tone}">
    <span>${label}</span>
    <strong>${value}</strong>
  </div>`;
}

function calendarFocusStatusHtml(meta) {
  if (meta.isTypedDay) {
    const typeMeta = dayTypeDisplayMeta(meta.day);
    return `<span class="calendar-status-group"><span class="calendar-status-pill type" style="--day-type-color:${typeMeta.color}">${typeMeta.symbol} ${escHtmlApp(typeMeta.name)}</span><span class="calendar-status-pill ${meta.isExcluded ? 'excluded' : 'scored'}">${meta.isExcluded ? '不评分' : '评分'}</span></span>`;
  }
  return '<span class="calendar-status-pill normal">普通日期</span>';
}

function calendarFocusPanelHtml(meta) {
  const date = strToDate(meta.dateStr);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  const unclassifiedTitle = meta.unclassifiedTasks.map(task => task.name || '未命名任务').join('、');
  return `<aside class="calendar-focus-panel">
    <div class="calendar-focus-head">
      <div>
        <div class="calendar-eyebrow">Focus Day</div>
        <div class="calendar-focus-date">${formatShort(meta.dateStr)}</div>
        <div class="calendar-focus-sub">${meta.dateStr} · ${weekday}</div>
      </div>
      ${calendarFocusStatusHtml(meta)}
    </div>
    <div class="calendar-focus-grid">
      ${calendarFocusMetricHtml('实际专注', fmtMin(meta.stats.actualMin, true), 'actual')}
      ${calendarFocusMetricHtml('任务时长', fmtMin(meta.stats.taskMin, true), 'task')}
      ${calendarFocusMetricHtml('时段数', `${meta.sessions.length} 段`, 'count')}
      ${calendarFocusMetricHtml('任务数', `${meta.tasks.length} 项`, 'count')}
      ${calendarFocusMetricHtml('起床', meta.day.wakeTime || '-', 'wake')}
      ${calendarFocusMetricHtml('睡觉', meta.day.sleepTime || '-', 'sleep')}
    </div>
    ${meta.unclassifiedTasks.length ? `<div class="calendar-warning">
      <strong>${meta.unclassifiedTasks.length} 条未分类任务</strong>
      <span title="${escHtmlApp(unclassifiedTitle)}">活动类别为空或关联模板已不存在，建议重新选择模板或整理类别。</span>
      <button type="button" class="btn btn-danger btn-sm" onclick="calOpenUnclassified('${meta.dateStr}')">处理未分类</button>
    </div>` : ''}
    <div class="calendar-focus-actions">
      <button type="button" class="btn btn-primary" onclick="calOpenDay('${meta.dateStr}')">进入日览</button>
      <button type="button" class="btn btn-ghost" onclick="calOpenEntry('${meta.dateStr}')">去录入</button>
    </div>
  </aside>`;
}

function calendarLegendHtml(monthDates) {
  const activityPaths = new Set();
  const typeMetas = new Map();
  monthDates.forEach(dateStr => {
    (getDay(dateStr).tasks || []).forEach(task => {
      activityPaths.add(String(task.activityType || '').trim() || '未分类');
    });
    const typeMeta = dayTypeDisplayMeta(state.data[dateStr]);
    if (typeMeta.name && !typeMetas.has(typeMeta.name)) typeMetas.set(typeMeta.name, typeMeta);
  });
  const visibleActivities = [...activityPaths].sort();
  const heatItems = [
    ['heat-0', '0'],
    ['heat-1', '<2h'],
    ['heat-2', '2-4h'],
    ['heat-3', '4-6h'],
    ['heat-4', '6h+'],
  ];
  return `<div class="cal-legend">
    <div class="cal-legend-section activity-types">
      <span class="cal-legend-label">活动类型</span>
      ${visibleActivities.map(activity => {
    const color = activity === '未分类' ? getSystemSeriesColor('unclassified') : getCategoryColor(activity);
    return `<span class="cal-legend-chip"><span class="cal-dot" style="--dot-color:${color}"></span>${escHtmlApp(activity)}</span>`;
  }).join('') || '<span class="cal-legend-muted">本月暂无活动类型</span>'}
    </div>
    <div class="cal-legend-section heat-levels">
      <span class="cal-legend-label">热力</span>
      ${heatItems.map(([cls, label]) => `<span class="cal-legend-chip"><span class="cal-heat-swatch ${cls}"></span>${label}</span>`).join('')}
    </div>
    <div class="cal-legend-section day-types">
      <span class="cal-legend-label">日期类型</span>
      ${[...typeMetas.values()].map(meta => `<span class="cal-legend-chip"><span class="cal-status-swatch type" style="--day-type-color:${meta.color}">${meta.symbol}</span>${escHtmlApp(meta.name)}</span>`).join('') || '<span class="cal-legend-muted">本月暂无日期类型</span>'}
    </div>
    <div class="cal-legend-section rating-status">
      <span class="cal-legend-label">评分状态</span>
      <span class="cal-legend-chip"><span class="cal-status-swatch scored"></span>评分</span>
      <span class="cal-legend-chip"><span class="cal-status-swatch excluded"></span>不评分</span>
      <span class="cal-legend-chip"><span class="cal-status-swatch warning"></span>未分类任务</span>
    </div>
  </div>`;
}

function renderCalendar() {
  const { year, month } = state.cal;
  const days = getMonthDays(year, month);
  const todayStr = getTodayStr();
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const monthDates = calendarMonthDateStrs(year, month);
  const focusDate = calendarFocusDate(year, month, days, todayStr);
  const maxActual = Math.max(...monthDates.map(dateStr => computeDay(dateStr).actualMin), 1);
  const monthStats = calendarBuildMonthStats(monthDates);
  const dayMetas = days.map(({ dateStr, inMonth }) => calendarDayMeta(dateStr, inMonth, todayStr, focusDate, maxActual));
  const focusMeta = dayMetas.find(meta => meta.dateStr === focusDate)
    || calendarDayMeta(focusDate, true, todayStr, focusDate, maxActual);

  document.getElementById('tab-calendar').innerHTML = `
    <div class="calendar-page">
      <section class="calendar-hero">
        <div>
          <div class="calendar-eyebrow">Calendar</div>
          <h2>${year}年 ${monthNames[month]}</h2>
          <p>点击日期查看当日摘要，再进入日览或录入。</p>
        </div>
        <div class="calendar-actions">
          <button class="btn btn-ghost btn-sm" onclick="calNav(-1)">← 上月</button>
          <button class="btn btn-ghost btn-sm" onclick="calGoToday()">今天</button>
          <button class="btn btn-ghost btn-sm" onclick="jumpToLastUnrecordedDay('calendar')" title="跳转到最后一个含记录日期之后的完全空白日">定位未记录日</button>
          <button class="btn btn-ghost btn-sm" onclick="calNav(1)">下月 →</button>
        </div>
      </section>
      ${calendarSummaryHtml(monthStats)}
      <div class="calendar-layout">
        <section class="calendar-board">
          <div class="cal-grid calendar-grid-view">
            ${weekdayNames.map(w => `<div class="cal-weekday">${w}</div>`).join('')}
            ${dayMetas.map(calendarDayCellHtml).join('')}
          </div>
          <div class="calendar-list-view">
            ${dayMetas.filter(meta => meta.inMonth).map(calendarDayListHtml).join('')}
          </div>
        </section>
        ${calendarFocusPanelHtml(focusMeta)}
      </div>
      ${calendarLegendHtml(monthDates)}
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
  const todayStr = getTodayStr();
  const [year, month] = todayStr.split('-').map(Number);
  state.cal = { year, month: month - 1 };
  state.selectedDate = todayStr;
  renderCalendar();
  requestAnimationFrame(() => {
    const target = document.querySelector(`.cal-day[data-calendar-date="${todayStr}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
      inline: 'center',
    });
  });
}
async function jumpToLastUnrecordedDay(destination) {
  try {
    const result = await apiFetch('/api/navigation/last-unrecorded-day');
    if (!result.found || !result.date) {
      alert('还没有任何包含实际内容的记录日。');
      return;
    }
    if (state.tab === 'entry' && document.getElementById('taskForm')) {
      saveDraft(state.selectedDate, collectEntryDraft());
    }
    state._editingSessionId = null;
    state._editingTaskId = null;
    state.selectedDate = result.date;
    const [year, month] = result.date.split('-').map(Number);
    state.cal = { year, month: month - 1 };
    if (destination === 'entry') {
      showTab('entry');
      return;
    }
    showTab('calendar');
  } catch (error) {
    console.error('定位未记录日失败', error);
    alert('无法获取未记录日，请确认后端服务正在运行。');
  }
}
function calSelectDay(dateStr) {
  state.selectedDate = dateStr;
  renderCalendar();
}
function calOpenDay(dateStr) {
  state.selectedDate = dateStr;
  showTab('day');
}
function calOpenEntry(dateStr) {
  state.selectedDate = dateStr;
  showTab('entry');
}

function openEntryDate(dateStr) {
  if (!dateStr) return;
  state.selectedDate = dateStr;
  showTab('entry');
}

// ============================================================
// DAY OVERVIEW TAB
// ============================================================
function dayGoToday() {
  state.selectedDate = getTodayStr();
  showTab('day');
}

function renderDayOverview() {
  const dateStr = state.selectedDate;
  const s = computeDay(dateStr);
  const day = getDay(dateStr);
  const actData = Object.keys(s.actMin || {}).filter(k => s.actMin[k] > 0);
  const taskEfficiencyIndex = buildTaskEfficiencyComparisonIndex();
  const taskOutputDeviation = taskOutputDeviationForDates([dateStr], taskEfficiencyIndex);

  document.getElementById('tab-day').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--hp)">${formatDisplay(dateStr)}</div>
      <button class="btn btn-ghost btn-sm" onclick="state.selectedDate=addDays('${dateStr}',-1);showTab('day')">←</button>
      <button class="btn btn-ghost btn-sm" onclick="dayGoToday()" title="定位到今天的日览">今日</button>
      <button class="btn btn-ghost btn-sm" onclick="state.selectedDate=addDays('${dateStr}',1);showTab('day')">→</button>
      <button class="btn btn-primary btn-sm" onclick="state.selectedDate='${dateStr}';showTab('entry')">✏️ 编辑</button>
    </div>

    ${renderRangeKpiStatus([{ dateStr, ...s }], { totalDays: 1 })}

    ${day.dayNote ? `<div class="card" style="margin-bottom:16px">
      <div class="card-title" style="margin-bottom:6px">📝 今日备注</div>
      <div style="font-size:13px;color:var(--text);line-height:1.8;white-space:pre-wrap">${escHtmlApp(day.dayNote)}</div>
    </div>` : ''}

    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-title">三维时间对比</div>
        <div class="chart-sub">时钟 / 有效时钟 / 名义 / 实际 对比（${durationDisplayUnitLabel()}）</div>
        <canvas id="dayThreeChart" height="180"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">类别时间分布</div>
        <div class="chart-sub">任务时长按类别</div>
        <canvas id="dayCatChart" height="180"></canvas>
      </div>
      <div class="chart-card full">
        <div class="chart-title">当日汇总表</div>
        <div class="chart-sub">点击日期进入当天录入界面</div>
        <div class="table-wrap"><table><thead><tr><th>日期</th><th>起床</th><th>睡觉</th><th class="c-clock">时钟</th><th class="c-clock">有效</th><th>休息</th><th class="c-nominal">名义</th><th class="c-actual">实际</th><th>计划偏差</th><th>效率</th><th title="按各任务历史平均效率计算当天实际产出高于或低于应完成量的比例">任务产出偏差</th><th>不可用占比</th></tr></thead>
          <tbody><tr class="range-summary-clickable" onclick="openEntryDate('${dateStr}')"><td class="fw-mono c-hp">${formatShort(dateStr)}${dayTypeName(day) ? `<br>${dayTypeBadgeHtml(day)}` : ''}</td><td class="fw-mono c-wake">${day.wakeTime || '-'}</td><td class="fw-mono c-sleep">${day.sleepTime || '-'}</td><td class="fw-mono c-clock">${fmtMin(s.clockMin, true)}</td><td class="fw-mono c-clock">${fmtMin(s.effectiveClockMin, true)}</td><td class="fw-mono">${fmtMin(s.restMin, true)}</td><td class="fw-mono c-nominal">${fmtMin(s.nominalMin, true)}</td><td class="fw-mono c-actual">${fmtMin(s.actualMin, true)}</td><td class="fw-mono ${devClass(s.actualVsNominal)}">${devStr(s.actualVsNominal)}</td><td class="fw-mono c-actual">${s.focusEfficiency != null ? `${s.focusEfficiency}%` : '-'}</td><td class="fw-mono">${taskOutputDeviationHtml(taskOutputDeviation)}</td><td class="fw-mono c-muted">${s.utilPct != null ? `${s.utilPct}%` : '-'}</td></tr></tbody>
        </table></div>
      </div>
      ${s.sessions.length > 0 ? `
      <div class="chart-card full">
        <div class="chart-title">专注时段明细</div>
        <div class="chart-sub">时钟 · 名义 · 实际 · 休息 · 分心 · 专注率</div>
        <div class="table-wrap">
          <table data-sort-table="day-sessions">
            <thead><tr>
              <th>#</th>${sortableTableHeaderHtml('day-sessions', 'start', '开始', 'time')}${sortableTableHeaderHtml('day-sessions', 'end', '结束', 'time')}
              ${sortableTableHeaderHtml('day-sessions', 'clock', '时钟', 'number', 'c-clock')}${sortableTableHeaderHtml('day-sessions', 'nominal', '名义', 'number', 'c-nominal')}${sortableTableHeaderHtml('day-sessions', 'actual', '实际', 'number', 'c-actual')}
              ${sortableTableHeaderHtml('day-sessions', 'rest', `休息${tipIcon('rest')}`)}${sortableTableHeaderHtml('day-sessions', 'distract', `分心${tipIcon('distract')}`)}
              ${sortableTableHeaderHtml('day-sessions', 'efficiency', '专注率')}<th>操作</th>
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
    return `<tr ${sortableTableRowAttrs({
      start: parseMin(sess.startTime), end: parseMin(sess.endTime), clock: cl,
      nominal: Number(sess.nominalMinutes) || 0, actual, rest: isSpec || isSpecialStudy ? null : rest,
      distract: isSpec || isSpecialStudy ? null : distract, efficiency: eff,
    }, i)}${typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}>
                  <td class="fw-mono c-muted">${i + 1}${typeMeta.short ? `<br><span style="font-size:9px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 4px;border-radius:3px">${typeMeta.short}</span>` : ''}</td>
                  <td class="fw-mono">${sess.type !== 'normal' && sess.name ? `<span style="color:${typeMeta.color};font-weight:600">${escHtmlApp(sess.name)}</span><br>` : ''}<button type="button" class="range-record-link" onclick="dayEditSession('${dateStr}','${sess.id}')">${sess.startTime || '-'}</button></td><td class="fw-mono">${sess.endTime || '-'}</td>
                  <td class="fw-mono c-clock">${fmtMin(cl, true)}</td>
                  <td class="fw-mono c-nominal">${fmtMin(Number(sess.nominalMinutes) || 0, true)}</td>
                  <td class="fw-mono c-actual">${fmtMin(actual, true)}</td>
                  <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(rest, true)}</td>
                  <td class="fw-mono">${isSpec || isSpecialStudy ? '-' : fmtMin(distract, true)}</td>
                  <td class="fw-mono c-actual">${eff != null ? eff + '%' : '-'}</td>
                  <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="dayEditSession('${dateStr}','${sess.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="dayDeleteSession('${dateStr}','${sess.id}')">删除</button></td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : '<div class="chart-card full"><div class="chart-title">专注时段明细</div><div class="chart-sub">点击记录可进入时段编辑</div><div class="empty-state"><p>当天暂无专注时段</p></div></div>'}
      ${s.tasks.length > 0 ? `
      <div class="chart-card full">
        <div class="chart-title">任务明细</div>
        <div class="chart-sub">类别 · 时长 · 数量 · 效率 · 共 ${s.tasks.length} 条</div>
        ${taskFilterHtml('day', s.tasks)}
        <div class="table-wrap">
          <table data-sort-table="day-tasks">
            <thead><tr>
              <th>任务</th><th>活动类型</th>
              ${sortableTableHeaderHtml('day-tasks', 'minutes', '时长')}${sortableTableHeaderHtml('day-tasks', 'quantity', '数量')}${sortableTableHeaderHtml('day-tasks', 'efficiency', '效率')}${sortableTableHeaderHtml('day-tasks', 'efficiencyDelta', '较平均效率')}${sortableTableHeaderHtml('day-tasks', 'accuracy', '正确率')}<th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${filterTasksByView(s.tasks, 'day').map((t, rowIndex) => {
    const actColor = getActColor(t.activityType);
    const visibleQty = visibleTaskQuantity(t);
    const visibleUnit = visibleTaskQuantityUnit(t);
    const efficiencyComparison = taskEfficiencyComparisonFor(taskEfficiencyIndex, t, dateStr);
    const efficiencyRate = taskEfficiencyRateText(t, efficiencyComparison);
    return `<tr ${sortableTableRowAttrs({
      minutes: Number(t.minutes) || 0,
      quantity: visibleQty > 0 ? visibleQty : null,
      efficiency: taskEfficiencySortValue(t, efficiencyComparison),
      efficiencyDelta: efficiencyComparison?.deltaPct,
      accuracy: visibleTaskAccuracy(t),
    }, rowIndex)}>
                  <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><button type="button" class="range-record-link" onclick="monthEditTask('${dateStr}','${t.id}')">${escHtmlApp(t.name)}</button></td>
                  <td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${t.activityType || '-'}</span></td>
                  <td class="fw-mono">${fmtMin(Number(t.minutes) || 0, true)}</td>
                  <td class="fw-mono">${visibleQty ? (visibleQty + (visibleUnit ? ' ' + visibleUnit : '')) : '-'}</td>
                  <td class="fw-mono">${escHtmlApp(efficiencyRate)}</td>
                  <td class="fw-mono">${taskEfficiencyDeltaHtml(efficiencyComparison)}</td>
                  <td class="fw-mono c-text">${visibleTaskAccuracy(t) == null ? '-' : `${visibleTaskAccuracy(t)}%`}</td>
                  <td class="c-muted" style="font-size:11px">${t.note || ''}</td>
                  <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="monthEditTask('${dateStr}','${t.id}')" style="margin-right:4px">编辑</button><button class="btn btn-danger btn-sm" onclick="dayDeleteTask('${dateStr}','${t.id}')">删除</button></td>
                </tr>`;
  }).join('')}
            </tbody>
            <tfoot><tr><td colspan="2">合计</td><td class="fw-mono">${fmtMin(filterTasksByView(s.tasks, 'day').reduce((a, t) => a + (Number(t.minutes) || 0), 0), true)}</td><td colspan="6"></td></tr></tfoot>
          </table>
        </div>
      </div>` : '<div class="chart-card full"><div class="chart-title">任务记录</div><div class="chart-sub">点击任务可进入任务编辑</div><div class="empty-state"><p>当天暂无任务记录</p></div></div>'}
    </div>
  `;

  mkChart('dayThreeChart', {
    type: 'bar',
    data: {
      labels: ['时钟时长', '有效时钟', '名义时长', '实际专注'],
      datasets: [{
        data: [s.clockMin, s.effectiveClockMin, s.nominalMin, s.actualMin],
        backgroundColor: [
          hexRgba(getChartSeriesColor('clock'), .15),
          hexRgba(getChartSeriesColor('effectiveClock'), .3),
          hexRgba(getChartSeriesColor('nominal'), .3),
          hexRgba(getChartSeriesColor('actual'), .3),
        ],
        borderColor: [
          getChartSeriesColor('clock'),
          getChartSeriesColor('effectiveClock'),
          getChartSeriesColor('nominal'),
          getChartSeriesColor('actual'),
        ], borderWidth: 2, borderRadius: 4
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
      data: { labels: actData, datasets: [{ data: actData.map(k => s.actMin[k]), backgroundColor: actData.map(k => getActColor(k).color), borderColor: actData.map(k => getActColor(k).color), borderWidth: 1 }] },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)}` } } } }
    });
  }
}

// ============================================================
// OVERALL OVERVIEW TAB
// ============================================================
function overviewCalendarDates(start, end) {
  if (!start || !end || start > end) return [];
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function overviewDailyBuckets(dates, recordedDateSet) {
  return dates.map(date => {
    const totals = computeRange([date]).totals;
    const recorded = recordedDateSet.has(date);
    const excluded = recorded && Boolean(state.data[date]?.excludeFromRating);
    return {
      key: date,
      label: formatShort(date),
      totals,
      recorded,
      excluded,
    };
  });
}

function overviewOpenDay(date) {
  state.selectedDate = date;
  showTab('day');
}

function overviewTaskRecordsHtml(tasks) {
  const totalMinutes = tasks.reduce((sum, task) => sum + (Number(task.minutes) || 0), 0);
  const taskEfficiencyIndex = buildTaskEfficiencyComparisonIndex();
  return `<div class="card entry-table-card range-record-table-card">
    <div class="card-header"><div><div class="card-title">任务记录</div><div class="card-sub">共 ${tasks.length} 条 · ${fmtMin(totalMinutes, true)} · 点击任务进入编辑</div></div></div>
    ${tasks.length ? `<div class="table-wrap" style="max-height:520px"><table data-sort-table="overview-tasks"><thead><tr>${sortableTableHeaderHtml('overview-tasks', 'date', '日期', 'date')}<th>任务名称</th><th>活动类型</th>${sortableTableHeaderHtml('overview-tasks', 'minutes', '时长')}${sortableTableHeaderHtml('overview-tasks', 'quantity', '数量')}${sortableTableHeaderHtml('overview-tasks', 'efficiency', '效率')}${sortableTableHeaderHtml('overview-tasks', 'efficiencyDelta', '较平均效率')}${sortableTableHeaderHtml('overview-tasks', 'accuracy', '正确率')}<th>备注</th><th>操作</th></tr></thead>
      <tbody>${tasks.map((task, rowIndex) => {
    const visibleQty = visibleTaskQuantity(task);
    const visibleUnit = visibleTaskQuantityUnit(task);
    const efficiencyComparison = taskEfficiencyComparisonFor(taskEfficiencyIndex, task, task._date);
    const efficiencyRate = taskEfficiencyRateText(task, efficiencyComparison);
    const actColor = getActColor(task.activityType);
    return `<tr ${sortableTableRowAttrs({
      date: task._date, minutes: Number(task.minutes) || 0,
      quantity: visibleQty > 0 ? visibleQty : null, efficiency: taskEfficiencySortValue(task, efficiencyComparison), efficiencyDelta: efficiencyComparison?.deltaPct,
      accuracy: visibleTaskAccuracy(task),
    }, rowIndex)}><td class="fw-mono c-hp" onclick="openEntryDate('${task._date}')" style="cursor:pointer;white-space:nowrap">${formatShort(task._date)}</td><td><button type="button" class="range-record-link" onclick="monthEditTask('${task._date}','${task.id}')">${escHtmlApp(task.name || '未命名任务')}</button></td><td><span class="badge" style="background:${actColor.color}22;color:${actColor.color};border:1px solid ${actColor.color}44">${escHtmlApp(task.activityType || '-')}</span></td><td class="fw-mono">${fmtMin(Number(task.minutes) || 0, true)}</td><td class="fw-mono">${visibleQty ? `${visibleQty}${visibleUnit ? ` ${escHtmlApp(visibleUnit)}` : ''}` : '-'}</td><td class="fw-mono">${escHtmlApp(efficiencyRate)}</td><td class="fw-mono">${taskEfficiencyDeltaHtml(efficiencyComparison)}</td><td class="fw-mono">${visibleTaskAccuracy(task) == null ? '-' : `${visibleTaskAccuracy(task)}%`}</td><td class="c-muted">${escHtmlApp(task.note || '')}</td><td><button type="button" class="btn btn-ghost btn-sm" onclick="monthEditTask('${task._date}','${task.id}')">编辑</button></td></tr>`;
  }).join('')}</tbody><tfoot><tr><td colspan="3">合计</td><td class="fw-mono">${fmtMin(totalMinutes, true)}</td><td colspan="6"></td></tr></tfoot></table></div>` : '<div class="empty-state"><p>当前范围暂无任务记录</p></div>'}
  </div>`;
}

function overviewSessionRecordsHtml(sessions) {
  const totalClock = sessions.reduce((sum, session) => sum + sessionClock(session), 0);
  const totalActual = sessions.filter(session => !isUnavailableSession(session)).reduce((sum, session) => sum + (Number(session.actualMinutes) || 0), 0);
  return `<div class="card entry-table-card range-record-table-card">
    <div class="card-header"><div><div class="card-title">专注时段</div><div class="card-sub">共 ${sessions.length} 段 · 时钟 ${fmtMin(totalClock, true)} · 实际 ${fmtMin(totalActual, true)} · 点击时段进入编辑</div></div></div>
    ${sessions.length ? `<div class="table-wrap" style="max-height:520px"><table data-sort-table="overview-sessions"><thead><tr>${sortableTableHeaderHtml('overview-sessions', 'date', '日期', 'date')}<th>类型</th>${sortableTableHeaderHtml('overview-sessions', 'start', '开始', 'time')}${sortableTableHeaderHtml('overview-sessions', 'end', '结束', 'time')}${sortableTableHeaderHtml('overview-sessions', 'clock', '时钟', 'number', 'c-clock')}${sortableTableHeaderHtml('overview-sessions', 'nominal', '名义', 'number', 'c-nominal')}${sortableTableHeaderHtml('overview-sessions', 'actual', '实际', 'number', 'c-actual')}${sortableTableHeaderHtml('overview-sessions', 'rest', '休息')}${sortableTableHeaderHtml('overview-sessions', 'efficiency', '效率')}<th>备注</th><th>操作</th></tr></thead>
      <tbody>${sessions.map((session, rowIndex) => {
    const clock = sessionClock(session);
    const unavailable = isUnavailableSession(session);
    const specialStudy = isSpecialStudySession(session);
    const typeMeta = sessionTypeMeta(session);
    const actual = Number(session.actualMinutes) || 0;
    const rest = Number(session.restMinutes) || 0;
    const efficiency = !unavailable && !specialStudy && clock - rest > 0 ? Math.round(actual / (clock - rest) * 100) : null;
    return `<tr ${sortableTableRowAttrs({
      date: session._date, start: parseMin(session.startTime), end: parseMin(session.endTime), clock,
      nominal: unavailable || specialStudy ? null : Number(session.nominalMinutes) || 0,
      actual: unavailable ? null : actual, rest: unavailable || specialStudy ? null : rest, efficiency,
    }, rowIndex)}${typeMeta.bg ? ` style="background:${typeMeta.bg}"` : ''}><td class="fw-mono c-hp" onclick="openEntryDate('${session._date}')" style="cursor:pointer;white-space:nowrap">${formatShort(session._date)}</td><td>${unavailable || specialStudy ? `<span style="font-size:10px;background:${typeMeta.color}22;color:${typeMeta.color};padding:1px 6px;border-radius:3px">${escHtmlApp(typeMeta.label)}</span>` : '普通'}</td><td class="fw-mono"><button type="button" class="range-record-link" onclick="monthEditSession('${session._date}','${session.id}')">${session.startTime || '-'}</button></td><td class="fw-mono">${session.endTime || '-'}</td><td class="fw-mono c-clock">${fmtMin(clock, true)}</td><td class="fw-mono c-nominal">${unavailable || specialStudy ? '-' : fmtMin(Number(session.nominalMinutes) || 0, true)}</td><td class="fw-mono c-actual">${unavailable ? '-' : fmtMin(actual, true)}</td><td class="fw-mono">${unavailable || specialStudy ? '-' : fmtMin(rest, true)}</td><td class="fw-mono c-actual">${efficiency == null ? '-' : `${efficiency}%`}</td><td class="c-muted">${escHtmlApp(session.note || '')}</td><td><button type="button" class="btn btn-ghost btn-sm" onclick="monthEditSession('${session._date}','${session.id}')">编辑</button></td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="empty-state"><p>当前范围暂无专注时段</p></div>'}
  </div>`;
}

function renderOverallOverview(panelKey = '') {
  const host = document.getElementById('tab-overview');
  if (!host) return;
  const overviewPanelKeys = {
    time: 'overview-time',
    task: 'overview-task',
    actual: 'overview-actual',
  };
  let scopedPanel = Boolean(overviewPanelKeys[panelKey] && host.querySelector(`[data-render-panel="${overviewPanelKeys[panelKey]}"]`));
  const overviewChartIds = {
    time: 'overviewTrendChart',
    task: 'overviewTaskChart',
    actual: 'overviewActualDeviationChart',
  };
  if (scopedPanel) destroyChart(overviewChartIds[panelKey]);
  else ['overviewTrendChart', 'overviewCategoryChart', 'overviewTaskChart', 'overviewActualDeviationChart'].forEach(destroyChart);

  const sharedRange = analysisRangeMeta('overview');
  const allStoredDates = getAllChartRecordDates();
  const baseDates = sharedRange.baseDates;
  const rangeContext = sharedRange.context;
  const dates = rangeContext.analysisDates;
  const filterHtml = `<div class="overview-unified-head"><div><div class="card-title">🌐 总览</div><div class="overview-range-meta">周、月及跨周期统计统一入口 · 点击汇总表可进入当天录入</div></div></div>${analysisRangePlannerHtml('overview', sharedRange)}`;

  const storedDateSet = new Set(allStoredDates);
  const recordedDates = dates.filter(date => storedDateSet.has(date));
  const displayRecordedDates = rangeContext.displayDates.filter(date => storedDateSet.has(date));
  if (!baseDates.length || !displayRecordedDates.length || (rangeContext.filtered && !recordedDates.length)) {
    if (scopedPanel) {
      ['overviewTrendChart', 'overviewCategoryChart', 'overviewTaskChart', 'overviewActualDeviationChart'].forEach(destroyChart);
      scopedPanel = false;
    }
    host.innerHTML = `${filterHtml}
      <div class="day-type-filter-empty"><b>${rangeContext.filtered ? `当前范围没有“${escHtmlApp(rangeContext.selectedType)}”记录` : '当前范围内暂无有效记录'}</b><span>可以调整日期范围或日期类型筛选。</span></div>`;
    return;
  }

  const { totals } = computeRange(dates);
  const taskEfficiencyIndex = buildTaskEfficiencyComparisonIndex();
  const summaryTaskOutputDeviation = taskOutputDeviationForDates(dates, taskEfficiencyIndex);
  const excludedCount = rangeContext.includeExcluded
    ? recordedDates.filter(date => state.data[date]?.excludeFromRating).length
    : rangeContext.shellDates.filter(date => storedDateSet.has(date)).length;
  const buckets = overviewDailyBuckets(dates, storedDateSet).map(bucket => ({ ...bucket, _dayTypeFilterActive: rangeContext.includeExcluded }));
  const recordedBuckets = buckets.filter(bucket => bucket.recorded);
  const shellSet = new Set(rangeContext.shellDates);
  const displayBuckets = overviewDailyBuckets(rangeContext.displayDates, storedDateSet)
    .filter(bucket => bucket.recorded)
    .map(bucket => ({ ...bucket, _shell: shellSet.has(bucket.key), _dayTypeFilterActive: rangeContext.includeExcluded }));
  const categoryMinutes = {};
  dates.forEach(date => {
    const day = computeDay(date);
    Object.entries(day.actMin || {}).forEach(([category, minutes]) => {
      categoryMinutes[category] = (categoryMinutes[category] || 0) + minutes;
    });
  });
  const categoryKeys = Object.keys(categoryMinutes)
    .filter(category => categoryMinutes[category] > 0)
    .sort((a, b) => categoryMinutes[b] - categoryMinutes[a]);
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const summaryEfficiency = totals.focusEfficiency;
  const summaryDeviation = totals.actualVsNominal;
  const averageActual = totals.avgActual;
  const overviewTasks = [];
  const overviewSessions = [];
  dates.forEach(dateStr => {
    const day = getDay(dateStr);
    (day.tasks || []).forEach(task => overviewTasks.push({ ...task, _date: dateStr }));
    sortSessionsByStart(day.sessions || []).forEach(session => overviewSessions.push({ ...session, _date: dateStr }));
  });
  const overviewTaskDeviationPoints = buckets.map(bucket => {
    const summary = taskOutputDeviationForDates([bucket.key], taskEfficiencyIndex);
    const value = summary && Number.isFinite(summary.deltaPct) ? summary.deltaPct : null;
    return { bucket, dateStr: bucket.key, label: bucket.label, value, summary };
  }).filter(point => point.bucket.recorded && Number.isFinite(point.value));
  const actualDeviationPoints = buckets.map(bucket => {
    const average = actualFocusAverageBeforeDate(bucket.key);
    const value = actualFocusDeviationPct(bucket.totals.actualMin, average);
    return { bucket, dateStr: bucket.key, label: bucket.label, value, average };
  }).filter(point => point.bucket.recorded && Number.isFinite(point.value));

  const overviewHtml = `${filterHtml}
    ${renderRangeKpiStatus(computeRange(dates).days, { totalDays: rangeContext.filtered ? dates.length : baseDates.length, className: 'overview-kpi-grid', excludedShellCount: rangeContext.shellDates.length, dayTypeFilterName: rangeContext.selectedType, includeAllDayTypes: rangeContext.complete })}

    <div class="chart-grid overview-chart-grid">
      <div class="chart-card full three-dim-chart-card" data-render-panel="overview-time">
        <div class="range-chart-head"><div><div class="chart-title">三维时间趋势</div><div class="chart-sub">${rangeChartView('overview', 'time') === 'daily' ? '时钟 / 有效时钟 / 名义 / 实际 · 日期类型使用模板符号' : '截至当天各项正值记录的累计平均时长'}</div></div>${rangeChartViewTabsHtml('overview', 'time')}</div>
        <canvas id="overviewTrendChart" height="90"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">任务类别累计占比</div>
        <div class="chart-sub">按任务记录时长汇总</div>
        ${categoryKeys.length
      ? '<canvas id="overviewCategoryChart" height="210"></canvas>'
      : '<div class="empty-state"><p>当前范围内暂无任务类别数据。</p></div>'}
      </div>
      <div class="chart-card" data-render-panel="overview-task">
        <div class="range-chart-head"><div><div class="chart-title">任务产出偏差</div><div class="chart-sub">${rangeChartView('overview', 'task') === 'daily' ? '按对应日期之前的历史效率换算每日产出偏差 · 点击数据点进入日览' : '截至当天已有产出偏差样本的累计平均 · 点击数据点进入日览'}</div></div>${rangeChartViewTabsHtml('overview', 'task')}</div>
        ${overviewTaskDeviationPoints.length ? '<canvas id="overviewTaskChart" height="210"></canvas>' : '<div class="empty-state"><p>当前统计日期内暂无可计算的任务产出偏差样本。</p></div>'}
      </div>
      <div class="chart-card" data-render-panel="overview-actual">
        <div class="range-chart-head"><div><div class="chart-title">实际偏日均</div><div class="chart-sub">${rangeChartView('overview', 'actual') === 'daily' ? '每天实际专注与该日期之前实际专注日均比较 · 点击数据点进入日览' : '截至当天已有实际偏日均样本的累计平均 · 点击数据点进入日览'}</div></div>${rangeChartViewTabsHtml('overview', 'actual')}</div>
        ${actualDeviationPoints.length ? '<canvas id="overviewActualDeviationChart" height="210"></canvas>' : '<div class="empty-state"><p>当前统计日期内暂无可计算的实际偏日均样本。</p></div>'}
      </div>
      <div class="chart-card full">
        <div class="chart-title">每日汇总表</div>
        <div class="chart-sub">只列有记录日期 · 点击行进入录入界面 · 汇总状态表示是否计入顶部范围 KPI</div>
        <div class="table-wrap overview-table-wrap">
          <table data-sort-table="overview-summary">
            <thead><tr>
              ${sortableTableHeaderHtml('overview-summary', 'date', '日期', 'date')}
              ${sortableTableHeaderHtml('overview-summary', 'clock', '时钟', 'number', 'c-clock')}${sortableTableHeaderHtml('overview-summary', 'effective', '有效', 'number', 'c-clock')}
              ${sortableTableHeaderHtml('overview-summary', 'nominal', '名义', 'number', 'c-nominal')}${sortableTableHeaderHtml('overview-summary', 'actual', '实际', 'number', 'c-actual')}${sortableTableHeaderHtml('overview-summary', 'actualDeviation', '实际偏日均')}
              ${sortableTableHeaderHtml('overview-summary', 'task', '任务时长')}${sortableTableHeaderHtml('overview-summary', 'efficiency', '专注效率')}${sortableTableHeaderHtml('overview-summary', 'taskOutputDeviation', '任务产出偏差')}${sortableTableHeaderHtml('overview-summary', 'deviation', '计划偏差')}<th>汇总状态</th>
            </tr></thead>
            <tbody>
              ${[...displayBuckets].reverse().map((bucket, rowIndex) => {
        if (bucket._shell) return dayTypeShellRowHtml({ ...(state.data[bucket.key] || {}), dateStr: bucket.key }, 11, rangeContext.filtered, { date: bucket.key }, rowIndex);
        const efficiency = bucket.totals.focusEfficiency;
        const deviation = bucket.totals.actualVsNominal;
        const averageActualBeforeDate = actualFocusAverageBeforeDate(bucket.key);
        const actualDeviation = actualFocusDeviationPct(bucket.totals.actualMin, averageActualBeforeDate);
        const taskOutputDeviation = taskOutputDeviationForDates([bucket.key], taskEfficiencyIndex);
        const dayObj = state.data[bucket.key] || {};
        return `<tr class="overview-summary-row range-summary-clickable" ${sortableTableRowAttrs({
          date: bucket.key, clock: bucket.totals.clockMin, effective: bucket.totals.effectiveClockMin,
          nominal: bucket.totals.nominalMin, actual: bucket.totals.actualMin, actualDeviation, task: bucket.totals.taskMin,
          efficiency, taskOutputDeviation: taskOutputDeviation?.deltaPct, deviation,
        }, rowIndex)}
                  onclick="openEntryDate('${bucket.key}')">
                  <td class="fw-mono" style="color:var(--hp)">${escHtmlApp(bucket.label)}${dayTypeName(dayObj) ? `<br>${dayTypeBadgeHtml(dayObj)}` : ''}</td>
                  <td class="fw-mono c-clock">${fmtMin(bucket.totals.clockMin, true)}</td>
                  <td class="fw-mono c-clock">${fmtMin(bucket.totals.effectiveClockMin, true)}</td>
                  <td class="fw-mono c-nominal">${fmtMin(bucket.totals.nominalMin, true)}</td>
                  <td class="fw-mono c-actual">${fmtMin(bucket.totals.actualMin, true)}</td>
                  <td class="fw-mono">${actualFocusDeviationBoxHtml(actualDeviation, averageActualBeforeDate)}</td>
                  <td class="fw-mono">${fmtMin(bucket.totals.taskMin, true)}</td>
                  <td class="fw-mono c-actual">${efficiency != null ? `${efficiency}%` : '-'}</td>
                  <td class="fw-mono">${taskOutputDeviationHtml(taskOutputDeviation)}</td>
                  <td class="fw-mono ${devClass(deviation)}">${devStr(deviation)}</td>
                  <td class="fw-mono ${bucket.excluded ? 'c-muted' : 'c-text'}">${bucket.excluded ? '筛选纳入（不评分）' : '计入'}</td>
                </tr>`;
      }).join('')}
            </tbody>
            <tfoot><tr>
              <td>范围合计（${recordedDates.length}天）</td>
              <td class="c-clock">${fmtMin(totals.clockMin, true)}</td>
              <td class="c-clock">${fmtMin(totals.effectiveClockMin, true)}</td>
              <td class="c-nominal">${fmtMin(totals.nominalMin, true)}</td>
              <td class="c-actual">${fmtMin(totals.actualMin, true)}</td>
              <td><span class="actual-focus-deviation-box c-muted" title="当前筛选范围的实际专注日均基准">日均 ${fmtMin(averageActual, true)}</span></td>
              <td>${fmtMin(totals.taskMin, true)}</td>
              <td class="c-actual">${summaryEfficiency != null ? `${summaryEfficiency}%` : '-'}</td>
              <td>${taskOutputDeviationHtml(summaryTaskOutputDeviation)}</td>
              <td class="${devClass(summaryDeviation)}">${devStr(summaryDeviation)}</td>
              <td>${excludedCount || '-'}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
    ${overviewSessionRecordsHtml(overviewSessions)}
    ${overviewTaskRecordsHtml(overviewTasks)}`;

  if (scopedPanel && !replaceRenderPanels(host, overviewHtml, overviewPanelKeys[panelKey])) scopedPanel = false;
  if (!scopedPanel) host.innerHTML = overviewHtml;

  const labels = buckets.map(bucket => bucket.label);
  if (!scopedPanel || panelKey === 'time') {
    renderThreeDimTrendChart(
      'overviewTrendChart',
      buckets.map(bucket => ({ dateStr: bucket.key, label: bucket.label, _dayTypeFilterActive: bucket._dayTypeFilterActive, ...bucket.totals })),
      item => item.label,
      'overview'
    );
  }

  if (!scopedPanel && categoryKeys.length) {
    mkChart('overviewCategoryChart', {
      type: 'doughnut',
      data: {
        labels: categoryKeys,
        datasets: [{
          data: categoryKeys.map(category => categoryMinutes[category]),
          backgroundColor: categoryKeys.map(category => getActColor(category).color),
          borderColor: categoryKeys.map(category => getActColor(category).color),
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right', labels: { color: '#6b7a9e', boxWidth: 10, padding: 8 } },
          tooltip: { callbacks: { label: context => `${context.label}: ${fmtMin(context.raw, true)}` } },
        },
      },
    });
  }

  if ((!scopedPanel || panelKey === 'task') && overviewTaskDeviationPoints.length) {
    const overviewTaskDates = overviewTaskDeviationPoints.map(point => point.dateStr);
    const overviewTaskDeviationValues = overviewTaskDeviationPoints.map(point => point.value);
    const taskDeviationColor = getChartSeriesColor('taskDuration');
    mkChart('overviewTaskChart', {
      type: 'line',
      data: {
        labels: overviewTaskDeviationPoints.map(point => point.label),
        datasets: [{
          label: rangeChartView('overview', 'task') === 'cumulativeAverage' ? '累计平均任务产出偏差' : '任务产出偏差',
          data: rangeChartView('overview', 'task') === 'cumulativeAverage'
            ? cumulativeFiniteAverage(overviewTaskDeviationValues, overviewTaskDates)
            : overviewTaskDeviationValues,
          backgroundColor: hexRgba(taskDeviationColor, .18),
          borderColor: taskDeviationColor,
          pointBackgroundColor: taskDeviationColor,
          borderWidth: 2,
          pointRadius: overviewTaskDeviationPoints.length > 30 ? 1.5 : 3,
          pointHoverRadius: 5,
          tension: .3,
          fill: true,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        onClick: (_event, elements) => {
          const point = overviewTaskDeviationPoints[elements[0]?.index];
          if (point?.bucket?.recorded) overviewOpenDay(point.bucket.key);
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: contexts => {
              const bucket = overviewTaskDeviationPoints[contexts[0]?.dataIndex]?.bucket;
              if (!bucket) return '';
              const meta = dayTypeDisplayMeta(state.data[bucket.key]);
              return meta.name ? `${bucket.label} · ${meta.symbol} ${meta.name}` : bucket.label;
            },
            label: context => {
              const value = Number(context.raw);
              if (!Number.isFinite(value)) return null;
              return `任务产出偏差：${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
            },
          } },
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', autoSkip: true, maxTicksLimit: 18, maxRotation: 35 }, grid: { display: false } },
          y: { ticks: { color: '#6b7a9e', callback: value => `${value}%` }, grid: gridCfg, title: { display: true, text: '任务产出偏差（%）', color: '#6b7a9e' } },
        },
      },
      plugins: [noRecordRegionPlugin(overviewTaskDates)],
    });

  }

  if ((!scopedPanel || panelKey === 'actual') && actualDeviationPoints.length) {
    const actualDeviationDates = actualDeviationPoints.map(point => point.dateStr);
    const actualDeviationValues = actualDeviationPoints.map(point => point.value);
    const actualDeviationColor = getChartSeriesColor('actual');
    mkChart('overviewActualDeviationChart', {
      type: 'line',
      data: {
        labels: actualDeviationPoints.map(point => point.label),
        datasets: [{
          label: rangeChartView('overview', 'actual') === 'cumulativeAverage' ? '累计平均实际偏日均' : '实际偏日均',
          data: rangeChartView('overview', 'actual') === 'cumulativeAverage'
            ? cumulativeFiniteAverage(actualDeviationValues, actualDeviationDates)
            : actualDeviationValues,
          backgroundColor: hexRgba(actualDeviationColor, .16),
          borderColor: actualDeviationColor,
          pointBackgroundColor: actualDeviationColor,
          borderWidth: 2,
          pointRadius: actualDeviationPoints.length > 30 ? 1.5 : 3,
          pointHoverRadius: 5,
          tension: .3,
          fill: true,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        onClick: (_event, elements) => {
          const point = actualDeviationPoints[elements[0]?.index];
          if (point?.bucket?.recorded) overviewOpenDay(point.bucket.key);
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: contexts => {
              const bucket = actualDeviationPoints[contexts[0]?.dataIndex]?.bucket;
              if (!bucket) return '';
              const meta = dayTypeDisplayMeta(state.data[bucket.key]);
              return meta.name ? `${bucket.label} · ${meta.symbol} ${meta.name}` : bucket.label;
            },
            label: context => {
              const value = Number(context.raw);
              if (!Number.isFinite(value)) return null;
              const average = actualDeviationPoints[context.dataIndex]?.average;
              return `实际偏日均：${value >= 0 ? '+' : ''}${value.toFixed(1)}%（此前日均 ${fmtMin(Math.round(Number(average) || 0), true)}）`;
            },
          } },
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', autoSkip: true, maxTicksLimit: 18, maxRotation: 35 }, grid: { display: false } },
          y: { ticks: { color: '#6b7a9e', callback: value => `${value}%` }, grid: gridCfg, title: { display: true, text: '实际偏日均（%）', color: '#6b7a9e' } },
        },
      },
      plugins: [noRecordRegionPlugin(actualDeviationDates)],
    });
  }

}

function monthEditTask(dateStr, taskId) {
  state.selectedDate = dateStr;
  state._editingTaskId = taskId;
  showTab('entry');
  // editTask will be triggered after render
  setTimeout(() => editTask(dateStr, taskId), 100);
}

// ============================================================
// SLEEP TAB
// ============================================================
function sleepRangeMeta() {
  const shared = analysisRangeMeta('sleep');
  const allDates = analysisRangeRecordDates('sleep');
  const relevantSet = new Set(allDates);
  const dates = shared.analysisDates.filter(date => relevantSet.has(date));
  return {
    ...shared,
    dates,
    allDates,
    dayTypeContext: shared.context,
    firstRecord: allDates[0] || getTodayStr(),
    lastRecord: allDates[allDates.length - 1] || getTodayStr(),
  };
}

function sleepNormalizedBedtimeMinute(value) {
  if (value == null) return null;
  let adjusted = Number(value);
  // 兼容旧录入：12:00-12:59 曾被作息页按次日 00:00-00:59 解释。
  if (adjusted >= 12 * 60 && adjusted < 13 * 60) adjusted -= 12 * 60;
  return adjusted < 12 * 60 ? adjusted + 1440 : adjusted;
}

function sleepBuildDays(dates) {
  return (dates || []).map(dateStr => {
    const day = state.data[dateStr] || {};
    const wakeMin = parseMin(day.wakeTime);
    const sleepMin = parseMin(day.sleepTime);
    let awakeMin = null;
    if (wakeMin != null && sleepMin != null) {
      awakeMin = sleepNormalizedBedtimeMinute(sleepMin) - wakeMin;
      if (awakeMin <= 0) awakeMin += 1440;
    }
    const stats = computeDay(dateStr);
    return {
      dateStr,
      wakeTime: day.wakeTime || '',
      sleepTime: day.sleepTime || '',
      wakeNote: String(day.wakeNote || ''),
      sleepNote: String(day.sleepNote || ''),
      wakeMin,
      sleepMin,
      awakeMin,
      actualMin: stats.actualMin,
      unavailableMin: stats.unavailableMin,
      utilPct: stats.utilPct,
      dayType: day.dayType || '',
      excludeFromRating: Boolean(day.dayType && day.excludeFromRating),
    };
  });
}

function sleepBuildCycles(dates, preserveDateAxis = false) {
  const cycles = new Map();
  const ensure = wakeDate => {
    if (!cycles.has(wakeDate)) {
      cycles.set(wakeDate, { wakeDate, sleepDate: addDays(wakeDate, -1), wakeTime: '', sleepTime: '', wakeMin: null, sleepMin: null });
    }
    return cycles.get(wakeDate);
  };
  if (preserveDateAxis) (dates || []).forEach(dateStr => ensure(dateStr));
  (dates || []).forEach(dateStr => {
    const day = state.data[dateStr] || {};
    if (day.wakeTime) {
      const cycle = ensure(dateStr);
      cycle.wakeTime = day.wakeTime;
      cycle.wakeMin = parseMin(day.wakeTime);
    }
    if (day.sleepTime) {
      const cycle = ensure(addDays(dateStr, 1));
      cycle.sleepTime = day.sleepTime;
      cycle.sleepMin = parseMin(day.sleepTime);
      cycle.sleepDate = dateStr;
    }
  });
  return [...cycles.values()].sort((a, b) => a.wakeDate.localeCompare(b.wakeDate));
}

function sleepClockLabel(minutes) {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

const SLEEP_INTERVAL_WIDTHS = { 1: 120, 2: 90, 3: 60, 4: 30, 5: 15 };

function sleepIntervalGranularity(value) {
  const level = Math.round(Number(value) || 3);
  return Math.max(1, Math.min(5, level));
}

function sleepIntervalDistribution(values, bedtime = false, granularity = 3) {
  const level = sleepIntervalGranularity(granularity);
  const width = SLEEP_INTERVAL_WIDTHS[level];
  const normalized = (values || [])
    .filter(value => value != null)
    .map(value => bedtime ? sleepNormalizedBedtimeMinute(value) : sleepNormalizedWakeMinute(value))
    .sort((a, b) => a - b);
  if (!normalized.length) return { level, width, values: [], bins: [], items: [], total: 0, average: null, dominant: null };
  const first = Math.floor(normalized[0] / width) * width;
  const lastValue = normalized[normalized.length - 1];
  const end = Math.max(first + width, Math.ceil((lastValue + Number.EPSILON) / width) * width);
  const binCount = Math.max(1, Math.ceil((end - first) / width));
  const bins = Array.from({ length: binCount }, (_, index) => {
    const min = first + index * width;
    const max = min + width;
    const count = normalized.filter(value => value >= min && (index === binCount - 1 ? value <= max : value < max)).length;
    return { min, max, count, label: `${sleepClockLabel(min)}–${sleepClockLabel(max)}` };
  });
  const total = normalized.length;
  const items = bins.map((bin, index) => ({
    ...bin,
    pct: total ? bin.count / total * 100 : 0,
    color: getChartSeriesColor(`distribution${index % 8 + 1}`),
  }));
  const dominant = bins.reduce((best, bin) => bin.count > best.count ? bin : best, bins[0]);
  return {
    level,
    width,
    values: normalized,
    bins,
    items,
    total,
    average: normalized.reduce((sum, value) => sum + value, 0) / normalized.length,
    dominant,
  };
}

function previewSleepIntervalGranularity(kind, value) {
  if (!['wake', 'bedtime'].includes(kind)) return;
  const level = sleepIntervalGranularity(value);
  const output = document.getElementById(`sleep-${kind}-interval-granularity-output`);
  if (output) output.textContent = `第 ${level} 档 · ${fmtMin(SLEEP_INTERVAL_WIDTHS[level], true)} / 格`;
}

function setSleepIntervalGranularity(kind, value) {
  const level = sleepIntervalGranularity(value);
  if (kind === 'wake') state.sleepWakeDistributionGranularity = level;
  else if (kind === 'bedtime') state.sleepBedtimeDistributionGranularity = level;
  else return;
  renderSleep(kind);
}

function switchSleepDistributionView(kind, view) {
  if (!['wake', 'bedtime'].includes(kind) || !['pie', 'interval'].includes(view)) return;
  if (kind === 'wake') state.sleepWakeDistributionView = view;
  else state.sleepBedtimeDistributionView = view;
  renderSleep(kind);
}

function sleepCumulativeUtilSeries(days) {
  let totalUnavailable = 0;
  let totalAwake = 0;
  return (days || []).map(day => {
    const recorded = chartDateStatus(day.dateStr) === 'recorded';
    const valid = day.awakeMin > 0 && day.unavailableMin != null;
    if (valid) {
      totalUnavailable += Math.max(0, Number(day.unavailableMin) || 0);
      totalAwake += Number(day.awakeMin) || 0;
    }
    return {
      dateStr: day.dateStr,
      label: formatShort(day.dateStr),
      daily: recorded && valid ? Number((Math.max(0, Number(day.unavailableMin) || 0) / day.awakeMin * 100).toFixed(2)) : null,
      cumulative: recorded && totalAwake > 0 ? Number((totalUnavailable / totalAwake * 100).toFixed(2)) : null,
    };
  });
}

function sleepCumulativeAverageSeries(days) {
  let totalAwake = 0;
  let totalActual = 0;
  let validDays = 0;
  return (days || []).map(day => {
    const recorded = chartDateStatus(day.dateStr) === 'recorded';
    if (day.awakeMin > 0) {
      totalAwake += Number(day.awakeMin) || 0;
      totalActual += Math.max(0, Number(day.actualMin) || 0);
      validDays += 1;
    }
    return {
      label: formatShort(day.dateStr),
      dateStr: day.dateStr,
      awakeAverage: recorded && validDays ? durationDisplayValue(totalAwake / validDays) : null,
      actualAverage: recorded && validDays ? durationDisplayValue(totalActual / validDays) : null,
    };
  });
}

function sleepNormalizedWakeMinute(value) {
  if (value == null) return null;
  const adjusted = Number(value);
  return adjusted < 18 * 60 ? adjusted + 1440 : adjusted;
}

function sleepTimePointStats(values, bedtime = false) {
  const normalized = (values || [])
    .filter(value => value != null)
    .map(value => bedtime ? sleepNormalizedBedtimeMinute(value) : sleepNormalizedWakeMinute(value));
  return calcStats(normalized);
}

function sleepCumulativeTimePointSeries(cycles) {
  let sleepTotal = 0, sleepCount = 0, wakeTotal = 0, wakeCount = 0;
  return (cycles || []).map(cycle => {
    if (cycle.sleepMin != null) {
      sleepTotal += sleepNormalizedBedtimeMinute(cycle.sleepMin);
      sleepCount += 1;
    }
    if (cycle.wakeMin != null) {
      wakeTotal += sleepNormalizedWakeMinute(cycle.wakeMin);
      wakeCount += 1;
    }
    return {
      sleep: chartDateStatus(cycle.wakeDate) === 'recorded' && sleepCount ? sleepTotal / sleepCount : null,
      wake: chartDateStatus(cycle.wakeDate) === 'recorded' && wakeCount ? wakeTotal / wakeCount : null,
    };
  });
}

function sleepCycleDuration(cycle) {
  if (cycle?.sleepMin == null || cycle?.wakeMin == null) return null;
  const sleep = sleepNormalizedBedtimeMinute(cycle.sleepMin);
  let wake = cycle.wakeMin + 1440;
  if (wake < sleep) wake += 1440;
  const duration = wake - sleep;
  return duration > 0 && duration <= 24 * 60 ? duration : null;
}

function sleepHeroHtml(meta) {
  return `<section class="sleep-hero">
    <div class="sleep-hero-copy">
      <div class="sleep-eyebrow">SLEEP & RHYTHM</div>
      <h2>作息仪表盘</h2>
      <p>统一查看睡觉、起床、清醒、实际专注和不可用时间结构。</p>
    </div>
    <div class="sleep-range-workspace">${analysisRangePlannerHtml('sleep', meta)}</div>
  </section>`;
}

function sleepSummaryHtml(days, cycles) {
  const wakeMins = days.map(day => day.wakeMin).filter(value => value != null);
  const sleepMins = days.map(day => day.sleepMin).filter(value => value != null);
  const wakeStats = sleepTimePointStats(wakeMins);
  const bedtimeStats = sleepTimePointStats(sleepMins, true);
  const awakeDays = days.filter(day => day.awakeMin != null);
  const durations = cycles.map(sleepCycleDuration).filter(value => value != null);
  const totalActual = days.reduce((sum, day) => sum + (Number(day.actualMin) || 0), 0);
  const utilDays = days.filter(day => day.awakeMin > 0 && day.unavailableMin != null);
  const totalAwake = utilDays.reduce((sum, day) => sum + day.awakeMin, 0);
  const totalUnavailable = utilDays.reduce((sum, day) => sum + Math.max(0, Number(day.unavailableMin) || 0), 0);
  const weightedUtil = totalAwake > 0 ? Math.round(totalUnavailable / totalAwake * 100) : null;
  return `<section class="sleep-summary">
    <div class="sleep-primary-kpis">
      <div><span>平均起床</span><strong class="c-wake">${wakeStats.n ? sleepClockLabel(wakeStats.mean) : '-'}</strong><small>${wakeStats.n} 条记录 · CV ${fmtCV(wakeStats.cv)} · σ ${wakeStats.n ? fmtMin(Math.round(wakeStats.stdDev), true) : '-'}</small></div>
      <div><span>平均睡觉</span><strong class="c-sleep">${bedtimeStats.n ? sleepClockLabel(bedtimeStats.mean) : '-'}</strong><small>${bedtimeStats.n} 条记录 · CV ${fmtCV(bedtimeStats.cv)} · σ ${bedtimeStats.n ? fmtMin(Math.round(bedtimeStats.stdDev), true) : '-'}</small></div>
      <div><span>平均睡眠时长</span><strong>${durations.length ? fmtMin(Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)) : '-'}</strong><small>${durations.length} 个完整睡眠周期</small></div>
    </div>
    <div class="sleep-secondary-kpis">
      <div><span>记录天数</span><b>${days.length}</b></div>
      <div><span>平均清醒</span><b>${awakeDays.length ? fmtMin(Math.round(awakeDays.reduce((sum, day) => sum + day.awakeMin, 0) / awakeDays.length)) : '-'}</b></div>
      <div><span>平均实际专注</span><b>${days.length ? fmtMin(Math.round(totalActual / days.length), true) : '-'}</b></div>
      <div><span>平均不可用占比</span><b>${weightedUtil == null ? '-' : `${weightedUtil}%`}</b></div>
    </div>
  </section>`;
}

function sleepDistributionHtml(kind, title, subtitle, chartId, distribution, view) {
  if (!distribution.items.length) {
    return `<article class="sleep-distribution-panel" data-render-panel="sleep-${kind}-distribution"><div class="sleep-panel-head"><div><h3>${title}</h3><p>${subtitle}</p></div></div><div class="sleep-panel-empty">当前范围没有可用记录</div></article>`;
  }
  const outputId = `sleep-${kind}-interval-granularity-output`;
  return `<article class="sleep-distribution-panel" data-render-panel="sleep-${kind}-distribution">
    <div class="sleep-panel-head"><div><h3>${title}</h3><p>${subtitle}</p></div><span>${distribution.total} 次</span></div>
    <div class="task-distribution-controls" style="margin-top:12px">
      <div class="task-distribution-scale-head"><span>区间精细度</span><output id="${outputId}">第 ${distribution.level} 档 · ${fmtMin(distribution.width, true)} / 格</output></div>
      <input type="range" min="1" max="5" step="1" value="${distribution.level}" aria-label="${title}区间精细度" oninput="previewSleepIntervalGranularity('${kind}',this.value)" onchange="setSleepIntervalGranularity('${kind}',this.value)">
      <div class="task-distribution-scale-labels"><span>宽泛 · ${fmtMin(120, true)}</span><span>精细 · ${fmtMin(15, true)}</span></div>
      <div class="sleep-util-tabs">
        <button type="button" class="${view === 'pie' ? 'active' : ''}" onclick="switchSleepDistributionView('${kind}','pie')">饼图</button>
        <button type="button" class="${view === 'interval' ? 'active' : ''}" onclick="switchSleepDistributionView('${kind}','interval')">区间分布图</button>
      </div>
    </div>
    ${view === 'pie' ? `<div class="sleep-distribution-body">
      <div class="sleep-doughnut-stage"><canvas id="${chartId}"></canvas></div>
      <div class="sleep-distribution-legend">${distribution.items.map((item, index) => `<div data-visual-distribution="${index % 8 + 1}"><i style="--legend-color:${item.color}"></i><b>${item.label}</b><span>${item.count} 次 · ${item.pct.toFixed(1)}%</span></div>`).join('')}</div>
    </div>` : `<div class="task-distribution-chart-head"><span><b>${title}</b></span><small>平均 ${sleepClockLabel(distribution.average)} · 最集中于 ${distribution.dominant.label}</small></div><div class="task-distribution-chart-stage"><canvas id="${chartId}"></canvas></div>`}
  </article>`;
}

function sleepDetailHtml(days, meta) {
  const completeCount = days.filter(day => day.wakeMin != null && day.sleepMin != null).length;
  return `<details class="sleep-detail-panel">
    <summary><span><b>作息数据明细</b><small>${meta.start} 至 ${meta.end}</small></span><span>${days.length} 天 · ${completeCount} 天完整作息</span></summary>
    <div class="sleep-detail-table-wrap"><table class="sleep-detail-table" data-sort-table="sleep-detail">
      <thead><tr>${sortableTableHeaderHtml('sleep-detail', 'date', '日期', 'date')}${sortableTableHeaderHtml('sleep-detail', 'wake', '起床', 'time', 'c-wake')}<th>起床备注</th>${sortableTableHeaderHtml('sleep-detail', 'sleep', '睡觉', 'time', 'c-sleep')}<th>睡觉备注</th>${sortableTableHeaderHtml('sleep-detail', 'awake', '清醒时长')}${sortableTableHeaderHtml('sleep-detail', 'actual', '实际专注', 'number', 'c-actual')}${sortableTableHeaderHtml('sleep-detail', 'util', '不可用占比')}</tr></thead>
      <tbody>${days.map((day, rowIndex) => `<tr ${sortableTableRowAttrs({
        date: day.dateStr,
        wake: day.wakeMin,
        sleep: day.sleepMin == null ? null : sleepNormalizedBedtimeMinute(day.sleepMin),
        awake: day.awakeMin,
        actual: Number(day.actualMin) || 0,
        util: day.utilPct,
      }, rowIndex)}>
        <td class="fw-mono"><button type="button" class="sleep-detail-date-link" onclick="openEntryDate('${day.dateStr}')">${formatShort(day.dateStr)}</button>${day.dayType ? dayTypeBadgeHtml({ dayType: day.dayType, excludeFromRating: day.excludeFromRating }) : ''}</td>
        <td class="fw-mono c-wake">${day.wakeTime || '-'}</td><td class="c-muted">${day.wakeNote ? escHtmlApp(day.wakeNote) : '-'}</td><td class="fw-mono c-sleep">${day.sleepTime || '-'}</td><td class="c-muted">${day.sleepNote ? escHtmlApp(day.sleepNote) : '-'}</td>
        <td class="fw-mono">${fmtMin(day.awakeMin)}</td><td class="fw-mono c-actual">${fmtMin(day.actualMin, true)}</td>
        <td class="fw-mono c-muted">${day.utilPct != null ? `${day.utilPct}%` : '-'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

function renderSleep(panelKey = '') {
  const host = document.getElementById('tab-sleep');
  if (!host) return;
  const sleepPanelKey = ['wake', 'bedtime'].includes(panelKey) ? `sleep-${panelKey}-distribution` : '';
  let scopedPanel = Boolean(sleepPanelKey && host.querySelector(`[data-render-panel="${sleepPanelKey}"]`));
  if (scopedPanel) destroyChart(panelKey === 'wake' ? 'sleepWakeDistributionChart' : 'sleepBedtimeDistributionChart');
  else ['sleepTimelineChart', 'sleepWakeDistributionChart', 'sleepBedtimeDistributionChart', 'sleepAwakeFocusChart', 'sleepUnavailableChart', 'wakeDistChart', 'awakeStudyChart'].forEach(destroyChart);
  const rangeMeta = sleepRangeMeta();
  const dates = rangeMeta.dates;
  const sleepDays = sleepBuildDays(dates);
  const sleepChartDays = sleepBuildDays(rangeMeta.analysisDates);
  const sleepCycles = sleepBuildCycles(dates);
  const sleepTimelineCycles = sleepBuildCycles(rangeMeta.dayTypeContext.displayDates, true);
  state.sleepWakeDistributionGranularity = sleepIntervalGranularity(state.sleepWakeDistributionGranularity);
  state.sleepBedtimeDistributionGranularity = sleepIntervalGranularity(state.sleepBedtimeDistributionGranularity);
  state.sleepWakeDistributionView = ['pie', 'interval'].includes(state.sleepWakeDistributionView) ? state.sleepWakeDistributionView : 'pie';
  state.sleepBedtimeDistributionView = ['pie', 'interval'].includes(state.sleepBedtimeDistributionView) ? state.sleepBedtimeDistributionView : 'pie';
  const wakeDistribution = sleepIntervalDistribution(sleepDays.map(day => day.wakeMin), false, state.sleepWakeDistributionGranularity);
  const bedtimeDistribution = sleepIntervalDistribution(sleepDays.map(day => day.sleepMin), true, state.sleepBedtimeDistributionGranularity);
  const utilSeries = sleepCumulativeUtilSeries(sleepChartDays);

  const focusView = ['duration', 'average'].includes(state.sleepFocusView) ? state.sleepFocusView : 'duration';
  state.sleepFocusView = focusView;
  const timelineView = ['daily', 'cumulativeAverage'].includes(state.sleepTimelineView) ? state.sleepTimelineView : 'daily';
  state.sleepTimelineView = timelineView;
  const utilView = ['daily', 'cumulative'].includes(state.sleepUtilView) ? state.sleepUtilView : 'daily';
  state.sleepUtilView = utilView;
  const sleepHtml = `<div class="sleep-dashboard">
    ${sleepHeroHtml(rangeMeta)}
    ${sleepDays.length ? `
      ${sleepSummaryHtml(sleepDays, sleepCycles)}
      <section class="sleep-panel sleep-timeline-panel">
        <div class="sleep-panel-head"><div><div class="sleep-eyebrow">SLEEP CYCLE</div><h3>睡觉与次日起床时间轴</h3><p id="sleep-timeline-mode-note">${timelineView === 'daily' ? '按起床日期配对前一晚睡觉记录；时间越晚，位置越靠下。' : '分别显示截至当天已有睡觉与起床记录的累计平均时间点。'}</p></div>
          <div class="sleep-timeline-tools">
            <div class="sleep-util-tabs sleep-timeline-tabs"><button type="button" class="${timelineView === 'daily' ? 'active' : ''}" data-sleep-timeline-view="daily" onclick="switchSleepTimelineView('daily')">每日时间</button><button type="button" class="${timelineView === 'cumulativeAverage' ? 'active' : ''}" data-sleep-timeline-view="cumulativeAverage" onclick="switchSleepTimelineView('cumulativeAverage')">累计平均</button></div>
            <div class="sleep-timeline-legend">
              <span class="sleep-timeline-count">${sleepTimelineCycles.filter(cycle => cycle.sleepMin != null || cycle.wakeMin != null).length} 个周期点</span>
              <span class="sleep-timeline-key sleep" style="--sleep-key-color:${getChartSeriesColor('bedtime')}"><i></i>${timelineView === 'daily' ? '睡觉' : '平均睡觉'}</span>
              <span class="sleep-timeline-key wake" style="--sleep-key-color:${getChartSeriesColor('wake')}"><i></i>${timelineView === 'daily' ? '起床' : '平均起床'}</span>
              <span class="sleep-timeline-key band" style="--sleep-key-color:${getChartSeriesColor('sleepBand')}"><i></i>${timelineView === 'daily' ? '睡眠区间' : '平均区间'}</span>
            </div>
          </div>
        </div>
        <div class="sleep-chart-canvas timeline"><canvas id="sleepTimelineChart"></canvas></div>
      </section>
      <section class="sleep-distribution-section">
        <div class="sleep-section-heading"><div><div class="sleep-eyebrow">SCHEDULE DISTRIBUTION</div><h3>作息时间分布</h3></div><p>区间精细度同时控制饼图和区间分布图，可在同一面板内切换视图。</p></div>
        <div class="sleep-distribution-grid">
          ${sleepDistributionHtml('wake', '起床时间分布', '按可调时间区间统计起床频次', 'sleepWakeDistributionChart', wakeDistribution, state.sleepWakeDistributionView)}
          ${sleepDistributionHtml('bedtime', '睡觉时间分布', '跨午夜连续排序后按可调区间统计', 'sleepBedtimeDistributionChart', bedtimeDistribution, state.sleepBedtimeDistributionView)}
        </div>
      </section>
      <section class="sleep-panel">
        <div class="sleep-panel-head"><div><div class="sleep-eyebrow">AWAKE & FOCUS</div><h3>清醒时长与实际专注</h3><p id="sleep-focus-mode-note">${focusView === 'duration' ? `两条覆盖折线使用相同的${durationDisplayUnitLabel()}坐标轴，缺失清醒数据保留断点。` : '分别显示截至当天的累计日均清醒时长与累计日均实际专注时长。'}</p></div>
          <div class="sleep-util-tabs sleep-focus-tabs">
            <button type="button" class="${focusView === 'duration' ? 'active' : ''}" data-sleep-focus-view="duration" onclick="switchSleepFocusView('duration')">时长趋势</button>
            <button type="button" class="${focusView === 'average' ? 'active' : ''}" data-sleep-focus-view="average" onclick="switchSleepFocusView('average')">累计平均</button>
          </div>
        </div>
        <div class="sleep-chart-canvas"><canvas id="sleepAwakeFocusChart"></canvas></div>
      </section>
      <section class="sleep-panel sleep-util-panel">
        <div class="sleep-panel-head"><div><div class="sleep-eyebrow">UNAVAILABLE RATIO</div><h3>不可用时间占比</h3><p id="sleep-util-mode-note">${utilView === 'daily' ? '显示每天不可用时间占清醒时间的比例。' : '显示截至当天的累计不可用时长 ÷ 累计清醒时长。'}</p></div>
          <div class="sleep-util-tabs">
            <button type="button" class="${utilView === 'daily' ? 'active' : ''}" data-sleep-util-view="daily" onclick="switchSleepUtilView('daily')">单日占比</button>
            <button type="button" class="${utilView === 'cumulative' ? 'active' : ''}" data-sleep-util-view="cumulative" onclick="switchSleepUtilView('cumulative')">累计占比</button>
          </div>
        </div>
        ${utilSeries.length ? '<div class="sleep-chart-canvas util"><canvas id="sleepUnavailableChart"></canvas></div>' : '<div class="sleep-panel-empty">当前范围没有完整的清醒与不可用时间数据</div>'}
      </section>
      ${sleepDetailHtml(sleepDays, rangeMeta)}
    ` : `<div class="sleep-empty-state"><b>当前范围没有作息记录</b><span>可以切换日期范围，或先在录入页填写起床、睡觉时间。</span></div>`}
  </div>`;
  if (scopedPanel && !replaceRenderPanels(host, sleepHtml, sleepPanelKey)) scopedPanel = false;
  if (!scopedPanel) host.innerHTML = sleepHtml;

  if (!sleepDays.length) return;
  requestAnimationFrame(() => {
    if (!scopedPanel) {
      renderSleepCharts({ sleepDays: sleepChartDays, sleepTimelineCycles, wakeDistribution, bedtimeDistribution, utilSeries });
    } else if (panelKey === 'wake') {
      renderSleepDistributionChart('sleepWakeDistributionChart', wakeDistribution, state.sleepWakeDistributionView, getChartSeriesColor('wake'), '起床次数');
    } else {
      renderSleepDistributionChart('sleepBedtimeDistributionChart', bedtimeDistribution, state.sleepBedtimeDistributionView, getChartSeriesColor('bedtime'), '睡觉次数');
    }
  });
  return;

}
function renderSleepCharts(context) {
  renderSleepTimelineChart(context.sleepTimelineCycles);
  renderSleepDistributionChart('sleepWakeDistributionChart', context.wakeDistribution, state.sleepWakeDistributionView, getChartSeriesColor('wake'), '起床次数');
  renderSleepDistributionChart('sleepBedtimeDistributionChart', context.bedtimeDistribution, state.sleepBedtimeDistributionView, getChartSeriesColor('bedtime'), '睡觉次数');
  renderSleepAwakeFocusChart(context.sleepDays);
  renderSleepUnavailableChart(context.utilSeries);
}

function renderSleepTimelineChart(cycles) {
  if (!document.getElementById('sleepTimelineChart')) return;
  const cumulativeAverage = state.sleepTimelineView === 'cumulativeAverage';
  const cumulative = cumulativeAverage ? sleepCumulativeTimePointSeries(cycles) : null;
  const sleepData = cumulativeAverage
    ? cumulative.map(item => item.sleep == null ? null : item.sleep / 60)
    : cycles.map(cycle => cycle.sleepMin == null ? null : sleepNormalizedBedtimeMinute(cycle.sleepMin) / 60);
  const wakeData = cumulativeAverage
    ? cumulative.map(item => item.wake == null ? null : item.wake / 60)
    : cycles.map(cycle => cycle.wakeMin == null ? null : sleepNormalizedWakeMinute(cycle.wakeMin) / 60);
  const values = [...sleepData, ...wakeData].filter(value => value != null);
  const yMin = Math.floor((Math.min(18, ...values) - .5) * 2) / 2;
  const yMax = Math.ceil((Math.max(33, ...values) + .5) * 2) / 2;
  const toTime = value => sleepClockLabel(Math.round(value * 60));
  const bedtimeColor = getChartSeriesColor('bedtime');
  const wakeColor = getChartSeriesColor('wake');
  const bandColor = getChartSeriesColor('sleepBand');
  mkChart('sleepTimelineChart', {
    type: 'line',
    data: {
      labels: cycles.map(cycle => formatShort(cycle.wakeDate)),
      datasets: [
        {
          label: cumulativeAverage ? '累计平均睡觉' : '睡觉',
          data: sleepData,
          borderColor: bedtimeColor,
          backgroundColor: hexRgba(bedtimeColor, .06),
          pointBackgroundColor: bedtimeColor,
          pointBorderColor: '#111827',
          pointBorderWidth: 2,
          borderWidth: 2.2,
          pointRadius: cycles.length > 60 ? 2 : 4,
          pointHoverRadius: 6,
          tension: .12,
          fill: false,
          spanGaps: false,
        },
        {
          label: cumulativeAverage ? '累计平均起床' : '起床',
          data: wakeData,
          borderColor: wakeColor,
          backgroundColor: hexRgba(bandColor, .08),
          pointBackgroundColor: wakeColor,
          pointBorderColor: '#111827',
          pointBorderWidth: 2,
          borderWidth: 2.2,
          pointRadius: cycles.length > 60 ? 2 : 4,
          pointHoverRadius: 6,
          tension: .12,
          fill: { target: '-1', above: hexRgba(bandColor, .08), below: hexRgba(bandColor, .08) },
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: items => {
            const cycle = cycles[items[0]?.dataIndex];
            return cycle ? (cumulativeAverage ? `截至 ${formatShort(cycle.wakeDate)}` : `${formatShort(cycle.sleepDate)} 夜 → ${formatShort(cycle.wakeDate)} 晨`) : '';
          },
          label: item => {
            if (item.raw == null) return null;
            return `${item.dataset.label}: ${toTime(Number(item.raw))}`;
          },
        } },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', autoSkip: true, autoSkipPadding: 18, maxRotation: 35 }, grid: { display: false }, title: { display: true, text: '起床日期', color: '#6b7a9e' } },
        y: { min: yMin, max: yMax, reverse: true, ticks: { color: '#7f8fb3', stepSize: 1, callback: toTime }, grid: { color: 'rgba(30,36,56,.72)' }, title: { display: true, text: '时间（越晚越靠下）', color: '#7f8fb3' } },
      },
    },
    plugins: [noRecordRegionPlugin(cycles.map(cycle => cycle.wakeDate))],
  });
}

function switchSleepTimelineView(view) {
  if (!['daily', 'cumulativeAverage'].includes(view)) return;
  state.sleepTimelineView = view;
  document.querySelectorAll('[data-sleep-timeline-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.sleepTimelineView === view);
  });
  const note = document.getElementById('sleep-timeline-mode-note');
  if (note) note.textContent = view === 'daily'
    ? '按起床日期配对前一晚睡觉记录；时间越晚，位置越靠下。'
    : '分别显示截至当天已有睡觉与起床记录的累计平均时间点。';
  const sleepKey = document.querySelector('.sleep-timeline-key.sleep');
  const wakeKey = document.querySelector('.sleep-timeline-key.wake');
  const bandKey = document.querySelector('.sleep-timeline-key.band');
  if (sleepKey) sleepKey.innerHTML = `<i></i>${view === 'daily' ? '睡觉' : '平均睡觉'}`;
  if (wakeKey) wakeKey.innerHTML = `<i></i>${view === 'daily' ? '起床' : '平均起床'}`;
  if (bandKey) bandKey.innerHTML = `<i></i>${view === 'daily' ? '睡眠区间' : '平均区间'}`;
  const rangeMeta = sleepRangeMeta();
  renderSleepTimelineChart(sleepBuildCycles(rangeMeta.dayTypeContext.displayDates, true));
}

function renderSleepDistributionChart(chartId, distribution, view = 'pie', color = '#80deea', label = '次数') {
  if (!document.getElementById(chartId) || !distribution.items.length) return;
  if (view === 'interval') {
    renderSleepIntervalDistributionChart(chartId, distribution, color, label);
    return;
  }
  mkChart(chartId, {
    type: 'doughnut',
    data: {
      labels: distribution.items.map(item => item.label),
      datasets: [{
        data: distribution.items.map(item => item.count),
        backgroundColor: distribution.items.map(item => `${item.color}cc`),
        borderColor: distribution.items.map(item => item.color),
        borderWidth: 1.5,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: context => {
          const item = distribution.items[context.dataIndex];
          return `${item.label}: ${item.count} 次（${item.pct.toFixed(1)}%）`;
        } } },
      },
    },
  });
}

function renderSleepAwakeFocusChart(days) {
  if (!document.getElementById('sleepAwakeFocusChart')) return;
  destroyChart('sleepAwakeFocusChart');
  const cumulativeAverage = state.sleepFocusView === 'average';
  const pointRadius = days.length > 60 ? 1.5 : 3.5;
  const awakeColor = getSystemSeriesColor('awake');
  const actualColor = getChartSeriesColor('actual');
  if (cumulativeAverage) {
    const series = sleepCumulativeAverageSeries(days);
    mkChart('sleepAwakeFocusChart', {
      type: 'line',
      data: {
        labels: series.map(item => item.label),
        datasets: [
          { label: '累计日均清醒', data: series.map(item => item.awakeAverage), borderColor: awakeColor, backgroundColor: hexRgba(awakeColor, .1), pointBackgroundColor: awakeColor, borderWidth: 2, pointRadius: series.length > 60 ? 1.5 : 3.5, tension: .2, fill: true },
          { label: '累计日均实际专注', data: series.map(item => item.actualAverage), borderColor: actualColor, backgroundColor: hexRgba(actualColor, .1), pointBackgroundColor: actualColor, borderWidth: 2.2, pointRadius: series.length > 60 ? 1.5 : 3.5, tension: .2, fill: true },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#6b7a9e', boxWidth: 10, padding: 12 } }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)}${durationDisplayUnitSuffix()}` } } },
        scales: { x: { ticks: { color: '#6b7a9e', autoSkip: true, autoSkipPadding: 18, maxRotation: 35 }, grid: gridCfg }, y: { beginAtZero: true, ticks: { color: '#6b7a9e', callback: value => `${value}${durationDisplayUnitSuffix()}` }, grid: gridCfg, title: { display: true, text: `累计日均时长（${durationDisplayUnitLabel()}）`, color: '#6b7a9e' } } },
      },
      plugins: [noRecordRegionPlugin(series.map(item => item.dateStr))],
    });
    return;
  }
  mkChart('sleepAwakeFocusChart', {
    type: 'line',
    data: {
      labels: days.map(day => formatShort(day.dateStr)),
      datasets: [
        { label: '清醒时长', data: days.map(day => day.awakeMin == null ? null : durationDisplayValue(day.awakeMin)), borderColor: awakeColor, backgroundColor: hexRgba(awakeColor, .12), pointBackgroundColor: awakeColor, borderWidth: 2, pointRadius, tension: .2, fill: true, spanGaps: false },
        { label: '实际专注', data: days.map(day => chartDateStatus(day.dateStr) === 'recorded' ? durationDisplayValue(day.actualMin) : null), borderColor: actualColor, backgroundColor: hexRgba(actualColor, .12), pointBackgroundColor: actualColor, borderWidth: 2.2, pointRadius, tension: .2, fill: true, spanGaps: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#6b7a9e', boxWidth: 10, padding: 12 } }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${context.parsed.y == null ? '-' : `${context.parsed.y.toFixed(2)}${durationDisplayUnitSuffix()}`}` } } },
      scales: { x: { ticks: { color: '#6b7a9e', autoSkip: true, autoSkipPadding: 18, maxRotation: 35 }, grid: gridCfg }, y: { beginAtZero: true, ticks: { color: '#6b7a9e', callback: value => `${value}${durationDisplayUnitSuffix()}` }, grid: gridCfg, title: { display: true, text: durationDisplayUnitLabel(), color: '#6b7a9e' } } },
    },
    plugins: [noRecordRegionPlugin(days.map(day => day.dateStr))],
  });
}

function switchSleepFocusView(view) {
  if (!['duration', 'average'].includes(view)) return;
  state.sleepFocusView = view;
  document.querySelectorAll('[data-sleep-focus-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.sleepFocusView === view);
  });
  const note = document.getElementById('sleep-focus-mode-note');
  if (note) note.textContent = view === 'duration'
    ? `两条覆盖折线使用相同的${durationDisplayUnitLabel()}坐标轴，缺失清醒数据保留断点。`
    : '分别显示截至当天的累计日均清醒时长与累计日均实际专注时长。';
  renderSleepAwakeFocusChart(sleepBuildDays(sleepRangeMeta().analysisDates));
}

function renderSleepUnavailableChart(series) {
  if (!document.getElementById('sleepUnavailableChart') || !series.length) return;
  destroyChart('sleepUnavailableChart');
  const cumulative = state.sleepUtilView === 'cumulative';
  const unavailableColor = getChartSeriesColor('unavailable');
  mkChart('sleepUnavailableChart', {
    type: 'line',
    data: {
      labels: series.map(item => item.label),
      datasets: [{
        label: cumulative ? '累计不可用占比' : '单日不可用占比',
        data: series.map(item => cumulative ? item.cumulative : item.daily),
        borderColor: unavailableColor,
        backgroundColor: hexRgba(unavailableColor, .12),
        pointBackgroundColor: unavailableColor,
        borderWidth: 2.2,
        pointRadius: series.length > 60 ? 1.5 : 3.5,
        tension: .2,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)}%` } } },
      scales: { x: { ticks: { color: '#6b7a9e', autoSkip: true, autoSkipPadding: 18, maxRotation: 35 }, grid: gridCfg }, y: { beginAtZero: true, min: 0, max: 100, ticks: { color: '#6b7a9e', callback: value => `${value}%` }, grid: gridCfg, title: { display: true, text: '不可用占比 (%)', color: '#6b7a9e' } } },
    },
    plugins: [noRecordRegionPlugin(series.map(item => item.dateStr))],
  });
}

function switchSleepUtilView(view) {
  if (!['daily', 'cumulative'].includes(view)) return;
  state.sleepUtilView = view;
  document.querySelectorAll('[data-sleep-util-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.sleepUtilView === view);
  });
  const note = document.getElementById('sleep-util-mode-note');
  if (note) note.textContent = view === 'daily'
    ? '显示每天不可用时间占清醒时间的比例。'
    : '显示截至当天的累计不可用时长 ÷ 累计清醒时长。';
  renderSleepUnavailableChart(sleepCumulativeUtilSeries(sleepBuildDays(sleepRangeMeta().analysisDates)));
}

// ============================================================
// EXPORT TAB
// ============================================================
function exportDataRangeMeta() {
  const validRanges = ['7d', '30d', '60d', '90d', 'year', 'custom'];
  const range = validRanges.includes(state.exportDataRange) ? state.exportDataRange : '30d';
  state.exportDataRange = range;
  const today = getTodayStr();
  const allDates = getAllDates();
  if (!state.exportCustomStart) state.exportCustomStart = allDates[0] || today;
  if (!state.exportCustomEnd) state.exportCustomEnd = today;
  let start = addDays(today, -29);
  let end = today;
  if (range === '7d') start = addDays(today, -6);
  else if (range === '60d') start = addDays(today, -59);
  else if (range === '90d') start = addDays(today, -89);
  else if (range === 'year') start = `${today.slice(0, 4)}-01-01`;
  else if (range === 'custom') {
    start = state.exportCustomStart;
    end = state.exportCustomEnd;
  }
  const dates = allDates.filter(dateStr => dateStr >= start && dateStr <= end);
  const labels = { '7d': '近7天', '30d': '近30天', '60d': '近60天', '90d': '近90天', year: '本年', custom: '自定义' };
  return { range, start, end, dates, label: labels[range] };
}

function exportDataPayload(meta = exportDataRangeMeta()) {
  const dateSet = new Set(meta.dates);
  const payload = {};
  Object.entries(state.data).forEach(([key, value]) => {
    if (key.startsWith('__') || dateSet.has(key)) payload[key] = value;
  });
  return payload;
}

function setExportDataRange(range) {
  if (!['7d', '30d', '60d', '90d', 'year', 'custom'].includes(range)) return;
  state.exportDataRange = range;
  renderExport();
}

function applyExportCustomRange() {
  const start = document.getElementById('export_custom_start')?.value || '';
  const end = document.getElementById('export_custom_end')?.value || '';
  if (!start || !end) {
    alert('请选择完整的开始日期和结束日期。');
    return;
  }
  if (start > end) {
    alert('开始日期不能晚于结束日期。');
    return;
  }
  state.exportCustomStart = start;
  state.exportCustomEnd = end;
  state.exportDataRange = 'custom';
  renderExport();
}

function renderExport() {
  const meta = exportDataRangeMeta();
  const payload = exportDataPayload(meta);
  const payloadSize = Math.max(1, Math.round(JSON.stringify(payload).length / 1024));
  const rangeOptions = [['7d', '近7天'], ['30d', '近30天'], ['60d', '近60天'], ['90d', '近90天'], ['year', '本年'], ['custom', '自定义']];
  document.getElementById('tab-export').innerHTML = `<div class="export-data-page">
    <section class="export-data-hero"><div><span>DATA PORTABILITY</span><h2>数据导入与导出</h2><p>按日期范围导出记录；模板、分类和设置会随文件保留。</p></div><div class="export-data-hero-stat"><span>当前范围</span><b>${meta.label}</b><small>${meta.start} 至 ${meta.end}</small></div></section>
    <div class="export-data-grid">
      <section class="card export-data-panel">
        <div class="export-data-panel-head"><div><div class="card-title">导出数据</div><p>生成可重新导入本记录器的 JSON 文件。</p></div><span>${meta.dates.length} 天</span></div>
        <div class="export-range-tabs">${rangeOptions.map(([value, label]) => `<button type="button" class="${meta.range === value ? 'active' : ''}" onclick="setExportDataRange('${value}')">${label}</button>`).join('')}</div>
        ${meta.range === 'custom' ? `<div class="export-custom-range"><label><span>开始日期</span><input type="date" id="export_custom_start" value="${escHtmlApp(state.exportCustomStart)}"></label><label><span>结束日期</span><input type="date" id="export_custom_end" value="${escHtmlApp(state.exportCustomEnd)}"></label><button type="button" class="btn btn-primary btn-sm" onclick="applyExportCustomRange()">应用范围</button></div>` : ''}
        <div class="export-range-summary"><div><span>记录日期</span><b>${meta.dates.length} 天</b></div><div><span>预计大小</span><b>约 ${payloadSize} KB</b></div><div><span>全局配置</span><b>一并保留</b></div></div>
        <div class="export-data-actions"><button class="btn btn-primary" onclick="downloadJSON()">下载 JSON</button></div>
      </section>
      <section class="card export-data-panel import-panel">
        <div class="export-data-panel-head"><div><div class="card-title">导入数据</div><p>选择此前导出的 JSON 文件。</p></div></div>
        <div class="export-import-warning"><b>覆盖规则</b><span>导入会与现有数据合并；相同日期将被导入文件中的整日数据覆盖。真正写入前会再次要求确认。</span></div>
        <button type="button" class="import-drop" onclick="document.getElementById('importFile').click()"><span>选择 JSON 文件</span><small>解析完成后先显示覆盖确认</small></button>
        <input type="file" id="importFile" accept=".json,application/json" hidden onchange="importJSON(this)">
      </section>
    </div>
    <div id="exportStatus" class="export-data-status" aria-live="polite"></div>
  </div>`;
}

function downloadJSON() {
  try {
    const meta = exportDataRangeMeta();
    if (!meta.dates.length) { alert('当前日期范围内没有可导出的记录。'); return; }
    const content = JSON.stringify(exportDataPayload(meta), null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `学习数据_${meta.start}_${meta.end}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById('exportStatus').textContent = `已下载 ${meta.dates.length} 天的数据。`;
  } catch (e) {
    console.error('下载失败', e);
    document.getElementById('exportStatus').textContent = '下载失败：' + e.message;
  }
}

async function importJSON(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error('INVALID_JSON_ROOT');
      const importedDates = Object.keys(imported).filter(key => !key.startsWith('__'));
      const conflictDates = importedDates.filter(dateStr => Object.prototype.hasOwnProperty.call(state.data, dateStr));
      const importedConfigCount = Object.keys(imported).filter(key => key.startsWith('__')).length;
      const confirmed = confirm(`即将导入 ${importedDates.length} 天的数据。\n\n其中 ${conflictDates.length} 个相同日期会被导入文件中的整日数据覆盖${importedConfigCount ? `，并更新 ${importedConfigCount} 项模板或设置配置` : ''}。\n此操作会立即保存，是否继续？`);
      if (!confirmed) {
        input.value = '';
        return;
      }
      Object.assign(state.data, imported);
      if (!Object.prototype.hasOwnProperty.call(imported, '__ordinalUnitList__')) {
        delete state.data.__ordinalUnitList__;
      }
      migrateSessionTemplateTypes();
      migrateForecastUnitModel();
      migrateTaskTemplateIds();
      migrateTaskTemplateScoringSettings();
      state.forecastEditingId = null;
      state.workbookReviewId = null;
      state.workbookDraft = null;
      cacheToLocal();
      await apiFetch('/api/data', { method: 'POST', body: JSON.stringify(state.data) });
      renderExport(); renderHeader();
      document.getElementById('exportStatus').textContent = `导入完成：${importedDates.length} 天，覆盖 ${conflictDates.length} 个相同日期。`;
      input.value = '';
    } catch {
      input.value = '';
      alert('JSON 格式错误，请检查文件。');
    }
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
// SETTINGS TAB
// ============================================================
const VISUAL_COLOR_GROUPS = [
  { key: 'level1', label: '一级分类' },
  { key: 'level2', label: '二级分类' },
  { key: 'level3', label: '三级分类' },
  { key: 'special', label: '特殊时段' },
];

const VISUAL_SYSTEM_ENTRIES = [
  { key: 'unclassified', label: '未分类任务' },
  { key: 'specialDefault', label: '新特殊时段默认色' },
  { key: 'taskTotal', label: '任务汇总' },
  { key: 'specialTotal', label: '特殊时段汇总' },
  { key: 'rest', label: '休息时间' },
  { key: 'distract', label: '分心时间' },
  { key: 'idle', label: '空闲/未记录' },
  { key: 'awake', label: '清醒时长 / 参考线' },
];

const VISUAL_CHART_ENTRIES = [
  { key: 'clock', label: '时钟时长' },
  { key: 'effectiveClock', label: '有效时钟' },
  { key: 'nominal', label: '名义时长' },
  { key: 'actual', label: '实际专注' },
  { key: 'taskDuration', label: '任务时长趋势' },
  { key: 'bedtime', label: '睡觉时间' },
  { key: 'wake', label: '起床时间' },
  { key: 'sleepBand', label: '睡眠区间填充' },
  { key: 'unavailable', label: '不可用时间占比' },
  { key: 'chapterDuration', label: '章节完成耗时' },
  { key: 'chapterEfficiency', label: '章节数量效率' },
  { key: 'archived', label: '已归档章节' },
  { key: 'workbookQuestions', label: '整册分段题数' },
  { key: 'workbookCumulativeQuestions', label: '整册累计题数' },
  { key: 'workbookErrorRate', label: '整册分段错误率' },
  { key: 'workbookCumulativeErrorRate', label: '整册累计错误率' },
  { key: 'workbookAverageErrorRate', label: '整册平均错误率参考线' },
  ...Array.from({ length: 8 }, (_, index) => ({
    key: `distribution${index + 1}`,
    label: `作息分布 · 第 ${index + 1} 个横轴区间`,
    breadcrumb: index === 0
      ? '起床/睡觉时间分布共用 · 对应图中最左侧时间区间'
      : `起床/睡觉时间分布共用 · 对应图中从左起第 ${index + 1} 个时间区间`,
  })),
];

function cloneVisualColorConfig(config) {
  return JSON.parse(JSON.stringify(config || visualColorBaseConfig()));
}

function visualColorEditorDraft() {
  if (!state.visualColorEditorDraft) {
    state.visualColorEditorDraft = cloneVisualColorConfig(getVisualColorConfig());
    state.visualColorEditorDirty = false;
  }
  return state.visualColorEditorDraft;
}

function visualColorGroupMap(config, group) {
  if (group === 'special') return config.special;
  if (group === 'system') return config.system;
  if (group === 'chart') return config.chart;
  return config.task[group];
}

function visualColorParentL1Options() {
  const current = getCatList(1);
  const names = new Set(current);
  [1, 2, 3].forEach(level => {
    collectVisualTaskPaths(level).forEach(path => {
      const level1 = parseActPath(path)[0];
      if (level1) names.add(level1);
    });
  });
  return [...current, ...[...names].filter(name => !current.includes(name)).sort()]
    .map(name => ({ value: name, label: name }));
}

function visualColorParentL2Options(level1) {
  const sources = collectVisualTaskPathSources(2);
  return [...sources.entries()]
    .filter(([path]) => parseActPath(path)[0] === level1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path]) => {
      const parts = parseActPath(path);
      return {
      value: path,
      label: parts[1],
    };
    });
}

function visualColorEditorContext(group) {
  const context = { level1Options: [], level2Options: [], level1: '', level2: '' };
  if (!['level2', 'level3'].includes(group)) return context;
  context.level1Options = visualColorParentL1Options();
  const level1Values = context.level1Options.map(option => option.value);
  if (!level1Values.includes(state.visualColorEditorParentL1)) {
    const usedLevel = group === 'level3' ? 3 : 2;
    const usedParents = new Set(collectVisualTaskPaths(usedLevel).map(path => parseActPath(path)[0]));
    state.visualColorEditorParentL1 = level1Values.find(value => usedParents.has(value)) || level1Values[0] || '';
  }
  context.level1 = state.visualColorEditorParentL1;
  if (group === 'level3') {
    context.level2Options = visualColorParentL2Options(context.level1);
    const level2Values = context.level2Options.map(option => option.value);
    if (!level2Values.includes(state.visualColorEditorParentL2)) {
      const usedParents = new Set(collectVisualTaskPaths(3).map(path => parseActPath(path).slice(0, 2).join(' > ')));
      state.visualColorEditorParentL2 = level2Values.find(value => usedParents.has(value)) || level2Values[0] || '';
    }
    context.level2 = state.visualColorEditorParentL2;
  }
  return context;
}

function visualTaskColorEntries(level, context = visualColorEditorContext(`level${level}`)) {
  const sources = collectVisualTaskPathSources(level);
  return [...sources.entries()]
    .filter(([path]) => {
      const parts = parseActPath(path);
      if (level === 2) return parts[0] === context.level1;
      if (level === 3) return parts.slice(0, 2).join(' > ') === context.level2;
      return true;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path], index) => {
      const parts = parseActPath(path);
      return {
        key: path,
        label: parts[level - 1],
        breadcrumb: level > 1 ? path : '',
        index: level === 1 ? getCatList(1).indexOf(path) : index,
      };
    });
}

function visualSpecialColorEntries() {
  const names = new Set([...collectVisualSpecialNames(), ...Object.keys(getVisualColorConfig().special)]);
  return [...names].sort().map(name => ({ key: name, label: name, index: -1 }));
}

function visualColorEntries(group, context = visualColorEditorContext(group)) {
  if (group.startsWith('level')) return visualTaskColorEntries(Number(group.slice(-1)), context);
  if (group === 'special') return visualSpecialColorEntries();
  if (group === 'chart') return VISUAL_CHART_ENTRIES.map((entry, index) => ({ ...entry, index }));
  return VISUAL_SYSTEM_ENTRIES.map((entry, index) => ({ ...entry, index }));
}

function visualColorEntryDefault(group, entry) {
  if (group === 'system') return VISUAL_SYSTEM_DEFAULTS[entry.key];
  if (group === 'chart') return VISUAL_CHART_DEFAULTS[entry.key];
  if (group === 'special') return visualDefaultColor('special', entry.key);
  return visualDefaultColor(group, entry.key, entry.index >= 0 ? entry.index : null);
}

function visualColorEditorRowHtml(group, entry, color) {
  const encodedKey = encodeURIComponent(entry.key).replace(/'/g, '%27');
  const rowId = `visual-color-row-${group}-${encodedKey}`;
  return `<div class="visual-color-row" id="${rowId}" style="--row-color:${color}">
    <div class="visual-color-name">
      <i></i>
      <div>
        <span>${escHtmlApp(entry.label)}</span>
        ${entry.breadcrumb ? `<em>${escHtmlApp(entry.breadcrumb)}</em>` : ''}
      </div>
    </div>
    <button type="button" class="visual-color-locate"
      title="前往实际使用位置并高亮显示"
      onclick="visualColorLocate('${group}','${encodedKey}')"><span aria-hidden="true">⌖</span> 定位</button>
    <div class="visual-color-controls">
      <input type="color" id="${rowId}-picker" value="${color}"
        aria-label="选择${escHtmlApp(entry.label)}颜色"
        oninput="visualColorEditorSet('${group}','${encodedKey}',this.value)">
      <input type="text" id="${rowId}-hex" class="visual-color-hex" value="${color.toUpperCase()}" maxlength="7"
        aria-label="${escHtmlApp(entry.label)}十六进制颜色"
        onchange="visualColorEditorSet('${group}','${encodedKey}',this.value,true)">
      <button type="button" class="visual-color-reset" title="恢复此项默认颜色"
        onclick="visualColorEditorResetItem('${group}','${encodedKey}')">↺</button>
    </div>
  </div>`;
}

let visualColorLocatorTimer = null;
let visualColorLocatorActiveCharts = [];

function visualColorLocatorLabel(group, key) {
  if (group.startsWith('level')) return `${group.slice(-1)}级分类「${key}」`;
  if (group === 'special') return `特殊时段「${key}」`;
  const entries = group === 'system' ? VISUAL_SYSTEM_ENTRIES : VISUAL_CHART_ENTRIES;
  return entries.find(entry => entry.key === key)?.label || key;
}

function visualColorLocatorColor(group, key) {
  if (group.startsWith('level')) return getCategoryColor(key, Number(group.slice(-1)));
  if (group === 'special') return getSpecialSeriesColor(key);
  if (group === 'system') return getSystemSeriesColor(key);
  return getChartSeriesColor(key);
}

function visualColorLocatorSpec(group, key) {
  const label = visualColorLocatorLabel(group, key);
  if (group.startsWith('level')) {
    const level = Number(group.slice(-1));
    return {
      tab: 'stacked', rangeScope: 'stacked', label, seriesKey: `task:${key}`,
      fallback: '.stacked-chart-panel',
      note: `堆积图中“${key}”这一${level}级任务分类使用该颜色。`,
      prepare: () => {
        state.stackedGroupLevel = level;
        state.stackedMergeTasks = false;
        state.stackedChartView = 'absolute';
        state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== `task:${key}`);
      },
      chart: { id: 'stackedMainChart', seriesKey: `task:${key}` },
    };
  }
  if (group === 'special') {
    return {
      tab: 'stacked', rangeScope: 'stacked', label, seriesKey: `special:${key}`,
      fallback: '.stacked-chart-panel',
      note: `堆积图中“${key}”这一特殊时段系列使用该颜色。`,
      prepare: () => {
        state.stackedMergeSpecials = false;
        state.stackedChartView = 'absolute';
        state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== `special:${key}`);
      },
      chart: { id: 'stackedMainChart', seriesKey: `special:${key}` },
    };
  }

  if (group === 'system') {
    const systemSpecs = {
      unclassified: {
        tab: 'stacked', rangeScope: 'stacked', seriesKey: 'task:未分类', fallback: '.stacked-chart-panel',
        note: '堆积图中的“未分类”任务系列使用该颜色。',
        prepare: () => {
          state.stackedGroupLevel = 1;
          state.stackedMergeTasks = false;
          state.stackedChartView = 'absolute';
          state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== 'task:未分类');
        },
        chart: { id: 'stackedMainChart', seriesKey: 'task:未分类' },
      },
      specialDefault: {
        tab: 'stacked', rangeScope: 'stacked', seriesKey: 'special:特殊时段', fallback: '.stacked-chart-panel',
        note: '名称为“特殊时段”且没有单独配色时，会使用这个默认色。',
        prepare: () => {
          state.stackedMergeSpecials = false;
          state.stackedChartView = 'absolute';
          state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== 'special:特殊时段');
        },
        chart: { id: 'stackedMainChart', seriesKey: 'special:特殊时段' },
      },
      taskTotal: {
        tab: 'taskAnalysis', rangeScope: 'task', selectors: ['.task-analysis-count-panel'],
        fallback: '.task-analysis-page', note: '任务分析中的“每日任务数量”图使用任务汇总色。',
        chart: { id: 'taskAnaCountChart', datasetIndex: 0 },
      },
      specialTotal: {
        tab: 'stacked', rangeScope: 'stacked', selectors: ['.stacked-summary-metric.special'],
        fallback: '.stacked-summary', note: '堆积图顶部“特殊时段”汇总卡使用该颜色。',
      },
      rest: {
        tab: 'stacked', rangeScope: 'stacked', seriesKey: 'status:rest',
        selectors: ['.stacked-summary-metric.rest'], fallback: '.stacked-chart-panel',
        note: '堆积图中的“休息”堆积区域和汇总卡使用该颜色。',
        prepare: () => {
          state.stackedChartView = 'absolute';
          state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== 'status:rest');
        },
        chart: { id: 'stackedMainChart', seriesKey: 'status:rest' },
      },
      distract: {
        tab: 'stacked', rangeScope: 'stacked', seriesKey: 'status:distract',
        selectors: ['.stacked-summary-metric.distract'], fallback: '.stacked-chart-panel',
        note: '堆积图中的“分心”堆积区域和汇总卡使用该颜色。',
        prepare: () => {
          state.stackedChartView = 'absolute';
          state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== 'status:distract');
        },
        chart: { id: 'stackedMainChart', seriesKey: 'status:distract' },
      },
      idle: {
        tab: 'stacked', rangeScope: 'stacked', seriesKey: 'status:idle',
        selectors: ['.stacked-summary-metric.idle'], fallback: '.stacked-chart-panel',
        note: '堆积图中的“空闲/未记录”区域和汇总卡使用该颜色。',
        prepare: () => {
          state.stackedChartView = 'absolute';
          state.stackedHiddenSeries = (state.stackedHiddenSeries || []).filter(item => item !== 'status:idle');
        },
        chart: { id: 'stackedMainChart', seriesKey: 'status:idle' },
      },
      awake: {
        tab: 'stacked', rangeScope: 'stacked',
        selectors: ['.stacked-legend-reference', '.stacked-awake-summary'], fallback: '.stacked-chart-panel',
        note: '堆积图中的“清醒时长”参考线和顶部清醒汇总使用该颜色。',
        prepare: () => { state.stackedChartView = 'absolute'; },
        chart: { id: 'stackedMainChart', datasetIncludes: '清醒时长' },
      },
    };
    return { label, ...systemSpecs[key] };
  }

  const chartSpecs = {
    clock: {
      tab: 'overview', rangeScope: 'overview', selectors: ['#overviewTrendChart'], fallback: '.overview-chart-grid',
      note: '总览“三维时间趋势”中的“时钟”折线使用该颜色。',
      chart: { id: 'overviewTrendChart', datasetLabel: '时钟' },
    },
    effectiveClock: {
      tab: 'overview', rangeScope: 'overview', selectors: ['#overviewTrendChart'], fallback: '.overview-chart-grid',
      note: '总览“三维时间趋势”中的“有效时钟”折线与填充使用该颜色。',
      chart: { id: 'overviewTrendChart', datasetLabel: '有效时钟' },
    },
    nominal: {
      tab: 'overview', rangeScope: 'overview', selectors: ['#overviewTrendChart'], fallback: '.overview-chart-grid',
      note: '总览“三维时间趋势”中的“名义”折线使用该颜色。',
      chart: { id: 'overviewTrendChart', datasetLabel: '名义' },
    },
    actual: {
      tab: 'overview', rangeScope: 'overview', selectors: ['#overviewTrendChart'], fallback: '.overview-chart-grid',
      note: '总览“三维时间趋势”中的“实际”折线与填充使用该颜色。',
      chart: { id: 'overviewTrendChart', datasetLabel: '实际' },
    },
    taskDuration: {
      tab: 'taskAnalysis', rangeScope: 'task', selectors: ['.task-analysis-range-task-panel'],
      fallback: '.task-analysis-page', note: '任务分析“范围每日任务时长”图使用该颜色。',
      chart: { id: 'taskAnaRangeTaskChart', datasetIndex: 0 },
    },
    bedtime: {
      tab: 'sleep', rangeScope: 'sleep', selectors: ['.sleep-timeline-key.sleep'],
      fallback: '.sleep-timeline-panel', note: '作息“睡觉与起床时间”图中的睡觉时间折线使用该颜色。',
      prepare: () => { state.sleepTimelineView = 'daily'; },
      chart: { id: 'sleepTimelineChart', datasetIncludes: '睡觉' },
    },
    wake: {
      tab: 'sleep', rangeScope: 'sleep', selectors: ['.sleep-timeline-key.wake'],
      fallback: '.sleep-timeline-panel', note: '作息“睡觉与起床时间”图中的起床时间折线使用该颜色。',
      prepare: () => { state.sleepTimelineView = 'daily'; },
      chart: { id: 'sleepTimelineChart', datasetIncludes: '起床' },
    },
    sleepBand: {
      tab: 'sleep', rangeScope: 'sleep', selectors: ['.sleep-timeline-key.band'],
      fallback: '.sleep-timeline-panel', note: '睡觉折线与起床折线之间的睡眠区间填充使用该颜色。',
      prepare: () => { state.sleepTimelineView = 'daily'; },
    },
    unavailable: {
      tab: 'sleep', rangeScope: 'sleep', selectors: ['.sleep-util-panel'],
      fallback: '.sleep-dashboard', note: '作息“不可用占清醒比例”图使用该颜色。',
      chart: { id: 'sleepUnavailableChart', datasetIndex: 0 },
    },
    chapterDuration: {
      tab: 'taskAnalysis', rangeScope: 'task', selectors: ['.task-chapter-workspace'],
      fallback: '.task-analysis-page', note: '任务分析“章节分析”的完成耗时系列使用该颜色。',
      prepare: () => { state.taskAna.chapterMetric = 'minutes'; state.taskAna.chapterView = 'single'; },
      chart: { id: 'taskAnaChapterChart', datasetIndex: 0 },
    },
    chapterEfficiency: {
      tab: 'taskAnalysis', rangeScope: 'task', selectors: ['.task-chapter-workspace'],
      fallback: '.task-analysis-page', note: '任务分析“章节分析”的数量效率系列使用该颜色。',
      prepare: () => { state.taskAna.chapterMetric = 'quantityEfficiency'; state.taskAna.chapterView = 'single'; },
      chart: { id: 'taskAnaChapterChart', datasetIndex: 0 },
    },
    archived: {
      tab: 'taskAnalysis', rangeScope: 'task', selectors: ['.task-chapter-workspace'],
      fallback: '.task-analysis-page', note: '章节完成耗时图中，已归档章节的数据柱使用该颜色。',
      prepare: () => { state.taskAna.chapterMetric = 'minutes'; state.taskAna.chapterView = 'single'; },
      chart: { id: 'taskAnaChapterChart', datasetIndex: 0, dataColorKey: 'archived' },
    },
    workbookQuestions: {
      tab: 'workbookReview', selectors: ['#workbookActiveChart'], fallback: '.workbook-analysis-panel',
      note: '整册复盘“分段总题数”图使用该颜色。',
      prepare: () => { state.workbookChartView = 'questions'; },
      chart: { id: 'workbookActiveChart', datasetIncludes: '分段总题数' },
    },
    workbookCumulativeQuestions: {
      tab: 'workbookReview', selectors: ['#workbookActiveChart'], fallback: '.workbook-analysis-panel',
      note: '整册复盘“累计总题数”图使用该颜色。',
      prepare: () => { state.workbookChartView = 'cumulativeQuestions'; },
      chart: { id: 'workbookActiveChart', datasetIncludes: '累计总题数' },
    },
    workbookErrorRate: {
      tab: 'workbookReview', selectors: ['#workbookActiveChart'], fallback: '.workbook-analysis-panel',
      note: '整册复盘“分段错误率”折线使用该颜色。',
      prepare: () => { state.workbookChartView = 'errorRate'; },
      chart: { id: 'workbookActiveChart', datasetIncludes: '分段错误率' },
    },
    workbookCumulativeErrorRate: {
      tab: 'workbookReview', selectors: ['#workbookActiveChart'], fallback: '.workbook-analysis-panel',
      note: '整册复盘“累计错误率”图使用该颜色。',
      prepare: () => { state.workbookChartView = 'cumulativeErrorRate'; },
      chart: { id: 'workbookActiveChart', datasetIncludes: '累计错误率' },
    },
    workbookAverageErrorRate: {
      tab: 'workbookReview', selectors: ['#workbookActiveChart'], fallback: '.workbook-analysis-panel',
      note: '整册复盘“分段错误率”图中的整册平均参考线使用该颜色。',
      prepare: () => { state.workbookChartView = 'errorRate'; },
      chart: { id: 'workbookActiveChart', datasetIncludes: '整册平均' },
    },
  };
  if (/^distribution[1-8]$/.test(key)) {
    const index = Number(key.replace('distribution', ''));
    return {
      tab: 'sleep', rangeScope: 'sleep', label, distributionIndex: index,
      fallback: '.sleep-distribution-section',
      note: `起床和睡觉时间分布图中，从左起第 ${index} 个时间区间使用该颜色；第 ${index + 8} 个区间会循环复用它。`,
      prepare: () => {
        state.sleepWakeDistributionView = 'pie';
        state.sleepBedtimeDistributionView = 'pie';
      },
      chart: [
        { id: 'sleepWakeDistributionChart', datasetIndex: 0, dataIndex: index - 1 },
        { id: 'sleepBedtimeDistributionChart', datasetIndex: 0, dataIndex: index - 1 },
      ],
    };
  }
  return { label, ...chartSpecs[key] };
}

function visualColorPrepareLocator(spec) {
  spec.prepare?.();
  if (!spec.rangeScope) return false;
  const range = analysisRangeState(spec.rangeScope);
  if (!range) return false;
  const changed = range.mode !== 'all' || Boolean(range.dayTypeFilter);
  range.mode = 'all';
  range.dayTypeFilter = '';
  range.pickerOpen = false;
  return changed;
}

function visualColorNormalizeLocatorTarget(element) {
  if (!element) return null;
  if (!element.matches('canvas')) return element;
  return element.closest('.chart-card, .task-analysis-panel, .sleep-panel, .sleep-distribution-panel, .stacked-chart-panel, .workbook-chart-stage, .workbook-analysis-panel')
    || element.parentElement;
}

function visualColorEndLocatorHighlight() {
  if (visualColorLocatorTimer) clearTimeout(visualColorLocatorTimer);
  visualColorLocatorTimer = null;
  document.querySelectorAll('.visual-color-locator-target').forEach(element => {
    element.classList.remove('visual-color-locator-target');
    element.style.removeProperty('--locator-color');
  });
  document.querySelectorAll('.visual-color-locator-badge').forEach(element => element.remove());
  visualColorLocatorActiveCharts.forEach(({ chart }) => {
    if (!chart || chartReg[chart.canvas?.id] !== chart) return;
    chart.setActiveElements([]);
    chart.tooltip?.setActiveElements?.([], { x: 0, y: 0 });
    chart.update('none');
  });
  visualColorLocatorActiveCharts = [];
}

function visualColorClearLocator() {
  visualColorEndLocatorHighlight();
  document.getElementById('visual-color-locator-toast')?.remove();
}

function visualColorActivateLocatorCharts(chartSpecs) {
  const specs = Array.isArray(chartSpecs) ? chartSpecs : chartSpecs ? [chartSpecs] : [];
  specs.forEach(spec => {
    const chart = chartReg[spec.id];
    if (!chart) return;
    let datasetIndex = Number.isInteger(spec.datasetIndex) ? spec.datasetIndex : -1;
    if (datasetIndex < 0 && spec.seriesKey) {
      datasetIndex = chart.data.datasets.findIndex(dataset => dataset._seriesKey === spec.seriesKey);
    }
    if (datasetIndex < 0 && spec.datasetLabel) {
      datasetIndex = chart.data.datasets.findIndex(dataset => dataset.label === spec.datasetLabel);
    }
    if (datasetIndex < 0 && spec.datasetIncludes) {
      datasetIndex = chart.data.datasets.findIndex(dataset => String(dataset.label || '').includes(spec.datasetIncludes));
    }
    if (datasetIndex < 0 || !chart.data.datasets[datasetIndex]) return;
    const dataset = chart.data.datasets[datasetIndex];
    const data = dataset.data || [];
    let dataIndex = Number.isInteger(spec.dataIndex) ? spec.dataIndex : -1;
    if (dataIndex < 0 && spec.dataColorKey) {
      const expectedColor = getChartSeriesColor(spec.dataColorKey);
      const borderColors = Array.isArray(dataset.borderColor) ? dataset.borderColor : [];
      dataIndex = borderColors.findIndex(color => color === expectedColor);
    }
    if (dataIndex < 0) dataIndex = data.findIndex(value => Number(value) > 0);
    if (dataIndex < 0) dataIndex = data.findIndex(value => value != null);
    if (dataIndex < 0 || dataIndex >= data.length || data[dataIndex] == null) return;
    const active = [{ datasetIndex, index: dataIndex }];
    chart.setActiveElements(active);
    chart.tooltip?.setActiveElements?.(active, { x: 0, y: 0 });
    chart.update('none');
    visualColorLocatorActiveCharts.push({ chart });
  });
}

function visualColorShowLocatorToast(group, encodedKey, spec, color, exactFound, rangeChanged) {
  document.getElementById('visual-color-locator-toast')?.remove();
  const toast = document.createElement('aside');
  toast.id = 'visual-color-locator-toast';
  toast.className = `visual-color-locator-toast${exactFound ? '' : ' is-fallback'}`;
  toast.style.setProperty('--locator-color', color);
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<i></i><div><strong>${exactFound ? '已精确定位颜色' : '已定位到所属区域'}</strong>
    <span>${escHtmlApp(spec.note)}${rangeChanged ? ' 已切换为“全部历史”以显示使用位置。' : ''}${exactFound ? '' : ' 当前没有足够数据生成对应系列。'}</span></div>
    <button type="button" onclick="visualColorReturnToEditor('${group}','${encodedKey}')">返回颜色设置</button>
    <button type="button" class="visual-color-locator-close" aria-label="关闭定位提示" onclick="visualColorClearLocator()">×</button>`;
  document.body.appendChild(toast);
}

function visualColorRevealLocator(group, encodedKey, spec, color, rangeChanged) {
  let targets = [];
  if (spec.seriesKey) {
    targets.push(...[...document.querySelectorAll('[data-visual-series-key]')]
      .filter(element => element.dataset.visualSeriesKey === spec.seriesKey));
  }
  if (spec.distributionIndex) {
    targets.push(...document.querySelectorAll(`[data-visual-distribution="${spec.distributionIndex}"]`));
  }
  (spec.selectors || []).forEach(selector => targets.push(...document.querySelectorAll(selector)));
  targets = [...new Set(targets.map(visualColorNormalizeLocatorTarget).filter(Boolean))];
  const exactFound = targets.length > 0;
  if (!targets.length && spec.fallback) {
    const fallback = document.querySelector(spec.fallback);
    if (fallback) targets = [visualColorNormalizeLocatorTarget(fallback)];
  }
  const first = targets[0];
  targets.forEach(element => {
    element.classList.add('visual-color-locator-target');
    element.style.setProperty('--locator-color', color);
  });
  if (first) {
    const badge = document.createElement('span');
    badge.className = 'visual-color-locator-badge';
    const badgeText = document.createElement('span');
    badgeText.textContent = exactFound ? `⌖ 这里使用：${spec.label}` : `⌖ ${spec.label} 所属区域`;
    const badgeClose = document.createElement('button');
    badgeClose.type = 'button';
    badgeClose.className = 'visual-color-locator-badge-close';
    badgeClose.setAttribute('aria-label', '关闭颜色定位高亮');
    badgeClose.textContent = '×';
    badgeClose.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      visualColorEndLocatorHighlight();
    });
    badge.append(badgeText, badgeClose);
    first.appendChild(badge);
    first.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }
  visualColorActivateLocatorCharts(spec.chart);
  visualColorShowLocatorToast(group, encodedKey, spec, color, exactFound, rangeChanged);
  visualColorLocatorTimer = setTimeout(visualColorEndLocatorHighlight, 9000);
}

function visualColorLocate(group, encodedKey) {
  const key = encodedKey ? decodeURIComponent(encodedKey) : '';
  const spec = visualColorLocatorSpec(group, key);
  if (!spec?.tab) return;
  visualColorClearLocator();
  if (state.visualColorEditorDirty) {
    spec.note += ' 当前存在未保存的颜色修改；这里继续显示上一次已保存颜色。';
  }
  const color = visualColorLocatorColor(group, key);
  const rangeChanged = visualColorPrepareLocator(spec);
  showTab(spec.tab);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    visualColorRevealLocator(group, encodedKey, spec, color, rangeChanged);
  }));
}

function visualColorReturnToEditor(group, encodedKey) {
  const key = encodedKey ? decodeURIComponent(encodedKey) : '';
  visualColorClearLocator();
  state.visualColorEditorGroup = group;
  if (group === 'level2' || group === 'level3') {
    const parts = parseActPath(key);
    state.visualColorEditorParentL1 = parts[0] || '';
    state.visualColorEditorParentL2 = group === 'level3' ? parts.slice(0, 2).join(' > ') : '';
  }
  showTab('settings');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const row = document.getElementById(`visual-color-row-${group}-${encodedKey}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

function visualColorParentControlsHtml(group, context) {
  if (!['level2', 'level3'].includes(group)) return '';
  const level1Options = context.level1Options.map(option => {
    const value = encodeURIComponent(option.value).replace(/'/g, '%27');
    return `<option value="${value}" ${option.value === context.level1 ? 'selected' : ''}>${escHtmlApp(option.label)}</option>`;
  }).join('');
  const level2Control = group === 'level3'
    ? `<label class="visual-color-parent">
        <span>二级分类</span>
        <select onchange="visualColorEditorSelectParent(2,this.value)" ${context.level2Options.length ? '' : 'disabled'}>
          ${context.level2Options.length ? context.level2Options.map(option => {
            const value = encodeURIComponent(option.value).replace(/'/g, '%27');
            return `<option value="${value}" ${option.value === context.level2 ? 'selected' : ''}>${escHtmlApp(option.label)}</option>`;
          }).join('') : '<option value="">暂无已使用二级路径</option>'}
        </select>
      </label>`
    : '';
  return `<div class="visual-color-parent-controls">
    <label class="visual-color-parent">
      <span>一级分类</span>
      <select onchange="visualColorEditorSelectParent(1,this.value)" ${context.level1Options.length ? '' : 'disabled'}>
        ${level1Options || '<option value="">暂无一级分类</option>'}
      </select>
    </label>
    ${level2Control}
  </div>`;
}

function visualColorPanelHtml() {
  const validGroups = VISUAL_COLOR_GROUPS.map(group => group.key);
  const group = validGroups.includes(state.visualColorEditorGroup) ? state.visualColorEditorGroup : 'level1';
  state.visualColorEditorGroup = group;
  const draft = visualColorEditorDraft();
  const context = visualColorEditorContext(group);
  const entries = visualColorEntries(group, context);
  const colors = visualColorGroupMap(draft, group);
  const preview = entries.slice(0, 12);
  return `<section class="visual-color-panel" id="visual-color-panel">
    <div class="visual-color-head">
      <div>
        <div class="settings-eyebrow">VISUAL COLOR SYSTEM</div>
        <h3>图表与分类颜色</h3>
        <p>统一管理一级、二级、三级任务分类与特殊时段颜色；保存后统一应用到图表、图例和内容标记，未保存修改只在本面板预览。</p>
      </div>
      <span class="visual-color-save-state ${state.visualColorEditorDirty ? 'dirty' : ''}" id="visual-color-save-state">
        ${state.visualColorEditorDirty ? '有未保存修改' : '颜色已同步'}
      </span>
    </div>
    <div class="visual-color-tabs">
      ${VISUAL_COLOR_GROUPS.map(item => `<button type="button" class="${item.key === group ? 'active' : ''}"
        onclick="visualColorEditorSwitchGroup('${item.key}')">${item.label}</button>`).join('')}
    </div>
    <div class="visual-color-toolbar">
      ${visualColorParentControlsHtml(group, context)}
      <span class="visual-color-count">${entries.length} 项</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="visualColorEditorAutoAssign()" ${entries.length ? '' : 'disabled'}>自动分配当前组</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="visualColorEditorResetGroup()" ${entries.length ? '' : 'disabled'}>恢复当前组默认值</button>
    </div>
    ${group === 'chart' ? `<div class="visual-color-note">
      <strong>作息分布色如何对应：</strong>
      用于“起床时间分布”和“睡觉时间分布”，按图表横轴从左到右依次套用第 1–8 色。
      每段的具体钟点会随数据范围和“区间精细度”变化，并非固定时间；超过 8 个区间时从第 1 色重新循环。
    </div>` : ''}
    ${preview.length ? `<div class="visual-color-preview">
      <span>预览</span>
      ${preview.map(entry => {
        const color = colors[entry.key] || visualColorEntryDefault(group, entry);
        const encodedKey = encodeURIComponent(entry.key).replace(/'/g, '%27');
        return `<i id="visual-color-preview-${group}-${encodedKey}" style="--preview-color:${color}" title="${escHtmlApp(entry.label)}"></i>`;
      }).join('')}
    </div>` : ''}
    <div class="visual-color-list">
      ${entries.length
        ? entries.map(entry => visualColorEditorRowHtml(group, entry, colors[entry.key] || visualColorEntryDefault(group, entry))).join('')
        : `<div class="visual-color-empty">${['level2', 'level3'].includes(group) ? '当前上级分类下暂无已使用路径。' : '当前分组暂无可配置项目。'}</div>`}
    </div>
    <div class="visual-color-actions">
      <button type="button" class="btn btn-primary" onclick="visualColorEditorSave()">保存颜色</button>
      <span id="visual-color-message"></span>
    </div>
  </section>`;
}

function renderVisualColorPanel() {
  const panel = document.getElementById('visual-color-panel');
  if (panel) panel.outerHTML = visualColorPanelHtml();
}

function visualColorEditorSwitchGroup(group) {
  state.visualColorEditorGroup = group;
  renderVisualColorPanel();
}

function visualColorEditorSelectParent(level, encodedValue) {
  const value = encodedValue ? decodeURIComponent(encodedValue) : '';
  if (level === 1) {
    state.visualColorEditorParentL1 = value;
    state.visualColorEditorParentL2 = '';
  } else {
    state.visualColorEditorParentL2 = value;
  }
  renderVisualColorPanel();
}

function visualColorEditorSet(group, encodedKey, value, fromText = false) {
  const key = decodeURIComponent(encodedKey);
  const normalized = String(value || '').trim().toLowerCase();
  const draft = visualColorEditorDraft();
  const map = visualColorGroupMap(draft, group);
  const rowId = `visual-color-row-${group}-${encodedKey}`;
  const row = document.getElementById(rowId);
  const message = document.getElementById('visual-color-message');
  if (!isVisualHexColor(normalized)) {
    if (message) {
      message.textContent = '请输入 #RRGGBB 格式的颜色。';
      message.style.color = 'var(--red)';
    }
    if (fromText && row) row.querySelector('.visual-color-hex').value = (map[key] || '#78909c').toUpperCase();
    return;
  }
  map[key] = normalized;
  state.visualColorEditorDirty = true;
  if (row) {
    row.style.setProperty('--row-color', normalized);
    row.querySelector('input[type="color"]').value = normalized;
    row.querySelector('.visual-color-hex').value = normalized.toUpperCase();
  }
  const preview = document.getElementById(`visual-color-preview-${group}-${encodedKey}`);
  if (preview) preview.style.setProperty('--preview-color', normalized);
  const saveState = document.getElementById('visual-color-save-state');
  if (saveState) {
    saveState.textContent = '有未保存修改';
    saveState.classList.add('dirty');
  }
  if (message) message.textContent = '';
}

function visualColorEditorResetItem(group, encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const entry = visualColorEntries(group).find(item => item.key === key);
  if (!entry) return;
  visualColorEditorSet(group, encodedKey, visualColorEntryDefault(group, entry));
}

function visualColorEditorAutoAssign() {
  const group = state.visualColorEditorGroup;
  const entries = visualColorEntries(group);
  const draft = visualColorEditorDraft();
  const map = visualColorGroupMap(draft, group);
  const palette = group === 'special' ? VISUAL_SPECIAL_PALETTE : VISUAL_COLOR_PALETTE;
  let shuffled = [...palette];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  const unchanged = entries.length > 0 && entries.every((entry, index) =>
    String(map[entry.key] || '').toLowerCase() === shuffled[index % shuffled.length].toLowerCase()
  );
  if (unchanged && shuffled.length > 1) shuffled = [...shuffled.slice(1), shuffled[0]];
  entries.forEach((entry, index) => { map[entry.key] = shuffled[index % shuffled.length]; });
  state.visualColorEditorDirty = true;
  renderVisualColorPanel();
}

function visualColorEditorResetGroup() {
  const group = state.visualColorEditorGroup;
  if (!confirm(`恢复“${VISUAL_COLOR_GROUPS.find(item => item.key === group)?.label || '当前组'}”的默认颜色？修改仍需保存后生效。`)) return;
  const draft = visualColorEditorDraft();
  const map = visualColorGroupMap(draft, group);
  visualColorEntries(group).forEach(entry => { map[entry.key] = visualColorEntryDefault(group, entry); });
  state.visualColorEditorDirty = true;
  renderVisualColorPanel();
}

async function visualColorEditorCommit(showMessage = true) {
  if (!state.visualColorEditorDraft) return;
  state.data.__visualColors__ = cloneVisualColorConfig(state.visualColorEditorDraft);
  await saveAllStorage();
  state.visualColorEditorDirty = false;
  if (showMessage) {
    renderVisualColorPanel();
    const message = document.getElementById('visual-color-message');
    if (message) {
      message.textContent = '颜色已保存并同步';
      message.style.color = 'var(--pol)';
    }
  } else {
    const saveState = document.getElementById('visual-color-save-state');
    if (saveState) {
      saveState.textContent = '颜色已同步';
      saveState.classList.remove('dirty');
    }
  }
}

async function visualColorEditorSave() {
  await visualColorEditorCommit(true);
}

function renderSettings() {
  const s = SETTINGS;

  document.getElementById('tab-settings').innerHTML = `
    <div style="max-width:900px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">⚙️ 全局设置</div>
        <p style="font-size:12px;color:var(--muted);margin:0">界面偏好保存在当前浏览器；启用后端快照后，当前页面和未提交内容可跨浏览器恢复。</p>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">🪄 通用显示</div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
          <div class="form-group"><label>时长显示单位</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn ${s.durationDisplayUnit === 'hours' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="settingsSetDisplayPreference('durationDisplayUnit','hours')">小时</button><button type="button" class="btn ${s.durationDisplayUnit === 'minutes' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="settingsSetDisplayPreference('durationDisplayUnit','minutes')">分钟</button></div><div class="form-hint">所有时长文本统一显示为小时或分钟；录入值仍以分钟保存。</div></div>
          <div class="form-group"><label>题目效率显示方式</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn ${s.questionEfficiencyDisplay === 'perMinute' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="settingsSetDisplayPreference('questionEfficiencyDisplay','perMinute')">每分钟多少题</button><button type="button" class="btn ${s.questionEfficiencyDisplay === 'minutesPerQuestion' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="settingsSetDisplayPreference('questionEfficiencyDisplay','minutesPerQuestion')">每题多少分钟</button></div><div class="form-hint">只切换显示口径；已有任务、预测和评分数据不会改变。</div></div>
        </div>
      </div>

      ${visualColorPanelHtml()}

      <!-- 2. 数据存储 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">💾 数据存储</div>
        <div class="form-grid" style="grid-template-columns:1fr">
          <div class="form-group"><label>后端快照保存模式</label>
            <select id="set_snapshotInterval">
              <option value="0" ${Number(s.snapshotInterval) === 0 ? 'selected' : ''}>关闭</option>
              <option value="30000" ${Number(s.snapshotInterval) === 30000 ? 'selected' : ''}>每30秒</option>
              <option value="60000" ${Number(s.snapshotInterval) === 60000 ? 'selected' : ''}>每1分钟</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-primary btn-sm" onclick="saveServerSnapshot(true)">立即保存快照</button>
          <button class="btn btn-ghost btn-sm" onclick="clearServerSnapshot(true)">清除后端快照</button>
          <span id="snapshot-status" class="form-hint">${state._serverSnapshot?.updatedAt ? `最后快照：${new Date(state._serverSnapshot.updatedAt).toLocaleString()}` : '后端暂无快照'}</span>
        </div>
        <div class="form-hint">本地草稿仍每3秒保存作为断网兜底；共享快照独立存放在后端 <code>draft_snapshot.json</code>，不会覆盖学习数据。</div>
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

function settingsSetDisplayPreference(key, value) {
  const allowed = {
    durationDisplayUnit: ['hours', 'minutes'],
    questionEfficiencyDisplay: ['perMinute', 'minutesPerQuestion'],
  };
  if (!allowed[key]?.includes(value)) return;
  SETTINGS = { ...SETTINGS, [key]: value };
  saveSettings(SETTINGS);
  renderHeader();
  renderSettings();
}

async function settingsSaveAll() {
  const s = SETTINGS;
  // 数据
  s.snapshotInterval = Number(document.getElementById('set_snapshotInterval')?.value);
  if (![0, 30000, 60000].includes(s.snapshotInterval)) s.snapshotInterval = 30000;
  s.useLocalStorageCache = true;

  SETTINGS = s;
  saveSettings(s);
  await visualColorEditorCommit(false);

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
  return analysisRangeMeta('session').analysisDates;
}

function sessAnaSessionCategory(sess) {
  if (isUnavailableSession(sess)) return sess.name || '特殊时段';
  if (isSpecialStudySession(sess)) return `🧩 ${sess.name || '特殊学习'}`;
  return '普通专注';
}

function sessAnaSessionTypeKey(sess) {
  if (isUnavailableSession(sess)) return 'special';
  if (isSpecialStudySession(sess)) return 'special-study';
  return 'normal';
}

function sessAnaSessionTypeLabel(type) {
  return { normal: '普通时段', special: '特殊时段', 'special-study': '特殊学习时段' }[type] || '全部类型';
}

const SESS_ANA_DURATION_BIN_MIN = 15;
const SESS_ANA_DURATION_BIN_MAX = 120;
const SESS_ANA_DURATION_BIN_STEP = 15;

function sessAnaNormalizeDurationBinSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 30;
  const stepped = Math.round(numeric / SESS_ANA_DURATION_BIN_STEP) * SESS_ANA_DURATION_BIN_STEP;
  return Math.min(SESS_ANA_DURATION_BIN_MAX, Math.max(SESS_ANA_DURATION_BIN_MIN, stepped));
}

function sessAnaBuildDurationBins(records, binSize) {
  const size = sessAnaNormalizeDurationBinSize(binSize);
  const maxDuration = records.reduce((max, record) => Math.max(max, record.duration), 0);
  const binCount = Math.max(1, Math.ceil(maxDuration / size));
  return Array.from({ length: binCount }, (_, index) => {
    const min = index * size;
    const max = (index + 1) * size;
    return {
      key: `${min}-${max}`,
      label: `${durationDisplayValue(min)}–${durationDisplayValue(max)}${durationDisplayUnitSuffix()}`,
      chartLabel: [`${durationDisplayValue(min)}–${durationDisplayValue(max)}`, durationDisplayUnitLabel()],
      min,
      max,
    };
  });
}

function sessAnaCategoryColor(category) {
  if (category === '普通专注') return getSystemSeriesColor('taskTotal');
  return getSpecialSeriesColor(String(category || '').replace(/^🧩\s*/, '') || '特殊时段');
}

function sessAnaTrendMetricMinutes(sess) {
  return isUnavailableSession(sess)
    ? Math.max(0, sessionClock(sess))
    : Math.max(0, Number(sess.actualMinutes) || 0);
}

function sessAnaDurationMetricMinutes(sess, basis) {
  if (basis === 'clock') return Math.max(0, sessionClock(sess));
  if (basis === 'nominal') {
    if (sess.nominalMinutes == null || sess.nominalMinutes === '') return null;
    const value = Number(sess.nominalMinutes);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (basis === 'actual') {
    if (isUnavailableSession(sess) || sess.actualMinutes == null || sess.actualMinutes === '') return null;
    const value = Number(sess.actualMinutes);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}

function sessAnaCumulativeAverageData(dateStrs, categories, catMap) {
  return {
    dates: dateStrs,
    series: categories.map(category => {
      let total = 0;
      let activeDays = 0;
      return {
        category,
        values: dateStrs.map(dateStr => {
          if (chartDateStatus(dateStr) !== 'recorded') return null;
          const row = catMap[category]?.[dateStr];
          if (row) {
            total += row.metric;
            activeDays += 1;
          }
          return activeDays ? durationDisplayValue(total / activeDays) : null;
        }),
      };
    }),
  };
}

function sessAnaDurationStats(records, categories, basis, binSize) {
  const valid = records.map(record => ({ ...record, duration: sessAnaDurationMetricMinutes(record.session, basis) }))
    .filter(record => record.duration != null && record.duration > 0);
  const bins = sessAnaBuildDurationBins(valid, binSize);
  const rows = categories.map(category => {
    const categoryRecords = valid.filter(record => record.category === category);
    const counts = Object.fromEntries(bins.map(bin => [bin.key, categoryRecords.filter(record => record.duration > bin.min && record.duration <= bin.max).length]));
    return { category, validCount: categoryRecords.length, counts };
  }).filter(row => row.validCount > 0);
  return { validCount: valid.length, rows, bins, binSize: sessAnaNormalizeDurationBinSize(binSize) };
}

function sessAnaEncodedValue(value) {
  return encodeURIComponent(String(value || '')).replace(/'/g, '%27');
}

function sessAnaLegendHtml(categories) {
  if (!categories.length) return '';
  return `<div class="sess-analysis-legend">
    <div class="sess-analysis-legend-items">${categories.map(category => {
      const encoded = sessAnaEncodedValue(category);
      const hidden = state.sessAna.hiddenSeries.includes(category);
      return `<button type="button" class="sess-analysis-legend-key${hidden ? ' hidden' : ''}" data-sess-series="${encoded}" onclick="sessAnaToggleSeries(decodeURIComponent('${encoded}'))"><i style="--series-color:${sessAnaCategoryColor(category)}"></i><span>${escHtmlApp(category)}</span></button>`;
    }).join('')}</div>
    <button type="button" class="btn btn-ghost btn-sm" onclick="sessAnaShowAllSeries()">全部显示</button>
  </div>`;
}

function sessAnaDurationPanelHtml(stats) {
  const s = state.sessAna;
  const basisLabels = { clock: '时钟时长', nominal: '名义时长', actual: '实际时长' };
  const categories = stats.rows.map(row => row.category);
  if (!categories.includes(s.durationCategory)) s.durationCategory = categories[0] || '';
  const selected = stats.rows.find(row => row.category === s.durationCategory) || null;
  const categoryTabs = stats.rows.map(row => {
    const encoded = sessAnaEncodedValue(row.category);
    return `<button type="button" class="sess-duration-category${s.durationCategory === row.category ? ' active' : ''}" style="--series-color:${sessAnaCategoryColor(row.category)}" onclick="selectSessAnaDurationCategory(decodeURIComponent('${encoded}'))"><i></i><span>${escHtmlApp(row.category)}</span><small>${row.validCount} 段</small></button>`;
  }).join('');
  const dominantBin = selected && stats.bins.length ? stats.bins.reduce((best, bin) => (selected.counts[bin.key] || 0) > (selected.counts[best.key] || 0) ? bin : best, stats.bins[0]) : null;
  return `<section class="sess-analysis-panel sess-duration-panel">
    <div class="sess-analysis-panel-head">
      <div><div class="sess-analysis-eyebrow">DURATION DISTRIBUTION</div><h3>时段长度分布</h3><p>通过滑动条调整每个时长区间的宽度；区间采用左开右闭口径。</p></div>
      <div class="sess-analysis-tabs sess-duration-basis" aria-label="时长统计口径">
        ${Object.entries(basisLabels).map(([basis, label]) => `<button type="button" class="${s.durationBasis === basis ? 'active' : ''}" onclick="switchSessAnaDurationBasis('${basis}')">${label}</button>`).join('')}
      </div>
    </div>
    ${stats.validCount ? `<div class="sess-duration-scale-control">
        <div class="sess-duration-scale-head"><span>区间宽度</span><output id="sess-duration-bin-output">${fmtMin(stats.binSize, true)} / 格</output></div>
        <input type="range" min="${SESS_ANA_DURATION_BIN_MIN}" max="${SESS_ANA_DURATION_BIN_MAX}" step="${SESS_ANA_DURATION_BIN_STEP}" value="${stats.binSize}" aria-label="时段长度区间宽度" oninput="previewSessAnaDurationBinSize(this.value)" onchange="setSessAnaDurationBinSize(this.value)">
        <div class="sess-duration-scale-labels"><span>${fmtMin(15, true)} · 精细</span><span>${fmtMin(120, true)} · 宽泛</span></div>
      </div>
      <div class="sess-duration-category-tabs" aria-label="选择时段类别">${categoryTabs}</div>
      <div class="sess-duration-chart-head"><span><b>${selected ? escHtmlApp(selected.category) : '-'}</b> 的时长区间分布</span><small>${selected ? `${selected.validCount} 个有效时段 · 最集中于${dominantBin.label}` : ''}</small></div>
      <div class="sess-duration-chart"><canvas id="sessAnaDurationChart"></canvas></div>` : `<div class="sess-analysis-empty compact"><b>当前口径没有可统计的时段</b><span>可以切换到时钟时长，或选择包含名义、实际记录的日期范围。</span></div>`}
  </section>`;
}

function renderSessAnalysisKpiStatus(dateStrs, filter = '', typeFilter = '') {
  const rows = dateStrs.map(dateStr => {
    const row = {
      dateStr,
      count: 0,
      clockMin: 0,
      effectiveClockMin: 0,
      nominalMin: 0,
      actualMin: 0,
      restMin: 0,
      distractMin: 0,
      unavailableMin: 0,
      specialStudyActualMin: 0,
    };
    (getDay(dateStr).sessions || []).forEach(sess => {
      if (typeFilter && sessAnaSessionTypeKey(sess) !== typeFilter) return;
      if (filter && sessAnaSessionCategory(sess) !== filter) return;
      const clock = sessionClock(sess);
      const nominal = Number(sess.nominalMinutes) || 0;
      const actual = Number(sess.actualMinutes) || 0;
      const rest = Number(sess.restMinutes) || 0;
      row.count += 1;
      row.clockMin += clock;
      row.nominalMin += nominal;
      row.actualMin += actual;
      row.restMin += rest;
      if (isUnavailableSession(sess)) {
        row.unavailableMin += clock;
      } else if (isSpecialStudySession(sess)) {
        row.effectiveClockMin += actual;
        row.unavailableMin += Math.max(0, clock - actual);
        row.specialStudyActualMin += actual;
      } else {
        row.effectiveClockMin += Math.max(0, clock - rest);
        row.distractMin += Math.max(0, clock - rest - actual);
      }
    });
    return row;
  });
  const activeRows = rows.filter(row => row.count > 0);
  const activeCount = activeRows.length;
  const sum = key => activeRows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const totalCount = sum('count');
  const totalClock = sum('clockMin');
  const totalEffectiveClock = sum('effectiveClockMin');
  const totalActual = sum('actualMin');
  const pct = totalEffectiveClock > 0 ? Math.round(totalActual / totalEffectiveClock * 100) : null;
  const primary = [
    ['实际专注', fmtHrs(totalActual), pct != null ? `有效时钟利用 ${pct}%` : '暂无有效时钟'],
    ['有效时钟', fmtHrs(totalEffectiveClock), activeCount ? `日均 ${fmtMin(Math.round(totalEffectiveClock / activeCount), true)}` : '-'],
    ['时段数量', `${totalCount} 段`, activeCount ? `记录日均 ${(totalCount / activeCount).toFixed(1)} 段` : '-'],
    ['有效记录天', `${activeCount} 天`, `${dateStrs.length} 天范围${filter ? ` · ${filter}` : ''}`],
  ];
  const secondary = [
    ['时钟', fmtHrs(totalClock)],
    ['名义', fmtHrs(sum('nominalMin'))],
    ['休息', fmtHrs(sum('restMin'))],
    ['分心', fmtHrs(sum('distractMin'))],
    ['不可用', fmtHrs(sum('unavailableMin'))],
    ['特殊学习', fmtHrs(sum('specialStudyActualMin'))],
    ['每段平均', totalCount ? fmtMin(Math.round(totalClock / totalCount), true) : '-'],
  ];
  return `<section class="sess-analysis-summary">
    <div class="sess-analysis-primary-grid">${primary.map(([label, value, sub], index) => `<article class="sess-analysis-primary-card tone-${index + 1}"><span>${label}</span><b>${value}</b><small>${sub}</small></article>`).join('')}</div>
    <div class="sess-analysis-secondary-strip">${secondary.map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join('')}</div>
  </section>`;
}

function sessAnaRecordDetailHtml(records) {
  const s = state.sessAna;
  const categories = [...new Set(records.map(record => record.category))]
    .sort((a, b) => a === '普通专注' ? -1 : b === '普通专注' ? 1 : a.localeCompare(b));
  if (s.detailCategory && !categories.includes(s.detailCategory)) s.detailCategory = '';
  const selectedCategory = s.detailCategory || '';
  const visibleRecords = records
    .filter(record => !selectedCategory || record.category === selectedCategory)
    .slice()
    .sort((a, b) => b.dateStr.localeCompare(a.dateStr) || a.sourceIndex - b.sourceIndex);
  const categoryCounts = records.reduce((counts, record) => {
    counts.set(record.category, (counts.get(record.category) || 0) + 1);
    return counts;
  }, new Map());
  const categoryButtons = categories.map(category => {
    const encoded = sessAnaEncodedValue(category);
    return `<button type="button" class="sess-record-category${selectedCategory === category ? ' active' : ''}" style="--series-color:${sessAnaCategoryColor(category)}" onclick="sessAnaSetDetailCategory(decodeURIComponent('${encoded}'))"><i></i><span>${escHtmlApp(category)}</span><b>${categoryCounts.get(category)}</b></button>`;
  }).join('');
  const rows = visibleRecords.map((record, rowIndex) => {
    const sess = record.session;
    const unavailable = isUnavailableSession(sess);
    const specialStudy = isSpecialStudySession(sess);
    const clock = sessionClock(sess);
    const nominal = Math.max(0, Number(sess.nominalMinutes) || 0);
    const actual = Math.max(0, Number(sess.actualMinutes) || 0);
    const rest = Math.max(0, Number(sess.restMinutes) || 0);
    const effective = specialStudy ? actual : Math.max(0, clock - rest);
    const efficiency = unavailable || effective <= 0 ? null : Math.round(actual / effective * 100);
    const typeLabel = unavailable ? '不可用' : specialStudy ? '特殊学习' : '普通专注';
    const typeClass = unavailable ? 'unavailable' : specialStudy ? 'special-study' : 'normal';
    const encodedDate = sessAnaEncodedValue(record.dateStr);
    const encodedId = sess.id ? sessAnaEncodedValue(sess.id) : '';
    const editAction = sess.id
      ? `onclick="sessAnaOpenSession(decodeURIComponent('${encodedDate}'),decodeURIComponent('${encodedId}'))"`
      : 'disabled title="该历史记录缺少ID，无法直接编辑"';
    const categoryCell = sess.id
      ? `<button type="button" class="sess-record-name" ${editAction}><i style="--series-color:${sessAnaCategoryColor(record.category)}"></i>${escHtmlApp(record.category)}</button>`
      : `<span class="sess-record-name disabled"><i style="--series-color:${sessAnaCategoryColor(record.category)}"></i>${escHtmlApp(record.category)}</span>`;
    return `<tr ${sortableTableRowAttrs({
      date: record.dateStr,
      timeRange: parseMin(sess.startTime) == null || parseMin(sess.endTime) == null
        ? null
        : [parseMin(sess.startTime), parseMin(sess.endTime)],
      clock,
      nominal: unavailable || specialStudy ? null : nominal,
      actual: unavailable ? null : actual,
      rest: unavailable || specialStudy ? null : rest,
      efficiency,
    }, rowIndex)}>
      <td class="fw-mono sess-record-date">${formatShort(record.dateStr)}</td>
      <td><span class="sess-record-type ${typeClass}">${typeLabel}</span></td>
      <td>${categoryCell}</td>
      <td class="fw-mono sess-record-time">${sess.startTime || '-'} <span>至</span> ${sess.endTime || '-'}</td>
      <td class="fw-mono c-clock">${fmtMin(clock, true)}</td>
      <td class="fw-mono c-nominal">${unavailable || specialStudy ? '-' : fmtMin(nominal, true)}</td>
      <td class="fw-mono c-actual">${unavailable ? '-' : fmtMin(actual, true)}</td>
      <td class="fw-mono">${unavailable || specialStudy ? '-' : fmtMin(rest, true)}</td>
      <td class="fw-mono c-actual">${efficiency == null ? '-' : `${efficiency}%`}</td>
      <td class="sess-record-note" title="${escHtmlApp(sess.note || '')}">${escHtmlApp(sess.note || '-')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" ${editAction}>编辑</button></td>
    </tr>`;
  }).join('');
  return `<section class="sess-record-detail-panel" data-render-panel="sess-records">
    <div class="sess-record-detail-head">
      <div><div class="sess-analysis-eyebrow">SESSION RECORDS</div><h3>时段记录明细</h3><p>逐条查看当前范围内的原始时段，并可直接进入录入页修改。</p></div>
      <span>${visibleRecords.length} / ${records.length} 段</span>
    </div>
    <div class="sess-record-categories">
      <button type="button" class="sess-record-category${selectedCategory ? '' : ' active'}" onclick="sessAnaSetDetailCategory('')"><span>全部时段</span><b>${records.length}</b></button>
      ${categoryButtons}
    </div>
    <div class="sess-record-table-wrap"><table class="sess-record-table" data-sort-table="sess-records">
      <thead><tr>${sortableTableHeaderHtml('sess-records', 'date', '日期', 'date')}<th>类型</th><th>时段类别</th>${sortableTableHeaderHtml('sess-records', 'timeRange', '起止时间', 'time')}${sortableTableHeaderHtml('sess-records', 'clock', '时钟')}${sortableTableHeaderHtml('sess-records', 'nominal', '名义')}${sortableTableHeaderHtml('sess-records', 'actual', '实际')}${sortableTableHeaderHtml('sess-records', 'rest', '休息')}${sortableTableHeaderHtml('sess-records', 'efficiency', '效率')}<th>备注</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function renderSessAnalysis() {
  const s = state.sessAna;
  if (!['daily', 'cumulativeAverage'].includes(s.trendView)) s.trendView = 'daily';
  if (!['clock', 'nominal', 'actual'].includes(s.durationBasis)) s.durationBasis = 'clock';
  if (!['', 'normal', 'special', 'special-study'].includes(s.typeFilter)) s.typeFilter = '';
  if (typeof s.durationCategory !== 'string') s.durationCategory = '';
  s.durationBinSize = sessAnaNormalizeDurationBinSize(s.durationBinSize);
  if (!Array.isArray(s.hiddenSeries)) s.hiddenSeries = [];
  const sharedRange = analysisRangeMeta('session');
  const dateStrs = sharedRange.analysisDates;
  s.mode = dateStrs.length <= 7 ? 'week' : dateStrs.length > 90 ? 'all' : 'month';
  const rangeLabel = sharedRange.label;

  // 收集每天的 session 分类数据
  // 分类：特殊时段按 name 分组，普通时段归为"普通专注"
  const catMap = {}; // { catName: { dateStr: aggregated metrics } }
  const allSessionRecords = [];
  const catKinds = {};
  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.sessions || []).forEach((sess, sourceIndex) => {
      const clk = sessionClock(sess);
      const nom = Number(sess.nominalMinutes) || 0;
      const act = Number(sess.actualMinutes) || 0;
      const rst = Number(sess.restMinutes) || 0;
      const cat = sessAnaSessionCategory(sess);
      const kind = isUnavailableSession(sess) ? 'unavailable' : isSpecialStudySession(sess) ? 'special-study' : 'normal';
      catKinds[cat] = kind;
      allSessionRecords.push({ dateStr: ds, category: cat, type: sessAnaSessionTypeKey(sess), session: sess, sourceIndex });
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][ds]) catMap[cat][ds] = { clock: 0, nominal: 0, actual: 0, rest: 0, count: 0, metric: 0 };
      catMap[cat][ds].clock += clk;
      catMap[cat][ds].nominal += nom;
      catMap[cat][ds].actual += act;
      catMap[cat][ds].rest += rst;
      catMap[cat][ds].metric += sessAnaTrendMetricMinutes(sess);
      catMap[cat][ds].count++;
    });
  });

  const allCats = Object.keys(catMap).sort((a, b) => a === '普通专注' ? -1 : b === '普通专注' ? 1 : a.localeCompare(b));
  const sessTypeFilter = s.typeFilter || '';
  const typeCats = sessTypeFilter
    ? allCats.filter(category => allSessionRecords.some(record => record.type === sessTypeFilter && record.category === category))
    : allCats;
  if (s.catFilter && !typeCats.includes(s.catFilter)) s.catFilter = '';
  const sessCatFilter = s.catFilter || '';
  const cats = sessCatFilter ? [sessCatFilter] : typeCats;
  const typeVisibleSessionRecords = sessTypeFilter
    ? allSessionRecords.filter(record => record.type === sessTypeFilter)
    : allSessionRecords;
  const visibleSessionRecords = sessCatFilter
    ? typeVisibleSessionRecords.filter(record => record.category === sessCatFilter)
    : typeVisibleSessionRecords;
  s._detailRecords = visibleSessionRecords;
  const daysWithSess = dateStrs.filter(ds => visibleSessionRecords.some(record => record.dateStr === ds)).length;
  // 趋势图横轴只展示当前可见类别实际有记录的日期。
  // 未筛选类别时这是各类别日期的并集；筛选单个类别时则只保留该类别日期。
  const trendDateStrs = dateStrs.filter(ds => visibleSessionRecords.some(record => record.dateStr === ds));
  const trendLabels = trendDateStrs.map(formatShort);

  // 每日折线图 datasets — 根据筛选决定显示方式
  let sessChartLabels, sessDayDS;
  if (s.trendView === 'cumulativeAverage') {
    const cumulative = sessAnaCumulativeAverageData(trendDateStrs, cats, catMap);
    sessChartLabels = cumulative.dates.map(formatShort);
    sessDayDS = cumulative.series.map(item => {
      const hex = sessAnaCategoryColor(item.category);
      return {
        label: item.category,
        seriesKey: item.category,
        data: item.values,
        borderColor: hex,
        backgroundColor: hex,
        borderWidth: 2.2,
        pointRadius: item.values.length > 60 ? 1.5 : 3.5,
        pointHoverRadius: 5,
        pointBackgroundColor: hex,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        tension: .16,
        fill: false,
        spanGaps: false,
        hidden: s.hiddenSeries.includes(item.category),
      };
    });
  } else if (sessCatFilter && catMap[sessCatFilter]) {
    sessChartLabels = trendLabels;
    const hex = sessAnaCategoryColor(sessCatFilter);
    sessDayDS = [{
      label: sessCatFilter,
      seriesKey: sessCatFilter,
      data: trendDateStrs.map(ds => durationDisplayValue(catMap[sessCatFilter][ds]?.metric || 0)),
      borderColor: hex,
      backgroundColor: hex,
      borderWidth: 2.2,
      pointRadius: dateStrs.length > 60 ? 1.5 : 4,
      pointHoverRadius: 5,
      pointBackgroundColor: hex,
      pointBorderColor: '#07111f',
      pointBorderWidth: 1.5,
      tension: .16,
      fill: false,
      hidden: s.hiddenSeries.includes(sessCatFilter),
    }];
  } else {
    sessChartLabels = trendLabels;
    sessDayDS = cats.map(cat => {
      const hex = sessAnaCategoryColor(cat);
      return {
        label: cat,
        seriesKey: cat,
        data: trendDateStrs.map(ds => durationDisplayValue(catMap[cat][ds]?.metric || 0)),
        borderColor: hex,
        backgroundColor: hex,
        borderWidth: 2,
        pointRadius: dateStrs.length > 60 ? 1.5 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: hex,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        tension: .16,
        fill: false,
        hidden: s.hiddenSeries.includes(cat),
      };
    });
  }
  s._trendContext = { dateStrs: [...trendDateStrs], cats: [...cats], catMap, sessCatFilter };

  // 每类别汇总
  const catStats = cats.map(cat => {
    let count = 0, clock = 0, nominal = 0, actual = 0, rest = 0, metric = 0;
    Object.values(catMap[cat]).forEach(v => { count += v.count; clock += v.clock; nominal += v.nominal; actual += v.actual; rest += v.rest; metric += v.metric; });
    const isSpecial = catKinds[cat] === 'unavailable';
    const effective = catKinds[cat] === 'special-study' ? actual : Math.max(0, clock - rest);
    const effCat = !isSpecial && effective > 0 ? Math.round(actual / effective * 100) : null;
    const categoryDays = Object.keys(catMap[cat]).length;
    const avgPerDay = categoryDays > 0 ? Math.round(metric / categoryDays) : 0;
    // 每天该类别的 metric 值数组（用于算 CV）
    const dailyVals = dateStrs.map(ds => {
      const d = catMap[cat][ds];
      if (!d) return 0;
      return d.metric;
    });
    const stats = calcStats(dailyVals);
    return { cat, count, clock, nominal, actual, rest, eff: effCat, isSpecial, avgAct: count > 0 ? Math.round(metric / count) : 0, avgPerDay, cv: stats.cv, stdDev: stats.stdDev };
  });
  const displayTotals = visibleSessionRecords.reduce((totals, record) => {
    const sess = record.session;
    const clock = sessionClock(sess);
    const actual = Math.max(0, Number(sess.actualMinutes) || 0);
    const rest = Math.max(0, Number(sess.restMinutes) || 0);
    totals.clock += clock;
    totals.nominal += Math.max(0, Number(sess.nominalMinutes) || 0);
    totals.actual += actual;
    totals.rest += rest;
    totals.effective += isUnavailableSession(sess) ? 0 : isSpecialStudySession(sess) ? actual : Math.max(0, clock - rest);
    return totals;
  }, { clock: 0, nominal: 0, actual: 0, rest: 0, effective: 0 });
  const durationStats = sessAnaDurationStats(visibleSessionRecords, cats, s.durationBasis, s.durationBinSize);
  const heroRange = !sharedRange.baseDates.length ? '暂无历史时段记录' : rangeLabel;

  document.getElementById('tab-sessAnalysis').innerHTML = `<div class="session-analysis-page">
    <section class="session-analysis-hero">
      <div class="session-analysis-hero-copy"><div class="sess-analysis-eyebrow">SESSION ANALYTICS</div><h2>时段分析</h2><p>${heroRange} · ${sessAnaSessionTypeLabel(sessTypeFilter)}${sessCatFilter ? ` · 当前类别：${escHtmlApp(sessCatFilter)}` : ' · 全部时段类别'}</p></div>
      <div class="session-analysis-hero-stats">
        <div><span>有效记录</span><b>${daysWithSess} 天</b></div>
        <div><span>时段总数</span><b>${visibleSessionRecords.length} 段</b></div>
        <div><span>实际专注</span><b>${fmtHrs(displayTotals.actual)}</b></div>
      </div>
    </section>

    ${analysisRangePlannerHtml('session', sharedRange)}

    <section class="sess-analysis-toolbar">
      <label class="sess-analysis-filter sess-analysis-type-filter"><span>时段类型</span><select onchange="sessAnaNav('typeFilter',this.value)">
        <option value="" ${sessTypeFilter ? '' : 'selected'}>全部类型 (${allSessionRecords.length})</option>
        ${[['normal', '普通时段'], ['special', '特殊时段'], ['special-study', '特殊学习时段']].map(([value, label]) => `<option value="${value}" ${sessTypeFilter === value ? 'selected' : ''}>${label} (${allSessionRecords.filter(record => record.type === value).length})</option>`).join('')}
      </select></label>
      <label class="sess-analysis-filter"><span>时段类别</span><select onchange="sessAnaNav('catFilter',this.value)"><option value="">全部类别 (${typeCats.length})</option>${typeCats.map(category => `<option value="${escHtmlApp(category)}" ${sessCatFilter === category ? 'selected' : ''}>${escHtmlApp(category)}</option>`).join('')}</select></label>
    </section>

    ${visibleSessionRecords.length ? `
      ${renderSessAnalysisKpiStatus(dateStrs, sessCatFilter, sessTypeFilter)}
      <section class="sess-analysis-panel sess-analysis-trend-panel">
        <div class="sess-analysis-panel-head"><div><div class="sess-analysis-eyebrow">FOCUS TREND</div><h3>每日专注时长趋势</h3><p id="sess-analysis-trend-note">${s.trendView === 'daily' ? '查看每天的类别时长；普通专注和特殊学习使用实际时长，不可用时段使用时钟时长。' : '查看截至当天的累计类别时长 ÷ 该类别有效记录天数。'}</p></div>
          <div class="sess-analysis-tabs sess-analysis-trend-tabs"><button type="button" class="${s.trendView === 'daily' ? 'active' : ''}" data-sess-trend-view="daily" onclick="switchSessAnaTrendView('daily')">每日趋势</button><button type="button" class="${s.trendView === 'cumulativeAverage' ? 'active' : ''}" data-sess-trend-view="cumulativeAverage" onclick="switchSessAnaTrendView('cumulativeAverage')">累计平均</button></div>
        </div>
        ${sessAnaLegendHtml(cats)}
        <div class="sess-analysis-chart-stage"><canvas id="sessAnaDailyChart"></canvas></div>
      </section>
      <div id="sess-analysis-duration-host">${sessAnaDurationPanelHtml(durationStats)}</div>
      <details class="sess-analysis-detail-panel">
        <summary><span><b>类别汇总明细</b><small>${cats.length} 个类别 · ${visibleSessionRecords.length} 个时段${sessCatFilter ? ` · ${escHtmlApp(sessCatFilter)}` : ''}</small></span><span>展开</span></summary>
        <div class="sess-analysis-table-wrap"><table class="sess-analysis-table" data-sort-table="sess-category-summary">
          <thead><tr><th>类别</th>${sortableTableHeaderHtml('sess-category-summary', 'count', '时段数')}${sortableTableHeaderHtml('sess-category-summary', 'clock', `时钟${tipIcon('clock')}`)}${sortableTableHeaderHtml('sess-category-summary', 'nominal', `名义${tipIcon('nominal')}`)}${sortableTableHeaderHtml('sess-category-summary', 'actual', `实际${tipIcon('actual')}`)}${sortableTableHeaderHtml('sess-category-summary', 'rest', `休息${tipIcon('rest')}`)}${sortableTableHeaderHtml('sess-category-summary', 'efficiency', `效率${tipIcon('efficiency')}`)}${sortableTableHeaderHtml('sess-category-summary', 'average', '每段平均')}${sortableTableHeaderHtml('sess-category-summary', 'daily', '日均')}${sortableTableHeaderHtml('sess-category-summary', 'cv', `CV${tipIcon('cv')}`)}</tr></thead>
          <tbody>${catStats.map((c, rowIndex) => `<tr ${sortableTableRowAttrs({ count: c.count, clock: c.clock, nominal: c.nominal, actual: c.actual, rest: c.rest, efficiency: c.eff, average: c.avgAct, daily: c.avgPerDay, cv: c.cv }, rowIndex)}><td><i style="--series-color:${sessAnaCategoryColor(c.cat)}"></i>${escHtmlApp(c.cat)}</td><td class="fw-mono">${c.count}</td><td class="fw-mono c-clock">${fmtMin(c.clock, true)}</td><td class="fw-mono c-nominal">${fmtMin(c.nominal, true)}</td><td class="fw-mono c-actual">${fmtMin(c.actual, true)}</td><td class="fw-mono">${fmtMin(c.rest, true)}</td><td class="fw-mono c-actual">${c.eff != null ? `${c.eff}%` : '-'}</td><td class="fw-mono">${fmtMin(c.avgAct)}</td><td class="fw-mono c-muted">${fmtMin(c.avgPerDay)}</td><td class="fw-mono c-muted">${fmtCV(c.cv)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>合计</td><td>${visibleSessionRecords.length}</td><td>${fmtMin(displayTotals.clock, true)}</td><td>${fmtMin(displayTotals.nominal, true)}</td><td>${fmtMin(displayTotals.actual, true)}</td><td>${fmtMin(displayTotals.rest, true)}</td><td>${displayTotals.effective ? `${Math.round(displayTotals.actual / displayTotals.effective * 100)}%` : '-'}</td><td></td><td>${daysWithSess ? fmtMin(Math.round(displayTotals.actual / daysWithSess)) : '-'}</td><td></td></tr></tfoot>
        </table></div>
      </details>
      ${sessAnaRecordDetailHtml(visibleSessionRecords)}
    ` : `<div class="sess-analysis-empty"><b>当前范围没有时段记录</b><span>可以切换时间范围或类别，也可以先在录入页添加专注时段。</span></div>`}
  </div>`;

  if (!visibleSessionRecords.length) return;
  renderSessAnaTrendChart(sessChartLabels, sessDayDS, trendDateStrs);
  renderSessAnaDurationChart(durationStats);
}

function renderSessAnaTrendChart(labels, datasets, dateStrs = []) {
  if (!document.getElementById('sessAnaDailyChart')) return;
  const s = state.sessAna;
  mkChart('sessAnaDailyChart', {
    type: 'line', data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => { const value = ctx.parsed.y; return value == null ? null : `${ctx.dataset.label}: ${fmtMin(Math.round(durationDisplayValueToMinutes(value)))}`; } } },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'week' ? 0 : 35, autoSkip: true, maxTicksLimit: s.mode === 'all' ? 24 : undefined }, grid: { display: false } },
        y: { ticks: { color: '#6b7a9e', callback: value => `${value}${durationDisplayUnitSuffix()}` }, grid: { color: 'rgba(107,122,158,.12)', drawBorder: false }, min: 0, title: { display: true, text: s.trendView === 'daily' ? `每日时长（${durationDisplayUnitLabel()}）` : `累计日均时长（${durationDisplayUnitLabel()}）`, color: '#6b7a9e' } },
      },
    },
    plugins: [noRecordRegionPlugin(dateStrs)],
  });
}

function sessAnaTrendDataForView(context, view) {
  const { dateStrs, cats, catMap, sessCatFilter } = context;
  const makeDataset = (category, values) => {
    const color = sessAnaCategoryColor(category);
    return {
      label: category,
      seriesKey: category,
      data: values,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.2,
      pointRadius: values.length > 60 ? 1.5 : 3.5,
      pointHoverRadius: 5,
      pointBackgroundColor: color,
      pointBorderColor: '#07111f',
      pointBorderWidth: 1.5,
      tension: .16,
      fill: false,
      spanGaps: false,
      hidden: state.sessAna.hiddenSeries.includes(category),
    };
  };
  if (view === 'cumulativeAverage') {
    const cumulative = sessAnaCumulativeAverageData(dateStrs, cats, catMap);
    return { labels: cumulative.dates.map(formatShort), datasets: cumulative.series.map(item => makeDataset(item.category, item.values)) };
  }
  if (sessCatFilter && catMap[sessCatFilter]) {
    const values = dateStrs.map(dateStr => durationDisplayValue(catMap[sessCatFilter][dateStr]?.metric || 0));
    return { labels: dateStrs.map(formatShort), datasets: [makeDataset(sessCatFilter, chartMaskRecordedValues(dateStrs, values))] };
  }
  return {
    labels: dateStrs.map(formatShort),
    datasets: cats.map(category => makeDataset(
      category,
      chartMaskRecordedValues(dateStrs, dateStrs.map(dateStr => durationDisplayValue(catMap[category][dateStr]?.metric || 0)))
    )),
  };
}

function renderSessAnaDurationChart(stats) {
  const canvas = document.getElementById('sessAnaDurationChart');
  if (!canvas || !stats?.validCount) return;
  const selected = stats.rows.find(row => row.category === state.sessAna.durationCategory) || stats.rows[0];
  if (!selected) return;
  const color = sessAnaCategoryColor(selected.category);
  mkChart('sessAnaDurationChart', {
    type: 'line',
    data: {
      labels: stats.bins.map(bin => bin.chartLabel),
      datasets: [{
        label: selected.category,
        data: stats.bins.map(bin => selected.counts[bin.key] || 0),
        borderColor: color,
        backgroundColor: `${color}1f`,
        pointBackgroundColor: color,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        pointRadius: 4.5,
        pointHoverRadius: 6,
        borderWidth: 2.3,
        tension: .18,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: contexts => stats.bins[contexts[0]?.dataIndex]?.label || '', label: context => {
          const count = Number(context.parsed.y) || 0;
          const pct = selected.validCount ? count / selected.validCount * 100 : 0;
          return `${count} 段 · 占该类别 ${pct.toFixed(1)}%`;
        } } },
      },
      scales: {
        x: { ticks: { color: '#a8b5d0', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false }, title: { display: true, text: `单条时段长度区间（每格${fmtMin(stats.binSize, true)}）`, color: '#6b7a9e' } },
        y: { beginAtZero: true, ticks: { color: '#6b7a9e', precision: 0 }, grid: { color: 'rgba(107,122,158,.12)', drawBorder: false }, title: { display: true, text: '时段数', color: '#6b7a9e' } },
      },
    },
  });
}

function sessAnaCurrentDurationContext() {
  const records = [];
  sessAnaGetDates().forEach(dateStr => {
    (getDay(dateStr).sessions || []).forEach(session => records.push({ dateStr, category: sessAnaSessionCategory(session), session }));
  });
  const typeVisible = state.sessAna.typeFilter
    ? records.filter(record => sessAnaSessionTypeKey(record.session) === state.sessAna.typeFilter)
    : records;
  const visible = state.sessAna.catFilter ? typeVisible.filter(record => record.category === state.sessAna.catFilter) : typeVisible;
  const categories = [...new Set(visible.map(record => record.category))].sort((a, b) => a === '普通专注' ? -1 : b === '普通专注' ? 1 : a.localeCompare(b));
  return { records: visible, categories };
}

function rerenderSessAnaDurationPanel() {
  const host = document.getElementById('sess-analysis-duration-host');
  if (!host) return;
  const context = sessAnaCurrentDurationContext();
  const stats = sessAnaDurationStats(context.records, context.categories, state.sessAna.durationBasis, state.sessAna.durationBinSize);
  host.innerHTML = sessAnaDurationPanelHtml(stats);
  requestAnimationFrame(() => renderSessAnaDurationChart(stats));
}

function switchSessAnaTrendView(view) {
  if (!['daily', 'cumulativeAverage'].includes(view)) return;
  state.sessAna.trendView = view;
  document.querySelectorAll('[data-sess-trend-view]').forEach(button => button.classList.toggle('active', button.dataset.sessTrendView === view));
  const note = document.getElementById('sess-analysis-trend-note');
  if (note) note.textContent = view === 'daily'
    ? '查看每天的类别时长；普通专注和特殊学习使用实际时长，不可用时段使用时钟时长。'
    : '查看截至当天的累计类别时长 ÷ 该类别有效记录天数。';
  const context = state.sessAna._trendContext;
  if (!context) return renderSessAnalysis();
  const chartData = sessAnaTrendDataForView(context, view);
  renderSessAnaTrendChart(chartData.labels, chartData.datasets, context.dateStrs);
}

function switchSessAnaDurationBasis(basis) {
  if (!['clock', 'nominal', 'actual'].includes(basis)) return;
  state.sessAna.durationBasis = basis;
  rerenderSessAnaDurationPanel();
}

function previewSessAnaDurationBinSize(value) {
  const output = document.getElementById('sess-duration-bin-output');
  if (output) output.textContent = `${fmtMin(sessAnaNormalizeDurationBinSize(value), true)} / 格`;
}

function setSessAnaDurationBinSize(value) {
  state.sessAna.durationBinSize = sessAnaNormalizeDurationBinSize(value);
  rerenderSessAnaDurationPanel();
}

function selectSessAnaDurationCategory(category) {
  if (!category) return;
  state.sessAna.durationCategory = category;
  rerenderSessAnaDurationPanel();
}

function sessAnaToggleSeries(category) {
  const hidden = state.sessAna.hiddenSeries;
  const index = hidden.indexOf(category);
  if (index >= 0) hidden.splice(index, 1);
  else hidden.push(category);
  const chart = chartReg.sessAnaDailyChart;
  if (chart) {
    const datasetIndex = chart.data.datasets.findIndex(dataset => dataset.seriesKey === category);
    if (datasetIndex >= 0) {
      chart.setDatasetVisibility(datasetIndex, index >= 0);
      chart.update();
    }
  }
  const encoded = sessAnaEncodedValue(category);
  document.querySelectorAll('[data-sess-series]').forEach(button => {
    if (button.dataset.sessSeries === encoded) button.classList.toggle('hidden', index < 0);
  });
}

function sessAnaShowAllSeries() {
  state.sessAna.hiddenSeries = [];
  const chart = chartReg.sessAnaDailyChart;
  if (chart) {
    chart.data.datasets.forEach((dataset, index) => chart.setDatasetVisibility(index, true));
    chart.update();
  }
  document.querySelectorAll('[data-sess-series]').forEach(button => button.classList.remove('hidden'));
}

function sessAnaSetDetailCategory(category) {
  state.sessAna.detailCategory = category || '';
  const host = document.getElementById('tab-sessAnalysis');
  const records = Array.isArray(state.sessAna._detailRecords) ? state.sessAna._detailRecords : [];
  const html = sessAnaRecordDetailHtml(records);
  if (!replaceRenderPanels(host, html, 'sess-records')) renderSessAnalysis();
}

function sessAnaOpenSession(dateStr, sessionId) {
  if (!dateStr || !sessionId) return;
  monthEditSession(dateStr, sessionId);
}

function sessAnaNav(action, val) {
  const s = state.sessAna;
  if (action === 'typeFilter') { s.typeFilter = val; s.catFilter = ''; }
  else if (action === 'catFilter') { s.catFilter = val; }
  else return;
  renderSessAnalysis();
}

// ============================================================
// TASK ANALYSIS TAB (任务记录分析)
// ============================================================
function taskAnaGetDates() {
  return analysisRangeMeta('task').analysisDates;
}

function taskAnaCumulativeCategoryData(dateStrs, categories, categoryMap, valueKey) {
  return {
    dates: dateStrs,
    series: categories.map(category => {
      let total = 0;
      let activeDays = 0;
      return {
        category,
        values: dateStrs.map(dateStr => {
          if (chartDateStatus(dateStr) !== 'recorded') return null;
          const row = categoryMap[category]?.[dateStr];
          if (row) {
            total += Math.max(0, Number(row[valueKey]) || 0);
            activeDays += 1;
          }
          return activeDays ? total / activeDays : null;
        }),
      };
    }),
  };
}

function taskAnaCumulativeDailyCount(dateStrs, taskRecords) {
  let total = 0;
  let activeDays = 0;
  return dateStrs.map(dateStr => {
    if (chartDateStatus(dateStr) !== 'recorded') return null;
    const count = taskRecords.filter(record => record.dateStr === dateStr).length;
    if (count > 0) {
      total += count;
      activeDays += 1;
    }
    return activeDays ? Number((total / activeDays).toFixed(2)) : null;
  });
}

function taskAnaLegendHtml(categories, group) {
  if (!categories.length) return '';
  const hidden = state.taskAna.hiddenSeries?.[group] || [];
  return `<div class="task-analysis-legend"><div class="task-analysis-legend-items">${categories.map(category => {
    const encoded = encodeURIComponent(category).replace(/'/g, '%27');
    return `<button type="button" class="task-analysis-legend-key${hidden.includes(category) ? ' hidden' : ''}" data-task-series-group="${group}" data-task-series="${encoded}" onclick="taskAnaToggleSeries('${group}',decodeURIComponent('${encoded}'))"><i style="--series-color:${getCategoryColor(category, group === 'efficiency' ? 3 : state.taskAna.level)}"></i><span>${escHtmlApp(category)}</span></button>`;
  }).join('')}</div><button type="button" class="btn btn-ghost btn-sm" onclick="taskAnaShowAllSeries('${group}')">全部显示</button></div>`;
}

function taskAnaCumulativeChapterValues(items, metric) {
  let totalMinutes = 0;
  let totalQuantity = 0;
  return items.map(item => {
    totalMinutes += Math.max(0, Number(item.minutes) || 0);
    totalQuantity += Math.max(0, Number(item.quantity) || 0);
    if (metric === 'quantityEfficiency') return totalMinutes > 0 ? totalQuantity / totalMinutes : null;
    return totalMinutes / Math.max(1, items.indexOf(item) + 1);
  });
}

const TASK_DISTRIBUTION_TARGET_BINS = [5, 7, 9, 12, 16];
const TASK_DISTRIBUTION_UNLABELED_UNIT = '__unlabeled__';

function taskAnaDistributionGranularity(value) {
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) ? Math.min(5, Math.max(1, numeric)) : 3;
}

function taskAnaDistributionUnitKey(task) {
  return visibleTaskQuantityUnit(task).trim() || TASK_DISTRIBUTION_UNLABELED_UNIT;
}

function taskAnaDistributionUnitLabel(unitKey) {
  return unitKey === TASK_DISTRIBUTION_UNLABELED_UNIT ? '未标单位' : unitKey;
}

function taskAnaDistributionNiceWidth(maxValue, targetBins, metric) {
  if (!(maxValue > 0)) return metric === 'efficiency' ? .001 : 1;
  const raw = maxValue / Math.max(1, targetBins);
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const fraction = raw / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  const minimum = metric === 'efficiency' ? .001 : 1;
  return Math.max(minimum, niceFraction * magnitude);
}

function taskAnaDistributionNumber(value, width, maximumDigits = 3) {
  const magnitude = Math.abs(width);
  const digits = magnitude >= 1 ? 0 : Math.min(maximumDigits, Math.max(1, Math.ceil(-Math.log10(magnitude))));
  return Number(value.toFixed(digits)).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function taskAnaDistributionMetricValue(task, metric, unitKey) {
  const minutes = Math.max(0, Number(task?.minutes) || 0);
  if (metric === 'duration') return minutes > 0 ? durationDisplayValue(minutes) : null;
  const quantity = visibleTaskQuantity(task);
  if (!(quantity > 0) || taskAnaDistributionUnitKey(task) !== unitKey) return null;
  if (metric === 'quantity') return quantity;
  return minutes > 0 ? questionEfficiencyDisplayValue(quantity / minutes) : null;
}

function taskAnaDistributionStats(records, metric, unitKey, granularity) {
  const values = records
    .map(record => taskAnaDistributionMetricValue(record.task, metric, unitKey))
    .filter(value => Number.isFinite(value) && value > 0);
  if (!values.length) return { values: [], bins: [], width: 0, average: null, dominant: null };
  const level = taskAnaDistributionGranularity(granularity);
  const targetBins = TASK_DISTRIBUTION_TARGET_BINS[level - 1];
  const maximum = Math.max(...values);
  const width = taskAnaDistributionNiceWidth(maximum, targetBins, metric);
  const count = Math.max(1, Math.ceil(maximum / width));
  const bins = Array.from({ length: count }, (_, index) => {
    const min = index * width;
    const max = (index + 1) * width;
    return {
      min,
      max,
      count: values.filter(value => value > min && value <= max + Number.EPSILON).length,
    };
  });
  const dominant = bins.reduce((best, bin) => bin.count > best.count ? bin : best, bins[0]);
  return {
    values,
    bins,
    width,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    dominant,
  };
}

function taskAnaDistributionPanelHtml(records) {
  const s = state.taskAna;
  if (!['duration', 'quantity', 'efficiency'].includes(s.distributionMetric)) s.distributionMetric = 'duration';
  s.distributionGranularity = taskAnaDistributionGranularity(s.distributionGranularity);
  const normalized = (records || []).map(record => {
    const [level1, level2, level3] = parseActPath(record.task?.activityType);
    return {
      ...record,
      distributionLevel1: level1 || '',
      distributionLevel2: level1 && level2 ? `${level1} > ${level2}` : '',
      distributionLevel3: level1 && level2 && level3 ? `${level1} > ${level2} > ${level3}` : '',
    };
  }).filter(record => record.distributionLevel3);
  const level1Options = [...new Set(normalized.map(record => record.distributionLevel1))].sort();
  if (s.distributionLevel1 && !level1Options.includes(s.distributionLevel1)) {
    s.distributionLevel1 = '';
    s.distributionLevel2 = '';
    s.distributionLevel3 = '';
    s.distributionUnit = '';
  }
  const level1Records = s.distributionLevel1
    ? normalized.filter(record => record.distributionLevel1 === s.distributionLevel1)
    : [];
  const level2Options = [...new Set(level1Records.map(record => record.distributionLevel2))].filter(Boolean).sort();
  if (s.distributionLevel2 && !level2Options.includes(s.distributionLevel2)) {
    s.distributionLevel2 = '';
    s.distributionLevel3 = '';
    s.distributionUnit = '';
  }
  const level2Records = s.distributionLevel2
    ? level1Records.filter(record => record.distributionLevel2 === s.distributionLevel2)
    : [];
  const level3Options = [...new Set(level2Records.map(record => record.distributionLevel3))].filter(Boolean).sort();
  if (s.distributionLevel3 && !level3Options.includes(s.distributionLevel3)) {
    s.distributionLevel3 = '';
    s.distributionUnit = '';
  }
  const selectedRecords = s.distributionLevel3
    ? level2Records.filter(record => record.distributionLevel3 === s.distributionLevel3)
    : [];
  const unitCounts = selectedRecords.reduce((counts, record) => {
    if (!(visibleTaskQuantity(record.task) > 0)) return counts;
    const unitKey = taskAnaDistributionUnitKey(record.task);
    counts.set(unitKey, (counts.get(unitKey) || 0) + 1);
    return counts;
  }, new Map());
  const unitOptions = [...unitCounts.keys()].sort((a, b) => (unitCounts.get(b) - unitCounts.get(a)) || taskAnaDistributionUnitLabel(a).localeCompare(taskAnaDistributionUnitLabel(b)));
  if (!unitOptions.includes(s.distributionUnit)) s.distributionUnit = unitOptions[0] || '';
  const metric = s.distributionMetric;
  const metricLabels = { duration: '任务时长', quantity: '完成数量', efficiency: '任务效率' };
  const needsUnit = metric !== 'duration';
  const unitLabel = metric === 'duration'
    ? durationDisplayUnitLabel()
    : metric === 'efficiency'
      ? questionEfficiencyUnitLabel(taskAnaDistributionUnitLabel(s.distributionUnit || TASK_DISTRIBUTION_UNLABELED_UNIT))
      : taskAnaDistributionUnitLabel(s.distributionUnit || TASK_DISTRIBUTION_UNLABELED_UNIT);
  const stats = s.distributionLevel3
    ? taskAnaDistributionStats(selectedRecords, metric, s.distributionUnit, s.distributionGranularity)
    : { values: [], bins: [], width: 0, average: null, dominant: null };
  const color = s.distributionLevel3 ? getCategoryColor(s.distributionLevel3, 3) : getSystemSeriesColor('taskTotal');
  const widthText = stats.width ? taskAnaDistributionNumber(stats.width, stats.width) : '-';
  const valueText = value => `${taskAnaDistributionNumber(value, stats.width || value || 1)} ${escHtmlApp(unitLabel)}`;
  const binText = bin => `${taskAnaDistributionNumber(bin.min, stats.width)}–${taskAnaDistributionNumber(bin.max, stats.width)} ${escHtmlApp(unitLabel)}`;
  s._distributionChartData = stats.values.length ? {
    color,
    category: s.distributionLevel3,
    unitLabel,
    labels: stats.bins.map(bin => [
      `${taskAnaDistributionNumber(bin.min, stats.width)}–${taskAnaDistributionNumber(bin.max, stats.width)}`,
      unitLabel,
    ]),
    counts: stats.bins.map(bin => bin.count),
    bins: stats.bins,
  } : null;
  s._distributionPreview = { selectedRecords, metric, unitKey: s.distributionUnit };
  const selectHtml = (level, label, options, selected, enabled) => `<label class="task-distribution-select"><span>${label}</span><select ${enabled ? '' : 'disabled'} onchange="taskAnaSetDistributionLevel(${level},this.value)"><option value="">${enabled ? `请选择${label}` : '请先选择上一级'}</option>${options.map(path => `<option value="${escHtmlApp(path)}" ${selected === path ? 'selected' : ''}>${escHtmlApp(path.split(' > ').pop() || path)}</option>`).join('')}</select></label>`;
  const selectors = [
    selectHtml(1, '一级分类', level1Options, s.distributionLevel1, true),
    selectHtml(2, '二级分类', level2Options, s.distributionLevel2, Boolean(s.distributionLevel1)),
    selectHtml(3, '三级分类', level3Options, s.distributionLevel3, Boolean(s.distributionLevel2)),
  ].join('');
  const metricTabs = Object.entries(metricLabels).map(([key, label]) => `<button type="button" class="${metric === key ? 'active' : ''}" onclick="switchTaskAnaDistributionMetric('${key}')">${label}</button>`).join('');
  let bodyHtml;
  if (!normalized.length) {
    bodyHtml = '<div class="task-analysis-empty compact"><b>当前范围没有完整三级分类任务</b><span>请先为任务补全一级、二级和三级分类。</span></div>';
  } else if (!s.distributionLevel3) {
    bodyHtml = '<div class="task-analysis-empty compact"><b>请选择完整三级分类</b><span>依次选择一级、二级和三级分类后，这里会显示单条任务分布。</span></div>';
  } else if (needsUnit && !unitOptions.length) {
    bodyHtml = `<div class="task-analysis-empty compact"><b>当前分类没有数量记录</b><span>${metric === 'efficiency' ? '填写正数数量和任务时长后才能计算效率分布。' : '填写正数完成数量后才能生成数量分布。'}</span></div>`;
  } else if (!stats.values.length) {
    bodyHtml = `<div class="task-analysis-empty compact"><b>当前指标没有有效任务</b><span>${metric === 'duration' ? '只有时长大于零的任务进入分布。' : '可以切换数量单位或补充有效记录。'}</span></div>`;
  } else {
    bodyHtml = `<div class="task-distribution-controls">
        <div class="task-distribution-scale-head"><span>区间精细度</span><output id="task-distribution-granularity-output">第 ${s.distributionGranularity} 档 · ${widthText} ${escHtmlApp(unitLabel)} / 格</output></div>
        <input type="range" min="1" max="5" step="1" value="${s.distributionGranularity}" aria-label="任务分布区间精细度" oninput="previewTaskAnaDistributionGranularity(this.value)" onchange="setTaskAnaDistributionGranularity(this.value)">
        <div class="task-distribution-scale-labels"><span>宽泛 · 5格</span><span>精细 · 16格</span></div>
      </div>
      <div class="task-distribution-chart-head"><span><i style="--series-color:${color}"></i><b>${escHtmlApp(s.distributionLevel3)}</b> · ${metricLabels[metric]}分布</span><small>${stats.values.length} 条有效任务 · 平均 ${valueText(stats.average)} · 最集中于 ${binText(stats.dominant)}</small></div>
      <div class="task-distribution-chart-stage"><canvas id="taskAnaDistributionChart"></canvas></div>`;
  }
  return `<section class="task-analysis-panel task-distribution-panel">
    <div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">TASK DISTRIBUTION</div><h3>单条任务分布</h3><p>选择完整三级分类，比较每条任务落入不同时长、数量或效率区间的频次。</p></div><div class="task-analysis-view-tabs task-distribution-metric-tabs">${metricTabs}</div></div>
    <div class="task-distribution-category-grid">${selectors}</div>
    ${needsUnit && s.distributionLevel3 && unitOptions.length ? `<label class="task-distribution-unit"><span>数量单位</span><select onchange="setTaskAnaDistributionUnit(this.value)">${unitOptions.map(unit => `<option value="${escHtmlApp(unit)}" ${s.distributionUnit === unit ? 'selected' : ''}>${escHtmlApp(taskAnaDistributionUnitLabel(unit))} · ${unitCounts.get(unit)} 条</option>`).join('')}</select></label>` : ''}
    ${bodyHtml}
  </section>`;
}

function taskAnaCurrentDistributionRecords() {
  const level = state.taskAna.level || 1;
  const records = [];
  taskAnaGetDates().forEach(dateStr => {
    (getDay(dateStr).tasks || []).forEach(task => records.push({
      dateStr,
      task,
      category: truncateActPath(task.activityType, level),
    }));
  });
  return state.taskAna.catFilter
    ? records.filter(record => record.category === state.taskAna.catFilter)
    : records;
}

function rerenderTaskAnaDistributionPanel() {
  const host = document.getElementById('task-analysis-distribution-host');
  if (!host) return;
  host.innerHTML = taskAnaDistributionPanelHtml(taskAnaCurrentDistributionRecords());
  requestAnimationFrame(renderTaskAnaDistributionChart);
}

function renderTaskAnaDistributionChart() {
  const canvas = document.getElementById('taskAnaDistributionChart');
  const chartData = state.taskAna._distributionChartData;
  if (!canvas || !chartData) return;
  mkChart('taskAnaDistributionChart', {
    type: 'line',
    data: {
      labels: chartData.labels,
      datasets: [{
        label: chartData.category,
        data: chartData.counts,
        borderColor: chartData.color,
        backgroundColor: `${chartData.color}1f`,
        pointBackgroundColor: chartData.color,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        pointRadius: 4.5,
        pointHoverRadius: 6,
        borderWidth: 2.3,
        tension: .18,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: contexts => {
            const bin = chartData.bins[contexts[0]?.dataIndex];
            if (!bin) return '';
            return `${taskAnaDistributionNumber(bin.min, bin.max - bin.min)}–${taskAnaDistributionNumber(bin.max, bin.max - bin.min)} ${chartData.unitLabel}`;
          },
          label: context => `${Number(context.parsed.y) || 0} 条任务`,
        } },
      },
      scales: {
        x: { ticks: { color: '#a8b5d0', maxRotation: 0, autoSkip: true, maxTicksLimit: 16 }, grid: { display: false }, title: { display: true, text: `单条任务区间（${chartData.unitLabel}）`, color: '#6b7a9e' } },
        y: { beginAtZero: true, ticks: { color: '#6b7a9e', precision: 0 }, grid: { color: 'rgba(107,122,158,.12)', drawBorder: false }, title: { display: true, text: '任务条数', color: '#6b7a9e' } },
      },
    },
  });
}

function taskAnaSetDistributionLevel(level, value) {
  const s = state.taskAna;
  if (Number(level) === 1) {
    s.distributionLevel1 = value || '';
    s.distributionLevel2 = '';
    s.distributionLevel3 = '';
  } else if (Number(level) === 2) {
    s.distributionLevel2 = value || '';
    s.distributionLevel3 = '';
  } else if (Number(level) === 3) s.distributionLevel3 = value || '';
  else return;
  s.distributionUnit = '';
  rerenderTaskAnaDistributionPanel();
}

function switchTaskAnaDistributionMetric(metric) {
  if (!['duration', 'quantity', 'efficiency'].includes(metric)) return;
  state.taskAna.distributionMetric = metric;
  rerenderTaskAnaDistributionPanel();
}

function setTaskAnaDistributionUnit(unit) {
  state.taskAna.distributionUnit = unit || '';
  rerenderTaskAnaDistributionPanel();
}

function previewTaskAnaDistributionGranularity(value) {
  const output = document.getElementById('task-distribution-granularity-output');
  const preview = state.taskAna._distributionPreview;
  if (!output || !preview) return;
  const stats = taskAnaDistributionStats(preview.selectedRecords, preview.metric, preview.unitKey, value);
  const unitLabel = preview.metric === 'duration'
    ? durationDisplayUnitLabel()
    : preview.metric === 'efficiency'
      ? questionEfficiencyUnitLabel(taskAnaDistributionUnitLabel(preview.unitKey || TASK_DISTRIBUTION_UNLABELED_UNIT))
      : taskAnaDistributionUnitLabel(preview.unitKey || TASK_DISTRIBUTION_UNLABELED_UNIT);
  output.textContent = `第 ${taskAnaDistributionGranularity(value)} 档 · ${stats.width ? taskAnaDistributionNumber(stats.width, stats.width) : '-'} ${unitLabel} / 格`;
}

function setTaskAnaDistributionGranularity(value) {
  state.taskAna.distributionGranularity = taskAnaDistributionGranularity(value);
  rerenderTaskAnaDistributionPanel();
}

function taskAnaCategoryFilterContext(records) {
  const normalized = (records || []).map((record, sourceIndex) => {
    const [rawLevel1, rawLevel2, rawLevel3] = parseActPath(record.task?.activityType);
    const level1 = rawLevel1 || '未分类';
    const level2 = rawLevel2 || '';
    const level3 = rawLevel3 || '';
    return {
      ...record,
      sourceIndex,
      level1Path: level1,
      level2Path: level2 ? `${level1} > ${level2}` : '',
      level3Path: level3 ? `${level1} > ${level2} > ${level3}` : '',
      level3Category: truncateActPath(record.task?.activityType, 3),
    };
  });
  const level1Counts = new Map();
  normalized.forEach(record => level1Counts.set(record.level1Path, (level1Counts.get(record.level1Path) || 0) + 1));
  const level1Options = [...level1Counts.keys()].sort();
  if (state.taskAna.taskDetailLevel1 && !level1Options.includes(state.taskAna.taskDetailLevel1)) {
    state.taskAna.taskDetailLevel1 = '';
    state.taskAna.taskDetailLevel2 = '';
    state.taskAna.taskDetailLevel3 = '';
  }
  const selectedLevel1 = state.taskAna.taskDetailLevel1 || '';
  const level1Records = selectedLevel1 ? normalized.filter(record => record.level1Path === selectedLevel1) : normalized;
  const level2Counts = new Map();
  level1Records.filter(record => record.level2Path).forEach(record => level2Counts.set(record.level2Path, (level2Counts.get(record.level2Path) || 0) + 1));
  const level2Options = [...level2Counts.keys()].sort();
  if (state.taskAna.taskDetailLevel2 && !level2Options.includes(state.taskAna.taskDetailLevel2)) {
    state.taskAna.taskDetailLevel2 = '';
    state.taskAna.taskDetailLevel3 = '';
  }
  const selectedLevel2 = state.taskAna.taskDetailLevel2 || '';
  const level2Records = selectedLevel2 ? level1Records.filter(record => record.level2Path === selectedLevel2) : level1Records;
  const level3Counts = new Map();
  level2Records.filter(record => record.level3Path).forEach(record => level3Counts.set(record.level3Path, (level3Counts.get(record.level3Path) || 0) + 1));
  const level3Options = [...level3Counts.keys()].sort();
  if (state.taskAna.taskDetailLevel3 && !level3Options.includes(state.taskAna.taskDetailLevel3)) state.taskAna.taskDetailLevel3 = '';
  const selectedLevel3 = state.taskAna.taskDetailLevel3 || '';
  const selectedPath = selectedLevel3 || selectedLevel2 || selectedLevel1;
  const visible = normalized
    .filter(record => !selectedLevel1 || record.level1Path === selectedLevel1)
    .filter(record => !selectedLevel2 || record.level2Path === selectedLevel2)
    .filter(record => !selectedLevel3 || record.level3Path === selectedLevel3)
    .sort((a, b) => b.dateStr.localeCompare(a.dateStr) || a.sourceIndex - b.sourceIndex);
  const filterRowHtml = (level, label, options, counts, selected, total, enabled, allLabel) => {
    if (!enabled) return `<div class="task-detail-filter-level disabled"><span class="task-detail-filter-label">${label}</span><div class="task-detail-filter-empty">请先选择上一级分类</div></div>`;
    const allButton = `<button type="button" class="task-detail-category${selected ? '' : ' active'}" onclick="taskAnaSetDetailLevel(${level},'')"><span>${allLabel}</span><b>${total}</b></button>`;
    const optionButtons = options.map(path => {
      const encoded = encodeURIComponent(path).replace(/'/g, '%27');
      const shortName = path.split(' > ').pop() || path;
      return `<button type="button" class="task-detail-category${selected === path ? ' active' : ''}" style="--category-color:${getCategoryColor(path, level)}" title="${escHtmlApp(path)}" onclick="taskAnaSetDetailLevel(${level},decodeURIComponent('${encoded}'))"><i></i><span>${escHtmlApp(shortName)}</span><b>${counts.get(path)}</b></button>`;
    }).join('');
    return `<div class="task-detail-filter-level"><span class="task-detail-filter-label">${label}</span><div class="task-detail-filter-options">${allButton}${optionButtons || '<span class="task-detail-filter-empty">当前分支没有下一级分类</span>'}</div></div>`;
  };
  const categoryFilters = [
    filterRowHtml(1, '一级分类', level1Options, level1Counts, selectedLevel1, normalized.length, true, '全部一级'),
    filterRowHtml(2, '二级分类', level2Options, level2Counts, selectedLevel2, level1Records.length, Boolean(selectedLevel1), '全部二级'),
    filterRowHtml(3, '三级分类', level3Options, level3Counts, selectedLevel3, level2Records.length, Boolean(selectedLevel2), '全部三级'),
  ].join('');
  return { normalized, selectedPath, visible, categoryFilters };
}

function taskAnaCategoryStatsFromRecords(records, level) {
  const grouped = new Map();
  (records || []).forEach(record => {
    const task = record.task || {};
    const cat = truncateActPath(task.activityType, level);
    if (!grouped.has(cat)) grouped.set(cat, {
      cat, count: 0, min: 0, qty: 0, qtyUnit: '', wrong: 0, errorQty: 0, errorTaskCount: 0,
      activeDates: new Set(), durations: [],
    });
    const row = grouped.get(cat);
    const minutes = Math.max(0, Number(task.minutes) || 0);
    const quantity = visibleTaskQuantity(task);
    const wrong = visibleTaskWrongCount(task);
    row.count++;
    row.min += minutes;
    row.qty += quantity;
    row.durations.push(minutes);
    if (record.dateStr) row.activeDates.add(record.dateStr);
    if (visibleTaskQuantityUnit(task)) row.qtyUnit = visibleTaskQuantityUnit(task);
    if (wrong != null) {
      row.wrong += wrong;
      row.errorQty += quantity;
      row.errorTaskCount++;
    }
  });
  return [...grouped.values()].map(row => {
    const activeDays = row.activeDates.size;
    const durationStats = calcStats(row.durations);
    const errorRate = row.errorQty > 0 ? row.wrong / row.errorQty * 100 : null;
    const correctCount = row.errorQty > 0 ? Math.max(0, row.errorQty - row.wrong) : null;
    const accuracyRate = row.errorQty > 0 ? correctCount / row.errorQty * 100 : null;
    return {
      cat: row.cat,
      count: row.count,
      min: row.min,
      qty: row.qty,
      qtyUnit: row.qtyUnit,
      wrong: row.wrong,
      errorQty: row.errorQty,
      errorTaskCount: row.errorTaskCount,
      errorRate,
      correctCount,
      accuracyRate,
      activeDays,
      avgMin: row.count ? Math.round(row.min / row.count) : 0,
      avgPerDay: activeDays ? Math.round(row.min / activeDays) : 0,
      avgEff: row.qty > 0 && row.min > 0 ? +(row.qty / row.min).toFixed(2) : null,
      cv: durationStats.cv,
    };
  });
}

function taskAnaTaskDetailPanelHtml(records, filterContext = null) {
  const taskEfficiencyIndex = buildTaskEfficiencyComparisonIndex();
  const context = filterContext || taskAnaCategoryFilterContext(records);
  const { normalized, selectedPath, visible, categoryFilters } = context;
  const rows = visible.map((record, rowIndex) => {
    const task = record.task || {};
    const quantity = visibleTaskQuantity(task);
    const unit = visibleTaskQuantityUnit(task);
    const minutes = Math.max(0, Number(task.minutes) || 0);
    const efficiency = quantity > 0 && minutes > 0 ? quantity / minutes : null;
    const efficiencyComparison = taskEfficiencyComparisonFor(taskEfficiencyIndex, task, record.dateStr);
    const accuracy = visibleTaskAccuracy(task);
    const encodedId = task.id ? encodeURIComponent(task.id).replace(/'/g, '%27') : '';
    const openAction = task.id ? `taskAnaOpenTask('${record.dateStr}','${encodedId}')` : '';
    return `<tr ${sortableTableRowAttrs({
      date: record.dateStr,
      minutes,
      quantity: quantity > 0 ? quantity : null,
      efficiency,
      efficiencyDelta: efficiencyComparison?.deltaPct,
      accuracy,
    }, rowIndex)}>
      <td class="fw-mono">${formatShort(record.dateStr)}</td>
      <td>${task.id ? `<button type="button" class="task-detail-name" onclick="${openAction}">${escHtmlApp(task.name || '未命名任务')}</button>` : `<span class="task-detail-name disabled" title="该历史任务缺少ID，无法打开编辑">${escHtmlApp(task.name || '未命名任务')}</span>`}</td>
      <td><span class="task-detail-category-label"><i style="--category-color:${getCategoryColor(record.level3Category, 3)}"></i>${escHtmlApp(record.level3Category)}</span></td>
      <td class="fw-mono c-actual">${fmtMin(minutes, true)}</td>
      <td class="fw-mono">${quantity > 0 ? `${forecastDisplayMetric(quantity)}${unit ? ` ${escHtmlApp(unit)}` : ''}` : '-'}</td>
      <td class="fw-mono">${formatQuestionEfficiency(efficiency, unit || '题')}</td>
      <td class="fw-mono">${taskEfficiencyDeltaHtml(efficiencyComparison)}</td>
      <td class="fw-mono c-muted">${accuracy == null ? '-' : `${accuracy.toFixed(2)}%`}</td>
      <td><span class="task-detail-note" title="${escHtmlApp(task.note || '')}">${escHtmlApp(task.note || '-')}</span></td>
      <td>${task.id ? `<button type="button" class="btn btn-ghost btn-sm" onclick="${openAction}">编辑</button>` : '<button type="button" class="btn btn-ghost btn-sm" disabled title="该历史任务缺少ID">不可编辑</button>'}</td>
    </tr>`;
  }).join('');
  return `<section class="task-detail-panel" data-render-panel="task-records">
    <div class="task-detail-head"><div><div class="task-analysis-eyebrow">TASK RECORDS</div><h3>任务记录明细</h3><p>当前范围共 ${normalized.length} 条任务${selectedPath ? ` · ${escHtmlApp(selectedPath)} ${visible.length} 条` : ''}</p></div><span>${visible.length} 条</span></div>
    <div class="task-detail-categories">${categoryFilters}</div>
    <div class="task-detail-table-wrap"><table class="task-detail-table" data-sort-table="task-records"><thead><tr>${sortableTableHeaderHtml('task-records', 'date', '日期', 'date')}<th>任务名称</th><th>三级分类</th>${sortableTableHeaderHtml('task-records', 'minutes', '时长')}${sortableTableHeaderHtml('task-records', 'quantity', '数量')}${sortableTableHeaderHtml('task-records', 'efficiency', '效率')}${sortableTableHeaderHtml('task-records', 'efficiencyDelta', '较平均效率')}${sortableTableHeaderHtml('task-records', 'accuracy', '正确率')}<th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function renderTaskAnalysis(panelKey = '') {
  const host = document.getElementById('tab-taskAnalysis');
  if (!host) return;
  const taskPanelGroups = {
    duration: ['task-duration'],
    'range-task': ['task-range-task'],
    count: ['task-count'],
    chapter: ['task-chapter'],
    efficiency: ['task-efficiency'],
    details: ['task-category-summary', 'task-records'],
  };
  const requestedPanels = taskPanelGroups[panelKey] || [];
  let scopedPanel = Boolean(requestedPanels.length && requestedPanels.every(key => host.querySelector(`[data-render-panel="${key}"]`)));
  const s = state.taskAna;
  if (!['daily', 'cumulativeAverage'].includes(s.durationView)) s.durationView = 'daily';
  if (!['daily', 'cumulativeAverage'].includes(s.countView)) s.countView = 'daily';
  if (!['minutes', 'quantityEfficiency'].includes(s.chapterMetric)) s.chapterMetric = 'minutes';
  if (!['single', 'cumulativeAverage'].includes(s.chapterView)) s.chapterView = 'single';
  if (!['daily', 'cumulativeAverage'].includes(s.efficiencyView)) s.efficiencyView = 'daily';
  if (!s.hiddenSeries || typeof s.hiddenSeries !== 'object') s.hiddenSeries = { duration: [], efficiency: [] };
  if (!Array.isArray(s.hiddenSeries.duration)) s.hiddenSeries.duration = [];
  if (!Array.isArray(s.hiddenSeries.efficiency)) s.hiddenSeries.efficiency = [];
  const sharedRange = analysisRangeMeta('task');
  const dateStrs = sharedRange.analysisDates;
  s.mode = dateStrs.length <= 7 ? 'week' : dateStrs.length > 90 ? 'all' : 'month';
  const labels = dateStrs.map(d => formatShort(d));
  const level = s.level || 1;
  const rangeLabel = sharedRange.label;

  // 收集任务按类别分组
  const catMap = {}; // { catName: { [dateStr]: { min, qty, count } } }
  const allTaskRecords = [];
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
      allTaskRecords.push({ dateStr: ds, task: t, category: cat });
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][ds]) catMap[cat][ds] = { min: 0, qty: 0, count: 0, qtyUnit: '', wrong: 0, errorQty: 0, errorTaskCount: 0 };
      catMap[cat][ds].min += min;
      catMap[cat][ds].qty += qty;
      catMap[cat][ds].count++;
      if (qtyUnit) catMap[cat][ds].qtyUnit = qtyUnit;
      const wrong = visibleTaskWrongCount(t);
      if (wrong != null) {
        catMap[cat][ds].wrong += wrong;
        catMap[cat][ds].errorQty += qty;
        catMap[cat][ds].errorTaskCount++;
      }
    });
  });

  const allCats = Object.keys(catMap).sort();
  if (s.catFilter && !allCats.includes(s.catFilter)) s.catFilter = '';
  const taskCatFilter = s.catFilter || '';
  const cats = taskCatFilter ? [taskCatFilter] : allCats;
  const trendTaskRecords = taskCatFilter ? allTaskRecords.filter(record => record.category === taskCatFilter) : allTaskRecords;
  const trendTotalMin = trendTaskRecords.reduce((sum, record) => sum + (Number(record.task.minutes) || 0), 0);
  const visibleTaskRecords = allTaskRecords;
  const fullLevel3Cats = [...new Set(allTaskRecords.map(record => truncateActPath(record.task.activityType, 3)))];
  totalCount = visibleTaskRecords.length;
  totalMin = visibleTaskRecords.reduce((sum, record) => sum + (Number(record.task.minutes) || 0), 0);
  totalQty = visibleTaskRecords.reduce((sum, record) => sum + visibleTaskQuantity(record.task), 0);
  const daysWithTasks = dateStrs.filter(dateStr => visibleTaskRecords.some(record => record.dateStr === dateStr)).length;
  const avgMinPerDay = daysWithTasks > 0 ? Math.round(totalMin / daysWithTasks) : 0;

  // 折线图 datasets — 根据筛选决定显示方式
  let taskChartLabels, taskDayDS;
  let taskChartDateStrs = dateStrs;

  if (s.durationView === 'cumulativeAverage') {
    const cumulative = taskAnaCumulativeCategoryData(dateStrs, cats, catMap, 'min');
    taskChartLabels = cumulative.dates.map(formatShort);
    taskDayDS = cumulative.series.map(item => {
      const hex = getCategoryColor(item.category, level);
      return {
        label: item.category,
        seriesKey: item.category,
        data: item.values.map(value => value == null ? null : durationDisplayValue(value)),
        borderColor: hex,
        backgroundColor: hex,
        borderWidth: 2.2,
        pointRadius: item.values.length > 60 ? 1.5 : 3.5,
        pointBackgroundColor: hex,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        tension: .16,
        fill: false,
        spanGaps: false,
        hidden: s.hiddenSeries.duration.includes(item.category),
      };
    });
  } else if (taskCatFilter && catMap[taskCatFilter]) {
    taskChartLabels = labels;
    const hex = getCategoryColor(taskCatFilter, level);
    taskDayDS = [{
      label: taskCatFilter,
      seriesKey: taskCatFilter,
      data: dateStrs.map(ds => {
        const minutes = Number(catMap[taskCatFilter][ds]?.min) || 0;
        return minutes > 0 ? durationDisplayValue(minutes) : null;
      }),
      borderColor: hex, backgroundColor: hex,
      borderWidth: 2.2, pointRadius: dateStrs.length > 60 ? 1.5 : 4, pointBackgroundColor: hex,
      pointBorderColor: '#07111f', pointBorderWidth: 1.5,
      tension: .16, fill: false,
      hidden: s.hiddenSeries.duration.includes(taskCatFilter),
    }];
  } else {
    // 全部模式
    taskChartLabels = labels;
    taskDayDS = cats.map((cat, ci) => {
      const hex = getCategoryColor(cat, level);
      return {
        label: cat,
        seriesKey: cat,
        data: dateStrs.map(ds => {
          const minutes = Number(catMap[cat][ds]?.min) || 0;
          return minutes > 0 ? durationDisplayValue(minutes) : null;
        }),
        borderColor: hex, backgroundColor: hex,
        borderWidth: 2, pointRadius: dateStrs.length > 60 ? 1.5 : 3, pointBackgroundColor: hex,
        pointBorderColor: '#07111f', pointBorderWidth: 1.5,
        tension: .16, fill: false,
        hidden: s.hiddenSeries.duration.includes(cat),
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
    const activeDays = Object.keys(catMap[cat]).length;
    const avgPerDay = activeDays > 0 ? Math.round(min / activeDays) : 0;
    const avgEff = (qty && min) ? +(qty / min).toFixed(2) : null;
    const errorRate = errorQty > 0 ? wrong / errorQty * 100 : null;
    const correctCount = errorQty > 0 ? Math.max(0, errorQty - wrong) : null;
    const accuracyRate = errorQty > 0 ? correctCount / errorQty * 100 : null;
    const durationStats = calcStats(allTaskRecords
      .filter(record => record.category === cat)
      .map(record => Math.max(0, Number(record.task.minutes) || 0)));
    return {
      cat, count, min, qty, qtyUnit, wrong, errorQty, errorTaskCount, errorRate, correctCount, accuracyRate,
      activeDays, avgMin: count > 0 ? Math.round(min / count) : 0, avgPerDay, avgEff,
      cv: durationStats.cv,
    };
  });
  // 章节效率：横轴按模板章节顺序；周/月只筛选首次完成日，累计值包含此前跨天投入。
  const analysisDateSet = new Set(dateStrs);
  const chapterTemplates = getTaskTemplates()
    .filter(template => Boolean(template.namedItemEnabled ?? template.ordinalEnabled) && !templateUsesChapterQuestionCounts(template))
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
    const questionSpeedStats = calcStats(quantityItems.map(item => item.quantity / item.minutes));
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
      variance: stats.variance,
      stdDev: stats.stdDev,
      cv: stats.cv,
      n: stats.n,
      questionSpeedCv: questionSpeedStats.cv,
      questionSpeedStdDev: questionSpeedStats.stdDev,
      questionSpeedN: questionSpeedStats.n,
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
  if (s.chapterMetric === 'quantityEfficiency' && !selectedChapterTemplateStats?.template.quantityEnabled) s.chapterMetric = 'minutes';
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
    const questionSpeedStats = calcStats(quantityItems.map(item => item.quantity / item.minutes));
    const unit = related.find(item => item.template.quantityEnabled)?.template.quantityUnit || '';
    return {
      cat,
      avgEff: items.length ? totalMinutes / items.length : null,
      questionSpeed: quantityMinutes > 0 ? totalQuantity / quantityMinutes : null,
      unit,
      chapters: items.length,
      variance: stats.variance,
      stdDev: stats.stdDev,
      cv: stats.cv,
      n: stats.n,
      questionSpeedCv: questionSpeedStats.cv,
      questionSpeedStdDev: questionSpeedStats.stdDev,
      questionSpeedN: questionSpeedStats.n,
    };
  });

  // 纯数量效率趋势：普通数量任务按记录日计入；章节＋数量模板按章节完成日计入累计章节数据。
  const effCatMap = {};
  const effSampleMap = {};
  dateStrs.forEach(ds => {
    const day = getDay(ds);
    (day.tasks || []).forEach(t => {
      const template = getTaskTemplateForTask(t);
      const namedEnabled = !templateUsesChapterQuestionCounts(template) && (template
        ? Boolean(template.namedItemEnabled ?? template.ordinalEnabled)
        : taskNamedItemAllocations(t).length > 0);
      if (namedEnabled) return;
      const qty = visibleTaskQuantity(t);
      const qtyUnit = visibleTaskQuantityUnit(t);
      const min = Number(t.minutes) || 0;
      if (!qty || !min) return;
      const cat3 = truncateActPath(t.activityType, 3);
      if (!effSampleMap[cat3]) effSampleMap[cat3] = [];
      effSampleMap[cat3].push(qty / min);
      if (!effCatMap[cat3]) effCatMap[cat3] = {};
      if (!effCatMap[cat3][ds]) effCatMap[cat3][ds] = { qty: 0, min: 0, qtyUnit: '' };
      effCatMap[cat3][ds].qty += qty;
      effCatMap[cat3][ds].min += min;
      if (qtyUnit) effCatMap[cat3][ds].qtyUnit = qtyUnit;
    });
  });
  chapterTemplateData.forEach(templateData => {
    const template = templateData.template;
    if (!template.quantityEnabled) return;
    const cat3 = truncateActPath(template.activityType, 3);
    const qtyUnit = String(template.quantityUnit || '').trim();
    [...templateData.progress.values()]
      .filter(progress => progress.completed && analysisDateSet.has(progress.completionDate) && progress.quantity > 0 && progress.minutes > 0)
      .forEach(progress => {
        const completionDate = progress.completionDate;
        if (!effSampleMap[cat3]) effSampleMap[cat3] = [];
        effSampleMap[cat3].push(progress.quantity / progress.minutes);
        if (!effCatMap[cat3]) effCatMap[cat3] = {};
        if (!effCatMap[cat3][completionDate]) effCatMap[cat3][completionDate] = { qty: 0, min: 0, qtyUnit: '' };
        effCatMap[cat3][completionDate].qty += progress.quantity;
        effCatMap[cat3][completionDate].min += progress.minutes;
        if (qtyUnit) effCatMap[cat3][completionDate].qtyUnit = qtyUnit;
      });
  });
  const effCats = Object.keys(effCatMap).sort();
  const effCategoryNodes = effCats.map(category => {
    const [level1, level2, level3] = parseActPath(category);
    return {
      category,
      level1Path: level1 || '',
      level2Path: level1 && level2 ? `${level1} > ${level2}` : '',
      level3Path: level1 && level2 && level3 ? `${level1} > ${level2} > ${level3}` : '',
    };
  }).filter(node => node.level3Path);
  if (s.effCatFilter && effCats.includes(s.effCatFilter) && !s.effLevel1 && !s.effLevel2 && !s.effLevel3) {
    const legacyNode = effCategoryNodes.find(node => node.category === s.effCatFilter);
    if (legacyNode) {
      s.effLevel1 = legacyNode.level1Path;
      s.effLevel2 = legacyNode.level2Path;
      s.effLevel3 = legacyNode.level3Path;
    }
  }
  const effLevel1Options = [...new Set(effCategoryNodes.map(node => node.level1Path))].sort();
  if (s.effLevel1 && !effLevel1Options.includes(s.effLevel1)) {
    s.effLevel1 = '';
    s.effLevel2 = '';
    s.effLevel3 = '';
  }
  const effLevel1Nodes = s.effLevel1
    ? effCategoryNodes.filter(node => node.level1Path === s.effLevel1)
    : [];
  const effLevel2Options = [...new Set(effLevel1Nodes.map(node => node.level2Path))].filter(Boolean).sort();
  if (s.effLevel2 && !effLevel2Options.includes(s.effLevel2)) {
    s.effLevel2 = '';
    s.effLevel3 = '';
  }
  const effLevel2Nodes = s.effLevel2
    ? effLevel1Nodes.filter(node => node.level2Path === s.effLevel2)
    : [];
  const effLevel3Options = [...new Set(effLevel2Nodes.map(node => node.level3Path))].filter(Boolean).sort();
  if (s.effLevel3 && !effLevel3Options.includes(s.effLevel3)) s.effLevel3 = '';
  const effSelectedPath = s.effLevel3 || s.effLevel2 || s.effLevel1 || '';
  const effFilteredCats = effSelectedPath
    ? effCats.filter(category => category === effSelectedPath || category.startsWith(`${effSelectedPath} > `))
    : effCats;
  const effCatFilter = s.effLevel3 || '';
  s.effCatFilter = effCatFilter;
  const effCategorySelectHtml = (level, label, options, selected, enabled) => `<label><span>${label}</span><select ${enabled ? '' : 'disabled'} onchange="taskAnaSetEfficiencyLevel(${level},this.value)"><option value="">${enabled ? (level === 1 ? '全部（显示所有曲线）' : `请选择${label}`) : '请先选择上一级'}</option>${options.map(path => `<option value="${escHtmlApp(path)}" ${selected === path ? 'selected' : ''}>${escHtmlApp(path.split(' > ').pop() || path)}</option>`).join('')}</select></label>`;
  const effCategorySelectors = [
    effCategorySelectHtml(1, '一级分类', effLevel1Options, s.effLevel1, true),
    effCategorySelectHtml(2, '二级分类', effLevel2Options, s.effLevel2, Boolean(s.effLevel1)),
    effCategorySelectHtml(3, '三级分类', effLevel3Options, s.effLevel3, Boolean(s.effLevel2)),
  ].join('');

  // 根据筛选构建效率 datasets
  let effChartLabels, effDayDS;
  let effChartDateStrs = dateStrs;
  if (s.efficiencyView === 'cumulativeAverage') {
    const visibleEffCats = effFilteredCats;
    effChartLabels = labels;
    effDayDS = visibleEffCats.map(cat => {
      const hex = getCategoryColor(cat, 3);
      let totalQty = 0, totalMinutes = 0, unit = '';
      Object.values(effCatMap[cat]).forEach(value => { if (value.qtyUnit) unit = value.qtyUnit; });
      return {
        label: cat + ` (${questionEfficiencyUnitLabel(unit || '题')})`,
        seriesKey: cat,
        data: dateStrs.map(dateStr => {
          if (chartDateStatus(dateStr) !== 'recorded') return null;
          const row = effCatMap[cat]?.[dateStr];
          if (row) { totalQty += row.qty; totalMinutes += row.min; }
          const rate = totalMinutes > 0 ? questionEfficiencyDisplayValue(totalQty / totalMinutes) : null;
          return rate == null ? null : Number(rate.toFixed(3));
        }),
        borderColor: hex,
        backgroundColor: hex,
        borderWidth: 2.2,
        pointRadius: dateStrs.length > 60 ? 1.5 : 3.5,
        pointBackgroundColor: hex,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        tension: .16,
        fill: false,
        spanGaps: false,
        hidden: s.hiddenSeries.efficiency.includes(cat),
      };
    });
  } else if (effCatFilter && effCatMap[effCatFilter]) {
    // 单类别仍保留完整日期轴。
    effChartLabels = labels;
    const hex = getCategoryColor(effCatFilter, 3);
    let unit = '';
    Object.values(effCatMap[effCatFilter]).forEach(v => { if (v.qtyUnit) unit = v.qtyUnit; });
    effDayDS = [{
      label: effCatFilter + ` (${questionEfficiencyUnitLabel(unit || '题')})`,
      seriesKey: effCatFilter,
      data: dateStrs.map(ds => {
        if (chartDateStatus(ds) !== 'recorded') return null;
        const d = effCatMap[effCatFilter][ds];
        const rate = d ? questionEfficiencyDisplayValue(d.qty / d.min) : null;
        return rate == null ? null : +rate.toFixed(3);
      }),
      borderColor: hex, backgroundColor: hex,
      borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
      pointBorderColor: '#07111f', pointBorderWidth: 1.5,
      tension: .16, fill: false, spanGaps: false,
      hidden: s.hiddenSeries.efficiency.includes(effCatFilter),
    }];
  } else {
    // 全部类别或当前一级／二级分支
    effChartLabels = labels;
    effDayDS = effFilteredCats.map((cat, ci) => {
      const hex = getCategoryColor(cat, 3);
      let unit = '';
      Object.values(effCatMap[cat]).forEach(v => { if (v.qtyUnit) unit = v.qtyUnit; });
      return {
        label: cat + ` (${questionEfficiencyUnitLabel(unit || '题')})`,
        seriesKey: cat,
        data: dateStrs.map(ds => {
          const d = effCatMap[cat][ds];
          if (!d) return null;
          const rate = questionEfficiencyDisplayValue(d.qty / d.min);
          return rate == null ? null : +rate.toFixed(3);
        }),
        borderColor: hex, backgroundColor: hex,
        borderWidth: 2, pointRadius: 4, pointBackgroundColor: hex,
        pointBorderColor: '#07111f', pointBorderWidth: 1.5,
        tension: .16, fill: false, spanGaps: false,
        hidden: s.hiddenSeries.efficiency.includes(cat),
      };
    });
  }

  // 横轴跟随当前可见时长系列：单类别仅保留自身有效日期，多类别取有效日期并集。
  const visibleDurationCats = cats.filter(cat => !s.hiddenSeries.duration.includes(cat));
  const activeDurationIndexes = dateStrs
    .map((dateStr, index) => ({ dateStr, index }))
    .filter(({ dateStr }) => visibleDurationCats.some(cat => (Number(catMap[cat]?.[dateStr]?.min) || 0) > 0));
  taskChartDateStrs = activeDurationIndexes.map(item => item.dateStr);
  taskChartLabels = activeDurationIndexes.map(item => taskChartLabels[item.index]);
  taskDayDS = taskDayDS.map(dataset => ({
    ...dataset,
    data: activeDurationIndexes.map(item => dataset.data[item.index]),
  }));

  // 横轴跟随当前可见系列，只保留至少有一个可见类别真正产生效率样本的日期。
  const visibleEfficiencyCats = effFilteredCats
    .filter(cat => !s.hiddenSeries.efficiency.includes(cat));
  const activeEfficiencyIndexes = dateStrs
    .map((dateStr, index) => ({ dateStr, index }))
    .filter(({ dateStr }) => visibleEfficiencyCats.some(cat => Boolean(effCatMap[cat]?.[dateStr])));
  effChartDateStrs = activeEfficiencyIndexes.map(item => item.dateStr);
  effChartLabels = activeEfficiencyIndexes.map(item => effChartLabels[item.index]);
  effDayDS = effDayDS.map(dataset => ({
    ...dataset,
    data: activeEfficiencyIndexes.map(item => dataset.data[item.index]),
  }));

  // 效率统计（每个三级类别的效率 CV）
  const effCatStats = effCats.map(cat => {
    let unit = '', totalQty = 0, totalMin = 0;
    Object.values(effCatMap[cat]).forEach(v => { totalQty += v.qty; totalMin += v.min; if (v.qtyUnit) unit = v.qtyUnit; });
    const stats = calcStats(effSampleMap[cat] || []);
    const avgEff = totalMin > 0 ? +(totalQty / totalMin).toFixed(3) : null;
    return { cat, unit, avgEff, variance: stats.variance, cv: stats.cv, stdDev: stats.stdDev, n: stats.n };
  });

  // 当前筛选的效率统计
  let effDisplayStats = null;
  if (effCatFilter) {
    effDisplayStats = effCatStats.find(c => c.cat === effCatFilter) || null;
  }

  const quantityRecordCount = visibleTaskRecords.filter(record => visibleTaskQuantity(record.task) > 0).length;
  const errorSampleRecords = visibleTaskRecords.filter(record => visibleTaskWrongCount(record.task) != null);
  const wrongRecordCount = errorSampleRecords.length;
  const detailCategoryContext = taskAnaCategoryFilterContext(visibleTaskRecords);
  const summaryRecords = detailCategoryContext.visible;
  const summaryLevel = 3;
  const summaryCatStats = taskAnaCategoryStatsFromRecords(summaryRecords, summaryLevel);
  const sortedCatStats = [...summaryCatStats].sort((a, b) => b.min - a.min);
  const summaryTotalCount = summaryRecords.length;
  const summaryTotalMin = summaryRecords.reduce((sum, record) => sum + Math.max(0, Number(record.task?.minutes) || 0), 0);
  const summaryDaysWithTasks = new Set(summaryRecords.map(record => record.dateStr)).size;
  const summaryAvgMinPerDay = summaryDaysWithTasks ? Math.round(summaryTotalMin / summaryDaysWithTasks) : 0;
  const summaryTotalQty = summaryRecords.reduce((sum, record) => sum + visibleTaskQuantity(record.task), 0);
  const summaryErrorRecords = summaryRecords.filter(record => visibleTaskWrongCount(record.task) != null);
  const summaryErrorQty = summaryErrorRecords.reduce((sum, record) => sum + visibleTaskQuantity(record.task), 0);
  const summaryWrong = summaryErrorRecords.reduce((sum, record) => sum + (visibleTaskWrongCount(record.task) || 0), 0);
  const summaryCorrect = summaryErrorQty > 0 ? Math.max(0, summaryErrorQty - summaryWrong) : null;
  const summaryAccuracyRate = summaryErrorQty > 0 ? summaryCorrect / summaryErrorQty * 100 : null;
  const summaryErrorRate = summaryErrorQty > 0 ? summaryWrong / summaryErrorQty * 100 : null;
  const summaryDurationStats = calcStats(summaryRecords.map(record => Math.max(0, Number(record.task?.minutes) || 0)));

  const taskAnalysisHtml = `<div class="task-analysis-page">
    <section class="task-analysis-hero">
      <div><div class="task-analysis-eyebrow">TASK ANALYTICS</div><h2>任务分析</h2><p>${rangeLabel} · 全部任务统计</p></div>
      <div class="task-analysis-hero-stats"><div><span>有任务天</span><b>${daysWithTasks} 天</b></div><div><span>任务总数</span><b>${totalCount} 条</b></div><div><span>总任务时长</span><b>${fmtHrs(totalMin)}</b></div><div><span>三级类别</span><b>${fullLevel3Cats.length} 类</b></div></div>
    </section>
    ${analysisRangePlannerHtml('task', sharedRange)}
    <section class="task-analysis-toolbar">
      <div class="task-analysis-control"><span>趋势 / 占比分类层级</span><div class="task-analysis-tabs"><button class="${level === 1 ? 'active' : ''}" onclick="taskAnaNav('level',1)">一级</button><button class="${level === 2 ? 'active' : ''}" onclick="taskAnaNav('level',2)">二级</button><button class="${level === 3 ? 'active' : ''}" onclick="taskAnaNav('level',3)">三级</button></div></div>
      <label class="task-analysis-filter"><span>趋势 / 占比类别</span><select onchange="taskAnaNav('catFilter',this.value)"><option value="">全部类别 (${allCats.length})</option>${allCats.map(category => `<option value="${escHtmlApp(category)}" ${taskCatFilter === category ? 'selected' : ''}>${escHtmlApp(category)}</option>`).join('')}</select></label>
    </section>
    ${totalCount ? `<section class="task-analysis-summary">
      <div class="task-analysis-primary-grid"><article><span>任务总时长${tipIcon('taskMin')}</span><b>${fmtHrs(totalMin)}</b><small>有任务日均 ${fmtMin(avgMinPerDay, true)}</small></article><article><span>任务数量</span><b>${totalCount} 条</b><small>有任务日均 ${daysWithTasks ? (totalCount / daysWithTasks).toFixed(1) : 0} 条</small></article><article><span>有任务天</span><b>${daysWithTasks} 天</b><small>当前范围 ${dateStrs.length} 天</small></article><article><span>每条平均</span><b>${totalCount ? fmtMin(Math.round(totalMin / totalCount)) : '-'}</b><small>全部分类</small></article></div>
      <div class="task-analysis-secondary-strip"><div><span>三级类别</span><b>${fullLevel3Cats.length}</b></div><div><span>数量记录</span><b>${quantityRecordCount} 条</b></div><div><span>有效错题记录</span><b>${wrongRecordCount} 条</b></div><div><span>累计数量</span><b>${totalQty ? forecastDisplayMetric(totalQty) : '-'}</b></div></div>
    </section>
    <div class="task-analysis-dashboard-grid">
      <section class="task-analysis-panel task-analysis-duration-panel" data-render-panel="task-duration">
        <div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">DURATION TREND</div><h3>每日任务时长趋势</h3><p>${s.durationView === 'daily' ? '按类别显示每天的任务时长。' : '显示截至当天累计类别时长 ÷ 该类别有任务天数。'}</p></div><div class="task-analysis-view-tabs"><button class="${s.durationView === 'daily' ? 'active' : ''}" onclick="switchTaskAnaView('durationView','daily')">每日时长</button><button class="${s.durationView === 'cumulativeAverage' ? 'active' : ''}" onclick="switchTaskAnaView('durationView','cumulativeAverage')">累计日均</button></div></div>
        ${taskAnaLegendHtml(cats, 'duration')}
        <div class="task-analysis-chart-stage large"><canvas id="taskAnaDailyChart"></canvas></div>
      </section>
      <section class="task-analysis-panel task-analysis-range-task-panel" data-render-panel="task-range-task">
        <div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">RANGE TASK DURATION</div><h3>范围每日任务时长</h3><p>${rangeChartView('task', 'task') === 'daily' ? '当前任务分析范围内每天的总任务时长。' : '截至当天有任务记录日的累计平均任务时长。'}</p></div>${rangeChartViewTabsHtml('task', 'task')}</div>
        <div class="task-analysis-chart-stage large"><canvas id="taskAnaRangeTaskChart"></canvas></div>
      </section>
      <div class="task-analysis-split-row">
        <section class="task-analysis-panel task-analysis-composition-panel"><div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">CATEGORY SHARE</div><h3>类别时间占比</h3><p>按顶部分类层级与类别筛选显示累计任务时长构成。</p></div></div><div class="task-analysis-composition-body"><div class="task-analysis-doughnut-stage"><canvas id="taskAnaPieChart"></canvas><div class="task-analysis-doughnut-center"><span>总时长</span><b>${fmtHrs(trendTotalMin)}</b></div></div><div class="task-analysis-composition-legend">${catStats.filter(c => c.min > 0).map((c, index) => `<button onclick="taskAnaHighlightPie(${index})"><i style="--series-color:${getCategoryColor(c.cat, level)}"></i><span>${escHtmlApp(c.cat)}</span><b>${fmtMin(c.min, true)}</b><small>${trendTotalMin ? (c.min / trendTotalMin * 100).toFixed(1) : 0}%</small></button>`).join('')}</div></div></section>
        <section class="task-analysis-panel task-analysis-count-panel" data-render-panel="task-count"><div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">TASK COUNT</div><h3>每日任务数量</h3><p>${s.countView === 'daily' ? '显示当前时间范围内每天的全部任务条数。' : '全部任务累计数量 ÷ 有任务天数。'}</p></div><div class="task-analysis-view-tabs"><button class="${s.countView === 'daily' ? 'active' : ''}" onclick="switchTaskAnaView('countView','daily')">每日数量</button><button class="${s.countView === 'cumulativeAverage' ? 'active' : ''}" onclick="switchTaskAnaView('countView','cumulativeAverage')">累计日均</button></div></div><div class="task-analysis-chart-stage medium"><canvas id="taskAnaCountChart"></canvas></div></section>
      </div>
      <div id="task-analysis-distribution-host">${taskAnaDistributionPanelHtml(visibleTaskRecords)}</div>
      ${chapterTemplateStats.length > 0 ? `<section class="task-analysis-panel task-chapter-workspace" data-render-panel="task-chapter">
        <div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">CHAPTER ANALYSIS</div><h3>章节分析</h3><p>按首次完成日期筛选；每章保留完成前全部跨天投入。</p></div><label class="task-analysis-select"><span>章节模板</span><select onchange="taskAnaNav('chapterEffTemplateId',this.value)">${chapterTemplateStats.map(item => `<option value="${escHtmlApp(item.id)}" ${selectedChapterTemplateStats?.id === item.id ? 'selected' : ''}>${escHtmlApp(item.label)}（${item.completedChapters}章）</option>`).join('')}</select></label></div>
        ${selectedChapterTemplateStats ? `<div class="task-chapter-summary">
          <div><span>完成章节</span><b>${selectedChapterTemplateStats.completedChapters} 章</b></div>
          <div><span>累计耗时</span><b>${fmtMin(selectedChapterTemplateStats.totalMinutes, true)}</b></div>
          <div><span>章节平均耗时</span><b>${selectedChapterTemplateStats.avgMinutes == null ? '-' : `${forecastDisplayMetric(selectedChapterTemplateStats.avgMinutes)} 分/章`}</b></div>
          <div><span>章节耗时 CV</span><b>${fmtCV(selectedChapterTemplateStats.cv)}</b></div>
          ${selectedChapterTemplateStats.template.quantityEnabled ? `<div><span>累计数量</span><b>${selectedChapterTemplateStats.totalQuantity ? `${forecastDisplayMetric(selectedChapterTemplateStats.totalQuantity)} ${escHtmlApp(selectedChapterTemplateStats.template.quantityUnit || '题')}` : '-'}</b></div>
          <div><span>章节内题目效率</span><b>${formatQuestionEfficiency(selectedChapterTemplateStats.questionSpeed, selectedChapterTemplateStats.template.quantityUnit || '题')}</b></div>
          <div><span>题目效率 CV</span><b>${fmtCV(selectedChapterTemplateStats.questionSpeedCv)}</b></div>` : ''}
        </div>` : ''}
        <div class="task-chapter-toolbar"><div class="task-analysis-view-tabs"><button class="${s.chapterMetric === 'minutes' ? 'active' : ''}" onclick="switchTaskAnaView('chapterMetric','minutes')">完成耗时</button>${selectedChapterTemplateStats?.template.quantityEnabled ? `<button class="${s.chapterMetric === 'quantityEfficiency' ? 'active' : ''}" onclick="switchTaskAnaView('chapterMetric','quantityEfficiency')">数量效率</button>` : ''}</div><div class="task-analysis-view-tabs"><button class="${s.chapterView === 'single' ? 'active' : ''}" onclick="switchTaskAnaView('chapterView','single')">${s.chapterMetric === 'minutes' ? '逐章数据' : '逐章效率'}</button><button class="${s.chapterView === 'cumulativeAverage' ? 'active' : ''}" onclick="switchTaskAnaView('chapterView','cumulativeAverage')">累计平均</button></div></div>
        ${selectedChapterItems.length ? '<div class="task-analysis-chart-stage chapter"><canvas id="taskAnaChapterChart"></canvas></div>' : '<div class="task-analysis-empty compact"><b>当前范围没有已完成章节</b><span>切换范围或章节模板后再查看。</span></div>'}
      </section>` : ''}
      ${effCats.length > 0 ? `<section class="task-analysis-panel task-efficiency-panel" data-render-panel="task-efficiency">
        <div class="task-analysis-panel-head"><div><div class="task-analysis-eyebrow">QUANTITY EFFICIENCY</div><h3>纯数量效率趋势</h3><p>${s.efficiencyView === 'daily' ? '普通数量任务按记录日统计；章节＋数量任务使用完成章节的累计数量与累计时长换算，并归入章节完成日。' : '截至当天按累计数量与累计时长换算，使用加权口径；章节数据从完成日开始计入。'}</p></div><div class="task-analysis-view-tabs"><button class="${s.efficiencyView === 'daily' ? 'active' : ''}" onclick="switchTaskAnaView('efficiencyView','daily')">每日效率</button><button class="${s.efficiencyView === 'cumulativeAverage' ? 'active' : ''}" onclick="switchTaskAnaView('efficiencyView','cumulativeAverage')">累计平均</button></div></div>
        <div class="task-efficiency-toolbar"><div class="task-analysis-view-tabs"><button class="${s.effScale === 'linear' ? 'active' : ''}" onclick="taskAnaNav('effScale','linear')">线性</button><button class="${s.effScale === 'log' ? 'active' : ''}" onclick="taskAnaNav('effScale','log')">对数</button><button class="${s.effScale === 'normalize' ? 'active' : ''}" onclick="taskAnaNav('effScale','normalize')">归一化</button></div>${s.effScale === 'linear' ? `<label><span>Y轴上限</span><input type="number" value="${s.effYMax}" placeholder="自动" min="0" step="0.5" onchange="state.taskAna.effYMax=this.value;renderTaskAnalysis('efficiency')"></label>` : ''}${effCategorySelectors}</div>
        ${effDisplayStats ? `<div class="task-efficiency-summary"><span>加权效率 <b>${formatQuestionEfficiency(effDisplayStats.avgEff, effDisplayStats.unit || '题')}</b></span><span>CV <b>${fmtCV(effDisplayStats.cv)}</b></span><span>样本 <b>${effDisplayStats.n}</b></span></div>` : ''}
        ${taskAnaLegendHtml(effFilteredCats, 'efficiency')}
        <div class="task-analysis-chart-stage large"><canvas id="taskAnaEffChart"></canvas></div>
      </section>` : ''}
      <section class="task-analysis-table-panel" data-render-panel="task-category-summary">
        <div class="task-analysis-table-head"><div><div class="task-analysis-eyebrow">CATEGORY DETAILS</div><h3>类别汇总明细</h3><p>${summaryCatStats.length} 个类别${detailCategoryContext.selectedPath ? ` · 当前分支：${escHtmlApp(detailCategoryContext.selectedPath)}` : ''} · 点击数值表头可切换排序</p></div></div>
        <div class="task-detail-categories task-summary-categories">${detailCategoryContext.categoryFilters}</div>
        <div class="task-analysis-table-wrap"><table class="task-analysis-table level-${summaryLevel}" data-sort-table="task-category-summary">
          <colgroup><col class="task-col-category"><col span="5" class="task-col-basic"><col class="task-col-stability"><col span="5" class="task-col-accuracy"><col span="4" class="task-col-efficiency"></colgroup>
          <thead><tr class="task-analysis-table-groups"><th rowspan="2" class="task-analysis-category-head">三级类别</th><th colspan="5">基础统计</th><th class="task-analysis-group-start">时长稳定性</th><th colspan="5" class="task-analysis-group-start">数量与正确性</th><th colspan="4" class="task-analysis-group-start">章节与题目效率</th></tr><tr>${sortableTableHeaderHtml('task-category-summary', 'count', '任务数')}${sortableTableHeaderHtml('task-category-summary', 'duration', '总时长')}${sortableTableHeaderHtml('task-category-summary', 'average', '每条平均')}${sortableTableHeaderHtml('task-category-summary', 'activeDays', '有任务天')}${sortableTableHeaderHtml('task-category-summary', 'daily', '有任务日均')}${sortableTableHeaderHtml('task-category-summary', 'durationCv', `时长CV${tipIcon('cv')}`, 'number', 'task-analysis-group-start')}${sortableTableHeaderHtml('task-category-summary', 'quantity', '总数量', 'number', 'task-analysis-group-start')}${sortableTableHeaderHtml('task-category-summary', 'wrong', '错题数')}${sortableTableHeaderHtml('task-category-summary', 'correct', '正确数')}${sortableTableHeaderHtml('task-category-summary', 'accuracy', '正确率')}${sortableTableHeaderHtml('task-category-summary', 'errorRate', '错误率')}${sortableTableHeaderHtml('task-category-summary', 'chapterAverage', '章节平均耗时', 'number', 'task-analysis-group-start')}${sortableTableHeaderHtml('task-category-summary', 'chapterCv', `章节耗时CV${tipIcon('cv')}`)}${sortableTableHeaderHtml('task-category-summary', 'questionEfficiency', '题目效率')}${sortableTableHeaderHtml('task-category-summary', 'questionCv', `题目效率CV${tipIcon('cv')}`)}</tr></thead>
            <tbody>${sortedCatStats.map((c, rowIndex) => {
    const hex = getCategoryColor(c.cat, summaryLevel);
    const ecs = effCatStats.find(e => e.cat === c.cat);
    const chapterEcs = chapterEffCatStats.find(e => e.cat === c.cat);
    const usesChapterEfficiency = chapterModeCats.has(c.cat);
    const chapterAverage = usesChapterEfficiency ? chapterEcs?.avgEff : null;
    const chapterCv = usesChapterEfficiency ? chapterEcs?.cv : null;
    const questionEfficiency = usesChapterEfficiency ? chapterEcs?.questionSpeed : c.avgEff;
    const questionCv = usesChapterEfficiency ? chapterEcs?.questionSpeedCv : ecs?.cv;
    const questionUnit = usesChapterEfficiency ? chapterEcs?.unit : c.qtyUnit;
    return `<tr ${sortableTableRowAttrs({
      count: c.count, duration: c.min, average: c.avgMin, activeDays: c.activeDays,
      daily: c.avgPerDay, durationCv: c.cv,
      quantity: c.qty > 0 ? c.qty : null,
      wrong: c.errorRate == null ? null : c.wrong,
      correct: c.correctCount,
      accuracy: c.accuracyRate,
      errorRate: c.errorRate,
      chapterAverage,
      chapterCv,
      questionEfficiency,
      questionCv,
    }, rowIndex)}>
              <td class="task-analysis-category-col"><div class="task-analysis-category-cell"><i style="--series-color:${hex}"></i><span>${escHtmlApp(c.cat)}</span></div></td>
              <td class="fw-mono">${c.count}</td>
              <td class="fw-mono c-actual">${fmtMin(c.min, true)}</td>
              <td class="fw-mono">${fmtMin(c.avgMin)}</td>
              <td class="fw-mono">${c.activeDays}</td><td class="fw-mono c-muted">${fmtMin(c.avgPerDay)}</td>
              <td class="fw-mono c-muted task-analysis-group-start">${fmtCV(c.cv)}</td>
              <td class="fw-mono task-analysis-group-start">${c.qty ? c.qty + (c.qtyUnit ? ' ' + c.qtyUnit : '') : '-'}</td>
              <td class="fw-mono c-muted">${c.errorRate == null ? '-' : forecastDisplayMetric(c.wrong)}</td><td class="fw-mono c-muted">${c.correctCount == null ? '-' : forecastDisplayMetric(c.correctCount)}</td><td class="fw-mono c-muted" title="${c.accuracyRate == null ? '没有合法错题记录' : `有效数量 ${forecastDisplayMetric(c.errorQty)} · 正确 ${forecastDisplayMetric(c.correctCount)} · 错题 ${forecastDisplayMetric(c.wrong)}`}">${c.accuracyRate == null ? '-' : `${c.accuracyRate.toFixed(2)}%`}</td><td class="fw-mono c-muted" title="${c.errorRate == null ? '没有合法错题记录' : `有效数量 ${forecastDisplayMetric(c.errorQty)} · 正确 ${forecastDisplayMetric(c.correctCount)} · 错题 ${forecastDisplayMetric(c.wrong)}`}">${c.errorRate == null ? '-' : `${c.errorRate.toFixed(2)}%`}</td>
              <td class="fw-mono task-analysis-group-start">${chapterAverage == null ? '-' : `${fmtMin(chapterAverage, true)}/章`}</td>
              <td class="fw-mono c-muted">${fmtCV(chapterCv)}</td>
              <td class="fw-mono">${formatQuestionEfficiency(questionEfficiency, questionUnit || '题')}</td>
              <td class="fw-mono c-muted">${fmtCV(questionCv)}</td>
            </tr>`;
  }).join('')}</tbody>
            <tfoot><tr><td class="task-analysis-category-col">合计</td><td>${summaryTotalCount}</td><td>${fmtMin(summaryTotalMin, true)}</td><td>${summaryTotalCount > 0 ? fmtMin(Math.round(summaryTotalMin / summaryTotalCount)) : '-'}</td><td>${summaryDaysWithTasks}</td><td>${fmtMin(summaryAvgMinPerDay)}</td><td class="task-analysis-group-start">${fmtCV(summaryDurationStats.cv)}</td><td class="task-analysis-group-start">${summaryTotalQty ? forecastDisplayMetric(summaryTotalQty) : '-'}</td><td>${summaryErrorQty ? forecastDisplayMetric(summaryWrong) : '-'}</td><td>${summaryCorrect == null ? '-' : forecastDisplayMetric(summaryCorrect)}</td><td title="${summaryAccuracyRate == null ? '没有合法错题记录' : `有效数量 ${forecastDisplayMetric(summaryErrorQty)}`}">${summaryAccuracyRate == null ? '-' : `${summaryAccuracyRate.toFixed(2)}%`}</td><td title="${summaryErrorRate == null ? '没有合法错题记录' : `有效数量 ${forecastDisplayMetric(summaryErrorQty)}`}">${summaryErrorRate == null ? '-' : `${summaryErrorRate.toFixed(2)}%`}</td><td class="task-analysis-group-start" colspan="4"></td></tr></tfoot>
          </table>
        </div>
      </section>
      ${taskAnaTaskDetailPanelHtml(visibleTaskRecords, detailCategoryContext)}
    </div>
    ` : `<div class="task-analysis-empty"><b>当前范围没有任务记录</b><span>可以切换时间范围、类别层级或先在录入页添加任务。</span></div>`}
  </div>`;

  if (scopedPanel && !replaceRenderPanels(host, taskAnalysisHtml, requestedPanels)) scopedPanel = false;
  if (!scopedPanel) host.innerHTML = taskAnalysisHtml;

  if (!totalCount) return;
  if (!scopedPanel) renderTaskAnaDistributionChart();
  if (!scopedPanel || panelKey === 'duration') mkChart('taskAnaDailyChart', {
    type: 'line', data: { labels: taskChartLabels, datasets: taskDayDS },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => { const v = ctx.parsed.y; if (v == null) return null; return `${ctx.dataset.label}: ${fmtMin(Math.round(durationDisplayValueToMinutes(v)))}`; } } }
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'week' ? 0 : 35, autoSkip: true, maxTicksLimit: s.mode === 'all' ? 24 : undefined }, grid: { display: false } },
        y: { ticks: { color: '#6b7a9e', callback: v => `${v}${durationDisplayUnitSuffix()}` }, grid: { color: 'rgba(107,122,158,.12)' }, min: 0, title: { display: true, text: s.durationView === 'daily' ? `每日时长（${durationDisplayUnitLabel()}）` : `累计日均时长（${durationDisplayUnitLabel()}）`, color: '#6b7a9e' } }
      }
    },
    plugins: [noRecordRegionPlugin(taskChartDateStrs)],
  });

  const taskRangeTaskValues = dateStrs.map(dateStr => durationDisplayValue(computeDay(dateStr).taskMin));
  const taskRangeTaskColor = getChartSeriesColor('taskDuration');
  if (!scopedPanel || panelKey === 'range-task') mkChart('taskAnaRangeTaskChart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: rangeChartView('task', 'task') === 'cumulativeAverage' ? `累计平均任务时长(${durationDisplayUnitSuffix()})` : `任务时长(${durationDisplayUnitSuffix()})`,
        data: rangeChartView('task', 'task') === 'cumulativeAverage'
          ? cumulativePositiveAverage(taskRangeTaskValues, dateStrs)
          : chartMaskRecordedValues(dateStrs, taskRangeTaskValues),
        backgroundColor: hexRgba(taskRangeTaskColor, .2),
        borderColor: taskRangeTaskColor,
        pointBackgroundColor: taskRangeTaskColor,
        borderWidth: 2,
        pointRadius: dateStrs.length > 60 ? 1.5 : 3,
        pointHoverRadius: 5,
        tension: .3,
        fill: true,
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (_event, elements) => {
        const dateStr = dateStrs[elements[0]?.index];
        if (dateStr && chartDateStatus(dateStr) === 'recorded') overviewOpenDay(dateStr);
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: contexts => {
            const dateStr = dateStrs[contexts[0]?.dataIndex];
            if (!dateStr) return '';
            const meta = dayTypeDisplayMeta(state.data[dateStr]);
            const label = formatShort(dateStr);
            return meta.name ? `${label} · ${meta.symbol} ${meta.name}` : label;
          },
          label: context => `任务时长：${fmtMin(Math.round(durationDisplayValueToMinutes(Number(context.raw) || 0)), true)}`,
        } },
      },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'week' ? 0 : 35, autoSkip: true, maxTicksLimit: s.mode === 'all' ? 24 : undefined }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: '#6b7a9e', callback: value => `${value}${durationDisplayUnitSuffix()}` }, grid: { color: 'rgba(107,122,158,.12)' }, title: { display: true, text: `任务时长（${durationDisplayUnitLabel()}）`, color: '#6b7a9e' } },
      },
    },
    plugins: [noRecordRegionPlugin(dateStrs)],
  });

  // 饼图
  const pieData = catStats.filter(c => c.min > 0);
  if (!scopedPanel && pieData.length > 0) {
    mkChart('taskAnaPieChart', {
      type: 'doughnut', data: {
        labels: pieData.map(c => c.cat),
        datasets: [{ data: pieData.map(c => c.min), backgroundColor: pieData.map(c => getCategoryColor(c.cat, level)), borderColor: '#101b2c', borderWidth: 2, hoverOffset: 5 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '67%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMin(ctx.raw)} · ${trendTotalMin ? (ctx.raw / trendTotalMin * 100).toFixed(1) : 0}%` } } } }
    });
  }

  // 每日任务条数 / 累计日均
  const dayCounts = dateStrs.map(dateStr => visibleTaskRecords.filter(record => record.dateStr === dateStr).length);
  const countChartData = s.countView === 'cumulativeAverage'
    ? taskAnaCumulativeDailyCount(dateStrs, visibleTaskRecords)
    : chartMaskRecordedValues(dateStrs, dayCounts);
  const countColor = getSystemSeriesColor('taskTotal');
  if (!scopedPanel || panelKey === 'count') mkChart('taskAnaCountChart', {
    type: s.countView === 'daily' ? 'bar' : 'line', data: {
      labels, datasets: [{
        label: s.countView === 'daily' ? '每日任务条数' : '累计日均任务数',
        data: countChartData,
        backgroundColor: s.countView === 'daily' ? hexRgba(countColor, .3) : hexRgba(countColor, .12),
        borderColor: countColor,
        borderWidth: 2,
        borderRadius: 4,
        pointRadius: s.countView === 'daily' ? 0 : 3.5,
        pointBackgroundColor: countColor,
        pointBorderColor: '#07111f',
        pointBorderWidth: 1.5,
        tension: .16,
        fill: s.countView !== 'daily',
        spanGaps: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(s.countView === 'daily' ? 0 : 2)} 条` } } },
      scales: {
        x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'week' ? 0 : 35, autoSkip: true, maxTicksLimit: s.mode === 'all' ? 24 : undefined }, grid: { display: false } },
        y: { ticks: { color: '#6b7a9e', precision: s.countView === 'daily' ? 0 : undefined }, grid: { color: 'rgba(107,122,158,.12)' }, min: 0, title: { display: true, text: s.countView === 'daily' ? '任务条数' : '累计日均任务数', color: '#6b7a9e' } }
      }
    },
    plugins: [noRecordRegionPlugin(dateStrs)],
  });

  if ((!scopedPanel || panelKey === 'chapter') && selectedChapterItems.length > 0 && document.getElementById('taskAnaChapterChart')) {
    const quantityMetric = s.chapterMetric === 'quantityEfficiency';
    const cumulative = s.chapterView === 'cumulativeAverage';
    const unit = selectedChapterTemplateStats?.template.quantityUnit || '题';
    const chapterValues = cumulative
      ? taskAnaCumulativeChapterValues(selectedChapterItems, s.chapterMetric)
      : selectedChapterItems.map(item => quantityMetric
        ? item.minutes > 0 && item.quantity > 0 ? item.quantity / item.minutes : null
        : item.minutes);
    const chapterDisplayValues = chapterValues.map(value => value == null
      ? null
      : quantityMetric ? questionEfficiencyDisplayValue(value) : durationDisplayValue(value));
    const color = getChartSeriesColor(quantityMetric ? 'chapterEfficiency' : 'chapterDuration');
    const archivedColor = getChartSeriesColor('archived');
    mkChart('taskAnaChapterChart', {
      type: cumulative || quantityMetric ? 'line' : 'bar',
      data: {
        labels: chapterChartLabels,
        datasets: [{
          label: quantityMetric
            ? cumulative ? `累计加权效率（${questionEfficiencyUnitLabel(unit)}）` : `逐章效率（${questionEfficiencyUnitLabel(unit)}）`
            : cumulative ? `累计平均耗时（${durationDisplayUnitLabel()}/章）` : `逐章完成耗时（${durationDisplayUnitLabel()}）`,
          data: chapterDisplayValues.map(value => value == null ? null : Number(value.toFixed(3))),
          backgroundColor: cumulative || quantityMetric ? hexRgba(color, .12) : selectedChapterItems.map(item => item.item.archived ? hexRgba(archivedColor, .42) : hexRgba(color, .4)),
          borderColor: cumulative || quantityMetric ? color : selectedChapterItems.map(item => item.item.archived ? archivedColor : color),
          borderWidth: 2.2,
          borderRadius: 4,
          pointRadius: cumulative || quantityMetric ? 4 : 0,
          pointBackgroundColor: color,
          pointBorderColor: '#07111f',
          pointBorderWidth: 1.5,
          tension: .16,
          fill: cumulative || quantityMetric,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: context => context.parsed.y == null ? '数据不足' : `${context.dataset.label}: ${quantityMetric ? Number(context.parsed.y).toFixed(3) : fmtMin(durationDisplayValueToMinutes(context.parsed.y), true)}`,
            afterLabel: context => {
              const item = selectedChapterItems[context.dataIndex];
              return [`累计数量：${forecastDisplayMetric(item.quantity)} ${unit}`, `章节累计耗时：${fmtMin(item.minutes, true)}`, `首次完成：${item.completionDate}`];
            },
          } },
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', maxRotation: 35, autoSkip: true, maxTicksLimit: 14 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: '#6b7a9e' }, grid: { color: 'rgba(107,122,158,.12)' }, title: { display: true, text: quantityMetric ? questionEfficiencyUnitLabel(unit) : `${durationDisplayUnitLabel()}/章`, color: '#6b7a9e' } },
        },
      },
    });
  }

  // 按章节完成耗时柱状图
  if (!scopedPanel && selectedChapterItems.length > 0 && document.getElementById('taskAnaChapterMinutesChart')) {
    const chapterDurationColor = getChartSeriesColor('chapterDuration');
    const archivedColor = getChartSeriesColor('archived');
    mkChart('taskAnaChapterMinutesChart', {
      type: 'bar',
      data: {
        labels: chapterChartLabels,
        datasets: [{
          label: `完成耗时（${durationDisplayUnitLabel()}）`,
          data: selectedChapterItems.map(item => durationDisplayValue(item.minutes)),
          backgroundColor: selectedChapterItems.map(item => hexRgba(item.item.archived ? archivedColor : chapterDurationColor, .45)),
          borderColor: selectedChapterItems.map(item => item.item.archived ? archivedColor : chapterDurationColor),
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
                return `累计耗时：${fmtMin(item.minutes, true)}`;
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
            ticks: { color: '#6b7a9e', callback: value => `${value}${durationDisplayUnitSuffix()}` },
            grid: gridCfg,
            min: 0,
            title: { display: true, text: `完成耗时（${durationDisplayUnitLabel()}）`, color: '#6b7a9e' }
          }
        }
      }
    });
  }

  // 章节＋数量模板：按章节题目效率折线图
  if (!scopedPanel && selectedChapterItems.length > 0 && selectedChapterTemplateStats?.template.quantityEnabled && document.getElementById('taskAnaChapterQuantityEffChart')) {
    const chapterEfficiencyColor = getChartSeriesColor('chapterEfficiency');
    mkChart('taskAnaChapterQuantityEffChart', {
      type: 'line',
      data: {
        labels: chapterChartLabels,
        datasets: [{
          label: questionEfficiencyUnitLabel(selectedChapterTemplateStats.template.quantityUnit || '题'),
          data: selectedChapterItems.map(item =>
            item.minutes > 0 && item.quantity > 0 ? +questionEfficiencyDisplayValue(item.quantity / item.minutes).toFixed(3) : null
          ),
          borderColor: chapterEfficiencyColor,
          backgroundColor: chapterEfficiencyColor,
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: chapterEfficiencyColor,
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
                  : `题目效率：${ctx.parsed.y.toFixed(3)} ${questionEfficiencyUnitLabel(selectedChapterTemplateStats.template.quantityUnit || '题')}`;
              },
              afterLabel: ctx => {
                const item = selectedChapterItems[ctx.dataIndex];
                return [
                  `累计数量：${forecastDisplayMetric(item.quantity)} ${selectedChapterTemplateStats.template.quantityUnit || '题'}`,
                  `累计耗时：${fmtMin(item.minutes, true)}`,
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
            title: { display: true, text: questionEfficiencyUnitLabel(selectedChapterTemplateStats.template.quantityUnit || '题'), color: '#6b7a9e' }
          }
        }
      }
    });
  }

  // 效率趋势图
  if ((!scopedPanel || panelKey === 'efficiency') && effDayDS.length > 0) {
    const effScale = s.effScale || 'linear';
    let chartDS = effDayDS;
    let yTitle = `效率 (${questionEfficiencyUnitLabel('数量')})`;
    let yType = 'linear';
    let yMin = 0;
    let yMax = s.effYMax ? parseFloat(s.effYMax) : undefined;
    let tooltipFmt = (ctx) => { const v = ctx.parsed.y; if (v == null) return null; return `${ctx.dataset.label}: ${v.toFixed(3)}`; };

    if (effScale === 'log') {
      yType = 'logarithmic';
      yMin = undefined; // log 轴不能从 0 开始
      yMax = undefined;
      yTitle = `效率 · 对数轴 (${questionEfficiencyUnitLabel('数量')})`;
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
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: tooltipFmt } }
        },
        scales: {
          x: { ticks: { color: '#6b7a9e', maxRotation: s.mode === 'week' ? 0 : 35, autoSkip: true, maxTicksLimit: s.mode === 'all' ? 24 : undefined }, grid: { display: false } },
          y: { type: yType, ticks: { color: '#6b7a9e' }, grid: { color: 'rgba(107,122,158,.12)' }, min: yMin, max: yMax, title: { display: true, text: yTitle, color: '#6b7a9e' } }
        }
      },
      plugins: [noRecordRegionPlugin(effChartDateStrs)],
    });
  }
}

function switchTaskAnaView(key, value) {
  const allowed = {
    durationView: ['daily', 'cumulativeAverage'],
    countView: ['daily', 'cumulativeAverage'],
    chapterMetric: ['minutes', 'quantityEfficiency'],
    chapterView: ['single', 'cumulativeAverage'],
    efficiencyView: ['daily', 'cumulativeAverage'],
  };
  if (!allowed[key]?.includes(value)) return;
  state.taskAna[key] = value;
  const panelByKey = {
    durationView: 'duration',
    countView: 'count',
    chapterMetric: 'chapter',
    chapterView: 'chapter',
    efficiencyView: 'efficiency',
  };
  renderTaskAnalysis(panelByKey[key]);
}

function taskAnaToggleSeries(group, category) {
  const hidden = state.taskAna.hiddenSeries[group];
  if (!Array.isArray(hidden)) return;
  const index = hidden.indexOf(category);
  if (index >= 0) hidden.splice(index, 1);
  else hidden.push(category);
  if (group === 'efficiency' || group === 'duration') renderTaskAnalysis(group);
}

function taskAnaShowAllSeries(group) {
  if (!state.taskAna.hiddenSeries[group]) return;
  state.taskAna.hiddenSeries[group] = [];
  if (group === 'efficiency' || group === 'duration') renderTaskAnalysis(group);
}

function taskAnaHighlightPie(index) {
  const chart = chartReg.taskAnaPieChart;
  if (!chart) return;
  chart.setActiveElements([{ datasetIndex: 0, index: Number(index) }]);
  chart.tooltip?.setActiveElements([{ datasetIndex: 0, index: Number(index) }], { x: 0, y: 0 });
  chart.update();
}

function taskAnaSetDetailLevel(level, categoryPath) {
  const value = categoryPath || '';
  if (Number(level) === 1) {
    state.taskAna.taskDetailLevel1 = value;
    state.taskAna.taskDetailLevel2 = '';
    state.taskAna.taskDetailLevel3 = '';
  } else if (Number(level) === 2) {
    state.taskAna.taskDetailLevel2 = value;
    state.taskAna.taskDetailLevel3 = '';
  } else if (Number(level) === 3) {
    state.taskAna.taskDetailLevel3 = value;
  } else return;
  renderTaskAnalysis('details');
}

function taskAnaOpenTask(dateStr, encodedTaskId) {
  const taskId = decodeURIComponent(encodedTaskId || '');
  if (!dateStr || !taskId) return;
  monthEditTask(dateStr, taskId);
}

function taskAnaSetEfficiencyLevel(level, categoryPath) {
  const s = state.taskAna;
  const value = categoryPath || '';
  if (Number(level) === 1) {
    s.effLevel1 = value;
    s.effLevel2 = '';
    s.effLevel3 = '';
  } else if (Number(level) === 2) {
    s.effLevel2 = value;
    s.effLevel3 = '';
  } else if (Number(level) === 3) {
    s.effLevel3 = value;
  } else return;
  s.effCatFilter = s.effLevel3 || '';
  renderTaskAnalysis('efficiency');
}

function taskAnaNav(action, val) {
  const s = state.taskAna;
  if (action === 'level') { s.level = val; s.catFilter = ''; }
  else if (action === 'effScale') { s.effScale = val; }
  else if (action === 'catFilter') { s.catFilter = val; }
  else if (action === 'effCatFilter') { s.effCatFilter = val; }
  else if (action === 'chapterEffTemplateId') { s.chapterEffTemplateId = val; }
  else return;
  if (action === 'effScale' || action === 'effCatFilter') renderTaskAnalysis('efficiency');
  else if (action === 'chapterEffTemplateId') renderTaskAnalysis('chapter');
  else renderTaskAnalysis();
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

function hexRgba(hex, a) {
  if (!hex || hex[0] !== '#') return `rgba(120,144,156,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function renderStackedArea(panelKey = '') {
  const sharedRange = analysisRangeMeta('stacked');
  const mode = sharedRange.analysisDates.length <= 7 ? 'week' : sharedRange.analysisDates.length > 90 ? 'all' : 'month';
  const rangeMeta = {
    ...sharedRange,
    dateStrs: sharedRange.analysisDates,
    rangeLabel: sharedRange.label,
    excludedCount: sharedRange.context.shellDates.length,
  };
  const dateStrs = rangeMeta.dateStrs;
  const chartView = ['absolute', 'percent'].includes(state.stackedChartView) ? state.stackedChartView : 'absolute';
  state.stackedChartView = chartView;
  const hiddenSeries = stackedHiddenSeriesSet();

  const rawBreakdowns = dateStrs.map(d => computeDayBreakdown(d));
  const groupLevel = state.stackedGroupLevel || 1;
  const mergeTasks = Boolean(state.stackedMergeTasks);
  const mergeSpecials = Boolean(state.stackedMergeSpecials);

  // 可按层级显示明细，也可把任务类别、特殊时段各自合并成一个汇总系列。
  const breakdowns = rawBreakdowns.map(bd => ({
    ...bd,
    taskMap: mergeTasks
      ? (bd.totalTaskMin > 0 ? { '任务记录': bd.totalTaskMin } : {})
      : regroupTaskMap(bd.taskMap, groupLevel),
    specialMap: mergeSpecials
      ? (bd.totalSpecialMin > 0 ? { '特殊时段': bd.totalSpecialMin } : {})
      : { ...bd.specialMap },
    totalTaskMin: bd.totalTaskMin, // 不变
  }));

  // 从当前显示口径收集图例与明细表列。
  const taskCatsSet = new Set();
  breakdowns.forEach(bd => Object.keys(bd.taskMap).forEach(k => taskCatsSet.add(k)));
  const taskCats = [...taskCatsSet].sort();
  const specialCatsSet = new Set();
  breakdowns.forEach(bd => Object.keys(bd.specialMap).forEach(k => specialCatsSet.add(k)));
  const specialCats = [...specialCatsSet].sort();
  const taskColors = taskCats.map(cat => mergeTasks
    ? getSystemSeriesColor('taskTotal')
    : getCategoryColor(cat, groupLevel));
  const specialColors = specialCats.map(cat => mergeSpecials
    ? getSystemSeriesColor('specialTotal')
    : getSpecialSeriesColor(cat));

  const labels = dateStrs.map(d => formatShort(d));

  // ── 构建堆积 datasets（绝对值 + 百分比共用逻辑） ──
  function buildDatasets(valueFn) {
    const ds = [];
    const maskedValues = getter => chartMaskRecordedValues(dateStrs, breakdowns.map(getter));
    // 任务类别
    taskCats.forEach((cat, index) => {
      const hex = taskColors[index];
      const seriesKey = mergeTasks ? 'task:__merged__' : `task:${cat}`;
      ds.push({
        label: cat,
        data: maskedValues(bd => valueFn(bd.taskMap[cat] || 0, bd)),
        backgroundColor: hex,
        borderColor: hex,
        borderWidth: 1,
        fill: 'origin',
        pointRadius: 0,
        tension: 0.22,
        hidden: hiddenSeries.has(seriesKey),
        _seriesKey: seriesKey,
        _seriesGroup: 'task',
        _seriesColor: hex,
      });
    });
    // 特殊时段
    specialCats.forEach((cat, index) => {
      const hex = specialColors[index];
      const seriesKey = mergeSpecials ? 'special:__merged__' : `special:${cat}`;
      ds.push({
        label: cat,
        data: maskedValues(bd => valueFn(bd.specialMap[cat] || 0, bd)),
        backgroundColor: hex,
        borderColor: hex,
        borderWidth: 1,
        fill: 'origin',
        pointRadius: 0,
        tension: 0.22,
        hidden: hiddenSeries.has(seriesKey),
        _seriesKey: seriesKey,
        _seriesGroup: 'special',
        _seriesColor: hex,
      });
    });
    // 休息
    ds.push({
      label: '休息',
      data: maskedValues(bd => valueFn(bd.focusRestMin, bd)),
      backgroundColor: hexRgba(getSystemSeriesColor('rest'), 0.48),
      borderColor: hexRgba(getSystemSeriesColor('rest'), 0.82),
      borderWidth: 1,
      fill: 'origin', pointRadius: 0, tension: 0.22,
      hidden: hiddenSeries.has('status:rest'),
      _seriesKey: 'status:rest', _seriesGroup: 'status', _seriesColor: getSystemSeriesColor('rest'),
    });
    // 分心
    ds.push({
      label: '分心',
      data: maskedValues(bd => valueFn(bd.focusDistractMin, bd)),
      backgroundColor: hexRgba(getSystemSeriesColor('distract'), 0.4),
      borderColor: hexRgba(getSystemSeriesColor('distract'), 0.78),
      borderWidth: 1,
      fill: 'origin', pointRadius: 0, tension: 0.22,
      hidden: hiddenSeries.has('status:distract'),
      _seriesKey: 'status:distract', _seriesGroup: 'status', _seriesColor: getSystemSeriesColor('distract'),
    });
    // 空闲
    ds.push({
      label: '空闲/未记录',
      data: maskedValues(bd => valueFn(bd.idleMin, bd)),
      backgroundColor: hexRgba(getSystemSeriesColor('idle'), 0.34),
      borderColor: hexRgba(getSystemSeriesColor('idle'), 0.7),
      borderWidth: 1,
      fill: 'origin', pointRadius: 0, tension: 0.22,
      hidden: hiddenSeries.has('status:idle'),
      _seriesKey: 'status:idle', _seriesGroup: 'status', _seriesColor: getSystemSeriesColor('idle'),
    });
    return ds;
  }

  // 绝对值 datasets（单位跟随通用显示设置）
  const absDatasets = buildDatasets((min, _bd) => durationDisplayValue(min));
  // 清醒参考线（独立 y 轴，不参与堆积）
  absDatasets.push({
    label: '── 清醒时长',
    data: chartMaskRecordedValues(dateStrs, breakdowns.map(bd => bd.awakeMin != null ? durationDisplayValue(bd.awakeMin, 1) : null)),
    borderColor: getSystemSeriesColor('awake'),
    borderWidth: 2.5,
    borderDash: [8, 4],
    backgroundColor: 'transparent',
    fill: false,
    pointRadius: 3,
    pointBackgroundColor: getSystemSeriesColor('awake'),
    tension: 0.35,
    yAxisID: 'yRef',
  });

  // 百分比 datasets — 存储原始分钟数，动态归一化到 100%
  const pctDatasets = buildDatasets((min, _bd) => min); // 原始分钟值
  // 在每个 dataset 上保存一份原始数据副本
  pctDatasets.forEach(ds => { ds._rawData = [...ds.data]; });

  // 创建图表前先归一化（避免首帧用原始分钟数渲染）
  (function preNormalize() {
    const len = pctDatasets[0]?.data?.length || 0;
    for (let i = 0; i < len; i++) {
      if (chartDateStatus(dateStrs[i]) !== 'recorded') {
        pctDatasets.forEach(ds => { ds.data[i] = null; });
        continue;
      }
      let sum = 0;
      pctDatasets.forEach(ds => { if (ds._rawData && !ds.hidden) sum += ds._rawData[i] || 0; });
      pctDatasets.forEach(ds => {
        if (!ds._rawData) return;
        ds.data[i] = !ds.hidden && sum > 0 ? +((ds._rawData[i] / sum) * 100).toFixed(1) : 0;
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

  const totals = {
    awake: totalAwake,
    task: totalTask,
    special: totalSpecial,
    rest: totalRest,
    distract: totalDistract,
    idle: totalIdle,
    daysWithData,
  };
  const hasBreakdownData = breakdowns.some(breakdown =>
    breakdown.awakeMin != null || breakdown.totalTaskMin > 0 || breakdown.totalSpecialMin > 0 ||
    breakdown.focusRestMin > 0 || breakdown.focusDistractMin > 0
  );
  const host = document.getElementById('tab-stacked');
  if (!host) return;
  const stackedPanelGroups = {
    chart: ['stacked-chart'],
    composition: ['stacked-hero', 'stacked-chart', 'stacked-detail'],
  };
  const requestedPanels = stackedPanelGroups[panelKey] || [];
  let scopedPanel = Boolean(requestedPanels.length && requestedPanels.every(key => host.querySelector(`[data-render-panel="${key}"]`)));
  const stackedHtml = `<div class="stacked-page">
    ${stackedToolbarHtml(rangeMeta, mode, groupLevel, daysWithData, mergeTasks, mergeSpecials)}
    ${analysisRangePlannerHtml('stacked', sharedRange)}
    ${hasBreakdownData ? `${stackedSummaryHtml(rangeMeta, totals)}
      ${stackedChartPanelHtml(mode, chartView, absDatasets)}
      ${stackedDetailTableHtml({
        dateStrs, breakdowns, taskCats, specialCats, taskColors, specialColors, totals, mergeTasks, mergeSpecials,
      })}` : stackedEmptyStateHtml()}
  </div>`;
  if (scopedPanel && !replaceRenderPanels(host, stackedHtml, requestedPanels)) scopedPanel = false;
  if (!scopedPanel) host.innerHTML = stackedHtml;

  if (!hasBreakdownData) return;

  // ── 计算 y 轴上限（取最大清醒时长向上取整） ──
  const maxAwakeHrs = durationDisplayValue(Math.max(...breakdowns.map(bd => bd.awakeMin || 0))) || 0;
  const yMax = Math.ceil(maxAwakeHrs + 1);

  const isAbsolute = chartView === 'absolute';
  const chartDatasets = isAbsolute ? absDatasets : pctDatasets;
  mkChart('stackedMainChart', {
    type: 'line',
    data: { labels, datasets: chartDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => {
              const value = context.parsed.y;
              if (value == null || value === 0) return null;
              return isAbsolute
                ? `${context.dataset.label}: ${fmtMin(Math.round(durationDisplayValueToMinutes(value)))}`
                : `${context.dataset.label}: ${value.toFixed(1)}%`;
            }
          }
        },
        filler: { propagate: true },
      },
      scales: {
        x: {
          ticks: {
            color: '#6b7a9e',
            maxRotation: mode === 'week' ? 0 : 45,
            autoSkip: true,
            maxTicksLimit: mode === 'all' ? 24 : undefined,
          },
          grid: gridCfg,
        },
        y: {
          stacked: true,
          ticks: { color: '#6b7a9e', callback: value => `${value}${isAbsolute ? 'h' : '%'}` },
          grid: gridCfg,
          title: { display: true, text: isAbsolute ? durationDisplayUnitLabel() : '可见组成 %', color: '#6b7a9e' },
          min: 0,
          max: isAbsolute ? (yMax > 0 ? yMax : undefined) : 100,
        },
        ...(isAbsolute ? {
          yRef: {
            display: false,
            stacked: false,
            min: 0,
            max: yMax > 0 ? yMax : undefined,
          }
        } : {}),
      }
    },
    plugins: [noRecordRegionPlugin(dateStrs)],
  });

}

function switchStackedChartView(view) {
  state.stackedChartView = view === 'percent' ? 'percent' : 'absolute';
  renderStackedArea('chart');
}

function stackedToggleSeries(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const hidden = stackedHiddenSeriesSet();
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  state.stackedHiddenSeries = [...hidden];
  renderStackedArea('chart');
}

function stackedShowAllSeries() {
  state.stackedHiddenSeries = [];
  renderStackedArea('chart');
}

function switchStackedLevel(level) {
  if (state.stackedMergeTasks) return;
  state.stackedGroupLevel = level;
  renderStackedArea('composition');
}

function toggleStackedMerge(group) {
  if (group === 'task') state.stackedMergeTasks = !state.stackedMergeTasks;
  else if (group === 'special') state.stackedMergeSpecials = !state.stackedMergeSpecials;
  else return;
  renderStackedArea('composition');
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
  if (!['7d', '30d', '70d', '90d', 'year', 'all', 'custom', 'hierarchy'].includes(settings.capacityRangeMode)) {
    settings.capacityRangeMode = 'custom';
  }
  settings.capacityPickerOpen = settings.capacityPickerOpen === true;
  if (!['year', 'month', 'week', 'day'].includes(settings.capacityHierarchyLevel)) settings.capacityHierarchyLevel = 'year';
  settings.capacityHierarchyYear = Number.isInteger(Number(settings.capacityHierarchyYear))
    ? Number(settings.capacityHierarchyYear)
    : new Date().getFullYear();
  settings.capacityHierarchyMonth = Number.isInteger(Number(settings.capacityHierarchyMonth))
    ? Math.min(11, Math.max(0, Number(settings.capacityHierarchyMonth)))
    : new Date().getMonth();
  settings.capacityHierarchyWeekStart = /^\d{4}-\d{2}-\d{2}$/.test(settings.capacityHierarchyWeekStart || '')
    ? settings.capacityHierarchyWeekStart
    : '';
  settings.capacityHierarchyLabel = String(settings.capacityHierarchyLabel || '').trim();
  settings.forecastTrackToday = settings.forecastTrackToday === true;
  settings.forecastStartDate = settings.forecastTrackToday
    ? forecastNormalizeStartDate(getTodayStr())
    : forecastNormalizeStartDate(settings.forecastStartDate);
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

function templateUsesChapterQuestionCounts(template) {
  return Boolean(template?.chapterQuantityOnly && template.quantityEnabled && (template.namedItemEnabled ?? template.ordinalEnabled));
}

function forecastModeFromTemplate(template) {
  if (templateUsesChapterQuestionCounts(template)) return 'quantity';
  const namedItemEnabled = template?.namedItemEnabled ?? template?.ordinalEnabled;
  if (namedItemEnabled) return template.quantityEnabled ? 'chapterQuantity' : 'chapter';
  if (template?.quantityEnabled) return 'quantity';
  return '';
}

function stackedToolbarHtml(meta, mode, groupLevel, daysWithData, mergeTasks, mergeSpecials) {
  return `<section class="stacked-hero" data-render-panel="stacked-hero">
    <div class="stacked-hero-head">
      <div>
        <div class="stacked-eyebrow">TIME COMPOSITION</div>
        <h2>时间堆积分析</h2>
        <p>按任务、特殊时段和时间状态查看清醒时间的组成变化。</p>
      </div>
      <div class="stacked-range-overview">
        <span>当前范围</span>
        <strong>${escHtmlApp(meta.rangeLabel)}</strong>
        <small>${daysWithData} 天具有完整清醒与分解数据${meta.excludedCount ? ` · ${meta.excludedCount} 天不评分已排除` : ''}</small>
      </div>
    </div>
    <div class="stacked-toolbar">
      <div class="stacked-control-group">
        <span>类别层级</span>
        <div class="stacked-segmented compact">
          <button class="${groupLevel === 1 ? 'active' : ''}" onclick="switchStackedLevel(1)" ${mergeTasks ? 'disabled' : ''}>一级</button>
          <button class="${groupLevel === 2 ? 'active' : ''}" onclick="switchStackedLevel(2)" ${mergeTasks ? 'disabled' : ''}>二级</button>
          <button class="${groupLevel === 3 ? 'active' : ''}" onclick="switchStackedLevel(3)" ${mergeTasks ? 'disabled' : ''}>三级</button>
        </div>
      </div>
      <div class="stacked-control-group">
        <span>合并显示</span>
        <div class="stacked-segmented compact">
          <button type="button" class="${mergeTasks ? 'active' : ''}" aria-pressed="${mergeTasks}" title="把所有任务类别合并为一个“任务记录”系列" onclick="toggleStackedMerge('task')">任务记录</button>
          <button type="button" class="${mergeSpecials ? 'active' : ''}" aria-pressed="${mergeSpecials}" title="把所有特殊时段名称合并为一个“特殊时段”系列" onclick="toggleStackedMerge('special')">特殊时段</button>
        </div>
      </div>
    </div>
  </section>`;
}

function stackedSummaryMetricHtml(label, value, percent, tone, tipKey, color) {
  return `<div class="stacked-summary-metric ${tone}" style="--metric-color:${color}">
    <span class="stacked-summary-label">${label}${tipIcon(tipKey)}</span>
    <strong>${value}</strong>
    <small>占清醒 ${percent}%</small>
    <i></i>
  </div>`;
}

function stackedSummaryHtml(meta, totals) {
  const pctOf = value => totals.awake > 0 ? Math.round(value / totals.awake * 100) : 0;
  const accounted = totals.task + totals.special + totals.rest + totals.distract;
  const overlap = Math.max(0, accounted - totals.awake);
  return `<section class="stacked-summary">
    <div class="stacked-awake-summary" style="--awake-color:${getSystemSeriesColor('awake')}">
      <span>清醒总时长${tipIcon('stackAwake')}</span>
      <strong>${fmtMin(totals.awake, true)}</strong>
      <div>${totals.daysWithData} 天有效数据 · ${escHtmlApp(meta.rangeLabel)}</div>
    </div>
    <div class="stacked-summary-grid">
      ${stackedSummaryMetricHtml('任务记录', fmtMin(totals.task, true), pctOf(totals.task), 'task', 'stackTask', getSystemSeriesColor('taskTotal'))}
      ${stackedSummaryMetricHtml('特殊时段', fmtMin(totals.special, true), pctOf(totals.special), 'special', 'stackSpecial', getSystemSeriesColor('specialTotal'))}
      ${stackedSummaryMetricHtml('休息时间', fmtMin(totals.rest, true), pctOf(totals.rest), 'rest', 'stackRest', getSystemSeriesColor('rest'))}
      ${stackedSummaryMetricHtml('分心时间', fmtMin(totals.distract, true), pctOf(totals.distract), 'distract', 'stackDistract', getSystemSeriesColor('distract'))}
      ${stackedSummaryMetricHtml('空闲/未记录', fmtMin(totals.idle, true), pctOf(totals.idle), 'idle', 'stackIdle', getSystemSeriesColor('idle'))}
    </div>
    ${overlap > 0 ? `<div class="stacked-accounting-note">任务记录和时段记录采用独立口径，当前可识别时间比清醒总时长多 ${fmtMin(overlap, true)}；图表保留原始记录，不自动扣减。</div>` : ''}
  </section>`;
}

function stackedHiddenSeriesSet() {
  return new Set(Array.isArray(state.stackedHiddenSeries) ? state.stackedHiddenSeries : []);
}

function stackedLegendHtml(datasets, chartView) {
  const hidden = stackedHiddenSeriesSet();
  const hiddenCount = datasets.filter(dataset => dataset._seriesKey && hidden.has(dataset._seriesKey)).length;
  const groups = [
    { key: 'task', label: state.stackedMergeTasks ? '任务汇总' : '任务类别' },
    { key: 'special', label: state.stackedMergeSpecials ? '特殊时段汇总' : '特殊时段' },
    { key: 'status', label: '时间状态' },
  ];
  const groupHtml = groups.map(group => {
    const items = datasets.filter(dataset => dataset._seriesGroup === group.key);
    if (!items.length) return '';
    return `<div class="stacked-legend-group">
      <span class="stacked-legend-label">${group.label}</span>
      <div class="stacked-legend-items">
        ${items.map(dataset => {
          const encodedKey = encodeURIComponent(dataset._seriesKey).replace(/'/g, '%27');
          const isHidden = hidden.has(dataset._seriesKey);
          return `<button type="button" class="stacked-legend-item ${isHidden ? 'is-hidden' : ''}" data-visual-series-key="${escHtmlApp(dataset._seriesKey)}"
            style="--stack-color:${dataset._seriesColor}" onclick="stackedToggleSeries('${encodedKey}')" aria-pressed="${!isHidden}">
            <i></i><span>${escHtmlApp(dataset.label)}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  return `<div class="stacked-legend">
    <div class="stacked-legend-head">
      <span>显示系列</span>
      <button class="btn btn-ghost btn-sm" onclick="stackedShowAllSeries()" ${hiddenCount ? '' : 'disabled'}>全部显示</button>
    </div>
    ${groupHtml}
    ${chartView === 'absolute' ? `<div class="stacked-legend-reference" style="--awake-color:${getSystemSeriesColor('awake')}"><i></i><span>清醒时长参考线</span></div>` : ''}
  </div>`;
}

function stackedChartPanelHtml(mode, chartView, datasets) {
  const isAbsolute = chartView === 'absolute';
  return `<section class="stacked-chart-panel range-${mode}" data-render-panel="stacked-chart">
    <div class="stacked-chart-head">
      <div>
        <div class="stacked-eyebrow">COMPOSITION TREND</div>
        <h3>${isAbsolute ? '每日时间分解' : '可见时间组成占比'}</h3>
        <p>${isAbsolute ? `纵轴为${durationDisplayUnitLabel()}，黄色虚线表示当天清醒总时长。` : '当前可见系列会重新归一化为 100%。'}</p>
      </div>
      <div class="stacked-segmented chart-view">
        <button class="${isAbsolute ? 'active' : ''}" onclick="switchStackedChartView('absolute')">绝对时长</button>
        <button class="${!isAbsolute ? 'active' : ''}" onclick="switchStackedChartView('percent')">结构占比</button>
      </div>
    </div>
    ${stackedLegendHtml(datasets, chartView)}
    <div class="stacked-chart-canvas"><canvas id="stackedMainChart"></canvas></div>
  </section>`;
}

function stackedTableHeaderCellHtml(label, color, sortKey = '') {
  const heading = `<span class="stacked-table-heading" style="--stack-color:${color}"><i></i>${escHtmlApp(label)}</span>`;
  return sortKey ? sortableTableHeaderHtml('stacked-detail', sortKey, heading) : `<th>${heading}</th>`;
}

function stackedDetailSortKey(group, label) {
  return `${group}:${encodeURIComponent(String(label || '')).replace(/'/g, '%27')}`;
}

function stackedDetailTableHtml(context) {
  const { dateStrs, breakdowns, taskCats, specialCats, taskColors, specialColors, totals, mergeTasks, mergeSpecials } = context;
  return `<details class="stacked-detail-panel" data-render-panel="stacked-detail">
    <summary>
      <div><strong>每日时间分解明细</strong><span>逐日核对各类别的实际组成</span></div>
      <div>${dateStrs.length} 天 · ${mergeTasks ? '任务已合并' : `${taskCats.length} 个任务类别`} · ${mergeSpecials ? '特殊时段已合并' : `${specialCats.length} 个特殊时段`}</div>
    </summary>
    <div class="stacked-detail-body">
      <div class="stacked-table-wrap">
        <table class="stacked-detail-table" data-sort-table="stacked-detail">
          <thead>
            <tr class="stacked-table-groups">
              <th colspan="2">基础信息</th>
              ${taskCats.length ? `<th colspan="${taskCats.length}">${mergeTasks ? '任务记录' : '任务类别'}</th>` : ''}
              ${specialCats.length ? `<th colspan="${specialCats.length}">${mergeSpecials ? '特殊时段汇总' : '特殊时段'}</th>` : ''}
              <th colspan="3">时间状态</th>
            </tr>
            <tr>
              ${sortableTableHeaderHtml('stacked-detail', 'date', '日期', 'date')}${sortableTableHeaderHtml('stacked-detail', 'awake', '清醒')}
              ${taskCats.map((cat, index) => stackedTableHeaderCellHtml(cat, taskColors[index], stackedDetailSortKey('task', cat))).join('')}
              ${specialCats.map((cat, index) => stackedTableHeaderCellHtml(cat, specialColors[index], stackedDetailSortKey('special', cat))).join('')}
              ${stackedTableHeaderCellHtml('休息', getSystemSeriesColor('rest'), 'rest')}
              ${stackedTableHeaderCellHtml('分心', getSystemSeriesColor('distract'), 'distract')}
              ${stackedTableHeaderCellHtml('空闲', getSystemSeriesColor('idle'), 'idle')}
            </tr>
          </thead>
          <tbody>
            ${breakdowns.map((breakdown, index) => {
              const hasData = breakdown.awakeMin != null;
              const sortValues = {
                date: dateStrs[index], awake: hasData ? breakdown.awakeMin : null,
                rest: Number(breakdown.focusRestMin) || 0,
                distract: Number(breakdown.focusDistractMin) || 0,
                idle: hasData ? Number(breakdown.idleMin) || 0 : null,
              };
              taskCats.forEach(cat => { sortValues[stackedDetailSortKey('task', cat)] = Number(breakdown.taskMap[cat]) || 0; });
              specialCats.forEach(cat => { sortValues[stackedDetailSortKey('special', cat)] = Number(breakdown.specialMap[cat]) || 0; });
              return `<tr ${sortableTableRowAttrs(sortValues, index)}>
                <td class="fw-mono">${formatShort(dateStrs[index])}</td>
                <td class="fw-mono stacked-awake-cell">${hasData ? fmtMin(breakdown.awakeMin) : '-'}</td>
                ${taskCats.map(cat => `<td class="fw-mono">${breakdown.taskMap[cat] ? fmtMin(breakdown.taskMap[cat]) : '-'}</td>`).join('')}
                ${specialCats.map(cat => `<td class="fw-mono">${breakdown.specialMap[cat] ? fmtMin(breakdown.specialMap[cat]) : '-'}</td>`).join('')}
                <td class="fw-mono">${breakdown.focusRestMin ? fmtMin(breakdown.focusRestMin) : '-'}</td>
                <td class="fw-mono">${breakdown.focusDistractMin ? fmtMin(breakdown.focusDistractMin) : '-'}</td>
                <td class="fw-mono">${hasData ? fmtMin(breakdown.idleMin) : '-'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td>合计</td>
            <td class="fw-mono stacked-awake-cell">${fmtMin(totals.awake, true)}</td>
            ${taskCats.map(cat => {
              const sum = breakdowns.reduce((total, breakdown) => total + (breakdown.taskMap[cat] || 0), 0);
              return `<td class="fw-mono">${sum ? fmtMin(sum) : '-'}</td>`;
            }).join('')}
            ${specialCats.map(cat => {
              const sum = breakdowns.reduce((total, breakdown) => total + (breakdown.specialMap[cat] || 0), 0);
              return `<td class="fw-mono">${sum ? fmtMin(sum) : '-'}</td>`;
            }).join('')}
            <td class="fw-mono">${fmtMin(totals.rest, true)}</td>
            <td class="fw-mono">${fmtMin(totals.distract, true)}</td>
            <td class="fw-mono">${fmtMin(totals.idle, true)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  </details>`;
}

function stackedEmptyStateHtml() {
  return `<div class="stacked-empty-state">
    <strong>当前范围暂无可分解记录</strong>
    <p>录入起床与睡觉时间，并添加任务或时段记录后，这里会显示时间组成。</p>
  </div>`;
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

function migrateTaskTemplateAccuracySettings() {
  const legacyTemplateIds = new Set(getTaskTemplates()
    .filter(template => typeof template.accuracyEnabled !== 'boolean')
    .map(template => template.id));
  if (!legacyTemplateIds.size) return;
  const evidenceUnits = new Map();
  forEachStoredTask(task => {
    const templateId = resolveTaskTemplateId(task);
    if (!legacyTemplateIds.has(templateId)) return;
    const evidence = taskAccuracyEvidence(task, true);
    if (!evidence) return;
    task.accuracy = evidence.accuracy;
    if (!evidenceUnits.has(templateId)) evidenceUnits.set(templateId, evidence.quantityUnit);
    else if (!evidenceUnits.get(templateId) && evidence.quantityUnit) evidenceUnits.set(templateId, evidence.quantityUnit);
  });
  getTaskTemplates().forEach(template => {
    if (!legacyTemplateIds.has(template.id)) return;
    const enabled = evidenceUnits.has(template.id);
    template.accuracyEnabled = enabled;
    if (enabled) {
      template.quantityEnabled = true;
      if (!String(template.quantityUnit || '').trim()) template.quantityUnit = evidenceUnits.get(template.id) || '数量';
    }
  });
}

function migrateTaskTemplateScoringSettings() {
  getTaskTemplates().forEach(template => {
    if (template.chapterScoringEnabled && !template.scoreEnabled &&
      (template.namedItemEnabled ?? template.ordinalEnabled) && !template.quantityEnabled) {
      template.scoreEnabled = true;
      template.scoreMax = template.chapterMaxScore;
    }
    // Keep legacy maxima for saved analysis standards without retaining a second switch.
    template.chapterScoringEnabled = false;
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
    chapterQuantityOnly: templateUsesChapterQuestionCounts(template),
    totalQuantity: templateUsesChapterQuestionCounts(template)
      ? forecastNamedItemQuestionTotal(template.namedItems || []) : goal?.totalQuantity,
    namedItems: Array.isArray(template?.namedItems) ? template.namedItems : [],
    ordinalUnit: template?.ordinalUnit || '',
    quantityUnit: template?.quantityUnit || '',
  };
}

function taskNamedItemAllocations(task) {
  return Array.isArray(task?.namedItemAllocations)
    ? task.namedItemAllocations.map(item => ({
      itemId: String(item?.itemId || ''),
      itemName: String(item?.itemName || '').trim(),
      minutes: Number(item?.minutes) || 0,
      quantity: item?.quantity == null ? null : Number(item.quantity),
      completed: Boolean(item?.completed),
      score: item?.score == null ? null : Number(item.score),
      isNew: Boolean(item?.isNew),
    })).filter(item => (item.itemId || item.itemName) && item.itemName)
    : [];
}

function taskNamedItemCardHtml(allocation, quantityEnabled) {
  const completed = Boolean(allocation.completed);
  const scoringEnabled = Boolean(allocation.scoringEnabled);
  const maxScore = Number(allocation.maxScore);
  const scoreValue = allocation.score == null ? '' : allocation.score;
  return `<div class="task-named-item-card" data-item-id="${escHtmlApp(allocation.itemId)}"
    data-item-name="${escHtmlApp(allocation.itemName)}" data-new="${allocation.isNew ? 'true' : 'false'}"
    data-completed="${completed ? 'true' : 'false'}" role="button" tabindex="0"
    onclick="taskToggleNamedItemCompleted(event,this)"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();taskToggleNamedItemCompleted(event,this)}"
    style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px;border:1px solid ${completed ? 'rgba(102,187,106,.65)' : 'var(--border)'};border-radius:7px;background:${completed ? 'rgba(102,187,106,.10)' : 'rgba(255,255,255,.015)'};cursor:pointer">
    <div>
      <div class="form-hint">章节</div>
      <b style="overflow-wrap:anywhere">${escHtmlApp(allocation.itemName)}</b>
      ${allocation.isNew ? '<span class="c-wake" style="font-size:10px;margin-left:5px">保存任务后入库</span>' : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
      <span class="task-named-completed-status" style="font-size:11px;color:${completed ? '#66bb6a' : 'var(--muted)'}">${completed ? '✓ 本次完成' : '进行中'}</span>
      <label class="task-named-score-field" style="display:${scoringEnabled && completed ? 'flex' : 'none'};align-items:center;gap:4px;font-size:11px;color:var(--muted)" onclick="event.stopPropagation()">得分 <input type="number" class="task-named-score" aria-label="${escHtmlApp(allocation.itemName)}得分" min="0" max="${Number.isFinite(maxScore) && maxScore > 0 ? maxScore : ''}" step="0.1" value="${escHtmlApp(String(scoreValue))}" placeholder="0-${Number.isFinite(maxScore) && maxScore > 0 ? maxScore : '满分'}" ${scoringEnabled && completed ? 'required' : 'disabled'} onclick="event.stopPropagation()" onkeydown="event.stopPropagation()" style="width:90px"></label>
      <input type="checkbox" class="task-named-completed" ${completed ? 'checked' : ''} hidden>
      <button type="button" class="btn btn-danger btn-sm" onclick="event.stopPropagation();taskNamedItemRemove('${allocation.itemId}')">移除</button>
    </div>
  </div>`;
}

function taskNamedItemStatusHtml(template, allocations = []) {
  if (!template) return '';
  const activeItems = [...(template.namedItems || [])]
    .filter(item => !item.archived)
    .sort((a, b) => a.order - b.order);
  const selectedById = new Map(allocations.map(item => [item.itemId, item]));
  const selectedByName = new Map(allocations.map(item => [
    String(item.itemName || '').trim().toLocaleLowerCase(),
    item,
  ]));
  const libraryProgress = namedItemLibraryProgress(template.id).progress;
  let completedCount = 0;
  let availableCount = 0;

  const rows = activeItems.map(item => {
    const selected = selectedById.get(item.id) ||
      selectedByName.get(String(item.name || '').trim().toLocaleLowerCase());
    const completionInfo = taskNamedItemCompletionInfo(template.id, item.id, item.name);
    const completedInCurrentTask = Boolean(selected?.completed);
    const completed = Boolean(completionInfo || completedInCurrentTask);
    const itemProgress = libraryProgress.get(item.id);
    if (completed) completedCount++;
    if (!completed && !selected) availableCount++;

    let detail = '未开始';
    if (completionInfo) {
      detail = `已于 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成`;
    } else if (completedInCurrentTask) {
      detail = '已在当前任务中标记为完成';
    } else if (itemProgress?.records?.length) {
      detail = `进行中 · 累计 ${fmtMin(itemProgress.minutes, true)}`;
      if (template.quantityEnabled && itemProgress.quantity > 0) {
        detail += ` · ${forecastDisplayMetric(itemProgress.quantity)} ${template.quantityUnit || '数量'}`;
      }
    }
    if (template.scoreEnabled && itemProgress?.records.some(record => record.score !== null)) {
      detail += ` · 累计得分 ${forecastDisplayMetric(itemProgress.score)}`;
    }
    if (item.questionCount != null) detail += ` · 总题数 ${item.questionCount} 题`;

    const rowClass = `${selected ? ' selected' : ''}${completed ? ' completed' : ''}`;
    const action = selected
      ? '<button type="button" class="task-named-status-action selected" disabled>本次已添加</button>'
      : completed
        ? '<button type="button" class="task-named-status-action completed" disabled>已完成，不可选择</button>'
        : `<button type="button" class="task-named-status-action"
            data-template-id="${escHtmlApp(template.id)}" data-item-id="${escHtmlApp(item.id)}"
            onclick="taskNamedItemPick(this)">＋ 选择</button>`;
    return `<div class="task-named-status-row${rowClass}" data-item-id="${escHtmlApp(item.id)}">
      <div class="task-named-status-copy">
        <b>${escHtmlApp(item.name)}</b>
        <span>${escHtmlApp(detail)}</span>
      </div>
      ${action}
    </div>`;
  }).join('');

  return `<div class="task-named-status-summary">
      <span>章节库 <b>${activeItems.length}</b> 个</span>
      <span>本次已添加 <b>${allocations.length}</b> 个</span>
      <span>已完成 <b data-task-named-summary="completed">${completedCount}</b> 个</span>
      <span>可选 <b>${availableCount}</b> 个</span>
    </div>
    <div class="task-named-status-list">
      ${rows || '<div class="form-hint">共享章节库中还没有章节。</div>'}
    </div>`;
}

function taskNamedItemsEditorHtml(template, values, quantityEnabled) {
  const templateItems = Array.isArray(template?.namedItems) ? template.namedItems : [];
  const allocations = taskNamedItemAllocations(values).map(allocation => {
    const idMatch = templateItems.find(item => item.id === allocation.itemId);
    const nameMatch = templateItems.find(item =>
      entryTextImportChapterKey(item.name) === entryTextImportChapterKey(allocation.itemName));
    const match = idMatch || nameMatch;
    return match
      ? { ...allocation, itemId: match.id, itemName: match.name, isNew: false }
      : { ...allocation, isNew: true };
  });
  const activeItems = [...(template?.namedItems || [])].filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const selectableItems = template
    ? activeItems.filter(item => !taskNamedItemCompletionInfo(template.id, item.id, item.name))
    : activeItems;
  const scoringEnabled = Boolean(template ? template.scoreEnabled : values.scoreEnabled);
  const maxScore = Number(template?.scoreMax ?? values.scoreMax);
  return `<div id="task_named_item_editor" style="margin-top:12px" data-template-id="${template?.id || ''}" data-quantity-enabled="${quantityEnabled ? 'true' : 'false'}" data-score-enabled="${scoringEnabled ? 'true' : 'false'}" data-score-max="${Number.isFinite(maxScore) && maxScore > 0 ? maxScore : ''}">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <label>本次涉及的命名章节 *</label>
      ${template ? `<button type="button" class="btn btn-ghost btn-sm" onclick="taskManageSharedNamedItems('${template.id}')">管理共享章节库</button>` : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:6px 0">
      <input id="task_named_item_input" list="task_named_item_options" placeholder="搜索已有章节或输入新章节名称"
        onkeydown="if(event.key==='Enter'){event.preventDefault();taskNamedItemAdd('${template?.id || ''}')}">
      <datalist id="task_named_item_options">${selectableItems.map(item => `<option value="${escHtmlApp(item.name)}">`).join('')}</datalist>
      <button type="button" class="btn btn-primary btn-sm" onclick="taskNamedItemAdd('${template?.id || ''}')">添加</button>
    </div>
    <div id="task_named_item_status">${taskNamedItemStatusHtml(template, allocations)}</div>
    <div id="task_named_item_suggestion" style="display:none;margin:6px 0"></div>
    <div id="task_named_item_cards" style="display:grid;gap:8px">${allocations.map(item => taskNamedItemCardHtml({ ...item, scoringEnabled, maxScore }, quantityEnabled)).join('')}</div>
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
  const accuracyEnabled = template ? Boolean(template.accuracyEnabled) : Boolean(values.accuracyEnabled);
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
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" ${accuracyEnabled ? 'checked' : ''} ${quantityEnabled ? '' : 'disabled'}
          onchange="taskTemplateToggleFeature('${template.id}','accuracy',this)">
        正确率记录（错题数必填）
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" ${template.scoreEnabled ? 'checked' : ''}
          onchange="taskTemplateToggleFeature('${template.id}','score',this)">
        分数记录（每章满分 ${template.scoreMax || '未设置'}）
      </label>`
    : `<label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_ordinal_enabled" ${ordinalEnabled ? 'checked' : ''} onchange="taskNewUnitToggle()">
        新模板开启命名章节记录
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_quantity_enabled" ${quantityEnabled ? 'checked' : ''} onchange="taskNewUnitToggle('quantity')">
        新模板开启数量记录
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_accuracy_enabled" ${accuracyEnabled ? 'checked' : ''} ${quantityEnabled ? '' : 'disabled'} onchange="taskNewUnitToggle('accuracy')">
        新模板开启正确率记录（错题数必填）
      </label>
      <label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="task_new_score_enabled" ${values.scoreEnabled ? 'checked' : ''} ${ordinalEnabled ? '' : 'disabled'} onchange="taskNewUnitToggle('score')">
        新模板开启分数记录
      </label>
      <label id="task_new_score_max_field" style="display:${values.scoreEnabled ? 'flex' : 'none'};align-items:center;gap:6px">
        每章满分 <input type="number" id="task_new_score_max" min="0.1" step="0.1" value="${escHtmlApp(String(values.scoreMax ?? ''))}" placeholder="例如 100" oninput="configureTaskUnitFields('')" style="width:100px">
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
    score: 0,
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
        const allocatedScore = allocation.score == null ? NaN : Number(allocation.score);
        itemProgress.minutes += allocatedMinutes;
        itemProgress.quantity += allocatedQuantity;
        if (Number.isFinite(allocatedScore) && allocatedScore >= 0) {
          itemProgress.score += allocatedScore;
        }
        itemProgress.records.push({
          date,
          taskId: task.id,
          taskName: task.name || '未命名任务',
          activityType: task.activityType || '',
          minutes: allocatedMinutes,
          quantity: allocation.quantity != null && Number.isFinite(Number(allocation.quantity)) ? allocatedQuantity : null,
          taskTotalQuantity: task.quantity != null && Number.isFinite(Number(task.quantity)) ? Number(task.quantity) : null,
          quantityUnit: task.quantityUnit || template?.quantityUnit || '',
          score: Number.isFinite(allocatedScore) && allocatedScore >= 0 ? allocatedScore : null,
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

function taskRefreshNamedItemStatus(templateId) {
  const host = document.getElementById('task_named_item_status');
  const template = getTaskTemplateById(templateId);
  if (!host || !template) return;
  const previousScrollTop = host.querySelector('.task-named-status-list')?.scrollTop || 0;
  host.innerHTML = taskNamedItemStatusHtml(template, taskCollectNamedItemAllocations(false));
  const list = host.querySelector('.task-named-status-list');
  if (list) list.scrollTop = previousScrollTop;
}

function taskNamedItemPick(button) {
  const templateId = button?.dataset.templateId || '';
  const itemId = button?.dataset.itemId || '';
  const template = getTaskTemplateById(templateId);
  const item = template?.namedItems?.find(candidate => candidate.id === itemId);
  if (item) taskNamedItemAdd(templateId, item.name);
}

function taskUpdateNamedItemStatusCompletion(templateId, itemId, completed) {
  const host = document.getElementById('task_named_item_status');
  const template = getTaskTemplateById(templateId);
  if (!host || !template) return;
  const row = [...host.querySelectorAll('.task-named-status-row')]
    .find(candidate => candidate.dataset.itemId === itemId);
  const item = template.namedItems?.find(candidate => candidate.id === itemId);
  if (!row || !item) return;

  row.classList.toggle('completed', completed);
  const detail = row.querySelector('.task-named-status-copy span');
  if (detail) {
    if (completed) {
      detail.textContent = '已在当前任务中标记为完成';
    } else {
      const itemProgress = namedItemLibraryProgress(templateId).progress.get(itemId);
      if (itemProgress?.records?.length) {
        detail.textContent = `进行中 · 累计 ${fmtMin(itemProgress.minutes, true)}`;
        if (template.quantityEnabled && itemProgress.quantity > 0) {
          detail.textContent += ` · ${forecastDisplayMetric(itemProgress.quantity)} ${template.quantityUnit || '数量'}`;
        }
      } else {
        detail.textContent = '未开始';
      }
    }
  }
  const completedTotal = host.querySelectorAll('.task-named-status-row.completed').length;
  const completedSummary = host.querySelector('[data-task-named-summary="completed"]');
  if (completedSummary) completedSummary.textContent = String(completedTotal);
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
  const normalized = entryTextImportChapterKey(name);
  const matched = allItems.find(item => entryTextImportChapterKey(item.name) === normalized);
  if (matched?.archived) {
    alert(`章节“${matched.name}”已归档，请先在共享章节库中恢复。`);
    return;
  }
  if (matched) {
    const completionInfo = taskNamedItemCompletionInfo(templateId, matched.id, matched.name);
    if (completionInfo) {
      alert(`章节“${matched.name}”已于 ${completionInfo.date} 的任务“${completionInfo.taskName}”中完成，不能再次选择。`);
      return;
    }
  }
  const itemId = matched?.id || `draft-${uid()}`;
  const cards = document.getElementById('task_named_item_cards');
  if (!cards) return;
  if ([...cards.querySelectorAll('.task-named-item-card')].some(card =>
    card.dataset.itemId === itemId || entryTextImportChapterKey(card.dataset.itemName) === normalized)) {
    alert(`章节“${name}”已经加入本次任务。`);
    return;
  }
  const quantityEnabled = document.getElementById('task_named_item_editor')?.dataset.quantityEnabled === 'true';
  const holder = document.createElement('div');
  const scoringEnabled = document.getElementById('task_named_item_editor')?.dataset.scoreEnabled === 'true';
  const maxScore = Number(document.getElementById('task_named_item_editor')?.dataset.scoreMax);
  holder.innerHTML = taskNamedItemCardHtml({
    itemId,
    itemName: matched?.name || name,
    minutes: 0,
    quantity: null,
    completed: false,
    scoringEnabled,
    maxScore,
    isNew: !matched,
  }, quantityEnabled);
  cards.appendChild(holder.firstElementChild);
  if (input) input.value = '';
  taskRecalculateNamedItemTotals();
  taskRefreshNamedItemStatus(templateId);
  taskUpdateNamedItemSuggestion(templateId, itemId, matched?.name || name);
}

function taskToggleNamedItemCompleted(event, card) {
  if (!card || event?.target?.closest('button')) return;
  const checkbox = card.querySelector('.task-named-completed');
  const status = card.querySelector('.task-named-completed-status');
  const templateId = document.getElementById('task_named_item_editor')?.dataset.templateId || '';
  if (!checkbox) return;
  if (!checkbox.checked) {
    const itemId = card.dataset.itemId || '';
    const itemName = card.dataset.itemName || '';
    const original = taskOriginalNamedItemAllocation(itemId, itemName);
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
  taskUpdateNamedItemStatusCompletion(templateId, card.dataset.itemId || '', checkbox.checked);
  configureTaskUnitFields(templateId);
}

function taskNamedItemRemove(itemId) {
  document.querySelector(`.task-named-item-card[data-item-id="${itemId}"]`)?.remove();
  taskRecalculateNamedItemTotals();
  const templateId = document.getElementById('task_named_item_editor')?.dataset.templateId || '';
  taskRefreshNamedItemStatus(templateId);
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
      score: row.querySelector('.task-named-score')?.value?.trim()
        ? Number(row.querySelector('.task-named-score').value)
        : null,
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
  configureTaskUnitFields(editor.dataset.templateId || '');
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

function forecastSortedTaskEntries(entries) {
  return (entries || []).map((entry, sourceIndex) => ({ ...entry, sourceIndex }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.sourceIndex - b.sourceIndex);
}

function forecastTaskRecord(entry, extra = {}) {
  const task = entry.task || {};
  return {
    date: entry.date,
    taskId: task.id || '',
    taskName: task.name || '未命名任务',
    minutes: Math.max(0, Number(task.minutes) || 0),
    quantity: task.quantity != null && Number.isFinite(Number(task.quantity)) ? Number(task.quantity) : null,
    quantityUnit: task.quantityUnit || '',
    ...extra,
  };
}

function forecastQuantityEntryReasons(goal, task) {
  const reasons = [];
  const quantity = Number(task?.quantity);
  const minutes = Number(task?.minutes);
  if (!Number.isInteger(quantity) || quantity <= 0) reasons.push('未填写有效题数');
  if (!Number.isInteger(minutes) || minutes <= 0) reasons.push('未填写有效任务时长');
  if (String(task?.quantityUnit || '') !== String(goal.quantityUnit || '')) {
    reasons.push(`数量单位不同（记录为${task?.quantityUnit || '未标单位'}，目标为${goal.quantityUnit || '未标单位'}）`);
  }
  return reasons;
}

function forecastQuantityResult(goal, entries) {
  const records = [];
  const excludedRecords = [];
  let cumulativeQuantity = 0;
  forecastSortedTaskEntries(entries).forEach(entry => {
    const reasons = forecastQuantityEntryReasons(goal, entry.task);
    if (reasons.length) {
      excludedRecords.push(forecastTaskRecord(entry, { reasons }));
      return;
    }
    const quantity = Number(entry.task.quantity);
    const minutes = Number(entry.task.minutes);
    cumulativeQuantity += quantity;
    records.push(forecastTaskRecord(entry, {
      quantity,
      cumulativeQuantity,
      efficiency: quantity / minutes,
    }));
  });
  const valid = records;
  const completed = valid.reduce((sum, record) => sum + Number(record.quantity), 0);
  const minutes = valid.reduce((sum, record) => sum + Number(record.minutes), 0);
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
    completedEffortMinutes: speed > 0 ? Number(goal.totalQuantity) / speed : minutes,
    excluded: excludedRecords.length,
    records,
    excludedRecords,
    summary: `已完成 ${completed} / ${goal.totalQuantity} ${goal.quantityUnit}`,
    efficiency: speed > 0 ? formatQuestionEfficiency(speed, goal.quantityUnit || '题', 2) : '数据不足',
  };
}

function forecastActiveNamedItems(goal) {
  return [...(Array.isArray(goal.namedItems) ? goal.namedItems : [])]
    .filter(item => !item.archived && item.id && String(item.name || '').trim())
    .sort((a, b) => Number(a.order) - Number(b.order));
}

function forecastNamedItemGroups(goal, entries, requireQuantity = false) {
  const items = [...(Array.isArray(goal.namedItems) ? goal.namedItems : [])]
    .filter(item => item.id && String(item.name || '').trim())
    .sort((a, b) => Number(a.order) - Number(b.order));
  const groups = new Map(items.map((item, index) => [item.id, {
    itemId: item.id,
    name: String(item.name || '').trim(),
    order: index,
    archived: Boolean(item.archived),
    minutes: 0,
    quantity: 0,
    quantityMinutes: 0,
    speedQuantity: 0,
    completed: false,
    records: [],
  }]));
  const byName = new Map(items.map(item => [String(item.name || '').trim().toLocaleLowerCase(), item.id]));
  let excluded = 0;
  const excludedRecords = [];
  forecastSortedTaskEntries(entries).forEach(entry => {
    const task = entry.task || {};
    let contributed = false;
    let matched = false;
    taskNamedItemAllocations(task).forEach(allocation => {
      const fallbackId = byName.get(allocation.itemName.toLocaleLowerCase());
      const group = groups.get(allocation.itemId) || groups.get(fallbackId);
      if (!group) {
        excludedRecords.push(forecastTaskRecord(entry, {
          itemName: allocation.itemName || '未知章节',
          allocatedMinutes: Math.max(0, Number(allocation.minutes) || 0),
          allocatedQuantity: allocation.quantity != null && Number.isFinite(Number(allocation.quantity)) ? Math.max(0, Number(allocation.quantity)) : null,
          completed: Boolean(allocation.completed),
          reasons: ['没有匹配活动章节'],
        }));
        return;
      }
      matched = true;
      const minutes = Number(allocation.minutes);
      const quantity = Number(allocation.quantity);
      const validMinutes = Number.isFinite(minutes) && minutes > 0;
      const validQuantity = Number.isFinite(quantity) && quantity > 0 &&
        task.quantityUnit === goal.quantityUnit;
      const reasons = [];
      if (group.archived) reasons.push('章节已归档，不参与当前目标预测');
      if (!validMinutes) reasons.push('章节分配缺少有效分钟');
      if (requireQuantity && !(Number.isFinite(quantity) && quantity > 0)) reasons.push('章节分配缺少有效题数');
      if (requireQuantity && Number.isFinite(quantity) && quantity > 0 && task.quantityUnit !== goal.quantityUnit) {
        reasons.push(`数量单位不同（记录为${task.quantityUnit || '未标单位'}，目标为${goal.quantityUnit || '未标单位'}）`);
      }
      if (allocation.completed) group.completed = true;
      const counted = !group.archived && validMinutes && (!requireQuantity || validQuantity);
      const record = forecastTaskRecord(entry, {
        itemId: group.itemId,
        itemName: group.name,
        allocatedMinutes: validMinutes ? minutes : 0,
        allocatedQuantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : null,
        completed: Boolean(allocation.completed),
        validMinutes,
        validQuantity,
        counted,
        reasons,
      });
      group.records.push(record);
      if (!group.archived) {
        if (validMinutes) group.minutes += minutes;
        if (validQuantity) group.quantity += quantity;
        if (validMinutes && validQuantity) {
          group.quantityMinutes += minutes;
          group.speedQuantity += quantity;
        }
      }
      if (counted) contributed = true;
      if (reasons.length) excludedRecords.push(record);
    });
    if (!matched && !taskNamedItemAllocations(task).length) {
      excludedRecords.push(forecastTaskRecord(entry, { reasons: ['没有匹配活动章节'] }));
    }
    if (!contributed) excluded++;
  });
  return {
    groups: [...groups.values()].filter(group => !group.archived || group.records.length).sort((a, b) => a.order - b.order),
    excluded,
    excludedRecords,
  };
}

function forecastChapterResult(goal, entries) {
  const { groups, excluded, excludedRecords } = forecastNamedItemGroups(goal, entries, false);
  const activeGroups = groups.filter(group => !group.archived);
  const chapterCount = activeGroups.length;
  const completedGroups = activeGroups.filter(group => group.completed);
  const validCompletedGroups = completedGroups.filter(group => group.minutes > 0);
  const completed = completedGroups.length;
  const remaining = chapterCount - completed;
  const complete = chapterCount > 0 && remaining === 0;
  const baseItems = groups.map(group => ({ ...group, estimatedRemainingMinutes: 0, estimatedRemainingQuantity: null }));
  if (!validCompletedGroups.length) {
    return {
      goal, complete, ready: false,
      reason: complete ? '目标已完成，但缺少有效章节时长，无法保留效率估算。' : '至少需要完成并勾选一个具有有效时长的章节后才能估算。',
      warning: '', requiredMinutes: complete ? 0 : null, progress: chapterCount ? completed / chapterCount * 100 : 0,
      completed, remaining, speed: 0, excluded, excludedRecords, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: '数据不足',
    };
  }
  const averageMinutes = validCompletedGroups.reduce((sum, group) => sum + group.minutes, 0) / validCompletedGroups.length;
  const items = groups.map(group => ({
    ...group,
    estimatedRemainingMinutes: group.archived || group.completed ? 0 : Math.max(0, averageMinutes - group.minutes),
    estimatedRemainingQuantity: null,
  }));
  const requiredMinutes = complete ? 0 : items.filter(item => !item.archived).reduce((sum, item) => sum + item.estimatedRemainingMinutes, 0);
  return {
    goal, complete, ready: true, reason: '', warning: '', requiredMinutes,
    progress: chapterCount ? completed / chapterCount * 100 : 0, completed, remaining,
    speed: averageMinutes > 0 ? 1 / averageMinutes : 0, excluded, excludedRecords, items,
    averageMinutes, completedEffortMinutes: averageMinutes * chapterCount,
    summary: `已完成 ${completed} / ${chapterCount} 个章节`,
    efficiency: `平均 ${fmtMin(averageMinutes, true)}/章节`,
  };
}

function forecastChapterQuantityResult(goal, entries) {
  const { groups, excluded, excludedRecords } = forecastNamedItemGroups(goal, entries, true);
  const activeGroups = groups.filter(group => !group.archived);
  const chapterCount = activeGroups.length;
  const completedGroups = activeGroups.filter(group => group.completed);
  const validCompletedGroups = completedGroups.filter(group => group.quantity > 0 && group.quantityMinutes > 0);
  const completed = completedGroups.length;
  const remaining = chapterCount - completed;
  const complete = chapterCount > 0 && remaining === 0;
  const baseItems = groups.map(group => ({ ...group, estimatedRemainingMinutes: 0, estimatedRemainingQuantity: 0 }));
  const totalQuestions = activeGroups.reduce((sum, group) => sum + group.speedQuantity, 0);
  const questionMinutes = activeGroups.reduce((sum, group) => sum + group.quantityMinutes, 0);
  const questionSpeed = questionMinutes > 0 ? totalQuestions / questionMinutes : 0;
  if (!validCompletedGroups.length || !questionSpeed) {
    return {
      goal, complete, ready: false,
      reason: complete ? `目标已完成，但缺少有效的${goal.quantityUnit || '数量'}和时长，无法保留效率估算。` : `至少需要完成一个章节，并为它记录有效的${goal.quantityUnit || '数量'}和时长。`,
      warning: '', requiredMinutes: complete ? 0 : null, progress: chapterCount ? completed / chapterCount * 100 : 0,
      completed, remaining, speed: questionSpeed, excluded, excludedRecords, items: baseItems,
      summary: `已完成 ${completed} / ${chapterCount} 个章节`,
      efficiency: questionSpeed > 0 ? formatQuestionEfficiency(questionSpeed, goal.quantityUnit || '题', 2) : '数据不足',
    };
  }
  const averageQuestions = validCompletedGroups.reduce((sum, group) => sum + group.quantity, 0) / validCompletedGroups.length;
  const averageMinutes = validCompletedGroups.reduce((sum, group) => sum + group.minutes, 0) / validCompletedGroups.length;
  const items = groups.map(group => {
    const estimatedRemainingQuantity = group.archived || group.completed ? 0 : Math.max(0, averageQuestions - group.quantity);
    return {
      ...group,
      estimatedRemainingQuantity,
      estimatedRemainingMinutes: estimatedRemainingQuantity / questionSpeed,
      quantityExceededAverage: !group.archived && !group.completed && group.quantity >= averageQuestions,
    };
  });
  const exceededCount = items.filter(item => !item.archived && item.quantityExceededAverage).length;
  const requiredMinutes = complete ? 0 : items.filter(item => !item.archived).reduce((sum, item) => sum + item.estimatedRemainingMinutes, 0);
  return {
    goal, complete, ready: true, reason: '',
    warning: exceededCount
      ? `${exceededCount} 个未完成章节的累计${goal.quantityUnit || '数量'}已达到或超过已完成章节平均值，这些章节暂按剩余 0 分钟估算，请确认是否应勾选完成。`
      : '',
    requiredMinutes,
    progress: chapterCount ? completed / chapterCount * 100 : 0, completed, remaining,
    speed: questionSpeed, excluded, excludedRecords, items, averageQuestions, averageMinutes,
    completedEffortMinutes: averageMinutes * chapterCount,
    summary: `已完成 ${completed} / ${chapterCount} 个章节 · 平均 ${averageQuestions.toFixed(1)} ${goal.quantityUnit}/章节`,
    efficiency: `${formatQuestionEfficiency(questionSpeed, goal.quantityUnit || '题', 2)} · 平均 ${fmtMin(averageMinutes, true)}/章节`,
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
    records: [],
    excludedRecords: [],
    items: [],
    warning: '',
    summary: '预测配置不完整',
    efficiency: '暂停计算',
  });
  if (!context.mode) return invalid('模板的序数和数量开关均已关闭，请先开启至少一个单位并重新配置目标。');
  if (context.mode === 'quantity' &&
    (!Number.isInteger(Number(context.totalQuantity)) || Number(context.totalQuantity) <= 0)) {
    return invalid(context.chapterQuantityOnly
      ? '请为每个活动章节填写总题数，合计必须大于 0。'
      : '当前主目标已切换为数量，请编辑目标并填写总任务量。');
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

function forecastRecordedDates() {
  return Object.keys(state.data)
    .filter(dateStr => /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && hasAnyRecordedContent(dateStr))
    .sort();
}

function forecastLatestRecordedDate() {
  const dates = forecastRecordedDates();
  return dates[dates.length - 1] || '';
}

function forecastDefaultStartDate() {
  const today = getTodayStr();
  const latestRecordedDate = forecastLatestRecordedDate();
  return latestRecordedDate && latestRecordedDate > today ? latestRecordedDate : today;
}

function forecastStartDateAllowed(dateStr) {
  const normalized = normalizeEditableDate(dateStr);
  if (!normalized) return false;
  return !forecastRecordedDates().some(recordDate => recordDate > normalized);
}

function forecastNormalizeStartDate(dateStr) {
  const normalized = normalizeEditableDate(dateStr);
  if (normalized && forecastStartDateAllowed(normalized)) return normalized;
  return forecastDefaultStartDate();
}

function forecastCompletionDateFromStart(totalMinutes, dailyMinutes, startDate, startUsed) {
  const start = forecastNormalizeStartDate(startDate);
  const remainingTotal = Math.max(0, Number(totalMinutes) || 0);
  const capacityPerDay = Math.max(0, Number(dailyMinutes) || 0);
  if (remainingTotal <= 0 || capacityPerDay <= 0) return start;

  const availableStartDay = Math.max(0, capacityPerDay - Math.max(0, Number(startUsed) || 0));
  if (remainingTotal <= availableStartDay) return start;

  const futureDaysAfterStart = Math.ceil((remainingTotal - availableStartDay) / capacityPerDay);
  return forecastDateAfter(start, futureDaysAfterStart);
}

function forecastRemainingWorkDays(totalMinutes, dailyMinutes, startUsed = 0) {
  const remainingTotal = Math.max(0, Number(totalMinutes) || 0);
  const capacityPerDay = Math.max(0, Number(dailyMinutes) || 0);
  if (remainingTotal <= 0) return 0;
  if (capacityPerDay <= 0) return null;
  const availableStartDay = Math.max(0, capacityPerDay - Math.max(0, Number(startUsed) || 0));
  if (remainingTotal <= availableStartDay) return 1;
  return (availableStartDay > 0 ? 1 : 0) + Math.ceil((remainingTotal - availableStartDay) / capacityPerDay);
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
      totalActualMinutes: 0,
    };
  }
  const start = settings.capacityStartDate;
  const end = settings.capacityTrackLatest ? getTodayStr() : settings.capacityEndDate;
  if (!start || !end || start > end) {
    return { source: 'range', valid: false, startDate: start, endDate: end, averageMinutes: 0, eligibleDays: 0, totalActualMinutes: 0 };
  }
  let cursor = start;
  let eligibleDays = 0;
  let totalActualMinutes = 0;
  while (cursor <= end) {
    eligibleDays++;
    totalActualMinutes += forecastActualMinutesForDay(cursor);
    cursor = forecastDateAfter(cursor, 1);
  }
  return {
    source: 'range',
    valid: eligibleDays > 0,
    startDate: start,
    endDate: end,
    averageMinutes: eligibleDays > 0 ? totalActualMinutes / eligibleDays : 0,
    eligibleDays,
    totalActualMinutes,
  };
}

function forecastCapacityPresetBounds(mode) {
  const today = getTodayStr();
  const records = getAllDates();
  if (mode === '7d') return { start: addDays(today, -6), end: today, trackLatest: true };
  if (mode === '30d') return { start: addDays(today, -29), end: today, trackLatest: true };
  if (mode === '70d') return { start: addDays(today, -69), end: today, trackLatest: true };
  if (mode === '90d') return { start: addDays(today, -89), end: today, trackLatest: true };
  if (mode === 'year') return { start: `${today.slice(0, 4)}-01-01`, end: today, trackLatest: true };
  if (mode === 'all') return { start: records[0] || today, end: today, trackLatest: true };
  return null;
}

function forecastCapacityRangeModeLabel(settings) {
  return ({
    '7d': '近7天',
    '30d': '近30天',
    '70d': '近70天',
    '90d': '近90天',
    year: '本年度',
    all: '全部历史',
    custom: '自定义',
    hierarchy: settings.capacityHierarchyLabel || '层级选择',
  })[settings.capacityRangeMode] || '自定义';
}

function forecastCapacityRangeLabel(settings, capacity) {
  const start = capacity?.source === 'range' ? capacity.startDate : settings.capacityStartDate;
  const end = capacity?.source === 'range'
    ? capacity.endDate
    : settings.capacityTrackLatest ? getTodayStr() : settings.capacityEndDate;
  return `${forecastCapacityRangeModeLabel(settings)}${start && end ? ` · ${formatShort(start)} — ${formatShort(end)}` : ' · 暂无范围'}`;
}

async function forecastApplyCapacityPreset(mode) {
  const settings = getForecastSettings();
  settings.capacityMode = 'range';
  settings.capacityRangeMode = mode;
  settings.capacityPickerOpen = false;
  const bounds = forecastCapacityPresetBounds(mode);
  if (bounds) {
    settings.capacityStartDate = bounds.start;
    settings.capacityEndDate = bounds.end;
    settings.capacityTrackLatest = bounds.trackLatest;
  } else if (mode === 'custom') {
    settings.capacityTrackLatest = false;
  }
  await saveAllStorage();
  renderForecast('capacity-results');
}

function forecastCapacityRenderOnly() {
  renderForecast('capacity');
}

function forecastToggleCapacityPicker() {
  const settings = getForecastSettings();
  settings.capacityMode = 'range';
  settings.capacityPickerOpen = !settings.capacityPickerOpen;
  if (settings.capacityPickerOpen) {
    settings.capacityRangeMode = 'hierarchy';
    if (!['year', 'month', 'week', 'day'].includes(settings.capacityHierarchyLevel)) settings.capacityHierarchyLevel = 'year';
  }
  forecastCapacityRenderOnly();
}

function forecastCapacityDrill(level, year, month = 0, weekStart = '') {
  if (!['year', 'month', 'week', 'day'].includes(level)) return;
  const settings = getForecastSettings();
  settings.capacityMode = 'range';
  settings.capacityRangeMode = 'hierarchy';
  settings.capacityPickerOpen = true;
  settings.capacityHierarchyLevel = level;
  settings.capacityHierarchyYear = Number(year);
  settings.capacityHierarchyMonth = Math.min(11, Math.max(0, Number(month) || 0));
  settings.capacityHierarchyWeekStart = weekStart || '';
  forecastCapacityRenderOnly();
}

async function forecastCapacityChoose(start, end, encodedLabel) {
  if (!start || !end || start > end) return alert('请选择有效的统计范围。');
  const settings = getForecastSettings();
  settings.capacityMode = 'range';
  settings.capacityRangeMode = 'hierarchy';
  settings.capacityStartDate = start;
  settings.capacityEndDate = end;
  settings.capacityTrackLatest = false;
  settings.capacityPickerOpen = false;
  settings.capacityHierarchyLabel = decodeURIComponent(encodedLabel || '') || '层级选择';
  await saveAllStorage();
  renderForecast('capacity-results');
}

function forecastCapacityChooseButton(start, end, label, text = '选择') {
  return `<button type="button" class="btn btn-primary btn-sm" onclick="forecastCapacityChoose('${start}','${end}','${encodeURIComponent(label)}')">${text}</button>`;
}

function forecastCapacityPickerHtml(settings) {
  if (!settings.capacityPickerOpen) return '';
  const records = getAllDates();
  const currentYear = new Date().getFullYear();
  const firstYear = records.length ? Number(records[0].slice(0, 4)) : currentYear;
  const years = Array.from({ length: Math.max(1, currentYear - firstYear + 1) }, (_, index) => currentYear - index);
  const year = Number(settings.capacityHierarchyYear) || currentYear;
  const month = Math.min(11, Math.max(0, Number(settings.capacityHierarchyMonth) || 0));
  const level = ['year', 'month', 'week', 'day'].includes(settings.capacityHierarchyLevel)
    ? settings.capacityHierarchyLevel
    : 'year';
  const breadcrumbs = [`<button type="button" onclick="forecastCapacityDrill('year',${year})">年份</button>`];
  if (level !== 'year') breadcrumbs.push(`<button type="button" onclick="forecastCapacityDrill('month',${year})">${year}年</button>`);
  if (['week', 'day'].includes(level)) breadcrumbs.push(`<button type="button" onclick="forecastCapacityDrill('week',${year},${month})">${month + 1}月</button>`);
  if (level === 'day') breadcrumbs.push(`<span>${formatShort(settings.capacityHierarchyWeekStart)} 起</span>`);

  let cards = '';
  if (level === 'year') {
    cards = years.map(value => {
      const start = `${value}-01-01`;
      const end = `${value}-12-31`;
      const label = `${value}年`;
      return `<article class="analysis-range-card"><b>${label}</b><small>${value === currentYear ? '当前年份 · 保留未来日期' : '自然年度'}</small><div>${forecastCapacityChooseButton(start, end, label, '选择全年')}<button type="button" class="btn btn-ghost btn-sm" onclick="forecastCapacityDrill('month',${value})">查看月份 →</button></div></article>`;
    }).join('');
  } else if (level === 'month') {
    cards = Array.from({ length: 12 }, (_, value) => {
      const start = `${year}-${String(value + 1).padStart(2, '0')}-01`;
      const end = dateToStr(new Date(year, value + 1, 0));
      const label = `${year}年${value + 1}月`;
      return `<article class="analysis-range-card"><b>${value + 1}月</b><small>${formatShort(start)} — ${formatShort(end)}</small><div>${forecastCapacityChooseButton(start, end, label, '选择整月')}<button type="button" class="btn btn-ghost btn-sm" onclick="forecastCapacityDrill('week',${year},${value})">查看周次 →</button></div></article>`;
    }).join('');
  } else if (level === 'week') {
    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const monthEnd = dateToStr(new Date(year, month + 1, 0));
    const firstMonday = getMondayOfDate(strToDate(monthStart));
    const weeks = [];
    for (let monday = firstMonday; monday <= monthEnd; monday = addDays(monday, 7)) weeks.push(monday);
    cards = weeks.map((monday, index) => {
      const sunday = addDays(monday, 6);
      const label = `${year}年${month + 1}月第${index + 1}周`;
      return `<article class="analysis-range-card"><b>第${index + 1}周</b><small>${formatShort(monday)} — ${formatShort(sunday)}${monday < monthStart || sunday > monthEnd ? ' · 跨月' : ''}</small><div>${forecastCapacityChooseButton(monday, sunday, label, '选择整周')}<button type="button" class="btn btn-ghost btn-sm" onclick="forecastCapacityDrill('day',${year},${month},'${monday}')">查看日期 →</button></div></article>`;
    }).join('');
  } else {
    const monday = settings.capacityHierarchyWeekStart || getMondayOfDate(new Date());
    cards = Array.from({ length: 7 }, (_, index) => {
      const dateStr = addDays(monday, index);
      const date = strToDate(dateStr);
      const label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
      return `<article class="analysis-range-card analysis-range-day"><b>${formatDisplay(dateStr)}</b><small>${dateStr}</small>${forecastCapacityChooseButton(dateStr, dateStr, label, '选择当天')}</article>`;
    }).join('');
  }

  return `<div class="analysis-range-picker"><div class="analysis-range-picker-head"><div class="analysis-range-breadcrumbs">${breadcrumbs.join('<i>›</i>')}</div><button type="button" class="btn btn-ghost btn-sm" onclick="forecastToggleCapacityPicker()">收起</button></div><div class="analysis-range-grid">${cards}</div></div>`;
}

function forecastCapacityRangePlannerHtml(settings, capacity) {
  const options = [['7d', '7天'], ['30d', '30天'], ['70d', '70天'], ['90d', '90天'], ['year', '本年度'], ['all', '全部历史'], ['custom', '自定义']];
  return `<section class="analysis-range-planner forecast-capacity-planner">
    <div class="analysis-range-main"><div class="analysis-range-presets">${options.map(([value, label]) => `<button type="button" class="${settings.capacityRangeMode === value ? 'active' : ''}" onclick="forecastApplyCapacityPreset('${value}')">${label}</button>`).join('')}<button type="button" class="${settings.capacityRangeMode === 'hierarchy' || settings.capacityPickerOpen ? 'active' : ''}" onclick="forecastToggleCapacityPicker()">层级选择</button></div><div class="analysis-range-summary"><span>当前能力范围</span><b>${escHtmlApp(forecastCapacityRangeLabel(settings, capacity))}</b><small>${capacity.source === 'range' ? `${capacity.eligibleDays} 天 · 日均 ${fmtMin(Math.round(capacity.averageMinutes), true)}` : '切换到范围模式后计算'}</small></div></div>
    ${forecastCapacityPickerHtml(settings)}
  </section>`;
}

function calculateForecastOverall(results) {
  const settings = getForecastSettings();
  const capacity = forecastCapacityStats(settings);
  const unfinished = results.filter(result => !result.complete);
  const insufficient = unfinished.filter(result => !result.ready);
  const forecastStartDate = settings.forecastStartDate;
  const startUsed = forecastActualMinutesForDay(forecastStartDate);
  if (!results.length) {
    return { label: '暂无参与预测目标', totalMinutes: null, remainingMinutes: null, todayUsed: startUsed, startUsed, insufficient: 0, capacity, forecastStartDate };
  }
  if (!unfinished.length) {
    return { label: '全部目标已完成', totalMinutes: 0, remainingMinutes: 0, todayUsed: startUsed, startUsed, insufficient: 0, capacity, forecastStartDate };
  }
  if (insufficient.length) {
    const needsConfiguration = insufficient.filter(result => result.configurationInvalid).length;
    return {
      label: needsConfiguration
        ? `${needsConfiguration} 个目标需要重新配置`
        : `${insufficient.length} 个目标数据不足`,
      totalMinutes: null,
      remainingMinutes: null,
      todayUsed: startUsed,
      startUsed,
      insufficient: insufficient.length,
      capacity,
      forecastStartDate,
    };
  }
  const remainingMinutes = unfinished.reduce((sum, result) => sum + (Number(result.requiredMinutes) || 0), 0);
  if (!capacity.valid || capacity.averageMinutes <= 0) {
    return {
      label: capacity.source === 'manual' ? '请设置有效的每日学习时长' : '历史日均实际学习时间不足',
      totalMinutes: null,
      remainingMinutes,
      todayUsed: startUsed,
      startUsed,
      insufficient: 0,
      capacity,
      forecastStartDate,
    };
  }
  const totalMinutes = remainingMinutes;
  const completionDate = forecastCompletionDateFromStart(totalMinutes, capacity.averageMinutes, forecastStartDate, startUsed);
  return {
    label: completionDate,
    totalMinutes,
    remainingMinutes,
    todayUsed: startUsed,
    startUsed,
    insufficient: 0,
    capacity,
    forecastStartDate,
  };
}

function forecastStartNew() {
  state.forecastEditingId = null;
  renderForecast();
}

function forecastEdit(id) {
  state.forecastEditingId = id;
  renderForecast();
  requestAnimationFrame(() => {
    const editor = document.querySelector('.forecast-editor-panel');
    editor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('forecast_goal_name')?.focus({ preventScroll: true });
  });
}

function renderSleepIntervalDistributionChart(chartId, distribution, color, label) {
  if (!document.getElementById(chartId) || !distribution?.bins?.length) return;
  mkChart(chartId, {
    type: 'line',
    data: {
      labels: distribution.bins.map(bin => [bin.label, fmtMin(distribution.width, true)]),
      datasets: [{
        label,
        data: distribution.bins.map(bin => bin.count),
        borderColor: color,
        backgroundColor: `${color}1f`,
        pointBackgroundColor: color,
        pointBorderColor: '#07111f',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2.2,
        tension: .22,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: contexts => distribution.bins[contexts[0]?.dataIndex]?.label || '',
          label: context => `${Number(context.parsed.y) || 0} 次`,
        } },
      },
      scales: {
        x: { ticks: { color: '#a8b5d0', maxRotation: 0, autoSkip: true, maxTicksLimit: 16 }, grid: { display: false }, title: { display: true, text: `时间区间（${fmtMin(distribution.width, true)}/格）`, color: '#6b7a9e' } },
        y: { beginAtZero: true, ticks: { color: '#6b7a9e', precision: 0 }, grid: { color: 'rgba(107,122,158,.12)', drawBorder: false }, title: { display: true, text: '出现次数', color: '#6b7a9e' } },
      },
    },
  });
}

function forecastNamedItemRecordsHtml(records = [], quantityUnit = '') {
  if (!records.length) {
    return '<div class="form-hint">该章节还没有关联的任务记录。</div>';
  }
  return `<div style="max-height:240px;overflow:auto">
    <table style="width:100%;font-size:11px">
      <thead><tr><th>日期</th><th>任务</th><th>活动类别</th><th>本章时长</th><th>本章数量</th><th>任务总数量</th><th>状态</th></tr></thead>
      <tbody>${records.map(record => `<tr>
        <td class="fw-mono">${escHtmlApp(record.date)}</td>
        <td>${templateTaskLinkHtml(record.date, { id: record.taskId, name: record.taskName })}</td>
        <td class="c-muted">${escHtmlApp(record.activityType || '-')}</td>
        <td class="fw-mono">${fmtMin(record.minutes, true)}</td>
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
    <div class="forecast-named-item-fields">
      <input class="forecast-named-item-name" value="${escHtmlApp(item.name || '')}" maxlength="160"
        ${archived ? 'disabled' : ''}
        oninput="forecastRefreshNamedItemEditorState()"
        onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
        aria-label="命名章节名称">
      <label class="forecast-named-item-question-count">总题数
        <input type="number" class="forecast-named-item-question-count-input" min="0" max="9007199254740991" step="1"
          value="${escHtmlApp(item.questionCount ?? '')}" placeholder="未设置" ${archived ? 'disabled' : ''}
          oninput="forecastRefreshNamedItemEditorState()" aria-label="章节总题数">
      </label>
    </div>
    <div class="forecast-named-item-actions" style="display:flex;gap:5px;align-items:center">
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
      questionCount: item?.questionCount ?? null,
    }))
    .filter(item => item.name)
    : [];
  const active = normalized.filter(item => !item.archived).sort((a, b) => a.order - b.order);
  const archived = normalized.filter(item => item.archived).sort((a, b) => a.order - b.order);
  const template = getTaskTemplateById(templateId);
  const libraryProgress = templateId ? namedItemLibraryProgress(templateId) : { progress: new Map(), completedActive: 0, totalQuantity: 0 };
  const lastActiveName = [...active].reverse().find(item => item.name)?.name || '';
  const predictedName = inferNextNamedItemName(lastActiveName, normalized.map(item => item.name));
  const showQuestionCounts = normalized.some(item => item.questionCount != null) || templateUsesChapterQuestionCounts(template);
  return `<div class="forecast-named-items-editor${showQuestionCounts ? ' show-question-counts' : ''}">
    <div class="forecast-named-items-heading">
      <label>命名章节清单 *</label>
      <button type="button" class="btn btn-ghost btn-sm forecast-question-count-toggle" aria-pressed="${showQuestionCounts}"
        onclick="forecastToggleNamedItemQuestionCounts(this)">章节题数</button>
    </div>
    ${template ? `<label class="forecast-chapter-quantity-only"><input type="checkbox" id="forecast_chapter_quantity_only"
      ${template.chapterQuantityOnly ? 'checked' : ''} ${template.quantityEnabled ? '' : 'disabled'}
      onchange="forecastChapterQuantityOnlyChanged(this)">章节仅作题数标定</label>` : ''}
    <div class="form-hint forecast-named-item-question-summary">${forecastNamedItemQuestionSummary(active)}</div>
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

function forecastNamedItemQuestionSummary(items) {
  const configured = items.filter(item => Number.isSafeInteger(item.questionCount) && item.questionCount >= 0);
  const total = configured.reduce((sum, item) => sum + item.questionCount, 0);
  return `已设定题数 ${total} 题 · ${configured.length}/${items.length} 章`;
}

function forecastNamedItemQuestionTotal(items) {
  const active = items.filter(item => !item.archived);
  if (!active.length || active.some(item => !Number.isSafeInteger(item.questionCount) || item.questionCount < 0)) return null;
  const total = active.reduce((sum, item) => sum + item.questionCount, 0);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function forecastChapterQuantityOnlyChanged(input) {
  if (input.checked) {
    const editor = input.closest('.forecast-named-items-editor');
    editor.classList.add('show-question-counts');
    editor.querySelector('.forecast-question-count-toggle').setAttribute('aria-pressed', 'true');
  }
  forecastUpdateGoalFields();
}

function forecastToggleNamedItemQuestionCounts(button) {
  const editor = button.closest('.forecast-named-items-editor');
  const showing = editor.classList.toggle('show-question-counts');
  button.setAttribute('aria-pressed', String(showing));
}

function forecastValidateNamedItemQuestionCounts() {
  const invalid = forecastNamedItemRows()
    .map(row => row.querySelector('.forecast-named-item-question-count-input'))
    .find(input => input && (!input.validity.valid || (input.value !== '' &&
      (!Number.isSafeInteger(Number(input.value)) || Number(input.value) < 0))));
  if (!invalid) return true;
  const editor = invalid.closest('.forecast-named-items-editor');
  editor.classList.add('show-question-counts');
  editor.querySelector('.forecast-question-count-toggle').setAttribute('aria-pressed', 'true');
  alert('章节总题数必须是大于或等于 0 的整数，也可以留空。');
  invalid.focus();
  return false;
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
  const questionSummary = activeHost?.closest('.forecast-named-items-editor')?.querySelector('.forecast-named-item-question-summary');
  if (questionSummary) {
    questionSummary.textContent = forecastNamedItemQuestionSummary(forecastCollectNamedItems().filter(item => !item.archived));
  }
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
  row.querySelectorAll('.forecast-named-item-name, .forecast-named-item-question-count-input')
    .forEach(input => input.disabled = true);
  const actions = row.querySelector('.forecast-named-item-actions');
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
  row.querySelectorAll('.forecast-named-item-name, .forecast-named-item-question-count-input')
    .forEach(input => input.disabled = false);
  const actions = row.querySelector('.forecast-named-item-actions');
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
      questionCount: row.querySelector('.forecast-named-item-question-count-input')?.value
        ? Number(row.querySelector('.forecast-named-item-question-count-input').value) : null,
    }))
    .filter(item => item.name || !item.draft || item.questionCount != null)
    .map((item, index) => ({
      id: item.id,
      name: item.name,
      order: index,
      archived: item.archived,
      questionCount: item.questionCount,
    }));
}

function forecastUpdateGoalFields(updateName = false) {
  const templateId = document.getElementById('forecast_goal_template')?.value || '';
  const template = getTaskTemplates().find(item => item.id === templateId);
  const effectiveTemplate = template && !updateName ? {
    ...template,
    chapterQuantityOnly: Boolean(document.getElementById('forecast_chapter_quantity_only')?.checked),
  } : template;
  const quantityOnly = templateUsesChapterQuestionCounts(effectiveTemplate);
  const mode = forecastModeFromTemplate(effectiveTemplate);
  const modeLabel = document.getElementById('forecast_goal_primary_label');
  if (modeLabel) {
    const namedItemEnabled = template?.namedItemEnabled ?? template?.ordinalEnabled;
    modeLabel.value = quantityOnly ? '题数主目标（活动章节总题数合计）' : namedItemEnabled
      ? `命名章节主目标${template.quantityEnabled ? '（题数辅助估算）' : ''}`
      : template?.quantityEnabled
        ? `数量主目标：${template.quantityUnit}`
        : '请先在模板库开启单位';
  }
  const quantityGroup = document.getElementById('forecast_quantity_group');
  const totalField = document.getElementById('forecast_total_field');
  const chapterGroup = document.getElementById('forecast_chapter_group');
  if (quantityGroup) quantityGroup.style.display = mode === 'quantity' || mode === 'chapterQuantity' ? 'grid' : 'none';
  if (totalField) totalField.style.display = mode === 'quantity' && !quantityOnly ? '' : 'none';
  if (chapterGroup) chapterGroup.style.display = quantityOnly || mode === 'chapter' || mode === 'chapterQuantity' ? 'grid' : 'none';
  if (chapterGroup && (quantityOnly || mode === 'chapter' || mode === 'chapterQuantity') && updateName) {
    chapterGroup.innerHTML = forecastNamedItemsEditorHtml(template?.namedItems || [], template?.id || '');
  }
  const unit = document.getElementById('forecast_goal_unit');
  if (unit) unit.value = template?.quantityUnit || '';
  if (updateName) {
    const name = document.getElementById('forecast_goal_name');
    if (name && !name.value.trim() && template) name.value = forecastTemplateLabel(template);
  }
}

async function forecastSaveStartDate() {
  const picked = normalizeEditableDate(document.getElementById('forecast_start_date')?.value || '');
  if (!picked) {
    alert('请选择有效的预计起始点日期。');
    return;
  }
  if (!forecastStartDateAllowed(picked)) {
    const latestRecordedDate = forecastLatestRecordedDate();
    alert(`预计起始点之后不能存在记录。当前最晚记录日是 ${latestRecordedDate || '无'}，所以起点不能早于这个日期。`);
    setEditableDateSegments('forecast_start_date', forecastNormalizeStartDate(picked));
    return;
  }
  const settings = getForecastSettings();
  settings.forecastStartDate = picked;
  await saveAllStorage();
  renderForecast('capacity-results');
}

async function forecastToggleStartTracking() {
  const settings = getForecastSettings();
  settings.forecastTrackToday = !settings.forecastTrackToday;
  settings.forecastStartDate = settings.forecastTrackToday
    ? forecastNormalizeStartDate(getTodayStr())
    : forecastNormalizeStartDate(
      document.getElementById('forecast_start_date')?.value || settings.forecastStartDate
    );
  await saveAllStorage();
  renderForecast('capacity-results');
}

function forecastApplyStartTrackingUi() {
  const settings = getForecastSettings();
  const tracking = settings.forecastTrackToday;
  const wrap = document.getElementById('forecast_start_date_wrap');
  if (wrap) {
    wrap.querySelectorAll('input:not([type="hidden"]), button').forEach(element => {
      element.disabled = tracking;
    });
    wrap.style.opacity = tracking ? '.6' : '';
    wrap.title = tracking ? '正在跟踪今日，预计起点会每天自动更新' : '';
  }
  const saveButton = document.getElementById('forecast_start_save');
  if (saveButton) saveButton.disabled = tracking;
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
  if (capacityMode === 'range') settings.capacityRangeMode = 'custom';
  settings.capacityPickerOpen = false;
  settings.capacityStartDate = startDate;
  settings.capacityEndDate = endDate;
  settings.capacityTrackLatest = trackLatest;
  await saveAllStorage();
  renderForecast('capacity-results');
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
  const excludedFromForecast = Boolean(document.getElementById('forecast_goal_excluded')?.checked);
  const chapterQuantityOnly = Boolean(document.getElementById('forecast_chapter_quantity_only')?.checked);
  const effectiveTemplate = template ? { ...template, chapterQuantityOnly } : null;
  const quantityOnly = templateUsesChapterQuestionCounts(effectiveTemplate);
  const mode = forecastModeFromTemplate(effectiveTemplate);
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

  const namedMode = quantityOnly || mode === 'chapter' || mode === 'chapterQuantity';
  if (namedMode && !forecastValidateNamedItemQuestionCounts()) return;
  const namedItems = namedMode ? forecastCollectNamedItems() : [];
  const totalQuantity = quantityOnly ? forecastNamedItemQuestionTotal(namedItems)
    : Number(document.getElementById('forecast_goal_total')?.value);
  const activeNamedItems = namedItems.filter(item => !item.archived);
  if (mode === 'quantity' && (!Number.isInteger(totalQuantity) || totalQuantity <= 0)) {
    alert(quantityOnly ? '请为每个活动章节填写总题数，合计必须大于 0。' : '总任务量必须是大于 0 的整数。');
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
    excludedFromForecast,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (namedMode) {
    template.namedItems = namedItems;
    template.chapterQuantityOnly = chapterQuantityOnly;
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

function forecastGoalIsExcluded(resultOrGoal) {
  const goal = resultOrGoal?.goal || resultOrGoal;
  return Boolean(goal?.excludedFromForecast);
}

function forecastActiveResults(results) {
  return results.filter(result => !forecastGoalIsExcluded(result));
}

function forecastSetCategoryFilter(level, value) {
  const filter = state.forecastCategoryFilter ||= { level1: '', level2: '', level3: '' };
  filter[`level${level}`] = value || '';
  if (level <= 1) {
    filter.level2 = '';
    filter.level3 = '';
  } else if (level === 2) {
    filter.level3 = '';
  }
  renderForecast('filter');
}

function forecastClearCategoryFilter() {
  state.forecastCategoryFilter = { level1: '', level2: '', level3: '' };
  renderForecast('filter');
}

function forecastCategoryFilterContext(results) {
  const filter = state.forecastCategoryFilter ||= { level1: '', level2: '', level3: '' };
  const templates = new Map(getTaskTemplates().map(template => [template.id, template]));
  const entries = results.map(result => ({
    result,
    parts: parseActPath(templates.get(result.goal.templateId)?.activityType || ''),
  }));
  const uniqueValues = values => [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const level1Options = uniqueValues(entries.map(entry => entry.parts[0]));
  if (filter.level1 && !level1Options.includes(filter.level1)) {
    filter.level1 = '';
    filter.level2 = '';
    filter.level3 = '';
  }
  const level2Options = filter.level1
    ? uniqueValues(entries.filter(entry => entry.parts[0] === filter.level1).map(entry => entry.parts[1]))
    : [];
  if (filter.level2 && !level2Options.includes(filter.level2)) {
    filter.level2 = '';
    filter.level3 = '';
  }
  const level3Options = filter.level1 && filter.level2
    ? uniqueValues(entries
      .filter(entry => entry.parts[0] === filter.level1 && entry.parts[1] === filter.level2)
      .map(entry => entry.parts[2]))
    : [];
  if (filter.level3 && !level3Options.includes(filter.level3)) filter.level3 = '';
  const filteredResults = entries
    .filter(entry => !filter.level1 || entry.parts[0] === filter.level1)
    .filter(entry => !filter.level2 || entry.parts[1] === filter.level2)
    .filter(entry => !filter.level3 || entry.parts[2] === filter.level3)
    .map(entry => entry.result);
  return {
    filter,
    level1Options,
    level2Options,
    level3Options,
    filteredResults,
    total: results.length,
    hasFilter: Boolean(filter.level1 || filter.level2 || filter.level3),
  };
}

function forecastCategoryFilterHtml(context) {
  if (!context.total) return '';
  const { filter, level1Options, level2Options, level3Options } = context;
  return `<section class="template-filter-grid forecast-category-filter" data-render-panel="forecast-category-filter">
    <label><span>一级分类</span><select onchange="forecastSetCategoryFilter(1,this.value)">
      <option value="">全部目标</option>
      ${level1Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level1 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <label><span>二级分类</span><select onchange="forecastSetCategoryFilter(2,this.value)" ${filter.level1 ? '' : 'disabled'}>
      <option value="">全部二级</option>
      ${level2Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level2 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <label><span>三级分类</span><select onchange="forecastSetCategoryFilter(3,this.value)" ${filter.level1 && filter.level2 ? '' : 'disabled'}>
      <option value="">全部三级</option>
      ${level3Options.map(value => `<option value="${escHtmlApp(value)}" ${filter.level3 === value ? 'selected' : ''}>${escHtmlApp(value)}</option>`).join('')}
    </select></label>
    <span class="template-filter-count">显示 ${context.filteredResults.length}/${context.total}</span>
    ${context.hasFilter ? '<button class="btn btn-ghost btn-sm" onclick="forecastClearCategoryFilter()">清除筛选</button>' : ''}
  </section>`;
}

async function forecastToggleExcluded(id) {
  const goal = getForecastGoals().find(item => item.id === id);
  if (!goal) return;
  goal.excludedFromForecast = !Boolean(goal.excludedFromForecast);
  goal.updatedAt = new Date().toISOString();
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
  const primaryLabel = templateUsesChapterQuestionCounts(editingTemplate)
    ? '题数主目标（活动章节总题数合计）' : (editingTemplate?.namedItemEnabled ?? editingTemplate?.ordinalEnabled)
    ? `命名章节主目标${editingTemplate.quantityEnabled ? '（题数辅助估算）' : ''}`
    : editingTemplate?.quantityEnabled
      ? `数量主目标：${escHtmlApp(editingTemplate.quantityUnit)}`
      : '请先在模板库开启单位';
  const modeCopy = mode
    ? forecastPrimaryTargetLabel({ ...editing, mode, quantityUnit: editingTemplate?.quantityUnit || '' })
    : '选择模板后自动识别预测模式';

  return `<section class="forecast-editor-panel">
    <div class="forecast-panel-head">
      <div>
        <div class="forecast-eyebrow">Goal Builder</div>
        <h3>${editing ? '编辑预测目标' : '新建预测目标'}</h3>
        <p>${escHtmlApp(modeCopy)}</p>
      </div>
      ${editing ? '<span class="forecast-editor-badge">正在编辑</span>' : '<span class="forecast-editor-badge muted">新目标</span>'}
    </div>
    ${templates.length ? `<div class="forecast-editor-body">
      <div class="form-grid forecast-goal-grid">
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
          <input id="forecast_goal_primary_label" readonly value="${primaryLabel}">
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
      <div id="forecast_chapter_group" class="forecast-editor-chapters">
        ${forecastNamedItemsEditorHtml(editingTemplate?.namedItems || [], editingTemplate?.id || '')}
      </div>
      <label class="forecast-exclude-toggle">
        <input type="checkbox" id="forecast_goal_excluded" ${editing?.excludedFromForecast ? 'checked' : ''}>
        <span>
          <b>暂不参与总预测</b>
          <small>目标仍保留在列表中，只是不计入顶部预计完成日和剩余总时长。</small>
        </span>
      </label>
      <div class="forecast-editor-actions">
        <button class="btn btn-success" onclick="forecastSaveGoal()">💾 保存预测目标</button>
        <button class="btn btn-ghost" onclick="forecastStartNew()">新建空白目标</button>
      </div>
    </div>` : '<div class="forecast-empty-panel"><p>请先在模板库建立任务模板。</p></div>'}
  </section>`;
}

function forecastDisplayMetric(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function forecastDailyOutputMeta(result, capacity) {
  const dailyMinutes = Number(capacity?.averageMinutes) || 0;
  const capacityValid = Boolean(capacity?.valid) && dailyMinutes > 0;
  const base = {
    effortLabel: capacityValid ? '等待预测数据' : '设置每日能力后可计算',
    effortDetail: capacityValid ? `按每日 ${fmtMin(Math.round(dailyMinutes), true)} 全部投入` : '保存能力设置后自动计算',
    primary: '',
    secondary: '',
    state: 'unavailable',
  };
  if (!capacityValid) {
    return { ...base, primary: '先设置每日能力', secondary: '保存能力设置后自动计算' };
  }
  if (result.configurationInvalid) {
    return { ...base, effortLabel: '重新配置后可计算', effortDetail: '当前模板或目标设置已变化', primary: '重新配置目标后可计算', secondary: '当前模板或目标设置已变化' };
  }
  if (!result.ready) {
    return result.complete
      ? { ...base, effortLabel: '0 天 · 已完成', effortDetail: '剩余任务量为 0', primary: '已完成 · 无法估算', secondary: '补足历史记录后可恢复完成时指标', state: 'complete' }
      : { ...base, effortLabel: '补足记录后可计算', effortDetail: result.reason || '需要有效的完成量与用时数据', primary: '补足历史记录后可计算', secondary: '需要有效的完成量与用时数据' };
  }

  const requiredMinutes = Math.max(0, Number(result.requiredMinutes) || 0);
  const effortDays = requiredMinutes / dailyMinutes;
  const effortLabel = result.complete
    ? '0 天 · 已完成'
    : requiredMinutes <= 0
      ? '待确认章节完成状态'
    : effortDays < .1
      ? '不足 0.1 天'
      : `约 ${effortDays.toFixed(1)} 天`;
  const effortBase = {
    ...base,
    effortLabel,
    effortDetail: result.complete ? '剩余任务量为 0' : base.effortDetail,
    state: result.complete ? 'complete' : 'ready',
  };

  const mode = result.goal.mode;
  const unit = result.goal.quantityUnit || '数量';
  if (mode === 'quantity') {
    const dailyQuantity = dailyMinutes * (Number(result.speed) || 0);
    return {
      ...effortBase,
      primary: `约 ${forecastDisplayMetric(dailyQuantity)} ${unit} / 天`,
      secondary: '按当前数量效率估算',
    };
  }
  if (mode === 'chapter') {
    const dailyChapters = dailyMinutes * (Number(result.speed) || 0);
    return {
      ...effortBase,
      primary: `约 ${forecastDisplayMetric(dailyChapters)} 章 / 天`,
      secondary: '按已完成章节平均用时估算',
    };
  }

  const dailyQuantity = dailyMinutes * (Number(result.speed) || 0);
  const averageChapterMinutes = Number(result.averageMinutes) || 0;
  const dailyChapters = averageChapterMinutes > 0 ? dailyMinutes / averageChapterMinutes : 0;
  return {
    ...effortBase,
    primary: `约 ${forecastDisplayMetric(dailyQuantity)} ${unit} / 天`,
    secondary: `约 ${forecastDisplayMetric(dailyChapters)} 章 / 天`,
  };
}

function forecastOpenTask(dateStr, encodedTaskId) {
  const taskId = decodeURIComponent(encodedTaskId || '');
  if (!dateStr || !taskId) return;
  monthEditTask(dateStr, taskId);
}

function forecastTaskNameHtml(record) {
  if (!record.taskId) return `<span class="forecast-ledger-task disabled" title="该历史任务缺少ID，无法编辑">${escHtmlApp(record.taskName)}</span>`;
  const encodedId = encodeURIComponent(record.taskId).replace(/'/g, '%27');
  return `<button type="button" class="forecast-ledger-task" onclick="forecastOpenTask('${record.date}','${encodedId}')">${escHtmlApp(record.taskName)}</button>`;
}

function forecastTaskEditHtml(record) {
  if (!record.taskId) return '<button type="button" class="btn btn-ghost btn-sm" disabled>不可编辑</button>';
  const encodedId = encodeURIComponent(record.taskId).replace(/'/g, '%27');
  return `<button type="button" class="btn btn-ghost btn-sm" onclick="forecastOpenTask('${record.date}','${encodedId}')">编辑</button>`;
}

function forecastQuantityHistoryHtml(result) {
  if (result.goal.mode !== 'quantity') return '';
  const records = Array.isArray(result.records) ? result.records : [];
  return `<details class="forecast-history-panel">
    <summary><span><b>题数完成明细</b><small>${records.length} 条有效任务 · 累计 ${forecastDisplayMetric(result.completed)} ${escHtmlApp(result.goal.quantityUnit)}</small></span><span>展开</span></summary>
    ${records.length ? `<div class="forecast-ledger-wrap"><table class="forecast-ledger-table">
      <thead><tr><th>日期</th><th>任务</th><th>任务用时</th><th>本次增加</th><th>累计题数</th><th>本次效率</th><th>操作</th></tr></thead>
      <tbody>${records.map(record => `<tr><td class="fw-mono">${formatShort(record.date)}</td><td>${forecastTaskNameHtml(record)}</td><td class="fw-mono">${fmtMin(record.minutes, true)}</td><td class="fw-mono c-actual">+${forecastDisplayMetric(record.quantity)} ${escHtmlApp(result.goal.quantityUnit)}</td><td class="fw-mono">${forecastDisplayMetric(record.cumulativeQuantity)} ${escHtmlApp(result.goal.quantityUnit)}</td><td class="fw-mono">${formatQuestionEfficiency(record.efficiency, result.goal.quantityUnit || '题')}</td><td>${forecastTaskEditHtml(record)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="forecast-ledger-empty">当前还没有参与预测的题数任务。</div>'}
  </details>`;
}

function forecastChapterTaskListHtml(item, result) {
  const quantityEnabled = result.goal.mode === 'chapterQuantity';
  const records = Array.isArray(item.records) ? [...item.records] : [];
  let cumulativeMinutes = 0;
  let cumulativeQuantity = 0;
  const rows = records.map(record => {
    if (record.validMinutes) cumulativeMinutes += Number(record.allocatedMinutes) || 0;
    if (record.validQuantity) cumulativeQuantity += Number(record.allocatedQuantity) || 0;
    const efficiency = record.validMinutes && record.validQuantity
      ? Number(record.allocatedQuantity) / Number(record.allocatedMinutes)
      : null;
    return `<tr class="${record.reasons?.length ? 'forecast-ledger-invalid' : ''}">
      <td class="fw-mono">${formatShort(record.date)}</td>
      <td>${forecastTaskNameHtml(record)}</td>
      <td class="fw-mono">${record.validMinutes ? fmtMin(record.allocatedMinutes, true) : '-'}</td>
      <td class="fw-mono">${fmtMin(cumulativeMinutes, true)}</td>
      ${quantityEnabled ? `<td class="fw-mono c-actual">${record.allocatedQuantity != null ? `+${forecastDisplayMetric(record.allocatedQuantity)} ${escHtmlApp(result.goal.quantityUnit)}` : '-'}</td><td class="fw-mono">${forecastDisplayMetric(cumulativeQuantity)} ${escHtmlApp(result.goal.quantityUnit)}</td><td class="fw-mono">${formatQuestionEfficiency(efficiency, result.goal.quantityUnit || '题')}</td>` : ''}
      <td>${record.completed ? '<span class="forecast-completion-badge">本次完成章节</span>' : '<span class="c-muted">贡献进度</span>'}${record.reasons?.length ? `<small class="forecast-ledger-reason">${escHtmlApp(record.reasons.join('；'))}</small>` : ''}</td>
      <td>${forecastTaskEditHtml(record)}</td>
    </tr>`;
  }).join('');
  const columnCount = quantityEnabled ? 9 : 6;
  return `<div class="forecast-chapter-task-list"><div class="forecast-ledger-wrap"><table class="forecast-ledger-table chapter-ledger">
    <thead><tr><th>日期</th><th>任务</th><th>本次时长</th><th>累计时长</th>${quantityEnabled ? '<th>本次题数</th><th>累计题数</th><th>章节效率</th>' : ''}<th>章节状态</th><th>操作</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${columnCount}" class="forecast-ledger-empty">当前章节还没有关联任务。</td></tr>`}</tbody>
  </table></div></div>`;
}

function forecastChapterProgressHtml(result) {
  if (!['chapter', 'chapterQuantity'].includes(result.goal.mode) || !Array.isArray(result.items)) return '';
  const quantityEnabled = result.goal.mode === 'chapterQuantity';
  return `<details class="forecast-chapter-progress">
    <summary class="forecast-chapter-progress-head"><span><b>逐章进度</b><small>${result.items.filter(item => !item.archived).length} 个活动章节</small></span></summary>
    <div class="forecast-chapter-list">
      ${result.items.map(item => {
        const records = Array.isArray(item.records) ? item.records : [];
        const displayMinutes = item.archived ? records.reduce((sum, record) => sum + (record.validMinutes ? Number(record.allocatedMinutes) || 0 : 0), 0) : item.minutes;
        const displayQuantity = item.archived ? records.reduce((sum, record) => sum + (record.validQuantity ? Number(record.allocatedQuantity) || 0 : 0), 0) : item.quantity;
        const hasProgress = displayMinutes > 0 || displayQuantity > 0;
        const stateLabel = item.archived ? '已归档' : item.completed ? '✓ 已完成' : hasProgress ? '进行中' : '未开始';
        const stateClass = item.archived ? 'archived' : item.completed ? 'complete' : hasProgress ? 'active' : 'idle';
        let estimate = '';
        if (!item.archived && !item.completed && result.ready) {
          estimate = quantityEnabled
            ? `预计剩余 ${forecastDisplayMetric(item.estimatedRemainingQuantity)} ${escHtmlApp(result.goal.quantityUnit)} · ${fmtMin(Math.ceil(item.estimatedRemainingMinutes), true)}`
            : `预计剩余 ${fmtMin(Math.ceil(item.estimatedRemainingMinutes), true)}`;
        }
        return `<details class="forecast-chapter-item ${stateClass}">
          <summary><div class="forecast-chapter-main"><b>${escHtmlApp(item.name)}</b>${item.quantityExceededAverage ? '<span class="forecast-chapter-warning">累计数量已达到平均值，但尚未勾选完成</span>' : ''}</div><div class="forecast-chapter-meta"><span class="forecast-chapter-state">${stateLabel}</span><span>累计 ${fmtMin(displayMinutes, true)}${quantityEnabled ? ` · ${forecastDisplayMetric(displayQuantity)} ${escHtmlApp(result.goal.quantityUnit)}` : ''}</span><span>${records.length} 条任务</span>${estimate ? `<span class="forecast-chapter-estimate">${estimate}</span>` : ''}</div></summary>
          ${forecastChapterTaskListHtml(item, result)}
        </details>`;
      }).join('')}
    </div>
  </details>`;
}

function forecastExcludedRecordsHtml(result) {
  const records = Array.isArray(result.excludedRecords) ? result.excludedRecords : [];
  if (!records.length) return '';
  return `<details class="forecast-excluded-records">
    <summary><span><b>未计入记录</b><small>${records.length} 条 · 不影响主累计值</small></span><span>查看原因</span></summary>
    <div class="forecast-ledger-wrap"><table class="forecast-ledger-table excluded-ledger"><thead><tr><th>日期</th><th>任务</th><th>章节</th><th>记录值</th><th>未计入原因</th><th>操作</th></tr></thead>
      <tbody>${records.map(record => `<tr><td class="fw-mono">${formatShort(record.date)}</td><td>${forecastTaskNameHtml(record)}</td><td>${escHtmlApp(record.itemName || '-')}</td><td class="fw-mono">${record.allocatedQuantity != null ? `${forecastDisplayMetric(record.allocatedQuantity)} ${escHtmlApp(record.quantityUnit || result.goal.quantityUnit || '')}` : record.quantity != null ? `${forecastDisplayMetric(record.quantity)} ${escHtmlApp(record.quantityUnit || '')}` : '-'}${record.allocatedMinutes != null ? ` · ${fmtMin(record.allocatedMinutes, true)}` : record.minutes ? ` · ${fmtMin(record.minutes, true)}` : ''}</td><td><span class="forecast-ledger-reason">${escHtmlApp((record.reasons || ['记录不完整']).join('；'))}</span></td><td>${forecastTaskEditHtml(record)}</td></tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

function forecastGoalHistoryHtml(result) {
  return `${forecastQuantityHistoryHtml(result)}${forecastChapterProgressHtml(result)}${forecastExcludedRecordsHtml(result)}`;
}

function forecastNamedItemProgressHtml(result) {
  return forecastGoalHistoryHtml(result);
}

function forecastGoalStatusMeta(result) {
  if (forecastGoalIsExcluded(result)) return { key: 'excluded', label: '已屏蔽', detail: '未参与总预测' };
  if (result.complete) return { key: 'complete', label: '已完成', detail: '目标已完成' };
  if (result.ready) return { key: 'ready', label: '', detail: `预计还需 ${fmtMin(Math.ceil(result.requiredMinutes), true)}` };
  if (result.configurationInvalid) return { key: 'invalid', label: '需要重新配置', detail: '模板或目标设置已变化' };
  return { key: 'insufficient', label: '数据不足', detail: '需要更多有效历史记录' };
}

function forecastGoalCardHtml(result, capacity) {
  const status = forecastGoalStatusMeta(result);
  const categoryPath = getTaskTemplates().find(template => template.id === result.goal.templateId)?.activityType || '未分类';
  const progress = Math.max(0, Math.min(100, Number(result.progress) || 0));
  const isExcluded = forecastGoalIsExcluded(result);
  const dailyOutput = forecastDailyOutputMeta(result, capacity);
  const remaining = result.complete
    ? '0'
    : result.ready
      ? `预计还需 ${fmtMin(Math.ceil(result.requiredMinutes), true)}`
      : result.reason || status.detail;
  return `<article class="forecast-target-card ${status.key}">
    <div class="forecast-goal-head">
      <div>
        ${status.label ? `<span class="forecast-status ${status.key}">${status.label}</span>` : ''}
        <b>${escHtmlApp(result.goal.name)}</b>
        <small>分类 · ${escHtmlApp(categoryPath)}</small>
        <small>${escHtmlApp(forecastPrimaryTargetLabel(result.goal))}</small>
      </div>
      <div class="forecast-goal-actions">
        <button class="btn btn-ghost btn-sm" onclick="forecastToggleExcluded('${result.goal.id}')">${isExcluded ? '解除屏蔽' : '屏蔽'}</button>
        <button class="btn btn-ghost btn-sm" onclick="forecastEdit('${result.goal.id}')">编辑</button>
        <button class="btn btn-danger btn-sm" onclick="forecastDelete('${result.goal.id}')">删除</button>
      </div>
    </div>
    <div class="forecast-progress" aria-label="完成进度 ${progress.toFixed(0)}%">
      <span style="width:${progress.toFixed(2)}%"></span>
    </div>
    <div class="forecast-daily-output ${dailyOutput.state}">
      <div class="forecast-effort-days">
        <span>全力完成时间</span>
        <strong>${escHtmlApp(dailyOutput.effortLabel)}</strong>
        <small>${escHtmlApp(dailyOutput.effortDetail)}</small>
      </div>
      <div class="forecast-daily-throughput">
        <span>若全天投入此目标</span>
        <strong>${escHtmlApp(dailyOutput.primary)}</strong>
        <small>${escHtmlApp(dailyOutput.secondary)}</small>
      </div>
    </div>
    <div class="forecast-goal-metrics">
      <div><span>进度</span><strong>${progress.toFixed(0)}%</strong></div>
      <div><span>剩余</span><strong>${escHtmlApp(remaining)}</strong></div>
      <div><span>效率</span><strong>${escHtmlApp(result.efficiency)}</strong></div>
    </div>
    <div class="forecast-goal-stats">
      <span>${escHtmlApp(result.summary)}</span>
      ${result.excludedRecords?.length ? `<span class="c-wake">${result.excludedRecords.length} 条记录未计入</span>` : ''}
    </div>
    ${result.warning ? `<div class="forecast-reason c-wake">${escHtmlApp(result.warning)}</div>` : ''}
    ${result.reason ? `<div class="forecast-reason">${escHtmlApp(result.reason)}</div>` : ''}
    ${forecastNamedItemProgressHtml(result)}
  </article>`;
}

function forecastGoalCardsHtml(results, capacity, filtered = false) {
  if (!results.length) return `<div class="forecast-empty-panel" data-render-panel="forecast-targets"><p>${filtered ? '当前分类下暂无预测目标。' : '暂无预测目标。'}</p></div>`;
  const activeCount = forecastActiveResults(results).length;
  return `<section class="forecast-target-section" data-render-panel="forecast-targets">
    <div class="forecast-section-head">
      <div>
        <div class="forecast-eyebrow">Targets</div>
        <h3>预测目标</h3>
      </div>
      <span>${results.length} 个目标 · ${activeCount} 个参与总预测</span>
    </div>
    <div class="forecast-target-grid">${results.map(result => forecastGoalCardHtml(result, capacity)).join('')}</div>
  </section>`;
}

function forecastKpiCardHtml(label, value, sub, tone = '') {
  return `<div class="forecast-kpi-card ${tone}">
    <span>${label}</span>
    <strong>${value}</strong>
    <small>${sub}</small>
  </div>`;
}

function forecastDashboardKpisHtml(results, activeResults, overall, capacity) {
  const completeCount = activeResults.filter(result => result.complete).length;
  const excludedCount = results.length - activeResults.length;
  const blockedCount = activeResults.filter(result => !result.complete && !result.ready).length;
  const readyCount = activeResults.filter(result => !result.complete && result.ready).length;
  return `<div class="forecast-kpi-grid" data-render-panel="forecast-kpis">
    ${forecastKpiCardHtml('目标总数', `${results.length} 个`, `${activeResults.length} 个参与总预测 · ${completeCount} 个已完成`, 'total')}
    ${forecastKpiCardHtml('可预测目标', `${readyCount} 个`, blockedCount ? `${blockedCount} 个待补数据` : '无阻塞目标', blockedCount ? 'warn' : 'ready')}
    ${forecastKpiCardHtml('已屏蔽目标', `${excludedCount} 个`, excludedCount ? '暂不参与顶部总预测' : '没有屏蔽目标', 'excluded')}
    ${forecastKpiCardHtml('有效统计天数', capacity.source === 'range' ? `${capacity.eligibleDays} 天` : '-', capacity.source === 'range' ? '按完整日期范围计算' : '手动模式不使用范围', 'days')}
  </div>`;
}

function forecastHeroHtml(overall, results, activeResults, filtered = false) {
  const completeCount = activeResults.filter(result => result.complete).length;
  const unfinishedCount = activeResults.length - completeCount;
  const capacity = overall.capacity;
  const forecastStartDate = overall.forecastStartDate || getTodayStr();
  const startUsed = Number(overall.startUsed ?? overall.todayUsed) || 0;
  const startUsedLabel = forecastStartDate === getTodayStr() ? '今日已用' : '起点已用';
  const dailyCapacity = capacity.valid && capacity.averageMinutes > 0
    ? fmtMin(Math.round(capacity.averageMinutes), true)
    : '-';
  const remainingMinutes = overall.remainingMinutes;
  const remainingHours = remainingMinutes == null ? null : durationDisplayValue(remainingMinutes);
  const remainingDays = remainingMinutes == null
    ? null
    : forecastRemainingWorkDays(remainingMinutes, capacity.averageMinutes, startUsed);
  const remainingLabel = remainingMinutes == null
    ? '需要补足目标数据'
    : fmtMin(Math.ceil(remainingMinutes), true);
  const remainingState = overall.insufficient
    ? 'blocked'
    : remainingMinutes == null
      ? 'empty'
      : remainingMinutes <= 0
        ? 'complete'
        : 'ready';
  const remainingHoursValue = remainingHours == null
    ? (overall.insufficient ? '待补数据' : '—')
    : remainingHours.toFixed(remainingHours >= 100 ? 1 : 2);
  const remainingHoursDetail = remainingMinutes == null
    ? (overall.insufficient ? `${overall.insufficient} 个目标需要补全数据` : '暂无参与总预测的未完成目标')
    : remainingMinutes > 0
      ? `约 ${fmtMin(Math.ceil(remainingMinutes), true)} · ${unfinishedCount} 个未完成目标`
      : '参与预测的目标已经全部完成';
  const remainingDaysValue = remainingDays == null ? '—' : String(remainingDays);
  const remainingDaysDetail = remainingMinutes == null
    ? '完成目标配置后自动计算'
    : remainingMinutes <= 0
      ? '当前不再需要额外投入'
      : remainingDays == null
        ? '请先设置有效的每日学习能力'
        : `按每日 ${fmtMin(Math.round(capacity.averageMinutes), true)} 计算${startUsed > 0 ? ` · 起点已用 ${fmtMin(startUsed, true)}` : ''}`;
  const summary = activeResults.length
    ? (unfinishedCount ? `参与预测 ${activeResults.length} 个 · 未完成 ${unfinishedCount} 个 · 剩余约 ${remainingLabel}` : '参与预测的目标已经完成')
    : (results.length ? '所有目标已屏蔽，顶部总预测暂不计算' : '尚未建立预测目标');
  return `<section class="forecast-hero" data-render-panel="forecast-hero">
    <div class="forecast-hero-intro">
      <div class="forecast-eyebrow">Forecast Dashboard</div>
      <h2>完成预测</h2>
      <p>把目标进度、历史效率和每日能力统一换算成预计完成时间。</p>
      <div class="forecast-remaining-overview ${remainingState}">
        <div class="forecast-remaining-metric primary">
          <span>${filtered ? '筛选后剩余总投入' : '剩余总投入'}</span>
          <strong>${remainingHoursValue}${remainingHours != null ? `<small>${durationDisplayUnitLabel()}</small>` : ''}</strong>
          <em>${escHtmlApp(remainingHoursDetail)}</em>
        </div>
        <div class="forecast-remaining-metric">
          <span>按当前能力还需</span>
          <strong>${remainingDaysValue}${remainingDays != null ? '<small>天</small>' : ''}</strong>
          <em>${escHtmlApp(remainingDaysDetail)}</em>
        </div>
      </div>
    </div>
    <div class="forecast-hero-result">
      <span>${filtered ? '当前筛选预计完成日' : '全部目标预计完成日'}</span>
      <strong>${escHtmlApp(overall.label)}</strong>
      <small>${summary}</small>
    </div>
    <div class="forecast-hero-strip">
      <div><span>预测起点</span><b>${escHtmlApp(forecastStartDate)}</b></div>
      <div><span>每日能力</span><b>${dailyCapacity}</b></div>
      <div><span>${startUsedLabel}</span><b>${fmtMin(startUsed, true)}</b></div>
      <div><span>已完成目标</span><b>${completeCount}/${activeResults.length}</b></div>
    </div>
  </section>`;
}

function forecastCapacityPanelHtml(settings, capacity, overall) {
  const capacityEndDate = settings.capacityTrackLatest ? getTodayStr() : settings.capacityEndDate;
  const forecastStartDate = settings.forecastStartDate || forecastDefaultStartDate();
  const latestRecordedDate = forecastLatestRecordedDate();
  const startRuleHint = settings.forecastTrackToday
    ? (forecastStartDate === getTodayStr()
      ? '正在跟踪今日：预计起点会在跨日或重新打开程序时自动变为当天。点击“正在跟踪今日”可恢复固定日期。'
      : `正在跟踪今日，但今日之后已有记录，当前暂按 ${forecastStartDate} 作为有效起点；日期条件允许后会自动跟随当天。`)
    : (latestRecordedDate
      ? `可选 ${formatShort(latestRecordedDate)} 及之后的日期；起点之后不能有任何记录，未来日期可以直接选择。`
      : '当前没有记录日期；可以选择任意有效日期，未来日期也可以作为预测起点。');
  const startUsedLabel = forecastStartDate === getTodayStr() ? '今天已完成实际学习' : '起点当天已完成实际学习';
  const startUsed = Number(overall.startUsed ?? overall.todayUsed) || 0;
  return `<aside class="forecast-capacity-panel" data-render-panel="forecast-capacity">
    <div class="forecast-panel-head">
      <div>
        <div class="forecast-eyebrow">Capacity</div>
        <h3>每日学习能力</h3>
        <p>${capacity.source === 'manual' ? '使用手动每日时长' : '按历史实际专注计算日均'}</p>
      </div>
    </div>
    <div class="form-group forecast-start-setting">
      <label>预计起始点</label>
      <div class="forecast-capacity-range forecast-start-range">
        ${editableDateInputHtml('forecast_start_date', forecastStartDate)}
        <button id="forecast_start_save" class="btn btn-primary btn-sm" onclick="forecastSaveStartDate()">保存起点</button>
        <button type="button"
          class="btn ${settings.forecastTrackToday ? 'btn-primary' : 'btn-ghost'} btn-sm"
          aria-pressed="${settings.forecastTrackToday ? 'true' : 'false'}"
          title="${settings.forecastTrackToday ? '点击停止跟踪并固定当前日期' : '让预计起点每天自动更新为当天'}"
          onclick="forecastToggleStartTracking()">${settings.forecastTrackToday ? '✓ 正在跟踪今日' : '跟踪今日'}</button>
      </div>
      <div class="form-hint">${startRuleHint}</div>
    </div>
    <div class="form-group">
      <label>每日可用学习时长来源</label>
      <select id="forecast_capacity_mode" onchange="forecastToggleCapacityMode()">
        <option value="range" ${settings.capacityMode === 'range' ? 'selected' : ''}>按统计范围计算日均</option>
        <option value="manual" ${settings.capacityMode === 'manual' ? 'selected' : ''}>手动设置每日时长</option>
      </select>
    </div>
    <div id="forecast_capacity_range_panel" class="forecast-capacity-mode-panel" style="${settings.capacityMode === 'manual' ? 'display:none' : ''}">
      ${forecastCapacityRangePlannerHtml(settings, capacity)}
      <label class="forecast-track-toggle">
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
      <div class="forecast-capacity-stats">
        <span>统计范围 <b>${capacity.source === 'range' ? capacity.startDate || '-' : settings.capacityStartDate} 至 ${capacity.source === 'range' ? capacity.endDate || '-' : capacityEndDate}</b></span>
        <span>有效天数 <b>${capacity.source === 'range' ? capacity.eligibleDays : '-'}</b></span>
        <span>累计实际 <b>${capacity.source === 'range' ? fmtMin(Math.round(capacity.totalActualMinutes), true) : '-'}</b></span>
        <span>日均实际 <b>${capacity.source === 'range' ? fmtMin(Math.round(capacity.averageMinutes), true) : '切换并保存后计算'}</b></span>
      </div>
      <div class="form-hint">${settings.capacityTrackLatest ? '正在持续跟踪：开始日期保持不变，结束日期会在每天打开本页时自动变为当天。' : '当前为固定范围；启用“跟踪今天”后结束日期将自动前移。'}</div>
    </div>
    <div id="forecast_capacity_manual_panel" class="forecast-capacity-mode-panel" style="${settings.capacityMode === 'manual' ? '' : 'display:none'}">
      <div class="forecast-capacity-range manual">
        <input type="number" id="forecast_manual_daily_minutes" min="1" max="1440" step="1"
          value="${settings.manualDailyMinutes || ''}" placeholder="例如 480">
        <span>分钟 / 天</span>
        <button class="btn btn-primary btn-sm" onclick="forecastSaveCapacityRange()">保存并计算</button>
      </div>
      <div class="form-hint">当前手动每日时长：${settings.manualDailyMinutes > 0 ? fmtMin(settings.manualDailyMinutes, true) : '尚未设置'}。</div>
    </div>
    <div class="forecast-capacity-note">
      <span>历史日均按所选日期范围完整计算。</span>
      <span>${startUsedLabel} ${fmtMin(startUsed, true)}；预测会先扣除起点当天已经使用的时间。</span>
    </div>
  </aside>`;
}

function renderForecast(panelKey = '') {
  const host = document.getElementById('tab-forecast');
  if (!host) return;
  const forecastPanelGroups = {
    filter: ['forecast-hero', 'forecast-kpis', 'forecast-category-filter', 'forecast-targets'],
    capacity: ['forecast-capacity'],
    'capacity-results': ['forecast-hero', 'forecast-kpis', 'forecast-targets', 'forecast-capacity'],
  };
  const requestedPanels = forecastPanelGroups[panelKey] || [];
  let scopedPanel = Boolean(requestedPanels.length && requestedPanels.every(key => host.querySelector(`[data-render-panel="${key}"]`)));
  if (!scopedPanel) {
    const templateManager = document.getElementById('template-named-items-manager');
    if (templateManager) templateManager.innerHTML = '';
  }
  const settings = getForecastSettings();
  const results = getForecastGoals().map(calculateForecastGoal);
  const categoryContext = forecastCategoryFilterContext(results);
  const visibleResults = categoryContext.filteredResults;
  const activeResults = forecastActiveResults(visibleResults);
  const overall = calculateForecastOverall(activeResults);
  const capacity = overall.capacity;
  const forecastHtml = `<div class="forecast-page forecast-dashboard">
    ${forecastHeroHtml(overall, visibleResults, activeResults, categoryContext.hasFilter)}
    ${forecastDashboardKpisHtml(visibleResults, activeResults, overall, capacity)}
    ${forecastCategoryFilterHtml(categoryContext)}
    <div class="forecast-main-layout">
      <main class="forecast-main-column">
          ${forecastGoalCardsHtml(visibleResults, capacity, categoryContext.hasFilter)}
        ${forecastGoalFormHtml()}
      </main>
      ${forecastCapacityPanelHtml(settings, capacity, overall)}
    </div>
  </div>`;
  if (scopedPanel && !replaceRenderPanels(host, forecastHtml, requestedPanels)) scopedPanel = false;
  if (!scopedPanel) host.innerHTML = forecastHtml;
  requestAnimationFrame(() => {
    if (!scopedPanel) forecastUpdateGoalFields();
    if (!scopedPanel || panelKey === 'capacity' || panelKey === 'capacity-results') {
      forecastToggleCapacityMode();
      forecastApplyStartTrackingUi();
      forecastApplyCapacityTrackingUi();
    }
  });
}

let _forecastTrackedToday = getTodayStr();
let _forecastTodayTimer = null;
function forecastRefreshTrackedToday() {
  const today = getTodayStr();
  if (today === _forecastTrackedToday) return;
  _forecastTrackedToday = today;
  const settings = getForecastSettings();
  if (!settings.forecastTrackToday || state.tab !== 'forecast') return;
  renderForecast('capacity-results');
}

function startForecastTodayTracking() {
  if (_forecastTodayTimer) clearInterval(_forecastTodayTimer);
  _forecastTrackedToday = getTodayStr();
  _forecastTodayTimer = setInterval(forecastRefreshTrackedToday, 60000);
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

function workbookChartSeries(sections) {
  let cumulativeTotal = 0;
  let cumulativeWrong = 0;
  const rows = (sections || []).map((section, index) => {
    const metric = workbookMetric(section);
    cumulativeTotal += metric.total;
    cumulativeWrong += metric.wrong;
    return {
      label: String(section?.name || '').trim() || `分段 ${index + 1}`,
      total: metric.total,
      wrong: metric.wrong,
      errorRate: metric.total > 0 ? Number(metric.errorRate.toFixed(2)) : null,
      cumulativeTotal,
      cumulativeWrong,
      cumulativeErrorRate: cumulativeTotal > 0
        ? Number((cumulativeWrong / cumulativeTotal * 100).toFixed(2))
        : null,
    };
  });
  return {
    rows,
    labels: rows.map(row => row.label),
    totals: rows.map(row => row.total),
    errorRates: rows.map(row => row.errorRate),
    cumulativeTotals: rows.map(row => row.cumulativeTotal),
    cumulativeErrorRates: rows.map(row => row.cumulativeErrorRate),
  };
}

function workbookInsights(sections) {
  const totals = workbookTotals(sections);
  const rows = (sections || []).map((section, index) => ({
    name: String(section?.name || '').trim() || `分段 ${index + 1}`,
    ...workbookMetric(section),
  })).filter(row => row.total > 0);
  const highestErrorRate = [...rows].sort((a, b) => b.errorRate - a.errorRate || b.wrong - a.wrong)[0] || null;
  const mostWrong = [...rows].sort((a, b) => b.wrong - a.wrong || b.errorRate - a.errorRate)[0] || null;
  const largestSection = [...rows].sort((a, b) => b.total - a.total || b.wrong - a.wrong)[0] || null;
  const aboveAverageCount = rows.filter(row => row.errorRate > totals.errorRate).length;
  return { rows, totals, highestErrorRate, mostWrong, largestSection, aboveAverageCount };
}

function workbookLibrarySummary(reviews) {
  const subjects = new Set();
  let total = 0;
  let wrong = 0;
  (reviews || []).forEach(review => {
    const subject = String(review?.subject || '').trim();
    if (subject) subjects.add(subject);
    const metrics = workbookTotals(review?.sections);
    total += metrics.total;
    wrong += metrics.wrong;
  });
  return { reviewCount: reviews.length, subjectCount: subjects.size, total, wrong };
}

function workbookFilteredReviews(reviews) {
  const query = String(state.workbookReviewQuery || '').trim().toLocaleLowerCase();
  const filtered = (reviews || []).filter(review => {
    if (!query) return true;
    return `${review.title || ''} ${review.subject || ''}`.toLocaleLowerCase().includes(query);
  });
  const sort = state.workbookReviewSort || 'updatedDesc';
  return [...filtered].sort((a, b) => {
    if (sort === 'completedDesc') return String(b.completedDate || '').localeCompare(String(a.completedDate || ''));
    if (sort === 'totalDesc') return workbookTotals(b.sections).total - workbookTotals(a.sections).total;
    if (sort === 'errorDesc') return workbookTotals(b.sections).errorRate - workbookTotals(a.sections).errorRate;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
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

function workbookMoveSection(index, direction) {
  ensureWorkbookDraft();
  const targetIndex = index + Number(direction || 0);
  const sections = state.workbookDraft.sections;
  if (!sections[index] || targetIndex < 0 || targetIndex >= sections.length) return;
  [sections[index], sections[targetIndex]] = [sections[targetIndex], sections[index]];
  renderWorkbookReview();
  document.getElementById(`workbook-section-name-${targetIndex}`)?.focus();
}

function workbookDuplicateSection(index) {
  ensureWorkbookDraft();
  const source = state.workbookDraft.sections[index];
  if (!source) return;
  const names = new Set(state.workbookDraft.sections.map(section => String(section?.name || '').trim()).filter(Boolean));
  const originalName = String(source.name || '').trim();
  let copyName = originalName ? `${originalName}（副本）` : '';
  let copyNumber = 2;
  while (copyName && names.has(copyName)) copyName = `${originalName}（副本${copyNumber++}）`;
  state.workbookDraft.sections.splice(index + 1, 0, {
    ...cloneWorkbookReview(source),
    id: uid(),
    name: copyName,
  });
  renderWorkbookReview();
  document.getElementById(`workbook-section-name-${index + 1}`)?.focus();
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

async function workbookDuplicateReview(id) {
  const review = getWorkbookReviews().find(item => item.id === id);
  if (!review) return;
  const now = new Date().toISOString();
  const duplicated = {
    ...cloneWorkbookReview(review),
    id: uid(),
    title: workbookUniqueTitle(String(review.title || '未命名资料').trim()),
    sections: (review.sections || []).map(section => ({ ...cloneWorkbookReview(section), id: uid() })),
    createdAt: now,
    updatedAt: now,
  };
  getWorkbookReviews().push(duplicated);
  state.workbookReviewId = duplicated.id;
  state.workbookDraft = cloneWorkbookReview(duplicated);
  await saveAllStorage();
  renderWorkbookReview();
  const message = document.getElementById('workbook-save-message');
  if (message) message.textContent = `✅ 已复制并保存为「${duplicated.title}」`;
}

function workbookSetQuery(value) {
  state.workbookReviewQuery = String(value || '');
  workbookRefreshLibrary();
}

function workbookSetSort(value) {
  state.workbookReviewSort = ['updatedDesc', 'completedDesc', 'totalDesc', 'errorDesc'].includes(value)
    ? value
    : 'updatedDesc';
  workbookRefreshLibrary();
}

function workbookRefreshLibrary() {
  const reviews = getWorkbookReviews();
  const filtered = workbookFilteredReviews(reviews);
  const host = document.getElementById('workbook-library-results');
  const count = document.getElementById('workbook-library-count');
  if (host) host.innerHTML = workbookCardsHtml(filtered);
  if (count) count.textContent = `显示 ${filtered.length}/${reviews.length}`;
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
    return '<div class="workbook-library-empty"><b>没有匹配的整册复盘</b><span>可以调整搜索条件，或新建一份复盘。</span></div>';
  }
  return reviews.map(review => {
    const totals = workbookTotals(review.sections);
    const active = review.id === state.workbookReviewId;
    return `<article class="workbook-card ${active ? 'active' : ''}">
      <button class="workbook-card-main" onclick="workbookOpenReview('${review.id}')">
        <span class="workbook-card-heading"><b>${escHtmlApp(review.title || '未命名资料')}</b><i>${workbookPct(totals.errorRate)}</i></span>
        <span>${escHtmlApp(review.subject || '未填写学科')} · ${escHtmlApp(review.completedDate || '-')}</span>
        <span>${(review.sections || []).length} 个分段 · ${totals.total} 题 · 错 ${totals.wrong} 题</span>
      </button>
      <div class="workbook-card-actions">
        <button type="button" class="workbook-card-delete" onclick="workbookDelete('${review.id}')">删除</button>
        <details class="workbook-card-menu">
          <summary title="更多操作">更多</summary>
          <div>
            <button type="button" onclick="workbookDuplicateReview('${review.id}')">复制为新复盘</button>
          </div>
        </details>
      </div>
    </article>`;
  }).join('');
}

function workbookHeroHtml(reviews) {
  const summary = workbookLibrarySummary(reviews);
  return `<section class="workbook-hero">
    <div>
      <div class="workbook-eyebrow">WORKBOOK REVIEW</div>
      <h2>整册复盘</h2>
      <p>把整本练习册、教材或题库拆成可比较的分段，集中查看题量、错误率和累计变化。</p>
    </div>
    <div class="workbook-hero-actions">
      <div class="workbook-hero-stats">
        <div><span>已保存整册</span><strong>${summary.reviewCount}</strong></div>
        <div><span>涉及学科</span><strong>${summary.subjectCount}</strong></div>
        <div><span>累计题量</span><strong>${summary.total}</strong></div>
        <div><span>累计错题</span><strong>${summary.wrong}</strong></div>
      </div>
      <button class="btn btn-primary" onclick="workbookStartNew()">＋ 新建复盘</button>
    </div>
  </section>`;
}

function workbookLibraryHtml(reviews) {
  const filtered = workbookFilteredReviews(reviews);
  return `<aside class="workbook-library">
    <div class="workbook-panel-head">
      <div><div class="workbook-eyebrow">LIBRARY</div><h3>复盘资料库</h3></div>
      <span id="workbook-library-count">显示 ${filtered.length}/${reviews.length}</span>
    </div>
    <div class="workbook-library-tools">
      <label><span>搜索标题或学科</span><input type="search" value="${escHtmlApp(state.workbookReviewQuery || '')}" placeholder="输入关键词" oninput="workbookSetQuery(this.value)"></label>
      <label><span>排序</span><select onchange="workbookSetSort(this.value)">
        <option value="updatedDesc" ${state.workbookReviewSort === 'updatedDesc' ? 'selected' : ''}>最近更新</option>
        <option value="completedDesc" ${state.workbookReviewSort === 'completedDesc' ? 'selected' : ''}>完成日期</option>
        <option value="totalDesc" ${state.workbookReviewSort === 'totalDesc' ? 'selected' : ''}>总题数</option>
        <option value="errorDesc" ${state.workbookReviewSort === 'errorDesc' ? 'selected' : ''}>错误率</option>
      </select></label>
    </div>
    <div class="workbook-list" id="workbook-library-results">${workbookCardsHtml(filtered)}</div>
  </aside>`;
}

function workbookSummaryHtml(totals, sectionCount) {
  return `<section class="workbook-summary-panel">
    <div class="workbook-panel-head"><div><div class="workbook-eyebrow">OVERVIEW</div><h3>整册概览</h3></div></div>
    <div class="workbook-primary-kpis">
      <div><span>总题数</span><strong id="workbook-total">${totals.total}</strong><small>全部分段题量</small></div>
      <div><span>错题数</span><strong class="c-red" id="workbook-wrong">${totals.wrong}</strong><small>累计错误题目</small></div>
      <div><span>整体错误率</span><strong class="c-red" id="workbook-error-rate">${workbookPct(totals.errorRate)}</strong><small>错题数 ÷ 总题数</small></div>
    </div>
    <div class="workbook-secondary-kpis">
      <div><span>正确数</span><strong class="c-green" id="workbook-correct">${totals.correct}</strong></div>
      <div><span>正确率</span><strong class="c-green" id="workbook-accuracy">${workbookPct(totals.accuracy)}</strong></div>
      <div><span>分段数量</span><strong id="workbook-section-count">${sectionCount}</strong></div>
    </div>
  </section>`;
}

function workbookInsightsHtml(sections) {
  const insight = workbookInsights(sections);
  if (!insight.rows.length) {
    return '<div class="workbook-insight-empty">录入有效题数后，这里会自动识别薄弱分段。</div>';
  }
  return `<div class="workbook-insight-grid">
    <div><span>错误率最高</span><b>${escHtmlApp(insight.highestErrorRate.name)}</b><strong class="c-red">${workbookPct(insight.highestErrorRate.errorRate)}</strong></div>
    <div><span>错题数量最多</span><b>${escHtmlApp(insight.mostWrong.name)}</b><strong class="c-red">${insight.mostWrong.wrong} 题</strong></div>
    <div><span>题量最大</span><b>${escHtmlApp(insight.largestSection.name)}</b><strong>${insight.largestSection.total} 题</strong></div>
    <div><span>高于整册平均</span><b>${insight.aboveAverageCount} / ${insight.rows.length} 个分段</b><strong>${workbookPct(insight.totals.errorRate)}</strong></div>
  </div>`;
}

function workbookChartsHtml(sections) {
  const series = workbookChartSeries(sections);
  if (!series.rows.some(row => row.total > 0)) {
    return '<div class="workbook-chart-empty"><b>暂无可分析数据</b><span>填写分段总题数和错误数后，四张图表会实时生成。</span></div>';
  }
  const views = [
    ['questions', '分段总题数', '各分段题量'],
    ['errorRate', '分段错误率', '对照整册平均'],
    ['cumulativeQuestions', '累计总题数', '逐段累加题量'],
    ['cumulativeErrorRate', '累计错误率', '累计加权结果'],
  ];
  const active = views.some(([key]) => key === state.workbookChartView)
    ? state.workbookChartView
    : 'questions';
  state.workbookChartView = active;
  const activeMeta = views.find(([key]) => key === active);
  return `<div class="workbook-chart-switcher" role="tablist" aria-label="整册复盘图表">
      ${views.map(([key, title, note]) => `<button type="button" role="tab" aria-selected="${key === active}" class="${key === active ? 'active' : ''}" onclick="switchWorkbookChartView('${key}')">
        <b>${title}</b><span>${note}</span>
      </button>`).join('')}
    </div>
    <article class="workbook-chart-stage">
      <div class="workbook-chart-stage-head">
        <div><span>ACTIVE ANALYSIS</span><h4>${activeMeta[1]}</h4></div>
        <p>${activeMeta[2]}，按当前表格顺序实时计算</p>
      </div>
      <div class="workbook-chart-canvas"><canvas id="workbookActiveChart"></canvas></div>
    </article>`;
}

function switchWorkbookChartView(view) {
  if (!['questions', 'errorRate', 'cumulativeQuestions', 'cumulativeErrorRate'].includes(view)) return;
  state.workbookChartView = view;
  renderWorkbookCharts();
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
      <td><div class="workbook-row-actions">
        <button type="button" title="上移" onclick="workbookMoveSection(${index},-1)" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" title="下移" onclick="workbookMoveSection(${index},1)" ${index === sections.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" title="复制分段" onclick="workbookDuplicateSection(${index})">复制</button>
        <button type="button" class="danger" title="删除分段" onclick="workbookRemoveSection(${index})">删除</button>
      </div></td>
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
    <div class="workbook-dashboard">
      ${workbookHeroHtml(reviews)}
      <div class="workbook-layout">
        ${workbookLibraryHtml(reviews)}
        <main class="workbook-workspace">
          <section class="workbook-info-panel">
            <div class="workbook-panel-head">
              <div><div class="workbook-eyebrow">CURRENT REVIEW</div><h3>${state.workbookReviewId ? '编辑整册复盘' : '新建整册复盘'}</h3></div>
              <span class="workbook-draft-status ${state.workbookReviewId ? 'saved' : ''}">${state.workbookReviewId ? '已保存记录' : '尚未保存'}</span>
            </div>
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
            <textarea rows="2" maxlength="500" placeholder="记录资料版本、复盘结论或后续安排" oninput="workbookSetMeta('note',this.value)">${escHtmlApp(draft.note || '')}</textarea>
          </div>
        </div>
          </section>

          ${workbookSummaryHtml(totals, draft.sections.length)}

          <section class="workbook-insight-panel">
            <div class="workbook-panel-head">
              <div><div class="workbook-eyebrow">WEAKNESS SIGNALS</div><h3>薄弱分段洞察</h3></div>
              <span>根据当前录入实时计算</span>
            </div>
            <div id="workbook-insights">${workbookInsightsHtml(draft.sections)}</div>
          </section>

          <section class="workbook-section-editor">
            <div class="workbook-section-toolbar">
              <div><div class="workbook-eyebrow">SECTION EDITOR</div><h3>分段明细</h3><p>当前共 <b id="workbook-section-toolbar-count">${draft.sections.length}</b> 个分段，累计图按此顺序计算。</p></div>
              <div class="workbook-section-tools">
                <button class="btn btn-primary btn-sm" onclick="workbookAddSection()" title="新增空白分段">＋ 新增空白分段</button>
                <button type="button" id="workbook-section-predict" class="btn btn-ghost btn-sm"
                  onclick="workbookAddPredictedSection()" ${sectionPrediction.predictedName ? '' : 'disabled'}>
                  ${sectionPrediction.predictedName ? `⚡＋ ${escHtmlApp(sectionPrediction.predictedName)}` : '⚡＋预测下一项'}
                </button>
                <span id="workbook-section-predict-hint" class="form-hint">
                  ${sectionPrediction.predictedName ? '' : (sectionPrediction.lastName ? '当前名称无法推测下一项' : '请先填写一个分段名称')}
                </span>
              </div>
            </div>
            <div class="table-wrap workbook-table-wrap">
              <table class="workbook-table">
                <thead><tr><th>#</th><th>分段名称 *</th><th>总题数 *</th><th>错误数 *</th><th>正确数</th><th>正确率</th><th>错误率</th><th>备注</th><th>操作</th></tr></thead>
                <tbody>${workbookSectionsHtml(draft.sections)}</tbody>
              </table>
            </div>
            <div class="workbook-editor-actions">
              <button class="btn btn-success" onclick="workbookSave()">💾 保存整册复盘</button>
              <button class="btn btn-ghost" onclick="workbookResetDraft()" title="放弃尚未保存的修改">取消</button>
              <span id="workbook-save-message"></span>
            </div>
          </section>

          <section class="workbook-analysis-panel">
            <div class="workbook-panel-head">
              <div><div class="workbook-eyebrow">FOUR-CHART ANALYSIS</div><h3>题量与错误趋势</h3></div>
              <span>累计指标按当前分段顺序计算</span>
            </div>
            <div id="workbook-charts"></div>
          </section>
        </main>
      </div>
    </div>`;

  scheduleWorkbookCharts();
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
  const insightsHost = document.getElementById('workbook-insights');
  if (insightsHost) insightsHost.innerHTML = workbookInsightsHtml(state.workbookDraft.sections);
  scheduleWorkbookCharts();
}

let workbookChartFrame = null;
function scheduleWorkbookCharts() {
  if (workbookChartFrame != null) cancelAnimationFrame(workbookChartFrame);
  workbookChartFrame = requestAnimationFrame(() => {
    workbookChartFrame = null;
    renderWorkbookCharts();
  });
}

function renderWorkbookCharts() {
  const host = document.getElementById('workbook-charts');
  if (!host || !state.workbookDraft || state.tab !== 'workbookReview') return;
  const chartIds = [
    'workbookActiveChart',
    'workbookQuestionsChart',
    'workbookErrorRateChart',
    'workbookCumulativeQuestionsChart',
    'workbookCumulativeErrorRateChart',
  ];
  chartIds.forEach(destroyChart);
  const sections = state.workbookDraft.sections || [];
  host.innerHTML = workbookChartsHtml(sections);
  const series = workbookChartSeries(sections);
  if (!series.rows.some(row => row.total > 0)) return;
  const totals = workbookTotals(sections);
  const questionTooltip = context => `${context.dataset.label}: ${Number(context.parsed.y || 0)} 题`;
  const percentTooltip = context => {
    const value = context.parsed.y;
    return `${context.dataset.label}: ${value == null ? '-' : `${Number(value).toFixed(2)}%`}`;
  };
  const xScale = {
    ticks: { color: '#6b7a9e', autoSkip: true, autoSkipPadding: 18, maxRotation: 35, minRotation: 0 },
    grid: gridCfg,
  };
  const questionScale = {
    beginAtZero: true,
    ticks: { precision: 0, color: '#6b7a9e' },
    title: { display: true, text: '题数', color: '#7f8fb3' },
    grid: gridCfg,
  };
  const percentScale = {
    beginAtZero: true,
    min: 0,
    max: 100,
    ticks: { color: '#6b7a9e', callback: value => `${value}%` },
    title: { display: true, text: '错误率 (%)', color: '#7f8fb3' },
    grid: gridCfg,
  };
  const chartOptions = (yScale, tooltipLabel, showLegend = false) => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: showLegend
        ? { labels: { color: '#6b7a9e', boxWidth: 10, padding: 12 } }
        : { display: false },
      tooltip: { callbacks: { label: tooltipLabel } },
    },
    scales: { x: xScale, y: yScale },
  });

  const view = state.workbookChartView || 'questions';
  let config;
  if (view === 'errorRate') {
    const errorRateColor = getChartSeriesColor('workbookErrorRate');
    const averageErrorRateColor = getChartSeriesColor('workbookAverageErrorRate');
    config = {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [
          {
            label: '分段错误率',
            data: series.errorRates,
            borderColor: errorRateColor,
            backgroundColor: hexRgba(errorRateColor, .12),
            pointBackgroundColor: errorRateColor,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2.2,
            tension: .18,
            spanGaps: false,
          },
          {
            label: `整册平均 ${workbookPct(totals.errorRate)}`,
            data: series.labels.map(() => Number(totals.errorRate.toFixed(2))),
            borderColor: hexRgba(averageErrorRateColor, .8),
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [6, 5],
            tension: 0,
          },
        ],
      },
      options: chartOptions(percentScale, percentTooltip, true),
    };
  } else if (view === 'cumulativeQuestions') {
    const cumulativeQuestionsColor = getChartSeriesColor('workbookCumulativeQuestions');
    config = {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [{
          label: '累计总题数',
          data: series.cumulativeTotals,
          borderColor: cumulativeQuestionsColor,
          backgroundColor: hexRgba(cumulativeQuestionsColor, .12),
          pointBackgroundColor: cumulativeQuestionsColor,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.2,
          tension: .18,
          fill: true,
        }],
      },
      options: chartOptions(questionScale, questionTooltip),
    };
  } else if (view === 'cumulativeErrorRate') {
    const cumulativeErrorRateColor = getChartSeriesColor('workbookCumulativeErrorRate');
    config = {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [{
          label: '累计错误率',
          data: series.cumulativeErrorRates,
          borderColor: cumulativeErrorRateColor,
          backgroundColor: hexRgba(cumulativeErrorRateColor, .1),
          pointBackgroundColor: cumulativeErrorRateColor,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.2,
          tension: .18,
          fill: true,
          spanGaps: false,
        }],
      },
      options: chartOptions(percentScale, percentTooltip),
    };
  } else {
    const questionsColor = getChartSeriesColor('workbookQuestions');
    config = {
      type: 'bar',
      data: {
        labels: series.labels,
        datasets: [{
          label: '分段总题数',
          data: series.totals,
          backgroundColor: hexRgba(questionsColor, .36),
          borderColor: questionsColor,
          borderWidth: 1.5,
          borderRadius: 4,
        }],
      },
      options: chartOptions(questionScale, questionTooltip),
    };
  }
  mkChart('workbookActiveChart', config);
}

// ============================================================
// ANALYSIS SCORE TAB
// ============================================================
const ANALYSIS_STANDARD_FIELDS = [
  ['awakeMinutes', '清醒时长', '分钟', '起床至睡觉的标准总时长'],
  ['totalClockMinutes', '时钟时长', '分钟', '全部普通、不可用与特殊学习时段的标准跨度'],
  ['nominalMinutes', '名义专注', '分钟', '标准日填写的计划专注总量'],
  ['actualMinutes', '实际专注', '分钟', '标准日真实专注总量，不要求高于名义专注'],
  ['restMinutes', '休息时长', '分钟', '普通专注时段内的标准休息总量'],
  ['unavailableMinutes', '不可用时间', '分钟', '完全不可用时间与特殊学习中未专注部分'],
  ['specialStudyClockMinutes', '特殊学习时钟时长', '分钟', '特殊学习时段的标准总时长，越短越好，且不得小于实际专注'],
  ['specialStudyActualMinutes', '特殊学习实际专注', '分钟', '特殊学习时钟时长内的实际专注，越长越好，且不得超过时钟时长'],
  ['taskMinutes', '任务记录时长', '分钟', '任务记录板的标准总时长'],
];

const ANALYSIS_STANDARD_RELATION_HINTS = {
  awakeMinutes: '时钟时长 + 不可用时间 + 特殊学习时钟时长 ≤ 清醒时长',
  totalClockMinutes: '名义专注 + 休息时长 ≤ 时钟时长；并与不可用、特殊学习时长之和不超过清醒时长',
  nominalMinutes: '实际专注 ≤ 名义专注，且名义专注 + 休息时长 ≤ 时钟时长',
  actualMinutes: '实际专注 ≤ 名义专注，且任务记录时长不超过实际专注与特殊学习实际专注之和',
  restMinutes: '名义专注 + 休息时长 ≤ 时钟时长',
  unavailableMinutes: '时钟时长 + 不可用时间 + 特殊学习时钟时长 ≤ 清醒时长',
  specialStudyClockMinutes: '时钟时长 + 不可用时间 + 特殊学习时钟时长 ≤ 清醒时长',
  specialStudyActualMinutes: '不得超过特殊学习时钟时长；与实际专注共同覆盖任务记录时长',
  taskMinutes: '任务记录时长 ≤ 特殊学习实际专注 + 实际专注',
};

function analysisFallbackConfig() {
  return {
    schemaVersion: 3,
    standardDay: Object.fromEntries(ANALYSIS_STANDARD_FIELDS.map(([key]) => [key, null])),
    taskStandards: [],
  };
}

function analysisCloneConfig(config) {
  const cloned = JSON.parse(JSON.stringify(config || analysisFallbackConfig()));
  (cloned.taskStandards || []).forEach(standard => {
    const template = analysisTemplateForStandard(standard);
    const max = Number(template?.scoreMax);
    if (template?.scoreEnabled && max > 0 && standard.chapterScorePerUnit != null &&
      Number.isFinite(Number(standard.chapterScorePerUnit))) {
      if (standard.scoreRate == null) standard.scoreRate = Number(standard.chapterScorePerUnit) / max;
      standard.chapterScorePerUnit = null;
      standard.chapterMaxScore = null;
    }
  });
  return cloned;
}

function analysisCardById(cardId) {
  return (state.analysis.cards || []).find(card => card.id === cardId) || null;
}

function analysisTrackingCardById(cardId) {
  return (state.analysis.trackingCards || []).find(card => card.id === cardId) || null;
}

function analysisTrackingEffectiveEnd(card) {
  if (!card?.endDate) return '';
  return card.endDate < getTodayStr() ? card.endDate : getTodayStr();
}

function analysisTrackingDays(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return 0;
  return Math.floor((strToDate(endDate) - strToDate(startDate)) / 86400000) + 1;
}

function clearActiveAnalysisTracking() {
  const analysis = state.analysis;
  analysis.activeTrackingCardId = '';
  analysis.activeTrackingPlanEndDate = '';
  analysis.trackingCardSaveOpen = false;
  analysis.trackingCardName = '';
}

function normalizeAnalysisDayTypeFilter(value) {
  const filter = String(value || '').trim();
  if (filter === DAY_TYPE_ALL_FILTER) return filter;
  return dayTypeFilterOptions().some(option => option.name === filter) ? filter : '';
}

function analysisDayTypeFilterLabel(value) {
  const filter = normalizeAnalysisDayTypeFilter(value);
  if (filter === DAY_TYPE_ALL_FILTER) return '完全统计';
  const meta = dayTypeFilterOptions().find(option => option.name === filter);
  return meta ? `${meta.symbol} ${meta.name}` : '常规统计';
}

function analysisV2DayTypeFilterHtml(value, onChange = 'updateAnalysisDayTypeFilter') {
  const selected = normalizeAnalysisDayTypeFilter(value);
  return `<label class="analysis-v2-day-type-filter"><span>日期类型筛选</span><select onchange="${onChange}(this.value)"><option value="" ${selected ? '' : 'selected'}>常规统计（排除不评分日期）</option><option value="${DAY_TYPE_ALL_FILTER}" ${selected === DAY_TYPE_ALL_FILTER ? 'selected' : ''}>完全统计（包含全部日期）</option>${dayTypeFilterOptions().map(option => `<option value="${escHtmlApp(option.name)}" ${selected === option.name ? 'selected' : ''}>${option.symbol} ${escHtmlApp(option.name)}${option.historical ? ' · 历史类型' : ''}</option>`).join('')}</select></label>`;
}

function analysisActiveCard() {
  return analysisCardById(state.analysis.activeCardId);
}

function applyAnalysisCardCollection(collection, preserveDraft = false) {
  const analysis = state.analysis;
  const supportsCards = Array.isArray(collection?.cards);
  analysis.cardStorageSupported = supportsCards;
  analysis.trackingCardStorageSupported = supportsCards && Array.isArray(collection?.trackingCards);
  if (!supportsCards) {
    const legacyConfig = analysisCloneConfig(collection);
    analysis.cards = [{ id: 'legacy-standard', name: '未命名标准', config: legacyConfig }];
    analysis.trackingCards = [];
    analysis.activeCardId = 'legacy-standard';
    if (!preserveDraft) analysis.config = legacyConfig;
    analysis.cardName = '未命名标准';
    return false;
  }
  analysis.cards = collection.cards;
  analysis.trackingCards = Array.isArray(collection.trackingCards) ? collection.trackingCards : [];
  const requestedId = String(collection?.activeCardId || '');
  const active = analysis.cards.find(card => card.id === requestedId) || analysis.cards[0] || null;
  analysis.activeCardId = active?.id || '';
  if (!preserveDraft) analysis.config = active ? analysisCloneConfig(active.config) : analysisFallbackConfig();
  analysis.cardName = active?.name || '';
  return true;
}

function selectAnalysisCard(cardId) {
  const card = analysisCardById(cardId);
  if (!card) return;
  const analysis = state.analysis;
  analysis.activeCardId = card.id;
  analysis.config = analysisCloneConfig(card.config);
  analysis.cardName = card.name;
  analysis.cardSaveOpen = true;
  analysis.result = null;
  analysisMessage(`已打开标准卡片“${card.name}”，可以保存更新或另存为新卡片`, 'ready');
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function createAnalysisCard() {
  const analysis = state.analysis;
  if (analysis.cardStorageSupported === false) {
    analysisMessage('当前后台尚未支持标准卡片。请重启后端后再新建或保存，以免覆盖现有标准。', 'error');
    return;
  }
  analysis.activeCardId = '';
  clearActiveAnalysisTracking();
  analysis.config = analysisFallbackConfig();
  analysis.cardName = '';
  analysis.cardSaveOpen = true;
  analysis.result = null;
  analysisMessage('新建标准卡片：填写标准后，为它命名并保存', 'ready');
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function analysisFiniteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function analysisAverageFromRange(value, days) {
  const total = analysisFiniteNonnegative(value);
  return total == null || !Number.isFinite(days) || days <= 0 ? null : total / days;
}

function analysisRangeBenchmarkConfig(result) {
  const metrics = result?.metrics || {};
  const dataQuality = result?.dataQuality || {};
  const days = Number(result?.dayCount) || 0;
  if (days <= 0) return null;

  const config = analysisFallbackConfig();
  const standard = config.standardDay;
  standard.awakeMinutes = analysisAverageFromRange(metrics.awakeMinutes, Number(dataQuality.awakeRecordedDays) || 0);
  standard.totalClockMinutes = analysisAverageFromRange(metrics.totalClockMinutes, days);
  standard.nominalMinutes = analysisAverageFromRange(metrics.nominalMinutes, days);
  standard.actualMinutes = analysisAverageFromRange(metrics.actualMinutes, days);
  standard.restMinutes = analysisAverageFromRange(metrics.restMinutes, days);
  standard.unavailableMinutes = analysisAverageFromRange(metrics.unavailableMinutes, days);
  standard.taskMinutes = analysisAverageFromRange(metrics.taskMinutes, days);

  standard.specialStudyClockMinutes = analysisAverageFromRange(metrics.specialStudyClockMinutes, days);
  standard.specialStudyActualMinutes = analysisAverageFromRange(metrics.specialStudyActualMinutes, days);

  const rows = Object.values(metrics.templateMetrics || {});
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const template = analysisTemplateForStandard(row);
    if (!template) continue;
    const caps = analysisTemplateCapabilities(template);
    const taskStandard = {
      templateId: template.id,
      activityType: template.activityType || row.activityType || '',
      chapterMinutesPerUnit: caps.named ? analysisFiniteNonnegative(row.chapterMinutesPerCompleted) : null,
      chapterScorePerUnit: caps.chapterScore ? analysisFiniteNonnegative(row.chapterScorePerCompleted) : null,
      chapterMaxScore: caps.chapterScore ? analysisFiniteNonnegative(template.chapterMaxScore) : null,
      quantityPerMinute: caps.quantity ? analysisFiniteNonnegative(row.quantityPerMinute) : null,
      pureTimeMaxRatio: caps.pureTime ? analysisFiniteNonnegative(row.pureTimeShareOfTotal) : null,
      accuracy: caps.accuracy ? analysisFiniteNonnegative(row.accuracy) : null,
      scoreRate: caps.score ? analysisFiniteNonnegative(row.scoreRate) : null,
      enabled: true,
    };
    if ([
      taskStandard.chapterMinutesPerUnit,
      taskStandard.chapterScorePerUnit,
      taskStandard.quantityPerMinute,
      taskStandard.pureTimeMaxRatio,
      taskStandard.accuracy,
      taskStandard.scoreRate,
    ].some(value => typeof value === 'number')) config.taskStandards.push(taskStandard);
  }
  return config;
}

async function createAnalysisCardFromRange() {
  const analysis = state.analysis;
  if (analysis.createLoading) return;
  analysis.createLoading = true;
  analysisMessage('正在读取创建区间并生成标准草稿…', 'loading');
  renderAnalysis();
  try {
    const result = await fetchAnalysisCreateRangeResult();
    const config = analysisRangeBenchmarkConfig(result) || analysisFallbackConfig();
    analysis.activeCardId = '';
    analysis.config = config;
    analysis.cardName = `区间标准 ${analysis.createStartDate} 至 ${analysis.createEndDate}`;
    analysis.cardSaveOpen = true;
    analysis.result = null;
    analysisMessage(
      Number(result?.dayCount) > 0
        ? '已按独立创建区间生成标准草稿；可调整后命名保存。'
        : '创建区间没有可用记录，已生成空白标准草稿。',
      Number(result?.dayCount) > 0 ? 'success' : 'pending',
    );
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`创建标准失败：${error.message}`, 'error');
  } finally {
    analysis.createLoading = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

async function fetchAnalysisCreateRangeResult() {
  const analysis = state.analysis;
  ensureAnalysisCreateRange();
  if (!analysis.createStartDate || !analysis.createEndDate || analysis.createStartDate > analysis.createEndDate) {
    throw new Error('请选择有效的创建区间起止日期');
  }
  const dayTypeFilter = normalizeAnalysisDayTypeFilter(analysis.createDayTypeFilter);
  return apiFetch('/api/analysis/evaluate', {
    method: 'POST',
    body: JSON.stringify({
      startDate: analysis.createStartDate,
      endDate: analysis.createEndDate,
      includeExcluded: dayTypeFilter === DAY_TYPE_ALL_FILTER || Boolean(dayTypeFilter),
      dayTypeFilter,
      config: analysis.config || analysisFallbackConfig(),
    }),
  });
}

function analysisStandardDraftValue(result, key) {
  const metrics = result?.metrics || {};
  const dataQuality = result?.dataQuality || {};
  const days = key === 'awakeMinutes'
    ? Number(dataQuality.awakeRecordedDays) || 0
    : Number(result?.dayCount) || 0;
  return analysisAverageFromRange(metrics[key], days);
}

async function generateAnalysisStandardField(key) {
  const analysis = state.analysis;
  if (!analysis.config || analysis.createLoading) return;
  const field = ANALYSIS_STANDARD_FIELDS.find(([fieldKey]) => fieldKey === key);
  if (!field) return;
  const [, label] = field;
  analysis.createLoading = true;
  analysisMessage(`正在为“${label}”生成草稿…`, 'loading');
  renderAnalysis();
  try {
    const result = await fetchAnalysisCreateRangeResult();
    const value = analysisStandardDraftValue(result, key);
    updateAnalysisStandard(key, value == null ? '' : value);
    analysisMessage(
      value == null
        ? `创建区间没有可用于“${label}”的记录，已清空该标准草稿。`
        : `已按创建区间生成“${label}”草稿。`,
      value == null ? 'pending' : 'success',
    );
  } catch (error) {
    analysisMessage(`生成“${label}”草稿失败：${error.message}`, 'error');
  } finally {
    analysis.createLoading = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

function analysisTemplateMetricsForStandard(result, standard) {
  const rows = Object.values(result?.metrics?.templateMetrics || {});
  return rows.find(row => row && (
    (standard.templateId && row.templateId === standard.templateId)
    || (!standard.templateId && standard.activityType && row.activityType === standard.activityType)
  )) || null;
}

async function generateAnalysisTaskStandard(index) {
  const analysis = state.analysis;
  const standard = analysis.config?.taskStandards?.[index];
  if (!standard || analysis.createLoading) return;
  const template = analysisTemplateForStandard(standard);
  const capabilities = analysisTemplateCapabilities(template);
  const label = analysisTemplateName(standard);
  analysis.createLoading = true;
  analysisMessage(`正在为“${label}”生成草稿…`, 'loading');
  renderAnalysis();
  try {
    const result = await fetchAnalysisCreateRangeResult();
    const metrics = analysisTemplateMetricsForStandard(result, standard);
    const values = {
      chapterMinutesPerUnit: capabilities.named ? analysisFiniteNonnegative(metrics?.chapterMinutesPerCompleted) : null,
      chapterScorePerUnit: capabilities.chapterScore ? analysisFiniteNonnegative(metrics?.chapterScorePerCompleted) : null,
      quantityPerMinute: capabilities.quantity ? analysisFiniteNonnegative(metrics?.quantityPerMinute) : null,
      pureTimeMaxRatio: capabilities.pureTime ? analysisFiniteNonnegative(metrics?.pureTimeShareOfTotal) : null,
      accuracy: capabilities.accuracy ? analysisFiniteNonnegative(metrics?.accuracy) : null,
      scoreRate: capabilities.score ? analysisFiniteNonnegative(metrics?.scoreRate) : null,
    };
    const generated = Object.entries(values).filter(([key]) => {
      if (key === 'chapterMinutesPerUnit') return capabilities.named;
      if (key === 'chapterScorePerUnit') return capabilities.chapterScore;
      if (key === 'quantityPerMinute') return capabilities.quantity;
      if (key === 'pureTimeMaxRatio') return capabilities.pureTime;
      if (key === 'scoreRate') return capabilities.score;
      return capabilities.accuracy;
    });
    generated.forEach(([key, value]) => {
      standard[key] = value;
    });
    analysisMarkChanged();
    const hasValue = generated.some(([, value]) => value != null);
    analysisMessage(
      hasValue
        ? `已按创建区间生成“${label}”草稿。`
        : `创建区间没有可用于“${label}”的记录，已清空该模板草稿。`,
      hasValue ? 'success' : 'pending',
    );
  } catch (error) {
    analysisMessage(`生成“${label}”草稿失败：${error.message}`, 'error');
  } finally {
    analysis.createLoading = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

function updateAnalysisCardName(value) {
  state.analysis.cardName = String(value || '').slice(0, 60);
  saveAnalysisDraftSnapshot();
}

function openAnalysisCardSave() {
  const analysis = state.analysis;
  if (analysis.cardStorageSupported === false) {
    analysisMessage('当前后台仍是旧版本，无法安全保存标准卡片。请重启后端后重试。', 'error');
    return;
  }
  const active = analysisActiveCard();
  analysis.cardName = active?.name || analysis.cardName || '';
  analysis.cardSaveOpen = true;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function cancelAnalysisCardSave() {
  state.analysis.cardSaveOpen = false;
  const active = analysisActiveCard();
  state.analysis.cardName = active?.name || '';
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

async function persistAnalysisCard(saveAsNew) {
  const analysis = state.analysis;
  if (analysis.cardStorageSupported === false) {
    analysisMessage('当前后台仍是旧版本。为保护现有标准，未发送保存请求；请重启后端后重试。', 'error');
    return;
  }
  const name = String(analysis.cardName || '').trim();
  if (!name) {
    analysisMessage('请先填写标准卡片名称', 'error');
    return;
  }
  if (saveAsNew && analysis.cards.some(card => String(card.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    analysisMessage(`无法另存为新卡片：名称“${name}”已存在，请使用其他名称。`, 'error');
    return;
  }
  if (analysis.savingCard) return;

  const activeIndex = analysis.cards.findIndex(card => card.id === analysis.activeCardId);
  const shouldCreate = saveAsNew || activeIndex < 0;
  const cardId = shouldCreate ? `analysis-${uid()}` : analysis.activeCardId;
  const card = { id: cardId, name, config: analysisCloneConfig(analysis.config) };
  const cards = analysis.cards.map(item => ({ ...item, config: analysisCloneConfig(item.config) }));
  if (shouldCreate) cards.push(card);
  else cards.splice(activeIndex, 1, card);

  analysis.savingCard = true;
  analysisMessage('正在保存标准卡片…', 'loading');
  renderAnalysis();
  try {
    const response = await apiFetch('/api/analysis/config', {
      method: 'PUT',
      body: JSON.stringify({ activeCardId: cardId, cards, trackingCards: analysis.trackingCards }),
    });
    if (!applyAnalysisCardCollection(response.collection)) {
      throw new Error('后台未返回卡片集合；请重启后端后重试');
    }
    analysis.cardSaveOpen = false;
    analysisMessage(`标准卡片“${name}”已保存`, 'success');
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`保存失败：${error.message}`, 'error');
  } finally {
    analysis.savingCard = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

async function deleteAnalysisCard(cardId = state.analysis.activeCardId) {
  const analysis = state.analysis;
  if (analysis.cardStorageSupported === false) {
    analysisMessage('当前后台仍是旧版本。为保护现有标准，未发送删除请求；请重启后端后重试。', 'error');
    return;
  }
  const card = analysisCardById(cardId);
  if (!card || analysis.savingCard) return;
  if (!confirm(`删除标准卡片“${card.name}”？该操作不会影响任何学习记录。`)) return;
  const wasActive = card.id === analysis.activeCardId;
  const cards = analysis.cards.filter(item => item.id !== card.id);
  const activeCardId = wasActive ? (cards[0]?.id || '') : analysis.activeCardId;
  analysis.savingCard = true;
  analysisMessage('正在删除标准卡片…', 'loading');
  renderAnalysis();
  try {
    const response = await apiFetch('/api/analysis/config', {
      method: 'PUT',
      body: JSON.stringify({ activeCardId, cards, trackingCards: analysis.trackingCards }),
    });
    if (!applyAnalysisCardCollection(response.collection)) {
      throw new Error('后台未返回卡片集合；请重启后端后重试');
    }
    analysis.cardSaveOpen = false;
    if (wasActive) analysis.result = null;
    analysisMessage('标准卡片已删除', 'success');
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`删除失败：${error.message}`, 'error');
  } finally {
    analysis.savingCard = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

function openAnalysisTrackingCardSave() {
  const analysis = state.analysis;
  if (!analysis.startDate || !analysis.endDate || analysis.startDate > analysis.endDate) {
    analysisMessage('请先选择有效的分析区间，再创建追踪卡片。', 'error');
    return;
  }
  if (analysis.trackingCardStorageSupported === false) {
    analysisMessage('当前后台尚未支持区间追踪卡片。请重启后端服务后重试。', 'error');
    return;
  }
  const active = analysisTrackingCardById(analysis.activeTrackingCardId);
  analysis.trackingCardName = active?.name || `区间追踪 ${analysis.startDate} 至 ${analysis.endDate}`;
  analysis.trackingCardSaveOpen = false;
  return persistAnalysisTrackingCard(false);
}

function updateAnalysisTrackingCardName(value) {
  state.analysis.trackingCardName = String(value || '').slice(0, 60);
  saveAnalysisDraftSnapshot();
}

function cancelAnalysisTrackingCardSave() {
  const analysis = state.analysis;
  analysis.trackingCardSaveOpen = false;
  const active = analysisTrackingCardById(analysis.activeTrackingCardId);
  analysis.trackingCardName = active?.name || '';
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

async function persistAnalysisTrackingCard(saveAsNew = false) {
  const analysis = state.analysis;
  const name = String(analysis.trackingCardName || '').trim();
  if (!name) {
    analysisMessage('请先填写追踪卡片名称。', 'error');
    return;
  }
  if (!analysis.startDate || !analysis.endDate || analysis.startDate > analysis.endDate) {
    analysisMessage('追踪卡片的开始日期不能晚于结束日期。', 'error');
    return;
  }
  if (analysis.savingTrackingCard) return;
  const activeIndex = analysis.trackingCards.findIndex(card => card.id === analysis.activeTrackingCardId);
  const shouldCreate = saveAsNew || activeIndex < 0;
  const cardId = shouldCreate ? `analysis-track-${uid()}` : analysis.activeTrackingCardId;
  const existing = activeIndex >= 0 ? analysis.trackingCards[activeIndex] : null;
  const planEndDate = analysis.activeTrackingPlanEndDate || analysis.endDate;
  const card = {
    id: cardId,
    name,
    startDate: analysis.startDate,
    endDate: planEndDate,
    includeExcluded: analysis.includeExcluded === true,
    dayTypeFilter: normalizeAnalysisDayTypeFilter(analysis.dayTypeFilter),
    config: analysisCloneConfig(analysis.config),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const trackingCards = analysis.trackingCards.map(item => ({ ...item, config: analysisCloneConfig(item.config) }));
  if (shouldCreate) trackingCards.push(card);
  else trackingCards.splice(activeIndex, 1, card);
  analysis.savingTrackingCard = true;
  analysisMessage('正在保存区间追踪卡片…', 'loading');
  renderAnalysis();
  try {
    const response = await apiFetch('/api/analysis/config', {
      method: 'PUT',
      body: JSON.stringify({ activeCardId: analysis.activeCardId || '', cards: analysis.cards, trackingCards }),
    });
    if (!Array.isArray(response.collection?.trackingCards)) {
      throw new Error('后台未返回追踪卡片集合；请重启后端后重试');
    }
    applyAnalysisCardCollection(response.collection, true);
    analysis.activeTrackingCardId = cardId;
    analysis.activeTrackingPlanEndDate = card.endDate;
    analysis.trackingCardSaveOpen = false;
    analysis.trackingCardName = name;
    analysisMessage(`追踪卡片“${name}”已保存。打开卡片即可更新每日进度。`, 'success');
    analysis.focusSavedRanges = true;
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`追踪卡片保存失败：${error.message}`, 'error');
  } finally {
    analysis.savingTrackingCard = false;
    if (state.tab === 'analysis') {
      renderAnalysis();
      if (analysis.focusSavedRanges) {
        analysis.focusSavedRanges = false;
        requestAnimationFrame(() => document.getElementById('analysis-tracking-library')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    }
  }
}

async function openAnalysisTrackingCard(cardId) {
  const card = analysisTrackingCardById(cardId);
  if (!card) return;
  const analysis = state.analysis;
  analysis.activeTrackingCardId = card.id;
  analysis.activeTrackingPlanEndDate = card.endDate;
  analysis.startDate = card.startDate;
  analysis.endDate = analysisTrackingEffectiveEnd(card);
  analysis.includeExcluded = card.includeExcluded === true;
  analysis.trackingCardName = card.name;
  analysis.dayTypeFilter = normalizeAnalysisDayTypeFilter(card.dayTypeFilter)
    || (card.includeExcluded === true ? DAY_TYPE_ALL_FILTER : '');
  analysis.includeExcluded = analysis.dayTypeFilter === DAY_TYPE_ALL_FILTER || Boolean(analysis.dayTypeFilter) || card.includeExcluded === true;
  analysis.trackingCardSaveOpen = false;
  analysis.result = null;
  analysisMessage(`正在更新追踪卡片“${card.name}”的当前进度…`, 'loading');
  saveAnalysisDraftSnapshot();
  renderAnalysis();
  if (card.startDate > getTodayStr()) {
    analysis.endDate = card.startDate;
    analysisMessage(`追踪卡片“${card.name}”计划于 ${formatDisplay(card.startDate)} 开始。`, 'pending');
    saveAnalysisDraftSnapshot();
    renderAnalysis();
    return;
  }
  await evaluateAnalysisRange();
}

async function deleteAnalysisTrackingCard(cardId) {
  const analysis = state.analysis;
  const card = analysisTrackingCardById(cardId);
  if (!card || analysis.savingTrackingCard) return;
  if (!confirm(`删除追踪卡片“${card.name}”？不会删除任何学习记录。`)) return;
  const trackingCards = analysis.trackingCards.filter(item => item.id !== card.id);
  analysis.savingTrackingCard = true;
  analysisMessage('正在删除追踪卡片…', 'loading');
  renderAnalysis();
  try {
    const response = await apiFetch('/api/analysis/config', {
      method: 'PUT',
      body: JSON.stringify({ activeCardId: analysis.activeCardId || '', cards: analysis.cards, trackingCards }),
    });
    if (!Array.isArray(response.collection?.trackingCards)) {
      throw new Error('后台未返回追踪卡片集合；请重启后端后重试');
    }
    applyAnalysisCardCollection(response.collection, true);
    if (analysis.activeTrackingCardId === card.id) {
      clearActiveAnalysisTracking();
      analysis.result = null;
    }
    analysisMessage('追踪卡片已删除。', 'success');
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`追踪卡片删除失败：${error.message}`, 'error');
  } finally {
    analysis.savingTrackingCard = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

function ensureAnalysisRange() {
  const analysis = state.analysis;
  if (analysis.startDate && analysis.endDate) return;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(state.selectedDate || '') ? state.selectedDate : getTodayStr();
  analysis.endDate = end;
  analysis.startDate = dateToStr(new Date(strToDate(end).getFullYear(), strToDate(end).getMonth(), strToDate(end).getDate() - 6));
}

function ensureAnalysisCreateRange() {
  const analysis = state.analysis;
  if (analysis.createStartDate && analysis.createEndDate) return;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(state.selectedDate || '') ? state.selectedDate : getTodayStr();
  analysis.createEndDate = end;
  analysis.createStartDate = dateToStr(new Date(strToDate(end).getFullYear(), strToDate(end).getMonth(), strToDate(end).getDate() - 6));
}

function analysisNumber(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function analysisFormatMinutes(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : fmtMin(Number(value), true);
}

function analysisFormatPercent(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(digits)}%`;
}

function analysisDateLabel(start, end) {
  if (!start || !end) return '请选择日期范围';
  return start === end ? formatDisplay(start) : `${formatShort(start)} 至 ${formatShort(end)}`;
}

function analysisMessage(text = '', kind = '') {
  state.analysis.message = text ? { text, kind } : '';
  const host = document.getElementById('analysis-status');
  if (!host) return;
  host.className = `analysis-status ${kind}`;
  host.textContent = text;
}

let _analysisSnapshotTimer = null;
function saveAnalysisDraftSnapshot() {
  const snapshot = buildServerSnapshot();
  saveLocalSnapshotCache(snapshot);
  state._serverSnapshot = snapshot;
  if (Number(SETTINGS.snapshotInterval) === 0) return;
  if (_analysisSnapshotTimer) clearTimeout(_analysisSnapshotTimer);
  _analysisSnapshotTimer = setTimeout(() => {
    _analysisSnapshotTimer = null;
    saveServerSnapshot();
  }, 400);
}

function analysisMarkChanged() {
  analysisMessage('标准已修改，已自动保存为快照；点击“开始分析”重新计算', 'pending');
  saveAnalysisDraftSnapshot();
}

function updateAnalysisRange(key, value) {
  clearActiveAnalysisTracking();
  state.analysis[key] = value;
  state.analysis.result = null;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function setAnalysisPreset(preset) {
  const end = getTodayStr();
  let start = end;
  if (preset === '7d') start = dateToStr(new Date(strToDate(end).getFullYear(), strToDate(end).getMonth(), strToDate(end).getDate() - 6));
  if (preset === '30d') start = dateToStr(new Date(strToDate(end).getFullYear(), strToDate(end).getMonth(), strToDate(end).getDate() - 29));
  if (preset === 'month') start = dateToStr(new Date(strToDate(end).getFullYear(), strToDate(end).getMonth(), 1));
  state.analysis.startDate = start;
  state.analysis.endDate = end;
  clearActiveAnalysisTracking();
  state.analysis.result = null;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function updateAnalysisOption(key, value) {
  clearActiveAnalysisTracking();
  state.analysis[key] = value;
  state.analysis.result = null;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function updateAnalysisDayTypeFilter(value) {
  const analysis = state.analysis;
  const normalized = normalizeAnalysisDayTypeFilter(value);
  clearActiveAnalysisTracking();
  analysis.dayTypeFilter = normalized;
  analysis.includeExcluded = normalized === DAY_TYPE_ALL_FILTER || Boolean(normalized);
  analysis.result = null;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function updateAnalysisCreateRange(key, value) {
  state.analysis[key] = value;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function updateAnalysisCreateOption(key, value) {
  state.analysis[key] = value;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function updateAnalysisCreateDayTypeFilter(value) {
  state.analysis.createDayTypeFilter = normalizeAnalysisDayTypeFilter(value);
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function analysisStandardBounds(standard, key) {
  const value = field => analysisFiniteNonnegative(standard[field]);
  const awake = value('awakeMinutes');
  const clock = value('totalClockMinutes');
  const nominal = value('nominalMinutes');
  const actual = value('actualMinutes');
  const rest = value('restMinutes');
  const unavailable = value('unavailableMinutes');
  const specialClock = value('specialStudyClockMinutes');
  const specialActual = value('specialStudyActualMinutes');
  const task = value('taskMinutes');
  const bounds = { min: 0, max: null };

  if (key === 'awakeMinutes' && clock != null && unavailable != null && specialClock != null) {
    bounds.min = clock + unavailable + specialClock;
  } else if (key === 'totalClockMinutes') {
    if (nominal != null && rest != null) bounds.min = nominal + rest;
    if (awake != null && unavailable != null && specialClock != null) bounds.max = Math.max(0, awake - unavailable - specialClock);
  } else if (key === 'nominalMinutes') {
    if (actual != null) bounds.min = actual;
    if (clock != null && rest != null) bounds.max = Math.max(0, clock - rest);
  } else if (key === 'actualMinutes') {
    if (nominal != null) bounds.max = nominal;
    if (task != null && specialActual != null) bounds.min = Math.max(0, task - specialActual);
  } else if (key === 'restMinutes') {
    if (clock != null && nominal != null) bounds.max = Math.max(0, clock - nominal);
  } else if (key === 'unavailableMinutes') {
    if (awake != null && clock != null && specialClock != null) bounds.max = Math.max(0, awake - clock - specialClock);
  } else if (key === 'specialStudyClockMinutes') {
    if (specialActual != null) bounds.min = specialActual;
    if (awake != null && clock != null && unavailable != null) bounds.max = Math.max(0, awake - clock - unavailable);
  } else if (key === 'specialStudyActualMinutes') {
    if (specialClock != null) bounds.max = specialClock;
    if (task != null && actual != null) bounds.min = Math.max(0, task - actual);
  } else if (key === 'taskMinutes' && actual != null && specialActual != null) {
    bounds.max = actual + specialActual;
  }

  return bounds;
}

function analysisStandardInputOptions(standard, key) {
  const bounds = analysisStandardBounds(standard, key);
  const options = [`min="${bounds.min}"`, 'step="1"'];
  if (bounds.max != null) options.push(`max="${bounds.max}"`);
  return options.join(' ');
}

function updateAnalysisStandard(key, value, input = null) {
  if (!state.analysis.config) return;
  const standard = state.analysis.config.standardDay;
  const rawValue = analysisNumber(value);
  let nextValue = rawValue;
  const bounds = analysisStandardBounds(standard, key);
  if (nextValue != null) {
    if (bounds.max != null && nextValue > bounds.max) nextValue = bounds.max;
    if (nextValue < bounds.min) nextValue = bounds.min;
  }
  standard[key] = nextValue;
  if (input && nextValue !== rawValue) input.value = nextValue == null ? '' : String(nextValue);
  analysisMarkChanged();
}

function updateAnalysisTaskStandard(index, key, value) {
  const standard = state.analysis.config?.taskStandards?.[index];
  if (!standard) return;
  standard[key] = key === 'enabled'
    ? Boolean(value)
    : key === 'quantityPerMinute'
      ? storedQuestionEfficiencyValue(value)
      : analysisNumber(value);
  analysisMarkChanged();
}

function analysisTemplateForStandard(standard) {
  return getTaskTemplates().find(template => template.id === standard.templateId)
    || getTaskTemplates().find(template => template.activityType === standard.activityType)
    || null;
}

function analysisTemplateName(standard) {
  const template = analysisTemplateForStandard(standard);
  return template?.activityType || standard.activityType || standard.templateId || '未命名任务模板';
}

function analysisTemplateCapabilities(template) {
  const named = Boolean(template && (template.namedItemEnabled || template.ordinalEnabled)) && !templateUsesChapterQuestionCounts(template);
  const quantity = Boolean(template && template.quantityEnabled);
  const accuracy = Boolean(template && template.quantityEnabled && template.accuracyEnabled);
  const score = Boolean(template && template.scoreEnabled && Number(template.scoreMax) > 0);
  const chapterScore = Boolean(template && named && !quantity && template.chapterScoringEnabled && Number(template.chapterMaxScore) > 0);
  return { named, quantity, accuracy, score, chapterScore, pureTime: !named && !quantity };
}

function addAnalysisTaskStandard() {
  const selector = document.getElementById('analysis-task-template-select');
  const templateId = selector?.value || '';
  const template = getTaskTemplates().find(item => item.id === templateId);
  if (!template || !state.analysis.config) {
    analysisMessage('请先从模板库选择一个任务模板', 'error');
    return;
  }
  const exists = state.analysis.config.taskStandards.some(item => item.templateId === template.id);
  if (exists) {
    analysisMessage('该任务模板已在分析标准中', 'pending');
    return;
  }
  const capabilities = analysisTemplateCapabilities(template);
  state.analysis.config.taskStandards.push({
    templateId: template.id,
    activityType: template.activityType || '',
    chapterMinutesPerUnit: null,
    chapterScorePerUnit: null,
    chapterMaxScore: capabilities.chapterScore ? Number(template.chapterMaxScore) : null,
    quantityPerMinute: null,
    pureTimeMaxRatio: null,
    accuracy: null,
    scoreRate: null,
    enabled: true,
  });
  analysisMarkChanged();
  renderAnalysis();
}

function removeAnalysisTaskStandard(index) {
  if (!state.analysis.config?.taskStandards?.[index]) return;
  state.analysis.config.taskStandards.splice(index, 1);
  analysisMarkChanged();
  renderAnalysis();
}

async function loadAnalysisConfig() {
  if (state.analysis.loading) return;
  state.analysis.loading = true;
  renderAnalysis();
  try {
    const supportsCards = applyAnalysisCardCollection(await apiFetch('/api/analysis/config'));
    const restoredDraft = restoreAnalysisSnapshotDraft(state.analysis.snapshotDraft);
    ensureAnalysisRange();
    analysisMessage(
      restoredDraft
        ? '已恢复上次未保存的分析标准快照'
        : supportsCards
        ? (state.analysis.cards.length ? '已载入保存的标准卡片' : '新建一张标准卡片后即可跨设备复用')
        : '后台尚未更新到卡片版本。请重启后端；在此之前已禁止保存，避免覆盖标准。',
      restoredDraft || supportsCards ? 'ready' : 'error',
    );
  } catch (error) {
    state.analysis.config = analysisFallbackConfig();
    const restoredDraft = restoreAnalysisSnapshotDraft(state.analysis.snapshotDraft);
    analysisMessage(restoredDraft ? '已恢复上次未保存的分析标准快照；保存卡片前请确认后台连接。' : `无法读取已保存标准：${error.message}`, restoredDraft ? 'pending' : 'error');
  } finally {
    state.analysis.loading = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

async function evaluateAnalysisRange() {
  const analysis = state.analysis;
  analysis.dayTypeFilter = normalizeAnalysisDayTypeFilter(analysis.dayTypeFilter)
    || (analysis.includeExcluded ? DAY_TYPE_ALL_FILTER : '');
  analysis.includeExcluded = analysis.dayTypeFilter === DAY_TYPE_ALL_FILTER || Boolean(analysis.dayTypeFilter);
  if (!analysis.config || !analysis.startDate || !analysis.endDate || analysis.startDate > analysis.endDate) {
    analysisMessage('请选择有效的起止日期', 'error');
    return;
  }
  analysis.loading = true;
  analysis.result = null;
  analysisMessage('正在汇总时段、任务和评分因子…', 'loading');
  renderAnalysis();
  try {
    const result = await apiFetch('/api/analysis/evaluate', {
      method: 'POST',
      body: JSON.stringify({
        startDate: analysis.startDate,
        endDate: analysis.endDate,
        includeExcluded: analysis.includeExcluded,
        dayTypeFilter: analysis.dayTypeFilter,
        config: analysis.config,
      }),
    });
    analysis.result = result;
    analysis.config = result.config;
    analysisMessage(result.score.score == null ? '尚无足够标准形成评分，请补充标准日或任务效率标准' : '分析结果已更新', result.score.score == null ? 'pending' : 'success');
    saveAnalysisDraftSnapshot();
  } catch (error) {
    analysisMessage(`分析失败：${error.message}`, 'error');
  } finally {
    analysis.loading = false;
    if (state.tab === 'analysis') renderAnalysis();
  }
}

function analysisMetricCardHtml(label, value, sub = '', tone = '') {
  return `<div class="analysis-metric ${tone}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
}

function analysisRatioPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
}

function analysisFactorDisplay(factor, value) {
  if (factor.key === 'evidenceCoverage' && value && typeof value === 'object') {
    if (value.available === false) return '未配置可评分的工作量目标';
    if (value.available == null && value.coverage != null) return `完整覆盖 ${analysisRatioPercent(value.coverage)}`;
    if (value.coefficient == null) return `目标覆盖 ${analysisRatioPercent(value.coverage)}`;
    return `覆盖 ${analysisRatioPercent(value.coverage)} · 系数 ${analysisRatioPercent(value.coefficient)}`;
  }
  if (factor.key === 'stability' && value && typeof value === 'object') {
    if (value.penalty != null) return `${value.metricCount || 0} 项序列 · CV ${analysisRatioPercent(value.cv)} · 相邻变化 ${analysisRatioPercent(value.meanAdjacentJump)}`;
    return `CV 容忍 ${analysisRatioPercent(value.cvTolerance)} · 跳变容忍 ${analysisRatioPercent(value.jumpTolerance)}`;
  }
  if (factor.key === 'specialStudy' && value && typeof value === 'object') {
    return `时钟 ${analysisFormatMinutes(value.clockMinutes)} · 实际 ${analysisFormatMinutes(value.actualMinutes)}`;
  }
  if (factor.key.endsWith(':chapterScore') && value && typeof value === 'object') {
    const score = value.scorePerChapter == null ? '—' : Number(value.scorePerChapter).toFixed(1);
    const max = value.maxScore == null ? '未设满分' : `满分 ${Number(value.maxScore).toFixed(1)}`;
    return `${score} 分/章节 · ${max}`;
  }
  if (value && typeof value === 'object') return `时钟 ${analysisFormatMinutes(value.clock)} · 实际 ${analysisFormatMinutes(value.actual)}`;
  if (factor.key === 'focusEfficiency' || factor.key.endsWith(':accuracy') || factor.key.endsWith(':pureTime')) return analysisFormatPercent(value);
  if (factor.key.endsWith(':chapter')) return `${analysisFormatMinutes(value)}/单位`;
  if (factor.key.endsWith(':quantity')) return formatQuestionEfficiency(value, '题', 2);
  return analysisFormatMinutes(value);
}

function analysisV2StabilitySummaryHtml(stability) {
  if (!stability) return '';
  if (!stability.available) {
    return `<div class="analysis-v2-stability-summary unavailable"><div><span>综合平稳度</span><b>样本不足</b></div><small>至少 ${stability.minimumComparableDays || 3} 个可比较日期后才计入总分。</small></div>`;
  }
  return `<div class="analysis-v2-stability-summary"><div><span>综合平稳度</span><b>${analysisRatioPercent(stability.penalty)}</b></div><small>CV ${analysisRatioPercent(stability.cv)} · 相邻变化 ${analysisRatioPercent(stability.meanAdjacentJump)} · ${stability.metricCount || 0} 项序列</small></div>`;
}

function analysisScoreValue(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1)} 分`;
}

function analysisScoreTrendDates(result, timeline = []) {
  const fullDates = Array.isArray(result?.dates) && result.dates.length
    ? result.dates
    : timeline.map(item => item.date);
  const filter = typeof result?.dayTypeFilter === 'string'
    ? result.dayTypeFilter
    : (state.analysis?.dayTypeFilter || '');
  if (filter === DAY_TYPE_ALL_FILTER) return fullDates;
  return Array.isArray(result?.includedDates)
    ? result.includedDates
    : timeline.map(item => item.date);
}

function renderAnalysisScoreTrend(result) {
  const chartId = 'analysisScoreTrendChart';
  const timeline = Array.isArray(result?.scoreTimeline) ? result.scoreTimeline : [];
  const dates = analysisScoreTrendDates(result, timeline);
  if (!dates.length || !document.getElementById(chartId)) {
    destroyChart(chartId);
    return;
  }
  const hasServerUnrecordedDates = Array.isArray(result?.unrecordedDates);
  const unrecordedDates = new Set(hasServerUnrecordedDates
    ? result.unrecordedDates
    : dates.filter(dateStr => {
      const day = state.data?.[dateStr] || {};
      return !(Array.isArray(day.sessions) && day.sessions.length)
        && !(Array.isArray(day.tasks) && day.tasks.length)
        && !day.wakeTime
        && !day.sleepTime;
    }));
  const scoreByDate = new Map(timeline.map(item => [item.date, item]));
  const statusResolver = dateStr => unrecordedDates.has(dateStr) ? (dateStr > getTodayStr() ? 'future' : 'missing') : 'recorded';
  const labels = dates.map(formatShort);
  const isCumulative = state.analysis.scoreTrendView === 'cumulative';
  const values = dates.map(dateStr => {
    if (unrecordedDates.has(dateStr)) return null;
    const item = scoreByDate.get(dateStr);
    const value = item ? (isCumulative ? item.cumulativeScore : item.dailyScore) : null;
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  });
  const scoreLabel = isCumulative ? '累计评分' : '每日评分';
  const scoreColor = isCumulative ? '#69f0ae' : '#4fc3f7';
  mkChart(chartId, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: scoreLabel,
          data: values,
          borderColor: scoreColor,
          backgroundColor: isCumulative ? 'rgba(105, 240, 174, .12)' : 'rgba(79, 195, 247, .14)',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: isCumulative ? 2.5 : 2,
          tension: .25,
          spanGaps: false,
        },
        {
          label: '标准线 100',
          data: dates.map(dateStr => unrecordedDates.has(dateStr) ? null : 100),
          borderColor: 'rgba(255, 213, 79, .78)',
          borderDash: [6, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#7f8fb3', maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(107,122,158,.10)' } },
        y: { ticks: { color: '#7f8fb3', callback: value => `${Number(value).toFixed(0)}分` }, grid: { color: 'rgba(107,122,158,.14)' }, title: { display: true, text: '评分', color: '#7f8fb3' } },
      },
      plugins: {
        legend: { labels: { color: '#c8d4f0', usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: context => context.raw == null ? null : `${context.dataset.label}: ${Number(context.raw).toFixed(1)} 分` } },
      },
    },
    plugins: [noRecordRegionPlugin(dates, statusResolver)],
  });
}

function setAnalysisScoreTrendView(view) {
  if (!['daily', 'cumulative'].includes(view) || state.analysis.scoreTrendView === view) return;
  state.analysis.scoreTrendView = view;
  saveAnalysisDraftSnapshot();
  renderAnalysis();
}

function analysisTrackingCardsHtml() {
  const analysis = state.analysis;
  const activeId = analysis.activeTrackingCardId;
  const storageUnavailable = analysis.trackingCardStorageSupported === false;
  const cards = (analysis.trackingCards || []).map(card => {
    const effectiveEnd = analysisTrackingEffectiveEnd(card);
    const future = card.startDate > getTodayStr();
    const status = future ? '尚未开始' : (card.endDate > getTodayStr() ? '进行中' : '已完成');
    const progress = future ? `计划 ${formatShort(card.startDate)} 开始` : `已追踪至 ${formatShort(effectiveEnd)}`;
    const score = card.id === activeId && analysis.result?.score?.score != null ? ` · 当前 ${Number(analysis.result.score.score).toFixed(1)} 分` : '';
    const encodedId = encodeURIComponent(card.id).replace(/'/g, '%27');
    return `<article class="analysis-tracking-card ${card.id === activeId ? 'active' : ''}">
      <button type="button" class="analysis-tracking-card-main" onclick="openAnalysisTrackingCard(decodeURIComponent('${encodedId}'))">
        <span>${escHtmlApp(card.name)}</span><b>${escHtmlApp(analysisDateLabel(card.startDate, card.endDate))}</b><small>${status} · ${progress} · ${analysisTrackingDays(card.startDate, card.endDate)} 天计划${score}</small>
      </button>
      <button type="button" class="analysis-icon-button danger analysis-tracking-card-delete" title="删除追踪卡片" aria-label="删除追踪卡片" onclick="deleteAnalysisTrackingCard(decodeURIComponent('${encodedId}'))">×</button>
    </article>`;
  }).join('');
  const active = analysisTrackingCardById(activeId);
  const savePanel = analysis.trackingCardSaveOpen ? `<div class="analysis-card-save-panel analysis-tracking-save-panel"><label><span>追踪卡片名称</span><input type="text" maxlength="60" value="${escHtmlApp(analysis.trackingCardName)}" placeholder="例如：暑假冲刺阶段" oninput="updateAnalysisTrackingCardName(this.value)"></label><div class="analysis-card-save-actions">${active ? `<button type="button" class="btn btn-primary" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="persistAnalysisTrackingCard(false)">保存更新</button>` : ''}<button type="button" class="btn btn-ghost" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="persistAnalysisTrackingCard(true)">保存为新卡片</button><button type="button" class="btn btn-ghost btn-sm" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="cancelAnalysisTrackingCardSave()">取消</button></div></div>` : '';
  const warning = storageUnavailable ? '<div class="analysis-card-compat-warning">当前后台尚未支持区间追踪卡片。请重启后端服务后刷新页面。</div>' : '';
  return `<section class="analysis-tracking-library"><div class="analysis-tracking-library-head"><div><span>RANGE TRACKING</span><h3>区间追踪卡片</h3><p>保存日期区间和追踪信息。打开后会按当前选中的评分标准计算，计划日期不会改变。</p></div><button type="button" class="btn btn-primary btn-sm" ${storageUnavailable ? 'disabled' : ''} onclick="openAnalysisTrackingCardSave()">＋ 创建追踪卡片</button></div>${warning}${cards ? `<div class="analysis-tracking-card-list">${cards}</div>` : '<div class="analysis-empty-inline">还没有追踪卡片。先选择区间，再保存一张卡片。</div>'}${savePanel}</section>`;
}

function analysisScoreResultHtml(result) {
  if (!result) return `<section class="analysis-result-empty"><b>尚未计算</b><span>选定日期范围并填写标准后，开始生成无上限综合评分。</span></section>`;
  const { metrics = {}, score = {}, dataQuality = {}, includedDates = [], excludedDates = [], scoreTimeline = [] } = result;
  const scoreValue = score.score == null ? '—' : Number(score.score).toFixed(1);
  const factorRows = (score.factors || []).map(factor => `<tr>
    <td><b>${escHtmlApp(factor.label)}</b></td>
    <td>${analysisFactorDisplay(factor, factor.value)}</td>
    <td>${analysisFactorDisplay(factor, factor.standard)}</td>
    <td class="analysis-ratio ${factor.ratio >= 1 ? 'up' : 'down'}">${Number(factor.ratio).toFixed(3)}×</td>
  </tr>`).join('');
  const scoreByDate = new Map(scoreTimeline.map(item => [item.date, item]));
  const dailyRows = (result.daily || []).map(day => {
    const scorePoint = scoreByDate.get(day.date) || {};
    return `<tr>
    <td>${escHtmlApp(day.date)}</td>
    <td>${analysisFormatMinutes(day.actualMinutes)}</td>
    <td>${analysisFormatMinutes(day.nominalMinutes)}</td>
    <td>${analysisFormatMinutes(day.restMinutes)}</td>
    <td>${analysisFormatMinutes(day.unavailableMinutes)}</td>
    <td>${analysisFormatPercent(day.focusEfficiency)}</td>
    <td>${analysisScoreValue(scorePoint.dailyScore)}</td>
    <td>${analysisScoreValue(scorePoint.cumulativeScore)}</td>
  </tr>`;
  }).join('');
  return `<div class="analysis-results-body">
    <section class="analysis-score-board">
      <div class="analysis-score-label"><span>RANGE SCORE</span><b>区间综合评分</b><small>标准表现 = 100 · 无最高上限</small></div>
      <div class="analysis-score-number ${score.score == null ? 'empty' : score.score >= 100 ? 'up' : 'down'}">${scoreValue}<small>分</small></div>
      <div class="analysis-score-meta"><span>有效日期 <b>${includedDates.length}</b></span><span>评分因子 <b>${(score.factors || []).length}</b></span></div>
    </section>
    <div class="analysis-metric-grid">
      ${analysisMetricCardHtml('实际专注', analysisFormatMinutes(metrics.actualMinutes), '普通 + 特殊学习实际', 'actual')}
      ${analysisMetricCardHtml('名义专注', analysisFormatMinutes(metrics.nominalMinutes), '计划总量', 'nominal')}
      ${analysisMetricCardHtml('时钟时长', analysisFormatMinutes(metrics.totalClockMinutes), '所有已记录时段', 'clock')}
      ${analysisMetricCardHtml('清醒时长', analysisFormatMinutes(metrics.awakeMinutes), `${dataQuality.awakeRecordedDays || 0} 天有作息记录`, 'awake')}
      ${analysisMetricCardHtml('休息时长', analysisFormatMinutes(metrics.restMinutes), '普通专注内', 'rest')}
      ${analysisMetricCardHtml('不可用时间', analysisFormatMinutes(metrics.unavailableMinutes), '含特殊学习未专注部分', 'unavailable')}
      ${analysisMetricCardHtml('任务记录', analysisFormatMinutes(metrics.taskMinutes), `${dataQuality.taskDays || 0} 天有任务`, 'task')}
      ${analysisMetricCardHtml('专注效率', analysisFormatPercent(metrics.focusEfficiency), '实际 / 有效时钟', 'efficiency')}
    </div>
    <section class="analysis-score-trend-panel">
      <div class="analysis-panel-head"><div><span>SCORE TREND</span><h3>${state.analysis.scoreTrendView === 'cumulative' ? '累计评分' : '每日评分'}</h3><p>${state.analysis.scoreTrendView === 'cumulative' ? '从区间开始到当天的全部数据重新计算，不是每日分数相加。' : '仅按当天记录与标准日比较，查看单日表现波动。'}</p></div><div class="analysis-score-trend-actions"><div class="analysis-score-trend-tabs"><button type="button" class="${state.analysis.scoreTrendView === 'daily' ? 'active' : ''}" onclick="setAnalysisScoreTrendView('daily')">每日评分</button><button type="button" class="${state.analysis.scoreTrendView === 'cumulative' ? 'active' : ''}" onclick="setAnalysisScoreTrendView('cumulative')">累计评分</button></div><small>标准线 = 100 分</small></div></div>
      ${scoreTimeline.length ? '<div class="analysis-score-trend-stage"><canvas id="analysisScoreTrendChart"></canvas></div>' : '<div class="analysis-empty-inline">暂无可绘制的评分数据。</div>'}
    </section>
    <div class="analysis-result-lower">
      <section class="analysis-ledger-panel">
        <div class="analysis-panel-head"><div><span>SCORING FACTORS</span><h3>评分因子</h3></div><small>倍率大于 1 表示优于标准</small></div>
        ${factorRows ? `<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>因子</th><th>本次表现</th><th>标准</th><th>相对标准</th></tr></thead><tbody>${factorRows}</tbody></table></div>` : '<div class="analysis-empty-inline">尚未启用有标准值的评分因子。</div>'}
      </section>
      <aside class="analysis-quality-panel">
        <span>DATA QUALITY</span><h3>数据覆盖</h3>
        <dl><div><dt>范围日期</dt><dd>${dataQuality.rangeDays || 0} 天</dd></div><div><dt>纳入评分</dt><dd>${dataQuality.includedDays || 0} 天</dd></div><div><dt>排除日期</dt><dd>${excludedDates.length} 天</dd></div><div><dt>有时段记录</dt><dd>${dataQuality.sessionDays || 0} 天</dd></div></dl>
        ${(dataQuality.unconfiguredFactors || []).length ? `<p>尚未设置：${dataQuality.unconfiguredFactors.map(key => ANALYSIS_STANDARD_FIELDS.find(field => field[0] === key)?.[1] || key).join('、')}</p>` : '<p class="success">标准日基础数据已完整设置。</p>'}
      </aside>
    </div>
    <details class="analysis-daily-details"><summary><span><b>逐日数据账本</b><small>查看每个日期的原始汇总和评分</small></span><span>${(result.daily || []).length} 天</span></summary>
      <div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>日期</th><th>实际</th><th>名义</th><th>休息</th><th>不可用</th><th>专注效率</th><th>每日评分</th><th>累计评分</th></tr></thead><tbody>${dailyRows || '<tr><td colspan="8">没有可汇总的日期记录</td></tr>'}</tbody></table></div>
    </details>
  </div>`;
}

function analysisStandardFormHtml(config) {
  const fields = ANALYSIS_STANDARD_FIELDS.map(([key, label, unit, hint]) => {
    const rawValue = config.standardDay[key];
    const inputOptions = analysisStandardInputOptions(config.standardDay, key);
    const relationHint = ANALYSIS_STANDARD_RELATION_HINTS[key];
    const onChange = `updateAnalysisStandard('${key}',this.value,this)`;
    return `<label class="analysis-field"><span>${label}</span><input type="number" ${inputOptions} value="${rawValue ?? ''}" placeholder="未设置" oninput="${onChange}"><small>${hint} · ${unit}<br>约束：${relationHint}</small><button type="button" class="btn btn-ghost btn-sm" ${state.analysis.createLoading ? 'disabled' : ''} onclick="generateAnalysisStandardField('${key}')">生成草稿</button></label>`;
  }).join('');
  return `<section class="analysis-config-section" id="analysis-standard-section">
    <div class="analysis-section-head"><div><span>01 · STANDARD DAY</span><h3>标准日模板</h3><p>所有字段都填写“达到你认可的一天”应有的数值。该模板本身计算时恰好是 100 分。</p></div><div class="analysis-callout">实际专注不需要大于名义专注；例如名义 360 分钟、实际 300 分钟同样可以是标准日。</div></div>
    <div class="analysis-standard-grid">${fields}</div>
  </section>`;
}

function analysisCardCollectionHtml() {
  const analysis = state.analysis;
  const active = analysisActiveCard();
  const storageUnavailable = analysis.cardStorageSupported === false;
  ensureAnalysisCreateRange();
  const canGenerate = false;
  const cards = (analysis.cards || []).map(card => {
    const encodedId = encodeURIComponent(card.id).replace(/'/g, '%27');
    return `<button type="button" class="analysis-benchmark-card ${card.id === analysis.activeCardId ? 'active' : ''}" onclick="selectAnalysisCard(decodeURIComponent('${encodedId}'))"><span>${escHtmlApp(card.name)}</span><small>${(card.config?.taskStandards || []).length} 个任务效率标准</small></button>`;
  }).join('');
  const savePanel = `<div class="analysis-card-save-panel"><label><span>卡片名称</span><input type="text" maxlength="60" value="${escHtmlApp(analysis.cardName)}" placeholder="例如：工作日标准" oninput="updateAnalysisCardName(this.value)"></label><div class="analysis-card-save-actions">${active ? `<button type="button" class="btn btn-primary" ${analysis.savingCard ? 'disabled' : ''} onclick="persistAnalysisCard(false)">保存更新</button>` : ''}<button type="button" class="btn btn-ghost" ${analysis.savingCard ? 'disabled' : ''} onclick="persistAnalysisCard(true)">另存为新卡片</button></div></div>`;
  const createRangeTool = `<div class="analysis-card-create-tool"><div class="analysis-card-create-copy"><span>CREATE FROM RANGE</span><b>按独立日期区间生成标准</b><small>这里的日期不会改变上方的分析区间。系统按该区间和日期类型筛选填充一张新卡片。</small></div><div class="analysis-card-create-controls"><label><span>创建开始日期</span><input type="date" value="${analysis.createStartDate}" onchange="updateAnalysisCreateRange('createStartDate',this.value)"></label><label><span>创建结束日期</span><input type="date" value="${analysis.createEndDate}" onchange="updateAnalysisCreateRange('createEndDate',this.value)"></label>${analysisV2DayTypeFilterHtml(analysis.createDayTypeFilter, 'updateAnalysisCreateDayTypeFilter')}<button type="button" class="btn btn-primary" ${analysis.createLoading ? 'disabled' : ''} onclick="createAnalysisCardFromRange()">${analysis.createLoading ? '生成中…' : '生成标准草稿'}</button></div></div>`;
  const compatibilityWarning = (storageUnavailable ? '<div class="analysis-card-compat-warning">当前网页已更新，但后台仍是旧版本，不能安全保存卡片。请先重启后端服务，再刷新页面。</div>' : '') + createRangeTool;
  return `<section class="analysis-card-library"><div class="analysis-card-library-head"><div><span>BENCHMARK CARDS</span><h3>${active ? escHtmlApp(active.name) : '未保存的标准'}</h3><p>一张卡同时包含标准日和任务效率设置。</p></div><div class="analysis-card-library-actions"><button type="button" class="btn btn-ghost btn-sm" ${canGenerate ? '' : 'disabled'} title="${canGenerate ? '按当前分析区间生成一张新标准卡片' : '请先完成当前日期范围的分析'}" onclick="createAnalysisCardFromRange()">按区间创建</button><button type="button" class="btn btn-ghost btn-sm" ${storageUnavailable ? 'disabled' : ''} onclick="createAnalysisCard()">＋ 新建卡片</button><button type="button" class="btn btn-ghost btn-sm" ${storageUnavailable ? 'disabled' : ''} onclick="openAnalysisCardSave()">保存为卡片</button>${active && !storageUnavailable ? `<button type="button" class="analysis-icon-button danger" title="删除当前标准卡片" aria-label="删除当前标准卡片" onclick="deleteAnalysisCard()">×</button>` : ''}</div></div>${compatibilityWarning}<div class="analysis-benchmark-card-list">${cards || '<div class="analysis-empty-inline">尚未保存标准卡片。当前填写内容会自动保存为快照；需要复用时，可命名保存为卡片。</div>'}</div>${savePanel}</section>`;
}

function analysisTaskStandardsHtml(config) {
  const templates = getTaskTemplates();
  const configured = config.taskStandards || [];
  const options = templates.map(template => `<option value="${escHtmlApp(template.id)}">${escHtmlApp(template.activityType || '未命名模板')}</option>`).join('');
  const rows = configured.map((standard, index) => {
    const template = analysisTemplateForStandard(standard);
    const caps = analysisTemplateCapabilities(template);
    const fields = [
      caps.named ? `<label class="analysis-field compact"><span>标准 分钟/章节</span><input type="number" min="0" step="0.1" value="${standard.chapterMinutesPerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterMinutesPerUnit',this.value)"></label>` : '',
      caps.chapterScore ? `<label class="analysis-field compact"><span>目标 得分/章节</span><input type="number" min="0" max="${template.chapterMaxScore}" step="0.1" value="${standard.chapterScorePerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterScorePerUnit',this.value)"><small>每章满分 ${Number(template.chapterMaxScore).toFixed(1)} 分，越高越好</small></label>` : '',
      caps.quantity ? `<label class="analysis-field compact"><span>标准 ${questionEfficiencyUnitLabel('题')}</span><input type="number" min="0" step="0.01" value="${questionEfficiencyInputValue(standard.quantityPerMinute)}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'quantityPerMinute',this.value)"></label>` : '',
      caps.accuracy ? `<label class="analysis-field compact"><span>标准 正确率 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.accuracy == null ? '' : Number(standard.accuracy) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'accuracy',this.value === '' ? '' : Number(this.value) / 100)"></label>` : '',
      caps.pureTime ? `<label class="analysis-field compact"><span>最大任务总时长占比 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.pureTimeMaxRatio == null ? '' : Number(standard.pureTimeMaxRatio) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'pureTimeMaxRatio',this.value === '' ? '' : Number(this.value) / 100)"><small>该模板分钟 ÷ 区间全部任务分钟，越低越好</small></label>` : '',
    ].filter(Boolean).join('');
    return `<article class="analysis-task-standard ${standard.enabled === false ? 'disabled' : ''}">
      <div class="analysis-task-standard-head"><div><span>任务模板</span><h4>${escHtmlApp(analysisTemplateName(standard))}</h4></div><div class="analysis-task-actions"><label class="analysis-toggle"><input type="checkbox" ${standard.enabled === false ? '' : 'checked'} onchange="updateAnalysisTaskStandard(${index},'enabled',this.checked)"><span>启用</span></label><button type="button" class="analysis-icon-button danger" title="删除任务标准" aria-label="删除任务标准" onclick="removeAnalysisTaskStandard(${index})">×</button></div></div>
      <div class="analysis-task-fields">${fields || '<span class="analysis-empty-inline">该模板未启用章节或数量记录，暂时没有可用效率指标。</span>'}</div>
    </article>`;
  }).join('');
  return `<section class="analysis-config-section" id="analysis-task-section">
    <div class="analysis-section-head"><div><span>02 · TASK BENCHMARKS</span><h3>任务效率标准</h3><p>章节任务按总分钟除以完成章节，数量任务按总数量除以总分钟；不会平均单条任务，避免短记录放大波动。</p></div></div>
    <div class="analysis-task-add"><label><span>从任务模板库加入</span><select id="analysis-task-template-select"><option value="">选择任务模板</option>${options}</select></label><button type="button" class="btn btn-primary" onclick="addAnalysisTaskStandard()">＋ 加入标准</button></div>
    <div class="analysis-task-standard-list">${rows || '<div class="analysis-empty-inline">还没有任务效率标准。可以先填写标准日，再按任务类型逐项加入。</div>'}</div>
  </section>`;
}

function analysisV2MetricCardHtml(label, value, sub = '', tone = '') {
  return `<article class="analysis-v2-metric ${tone}"><div class="analysis-v2-metric-label"><i></i><span>${label}</span></div><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</article>`;
}

function analysisV2TrackingCardsHtml() {
  const analysis = state.analysis;
  const activeId = analysis.activeTrackingCardId;
  const storageUnavailable = analysis.trackingCardStorageSupported === false;
  const cards = (analysis.trackingCards || []).map(card => {
    const effectiveEnd = analysisTrackingEffectiveEnd(card);
    const future = card.startDate > getTodayStr();
    const status = future ? '尚未开始' : (card.endDate > getTodayStr() ? '进行中' : '已完成');
    const progress = future ? `计划 ${formatShort(card.startDate)} 开始` : `已追踪至 ${formatShort(effectiveEnd)}`;
    const score = card.id === activeId && analysis.result?.score?.score != null ? ` · 当前 ${Number(analysis.result.score.score).toFixed(1)} 分` : '';
    const encodedId = encodeURIComponent(card.id).replace(/'/g, '%27');
    return `<article class="analysis-v2-track-card ${card.id === activeId ? 'active' : ''}">
      <button type="button" class="analysis-v2-track-main" onclick="openAnalysisTrackingCard(decodeURIComponent('${encodedId}'))"><span class="analysis-v2-track-status-row"><span class="analysis-v2-track-status">${status}</span>${card.id === activeId ? '<span class="analysis-v2-track-in-use">正在使用</span>' : ''}</span><strong>${escHtmlApp(card.name)}</strong><b>${escHtmlApp(analysisDateLabel(card.startDate, card.endDate))}</b><small>${progress} · ${analysisTrackingDays(card.startDate, card.endDate)} 天计划 · ${escHtmlApp(analysisDayTypeFilterLabel(card.dayTypeFilter || (card.includeExcluded ? DAY_TYPE_ALL_FILTER : '')))}${score}</small></button>
      <button type="button" class="analysis-v2-icon danger" title="删除追踪卡片" aria-label="删除追踪卡片" onclick="deleteAnalysisTrackingCard(decodeURIComponent('${encodedId}'))">×</button>
    </article>`;
  }).join('');
  const active = analysisTrackingCardById(activeId);
  const savePanel = analysis.trackingCardSaveOpen ? `<div class="analysis-v2-save-panel"><label><span>追踪卡片名称</span><input type="text" maxlength="60" value="${escHtmlApp(analysis.trackingCardName)}" placeholder="例如：暑假冲刺阶段" oninput="updateAnalysisTrackingCardName(this.value)"></label><div class="analysis-v2-actions">${active ? `<button type="button" class="btn btn-primary" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="persistAnalysisTrackingCard(false)">保存更新</button>` : ''}<button type="button" class="btn btn-ghost" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="persistAnalysisTrackingCard(true)">保存为新卡片</button><button type="button" class="btn btn-ghost btn-sm" ${analysis.savingTrackingCard ? 'disabled' : ''} onclick="cancelAnalysisTrackingCardSave()">取消</button></div></div>` : '';
  const warning = storageUnavailable ? '<div class="analysis-v2-warning">当前后台尚未支持区间追踪卡片。请重启后端服务后刷新页面。</div>' : '';
  return `<section id="analysis-tracking-library" class="analysis-tracking-library analysis-v2-panel analysis-v2-tracking"><header class="analysis-v2-section-head"><div><span>SAVED RANGES</span><h3>已保存区间</h3><p>每张卡片会保存开始日期和计划结束日期。打开后会使用当前选中的评分标准计算该区间。</p></div><small class="analysis-v2-section-meta">${cards ? `${analysis.trackingCards.length} 张已保存` : '尚未保存区间'}</small></header>${warning}${cards ? `<div class="analysis-v2-track-grid">${cards}</div>` : '<div class="analysis-v2-empty">还没有保存的区间。点击结果区右上角“保存当前区间”即可创建第一张卡片。</div>'}${savePanel}</section>`;
}

function analysisV2ScoreResultHtml(result) {
  if (!result) return `<div class="analysis-v2-empty analysis-v2-empty-result"><span class="analysis-v2-empty-icon">○</span><b>还没有评分结果</b><small>选择日期范围并填写标准后，开始生成综合评分。</small></div>`;
  const { metrics = {}, score = {}, dataQuality = {}, includedDates = [], excludedDates = [], scoreTimeline = [] } = result;
  const scoreValue = score.score == null ? '—' : Number(score.score).toFixed(1);
  const scoreClass = score.score == null ? 'empty' : score.score >= 100 ? 'up' : 'down';
  const factorRows = (score.factors || []).map(factor => `<tr><td><strong>${escHtmlApp(factor.label)}</strong></td><td>${analysisFactorDisplay(factor, factor.value)}</td><td>${analysisFactorDisplay(factor, factor.standard)}</td><td><b class="analysis-v2-ratio ${factor.ratio >= 1 ? 'up' : 'down'}">${Number(factor.ratio).toFixed(3)}×</b></td></tr>`).join('');
  const scoreByDate = new Map(scoreTimeline.map(item => [item.date, item]));
  const scoredDailyCount = scoreTimeline.filter(item => item?.dailyScore != null && Number.isFinite(Number(item.dailyScore))).length;
  const stability = score.stability || result.stability;
  const hasTrendDates = analysisScoreTrendDates(result, scoreTimeline).length > 0;
  const dailyRows = (result.daily || []).map(day => { const point = scoreByDate.get(day.date) || {}; return `<tr><td><strong>${escHtmlApp(day.date)}</strong></td><td>${analysisFormatMinutes(day.actualMinutes)}</td><td>${analysisFormatMinutes(day.nominalMinutes)}</td><td>${analysisFormatMinutes(day.restMinutes)}</td><td>${analysisFormatMinutes(day.unavailableMinutes)}</td><td>${analysisFormatPercent(day.focusEfficiency)}</td><td>${analysisScoreValue(point.dailyScore)}</td><td>${analysisScoreValue(point.cumulativeScore)}</td></tr>`; }).join('');
  return `<div class="analysis-v2-results-body">
    <section class="analysis-v2-score-hero"><div class="analysis-v2-score-copy"><span>RANGE SCORE</span><h3>区间综合评分</h3><p>标准日为 100 分，当前结果可持续追踪且没有上限。</p></div><div class="analysis-v2-score-value ${scoreClass}"><strong>${scoreValue}</strong><span>分</span></div><div class="analysis-v2-score-context"><div><span>纳入日期</span><b>${includedDates.length} 天</b></div><div><span>评分因子</span><b>${(score.factors || []).length} 项</b></div><div><span>标准线</span><b>100 分</b></div></div></section>
    <section class="analysis-v2-metrics" aria-label="核心指标">${analysisV2MetricCardHtml('实际专注', analysisFormatMinutes(metrics.actualMinutes), '普通 + 特殊学习实际', 'actual')}${analysisV2MetricCardHtml('名义专注', analysisFormatMinutes(metrics.nominalMinutes), '计划总量', 'nominal')}${analysisV2MetricCardHtml('时钟时长', analysisFormatMinutes(metrics.totalClockMinutes), '所有已记录时段', 'clock')}${analysisV2MetricCardHtml('清醒时长', analysisFormatMinutes(metrics.awakeMinutes), `${dataQuality.awakeRecordedDays || 0} 天有作息记录`, 'awake')}${analysisV2MetricCardHtml('休息时长', analysisFormatMinutes(metrics.restMinutes), '普通专注内', 'rest')}${analysisV2MetricCardHtml('不可用时间', analysisFormatMinutes(metrics.unavailableMinutes), '含特殊学习未专注部分', 'unavailable')}${analysisV2MetricCardHtml('任务记录', analysisFormatMinutes(metrics.taskMinutes), `${dataQuality.taskDays || 0} 天有任务`, 'task')}${analysisV2MetricCardHtml('专注效率', analysisFormatPercent(metrics.focusEfficiency), '实际 / 有效时钟', 'efficiency')}</section>
    <section class="analysis-v2-trend"><header class="analysis-v2-module-head"><div><span>SCORE TREND</span><h3>${state.analysis.scoreTrendView === 'cumulative' ? '累计评分' : '每日评分'}</h3><p>${state.analysis.scoreTrendView === 'cumulative' ? '从区间开始重新计算到当天，不是每日分数相加。' : '按每天记录与标准日比较，查看表现波动。'}</p></div><div class="analysis-v2-trend-tools"><div class="analysis-v2-segment"><button type="button" class="${state.analysis.scoreTrendView === 'daily' ? 'active' : ''}" onclick="setAnalysisScoreTrendView('daily')">每日</button><button type="button" class="${state.analysis.scoreTrendView === 'cumulative' ? 'active' : ''}" onclick="setAnalysisScoreTrendView('cumulative')">累计</button></div><small>标准线 · 100</small></div></header>${hasTrendDates ? '<div class="analysis-v2-chart"><canvas id="analysisScoreTrendChart"></canvas></div>' : '<div class="analysis-v2-empty">暂无可绘制的评分数据。</div>'}</section>
    <div class="analysis-v2-insight-grid"><section class="analysis-v2-module analysis-v2-factors"><header class="analysis-v2-module-head"><div><span>SCORING FACTORS</span><h3>评分因子</h3></div><small>倍率 ≥ 1 表示高于标准</small></header>${factorRows ? `<div class="analysis-v2-table-wrap"><table class="analysis-v2-table"><thead><tr><th>因子</th><th>本次表现</th><th>标准</th><th>相对标准</th></tr></thead><tbody>${factorRows}</tbody></table></div>` : '<div class="analysis-v2-empty">尚未启用有标准值的评分因子。</div>'}</section><aside class="analysis-v2-module analysis-v2-quality"><header class="analysis-v2-module-head"><div><span>DATA QUALITY</span><h3>数据覆盖</h3></div><span class="analysis-v2-quality-dot"></span></header><div class="analysis-v2-quality-list"><div><span>范围日期</span><b>${dataQuality.rangeDays || 0} 天</b></div><div><span>纳入评分</span><b>${dataQuality.includedDays || 0} 天</b></div><div><span>无记录日期</span><b>${dataQuality.unrecordedDays || 0} 天</b></div><div><span>可计算日分</span><b>${scoredDailyCount} 天</b></div><div><span>排除日期</span><b>${excludedDates.length} 天</b></div><div><span>有时段记录</span><b>${dataQuality.sessionDays || 0} 天</b></div></div>${analysisV2StabilitySummaryHtml(stability)}${(dataQuality.unconfiguredFactors || []).length ? `<p class="warning">尚未设置：${dataQuality.unconfiguredFactors.map(key => ANALYSIS_STANDARD_FIELDS.find(field => field[0] === key)?.[1] || key).join('、')}</p>` : '<p class="success">标准日基础数据已完整设置。</p>'}</aside></div>
    <details class="analysis-v2-daily"><summary><span><b>逐日数据账本</b><small>查看每个日期的原始汇总和评分</small></span><b>${(result.daily || []).length} 天</b></summary><div class="analysis-v2-table-wrap"><table class="analysis-v2-table"><thead><tr><th>日期</th><th>实际</th><th>名义</th><th>休息</th><th>不可用</th><th>专注效率</th><th>每日评分</th><th>累计评分</th></tr></thead><tbody>${dailyRows || '<tr><td colspan="8">没有可汇总的日期记录</td></tr>'}</tbody></table></div></details>
  </div>`;
}

function analysisV2StandardFormHtml(config) {
  const fields = ANALYSIS_STANDARD_FIELDS.map(([key, label, unit, hint]) => {
    const inputOptions = analysisStandardInputOptions(config.standardDay, key);
    const relationHint = ANALYSIS_STANDARD_RELATION_HINTS[key];
    return `<label class="analysis-v2-field"><span>${label}</span><input type="number" ${inputOptions} value="${config.standardDay[key] ?? ''}" placeholder="未设置" oninput="updateAnalysisStandard('${key}',this.value,this)"><small>${hint} · ${unit}<br>约束：${relationHint}</small><button type="button" class="btn btn-ghost btn-sm" ${state.analysis.createLoading ? 'disabled' : ''} onclick="generateAnalysisStandardField('${key}')">生成草稿</button></label>`;
  }).join('');
  return `<section class="analysis-v2-config analysis-v2-standard" id="analysis-standard-section"><header class="analysis-v2-config-head"><div><span>01 · STANDARD DAY</span><h3>标准日</h3><p>填写你认可的一天应有的表现。这个模板计算时恰好等于 100 分。</p></div><div class="analysis-v2-note"><b>标准不是极限</b><small>实际专注可以低于名义专注，重点是定义你满意的一天。</small></div></header><div class="analysis-v2-field-grid">${fields}</div></section>`;
}

function analysisV2CardCollectionHtml() {
  const analysis = state.analysis; const active = analysisActiveCard(); const storageUnavailable = analysis.cardStorageSupported === false; ensureAnalysisCreateRange();
  const cards = (analysis.cards || []).map(card => { const encodedId = encodeURIComponent(card.id).replace(/'/g, '%27'); return `<article class="analysis-v2-benchmark-card-wrap"><button type="button" class="analysis-v2-benchmark-card ${card.id === analysis.activeCardId ? 'active' : ''}" onclick="selectAnalysisCard(decodeURIComponent('${encodedId}'))"><span>${escHtmlApp(card.name)}</span><small>${(card.config?.taskStandards || []).length} 个任务效率标准</small><b>${card.id === analysis.activeCardId ? '当前使用' : '选择此标准'} →</b></button><button type="button" class="analysis-v2-benchmark-delete" title="删除标准卡片“${escHtmlApp(card.name)}”" aria-label="删除标准卡片“${escHtmlApp(card.name)}”" ${storageUnavailable ? 'disabled' : ''} onclick="deleteAnalysisCard(decodeURIComponent('${encodedId}'))">×</button></article>`; }).join('');
  const savePanel = `<div class="analysis-v2-save-panel"><label><span>卡片名称</span><input type="text" maxlength="60" value="${escHtmlApp(analysis.cardName)}" placeholder="例如：工作日标准" oninput="updateAnalysisCardName(this.value)"></label><div class="analysis-v2-actions">${active ? `<button type="button" class="btn btn-primary" ${analysis.savingCard ? 'disabled' : ''} onclick="persistAnalysisCard(false)">保存更新</button>` : ''}<button type="button" class="btn btn-ghost" ${analysis.savingCard ? 'disabled' : ''} onclick="persistAnalysisCard(true)">另存为新卡片</button></div></div>`;
  const createRangeTool = `<div class="analysis-v2-create"><div><span>CREATE FROM RANGE</span><b>从历史区间提取标准</b><small>按独立日期区间和日期类型筛选生成整套标准草稿。</small></div><div class="analysis-v2-create-controls"><label><span>开始</span><input type="date" value="${analysis.createStartDate}" onchange="updateAnalysisCreateRange('createStartDate',this.value)"></label><label><span>结束</span><input type="date" value="${analysis.createEndDate}" onchange="updateAnalysisCreateRange('createEndDate',this.value)"></label>${analysisV2DayTypeFilterHtml(analysis.createDayTypeFilter, 'updateAnalysisCreateDayTypeFilter')}<button type="button" class="btn btn-primary" ${analysis.createLoading ? 'disabled' : ''} onclick="createAnalysisCardFromRange()">${analysis.createLoading ? '生成中…' : '生成整套草稿'}</button></div></div>`;
  const warning = storageUnavailable ? '<div class="analysis-v2-warning">当前网页已更新，但后台仍是旧版本，不能安全保存卡片。请先重启后端服务，再刷新页面。</div>' : '';
  return `<section class="analysis-v2-config analysis-v2-library" id="analysis-card-library"><header class="analysis-v2-config-head"><div><span>BENCHMARK LIBRARY</span><h3>${active ? escHtmlApp(active.name) : '标准卡片库'}</h3><p>选择卡片会切换当前标准；下方名称和保存操作始终可用。</p></div><div class="analysis-v2-actions"><button type="button" class="btn btn-primary btn-sm" ${storageUnavailable ? 'disabled' : ''} onclick="createAnalysisCard()">＋ 新建卡片</button>${active && !storageUnavailable ? `<button type="button" class="analysis-v2-icon danger" title="删除当前标准卡片" aria-label="删除当前标准卡片" onclick="deleteAnalysisCard()">×</button>` : ''}</div></header>${warning}${createRangeTool}<div class="analysis-v2-benchmark-grid">${cards || '<div class="analysis-v2-empty">尚未保存标准卡片。点击“新建卡片”开始。</div>'}</div>${savePanel}</section>`;
}

function analysisV2TaskStandardsHtmlLegacy(config) {
  const analysis = state.analysis; const templates = getTaskTemplates(); const configured = config.taskStandards || []; const options = templates.map(template => `<option value="${escHtmlApp(template.id)}">${escHtmlApp(template.activityType || '未命名模板')}</option>`).join('');
  const rows = configured.map((standard, index) => { const template = analysisTemplateForStandard(standard); const caps = analysisTemplateCapabilities(template); const fields = [caps.named ? `<label class="analysis-v2-field compact"><span>标准 分钟/章节</span><input type="number" min="0" step="0.1" value="${standard.chapterMinutesPerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterMinutesPerUnit',this.value)"></label>` : '', caps.chapterScore ? `<label class="analysis-v2-field compact"><span>目标 得分/章节</span><input type="number" min="0" max="${template.chapterMaxScore}" step="0.1" value="${standard.chapterScorePerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterScorePerUnit',this.value)"><small>每章满分 ${Number(template.chapterMaxScore).toFixed(1)} 分</small></label>` : '', caps.quantity ? `<label class="analysis-v2-field compact"><span>标准 数量/分钟</span><input type="number" min="0" step="0.01" value="${standard.quantityPerMinute ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'quantityPerMinute',this.value)"></label>` : '', caps.accuracy ? `<label class="analysis-v2-field compact"><span>标准 正确率 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.accuracy == null ? '' : Number(standard.accuracy) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'accuracy',this.value === '' ? '' : Number(this.value) / 100)"></label>` : '', caps.pureTime ? `<label class="analysis-v2-field compact"><span>最大任务时长占比 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.pureTimeMaxRatio == null ? '' : Number(standard.pureTimeMaxRatio) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'pureTimeMaxRatio',this.value === '' ? '' : Number(this.value) / 100)"><small>该模板分钟 ÷ 区间全部任务分钟，越低越好</small></label>` : ''].filter(Boolean).join(''); return `<article class="analysis-v2-task ${standard.enabled === false ? 'disabled' : ''}"><header><div><span>任务效率标准</span><h4>${escHtmlApp(analysisTemplateName(standard))}</h4></div><div class="analysis-v2-task-actions"><button type="button" class="btn btn-ghost btn-sm" ${analysis.createLoading ? 'disabled' : ''} onclick="generateAnalysisTaskStandard(${index})">生成草稿</button><label class="analysis-v2-toggle"><input type="checkbox" ${standard.enabled === false ? '' : 'checked'} onchange="updateAnalysisTaskStandard(${index},'enabled',this.checked)"><span>启用</span></label><button type="button" class="analysis-v2-icon danger" title="删除任务标准" aria-label="删除任务标准" onclick="removeAnalysisTaskStandard(${index})">×</button></div></header><div class="analysis-v2-task-fields">${fields || '<span class="analysis-v2-empty">该模板没有可用效率指标。</span>'}</div></article>`; }).join('');
  return `<section class="analysis-v2-config analysis-v2-task-config" id="analysis-task-section"><header class="analysis-v2-config-head"><div><span>02 · TASK BENCHMARKS</span><h3>任务效率</h3><p>按任务类型配置章节、数量、正确率或时间占比标准。</p></div></header><div class="analysis-v2-add-task"><label><span>从任务模板库加入</span><select id="analysis-task-template-select"><option value="">选择任务模板</option>${options}</select></label><button type="button" class="btn btn-primary" onclick="addAnalysisTaskStandard()">＋ 加入标准</button></div><div class="analysis-v2-task-list">${rows || '<div class="analysis-v2-empty">还没有任务效率标准，可以从上方模板库加入。</div>'}</div></section>`;
}

function analysisV2TaskStandardsHtml(config) {
  const analysis = state.analysis;
  const templates = getTaskTemplates();
  const configured = config.taskStandards || [];
  const options = templates.map(template => `<option value="${escHtmlApp(template.id)}">${escHtmlApp(template.activityType || '未命名模板')}</option>`).join('');
  const rows = configured.map((standard, index) => {
    const template = analysisTemplateForStandard(standard);
    const caps = analysisTemplateCapabilities(template);
    const fields = [
      caps.named ? `<label class="analysis-v2-field compact"><span>标准 分钟/章节</span><input type="number" min="0" step="0.1" value="${standard.chapterMinutesPerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterMinutesPerUnit',this.value)"></label>` : '',
      caps.chapterScore ? `<label class="analysis-v2-field compact"><span>目标 得分/章节</span><input type="number" min="0" max="${template.chapterMaxScore}" step="0.1" value="${standard.chapterScorePerUnit ?? ''}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'chapterScorePerUnit',this.value)"><small>每章满分 ${Number(template.chapterMaxScore).toFixed(1)} 分</small></label>` : '',
      caps.quantity ? `<label class="analysis-v2-field compact"><span>标准 ${questionEfficiencyUnitLabel('题')}</span><input type="number" min="0" step="0.01" value="${questionEfficiencyInputValue(standard.quantityPerMinute)}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'quantityPerMinute',this.value)"></label>` : '',
      caps.accuracy ? `<label class="analysis-v2-field compact"><span>标准 正确率 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.accuracy == null ? '' : Number(standard.accuracy) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'accuracy',this.value === '' ? '' : Number(this.value) / 100)"></label>` : '',
      caps.score ? `<label class="analysis-v2-field compact"><span>标准 得分率 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.scoreRate == null ? '' : Number(standard.scoreRate) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'scoreRate',this.value === '' ? '' : Number(this.value) / 100)"><small>每章满分 ${Number(template.scoreMax).toFixed(1)} 分</small></label>` : '',
      caps.pureTime ? `<label class="analysis-v2-field compact"><span>最大任务时长占比 %</span><input type="number" min="0" max="100" step="0.1" value="${standard.pureTimeMaxRatio == null ? '' : Number(standard.pureTimeMaxRatio) * 100}" placeholder="不评分" oninput="updateAnalysisTaskStandard(${index},'pureTimeMaxRatio',this.value === '' ? '' : Number(this.value) / 100)"><small>该模板分钟 ÷ 区间全部任务分钟，越低越好</small></label>` : '',
    ].filter(Boolean).join('');
    return `<article class="analysis-v2-task ${standard.enabled === false ? 'disabled' : ''}"><header><div><span>任务效率标准</span><h4>${escHtmlApp(analysisTemplateName(standard))}</h4></div><div class="analysis-v2-task-actions"><button type="button" class="btn btn-ghost btn-sm" ${analysis.createLoading ? 'disabled' : ''} onclick="generateAnalysisTaskStandard(${index})">生成草稿</button><label class="analysis-v2-toggle"><input type="checkbox" ${standard.enabled === false ? '' : 'checked'} onchange="updateAnalysisTaskStandard(${index},'enabled',this.checked)"><span>启用</span></label><button type="button" class="analysis-v2-icon danger" title="删除任务标准" aria-label="删除任务标准" onclick="removeAnalysisTaskStandard(${index})">×</button></div></header><div class="analysis-v2-task-fields">${fields || '<span class="analysis-v2-empty">该模板没有可用效率指标。</span>'}</div></article>`;
  }).join('');
  return `<section class="analysis-v2-config analysis-v2-task-config" id="analysis-task-section"><header class="analysis-v2-config-head"><div><span>02 · TASK BENCHMARKS</span><h3>任务效率</h3><p>按任务类型配置章节、数量、正确率或时间占比标准。</p></div></header><div class="analysis-v2-add-task"><label><span>从任务模板库加入</span><select id="analysis-task-template-select"><option value="">选择任务模板</option>${options}</select></label><button type="button" class="btn btn-primary" onclick="addAnalysisTaskStandard()">＋ 加入标准</button></div><div class="analysis-v2-task-list">${rows || '<div class="analysis-v2-empty">还没有任务效率标准，可以从上方模板库加入。</div>'}</div></section>`;
}

function renderAnalysis() {
  const host = document.getElementById('tab-analysis');
  if (!host) return;
  ensureAnalysisRange();
  const analysis = state.analysis;
  if (!analysis.config) {
    host.innerHTML = `<section class="analysis-loading"><span>ANALYSIS</span><b>${analysis.loading ? '正在读取分析标准…' : '准备分析工作区…'}</b><small>分析标准独立保存，不会改动已有记录。</small></section>`;
    if (!analysis.loading) loadAnalysisConfig();
    return;
  }
  const result = analysis.result;
  const activePreset = analysis.endDate === getTodayStr() && analysis.startDate === dateToStr(new Date(strToDate(getTodayStr()).getFullYear(), strToDate(getTodayStr()).getMonth(), strToDate(getTodayStr()).getDate() - 6)) ? '7d' : '';
  const message = analysis.message || '';
  host.innerHTML = `<div class="analysis-v2-page">
    <section class="analysis-v2-hero"><div class="analysis-v2-hero-copy"><span>ANALYSIS WORKSPACE</span><h2>分析评分</h2><p>把每天的学习记录转化为清晰、可追踪的表现反馈。先选定一个区间，再用你的标准定义“做得好”。</p><div class="analysis-v2-hero-tags"><span>可追溯</span><span>无上限评分</span><span>标准可复用</span></div></div><div class="analysis-v2-hero-side"><span class="analysis-v2-hero-mark">01</span><b>你的标准<br>定义满分</b><small>标准日 = 100 分<br>表现可以超过 100</small></div></section>
    <section class="analysis-v2-range" aria-label="分析日期范围"><header class="analysis-v2-range-head"><div><span>01 / DATE RANGE</span><h3>${analysisDateLabel(analysis.startDate, analysis.endDate)}</h3><small>${result ? `已汇总 ${result.dayCount} 个日期 · ${analysisDayTypeFilterLabel(analysis.dayTypeFilter)}` : `当前筛选：${analysisDayTypeFilterLabel(analysis.dayTypeFilter)}`}</small></div><div class="analysis-v2-presets"><button type="button" class="${activePreset === '7d' ? 'active' : ''}" onclick="setAnalysisPreset('7d')">近 7 天</button><button type="button" onclick="setAnalysisPreset('30d')">近 30 天</button><button type="button" onclick="setAnalysisPreset('month')">本月</button></div></header><div class="analysis-v2-range-fields"><label><span>开始日期</span><input type="date" value="${analysis.startDate}" onchange="updateAnalysisRange('startDate',this.value)"></label><label><span>结束日期</span><input type="date" value="${analysis.endDate}" onchange="updateAnalysisRange('endDate',this.value)"></label>${analysisV2DayTypeFilterHtml(analysis.dayTypeFilter)}<button type="button" class="analysis-v2-run" ${analysis.loading ? 'disabled' : ''} onclick="evaluateAnalysisRange()"><span>${analysis.loading ? '计算中…' : '开始分析'}</span><b>↗</b></button></div></section>
    <div id="analysis-status" class="analysis-v2-status ${message.kind || ''}">${escHtmlApp(message.text || '')}</div>
    <section class="analysis-v2-results-shell"><header class="analysis-v2-page-head"><div><span>02 / RESULT</span><h3>区间结果</h3>${analysis.activeTrackingCardId && analysis.activeTrackingPlanEndDate ? `<small>当前已打开追踪区间 · 计划结束：${formatDisplay(analysis.activeTrackingPlanEndDate)} · 计算至：${formatDisplay(analysis.endDate)}</small>` : '<small>综合评分、趋势和评分因子会在这里集中呈现。</small>'}</div><div class="analysis-v2-result-actions"><button type="button" class="analysis-v2-save-range" onclick="openAnalysisTrackingCardSave()">＋ 保存当前区间</button></div></header>${analysis.loading && !result ? '<div class="analysis-v2-empty">正在计算，请稍候…</div>' : analysisV2ScoreResultHtml(result)}</section>
    ${analysisV2TrackingCardsHtml()}
    <section class="analysis-v2-settings"><header class="analysis-v2-page-head"><div><span>03 / BENCHMARK SETTINGS</span><h3>评分标准</h3><small>标准决定评分如何理解你的记录；修改后会自动保存当前快照。</small></div></header>${analysisV2CardCollectionHtml()}<div class="analysis-v2-config-grid">${analysisV2StandardFormHtml(analysis.config)}${analysisV2TaskStandardsHtml(analysis.config)}</div></section>
  </div>`;
  renderAnalysisScoreTrend(result);
}

// ============================================================
// INIT
// ============================================================
async function init() {
  chartDefaults();
  applyThemeColors(SETTINGS);
  await loadStorage();
  migrateOldTypes();
  migrateSessionTemplateTypes();
  migrateVisualColors();
  migrateForecastUnitModel();
  migrateTaskTemplateIds();
  migrateTaskTemplateAccuracySettings();
  migrateTaskTemplateScoringSettings();
  migrateDayTypeModel();
  await saveAllStorage();
  await loadServerSnapshot();

  const sd = strToDate(state.selectedDate);
  state.cal = { year: sd.getFullYear(), month: sd.getMonth() };

  initCustomDatePicker();
  setupPrimaryNavigation();
  startSortableTableObserver();
  showTab(state.tab || 'entry');
  startDraftAutoSave();
  startForecastTodayTracking();
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
  if (document.visibilityState === 'hidden') {
    flushSnapshotOnExit();
  } else {
    forecastRefreshTrackedToday();
  }
});
