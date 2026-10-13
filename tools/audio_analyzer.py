"""MP4 오디오 → 박자/onset/강세/에너지 분석 (numpy 만 사용, 로컬 도구 전용).

모든 시각은 **원본 영상 timeline 기준 ms** 이다. 노래가 7.5초에 시작하면 첫 후보도 7500ms 근처다.
게임 서버(backend/)는 이 모듈을 import 하지 않는다.

분석 순서
  1. STFT spectral flux (저역/중역/고역) → onset 세기, RMS 에너지, spectral centroid
  2. 4초 창마다 onset 의 주기성(pulse clarity) + 에너지로 "실제 음악" 구간을 찾는다
     (검은 화면/방송 멘트/무음처럼 박자가 없는 인트로에는 노트를 만들지 않기 위해)
  3. onset 자기상관 + 템포 prior 로 BPM 추정
  4. 동적계획법(Ellis 2007) beat tracking
  5. 저역 강세로 마디 첫 박(downbeat) 위치 추정, 8분/16분 격자 생성
  6. onset peak 를 격자에 스냅해 후보 생성 (격자 밖의 강한 onset 은 싱코페이션 후보)
"""
from dataclasses import dataclass, field

import numpy as np

SR = 22050
N_FFT = 2048
HOP = 256
FPS = SR / HOP


class AnalysisError(RuntimeError):
    pass


@dataclass
class Candidate:
    time: int            # ms, 영상 timeline 기준
    level: int           # 0 강박 / 1 3박 / 2 2·4박 / 3 8분 / 4 16분 / 5 격자 밖 onset
    strength: float      # 0~1 onset 세기
    has_onset: bool
    intensity: float     # 0~1 곡 안에서의 상대 에너지 (구간 분위기)
    pitch: float         # 0~1 spectral centroid 순위 (낮은 소리 → 0, 높은 소리 → 1)
    low: float           # 0~1 저역(킥) 강세
    high: float          # 0~1 고역 강세


@dataclass
class Analysis:
    duration_ms: int
    bpm: float
    music_start_ms: int
    music_end_ms: int
    beats_ms: list
    downbeat_phase: int
    candidates: list = field(default_factory=list)
    onset_count: int = 0

    def summary(self):
        return {'bpm': round(self.bpm, 1), 'musicStartMs': self.music_start_ms, 'musicEndMs': self.music_end_ms,
                'beats': len(self.beats_ms), 'onsets': self.onset_count, 'candidates': len(self.candidates)}


# ---------------------------------------------------------------- 기본 특징
def _features(x):
    pad = N_FFT // 2
    x = np.pad(x.astype(np.float32), (pad, pad))
    n = 1 + (len(x) - N_FFT) // HOP
    view = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP][:n]
    window = np.hanning(N_FFT).astype(np.float32)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    masks = {'low': (freqs >= 30) & (freqs < 200), 'mid': (freqs >= 200) & (freqs < 2000),
             'high': (freqs >= 2000) & (freqs < 8000)}
    cmask = (freqs >= 30) & (freqs < 8000)
    flux = {k: np.zeros(n, np.float32) for k in masks}
    rms = np.zeros(n, np.float32)
    centroid = np.zeros(n, np.float32)
    prev = None
    for s in range(0, n, 2048):  # 블록 단위로 처리해 메모리를 작게 유지
        frames = view[s:s + 2048]
        rms[s:s + len(frames)] = np.sqrt(np.mean(frames * frames, axis=1))
        mag = np.abs(np.fft.rfft(frames * window, axis=1)).astype(np.float32)
        logm = np.log1p(10.0 * mag)
        before = np.vstack([logm[:1] if prev is None else prev, logm[:-1]])
        rise = np.maximum(0.0, logm - before)
        for k, m in masks.items():
            flux[k][s:s + len(frames)] = rise[:, m].sum(axis=1)
        cm = mag[:, cmask]
        centroid[s:s + len(frames)] = (cm * freqs[cmask]).sum(axis=1) / np.maximum(cm.sum(axis=1), 1e-9)
        prev = logm[-1:]
    return flux, rms, centroid


