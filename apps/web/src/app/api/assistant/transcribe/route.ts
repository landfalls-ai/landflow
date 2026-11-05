/**
 * Spotlight's microphone: the body is one recording (`audio/*`, at most 10 MB), the reply `{ text }`. The text goes
 * into the input box for the person to edit; it is not sent to the assistant from here.
 */
import { error, handler, json } from '@/lib/server/http';
import { MAX_AUDIO_BYTES, transcribe, TranscribeError } from '@/lib/server/assistant/transcribe';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('audio/') && !type.startsWith('video/webm')) return error('Send the recording with an audio content type', 415);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_AUDIO_BYTES) return error('The recording is too long (10 MB at most)', 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return error('The recording is empty');
  if (bytes.byteLength > MAX_AUDIO_BYTES) return error('The recording is too long (10 MB at most)', 413);
  const language = new URL(request.url).searchParams.get('language') ?? undefined;
  try {
    const text = await transcribe(new Blob([bytes], { type }), { ...(language && /^[a-z]{2,3}$/i.test(language) && { language }), signal: request.signal });
    return json({ text });
  } catch (caught) {
    if (caught instanceof TranscribeError) return error(caught.message, caught.status);
    throw caught;
  }
});
