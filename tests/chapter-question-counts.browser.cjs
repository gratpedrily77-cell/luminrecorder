const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '..');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><style>${fs.readFileSync(path.join(root, 'style.css'), 'utf8')}</style></head>
      <body><main class="template-chapter-workspace" style="max-width:1000px;margin:20px auto"><div id="fixture"></div></main></body></html>`);
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'app.js'), 'utf8') });
    await page.evaluate(() => {
      SETTINGS.snapshotInterval = 0;
      window.alerts = [];
      window.saves = 0;
      window.alert = message => alerts.push(message);
      window.renderTemplates = () => {};
      window.tmplManageNamedItems = () => {};
      window.showPersistentSaveNotice = () => {};
      window.saveAllStorage = async () => { saves++; };
    });
    const reset = async (enabled = false, quantity = 100) => page.evaluate(({ enabled, quantity }) => {
      alerts.length = 0;
      saves = 0;
      window.template = {
        id: 'math', activityType: buildActPath('学习', '数学', ''), namedItemEnabled: true, ordinalEnabled: true,
        quantityEnabled: true, quantityUnit: '题', chapterQuantityOnly: enabled,
        namedItems: [{ id: 'a', name: '第一章', questionCount: 155, order: 0 },
                     { id: 'b', name: '第二章', questionCount: 200, order: 1 }],
      };
      state.data = {
        __taskTemplates__: [template],
        '2026-10-01': { tasks: [{ id: 'old', name: '旧任务', templateId: 'math', minutes: 30,
          quantity, quantityUnit: '题', namedItemAllocations: [{ itemId: 'a', itemName: '第一章', quantity, minutes: 30 }] }] },
        '2026-10-07': { tasks: [], sessions: [] },
      };
      getTaskTemplateById = id => getTaskTemplates().find(template => template.id === id);
      document.getElementById('fixture').innerHTML = forecastNamedItemsEditorHtml(template.namedItems, template.id);
    }, { enabled, quantity });
    const row = id => page.locator(`.forecast-named-item-row[data-item-id="${id}"]`);
    let count = 0;
    const check = async (label, callback) => { await callback(); count++; console.log(`PASS ${label}`); };

    await check('stored question totals are disabled until calibration is enabled', async () => {
      await reset();
      assert.equal(await row('a').getByLabel('章节总题数').isDisabled(), true);
      assert.equal(await row('a').getByLabel('章节总题数').inputValue(), '155');
      await page.getByLabel('章节仅作题数标定', { exact: true }).check();
      assert.equal(await row('a').getByLabel('章节总题数').isDisabled(), false);
      assert.match(await page.locator('.forecast-chapter-quantity-hint').innerText(), /所有日期、所有任务/);
      await page.getByLabel('章节仅作题数标定', { exact: true }).uncheck();
      assert.equal(await row('a').getByLabel('章节总题数').isDisabled(), true);
      assert.equal(await row('a').getByLabel('章节总题数').inputValue(), '155');
      assert.match(await page.locator('.forecast-chapter-quantity-hint').innerText(), /不参与预测/);
    });

    await check('enabling calibration rejects historical overruns before saving the template', async () => {
      await reset(false, 156);
      await page.getByLabel('章节仅作题数标定', { exact: true }).check();
      await page.evaluate(() => tmplSaveNamedItems('math'));
      assert.equal(await page.evaluate(() => saves), 0);
      assert.equal(await page.evaluate(() => template.chapterQuantityOnly), false);
      assert.match(await page.evaluate(() => alerts[0]), /不能超过 155.*超出 1/);
    });

    await check('reducing a total below recorded quantity is rejected and the input stays available', async () => {
      await reset(true);
      await row('a').getByLabel('章节总题数').fill('99');
      await page.evaluate(() => tmplSaveNamedItems('math'));
      assert.equal(await page.evaluate(() => saves), 0);
      assert.equal(await page.evaluate(() => template.namedItems[0].questionCount), 155);
      assert.equal(await row('a').getByLabel('章节总题数').inputValue(), '99');
      assert.match(await page.evaluate(() => alerts[0]), /超出 1/);
    });

    await check('calibrated counts survive insertion, sorting and collection', async () => {
      await reset(true);
      await row('a').getByLabel('章节总题数').click();
      await page.getByRole('button', { name: '＋ 新增空白章节', exact: true }).click();
      const inserted = page.locator('#forecast_named_items_active > .forecast-named-item-row').nth(1);
      await inserted.locator('.forecast-named-item-name').fill('插入章节');
      await inserted.getByLabel('章节总题数').fill('20');
      await row('b').getByTitle('上移', { exact: true }).click();
      await page.evaluate(() => tmplSaveNamedItems('math'));
      assert.deepEqual(await page.evaluate(() => template.namedItems.map(item => [item.name, item.questionCount])),
        [['第一章', 155], ['第二章', 200], ['插入章节', 20]]);
      assert.equal(await page.evaluate(() => template.chapterQuantityOnly), true);
    });

    const taskForm = async quantity => {
      await reset(true);
      await page.evaluate(quantity => {
        alerts.length = 0;
        window.apiCalls = [];
        window.rejectSave = false;
        state._editingTaskId = null;
        state.selectedDate = '2026-10-07';
        document.getElementById('fixture').innerHTML = `
          <input id="task_name" value="新任务"><input id="task_min" value="30">
          <input id="task_qty" value="${quantity}"><input id="task_unit" value="题">
          <textarea id="task_note"></textarea><select id="task_tmpl"><option selected value="math">数学</option></select>
          <div id="task_named_item_editor" data-template-id="math" data-quantity-enabled="true">
            ${taskNamedItemCardHtml({ itemId: 'a', itemName: '第一章', quantity: null, completed: false }, true)}
          </div>`;
        catSelValue = id => id === 'task_l1' ? '学习' : id === 'task_l2' ? '数学' : '';
        taskRecalculateNamedItemTotals = () => {};
        commitTaskTemplateUnitChanges = async () => true;
        studySessionActualTotal = () => 500;
        clearEntryDraftFields = () => {};
        showTab = () => {};
        apiFetch = async (url, options) => {
          apiCalls.push({ url, body: JSON.parse(options.body) });
          if (rejectSave) throw new Error('章节“第一章”累计题数不能超过 155 题；保存后为 156 题，超出 1 题。');
          return { ok: true };
        };
      }, quantity);
    };

    await check('actual saveTask blocks 100 plus 56 without adding a local task or clearing input', async () => {
      await taskForm(56);
      await page.evaluate(() => saveTask('2026-10-07'));
      assert.equal(await page.evaluate(() => apiCalls.length), 0);
      assert.equal(await page.evaluate(() => state.data['2026-10-07'].tasks.length), 0);
      assert.equal(await page.locator('#task_qty').inputValue(), '56');
      assert.match(await page.evaluate(() => alerts[0]), /156.*超出 1/);
    });

    await check('actual saveTask accepts 100 plus 55 and preserves the chapter association', async () => {
      await taskForm(55);
      await page.evaluate(() => saveTask('2026-10-07'));
      assert.equal(await page.evaluate(() => apiCalls.length), 1);
      assert.equal(await page.evaluate(() => state.data['2026-10-07'].tasks[0].namedItemAllocations[0].quantity), 55);
      assert.deepEqual(await page.evaluate(() => alerts), []);
    });

    await check('a server rejection rolls back the local task and keeps the form', async () => {
      await taskForm(55);
      await page.evaluate(() => { rejectSave = true; });
      await page.evaluate(() => saveTask('2026-10-07'));
      assert.equal(await page.evaluate(() => apiCalls.length), 1);
      assert.equal(await page.evaluate(() => state.data['2026-10-07'].tasks.length), 0);
      assert.equal(await page.locator('#task_qty').inputValue(), '55');
      assert.match(await page.evaluate(() => alerts[0]), /超出 1/);
    });

    await check('question total fields remain usable at 390 pixels', async () => {
      await reset(true);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await row('a').getByLabel('章节总题数').fill('155');
      if (process.argv[3]) {
        await page.locator('main').screenshot({ path: path.join(process.argv[3], 'chapter-question-counts.png') });
      }
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log(`Passed ${count} chapter calibration browser scenarios; no page errors or network requests.`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
