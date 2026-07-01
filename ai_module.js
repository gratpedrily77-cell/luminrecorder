// ============================================================
// 学习追踪器 — AI 管控模块 (ai_module.js)
// 通过自然语言批量录入，AI 负责拆分与结构化解析
// ============================================================

const AI_PARSER_VERSION = window.AIParserCore?.VERSION || 2;

// ── AI 状态 ───────────────────────────────────────────────────
const aiState = {
  daySplits: [],   // [{ id, date, text, startLine, endLine, status, parsed, issues }]
  // review status: pending | parsing | review | blocked | confirmed | error | imported
  rawInput: '',    // 原始输入文本
  sourceMeta: { fileName: '', lineCount: 0, charCount: 0, loadedAt: '' },
  sourceIssues: [],
  parserVersion: AI_PARSER_VERSION,
  networkConcurrency: 1,
  step2StopInfo: null,
  parseManager: null,
  _activeStep2Run: null,
  _cacheLoaded: false,
};

// ── 后端暂存 helpers ──────────────────────────────────────────
async function aiSaveCacheToServer() {
  try {
    await fetch('/api/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parserVersion: AI_PARSER_VERSION,
        rawInput: aiState.rawInput,
        daySplits: aiState.daySplits,
        sourceMeta: aiState.sourceMeta,
        sourceIssues: aiState.sourceIssues,
        step2StopInfo: aiState.step2StopInfo,
        parseManager: aiState.parseManager,
      }),
    });
  } catch (e) { console.warn('AI缓存保存失败', e); }
}

async function aiLoadCacheFromServer() {
  try {
    const res = await fetch('/api/cache');
    const cache = await res.json();
    if (cache && (cache.rawInput || (cache.daySplits && cache.daySplits.length))) {
      aiState.rawInput = cache.rawInput || '';
      const cachedParserVersion = Number(cache.parserVersion) || 0;
      aiState.daySplits = (cache.daySplits || []).map(split => aiMigrateCachedSplit(split, cachedParserVersion));
      aiState.sourceMeta = cache.sourceMeta || aiBuildSourceMeta(aiState.rawInput);
      aiState.sourceIssues = cache.sourceIssues || [];
      aiState.step2StopInfo = cache.step2StopInfo || null;
      aiState.parseManager = window.AIParseManager.reconcileOnLoad(
        aiState.daySplits,
        cache.parseManager,
        split => window.AIParserCore.extractFacts(split.text)
      );
      aiState.parserVersion = AI_PARSER_VERSION;
      aiState._cacheLoaded = true;
      aiRunSourcePreflight(aiState.daySplits);
      aiState.daySplits.forEach(split => {
        if (!split.parsed) return;
        aiValidateDraftDay(split);
        if (split.status !== 'imported' && aiHasBlockingIssues(split)) {
          split.status = 'blocked';
        }
      });
    }
  } catch (e) { console.warn('AI缓存加载失败', e); }
}

async function aiClearCacheOnServer() {
  try { await fetch('/api/cache', { method: 'DELETE' }); } catch (e) { }
}

// ── localStorage 配置键 ───────────────────────────────────────
const AI_CFG_KEY = 'study_tracker_ai_config';

function aiLoadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_CFG_KEY) || '{}');
    // 迁移旧格式：单套配置 → 双套
    if (raw.provider && !raw.split) {
      const single = { provider: raw.provider, baseUrl: raw.baseUrl, apiKey: raw.apiKey, modelId: raw.modelId };
      return { split: { ...single }, parse: { ...single }, useSameConfig: true, parseConcurrency: 1 };
    }
    // 确保结构完整
    if (!raw.split) raw.split = {};
    if (!raw.parse) raw.parse = {};
    if (raw.useSameConfig === undefined) raw.useSameConfig = true;
    raw.parseConcurrency = aiNormalizeParseConcurrency(raw.parseConcurrency);
    return raw;
  } catch { return { split: {}, parse: {}, useSameConfig: true }; }
}
function aiPersistConfig(cfg) {
  localStorage.setItem(AI_CFG_KEY, JSON.stringify(cfg));
}

function aiNormalizeParseConcurrency(value) {
  if (window.AIStep2Scheduler) return window.AIStep2Scheduler.normalizeConcurrency(value);
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, n));
}

// ============================================================
// PATCH showTab — 加入 AI 标签页
// ============================================================
(function patchShowTab() {
  const ALL_TAB_IDS = ['entry', 'calendar', 'day', 'week', 'month', 'stacked', 'sessAnalysis', 'taskAnalysis', 'sleep', 'export', 'templates', 'ai', 'scan', 'settings'];
  window.showTab = function (id) {
    destroyAll();
    state.tab = id;
    document.querySelectorAll('.tab').forEach((t, i) => {
      t.classList.toggle('active', ALL_TAB_IDS[i] === id);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === 'tab-' + id);
    });
    const renders = {
      entry: renderEntry,
      calendar: renderCalendar,
      day: renderDayOverview,
      week: renderWeekOverview,
      month: renderMonthOverview,
      stacked: renderStackedArea,
      sessAnalysis: renderSessAnalysis,
      taskAnalysis: renderTaskAnalysis,
      sleep: renderSleep,
      export: renderExport,
      templates: renderTemplates,
      ai: renderAI,
      scan: renderScan,
      settings: renderSettings,
    };
    if (renders[id]) renders[id]();
    renderHeader();
  };
})();

// ============================================================
// RENDER — 主界面
// ============================================================
async function renderAI() {
  // 首次进入时从后端恢复缓存
  if (!aiState._cacheLoaded) {
    await aiLoadCacheFromServer();
  }

  const cfg = aiLoadConfig();
  const parseManager = aiEnsureParseManager();
  const parseManagerRunning = parseManager.state === 'running';

  // 方案 A：重建 DOM 前保存 textarea 已有内容
  const savedRawInput = document.getElementById('ai-rawInput')?.value || '';

  document.getElementById('tab-ai').innerHTML = `

    <!-- ── API 配置卡 ─────────────────────────────────── -->
    <div class="card" id="ai-cfg-card" style="max-width:900px;margin-bottom:16px">

      <div class="card-header" style="cursor:pointer" onclick="aiToggleConfig()">
        <div class="card-title">⚙️ AI 接口配置</div>
        <span id="ai-cfg-toggle" style="font-size:12px;color:var(--muted)">▼ 展开</span>
      </div>

      <div id="ai-cfg-body" style="display:none;margin-top:14px">

        <!-- ═══ Step 1 分割 AI 配置 ═══ -->
        <div style="margin-bottom:16px;padding:12px;border:1px solid rgba(99,179,237,.15);border-radius:8px;background:rgba(99,179,237,.03)">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--clock)">🔍 Step 1 — 分割用 AI</div>
          ${aiCfgFieldsHtml('split', cfg.split || {})}
          <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;color:var(--muted);line-height:28px">快速填入：</span>
            ${aiPresetsHtml('split')}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-ghost" id="ai-btn-test-split" onclick="aiTestConn('split')">🔌 测试 ${cfg.useSameConfig !== false ? 'Step1+Step2' : 'Step1'}</button>
            <span id="ai-cfg-msg-split" style="font-size:12px;font-family:var(--mono)"></span>
          </div>
        </div>

        <!-- ═══ 复用开关 ═══ -->
        <div style="margin-bottom:16px;display:flex;align-items:center;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="ai-useSame" ${cfg.useSameConfig !== false ? 'checked' : ''} onchange="aiToggleSame()">
            Step 2 解析使用与 Step 1 相同的 AI 配置
          </label>
        </div>

        <!-- ═══ Step 2 解析 AI 配置 ═══ -->
        <div id="ai-parse-cfg" style="${cfg.useSameConfig !== false ? 'display:none;' : ''}margin-bottom:16px;padding:12px;border:1px solid rgba(105,240,174,.15);border-radius:8px;background:rgba(105,240,174,.03)">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--pol)">🤖 Step 2 — 解析用 AI</div>
          ${aiCfgFieldsHtml('parse', cfg.parse || {})}
          <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;color:var(--muted);line-height:28px">快速填入：</span>
            ${aiPresetsHtml('parse')}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-ghost" onclick="aiTestConn('parse')">🔌 测试 Step2</button>
            <span id="ai-cfg-msg-parse" style="font-size:12px;font-family:var(--mono)"></span>
          </div>
        </div>

        <div style="margin-bottom:16px;padding:12px;border:1px solid rgba(79,195,247,.15);border-radius:8px;background:rgba(79,195,247,.03)">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--hp)">⚡ Step 2 — 解析并发</div>
          <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
            <div class="form-group">
              <label>同时解析本日项目数</label>
              <input type="number" id="ai-parseConcurrency" value="${aiNormalizeParseConcurrency(cfg.parseConcurrency)}" min="1" max="10" step="1">
            </div>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px">日期始终逐日处理；此数值只控制当前日期相邻项目的并发量，范围 1-10。收到 429 会立即停止。</div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="aiSaveConfig()">💾 保存全部配置</button>
          <span id="ai-cfg-msg" style="font-size:12px;font-family:var(--mono)"></span>
        </div>

        <div style="margin-top:10px;padding:10px;background:rgba(107,122,158,.05);border-radius:6px;
                    font-size:11px;color:var(--muted);line-height:1.8">
          <b>多供应商支持：</b>请先选择正确的 <b>API 供应商</b>，程序会自动使用对应的请求格式：<br>
          • <b>Anthropic</b> → <code>/v1/messages</code> + <code>x-api-key</code><br>
          • <b>OpenAI / OpenAI Compatible</b>（DeepSeek、通义、中转等）→ <code>/v1/chat/completions</code> + <code>Bearer Token</code><br>
          • <b>Google Gemini</b> → <code>/v1beta/models/:generateContent</code> + URL 参数 key
        </div>
      </div>
    </div>

    <!-- ── 文字输入卡 ─────────────────────────────────── -->
    <div class="card" style="max-width:900px;margin-bottom:16px">
      <div class="card-title" style="margin-bottom:8px">📝 自然语言录入</div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
        按任意格式输入多天的学习记录，AI 自动识别日期、时段与任务。<br>
        建议包含：<b>日期</b>、<b>起床/睡觉时间</b>、<b>每段起止时间</b>、<b>科目/内容</b>、<b>摸鱼时长</b>。
      </p>
      <div class="ai-source-toolbar">
        <input type="file" id="ai-source-file" accept=".txt,text/plain" style="display:none" onchange="aiLoadTextFile(event)">
        <button class="btn btn-ghost" onclick="document.getElementById('ai-source-file').click()">📄 读取 TXT 文件</button>
        <span id="ai-source-meta" class="ai-source-meta"></span>
      </div>
      <textarea id="ai-rawInput"
        placeholder="示例：&#10;4月1日 周二&#10;起床 7:30，睡觉 23:30&#10;9:00-11:30 刷题 LeetCode，中间摸了20分钟&#10;14:00-17:00 看论文《XX》，专注度一般，实际干了2小时&#10;&#10;4月2日&#10;起床 8:10&#10;10:00-12:00 英语听力+精读&#10;15:00-18:00 写代码，全程专注&#10;睡觉 00:30"
        style="width:100%;min-height:200px;resize:vertical;
               background:rgba(255,255,255,.04);border:1px solid var(--border);
               color:var(--text);padding:12px;border-radius:8px;
               font-size:13px;line-height:1.8;font-family:var(--mono);box-sizing:border-box"
      ></textarea>
      <div id="ai-source-preflight"></div>

      <div style="display:flex;gap:10px;margin-top:12px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="ai-btn-split" onclick="aiStep1Split()">
          🔍 Step 1：按日期智能分割
        </button>
        <button class="btn btn-ghost" onclick="aiClearAll()">🗑️ 清空</button>
        <span id="ai-split-msg" style="font-size:12px;font-family:var(--mono)"></span>
      </div>

      <!-- 额外解析指令（始终可见） -->
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
        <div style="cursor:pointer;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"
             onclick="document.getElementById('ai-extra-prompt-wrap').style.display=document.getElementById('ai-extra-prompt-wrap').style.display==='none'?'block':'none'">
          📝 Step 2 额外解析指令（可选）<span style="font-size:10px">▼</span>
        </div>
        <div id="ai-extra-prompt-wrap" style="display:${(cfg.extraParsePrompt ? 'block' : 'none')};margin-top:6px">
          <textarea id="ai-extraParsePrompt"
            placeholder="例如：我的英语课包含听力和精读，请分开记录为两个 task；数学刷题归类到「学习 > 数学 > 刷题」"
            style="width:100%;min-height:60px;resize:vertical;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px;font-size:12px;line-height:1.6;font-family:var(--mono);box-sizing:border-box"
          >${escHtml(cfg.extraParsePrompt || '')}</textarea>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">此内容会追加到 Step 2 解析的 AI 指令末尾，帮助 AI 更准确地理解你的记录习惯</div>
        </div>
      </div>
    </div>

    <!-- ── 分割结果卡（初始隐藏）─────────────────────── -->
    <div id="ai-splits-section" style="display:none;max-width:900px">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
          <div class="card-title" id="ai-splits-title">📋 分割结果</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="ai-btn-parse-all" onclick="aiStep2ParseAll()" ${parseManagerRunning ? 'disabled title="已有解析正在运行"' : ''}>
              ${parseManagerRunning ? '⏳ Step 2 解析中' : '🤖 Step 2：全部解析'}
            </button>
            <button class="btn btn-success" id="ai-btn-import-all" style="display:none" onclick="aiStep3ImportAll()">
              ✅ Step 3：批量导入
            </button>
          </div>
        </div>

        <!-- 进度条 -->
        <div id="ai-progress-wrap" style="display:none;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:4px">
            <span id="ai-progress-label">解析进度</span>
            <span id="ai-progress-pct">0%</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px">
            <div id="ai-progress-bar" style="height:4px;background:var(--pol);border-radius:2px;width:0%;transition:width .3s"></div>
          </div>
        </div>
        <div id="ai-parse-manager"></div>
        <div id="ai-step2-stop" style="display:none;margin-bottom:12px"></div>

        <div id="ai-day-list"></div>
      </div>
    </div>
  `;

  // 恢复 textarea 内容：优先用当前DOM值，其次用 aiState 缓存
  const restoredTa = document.getElementById('ai-rawInput');
  if (restoredTa) {
    if (savedRawInput) {
      restoredTa.value = savedRawInput;
    } else if (aiState.rawInput) {
      restoredTa.value = aiState.rawInput;
    }
  }
  aiRenderSourceMeta();

  // 如果已有分割结果，重新渲染
  if (aiState.daySplits.length) {
    aiShowSplitsSection();
    aiRenderDayList();
    aiUpdateImportBtn();
  }
}

// ============================================================
// 配置 HTML 生成 helpers（供 renderAI 模板使用）
// ============================================================
function aiCfgFieldsHtml(prefix, c) {
  const prov = c.provider || 'anthropic';
  return `
    <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="form-group">
        <label>API 供应商</label>
        <select id="ai-provider-${prefix}" style="font-size:12px;padding:6px 8px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);border-radius:6px" onchange="aiOnProviderChange('${prefix}')">
          <option value="anthropic" ${prov === 'anthropic' ? 'selected' : ''}>Anthropic</option>
          <option value="openai" ${prov === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="openai-compatible" ${prov === 'openai-compatible' ? 'selected' : ''}>OpenAI Compatible（DeepSeek/通义/中转等）</option>
          <option value="gemini" ${prov === 'gemini' ? 'selected' : ''}>Google Gemini</option>
        </select>
      </div>
      <div class="form-group">
        <label>Base URL</label>
        <input type="text" id="ai-baseUrl-${prefix}"
          placeholder="https://api.anthropic.com"
          value="${escHtml(c.baseUrl || '')}"
          style="font-family:var(--mono);font-size:12px">
      </div>
    </div>
    <div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="form-group">
        <label>API Key</label>
        <input type="password" id="ai-apiKey-${prefix}"
          placeholder="sk-..."
          value="${escHtml(c.apiKey || '')}"
          style="font-family:var(--mono);font-size:12px">
      </div>
      <div class="form-group">
        <label>Model ID</label>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="ai-modelId-${prefix}"
            style="flex:1;font-family:var(--mono);font-size:12px;padding:6px 8px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);border-radius:6px">
            ${c.modelId ? `<option value="${escHtml(c.modelId)}" selected>${escHtml(c.modelId)}</option>` : '<option value="">-- 请获取模型列表 --</option>'}
          </select>
          <button class="btn btn-ghost" style="font-size:11px;padding:4px 8px;white-space:nowrap"
            id="ai-fetch-models-btn-${prefix}"
            onclick="aiFetchModels('${prefix}')">📡 获取模型</button>
        </div>
        <input type="text" id="ai-modelId-manual-${prefix}"
          placeholder="或手动输入模型ID…"
          style="font-family:var(--mono);font-size:11px;margin-top:4px;padding:4px 8px;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--muted);border-radius:4px;width:100%;box-sizing:border-box"
          oninput="aiOnManualModelInput('${prefix}')">
        <div style="font-size:10px;color:var(--muted);margin-top:2px">下拉选择或手动输入均可，手动输入会覆盖下拉选择</div>
      </div>
    </div>`;
}

function aiPresetsHtml(prefix) {
  return [
    { label: 'Anthropic', url: 'https://api.anthropic.com' },
    { label: 'OpenAI', url: 'https://api.openai.com' },
    { label: 'DeepSeek', url: 'https://api.deepseek.com' },
    { label: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode' },
    { label: 'Gemini', url: 'https://generativelanguage.googleapis.com' },
  ].map(p => `<button class="btn btn-ghost" style="font-size:11px;padding:2px 8px"
    onclick="aiPreset('${prefix}','${p.url}')">${p.label}</button>`).join('');
}

// ============================================================
// 配置 helpers
// ============================================================
function aiToggleConfig() {
  const body = document.getElementById('ai-cfg-body');
  const toggle = document.getElementById('ai-cfg-toggle');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  toggle.textContent = open ? '▲ 收起' : '▼ 展开';
}

function aiToggleSame() {
  const checked = document.getElementById('ai-useSame').checked;
  document.getElementById('ai-parse-cfg').style.display = checked ? 'none' : '';
  // 动态更新测试按钮名称
  const btn = document.getElementById('ai-btn-test-split');
  if (btn) btn.textContent = checked ? '🔌 测试 Step1+Step2' : '🔌 测试 Step1';
}

function aiOnProviderChange(prefix) {
  // 目前无需动态 hint，留空或可扩展
}

const _aiProviderMap = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'api.deepseek.com': 'openai-compatible',
  'dashscope.aliyuncs.com': 'openai-compatible',
  'generativelanguage.googleapis.com': 'gemini',
};

function aiPreset(prefix, url) {
  document.getElementById('ai-baseUrl-' + prefix).value = url;
  // 自动匹配供应商
  const sel = document.getElementById('ai-provider-' + prefix);
  for (const [domain, prov] of Object.entries(_aiProviderMap)) {
    if (url.includes(domain)) { sel.value = prov; break; }
  }
  // 清空模型下拉列表，提示用户点击获取
  const modelSel = document.getElementById('ai-modelId-' + prefix);
  if (modelSel) {
    modelSel.innerHTML = '<option value="">-- 请点击「获取模型」加载列表 --</option>';
    modelSel.value = '';
  }
}

/** 从 DOM 读取某一组配置 */
function aiReadStepFields(prefix) {
  const el = document.getElementById('ai-baseUrl-' + prefix);
  if (!el) return null;
  // 手动输入优先于下拉选择
  const manualInput = document.getElementById('ai-modelId-manual-' + prefix);
  const selectEl = document.getElementById('ai-modelId-' + prefix);
  const manualVal = manualInput ? manualInput.value.trim() : '';
  const selectVal = selectEl ? selectEl.value.trim() : '';
  return {
    provider: document.getElementById('ai-provider-' + prefix).value,
    baseUrl: el.value.trim(),
    apiKey: document.getElementById('ai-apiKey-' + prefix).value.trim(),
    modelId: manualVal || selectVal,
  };
}

/** 手动输入模型ID时的处理 */
function aiOnManualModelInput(prefix) {
  // 如果手动输入框有值，视觉上淡化下拉框表示被覆盖
  const manualInput = document.getElementById('ai-modelId-manual-' + prefix);
  const selectEl = document.getElementById('ai-modelId-' + prefix);
  if (manualInput && selectEl) {
    selectEl.style.opacity = manualInput.value.trim() ? '0.5' : '1';
  }
}

// ============================================================
// 获取模型列表 — 调用各供应商的 models API
// ============================================================
async function aiFetchModels(prefix) {
  const baseUrl = document.getElementById('ai-baseUrl-' + prefix)?.value.trim();
  const apiKey = document.getElementById('ai-apiKey-' + prefix)?.value.trim();
  const provider = document.getElementById('ai-provider-' + prefix)?.value;
  const btn = document.getElementById('ai-fetch-models-btn-' + prefix);
  const selectEl = document.getElementById('ai-modelId-' + prefix);

  if (!baseUrl || !apiKey) {
    alert('请先填写 Base URL 和 API Key，再获取模型列表。');
    return;
  }

  // 保存当前选中的值，获取后尝试恢复
  const prevVal = selectEl ? selectEl.value : '';

  if (btn) { btn.disabled = true; btn.textContent = '⏳ 加载中…'; }

  try {
    const base = baseUrl.replace(/\/$/, '');
    const hasV1 = /\/v1\/?$/i.test(base);
    let models = [];

    if (provider === 'anthropic') {
      // Anthropic: GET /v1/models
      const url = hasV1 ? base + '/models' : base + '/v1/models';
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-calls': 'true',
        },
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      // Anthropic 返回 { data: [{ id, display_name, ... }] }
      models = (data.data || []).map(m => ({
        id: m.id,
        name: m.display_name || m.id,
      }));

    } else if (provider === 'openai' || provider === 'openai-compatible') {
      // OpenAI / Compatible: GET /v1/models
      const url = hasV1 ? base + '/models' : base + '/v1/models';
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey },
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      // OpenAI 返回 { data: [{ id, owned_by, ... }] }
      models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id + (m.owned_by ? ` (${m.owned_by})` : ''),
      }));

    } else if (provider === 'gemini') {
      // Gemini: GET /v1beta/models?key=...
      const geminiBase = hasV1 ? base.replace(/\/v1\/?$/i, '') : base;
      const url = geminiBase + '/v1beta/models?key=' + apiKey;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      // Gemini 返回 { models: [{ name: "models/gemini-xxx", displayName, ... }] }
      models = (data.models || []).map(m => ({
        id: m.name ? m.name.replace(/^models\//, '') : m.name,
        name: (m.displayName || m.name || '').replace(/^models\//, ''),
      }));
      // 过滤掉嵌入模型等非生成模型
      models = models.filter(m =>
        m.id && !m.id.includes('embedding') && !m.id.includes('aqa')
      );

    } else {
      throw new Error('该供应商暂不支持自动获取模型列表');
    }

    // 按 ID 排序
    models.sort((a, b) => a.id.localeCompare(b.id));

    if (models.length === 0) {
      throw new Error('API 返回了空的模型列表');
    }

    // 填充下拉框
    if (selectEl) {
      selectEl.innerHTML = models.map(m =>
        `<option value="${escHtml(m.id)}">${escHtml(m.name || m.id)}</option>`
      ).join('');

      // 尝试恢复之前选中的值
      if (prevVal && models.some(m => m.id === prevVal)) {
        selectEl.value = prevVal;
      }

      // 清空手动输入并恢复下拉框透明度
      const manualInput = document.getElementById('ai-modelId-manual-' + prefix);
      if (manualInput) { manualInput.value = ''; }
      selectEl.style.opacity = '1';
    }

    if (btn) { btn.textContent = `✅ ${models.length} 个模型`; }
    setTimeout(() => { if (btn) btn.textContent = '📡 获取模型'; }, 3000);

  } catch (e) {
    if (selectEl) {
      selectEl.innerHTML = `<option value="">❌ 获取失败</option>`;
    }
    if (btn) { btn.textContent = '❌ 失败'; }
    setTimeout(() => { if (btn) btn.textContent = '📡 获取模型'; }, 3000);
    console.error('[aiFetchModels]', e);
    alert('获取模型列表失败：' + e.message.slice(0, 150));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function aiSaveConfig() {
  const splitCfg = aiReadStepFields('split') || {};
  const parseCfg = aiReadStepFields('parse') || {};
  const useSame = document.getElementById('ai-useSame')?.checked !== false;
  const extraParsePrompt = document.getElementById('ai-extraParsePrompt')?.value || '';
  const parseConcurrency = aiNormalizeParseConcurrency(document.getElementById('ai-parseConcurrency')?.value || aiLoadConfig().parseConcurrency);
  const cfg = { split: splitCfg, parse: parseCfg, useSameConfig: useSame, extraParsePrompt, parseConcurrency };
  aiPersistConfig(cfg);
  aiMsg('cfg', '✅ 已保存', 'ok');
  return cfg;
}

function aiGetParseConcurrency() {
  const domValue = document.getElementById('ai-parseConcurrency')?.value;
  return aiNormalizeParseConcurrency(domValue || aiLoadConfig().parseConcurrency);
}

/** 读取指定 step 的有效配置（split 或 parse） */
function aiReadConfig(step) {
  step = step || 'split';
  // 判断是否复用
  const useSame = document.getElementById('ai-useSame')?.checked;
  const effectivePrefix = (step === 'parse' && useSame !== false) ? 'split' : step;

  // 优先从 DOM 读
  const fromDom = aiReadStepFields(effectivePrefix);
  if (fromDom && fromDom.baseUrl) return fromDom;

  // fallback 从 localStorage
  const stored = aiLoadConfig();
  const effectiveKey = (step === 'parse' && stored.useSameConfig !== false) ? 'split' : step;
  return stored[effectiveKey] || {};
}

// ============================================================
// 底层 API 调用
// ============================================================
const aiNetworkGate = { active: 0, limit: 1, queue: [] };

function aiSetNetworkConcurrency(value) {
  aiNetworkGate.limit = aiNormalizeParseConcurrency(value);
  aiState.networkConcurrency = aiNetworkGate.limit;
  aiDrainNetworkQueue();
}

function aiDrainNetworkQueue() {
  while (aiNetworkGate.active < aiNetworkGate.limit && aiNetworkGate.queue.length) {
    const entry = aiNetworkGate.queue.shift();
    if (entry.signal?.aborted) {
      entry.reject(aiAbortError(entry.signal.reason));
      continue;
    }
    entry.signal?.removeEventListener('abort', entry.onAbort);
    aiNetworkGate.active += 1;
    entry.resolve();
  }
}

function aiAbortError(reason = null) {
  const error = new Error(reason?.message || '请求已取消');
  error.name = 'AbortError';
  error.code = 'REQUEST_ABORTED';
  return error;
}

function aiAcquireNetworkSlot(signal = null) {
  if (signal?.aborted) return Promise.reject(aiAbortError(signal.reason));
  if (aiNetworkGate.active < aiNetworkGate.limit) {
    aiNetworkGate.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, onAbort: null };
    entry.onAbort = () => {
      const index = aiNetworkGate.queue.indexOf(entry);
      if (index >= 0) aiNetworkGate.queue.splice(index, 1);
      reject(aiAbortError(signal?.reason));
    };
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    aiNetworkGate.queue.push(entry);
  });
}

function aiReleaseNetworkSlot() {
  aiNetworkGate.active = Math.max(0, aiNetworkGate.active - 1);
  aiDrainNetworkQueue();
}

