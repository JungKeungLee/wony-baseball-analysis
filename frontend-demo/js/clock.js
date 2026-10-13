// 게임 시계 = video.currentTime. 영상이 음악이고, 영상이 게임 시계다.
// 노트 위치 / 판정 / 진행률 / 종료 / 결과는 모두 now() 하나(= video.currentTime * 1000)를 본다.
// 별도 audio 요소나 setInterval 누적 시간은 쓰지 않는다.
//
// 인터페이스: start(leadMs) / now() / pause() / resume() / stop() / tick() / ended / kind
// start(leadMs) 직후 now() 는 -leadMs 부터 올라가고(카운트다운, 영상은 0초에 정지), 0 이 되면 영상을 재생한다.

const perfNow = () => globalThis.performance.now();

export class VideoClock {
  /**
   * @param {HTMLVideoElement} video
   * @param {{allowSeek?: boolean, nowFn?: () => number}} opts
   *   allowSeek: 플레이 모드에서는 false (사용자/OS 의 위치 이동을 되돌림). 나중에 CHART EDIT MODE 에서만 true.
   */
  constructor(video, { allowSeek = false, nowFn = perfNow } = {}) {
    this.kind = 'video';
    this.video = video;
    this.allowSeek = allowSeek;
    this.nowFn = nowFn;
    this.reset();
    video.playbackRate = 1;
    video.defaultPlaybackRate = 1;
    if (typeof video.addEventListener === 'function') {
      video.addEventListener('ratechange', () => { if (video.playbackRate !== 1) video.playbackRate = 1; });
      video.addEventListener('seeking', () => this.onSeeking());
    }
  }

  reset() {
    this.leadEnd = 0;
    this.started = false;   // 카운트다운이 끝나 영상 재생을 시작했는지
    this.paused = false;
    this.pausedAt = 0;
    this.lastV = 0;
    this.lastP = 0;
    this.lastOut = -Infinity;
    this.internalSeek = false;
  }

  /** 사용자 탭/클릭 처리 안에서 호출: 모바일 자동재생 정책을 풀어 둔다 (무음으로 잠깐 재생 후 정지). */
  unlock() {
    const v = this.video;
    v.muted = true;
    const p = v.play();
    const done = () => {
      if (!this.started) v.pause();
      v.muted = false;
    };
    if (p && typeof p.then === 'function') p.then(done, done); else done();
  }

  seekInternal(seconds) {
    this.internalSeek = true;
    try { this.video.currentTime = seconds; } catch { this.internalSeek = false; }
  }

  start(leadMs = 0) {
    this.reset();
    this.video.playbackRate = 1;
    if (this.video.currentTime !== 0) this.seekInternal(0);
    this.leadEnd = this.nowFn() + leadMs;
  }

  now() {
    if (this.paused) return this.pausedAt;
    const p = this.nowFn();
    const v = this.video;
    if (!this.started) {
      const r = p - this.leadEnd;
      if (r < 0) return r;
      this.started = true;
      v.muted = false;
      const played = v.play();
      if (played && played.catch) played.catch(() => {});
      this.lastV = v.currentTime * 1000;
      this.lastP = p;
      this.lastOut = this.lastV;
      return this.lastOut;
    }
    // 외부 seek 직후: seeking 은 즉시 true 가 되지만 'seeking' 이벤트는 나중에 온다.
    // 그 사이 프레임에서 새 위치를 받아들이면 onSeeking 이 되돌릴 기준을 잃으므로 이전 위치를 유지한다.
    if (v.seeking && !this.internalSeek && !this.allowSeek) return this.lastOut;
    const t = v.currentTime * 1000;
    if (t !== this.lastV) {
      this.lastV = t;
      this.lastP = p;
    }
    // currentTime 갱신이 프레임보다 거친 브라우저용: 재생 중일 때만 마지막 갱신 후 최대 50ms 보간.
    // 버퍼링(waiting)·일시정지 중에는 보간하지 않으므로 영상이 멈추면 노트도 멈춘다.
    const running = !v.paused && !v.seeking && (v.readyState === undefined || v.readyState >= 3);
    const out = running ? t + Math.min(p - this.lastP, 50) : t;
    // 보간 때문에 시간이 뒤로 가지 않게 하되, 실제 영상 위치가 크게 달라지면 영상 위치를 따른다.
    this.lastOut = out < this.lastOut && this.lastOut - out < 60 ? this.lastOut : out;
    return this.lastOut;
  }

  /** 플레이 중 위치 이동(시크바/미디어 키/OS 컨트롤) 금지: 원래 위치로 되돌린다. */
  onSeeking() {
    if (this.internalSeek) {
      this.internalSeek = false;
      return;
    }
    if (this.allowSeek) return;
    const back = (this.paused ? this.pausedAt : Math.max(0, this.lastOut)) / 1000;
    if (this.started && Number.isFinite(back) && Math.abs(this.video.currentTime - back) > 0.25) this.seekInternal(back);
  }

  pause() {
    if (this.paused) return;
    this.pausedAt = this.now();
    this.paused = true;
    if (this.started) this.video.pause();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.started) {
      this.leadEnd = this.nowFn() - this.pausedAt; // pausedAt 은 음수 (카운트다운 중)
      return;
    }
    this.lastV = this.video.currentTime * 1000;
    this.lastP = this.nowFn();
    this.lastOut = this.lastV;
    const played = this.video.play();
    if (played && played.catch) played.catch(() => {});
  }

  stop() {
    this.paused = true;
    this.pausedAt = this.lastOut;
    this.video.pause();
  }

  tick() {
    if (this.video.playbackRate !== 1) this.video.playbackRate = 1;
  }

  get ended() {
    return this.started && Boolean(this.video.ended);
  }
}
