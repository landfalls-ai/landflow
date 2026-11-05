'use client';

/**
 * Push-to-talk for Spotlight: record with MediaRecorder, post the clip to /api/assistant/transcribe, hand the text
 * back. The text lands in the input box to edit; nothing is sent to the assistant by voice alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const MAX_SECONDS = 120;
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export const dictationSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const callback = useRef(onText);
  callback.current = onText;

  const release = () => {
    clearInterval(timer.current);
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
    recorder.current = null;
  };

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    setError('');
    if (!dictationSupported()) return setError('This browser can’t record audio');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError('Allow the microphone to dictate');
    }
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    cancelled.current = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      const type = rec.mimeType || mimeType || 'audio/webm';
      release();
      if (cancelled.current || !chunks.length) return setState('idle');
      setState('transcribing');
      try {
        const res = await fetch('/api/assistant/transcribe', { method: 'POST', headers: { 'content-type': type.split(';')[0]! }, body: new Blob(chunks, { type }) });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? `Transcription failed (${res.status})`);
        if (body.text) callback.current(body.text);
        else setError('Didn’t catch anything');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setState('idle');
      }
    };
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setState('recording');
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }, [stop]);

  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      release();
    },
    [],
  );

  return { state, error, seconds, start, stop, cancel, clearError: () => setError('') };
}
