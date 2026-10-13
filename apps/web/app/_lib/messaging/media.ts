import { type FileKind, MEDIA_RULES, type UploadKind } from '@bedo/contracts';

/**
 * Phase 4 in the browser: everything about a file that is worked out on the device before it is sent (D-36: there
 * is no server-side conversion). Photos are resized (longest side 2560 px) and get a small preview; videos and
 * video messages get a poster frame; durations come from the media element; voice messages get a waveform while
 * they are recorded.
 */
export interface PreparedFile {
  kind: UploadKind;
  body: Blob;
  mimeType: string;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
  thumbnail?: Blob;
  /** A local address to show the file while it uploads (revoked once sent). */
  previewUrl: string | null;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/webm', 'audio/aac']);

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the picture'))), type, quality));
}

function fit(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function drawScaled(source: CanvasImageSource, width: number, height: number, max: number, type: string, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const size = fit(width, height, max);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  if (type === 'image/jpeg') {
    // JPEG has no transparency: transparent parts of a PNG become white, not black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
  }
  context.drawImage(source, 0, 0, size.width, size.height);
  return { blob: await canvasBlob(canvas, type, quality), ...size };
}

/** A small preview that fits the API's limit (shrinks the quality until it does). */
async function thumbnailOf(source: CanvasImageSource, width: number, height: number): Promise<Blob | undefined> {
  for (const quality of [0.75, 0.55, 0.35]) {
    const { blob } = await drawScaled(source, width, height, MEDIA_RULES.thumbnailMaxSide, 'image/jpeg', quality);
    if (blob.size <= MEDIA_RULES.thumbnailMaxBytes) return blob;
  }
  return undefined;
}

function mediaElement(url: string, tag: 'video' | 'audio'): Promise<HTMLVideoElement | HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    element.preload = 'metadata';
    element.muted = true;
    element.onloadedmetadata = () => resolve(element);
    element.onerror = () => reject(new Error('This file cannot be played'));
    element.src = url;
  });
}

async function videoFrame(video: HTMLVideoElement): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    video.onseeked = done;
    video.onloadeddata = done;
    video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    setTimeout(done, 3000);
  });
}

const durationMs = (element: HTMLMediaElement) => (Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : undefined);

