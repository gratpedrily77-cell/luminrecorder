// ============================================================
// 学习追踪器 — AI 管控模块 (ai_module.js)
// 通过自然语言批量录入，AI 负责拆分与结构化解析
// ============================================================

const AI_PARSER_VERSION = window.AIParserCore?.VERSION || 2;

// ── AI 状态 ───────────────────────────────────────────────────
const aiState = {
  daySplits: [],   // [{ id, date, text, startLine, endLine, status, parsed, issues }]
  // status: 'pending' | 'parsing' | 'review' | 'blocked' | 'confirmed' | 'error' | 'imported'
  rawInput: '',    // 原始输入文本
  sourceMeta: { fileName: '', lineCount: 0, charCount: 0, loadedAt: '' },
  sourceIssues: [],
  parserVersion: AI_PARSER_VERSION,
  networkConcurrency: 1,
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
      }),
    });
  } catch (e) { console.warn('AI缓存保存失败', e); }
}

async function aiLoadCacheFromServer() {
  try {
    const res = await fetch('/api/cache');
    const cache = await res.json();
    if (cache && (cache.rawInput || (cache.daySplits && cache.daySplits.length))) {
      const currentParser = Number(cache.parserVersion) === AI_PARSER_VERSION;
      aiState.rawInput = cache.rawInput || '';
      aiState.daySplits = (cache.daySplits || []).map(split => aiNormalizeCachedSplit(currentParser ? split : {
        id: split.id,
        date: split.date,
        text: split.text,
        startLine: split.startLine,
        endLine: split.endLine,
        status: 'pending',
      }));
      aiState.sourceMeta = cache.sourceMeta || aiBuildSourceMeta(aiState.rawInput);
      aiState.sourceIssues = cache.sourceIssues || [];
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
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(1, n));
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
              <label>同时解析天数</label>
              <input type="number" id="ai-parseConcurrency" value="${aiNormalizeParseConcurrency(cfg.parseConcurrency)}" min="1" max="2" step="1">
            </div>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px">默认 1，最多 2。出现限流、空流或网络失败时，本轮会自动降为串行。</div>
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
            <button class="btn btn-primary" id="ai-btn-parse-all" onclick="aiStep2ParseAll()">
              🤖 Step 2：全部解析
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
    aiNetworkGate.active += 1;
    aiNetworkGate.queue.shift()();
  }
}

function aiAcquireNetworkSlot() {
  if (aiNetworkGate.active < aiNetworkGate.limit) {
    aiNetworkGate.active += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => aiNetworkGate.queue.push(resolve));
}

function aiReleaseNetworkSlot() {
  aiNetworkGate.active = Math.max(0, aiNetworkGate.active - 1);
  aiDrainNetworkQueue();
}

async function aiCall(messages, systemPrompt, maxTokens = 3000, step = 'split') {
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

  await aiAcquireNetworkSlot();
  try {
    const res = await fetch(url, { method: 'POST', headers, body });

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
  return status === 429 || status >= 500 || error?.code === 'EMPTY_STREAM' ||
    /Failed to fetch|NetworkError|网络|空|流式接口错误|无法解析流式数据|无法识别的非流式内容/i.test(error?.message || '');
}

function aiWait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function aiCallWithNetworkRetry(messages, systemPrompt, maxTokens, step, maxRetries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await aiCall(messages, systemPrompt, maxTokens, step);
    } catch (error) {
      lastError = error;
      if (!aiIsRetryableNetworkError(error) || attempt >= maxRetries) throw error;
      if (Number(error.status) === 429) aiSetNetworkConcurrency(1);
      const retryAfterMs = Number(error.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0;
      const baseDelay = attempt === 0 ? 2000 : 5000;
      await aiWait(Math.max(retryAfterMs, baseDelay) + Math.floor(Math.random() * 400));
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
  const normalized = {
    id: split.id || uid(),
    date: split.date || '',
    text: split.text || '',
    startLine: split.startLine || null,
    endLine: split.endLine || null,
    status: split.status === 'done' ? 'review' : (split.status || 'pending'),
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
    reviewProposals: split.reviewProposals || [],
    itemParseResults: split.itemParseResults || [],
    sourceFacts: split.sourceFacts || null,
    parserVersion: AI_PARSER_VERSION,
    parsingLocked: false,
    reparseLocked: false,
  };
  if (normalized.parsed) aiValidateDraftDay(normalized);
  return normalized;
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
    parsed: null,
    error: null,
    issues: [],
  }));
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
    return desc;
  });
  return lines.join('\n') + '\n命中模板时，task.templateId 必须填写对应 templateId；未命中模板时 templateId 设为空字符串。';
}

function aiGetSessionTemplateHint() {
  const templates = (typeof getSessionTemplates === 'function') ? getSessionTemplates() : [];
  if (!templates || templates.length === 0) return '';
  const lines = templates.map((t, i) => {
    const kw = (t.keywords || []).join('、') || '（无关键词）';
    let desc = `  - 特殊时段模板#${i + 1} → 名称: "${t.name}"，关键词：${kw}`;
    if (t.note) desc += `，note: "${t.note}"`;
    return desc;
  });
  return lines.join('\n');
}

const AI_ITEM_JSON_BEGIN = '<<<AI_JSON_BEGIN:item-v1>>>';
const AI_ITEM_JSON_END = '<<<AI_JSON_END:item-v1>>>';
const AI_REVIEW_JSON_BEGIN = '<<<AI_JSON_BEGIN:review-v1>>>';
const AI_REVIEW_JSON_END = '<<<AI_JSON_END:review-v1>>>';
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