def _norm(v, ref_slice=None):
    ref = v if ref_slice is None else v[ref_slice]
    scale = np.percentile(ref, 98) if ref.size else 0
    return np.clip(v / scale, 0, 1.5) if scale > 1e-9 else np.zeros_like(v)


def _smooth(v, frames):
    if frames <= 1:
        return v
    k = np.hanning(frames + 2)[1:-1]
    return np.convolve(v, k / k.sum(), mode='same')


def _moving_mean(v, frames):
    k = np.ones(frames) / frames
    return np.convolve(v, k, mode='same')


def _autocorr(v):
    v = v - v.mean()
    n = len(v)
    f = np.fft.rfft(v, 2 * n)
    return np.fft.irfft(f * np.conj(f))[:n]


# ---------------------------------------------------------------- 음악 구간 / 템포
def _pulse_clarity(env, lo, hi):
    ac = _autocorr(env)
    if ac[0] <= 1e-9 or hi >= len(ac):
        return 0.0
    return float(ac[lo:hi].max() / ac[0])


def _music_mask(env, rms_db):
    """주기성이 있고 충분히 큰 소리가 나는 4초 창 → 음악."""
    win, step = int(4 * FPS), int(0.5 * FPS)
    lo, hi = int(60 * FPS / 210), int(60 * FPS / 55)
    ref = np.percentile(rms_db, 95)
    mask = np.zeros(len(env), bool)
    for s in range(0, max(1, len(env) - win + 1), step):
        seg = slice(s, s + win)
        loud = np.median(rms_db[seg]) > ref - 24
        if loud and _pulse_clarity(env[seg], lo, hi) >= 0.3:
            mask[seg] = True
    if not mask.any():  # 주기성이 약한 곡: 소리가 나는 구간 전체
        mask = rms_db > ref - 30
    return mask


def _longest_span(mask, gap_frames):
    """작은 틈(gap_frames 이하)은 메우고 가장 긴 연속 구간."""
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return None
    spans, start, last = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - last > gap_frames:
            spans.append((start, last))
            start = i
        last = i
    spans.append((start, last))
    return max(spans, key=lambda s: s[1] - s[0])


