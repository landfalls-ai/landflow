/**
 * Speech to text for Spotlight's microphone: the recording goes to an OpenAI-compatible `/audio/transcriptions`
 * endpoint (a local whisper.cpp or faster-whisper server, or any hosted one the operator points it at). Server-side
 * settings only: LANDFLOW_STT_URL, LANDFLOW_STT_MODEL, LANDFLOW_STT_API_KEY.
 */
import { HttpError } from '../errors';
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export class TranscribeError extends HttpError {
  constructor(
    message: string,
    status = 502,
  ) {
    super(message, status, { expose: true });
  }
}

const settings = () => ({
  baseUrl: (process.env.LANDFLOW_STT_URL ?? 'http://127.0.0.1:8000/v1').replace(/\/+$/, ''),
  model: process.env.LANDFLOW_STT_MODEL ?? 'whisper-1',
  apiKey: process.env.LANDFLOW_STT_API_KEY ?? '',
});

const extension = (mime: string) => {
  const sub = mime.split('/')[1]?.split(';')[0]?.trim() ?? '';
  return /^[a-z0-9]{2,5}$/i.test(sub) ? sub : 'webm';
};

export async function transcribe(audio: Blob, opts: { language?: string; signal?: AbortSignal } = {}): Promise<string> {
  const { baseUrl, model, apiKey } = settings();
  const form = new FormData();
  form.append('file', audio, `speech.${extension(audio.type)}`);
  form.append('model', model);
  form.append('response_format', 'json');
  if (opts.language) form.append('language', opts.language);
  const url = `${baseUrl}/audio/transcriptions`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', body: form, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, ...(opts.signal && { signal: opts.signal }) });
  } catch (caught) {
    throw new TranscribeError(`Can’t reach the speech-to-text server at ${url}. Set LANDFLOW_STT_URL to an OpenAI-compatible transcription API. ${(caught as Error).message}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new TranscribeError(`Transcription failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = (await response.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== 'string') throw new TranscribeError('The speech-to-text server returned no text');
  return body.text.trim();
}