async function aiStrictMarkedJsonCall({ messages, systemPrompt, maxTokens, step, beginMarker, endMarker, validate }) {
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
      step
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

function aiIsHHMM(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function aiIsDaytimeSleep(value) {
  if (!aiIsHHMM(value)) return false;
  const hour = Number(String(value).slice(0, 2));
  return hour >= 6 && hour <= 20;
}

function aiBuildLineParseUnits(split) {
  return String(split.text || '').replace(/\r\n?/g, '\n').split('\n')
    .map((line, offset) => ({
      key: `line-${offset + 1}`,
      relativeLine: offset + 1,
      absoluteLine: split.startLine ? split.startLine + offset : offset + 1,
      text: line,
      trimmed: line.trim(),
    }))
    .filter(unit => unit.trimmed);
}

function aiLineLooksDateHeading(text) {
  return /^(?:(?:20\d{2})年)?\d{1,2}月\d{1,2}日\s*$/.test(String(text || '').trim());
}

function aiLineParserSystem(split) {
  const actHint = aiGetActHint();
  const tmplHint = aiGetTemplateHint();
  const sessTmplHint = aiGetSessionTemplateHint();
  return `你是学习追踪器的逐项解析助手。你一次只解析一行原文，不能重建整天。

必须严格输出：
${AI_ITEM_JSON_BEGIN}
{"kind":"field|session|task|note|unknown|none","field":"","value":"","session":null,"task":null,"note":{"target":"day|previous-session|previous-task|unknown","text":""},"aiIssues":[]}
${AI_ITEM_JSON_END}

规则：
1. 只解析当前这一行，不要补充别的行内容。
2. 所有时间必须是 24 小时制 HH:MM。
3. 起床行只能输出 kind="field", field="wakeTime"。
4. 睡觉行只能输出 kind="field", field="sleepTime"；睡觉12:xx=00:xx，睡觉1点=01:00，睡觉24点=00:00。
5. 如果睡觉时间会落在 06:00-20:59，禁止写入 field 值，改为 kind="unknown" 并在 aiIssues 里输出 level="error" 的歧义时间问题。
6. 有起止时间的学习行输出 kind="session"；吃饭、洗澡、午休等非学习起止时间输出 session.type="special"。
7. 任务行输出 kind="task"，提取 name/activityType/minutes/quantity/quantityUnit/note。
8. 备注行输出 kind="note"，并选择 target；无法判断时 target="unknown"。
9. 日期标题行输出 kind="unknown"，不要报错。
10. aiIssues 只允许输出 level="error" 的硬错误，不要输出普通建议。
11. 不要输出 sourceLines，程序会自动写入当前行号。

日期：${split.date}

特殊时段模板：
${sessTmplHint || '无'}

任务模板：
${tmplHint || '无'}

已有活动分类：
${actHint || '无'}`;
}

function aiValidateLineParseValue(value) {
  const kind = String(value?.kind || '').toLowerCase();
  const allowedKinds = ['field', 'session', 'task', 'note', 'unknown', 'none'];
  if (!allowedKinds.includes(kind)) throw new Error('kind 不合法：' + (value?.kind || '空'));
  if (!Array.isArray(value.aiIssues)) value.aiIssues = [];
  if (kind === 'field') {
    const field = value.field;
    if (!['wakeTime', 'sleepTime', 'dayNote', 'specialDay', 'excludeFromRating'].includes(field)) {
      throw new Error('field 不合法：' + (field || '空'));
    }
    if ((field === 'wakeTime' || field === 'sleepTime') && !aiIsHHMM(value.value)) {
      throw new Error(`${field} 必须是 HH:MM`);
    }
    if (field === 'sleepTime' && aiIsDaytimeSleep(value.value)) {
      throw new Error('sleepTime 落在白天，必须改为 hard error，不得写入字段');
    }
  }
  if (kind === 'session') {
    const s = value.session;
    if (!s || typeof s !== 'object') throw new Error('session 缺失');
    if (!aiIsHHMM(s.startTime) || !aiIsHHMM(s.endTime)) throw new Error('session startTime/endTime 必须是 HH:MM');
  }
  if (kind === 'task') {
    const t = value.task;
    if (!t || typeof t !== 'object') throw new Error('task 缺失');
    if (!String(t.name || '').trim()) throw new Error('task.name 不能为空');
  }
  if (kind === 'note') {
    if (!value.note || typeof value.note !== 'object') throw new Error('note 缺失');
    const target = value.note.target || 'unknown';
    if (!['day', 'previous-session', 'previous-task', 'unknown'].includes(target)) throw new Error('note.target 不合法');
  }
}

function aiIssueFromItemAiIssue(issue, unit) {
  return {
    level: (issue.level || 'error').toLowerCase(),
    code: issue.code || 'AI_ITEM_REVIEW',
    message: issue.message || 'AI 解析提醒',
    sourceLines: [unit.relativeLine],
    original: issue.original || unit.trimmed,
    suggestion: issue.suggestion || '',
    sourceReplacement: issue.sourceReplacement || '',
    targetPath: issue.targetPath || '',
    suggestedValue: issue.suggestedValue ?? '',
    confidence: issue.confidence ?? null,
  };
}

function aiNormalizeLineParseResult(value, unit, error = null) {
  if (error) {
    return {
      kind: 'unknown',
      sourceLine: unit.relativeLine,
      text: unit.trimmed,
      parseStatus: 'failed',
      error,
      aiIssues: [{
        level: 'error',
        code: 'AI_ITEM_PARSE_FAILED',
        message: `第 ${unit.relativeLine} 行 AI 逐项解析失败：${error}`,
        sourceLines: [unit.relativeLine],
        original: unit.trimmed,
        confidence: 1,
      }],
    };
  }
  const kind = String(value.kind || '').toLowerCase();
  return {
    ...value,
    kind,
    sourceLine: unit.relativeLine,
    text: unit.trimmed,
    parseStatus: 'ok',
    aiIssues: (value.aiIssues || []).map(issue => aiIssueFromItemAiIssue(issue, unit)),
  };
}

function aiAppendTextValue(target, value) {
  const text = String(value || '').trim();
  if (!text) return target || '';
  return target ? `${target}\n${text}` : text;
}

function aiMergeLineParseResults(split, results) {
  const parsed = {
    wakeTime: '',
    sleepTime: '',
    dayNote: '',
    sessions: [],
    tasks: [],
    aiIssues: [],
    unassignedLines: [],
    consumedLines: [],
  };
  let lastSession = null;
  let lastTask = null;

  results.forEach(result => {
    const line = Number(result.sourceLine);
    const unitText = result.text || result.original || '';
    const markConsumed = () => {
      if (Number.isFinite(line) && !parsed.consumedLines.includes(line)) parsed.consumedLines.push(line);
    };

    (result.aiIssues || []).forEach(issue => parsed.aiIssues.push(issue));

    if (result.parseStatus === 'failed') {
      parsed.unassignedLines.push({ line, text: unitText, reason: result.error || 'AI逐项解析失败' });
      markConsumed();
      return;
    }

    if (aiLineLooksDateHeading(unitText)) {
      markConsumed();
      return;
    }

    if (result.kind === 'field') {
      if (result.field === 'dayNote') parsed.dayNote = aiAppendTextValue(parsed.dayNote, result.value);
      else parsed[result.field] = result.value ?? '';
      markConsumed();
      return;
    }

    if (result.kind === 'session') {
      const session = { ...(result.session || {}) };
      session.id = session.id || uid();
      session.type = session.type || 'normal';
      session.name = session.name || '';
      session.nominalMinutes = Number(session.nominalMinutes) || 0;
      session.actualMinutes = Number(session.actualMinutes) || 0;
      session.restMinutes = Number(session.restMinutes) || 0;
      session.note = session.note || '';
      session.sourceLines = [line];
      session.aiMeta = session.aiMeta || { confidence: result.confidence ?? 0.9, reason: '逐项解析', matchMode: 'keyword-exact' };
      parsed.sessions.push(session);
      lastSession = session;
      lastTask = null;
      markConsumed();
      return;
    }

    if (result.kind === 'task') {
      const task = { ...(result.task || {}) };
      task.id = task.id || uid();
      task.name = task.name || unitText;
      task.activityType = task.activityType || '';
      task.minutes = Number(task.minutes) || 0;
      task.quantity = task.quantity === undefined ? null : task.quantity;
      task.quantityUnit = task.quantityUnit || '';
      task.note = task.note || '';
      task.sourceLines = [line];
      task.aiMeta = task.aiMeta || { confidence: result.confidence ?? 0.8, reason: '逐项解析', matchMode: task.activityType ? 'category-semantic' : 'unclassified' };
      parsed.tasks.push(task);
      lastTask = task;
      markConsumed();
      return;
    }

    if (result.kind === 'note') {
      const note = result.note || {};
      const noteText = note.text || unitText;
      if (note.target === 'previous-task' && lastTask) {
        lastTask.note = aiAppendTextValue(lastTask.note, noteText);
      } else if (note.target === 'previous-session' && lastSession) {
        lastSession.note = aiAppendTextValue(lastSession.note, noteText);
      } else if (note.target === 'day') {
        parsed.dayNote = aiAppendTextValue(parsed.dayNote, noteText);
      } else {
        parsed.unassignedLines.push({ line, text: unitText, reason: '备注无法安全归属' });
      }
      markConsumed();
      return;
    }

    parsed.unassignedLines.push({ line, text: unitText, reason: result.reason || 'AI未能归属该行' });
    markConsumed();
  });

  parsed.consumedLines = [...new Set(parsed.consumedLines)].sort((a, b) => a - b);
  aiResolveParsedTaskTemplates(parsed);
  return parsed;
}

function aiReviewDraftSummary(parsed) {
  return {
    wakeTime: parsed.wakeTime || '',
    sleepTime: parsed.sleepTime || '',
    dayNote: parsed.dayNote || '',
    sessions: (parsed.sessions || []).map(session => ({
      id: session.id,
      type: session.type,
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
  const exactTarget = /^parsed\.(?:wakeTime|sleepTime|dayNote|specialDay|excludeFromRating|sessions\.\d+\.(?:type|name|startTime|endTime|nominalMinutes|actualMinutes|restMinutes|note)|tasks\.\d+\.(?:name|templateId|activityType|minutes|quantity|quantityUnit|completionStatus|progressText|errorCount|note))$/;
  value.reviewProposals.forEach((proposal, index) => {
    if (!['source', 'field', 'session', 'task'].includes(proposal.type)) throw new Error(`reviewProposals[${index}].type 不合法`);
    if (!['error', 'warning'].includes(proposal.severity)) proposal.severity = 'warning';
    if (!Array.isArray(proposal.sourceLines)) proposal.sourceLines = [];
    if (!proposal.message) throw new Error(`reviewProposals[${index}].message 不能为空`);
    if (proposal.targetPath && !exactTarget.test(proposal.targetPath)) {
      throw new Error(`reviewProposals[${index}].targetPath 不是精确字段路径：${proposal.targetPath}`);
    }
  });
}

function aiReviewProposalsToIssues(split, proposals) {
  return (proposals || []).map((proposal, index) => {
    const level = proposal.severity === 'error' ? 'error' : 'warning';
    return aiCreateIssue(`AI_REVIEW_PROPOSAL_${proposal.type || 'source'}_${index}`, level, proposal.message || 'AI 复查提案', {
      target: proposal.targetPath || '',
      sourceLines: aiAbsoluteSourceLines(split, proposal.sourceLines || []),
      original: proposal.original || '',
      suggestion: proposal.suggestion || proposal.suggestedValue || proposal.sourceReplacement || '',
      sourceReplacement: proposal.sourceReplacement || '',
      apply: aiSafeApplyFromAI({
        targetPath: proposal.targetPath || '',
        suggestedValue: proposal.suggestedValue,
        suggestion: proposal.suggestion,
      }),
      confidence: proposal.confidence ?? null,
    });
  });
}

async function aiRunReviewProposal(split, parsed, localIssues, sourceFacts = split.sourceFacts || null) {
  const system = `你是学习追踪器的最终复查助手。你只能复查程序合并后的草稿并输出提案，绝不能直接修改草稿。

必须严格输出：
${AI_REVIEW_JSON_BEGIN}
{"reviewProposals":[]}
${AI_REVIEW_JSON_END}

reviewProposals 每项格式：
{"type":"source|field|session|task","sourceLines":[1],"severity":"error|warning","message":"问题","original":"","sourceReplacement":"","targetPath":"","suggestedValue":"","confidence":0.9}

规则：
1. 只提出会影响导入正确性的硬问题或安全修正提案。
2. 不要输出模板单位差异、普通任务未关联时段、任务总时长和 session 总时长口径差异这类软建议。
3. 如果发现睡觉时间被解析为 06:00-20:59，必须提出 error 提案，不能默认接受。
4. 如果本地硬校验已经列出错误，可以补充原因或安全的原文替换建议。
5. sourceLines 使用本日相对行号。
6. targetPath 必须是精确字段路径，例如 parsed.tasks.10.quantityUnit；不能只写 tasks、sessions 等集合名。
7. source-explicit 的时间、分钟、数量和单位是原文事实，不得建议用模板值覆盖。` + aiGetExtraParsePrompt();
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
    validate: aiValidateReviewValue,
  });
  return value.reviewProposals || [];
}

async function aiParseLineUnit(split, unit, context) {
  const user = `当前行：
[L${unit.relativeLine}] ${unit.trimmed}

上一条 session 摘要：
${context.lastSession ? JSON.stringify({ startTime: context.lastSession.startTime, endTime: context.lastSession.endTime, name: context.lastSession.name || '', sourceLines: context.lastSession.sourceLines || [] }) : '无'}

上一条 task 摘要：
${context.lastTask ? JSON.stringify({ name: context.lastTask.name, minutes: context.lastTask.minutes, sourceLines: context.lastTask.sourceLines || [] }) : '无'}`;
  const { value } = await aiStrictMarkedJsonCall({
    messages: [{ role: 'user', content: user }],
    systemPrompt: aiLineParserSystem(split),
    maxTokens: 900,
    step: 'parse',
    beginMarker: AI_ITEM_JSON_BEGIN,
    endMarker: AI_ITEM_JSON_END,
    validate: aiValidateLineParseValue,
  });
  return aiNormalizeLineParseResult(value, unit);
}

async function aiParseSingleDayByUnitsLegacy(index, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return false;
  if (split.parsingLocked || split.status === 'parsing') {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    return false;
  }

  aiRunSourcePreflight(aiState.daySplits);
  const asProposal = Boolean(options.asProposal && split.parsed);
  const previousParsed = split.parsed;
  const previousIssues = split.issues || [];
  const units = aiBuildLineParseUnits(split);
  const results = [];
  const context = { lastSession: null, lastTask: null };

  split.parsingLocked = true;
  split.status = 'parsing';
  split.error = null;
  split.pendingProposal = null;
  split.reviewProposals = [];
  split.itemParseResults = [];
  split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
  split.partialParseMessage = `正在逐项解析本日原文：0 / ${units.length} 项…`;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);

  try {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      let result;
      try {
        result = await aiParseLineUnit(split, unit, context);
      } catch (e) {
        result = aiNormalizeLineParseResult(null, unit, e.message || String(e));
      }
      results.push(result);
      if (result.kind === 'session' && result.session) {
        context.lastSession = { ...result.session, sourceLines: [unit.relativeLine] };
        context.lastTask = null;
      } else if (result.kind === 'task' && result.task) {
        context.lastTask = { ...result.task, sourceLines: [unit.relativeLine] };
      }
      split.itemParseResults = results.slice();
      if (options.progress) {
        options.progress.doneItems += 1;
        aiUpdateProgress();
      }
      split.partialParseMessage = `正在逐项解析本日原文：${i + 1} / ${units.length} 项…`;
      aiRenderDayCard(index);
      if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    }

    const parsed = aiMergeLineParseResults(split, results);
    const validationSplit = { ...split, parsed, issues: [] };
    aiValidateDraftDay(validationSplit);
    let reviewProposals = [];
    try {
      reviewProposals = await aiRunReviewProposal(split, parsed, validationSplit.issues || []);
    } catch (e) {
      reviewProposals = [{
        type: 'source',
        sourceLines: [],
        severity: 'warning',
        message: `AI 最终复查失败：${e.message || e}`,
        confidence: 1,
      }];
    }

    if (asProposal) {
      const proposalSplit = { ...split, parsed, issues: [], reviewProposals };
      aiValidateDraftDay(proposalSplit);
      split.parsed = previousParsed;
      split.reviewProposals = [];
      split.pendingProposal = {
        parsed,
        issues: proposalSplit.issues || [],
        differences: aiBuildProposalDifferences(previousParsed, parsed),
        createdAt: new Date().toISOString(),
      };
      split.partialParseMessage = 'AI 已逐项重新解析本日原文。新结果尚未覆盖最终草稿，请审核下方提案。';
    } else {
      split.parsed = parsed;
      split.pendingProposal = null;
      split.reviewProposals = reviewProposals;
      split.partialParseMessage = '本日原文已逐项解析，并已完成 AI 复查提案。';
    }
    split.error = null;
    split.sourceDirty = false;
    split.draftDirty = false;
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
  } catch (e) {
    split.parsed = previousParsed;
    split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
    if (previousParsed) aiValidateDraftDay(split);
    split.status = previousParsed ? (aiHasBlockingIssues(split) ? 'blocked' : 'review') : 'error';
    split.error = e.message;
  }

  if (options.progress) {
    options.progress.doneDays += 1;
    aiUpdateProgress();
  }
  split.parsingLocked = false;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
  aiUpdateImportBtn();
  aiUpdateProgress();
  aiSaveCacheToServer();
  return split.status !== 'error';
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
    "session":{"type":"normal|special|special-study","name":"","note":""},
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
7. task 负责名称、已有分类和模板候选。原文明写的分钟、数量、单位由程序处理，不得为了匹配模板改写。
8. 备注按整日上下文归入 day、previous-session 或 previous-task；不确定时使用 unknown。
9. 不要生成数值置信度。aiIssues 只允许影响导入正确性的硬错误。

日期：${split.date}

任务模板：
${aiGetTemplateHint() || '无'}

特殊时段模板：
${aiGetSessionTemplateHint() || '无'}

已有活动分类：
${aiGetActHint() || '无'}` + aiGetExtraParsePrompt();
}

async function aiRequestDayLineResults(split, sourceFacts, targetLines = null) {
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
  });
  return value.lineResults;
}

function aiPrepareV2Parsed(split, sourceFacts, lineResults) {
  const parsed = window.AIParserCore.assembleDay(sourceFacts, lineResults, {
    taskTemplates: aiGetTaskTemplatesSafe(),
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

async function aiParseSingleDayByUnits(index, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return false;
  if (split.parsingLocked || split.status === 'parsing') {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    return false;
  }

  aiRunSourcePreflight(aiState.daySplits);
  const asProposal = Boolean(options.asProposal && split.parsed);
  const previousParsed = split.parsed;
  const previousIssues = split.issues || [];
  const sourceFacts = window.AIParserCore.extractFacts(split.text);

  split.parsingLocked = true;
  split.status = 'parsing';
  split.error = null;
  split.pendingProposal = null;
  split.reviewProposals = [];
  split.itemParseResults = [];
  split.sourceFacts = sourceFacts;
  split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
  split.partialParseMessage = `正在按日批量解析 ${sourceFacts.nonEmptyLines.length} 行原文…`;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);

  try {
    const lineResults = await aiRequestDayLineResults(split, sourceFacts);
    split.itemParseResults = lineResults.map(result => ({
      ...result,
      sourceLine: Number(result.line),
      text: sourceFacts.lines[Number(result.line) - 1]?.trim() || '',
      parseStatus: 'ok',
    }));
    const parsed = aiPrepareV2Parsed(split, sourceFacts, lineResults);
    const validationSplit = { ...split, parsed, issues: [] };
    aiValidateDraftDay(validationSplit);

    let reviewProposals = [];
    try {
      reviewProposals = await aiRunReviewProposal(split, parsed, validationSplit.issues || [], sourceFacts);
    } catch (error) {
      reviewProposals = [{
        type: 'source',
        sourceLines: [],
        severity: 'warning',
        message: `AI 最终复查失败：${error.message || error}`,
        confidence: null,
      }];
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
      split.partialParseMessage = '本日原文已完成批量逐行解析和整日 AI 复查。';
    }

    split.error = null;
    split.sourceDirty = false;
    split.draftDirty = false;
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';
    if (options.progress) {
      options.progress.doneItems += sourceFacts.nonEmptyLines.length;
      options.progress.doneDays += 1;
    }
  } catch (error) {
    split.parsed = previousParsed;
    split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
    if (previousParsed) aiValidateDraftDay(split);
    split.status = previousParsed ? (aiHasBlockingIssues(split) ? 'blocked' : 'review') : 'error';
    split.error = error.message;
    if (options.progress) options.progress.doneDays += 1;
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
  return aiParseSingleDayByUnits(index, options);
}

async function aiParseSingleDayLegacy(index, options = {}) {
  const split = aiState.daySplits[index];
  if (!split) return;
  if (split.parsingLocked || split.status === 'parsing') {
    split.partialParseMessage = '正在解析，请稍候…';
    aiRenderDayCard(index);
    if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    return false;
  }
  aiRunSourcePreflight(aiState.daySplits);
  const asProposal = Boolean(options.asProposal && split.parsed);
  const previousParsed = split.parsed;
  const previousIssues = split.issues || [];

  split.parsingLocked = true;
  split.status = 'parsing';
  split.error = null;
  split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);

  const actHint = aiGetActHint();
  const tmplHint = aiGetTemplateHint();

  const sessTmplHint = aiGetSessionTemplateHint();

  const sessTmplSection = sessTmplHint ? `
## 【特殊时段模板库】解析 sessions 时优先匹配
以下是用户预定义的特殊时段模板（如吃饭、活动、休息等非学习时段），**解析 sessions 时必须先在此处匹配**：
${sessTmplHint}

### 特殊时段模板匹配规则
1. 对每个时段的描述文字，逐一与各特殊时段模板的关键词列表进行比对
2. 如有任意一个关键词命中 → 该 session 标记为特殊时段：
   - 添加 "type": "special"
   - 添加 "name": "模板名称"（如"午饭"）
   - nominalMinutes 和 actualMinutes 都设为 0（特殊时段没有名义/实际专注）
   - restMinutes 设为 0
   - 只保留 startTime 和 endTime（时钟时长由程序自动计算）
3. 未命中任何特殊时段模板 → 按正常规则从文字中解析时长（普通学习时段）

> **重要提示**：特殊时段（type=special）会被从「可支配时长」中扣除，从而影响时间利用率计算（利用率 = 实际专注 ÷ 可支配时长）。请务必准确识别真正无法专注的时段并标记 type=special，这样利用率才能真实反映可学习时间的利用情况。
` : '';

  const hasAnyCats = getLevel1Names().length > 0 || getLevel2Names().length > 0 || getLevel3Names().length > 0;

  const tmplSection = tmplHint ? `
## 【第一优先级】任务模板库（优先于活动分类）
以下是用户预先定义的任务模板，**每条任务的 activityType 必须先在此处匹配**：
${tmplHint}

### 模板匹配规则
1. 对任务描述的每个词/短语，逐一与各模板的关键词列表进行比对
2. 如有任意一个关键词命中 → 直接使用该模板的 activityType（禁止自行推断）
3. 多个模板同时命中 → 选择关键词匹配数最多的模板
4. 模板库完全未命中 → 进入第二优先级（活动分类推断，见下方）
5. 活动分类也无法匹配 → 将 activityType 设为空字符串 ""，并在该 task 上加字段 "needsClassification": true；note 字段只写有意义的补充描述，若无则留空 ""
` : `
## 【重要】无任务模板库
当前用户没有定义任何任务模板。${!hasAnyCats ? '也没有定义任何活动分类。' : ''}
**严格规则：**
- 你**严禁**自行发明、推断、猜测或凭空创建任何 activityType 类别名称
- ${hasAnyCats ? '只能使用下方【已有活动分类】中列出的类别名称' : '由于分类列表也为空，所有任务的 activityType 必须设为空字符串 ""'}
- ${hasAnyCats ? '如果下方分类也无法匹配，则' : ''}每个任务都必须添加字段 "needsClassification": true
- name 字段仍然必须从用户原文中提取一个简洁有意义的任务名称
- note 字段只写有意义的补充描述，若无则留空 ""
`;

  const system = `你是学习追踪器的数据录入助手。将用户的一天文字记录解析为 JSON。

## 目标 JSON 结构
{
  "wakeTime": "HH:MM",      // 起床时间（24小时制），无则 ""
  "sleepTime": "HH:MM",     // 睡觉时间（凌晨如 00:30），无则 ""
  "dayNote": "",             // 一整天的总结性备注/感受/计划（非特定时段或任务的备注），无则 ""
  "sessions": [
    {
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "nominalMinutes": <整数>,   // 计划投入的学习时长（若时间块内有安排好的非学习事项如午饭，可小于时钟时长；无特殊情况则等于时钟时长）
      "actualMinutes": <整数>,    // 实际专注 = 名义时长 - 摸鱼/分心时间
      "restMinutes": <整数>,      // 该时段内的计划休息时长（如番茄钟间隔休息、课间休息等），默认 0
      "note": "本时段专属备注，仅填写时段层面的元信息（如中断原因、专注方式、环境等），禁止写入科目/任务内容，那些属于 tasks；无则 \"\""
    }
  ],
  "tasks": [
    {
      "name": "任务名称",                    // 见下方「任务名称生成规则」
      "activityType": "一级 > 二级 > 三级",  // 按下方优先级规则确定，必须严格使用 "一级 > 二级 > 三级" 格式
      "minutes": <整数>,                     // 该科目的实际学习分钟
      "quantity": <数字|null>,               // 完成的数量（如刷了30道题、读了20页），无则 null
      "quantityUnit": "单位",               // 数量的单位（如"道题"、"页"、"单词"），无则 ""
      "note": "具体内容"
    }
  ]
}

## 解析规则
1. sessions = 有明确起止时间的学习块；tasks = 按科目/类型拆分的内容明细
2. 一个 session 可对应多个 tasks（同一时段学多科）
3. **时间分解公式**：时钟时长 = 实际专注(actualMinutes) + 休息时间(restMinutes) + 分心时间（自动计算，不用输出）。三者互不重叠。
4. **摸鱼/分心**：如"中间摸了20分钟"→ 从 actualMinutes 扣除（actualMinutes 减少，restMinutes 不变）；若时间块内有安排好的非学习事项（如午饭）→ nominalMinutes 可相应减少
5. **休息时间识别与关联规则（重要）**：
   每个专注时段(session)都有一个 restMinutes 字段，代表该时段内的计划休息时长。识别规则：
   - 用户可能在时段描述后面写休息信息："9:00-11:30 刷题，休息了15分钟" → 该session的restMinutes=15
   - 用户可能在两个时段之间写休息："9:00-11:00 数学" → "休息30分钟" → "11:30-13:00 英语"，此时这30分钟休息应归入前一个时段(数学)的restMinutes
   - "番茄钟休息"、"课间休息"、"中间休息了X分钟"等，都应计入对应时段的restMinutes
   - "做了4个番茄钟(25+5)" → restMinutes=4×5=20（需要推算）
   - 如果休息时间无法明确归属某个时段，归入紧邻的前一个时段
   - 若未提及任何休息则 restMinutes=0
   - 注意与"特殊时段"区分："12:00-12:30 午休" / "14:00-14:20 休息" → 这是独立的非学习时段，应标记为特殊时段(type=special)，restMinutes=0
   - actualMinutes 的计算中，休息时间不从actualMinutes中扣除——它是独立字段。分心时间才从actualMinutes中扣除
   - 专注效率的计算公式是：actualMinutes ÷ (时钟时长 - restMinutes)，所以准确识别restMinutes非常重要
6. **通用归属原则（重要）**：在用户的文字记录中，夹在两个专注时段或任务记录之间的附属信息（如休息描述、总结、感想、补充说明等），通常属于它上方/前面的那个时段或任务。这是普遍规则，除非上下文明确表明该信息属于后面的时段
7. **actualMinutes 计算**：actualMinutes = 时钟时长 − restMinutes − 分心时长。注意不要把休息时间重复扣减——休息时间只计入 restMinutes，不要同时从 actualMinutes 中再扣一次
8. 无明确时段信息但有科目和时长的，只放 tasks，不放 sessions
9. 只输出 JSON，无代码块标记，无解释文字

## 【重要】时间格式转换规则（12小时制 ↔ 24小时制）
所有输出时间必须使用24小时制（HH:MM）。用户输入可能使用12小时制，你必须根据上下文正确转换：

1. **睡觉时间 (sleepTime)**：
   - 睡觉时间通常在晚上或凌晨，不可能是中午
   - "12:xx" 在没有明确标注 "PM"/"下午"/"中午" 的情况下，**必须视为凌晨 00:xx**
   - 例如 "睡觉 12:30" → sleepTime: "00:30"
   - 例如 "睡觉 1:00" → sleepTime: "01:00"（凌晨1点）
   - "23:00"、"23:30" 等已经是24小时制，直接使用

2. **起床时间 (wakeTime)**：
   - 起床时间通常在早上或上午
   - "12:xx" 在没有明确标注 "AM"/"凌晨" 的情况下，视为中午 12:xx
   - 例如 "起床 7:30" → wakeTime: "07:30"

3. **时段起止时间 (sessions)**：
   - 根据相邻时间和上下文推断AM/PM
   - 晚上时段中出现 "12:xx" 应视为凌晨 "00:xx"，例如 "21:00-12:30" → startTime: "21:00", endTime: "00:30"
   - 下午时段中出现 "1:00" 应视为 "13:00"（根据上下文判断）

4. **明确标注直接处理**：
   - "AM"/"凌晨"/"早上" → 00-11时
   - "PM"/"下午"/"晚上" → 12-23时
   - "午夜"/"凌晨0点"/"半夜12点" → 00:00

## 【重要】数量与单位识别规则
用户的文字记录中经常会包含完成的数量信息，你必须仔细识别并提取：
1. 识别各种数量描述：如"刷了30道题"、"背了200个单词"、"读了15页"、"写了3篇作文"、"做了2套卷子"等
2. 提取 quantity（数字）和 quantityUnit（单位，如"道题"、"个单词"、"页"、"篇"、"套"等）
3. **模板单位优先**：如果该任务命中了模板，且模板定义了 quantityUnit，则必须使用模板的 quantityUnit（即使用户文字中的单位表述略有不同）
4. 如果用户文字中没有提到任何数量信息，quantity 设为 null，quantityUnit 设为 ""
5. 数量信息通常紧跟在任务描述中，如"9:00-11:00 刷题30道"、"背单词200个"、"阅读20页"

## 【重要】备注识别规则
用户的文字记录中，不属于日期、时间、科目、时长等结构化信息的"自言自语"、吐槽、感受、补充说明等文字都是**备注**，必须正确归类到对应字段：

1. **任务备注（task.note）**：紧跟在某个任务/科目记录下方的非结构化文字（如吐槽、补充说明、心得），属于该任务的备注
2. **时段备注（session.note）**：紧跟在某段专注时段（有起止时间的时间块）下方的非结构化文字（如吐槽、中断原因、专注感受），属于该时段的备注。注意：时段备注只写时段层面的元信息，不写科目/任务内容
3. **全天备注（dayNote）**：在"睡觉时间"那一行下方出现的自言自语、总结性文字、对一整天的回顾/感受/吐槽，属于整天的备注，应放入 dayNote 字段。如果文末（通常在睡觉时间之后）有总结性的段落，也归入 dayNote

请仔细根据文字出现的**位置**来判断它属于哪种备注，不要遗漏任何非结构化的文字内容。

## 任务名称生成规则（name 字段）
- 如果命中了模板且该模板有名称（名称非空）→ 直接使用模板的名称
- 如果命中了模板但该模板无名称 → 从用户原文中提取/总结一个简洁的任务名称（如"刷LeetCode"、"英语精读"）
- 如果未命中任何模板 → 从用户原文中提取/总结一个简洁的任务名称
- name 字段**不能为空**，必须为每个任务生成一个有意义的名称
${sessTmplSection}
${tmplSection}
## 【第二优先级】已有活动分类（模板未命中时使用）
${actHint}

## 【必须输出】审核辅助字段
本次输出不仅用于导入，还要供用户逐项审核。请遵守：
下方原文每行都带有 [L数字] 前缀，所有相对行号字段都以该数字为准。
1. 每条 session 和 task 都添加 sourceLines 数组，写出它对应于本日原文中的相对行号（从 1 开始）
2. 每条 session 和 task 都添加 aiMeta：
   {"confidence":0到1之间的小数,"reason":"简短依据","matchMode":"keyword-exact|template-semantic|category-semantic|unclassified"}
3. task 若命中已有任务模板，添加 templateId；否则 templateId 设为 ""
4. task 尽量提取 completionStatus（completed|partial|review|unknown）、progressText、errorCount
5. 输出 aiIssues 数组。只记录会影响导入正确性的硬错误，例如明显笔误、无法安全解析、时间字段冲突、缺少必要字段：
   {"level":"error|warning|info","code":"简短代码","message":"问题说明","sourceLines":[相对行号],"original":"原文字段","suggestion":"给用户看的建议文字或空字符串","sourceReplacement":"只有确认可安全替换原文字段时才填写精确替换值，否则为空字符串","targetPath":"可以安全自动写入时填写 parsed 开头的字段路径，否则为空字符串","suggestedValue":"用户接受建议后应写入 targetPath 的值，没有安全写入路径时留空","confidence":0到1}
   AI 只允许给出建议，无权替用户修改疑似错误。存在硬错误时，parsed 中不得悄悄写入建议值，必须等待用户手动修改。
   禁止为普通审计噪音输出 aiIssues：模板数量单位与原文单位不同、普通任务未添加 linkedSessionId、普通任务总时长与 session 实际专注总时长不完全一致、任务和时段无法一一对应。此类不确定性只写入对应 aiMeta.reason，不进入 aiIssues。
6. 输出 unassignedLines 数组。任何无法归属的非空原文行必须放入：
   {"line":相对行号,"text":"原文","reason":"无法归属原因"}
7. 输出 consumedLines 数组，列出已经被日期、起床、睡觉、备注、session、task 或 unassignedLines 覆盖的全部非空相对行号。必须逐行核对，不允许静默漏行
8. 识别特殊学习时段：如果长时间外出、回学校或上课中明确包含零散学习，session.type 设为 "special-study"，保留外层 startTime/endTime，并将汇总学习时长写入 actualMinutes。不得编造内部片段的起止时间
9. 特殊学习时段中明确列出的学习项目仍需拆为 tasks，并添加 linkedSessionId 指向该 session
10. 普通非学习时段 type 仍为 "special"

## 当天日期（供参考）
${split.date}

## 本日原文在源文件中的行号范围
第 ${split.startLine || '?'} 行到第 ${split.endLine || '?'} 行` + aiGetExtraParsePrompt();

  try {
    const raw = await aiCall([{ role: 'user', content: aiNumberSplitLines(split.text) }], system, 2048, 'parse');
    let cleaned = raw.replace(/```json|```/g, '').trim();
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    if (objStart !== -1 && objEnd > objStart) {
      cleaned = cleaned.slice(objStart, objEnd + 1);
    } else {
      throw new Error('返回内容不完整，未找到 JSON 对象。末尾：' + raw.slice(-100));
    }
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw new Error('JSON 解析失败：' + e.message + '\n…末尾内容：' + raw.slice(-200)); }

    parsed.sessions = parsed.sessions || [];
    parsed.tasks = parsed.tasks || [];
    parsed.aiIssues = parsed.aiIssues || [];
    parsed.unassignedLines = parsed.unassignedLines || [];
    parsed.consumedLines = parsed.consumedLines || [];

    // 补充 ID
    parsed.sessions.forEach(s => { if (!s.id) s.id = uid(); });
    parsed.tasks.forEach(t => { if (!t.id) t.id = uid(); });

    // 后处理：数量单位——模板单位优先 + 自动计算速度
    (parsed.tasks || []).forEach(t => {
      // 模板单位优先：如果命中模板且模板有 quantityUnit，覆盖 AI 返回的单位
      const _tmpls = (typeof getTaskTemplates === 'function') ? getTaskTemplates() : [];
      if (t.activityType && _tmpls.length) {
        const matched = _tmpls.find(tm => tm.activityType === t.activityType);
        if (matched && matched.quantityUnit) {
          t.quantityUnit = matched.quantityUnit;
        }
      }
      // 自动计算速度：rate = quantity / minutes，即每分钟完成数量
      if (t.quantity && t.minutes && t.minutes > 0) {
        t.rate = +(t.quantity / t.minutes).toFixed(2);
      } else {
        t.rate = null;
      }
    });

    // 后处理：兼容旧格式——若 AI 仍在 note 末尾追加了 " [待分类]"，转换为布尔标志
    (parsed.tasks || []).forEach(t => {
      if (t.note && t.note.endsWith(' [待分类]')) {
        t.note = t.note.slice(0, -6).trim();
        t.needsClassification = true;
      }
    });

    // 后处理：验证 activityType 合法性——若无模板且无分类，强制清空AI可能伪造的类别
    const _allCats = [...getLevel1Names(), ...getLevel2Names(), ...getLevel3Names()];
    const _allTemplates = (typeof getTaskTemplates === 'function') ? getTaskTemplates() : [];
    const _validTypes = new Set([
      ..._allTemplates.map(t => t.activityType).filter(Boolean),
      ..._allCats,
    ]);
    if (_validTypes.size === 0) {
      // 无任何合法类别：所有 activityType 必须清空
      (parsed.tasks || []).forEach(t => {
        if (t.activityType) {
          console.warn(`[AI后处理] 清除伪造类别: "${t.activityType}" (任务: ${t.name})`);
          t.activityType = '';
          t.needsClassification = true;
        }
      });
    } else {
      // 有合法类别：检查每个 activityType 是否存在于合法集合中
      (parsed.tasks || []).forEach(t => {
        if (t.activityType && !_validTypes.has(t.activityType)) {
          // 尝试部分匹配（如 AI 返回 "数学" 但合法的是 "学习 > 数学 > 刷题"）
          const found = [..._validTypes].find(v => v.includes(t.activityType) || t.activityType.includes(v));
          if (found) {
            t.activityType = found;
          } else {
            console.warn(`[AI后处理] 清除无效类别: "${t.activityType}" (任务: ${t.name})`);
            t.activityType = '';
            t.needsClassification = true;
          }
        }
      });
    }

    aiResolveParsedTaskTemplates(parsed);

    if (asProposal) {
      const proposalSplit = { ...split, parsed, issues: [] };
      aiValidateDraftDay(proposalSplit);
      split.parsed = previousParsed;
      split.pendingProposal = {
        parsed,
        issues: proposalSplit.issues || [],
        differences: aiBuildProposalDifferences(previousParsed, parsed),
        createdAt: new Date().toISOString(),
      };
    } else {
      split.parsed = parsed;
      split.pendingProposal = null;
    }
    split.error = null;
    split.sourceDirty = false;
    split.partialParseMessage = asProposal
      ? 'AI 已重新解析本日原文。新结果尚未覆盖最终草稿，请审核下方提案。'
      : '本日原文已完成解析；请对照原文审核最终草稿。';
    split.draftDirty = false;
    aiValidateDraftDay(split);
    split.status = aiHasBlockingIssues(split) ? 'blocked' : 'review';

  } catch (e) {
    split.parsed = previousParsed;
    split.issues = aiMergeIssueLists(previousIssues, split.sourceIssues || []);
    if (previousParsed) aiValidateDraftDay(split);
    split.status = previousParsed ? (aiHasBlockingIssues(split) ? 'blocked' : 'review') : 'error';
    split.error = e.message;
  }

  split.parsingLocked = false;
  aiRenderDayCard(index);
  if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
  aiUpdateImportBtn();
  aiUpdateProgress();
  // 每次解析完暂存到后端
  aiSaveCacheToServer();
  return split.status !== 'error';
}

async function aiStep2ParseAll() {
  aiSaveConfig();
  const btn = document.getElementById('ai-btn-parse-all');
  const concurrency = aiGetParseConcurrency();
  aiSetNetworkConcurrency(concurrency);
  btn.disabled = true;
  btn.textContent = `⏳ 按日批量解析中…并发 ${concurrency}`;

  const pending = aiState.daySplits
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === 'pending' || s.status === 'error');
  const progress = {
    doneItems: 0,
    totalItems: pending.reduce((sum, { s }) => sum + aiBuildLineParseUnits(s).length, 0),
    doneDays: 0,
    totalDays: pending.length,
  };
  aiState.itemParseProgress = progress;

  // 显示进度条
  const pw = document.getElementById('ai-progress-wrap');
  if (pw) pw.style.display = 'block';
  aiUpdateProgress();

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, pending.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < pending.length) {
      const { i } = pending[nextIndex++];
      await aiParseSingleDay(i, { progress });
    }
  });
  await Promise.all(workers);

  aiState.itemParseProgress = null;
  aiUpdateProgress();
  btn.disabled = false;
  btn.textContent = '🤖 Step 2：全部解析';
}

function aiUpdateProgress() {
  const total = aiState.daySplits.length;
  const done = aiState.daySplits.filter(s => ['review', 'blocked', 'confirmed', 'imported'].includes(s.status)).length;
  const itemProgress = aiState.itemParseProgress;
  const pct = itemProgress && itemProgress.totalItems
    ? Math.round(itemProgress.doneItems / itemProgress.totalItems * 100)
    : (total ? Math.round(done / total * 100) : 0);
  const bar = document.getElementById('ai-progress-bar');
  const label = document.getElementById('ai-progress-label');
  const pctEl = document.getElementById('ai-progress-pct');
  if (bar) bar.style.width = pct + '%';
  if (label) {
    label.textContent = itemProgress
      ? `已解析 ${itemProgress.doneItems} / ${itemProgress.totalItems} 项 · 已完成 ${itemProgress.doneDays} / ${itemProgress.totalDays} 天`
      : `已解析 ${done} / ${total} 天 · 已确认 ${aiState.daySplits.filter(s => s.status === 'confirmed' || s.status === 'imported').length} 天`;
  }
  if (pctEl) pctEl.textContent = pct + '%';
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
    /^parsed\.(wakeTime|sleepTime|dayNote|specialDay|excludeFromRating)$/,
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
    ['dayNote', '全天备注'],
    ['specialDay', '特殊日'],
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

function aiProposalFindItemIndex(items, item) {
  if (!item) return -1;
  if (item.id) {
    const byId = items.findIndex(candidate => candidate.id === item.id);
    if (byId >= 0) return byId;
  }
  const sourceKey = (item.sourceLines || []).map(Number).join(',');
  return items.findIndex(candidate => (candidate.sourceLines || []).map(Number).join(',') === sourceKey);
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

function aiHasOpenErrors(split) {
  return (split.issues || []).some(issue => issue.status === 'open' && issue.level === 'error');
}

function aiHasOpenReviewIssues(split) {
  return (split.issues || []).some(issue => issue.status === 'open' && (issue.level === 'error' || issue.level === 'warning'));
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
  return Boolean(split?.parsed) && !split.draftDirty && !split.sourceDirty && !split.pendingProposal && !aiHasBlockingIssues(split);
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
  if (path === 'date') split.importMode = '';
  aiMarkDraftDirty(index);
}

function aiMarkDraftDirty(index, render = false) {
  const split = aiState.daySplits[index];
  if (!split?.parsed) return;
  // 内嵌表格就是最终草稿。字段变更后立即进行本地校验。
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
  const tmpl = (typeof getTaskTemplates === 'function' ? getTaskTemplates() : []).find(item => item.id === templateId);
  if (!task) return;
  task.templateId = templateId || '';
  if (tmpl) {
    task.activityType = tmpl.activityType || task.activityType || '';
    if (tmpl.quantityUnit) task.quantityUnit = tmpl.quantityUnit;
    if (tmpl.defaultMinutes && !task.minutes) task.minutes = tmpl.defaultMinutes;
    if (tmpl.note && !task.note) task.note = tmpl.note;
    task.needsClassification = false;
    task.aiMeta = { evidenceLevel: 'manual', evidenceLabel: '人工确认', reason: '人工套用模板', matchMode: 'manual' };
  }
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
    await aiParseSingleDay(index, { asProposal: Boolean(split.parsed), scrollAnchor });
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
  await aiParseSingleDay(index, { asProposal: Boolean(split.parsed), scrollAnchor });
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
    const allowed = ['wakeTime', 'sleepTime', 'dayNote', 'specialDay', 'excludeFromRating'];
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
      const lineResults = await aiRequestDayLineResults(split, sourceFacts, targetLines);
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
    split.sourceDirty = true;
    split.partialParseMessage = '本项原文已保存，但本项重解析失败：' + e.message;
    aiRenderDayCard(index);
    if (options.scrollAnchor) aiRestoreScrollAnchor(options.scrollAnchor);
    aiScheduleCacheSave();
    return false;
  }
}

function aiIsSourceIssue(split, issue) {
  return (split.sourceIssues || []).some(sourceIssue => sourceIssue.id === issue.id);
}

function aiCanPatchSourceSuggestion(split, issue) {
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

  if (aiCanPatchSourceSuggestion(split, issue)) {
    aiStageIssueSuggestion(index, issueIndex);
    return;
  }

  alert('这条建议无法安全自动写入原文。请手动修改对应原文片段后，点击“保存本项原文并重解析本项”。');
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
    day.wakeTime || day.sleepTime || day.dayNote || day.specialDay ||
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
  aiState.daySplits = [];
  aiState.rawInput = '';
  aiState.sourceMeta = { fileName: '', lineCount: 0, charCount: 0, loadedAt: '' };
  aiState.sourceIssues = [];
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

function aiSourcePreflightCardHtml(split) {
  const issues = split.sourceIssues || [];
  if (!issues.length) return '';
  return `<div class="ai-preflight ai-split-preflight">
    <b>源文件预检</b>
    ${issues.slice(0, 4).map(issue => `<div class="ai-preflight-item">${escHtml(issue.message || '')}</div>`).join('')}
    ${issues.length > 4 ? `<div class="ai-preflight-item">还有 ${issues.length - 4} 条预检提示，Step 2 解析后会进入正式审核。</div>` : ''}
  </div>`;
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

function aiLegacyAnnotationActionsHtml(index, issueIndex, split, issue, offset = null) {
  if (issue.status !== 'open') {
    return `<span class="ai-annotation-status">${issue.status === 'accepted' ? '已采纳 AI 建议' : '已处理'}</span>`;
  }
  if (offset != null) {
    return `<div class="ai-issue-actions">
      ${aiCanPatchSourceSuggestion(split, issue) ? `<button class="btn btn-success btn-sm" onclick="aiStageIssueSuggestion(${index},${issueIndex})">${issue.suggestionStaged ? 'AI 建议已填入' : '采用 AI 建议'}</button>` : ''}
    </div>`;
  }
  return `<div class="ai-issue-actions">
    ${aiCanAcceptIssue(split, issue) ? `<button class="btn btn-success btn-sm" onclick="aiAcceptIssueSuggestion(${index},${issueIndex})">接受 AI 建议</button>` : ''}
  </div>`;
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

function aiHighlightAnnotatedLine(line, issues) {
  let html = escHtml(line || ' ');
  for (const issue of issues) {
    const original = String(issue.original || '').trim();
    if (!original || !String(line).includes(original)) continue;
    const escaped = escHtml(original);
    html = html.replace(escaped, `<mark class="ai-source-mark">${escaped}</mark>`);
    break;
  }
  return html;
}

function aiAnnotationCommentHtml(index, issueIndex, split, issue, offset = null) {
  const confidence = issue.confidence == null ? NaN : Number(issue.confidence);
  const displayedSuggestion = issue.suggestion ?? issue.sourceReplacement;
  const suggestionText = displayedSuggestion && typeof displayedSuggestion === 'object'
    ? JSON.stringify(displayedSuggestion, null, 2)
    : displayedSuggestion;
  return `<div class="ai-annotation-comment ai-annotation-${issue.level} ${issue.status !== 'open' ? 'ai-annotation-resolved' : ''}">
    <div class="ai-annotation-title">
      <b>${issue.level === 'error' ? '错误' : issue.level === 'warning' ? 'AI 建议' : '提示'}</b>
      ${Number.isFinite(confidence) ? `<span>${Math.round(confidence * 100)}%</span>` : ''}
    </div>
    <div>${escHtml(issue.message)}</div>
    ${issue.original ? `<div class="ai-annotation-original">发现：${escHtml(String(issue.original))}</div>` : ''}
    ${suggestionText != null && suggestionText !== '' ? `<div class="ai-suggestion">建议改为：${escHtml(String(suggestionText))}</div>` : ''}
    ${offset == null ? aiInlineFieldEditorHtml(index, issueIndex, split, issue) : ''}
    ${aiAnnotationActionsHtml(index, issueIndex, split, issue, offset)}
  </div>`;
}

function aiProposalValueHtml(value) {
  if (value == null || value === '') return '<span class="c-muted">空</span>';
  const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  return `<code>${escHtml(text)}</code>`;
}

function aiProposalHtml(index, split) {
  const proposal = split.pendingProposal;
  if (!proposal) return '';
  const differences = (proposal.differences || []).filter(aiProposalDiffHasRealChange);
  const issueCount = (proposal.issues || []).filter(issue => issue.level === 'error' || issue.level === 'warning').length;
  return `<div class="ai-proposal">
    <div class="ai-proposal-header">
      <div><b>AI 重解析提案</b><span>新结果尚未写入最终草稿${issueCount ? ` · 包含 ${issueCount} 条新提醒` : ''}</span></div>
      <div>
        <button class="btn btn-success btn-sm" onclick="aiAcceptProposal(${index})">全部采纳</button>
        <button class="btn btn-ghost btn-sm" onclick="aiKeepCurrentDraft(${index})">保留当前草稿</button>
      </div>
    </div>
    ${differences.length ? `<div class="ai-proposal-list">${differences.map((diff, diffIndex) => `
      <div class="ai-proposal-item ${diff.status !== 'open' ? 'ai-proposal-item-done' : ''}">
        <div><b>${escHtml(diff.label)}</b>${diff.affectedLines?.length ? `<span>原文相对行 ${diff.affectedLines.join('、')}</span>` : ''}</div>
        <div class="ai-proposal-change">${escHtml(aiProposalDiffSummary(diff))}</div>
        ${diff.status === 'open' ? `<div class="ai-proposal-actions">
          <button class="btn btn-success btn-sm" onclick="aiApplyProposalDifference(${index},${diffIndex})">定位原文并手动修改</button>
          <button class="btn btn-ghost btn-sm" onclick="aiKeepDraftForProposalDifference(${index},${diffIndex})">保留原值</button>
        </div>` : `<span class="ai-annotation-status">${diff.status === 'accepted' ? '已采纳' : '保留原值'}</span>`}
      </div>`).join('')}</div>` : '<div class="ai-review-ok">结构化草稿没有变化。你仍可检查 AI 新提醒，或直接保留当前草稿。</div>'}
  </div>`;
}

function aiLegacyDraftTopFieldsHtml(index, split) {
  const p = split.parsed;
  if (!p) return '';
  return `<div class="ai-linked-overview">
    <div class="ai-linked-heading">本日最终录入草稿 <span>直接修改字段，最终导入以这里为准</span></div>
    <div class="ai-draft-grid">
      <label>日期<input value="${escAttr(split.date)}" onchange="aiDraftSetField(${index},'date',this.value)"></label>
      <label>起床<input value="${escAttr(p.wakeTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.wakeTime',this.value)"></label>
      <label>睡觉<input value="${escAttr(p.sleepTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.sleepTime',this.value)"></label>
      <label class="ai-checkbox"><input type="checkbox" ${p.specialDay ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.specialDay',this.checked,'boolean')"> 特殊日</label>
      <label class="ai-checkbox"><input type="checkbox" ${p.excludeFromRating ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.excludeFromRating',this.checked,'boolean')"> 不参与评分</label>
      <label class="ai-full">全天备注<textarea onchange="aiDraftSetField(${index},'parsed.dayNote',this.value)">${escHtml(p.dayNote || '')}</textarea></label>
    </div>
  </div>`;
}

function aiLinkedSessionHtml(index, session, sessionIndex) {
  return `<div class="ai-linked-draft-row ai-linked-session">
    <span class="ai-linked-kind">时段 ${sessionIndex + 1}</span>
    <select title="类型" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.type',this.value)">
      <option value="normal" ${session.type === 'normal' || !session.type ? 'selected' : ''}>普通专注</option>
      <option value="special" ${session.type === 'special' ? 'selected' : ''}>不可用</option>
      <option value="special-study" ${session.type === 'special-study' ? 'selected' : ''}>特殊学习</option>
    </select>
    <input value="${escAttr(session.name || '')}" placeholder="名称" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.name',this.value)">
    <input value="${escAttr(session.startTime || '')}" placeholder="开始 HH:MM" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.startTime',this.value)">
    <input value="${escAttr(session.endTime || '')}" placeholder="结束 HH:MM" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.endTime',this.value)">
    <input type="number" value="${session.nominalMinutes ?? ''}" placeholder="名义" title="名义分钟" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.nominalMinutes',this.value,'number')">
    <input type="number" value="${session.actualMinutes ?? ''}" placeholder="实际" title="实际分钟" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.actualMinutes',this.value,'number')">
    <input type="number" value="${session.restMinutes ?? ''}" placeholder="休息" title="休息分钟" onchange="aiDraftSetField(${index},'parsed.sessions.${sessionIndex}.restMinutes',this.value,'number')">
    ${aiConfidenceHtml(session.aiMeta)}
    <button class="btn btn-danger btn-sm" onclick="aiDraftDeleteSession(${index},${sessionIndex})">删除</button>
  </div>`;
}

function aiLinkedTaskHtml(index, task, taskIndex) {
  const templates = typeof getTaskTemplates === 'function' ? getTaskTemplates() : [];
  return `<div class="ai-linked-draft-row ai-linked-task">
    <span class="ai-linked-kind">任务 ${taskIndex + 1}</span>
    <input value="${escAttr(task.name || '')}" placeholder="任务名称" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.name',this.value)">
    <select title="模板" onchange="aiDraftApplyTaskTemplate(${index},${taskIndex},this.value)">
      <option value="">不套用模板</option>
      ${templates.map(template => `<option value="${escAttr(template.id)}" ${task.templateId === template.id ? 'selected' : ''}>${escHtml(template.name || template.activityType || '未命名模板')}</option>`).join('')}
    </select>
    <input value="${escAttr(task.activityType || '')}" placeholder="活动分类路径" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.activityType',this.value)">
    <input type="number" value="${task.minutes ?? ''}" placeholder="分钟" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.minutes',this.value,'number')">
    <input type="number" value="${task.quantity ?? ''}" placeholder="数量" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantity',this.value,'number')">
    <input value="${escAttr(task.quantityUnit || '')}" placeholder="单位" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantityUnit',this.value)">
    <input value="${escAttr(task.note || '')}" placeholder="备注" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.note',this.value)">
    ${aiConfidenceHtml(task.aiMeta)}
    <button class="btn btn-danger btn-sm" onclick="aiDraftDeleteTask(${index},${taskIndex})">删除</button>
  </div>`;
}

function aiItemBelongsToUnit(item, unit) {
  const firstLine = (item.sourceLines || []).map(Number).find(Number.isFinite);
  return Number.isFinite(firstLine) && unit.relativeLines.includes(firstLine);
}

function aiUnitDraftHtml(index, split, unit) {
  const p = split.parsed;
  if (!p) return '';
  const sessions = (p.sessions || []).map((item, itemIndex) => ({ item, itemIndex })).filter(entry => aiItemBelongsToUnit(entry.item, unit));
  const tasks = (p.tasks || []).map((item, itemIndex) => ({ item, itemIndex })).filter(entry => aiItemBelongsToUnit(entry.item, unit));
  if (!sessions.length && !tasks.length) return '<div class="ai-linked-empty">本段目前没有绑定草稿行。重新解析后可更新归属。</div>';
  return `<div class="ai-linked-draft">
    ${sessions.map(entry => aiLinkedSessionHtml(index, entry.item, entry.itemIndex)).join('')}
    ${tasks.map(entry => aiLinkedTaskHtml(index, entry.item, entry.itemIndex)).join('')}
  </div>`;
}

function aiUnlinkedDraftHtml(index, split) {
  const p = split.parsed;
  if (!p) return '';
  const sessions = (p.sessions || []).map((item, itemIndex) => ({ item, itemIndex })).filter(entry => !(entry.item.sourceLines || []).length);
  const tasks = (p.tasks || []).map((item, itemIndex) => ({ item, itemIndex })).filter(entry => !(entry.item.sourceLines || []).length);
  return `<div class="ai-unlinked-draft">
    <div class="ai-linked-heading">未绑定原文的草稿行 <span>人工新增项目会暂时出现在这里</span></div>
    ${sessions.map(entry => aiLinkedSessionHtml(index, entry.item, entry.itemIndex)).join('')}
    ${tasks.map(entry => aiLinkedTaskHtml(index, entry.item, entry.itemIndex)).join('')}
    <div class="ai-unlinked-actions">
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'normal')">+ 普通专注</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'special')">+ 不可用时段</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddSession(${index},'special-study')">+ 特殊学习</button>
      <button class="btn btn-ghost btn-sm" onclick="aiDraftAddTask(${index})">+ 添加任务</button>
    </div>
  </div>`;
}

function aiLegacyIssueListHtml(index, split) {
  const issues = split.issues || [];
  const commentsByOffset = new Map();
  const generalIssues = [];
  const busyAttr = aiBusyAttr(split);
  issues.forEach((issue, issueIndex) => {
    const offsets = (issue.sourceLines || [])
      .map(line => Number(line) - Number(split.startLine))
      .filter(offset => Number.isFinite(offset) && offset >= 0 && offset < lines.length);
    if (!offsets.length) {
      generalIssues.push({ issue, issueIndex });
      return;
    }
    const offset = offsets[0];
    if (!commentsByOffset.has(offset)) commentsByOffset.set(offset, []);
    commentsByOffset.get(offset).push({ issue, issueIndex });
  });

  const sourceUnits = aiBuildSourceReviewUnits(split).map(unit => {
    const comments = unit.offsets.flatMap(offset => commentsByOffset.get(offset) || []);
    const lineLabel = unit.startOffset === unit.endOffset
      ? `第 ${split.startLine + unit.startOffset} 行`
      : `第 ${split.startLine + unit.startOffset}-${split.startLine + unit.endOffset} 行`;
    return `<div class="ai-source-unit ${comments.length ? 'ai-source-unit-flagged' : ''}">
      <div class="ai-source-unit-head">
        <span>${lineLabel}</span>
        <button class="btn btn-primary btn-sm" onclick="aiConfirmAnnotationUnitRevision(${index},'${unit.key}')" ${busyAttr}>保存本段并让 AI 重新解析</button>
      </div>
      <textarea id="ai-source-unit-${index}-${unit.key}" class="ai-source-unit-input" oninput="aiSetAnnotationUnitDraft(${index},'${unit.key}',this.value)">${escHtml(split.annotationUnitDrafts?.[unit.key] ?? unit.text)}</textarea>
      ${comments.length ? `<div class="ai-source-unit-comments">${comments.map(item => aiAnnotationCommentHtml(index, item.issueIndex, split, item.issue, unit.startOffset)).join('')}</div>` : ''}
      ${aiUnitDraftHtml(index, split, unit)}
    </div>`;
  }).join('');

  return `<div class="ai-annotation-wrap">
    <div class="ai-annotation-heading">原文与最终草稿对照 <span>空行仅作为分隔；修改本项原文后由 AI 只重解析本项。</span></div>
    ${split.partialParseMessage ? `<div class="ai-partial-parse-message">${escHtml(split.partialParseMessage)}</div>` : ''}
    ${aiProposalHtml(index, split)}
    ${aiDraftTopFieldsHtml(index, split)}
    ${sourceUnits ? `<div class="ai-source-units">${sourceUnits}</div>` : '<div class="ai-review-ok">本日原文没有可审核的非空内容。</div>'}
    ${aiUnlinkedDraftHtml(index, split)}
    ${generalIssues.length ? `<div class="ai-general-comments">
      <b>字段批注</b>
      ${generalIssues.map(item => aiAnnotationCommentHtml(index, item.issueIndex, split, item.issue)).join('')}
    </div>` : ''}
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
  return `<div class="ai-linked-draft ai-day-fields">
    <div class="ai-linked-draft-title">最终草稿 · 本日字段</div>
    <div class="ai-draft-grid">
      <label>日期<input value="${escAttr(split.date)}" onchange="aiDraftSetField(${index},'date',this.value)"></label>
      <label>起床<input value="${escAttr(p.wakeTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.wakeTime',this.value)"></label>
      <label>睡觉<input value="${escAttr(p.sleepTime || '')}" placeholder="HH:MM" onchange="aiDraftSetField(${index},'parsed.sleepTime',this.value)"></label>
      <label class="ai-checkbox"><input type="checkbox" ${p.specialDay ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.specialDay',this.checked,'boolean')"> 特殊日</label>
      <label class="ai-checkbox"><input type="checkbox" ${p.excludeFromRating ? 'checked' : ''} onchange="aiDraftSetField(${index},'parsed.excludeFromRating',this.checked,'boolean')"> 不参与评分</label>
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
  const templates = typeof getTaskTemplates === 'function' ? getTaskTemplates() : [];
  return `<div class="ai-linked-row ai-linked-task">
    <span class="ai-linked-kind">任务</span>
    <input title="任务名称" value="${escAttr(task.name || '')}" placeholder="任务名称" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.name',this.value)">
    <select title="任务模板" onchange="aiDraftApplyTaskTemplate(${index},${taskIndex},this.value)">
      <option value="">不套用模板</option>
      ${templates.map(template => `<option value="${escAttr(template.id)}" ${task.templateId === template.id ? 'selected' : ''}>${escHtml(template.name || template.activityType || '未命名模板')}</option>`).join('')}
    </select>
    <input title="活动分类" value="${escAttr(task.activityType || '')}" placeholder="活动分类路径" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.activityType',this.value)">
    <input title="分钟" type="number" value="${task.minutes ?? ''}" placeholder="分钟" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.minutes',this.value,'number')">
    <input title="数量" type="number" value="${task.quantity ?? ''}" placeholder="数量" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantity',this.value,'number')">
    <input title="单位" value="${escAttr(task.quantityUnit || '')}" placeholder="单位" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.quantityUnit',this.value)">
    <input title="正确率" type="number" value="${task.accuracy ?? ''}" placeholder="正确率" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.accuracy',this.value,'number')">
    <input title="备注" value="${escAttr(task.note || '')}" placeholder="备注" onchange="aiDraftSetField(${index},'parsed.tasks.${taskIndex}.note',this.value)">
    ${aiConfidenceHtml(task.aiMeta)}
    <button class="btn btn-danger btn-sm" onclick="aiDraftDeleteTask(${index},${taskIndex})">删除</button>
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

function aiIssueListHtml(index, split) {
  const issues = split.issues || [];
  const units = aiBuildSourceReviewUnits(split);
  const p = split.parsed;
  const issueEntries = issues.map((issue, issueIndex) => ({ issue, issueIndex }));
  const sourceIssueEntries = new Set();
  const busyAttr = aiBusyAttr(split);
  const primaryLine = item => Number((item.sourceLines || [])[0]);
  const sessions = p?.sessions || [];
  const tasks = p?.tasks || [];

  const unitHtml = units.map(unit => {
    const unitIssues = issueEntries.filter(entry => (entry.issue.sourceLines || []).some(line => {
      const offset = Number(line) - Number(split.startLine);
      return offset >= unit.startOffset && offset <= unit.endOffset;
    }));
    unitIssues.forEach(entry => sourceIssueEntries.add(entry));
    const unitSessions = sessions.map((item, itemIndex) => ({ item, itemIndex }))
      .filter(entry => unit.relativeLines.includes(primaryLine(entry.item)));
    const unitTasks = tasks.map((item, itemIndex) => ({ item, itemIndex }))
      .filter(entry => unit.relativeLines.includes(primaryLine(entry.item)));
    return `<section id="${aiUnitWrapId(index, unit.key)}" class="ai-source-unit ${unitIssues.length ? 'ai-source-unit-flagged' : ''}">
      <div class="ai-source-unit-head">
        <b>原文第 ${split.startLine + unit.startOffset}${unit.endOffset > unit.startOffset ? `-${split.startLine + unit.endOffset}` : ''} 行</b>
        <span>${unitIssues.length ? `${unitIssues.length} 条建议或校验结果` : '未发现批注'}</span>
      </div>
      <textarea id="ai-source-unit-${index}-${unit.key}" class="ai-source-unit-input" oninput="aiSetAnnotationUnitDraft(${index},'${unit.key}',this.value)">${escHtml(split.annotationUnitDrafts?.[unit.key] ?? unit.text)}</textarea>
      <button class="btn btn-primary btn-sm ai-source-unit-confirm" onclick="aiConfirmAnnotationUnitRevision(${index},'${unit.key}')" ${busyAttr}>保存片段并重解析本片段</button>
      ${unitIssues.length ? `<div class="ai-source-unit-comments">${unitIssues.map(entry => aiAnnotationCommentHtml(index, entry.issueIndex, split, entry.issue, unit.startOffset)).join('')}</div>` : ''}
      ${(unitSessions.length || unitTasks.length) ? `<div class="ai-linked-draft">
        <div class="ai-linked-draft-title">最终草稿 · 对应表格行</div>
        ${unitSessions.map(entry => aiCompactSessionDraftHtml(index, entry.item, entry.itemIndex)).join('')}
        ${unitTasks.map(entry => aiCompactTaskDraftHtml(index, entry.item, entry.itemIndex)).join('')}
      </div>` : '<div class="ai-source-unlinked">当前没有与本片段关联的最终草稿行。</div>'}
      ${aiProposalPanelHtml(index, split, unit)}
    </section>`;
  }).join('');

  const generalIssues = issueEntries.filter(entry => !sourceIssueEntries.has(entry));
  const unlinkedSessions = sessions.map((item, itemIndex) => ({ item, itemIndex }))
    .filter(entry => !units.some(unit => unit.relativeLines.includes(primaryLine(entry.item))));
  const unlinkedTasks = tasks.map((item, itemIndex) => ({ item, itemIndex }))
    .filter(entry => !units.some(unit => unit.relativeLines.includes(primaryLine(entry.item))));

  return `<div class="ai-annotation-wrap">
    <div class="ai-annotation-heading">原文与最终草稿对照 <span>空行仅作为段落间隔；修改本项原文后，AI 只重解析本项并同步最终草稿。</span></div>
    ${split.partialParseMessage ? `<div class="ai-partial-parse-message">${escHtml(split.partialParseMessage)}</div>` : ''}
    ${aiDraftTopFieldsHtml(index, split)}
    ${aiProposalPanelHtml(index, split)}
    <div class="ai-source-units">${unitHtml || '<div class="ai-review-ok">本日没有非空原文片段。</div>'}</div>
    ${(unlinkedSessions.length || unlinkedTasks.length) ? `<div class="ai-linked-draft ai-unlinked-draft">
      <div class="ai-linked-draft-title">最终草稿 · 尚未关联到原文片段</div>
      ${unlinkedSessions.map(entry => aiCompactSessionDraftHtml(index, entry.item, entry.itemIndex)).join('')}
      ${unlinkedTasks.map(entry => aiCompactTaskDraftHtml(index, entry.item, entry.itemIndex)).join('')}
    </div>` : ''}
    ${generalIssues.length ? `<div class="ai-general-comments">
      <b>字段批注与整体校验</b>
      ${generalIssues.map(entry => aiAnnotationCommentHtml(index, entry.issueIndex, split, entry.issue)).join('')}
    </div>` : ''}
  </div>`;
}

// Record-level review renderer. This overrides the older paragraph renderer above.
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
  const p = split.parsed;
  const openReviewCount = (split.issues || []).filter(issue => issue.status === 'open' && (issue.level === 'error' || issue.level === 'warning')).length;
  const meaningfulTarget = aiIsMeaningfulDay(state.data?.[split.date]);
  const importMode = split.importMode || aiDefaultImportMode(split.date);
  const canConfirm = aiCanConfirmSplit(split);
  const busy = aiSplitIsBusy(split);

  el.innerHTML = `<div class="ai-review-card ${split.status === 'blocked' ? 'ai-review-card-blocked' : ''}">
    <div class="ai-review-header">
      <div><span class="ai-status-icon">${meta.icon}</span> <b style="color:${meta.color}">${escHtml(split.date)}</b> <span>${meta.label}</span>
        <span class="ai-source-lines">第 ${split.startLine || '?'}-${split.endLine || '?'} 行</span></div>
      <div class="ai-review-actions">
        ${(split.status === 'pending' || split.status === 'error') ? `<button class="btn btn-primary btn-sm" onclick="aiParseSingleDay(${index})" ${busy ? 'disabled title="正在解析，请稍候"' : ''}>🤖 解析</button>` : ''}
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
