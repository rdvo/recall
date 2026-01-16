import type { LLMConfig } from '../types.js';
import { config as cfg } from '../config.js';

/**
 * Extract JSON from potentially fenced or noisy text output
 * Handles markdown code fences, extra text, etc.
 */
function extractJSON<T>(text: string): T {
  // Try to find JSON in markdown code fences
  const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]) as T;
    } catch {
      // Fall through to other methods
    }
  }

  // Try to find JSON object/array directly (first complete JSON structure)
  const directMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (directMatch) {
    try {
      return JSON.parse(directMatch[1]) as T;
    } catch {
      // Fall through
    }
  }

  // Last resort: try parsing the whole text
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    // Try to find and parse just the JSON object/array if there's trailing text
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as T;
      } catch {
        // Fall through to error
      }
    }
    throw new Error(`Failed to extract JSON from LLM response. Text preview: ${text.slice(0, 500)}`);
  }
}

export interface LLMProvider {
  complete(prompt: string, systemPrompt?: string): Promise<string>;
  completeStructured<T = any>(prompt: string, schema: any, systemPrompt?: string): Promise<T>;
}

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey || env('LLM_API_KEY') || '';
    this.model = config.model || 'gpt-4o-mini';
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json() as any;
    return data.choices[0].message.content.trim();
  }

  async completeStructured<T = any>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    // OpenAI doesn't support structured outputs the same way, fallback to regular
    const text = await this.complete(prompt, systemPrompt);
    return extractJSON<T>(text);
  }
}

export class GroqProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey || env('LLM_API_KEY') || '';
    this.model = config.model || 'llama-3.1-8b-instant';
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${error}`);
    }

    const data = await response.json() as any;
    return data.choices[0].message.content.trim();
  }

  async completeStructured<T = any>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    const text = await this.complete(prompt, systemPrompt);
    return extractJSON<T>(text);
  }
}

export class OllamaProvider implements LLMProvider {
  private baseURL: string;
  private model: string;

  constructor(config: LLMConfig) {
    this.baseURL = config.baseURL || env('OLLAMA_BASE_URL') || 'http://localhost:11434';
    this.model = config.model || 'llama3.2';
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        stream: false,
        options: {
          temperature: 0
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = await response.json() as any;
    return data.response.trim();
  }

  async completeStructured<T = any>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    const text = await this.complete(prompt, systemPrompt);
    return extractJSON<T>(text);
  }
}

export class CerebrasProvider implements LLMProvider {
  private client: any;
  private model: string;
  private apiKey: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey || cfg.cerebrasApiKey() || env('LLM_API_KEY') || '';
    this.model = config.model || 'zai-glm-4.6';
    // Client will be initialized lazily on first use
  }

  private async getClient() {
    if (!this.client) {
      const CerebrasModule = await import('@cerebras/cerebras_cloud_sdk');
      const Cerebras = CerebrasModule.default || CerebrasModule;
      this.client = new Cerebras({
        apiKey: this.apiKey
      });
    }
    return this.client;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const client = await this.getClient();
    const completion = await client.chat.completions.create({
      model: this.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0,
      top_p: 1
    });

    return (completion.choices[0].message.content || '').trim();
  }

  async completeStructured<T = any>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    const client = await this.getClient();
    
    const completion = await client.chat.completions.create({
      model: this.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0,
      top_p: 1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response_schema',
          strict: true,
          schema: schema
        }
      }
    });

    const content = completion.choices[0].message.content;
    // Cerebras has structured outputs, but still use extractJSON for robustness
    return extractJSON<T>(content);
  }
}

export function createLLMProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'groq':
      return new GroqProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'cerebras':
      return new CerebrasProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

function env(name: string): string | undefined {
  return process.env[name];
}

