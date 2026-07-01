(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIParseManager = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY_STATES = ['pending', 'parsing', 'partial', 'complete', 'excluded', 'error'];
  const MANAGER_STATES = ['idle', 'running', 'paused', 'stopped'];

  function createManager(value = {}) {
    return {
      state: MANAGER_STATES.includes(value.state) ? value.state : 'idle',
      mode: value.mode === 'single' ? 'single' : 'all',
      activeDayId: value.activeDayId || null,
      queueDayIds: Array.isArray(value.queueDayIds) ? [...new Set(value.queueDayIds.filter(Boolean))] : [],
      concurrency: Math.max(1, Number(value.concurrency) || 1),
      startedAt: value.startedAt || '',
      updatedAt: value.updatedAt || '',
      stopReason: value.stopReason || '',
    };
  }

  function checkpointLine(record) {
    return Number(record?.line ?? record?.sourceLine);
  }

  function isValidCheckpoint(record, facts) {
    const line = checkpointLine(record);
    if (!Number.isFinite(line) || record?.parseStatus !== 'ok') return false;
    if (!facts.nonEmptyLines.includes(line)) return false;
    return String(record.text || '') === String(facts.lines[line - 1] || '').trim();
  }

  function dayProgress(split, facts) {
    const records = split?.itemParseResults || [];
    const valid = records.filter(record => isValidCheckpoint(record, facts));
    const failed = records.filter(record => {
      const line = checkpointLine(record);
      return record?.parseStatus === 'error' &&
        facts.nonEmptyLines.includes(line) &&
        String(record.text || '') === String(facts.lines[line - 1] || '').trim();
    });
    return {
      done: valid.length,
      total: facts.nonEmptyLines.length,
      failed: failed.length,
      percent: facts.nonEmptyLines.length
        ? Math.round(valid.length / facts.nonEmptyLines.length * 100)
        : 100,
    };
  }

  function deriveDayState(split, facts) {
    if (split?.parseExcluded) return 'excluded';
    if (split?.parseState === 'parsing') return 'parsing';
    if (split?.parseState === 'partial') return 'partial';
    const progress = dayProgress(split, facts);
    const hasCurrentRecords = (split?.itemParseResults || []).some(record => {
      const line = checkpointLine(record);
      return facts.nonEmptyLines.includes(line) &&
        String(record.text || '') === String(facts.lines[line - 1] || '').trim();
    });
    if (hasCurrentRecords && progress.done < progress.total) {
      if (progress.done > 0) return 'partial';
      if (split?.status === 'error' || split?.parseState === 'error') return 'error';
      return 'pending';
    }
    if (progress.done === progress.total && split?.parsed) {
      if (split.finalReviewState === 'reviewing') return 'parsing';
      if (['pending', 'error'].includes(split.finalReviewState)) return 'partial';
    }
    if (!split?.sourceDirty && split?.parsed && split.finalReviewState === 'complete' &&
      ['review', 'blocked', 'confirmed', 'imported'].includes(split.status)) return 'complete';
    if (!split?.sourceDirty && progress.total > 0 && progress.done === progress.total &&
      split?.parsed && split.finalReviewState === 'complete') return 'complete';
    if (progress.done > 0) return 'partial';
    if (split?.status === 'error' || split?.parseState === 'error') return 'error';
    return 'pending';
  }

  function reconcileOnLoad(splits, managerValue, factsForSplit) {
    const manager = createManager(managerValue);
    const interrupted = manager.state === 'running';
    if (interrupted) {
      manager.state = 'paused';
      manager.stopReason = '页面刷新，运行中的请求已中断';
      manager.updatedAt = new Date().toISOString();
    }

    (splits || []).forEach(split => {
      const facts = factsForSplit(split);
      if (split.parseExcluded) {
        split.parseState = 'excluded';
      } else if ((interrupted && split.id === manager.activeDayId) || split.parseState === 'parsing') {
        split.parseState = 'partial';
      } else {
        split.parseState = deriveDayState(split, facts);
      }
    });
    return manager;
  }

  function setExcluded(split, excluded, facts) {
    split.parseExcluded = Boolean(excluded);
    split.parseState = excluded ? 'excluded' : deriveDayState({ ...split, parseExcluded: false, parseState: '' }, facts);
    return split.parseState;
  }

  function eligibleForQueue(split, facts) {
    if (split?.parseExcluded) return false;
    const state = deriveDayState(split, facts);
    return ['pending', 'partial', 'error'].includes(state);
  }

  function buildSnapshot(splits, managerValue, factsForSplit) {
    const manager = createManager(managerValue);
    const days = (splits || []).map(split => {
      const facts = factsForSplit(split);
      const progress = dayProgress(split, facts);
      const state = split.parseExcluded ? 'excluded' : deriveDayState(split, facts);
      return {
        id: split.id,
        date: split.date,
        state,
        reviewStatus: split.status || 'pending',
        finalReviewState: split.finalReviewState || 'pending',
        finalReviewError: split.finalReviewError || '',
        ...progress,
      };
    });
    const defaultQueue = days.filter(day => !['complete', 'excluded'].includes(day.state));
    const queueIds = manager.queueDayIds.length
      ? new Set(manager.queueDayIds)
      : new Set((defaultQueue.length ? defaultQueue : days.filter(day => day.state !== 'excluded')).map(day => day.id));
    const queueDays = days.filter(day => queueIds.has(day.id) && day.state !== 'excluded');
    const done = queueDays.reduce((sum, day) => sum + day.done, 0);
    const total = queueDays.reduce((sum, day) => sum + day.total, 0);
    const reviewDone = queueDays.filter(day => day.finalReviewState === 'complete').length;
    const reviewTotal = queueDays.length;
    const workflowDone = done + reviewDone;
    const workflowTotal = total + reviewTotal;
    return {
      manager,
      days,
      done,
      total,
      reviewDone,
      reviewTotal,
      percent: workflowTotal ? Math.round(workflowDone / workflowTotal * 100) : 0,
    };
  }

  return {
    DAY_STATES,
    MANAGER_STATES,
    createManager,
    checkpointLine,
    isValidCheckpoint,
    dayProgress,
    deriveDayState,
    reconcileOnLoad,
    setExcluded,
    eligibleForQueue,
    buildSnapshot,
  };
});
