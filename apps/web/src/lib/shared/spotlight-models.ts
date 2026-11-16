/** SB19: a model Spotlight may use, as the server lists it (Settings → AI → Spotlight and Spotlight's picker). */
export interface SpotlightModel {
  /** What a request sends: a bare Ollama name, or `litellm/…`, `anthropic/…`, `openai/…`. */
  id: string;
  label: string;
  source: 'ollama' | 'gateway' | 'anthropic' | 'openai';
  /** Runs on this machine (Ollama). */
  local: boolean;
}

export interface SpotlightModels {
  /** The default in force. */
  default: string;
  models: SpotlightModel[];
}