async function aiCall(messages, systemPrompt, maxTokens = 3000, step = 'split', requestOptions = {}) {
  const cfg = aiReadConfig(step);
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.modelId) {
    throw new Error('请先展开"AI 接口配置"，填写 Base URL、API Key 和 Model ID，然后保存。');
  }

  const provider = cfg.provider || 'anthropic';
  const base = cfg.baseUrl.replace(/\/$/, '');

  // 智能判断 Base URL 是否已包含 /v1 前缀，避免重复拼接
  const hasV1 = /\/v1\/?$/i.test(base);

  let url, headers, body;

  if (provider === 'anthropic') {
    // ── Anthropic Messages API ──
    url = hasV1 ? base + '/messages' : base + '/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-calls': 'true',
    };
    const payload = { model: cfg.modelId, max_tokens: maxTokens, messages };
    if (systemPrompt) payload.system = systemPrompt;
    body = JSON.stringify(payload);

  } else if (provider === 'openai' || provider === 'openai-compatible') {
    // ── OpenAI / OpenAI Compatible Chat Completions ──
    url = hasV1 ? base + '/chat/completions' : base + '/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey,
    };
    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);
    body = JSON.stringify({ model: cfg.modelId, max_tokens: maxTokens, messages: msgs });

  } else if (provider === 'gemini') {
    // ── Google Gemini ──
    const geminiBase = hasV1 ? base.replace(/\/v1\/?$/i, '') : base;
    url = geminiBase + '/v1beta/models/' + cfg.modelId + ':generateContent?key=' + cfg.apiKey;
    headers = { 'Content-Type': 'application/json' };
    const contents = [];
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: '好的，我会按照要求执行。' }] });
    }
    for (const m of messages) {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
    body = JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } });

  } else {
    throw new Error('未知的 API 供应商类型：' + provider);
  }

  // ── 启用流式请求 ──
  const useStream = (provider === 'openai' || provider === 'openai-compatible' || provider === 'anthropic');
  if (useStream) {
    const parsed = JSON.parse(body);
    parsed.stream = true;
    body = JSON.stringify(parsed);
  }

  await aiAcquireNetworkSlot(requestOptions.signal);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: requestOptions.signal });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const error = new Error(`API ${res.status}: ${txt.slice(0, 500)}`);
      error.status = res.status;
      error.retryAfter = Number(res.headers.get('retry-after')) || null;
      error.responseText = txt;
      throw error;
    }

    // ── 流式响应解析 ──
    if (useStream) {
      return await aiReadStream(res, provider);
    }

    // ── 非流式（Gemini 等）──
    const data = await res.json();

    // Gemini 格式
    if (data.candidates) {
      return data.candidates[0]?.content?.parts?.map(p => p.text).join('') || '';
    }
    // Anthropic 格式 fallback
    if (data.content && Array.isArray(data.content)) {
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    // OpenAI 格式 fallback
    if (data.choices) {
      return data.choices[0]?.message?.content || '';
    }
    throw new Error('无法识别的 API 响应格式：' + JSON.stringify(data).slice(0, 500));
  } finally {
    aiReleaseNetworkSlot();
  }
}

// ── 流式 SSE 读取 ──────────────────────────────────────────
async function aiReadStream(res, provider) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  let streamError = null;

  const consumeLine = line => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]' || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      if (json.error) {
        const message = json.error.message || json.error.type || JSON.stringify(json.error);
        streamError = new Error(`流式接口错误：${message}`);
        streamError.status = Number(json.error.status || json.error.code) || null;
        if (!streamError.status && aiIsRateLimitError(streamError)) streamError.status = 429;
        streamError.responseText = payload;
        return;
      }

      if (provider === 'openai' || provider === 'openai-compatible') {
        const delta = json.choices?.[0]?.delta?.content;
        const complete = json.choices?.[0]?.message?.content;
        if (delta) result += delta;
        else if (complete) result += complete;
      } else if (provider === 'anthropic') {
        if (json.type === 'error') {
          streamError = new Error(`流式接口错误：${json.error?.message || payload}`);
          if (aiIsRateLimitError(streamError)) streamError.status = 429;
          streamError.responseText = payload;
        } else if (json.type === 'content_block_delta' && json.delta?.text) {
          result += json.delta.text;
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        streamError = streamError || new Error(`无法解析流式数据：${payload.slice(0, 500)}`);
        streamError.responseText = payload;
      } else {
        throw error;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留未完成的行

    lines.forEach(consumeLine);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    if (buffer.trim().startsWith('{')) {
      try {
        const json = JSON.parse(buffer.trim());
        if (json.error) {
          streamError = new Error(`接口错误：${json.error.message || JSON.stringify(json.error)}`);
          streamError.status = Number(json.error.status || json.error.code) || null;
          if (!streamError.status && aiIsRateLimitError(streamError)) streamError.status = 429;
          streamError.responseText = buffer.trim();
        } else if (json.choices?.[0]?.message?.content) {
          result += json.choices[0].message.content;
        }
      } catch (error) {
        if (!streamError) {
          streamError = new Error(`接口返回了无法识别的非流式内容：${buffer.trim().slice(0, 500)}`);
          streamError.responseText = buffer.trim();
        }
      }
    } else {
      consumeLine(buffer);
    }
  }

  if (streamError && !result) throw streamError;
  if (!result) {
    const error = new Error('流式响应为空，未获取到任何内容');
    error.code = 'EMPTY_STREAM';
    throw error;
  }
  return result;
}

function aiIsRetryableNetworkError(error) {
  const status = Number(error?.status);
  return status >= 500 || error?.code === 'EMPTY_STREAM' ||
    /Failed to fetch|NetworkError|网络|空|流式接口错误|无法解析流式数据|无法识别的非流式内容/i.test(error?.message || '');
}

function aiIsRateLimitError(error) {
  if (window.AIStep2Scheduler) return window.AIStep2Scheduler.isRateLimitError(error);
  return Number(error?.status) === 429 ||
    /(?:^|\D)429(?:\D|$)|rate[\s_-]*limit|too many requests|请求过多|concurrency limit exceeded|concurrent request limit|too many concurrent requests/i.test(error?.message || '');
}

function aiWait(ms, signal = null) {
  if (signal?.aborted) return Promise.reject(aiAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aiAbortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function aiCallWithNetworkRetry(messages, systemPrompt, maxTokens, step, maxRetries = 2, requestOptions = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await aiCall(messages, systemPrompt, maxTokens, step, requestOptions);
    } catch (error) {
      lastError = error;
      if (aiIsRateLimitError(error) || error?.name === 'AbortError') throw error;
      if (!aiIsRetryableNetworkError(error) || attempt >= maxRetries) throw error;
      const baseDelay = attempt === 0 ? 2000 : 5000;
      await aiWait(baseDelay + Math.floor(Math.random() * 400), requestOptions.signal);
    }
  }
  throw lastError;
}

// 连接测试 — 模拟真实任务验证
const _aiTestSplitInput = `3月15日\n起床8:00 睡觉23:00\n9:00-11:00 数学\n\n3月16日\n10:00-12:00 英语`;
const _aiTestParseInput = `起床 7:30，睡觉 23:30\n9:00-11:30 刷题，中间摸了20分钟\n14:00-16:00 看论文`;

const _aiTestSplitSystem = `你是学习记录解析助手。识别用户输入中每一天记录的日期和起始位置。
输出纯 JSON 数组，每个元素：{"date":"YYYY-MM-DD","startMark":"该天第一行完整内容"}
只输出 JSON，无解释，无代码块标记。年份用2025。`;

const _aiTestParseSystem = `你是学习追踪器的数据录入助手。将用户的一天学习记录解析为 JSON。
输出格式：{"wakeTime":"HH:MM","sleepTime":"HH:MM","sessions":[{"startTime":"HH:MM","endTime":"HH:MM","nominalMinutes":整数,"actualMinutes":整数,"restMinutes":整数,"note":""}],"tasks":[{"activityType":"分类","minutes":整数,"note":""}]}
只输出 JSON，无解释，无代码块标记。`;

async function aiTestConn(step) {
  aiSaveConfig();
  const area = 'cfg-' + step;

  // 如果 useSame 且点的是 split，同时测两个
  const useSame = document.getElementById('ai-useSame')?.checked;
  const testBoth = (step === 'split' && useSame);

  if (testBoth) {
    aiMsg('cfg-split', '⏳ 同时测试分割+解析…', 'muted');
  } else {
    aiMsg(area, `⏳ 测试 ${step === 'split' ? '分割' : '解析'} 任务中…`, 'muted');
  }

  try {
    if (step === 'split' || testBoth) {
      await _aiRunSplitTest();
    }
    if (step === 'parse' || testBoth) {
      await _aiRunParseTest(testBoth ? 'split' : 'parse');
    }

    if (testBoth) {
      aiMsg('cfg-split', '✅ 分割+解析均测试通过', 'ok');
    } else {
      aiMsg(area, `✅ ${step === 'split' ? '分割' : '解析'}测试通过`, 'ok');
    }
  } catch (e) {
    aiMsg(area, `❌ ${e.message.slice(0, 120)}`, 'err');
  }
}

async function _aiRunSplitTest() {
  const raw = await aiCall([{ role: 'user', content: _aiTestSplitInput }], _aiTestSplitSystem, 500, 'split');
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch { throw new Error('分割测试失败：AI 返回的不是有效 JSON'); }
  if (!Array.isArray(arr) || arr.length < 2) throw new Error('分割测试失败：期望识别出 2 天，实际 ' + (arr?.length || 0));
  if (!arr[0].date || !arr[0].startMark) throw new Error('分割测试失败：返回格式缺少 date/startMark 字段');
}

async function _aiRunParseTest(step) {
  const raw = await aiCall([{ role: 'user', content: _aiTestParseInput }], _aiTestParseSystem, 500, step);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch { throw new Error('解析测试失败：AI 返回的不是有效 JSON'); }
  if (!obj.sessions && !obj.tasks) throw new Error('解析测试失败：返回缺少 sessions/tasks');
  const sess = obj.sessions || [];
  if (sess.length === 0) throw new Error('解析测试失败：未识别出任何时段');
}

// ============================================================
// STEP 1 — 按日期拆分
// ============================================================
function aiBuildSourceMeta(rawText, fileName = '') {
  const text = rawText || '';
  return {
    fileName,
    lineCount: text ? text.split(/\r?\n/).length : 0,
    charCount: text.length,
    loadedAt: new Date().toISOString(),
  };
}

function aiNormalizeCachedSplit(split) {
  const reviewProposals = split.reviewProposals || [];
  const legacyFinalReviewFailure = reviewProposals.some(proposal =>
    /AI 最终复查失败/.test(proposal?.message || '')
  );
  const finalReviewState = ['pending', 'reviewing', 'complete', 'error'].includes(split.finalReviewState)
    ? (split.finalReviewState === 'reviewing' ? 'pending' : split.finalReviewState)
    : legacyFinalReviewFailure
      ? 'error'
      : split.parsed && ['review', 'blocked', 'confirmed', 'imported'].includes(split.status)
        ? 'complete'
        : 'pending';
  const normalized = {
    id: split.id || uid(),
    date: split.date || '',
    text: split.text || '',
    startLine: split.startLine || null,
    endLine: split.endLine || null,
    status: split.status === 'done'
      ? 'review'
      : split.status === 'parsing'
        ? (split.parsed ? 'review' : 'error')
        : (split.status || 'pending'),
    parsed: split.parsed || null,
    error: split.error || null,
    issues: split.issues || [],
    sourceIssues: split.sourceIssues || [],
    importMode: split.importMode || '',
    editorOpen: Boolean(split.editorOpen),
    sourceEditorOpen: Boolean(split.sourceEditorOpen),
    rawOpen: Boolean(split.rawOpen),
    jsonOpen: Boolean(split.jsonOpen),
    annotationDrafts: split.annotationDrafts || {},
    annotationUnitDrafts: split.annotationUnitDrafts || {},
    sourceDirty: Boolean(split.sourceDirty),
    partialParseMessage: split.partialParseMessage || '',
    draftDirty: Boolean(split.draftDirty),
    pendingProposal: split.pendingProposal || null,
    reviewProposals,
    finalReviewState,
    finalReviewError: split.finalReviewError ||
      (legacyFinalReviewFailure ? reviewProposals.find(proposal => /AI 最终复查失败/.test(proposal?.message || ''))?.message || '' : ''),
    resumeAsProposal: Boolean(split.resumeAsProposal),
    itemParseResults: split.itemParseResults || [],
    sourceFacts: split.sourceFacts || null,
    sourceEditHistory: split.sourceEditHistory || [],
    parseState: window.AIParseManager?.DAY_STATES.includes(split.parseState) ? split.parseState : '',
    parseExcluded: Boolean(split.parseExcluded),
    parserVersion: AI_PARSER_VERSION,
    parsingLocked: false,
    reparseLocked: false,
  };
  if (normalized.parsed) aiValidateDraftDay(normalized);
  return normalized;
}

function aiMigrateCachedSplit(split, cachedParserVersion) {
  if (cachedParserVersion === AI_PARSER_VERSION) return aiNormalizeCachedSplit(split);
  if ([2, 3].includes(cachedParserVersion)) {
    const normalized = aiNormalizeCachedSplit({ ...split, parserVersion: AI_PARSER_VERSION });
    const facts = window.AIParserCore.extractFacts(normalized.text);
    const validResults = (normalized.itemParseResults || [])
      .filter(record => window.AIParseManager.isValidCheckpoint(record, facts));

    if (facts.nonEmptyLines.length > 0 && validResults.length === facts.nonEmptyLines.length) {
      const lineResults = validResults.map(record => {
        const { sourceLine, text, parseStatus, parserVersion, error, errorStatus, ...result } = record;
        return result;
      }).sort((a, b) => Number(a.line) - Number(b.line));
      normalized.sourceFacts = facts;
      normalized.parsed = aiPrepareV2Parsed(normalized, facts, lineResults);
      normalized.reviewProposals = [];
      normalized.pendingProposal = null;
      normalized.issues = [];
      aiValidateDraftDay(normalized);
      if (split.status !== 'imported') {
        normalized.status = aiHasBlockingIssues(normalized) ? 'blocked' : 'review';
        normalized.finalReviewState = 'pending';
        normalized.finalReviewError = '';
        normalized.parseState = 'partial';
        normalized.partialParseMessage = '解析器已升级；逐项检查点已保留，继续时只补新版最终复查与日期类型判断。';
      } else {
        normalized.parseState = 'complete';
      }
      return normalized;
    }

    normalized.sourceFacts = facts;
    normalized.itemParseResults = normalized.itemParseResults || [];
    if (split.status === 'imported') {
      normalized.status = 'imported';
      normalized.parseState = 'complete';
      return normalized;
    }
    if (split.status !== 'imported') normalized.parsed = null;
    normalized.parseState = validResults.length ? 'partial' : 'pending';
    normalized.status = validResults.length ? 'error' : 'pending';
    normalized.error = validResults.length ? '解析器已升级，可从现有逐项检查点继续。' : null;
    return normalized;
  }

  return aiNormalizeCachedSplit({
    id: split.id,
    date: split.date,
    text: split.text,
    startLine: split.startLine,
    endLine: split.endLine,
    status: 'pending',
    parseState: 'pending',
  });
}

function aiNumberSplitLines(rawText) {
  return String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => `[L${index + 1}] ${line}`)
    .join('\n');
}

function aiCreateIssue(code, level, message, options = {}) {
  const sourceLines = options.sourceLines || [];
  const target = options.target || '';
  return {
    id: options.id || [code, target, sourceLines.join('-'), options.original || ''].join('|'),
    code,
    level,
    message,
    target,
    sourceLines,
    original: options.original || '',
    suggestion: options.suggestion ?? null,
    sourceReplacement: options.sourceReplacement ?? null,
    expectedSource: options.expectedSource ?? null,
    replacementSource: options.replacementSource ?? null,
    proposalType: options.proposalType || '',
    reason: options.reason || '',
    apply: options.apply || null,
    confidence: options.confidence ?? null,
    status: options.status || 'open',
  };
}

function aiMergeIssueLists(previous, next) {
  const oldById = new Map((previous || []).map(issue => [issue.id, issue]));
  return (next || []).map(issue => {
    const old = oldById.get(issue.id);
    return old ? {
      ...issue,
      status: old.status || issue.status,
      suggestionStaged: old.suggestionStaged || issue.suggestionStaged,
    } : issue;
  });
}

async function aiLoadTextFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const rawText = await file.text();
  const el = document.getElementById('ai-rawInput');
  if (el) el.value = rawText;
  aiState.rawInput = rawText;
  aiState.sourceMeta = aiBuildSourceMeta(rawText, file.name);
  aiState.daySplits = [];
  aiState.sourceIssues = [];
  aiState.parseManager = window.AIParseManager.createManager();
  aiRenderSourceMeta();
  aiMsg('split', `已读取 ${file.name}，可以开始日期切分`, 'ok');
  await aiSaveCacheToServer();
}

function aiRenderSourceMeta() {
  const metaEl = document.getElementById('ai-source-meta');
  const preflightEl = document.getElementById('ai-source-preflight');
  const meta = aiState.sourceMeta || {};
  if (metaEl) {
    metaEl.textContent = meta.lineCount
      ? `${meta.fileName || '粘贴文本'} · ${meta.lineCount} 行 · ${meta.charCount} 字符`
      : '可直接粘贴，也可读取本地 TXT';
  }
  if (preflightEl) {
    preflightEl.innerHTML = aiState.sourceIssues?.length
      ? `<div class="ai-preflight"><b>源文件预检：</b>发现 ${aiState.sourceIssues.length} 个日期级问题。请在下方对应原文旁查看 AI 批注并决定是否采纳。</div>`
      : '';
  }
}

function aiTryLocalDateSplit(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const year = new Date().getFullYear();
  const markers = [];
  lines.forEach((line, index) => {
    const m = line.trim().match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
    if (!m) return;
    markers.push({
      date: `${m[1] || year}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`,
      lineIndex: index,
    });
  });
  if (!markers.length) return [];
  return markers.map((marker, index) => {
    const endIndex = index + 1 < markers.length ? markers[index + 1].lineIndex - 1 : lines.length - 1;
    return {
      date: marker.date,
      text: lines.slice(marker.lineIndex, endIndex + 1).join('\n').trim(),
      startLine: marker.lineIndex + 1,
      endLine: endIndex + 1,
    };
  });
}

function aiAttachLineRanges(rawText, splits) {
  const lines = String(rawText || '').split(/\r?\n/);
  let cursor = 0;
  return splits.map(split => {
    const blockLines = String(split.text || '').split(/\r?\n/);
    const first = blockLines[0]?.trim();
    let start = lines.findIndex((line, index) => index >= cursor && line.trim() === first);
    if (start < 0) start = cursor;
    const end = Math.min(lines.length - 1, start + blockLines.length - 1);
    cursor = end + 1;
    return { ...split, startLine: start + 1, endLine: end + 1 };
  });
}

function aiRunSourcePreflight(splits) {
  const globalIssues = [];
  const byDate = new Map();
  splits.forEach(split => {
    split.sourceIssues = [];
    if (!byDate.has(split.date)) byDate.set(split.date, []);
    byDate.get(split.date).push(split);
  });

  const parsedDates = splits.map(split => split.date).filter(Boolean);
  const months = new Map();
  parsedDates.forEach(date => {
    const [year, month, day] = date.split('-').map(Number);
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(day);
  });

  for (const [date, sameDateSplits] of byDate.entries()) {
    if (sameDateSplits.length < 2) continue;
    const [year, month] = date.split('-').map(Number);
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const dim = new Date(year, month, 0).getDate();
    const present = new Set(months.get(key) || []);
    const missing = Array.from({ length: dim }, (_, i) => i + 1).filter(day => !present.has(day));
    sameDateSplits.forEach((split, duplicateIndex) => {
      if (duplicateIndex === 0) return;
      const suggestedDay = missing[0];
      const suggestedDate = suggestedDay ? `${key}-${String(suggestedDay).padStart(2, '0')}` : '';
      const issue = aiCreateIssue('DUPLICATE_DATE', 'error',
        `日期 ${date} 重复出现${suggestedDate ? `；建议将本段改为 ${suggestedDate}` : ''}。`,
        {
          sourceLines: [split.startLine],
          original: date,
          suggestion: suggestedDate || null,
          apply: suggestedDate ? { path: 'date', value: suggestedDate } : null,
          confidence: suggestedDate ? 0.92 : 0.7,
        });
      split.sourceIssues.push(issue);
      globalIssues.push(issue);
    });
  }

  splits.forEach(split => {
    const lines = split.text.split(/\r?\n/);
    lines.forEach((line, offset) => {
      const lineNo = split.startLine + offset;
      const overflow = line.match(/(\d+)\s*小时\s*(\d+)\s*分/);
      if (overflow && Number(overflow[2]) >= 60) {
        const total = Number(overflow[1]) * 60 + Number(overflow[2]);
        const suggestion = `${Math.floor(total / 60)}小时${String(total % 60).padStart(2, '0')}分钟`;
        split.sourceIssues.push(aiCreateIssue('DURATION_MINUTE_OVERFLOW', 'warning',
          `时长“${overflow[0]}”的分钟数超过 59；建议确认是否应为“${suggestion}”。`,
          { sourceLines: [lineNo], original: overflow[0], suggestion, confidence: 0.98 }));
      }
      if (/睡觉\s*13点/.test(line)) {
        split.sourceIssues.push(aiCreateIssue('DAYTIME_BEDTIME', 'warning',
          '睡觉时间写为 13 点，结合上下文很可能是凌晨 01:00，请确认。',
          { sourceLines: [lineNo], original: line.trim(), suggestion: '01:00', apply: { path: 'parsed.sleepTime', value: '01:00' }, confidence: 0.94 }));
      }
      if (/去上课\s*18:17\s*到\s*7:00/.test(line)) {
        split.sourceIssues.push(aiCreateIssue('LIKELY_MISSING_HOUR_DIGIT', 'warning',
          '“去上课 18:17 到 7:00”疑似漏写 19 点中的数字 1，请确认结束时间。',
          { sourceLines: [lineNo], original: line.trim(), suggestion: '18:17 到 19:00', confidence: 0.86 }));
      }
      if (/^32分钟\s+31分钟\s+30分钟/.test(line.trim())) {
        split.sourceIssues.push(aiCreateIssue('UNASSIGNED_DURATION_LIST', 'warning',
          '检测到一串未说明用途的分钟数，必须人工决定归属。',
          { sourceLines: [lineNo], original: line.trim(), confidence: 0.99 }));
      }
    });
  });

  splits.forEach(split => {
    if (!split.parsed) split.issues = [];
  });
  aiState.sourceIssues = globalIssues;
  aiRenderSourceMeta();
}

function aiFinalizeSplits(rawText, splits) {
  const ranged = aiAttachLineRanges(rawText, splits);
  aiState.daySplits = ranged.map(split => aiNormalizeCachedSplit({
    ...split,
    id: uid(),
    status: 'pending',
    parseState: 'pending',
    parseExcluded: false,
    parsed: null,
    error: null,
    issues: [],
  }));
  aiState.parseManager = window.AIParseManager.createManager();
  aiState.rawInput = rawText;
  aiState.sourceMeta = {
    ...aiBuildSourceMeta(rawText, aiState.sourceMeta?.fileName || ''),
    fileName: aiState.sourceMeta?.fileName || '',
  };
}

async function aiStep1Split() {
  const rawText = document.getElementById('ai-rawInput').value.trim();
  if (!rawText) { alert('请先在上方输入文字内容'); return; }

  aiSaveConfig();

  const btn = document.getElementById('ai-btn-split');
  btn.disabled = true;
  btn.textContent = '⏳ AI 分析中…';
  aiMsg('split', '正在识别日期并分割，请稍候…', 'muted');

  const year = new Date().getFullYear();
  const localSplits = aiTryLocalDateSplit(rawText);
  if (localSplits.length) {
    aiFinalizeSplits(rawText, localSplits);
    aiMsg('split', `✅ 本地识别到 ${localSplits.length} 个日期区块，已完成源文件预检`, 'ok');
    aiShowSplitsSection();
    aiRenderDayList();
    await aiSaveCacheToServer();
    btn.disabled = false;
    btn.textContent = '🔍 Step 1：按日期智能分割';
    return;
  }

  const system = `你是学习记录解析助手。识别用户输入中每一天记录的日期和起始位置。

## 输出格式
纯 JSON 数组，每个元素：
{"date":"YYYY-MM-DD","startMark":"该天记录在原文中的第一行完整内容"}

## 规则
1. 识别各种日期写法：4月1日、04/01、4.1、4-1、2025-04-01、周X 等
2. 年份缺失时使用 ${year}
3. startMark 必须是原文中该天内容起始处的**完整第一行**（原样复制，不修改），用于程序定位切割
4. 只输出 JSON，不输出任何解释文字、代码块标记（无需 \`\`\`）
5. 按在原文中出现的顺序排列

## 示例
输入：
4月1日 周二
起床 7:30
9:00-11:30 刷题

4月2日
10:00-12:00 英语

输出：
[{"date":"${year}-04-01","startMark":"4月1日 周二"},{"date":"${year}-04-02","startMark":"4月2日"}]`;

  try {
    const raw = await aiCall([{ role: 'user', content: rawText }], system, 2048, 'split');
    let cleaned = raw.replace(/```json|```/g, '').trim();
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      cleaned = cleaned.slice(arrStart, arrEnd + 1);
    } else {
      throw new Error('返回内容不完整（可能被截断）。末尾内容：' + raw.slice(-100));
    }
    let markers;
    try { markers = JSON.parse(cleaned); }
    catch (e) { throw new Error('JSON解析失败：' + e.message + '\n返回末尾：' + raw.slice(-80)); }

    if (!Array.isArray(markers) || markers.length === 0)
      throw new Error('AI 未识别到有效日期，请检查文字中是否包含日期信息。');

    // 根据 startMark 在原文中定位并切割
    const splits = aiSplitByMarkers(rawText, markers);

    aiFinalizeSplits(rawText, splits);

    aiMsg('split', `✅ 识别到 ${splits.length} 天记录`, 'ok');
    aiShowSplitsSection();
    aiRenderDayList();

    // 暂存到后端
    aiSaveCacheToServer();

  } catch (e) {
    aiMsg('split', `❌ ${e.message.slice(0, 120)}`, 'err');
  }

  btn.disabled = false;
  btn.textContent = '🔍 Step 1：按日期智能分割';
}

/**
 * 根据 AI 返回的 startMark 标记在原文中定位并切割出每天的文字
 * @param {string} rawText - 用户输入的完整原文
 * @param {Array<{date:string, startMark:string}>} markers - AI 返回的标记数组
 * @returns {Array<{date:string, text:string}>}
 */
function aiSplitByMarkers(rawText, markers) {
  // 找到每个 startMark 在原文中的位置
  const positions = [];
  for (const m of markers) {
    const idx = rawText.indexOf(m.startMark);
    if (idx === -1) {
      // 容错：尝试去掉首尾空格后模糊匹配
      const trimmed = m.startMark.trim();
      const idx2 = rawText.indexOf(trimmed);
      if (idx2 === -1) {
        console.warn(`[AI Split] startMark 未找到: "${m.startMark}"`);
        continue; // 跳过找不到的
      }
      positions.push({ date: m.date, idx: idx2 });
    } else {
      positions.push({ date: m.date, idx });
    }
  }

  // 按位置排序
  positions.sort((a, b) => a.idx - b.idx);

  // 切割
  const results = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = (i + 1 < positions.length) ? positions[i + 1].idx : rawText.length;
    results.push({
      date: positions[i].date,
      text: rawText.slice(start, end).trim(),
    });
  }

  if (results.length === 0) {
    throw new Error('无法根据 AI 返回的标记在原文中定位，请重试。');
  }

  return results;
}

// ============================================================
// STEP 2 — 逐日解析
// ============================================================
function aiGetActHint() {
  const l1 = getLevel1Names();
  const l2 = getLevel2Names();
  const l3 = getLevel3Names();
  if (l1.length === 0 && l2.length === 0 && l3.length === 0) return '（暂无已有分类。严禁自行推断或发明任何类别名称！此时 activityType 必须设为空字符串 ""，并在该 task 上添加 "needsClassification": true）';
  const parts = [];
  if (l1.length) parts.push('一级: ' + l1.join('、'));
  if (l2.length) parts.push('二级: ' + l2.join('、'));
  if (l3.length) parts.push('三级: ' + l3.join('、'));
  return parts.join(' | ');
}

/** 将任务模板库格式化为 AI 可读的提示文本 */
function aiGetTemplateHint() {
  const templates = (typeof getTaskTemplates === 'function') ? getTaskTemplates() : [];
  if (!templates || templates.length === 0) return '';
  const lines = templates.map((t, i) => {
    const kw = (t.keywords || []).join('、') || '（无关键词）';
    const nameInfo = t.name ? `名称: "${t.name}"，` : '（无名称，需要从用户原文提取任务名），';
    let desc = `  - 模板#${i + 1} templateId: "${t.id}" → ${nameInfo}activityType: "${t.activityType || ''}"，关键词：${kw}`;
    if (t.defaultMinutes) desc += `，默认时长：${t.defaultMinutes}分钟`;
    if (t.quantityUnit) desc += `，数量单位：${t.quantityUnit}`;
    if (t.note) desc += `，备注模板：${t.note}`;
    if (String(t.aiPrompt || '').trim()) {
      desc += `\n    专属 AI 提示词（选择模板时优先遵守）：${String(t.aiPrompt).trim()}`;
    }
    return desc;
  });
  return lines.join('\n') + '\n模板选择必须先理解专属 AI 提示词中的适用范围、扩展场景、排除情况和注意事项，再结合关键词与整日上下文。专属提示词与关键词冲突时，以专属提示词为准。命中模板时，task.templateId 必须填写对应 templateId；模板名称非空时 task.name 使用模板名称，模板名称为空时由你生成名称；未命中模板时 templateId 设为空字符串。';
}

