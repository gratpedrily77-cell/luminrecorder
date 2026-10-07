const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function loadApp(document = {}) {
  const context = vm.createContext({
    console,
    localStorage: { getItem: () => null },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, ...document },
    window: { addEventListener() {} },
  });
  // 不触发 init，不读取或写入用户数据；加载完整脚本以验证实际调用链。
  vm.runInContext(source, context, { filename: 'app.js' });
  return context;
}

const app = loadApp();
const examples = [
  [['9'], '10'],
  [['第1章', '第3章'], '第5章'],
  [['1.1', '1.3'], '1.5'],
  [['1.1', '2.1', '3.1'], '4.1'],
  [['第3章 第1节', '第3章 第3节'], '第3章 第5节'],
  [['2026版 第1章', '2026版 第3章'], '2026版 第5章'],
  [['第九章'], '第十章'],
  [['第九十九章'], '第一百章'],
  [['第一章', '第三章'], '第五章'],
  [['卷两'], '卷三'],
  [['第三章 三角函数'], '第四章'],
  [['第三章三角函数'], '第四章'],
  [['第一章 函数', '第三章 导数'], '第五章'],
  [['第1章 10道题'], '第2章'],
  [['练习001', '练习003'], '练习005'],
  [['第１章', '第３章'], '第５章'],
  [['二〇二六'], '二〇二七'],
  [['第〇九章'], '第一〇章'],
  [['P20-35'], 'P36-51'],
  [['P001-010', 'P011-020'], 'P021-030'],
  [['P1-10', 'P21-30'], 'P41-50'],
  [['1-10题'], '11-20题'],
  [['页码 ２０～３５'], '页码 ３６～５１'],
  [['2026-10-31'], '2026-11-01'],
  [['2026-12-31'], '2027-01-01'],
  [['2024-02-28'], '2024-02-29'],
  [['2026-02-28'], '2026-03-01'],
  [['2026/10/7', '2026/10/14'], '2026/10/21'],
  [['2026年10月31日'], '2026年11月01日'],
  [['附录A', '附录C'], '附录E'],
  [['a', 'b'], 'c'],
  [['第5章', '第3章'], '第1章'],
  [['导言', '第1章', '第3章'], '第5章'],
];

for (const [names, expected] of examples) {
  test(`${names.join(' → ')} predicts ${expected}`, () => {
    assert.equal(app.predictNamedItemSequence(names).predictedName, expected);
  });
}

const rejected = [
  [], ['三角函数'], ['一元二次方程'], ['第一性原理'], ['第一次世界大战'],
  ['高数2026版'], ['20-35'], ['1', '2', '4'], ['第1章', '第1章'],
  ['1.1', '2.2'], ['P1-10', 'P11-25'], ['P35-20'],
  ['2026-02-30'], ['2026-10/31'], ['第十百章'],
  ['9007199254740991'], ['Z'], ['第3章', '第1章'],
];

for (const names of rejected) {
  test(`refuses unsupported or conflicting sequence: ${names.join(' → ') || '(empty)'}`, () => {
    const prediction = app.predictNamedItemSequence(names);
    assert.equal(prediction.predictedName, '');
    assert.ok(prediction.reason);
    assert.equal(prediction.previewNames.length, 0);
  });
}

test('shows evidence, the chosen step, and three concrete previews', () => {
  const prediction = app.predictNamedItemSequence(['第1章', '第3章', '第5章']);
  assert.equal(prediction.sampleCount, 3);
  assert.match(prediction.reason, /3 个名称/);
  assert.match(prediction.reason, /步长 \+2/);
  assert.deepEqual(Array.from(prediction.previewNames), ['第7章', '第9章', '第11章']);
  assert.match(app.namedItemPredictionHint(prediction), /第9章 → 第11章/);
});

test('a single example is explicitly identified as a default assumption', () => {
  const prediction = app.predictNamedItemSequence(['第3章']);
  assert.match(prediction.reason, /仅 1 个样本/);
  assert.match(prediction.reason, /默认编号 \+1/);
});

test('archived names prevent duplicates without determining the step', () => {
  const prediction = app.predictNamedItemSequence(['第1章', '第3章'], ['第1章', '第3章', '第5章', '第99章']);
  assert.equal(prediction.predictedName, '第7章');
  assert.equal(prediction.sampleCount, 2);
  assert.match(prediction.reason, /跳过 1 个重名项/);
});

test('successive clicks preserve the step after skipping an archived name', () => {
  const active = ['第1章', '第3章'];
  const existing = [...active, '第5章'];
  for (const expected of ['第7章', '第9章', '第11章']) {
    const next = app.predictNamedItemSequence(active, existing).predictedName;
    assert.equal(next, expected);
    active.push(next);
    existing.push(next);
  }
});

test('duplicate comparisons ignore whitespace and case', () => {
  assert.equal(app.predictNamedItemSequence(['附录A'], ['附录A', ' 附录b ']).predictedName, '附录C');
});

