const assert = require('assert');
const manager = require('./ai_parse_manager.js');

function facts(lines) {
  return {
    lines,
    nonEmptyLines: lines.map((line, index) => line.trim() ? index + 1 : null).filter(Boolean),
  };
}

function ok(line, text) {
  return { line, sourceLine: line, text, parseStatus: 'ok' };
}

function run() {
  const sourceFacts = facts(['5月1日', '任务A', '任务B']);
  const partial = {
    id: 'day-1',
    date: '2026-05-01',
    status: 'error',
    itemParseResults: [ok(1, '5月1日'), ok(2, '任务A')],
  };
  assert.deepStrictEqual(manager.dayProgress(partial, sourceFacts), {
    done: 2,
    total: 3,
    failed: 0,
    percent: 67,
  });
  assert.strictEqual(manager.deriveDayState(partial, sourceFacts), 'partial');
  assert.strictEqual(manager.deriveDayState({
    ...partial,
    parsed: { tasks: [{ name: '旧草稿' }] },
    status: 'review',
  }, sourceFacts), 'partial');

  const reviewFailed = {
    id: 'day-review-failed',
    date: '2026-05-03',
    status: 'review',
    parsed: { tasks: [{ name: '已组装草稿' }] },
    finalReviewState: 'error',
    finalReviewError: 'Concurrency limit exceeded',
    itemParseResults: [
      ok(1, '5月1日'),
      ok(2, '任务A'),
      ok(3, '任务B'),
    ],
  };
  assert.strictEqual(manager.deriveDayState(reviewFailed, sourceFacts), 'partial');
  assert.strictEqual(manager.eligibleForQueue(reviewFailed, sourceFacts), true);

  const reviewComplete = {
    ...reviewFailed,
    finalReviewState: 'complete',
    finalReviewError: '',
  };
  assert.strictEqual(manager.deriveDayState(reviewComplete, sourceFacts), 'complete');
  assert.strictEqual(manager.eligibleForQueue(reviewComplete, sourceFacts), false);

  const excluded = { ...partial };
  manager.setExcluded(excluded, true, sourceFacts);
  assert.strictEqual(excluded.parseState, 'excluded');
  assert.strictEqual(manager.eligibleForQueue(excluded, sourceFacts), false);
  manager.setExcluded(excluded, false, sourceFacts);
  assert.strictEqual(excluded.parseState, 'partial');

  const splits = [{ ...partial, parseState: 'parsing' }, {
    id: 'day-2',
    date: '2026-05-02',
    status: 'pending',
    itemParseResults: [],
  }];
  const sourceById = {
    'day-1': sourceFacts,
    'day-2': facts(['5月2日', '任务C']),
  };
  const restored = manager.reconcileOnLoad(splits, {
    state: 'running',
    mode: 'all',
    activeDayId: 'day-1',
    queueDayIds: ['day-1', 'day-2'],
  }, split => sourceById[split.id]);
  assert.strictEqual(restored.state, 'paused');
  assert.strictEqual(splits[0].parseState, 'partial');
  assert.strictEqual(splits[1].parseState, 'pending');

  const snapshot = manager.buildSnapshot(splits, restored, split => sourceById[split.id]);
  assert.strictEqual(snapshot.done, 2);
  assert.strictEqual(snapshot.total, 5);
  assert.strictEqual(snapshot.reviewDone, 0);
  assert.strictEqual(snapshot.reviewTotal, 2);
  assert.strictEqual(snapshot.days[0].state, 'partial');

  console.log('AI parse manager tests passed');
}

run();