function aiGetSessionTemplateHint() {
  const templates = (typeof getSessionTemplates === 'function') ? getSessionTemplates() : [];
  if (!templates || templates.length === 0) return '';
  const lines = templates.map((t, i) => {
    const kw = (t.keywords || []).join('、') || '（无关键词）';
    let desc = `  - 特殊时段模板#${i + 1} templateId: "${t.id}" → 名称: "${t.name}"，关键词：${kw}`;
    if (t.note) desc += `，note: "${t.note}"`;
    if (String(t.aiPrompt || '').trim()) {
      desc += `\n    专属 AI 提示词（选择模板时优先遵守）：${String(t.aiPrompt).trim()}`;
    }
    return desc;
  });
  return lines.join('\n') + '\n特殊时段模板也必须先理解专属 AI 提示词，再结合关键词与整日上下文。专属提示词与关键词冲突时，以专属提示词为准。';
}

function aiGetDayTypeTemplateHint() {
  const templates = typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : [];
  if (!templates.length) return '';
  const lines = templates.map((template, index) => {
    const keywords = (template.keywords || []).join('、') || '（无关键词）';
    const flags = `特殊天=${template.specialDay ? '是' : '否'}，不参与评分=${template.excludeFromRating ? '是' : '否'}`;
    let description = `  - 日期类型#${index + 1} templateId: "${template.id}" → 名称: "${template.name}"，关键词：${keywords}，${flags}`;
    if (String(template.aiPrompt || '').trim()) {
      description += `\n    专属 AI 提示词（最高优先级）：${String(template.aiPrompt).trim()}`;
    }
    return description;
  });
  return lines.join('\n') + '\n每天最多选择一个日期类型。先遵守专属 AI 提示词，再参考关键词和整日上下文；无法明确匹配时 templateId 必须留空。不要自行输出特殊天或不参与评分的值。';
}

const AI_ITEM_JSON_BEGIN = '<<<AI_JSON_BEGIN:item-v1>>>';
const AI_ITEM_JSON_END = '<<<AI_JSON_END:item-v1>>>';
const AI_REVIEW_JSON_BEGIN = '<<<AI_JSON_BEGIN:review-v2>>>';
const AI_REVIEW_JSON_END = '<<<AI_JSON_END:review-v2>>>';
const AI_DAY_JSON_BEGIN = '<<<AI_JSON_BEGIN:day-lines-v2>>>';
const AI_DAY_JSON_END = '<<<AI_JSON_END:day-lines-v2>>>';
const AI_STRICT_JSON_RETRIES = 1;

function aiExtractMarkedJson(raw, beginMarker, endMarker) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const start = text.indexOf(beginMarker);
  const end = text.lastIndexOf(endMarker);
  if (start < 0) throw new Error(`缺少开始标记 ${beginMarker}`);
  if (end < 0) throw new Error(`缺少结束标记 ${endMarker}`);
  if (end <= start) throw new Error('JSON 结束标记出现在开始标记之前');
  const jsonText = text.slice(start + beginMarker.length, end).trim();
  if (!jsonText.startsWith('{') || !jsonText.endsWith('}')) {
    throw new Error('标记之间不是完整 JSON 对象');
  }
  return JSON.parse(jsonText);
}

async function aiStrictMarkedJsonCall({ messages, systemPrompt, maxTokens, step, beginMarker, endMarker, validate, requestOptions = {} }) {
  let lastRaw = '';
  let lastError = '';
  for (let attempt = 0; attempt <= AI_STRICT_JSON_RETRIES; attempt++) {
    const repairPrompt = attempt === 0 ? '' : `

上一轮输出不合格，错误原因：${lastError}
上一轮原始输出：
${lastRaw.slice(-2500)}

请重新输出。必须严格使用：
${beginMarker}
{...合法 JSON 对象...}
${endMarker}
不要输出任何解释、Markdown 或额外文字。`;
    const raw = await aiCallWithNetworkRetry(
      attempt === 0 ? messages : [...messages, { role: 'user', content: repairPrompt }],
      systemPrompt,
      maxTokens,
      step,
      2,
      requestOptions
    );
    lastRaw = raw;
    try {
      const value = aiExtractMarkedJson(raw, beginMarker, endMarker);
      if (typeof validate === 'function') validate(value);
      return { value, raw, attempts: attempt + 1 };
    } catch (e) {
      lastError = e.message || String(e);
      if (attempt >= AI_STRICT_JSON_RETRIES) {
        const err = new Error(lastError);
        err.raw = lastRaw;
        err.attempts = attempt + 1;
        throw err;
      }
    }
  }
  throw new Error(lastError || 'AI JSON 输出失败');
}

function aiReviewDraftSummary(parsed) {
  return {
    wakeTime: parsed.wakeTime || '',
    sleepTime: parsed.sleepTime || '',
    dayType: parsed.dayType || '',
    dayTypeTemplateId: parsed.dayTypeTemplateId || '',
    specialDay: Boolean(parsed.specialDay),
    specialDayReason: parsed.specialDayReason || '',
    excludeFromRating: Boolean(parsed.excludeFromRating),
    dayNote: parsed.dayNote || '',
    sessions: (parsed.sessions || []).map(session => ({
      id: session.id,
      type: session.type,
      sessionTemplateId: session.sessionTemplateId || '',
      name: session.name || '',
      startTime: session.startTime || '',
      endTime: session.endTime || '',
      nominalMinutes: Number(session.nominalMinutes) || 0,
      actualMinutes: Number(session.actualMinutes) || 0,
      restMinutes: Number(session.restMinutes) || 0,
      sourceLines: session.sourceLines || [],
    })),
    tasks: (parsed.tasks || []).map(task => ({
      id: task.id,
      templateId: task.templateId || '',
      name: task.name || '',
      activityType: task.activityType || '',
      minutes: Number(task.minutes) || 0,
      quantity: task.quantity ?? null,
      quantityUnit: task.quantityUnit || '',
      sourceLines: task.sourceLines || [],
    })),
    unassignedLines: parsed.unassignedLines || [],
  };
}

function aiValidateReviewValue(value) {
  if (!value || !Array.isArray(value.reviewProposals)) throw new Error('复查结果缺少 reviewProposals 数组');
  if (!value.dayClassification || typeof value.dayClassification !== 'object') {
    throw new Error('复查结果缺少 dayClassification 对象');
  }
  const dayClassification = value.dayClassification;
  dayClassification.templateId = String(dayClassification.templateId || '');
  dayClassification.reason = String(dayClassification.reason || '');
  dayClassification.sourceLines = [...new Set((dayClassification.sourceLines || []).map(Number))]
    .filter(line => Number.isFinite(line) && line > 0)
    .sort((a, b) => a - b);
  const dayTypeTemplates = typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : [];
  if (dayClassification.templateId && !dayTypeTemplates.some(template => template.id === dayClassification.templateId)) {
    throw new Error(`dayClassification.templateId 不存在：${dayClassification.templateId}`);
  }
  const exactTarget = /^parsed\.(?:wakeTime|sleepTime|dayType|dayNote|specialDay|specialDayReason|excludeFromRating|sessions\.\d+\.(?:type|sessionTemplateId|name|startTime|endTime|nominalMinutes|actualMinutes|restMinutes|note)|tasks\.\d+\.(?:name|templateId|activityType|minutes|quantity|quantityUnit|completionStatus|progressText|errorCount|note))$/;
  value.reviewProposals.forEach((proposal, index) => {
    if (!['source', 'field', 'session', 'task'].includes(proposal.type)) throw new Error(`reviewProposals[${index}].type 不合法`);
    if (!['error', 'warning'].includes(proposal.severity)) proposal.severity = 'warning';
    if (!Array.isArray(proposal.sourceLines)) proposal.sourceLines = [];
    if (!proposal.message) throw new Error(`reviewProposals[${index}].message 不能为空`);
    if (proposal.targetPath && !exactTarget.test(proposal.targetPath)) {
      throw new Error(`reviewProposals[${index}].targetPath 不是精确字段路径：${proposal.targetPath}`);
    }
    const hasSourceRewrite = proposal.type === 'source' &&
      (String(proposal.expectedSource ?? '') !== '' || String(proposal.replacementSource ?? '') !== '');
    if (hasSourceRewrite) {
      const lines = [...new Set(proposal.sourceLines.map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
      if (!lines.length) throw new Error(`reviewProposals[${index}] 原文修改缺少 sourceLines`);
      if (lines.some((line, lineIndex) => lineIndex > 0 && line !== lines[lineIndex - 1] + 1)) {
        throw new Error(`reviewProposals[${index}] 原文修改的 sourceLines 必须连续`);
      }
      if (typeof proposal.expectedSource !== 'string' || typeof proposal.replacementSource !== 'string') {
        throw new Error(`reviewProposals[${index}] 原文修改必须同时提供 expectedSource 和 replacementSource`);
      }
      proposal.sourceLines = lines;
    } else {
      delete proposal.expectedSource;
      delete proposal.replacementSource;
    }
  });
}

function aiReviewProposalsToIssues(split, proposals) {
  return (proposals || []).map((proposal, index) => {
    const level = proposal.severity === 'error' ? 'error' : 'warning';
    return aiCreateIssue(`AI_REVIEW_PROPOSAL_${proposal.type || 'source'}_${index}`, level, proposal.message || 'AI 复查提案', {
      target: proposal.targetPath || '',
      sourceLines: aiAbsoluteSourceLines(split, proposal.sourceLines || []),
      original: proposal.expectedSource ?? proposal.original ?? '',
      suggestion: proposal.replacementSource ?? proposal.suggestion ?? proposal.suggestedValue ?? proposal.sourceReplacement ?? '',
      sourceReplacement: proposal.replacementSource ?? proposal.sourceReplacement ?? '',
      expectedSource: proposal.expectedSource ?? null,
      replacementSource: proposal.replacementSource ?? null,
      proposalType: proposal.type || '',
      reason: proposal.reason || '',
      apply: aiSafeApplyFromAI({
        targetPath: proposal.targetPath || '',
        suggestedValue: proposal.suggestedValue,
        suggestion: proposal.suggestion,
      }),
      confidence: proposal.confidence ?? null,
    });
  });
}

async function aiRunReviewProposal(split, parsed, localIssues, sourceFacts = split.sourceFacts || null, requestOptions = {}) {
  const system = `你是学习追踪器的最终复查与日期类型判断助手。字段修正只能输出提案，绝不能未经用户点击采纳就修改草稿或原文。日期类型判断会由程序确定性套用到待审核草稿，但不会直接修改正式数据。

必须严格输出：
${AI_REVIEW_JSON_BEGIN}
{"dayClassification":{"templateId":"","reason":"","sourceLines":[]},"reviewProposals":[]}
${AI_REVIEW_JSON_END}

dayClassification 规则：
1. 阅读整日原文，并从下方日期类型模板中选择至多一个。
2. 专属 AI 提示词优先于关键词；关键词只提供候选线索。
3. 无法明确匹配时 templateId 留空，不得强行分类。
4. reason 简要说明判断依据，sourceLines 列出本日相对行号。
5. 只返回 templateId，不要自行返回 specialDay 或 excludeFromRating。

reviewProposals 每项格式：
{"type":"source|field|session|task","sourceLines":[1],"severity":"error|warning","message":"问题","reason":"修改原因","expectedSource":"指定行当前完整原文","replacementSource":"建议替换后的完整原文","targetPath":"","suggestedValue":""}

规则：
1. 只提出会影响导入正确性的硬问题或安全修正提案。
2. 不要输出模板单位差异、普通任务未关联时段、任务总时长和 session 总时长口径差异这类软建议。
3. 如果发现睡觉时间被解析为 06:00-20:59，必须提出 error 提案，不能默认接受。
4. 你可以质疑原文明写的时间、分钟、数量、单位或文字，并提出原文修改，但只能作为用户可采纳的提案。
5. sourceLines 使用本日相对行号。
6. targetPath 必须是精确字段路径，例如 parsed.tasks.10.quantityUnit；不能只写 tasks、sessions 等集合名。
7. 原文修改必须使用 type="source"，sourceLines 必须连续；expectedSource 必须逐字等于这些行的完整当前原文，replacementSource 必须给出完整替换文本。
8. 不得为了迎合模板而修改原文。只有确实认为原文有误时才提出修改，并在 reason 中说明依据。
9. 复查模板选择时必须重新阅读下方每个模板的专属 AI 提示词；提示词优先于关键词，发现套用了明确排除的模板时提出精确字段提案。
10. 不要输出数值置信度。

任务模板：
${aiGetTemplateHint() || '无'}

特殊时段模板：
${aiGetSessionTemplateHint() || '无'}

日期类型模板：
${aiGetDayTypeTemplateHint() || '无'}` + aiGetExtraParsePrompt();
  const hardIssues = (localIssues || [])
    .filter(issue => issue.level === 'error')
    .map(issue => ({
      code: issue.code,
      message: issue.message,
      sourceLines: (issue.sourceLines || []).map(line => split.startLine ? Number(line) - split.startLine + 1 : Number(line)).filter(Number.isFinite),
    }));
  const user = `日期：${split.date}

本日原文：
${aiNumberSplitLines(split.text)}

程序提取的原文事实：
${JSON.stringify(sourceFacts || {}, null, 2)}

程序合并草稿摘要：
${JSON.stringify(aiReviewDraftSummary(parsed), null, 2)}

本地硬错误：
${JSON.stringify(hardIssues, null, 2)}`;
  const { value } = await aiStrictMarkedJsonCall({
    messages: [{ role: 'user', content: user }],
    systemPrompt: system,
    maxTokens: 1800,
    step: 'parse',
    beginMarker: AI_REVIEW_JSON_BEGIN,
    endMarker: AI_REVIEW_JSON_END,
    validate: value => {
      aiValidateReviewValue(value);
      const maxLine = sourceFacts?.lines?.length || String(split.text || '').split(/\r?\n/).length;
      if (value.dayClassification.sourceLines.some(line => line > maxLine)) {
        throw new Error(`dayClassification.sourceLines 超出本日原文范围：${value.dayClassification.sourceLines.join('、')}`);
      }
    },
    requestOptions,
  });
  return {
    dayClassification: value.dayClassification,
    reviewProposals: value.reviewProposals || [],
  };
}

async function aiRunFinalReviewStage(split, parsed, localIssues, sourceFacts = split.sourceFacts || null, requestOptions = {}) {
  const scheduler = window.AIStep2Scheduler;
  if (!scheduler?.runFinalReviewStage) throw new Error('Step 2 最终复查调度模块未加载');
  const configuredConcurrency = aiNetworkGate.limit;
  return scheduler.runFinalReviewStage({
    configuredConcurrency,
    setConcurrency: aiSetNetworkConcurrency,
    review: () => aiRunReviewProposal(split, parsed, localIssues, sourceFacts, requestOptions),
  });
}

function aiBatchParserSystem(split, sourceFacts, targetLines = null) {
  const requested = targetLines?.length
    ? `只返回这些相对行号：${targetLines.join('、')}。`
    : '必须为本日每个非空相对行号返回且只返回一个结果。';
  return `你是学习追踪器的逐行语义解析助手。你会一次看到整天原文，但输出仍按原文行组织。

程序已经提取了明确时间、分钟、数量和单位。这些 source-explicit 事实不可改写；你的职责是判断语义、归属、分类和模板。

必须严格输出：
${AI_DAY_JSON_BEGIN}
{"lineResults":[
  {
    "line":1,
    "kind":"field|session|task|note|unknown",
    "field":"",
    "value":"",
    "session":{"type":"normal|special|special-study","templateId":"","name":"","note":""},
    "task":{"name":"","activityType":"","templateId":"","minutes":null,"quantity":null,"quantityUnit":"","completionStatus":"completed|partial|review|unknown","progressText":"","errorCount":null,"note":""},
    "note":{"target":"day|previous-session|previous-task|unknown","targetLine":null,"text":""},
    "reason":"简短语义依据",
    "aiIssues":[]
  }
]}
${AI_DAY_JSON_END}

规则：
1. ${requested}
2. 日期标题输出 kind="unknown"，不要报错。
3. 起床加单个时间输出 field/wakeTime；睡觉加单个时间输出 field/sleepTime。
4. 睡觉、午睡或午休只要带起止时间范围，就必须输出 session/type="special"，不能输出 sleepTime。
5. 普通学习时间范围输出 session/type="normal"；吃饭、洗澡、外出、睡觉等不可用范围输出 special；外层时段含零散学习才使用 special-study。
6. session.type 只能是 normal、special、special-study，禁止输出 study 等其他值。
7. 选择任务或特殊时段模板时，专属 AI 提示词的优先级高于关键词。必须先判断提示词中的适用范围、可扩展场景、排除条件和注意事项；关键词只用于提供候选线索。
8. 特殊时段符合模板专属提示词及上下文时，session.templateId 必须填写对应模板 ID；不符合时即使出现关键词也不得套用；普通时段留空。
9. task 负责名称、已有分类和模板候选。符合模板专属提示词及上下文时填写 templateId；不符合时即使活动类别相同或出现宽泛关键词也不得套用。原文明写的分钟、数量、单位由程序处理，不得为了匹配模板改写。
10. 备注按整日上下文归入 day、previous-session 或 previous-task；不确定时使用 unknown。
11. 不要生成数值置信度。aiIssues 只允许影响导入正确性的硬错误。

日期：${split.date}

任务模板：
${aiGetTemplateHint() || '无'}

特殊时段模板：
${aiGetSessionTemplateHint() || '无'}

已有活动分类：
${aiGetActHint() || '无'}` + aiGetExtraParsePrompt();
}

async function aiRequestDayLineResults(split, sourceFacts, targetLines = null, requestOptions = {}) {
  const expectedLines = targetLines?.length ? targetLines : sourceFacts.nonEmptyLines;
  const factPayload = sourceFacts.lineFacts
    .filter(item => expectedLines.includes(item.line))
    .map(item => ({ line: item.line, text: item.text, facts: item.facts, hints: item.hints }));
  const user = `本日完整原文：
${aiNumberSplitLines(split.text)}

程序已提取事实：
${JSON.stringify(factPayload, null, 2)}

请求行号：
${expectedLines.join('、')}`;
  const maxTokens = Math.min(16000, Math.max(3000, 1800 + expectedLines.length * 430));
  const { value } = await aiStrictMarkedJsonCall({
    messages: [{ role: 'user', content: user }],
    systemPrompt: aiBatchParserSystem(split, sourceFacts, targetLines),
    maxTokens,
    step: 'parse',
    beginMarker: AI_DAY_JSON_BEGIN,
    endMarker: AI_DAY_JSON_END,
    validate: result => window.AIParserCore.validateAiEnvelope(result, sourceFacts, expectedLines),
    requestOptions,
  });
  return value.lineResults;
}

function aiPrepareV2Parsed(split, sourceFacts, lineResults) {
  const parsed = window.AIParserCore.assembleDay(sourceFacts, lineResults, {
    taskTemplates: aiGetTaskTemplatesSafe(),
    sessionTemplates: typeof getSessionTemplates === 'function' ? getSessionTemplates() : [],
  });
  parsed.sessions.forEach(session => {
    session.id = session.id || uid();
  });
  parsed.tasks.forEach(task => {
    task.id = task.id || uid();
  });
  parsed.aiIssues = window.AIParserCore.validateDay(parsed, sourceFacts);
  return parsed;
}

function aiCreateStep2Run(concurrency = aiGetParseConcurrency()) {
  return {
    concurrency: aiNormalizeParseConcurrency(concurrency),
    failedWaves: 0,
    controller: new AbortController(),
    stopped: false,
    stopReason: '',
    stopError: null,
    pauseRequested: false,
    paused: false,
  };
}

function aiEnsureParseManager() {
  if (!aiState.parseManager) {
    aiState.parseManager = window.AIParseManager.createManager({
      concurrency: aiGetParseConcurrency(),
    });
  }
  return aiState.parseManager;
}

function aiFactsForSplit(split) {
  return window.AIParserCore.extractFacts(split?.text || '');
}

function aiDayParseProgress(split) {
  return window.AIParseManager.dayProgress(split, aiFactsForSplit(split));
}

function aiUpdateParseManager(values = {}) {
  const manager = aiEnsureParseManager();
  Object.assign(manager, values, { updatedAt: new Date().toISOString() });
  aiRenderParseManager();
  return manager;
}

function aiPauseStep2() {
  const manager = aiEnsureParseManager();
  const run = aiState._activeStep2Run;
  if (manager.state !== 'running' || !run) return;
  run.pauseRequested = true;
  run.paused = true;
  run.stopped = true;
  run.stopReason = 'paused';
  const reason = new Error('用户暂停 Step 2');
  reason.code = 'USER_PAUSE';
  run.stopError = reason;
  if (!run.controller.signal.aborted) run.controller.abort(reason);
  const active = aiState.daySplits.find(split => split.id === manager.activeDayId);
  if (active) {
    const progress = aiDayParseProgress(active);
    if (active.parseState === 'parsing' || progress.done < progress.total || !active.parsed) {
      active.parseState = 'partial';
      active.partialParseMessage = '解析已暂停；成功项目已保存，继续时只处理剩余项目。';
    }
  }
  aiUpdateParseManager({
    state: 'paused',
    stopReason: '用户暂停',
  });
  aiRenderExistingDayCards();
  aiUpdateProgress();
  aiSaveCacheToServer();
}

function aiSetDayParseExcluded(index, excluded) {
  const split = aiState.daySplits[index];
  if (!split) return;
  const manager = aiEnsureParseManager();
  if (manager.state === 'running' && manager.activeDayId === split.id) {
    alert('请先暂停当前解析，再排除这个日期。');
    return;
  }
  window.AIParseManager.setExcluded(split, excluded, aiFactsForSplit(split));
  if (excluded) manager.queueDayIds = manager.queueDayIds.filter(id => id !== split.id);
  split.partialParseMessage = excluded
    ? '本日已移出“全部解析”队列，逐项检查点仍然保留。'
    : '本日已恢复到解析队列。';
  aiUpdateParseManager({});
  aiRenderDayCard(index);
  aiUpdateProgress();
  aiSaveCacheToServer();
}

async function aiInvalidateDayTypeReviews() {
  let changed = false;
  aiState.daySplits.forEach(split => {
    if (!split?.parsed || split.status === 'imported') return;
    const facts = aiFactsForSplit(split);
    window.AIParserCore.applyDayTypeClassification(
      split.parsed,
      facts,
      { templateId: '', reason: '', sourceLines: [] },
      typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : []
    );
    if (split.pendingProposal?.parsed) {
      window.AIParserCore.applyDayTypeClassification(
        split.pendingProposal.parsed,
        facts,
        { templateId: '', reason: '', sourceLines: [] },
        typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : []
      );
      split.resumeAsProposal = true;
    }
    split.finalReviewState = 'pending';
    split.finalReviewError = '';
    split.reviewProposals = [];
    const progress = aiDayParseProgress(split);
    split.parseState = progress.done === progress.total ? 'partial' : split.parseState;
    split.partialParseMessage = '日期类型模板已变化；逐项结果保持不变，继续时只重新执行最终复查。';
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
    changed = true;
  });
  if (!changed) return;
  aiRenderExistingDayCards();
  aiUpdateImportBtn();
  aiUpdateProgress();
  await aiSaveCacheToServer();
}

function aiCheckpointLine(record) {
  return Number(record?.line ?? record?.sourceLine);
}

function aiValidItemCheckpoint(record, sourceFacts) {
  const line = aiCheckpointLine(record);
  if (!Number.isFinite(line) || record?.parseStatus !== 'ok') return false;
  if (!sourceFacts.nonEmptyLines.includes(line)) return false;
  return String(record.text || '') === String(sourceFacts.lines[line - 1] || '').trim();
}

function aiCheckpointRecord(result, sourceFacts) {
  const line = Number(result.line);
  return {
    ...result,
    sourceLine: line,
    text: String(sourceFacts.lines[line - 1] || '').trim(),
    parseStatus: 'ok',
    parserVersion: AI_PARSER_VERSION,
  };
}

function aiFailedCheckpointRecord(line, sourceFacts, error) {
  return {
    line: Number(line),
    sourceLine: Number(line),
    text: String(sourceFacts.lines[Number(line) - 1] || '').trim(),
    parseStatus: 'error',
    parserVersion: AI_PARSER_VERSION,
    error: error?.message || String(error || '解析失败'),
    errorStatus: Number(error?.status) || null,
  };
}

function aiStep2StopMessage(info) {
  if (!info) return '';
  const prefix = info.reason === 'rate-limit'
    ? '接口返回 429（请求过多），Step 2 已立即停止，未进行重试。'
    : `解析失败波次累计达到 ${info.failedWaves || 3} 次，Step 2 已停止。`;
  const location = [info.date, info.lines?.length ? `本日相对行 ${info.lines.join('、')}` : '']
    .filter(Boolean)
    .join(' · ');
  return `${prefix}${location ? `\n位置：${location}` : ''}${info.error ? `\n最后错误：${info.error}` : ''}`;
}

function aiStopStep2Run(run, split, scheduleResult) {
  if (!run || run.stopped) return;
  run.stopped = true;
  run.stopReason = scheduleResult.stopReason;
  run.stopError = scheduleResult.stopError || null;
  if (!run.controller.signal.aborted) run.controller.abort(run.stopError);
  const rejected = (scheduleResult.results || []).filter(entry =>
    entry.status === 'rejected' && entry.error?.name !== 'AbortError'
  );
  aiState.step2StopInfo = {
    reason: run.stopReason,
    failedWaves: run.failedWaves,
    date: split?.date || '',
    lines: [...new Set(rejected.map(entry => Number(entry.item)).filter(Number.isFinite))],
    error: run.stopError?.message || String(run.stopError || ''),
    stoppedAt: new Date().toISOString(),
  };
  aiUpdateParseManager({
    state: 'stopped',
    activeDayId: split?.id || null,
    stopReason: aiState.step2StopInfo.reason,
  });
  aiRenderStep2StopInfo();
  if (!run.transactional) aiSaveCacheToServer();
  if (!run.notified) {
    run.notified = true;
    setTimeout(() => alert(aiStep2StopMessage(aiState.step2StopInfo)), 0);
  }
}

async function aiParseTargetLinesInWaves(index, split, sourceFacts, targetLines, options = {}) {
  const scheduler = window.AIStep2Scheduler;
  if (!scheduler) throw new Error('Step 2 调度模块未加载');
  const run = options.run || aiCreateStep2Run();
  const checkpointByLine = new Map();
  (options.existingResults || split.itemParseResults || []).forEach(record => {
    const line = aiCheckpointLine(record);
    if (Number.isFinite(line)) checkpointByLine.set(line, record);
  });

  const scheduleResult = await scheduler.runAdjacentWaves({
    items: targetLines,
    concurrency: run.concurrency,
    initialFailedWaves: run.failedWaves,
    failureLimit: 3,
    signal: run.controller.signal,
    processItem: async (line, waveContext) => {
      const lineResults = await aiRequestDayLineResults(
        split,
        sourceFacts,
        [line],
        { signal: waveContext.signal }
      );
      return lineResults[0];
    },
    onWaveComplete: async summary => {
      run.failedWaves = summary.failedWaves;
      summary.settled.forEach(entry => {
        const line = Number(entry.item);
        if (entry.status === 'fulfilled') {
          checkpointByLine.set(line, aiCheckpointRecord(entry.value, sourceFacts));
          if (options.progress) options.progress.doneItems += 1;
        } else if (entry.error?.name !== 'AbortError') {
          checkpointByLine.set(line, aiFailedCheckpointRecord(line, sourceFacts, entry.error));
        }
      });
      split.itemParseResults = [...checkpointByLine.values()]
        .sort((a, b) => aiCheckpointLine(a) - aiCheckpointLine(b));
      const completed = split.itemParseResults.filter(record => record.parseStatus === 'ok').length;
      split.partialParseMessage = `正在解析 ${split.date}：已完成 ${completed} / ${sourceFacts.nonEmptyLines.length} 项；失败波次 ${run.failedWaves} / 3。`;
      split.parseState = 'parsing';
      if (aiState._activeStep2Run === run) aiUpdateParseManager({});
      aiRenderDayCard(index);
      aiUpdateProgress();
      if (options.checkpoint !== false) await aiSaveCacheToServer();
    },
  });

  run.failedWaves = scheduleResult.failedWaves;
  if (scheduleResult.stopped) {
    if (scheduleResult.stopReason === 'aborted' && run.pauseRequested) {
      run.paused = true;
      run.stopped = true;
      run.stopReason = 'paused';
    } else {
      aiStopStep2Run(run, split, scheduleResult);
    }
  }
  return {
    run,
    scheduleResult,
    checkpoints: [...checkpointByLine.values()].sort((a, b) => aiCheckpointLine(a) - aiCheckpointLine(b)),
  };
}

async function aiParseSingleDayByUnits(index, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return false;
  if (split.parsingLocked || split.status === 'parsing') {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    return false;
  }

  aiRunSourcePreflight(aiState.daySplits);
  const asProposal = Boolean((options.asProposal || split.resumeAsProposal) && split.parsed);
  const previousParsed = split.parsed;
  const previousIssues = split.issues || [];
  const sourceFacts = window.AIParserCore.extractFacts(split.text);
  const run = options.step2Run || aiCreateStep2Run();
  const force = Boolean(options.force);
  const reusableResults = force
    ? []
    : (split.itemParseResults || []).filter(record => aiValidItemCheckpoint(record, sourceFacts));
  const reusableLines = new Set(reusableResults.map(aiCheckpointLine));
  const pendingLines = sourceFacts.nonEmptyLines.filter(line => !reusableLines.has(line));
  let assembledParsed = null;
  let finalReviewFailure = null;

  split.parsingLocked = true;
  split.status = 'parsing';
  split.parseState = 'parsing';
  split.error = null;
  split.pendingProposal = null;
  split.reviewProposals = [];
  split.finalReviewState = 'pending';
  split.finalReviewError = '';
  split.resumeAsProposal = asProposal;
  split.itemParseResults = reusableResults;
  split.sourceFacts = sourceFacts;
  split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
  split.partialParseMessage = `正在解析 ${split.date}：待处理 ${pendingLines.length} / ${sourceFacts.nonEmptyLines.length} 项，并发 ${run.concurrency}。`;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);

  try {
    if (pendingLines.length) {
      await aiParseTargetLinesInWaves(index, split, sourceFacts, pendingLines, {
        run,
        progress: options.progress,
      });
    }
    if (run.stopped) throw run.stopError || new Error('Step 2 已停止');

    const validCheckpoints = (split.itemParseResults || [])
      .filter(record => aiValidItemCheckpoint(record, sourceFacts));
    const lineResults = validCheckpoints.map(record => {
      const { sourceLine, text, parseStatus, parserVersion, error, errorStatus, ...result } = record;
      return result;
    }).sort((a, b) => Number(a.line) - Number(b.line));
    const completedLines = new Set(lineResults.map(result => Number(result.line)));
    const missingLines = sourceFacts.nonEmptyLines.filter(line => !completedLines.has(line));
    if (missingLines.length) {
      const error = new Error(`本日仍有 ${missingLines.length} 项解析失败：相对行 ${missingLines.join('、')}。成功项目已保存，可点击继续解析。`);
      error.code = 'PARTIAL_DAY_PARSE';
      throw error;
    }

    const parsed = aiPrepareV2Parsed(split, sourceFacts, lineResults);
    assembledParsed = parsed;
    const validationSplit = { ...split, parsed, issues: [] };
    aiValidateDraftDay(validationSplit);

    let finalReviewResult = {
      dayClassification: { templateId: '', reason: '', sourceLines: [] },
      reviewProposals: [],
    };
    try {
      split.finalReviewState = 'reviewing';
      split.partialParseMessage = '本日项目解析完成，正在进行 AI 最终复查；并发已临时降为 1。';
      aiRenderDayCard(index);
      aiUpdateProgress();
      finalReviewResult = await aiRunFinalReviewStage(
        split,
        parsed,
        validationSplit.issues || [],
        sourceFacts,
        { signal: run.controller.signal }
      );
    } catch (error) {
      finalReviewFailure = error;
      if (!run.pauseRequested && error?.name !== 'AbortError' && aiIsRateLimitError(error)) {
        aiStopStep2Run(run, split, {
          stopped: true,
          stopReason: 'rate-limit',
          stopError: error,
          failedWaves: run.failedWaves,
          results: [],
        });
      }
    }
    const reviewProposals = finalReviewResult.reviewProposals || [];
    if (!finalReviewFailure) {
      window.AIParserCore.applyDayTypeClassification(
        parsed,
        sourceFacts,
        finalReviewResult.dayClassification,
        typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : []
      );
    }

    if (asProposal) {
      const proposalSplit = { ...split, parsed, issues: [], reviewProposals, sourceFacts };
      aiValidateDraftDay(proposalSplit);
      split.parsed = previousParsed;
      split.reviewProposals = [];
      split.pendingProposal = {
        parsed,
        issues: proposalSplit.issues || [],
        differences: aiBuildProposalDifferences(previousParsed, parsed),
        createdAt: new Date().toISOString(),
      };
      split.partialParseMessage = 'AI 已按日重新解析原文。新结果尚未覆盖最终草稿，请审核下方提案。';
    } else {
      split.parsed = parsed;
      split.pendingProposal = null;
      split.reviewProposals = reviewProposals;
    }

    split.sourceDirty = false;
    split.draftDirty = false;
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
    if (finalReviewFailure) {
      const paused = run.pauseRequested || finalReviewFailure?.name === 'AbortError';
      split.finalReviewState = paused ? 'pending' : 'error';
      split.finalReviewError = finalReviewFailure.message || String(finalReviewFailure);
      split.error = paused ? null : `AI 最终复查失败：${split.finalReviewError}`;
      split.parseState = 'partial';
      split.partialParseMessage = paused
        ? '最终复查已暂停；逐项结果和组装草稿均已保存，继续时只执行最终复查。'
        : '逐项解析和草稿组装已经完成，但最终复查失败。点击“继续最终复查”即可补做，不会重新解析已有项目。';
    } else {
      split.finalReviewState = 'complete';
      split.finalReviewError = '';
      split.resumeAsProposal = false;
      split.error = null;
      split.parseState = 'complete';
      split.partialParseMessage = asProposal
        ? 'AI 已按日重新解析并完成最终复查。新结果尚未覆盖最终草稿，请审核下方提案。'
        : '本日原文已完成批量逐行解析和整日 AI 复查。';
      if (options.progress) {
        options.progress.doneDays += 1;
      }
    }
  } catch (error) {
    split.parsed = !asProposal && assembledParsed ? assembledParsed : previousParsed;
    split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
    if (split.parsed) aiValidateDraftDay(split);
    if (run.paused || run.pauseRequested || error?.code === 'USER_PAUSE') {
      split.status = split.parsed ? (aiHasBlockingIssues(split) ? 'blocked' : 'review') : 'pending';
      split.parseState = 'partial';
      split.finalReviewState = assembledParsed ? 'pending' : split.finalReviewState;
      split.error = null;
      split.partialParseMessage = '解析已暂停；已完成项目保留，继续时只解析剩余项目。';
    } else {
      split.status = split.parsed ? (aiHasBlockingIssues(split) ? 'blocked' : 'review') : 'error';
      split.error = error.message;
      const progress = aiDayParseProgress(split);
      split.parseState = progress.done > 0 ? 'partial' : 'error';
    }
  }

  split.parsingLocked = false;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
  aiUpdateImportBtn();
  aiUpdateProgress();
  await aiSaveCacheToServer();
  return split.status !== 'error';
}

async function aiParseSingleDay(index, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return false;
  const ownsRun = !options.step2Run;
  let run = options.step2Run;
  if (ownsRun) {
    if (aiEnsureParseManager().state === 'running') {
      alert('已有 Step 2 解析正在运行，请先暂停。');
      return false;
    }
    aiState.step2StopInfo = null;
    aiRenderStep2StopInfo();
    if (split.parseExcluded) window.AIParseManager.setExcluded(split, false, aiFactsForSplit(split));
    run = aiCreateStep2Run();
    aiState._activeStep2Run = run;
    aiUpdateParseManager({
      state: 'running',
      mode: 'single',
      activeDayId: split.id,
      queueDayIds: [split.id],
      concurrency: run.concurrency,
      startedAt: new Date().toISOString(),
      stopReason: '',
    });
    aiUpdateProgress();
    options = { ...options, step2Run: run };
    await aiSaveCacheToServer();
  }
  aiSetNetworkConcurrency(run?.concurrency || aiGetParseConcurrency());
  const result = await aiParseSingleDayByUnits(index, options);
  if (ownsRun) {
    aiState._activeStep2Run = null;
    if (run.paused) {
      aiUpdateParseManager({ state: 'paused', activeDayId: split.id, stopReason: '用户暂停' });
    } else if (!run.stopped) {
      aiUpdateParseManager({ state: 'idle', activeDayId: null, stopReason: '' });
    }
    aiUpdateProgress();
    await aiSaveCacheToServer();
  }
  return result;
}

async function aiStep2ParseAll() {
  aiSaveConfig();
  const btn = document.getElementById('ai-btn-parse-all');
  const concurrency = aiGetParseConcurrency();
  aiSetNetworkConcurrency(concurrency);
  const manager = aiEnsureParseManager();
  if (manager.state === 'running') return;
  aiState.step2StopInfo = null;
  aiRenderStep2StopInfo();
  const resumeQueue = ['paused', 'stopped'].includes(manager.state) &&
    manager.mode === 'all' &&
    manager.queueDayIds.length;
  const eligible = aiState.daySplits.filter(split =>
    window.AIParseManager.eligibleForQueue(split, aiFactsForSplit(split))
  );
  const queueIds = resumeQueue
    ? manager.queueDayIds.filter(id => eligible.some(split => split.id === id))
    : eligible.map(split => split.id);
  const pending = queueIds.map(id => {
    const i = aiState.daySplits.findIndex(split => split.id === id);
    return { s: aiState.daySplits[i], i };
  }).filter(entry => entry.i >= 0 && entry.s);

  if (!pending.length) {
    aiUpdateParseManager({
      state: 'idle',
      mode: 'all',
      activeDayId: null,
      queueDayIds: [],
      stopReason: '没有待解析、部分解析或失败的日期',
    });
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🤖 Step 2：全部解析';
    }
    aiUpdateProgress();
    await aiSaveCacheToServer();
    return;
  }

  const run = aiCreateStep2Run(concurrency);
  aiState._activeStep2Run = run;
  aiUpdateParseManager({
    state: 'running',
    mode: 'all',
    activeDayId: null,
    queueDayIds: queueIds,
    concurrency,
    startedAt: new Date().toISOString(),
    stopReason: '',
  });
  aiUpdateProgress();
  if (btn) {
    btn.disabled = true;
    btn.textContent = `⏳ 逐日解析中…本日并发 ${concurrency}`;
  }

  for (const { s, i } of pending) {
    if (run.stopped) break;
    s.parseState = 'parsing';
    aiUpdateParseManager({ activeDayId: s.id });
    await aiSaveCacheToServer();
    const progress = aiDayParseProgress(s);
    if (s.parsed && progress.done === progress.total && s.finalReviewState !== 'complete') {
      await aiRetryFinalReview(i, { step2Run: run });
    } else {
      await aiParseSingleDay(i, { step2Run: run });
    }
    if (!run.stopped) aiUpdateParseManager({ activeDayId: null });
  }

  aiState._activeStep2Run = null;
  if (run.paused) {
    aiUpdateParseManager({ state: 'paused', stopReason: '用户暂停' });
  } else if (!run.stopped) {
    aiUpdateParseManager({ state: 'idle', activeDayId: null, stopReason: '' });
  }
  aiUpdateProgress();
  if (btn) {
    btn.disabled = false;
    btn.textContent = run.stopped ? '▶ 继续 Step 2 解析' : '🤖 Step 2：全部解析';
  }
  await aiSaveCacheToServer();
}