test('a new naming structure starts a new sequence', () => {
  const prediction = app.predictNamedItemSequence(['第1章', '第3章', '卷一']);
  assert.equal(prediction.predictedName, '卷二');
  assert.equal(prediction.sampleCount, 1);
});

test('safe Chinese number parsing supports unit nesting and rejects malformed input', () => {
  assert.equal(app.chineseNamedItemNumberToValue('一万亿'), 1000000000000);
  assert.equal(app.chineseNamedItemNumberToValue('一亿零一万'), 100010000);
  assert.equal(app.chineseNamedItemNumberToValue('十百'), null);
  assert.equal(app.chineseNamedItemNumberToValue('一百二'), null);
});

test('workbook prediction uses the complete draft order and refreshes its hint', () => {
  const button = {};
  const hint = {};
  const context = loadApp({
    getElementById: id => ({ 'workbook-section-predict': button, 'workbook-section-predict-hint': hint })[id],
  });
  vm.runInContext("state.workbookDraft = { sections: [{ name: '1.1' }, { name: '1.3' }] }", context);
  context.workbookRefreshSectionPrediction();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '⚡＋ 1.5');
  assert.match(hint.textContent, /步长 \+2/);
  let appended = '';
  context.workbookAddSection = name => { appended = name; };
  context.workbookAddPredictedSection();
  assert.equal(appended, '1.5');
  vm.runInContext("state.workbookDraft.sections.push({ name: '1.4' })", context);
  context.workbookRefreshSectionPrediction();
  assert.equal(button.disabled, true);
  assert.match(hint.textContent, /步长不一致/);
});

test('chapter editor reads active DOM order, excludes archived examples, and appends its preview', () => {
  const row = (id, name) => ({
    dataset: { itemId: id, archived: 'false' },
    classList: { toggle() {} },
    querySelector: () => ({ value: name }),
  });
  const active = [row('one', '第1章'), row('three', '第3章')];
  const archived = [row('five', '第5章')];
  const button = {};
  const hint = {};
  const context = loadApp({
    getElementById: id => ({
      forecast_named_items_active: { dataset: {}, querySelectorAll: () => active },
      forecast_named_items_archived: { querySelectorAll: () => archived },
      forecast_named_item_predict: button,
      forecast_named_item_predict_hint: hint,
    })[id],
    querySelectorAll: () => [...active, ...archived],
  });
  context.forecastRefreshNamedItemEditorState();
  assert.equal(button.textContent, '⚡＋ 第7章');
  assert.match(hint.textContent, /依据末尾 2 个名称/);
  let appended = '';
  context.forecastAppendNamedItem = name => { appended = name; };
  context.forecastAddPredictedNamedItem();
  assert.equal(appended, '第7章');
  active.reverse();
  context.forecastRefreshNamedItemEditorState();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '⚡＋预测下一项');
  assert.match(hint.textContent, /超出支持范围/);
});

test('moving a chapter refreshes the prediction immediately', () => {
  let refreshed = false;
  const previous = { classList: { contains: () => true } };
  const current = { dataset: { itemId: 'two', archived: 'false' }, previousElementSibling: previous };
  current.parentElement = { insertBefore: (row, before) => {
    assert.equal(row, current);
    assert.equal(before, previous);
  } };
  const context = loadApp();
  context.forecastNamedItemRows = () => [current];
  context.forecastRefreshNamedItemEditorState = () => { refreshed = true; };
  context.forecastMoveNamedItem('two', -1);
  assert.equal(refreshed, true);
});

test('task entry continues the active library order and skips archived duplicates', () => {
  const host = { dataset: {}, style: {} };
  const context = loadApp({
    getElementById: id => id === 'task_named_item_suggestion' ? host : null,
    querySelectorAll: () => [{ dataset: { itemId: 'three', itemName: '第3章' } }],
  });
  context.getTaskTemplateById = () => ({ namedItems: [
    { id: 'one', name: '第1章', order: 0 },
    { id: 'three', name: '第3章', order: 1 },
    { id: 'five', name: '第5章', order: 2, archived: true },
  ] });
  context.taskCompletedNamedItemIds = () => new Set();
  context.taskUpdateNamedItemSuggestion('template');
  assert.equal(host.dataset.suggestionName, '第7章');
  assert.match(host.innerHTML, /步长 \+2/);
  assert.match(host.innerHTML, /跳过 1 个重名项/);
});

test('prediction hints escape generated names when rendered as HTML', () => {
  const context = loadApp();
  context.getTaskTemplateById = () => null;
  const html = context.forecastNamedItemsEditorHtml([
    { id: 'one', name: '<img src=x onerror=alert(1)>第1章', order: 0 },
    { id: 'three', name: '<img src=x onerror=alert(1)>第3章', order: 1 },
  ]);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /aria-live="polite"/);
});
