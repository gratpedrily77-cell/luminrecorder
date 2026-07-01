'use strict';

const assert = require('assert');
const core = require('./ai_parser_core.js');

function lineResult(line, kind, value = {}) {
  return { line, kind, aiIssues: [], ...value };
}

function run() {
  assert.strictEqual(core.VERSION, 4);
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
  const restDayFacts = core.extractFacts('休息日');
  assert.strictEqual(restDayFacts.lineFacts[0].facts.specialDay, undefined);
  assert.strictEqual(restDayFacts.lineFacts[0].facts.excludeFromRating, undefined);
  const explicitDayFacts = core.extractFacts('特殊天\n不参与评分');
  assert.strictEqual(explicitDayFacts.lineFacts[0].facts.specialDay.value, true);
  assert.strictEqual(explicitDayFacts.lineFacts[1].facts.excludeFromRating.value, true);
  const explicitNegativeDayFacts = core.extractFacts('不是特殊天\n参与评分');
  assert.strictEqual(explicitNegativeDayFacts.lineFacts[0].facts.specialDay.value, false);
  assert.strictEqual(explicitNegativeDayFacts.lineFacts[1].facts.excludeFromRating.value, false);

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
      name: '政治多选题模板',
      activityType: '政治 > 填空题答题 > 多选题',
      quantityUnit: '道题',
    }],
    sessionTemplates: [{
      id: 'nap',
      name: '午休',
      keywords: ['睡觉'],
      note: '模板备注',
    }],
  });

  assert.strictEqual(draft.wakeTime, '09:00');
  assert.strictEqual(draft.sleepTime, '01:30');
  assert.strictEqual(draft.tasks[0].name, '政治多选题模板');
  assert.strictEqual(draft.tasks[0].quantityUnit, '个空');
  assert.strictEqual(draft.sessions[1].name, '午休');
  assert.strictEqual(draft.sessions[1].sessionTemplateId, 'nap');
  assert.strictEqual(draft.sessions[1].note, '模板备注');
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
  assert.strictEqual(imported.dayType, '');
  assert.strictEqual(imported.tasks[0].quantityUnit, '个空');
  assert.ok(!Object.prototype.hasOwnProperty.call(imported.tasks[0], 'fieldMeta'));
  assert.ok(!Object.prototype.hasOwnProperty.call(imported.sessions[0], 'sourceLines'));
  assert.ok(!Object.prototype.hasOwnProperty.call(imported.sessions[1], 'sessionTemplateId'));

  const dayTypeCombinations = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];
  dayTypeCombinations.forEach(([specialDay, excludeFromRating], index) => {
    const candidate = core.assembleDay(facts, results, {});
    const template = {
      id: `day-type-${index}`,
      name: `日期类型${index}`,
      specialDay,
      excludeFromRating,
    };
    core.applyDayTypeClassification(candidate, facts, {
      templateId: template.id,
      reason: '整日上下文符合模板',
      sourceLines: [3, 4],
    }, [template]);
    assert.strictEqual(candidate.dayType, template.name);
    assert.strictEqual(candidate.dayTypeTemplateId, template.id);
    assert.strictEqual(candidate.specialDay, specialDay);
    assert.strictEqual(candidate.excludeFromRating, excludeFromRating);

    const importedCandidate = core.buildImportDay(candidate);
    assert.strictEqual(importedCandidate.dayType, template.name);
    assert.ok(!Object.prototype.hasOwnProperty.call(importedCandidate, 'dayTypeTemplateId'));
  });

  const resetClassificationDraft = core.assembleDay(facts, results, {});
  core.applyDayTypeClassification(resetClassificationDraft, facts, {
    templateId: 'temporary-day-type',
    reason: '先命中',
    sourceLines: [3],
  }, [{
    id: 'temporary-day-type',
    name: '临时特殊日',
    specialDay: true,
    excludeFromRating: true,
  }]);
  core.applyDayTypeClassification(resetClassificationDraft, facts, {
    templateId: '',
    reason: '重新判断后不匹配',
    sourceLines: [],
  }, []);
  assert.strictEqual(resetClassificationDraft.dayType, '');
  assert.strictEqual(resetClassificationDraft.specialDay, false);
  assert.strictEqual(resetClassificationDraft.excludeFromRating, false);

  const explicitDayDraft = core.assembleDay(explicitDayFacts, [
    lineResult(1, 'unknown'),
    lineResult(2, 'unknown'),
  ], {});
  core.applyDayTypeClassification(explicitDayDraft, explicitDayFacts, {
    templateId: 'rated-normal',
    reason: '模板判断',
    sourceLines: [1, 2],
  }, [{
    id: 'rated-normal',
    name: '普通评分日',
    specialDay: false,
    excludeFromRating: false,
  }]);
  assert.strictEqual(explicitDayDraft.specialDay, true);
  assert.strictEqual(explicitDayDraft.excludeFromRating, true);
  assert.strictEqual(
    explicitDayDraft.aiIssues.filter(item => item.code === 'DAY_TYPE_FACT_CONFLICT').length,
    2
  );

  const manualPriorityDraft = core.assembleDay(facts, results, {});
  manualPriorityDraft.specialDay = true;
  manualPriorityDraft.dayType = '人工自定义类型';
  manualPriorityDraft.fieldMeta.specialDay = {
    value: true,
    sourceLines: [],
    origin: 'manual',
    raw: '人工修改',
  };
  manualPriorityDraft.fieldMeta.dayType = {
    value: '人工自定义类型',
    sourceLines: [],
    origin: 'manual',
    raw: '人工修改',
  };
  core.applyDayTypeClassification(manualPriorityDraft, facts, {
    templateId: 'manual-conflict',
    reason: '模板判断',
    sourceLines: [3],
  }, [{
    id: 'manual-conflict',
    name: '模板普通日',
    specialDay: false,
    excludeFromRating: false,
  }]);
  assert.strictEqual(manualPriorityDraft.specialDay, true);
  assert.strictEqual(manualPriorityDraft.dayType, '人工自定义类型');
  assert.strictEqual(manualPriorityDraft.dayTypeTemplateId, '');
  assert.ok(manualPriorityDraft.aiIssues.some(item => item.code === 'DAY_TYPE_FACT_CONFLICT'));

  const missingDayTypeDraft = core.assembleDay(facts, results, {});
  core.applyDayTypeClassification(missingDayTypeDraft, facts, {
    templateId: 'missing-template',
    reason: '错误 ID',
    sourceLines: [1],
  }, []);
  assert.ok(missingDayTypeDraft.aiIssues.some(item => item.code === 'DAY_TYPE_TEMPLATE_NOT_FOUND'));

  const blankNameDraft = core.assembleDay(facts, results, {
    taskTemplates: [{
      id: 'multi',
      name: '',
      activityType: '政治 > 填空题答题 > 多选题',
    }],
  });
  assert.strictEqual(blankNameDraft.tasks[0].name, '多选题');

  const promptedTaskResults = results.map(item => item.line === 3
    ? lineResult(3, 'task', {
      task: {
        ...item.task,
        name: 'AI 判断的任务名',
        templateId: '',
      },
    })
    : item);
  const promptedTaskTemplate = {
    id: 'prompted-task',
    name: '提示词任务模板',
    activityType: '政治 > 填空题答题 > 多选题',
    aiPrompt: '只用于明确说明正在复习错题的记录；普通做题不要套用。',
  };
  const promptedTaskNotSelected = core.assembleDay(facts, promptedTaskResults, {
    taskTemplates: [promptedTaskTemplate],
  });
  assert.strictEqual(promptedTaskNotSelected.tasks[0].name, 'AI 判断的任务名');
  assert.strictEqual(promptedTaskNotSelected.tasks[0].templateId, '');

  const promptedTaskSelected = core.assembleDay(facts, promptedTaskResults.map(item => item.line === 3
    ? lineResult(3, 'task', { task: { ...item.task, templateId: 'prompted-task' } })
    : item), {
    taskTemplates: [promptedTaskTemplate],
  });
  assert.strictEqual(promptedTaskSelected.tasks[0].name, '提示词任务模板');
  assert.strictEqual(promptedTaskSelected.tasks[0].templateId, 'prompted-task');

  const manualTask = {
    name: '人工任务名',
    activityType: '政治 > 填空题答题 > 多选题',
    templateId: 'multi',
    sourceLines: [3],
    fieldMeta: { name: { value: '人工任务名', sourceLines: [3], origin: 'manual', raw: '人工修改' } },
  };
  core.resolveTaskTemplate(manualTask, [{
    id: 'multi',
    name: '模板任务名',
    activityType: '政治 > 填空题答题 > 多选题',
  }], {}, [], 3, 0);
  assert.strictEqual(manualTask.name, '人工任务名');

  const conflictResults = results.map(item => item.line === 5
    ? lineResult(5, 'session', { session: { type: 'special', name: 'AI午睡', note: '' } })
    : item);
  const conflictDraft = core.assembleDay(facts, conflictResults, {
    sessionTemplates: [
      { id: 'sleep-a', name: '午休A', keywords: ['睡觉'] },
      { id: 'sleep-b', name: '午休B', keywords: ['睡觉'] },
    ],
  });
  assert.strictEqual(conflictDraft.sessions[1].name, 'AI午睡');
  assert.ok(conflictDraft.aiIssues.some(item => item.code === 'SESSION_TEMPLATE_CONFLICT'));

  const promptedSessionTemplate = {
    id: 'prompted-nap',
    name: '提示词午休',
    keywords: ['睡觉'],
    aiPrompt: '仅用于白天主动午休；生病卧床不要套用。',
  };
  const promptedSessionNotSelected = core.assembleDay(facts, conflictResults, {
    sessionTemplates: [promptedSessionTemplate],
  });
  assert.strictEqual(promptedSessionNotSelected.sessions[1].name, 'AI午睡');
  assert.ok(!promptedSessionNotSelected.sessions[1].sessionTemplateId);

  const promptedSessionSelectedResults = conflictResults.map(item => item.line === 5
    ? lineResult(5, 'session', {
      session: { ...item.session, templateId: 'prompted-nap' },
    })
    : item);
  const promptedSessionSelected = core.assembleDay(facts, promptedSessionSelectedResults, {
    sessionTemplates: [promptedSessionTemplate],
  });
  assert.strictEqual(promptedSessionSelected.sessions[1].name, '提示词午休');
  assert.strictEqual(promptedSessionSelected.sessions[1].sessionTemplateId, 'prompted-nap');

  const clearRangeUnknown = results.map(item => item.line === 4
    ? lineResult(4, 'unknown')
    : item);
  const deterministicDraft = core.assembleDay(facts, clearRangeUnknown, { taskTemplates: [] });
  assert.strictEqual(deterministicDraft.sessions[0].type, 'normal');
  assert.strictEqual(deterministicDraft.sessions[0].actualMinutes, 111);

  console.log('AIParserCore tests passed');
}

run();