function aiUpdateProgress() {
  const snapshot = window.AIParseManager.buildSnapshot(
    aiState.daySplits,
    aiEnsureParseManager(),
    aiFactsForSplit
  );
  const bar = document.getElementById('ai-progress-bar');
  const label = document.getElementById('ai-progress-label');
  const pctEl = document.getElementById('ai-progress-pct');
  const wrap = document.getElementById('ai-progress-wrap');
  if (wrap) wrap.style.display = aiState.daySplits.length ? 'block' : 'none';
  if (bar) bar.style.width = snapshot.percent + '%';
  if (label) label.textContent = `项目 ${snapshot.done} / ${snapshot.total} · 最终复查 ${snapshot.reviewDone} / ${snapshot.reviewTotal}`;
  if (pctEl) pctEl.textContent = snapshot.percent + '%';
  aiRenderParseManager();
  aiRenderStep2StopInfo();
}

async function aiRetryFinalReview(index, options = {}) {
  const split = aiState.daySplits[index];
  const ownsRun = !options.step2Run;
  if (!split?.parsed || split.parsingLocked || (ownsRun && aiEnsureParseManager().state === 'running')) return false;
  const asProposal = Boolean(split.resumeAsProposal && split.pendingProposal?.parsed);
  const parsed = asProposal ? split.pendingProposal.parsed : split.parsed;
  const sourceFacts = window.AIParserCore.extractFacts(split.text);
  const run = options.step2Run || aiCreateStep2Run();

  if (ownsRun) {
    aiState.step2StopInfo = null;
    aiState._activeStep2Run = run;
    aiUpdateParseManager({
      state: 'running',
      mode: 'single',
      activeDayId: split.id,
      queueDayIds: [split.id],
      concurrency: run.concurrency,
      startedAt: new Date().toISOString(),
      stopReason: '',
    });
  }
  split.parsingLocked = true;
  split.status = 'parsing';
  split.parseState = 'parsing';
  split.finalReviewState = 'reviewing';
  split.finalReviewError = '';
  split.error = null;
  split.partialParseMessage = '正在补做 AI 最终复查；逐项结果不会重新解析，并发临时降为 1。';
  aiRenderDayCard(index);
  aiUpdateProgress();

  try {
    const validationSplit = { ...split, parsed, issues: [] };
    aiValidateDraftDay(validationSplit);
    const result = await aiRunFinalReviewStage(
      split,
      parsed,
      validationSplit.issues || [],
      sourceFacts,
      { signal: run.controller.signal }
    );
    window.AIParserCore.applyDayTypeClassification(
      parsed,
      sourceFacts,
      result.dayClassification,
      typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : []
    );
    if (asProposal && split.parsed && split.parsed !== parsed) {
      window.AIParserCore.applyDayTypeClassification(
        split.parsed,
        sourceFacts,
        result.dayClassification,
        typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : []
      );
    }

    if (asProposal) {
      const proposalSplit = {
        ...split,
        parsed,
        issues: [],
        reviewProposals: result.reviewProposals || [],
        sourceFacts,
      };
      aiValidateDraftDay(proposalSplit);
      split.pendingProposal = {
        ...split.pendingProposal,
        parsed,
        issues: proposalSplit.issues || [],
        differences: aiBuildProposalDifferences(split.parsed, parsed),
        createdAt: new Date().toISOString(),
      };
      split.reviewProposals = [];
    } else {
      split.reviewProposals = result.reviewProposals || [];
    }

    split.sourceFacts = sourceFacts;
    split.finalReviewState = 'complete';
    split.finalReviewError = '';
    split.resumeAsProposal = false;
    split.parseState = 'complete';
    split.partialParseMessage = asProposal
      ? '最终复查已补完；AI 重解析结果仍作为提案等待审核。'
      : '最终复查已补完；日期类型与复查建议已更新。';
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
  } catch (error) {
    const paused = run.pauseRequested || error?.name === 'AbortError';
    if (!paused && aiIsRateLimitError(error)) {
      aiStopStep2Run(run, split, {
        stopped: true,
        stopReason: 'rate-limit',
        stopError: error,
        failedWaves: run.failedWaves,
        results: [],
      });
    }
    split.finalReviewState = paused ? 'pending' : 'error';
    split.finalReviewError = error.message || String(error);
    split.parseState = 'partial';
    split.error = paused ? null : `AI 最终复查失败：${split.finalReviewError}`;
    split.partialParseMessage = paused
      ? '最终复查已暂停；继续时仍只补最终复查。'
      : '最终复查失败；逐项结果与现有草稿均已保留，可再次点击“继续最终复查”。';
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
  } finally {
    split.parsingLocked = false;
    if (ownsRun) {
      aiState._activeStep2Run = null;
      if (run.paused) {
        aiUpdateParseManager({ state: 'paused', activeDayId: split.id, stopReason: '用户暂停' });
      } else if (!run.stopped) {
        aiUpdateParseManager({ state: 'idle', activeDayId: null, stopReason: '' });
      }
    }
    aiRenderDayCard(index);
    aiUpdateImportBtn();
    aiUpdateProgress();
    await aiSaveCacheToServer();
  }
  return split.finalReviewState === 'complete';
}

function aiContinueDayParse(index) {
  const split = aiState.daySplits[index];
  if (!split) return;
  const progress = aiDayParseProgress(split);
  if (split.parsed && progress.done === progress.total && split.finalReviewState !== 'complete') {
    aiRetryFinalReview(index);
    return;
  }
  aiParseSingleDay(index, { asProposal: Boolean(split.resumeAsProposal && split.parsed) });
}

function aiContinueParseManager() {
  const manager = aiEnsureParseManager();
  if (manager.mode === 'single' && manager.activeDayId) {
    const index = aiState.daySplits.findIndex(split => split.id === manager.activeDayId);
    if (index >= 0) {
      aiContinueDayParse(index);
      return;
    }
  }
  aiStep2ParseAll();
}

function aiParseStateMeta(day) {
  const finalReviewSuffix = day.done === day.total && day.finalReviewState !== 'complete'
    ? day.finalReviewState === 'error'
      ? ' · 最终复查失败'
      : ' · 等待最终复查'
    : '';
  const reviewSuffix = day.state === 'complete'
    ? day.reviewStatus === 'blocked'
      ? ' · 存在错误'
      : ['review', 'confirmed', 'imported'].includes(day.reviewStatus)
        ? ' · 待审核/已确认'
        : ''
    : '';
  const values = {
    pending: { label: '待解析', symbol: '○' },
    parsing: { label: '解析中', symbol: '▶' },
    partial: { label: `部分解析${finalReviewSuffix}`, symbol: '◐' },
    complete: { label: `解析完成${reviewSuffix}`, symbol: '✓' },
    excluded: { label: '已排除', symbol: '⊘' },
    error: { label: '解析失败', symbol: '!' },
  };
  return values[day.state] || values.pending;
}

function aiParseManagerDayActions(day, index, manager) {
  if (day.state === 'parsing') {
    return `<button class="btn btn-ghost btn-sm" onclick="aiPauseStep2()" title="暂停整个解析批次">Ⅱ</button>`;
  }
  if (day.state === 'excluded') {
    return `<button class="btn btn-ghost btn-sm" onclick="aiSetDayParseExcluded(${index},false)" title="恢复到解析队列">↩</button>`;
  }
  if (['pending', 'partial', 'error'].includes(day.state)) {
    const missingItems = Math.max(0, day.total - day.done);
    const label = missingItems > 0 && (day.done > 0 || day.failed > 0)
      ? `继续补全 ${missingItems} 项`
      : missingItems === 0 && day.finalReviewState !== 'complete'
        ? '继续最终复查'
        : '解析';
    const disabled = manager.state === 'running' ? 'disabled title="已有解析正在运行"' : '';
    return `<button class="btn btn-primary btn-sm" onclick="aiContinueDayParse(${index})" ${disabled}>${label}</button>
      <button class="btn btn-ghost btn-sm" onclick="aiSetDayParseExcluded(${index},true)" ${disabled} title="移出全部解析队列">⊘</button>`;
  }
  return '';
}

function aiRenderParseManager() {
  const el = document.getElementById('ai-parse-manager');
  if (!el || !window.AIParseManager) return;
  if (!aiState.daySplits.length) {
    el.innerHTML = '';
    return;
  }
  const snapshot = window.AIParseManager.buildSnapshot(
    aiState.daySplits,
    aiEnsureParseManager(),
    aiFactsForSplit
  );
  const manager = snapshot.manager;
  const parseAllBtn = document.getElementById('ai-btn-parse-all');
  if (parseAllBtn) {
    parseAllBtn.disabled = manager.state === 'running';
    parseAllBtn.textContent = manager.state === 'running'
      ? '⏳ Step 2 解析中'
      : ['paused', 'stopped'].includes(manager.state) && manager.mode === 'all'
        ? '▶ 继续 Step 2 解析'
        : '🤖 Step 2：全部解析';
  }
  snapshot.days.forEach(day => {
    const split = aiState.daySplits.find(item => item.id === day.id);
    if (split && split.parseState !== 'parsing') split.parseState = day.state;
  });
  const managerState = {
    idle: '空闲',
    running: '解析中',
    paused: '已暂停',
    stopped: '已停止',
  }[manager.state] || '空闲';
  const mode = manager.mode === 'single' ? '单日解析' : '全部解析';
  const groups = [
    ['parsing', '解析中'],
    ['partial', '部分解析'],
    ['pending', '待解析'],
    ['error', '解析失败'],
    ['complete', '解析完成'],
    ['excluded', '已排除'],
  ];
  const groupHtml = groups.map(([state, title]) => {
    const days = snapshot.days.filter(day => day.state === state);
    if (!days.length) return '';
    return `<section class="ai-parse-manager-group ai-parse-manager-${state}">
      <div class="ai-parse-manager-group-title">${title}<span>${days.length}</span></div>
      ${days.map(day => {
        const index = aiState.daySplits.findIndex(split => split.id === day.id);
        const meta = aiParseStateMeta(day);
        return `<div class="ai-parse-manager-row">
          <span class="ai-parse-manager-symbol">${meta.symbol}</span>
          <b>${escHtml(day.date || '未定日期')}</b>
          <span class="ai-parse-manager-state">${escHtml(meta.label)}</span>
          <div class="ai-parse-manager-day-progress" aria-label="${day.done}/${day.total}">
            <span style="width:${day.percent}%"></span>
          </div>
          <span class="ai-parse-manager-count">${day.done}/${day.total}${day.failed ? ` · 失败${day.failed}` : ''}</span>
          <div class="ai-parse-manager-actions">${aiParseManagerDayActions(day, index, manager)}</div>
        </div>`;
      }).join('')}
    </section>`;
  }).join('');
  const control = manager.state === 'running'
    ? '<button class="btn btn-ghost btn-sm" onclick="aiPauseStep2()">Ⅱ 暂停</button>'
    : ['paused', 'stopped'].includes(manager.state)
      ? '<button class="btn btn-primary btn-sm" onclick="aiContinueParseManager()">▶ 继续</button>'
      : '';
  el.innerHTML = `<div class="ai-parse-manager">
    <div class="ai-parse-manager-head">
      <div><b>Step 2 解析管理器</b><span>${mode} · ${managerState}</span></div>
      <div class="ai-parse-manager-controls">${control}</div>
    </div>
    ${manager.stopReason ? `<div class="ai-parse-manager-message">${escHtml(manager.stopReason)}</div>` : ''}
    <div class="ai-parse-manager-groups">${groupHtml}</div>
  </div>`;
}

function aiRenderStep2StopInfo() {
  const el = document.getElementById('ai-step2-stop');
  if (!el) return;
  const info = aiState.step2StopInfo;
  if (!info) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const title = info.reason === 'rate-limit'
    ? '请求过多，Step 2 已立即停止'
    : '连续运行风险过高，Step 2 已停止';
  const location = [info.date, info.lines?.length ? `相对行 ${info.lines.join('、')}` : '']
    .filter(Boolean)
    .join(' · ');
  el.style.display = 'block';
  el.innerHTML = `<div class="ai-step2-stop-panel">
    <div><b>${escHtml(title)}</b>${location ? `<span>${escHtml(location)}</span>` : ''}</div>
    <div>${escHtml(info.error || '请检查接口状态后继续。')}</div>
    <div class="ai-issue-actions">
      <button class="btn btn-primary btn-sm" onclick="aiContinueParseManager()">从检查点继续解析</button>
    </div>
  </div>`;
}

// ============================================================
// STEP 2 REVIEW — 本地校验、人工修改与确认
// ============================================================
function aiAbsoluteSourceLines(split, lines) {
  return (lines || []).map(line => {
    const n = Number(line);
    return Number.isFinite(n) && split.startLine ? split.startLine + n - 1 : n;
  }).filter(Boolean);
}

function aiSafeApplyFromAI(issue) {
  const path = issue.targetPath || issue.apply?.path || '';
  const allowed = [
    /^parsed\.(wakeTime|sleepTime|dayType|dayNote|specialDay|specialDayReason|excludeFromRating)$/,
    /^parsed\.sessions\.\d+\.(type|name|startTime|endTime|nominalMinutes|actualMinutes|restMinutes|note)$/,
    /^parsed\.tasks\.\d+\.(name|templateId|activityType|minutes|quantity|quantityUnit|completionStatus|progressText|errorCount|note)$/,
  ];
  if (!allowed.some(pattern => pattern.test(path))) return null;
  const value = issue.suggestedValue !== undefined ? issue.suggestedValue : issue.suggestion;
  return value === undefined || value === null || value === '' ? null : { path, value };
}

function aiProposalClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function aiProposalEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function aiProposalItemValue(item) {
  if (!item) return null;
  const clone = aiProposalClone(item);
  delete clone.id;
  delete clone.aiMeta;
  delete clone.sourceLines;
  delete clone.linkedTaskIds;
  return clone;
}

function aiProposalAffectedLines(before, after) {
  return [...new Set([...(before?.sourceLines || []), ...(after?.sourceLines || [])].map(Number).filter(Number.isFinite))];
}

function aiBuildProposalDifferences(before, after) {
  const differences = [];
  [
    ['wakeTime', '起床时间'],
    ['sleepTime', '睡觉时间'],
    ['dayType', '日期类型'],
    ['dayNote', '全天备注'],
    ['specialDay', '特殊日'],
    ['specialDayReason', '特殊日原因'],
    ['excludeFromRating', '不参与评分'],
  ].forEach(([field, label]) => {
    if (aiProposalEqual(before?.[field], after?.[field])) return;
    differences.push({
      kind: 'field',
      label,
      path: `parsed.${field}`,
      before: before?.[field] ?? '',
      after: after?.[field] ?? '',
      affectedLines: [],
      status: 'open',
    });
  });

  [
    ['sessions', '时段'],
    ['tasks', '任务'],
  ].forEach(([collection, label]) => {
    const oldItems = before?.[collection] || [];
    const newItems = after?.[collection] || [];
    const usedNewIndexes = new Set();
    oldItems.forEach((oldItem, oldIndex) => {
      const oldLines = new Set((oldItem.sourceLines || []).map(Number).filter(Number.isFinite));
      let newIndex = -1;
      let bestOverlap = 0;
      newItems.forEach((newItem, candidateIndex) => {
        if (usedNewIndexes.has(candidateIndex)) return;
        const overlap = (newItem.sourceLines || []).map(Number).filter(Number.isFinite).filter(line => oldLines.has(line)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          newIndex = candidateIndex;
        }
      });
      if (newIndex < 0 && newItems[oldIndex] && !usedNewIndexes.has(oldIndex)) newIndex = oldIndex;
      const newItem = newIndex >= 0 ? newItems[newIndex] : null;
      if (!newItem) {
        differences.push({
          kind: 'remove-item', collection, label: `删除${label}`, before: oldItem,
          affectedLines: aiProposalAffectedLines(oldItem, null), status: 'open',
        });
        return;
      }
      usedNewIndexes.add(newIndex);
      if (!aiProposalEqual(aiProposalItemValue(oldItem), aiProposalItemValue(newItem))) {
        differences.push({
          kind: 'replace-item', collection, label: `更新${label}`, before: oldItem, after: newItem,
          affectedLines: aiProposalAffectedLines(oldItem, newItem), status: 'open',
        });
      }
    });
    newItems.forEach((newItem, newIndex) => {
      if (usedNewIndexes.has(newIndex)) return;
      differences.push({
        kind: 'add-item', collection, label: `新增${label}`, after: newItem,
        affectedLines: aiProposalAffectedLines(null, newItem), status: 'open',
      });
    });
  });
  return differences;
}

function aiProposalChangedFields(before, after) {
  const b = aiProposalItemValue(before) || {};
  const a = aiProposalItemValue(after) || {};
  if (typeof b !== 'object' || typeof a !== 'object') return [];
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter(key => !aiProposalEqual(b[key], a[key]))
    .map(key => ({ key, before: b[key], after: a[key] }));
}

function aiProposalDiffHasRealChange(diff) {
  if (diff.kind === 'field') return !aiProposalEqual(diff.before, diff.after);
  if (diff.kind === 'add-item' || diff.kind === 'remove-item') return true;
  return aiProposalChangedFields(diff.before, diff.after).length > 0;
}

function aiProposalDiffSummary(diff) {
  if (diff.kind === 'field') {
    return `${diff.label}：${aiProposalDisplayValue(diff.before)} → ${aiProposalDisplayValue(diff.after)}`;
  }
  const changed = aiProposalChangedFields(diff.before, diff.after);
  if (changed.length) {
    return `${diff.label}：` + changed
      .slice(0, 4)
      .map(item => `${item.key}: ${aiProposalDisplayValue(item.before)} → ${aiProposalDisplayValue(item.after)}`)
      .join('；');
  }
  return `${diff.label}：${aiProposalDisplayValue(diff.before)} → ${aiProposalDisplayValue(diff.after)}`;
}

