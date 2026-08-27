export type OpenAiModelRates = {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  usdPerMinute: number | null;
};

export type TranscribeUsage = {
  inputTokens: number;
  outputTokens: number;
  durationSeconds: number;
};

export type SttCost =
  | {
      usd: number;
      basis: 'tokens' | 'duration';
      rates: OpenAiModelRates;
      usage: TranscribeUsage;
    }
  | { usd: null; reason: string };

const MODEL_DOCS_URL = 'https://developers.openai.com/api/docs/models';
const ratesCache = new Map<string, OpenAiModelRates>();

export function docsSlugForModel(model: string): string {
  return model.trim().replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export function parseOpenAiModelDocsMarkdown(markdown: string): OpenAiModelRates {
  return {
    inputUsdPerMillionTokens: matchUsd(
      markdown,
      /\|\s*Input\s*\|\s*\$([0-9]+(?:\.[0-9]+)?)\s*\|\s*1M tokens/i,
    ),
    outputUsdPerMillionTokens: matchUsd(
      markdown,
      /\|\s*Output\s*\|\s*\$([0-9]+(?:\.[0-9]+)?)\s*\|\s*1M tokens/i,
    ),
    usdPerMinute: matchUsd(
      markdown,
      /\|\s*Price\s*\|\s*\$([0-9]+(?:\.[0-9]+)?)\s*\|\s*minutes?/i,
    ),
  };
}

export function usageFromTranscription(
  result: unknown,
  wavDurationSeconds: number,
): TranscribeUsage {
  const usage =
    result && typeof result === 'object' && 'usage' in result
      ? (result as { usage?: unknown }).usage
      : undefined;
  const record = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  return {
    inputTokens: asNonNegNumber(record.input_tokens),
    outputTokens: asNonNegNumber(record.output_tokens),
    durationSeconds:
      asNonNegNumber(record.seconds) || Math.max(0, wavDurationSeconds),
  };
}

export function addUsage(left: TranscribeUsage, right: TranscribeUsage): TranscribeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    durationSeconds: left.durationSeconds + right.durationSeconds,
  };
}

export function costFromUsageAndRates(
  usage: TranscribeUsage,
  rates: OpenAiModelRates,
): SttCost {
  const hasTokenRates =
    rates.inputUsdPerMillionTokens != null || rates.outputUsdPerMillionTokens != null;
  const hasTokenUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (hasTokenRates && hasTokenUsage) {
    const usd =
      (usage.inputTokens / 1_000_000) * (rates.inputUsdPerMillionTokens ?? 0) +
      (usage.outputTokens / 1_000_000) * (rates.outputUsdPerMillionTokens ?? 0);
    return { usd, basis: 'tokens', rates, usage };
  }
  if (rates.usdPerMinute != null && usage.durationSeconds > 0) {
    return {
      usd: (usage.durationSeconds / 60) * rates.usdPerMinute,
      basis: 'duration',
      rates,
      usage,
    };
  }
  if (!hasTokenRates && rates.usdPerMinute == null) {
    return { usd: null, reason: 'OpenAI model docs had no parseable price' };
  }
  return {
    usd: null,
    reason: 'transcription response had no usage to price',
  };
}

export async function loadOpenAiModelRates(
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAiModelRates> {
  const slug = docsSlugForModel(model);
  const cached = ratesCache.get(slug);
  if (cached) {
    return cached;
  }
  const url = `${MODEL_DOCS_URL}/${encodeURIComponent(slug)}.md`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/markdown, text/plain;q=0.9',
      'User-Agent': 'Pith (STT cost from OpenAI model docs)',
    },
  });
  if (!response.ok) {
    throw new Error(`openai_model_docs_${response.status}`);
  }
  const rates = parseOpenAiModelDocsMarkdown(await response.text());
  ratesCache.set(slug, rates);
  return rates;
}

export function resetOpenAiModelRatesCache(): void {
  ratesCache.clear();
}

export function formatTranscribeCostLine(args: {
  model: string;
  cost: SttCost;
}): string {
  if (args.cost.usd == null) {
    return `STT cost: unavailable (${args.cost.reason}, model=${args.model})`;
  }
  const { usage, rates, basis, usd } = args.cost;
  if (basis === 'tokens') {
    return `STT cost: $${usd.toFixed(4)} USD (${usage.inputTokens} in + ${usage.outputTokens} out tokens @ $${rates.inputUsdPerMillionTokens ?? 0}/$${rates.outputUsdPerMillionTokens ?? 0} per 1M from OpenAI docs, model=${args.model})`;
  }
  const minutes = usage.durationSeconds / 60;
  return `STT cost: $${usd.toFixed(4)} USD (${minutes.toFixed(2)} min @ $${rates.usdPerMinute}/min from OpenAI docs, model=${args.model})`;
}

function matchUsd(markdown: string, pattern: RegExp): number | null {
  const match = markdown.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function asNonNegNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
