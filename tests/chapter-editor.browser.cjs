const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const screenshots = process.argv[3];
const initial = [
  { id: 'a', name: '第一章 函数', order: 0 },
  { id: 'b', name: '第二章 导数', order: 1 },
  { id: 'c', name: '第三章 积分', order: 2 },
];

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${style}</style></head>
      <body><main class="template-chapter-workspace" style="max-width:1000px;margin:20px auto">
      <h3>共享章节清单</h3><div id="fixture"></div></main></body></html>`);
    // 完整脚本在 DOMContentLoaded 后加载，不启动应用、不访问用户数据或 API。
    await page.addScriptTag({ content: appSource });
    await page.evaluate(() => {
      SETTINGS.snapshotInterval = 0;
      getTaskTemplateById = () => null;
      forecastNamedItemIsReferenced = id => id === 'b';
    });

    const row = id => page.locator(`.forecast-named-item-row[data-item-id="${id}"]`);
    const toolbarAdd = () => page.getByRole('button', { name: '＋ 新增空白章节', exact: true });
    const order = () => page.locator('#forecast_named_items_active > .forecast-named-item-row')
      .evaluateAll(rows => rows.map(row => row.dataset.itemId));
    const focusedId = () => page.evaluate(() => document.activeElement.closest('.forecast-named-item-row')?.dataset.itemId);
    const reset = items => page.evaluate(items => {
      document.getElementById('fixture').innerHTML = forecastNamedItemsEditorHtml(items);
    }, items || initial);
    let count = 0;
    const check = async (label, run) => {
      await run();
      count++;
      console.log(`PASS ${label}`);
    };

    await check('row add inserts immediately below that row and focuses the new input', async () => {
      await reset();
      await row('b').getByRole('button', { name: '在本章下方新增空白章节', exact: true }).click();
      const ids = await order();
      assert.equal(ids.length, 4);
      assert.deepEqual([ids[0], ids[1], ids[3]], ['a', 'b', 'c']);
      assert.equal(await focusedId(), ids[2]);
      assert.equal(await row(ids[2]).locator('.forecast-named-item-name').inputValue(), '');
      await row(ids[2]).locator('.forecast-named-item-name').fill('插入的章节');
      const saved = await page.evaluate(() => forecastCollectNamedItems());
      assert.deepEqual(saved.map(item => item.id), ids);
      assert.deepEqual(saved.map(item => item.order), [0, 1, 2, 3]);
    });

    await check('toolbar add retains the selected chapter when the button takes focus', async () => {
      await reset();
      await row('b').locator('.forecast-named-item-name').click();
      assert.match(await page.locator('#forecast_named_item_insert_hint').innerText(), /第二章 导数/);
      await toolbarAdd().click();
      const ids = await order();
      assert.deepEqual([ids[0], ids[1], ids[3]], ['a', 'b', 'c']);
      assert.equal(await focusedId(), ids[2]);
    });

    await check('repeated toolbar clicks insert below the newly focused blank row', async () => {
      const first = (await order())[2];
      await toolbarAdd().click();
      const ids = await order();
      assert.equal(ids.length, 5);
      assert.deepEqual([ids[0], ids[1], ids[2], ids[4]], ['a', 'b', first, 'c']);
      assert.equal(await focusedId(), ids[3]);
    });

    await check('row add uses its own row even when another chapter is selected', async () => {
      await reset();
      await row('c').locator('.forecast-named-item-name').click();
      await row('a').getByRole('button', { name: '在本章下方新增空白章节', exact: true }).click();
      const ids = await order();
      assert.deepEqual([ids[0], ids[2], ids[3]], ['a', 'b', 'c']);
      assert.equal(await focusedId(), ids[1]);
    });

    await check('without a selected chapter, toolbar add appends at the end', async () => {
      await reset();
      await toolbarAdd().click();
      const ids = await order();
      assert.deepEqual(ids.slice(0, 3), ['a', 'b', 'c']);
      assert.equal(await focusedId(), ids[3]);
      assert.equal(await page.evaluate(() => document.getElementById('forecast_named_items_active').lastElementChild.id),
        'forecast_named_items_empty');
    });

    await check('an empty chapter list supports adding and focusing the first row', async () => {
      await reset([]);
      await toolbarAdd().click();
      assert.equal((await order()).length, 1);
      assert.equal(await focusedId(), (await order())[0]);
      assert.equal(await page.locator('#forecast_named_items_empty').isVisible(), false);
    });

    await check('real mouse drag moves a chapter upward and preserves the existing DOM node and edited name', async () => {
      await reset();
      await row('c').locator('.forecast-named-item-name').fill('第三章 已编辑');
      await page.evaluate(() => {
        window.draggedChapter = document.querySelector('.forecast-named-item-row[data-item-id="c"]');
      });
      await row('c').locator('.forecast-named-item-drag-handle').dragTo(row('a'), { targetPosition: { x: 12, y: 4 } });
      assert.deepEqual(await order(), ['c', 'a', 'b']);
      assert.equal(await row('c').locator('.forecast-named-item-name').inputValue(), '第三章 已编辑');
      assert.equal(await page.evaluate(() => window.draggedChapter === document.querySelector('.forecast-named-item-row[data-item-id="c"]')), true);
      assert.equal(await focusedId(), 'c');
      assert.equal(await page.locator('.is-dragging, .drop-before, .drop-after').count(), 0);
    });

    await check('real mouse drag moves a chapter downward and updates saved order', async () => {
      const bounds = await row('b').boundingBox();
      await row('c').locator('.forecast-named-item-drag-handle').dragTo(row('b'),
        { targetPosition: { x: 12, y: bounds.height - 4 } });
      assert.deepEqual(await order(), ['a', 'b', 'c']);
      assert.deepEqual(await page.evaluate(() => forecastCollectNamedItems().map(item => [item.id, item.order])),
        [['a', 0], ['b', 1], ['c', 2]]);
    });

    await check('Escape cancels a real drag and clears drag indicators', async () => {
      const bounds = await row('a').locator('.forecast-named-item-drag-handle').boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 25, { steps: 5 });
      await page.waitForFunction(() => Boolean(document.getElementById('forecast_named_items_active').dataset.dragItemId));
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.deepEqual(await order(), ['a', 'b', 'c']);
      assert.equal(await page.locator('.is-dragging, .drop-before, .drop-after').count(), 0);
      assert.equal(await page.evaluate(() => document.getElementById('forecast_named_items_active').dataset.dragItemId), undefined);
    });

    await check('archiving clears selection and preserves the chapter detail panel', async () => {
      await reset();
      await page.evaluate(() => {
        const holder = document.createElement('div');
        holder.innerHTML = forecastNamedItemRowHtml({ id: 'b', name: '第二章 导数' }, {
          minutes: 12, quantity: 4, records: [{ date: '2026-10-07', taskName: '导数练习', minutes: 12, quantity: 4 }],
        }, true, '题');
        document.querySelector('.forecast-named-item-row[data-item-id="b"]').replaceWith(holder.firstElementChild);
        window.chapterDetails = document.querySelector('.forecast-named-item-row[data-item-id="b"] .forecast-named-item-details');
      });
      await row('b').locator('.forecast-named-item-name').click();
      await row('b').getByRole('button', { name: '移除章节', exact: true }).click();
      assert.deepEqual(await order(), ['a', 'c']);
      assert.equal(await row('b').locator('.forecast-named-item-leading').isVisible(), false);
      assert.equal(await row('b').locator('.forecast-named-item-name').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.chapterDetails === document.querySelector('.forecast-named-item-row[data-item-id="b"] .forecast-named-item-details')), true);
      assert.match(await row('b').locator('.forecast-named-item-details').textContent(), /导数练习/);
      await toolbarAdd().click();
      assert.deepEqual((await order()).slice(0, 2), ['a', 'c']);
    });

    await check('restoring a chapter restores row controls and retains its details', async () => {
      await page.locator('#forecast_named_items_archived_wrap > summary').click();
      await row('b').getByRole('button', { name: '恢复', exact: true }).click();
      assert.equal(await row('b').locator('.forecast-named-item-leading').isVisible(), true);
      assert.equal(await row('b').locator('.forecast-named-item-name').isDisabled(), false);
      assert.equal(await page.evaluate(() => window.chapterDetails === document.querySelector('.forecast-named-item-row[data-item-id="b"] .forecast-named-item-details')), true);
      await row('b').getByRole('button', { name: '在本章下方新增空白章节', exact: true }).click();
      const ids = await order();
      assert.equal(ids[ids.length - 2], 'b');
      assert.equal(await focusedId(), ids[ids.length - 1]);
    });

    await check('removing the selected unreferenced row clears the insertion anchor', async () => {
      await reset();
      await row('a').locator('.forecast-named-item-name').click();
      await row('a').getByRole('button', { name: '移除章节', exact: true }).click();
      await toolbarAdd().click();
      assert.deepEqual((await order()).slice(0, 2), ['b', 'c']);
      assert.equal(await focusedId(), (await order())[2]);
    });

    await check('keyboard-accessible move buttons continue to reorder chapters', async () => {
      await reset();
      await row('b').getByTitle('上移', { exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await order(), ['b', 'a', 'c']);
      await row('b').getByTitle('下移', { exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await order(), ['a', 'b', 'c']);
    });

    await reset();
    await row('b').locator('.forecast-named-item-name').click();
    if (screenshots) {
      fs.mkdirSync(screenshots, { recursive: true });
      await page.locator('main').screenshot({ path: path.join(screenshots, 'chapter-editor-desktop.png') });
    }
    await check('the narrow layout keeps insertion controls and the name input within the viewport', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const input = await row('b').locator('.forecast-named-item-name').boundingBox();
      assert.ok(input.width > 150);
      await toolbarAdd().click();
      assert.equal(await focusedId(), (await order())[2]);
      if (screenshots) await page.locator('main').screenshot({ path: path.join(screenshots, 'chapter-editor-narrow.png') });
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log(`Passed ${count} browser scenarios; no page errors or network requests.`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