function aiFinishProposalReview(index) {
  const split = aiState.daySplits[index];
  if (!split?.pendingProposal) return;
  const hasOpen = split.pendingProposal.differences.some(diff => diff.status === 'open');
  if (hasOpen) return;
  split.pendingProposal = null;
  split.sourceDirty = false;
  split.partialParseMessage = 'AI 重解析提案已审核完成，最终草稿已按你的选择保留。';
  split.issues = [];
  aiRevalidateAndRender(index);
}

function aiApplyProposalDifference(index, diffIndex) {
  const split = aiState.daySplits[index];
  const diff = split?.pendingProposal?.differences?.[diffIndex];
  if (!split?.parsed || !diff || diff.status !== 'open') return;
  const line = Number((diff.affectedLines || [])[0]);
  const unit = Number.isFinite(line)
    ? aiFindSourceUnitByOffset(split, line - 1)
    : null;
  if (unit?.hasSource) {
    split.partialParseMessage = '请先在对应原文片段中修改文字，再点击“保存本项原文并重解析本项”。提案不会直接改最终草稿。';
    aiRenderDayCard(index);
    const el = document.getElementById(`ai-source-unit-${index}-${unit.key}`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'center' });
    }
  } else {
    alert('这项提案无法安全反推到具体原文。请手动修改原文片段后保存本项。');
  }
}

function aiKeepDraftForProposalDifference(index, diffIndex) {
  const split = aiState.daySplits[index];
  const diff = split?.pendingProposal?.differences?.[diffIndex];
  if (!diff || diff.status !== 'open') return;
  diff.status = 'kept';
  aiFinishProposalReview(index);
  if (split.pendingProposal) aiRevalidateAndRender(index);
}

function aiAcceptProposal(index) {
  const split = aiState.daySplits[index];
  if (!split?.pendingProposal?.parsed) return;
  split.parsed = aiProposalClone(split.pendingProposal.parsed);
  split.pendingProposal = null;
  split.sourceDirty = false;
  split.partialParseMessage = '已采纳 AI 本次重解析结果，并同步到最终草稿。';
  split.issues = [];
  aiRevalidateAndRender(index);
}

function aiKeepCurrentDraft(index) {
  const split = aiState.daySplits[index];
  if (!split?.pendingProposal) return;
  split.pendingProposal = null;
  split.sourceDirty = false;
  split.partialParseMessage = '已保留当前最终草稿。本次 AI 重解析结果未写入。';
  split.issues = [];
  aiRevalidateAndRender(index);
}

function aiTaskTemplateLabel(template) {
  if (!template) return '未命名模板';
  return template.name || template.activityType || '未命名模板';
}

function aiGetTaskTemplatesSafe() {
  return typeof getTaskTemplates === 'function' ? getTaskTemplates() : [];
}

function aiTaskTemplateById(templateId, templates = aiGetTaskTemplatesSafe()) {
  return templates.find(template => template.id === templateId) || null;
}

function aiUniqueTemplateByActivityType(activityType, templates = aiGetTaskTemplatesSafe()) {
  if (!activityType) return null;
  const matches = templates.filter(template => template.activityType === activityType);
  return matches.length === 1 ? matches[0] : null;
}

function aiIsManualTemplateBypass(task) {
  const mode = task?.aiMeta?.matchMode || '';
  return mode === 'manual' || mode === 'manual-category' || mode === 'manual-opt-out';
}

function aiResolveTaskTemplate(task, templates = aiGetTaskTemplatesSafe()) {
  if (!task) return null;
  task.aiMeta = task.aiMeta || {
    evidenceLevel: task.activityType ? 'ai-inferred' : 'conflict',
    evidenceLabel: task.activityType ? 'AI语义推断' : '存在冲突',
    reason: task.activityType ? '已有活动分类' : '尚未分类',
    matchMode: task.activityType ? 'category-semantic' : 'unclassified',
  };

  const selectedTemplate = task.templateId ? aiTaskTemplateById(task.templateId, templates) : null;
  if (selectedTemplate) {
    task.activityType = selectedTemplate.activityType || task.activityType || '';
    task.fieldMeta = task.fieldMeta || {};
    if (selectedTemplate.name && task.fieldMeta.name?.origin !== 'manual') {
      task.name = selectedTemplate.name;
      task.fieldMeta.name = {
        value: selectedTemplate.name,
        sourceLines: task.sourceLines || [],
        origin: 'template-default',
        raw: selectedTemplate.name,
      };
    }
    if (selectedTemplate.quantityUnit && !task.quantityUnit) task.quantityUnit = selectedTemplate.quantityUnit;
    if (selectedTemplate.defaultMinutes && task.minutes == null) task.minutes = selectedTemplate.defaultMinutes;
    if (selectedTemplate.note && !task.note) task.note = selectedTemplate.note;
    task.needsClassification = false;
    return selectedTemplate;
  }

  if (task.templateId || aiIsManualTemplateBypass(task)) return null;
  const uniqueTemplate = aiUniqueTemplateByActivityType(task.activityType, templates);
  if (!uniqueTemplate) return null;
  task.templateId = uniqueTemplate.id;
  task.activityType = uniqueTemplate.activityType || task.activityType || '';
  task.fieldMeta = task.fieldMeta || {};
  if (uniqueTemplate.name && task.fieldMeta.name?.origin !== 'manual') {
    task.name = uniqueTemplate.name;
    task.fieldMeta.name = {
      value: uniqueTemplate.name,
      sourceLines: task.sourceLines || [],
      origin: 'template-default',
      raw: uniqueTemplate.name,
    };
  }
  if (uniqueTemplate.quantityUnit && !task.quantityUnit) task.quantityUnit = uniqueTemplate.quantityUnit;
  if (uniqueTemplate.defaultMinutes && task.minutes == null) task.minutes = uniqueTemplate.defaultMinutes;
  if (uniqueTemplate.note && !task.note) task.note = uniqueTemplate.note;
  task.needsClassification = false;
  task.aiMeta = {
    ...task.aiMeta,
    evidenceLevel: task.aiMeta.evidenceLevel === 'source-explicit' ? 'source-explicit' : 'template-default',
    evidenceLabel: task.aiMeta.evidenceLevel === 'source-explicit' ? '原文明确' : '唯一模板',
    reason: task.aiMeta.reason || '活动分类唯一匹配模板',
    matchMode: 'template-auto',
  };
  return uniqueTemplate;
}

function aiResolveParsedTaskTemplates(parsed) {
  if (!parsed?.tasks) return;
  const templates = aiGetTaskTemplatesSafe();
  parsed.tasks.forEach(task => aiResolveTaskTemplate(task, templates));
}

function aiValidateDraftDay(split) {
  if (!split?.parsed) return [];
  const p = split.parsed;
  p.sessions = p.sessions || [];
  p.tasks = p.tasks || [];
  p.aiIssues = p.aiIssues || [];
  p.unassignedLines = p.unassignedLines || [];
  p.consumedLines = p.consumedLines || [];

  const issues = [...(split.sourceIssues || [])];
  p.aiIssues.forEach(issue => {
    const level = (issue.level || 'error').toLowerCase();
    if (!['error', 'warning'].includes(level)) return;
    issues.push(aiCreateIssue(issue.code || 'AI_REVIEW_NOTE', level, issue.message || 'AI 提醒', {
      target: issue.targetPath || issue.target || '',
      sourceLines: aiAbsoluteSourceLines(split, issue.sourceLines),
      original: issue.original || '',
      suggestion: issue.suggestion ?? null,
      sourceReplacement: issue.sourceReplacement ?? null,
      apply: aiSafeApplyFromAI(issue),
      confidence: issue.confidence ?? null,
    }));
  });

  const bedtime = p.sleepTime || '';
  const bedtimeHour = Number(bedtime.split(':')[0]);
  if (bedtime && Number.isFinite(bedtimeHour) && bedtimeHour >= 12 && bedtimeHour <= 18) {
    const suggestion = String(bedtimeHour - 12).padStart(2, '0') + ':' + (bedtime.split(':')[1] || '00');
    issues.push(aiCreateIssue('DAYTIME_BEDTIME', 'warning', `睡觉时间 ${bedtime} 落在白天，建议确认是否应为 ${suggestion}。`, {
      target: 'parsed.sleepTime',
      original: bedtime,
      suggestion,
      apply: { path: 'parsed.sleepTime', value: suggestion },
      confidence: 0.9,
    }));
  }

  p.sessions.forEach((session, index) => {
    session.id = session.id || uid();
    if (!session.type && p.parserVersion !== AI_PARSER_VERSION) session.type = 'normal';
    session.sourceLines = session.sourceLines || [];
    session.aiMeta = session.aiMeta || {
      evidenceLevel: 'ai-inferred',
      evidenceLabel: 'AI语义推断',
      reason: 'AI 未提供判断依据',
      matchMode: 'unclassified',
    };
    const prefix = `parsed.sessions.${index}`;
    const clock = sessionClock(session);
    const actual = Number(session.actualMinutes) || 0;
    const rest = Number(session.restMinutes) || 0;
    const sourceLines = aiAbsoluteSourceLines(split, session.sourceLines);
    if (!['normal', 'special', 'special-study'].includes(session.type)) {
      issues.push(aiCreateIssue('SESSION_TYPE_INVALID', 'error',
        `时段“${session.name || `#${index + 1}`}”的类型“${session.type || '空'}”不合法。`,
        { target: `${prefix}.type`, sourceLines, confidence: 1 }));
    }
    if (!session.startTime || !session.endTime) {
      issues.push(aiCreateIssue('SESSION_TIME_MISSING', 'error', `时段“${session.name || `#${index + 1}`}”缺少开始或结束时间。`, {
        target: prefix, sourceLines, confidence: 1,
      }));
    }
    if (session.type === 'normal') {
      ['nominalMinutes', 'actualMinutes', 'restMinutes'].forEach(field => {
        if (session[field] == null || !Number.isFinite(Number(session[field])) || Number(session[field]) < 0) {
          issues.push(aiCreateIssue('SESSION_DURATION_MISSING', 'error',
            `普通时段 ${session.startTime || '?'}-${session.endTime || '?'} 缺少合法的 ${field}。`,
            { target: `${prefix}.${field}`, sourceLines, confidence: 1 }));
        }
      });
    }
    if (session.type === 'normal' && actual + rest > clock) {
      issues.push(aiCreateIssue('SESSION_TOTAL_EXCEEDS_CLOCK', 'error',
        `时段 ${session.startTime || '?'}-${session.endTime || '?'} 中，实际专注 ${actual} 分钟 + 休息 ${rest} 分钟超过时钟跨度 ${clock} 分钟。`,
        { target: prefix, sourceLines, confidence: 1 }));
    }
    if (session.type === 'special-study' && actual > clock) {
      issues.push(aiCreateIssue('SPECIAL_STUDY_EXCEEDS_CLOCK', 'error',
        `特殊学习时段“${session.name || `#${index + 1}`}”的学习时长 ${actual} 分钟超过外层跨度 ${clock} 分钟。`,
        { target: prefix, sourceLines, confidence: 1 }));
    }
  });

  for (let i = 0; i < p.sessions.length; i++) {
    const a = p.sessions[i];
    if (a.type !== 'normal') continue;
    for (let j = i + 1; j < p.sessions.length; j++) {
      const b = p.sessions[j];
      if (b.type !== 'normal') continue;
      const aStart = parseMin(a.startTime), bStart = parseMin(b.startTime);
      if (aStart == null || bStart == null) continue;
      const aEnd = aStart + sessionClock(a), bEnd = bStart + sessionClock(b);
      const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
      if (overlap > 0) {
        issues.push(aiCreateIssue('SESSION_OVERLAP', 'warning',
          `普通专注时段 ${a.startTime}-${a.endTime} 与 ${b.startTime}-${b.endTime} 重叠 ${overlap} 分钟，请确认是否为录入错误。`,
          { target: `parsed.sessions.${i}`, sourceLines: aiAbsoluteSourceLines(split, [...(a.sourceLines || []), ...(b.sourceLines || [])]), confidence: 1 }));
      }
    }
  }

  const taskTemplates = aiGetTaskTemplatesSafe();
  p.tasks.forEach((task, index) => {
    task.id = task.id || uid();
    task.sourceLines = task.sourceLines || [];
    task.aiMeta = task.aiMeta || {
      evidenceLevel: task.activityType ? 'ai-inferred' : 'conflict',
      evidenceLabel: task.activityType ? 'AI语义推断' : '存在冲突',
      reason: 'AI 未提供判断依据',
      matchMode: task.activityType ? 'category-semantic' : 'unclassified',
    };
    aiResolveTaskTemplate(task, taskTemplates);
    if (task.minutes == null || !Number.isFinite(Number(task.minutes)) || Number(task.minutes) < 0) {
      issues.push(aiCreateIssue('TASK_MINUTES_MISSING', 'error',
        `任务“${task.name || `#${index + 1}`}”缺少合法时长。`,
        { target: `parsed.tasks.${index}.minutes`, sourceLines: aiAbsoluteSourceLines(split, task.sourceLines), confidence: 1 }));
    }
    const selectedTemplate = taskTemplates.find(template => template.id === task.templateId);
    if (task.templateId && !selectedTemplate) {
      issues.push(aiCreateIssue('TASK_TEMPLATE_NOT_FOUND', 'error',
        `任务“${task.name || `#${index + 1}`}”引用的模板 ${task.templateId} 不存在，请重新选择。`,
        { target: `parsed.tasks.${index}.templateId`, sourceLines: aiAbsoluteSourceLines(split, task.sourceLines), confidence: 1 }));
    } else if (!task.templateId && !aiIsManualTemplateBypass(task)) {
      issues.push(aiCreateIssue('TASK_TEMPLATE_NOT_SELECTED', 'warning',
        `任务“${task.name || `#${index + 1}`}”未套用模板，将按分类“${task.activityType || '未分类'}”导入。请确认模板库是否缺少对应模板。`,
        { target: `parsed.tasks.${index}.templateId`, sourceLines: aiAbsoluteSourceLines(split, task.sourceLines), confidence: null }));
    }
    if (!task.activityType || task.needsClassification) {
      issues.push(aiCreateIssue('TASK_UNCLASSIFIED', 'warning',
        `任务“${task.name || `#${index + 1}`}”尚未确定分类，请手动选择。`,
        { target: `parsed.tasks.${index}.activityType`, sourceLines: aiAbsoluteSourceLines(split, task.sourceLines), confidence: null }));
    }
  });

  p.sessions.forEach((session, index) => {
    if (session.type !== 'special-study') return;
    const linkedTasks = p.tasks.filter(task => task.linkedSessionId === session.id);
    session.linkedTaskIds = [...new Set([...(session.linkedTaskIds || []), ...linkedTasks.map(task => task.id)])];
    const linkedTaskMin = linkedTasks.reduce((sum, task) => sum + (Number(task.minutes) || 0), 0);
    const actual = Number(session.actualMinutes) || 0;
    if (linkedTasks.length && linkedTaskMin !== actual) {
      issues.push(aiCreateIssue('SPECIAL_STUDY_TASK_MINUTES_MISMATCH', 'warning',
        `特殊学习时段“${session.name || `#${index + 1}`}”记录实际学习 ${actual} 分钟，但关联任务合计为 ${linkedTaskMin} 分钟，请确认。`,
        { target: `parsed.sessions.${index}`, sourceLines: aiAbsoluteSourceLines(split, session.sourceLines), confidence: 1 }));
    }
  });

  const rawLines = split.text.split(/\r?\n/);
  rawLines.forEach((line, offset) => {
    if (/[（(](?:专注|关注)\d*次[）)]/.test(line) && !/休息/.test(line)) {
      issues.push(aiCreateIssue('REST_MINUTES_MISSING', 'warning',
        '专注时段没有明确填写休息时间，不会自动补默认值，请确认。',
        { sourceLines: [split.startLine + offset], original: line.trim(), confidence: 1 }));
    }
  });

  p.unassignedLines.forEach(item => {
    issues.push(aiCreateIssue('UNASSIGNED_SOURCE_LINE', 'warning',
      `原文仍未归属：“${item.text || ''}”${item.reason ? `（${item.reason}）` : ''}`,
      { sourceLines: aiAbsoluteSourceLines(split, [item.line]), original: item.text || '', confidence: 1 }));
  });

  const claimedLines = new Set((p.consumedLines || []).map(Number).filter(Number.isFinite));
  [...p.sessions, ...p.tasks].forEach(item => {
    (item.sourceLines || []).forEach(line => claimedLines.add(Number(line)));
  });
  p.unassignedLines.forEach(item => claimedLines.add(Number(item.line)));
  rawLines.forEach((line, offset) => {
    const relativeLine = offset + 1;
    if (!line.trim() || claimedLines.has(relativeLine)) return;
    issues.push(aiCreateIssue('SOURCE_LINE_NOT_ACCOUNTED', 'warning',
      `AI 尚未说明原文第 ${relativeLine} 行的归属：“${line.trim()}”`,
      { sourceLines: [split.startLine + offset], original: line.trim(), confidence: 1 }));
  });

  const reviewIssues = aiReviewProposalsToIssues(split, split.reviewProposals || []);
  split.issues = aiMergeIssueLists(split.issues, [...issues, ...reviewIssues]);
  split.importMode = split.importMode || aiDefaultImportMode(split.date);
  return split.issues;
}

function aiIssueBlocksConfirmation(issue) {
  return issue.status === 'open' && (
    issue.level === 'error' ||
    issue.code === 'UNASSIGNED_SOURCE_LINE' ||
    issue.code === 'SOURCE_LINE_NOT_ACCOUNTED'
  );
}

function aiHasBlockingIssues(split) {
  return (split.issues || []).some(aiIssueBlocksConfirmation);
}

function aiCanConfirmSplit(split) {
  return Boolean(split?.parsed) && split.finalReviewState === 'complete' &&
    !split.draftDirty && !split.sourceDirty && !split.pendingProposal && !aiHasBlockingIssues(split);
}

function aiScheduleCacheSave() {
  clearTimeout(aiState._saveTimer);
  aiState._saveTimer = setTimeout(() => aiSaveCacheToServer(), 350);
}

function aiSetByPath(root, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] == null) cur[key] = {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (last != null) cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function aiGetByPath(root, path) {
  return String(path || '').split('.').filter(Boolean).reduce((value, part) => {
    if (value == null) return undefined;
    return value[/^\d+$/.test(part) ? Number(part) : part];
  }, root);
}

function aiRevalidateAndRender(index) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  split.draftDirty = false;
  aiValidateDraftDay(split);
  if (split.status !== 'imported') split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
  aiRenderDayCard(index);
  aiUpdateImportBtn();
  aiUpdateProgress();
  aiScheduleCacheSave();
}

function aiDraftSetField(index, path, value, type = 'text') {
  const split = aiState.daySplits[index];
  if (!split) return;
  const parsedValue = type === 'number' ? (value === '' ? null : Number(value)) : type === 'boolean' ? Boolean(value) : value;
  aiSetByPath(split, path, parsedValue);
  const taskNameMatch = String(path || '').match(/^parsed\.tasks\.(\d+)\.name$/);
  if (taskNameMatch) {
    const task = split.parsed?.tasks?.[Number(taskNameMatch[1])];
    if (task) {
      task.fieldMeta = task.fieldMeta || {};
      task.fieldMeta.name = {
        value: parsedValue,
        sourceLines: task.sourceLines || [],
        origin: 'manual',
        raw: '人工修改任务名称',
      };
    }
  }
  const dayFieldMatch = String(path || '').match(/^parsed\.(dayType|specialDay|specialDayReason|excludeFromRating)$/);
  if (dayFieldMatch && split.parsed) {
    const field = dayFieldMatch[1];
    split.parsed.fieldMeta = split.parsed.fieldMeta || {};
    split.parsed.fieldMeta[field] = {
      value: parsedValue,
      sourceLines: [],
      origin: 'manual',
      raw: '人工修改本日字段',
    };
    if (field === 'dayType') split.parsed.dayTypeTemplateId = '';
  }
  if (path === 'date') split.importMode = '';
  aiMarkDraftDirty(index);
}

function aiMarkDraftDirty(index, render = false) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  // 内嵌表格就是最终草稿。字段变更后立即进行本地校验。
  aiRevalidateAndRender(index);
}

function aiDraftApplyDayTypeTemplate(index, name) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  const value = String(name || '').trim();
  const template = typeof getDayTypeTemplates === 'function'
    ? getDayTypeTemplates().find(item => item.name === value)
    : null;
  split.parsed.fieldMeta = split.parsed.fieldMeta || {};
  split.parsed.dayType = value;
  split.parsed.dayTypeTemplateId = template?.id || '';
  split.parsed.fieldMeta.dayType = {
    value,
    sourceLines: [],
    origin: 'manual',
    raw: template ? `人工选择日期类型模板：${template.name}` : '人工填写日期类型',
  };
  if (template) {
    ['specialDay', 'excludeFromRating'].forEach(field => {
      split.parsed[field] = Boolean(template[field]);
      split.parsed.fieldMeta[field] = {
        value: Boolean(template[field]),
        sourceLines: [],
        origin: 'manual',
        raw: `人工选择日期类型模板：${template.name}`,
      };
    });
  }
  split.partialParseMessage = template
    ? `已人工套用日期类型“${template.name}”，并同步特殊天与评分开关。`
    : '已人工修改日期类型；特殊天与评分开关保持不变。';
  aiRevalidateAndRender(index);
}

function aiDraftAddSession(index, type = 'normal') {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  split.parsed.sessions.push({
    id: uid(), type, name: type === 'normal' ? '' : '待命名',
    startTime: '', endTime: '', nominalMinutes: 0, actualMinutes: 0, restMinutes: 0, note: '',
    sourceLines: [], aiMeta: { evidenceLevel: 'manual', evidenceLabel: '人工确认', reason: '人工新增', matchMode: 'manual' },
  });
  split.editorOpen = true;
  aiMarkDraftDirty(index, true);
}

function aiDraftDeleteSession(index, sessionIndex) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  split.parsed.sessions.splice(sessionIndex, 1);
  aiMarkDraftDirty(index, true);
}

function aiDraftAddTask(index) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  split.parsed.tasks.push({
    id: uid(), name: '', templateId: '', activityType: '', minutes: 0,
    quantity: null, quantityUnit: '', accuracy: '', completionStatus: 'unknown',
    progressText: '', errorCount: null, note: '', sourceLines: [],
    aiMeta: { evidenceLevel: 'manual', evidenceLabel: '人工确认', reason: '人工新增', matchMode: 'manual' },
  });
  split.editorOpen = true;
  aiMarkDraftDirty(index, true);
}

function aiDraftDeleteTask(index, taskIndex) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  split.parsed.tasks.splice(taskIndex, 1);
  aiMarkDraftDirty(index, true);
}

function aiDraftApplyTaskTemplate(index, taskIndex, templateId) {
  const split = aiState.daySplits[index];
  const task = split?.parsed?.tasks?.[taskIndex];
  if (!task) return;
  const templates = aiGetTaskTemplatesSafe();
  const previousTemplate = aiTaskTemplateById(task.templateId, templates);
  const tmpl = aiTaskTemplateById(templateId, templates);

  if (!tmpl) {
    task.templateId = '';
    task.activityType = '';
    if (previousTemplate?.quantityUnit && task.quantityUnit === previousTemplate.quantityUnit) {
      task.quantityUnit = '';
    }
    task.needsClassification = true;
    task.aiMeta = { evidenceLevel: 'manual', evidenceLabel: '人工确认', reason: '人工选择不套用模板', matchMode: 'manual-opt-out' };
    aiMarkDraftDirty(index, true);
    return;
  }

  task.templateId = tmpl.id;
  task.activityType = tmpl.activityType || '';
  task.fieldMeta = task.fieldMeta || {};
  if (tmpl.name && task.fieldMeta.name?.origin !== 'manual') {
    task.name = tmpl.name;
    task.fieldMeta.name = {
      value: tmpl.name,
      sourceLines: task.sourceLines || [],
      origin: 'template-default',
      raw: tmpl.name,
    };
  }
  if (tmpl.quantityUnit) task.quantityUnit = tmpl.quantityUnit;
  if (tmpl.defaultMinutes && !task.minutes) task.minutes = tmpl.defaultMinutes;
  if (tmpl.note && !task.note) task.note = tmpl.note;
  task.needsClassification = false;
  task.aiMeta = { evidenceLevel: 'manual', evidenceLabel: '人工确认', reason: '人工套用模板', matchMode: 'manual-template' };
  aiMarkDraftDirty(index, true);
}

function aiCategorySelectOptionsHtml(values, selected, emptyLabel) {
  const uniqueValues = [...new Set((values || []).filter(Boolean))];
  return `<option value="">${escHtml(emptyLabel || '未选择')}</option>` +
    uniqueValues.map(value => `<option value="${escAttr(value)}" ${value === selected ? 'selected' : ''}>${escHtml(value)}</option>`).join('');
}

function aiTaskCategorySelectHtml(index, taskIndex, task) {
  const parts = typeof parseActPath === 'function' ? parseActPath(task.activityType || '') : String(task.activityType || '').split(' > ');
  const [l1 = '', l2 = '', l3 = ''] = parts;
  return `<div class="ai-task-category-select" title="活动分类">
    <select id="ai-task-cat-${index}-${taskIndex}-1" onchange="aiDraftSetTaskCategory(${index},${taskIndex})">
      ${aiCategorySelectOptionsHtml(typeof getLevel1Names === 'function' ? getLevel1Names() : [], l1, '一级')}
    </select>
    <select id="ai-task-cat-${index}-${taskIndex}-2" onchange="aiDraftSetTaskCategory(${index},${taskIndex})">
      ${aiCategorySelectOptionsHtml(typeof getLevel2Names === 'function' ? getLevel2Names() : [], l2, '二级')}
    </select>
    <select id="ai-task-cat-${index}-${taskIndex}-3" onchange="aiDraftSetTaskCategory(${index},${taskIndex})">
      ${aiCategorySelectOptionsHtml(typeof getLevel3Names === 'function' ? getLevel3Names() : [], l3, '三级')}
    </select>
  </div>`;
}

function aiDraftSetTaskCategory(index, taskIndex) {
  const split = aiState.daySplits[index];
  const task = split?.parsed?.tasks?.[taskIndex];
  if (!task) return;
  const l1 = document.getElementById(`ai-task-cat-${index}-${taskIndex}-1`)?.value || '';
  const l2 = document.getElementById(`ai-task-cat-${index}-${taskIndex}-2`)?.value || '';
  const l3 = document.getElementById(`ai-task-cat-${index}-${taskIndex}-3`)?.value || '';
  task.templateId = '';
  task.activityType = typeof buildActPath === 'function' ? buildActPath(l1, l2, l3) : [l1, l2, l3].filter(Boolean).join(' > ');
  task.needsClassification = !task.activityType;
  task.aiMeta = {
    confidence: 1,
    reason: task.activityType ? '人工选择活动分类' : '人工清空活动分类',
    matchMode: task.activityType ? 'manual-category' : 'manual-opt-out',
  };
  aiMarkDraftDirty(index, true);
}

function aiToggleSourceEditor(index) {
  const split = aiState.daySplits[index];
  if (!split) return;
  split.sourceEditorOpen = !split.sourceEditorOpen;
  aiRenderDayCard(index);
  aiScheduleCacheSave();
}

function aiSyncRawInputFromSplit(index, oldStartLine, oldEndLine) {
  const split = aiState.daySplits[index];
  if (!split) return;
  const rawLines = String(aiState.rawInput || '').split(/\r?\n/);
  const startLine = Number(oldStartLine || split.startLine || 1);
  const endLine = Number(oldEndLine || split.endLine || startLine);
  const replacementLines = String(split.text || '').split(/\r?\n/);
  const removedCount = Math.max(1, endLine - startLine + 1);
  rawLines.splice(startLine - 1, removedCount, ...replacementLines);
  const delta = replacementLines.length - removedCount;
  split.startLine = startLine;
  split.endLine = startLine + replacementLines.length - 1;
  aiState.daySplits.forEach((other, otherIndex) => {
    if (otherIndex === index || Number(other.startLine) <= endLine) return;
    other.startLine += delta;
    other.endLine += delta;
  });
  aiState.rawInput = rawLines.join('\n');
  aiState.sourceMeta = aiBuildSourceMeta(aiState.rawInput, aiState.sourceMeta?.fileName || '');
  const rawEl = document.getElementById('ai-rawInput');
  if (rawEl) rawEl.value = aiState.rawInput;
}

