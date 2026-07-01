'use strict';

const assert = require('assert');
const core = require('./ai_parser_core.js');

function lineResult(line, kind, value = {}) {
  return { line, kind, aiIssues: [], ...value };
}

function run() {
  assert.strictEqual(core.parseDuration('2小时'), 120);
  assert.strictEqual(core.parseDuration('1小时51分钟'), 111);
  assert.strictEqual(core.parseDuration('半小时'), 30);
  assert.strictEqual(core.parseDuration('三分钟'), 3);
  assert.strictEqual(core.extractClockToken('睡觉12:30', '睡觉'), '00:30');
  assert.strictEqual(core.extractClockToken('睡觉1点30分', '睡觉'), '01:30');

  const source = [
    '5月2日',
    '起床9点',
    '多选题（1小时49分钟 190个空）',
    '9:00~11:25（专注4次）（2小时）（实际专注1小时51分钟）（休息20分钟）',
    '睡觉13:52~15:00',
    '15:00~16:00 学习',
    '睡觉1点30分',
  ].join('\n');
  const facts = core.extractFacts(source);

  const taskFacts = facts.lineFacts.find(item => item.line === 3).facts;
  assert.strictEqual(taskFacts.taskMinutes.value, 109);
  assert.strictEqual(taskFacts.quantity.value, 190);
  assert.strictEqual(taskFacts.quantityUnit.value, '个空');

  const sessionFacts = facts.lineFacts.find(item => item.line === 4).facts;
  assert.strictEqual(sessionFacts.nominalMinutes.value, 120);
  assert.strictEqual(sessionFacts.actualMinutes.value, 111);
  assert.strictEqual(sessionFacts.restMinutes.value, 20);
  assert.strictEqual(facts.lineFacts.find(item => item.line === 5).hints.sessionType, 'special');

  const results = [
    lineResult(1, 'unknown'),
    lineResult(2, 'field', { field: 'wakeTime', value: '09:00' }),
    lineResult(3, 'task', {
      task: {
        name: '多选题',
        activityType: '政治 > 填空题答题 > 多选题',
        templateId: 'multi',
        minutes: 109,
        quantity: 190,
        quantityUnit: '道题',
        note: '',
      },
    }),
    lineResult(4, 'session', { session: { type: 'normal', name: '', note: '' } }),
    lineResult(5, 'session', { session: { type: 'special', name: '午睡', note: '' } }),
    lineResult(6, 'session', { session: { type: 'normal', name: '', note: '' } }),
    lineResult(7, 'field', { field: 'sleepTime', value: '01:30' }),
  ];

  assert.strictEqual(core.validateAiEnvelope({ lineResults: results }, facts), true);
  assert.throws(
    () => core.validateAiEnvelope({
      lineResults: results.map(item => item.line === 4
        ? { ...item, session: { ...item.session, type: 'study' } }
        : item),
    }, facts),
    /session\.type 不合法/
  );

  const draft = core.assembleDay(facts, results, {
    taskTemplates: [{
      id: 'multi',
      activityType: '政治 > 填空题答题 > 多选题',
      quantityUnit: '道题',
    }],
  });

  assert.strictEqual(draft.wakeTime, '09:00');
  assert.strictEqual(draft.sleepTime, '01:30');
  assert.strictEqual(draft.tasks[0].quantityUnit, '个空');
  assert.ok(draft.aiIssues.some(item => item.code === 'TEMPLATE_FACT_CONFLICT'));

  assert.deepStrictEqual(
    draft.sessions.map(item => [
      item.type,
      item.startTime,
      item.endTime,
      item.nominalMinutes,
      item.actualMinutes,
      item.restMinutes,
    ]),
    [
      ['normal', '09:00', '11:25', 120, 111, 20],
      ['special', '13:52', '15:00', 0, 0, 0],
      ['normal', '15:00', '16:00', 60, 60, 0],
    ]
  );

  const validation = core.validateDay(draft, facts);
  assert.ok(!validation.some(item => item.level === 'error'));

  const imported = core.buildImportDay(draft);
  assert.strictEqual(imported.tasks[0].quantityUnit, '个空');
  assert.ok(!Object.prototype.hasOwnProperty.call(imported.tasks[0], 'fieldMeta'));
  assert.ok(!Object.prototype.hasOwnProperty.call(imported.sessions[0], 'sourceLines'));

  const clearRangeUnknown = results.map(item => item.line === 4
    ? lineResult(4, 'unknown')
    : item);
  const deterministicDraft = core.assembleDay(facts, clearRangeUnknown, { taskTemplates: [] });
  assert.strictEqual(deterministicDraft.sessions[0].type, 'normal');
  assert.strictEqual(deterministicDraft.sessions[0].actualMinutes, 111);

  console.log('AIParserCore tests passed');
}

run();
