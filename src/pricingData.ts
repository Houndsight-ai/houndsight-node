/**
 * GENERATED from the canonical shared pricing table
 * (houndsight-python: src/houndsight/pricing.json). Regenerate when prices
 * change. Snapshot: 2026-01. Unit: USD per 1,000,000 tokens.
 */

export interface PriceEntry {
  prompt_per_million: number;
  completion_per_million: number;
}

export type PricingTable = Record<string, Record<string, PriceEntry>>;

export const PRICING: PricingTable = {
  "openai": {
    "gpt-4o": {
      "prompt_per_million": 2.5,
      "completion_per_million": 10.0
    },
    "gpt-4o-mini": {
      "prompt_per_million": 0.15,
      "completion_per_million": 0.6
    },
    "gpt-4-turbo": {
      "prompt_per_million": 10.0,
      "completion_per_million": 30.0
    },
    "gpt-4": {
      "prompt_per_million": 30.0,
      "completion_per_million": 60.0
    },
    "gpt-3.5-turbo": {
      "prompt_per_million": 0.5,
      "completion_per_million": 1.5
    },
    "o1-preview": {
      "prompt_per_million": 15.0,
      "completion_per_million": 60.0
    },
    "o1-mini": {
      "prompt_per_million": 3.0,
      "completion_per_million": 12.0
    },
    "o1": {
      "prompt_per_million": 15.0,
      "completion_per_million": 60.0
    },
    "o3-mini": {
      "prompt_per_million": 1.1,
      "completion_per_million": 4.4
    },
    "text-embedding-3-small": {
      "prompt_per_million": 0.02,
      "completion_per_million": 0.0
    },
    "text-embedding-3-large": {
      "prompt_per_million": 0.13,
      "completion_per_million": 0.0
    },
    "text-embedding-ada-002": {
      "prompt_per_million": 0.1,
      "completion_per_million": 0.0
    }
  },
  "anthropic": {
    "claude-3-5-sonnet": {
      "prompt_per_million": 3.0,
      "completion_per_million": 15.0
    },
    "claude-3-5-haiku": {
      "prompt_per_million": 0.8,
      "completion_per_million": 4.0
    },
    "claude-3-opus": {
      "prompt_per_million": 15.0,
      "completion_per_million": 75.0
    },
    "claude-3-sonnet": {
      "prompt_per_million": 3.0,
      "completion_per_million": 15.0
    },
    "claude-3-haiku": {
      "prompt_per_million": 0.25,
      "completion_per_million": 1.25
    },
    "claude-sonnet-4": {
      "prompt_per_million": 3.0,
      "completion_per_million": 15.0
    },
    "claude-opus-4": {
      "prompt_per_million": 15.0,
      "completion_per_million": 75.0
    },
    "claude-haiku-4": {
      "prompt_per_million": 1.0,
      "completion_per_million": 5.0
    }
  },
  "gemini": {
    "gemini-1.5-pro": {
      "prompt_per_million": 1.25,
      "completion_per_million": 5.0
    },
    "gemini-1.5-flash": {
      "prompt_per_million": 0.075,
      "completion_per_million": 0.3
    },
    "gemini-1.5-flash-8b": {
      "prompt_per_million": 0.0375,
      "completion_per_million": 0.15
    },
    "gemini-2.0-flash": {
      "prompt_per_million": 0.1,
      "completion_per_million": 0.4
    },
    "gemini-2.0-flash-thinking": {
      "prompt_per_million": 0.1,
      "completion_per_million": 0.4
    }
  }
};