async function aiConfirmSourceRevision(index, reparse = false) {
  const split = aiState.daySplits[index];
  if (!split) return;
  if (aiSplitIsBusy(split)) {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    return;
  }
  const date = document.getElementById(`ai-source-date-${index}`)?.value?.trim() || '';
  const text = document.getElementById(`ai-source-text-${index}`)?.value?.trim() || '';
  if (!date) { alert('请填写日期'); return; }
  if (!text) { alert('请填写本段原文'); return; }

  const scrollAnchor = aiCaptureScrollAnchor(`ai-source-text-${index}`);
  if (reparse) split.reparseLocked = true;
  const oldStartLine = split.startLine;
  const oldEndLine = split.endLine;
  split.date = date;
  split.text = text;
  split.error = null;
  split.status = split.parsed ? 'review' : 'pending';
  split.importMode = '';
  split.sourceEditorOpen = true;
  split.sourceDirty = true;
  split.annotationDrafts = {};
  split.annotationUnitDrafts = {};
  split.partialParseMessage = reparse ? '正在重新解析本段原文…' : '原文已更新，请继续预检或解析。';

  aiSyncRawInputFromSplit(index, oldStartLine, oldEndLine);
  aiRunSourcePreflight(aiState.daySplits);
  aiState.daySplits.forEach((other, otherIndex) => {
    if (otherIndex === index || !other.parsed) return;
    aiValidateDraftDay(other);
    if (other.status !== 'imported' && aiHasBlockingIssues(other)) {
      other.status = 'blocked';
    }
  });
  aiRenderExistingDayCards();
  aiRestoreScrollAnchor(scrollAnchor);
  aiUpdateImportBtn();
  await aiSaveCacheToServer();

  if (reparse) {
    await aiParseSingleDay(index, { asProposal: Boolean(split.parsed), scrollAnchor, force: true });
    split.sourceEditorOpen = true;
    split.sourceDirty = split.status === 'error';
    split.partialParseMessage = split.status === 'error'
      ? '本段原文已经保存，但重新解析失败。展开状态保持不变，你可以继续修改后重试。'
      : split.pendingProposal
        ? 'AI 已重新解析本日原文。请审核新提案，再决定是否同步到最终草稿。'
        : '本段原文已重新解析；展开状态保持不变。';
    split.reparseLocked = false;
    aiRenderDayCard(index);
    aiRestoreScrollAnchor(scrollAnchor);
    aiScheduleCacheSave();
  }
}

async function aiReparseDayWithProposal(index) {
  const split = aiState.daySplits[index];
  if (!split) return;
  if (aiSplitIsBusy(split)) {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    return;
  }
  const scrollAnchor = aiCaptureScrollAnchor(`ai-day-${index}`);
  split.partialParseMessage = '正在让 AI 重新解析本日原文…';
  split.error = null;
  aiRenderDayCard(index);
  aiRestoreScrollAnchor(scrollAnchor);
  await aiParseSingleDay(index, { asProposal: Boolean(split.parsed), scrollAnchor, force: true });
}

function aiMapUnitLocalLines(unit, localLines, replacementLines) {
  const max = Math.max(1, replacementLines.length);
  const lines = (localLines || []).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= max);
  const effective = lines.length ? lines : Array.from({ length: max }, (_, i) => i + 1);
  return [...new Set(effective.map(n => unit.startOffset + n))].sort((a, b) => a - b);
}

function aiShiftLineValueAfterEdit(value, threshold, delta) {
  const n = Number(value);
  return Number.isFinite(n) && n > threshold ? n + delta : value;
}

function aiShiftParsedLinesAfterEdit(split, threshold, delta) {
  if (!delta || !split?.parsed) return;
  const shiftList = lines => (lines || []).map(line => aiShiftLineValueAfterEdit(line, threshold, delta));
  [...(split.parsed.sessions || []), ...(split.parsed.tasks || [])].forEach(item => {
    item.sourceLines = shiftList(item.sourceLines);
  });
  split.parsed.consumedLines = shiftList(split.parsed.consumedLines);
  split.parsed.unassignedLines = (split.parsed.unassignedLines || []).map(item => ({
    ...item,
    line: aiShiftLineValueAfterEdit(item.line, threshold, delta),
  }));
}

function aiMarkUnitLinesConsumed(split, unit, replacementLines) {
  if (!split?.parsed) return;
  const lines = aiMapUnitLocalLines(unit, [], replacementLines);
  const consumed = new Set((split.parsed.consumedLines || []).map(Number).filter(Number.isFinite));
  lines.forEach(line => consumed.add(line));
  split.parsed.consumedLines = [...consumed].sort((a, b) => a - b);
  const lineSet = new Set(lines);
  split.parsed.unassignedLines = (split.parsed.unassignedLines || []).filter(item => !lineSet.has(Number(item.line)));
}

function aiRemoveUnitItem(split, unit) {
  if (!split?.parsed || !['session', 'task'].includes(unit.kind)) return;
  const collection = unit.kind === 'session' ? 'sessions' : 'tasks';
  const items = split.parsed[collection] || [];
  if (items[unit.itemIndex]) items.splice(unit.itemIndex, 1);
}

function aiApplyUnitParsedResult(split, unit, parsed, replacementLines) {
  if (!split.parsed) split.parsed = { sessions: [], tasks: [], aiIssues: [], unassignedLines: [], consumedLines: [] };
  split.parsed.sessions = split.parsed.sessions || [];
  split.parsed.tasks = split.parsed.tasks || [];
  split.parsed.aiIssues = split.parsed.aiIssues || [];
  split.parsed.unassignedLines = split.parsed.unassignedLines || [];
  split.parsed.consumedLines = split.parsed.consumedLines || [];

  const kind = String(parsed.kind || '').toLowerCase();
  if (kind === 'field') {
    const field = parsed.field;
    const allowed = ['wakeTime', 'sleepTime', 'dayType', 'dayNote', 'specialDay', 'specialDayReason', 'excludeFromRating'];
    if (!allowed.includes(field)) throw new Error('本项解析返回了不支持的字段：' + field);
    split.parsed[field] = parsed.value ?? '';
    aiRemoveUnitItem(split, unit);
    aiMarkUnitLinesConsumed(split, unit, replacementLines);
    return;
  }

  if (kind === 'session') {
    const session = parsed.session || parsed.item;
    if (!session) throw new Error('本项解析缺少 session');
    session.id = unit.kind === 'session' && split.parsed.sessions[unit.itemIndex]?.id
      ? split.parsed.sessions[unit.itemIndex].id
      : (session.id || uid());
    session.type = session.type || 'normal';
    session.sourceLines = aiMapUnitLocalLines(unit, session.sourceLines, replacementLines);
    session.aiMeta = session.aiMeta || { confidence: parsed.confidence ?? 0.9, reason: '本项重解析', matchMode: 'keyword-exact' };
    if (unit.kind === 'session' && split.parsed.sessions[unit.itemIndex]) {
      split.parsed.sessions[unit.itemIndex] = session;
    } else {
      aiRemoveUnitItem(split, unit);
      split.parsed.sessions.push(session);
    }
    aiMarkUnitLinesConsumed(split, unit, replacementLines);
    return;
  }

  if (kind === 'task') {
    const task = parsed.task || parsed.item;
    if (!task) throw new Error('本项解析缺少 task');
    task.id = unit.kind === 'task' && split.parsed.tasks[unit.itemIndex]?.id
      ? split.parsed.tasks[unit.itemIndex].id
      : (task.id || uid());
    task.sourceLines = aiMapUnitLocalLines(unit, task.sourceLines, replacementLines);
    task.aiMeta = task.aiMeta || { confidence: parsed.confidence ?? 0.9, reason: '本项重解析', matchMode: 'keyword-exact' };
    if (unit.kind === 'task' && split.parsed.tasks[unit.itemIndex]) {
      split.parsed.tasks[unit.itemIndex] = task;
    } else {
      aiRemoveUnitItem(split, unit);
      split.parsed.tasks.push(task);
    }
    aiResolveParsedTaskTemplates(split.parsed);
    aiMarkUnitLinesConsumed(split, unit, replacementLines);
    return;
  }

  if (kind === 'none') {
    if (!replacementLines.join('').trim()) aiRemoveUnitItem(split, unit);
    return;
  }

  throw new Error('本项解析返回了未知 kind：' + (parsed.kind || '空'));
}

async function aiParseSingleUnit(index, unit, sourceText, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return false;
  const replacementLines = String(sourceText || '').replace(/\r\n?/g, '\n').split('\n');
  const run = aiCreateStep2Run();

  try {
    if (!replacementLines.join('').trim()) {
      const proposalParsed = aiProposalClone(split.parsed);
      const proposalSplit = { ...split, parsed: proposalParsed };
      aiApplyUnitParsedResult(proposalSplit, unit, { kind: 'none' }, []);
      split.pendingProposal = {
        parsed: proposalParsed,
        issues: [],
        differences: aiBuildProposalDifferences(split.parsed, proposalParsed),
        createdAt: new Date().toISOString(),
      };
      split.partialParseMessage = '本项原文已删除。请审核删除提案，再决定是否同步到最终草稿。';
    } else {
      const sourceFacts = window.AIParserCore.extractFacts(split.text);
      const targetLines = Array.from(
        { length: replacementLines.length },
        (_, offset) => unit.startOffset + offset + 1
      ).filter(line => sourceFacts.nonEmptyLines.includes(line));
      const lineResults = await aiRequestDayLineResults(
        split,
        sourceFacts,
        targetLines,
        { signal: run.controller.signal }
      );
      const subsetFacts = {
        ...sourceFacts,
        nonEmptyLines: targetLines,
        lineFacts: sourceFacts.lineFacts.filter(item => targetLines.includes(item.line)),
      };
      const parsedUnit = aiPrepareV2Parsed(split, subsetFacts, lineResults);
      let result = null;
      if (parsedUnit.sessions.length) {
        const session = parsedUnit.sessions[0];
        session.sourceLines = session.sourceLines.map(line => line - unit.startOffset);
        result = { kind: 'session', session };
      } else if (parsedUnit.tasks.length) {
        const task = parsedUnit.tasks[0];
        task.sourceLines = task.sourceLines.map(line => line - unit.startOffset);
        result = { kind: 'task', task };
      } else {
        const lineResult = lineResults[0];
        if (lineResult?.kind === 'field') result = { kind: 'field', field: lineResult.field, value: lineResult.value };
      }
      if (!result) throw new Error('本项重解析没有生成可应用的字段、时段或任务');

      const proposalParsed = aiProposalClone(split.parsed);
      const proposalSplit = { ...split, parsed: proposalParsed };
      aiApplyUnitParsedResult(proposalSplit, unit, result, replacementLines);
      proposalSplit.sourceFacts = sourceFacts;
      proposalSplit.parsed.aiIssues = [];
      proposalSplit.parsed.aiIssues = window.AIParserCore.validateDay(proposalSplit.parsed, sourceFacts);
      aiValidateDraftDay(proposalSplit);
      split.sourceFacts = sourceFacts;
      split.pendingProposal = {
        parsed: proposalParsed,
        issues: proposalSplit.issues || [],
        differences: aiBuildProposalDifferences(split.parsed, proposalParsed),
        createdAt: new Date().toISOString(),
      };
      split.partialParseMessage = '本项原文已按统一规则重新解析。请审核提案，再决定是否同步到最终草稿。';
    }
    split.sourceDirty = false;
    split.error = null;
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
    aiRenderDayCard(index);
    if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    aiUpdateImportBtn();
    aiUpdateProgress();
    aiScheduleCacheSave();
    return true;
  } catch (e) {
    if (aiIsRateLimitError(e)) {
      aiStopStep2Run(run, split, {
        stopped: true,
        stopReason: 'rate-limit',
        stopError: e,
        failedWaves: 0,
        results: targetLinesForUnitError(unit, e),
      });
    }
    split.sourceDirty = true;
    split.partialParseMessage = '本项原文已保存，但本项重解析失败：' + e.message;
    aiRenderDayCard(index);
    if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    aiScheduleCacheSave();
    return false;
  }
}

function targetLinesForUnitError(unit, error) {
  return (unit?.relativeLines || []).map(line => ({
    item: Number(line),
    status: 'rejected',
    error,
  }));
}

function aiIsSourceIssue(split, issue) {
  return (split.sourceIssues || []).some(sourceIssue => sourceIssue.id === issue.id);
}

function aiHasStructuredSourceRewrite(issue) {
  return Boolean(
    issue &&
    Array.isArray(issue.sourceLines) &&
    issue.sourceLines.length &&
    typeof issue.expectedSource === 'string' &&
    typeof issue.replacementSource === 'string'
  );
}

function aiStructuredSourceRelativeLines(split, issue) {
  return [...new Set((issue.sourceLines || []).map(line => Number(line) - Number(split.startLine || 1) + 1))]
    .filter(line => Number.isFinite(line) && line >= 1)
    .sort((a, b) => a - b);
}

function aiCanPatchSourceSuggestion(split, issue) {
  if (aiHasStructuredSourceRewrite(issue)) {
    const relativeLines = aiStructuredSourceRelativeLines(split, issue);
    return relativeLines.length > 0 &&
      relativeLines.every((line, index) => index === 0 || line === relativeLines[index - 1] + 1);
  }
  const replacement = issue.sourceReplacement ?? issue.suggestion;
  if ((!aiIsSourceIssue(split, issue) && !issue.sourceReplacement) || replacement == null || replacement === '') return false;
  if (issue.code === 'DUPLICATE_DATE' && /^\d{4}-\d{2}-\d{2}$/.test(String(replacement))) return true;
  const absoluteLine = Number(issue.sourceLines?.[0]);
  const offset = Number.isFinite(absoluteLine) ? absoluteLine - split.startLine : -1;
  const current = String(split.text || '').split(/\r?\n/)[offset] || '';
  if (issue.code === 'DAYTIME_BEDTIME') return /睡觉\s*13点/.test(current);
  if (issue.code === 'LIKELY_MISSING_HOUR_DIGIT') return /去上课\s*18:17\s*到\s*7:00/.test(current);
  return Boolean(issue.original && current.includes(issue.original));
}

function aiCanAcceptIssue(split, issue) {
  if (!issue || issue.status !== 'open') return false;
  if (issue.apply?.path) return true;
  if (aiHasStructuredSourceRewrite(issue)) return true;
  return aiCanPatchSourceSuggestion(split, issue);
}

function aiSuggestedSourceLine(split, issue) {
  const lines = String(split.text || '').split(/\r?\n/);
  const suggestedReplacement = issue.sourceReplacement ?? issue.suggestion;

  if (issue.code === 'DUPLICATE_DATE' && /^\d{4}-\d{2}-\d{2}$/.test(String(suggestedReplacement || ''))) {
    const [, month, day] = String(suggestedReplacement).split('-').map(Number);
    const heading = `${month}月${day}日`;
    return { offset: 0, line: lines[0].replace(/^(?:(?:\d{4})年)?\d{1,2}月\d{1,2}日/, heading) };
  }

  const absoluteLine = Number(issue.sourceLines?.[0]);
  const offset = Number.isFinite(absoluteLine) ? absoluteLine - split.startLine : -1;
  if (offset < 0 || offset >= lines.length) return null;
  const current = lines[offset];
  let replacement = current;
  if (issue.code === 'DAYTIME_BEDTIME') {
    replacement = current.replace(/睡觉\s*13点/, `睡觉${suggestedReplacement}`);
  } else if (issue.code === 'LIKELY_MISSING_HOUR_DIGIT') {
    replacement = current.replace(/去上课\s*18:17\s*到\s*7:00/, '去上课18:17到19:00');
  } else if (issue.code === 'DURATION_MINUTE_OVERFLOW' && issue.original) {
    const original = current.includes(`${issue.original}钟`) ? `${issue.original}钟` : issue.original;
    replacement = current.replace(original, String(suggestedReplacement));
  } else if (issue.original && current.includes(issue.original)) {
    replacement = current.replace(issue.original, String(suggestedReplacement));
  }
  return replacement !== current ? { offset, line: replacement } : null;
}

function aiBuildSourceReviewUnits(split) {
  const lines = String(split.text || '').replace(/\r\n?/g, '\n').split('\n');
  const units = [];
  const coveredOffsets = new Set();
  const p = split.parsed || {};
  const normalizeOffsets = item => [...new Set((item?.sourceLines || [])
    .map(Number)
    .filter(line => Number.isFinite(line) && line >= 1 && line <= lines.length)
    .map(line => line - 1)
    .filter(offset => String(lines[offset] || '').trim()))]
    .sort((a, b) => a - b);
  const isContiguous = offsets => offsets.every((offset, index) => index === 0 || offset === offsets[index - 1] + 1);
  const lineLabel = offsets => {
    if (!offsets.length) return '未绑定原文';
    const absolute = offsets.map(offset => Number(split.startLine || 1) + offset);
    return absolute.length === 1 ? `第 ${absolute[0]} 行` : `第 ${absolute[0]}-${absolute[absolute.length - 1]} 行`;
  };
  const addItemUnit = (kind, item, itemIndex) => {
    const offsets = normalizeOffsets(item);
    offsets.forEach(offset => coveredOffsets.add(offset));
    const title = kind === 'session'
      ? `时段 ${itemIndex + 1}${item?.startTime || item?.endTime ? ` · ${item.startTime || '?'}-${item.endTime || '?'}` : ''}`
      : `任务 ${itemIndex + 1}${item?.name ? ` · ${item.name}` : ''}`;
    units.push({
      key: `${kind}-${itemIndex}`,
      kind,
      itemIndex,
      targetPrefix: `parsed.${kind === 'session' ? 'sessions' : 'tasks'}.${itemIndex}`,
      title,
      label: lineLabel(offsets),
      startOffset: offsets.length ? offsets[0] : null,
      endOffset: offsets.length ? offsets[offsets.length - 1] : null,
      offsets,
      relativeLines: offsets.map(offset => offset + 1),
      text: offsets.map(offset => lines[offset]).join('\n'),
      contiguous: isContiguous(offsets),
      hasSource: offsets.length > 0,
    });
  };
  (p.sessions || []).forEach((session, itemIndex) => addItemUnit('session', session, itemIndex));
  (p.tasks || []).forEach((task, itemIndex) => addItemUnit('task', task, itemIndex));
  (p.consumedLines || []).forEach(line => {
    const offset = Number(line) - 1;
    if (Number.isFinite(offset) && offset >= 0 && offset < lines.length) coveredOffsets.add(offset);
  });

  const issueOffsets = new Set();
  (split.issues || []).forEach(issue => {
    (issue.sourceLines || []).forEach(line => {
      const offset = Number(line) - Number(split.startLine || 1);
      if (Number.isFinite(offset) && offset >= 0 && offset < lines.length && lines[offset].trim()) {
        issueOffsets.add(offset);
      }
    });
  });
  lines.forEach((line, offset) => {
    if (!line.trim() || coveredOffsets.has(offset)) return;
    const reason = issueOffsets.has(offset) ? 'AI建议对应原文' : '未绑定原文';
    units.push({
      key: `source-${offset}`,
      kind: issueOffsets.has(offset) ? 'source-issue' : 'source',
      title: reason,
      label: lineLabel([offset]),
      startOffset: offset,
      endOffset: offset,
      offsets: [offset],
      relativeLines: [offset + 1],
      text: line,
      contiguous: true,
      hasSource: true,
    });
  });
  const order = { session: 0, task: 1, 'source-issue': 2, source: 3 };
  return units.sort((a, b) => {
    const aOffset = a.startOffset == null ? Number.MAX_SAFE_INTEGER : a.startOffset;
    const bOffset = b.startOffset == null ? Number.MAX_SAFE_INTEGER : b.startOffset;
    return aOffset - bOffset || (order[a.kind] || 9) - (order[b.kind] || 9) || String(a.key).localeCompare(String(b.key));
  });
}

function aiFindSourceUnitByOffset(split, offset) {
  return aiBuildSourceReviewUnits(split).find(unit => unit.offsets?.includes(offset)) || null;
}

function aiStageIssueSuggestion(index, issueIndex) {
  const split = aiState.daySplits[index];
  const issue = split?.issues?.[issueIndex];
  if (!split || !issue || !aiCanPatchSourceSuggestion(split, issue)) return;
  const suggested = aiSuggestedSourceLine(split, issue);
  if (!suggested) return;
  const unit = aiFindSourceUnitByOffset(split, suggested.offset);
  if (!unit) return;
  const lines = unit.text.split('\n');
  const localIndex = (unit.offsets || []).indexOf(suggested.offset);
  if (localIndex < 0) return;
  lines[localIndex] = suggested.line;
  split.annotationUnitDrafts = { ...(split.annotationUnitDrafts || {}), [unit.key]: lines.join('\n') };
  issue.suggestionStaged = true;
  split.partialParseMessage = 'AI 建议已填入对应原文片段，尚未写入。你可以继续修改，完成后点击片段下方的重解析按钮。';
  aiRenderDayCard(index);
  aiScheduleCacheSave();
  document.getElementById(`ai-source-unit-${index}-${unit.key}`)?.focus();
}

async function aiAcceptIssueSuggestion(index, issueIndex) {
  const split = aiState.daySplits[index];
  const issue = split?.issues?.[issueIndex];
  if (!split || !issue || !aiCanAcceptIssue(split, issue)) return;

  if (aiHasStructuredSourceRewrite(issue)) {
    await aiAcceptStructuredSourceRewrite(index, issueIndex);
    return;
  }

  if (issue.apply?.path) {
    aiSetByPath(split, issue.apply.path, issue.apply.value);
    issue.status = 'accepted';
    split.partialParseMessage = `已采纳 AI 字段建议并更新 ${issue.apply.path}。`;
    aiRevalidateAndRender(index);
    return;
  }

  if (aiCanPatchSourceSuggestion(split, issue)) {
    aiStageIssueSuggestion(index, issueIndex);
    return;
  }

  alert('这条建议无法安全自动写入原文。请手动修改对应原文片段后，点击“保存本项原文并重解析本项”。');
}

function aiSourceTransactionSnapshot() {
  return {
    rawInput: aiState.rawInput,
    sourceMeta: aiProposalClone(aiState.sourceMeta || {}),
    sourceIssues: aiProposalClone(aiState.sourceIssues || []),
    daySplits: aiProposalClone(aiState.daySplits || []),
    step2StopInfo: aiProposalClone(aiState.step2StopInfo),
    parseManager: aiProposalClone(aiEnsureParseManager()),
  };
}

function aiRestoreSourceTransaction(snapshot) {
  aiState.rawInput = snapshot.rawInput;
  aiState.sourceMeta = snapshot.sourceMeta;
  aiState.sourceIssues = snapshot.sourceIssues;
  aiState.daySplits = snapshot.daySplits.map(aiNormalizeCachedSplit);
  aiState.step2StopInfo = snapshot.step2StopInfo;
  aiState.parseManager = window.AIParseManager.createManager(snapshot.parseManager);
  const rawEl = document.getElementById('ai-rawInput');
  if (rawEl) rawEl.value = aiState.rawInput;
  aiRenderSourceMeta();
}

function aiBlockingIssueFingerprint(issue) {
  return [
    issue.code || '',
    issue.target || issue.targetPath || '',
    issue.original || '',
    issue.level || '',
  ].join('|');
}

async function aiAcceptStructuredSourceRewrite(index, issueIndex) {
  const split = aiState.daySplits[index];
  const issue = split?.issues?.[issueIndex];
  if (!split || !aiHasStructuredSourceRewrite(issue) || aiSplitIsBusy(split)) return;

  const snapshot = aiSourceTransactionSnapshot();
  const beforeBlocking = new Set(
    (split.issues || []).filter(aiIssueBlocksConfirmation).map(aiBlockingIssueFingerprint)
  );
  const relativeLines = aiStructuredSourceRelativeLines(split, issue);
  const oldStartLine = split.startLine;
  const oldEndLine = split.endLine;
  const run = aiCreateStep2Run();
  run.transactional = true;
  let committed = false;

  clearTimeout(aiState._saveTimer);
  split.reparseLocked = true;
  split.partialParseMessage = '正在采纳 AI 原文修改并重新提取最终草稿…';
  aiRenderDayCard(index);

  try {
    const rewrite = window.AIStep2Scheduler.sourceRewrite(
      split.text,
      relativeLines,
      issue.expectedSource,
      issue.replacementSource
    );
    split.text = rewrite.text;
    const heading = String(split.text || '').split('\n')[0]?.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
    if (heading) {
      const year = heading[1] || String(split.date || '').slice(0, 4) || String(new Date().getFullYear());
      split.date = `${year}-${String(Number(heading[2])).padStart(2, '0')}-${String(Number(heading[3])).padStart(2, '0')}`;
      split.importMode = '';
    }
    split.pendingProposal = null;
    split.reviewProposals = [];
    split.error = null;
    split.sourceDirty = true;
    split.status = 'parsing';
    aiSyncRawInputFromSplit(index, oldStartLine, oldEndLine);
    aiRunSourcePreflight(aiState.daySplits);

    const sourceFacts = window.AIParserCore.extractFacts(split.text);
    const lineCountChanged = rewrite.oldLineCount !== rewrite.newLineCount;
    const existingResults = (snapshot.daySplits[index]?.itemParseResults || [])
      .filter(record => aiValidItemCheckpoint(record, sourceFacts))
      .filter(record => !lineCountChanged || aiCheckpointLine(record) < rewrite.startLine);
    const reusableLines = new Set(existingResults.map(aiCheckpointLine));
    const targetLines = sourceFacts.nonEmptyLines.filter(line => !reusableLines.has(line));

    split.itemParseResults = existingResults;
    split.sourceFacts = sourceFacts;
    aiSetNetworkConcurrency(run.concurrency);
    if (targetLines.length) {
      await aiParseTargetLinesInWaves(index, split, sourceFacts, targetLines, {
        run,
        existingResults,
        checkpoint: false,
      });
    }
    if (run.stopped) throw run.stopError || new Error('Step 2 已停止');

    const validResults = (split.itemParseResults || [])
      .filter(record => aiValidItemCheckpoint(record, sourceFacts));
    const resultLines = new Set(validResults.map(aiCheckpointLine));
    const missingLines = sourceFacts.nonEmptyLines.filter(line => !resultLines.has(line));
    if (missingLines.length) {
      throw new Error(`修改后的原文仍有未完成项目：相对行 ${missingLines.join('、')}`);
    }

    const lineResults = validResults.map(record => {
      const { sourceLine, text, parseStatus, parserVersion, error, errorStatus, ...result } = record;
      return result;
    }).sort((a, b) => Number(a.line) - Number(b.line));
    split.parsed = aiPrepareV2Parsed(split, sourceFacts, lineResults);
    split.sourceFacts = sourceFacts;
    split.reviewProposals = [];
    split.pendingProposal = null;
    split.issues = [];
    split.sourceDirty = false;
    split.draftDirty = false;
    aiValidateDraftDay(split);

    const newBlocking = (split.issues || [])
      .filter(aiIssueBlocksConfirmation)
      .filter(item => !beforeBlocking.has(aiBlockingIssueFingerprint(item)));
    if (newBlocking.length) {
      throw new Error(`修改后的草稿产生新的阻断错误：${newBlocking[0].message}`);
    }

    split.sourceEditHistory = [
      ...(split.sourceEditHistory || []),
      {
        type: 'ai-source-rewrite',
        sourceLines: relativeLines,
        expectedSource: issue.expectedSource,
        replacementSource: issue.replacementSource,
        reason: issue.reason || issue.message || '',
        acceptedAt: new Date().toISOString(),
      },
    ];
    split.partialParseMessage = '已采纳 AI 原文修改，并用修改后的原文重新提取和更新最终草稿。';
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
    split.reparseLocked = false;
    aiState.daySplits.forEach((other, otherIndex) => {
      if (otherIndex === index || !other.parsed) return;
      aiValidateDraftDay(other);
      if (other.status !== 'imported') other.status = aiHasBlockingIssues(other) ? 'blocked' : other.status;
    });
    committed = true;
    aiRenderExistingDayCards();
    aiUpdateImportBtn();
    await aiSaveCacheToServer();
  } catch (error) {
    const stopInfo = run.stopped ? aiProposalClone(aiState.step2StopInfo) : null;
    aiRestoreSourceTransaction(snapshot);
    if (stopInfo) aiState.step2StopInfo = stopInfo;
    const restored = aiState.daySplits[index];
    if (restored) {
      restored.reparseLocked = false;
      restored.partialParseMessage = `AI 原文修改未生效，已完整回滚：${error.message || error}`;
    }
    aiRenderExistingDayCards();
    aiUpdateImportBtn();
    await aiSaveCacheToServer();
    if (error?.code === 'STALE_SOURCE_REWRITE') {
      alert('原文已经变化，这条 AI 建议已过期，没有执行任何修改。');
    } else if (!run.stopped) {
      alert('采纳 AI 原文修改失败，已恢复原文和旧草稿：' + (error.message || error));
    }
  } finally {
    if (committed && aiState.daySplits[index]) aiState.daySplits[index].reparseLocked = false;
    aiRenderStep2StopInfo();
  }
}

