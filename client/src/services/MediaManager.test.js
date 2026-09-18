import { describe, expect, it, vi } from 'vitest';
import { TRACK_STATUS } from '../utils/mediaErrors.js';
import { MediaManager, VIDEO_CONSTRAINTS } from './MediaManager.js';

/** Дорожка с тем минимумом, который использует `MediaManager`. */
function fakeTrack(kind) {
  return { kind, enabled: true, readyState: 'live', onended: null, stop: vi.fn() };
}

function fakeStream(tracks) {
  return { getTracks: () => tracks };
}

/** Ошибка `getUserMedia` приходит как `DOMException` — важно только имя (TDD §4.1.4). */
function mediaError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * Мок `navigator.mediaDevices`. `getUserMedia` отвечает по видам, которые у него просят:
 * `responses` задаёт результат для каждого вида — дорожку или ошибку.
 * @param {{ devices?: string[], responses?: Record<string, unknown> }} [options]
 */
function createMediaDevices({ devices = ['audioinput', 'videoinput'], responses = {} } = {}) {
  const getUserMedia = vi.fn(async (constraints) => {
    const kinds = Object.keys(constraints);
    const tracks = [];
    for (const kind of kinds) {
      const response = responses[kind] ?? fakeTrack(kind);
      // Один запрос на оба вида отклоняется целиком, если хоть одно устройство недоступно.
      if (response instanceof Error) throw response;
      tracks.push(response);
    }
    return fakeStream(tracks);
  });

  return {
    enumerateDevices: vi.fn(async () => devices.map((kind) => ({ kind }))),
    getUserMedia,
  };
}

describe('MediaManager.acquire: первичный захват (TDD §4.1.4)', () => {
  it('камера и микрофон доступны: один запрос на оба вида', async () => {
    const mediaDevices = createMediaDevices();
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: VIDEO_CONSTRAINTS,
    });
    expect(result.audio.status).toBe(TRACK_STATUS.OK);
    expect(result.video.status).toBe(TRACK_STATUS.OK);
    expect(manager.getTrack('audio')).toBe(result.audio.track);
    expect(manager.getTrack('video')).toBe(result.video.track);
    expect(manager.getStatus('video')).toBe(TRACK_STATUS.OK);
  });

  it('камеры нет в системе: она не запрашивается и считается NOT_FOUND (FR-14)', async () => {
    const mediaDevices = createMediaDevices({ devices: ['audioinput'] });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.audio.status).toBe(TRACK_STATUS.OK);
    expect(result.video).toEqual({ status: TRACK_STATUS.NOT_FOUND, track: null });
    expect(manager.getTrack('video')).toBeNull();
  });

  it('отказ в доступе: оба вида DENIED, пользователь остаётся в комнате (FR-33, US-12)', async () => {
    const denied = mediaError('NotAllowedError');
    const mediaDevices = createMediaDevices({
      responses: { audio: denied, video: denied },
    });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    // Общий запрос, затем по одному на каждый вид.
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(result.audio.status).toBe(TRACK_STATUS.DENIED);
    expect(result.video.status).toBe(TRACK_STATUS.DENIED);
  });

  it('камера занята, микрофон свободен: частичный успех (FR-14, TDD §4.1.4, шаг 3)', async () => {
    const mediaDevices = createMediaDevices({
      responses: { video: mediaError('NotReadableError') },
    });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia.mock.calls.map(([constraints]) => constraints)).toEqual([
      { audio: true, video: VIDEO_CONSTRAINTS },
      { audio: true },
      { video: VIDEO_CONSTRAINTS },
    ]);
    expect(result.audio.status).toBe(TRACK_STATUS.OK);
    expect(result.audio.track.kind).toBe('audio');
    expect(result.video).toEqual({ status: TRACK_STATUS.BUSY, track: null });
  });

  it('устройств нет совсем: getUserMedia не вызывается (TDD §4.1.4, шаг 2)', async () => {
    const mediaDevices = createMediaDevices({ devices: [] });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(result.audio.status).toBe(TRACK_STATUS.NOT_FOUND);
    expect(result.video.status).toBe(TRACK_STATUS.NOT_FOUND);
  });

  it('единственное устройство недоступно: повторных запросов нет', async () => {
    const mediaDevices = createMediaDevices({
      devices: ['videoinput'],
      responses: { video: mediaError('NotFoundError') },
    });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.video.status).toBe(TRACK_STATUS.NOT_FOUND);
  });

  it('неизвестная ошибка даёт ERROR', async () => {
    const mediaDevices = createMediaDevices({
      devices: ['audioinput'],
      responses: { audio: mediaError('TypeError') },
    });

    const result = await new MediaManager({ mediaDevices }).acquire();

    expect(result.audio.status).toBe(TRACK_STATUS.ERROR);
  });

  it('список устройств недоступен: запрашиваются оба вида', async () => {
    const mediaDevices = createMediaDevices();
    mediaDevices.enumerateDevices.mockRejectedValue(new Error('нет доступа к списку'));

    const result = await new MediaManager({ mediaDevices }).acquire();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: VIDEO_CONSTRAINTS,
    });
    expect(result.audio.status).toBe(TRACK_STATUS.OK);
  });

  it('ответ без запрошенной дорожки: ERROR вместо молчаливого успеха', async () => {
    const mediaDevices = createMediaDevices({ devices: ['audioinput'] });
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream([]));

    const result = await new MediaManager({ mediaDevices }).acquire();

    expect(result.audio).toEqual({ status: TRACK_STATUS.ERROR, track: null });
  });
});
