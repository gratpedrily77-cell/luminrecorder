const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function setup(options = {}) {
  const context = vm.createContext({
    console,
    localStorage: { getItem: () => null },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
  });
  vm.runInContext(source, context);
  const template = {
    id: 'math', activityType: '学习/数学', namedItemEnabled: true,
    quantityEnabled: true, quantityUnit: '题', chapterQuantityOnly: true,
    namedItems: [
      { id: 'a', name: '第一章', questionCount: 155, order: 0 },
      { id: 'b', name: '第二章', questionCount: 200, order: 1 },
    ],
    ...options,
  };
  context.getTaskTemplates = () => [template];
  return { app: context, template };
}

function allocation(quantity, id = 'a') {
  return { itemId: id, itemName: id === 'a' ? '第一章' : '第二章', quantity, minutes: 30 };
}

function entry(quantity, id = 'old', chapter = 'a', date = '2026-10-01') {
  return { date, task: { id, templateId: 'math', name: id, minutes: 30, quantity, quantityUnit: '题', namedItemAllocations: [allocation(quantity, chapter)] } };
}

test('100 plus 55 fits, but 100 plus 56 exceeds the 155 cap across dates', () => {
  const { app, template } = setup();
  assert.equal(app.chapterQuestionCountError(template, [entry(100), entry(55, 'next', 'a', '2026-10-07')]), '');
  assert.match(app.chapterQuestionCountError(template, [entry(100), entry(56, 'next', 'a', '2026-10-07')]), /不能超过 155.*156.*超出 1/);
});

test('a single task cannot exceed a chapter total', () => {
  const { app, template } = setup();
  assert.equal(app.chapterQuestionCountError(template, [entry(155)]), '');
  assert.match(app.chapterQuestionCountError(template, [entry(156)]), /超出 1/);
});

test('disabling calibration ignores saved chapter totals and retains chapter forecasting', () => {
  const { app, template } = setup({ chapterQuantityOnly: false });
  assert.equal(app.chapterQuestionCountError(template, [entry(1000)]), '');
  assert.equal(app.forecastModeFromTemplate(template), 'chapterQuantity');
  const context = app.forecastGoalContext({ templateId: 'math', totalQuantity: null });
  assert.equal(context.totalQuantity, null);
  assert.equal(template.namedItems[0].questionCount, 155);
});

test('enabled calibration changes the forecast target to active question totals', () => {
  const { app, template } = setup();
  assert.equal(app.forecastModeFromTemplate(template), 'quantity');
  assert.equal(app.forecastGoalContext({ templateId: 'math', totalQuantity: 9999 }).totalQuantity, 355);
});

test('editing replaces the old contribution, including tasks on the same chapter', () => {
  const { app, template } = setup();
  app.getForecastTaskEntries = () => [entry(100), entry(55, 'second')];
  assert.equal(app.taskChapterQuestionCountError(template, [allocation(100)], 100, '2026-10-01', 'old'), '');
  assert.equal(app.taskChapterQuestionCountError(template, [allocation(99)], 99, '2026-10-01', 'old'), '');
  assert.match(app.taskChapterQuestionCountError(template, [allocation(101)], 101, '2026-10-01', 'old'), /超出 1/);
});

test('moving an edited task to a different chapter frees its old contribution', () => {
  const { app, template } = setup();
  app.getForecastTaskEntries = () => [entry(155), entry(150, 'other', 'b')];
  assert.equal(app.taskChapterQuestionCountError(template, [allocation(50, 'b')], 50, '2026-10-01', 'old'), '');
  assert.match(app.taskChapterQuestionCountError(template, [allocation(51, 'b')], 51, '2026-10-01', 'old'), /第二章.*超出 1/);
});