/** Works out how to send a file the person picked: as a photo, video, audio or plain file. */
export async function prepareFile(file: File, asFile = false): Promise<PreparedFile> {
  const type = file.type.toLowerCase();
  const name = file.name.slice(0, MEDIA_RULES.fileNameMaxLength) || 'file';
  if (!asFile && IMAGE_TYPES.has(type) && file.size <= MEDIA_RULES.maxBytes.photo * 2) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap) {
      try {
        const thumbnail = await thumbnailOf(bitmap, bitmap.width, bitmap.height);
        // Animated GIFs are sent as they are; other pictures are resized like Telegram's "photo".
        if (type === 'image/gif') {
          return { kind: 'photo', body: file, mimeType: type, fileName: name, width: bitmap.width, height: bitmap.height, ...(thumbnail ? { thumbnail } : {}), previewUrl: URL.createObjectURL(file) };
        }
        const resized = await drawScaled(bitmap, bitmap.width, bitmap.height, MEDIA_RULES.photoMaxSide, 'image/jpeg', 0.85);
        return {
          kind: 'photo',
          body: resized.blob,
          mimeType: 'image/jpeg',
          fileName: name.replace(/\.[^.]+$/, '.jpg'),
          width: resized.width,
          height: resized.height,
          ...(thumbnail ? { thumbnail } : {}),
          previewUrl: URL.createObjectURL(resized.blob),
        };
      } finally {
        bitmap.close();
      }
    }
  }
  if (!asFile && VIDEO_TYPES.has(type) && file.size <= MEDIA_RULES.maxBytes.video) {
    const url = URL.createObjectURL(file);
    try {
      const video = (await mediaElement(url, 'video')) as HTMLVideoElement;
      await videoFrame(video);
      const thumbnail = video.videoWidth > 0 ? await thumbnailOf(video, video.videoWidth, video.videoHeight).catch(() => undefined) : undefined;
      const duration = durationMs(video);
      return {
        kind: 'video',
        body: file,
        mimeType: type,
        fileName: name,
        ...(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        previewUrl: thumbnail ? URL.createObjectURL(thumbnail) : null,
      };
    } catch {
      // Not playable here: sent as a file.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!asFile && AUDIO_TYPES.has(type) && file.size <= MEDIA_RULES.maxBytes.audio) {
    const url = URL.createObjectURL(file);
    try {
      const audio = await mediaElement(url, 'audio');
      const duration = durationMs(audio);
      return { kind: 'audio', body: file, mimeType: type === 'audio/x-m4a' ? 'audio/mp4' : type === 'audio/x-wav' ? 'audio/wav' : type, fileName: name, ...(duration !== undefined ? { durationMs: duration } : {}), previewUrl: null };
    } catch {
      // Sent as a file.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { kind: 'file', body: file, mimeType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream', fileName: name, previewUrl: null };
}

/** Uploads to a signed URL with progress (fetch cannot report upload progress). */
export function uploadWithProgress(url: string, headers: Record<string, string>, body: Blob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Upload failed (${request.status})`)));
    request.onerror = () => reject(new Error('Upload failed'));
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort());
    request.send(body);
  });
}

/** The recording type this browser supports (Opus in WebM or Ogg; Safari records MP4). */
function recordingType(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported in this browser');
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  waveform: number[];
}

/**
 * A voice message (Opus) or a video message being recorded. Voice recording samples the level 20 times a second for
 * the waveform; both stop at their limit (15 minutes, 60 seconds).
 */
export class Recorder {
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly levels: number[] = [];
  private readonly startedAt = Date.now();
  private sampler: ReturnType<typeof setInterval> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private context: AudioContext | null = null;
  private stopped: Promise<Recording> | null = null;
  onLevel: ((level: number) => void) | null = null;
  onLimit: (() => void) | null = null;

  private constructor(
    readonly stream: MediaStream,
    readonly kind: 'voice' | 'video_note',
  ) {
    const mimeType =
      kind === 'voice'
        ? recordingType(['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'])
        : recordingType(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    this.recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), ...(kind === 'voice' ? { audioBitsPerSecond: 32_000 } : { videoBitsPerSecond: 1_000_000 }) });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    if (kind === 'voice') {
      try {
        this.context = new AudioContext();
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        this.context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        this.sampler = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
          const level = Math.min(100, Math.round((peak / 128) * 160));
          this.levels.push(level);
          this.onLevel?.(level);
        }, 50);
      } catch {
        // No waveform; the message is still recorded.
      }
    }
    this.recorder.start(1000);
    this.limitTimer = setTimeout(() => this.onLimit?.(), kind === 'voice' ? MEDIA_RULES.voiceMaxDurationMs : MEDIA_RULES.videoNoteMaxDurationMs);
  }

  static async start(kind: 'voice' | 'video_note'): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'voice' ? { audio: { echoCancellation: true, noiseSuppression: true } } : { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } },
    );
    return new Recorder(stream, kind);
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private release(): void {
    if (this.sampler) clearInterval(this.sampler);
    if (this.limitTimer) clearTimeout(this.limitTimer);
    void this.context?.close().catch(() => undefined);
    for (const track of this.stream.getTracks()) track.stop();
  }

  /** Stops and returns the recording. */
  stop(): Promise<Recording> {
    this.stopped ??= new Promise<Recording>((resolve, reject) => {
      const limit = this.kind === 'voice' ? MEDIA_RULES.voiceMaxDurationMs : MEDIA_RULES.videoNoteMaxDurationMs;
      this.recorder.onstop = () => {
        this.release();
        const mimeType = (this.recorder.mimeType || this.chunks[0]?.type || '').split(';')[0]!.trim() || (this.kind === 'voice' ? 'audio/webm' : 'video/webm');
        const blob = new Blob(this.chunks, { type: mimeType });
        if (blob.size === 0) {
          reject(new Error('Nothing was recorded'));
          return;
        }
        resolve({ blob, mimeType, durationMs: Math.min(limit, this.elapsedMs), waveform: compressWaveform(this.levels, MEDIA_RULES.waveformMaxBars) });
      };
      if (this.recorder.state === 'inactive') this.recorder.onstop(new Event('stop'));
      else this.recorder.stop();
    });
    return this.stopped;
  }

  /** Stops and throws the recording away. */
  cancel(): void {
    this.recorder.onstop = () => this.release();
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    else this.release();
  }
}

/** Reduces level samples to at most `bars` bars (each the loudest sample in its stretch). */
export function compressWaveform(levels: readonly number[], bars: number): number[] {
  if (levels.length === 0) return [0];
  if (levels.length <= bars) return levels.map((level) => Math.max(0, Math.min(100, Math.round(level))));
  const result: number[] = [];
  for (let index = 0; index < bars; index += 1) {
    const start = Math.floor((index * levels.length) / bars);
    const end = Math.max(start + 1, Math.floor(((index + 1) * levels.length) / bars));
    result.push(Math.max(0, Math.min(100, Math.round(Math.max(...levels.slice(start, end))))));
  }
  return result;
}

/** A recording, ready to send as a voice or video message. */
export async function prepareRecording(kind: 'voice' | 'video_note', recording: Recording): Promise<PreparedFile> {
  const base = recording.mimeType.split(';')[0]!;
  const mimeType = kind === 'voice' ? base.replace(/^video\//, 'audio/') : base.replace(/^audio\//, 'video/');
  if (kind === 'voice') {
    return { kind, body: recording.blob, mimeType, durationMs: recording.durationMs, waveform: recording.waveform, previewUrl: null };
  }
  const url = URL.createObjectURL(recording.blob);
  try {
    const video = (await mediaElement(url, 'video')) as HTMLVideoElement;
    await videoFrame(video);
    const thumbnail = video.videoWidth > 0 ? await thumbnailOf(video, video.videoWidth, video.videoHeight).catch(() => undefined) : undefined;
    return {
      kind,
      body: recording.blob,
      mimeType,
      durationMs: recording.durationMs,
      ...(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      previewUrl: thumbnail ? URL.createObjectURL(thumbnail) : null,
    };
  } catch {
    return { kind, body: recording.blob, mimeType, durationMs: recording.durationMs, previewUrl: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "1.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1:05" */
export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** How a message's media is named in previews ("Photo", "Voice message", ...). */
export const MEDIA_LABEL: Record<FileKind | 'sticker' | 'poll', string> = {
  poll: 'Poll',
  photo: 'Photo',
  video: 'Video',
  audio: 'Audio',
  voice: 'Voice message',
  video_note: 'Video message',
  file: 'File',
  gif: 'GIF',
  sticker: 'Sticker',
};
