const assert = require('assert');
const scheduler = require('./ai_step2_scheduler.js');

async function testAdjacentWaves() {
  assert.deepStrictEqual(
    scheduler.buildAdjacentWaves([1, 2, 3, 4, 5, 6], 4),
    [[1, 2, 3, 4], [5, 6]]
  );
  assert.strictEqual(scheduler.normalizeConcurrency(0), 1);
  assert.strictEqual(scheduler.normalizeConcurrency(10), 10);
  assert.strictEqual(scheduler.normalizeConcurrency(99), 10);
}

async function testConcurrencyAndOrder() {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const result = await scheduler.runAdjacentWaves({
    items: [1, 2, 3, 4, 5, 6],
    concurrency: 4,
    processItem: async item => {
      started.push(item);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return item * 10;
    },
  });
  assert.strictEqual(result.stopped, false);
  assert.strictEqual(maxActive, 4);
  assert.deepStrictEqual(started, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(result.results.map(entry => entry.value), [10, 20, 30, 40, 50, 60]);
}

async function testRateLimitStopsImmediately() {
  const started = [];
  const error429 = Object.assign(new Error('API 429: too many requests'), { status: 429 });
  const result = await scheduler.runAdjacentWaves({
    items: [1, 2, 3, 4, 5, 6],
    concurrency: 2,
    processItem: async item => {
      started.push(item);
      if (item === 2) throw error429;
      await new Promise(resolve => setTimeout(resolve, 5));
      return item;
    },
  });
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.stopReason, 'rate-limit');
  assert.deepStrictEqual(started, [1, 2]);
}

async function testConcurrencyLimitMessageIsRateLimit() {
  assert.strictEqual(
    scheduler.isRateLimitError(new Error('Concurrency limit exceeded for account, please retry later')),
    true
  );
}

async function testFinalReviewTemporarilyUsesOneConcurrency() {
  const changes = [];
  let concurrencyDuringReview = null;
  const value = await scheduler.runFinalReviewStage({
    configuredConcurrency: 4,
    setConcurrency: value => changes.push(value),
    review: async () => {
      concurrencyDuringReview = changes[changes.length - 1];
      return 'reviewed';
    },
  });
  assert.strictEqual(value, 'reviewed');
  assert.strictEqual(concurrencyDuringReview, 1);
  assert.deepStrictEqual(changes, [1, 4]);

  const failureChanges = [];
  await assert.rejects(
    scheduler.runFinalReviewStage({
      configuredConcurrency: 7,
      setConcurrency: value => failureChanges.push(value),
      review: async () => {
        throw new Error('review failed');
      },
    }),
    /review failed/
  );
  assert.deepStrictEqual(failureChanges, [1, 7]);
}

async function testThreeFailedWavesStop() {
  const result = await scheduler.runAdjacentWaves({
    items: [1, 2, 3, 4, 5],
    concurrency: 1,
    processItem: async item => {
      if (item <= 3) throw new Error(`failed ${item}`);
      return item;
    },
  });
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.stopReason, 'failure-limit');
  assert.strictEqual(result.failedWaves, 3);
  assert.deepStrictEqual(result.results.map(entry => entry.item), [1, 2, 3]);
}

async function testFailureCountContinuesAcrossDays() {
  const firstDay = await scheduler.runAdjacentWaves({
    items: [1, 2],
    concurrency: 1,
    processItem: async item => {
      if (item === 1) throw new Error('day one failure');
      return item;
    },
  });
  assert.strictEqual(firstDay.stopped, false);
  assert.strictEqual(firstDay.failedWaves, 1);

  const secondDay = await scheduler.runAdjacentWaves({
    items: [3, 4],
    concurrency: 1,
    initialFailedWaves: firstDay.failedWaves,
    processItem: async () => {
      throw new Error('day two failure');
    },
  });
  assert.strictEqual(secondDay.stopped, true);
  assert.strictEqual(secondDay.failedWaves, 3);
}

async function testRateLimitCancelsCurrentWave() {
  const started = [];
  const completed = [];
  const error429 = Object.assign(new Error('rate_limit_exceeded'), { status: 429 });
  const result = await scheduler.runAdjacentWaves({
    items: [1, 2, 3],
    concurrency: 3,
    processItem: async (item, context) => {
      started.push(item);
      if (item === 1) throw error429;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      completed.push(item);
      return item;
    },
  });
  assert.deepStrictEqual(started, [1, 2, 3]);
  assert.deepStrictEqual(completed, []);
  assert.strictEqual(result.stopReason, 'rate-limit');
}

async function testPauseKeepsCompletedItemsWithoutFailure() {
  const controller = new AbortController();
  const result = await scheduler.runAdjacentWaves({
    items: [1, 2, 3],
    concurrency: 2,
    signal: controller.signal,
    processItem: async (item, context) => {
      if (item === 1) return 'saved';
      setTimeout(() => controller.abort(new Error('user pause')), 5);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('paused');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      return item;
    },
  });
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.stopReason, 'aborted');
  assert.strictEqual(result.failedWaves, 0);
  assert.strictEqual(result.results.find(entry => entry.item === 1).value, 'saved');
  assert.ok(!result.results.some(entry => entry.item === 3));
}

async function testSourceRewrite() {
  const sameLine = scheduler.sourceRewrite('a\nb\nc', [2], 'b', 'B');
  assert.strictEqual(sameLine.text, 'a\nB\nc');
  assert.strictEqual(sameLine.newLineCount, 1);

  const extraLine = scheduler.sourceRewrite('a\nb\nc', [2], 'b', 'B1\nB2');
  assert.strictEqual(extraLine.text, 'a\nB1\nB2\nc');
  assert.strictEqual(extraLine.newLineCount, 2);

  assert.throws(
    () => scheduler.sourceRewrite('a\nchanged', [2], 'old', 'new'),
    error => error.code === 'STALE_SOURCE_REWRITE'
  );
  assert.throws(
    () => scheduler.sourceRewrite('a\nb\nc', [1, 3], 'a\nc', 'x'),
    /连续原文行/
  );
}

async function run() {
  await testAdjacentWaves();
  await testConcurrencyAndOrder();
  await testRateLimitStopsImmediately();
  await testConcurrencyLimitMessageIsRateLimit();
  await testFinalReviewTemporarilyUsesOneConcurrency();
  await testThreeFailedWavesStop();
  await testFailureCountContinuesAcrossDays();
  await testRateLimitCancelsCurrentWave();
  await testPauseKeepsCompletedItemsWithoutFailure();
  await testSourceRewrite();
  console.log('AI Step 2 scheduler tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