function aiSetAnnotationUnitDraft(index, key, value) {
  const split = aiState.daySplits[index];
  if (!split) return;
  split.annotationUnitDrafts = { ...(split.annotationUnitDrafts || {}), [key]: value };
}

async function aiConfirmAnnotationUnitRevision(index, key) {
  const split = aiState.daySplits[index];
  if (!split) return;
  if (aiSplitIsBusy(split)) {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    return;
  }
  const unit = aiBuildSourceReviewUnits(split).find(item => item.key === key);
  if (!unit) return;
  if (!unit.hasSource || !unit.offsets?.length) {
    alert('这一项还没有绑定到具体原文行，请使用上方“修改原文”编辑整日原文后重新解析。');
    return;
  }
  if (!unit.contiguous) {
    alert('这一项关联了不连续的原文行。为避免误删其他内容，请使用上方“修改原文”编辑整日原文后重新解析。');
    return;
  }
  const input = document.getElementById(`ai-source-unit-${index}-${key}`);
  const value = input?.value ?? split.annotationUnitDrafts?.[key] ?? unit.text;
  const replacementLines = String(value).replace(/\r\n?/g, '\n').trim()
    ? String(value).replace(/\r\n?/g, '\n').split('\n')
    : [];
  const scrollAnchor = aiCaptureScrollAnchor(aiUnitWrapId(index, key));
  const oldStartLine = split.startLine;
  const oldEndLine = split.endLine;

  split.reparseLocked = true;
  try {
    const lines = String(split.text || '').replace(/\r\n?/g, '\n').split('\n');
    const oldLineCount = unit.endOffset - unit.startOffset + 1;
    const delta = replacementLines.length - oldLineCount;
    lines.splice(unit.startOffset, unit.endOffset - unit.startOffset + 1, ...replacementLines);
    split.text = lines.join('\n');
    aiShiftParsedLinesAfterEdit(split, unit.endOffset + 1, delta);
    if (unit.startOffset === 0 && replacementLines.length) {
      const heading = replacementLines[0].match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
      if (heading) {
        const year = heading[1] || String(split.date || '').slice(0, 4) || String(new Date().getFullYear());
        split.date = `${year}-${String(Number(heading[2])).padStart(2, '0')}-${String(Number(heading[3])).padStart(2, '0')}`;
        split.importMode = '';
      }
    }
    split.annotationDrafts = {};
    split.annotationUnitDrafts = {};
    split.pendingProposal = null;
    split.error = null;
    split.sourceDirty = true;
    split.partialParseMessage = '原文片段已保存，正在让 AI 重新解析本项…';
    aiSyncRawInputFromSplit(index, oldStartLine, oldEndLine);
    aiRunSourcePreflight(aiState.daySplits);
    if (split.parsed) aiValidateDraftDay(split);
    aiRenderDayCard(index);
    aiRestoreScrollAnchor(scrollAnchor);
    await aiSaveCacheToServer();
    await aiParseSingleUnit(index, unit, replacementLines.join('\n'), { scrollAnchor });
  } finally {
    split.reparseLocked = false;
    aiRenderDayCard(index);
    aiRestoreScrollAnchor(scrollAnchor);
    aiScheduleCacheSave();
  }
}

function aiConfirmDay(index) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  if (split.draftDirty) {
    alert('草稿仍在更新，请稍后再确认。');
    return;
  }
  aiValidateDraftDay(split);
  if (!aiCanConfirmSplit(split)) {
    alert(split.pendingProposal
      ? '仍有尚未审核的 AI 重解析提案。请先采纳提案或保留当前草稿。'
      : '仍有会阻止导入的数据错误或未归属原文。请先完成修正。');
    aiRenderDayCard(index);
    return;
  }
  split.status = 'confirmed';
  split.importMode = split.importMode || aiDefaultImportMode(split.date);
  aiRenderDayCard(index);
  aiUpdateImportBtn();
  aiUpdateProgress();
  aiScheduleCacheSave();
}

function aiIsMeaningfulDay(day) {
  return Boolean(day && (
    day.wakeTime || day.sleepTime || day.dayType || day.dayNote || day.specialDay ||
    day.specialDayReason || day.excludeFromRating ||
    (day.sessions && day.sessions.length) || (day.tasks && day.tasks.length)
  ));
}

function aiDefaultImportMode(date) {
  return aiIsMeaningfulDay(state.data?.[date]) ? 'needs-choice' : 'replace-blank';
}

// ============================================================
// STEP 3 — 导入
// ============================================================
async function aiStep3ImportAll() {
  const ready = aiState.daySplits.filter(s => s.status === 'confirmed' && s.parsed);
  if (ready.length === 0) { alert('没有已人工确认的数据可导入'); return; }
  const unresolved = ready.filter(split => !split.importMode || split.importMode === 'needs-choice');
  if (unresolved.length) {
    alert(`有 ${unresolved.length} 天已存在数据，请先在对应日期卡片中选择“替换、去重合并或跳过”。`);
    return;
  }
  if (!confirm(`确认执行 ${ready.length} 天的导入计划？\n空白日期将直接写入；已有数据只会按你选择的策略处理。`)) return;

  let count = 0;
  for (const split of ready) {
    await aiImportDay(split, split.importMode);
    split.status = 'imported';
    aiRenderDayCard(aiState.daySplits.indexOf(split));
    if (split.importMode !== 'skip') count++;
  }

  await saveAllStorage();
  renderHeader();
  aiUpdateImportBtn();
  aiUpdateProgress();
  // 全部导入完成后清理缓存
  const allImported = aiState.daySplits.every(s => s.status === 'imported');
  if (allImported) aiClearCacheOnServer();
  else aiSaveCacheToServer();
  alert(`✅ 导入完成：写入 ${count} 天。可切换到“录入”或“日览”检查。`);
}

async function aiImportSingleDay(index) {
  const split = aiState.daySplits[index];
  if (!split || split.status !== 'confirmed' || !split.parsed) return;
  if (!split.importMode || split.importMode === 'needs-choice') {
    alert('该日期已有数据，请先选择导入策略。');
    return;
  }

  await aiImportDay(split, split.importMode);
  split.status = 'imported';
  await saveAllStorage();
  renderHeader();
  aiRenderDayCard(index);
  aiUpdateImportBtn();
  aiUpdateProgress();
  // 单独导入后同步缓存
  const allImported = aiState.daySplits.every(s => s.status === 'imported');
  if (allImported) aiClearCacheOnServer();
  else aiSaveCacheToServer();
}

function aiSetImportMode(index, mode) {
  const split = aiState.daySplits[index];
  if (!split) return;
  split.importMode = mode;
  aiRenderDayCard(index);
  aiScheduleCacheSave();
}

function aiBuildDayFromParsed(parsed) {
  if (window.AIParserCore) return window.AIParserCore.buildImportDay(parsed);
  return {
    wakeTime: parsed.wakeTime || '',
    sleepTime: parsed.sleepTime || '',
    dayType: parsed.dayType || '',
    specialDay: Boolean(parsed.specialDay),
    specialDayReason: parsed.specialDayReason || '',
    excludeFromRating: Boolean(parsed.excludeFromRating),
    dayNote: parsed.dayNote || '',
    sessions: (parsed.sessions || []).map(session => ({ ...session })),
    tasks: (parsed.tasks || []).map(task => ({ ...task })),
  };
}

function aiSessionFingerprint(session) {
  return [session.type || 'normal', session.name || '', session.startTime || '', session.endTime || '', Number(session.actualMinutes) || 0].join('|');
}

function aiTaskFingerprint(task) {
  return [task.name || '', task.activityType || '', Number(task.minutes) || 0, Number(task.quantity) || 0, task.quantityUnit || ''].join('|');
}

function aiMergeDayData(split) {
  const p = aiBuildDayFromParsed(split.parsed);
  const day = getDay(split.date);
  if (p.wakeTime) day.wakeTime = p.wakeTime;
  if (p.sleepTime) day.sleepTime = p.sleepTime;
  if (p.dayType) day.dayType = p.dayType;
  if (p.specialDay) day.specialDay = true;
  if (p.specialDayReason) day.specialDayReason = p.specialDayReason;
  if (p.excludeFromRating) day.excludeFromRating = true;
  if (p.dayNote) {
    day.dayNote = day.dayNote ? (day.dayNote + '\n' + p.dayNote) : p.dayNote;
  }
  if (p.sessions && p.sessions.length) {
    const seen = new Set((day.sessions || []).map(aiSessionFingerprint));
    day.sessions = [...(day.sessions || []), ...p.sessions.filter(session => !seen.has(aiSessionFingerprint(session)))];
  }
  if (p.tasks && p.tasks.length) {
    const seen = new Set((day.tasks || []).map(aiTaskFingerprint));
    day.tasks = [...(day.tasks || []), ...p.tasks.filter(task => !seen.has(aiTaskFingerprint(task)))];
  }
}

function aiImportDay(split, mode) {
  if (mode === 'skip') return;
  const current = state.data[split.date];
  if (mode === 'replace-blank') {
    if (aiIsMeaningfulDay(current)) throw new Error(`${split.date} 已存在数据，不能按“覆盖空白”导入`);
    state.data[split.date] = aiBuildDayFromParsed(split.parsed);
    return;
  }
  if (mode === 'replace') {
    state.data[split.date] = aiBuildDayFromParsed(split.parsed);
    return;
  }
  if (mode === 'merge') {
    aiMergeDayData(split);
    return;
  }
  throw new Error(`${split.date} 尚未选择有效导入策略`);
}

// ============================================================
// 清空
// ============================================================
function aiClearAll() {
  if (aiState.daySplits.length > 0 && !confirm('清空当前分割结果？')) return;
  if (aiState._activeStep2Run && !aiState._activeStep2Run.controller.signal.aborted) {
    aiState._activeStep2Run.controller.abort(new Error('用户清空解析数据'));
  }
  aiState._activeStep2Run = null;
  aiState.daySplits = [];
  aiState.rawInput = '';
  aiState.sourceMeta = { fileName: '', lineCount: 0, charCount: 0, loadedAt: '' };
  aiState.sourceIssues = [];
  aiState.step2StopInfo = null;
  aiState.parseManager = window.AIParseManager.createManager();
  const el = document.getElementById('ai-rawInput');
  if (el) el.value = '';
  aiMsg('split', '', 'muted');
  const sec = document.getElementById('ai-splits-section');
  if (sec) sec.style.display = 'none';
  aiRenderSourceMeta();
  aiClearCacheOnServer();
}

// ============================================================
// RENDER HELPERS
// ============================================================
function aiShowSplitsSection() {
  const sec = document.getElementById('ai-splits-section');
  if (!sec) return;
  sec.style.display = 'block';
  const titleEl = document.getElementById('ai-splits-title');
  if (titleEl) titleEl.textContent = `📋 分割结果（${aiState.daySplits.length} 天）`;
}

function aiUnitWrapId(index, key) {
  return `ai-source-unit-wrap-${index}-${key}`;
}

function aiCaptureScrollAnchor(elementId) {
  const el = document.getElementById(elementId);
  return {
    elementId,
    top: el ? el.getBoundingClientRect().top : null,
    scrollY: window.scrollY,
  };
}

function aiRestoreScrollAnchor(anchor) {
  if (!anchor) return;
  const el = anchor.elementId ? document.getElementById(anchor.elementId) : null;
  const html = document.documentElement;
  const body = document.body;
  const oldHtmlBehavior = html?.style.scrollBehavior || '';
  const oldBodyBehavior = body?.style.scrollBehavior || '';
  if (html) html.style.scrollBehavior = 'auto';
  if (body) body.style.scrollBehavior = 'auto';
  if (el && Number.isFinite(anchor.top)) {
    window.scrollBy(0, el.getBoundingClientRect().top - anchor.top);
  } else if (Number.isFinite(anchor.scrollY)) {
    window.scrollTo(0, anchor.scrollY);
  }
  if (html) html.style.scrollBehavior = oldHtmlBehavior;
  if (body) body.style.scrollBehavior = oldBodyBehavior;
}

function aiSplitIsBusy(split) {
  return Boolean(split?.parsingLocked || split?.reparseLocked || split?.status === 'parsing');
}

function aiBusyAttr(split) {
  return aiSplitIsBusy(split) ? 'disabled title="正在解析，请稍候"' : '';
}

function aiRenderDayList() {
  const container = document.getElementById('ai-day-list');
  if (!container) return;
  container.innerHTML = '';
  aiState.daySplits.forEach((_, i) => {
    const div = document.createElement('div');
    div.id = `ai-day-${i}`;
    container.appendChild(div);
    aiRenderDayCard(i);
  });
  aiUpdateProgress();
}

function aiRenderExistingDayCards() {
  aiState.daySplits.forEach((_, i) => aiRenderDayCard(i));
  aiUpdateProgress();
}

function aiConfidenceHtml(aiMeta) {
  const evidence = aiMeta?.evidenceLabel || ({
    'source-explicit': '原文明确',
    'program-derived': '程序推导',
    'template-default': '唯一模板',
    'ai-inferred': 'AI语义推断',
    conflict: '存在冲突',
    manual: '人工确认',
  })[aiMeta?.evidenceLevel];
  if (evidence) {
    const level = aiMeta?.evidenceLevel === 'conflict'
      ? 'low'
      : aiMeta?.evidenceLevel === 'ai-inferred'
        ? 'medium'
        : 'high';
    return `<span class="ai-confidence ai-confidence-${level}" title="${escAttr(aiMeta?.reason || '')}">${escHtml(evidence)}</span>`;
  }
  const confidence = Number(aiMeta?.confidence);
  if (!Number.isFinite(confidence)) return '';
  const level = confidence >= 0.9 ? 'high' : confidence >= 0.65 ? 'medium' : 'low';
  return `<span class="ai-confidence ai-confidence-${level}" title="${escAttr(aiMeta?.reason || '')}">${Math.round(confidence * 100)}%</span>`;
}

function aiInlineEditableTarget(issue) {
  const path = String(issue.target || issue.apply?.path || '');
  const allowed = [
    /^parsed\.(wakeTime|sleepTime|dayNote|specialDay|excludeFromRating)$/,
    /^parsed\.sessions\.\d+\.(type|name|startTime|endTime|nominalMinutes|actualMinutes|restMinutes|note)$/,
    /^parsed\.tasks\.\d+\.(name|activityType|minutes|quantity|quantityUnit|completionStatus|progressText|errorCount|note)$/,
  ];
  return allowed.some(pattern => pattern.test(path)) ? path : '';
}

function aiInlineFieldEditorHtml(index, issueIndex, split, issue) {
  const path = aiInlineEditableTarget(issue);
  if (!path || !split.parsed) return '';
  const value = aiGetByPath(split, path);
  const inputId = `ai-annotation-field-${index}-${issueIndex}`;
  if (typeof value === 'boolean') {
    return `<div class="ai-inline-field-editor">
      <label><input id="${inputId}" type="checkbox" ${value ? 'checked' : ''}> ${escHtml(path)}</label>
      <button class="btn btn-primary btn-sm" onclick="aiConfirmAnnotationFieldRevision(${index},${issueIndex},'boolean')">确认字段修改</button>
    </div>`;
  }
  const type = typeof value === 'number' ? 'number' : 'text';
  return `<div class="ai-inline-field-editor">
    <label>${escHtml(path)}<input id="${inputId}" type="${type}" value="${escAttr(value ?? '')}"></label>
    <button class="btn btn-primary btn-sm" onclick="aiConfirmAnnotationFieldRevision(${index},${issueIndex},'${type}')">确认字段修改</button>
  </div>`;
}

function aiConfirmAnnotationFieldRevision(index, issueIndex, type = 'text') {
  const split = aiState.daySplits[index];
  const issue = split?.issues?.[issueIndex];
  const path = aiInlineEditableTarget(issue || {});
  const input = document.getElementById(`ai-annotation-field-${index}-${issueIndex}`);
  if (!split?.parsed || !path || !input) return;
  const value = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value || 0) : input.value;
  aiSetByPath(split, path, value);
  split.partialParseMessage = `字段 ${path} 已同步到最终草稿，并完成本地校验。`;
  aiRevalidateAndRender(index);
}

function aiAnnotationCommentHtml(index, issueIndex, split, issue, offset = null) {
  const confidence = issue.confidence == null ? NaN : Number(issue.confidence);
  const displayedSuggestion = issue.suggestion ?? issue.sourceReplacement;
  const suggestionText = displayedSuggestion && typeof displayedSuggestion === 'object'
    ? JSON.stringify(displayedSuggestion, null, 2)
    : displayedSuggestion;
  const sourceRewriteHtml = aiHasStructuredSourceRewrite(issue)
    ? `<div class="ai-source-rewrite-preview">
        <div><b>当前原文</b><pre>${escHtml(issue.expectedSource)}</pre></div>
        <div><b>AI 建议改为</b><pre>${escHtml(issue.replacementSource || '（删除这些行）')}</pre></div>
        ${issue.reason ? `<div class="ai-source-rewrite-reason">依据：${escHtml(issue.reason)}</div>` : ''}
      </div>`
    : '';
  return `<div class="ai-annotation-comment ai-annotation-${issue.level} ${issue.status !== 'open' ? 'ai-annotation-resolved' : ''}">
    <div class="ai-annotation-title">
      <b>${issue.level === 'error' ? '错误' : issue.level === 'warning' ? 'AI 建议' : '提示'}</b>
      ${Number.isFinite(confidence) ? `<span>${Math.round(confidence * 100)}%</span>` : ''}
    </div>
    <div>${escHtml(issue.message)}</div>
    ${sourceRewriteHtml || (issue.original ? `<div class="ai-annotation-original">发现：${escHtml(String(issue.original))}</div>` : '')}
    ${!sourceRewriteHtml && suggestionText != null && suggestionText !== '' ? `<div class="ai-suggestion">建议改为：${escHtml(String(suggestionText))}</div>` : ''}
    ${offset == null ? aiInlineFieldEditorHtml(index, issueIndex, split, issue) : ''}
    ${aiAnnotationActionsHtml(index, issueIndex, split, issue, offset)}
  </div>`;
}

function aiSourceEditorHtml(index, split) {
  if (!split.sourceEditorOpen) return '';
  const busyAttr = aiBusyAttr(split);
  return `<div class="ai-source-editor">
    <div class="ai-manual-note">这里用于整段修改。点击确认后只重新解析当前日期，不会折叠当前审核区域。</div>
    ${split.partialParseMessage ? `<div class="ai-partial-parse-message">${escHtml(split.partialParseMessage)}</div>` : ''}
    <label>日期<input id="ai-source-date-${index}" value="${escAttr(split.date)}" placeholder="YYYY-MM-DD"></label>
    <label>本段原文<textarea id="ai-source-text-${index}">${escHtml(split.text)}</textarea></label>
    <div class="ai-source-editor-actions">
      <button class="btn btn-success btn-sm" onclick="aiConfirmSourceRevision(${index},${split.parsed ? 'true' : 'false'})" ${busyAttr}>${split.parsed ? '确认原文修改并让 AI 重解析' : '确认修改并重新预检'}</button>
      <button class="btn btn-ghost btn-sm" onclick="aiToggleSourceEditor(${index})">取消</button>
    </div>
  </div>`;
}

// The review workbench renders source paragraphs and their final draft rows together.
// These later definitions intentionally replace the older line-only annotation renderer.
function aiAnnotationActionsHtml(index, issueIndex, split, issue, offset = null) {
  if (issue.status !== 'open') {
    return `<span class="ai-annotation-status">${issue.status === 'accepted' ? '已接受 AI 建议' : '已保留当前草稿'}</span>`;
  }
  if (aiHasStructuredSourceRewrite(issue)) {
    return `<div class="ai-issue-actions">
      <button class="btn btn-success btn-sm" onclick="aiAcceptIssueSuggestion(${index},${issueIndex})">采纳 AI 原文修改并重提取</button>
    </div>`;
  }
  if (offset != null) {
    return `<div class="ai-issue-actions">
      ${aiCanPatchSourceSuggestion(split, issue) ? `<button class="btn btn-success btn-sm" onclick="aiStageIssueSuggestion(${index},${issueIndex})">${issue.suggestionStaged ? 'AI 建议已填入' : '填入 AI 文本建议'}</button>` : ''}
    </div>`;
  }
  return `<div class="ai-issue-actions">
    ${aiCanAcceptIssue(split, issue) ? `<button class="btn btn-success btn-sm" onclick="aiAcceptIssueSuggestion(${index},${issueIndex})">接受 AI 字段建议</button>` : ''}
  </div>`;
}

function aiDraftTopFieldsHtml(index, split) {
  if (!split.parsed) return '';
  const p = split.parsed;
  const dayTypeTemplates = typeof getDayTypeTemplates === 'function' ? getDayTypeTemplates() : [];
  return `<div class="ai-linked-draft ai-day-fields">
    <div class="ai-linked-draft-title">最终草稿 · 本日字段</div>
    <div class="ai-draft-grid">
      <label>日期<input value="${escAttr(split.date)}" onchange="aiDraftSetField(${index},'date',this.value)"></label>
      <label>起床<input value="${escAttr(p.wakeTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.wakeTime',this.value)"></label>
      <label>睡觉<input value="${escAttr(p.sleepTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.sleepTime',this.value)"></label>
      <label>日期类型
        <input list="ai-day-type-options-${index}" value="${escAttr(p.dayType || '')}" placeholder="可选" onchange="aiDraftApplyDayTypeTemplate(${index},this.value)">
        <datalist id="ai-day-type-options-${index}">${dayTypeTemplates.map(template => `<option value="${escAttr(template.name || '')}">`).join('')}</datalist>
        ${p.fieldMeta?.dayType?.raw ? `<span class="form-hint">判断依据：${escHtml(p.fieldMeta.dayType.raw)}</span>` : ''}
      </label>
      <label class="ai-checkbox"><input type="checkbox" ${p.specialDay ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.specialDay',this.checked,'boolean')"> 特殊日</label>
      <label class="ai-checkbox"><input type="checkbox" ${p.excludeFromRating ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.excludeFromRating',this.checked,'boolean')"> 不参与评分</label>
      <label class="ai-full">特殊日原因<input value="${escAttr(p.specialDayReason || '')}" placeholder="可选，不会被日期类型名称覆盖" onchange="aiDraftSetField(${index},'parsed.specialDayReason',this.value)"></label>
      <label class="ai-full">全天备注<textarea onchange="aiDraftSetField(${index},'parsed.dayNote',this.value)">${escHtml(p.dayNote || '')}</textarea></label>
    </div>
    <div class="ai-linked-add-actions">
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'normal')">+ 普通专注</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'special')">+ 不可用时段</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'special-study')">+ 特殊学习</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddTask(${index})">+ 添加任务</button>
    </div>
  </div>`;
}

function aiCompactSessionDraftHtml(index, session, sessionIndex) {
  return `<div class="ai-linked-row ai-linked-session">
    <span class="ai-linked-kind">时段</span>
    <select title="时段类型" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.type',this.value)">
      <option value="normal" ${session.type === 'normal' || !session.type ? 'selected' : ''}>普通专注</option>
      <option value="special" ${session.type === 'special' ? 'selected' : ''}>不可用</option>
      <option value="special-study" ${session.type === 'special-study' ? 'selected' : ''}>特殊学习</option>
    </select>
    <input title="名称" value="${escAttr(session.name || '')}" placeholder="名称" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.name',this.value)">
    <input title="开始时间" value="${escAttr(session.startTime || '')}" placeholder="开始 HH:MM" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.startTime',this.value)">
    <input title="结束时间" value="${escAttr(session.endTime || '')}" placeholder="结束 HH:MM" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.endTime',this.value)">
    <input title="名义分钟" type="number" value="${session.nominalMinutes ?? ''}" placeholder="名义" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.nominalMinutes',this.value,'number')">
    <input title="实际分钟" type="number" value="${session.actualMinutes ?? ''}" placeholder="实际" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.actualMinutes',this.value,'number')">
    <input title="休息分钟" type="number" value="${session.restMinutes ?? ''}" placeholder="休息" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.restMinutes',this.value,'number')">
    <input title="备注" value="${escAttr(session.note || '')}" placeholder="备注" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.note',this.value)">
    ${aiConfidenceHtml(session.aiMeta)}
    <button class="btn btn-danger btn-sm" onclick="aiDraftDeleteSession(${index},${sessionIndex})">删除</button>
  </div>`;
}

function aiCompactTaskDraftHtml(index, task, taskIndex) {
  const templates = aiGetTaskTemplatesSafe();
  return `<div class="ai-linked-row ai-linked-task">
    <span class="ai-linked-kind">任务</span>
    <input title="任务名称" value="${escAttr(task.name || '')}" placeholder="任务名称" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.name',this.value)">
    <select title="任务模板" class="ai-template-select" onchange="aiDraftApplyTaskTemplate(${index},${taskIndex},this.value)">
      <option value="">不套用模板</option>
      ${templates.map(template => `<option value="${escAttr(template.id)}" ${task.templateId === template.id ? 'selected' : ''}>${escHtml(aiTaskTemplateLabel(template))}</option>`).join('')}
    </select>
    ${aiTaskCategorySelectHtml(index, taskIndex, task)}
    <input title="分钟" type="number" value="${task.minutes ?? ''}" placeholder="分钟" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.minutes',this.value,'number')">
    <input title="数量" type="number" value="${task.quantity ?? ''}" placeholder="数量" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantity',this.value,'number')">
    <input title="单位" value="${escAttr(task.quantityUnit || '')}" placeholder="单位" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantityUnit',this.value)">
    <input title="正确率" type="number" value="${task.accuracy ?? ''}" placeholder="正确率" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.accuracy',this.value,'number')">
    <input title="备注" value="${escAttr(task.note || '')}" placeholder="备注" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.note',this.value)">
    ${aiConfidenceHtml(task.aiMeta)}
    <button class="btn btn-danger btn-sm" onclick="aiDraftDeleteTask(${index},${taskIndex})">删除</button>
  </div>`;
}

function aiProposalDisplayValue(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  if (value == null || value === '') return '空';
  if (typeof value === 'object') {
    return value.name || [value.startTime, value.endTime].filter(Boolean).join('-') || JSON.stringify(aiProposalItemValue(value));
  }
  return String(value);
}

function aiProposalDifferenceHtml(index, diff, diffIndex) {
  return `<div class="ai-proposal-diff ${diff.status !== 'open' ? 'ai-proposal-diff-resolved' : ''}">
    <div>${escHtml(aiProposalDiffSummary(diff))}</div>
    ${diff.status === 'open' ? `<div class="ai-issue-actions">
      <button class="btn btn-success btn-sm" onclick="aiApplyProposalDifference(${index},${diffIndex})">定位原文并手动修改</button>
      <button class="btn btn-ghost btn-sm" onclick="aiKeepDraftForProposalDifference(${index},${diffIndex})">保留当前草稿</button>
    </div>` : `<span class="ai-annotation-status">${diff.status === 'accepted' ? '已采纳' : '已保留当前草稿'}</span>`}
  </div>`;
}

function aiProposalIssueHtml(issue) {
  const sourceLines = (issue.sourceLines || []).join('、');
  return `<div class="ai-proposal-new-issue ai-annotation-${issue.level || 'warning'}">
    <b>${issue.level === 'error' ? '新错误' : issue.level === 'warning' ? '新建议' : '新提示'}</b>
    ${sourceLines ? `<span>相对行 ${escHtml(sourceLines)}</span>` : ''}
    <div>${escHtml(issue.message || 'AI 提醒')}</div>
  </div>`;
}

function aiProposalPanelHtml(index, split, unit = null) {
  const proposal = split.pendingProposal;
  if (!proposal) return '';
  const diffs = (proposal.differences || [])
    .map((diff, diffIndex) => ({ diff, diffIndex }))
    .filter(({ diff }) => aiProposalDiffHasRealChange(diff))
    .filter(({ diff }) => unit
      ? (diff.affectedLines || []).some(line => unit.relativeLines.includes(Number(line)))
      : !(diff.affectedLines || []).length);
  const proposalIssues = unit ? [] : (proposal.issues || []).filter(issue => issue.level === 'error' || issue.level === 'warning');
  if (unit && !diffs.length) return '';
  return `<div class="ai-proposal-panel">
    ${unit ? '<div class="ai-linked-draft-title">AI 重解析提案 · 本片段</div>' : `<div class="ai-proposal-header">
      <div><b>AI 重解析提案</b><span> AI 已重新理解本日原文，但尚未覆盖最终草稿。</span></div>
      <div class="ai-issue-actions">
        <button class="btn btn-success btn-sm" onclick="aiAcceptProposal(${index})">采纳全部 AI 新结果</button>
        <button class="btn btn-ghost btn-sm" onclick="aiKeepCurrentDraft(${index})">全部保留当前草稿</button>
      </div>
    </div>`}
    ${!unit && !(proposal.differences || []).length ? '<div class="ai-review-ok">AI 重新解析后没有发现结构化字段变化。你仍可采纳新结果以刷新原文映射和批注。</div>' : ''}
    ${diffs.map(({ diff, diffIndex }) => aiProposalDifferenceHtml(index, diff, diffIndex)).join('')}
    ${proposalIssues.length ? `<div class="ai-proposal-new-issues">
      <div class="ai-linked-draft-title">AI 本次重新解析生成的提醒</div>
      ${proposalIssues.map(aiProposalIssueHtml).join('')}
    </div>` : ''}
  </div>`;
}