test('each chapter in a multi-chapter task gets its own limit check', () => {
  const { app, template } = setup();
  app.getForecastTaskEntries = () => [entry(150), entry(190, 'other', 'b')];
  assert.equal(app.taskChapterQuestionCountError(template, [allocation(5), allocation(5, 'b')], 10, '2026-10-07'), '');
  assert.match(app.taskChapterQuestionCountError(template, [allocation(6), allocation(6, 'b')], 12, '2026-10-07'), /第一章.*超出 1/);
});

test('equal-share rounding never creates a false overrun at the exact total', () => {
  const { app, template } = setup();
  const current = entry(155);
  current.task.namedItemAllocations = [allocation(155 / 3), allocation(155 / 3), allocation(155 / 3)];
  assert.equal(app.chapterQuestionCountError(template, [current]), '');
});

test('unassigned legacy quantities are shared across linked chapters', () => {
  const { app, template } = setup();
  const current = entry(312);
  current.task.namedItemAllocations = [allocation(null), allocation(null, 'b')];
  assert.match(app.chapterQuestionCountError(template, [current]), /第一章.*超出 1/);
});

test('mismatched allocations cannot hide part of a task quantity', () => {
  const { app, template } = setup();
  const current = entry(156);
  current.task.namedItemAllocations = [allocation(1)];
  assert.match(app.chapterQuestionCountError(template, [current]), /合计必须等于任务总题数/);
});

test('turning on or reducing a total checks previously recorded quantities', () => {
  const { app, template } = setup();
  assert.match(app.chapterQuestionCountError({ ...template, namedItems: [{ ...template.namedItems[0], questionCount: 99 }] }, [entry(100)]), /超出 1/);
  assert.match(app.chapterQuestionCountError(template, [entry(156)]), /不能超过 155/);
});

test('unmarked, completed and forecast-excluded tasks all consume the same cap', () => {
  const { app, template } = setup();
  const first = entry(100);
  first.task.excludedFromForecast = true;
  first.task.namedItemAllocations[0].completed = false;
  const next = entry(56, 'next');
  next.task.namedItemAllocations[0].completed = true;
  assert.match(app.chapterQuestionCountError(template, [first, next]), /超出 1/);
});

test('legacy template and chapter names resolve to their current IDs', () => {
  const { app, template } = setup();
  const first = entry(156);
  delete first.task.templateId;
  first.task.activityType = template.activityType;
  first.task.namedItemAllocations[0].itemId = 'old-id';
  assert.match(app.chapterQuestionCountError(template, [first]), /不能超过 155/);
});

test('unknown or uncalibrated chapters are rejected while the flag is enabled', () => {
  const { app, template } = setup();
  const first = entry(1);
  first.task.namedItemAllocations[0] = { itemId: 'new', itemName: '第三章', quantity: 1 };
  assert.match(app.chapterQuestionCountError(template, [first]), /第三章.*尚未设置总题数/);
  template.namedItems[1].questionCount = null;
  assert.match(app.chapterQuestionCountError(template, []), /每个活动章节/);
});

test('zero-count chapters allow zero questions and reject any positive quantity', () => {
  const { app, template } = setup();
  template.namedItems[0].questionCount = 0;
  assert.equal(app.chapterQuestionCountError(template, [entry(0)]), '');
  assert.match(app.chapterQuestionCountError(template, [entry(1)]), /不能超过 0/);
});

test('calibration has no effect when either required template dimension is disabled', () => {
  for (const options of [{ quantityEnabled: false }, { namedItemEnabled: false }]) {
    const { app, template } = setup(options);
    assert.equal(app.chapterQuestionCountError(template, [entry(1000)]), '');
  }
});

test('archived quantities do not complete an active calibrated forecast', () => {
  const { app, template } = setup();
  template.namedItems[1].archived = true;
  const goal = app.forecastGoalContext({ templateId: 'math' });
  const result = app.forecastQuantityResult(goal, [entry(100), entry(200, 'archived', 'b')]);
  assert.equal(goal.totalQuantity, 155);
  assert.equal(result.completed, 100);
  assert.equal(result.remaining, 55);
  assert.equal(result.excluded, 1);
});