def _tempo(env):
    ac = _autocorr(env)
    lags = np.arange(int(60 * FPS / 200), int(60 * FPS / 60) + 1)
    lags = lags[lags < len(ac) - 1]
    if lags.size == 0:
        raise AnalysisError('곡이 너무 짧아 박자를 찾지 못했습니다.')
    bpm = 60 * FPS / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 120.0) / 0.9) ** 2)
    score = np.maximum(ac[lags], 0) * prior
    i = int(np.argmax(score))
    lag = float(lags[i])
    if 0 < i < len(lags) - 1:  # 포물선 보간으로 소수점 lag
        a, b, c = score[i - 1], score[i], score[i + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag += 0.5 * (a - c) / denom
    return lag


def _track_beats(local, period, tightness=100.0):
    n = len(local)
    window = np.arange(-int(round(2 * period)), -int(round(period / 2)) + 1)
    txwt = -tightness * np.log(-window / period) ** 2
    cum = local.copy()
    back = np.full(n, -1)
    for i in range(n):
        idx = i + window
        ok = idx >= 0
        if not ok.any():
            continue
        cand = cum[idx[ok]] + txwt[ok]
        j = int(np.argmax(cand))
        if cand[j] > 0:
            cum[i] = local[i] + cand[j]
            back[i] = idx[ok][j]
    tail = max(1, int(round(2 * period)))
    i = n - tail + int(np.argmax(cum[-tail:]))
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    return np.array(beats[::-1])


# ---------------------------------------------------------------- onset
def _onset_peaks(env, threshold):
    r = 3  # ±35ms 안에서 가장 큰 값
    padded = np.pad(env, r, mode='constant')
    windows = np.lib.stride_tricks.sliding_window_view(padded, 2 * r + 1)
    is_max = env >= windows.max(axis=1)
    peaks = np.flatnonzero(is_max & (env >= threshold))
    out, last = [], -10 ** 9
    min_dist = int(0.05 * FPS)
    for p in peaks:
        if p - last >= min_dist:
            out.append(p)
            last = p
        elif env[p] > env[out[-1]]:
            out[-1] = p
            last = p
    return np.array(out, dtype=int)


def _rank01(values):
    values = np.asarray(values, float)
    if values.size <= 1:
        return np.full(values.shape, 0.5)
    order = values.argsort().argsort()
    return order / (values.size - 1)


class _AttackRefiner:
    """STFT 프레임 위치 → 실제 소리가 커지기 시작한 시각 (오디오 기준 ms).

    2048 창 spectral flux 의 peak 는 실제 attack 보다 일정하게 앞선다(약 29ms, 합성 신호로 측정).
    그래서 frame 시각 뒤쪽 [-30, +70]ms 안에서 2.9ms 단위 에너지(dB) 상승이 가장 큰 지점을 찾고,
    뚜렷한 상승이 없으면(부드러운 소리) 측정된 편향만큼만 옮긴다.
    """
    W = 64                 # 2.9ms 간격 @ 22050Hz
    SPAN = 256             # 11.6ms RMS 창: 저음 한 주기보다 짧으면 위상 때문에 가짜 상승이 생긴다
    LAG = 3                # 3칸(8.7ms) 전 대비 dB 상승
    FRAME_BIAS_MS = 29.0
    MIN_RISE_DB = 3.0
    ATTACK_SHIFT = -2.4    # 상승 최대 지점 → attack 시각 보정 (칸 단위, 합성 킥/하이햇으로 측정한 +7ms 편향 제거)

    def __init__(self, samples):
        hp = np.diff(samples, prepend=samples[:1])  # 고역 강조: attack 은 넓은 대역, 저음 출렁임은 약해진다
        c = np.concatenate([[0.0], np.cumsum(np.square(hp, dtype=np.float64))])
        starts = np.arange(0, len(hp) - self.SPAN, self.W)
        e = np.sqrt((c[starts + self.SPAN] - c[starts]) / self.SPAN)
        le = 20 * np.log10(e + 1e-7)
        self.rise = np.zeros(len(le))
        self.rise[self.LAG:] = le[self.LAG:] - le[:-self.LAG]
        self.step_ms = self.W / SR * 1000

    def refine(self, frame):
        c = frame * HOP / SR * 1000
        lo = max(self.LAG, int((c - 30) / self.step_ms))
        hi = min(len(self.rise), int((c + 70) / self.step_ms) + 1)
        if hi - lo < 3:
            return c + self.FRAME_BIAS_MS
        j = lo + int(np.argmax(self.rise[lo:hi]))
        if self.rise[j] < self.MIN_RISE_DB:
            return c + self.FRAME_BIAS_MS
        # 창 [j*W, j*W+SPAN) 의 끝부분에 attack 이 들어올 때 상승이 가장 크다
        return (j + self.ATTACK_SHIFT) * self.step_ms + self.SPAN / SR * 1000


# ---------------------------------------------------------------- 메인
def analyze(samples, *, offset_ms=0.0, duration_ms=None, debug=None):
    """samples: SR(22050Hz) 모노 float32. offset_ms: 영상 0초 대비 오디오 시작 위치."""
    if samples is None or len(samples) < SR * 3:
        raise AnalysisError('오디오가 너무 짧습니다 (3초 미만).')
    if not np.isfinite(samples).all():
        samples = np.nan_to_num(samples)
    duration_ms = int(duration_ms if duration_ms else offset_ms + len(samples) / SR * 1000)
    flux, rms, centroid = _features(samples)
    n = len(rms)
    rms_db = 20 * np.log10(rms + 1e-9)
    if np.percentile(rms_db, 99) < -60:
        raise AnalysisError('오디오가 거의 무음입니다.')

    low, mid, high = (_norm(flux[k]) for k in ('low', 'mid', 'high'))
    env = 0.45 * low + 0.35 * mid + 0.2 * high

    # 1차 음악 구간 (짧은 끊김 2초는 메움)
    span = _longest_span(_music_mask(env, rms_db), int(2 * FPS))
    if span is None or span[1] - span[0] < 4 * FPS:
        raise AnalysisError('음악으로 판단되는 구간을 찾지 못했습니다.')
    s0, s1 = span
    region = slice(s0, s1 + 1)
    low, mid, high = (_norm(flux[k], region) for k in ('low', 'mid', 'high'))
    env = 0.45 * low + 0.35 * mid + 0.2 * high
    env_n = _norm(env, region)

    period = _tempo(env_n[region])
    bpm = 60 * FPS / period

    # beat tracking (구간 앞뒤로 조금 여유)
    a = max(0, s0 - int(2 * FPS))
    b = min(n, s1 + int(1 * FPS))
    local = _smooth(env_n[a:b], 3)
    local = local / (local.std() + 1e-9)
    beat_frames = _track_beats(local, period) + a

    # onset peak
    adaptive = _moving_mean(env_n, int(0.4 * FPS) | 1) + 0.04
    peaks = _onset_peaks(env_n, np.maximum(adaptive, 0.06))

    def peak_val(arr, f):
        return arr[max(0, f - 2):f + 3].max()

    # 각 beat 를 근처(±2프레임) onset 최대 위치로 미세 조정
    for i, f in enumerate(beat_frames):
        lo_, hi_ = max(0, f - 2), min(n, f + 3)
        beat_frames[i] = lo_ + int(np.argmax(env_n[lo_:hi_]))

    # 음악 시작/끝 다듬기. beat 마다
    #   - 뚜렷한 onset 이 있고 (salience)
    #   - 실제 attack 시각(ms)이 앞뒤 박과 박자 간격으로 ±10ms 안에 맞는지 (timing)
    # 를 보고, 연속 4박이 모두 맞고 8박 중 7박 이상 맞는 첫/마지막 지점을 음악 구간으로 잡는다.
    # 멘트/잡음이 우연히 박자 자리에 소리를 낼 수는 있어도 ms 단위 간격까지 맞기는 어렵다.
    attack = _AttackRefiner(samples)
    sal = np.array([peak_val(env_n, f) for f in beat_frames])
    t_ms = np.array([attack.refine(f) for f in beat_frames])
    inside = (beat_frames >= s0) & (beat_frames <= s1)
    ref = np.median(sal[inside]) if inside.any() else np.median(sal)
    period_ms = period / FPS * 1000
    ibi = np.diff(t_ms)
    fits = np.abs(ibi - period_ms) <= max(10.0, 0.02 * period_ms)  # fits[i]: i 와 i+1 사이 간격이 맞음
    timing = np.zeros(len(t_ms), bool)
    timing[:-1] |= fits
    timing[1:] |= fits
    good = (sal >= 0.5 * ref) & timing
    k = 8
    starts = [i for i in range(len(good) - k + 1) if good[i:i + 4].all() and fits[i:i + 3].all() and good[i:i + k].sum() >= 7]
    ends = [i for i in range(k - 1, len(good)) if good[i - 3:i + 1].all() and fits[i - 3:i].all() and good[i - k + 1:i + 1].sum() >= 7]
    if not starts or not ends or ends[-1] <= starts[0]:
        raise AnalysisError('박자가 일정한 음악 구간을 찾지 못했습니다.')
    first, last = starts[0], ends[-1]
    # 곡의 첫/마지막 박은 앞뒤 소리 때문에 onset 이 약하게 잡히기 쉽다:
    # 박 간격이 ms 단위로 맞으면 약한 박도 최대 2박까지 포함
    for _ in range(2):
        if first > 0 and fits[first - 1] and sal[first - 1] >= 0.3 * ref:
            first -= 1
        if last + 1 < len(sal) and fits[last] and sal[last + 1] >= 0.3 * ref:
            last += 1
    if debug is not None:  # 진단용 (테스트/튜닝)
        debug.update(beat_ms=t_ms, salience=sal / max(ref, 1e-9), fits=fits, good=good, first=first, last=last)
    tol = max(2, int(0.06 * FPS))
    beat_frames = beat_frames[first:last + 1]
    start_f, end_f = int(beat_frames[0]), int(beat_frames[-1])
    if len(beat_frames) < 8:
        raise AnalysisError('박자를 충분히 찾지 못했습니다.')

    # 마디 첫 박: 저역(킥) 강세가 가장 큰 위상
    phase_score = []
    for ph in range(4):
        sel = beat_frames[ph::4]
        phase_score.append(np.mean([peak_val(low, f) + 0.5 * peak_val(env_n, f) for f in sel]) if len(sel) else 0)
    downbeat = int(np.argmax(phase_score))

    # 정밀 시각: STFT 프레임(11.6ms, 2048 창 편향 있음) 대신 2.9ms 해상도 에너지 상승점(attack)
    to_ms = lambda audio_ms: int(round(audio_ms + offset_ms))  # noqa: E731
    frame_of = lambda audio_ms: int(round(audio_ms / 1000 * FPS))  # noqa: E731
    intensity_curve = _smooth(rms_db, int(3 * FPS))
    music = np.sort(intensity_curve[start_f:end_f + 1])

    def intensity_at(f):
        return float(np.searchsorted(music, intensity_curve[min(max(f, 0), n - 1)]) / max(1, music.size))

    beat_ms = np.maximum.accumulate([attack.refine(f) for f in beat_frames])

    # 격자 (오디오 기준 ms): 박 / 8분 / 16분
    grid = []
    for i, t in enumerate(beat_ms):
        pos = (i - downbeat) % 4
        grid.append((float(t), 0 if pos == 0 else 1 if pos == 2 else 2))
        if i + 1 < len(beat_ms):
            g = beat_ms[i + 1] - t
            grid += [(t + g / 2, 3), (t + g / 4, 4), (t + 3 * g / 4, 4)]
    grid.sort()
    grid_t = np.array([g[0] for g in grid])
    sixteenth_ms = period / FPS * 1000 / 4
    snap_tol = min(45.0, 0.3 * sixteenth_ms)

    cands = {}  # key: grid index 또는 ('off', frame)
    for gi, (gt, lvl) in enumerate(grid):
        if lvl <= 2:
            cands[gi] = {'t': gt, 'level': lvl, 'strength': float(peak_val(env_n, frame_of(gt))), 'has_onset': False}
    for p in peaks:
        if p < start_f - tol or p > end_f + tol:
            continue
        ot = attack.refine(p)
        gi = int(np.argmin(np.abs(grid_t - ot))) if grid_t.size else -1
        s = float(min(1.0, env_n[p]))
        if gi >= 0 and abs(grid_t[gi] - ot) <= snap_tol:
            c = cands.setdefault(gi, {'t': grid_t[gi], 'level': grid[gi][1], 'strength': 0.0, 'has_onset': False})
            c['strength'] = max(c['strength'], s)
            c['has_onset'] = True
        else:
            cands[('off', int(p))] = {'t': ot, 'level': 5, 'strength': s, 'has_onset': True}

    items = sorted(cands.values(), key=lambda c: c['t'])
    frames = [frame_of(c['t']) for c in items]
    pitch = _rank01([centroid[max(0, f - 2):f + 3].mean() for f in frames]) if frames else []
    start_ms = to_ms(min(attack.refine(start_f), beat_ms[0]))
    end_ms = to_ms(max(attack.refine(end_f), beat_ms[-1]))
    candidates = []
    for c, f, pr in zip(items, frames, pitch):
        t = to_ms(c['t'])
        if t < start_ms - 30 or t > min(end_ms + 30, duration_ms - 50):
            continue
        candidates.append(Candidate(time=t, level=c['level'], strength=round(min(1.0, c['strength']), 4),
                                    has_onset=c['has_onset'], intensity=round(intensity_at(f), 4), pitch=round(float(pr), 4),
                                    low=round(float(min(1.0, peak_val(low, f))), 4),
                                    high=round(float(min(1.0, peak_val(high, f))), 4)))
    if not candidates:
        raise AnalysisError('노트 후보를 만들지 못했습니다.')
    return Analysis(duration_ms=duration_ms, bpm=float(bpm), music_start_ms=start_ms, music_end_ms=end_ms,
                    beats_ms=[to_ms(t) for t in beat_ms], downbeat_phase=downbeat, candidates=candidates,
                    onset_count=int(len(peaks)))