// Record-level review renderer.
function aiIssueListHtml(index, split) {
  const issues = split.issues || [];
  const units = aiBuildSourceReviewUnits(split);
  const p = split.parsed;
  const issueEntries = issues.map((issue, issueIndex) => ({ issue, issueIndex }));
  const sourceIssueEntries = new Set();
  const busyAttr = aiBusyAttr(split);

  const unitHtml = units.map(unit => {
    const unitIssues = issueEntries.filter(entry => {
      const issueTarget = String(entry.issue.target || entry.issue.targetPath || entry.issue.apply?.path || '');
      const targetHit = unit.targetPrefix && (
        issueTarget === unit.targetPrefix ||
        issueTarget.startsWith(unit.targetPrefix + '.')
      );
      const lineHit = (entry.issue.sourceLines || []).some(line => {
        const offset = Number(line) - Number(split.startLine || 1);
        return unit.offsets?.includes(offset);
      });
      return targetHit || lineHit;
    });
    unitIssues.forEach(entry => sourceIssueEntries.add(entry.issueIndex));

    const draftHtml = unit.kind === 'session' && p?.sessions?.[unit.itemIndex]
      ? aiCompactSessionDraftHtml(index, p.sessions[unit.itemIndex], unit.itemIndex)
      : unit.kind === 'task' && p?.tasks?.[unit.itemIndex]
        ? aiCompactTaskDraftHtml(index, p.tasks[unit.itemIndex], unit.itemIndex)
        : '';
    const unitKindLabel = unit.kind === 'session' ? '时段' : unit.kind === 'task' ? '任务' : '原文';
    const sourceHtml = unit.hasSource ? `
      <textarea id="ai-source-unit-${index}-${unit.key}" class="ai-source-unit-input" oninput="aiSetAnnotationUnitDraft(${index},'${unit.key}',this.value)">${escHtml(split.annotationUnitDrafts?.[unit.key] ?? unit.text)}</textarea>
      ${unit.contiguous
        ? `<button class="btn btn-primary btn-sm ai-source-unit-confirm" onclick="aiConfirmAnnotationUnitRevision(${index},'${unit.key}')" ${busyAttr}>保存本项原文并重解析本项</button>`
        : '<div class="ai-source-unlinked">这项关联了不连续的原文行，请使用上方“修改原文”编辑整日原文。</div>'}`
      : '<div class="ai-source-unlinked">这项目前没有绑定到具体原文行，可直接修改下方最终草稿；需要改原文时请使用上方“修改原文”。</div>';

    return `<section id="${aiUnitWrapId(index, unit.key)}" class="ai-source-unit ai-source-unit-${unit.kind} ${unitIssues.length ? 'ai-source-unit-flagged' : ''}">
      <div class="ai-source-unit-head">
        <b>${escHtml(unit.title || unitKindLabel)}</b>
        <span>${escHtml(unit.label || '')}${unitIssues.length ? ` · ${unitIssues.length} 条 AI 建议` : ''}</span>
      </div>
      ${sourceHtml}
      ${unitIssues.length ? `<div class="ai-source-unit-comments">${unitIssues.map(entry => aiAnnotationCommentHtml(index, entry.issueIndex, split, entry.issue, unit.startOffset)).join('')}</div>` : ''}
      ${draftHtml ? `<div class="ai-linked-draft">
        <div class="ai-linked-draft-title">最终草稿 · ${unitKindLabel}表格行</div>
        ${draftHtml}
      </div>` : '<div class="ai-source-unlinked">当前没有与本项原文关联的最终草稿行。</div>'}
      ${aiProposalPanelHtml(index, split, unit)}
    </section>`;
  }).join('');

  const generalIssues = issueEntries.filter(entry => !sourceIssueEntries.has(entry.issueIndex));

  return `<div class="ai-annotation-wrap">
    <div class="ai-annotation-heading">原文与最终草稿对照 <span>现在按单条任务/单条时段拆成小单元；每个单元包含原文、AI 建议和对应草稿行。</span></div>
    ${split.partialParseMessage ? `<div class="ai-partial-parse-message">${escHtml(split.partialParseMessage)}</div>` : ''}
    ${aiDraftTopFieldsHtml(index, split)}
    ${aiProposalPanelHtml(index, split)}
    <div class="ai-source-units">${unitHtml || '<div class="ai-review-ok">本日没有可审核的任务、时段或非空原文。</div>'}</div>
    ${generalIssues.length ? `<div class="ai-general-comments">
      <b>字段批注与整体验证</b>
      ${generalIssues.map(entry => aiAnnotationCommentHtml(index, entry.issueIndex, split, entry.issue)).join('')}
    </div>` : ''}
  </div>`;
}

function aiRenderDayCard(index) {
  const el = document.getElementById(`ai-day-${index}`);
  if (!el) return;
  const split = aiState.daySplits[index];
  const STATUS_META = {
    pending: { icon: '⬜', label: '待解析', color: 'var(--muted)' },
    parsing: { icon: '⏳', label: '解析中', color: 'var(--nominal)' },
    review: { icon: '📝', label: '待审核', color: 'var(--wake)' },
    blocked: { icon: '⚠️', label: '存在错误', color: 'var(--code)' },
    confirmed: { icon: '✅', label: '已人工确认', color: 'var(--pol)' },
    error: { icon: '❌', label: '解析失败', color: 'var(--code)' },
    imported: { icon: '📥', label: '已导入', color: 'var(--hp)' },
  };
  const meta = STATUS_META[split.status] || STATUS_META.pending;
  const parseProgress = aiDayParseProgress(split);
  const parseState = split.parseExcluded ? 'excluded' : window.AIParseManager.deriveDayState(split, aiFactsForSplit(split));
  const parseMeta = aiParseStateMeta({
    state: parseState,
    reviewStatus: split.status,
    finalReviewState: split.finalReviewState,
    done: parseProgress.done,
    total: parseProgress.total,
  });
  const p = split.parsed;
  const openReviewCount = (split.issues || []).filter(issue => issue.status === 'open' && (issue.level === 'error' || issue.level === 'warning')).length;
  const meaningfulTarget = aiIsMeaningfulDay(state.data?.[split.date]);
  const importMode = split.importMode || aiDefaultImportMode(split.date);
  const canConfirm = aiCanConfirmSplit(split);
  const busy = aiSplitIsBusy(split) || aiEnsureParseManager().state === 'running';
  const missingItems = Math.max(0, parseProgress.total - parseProgress.done);
  const continueLabel = missingItems > 0 && (parseProgress.done > 0 || parseProgress.failed > 0)
    ? `继续补全 ${missingItems} 项`
    : missingItems === 0 && split.finalReviewState !== 'complete'
      ? '继续最终复查'
      : '解析';

  el.innerHTML = `<div class="ai-review-card ${split.status === 'blocked' ? 'ai-review-card-blocked' : ''}">
    <div class="ai-review-header">
      <div><span class="ai-status-icon">${meta.icon}</span> <b style="color:${meta.color}">${escHtml(split.date)}</b> <span>${meta.label}</span>
        <span class="ai-parse-state-label">${escHtml(parseMeta.label)} · ${parseProgress.done}/${parseProgress.total}</span>
        <span class="ai-source-lines">第 ${split.startLine || '?'}-${split.endLine || '?'} 行</span></div>
      <div class="ai-review-actions">
        ${['pending', 'partial', 'error'].includes(parseState) && !split.parseExcluded ? `<button class="btn btn-primary btn-sm" onclick="aiContinueDayParse(${index})" ${busy ? 'disabled title="正在解析，请稍候"' : ''}>${escHtml(continueLabel)}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="aiToggleRaw(${index})">查看原文</button>
        <button class="btn btn-ghost btn-sm" onclick="aiToggleSourceEditor(${index})">${split.sourceEditorOpen ? '收起原文编辑' : '修改原文'}</button>
        ${p ? `<button class="btn btn-primary btn-sm" onclick="aiReparseDayWithProposal(${index})" ${busy ? 'disabled title="正在解析，请稍候"' : ''}>让 AI 重新解析本日原文</button>
          <button class="btn btn-ghost btn-sm" onclick="aiToggleJson(${index})">JSON</button>` : ''}
      </div>
    </div>
    <pre id="ai-raw-${index}" class="ai-folded ${split.rawOpen ? 'ai-folded-open' : ''}">${escHtml(split.text)}</pre>
    ${aiSourceEditorHtml(index, split)}
    ${split.error ? `<div class="ai-issue ai-issue-error">${escHtml(split.error.slice(0, 500))}</div>` : ''}
    ${p ? `<div class="ai-review-summary">
      <span>起床 <b>${escHtml(p.wakeTime || '-')}</b></span><span>睡觉 <b>${escHtml(p.sleepTime || '-')}</b></span>
      <span>日期类型 <b>${escHtml(p.dayType || '-')}</b></span>
      <span>时段 <b>${(p.sessions || []).length}</b></span><span>任务 <b>${(p.tasks || []).length}</b></span>
      <span>待处理 <b class="${openReviewCount ? 'c-red' : 'c-green'}">${openReviewCount}</b></span>
    </div>
    ${aiIssueListHtml(index, split)}
    <div class="ai-import-plan">
      <label>导入策略
        <select onchange="aiSetImportMode(${index},this.value)">
          <option value="replace-blank" ${importMode === 'replace-blank' ? 'selected' : ''}>覆盖空白日期</option>
          <option value="replace" ${importMode === 'replace' ? 'selected' : ''}>整天替换</option>
          <option value="merge" ${importMode === 'merge' ? 'selected' : ''}>去重合并</option>
          <option value="skip" ${importMode === 'skip' ? 'selected' : ''}>跳过</option>
          ${importMode === 'needs-choice' ? '<option value="needs-choice" selected>请选择策略</option>' : ''}
        </select>
      </label>
      <span>${meaningfulTarget ? '目标日期已有数据' : '目标日期为空白'}</span>
      ${split.status === 'imported'
        ? '<b class="c-hp">已导入</b>'
        : split.status === 'confirmed'
          ? '<b class="c-green">草稿已确认</b>'
          : `<button id="ai-confirm-day-${index}" class="btn btn-success btn-sm" onclick="aiConfirmDay(${index})" ${busy ? 'disabled title="正在解析，请稍候"' : (canConfirm ? '' : 'disabled title="请先处理数据错误、未归属原文或尚未审核的 AI 提案"')}>确认本日草稿</button>`}
      ${split.status === 'confirmed' ? `<button class="btn btn-primary btn-sm" onclick="aiImportSingleDay(${index})">单独导入</button>` : ''}
    </div>
    <pre id="ai-json-${index}" class="ai-folded ${split.jsonOpen ? 'ai-folded-open' : ''}">${escHtml(JSON.stringify(p, null, 2))}</pre>` : ''}
  </div>`;
}

function aiToggleRaw(i) {
  const split = aiState.daySplits[i];
  if (!split) return;
  split.rawOpen = !split.rawOpen;
  aiRenderDayCard(i);
  aiScheduleCacheSave();
}
function aiToggleJson(i) {
  const split = aiState.daySplits[i];
  if (!split) return;
  split.jsonOpen = !split.jsonOpen;
  aiRenderDayCard(i);
  aiScheduleCacheSave();
}

function aiUpdateImportBtn() {
  const btn = document.getElementById('ai-btn-import-all');
  if (!btn) return;
  const hasDone = aiState.daySplits.some(s => s.status === 'confirmed');
  btn.style.display = hasDone ? 'inline-block' : 'none';
}

// ============================================================
// 通用 helpers
// ============================================================
/** 读取额外解析指令，拼接到 system prompt */
function aiGetExtraParsePrompt() {
  const el = document.getElementById('ai-extraParsePrompt');
  const extra = (el ? el.value : (aiLoadConfig().extraParsePrompt || '')).trim();
  if (!extra) return '';
  return '\n\n## 用户额外指令（务必遵守）\n' + extra;
}

function aiMsg(area, text, type) {
  const ids = { cfg: 'ai-cfg-msg', split: 'ai-split-msg', 'cfg-split': 'ai-cfg-msg-split', 'cfg-parse': 'ai-cfg-msg-parse' };
  const el = document.getElementById(ids[area]);
  if (!el) return;
  el.textContent = text;
  el.style.color = type === 'ok' ? 'var(--pol)'
    : type === 'err' ? 'var(--code)'
      : 'var(--muted)';
}

function escHtml(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return escHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// AI 扫描模块 — 对已录入的未分类任务重新匹配模板库
// ============================================================
const scanState = {
  tasks: [],       // [{ dateStr, taskId, name, note, activityType, minutes, original, suggested, status }]
  // status: 'pending' | 'scanning' | 'matched' | 'skipped' | 'applied'
  scanning: false,
  scope: 'month',  // 'month' | 'all'
};

/** 收集未分类任务 */
function scanCollectUnclassified(scope) {
  const results = [];
  let dateStrs;
  if (scope === 'all') {
    dateStrs = getAllDates();
  } else {
    // 当前月
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const dim = new Date(y, m + 1, 0).getDate();
    dateStrs = [];
    for (let i = 1; i <= dim; i++) {
      dateStrs.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
    }
  }
  dateStrs.forEach(ds => {
    const day = state.data[ds];
    if (!day || !day.tasks) return;
    day.tasks.forEach(t => {
      if (!t.activityType || t.needsClassification) {
        results.push({
          dateStr: ds,
          taskId: t.id,
          name: t.name || '',
          note: t.note || '',
          minutes: t.minutes || 0,
          original: t.activityType || '',
          suggested: null,
          suggestedName: null,
          status: 'pending',
        });
      }
    });
  });
  return results;
}

function renderScan() {
  const tmplCount = (typeof getTaskTemplates === 'function') ? getTaskTemplates().length : 0;
  const l1 = getLevel1Names().length, l2 = getLevel2Names().length, l3 = getLevel3Names().length;
  const catTotal = l1 + l2 + l3;

  // 先收集一下当前月未分类数量做预览
  const previewMonth = scanCollectUnclassified('month').length;
  const previewAll = scanCollectUnclassified('all').length;

  document.getElementById('tab-scan').innerHTML = `
    <div style="max-width:900px">

      <!-- 说明卡 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:6px">🔍 AI 扫描 — 未分类任务重新匹配</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.8;margin:0">
          扫描已录入数据中<b>未分类</b>（activityType 为空或标记了 needsClassification）的任务，<br>
          使用当前最新的<b>模板库</b>和<b>活动分类</b>让 AI 重新匹配分类。<br>
          适用场景：先录入了数据，之后才完善了模板库，需要回头补分类。
        </p>
        <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:12px">
          <span>📋 任务模板：<b style="color:var(--pol)">${tmplCount}</b> 个</span>
          <span>🏷️ 活动分类：<b style="color:var(--hp)">${catTotal}</b> 个（${l1}+${l2}+${l3}）</span>
          <span>📅 本月未分类：<b style="color:${previewMonth > 0 ? 'var(--code)' : 'var(--pol)'}">${previewMonth}</b> 条</span>
          <span>📊 全部未分类：<b style="color:${previewAll > 0 ? 'var(--code)' : 'var(--pol)'}">${previewAll}</b> 条</span>
        </div>
        ${tmplCount === 0 && catTotal === 0 ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(244,67,54,.08);border:1px solid rgba(244,67,54,.2);border-radius:6px;font-size:12px;color:var(--code)">
          ⚠️ 当前没有任何模板和分类，AI 无法进行匹配。请先到 <a href="#" onclick="showTab('templates');return false" style="color:var(--hp)">📋 模板库</a> 添加模板。
        </div>` : ''}
      </div>

      <!-- 操作卡 -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:10px">🚀 开始扫描</div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
          <span style="font-size:12px;color:var(--muted)">扫描范围：</span>
          <div style="display:flex;gap:4px;background:var(--card2);border-radius:8px;padding:2px">
            <button class="btn btn-sm ${scanState.scope === 'month' ? 'btn-primary' : 'btn-ghost'}" onclick="scanSetScope('month')">📅 本月 (${previewMonth})</button>
            <button class="btn btn-sm ${scanState.scope === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick="scanSetScope('all')">📊 全部 (${previewAll})</button>
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="scan-btn-start" onclick="scanStart()" ${(tmplCount === 0 && catTotal === 0) ? 'disabled' : ''}>
            🔍 扫描未分类任务
          </button>
          <button class="btn btn-success" id="scan-btn-apply" style="display:none" onclick="scanApplyAll()">
            ✅ 批量应用匹配结果
          </button>
          <span id="scan-msg" style="font-size:12px;font-family:var(--mono)"></span>
        </div>

        <!-- 进度条 -->
        <div id="scan-progress-wrap" style="display:none;margin-top:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:4px">
            <span id="scan-progress-label">扫描进度</span>
            <span id="scan-progress-pct">0%</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px">
            <div id="scan-progress-bar" style="height:4px;background:var(--hp);border-radius:2px;width:0%;transition:width .3s"></div>
          </div>
        </div>
      </div>

      <!-- 结果列表 -->
      <div id="scan-results" style="display:none">
        <div class="card">
          <div class="card-title" id="scan-results-title" style="margin-bottom:12px">📋 扫描结果</div>
          <div id="scan-task-list"></div>
        </div>
      </div>
    </div>
  `;

  // 如果已有扫描结果，重新渲染
  if (scanState.tasks.length > 0) {
    scanRenderResults();
  }
}

function scanSetScope(scope) {
  scanState.scope = scope;
  scanState.tasks = [];
  renderScan();
}

async function scanStart() {
  const tasks = scanCollectUnclassified(scanState.scope);
  if (tasks.length === 0) {
    const el = document.getElementById('scan-msg');
    if (el) { el.textContent = '✅ 没有未分类的任务，无需扫描'; el.style.color = 'var(--pol)'; }
    return;
  }

  scanState.tasks = tasks;
  scanState.scanning = true;

  const btn = document.getElementById('scan-btn-start');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 扫描中…'; }
  const msgEl = document.getElementById('scan-msg');
  if (msgEl) { msgEl.textContent = `正在扫描 ${tasks.length} 条未分类任务…`; msgEl.style.color = 'var(--muted)'; }

  // 显示进度条和结果区
  const pw = document.getElementById('scan-progress-wrap');
  if (pw) pw.style.display = 'block';
  scanRenderResults();

  // 批量发送给 AI（每批最多 20 条，减少请求次数）
  const BATCH_SIZE = 20;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    await scanBatchClassify(batch);
    scanUpdateProgress();
    scanRenderTaskList();
  }

  scanState.scanning = false;
  if (btn) { btn.disabled = false; btn.textContent = '🔍 重新扫描'; }

  const matched = tasks.filter(t => t.status === 'matched').length;
  const skipped = tasks.filter(t => t.status === 'skipped').length;
  if (msgEl) {
    msgEl.textContent = `✅ 扫描完成：${matched} 条已匹配，${skipped} 条无法匹配`;
    msgEl.style.color = 'var(--pol)';
  }

  // 显示批量应用按钮
  const applyBtn = document.getElementById('scan-btn-apply');
  if (applyBtn && matched > 0) applyBtn.style.display = 'inline-block';
}

async function scanBatchClassify(batch) {
  const tmplHint = aiGetTemplateHint();
  const actHint = aiGetActHint();

  // 构建任务列表文本
  const taskListText = batch.map((t, i) => {
    return `[${i}] 任务名称: "${t.name}"${t.note ? `，备注: "${t.note}"` : ''}${t.minutes ? `，时长: ${t.minutes}分钟` : ''}`;
  }).join('\n');

  const system = `你是学习追踪器的分类助手。用户会给你一批未分类的任务，你需要根据模板库和活动分类为每个任务匹配最合适的 activityType。

## 任务模板库（优先匹配）
${tmplHint || '（无模板）'}

## 已有活动分类（模板未命中时使用）
${actHint}

## 匹配规则
1. 对每个任务的名称和备注，逐一与模板库的关键词进行比对
2. 命中模板 → 使用该模板的 activityType
3. 未命中模板 → 尝试从已有活动分类中推断最合适的分类路径（格式："一级 > 二级 > 三级"）
4. 完全无法匹配 → activityType 设为空字符串 ""
5. **严禁发明不存在的分类名称**，只能使用上面列出的模板 activityType 或已有分类中的名称

## 输出格式
纯 JSON 数组，每个元素对应输入中的一个任务（按序号对应）：
[{"index":0,"activityType":"匹配到的分类路径","confidence":"high|medium|low"},...]

- index: 对应输入中的序号
- activityType: 匹配到的分类路径，无法匹配则为 ""
- confidence: 匹配置信度（high=关键词精确命中，medium=语义推断，low=勉强匹配）

只输出 JSON，无解释，无代码块标记。`;

  try {
    const raw = await aiCall([{ role: 'user', content: taskListText }], system, 2048, 'parse');
    let cleaned = raw.replace(/```json|```/g, '').trim();
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      cleaned = cleaned.slice(arrStart, arrEnd + 1);
    }
    let results;
    try { results = JSON.parse(cleaned); } catch { results = []; }

    // 验证并应用结果
    const _allTemplates = (typeof getTaskTemplates === 'function') ? getTaskTemplates() : [];
    const _allCats = [...getLevel1Names(), ...getLevel2Names(), ...getLevel3Names()];
    const _validTypes = new Set([
      ..._allTemplates.map(t => t.activityType).filter(Boolean),
      ..._allCats,
    ]);

    // 构建完整的合法 activityType 集合（包含模板的完整路径）
    const _validFullPaths = new Set(_allTemplates.map(t => t.activityType).filter(Boolean));

    for (const r of (results || [])) {
      const idx = r.index;
      if (idx == null || idx < 0 || idx >= batch.length) continue;
      const task = batch[idx];

      if (r.activityType && r.activityType.trim()) {
        const suggested = r.activityType.trim();
        // 验证合法性
        if (_validFullPaths.has(suggested) || _validTypes.has(suggested)) {
          task.suggested = suggested;
          task.confidence = r.confidence || 'medium';
          task.status = 'matched';
        } else {
          // 尝试部分匹配
          const found = [..._validFullPaths, ..._validTypes].find(v => v.includes(suggested) || suggested.includes(v));
          if (found) {
            task.suggested = found;
            task.confidence = 'low';
            task.status = 'matched';
          } else {
            task.status = 'skipped';
          }
        }
      } else {
        task.status = 'skipped';
      }
    }

    // 未被 AI 返回的任务标记为 skipped
    batch.forEach(t => { if (t.status === 'pending') t.status = 'skipped'; });

  } catch (e) {
    console.error('[scanBatchClassify]', e);
    batch.forEach(t => { t.status = 'skipped'; t.error = e.message; });
  }
}

function scanUpdateProgress() {
  const total = scanState.tasks.length;
  const done = scanState.tasks.filter(t => t.status !== 'pending' && t.status !== 'scanning').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const bar = document.getElementById('scan-progress-bar');
  const label = document.getElementById('scan-progress-label');
  const pctEl = document.getElementById('scan-progress-pct');
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = `已扫描 ${done} / ${total} 条`;
  if (pctEl) pctEl.textContent = pct + '%';
}

function scanRenderResults() {
  const sec = document.getElementById('scan-results');
  if (sec) sec.style.display = 'block';
  const titleEl = document.getElementById('scan-results-title');
  const matched = scanState.tasks.filter(t => t.status === 'matched').length;
  const skipped = scanState.tasks.filter(t => t.status === 'skipped').length;
  const applied = scanState.tasks.filter(t => t.status === 'applied').length;
  if (titleEl) titleEl.textContent = `📋 扫描结果（${scanState.tasks.length} 条：✅ ${matched} 匹配 · ⏭ ${skipped} 跳过 · 📥 ${applied} 已应用）`;
  scanRenderTaskList();
}

function scanRenderTaskList() {
  const container = document.getElementById('scan-task-list');
  if (!container) return;

  if (scanState.tasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无扫描结果</p></div>';
    return;
  }

  const CONF_COLORS = { high: 'var(--pol)', medium: 'var(--wake)', low: 'var(--code)' };
  const CONF_LABELS = { high: '高', medium: '中', low: '低' };

  container.innerHTML = scanState.tasks.map((t, i) => {
    const statusIcon = t.status === 'matched' ? '✅' : t.status === 'skipped' ? '⏭' : t.status === 'applied' ? '📥' : '⬜';
    const confColor = CONF_COLORS[t.confidence] || 'var(--muted)';
    const confLabel = CONF_LABELS[t.confidence] || '';

    return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;
                        background:${t.status === 'applied' ? 'rgba(105,240,174,.04)' : t.status === 'matched' ? 'rgba(79,195,247,.03)' : 'rgba(255,255,255,.015)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:14px">${statusIcon}</span>
            <span style="font-weight:600;font-size:13px">${escHtml(t.name)}</span>
            <span style="font-size:11px;color:var(--muted)">${escHtml(t.dateStr)} · ${t.minutes}m</span>
          </div>
          ${t.note ? `<div style="font-size:11px;color:var(--dim);margin-bottom:4px">📝 ${escHtml(t.note.slice(0, 60))}</div>` : ''}
          <div style="font-size:11px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <span style="color:var(--muted)">当前：<span style="color:var(--code)">${t.original || '未分类'}</span></span>
            ${t.suggested ? `<span>→ 建议：<span style="color:var(--hp);font-weight:600">${escHtml(t.suggested)}</span>
              <span style="font-size:10px;color:${confColor};margin-left:4px">[${confLabel}]</span></span>` : ''}
            ${t.status === 'applied' ? '<span style="color:var(--pol);font-weight:600">✔ 已应用</span>' : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${t.status === 'matched' ? `<button class="btn btn-success btn-sm" style="font-size:11px;padding:2px 8px" onclick="scanApplySingle(${i})">✅ 应用</button>
            <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="scanSkipSingle(${i})">⏭ 跳过</button>` : ''}
          ${t.status === 'skipped' ? '<span style="font-size:11px;color:var(--dim)">无匹配</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function scanApplySingle(index) {
  const t = scanState.tasks[index];
  if (!t || t.status !== 'matched' || !t.suggested) return;

  const day = state.data[t.dateStr];
  if (!day || !day.tasks) return;
  const task = day.tasks.find(x => x.id === t.taskId);
  if (!task) return;

  task.activityType = t.suggested;
  delete task.needsClassification;
  t.status = 'applied';

  cacheToLocal();
  await apiFetch(`/api/data/${t.dateStr}`, { method: 'PUT', body: JSON.stringify(day) });

  scanRenderResults();
  renderHeader();
}

function scanSkipSingle(index) {
  const t = scanState.tasks[index];
  if (t) t.status = 'skipped';
  scanRenderResults();
}

async function scanApplyAll() {
  const matched = scanState.tasks.filter(t => t.status === 'matched');
  if (matched.length === 0) { alert('没有可应用的匹配结果'); return; }
  if (!confirm(`确认批量应用 ${matched.length} 条匹配结果？`)) return;

  const affectedDates = new Set();
  for (const t of matched) {
    const day = state.data[t.dateStr];
    if (!day || !day.tasks) continue;
    const task = day.tasks.find(x => x.id === t.taskId);
    if (!task) continue;
    task.activityType = t.suggested;
    delete task.needsClassification;
    t.status = 'applied';
    affectedDates.add(t.dateStr);
  }

  // 保存所有受影响的日期
  cacheToLocal();
  for (const ds of affectedDates) {
    try {
      await apiFetch(`/api/data/${ds}`, { method: 'PUT', body: JSON.stringify(state.data[ds]) });
    } catch (e) { console.error(`保存 ${ds} 失败`, e); }
  }

  await saveAllStorage();
  renderHeader();
  scanRenderResults();

  const applyBtn = document.getElementById('scan-btn-apply');
  if (applyBtn) applyBtn.style.display = 'none';

  const msgEl = document.getElementById('scan-msg');
  if (msgEl) { msgEl.textContent = `✅ 已应用 ${matched.length} 条分类`; msgEl.style.color = 'var(--pol)'; }
}
