"""테스트용 합성 MP4 (저작권 없는 직접 생성 음원/영상)."""
import subprocess
import wave

import numpy as np

SR = 44100


def _env(n, attack=0.002, decay=0.15):
    t = np.arange(n) / SR
    return np.minimum(1, t / attack) * np.exp(-t / decay)


def song_wav(path, *, intro_silence=3.0, talk_until=7.5, music_end=27.5, total=30.0, bpm=120, seed=1):
    """intro_silence 까지 무음, talk_until 까지 불규칙한 '멘트' 소음, 그 뒤 bpm 드럼+멜로디, music_end 이후 무음.
    반환: 실제 박 시각(ms) 목록."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(total * SR), np.float32)

    def add(t, sig):
        i = int(t * SR)
        sig = sig[:max(0, len(out) - i)]
        out[i:i + len(sig)] += sig

    # 방송 멘트처럼 박자가 없는 소리: 길이/간격이 제각각인 대역 소음 + 낮은 웅얼거림
    t = intro_silence
    while t < talk_until - 0.3:
        dur = rng.uniform(0.12, 0.45)
        n = int(dur * SR)
        noise = rng.normal(0, 1, n)
        noise = np.convolve(noise, np.ones(12) / 12, mode='same')
        f0 = rng.uniform(110, 220)
        hum = np.sin(2 * np.pi * f0 * np.arange(n) / SR)
        win = np.hanning(n)
        add(t, (0.25 * noise + 0.2 * hum) * win)
        t += dur + rng.uniform(0.05, 0.35)

    beat = 60 / bpm
    beats = []
    notes = [261.63, 329.63, 392.0, 523.25, 440.0, 349.23, 293.66, 392.0]
    k = 0
    t = talk_until
    while t < music_end - 1e-6:
        beats.append(round(t * 1000))
        n = int(0.3 * SR)
        tt = np.arange(n) / SR
        kick = np.sin(2 * np.pi * (50 + 100 * np.exp(-tt / 0.03)) * tt) * _env(n, decay=0.12)
        add(t, 0.9 * kick)
        if k % 2 == 1:  # 2, 4 박 스네어
            add(t, 0.45 * rng.normal(0, 1, int(0.15 * SR)) * _env(int(0.15 * SR), decay=0.05))
        for half in (0, 0.5):  # 8분 하이햇
            m = int(0.05 * SR)
            add(t + half * beat, 0.12 * rng.normal(0, 1, m) * _env(m, decay=0.01))
        f = notes[k % len(notes)]
        m = int(beat * SR)
        add(t, 0.18 * np.sign(np.sin(2 * np.pi * f * np.arange(m) / SR)) * _env(m, decay=0.2))
        t += beat
        k += 1
    out /= max(1e-9, np.abs(out).max()) / 0.8
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((out * 32767).astype('<i2').tobytes())
    return beats


def make_mp4(path, wav, *, total=30.0, fade_in=4.0, vcodec='libx264', small=False):
    """테스트 패턴 영상 (처음 fade_in 초는 검은 화면에서 서서히 밝아짐) + wav."""
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', f'testsrc2=size=320x180:rate=24:duration={total}',
        '-i', str(wav),
        '-vf', f'fade=in:st=0:d={fade_in}',
        '-c:v', vcodec, *(['-preset', 'slow', '-crf', '34', '-r', '15'] if small else ['-preset', 'ultrafast']), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-shortest', str(path),
    ], check=True, capture_output=True)
    return path
