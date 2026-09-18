import { describe, expect, it, vi } from 'vitest';
import { TRACK_STATUS } from '../utils/mediaErrors.js';
import { MediaManager, VIDEO_CONSTRAINTS } from './MediaManager.js';

/** Дорожка с тем минимумом, который использует `MediaManager`. */
function fakeTrack(kind) {
  const track = { kind, enabled: true, readyState: 'live', onended: null };
  track.stop = vi.fn(() => {
    track.readyState = 'ended';
  });
  /** Устройство исчезло само: браузер поднимает `ended` (FR-20). */
  track.end = () => track.onended?.();
  return track;
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
 * `responses[kind]` — дорожка, ошибка или функция, возвращающая то или другое; по умолчанию
 * каждый вызов даёт новую дорожку.
 * @param {{ devices?: string[], responses?: Record<string, unknown> }} [options]
 */
function createMediaDevices({ devices = ['audioinput', 'videoinput'], responses = {} } = {}) {
  const getUserMedia = vi.fn(async (constraints) => {
    const tracks = [];
    for (const kind of Object.keys(constraints)) {
      const configured = responses[kind];
      const response =
        typeof configured === 'function' ? configured() : (configured ?? fakeTrack(kind));
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

/** `MediaStream` в jsdom нет: подменяем набором дорожек с тем же интерфейсом. */
function createStreamFactory() {
  return vi.fn((initial) => {
    let tracks = [...initial];
    return {
      getTracks: () => [...tracks],
      addTrack: (track) => tracks.push(track),
      removeTrack: (track) => {
        tracks = tracks.filter((candidate) => candidate !== track);
      },
    };
  });
}

/** Захватил оба устройства и подписан на изменения дорожек — состояние после успешного входа. */
async function acquired(options) {
  const mediaDevices = createMediaDevices(options);
  const createMediaStream = createStreamFactory();
  const manager = new MediaManager({ mediaDevices, createMediaStream });
  const onTrackChange = vi.fn();
  const onDeviceLost = vi.fn();
  manager.onTrackChange(onTrackChange);
  manager.onDeviceLost(onDeviceLost);
  const initial = await manager.acquire();

  return { manager, mediaDevices, createMediaStream, onTrackChange, onDeviceLost, initial };
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
    expect(manager.getMediaState()).toEqual({ audio: true, video: true });
  });

  it('камеры нет в системе: она не запрашивается и считается NOT_FOUND (FR-14)', async () => {
    const mediaDevices = createMediaDevices({ devices: ['audioinput'] });
    const manager = new MediaManager({ mediaDevices });

    const result = await manager.acquire();

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.audio.status).toBe(TRACK_STATUS.OK);
    expect(result.video).toEqual({ status: TRACK_STATUS.NOT_FOUND, track: null });
    expect(manager.getTrack('video')).toBeNull();
    expect(manager.getMediaState()).toEqual({ audio: true, video: false });
  });

  it('отказ в доступе: оба вида DENIED, пользователь остаётся в комнате (FR-33, US-12)', async () => {
    const denied = mediaError('NotAllowedError');
    const mediaDevices = createMediaDevices({ responses: { audio: denied, video: denied } });
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

  it('dispose во время диалога разрешений: дорожки останавливаются сразу', async () => {
    const mediaDevices = createMediaDevices();
    const manager = new MediaManager({ mediaDevices });

    const pending = manager.acquire();
    manager.dispose();
    const result = await pending;

    expect(result.audio.track.stop).toHaveBeenCalled();
    expect(result.video.track.stop).toHaveBeenCalled();
    expect(manager.getTrack('audio')).toBeNull();
  });
});

describe('MediaManager.setAudioEnabled: тумблер микрофона (FR-15, TDD §4.1.4)', () => {
  it('выключение только снимает enabled: дорожка живёт, пирам идёт тишина', async () => {
    const { manager, onTrackChange, initial } = await acquired();

    await manager.setAudioEnabled(false);

    expect(initial.audio.track.enabled).toBe(false);
    expect(initial.audio.track.stop).not.toHaveBeenCalled();
    // Повторное согласование SDP не нужно: дорожка у пиров та же самая (TDD §4.1.4).
    expect(onTrackChange).not.toHaveBeenCalled();
    expect(manager.getMediaState().audio).toBe(false);
  });

  it('включение возвращает enabled без нового захвата', async () => {
    const { manager, mediaDevices, initial } = await acquired();
    await manager.setAudioEnabled(false);

    await manager.setAudioEnabled(true);

    expect(initial.audio.track.enabled).toBe(true);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('дорожки нет (было DENIED): включение захватывает микрофон заново', async () => {
    const denied = mediaError('NotAllowedError');
    const { manager, mediaDevices, onTrackChange } = await acquired({
      responses: { audio: denied, video: denied },
    });
    mediaDevices.getUserMedia.mockImplementation(async () => fakeStream([fakeTrack('audio')]));

    const status = await manager.setAudioEnabled(true);

    expect(status).toBe(TRACK_STATUS.OK);
    expect(manager.getStatus('audio')).toBe(TRACK_STATUS.OK);
    expect(manager.getTrack('audio')).not.toBeNull();
    expect(onTrackChange).toHaveBeenCalledWith('audio', manager.getTrack('audio'));
  });

  it('дорожки нет и выключать нечего: захвата не происходит', async () => {
    const { manager, mediaDevices } = await acquired({ devices: ['videoinput'] });
    const callsAfterAcquire = mediaDevices.getUserMedia.mock.calls.length;

    await manager.setAudioEnabled(false);

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(callsAfterAcquire);
  });
});

describe('MediaManager.setVideoEnabled: тумблер камеры (FR-17, FR-19, TDD §7.4)', () => {
  it('выключение останавливает дорожку: аппаратный индикатор гаснет (FR-19)', async () => {
    const { manager, onTrackChange, initial } = await acquired();

    await manager.setVideoEnabled(false);

    expect(initial.video.track.stop).toHaveBeenCalledTimes(1);
    expect(manager.getTrack('video')).toBeNull();
    // Пирам уходит replaceTrack(null), нового SDP при этом не нужно.
    expect(onTrackChange).toHaveBeenCalledWith('video', null);
    expect(manager.getMediaState().video).toBe(false);
  });

  it('повторное выключение ничего не рассылает', async () => {
    const { manager, onTrackChange } = await acquired();
    await manager.setVideoEnabled(false);
    onTrackChange.mockClear();

    await manager.setVideoEnabled(false);

    expect(onTrackChange).not.toHaveBeenCalled();
  });

  it('включение создаёт новую дорожку и рассылает её пирам', async () => {
    const { manager, mediaDevices, onTrackChange, initial } = await acquired();
    await manager.setVideoEnabled(false);
    onTrackChange.mockClear();

    const status = await manager.setVideoEnabled(true);

    expect(status).toBe(TRACK_STATUS.OK);
    expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ video: VIDEO_CONSTRAINTS });
    const track = manager.getTrack('video');
    expect(track).not.toBe(initial.video.track);
    expect(onTrackChange).toHaveBeenCalledWith('video', track);
    expect(manager.getMediaState().video).toBe(true);
  });

  it('ошибка включения не меняет состояние, а возвращает причину (TDD §8.2)', async () => {
    const { manager, mediaDevices, onTrackChange } = await acquired();
    await manager.setVideoEnabled(false);
    onTrackChange.mockClear();
    mediaDevices.getUserMedia.mockRejectedValue(mediaError('NotReadableError'));

    const status = await manager.setVideoEnabled(true);

    expect(status).toBe(TRACK_STATUS.BUSY);
    expect(manager.getStatus('video')).toBe(TRACK_STATUS.BUSY);
    expect(manager.getTrack('video')).toBeNull();
    expect(manager.getMediaState().video).toBe(false);
    expect(onTrackChange).not.toHaveBeenCalled();
  });

  it('включение при живой дорожке не трогает устройство', async () => {
    const { manager, mediaDevices } = await acquired();

    await manager.setVideoEnabled(true);

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('MediaManager: потеря устройства (FR-20, TDD §8.2)', () => {
  it('ended у дорожки: колбэк, сброс дорожки и рассылка null пирам', async () => {
    const { manager, onTrackChange, onDeviceLost, initial } = await acquired();

    initial.video.track.end();

    expect(onDeviceLost).toHaveBeenCalledWith('video');
    expect(onTrackChange).toHaveBeenCalledWith('video', null);
    expect(manager.getTrack('video')).toBeNull();
    // Статус прежний: устройство могли вернуть на место, кнопка должна остаться доступной.
    expect(manager.getStatus('video')).toBe(TRACK_STATUS.OK);
  });

  it('после потери камеру можно включить заново', async () => {
    const { manager, initial } = await acquired();
    initial.video.track.end();

    const status = await manager.setVideoEnabled(true);

    expect(status).toBe(TRACK_STATUS.OK);
    expect(manager.getTrack('video')).not.toBeNull();
  });

  it('свой stop() не считается потерей устройства', async () => {
    const { manager, onDeviceLost, initial } = await acquired();

    await manager.setVideoEnabled(false);
    // Некоторые браузеры поднимают ended и на остановленной нами дорожке.
    initial.video.track.onended?.();

    expect(onDeviceLost).not.toHaveBeenCalled();
  });

  it('ended у заменённой дорожки игнорируется', async () => {
    const { manager, onDeviceLost, initial } = await acquired();
    await manager.setVideoEnabled(false);
    await manager.setVideoEnabled(true);

    initial.video.track.end();

    expect(onDeviceLost).not.toHaveBeenCalled();
    expect(manager.getTrack('video')).not.toBeNull();
  });

  it('отписка снимает обработчики', async () => {
    const { manager, initial } = await acquired();
    const handler = vi.fn();
    const unsubscribe = manager.onDeviceLost(handler);

    unsubscribe();
    initial.audio.track.end();

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('MediaManager.localStream: поток своей плитки (TDD §4.1.5)', () => {
  it('собирается из захваченных дорожек', async () => {
    const { manager, initial } = await acquired();

    expect(manager.localStream.getTracks()).toEqual([initial.audio.track, initial.video.track]);
  });

  it('объект один и тот же, а дорожки в нём меняются вслед за тумблерами', async () => {
    const { manager, createMediaStream } = await acquired();
    const stream = manager.localStream;

    await manager.setVideoEnabled(false);
    expect(stream.getTracks().map(({ kind }) => kind)).toEqual(['audio']);

    await manager.setVideoEnabled(true);
    expect(stream.getTracks().map(({ kind }) => kind)).toEqual(['audio', 'video']);
    // `<video>` не перепривязывается: srcObject остаётся прежним.
    expect(manager.localStream).toBe(stream);
    expect(createMediaStream).toHaveBeenCalledTimes(1);
  });

  it('потерянное устройство уходит из потока (FR-20)', async () => {
    const { manager, initial } = await acquired();
    const stream = manager.localStream;

    initial.video.track.end();

    expect(stream.getTracks()).toEqual([initial.audio.track]);
  });
});

describe('MediaManager.dispose: освобождение устройств (TDD §7.6)', () => {
  it('останавливает все дорожки и молчит после этого', async () => {
    const { manager, onTrackChange, onDeviceLost, initial } = await acquired();

    manager.dispose();

    expect(initial.audio.track.stop).toHaveBeenCalledTimes(1);
    expect(initial.video.track.stop).toHaveBeenCalledTimes(1);
    expect(manager.getTrack('audio')).toBeNull();
    expect(onTrackChange).not.toHaveBeenCalled();
    expect(onDeviceLost).not.toHaveBeenCalled();
  });

  it('идемпотентен и блокирует повторный захват', async () => {
    const { manager, mediaDevices, initial } = await acquired();

    manager.dispose();
    manager.dispose();
    const status = await manager.setVideoEnabled(true);

    expect(initial.video.track.stop).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(status).toBe(TRACK_STATUS.OK);
    expect(manager.getTrack('video')).toBeNull();
  });
});
