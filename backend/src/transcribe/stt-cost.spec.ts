import {
  addUsage,
  costFromUsageAndRates,
  docsSlugForModel,
  formatTranscribeCostLine,
  loadOpenAiModelRates,
  parseOpenAiModelDocsMarkdown,
  resetOpenAiModelRatesCache,
  usageFromTranscription,
} from './stt-cost';

const MINI_DOCS = `
### Audio tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1.25 | 1M tokens |
| Output | $5 | 1M tokens |
`;

const DURATION_DOCS = `
### Transcription audio duration

| Metric | Price | Unit |
| --- | ---: | --- |
| Price | $0.0045 | minute |
`;

describe('stt-cost', () => {
  afterEach(() => {
    resetOpenAiModelRatesCache();
  });

  it('parses token rates from OpenAI model docs markdown', () => {
    expect(parseOpenAiModelDocsMarkdown(MINI_DOCS)).toEqual({
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 5,
      usdPerMinute: null,
    });
  });

  it('parses per-minute rates from OpenAI model docs markdown', () => {
    expect(parseOpenAiModelDocsMarkdown(DURATION_DOCS)).toEqual({
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      usdPerMinute: 0.0045,
    });
  });

  it('strips dated snapshots so docs URLs use the model alias', () => {
    expect(docsSlugForModel('gpt-4o-mini-transcribe-2025-12-15')).toBe(
      'gpt-4o-mini-transcribe',
    );
  });

  it('reads token usage from a transcription response', () => {
    expect(
      usageFromTranscription(
        {
          text: 'hi',
          usage: {
            type: 'tokens',
            input_tokens: 1081,
            output_tokens: 286,
          },
        },
        12,
      ),
    ).toEqual({
      inputTokens: 1081,
      outputTokens: 286,
      durationSeconds: 12,
    });
  });

  it('prices token usage with fetched rates', () => {
    const cost = costFromUsageAndRates(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, durationSeconds: 60 },
      parseOpenAiModelDocsMarkdown(MINI_DOCS),
    );
    expect(cost.usd).toBeCloseTo(6.25);
    if (cost.usd != null) {
      expect(cost.basis).toBe('tokens');
    }
  });

  it('prices duration usage when the model docs are per minute', () => {
    const cost = costFromUsageAndRates(
      { inputTokens: 0, outputTokens: 0, durationSeconds: 120 },
      parseOpenAiModelDocsMarkdown(DURATION_DOCS),
    );
    expect(cost.usd).toBeCloseTo(0.009);
  });

  it('sums usage across WAV parts', () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 2, durationSeconds: 1 },
        { inputTokens: 5, outputTokens: 1, durationSeconds: 3 },
      ),
    ).toEqual({ inputTokens: 15, outputTokens: 3, durationSeconds: 4 });
  });

  it('loads rates through fetch and caches the OpenAI docs page', async () => {
    const fetchImpl = jest.fn(async () => {
      return {
        ok: true,
        text: async () => MINI_DOCS,
      } as Response;
    });
    const first = await loadOpenAiModelRates('gpt-4o-mini-transcribe', fetchImpl);
    const second = await loadOpenAiModelRates('gpt-4o-mini-transcribe', fetchImpl);
    expect(first.inputUsdPerMillionTokens).toBe(1.25);
    expect(second.outputUsdPerMillionTokens).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/docs/models/gpt-4o-mini-transcribe.md'),
      expect.any(Object),
    );
  });

  it('formats a terminal line from computed USD', () => {
    const cost = costFromUsageAndRates(
      { inputTokens: 1_000_000, outputTokens: 0, durationSeconds: 0 },
      parseOpenAiModelDocsMarkdown(MINI_DOCS),
    );
    const line = formatTranscribeCostLine({
      model: 'gpt-4o-mini-transcribe',
      cost,
    });
    expect(line).toContain('$1.2500 USD');
    expect(line).toContain('from OpenAI docs');
  });
});
