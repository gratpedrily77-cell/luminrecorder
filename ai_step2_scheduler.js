(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIStep2Scheduler = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX_CONCURRENCY = 10;
  const DEFAULT_FAILURE_LIMIT = 3;

  function normalizeConcurrency(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(MAX_CONCURRENCY, Math.max(1, parsed));
  }

  function buildAdjacentWaves(items, concurrency) {
    const size = normalizeConcurrency(concurrency);
    const source = Array.isArray(items) ? items : [];
    const waves = [];
    for (let index = 0; index < source.length; index += size) {
      waves.push(source.slice(index, index + size));
    }
    return waves;
  }

  function isRateLimitError(error) {
    if (error?.name === 'AbortError') return false;
    return Number(error?.status) === 429 ||
      /(?:^|\D)429(?:\D|$)|rate[\s_-]*limit|too many requests|请求过多|concurrency limit exceeded|concurrent request limit|too many concurrent requests/i.test(error?.message || '');
  }

  async function runFinalReviewStage(options = {}) {
    const {
      configuredConcurrency = 1,
      setConcurrency,
      review,
    } = options;
    if (typeof setConcurrency !== 'function') throw new Error('setConcurrency 必须是函数');
    if (typeof review !== 'function') throw new Error('review 必须是函数');

    const restoreConcurrency = normalizeConcurrency(configuredConcurrency);
    setConcurrency(1);
    try {
      return await review();
    } finally {
      setConcurrency(restoreConcurrency);
    }
  }

  function errorMessage(error) {
    return error?.message || String(error || '未知错误');
  }

  async function runAdjacentWaves(options) {
    const {
      items = [],
      concurrency = 1,
      processItem,
      initialFailedWaves = 0,
      failureLimit = DEFAULT_FAILURE_LIMIT,
      signal = null,
      onWaveComplete = null,
    } = options || {};
    if (typeof processItem !== 'function') throw new Error('processItem 必须是函数');

    const waves = buildAdjacentWaves(items, concurrency);
    let failedWaves = Math.max(0, Number(initialFailedWaves) || 0);
    const results = [];

    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      if (signal?.aborted) {
        return { stopped: true, stopReason: 'aborted', failedWaves, results, nextWaveIndex: waveIndex };
      }

      const wave = waves[waveIndex];
      const waveController = new AbortController();
      let fatalError = null;
      const abortFromParent = () => waveController.abort(signal?.reason);
      if (signal) signal.addEventListener('abort', abortFromParent, { once: true });

      const settled = await Promise.all(wave.map(async item => {
        try {
          const value = await processItem(item, {
            signal: waveController.signal,
            waveIndex,
            wave,
          });
          return { item, status: 'fulfilled', value };
        } catch (error) {
          if (isRateLimitError(error) && !fatalError) {
            fatalError = error;
            waveController.abort(error);
          }
          return { item, status: 'rejected', error };
        }
      }));
      if (signal) signal.removeEventListener('abort', abortFromParent);
      results.push(...settled);

      const nonAbortFailures = settled.filter(entry =>
        entry.status === 'rejected' &&
        entry.error?.name !== 'AbortError' &&
        !isRateLimitError(entry.error)
      );
      const waveFailed = Boolean(fatalError || nonAbortFailures.length);
      if (waveFailed && !fatalError) failedWaves += 1;

      const summary = {
        wave,
        waveIndex,
        settled,
        failedWaves,
        waveFailed,
        fatalError,
      };
      if (typeof onWaveComplete === 'function') await onWaveComplete(summary);

      if (fatalError) {
        return {
          stopped: true,
          stopReason: 'rate-limit',
          stopError: fatalError,
          failedWaves,
          results,
          nextWaveIndex: waveIndex + 1,
        };
      }
      if (waveFailed && failedWaves >= failureLimit) {
        return {
          stopped: true,
          stopReason: 'failure-limit',
          stopError: nonAbortFailures[0]?.error || new Error('解析失败波次达到上限'),
          failedWaves,
          results,
          nextWaveIndex: waveIndex + 1,
        };
      }
    }

    return {
      stopped: false,
      stopReason: '',
      stopError: null,
      failedWaves,
      results,
      nextWaveIndex: waves.length,
    };
  }

  function sourceRewrite(text, sourceLines, expectedSource, replacementSource) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const targets = [...new Set((sourceLines || []).map(Number))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!targets.length) throw new Error('AI 原文修改没有指定 sourceLines');
    if (targets.some((line, index) => index > 0 && line !== targets[index - 1] + 1)) {
      throw new Error('AI 原文修改只能针对连续原文行');
    }
    if (targets[0] < 1 || targets[targets.length - 1] > lines.length) {
      throw new Error('AI 原文修改的 sourceLines 超出本日原文范围');
    }

    const startIndex = targets[0] - 1;
    const endIndex = targets[targets.length - 1] - 1;
    const currentSource = lines.slice(startIndex, endIndex + 1).join('\n');
    if (currentSource !== String(expectedSource ?? '')) {
      const error = new Error('原文已经变化，AI 建议已过期，未执行替换');
      error.code = 'STALE_SOURCE_REWRITE';
      error.currentSource = currentSource;
      throw error;
    }

    const replacementText = String(replacementSource ?? '').replace(/\r\n?/g, '\n');
    const replacementLines = replacementText === '' ? [] : replacementText.split('\n');
    lines.splice(startIndex, targets.length, ...replacementLines);
    return {
      text: lines.join('\n'),
      startLine: targets[0],
      oldLineCount: targets.length,
      newLineCount: replacementLines.length,
      replacementLines,
      currentSource,
    };
  }

  return {
    MAX_CONCURRENCY,
    DEFAULT_FAILURE_LIMIT,
    normalizeConcurrency,
    buildAdjacentWaves,
    isRateLimitError,
    runAdjacentWaves,
    runFinalReviewStage,
    sourceRewrite,
    errorMessage,
  };
});
