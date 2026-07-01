(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AIParserCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const VERSION = 4;
  const SESSION_TYPES = new Set(['normal', 'special', 'special-study']);
  const LINE_KINDS = new Set(['field', 'session', 'task', 'note', 'unknown']);
  const ORIGINS = new Set(['source-explicit', 'program-derived', 'ai-inferred', 'template-default', 'manual']);
  const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  function fact(value, sourceLines, origin = 'source-explicit', raw = '') {
    return { value, sourceLines: [...new Set(sourceLines || [])], origin, raw };
  }

  function chineseNumber(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (text === '半') return 0.5;
    let total = 0;
    let current = 0;
    let seen = false;
    const units = { 十: 10, 百: 100, 千: 1000 };
    for (const char of text) {
      if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, char)) {
        current = CHINESE_DIGITS[char];
        seen = true;
      } else if (units[char]) {
        total += (current || 1) * units[char];
        current = 0;
        seen = true;
      }
    }
    return seen ? total + current : null;
  }

  function parseDuration(value) {
    const text = String(value || '').replace(/\s+/g, '').replace(/^还/, '');
    if (!text) return null;
    if (/半(?:个)?小时/.test(text)) return 30;
    const hourMatch = text.match(/([零〇一二两三四五六七八九十百千\d.]+)(?:个)?小时/);
    const minuteMatch = text.match(/([零〇一二两三四五六七八九十百千\d.]+)(?:分钟|分)/);
    const hours = hourMatch ? chineseNumber(hourMatch[1]) : 0;
    const minutes = minuteMatch ? chineseNumber(minuteMatch[1]) : 0;
    if (hours == null || minutes == null || (!hourMatch && !minuteMatch)) return null;
    return Math.round(hours * 60 + minutes);
  }

  function normalizeClock(hourValue, minuteValue, context = '') {
    let hour = Number(hourValue);
    const minute = Number(minuteValue || 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return '';
    if (hour === 24) hour = 0;
    if (hour > 24 || hour < 0) return '';
    if (/睡觉|就寝/.test(context) && hour === 12 && !/中午|下午|PM/i.test(context)) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function extractClockToken(token, context = '') {
    const text = String(token || '').trim();
    let match = text.match(/(\d{1,2})\s*[:.]\s*(\d{1,2})/);
    if (match) return normalizeClock(match[1], match[2], context);
    match = text.match(/([零〇一二两三四五六七八九十百千\d]+)\s*点(?:\s*([零〇一二两三四五六七八九十百千\d]+)\s*分?)?/);
    if (!match) return '';
    return normalizeClock(chineseNumber(match[1]), match[2] ? chineseNumber(match[2]) : 0, context);
  }

  function clockMinutes(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }

  function clockSpan(startTime, endTime) {
    const start = clockMinutes(startTime);
    const end = clockMinutes(endTime);
    if (start == null || end == null) return null;
    const span = end - start;
    return span >= 0 ? span : span + 1440;
  }

  function extractTimeRange(text) {
    const normalized = String(text || '').replace(/[～—]/g, '~');
    const match = normalized.match(
      /(\d{1,2})\s*[:.]\s*(\d{1,2})\s*(?:~|-|到)\s*(\d{1,2})\s*[:.]\s*(\d{1,2})/
    );
    if (!match) return null;
    const startTime = normalizeClock(match[1], match[2]);
    const endTime = normalizeClock(match[3], match[4]);
    if (!startTime || !endTime) return null;
    return { startTime, endTime, raw: match[0] };
  }

  function durationExpressionPattern() {
    return '(?:半(?:个)?小时|(?:[零〇一二两三四五六七八九十百千\\d.]+(?:个)?小时)(?:[零〇一二两三四五六七八九十百千\\d.]+(?:分钟|分))?|[零〇一二两三四五六七八九十百千\\d.]+(?:分钟|分))';
  }

  function extractLabeledDuration(text, labelPattern) {
    const pattern = new RegExp(`${labelPattern}\\s*(?:还)?\\s*(${durationExpressionPattern()})`, 'i');
    const match = String(text || '').match(pattern);
    if (!match) return null;
    const value = parseDuration(match[1]);
    return value == null ? null : { value, raw: match[1] };
  }

  function extractNominalDuration(text) {
    const source = String(text || '');
    const parenthetical = [...source.matchAll(/[（(]([^（）()]*)[）)]/g)].map(match => match[1].trim());
    for (const segment of parenthetical) {
      if (/实际|实记|实力|休息|专注.*次|关注.*次/.test(segment)) continue;
      if (new RegExp(`^${durationExpressionPattern()}$`).test(segment.replace(/\s+/g, ''))) {
        const value = parseDuration(segment);
        if (value != null) return { value, raw: segment };
      }
    }
    return null;
  }

  function extractQuantity(text) {
    const match = String(text || '').match(
      /([零〇一二两三四五六七八九十百千万\d.]+)\s*(个空|道题|个单词|单词|个词|词|页|篇|套|题)/
    );
    if (!match) return null;
    const value = chineseNumber(match[1]);
    if (value == null) return null;
    return { value, unit: match[2], raw: match[0] };
  }

  function extractTaskMinutes(text) {
    const source = String(text || '');
    const matches = [...source.matchAll(new RegExp(durationExpressionPattern(), 'g'))];
    if (!matches.length) return null;
    const candidate = matches[matches.length - 1][0];
    const value = parseDuration(candidate);
    return value == null ? null : { value, raw: candidate };
  }

  function extractCompletionStatus(text) {
    const source = String(text || '');
    if (/未完成|暂时|做到一半|填到一半/.test(source)) return 'partial';
    if (/已完成|完成[）)]/.test(source)) return 'completed';
    if (/检查错题|错题检测|错题批改|复习/.test(source)) return 'review';
    return '';
  }

  function extractFacts(dayText) {
    const lines = String(dayText || '').replace(/\r\n?/g, '\n').split('\n');
    const lineFacts = [];
    const nonEmptyLines = [];

    lines.forEach((text, offset) => {
      const line = offset + 1;
      const trimmed = text.trim();
      if (!trimmed) return;
      nonEmptyLines.push(line);
      const result = { line, text, trimmed, facts: {}, hints: {} };
      const dateHeading = /^(?:(?:20\d{2})年)?\d{1,2}月\d{1,2}日/.test(trimmed);
      if (dateHeading) result.hints.dateHeading = true;

      const range = extractTimeRange(trimmed);
      if (range) {
        result.facts.startTime = fact(range.startTime, [line], 'source-explicit', range.raw);
        result.facts.endTime = fact(range.endTime, [line], 'source-explicit', range.raw);
        result.facts.clockMinutes = fact(clockSpan(range.startTime, range.endTime), [line], 'program-derived', range.raw);
        result.hints.hasTimeRange = true;
      }

      if (/起床/.test(trimmed) && !range) {
        const value = extractClockToken(trimmed, '起床');
        if (value) result.facts.wakeTime = fact(value, [line], 'source-explicit', trimmed);
      }

      if (/睡觉|就寝/.test(trimmed)) {
        if (range) {
          result.hints.sessionType = 'special';
          result.hints.sessionName = /午睡|午休/.test(trimmed) ? '午睡' : '睡觉';
        } else {
          const value = extractClockToken(trimmed, '睡觉');
          if (value) result.facts.sleepTime = fact(value, [line], 'source-explicit', trimmed);
        }
      }

      if (range && /吃饭|早餐|午饭|晚饭|洗澡|剪头发|回学校|上课|停电|修电脑|午睡|午休|睡觉/.test(trimmed)) {
        result.hints.sessionType = 'special';
        result.hints.sessionName = result.hints.sessionName ||
          ((trimmed.match(/吃饭|早餐|午饭|晚饭|洗澡|剪头发|回学校|上课|停电|修电脑|午睡|午休|睡觉/) || [])[0] || '特殊时段');
      } else if (range && /专注|关注|实际|实记|休息/.test(trimmed)) {
        result.hints.sessionType = 'normal';
      }

      if (range) {
        const nominal = extractNominalDuration(trimmed);
        const actual = extractLabeledDuration(trimmed, '(?:实际|实记|实力)\\s*(?:专注|关注)?');
        const rest = extractLabeledDuration(trimmed, '休息');
        if (nominal) result.facts.nominalMinutes = fact(nominal.value, [line], 'source-explicit', nominal.raw);
        if (actual) result.facts.actualMinutes = fact(actual.value, [line], 'source-explicit', actual.raw);
        if (rest) result.facts.restMinutes = fact(rest.value, [line], 'source-explicit', rest.raw);
        const focusMatch = trimmed.match(/(?:专注|关注)\s*([零〇一二两三四五六七八九十百千\d]+)\s*次/);
        if (focusMatch) {
          const count = chineseNumber(focusMatch[1]);
          if (count != null) result.facts.focusCount = fact(count, [line], 'source-explicit', focusMatch[0]);
        }
      } else if (!dateHeading && !result.facts.wakeTime && !result.facts.sleepTime) {
        const duration = extractTaskMinutes(trimmed);
        const quantity = extractQuantity(trimmed);
        if (duration) result.facts.taskMinutes = fact(duration.value, [line], 'source-explicit', duration.raw);
        if (quantity) {
          result.facts.quantity = fact(quantity.value, [line], 'source-explicit', quantity.raw);
          result.facts.quantityUnit = fact(quantity.unit, [line], 'source-explicit', quantity.raw);
        }
        const completionStatus = extractCompletionStatus(trimmed);
        if (completionStatus) result.facts.completionStatus = fact(completionStatus, [line], 'source-explicit', trimmed);
        const errorMatch = trimmed.match(/错误\s*([零〇一二两三四五六七八九十百千\d]+)\s*(?:道题|题)?/);
        if (errorMatch) {
          const errorCount = chineseNumber(errorMatch[1]);
          if (errorCount != null) result.facts.errorCount = fact(errorCount, [line], 'source-explicit', errorMatch[0]);
        }
      }

      const specialDayNegative = /(?:不是|并非|非)\s*特殊(?:日|天)/.test(trimmed);
      const specialDayPositive = /特殊(?:日|天)/.test(trimmed);
      if (specialDayNegative) {
        result.facts.specialDay = fact(false, [line], 'source-explicit', trimmed);
      } else if (specialDayPositive) {
        result.facts.specialDay = fact(true, [line], 'source-explicit', trimmed);
      }

      const excludeRatingPositive = /不参与评分|不计入评分|不评分|排除评分/.test(trimmed);
      const excludeRatingNegative = /(?:参与|计入)\s*评分/.test(trimmed);
      if (excludeRatingPositive) {
        result.facts.excludeFromRating = fact(true, [line], 'source-explicit', trimmed);
      } else if (excludeRatingNegative) {
        result.facts.excludeFromRating = fact(false, [line], 'source-explicit', trimmed);
      }
      lineFacts.push(result);
    });

    return { parserVersion: VERSION, text: String(dayText || ''), lines, nonEmptyLines, lineFacts };
  }

  function validateAiEnvelope(value, sourceFacts, expectedLines = null) {
    if (!value || !Array.isArray(value.lineResults)) throw new Error('批量解析结果缺少 lineResults 数组');
    const expected = new Set(expectedLines || sourceFacts.nonEmptyLines);
    const seen = new Set();
    value.lineResults.forEach((result, index) => {
      const line = Number(result?.line);
      if (!expected.has(line)) throw new Error(`lineResults[${index}].line 不在请求范围内：${result?.line}`);
      if (seen.has(line)) throw new Error(`lineResults 出现重复行号：${line}`);
      seen.add(line);
      const kind = String(result?.kind || '').toLowerCase();
      if (!LINE_KINDS.has(kind)) throw new Error(`第 ${line} 行 kind 不合法：${result?.kind || '空'}`);
      result.kind = kind;
      if (kind === 'field' && !['wakeTime', 'sleepTime', 'specialDay', 'excludeFromRating', 'dayNote'].includes(result.field)) {
        throw new Error(`第 ${line} 行 field 不合法：${result.field || '空'}`);
      }
      if (kind === 'session' && (!result.session || typeof result.session !== 'object')) {
        throw new Error(`第 ${line} 行缺少 session`);
      }
      if (kind === 'session' && result.session.type && !SESSION_TYPES.has(result.session.type)) {
        throw new Error(`第 ${line} 行 session.type 不合法：${result.session.type}`);
      }
      if (kind === 'task' && (!result.task || typeof result.task !== 'object' || !String(result.task.name || '').trim())) {
        throw new Error(`第 ${line} 行缺少有效 task`);
      }
      if (kind === 'note' && (!result.note || typeof result.note !== 'object')) {
        throw new Error(`第 ${line} 行缺少 note`);
      }
      if (!Array.isArray(result.aiIssues)) result.aiIssues = [];
    });
    const missing = [...expected].filter(line => !seen.has(line));
    if (missing.length) throw new Error(`批量解析遗漏行号：${missing.join('、')}`);
    return true;
  }

  function issue(code, level, message, sourceLines, extra = {}) {
    return { code, level, message, sourceLines: [...new Set(sourceLines || [])], ...extra };
  }

  function itemMeta(origin, reason, extra = {}) {
    const labels = {
      'source-explicit': '原文明确',
      'program-derived': '程序推导',
      'ai-inferred': 'AI语义推断',
      'template-default': '唯一模板',
      manual: '人工确认',
      conflict: '存在冲突'
    };
    return { evidenceLevel: origin, evidenceLabel: labels[origin] || origin, reason, ...extra };
  }

  function resolveTemplate(task, templates, facts, issues, line, taskIndex) {
    const selected = task.templateId ? templates.find(template => template.id === task.templateId) : null;
    const uniqueByType = !selected && task.activityType
      ? templates.filter(template => template.activityType === task.activityType)
      : [];
    const typeFallback = uniqueByType.length === 1 && !String(uniqueByType[0].aiPrompt || '').trim()
      ? uniqueByType[0]
      : null;
    const template = selected || typeFallback;
    if (!template) return;
    task.templateId = template.id;
    if (!task.activityType && template.activityType) task.activityType = template.activityType;
    if (template.name && task.fieldMeta?.name?.origin !== 'manual') {
      task.name = template.name;
      task.fieldMeta.name = fact(template.name, [line], 'template-default', template.name);
    }
    if (template.defaultMinutes && task.minutes == null) {
      task.minutes = Number(template.defaultMinutes);
      task.fieldMeta.minutes = fact(task.minutes, [line], 'template-default', template.name || template.activityType || '');
    }
    if (template.quantityUnit && task.quantityUnit == null) {
      task.quantityUnit = template.quantityUnit;
      task.fieldMeta.quantityUnit = fact(template.quantityUnit, [line], 'template-default', template.name || template.activityType || '');
    } else if (template.quantityUnit && facts.quantityUnit && template.quantityUnit !== facts.quantityUnit.value) {
      issues.push(issue(
        'TEMPLATE_FACT_CONFLICT',
        'warning',
        `原文单位“${facts.quantityUnit.value}”与模板默认单位“${template.quantityUnit}”不同，已保留原文单位。`,
        [line],
        { targetPath: `parsed.tasks.${taskIndex}.quantityUnit`, original: facts.quantityUnit.value, suggestion: template.quantityUnit }
      ));
      task.aiMeta = itemMeta('conflict', '模板单位与原文明写单位冲突');
    }
    if (template.note && !task.note) task.note = template.note;
    if (task.aiMeta?.evidenceLevel !== 'conflict') task.aiMeta = itemMeta('template-default', '唯一任务模板');
  }

  function sessionTemplateMatches(text, template) {
    const source = String(text || '').toLowerCase();
    if (!source) return false;
    const name = String(template?.name || '').trim().toLowerCase();
    if (name && source.includes(name)) return true;
    return (template?.keywords || []).some(keyword => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && source.includes(normalized);
    });
  }

  function resolveSessionTemplate(session, templates, lineFact, aiSession, issues, line, sessionIndex) {
    if (session.type !== 'special' || !templates.length) return null;
    const literalMatches = templates.filter(template => sessionTemplateMatches(lineFact.trimmed, template));
    const aiSelected = aiSession.templateId
      ? templates.find(template => template.id === aiSession.templateId)
      : null;
    const deterministicMatches = literalMatches.filter(template => !String(template.aiPrompt || '').trim());
    let selected = null;

    if (aiSelected) {
      selected = aiSelected;
    } else if (deterministicMatches.length === 1) {
      selected = deterministicMatches[0];
    } else if (deterministicMatches.length > 1) {
      if (!selected) {
        issues.push(issue(
          'SESSION_TEMPLATE_CONFLICT',
          'warning',
          `第 ${line} 行同时命中多个特殊时段模板：${deterministicMatches.map(template => template.name || template.id).join('、')}。`,
          [line],
          { targetPath: `parsed.sessions.${sessionIndex}.name` }
        ));
        session.aiMeta = itemMeta('conflict', '多个特殊时段模板同时命中');
        return null;
      }
    } else if (aiSession.templateId) {
      issues.push(issue(
        'SESSION_TEMPLATE_NOT_FOUND',
        'warning',
        `第 ${line} 行引用的特殊时段模板不存在：${aiSession.templateId}。`,
        [line],
        { original: aiSession.templateId, targetPath: `parsed.sessions.${sessionIndex}.name` }
      ));
    }

    if (!selected) return null;
    session.sessionTemplateId = selected.id;
    if (selected.name) session.name = selected.name;
    if (selected.note && !session.note) session.note = selected.note;
    session.aiMeta = itemMeta('template-default', `特殊时段模板：${selected.name || selected.id}`);
    return selected;
  }

  function assembleDay(sourceFacts, aiLineResults, options = {}) {
    const templates = options.taskTemplates || [];
    const sessionTemplates = options.sessionTemplates || [];
    const byLine = new Map((aiLineResults || []).map(result => [Number(result.line), result]));
    const draft = {
      parserVersion: VERSION,
      wakeTime: null,
      sleepTime: null,
      dayType: '',
      dayTypeTemplateId: '',
      specialDay: false,
      specialDayReason: '',
      excludeFromRating: false,
      dayNote: '',
      sessions: [],
      tasks: [],
      aiIssues: [],
      unassignedLines: [],
      consumedLines: [],
      fieldMeta: {}
    };
    let lastSession = null;
    let lastTask = null;

    sourceFacts.lineFacts.forEach(lineFact => {
      const line = lineFact.line;
      const facts = lineFact.facts;
      const hints = lineFact.hints;
      const ai = byLine.get(line) || { line, kind: 'unknown', aiIssues: [] };
      const markConsumed = () => {
        if (!draft.consumedLines.includes(line)) draft.consumedLines.push(line);
      };
      (ai.aiIssues || []).forEach(item => draft.aiIssues.push({ ...item, sourceLines: [line] }));
      const hasExplicitDayFlags = Boolean(facts.specialDay || facts.excludeFromRating);
      if (facts.specialDay) {
        draft.specialDay = Boolean(facts.specialDay.value);
        draft.fieldMeta.specialDay = facts.specialDay;
      }
      if (facts.excludeFromRating) {
        draft.excludeFromRating = Boolean(facts.excludeFromRating.value);
        draft.fieldMeta.excludeFromRating = facts.excludeFromRating;
      }

      if (hints.dateHeading) {
        markConsumed();
        return;
      }
      if (facts.wakeTime) {
        draft.wakeTime = facts.wakeTime.value;
        draft.fieldMeta.wakeTime = facts.wakeTime;
        markConsumed();
        return;
      }
      if (facts.sleepTime) {
        draft.sleepTime = facts.sleepTime.value;
        draft.fieldMeta.sleepTime = facts.sleepTime;
        markConsumed();
        return;
      }
      const structuralSession = Boolean(facts.startTime && facts.endTime);
      if (structuralSession || ai.kind === 'session') {
        const aiSession = ai.session || {};
        const rawType = hints.sessionType || aiSession.type || '';
        const type = SESSION_TYPES.has(rawType) ? rawType : null;
        if (!type) {
          draft.aiIssues.push(issue(
            'SESSION_TYPE_INVALID',
            'error',
            `第 ${line} 行时段类型“${rawType || '空'}”不合法。`,
            [line],
            { original: rawType }
          ));
        }
        const startTime = facts.startTime?.value || aiSession.startTime || null;
        const endTime = facts.endTime?.value || aiSession.endTime || null;
        const span = clockSpan(startTime, endTime);
        const session = {
          id: aiSession.id || '',
          type,
          name: aiSession.name || hints.sessionName || '',
          startTime,
          endTime,
          nominalMinutes: null,
          actualMinutes: null,
          restMinutes: null,
          note: aiSession.note || '',
          sourceLines: [line],
          linkedTaskIds: [],
          fieldMeta: {
            startTime: facts.startTime || fact(startTime, [line], 'ai-inferred'),
            endTime: facts.endTime || fact(endTime, [line], 'ai-inferred')
          },
          aiMeta: itemMeta(hints.sessionType ? 'source-explicit' : 'ai-inferred', hints.sessionType ? '原文关键词和时间范围' : 'AI时段语义判断')
        };
        resolveSessionTemplate(
          session,
          sessionTemplates,
          lineFact,
          aiSession,
          draft.aiIssues,
          line,
          draft.sessions.length
        );

        if (type === 'special') {
          session.nominalMinutes = 0;
          session.actualMinutes = 0;
          session.restMinutes = 0;
          session.fieldMeta.nominalMinutes = fact(0, [line], 'program-derived', 'special');
          session.fieldMeta.actualMinutes = fact(0, [line], 'program-derived', 'special');
          session.fieldMeta.restMinutes = fact(0, [line], 'program-derived', 'special');
        } else if (type === 'normal' || type === 'special-study') {
          const hasExplicitStats = Boolean(facts.nominalMinutes || facts.actualMinutes || facts.restMinutes);
          if (type === 'normal' && !hasExplicitStats && span != null) {
            session.nominalMinutes = span;
            session.actualMinutes = span;
            session.restMinutes = 0;
            session.fieldMeta.nominalMinutes = fact(span, [line], 'program-derived', 'clock span');
            session.fieldMeta.actualMinutes = fact(span, [line], 'program-derived', 'clock span');
            session.fieldMeta.restMinutes = fact(0, [line], 'program-derived', 'no rest stated');
          } else {
            session.nominalMinutes = facts.nominalMinutes?.value ?? null;
            session.actualMinutes = facts.actualMinutes?.value ?? null;
            session.restMinutes = facts.restMinutes?.value ?? 0;
            if (facts.nominalMinutes) session.fieldMeta.nominalMinutes = facts.nominalMinutes;
            if (facts.actualMinutes) session.fieldMeta.actualMinutes = facts.actualMinutes;
            session.fieldMeta.restMinutes = facts.restMinutes || fact(0, [line], 'program-derived', 'no rest stated');
            if (type === 'special-study' && session.nominalMinutes == null) {
              session.nominalMinutes = 0;
              session.fieldMeta.nominalMinutes = fact(0, [line], 'program-derived', 'special-study');
            }
          }
        }
        draft.sessions.push(session);
        lastSession = session;
        lastTask = null;
        markConsumed();
        return;
      }

      if (ai.kind === 'field') {
        if (ai.field === 'dayNote') draft.dayNote = [draft.dayNote, String(ai.value || '')].filter(Boolean).join('\n');
        else if (['specialDay', 'excludeFromRating'].includes(ai.field)) {
          if (draft.fieldMeta[ai.field]?.origin !== 'source-explicit') {
            draft[ai.field] = Boolean(ai.value);
            draft.fieldMeta[ai.field] = fact(Boolean(ai.value), [line], 'ai-inferred', lineFact.trimmed);
          }
        }
        else if (['wakeTime', 'sleepTime'].includes(ai.field)) draft[ai.field] = ai.value || null;
        if (!draft.fieldMeta[ai.field]) draft.fieldMeta[ai.field] = fact(ai.value, [line], 'ai-inferred', lineFact.trimmed);
        markConsumed();
        return;
      }

      const taskLikeFacts = Boolean(facts.taskMinutes || facts.quantity || facts.quantityUnit || facts.completionStatus);
      if (ai.kind === 'task' || taskLikeFacts) {
        const aiTask = ai.task || {};
        const task = {
          id: aiTask.id || '',
          name: String(aiTask.name || lineFact.trimmed).trim(),
          activityType: aiTask.activityType || '',
          templateId: aiTask.templateId || '',
          minutes: facts.taskMinutes?.value ?? (Number.isFinite(Number(aiTask.minutes)) ? Number(aiTask.minutes) : null),
          quantity: facts.quantity?.value ?? (aiTask.quantity == null ? null : Number(aiTask.quantity)),
          quantityUnit: facts.quantityUnit?.value ?? (aiTask.quantityUnit || null),
          completionStatus: facts.completionStatus?.value || aiTask.completionStatus || 'unknown',
          progressText: aiTask.progressText || '',
          errorCount: facts.errorCount?.value ?? (aiTask.errorCount == null ? null : Number(aiTask.errorCount)),
          note: aiTask.note || '',
          sourceLines: [line],
          fieldMeta: {},
          aiMeta: itemMeta('ai-inferred', 'AI任务语义判断')
        };
        task.fieldMeta.name = fact(task.name, [line], 'ai-inferred', aiTask.name || lineFact.trimmed);
        if (facts.taskMinutes) task.fieldMeta.minutes = facts.taskMinutes;
        else if (task.minutes != null) task.fieldMeta.minutes = fact(task.minutes, [line], 'ai-inferred');
        if (facts.quantity) task.fieldMeta.quantity = facts.quantity;
        else if (task.quantity != null) task.fieldMeta.quantity = fact(task.quantity, [line], 'ai-inferred');
        if (facts.quantityUnit) task.fieldMeta.quantityUnit = facts.quantityUnit;
        else if (task.quantityUnit) task.fieldMeta.quantityUnit = fact(task.quantityUnit, [line], 'ai-inferred');
        resolveTemplate(task, templates, facts, draft.aiIssues, line, draft.tasks.length);
        draft.tasks.push(task);
        lastTask = task;
        markConsumed();
        return;
      }

      if (ai.kind === 'note') {
        const note = ai.note || {};
        const text = String(note.text || lineFact.trimmed).trim();
        if (note.target === 'previous-task' && lastTask) lastTask.note = [lastTask.note, text].filter(Boolean).join('\n');
        else if (note.target === 'previous-session' && lastSession) lastSession.note = [lastSession.note, text].filter(Boolean).join('\n');
        else if (note.target === 'day') draft.dayNote = [draft.dayNote, text].filter(Boolean).join('\n');
        else {
          draft.unassignedLines.push({ line, text: lineFact.trimmed, reason: '备注无法安全归属' });
        }
        markConsumed();
        return;
      }

      if (hasExplicitDayFlags) {
        markConsumed();
        return;
      }

      draft.unassignedLines.push({ line, text: lineFact.trimmed, reason: ai.reason || 'AI未能归属该行' });
      markConsumed();
    });

    draft.consumedLines.sort((a, b) => a - b);
    return draft;
  }

  function applyDayTypeClassification(draft, sourceFacts, classification, templates) {
    if (!draft) return draft;
    draft.fieldMeta = draft.fieldMeta || {};
    draft.aiIssues = (draft.aiIssues || []).filter(item =>
      !['DAY_TYPE_TEMPLATE_NOT_FOUND', 'DAY_TYPE_FACT_CONFLICT'].includes(item.code)
    );
    const sourceLines = [...new Set((classification?.sourceLines || []).map(Number).filter(Number.isFinite))];
    const templateId = String(classification?.templateId || '');
    const selected = templateId
      ? (templates || []).find(template => template.id === templateId)
      : null;

    const resetTemplateField = (field, fallback) => {
      const origin = draft.fieldMeta[field]?.origin;
      if (['template-default', 'ai-inferred'].includes(origin)) {
        draft[field] = fallback;
        delete draft.fieldMeta[field];
      }
    };

    resetTemplateField('dayType', '');
    resetTemplateField('specialDay', false);
    resetTemplateField('excludeFromRating', false);
    draft.dayTypeTemplateId = '';

    if (!templateId) return draft;
    if (!selected) {
      draft.aiIssues.push(issue(
        'DAY_TYPE_TEMPLATE_NOT_FOUND',
        'error',
        `AI 返回的日期类型模板不存在：${templateId}。`,
        sourceLines,
        { original: templateId, targetPath: 'parsed.dayType' }
      ));
      return draft;
    }

    const reason = String(classification?.reason || '').trim();
    if (draft.fieldMeta.dayType?.origin !== 'manual') {
      draft.dayType = selected.name || '';
      draft.fieldMeta.dayType = fact(draft.dayType, sourceLines, 'ai-inferred', reason || selected.name || '');
      draft.dayTypeTemplateId = selected.id;
    } else {
      draft.dayTypeTemplateId = '';
    }

    ['specialDay', 'excludeFromRating'].forEach(field => {
      const templateValue = Boolean(selected[field]);
      const currentMeta = draft.fieldMeta[field];
      if (currentMeta && ['manual', 'source-explicit'].includes(currentMeta.origin)) {
        if (Boolean(draft[field]) !== templateValue) {
          draft.aiIssues.push(issue(
            'DAY_TYPE_FACT_CONFLICT',
            'warning',
            `日期类型“${selected.name || selected.id}”建议${field === 'specialDay' ? '特殊天' : '不参与评分'}为${templateValue ? '是' : '否'}，但已保留${currentMeta.origin === 'manual' ? '人工修改' : '原文明写'}值。`,
            [...new Set([...(currentMeta.sourceLines || []), ...sourceLines])],
            {
              targetPath: `parsed.${field}`,
              original: Boolean(draft[field]),
              suggestion: templateValue
            }
          ));
        }
        return;
      }
      draft[field] = templateValue;
      draft.fieldMeta[field] = fact(templateValue, sourceLines, 'template-default', selected.name || selected.id);
    });
    return draft;
  }

  function validateDay(draft, sourceFacts) {
    const issues = [];
    const claimed = new Set(draft.consumedLines || []);
    sourceFacts.nonEmptyLines.forEach(line => {
      if (!claimed.has(line)) issues.push(issue('SOURCE_LINE_NOT_ACCOUNTED', 'error', `第 ${line} 行未被处理。`, [line]));
    });
    (draft.sessions || []).forEach((session, index) => {
      const lines = session.sourceLines || [];
      if (!SESSION_TYPES.has(session.type)) {
        issues.push(issue('SESSION_TYPE_INVALID', 'error', `时段 #${index + 1} 的类型不合法。`, lines, { targetPath: `parsed.sessions.${index}.type` }));
      }
      if (!clockMinutes(session.startTime) && session.startTime !== '00:00') {
        issues.push(issue('SESSION_TIME_MISSING', 'error', `时段 #${index + 1} 缺少合法开始时间。`, lines));
      }
      if (!clockMinutes(session.endTime) && session.endTime !== '00:00') {
        issues.push(issue('SESSION_TIME_MISSING', 'error', `时段 #${index + 1} 缺少合法结束时间。`, lines));
      }
      if (session.type === 'normal') {
        ['nominalMinutes', 'actualMinutes', 'restMinutes'].forEach(field => {
          if (!Number.isFinite(Number(session[field])) || Number(session[field]) < 0) {
            issues.push(issue('SESSION_DURATION_MISSING', 'error', `普通时段 #${index + 1} 缺少合法的 ${field}。`, lines, { targetPath: `parsed.sessions.${index}.${field}` }));
          }
        });
        const span = clockSpan(session.startTime, session.endTime);
        if (span != null && Number(session.actualMinutes) + Number(session.restMinutes) > span) {
          issues.push(issue('SESSION_TOTAL_EXCEEDS_CLOCK', 'error', `时段 ${session.startTime}-${session.endTime} 的实际专注与休息超过时钟跨度。`, lines));
        }
      }
    });
    (draft.tasks || []).forEach((task, index) => {
      if (!task.name) issues.push(issue('TASK_NAME_MISSING', 'error', `任务 #${index + 1} 缺少名称。`, task.sourceLines || []));
      if (task.minutes == null || !Number.isFinite(Number(task.minutes)) || Number(task.minutes) < 0) {
        issues.push(issue('TASK_MINUTES_MISSING', 'error', `任务“${task.name || `#${index + 1}`}”缺少合法时长。`, task.sourceLines || []));
      }
    });
    (draft.unassignedLines || []).forEach(item => {
      const lineFact = sourceFacts.lineFacts.find(candidate => candidate.line === Number(item.line));
      if (lineFact?.hints?.hasTimeRange) {
        issues.push(issue('CLEAR_TIME_RANGE_UNASSIGNED', 'error', `明确时间范围未能归属：“${item.text}”`, [item.line]));
      } else {
        issues.push(issue('UNASSIGNED_SOURCE_LINE', 'warning', `原文仍未归属：“${item.text}”`, [item.line]));
      }
    });
    return [...(draft.aiIssues || []), ...issues];
  }

  function stripParserMetadata(value) {
    if (Array.isArray(value)) return value.map(stripParserMetadata);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    Object.entries(value).forEach(([key, item]) => {
      if (['fieldMeta', 'aiMeta', 'sourceLines', 'parserVersion', 'aiIssues', 'unassignedLines', 'consumedLines', 'sessionTemplateId', 'dayTypeTemplateId'].includes(key)) return;
      output[key] = stripParserMetadata(item);
    });
    return output;
  }

  function buildImportDay(validatedDraft) {
    return stripParserMetadata({
      wakeTime: validatedDraft.wakeTime || '',
      sleepTime: validatedDraft.sleepTime || '',
      dayType: validatedDraft.dayType || '',
      specialDay: Boolean(validatedDraft.specialDay),
      specialDayReason: validatedDraft.specialDayReason || '',
      excludeFromRating: Boolean(validatedDraft.excludeFromRating),
      dayNote: validatedDraft.dayNote || '',
      sessions: validatedDraft.sessions || [],
      tasks: validatedDraft.tasks || []
    });
  }

  return {
    VERSION,
    SESSION_TYPES: [...SESSION_TYPES],
    ORIGINS: [...ORIGINS],
    chineseNumber,
    parseDuration,
    extractClockToken,
    clockSpan,
    extractFacts,
    validateAiEnvelope,
    resolveTaskTemplate: resolveTemplate,
    assembleDay,
    applyDayTypeClassification,
    validateDay,
    buildImportDay
  };
});
