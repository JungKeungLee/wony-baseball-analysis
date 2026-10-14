"""WONY RHYTHM 온라인 기능 설정 (Render 환경변수, 전부 서버 전용).

  RHYTHM_LINK_SECRET        WONY PHONE 과 같은 값. 1회용 입장권 서명 확인 + 세션 쿠키 서명 (32자 이상)
  RHYTHM_DB_SECRET          Supabase rhythm_private.settings 와 같은 값. DB 함수 호출 서명 (32자 이상)
  SUPABASE_URL              WONY PHONE 과 같은 Supabase 주소 (https://xxxx.supabase.co)
  SUPABASE_PUBLISHABLE_KEY  WONY PHONE 과 같은 공개 키 (sb_publishable_… 또는 이전 anon JWT). service role key 아님
  WONY_PHONE_URL            (선택) 로그인 안내 링크. 예: https://wony-phone.vercel.app/phone
  RHYTHM_SESSION_HOURS      (선택) 로그인 유지 시간, 기본 168 (7일)

하나라도 없으면 온라인 기능만 꺼지고 게임 · 로컬 기록은 그대로 동작합니다.
값은 로그에 출력하지 않습니다.
"""
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse

MIN_SECRET = 32


def _https_origin(raw):
    """https 주소(개발용 http://localhost · 127.0.0.1 허용)의 origin. 잘못되면 None."""
    if not raw:
        return None
    try:
        u = urlparse(raw.strip())
    except ValueError:
        return None
    local = u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1')
    if (u.scheme != 'https' and not local) or not u.hostname or u.username or u.password:
        return None
    return f'{u.scheme}://{u.netloc}'


@dataclass(frozen=True)
class RhythmConfig:
    link_secret: str
    db_secret: str
    supabase_url: str | None
    publishable_key: str
    phone_url: str | None
    session_seconds: int

    @property
    def login_enabled(self):
        return len(self.link_secret) >= MIN_SECRET

    @property
    def online_enabled(self):
        return self.login_enabled and len(self.db_secret) >= MIN_SECRET and bool(self.supabase_url) and bool(self.publishable_key)

    @property
    def online_issues(self):
        """온라인 기록이 꺼진 이유 = 빠졌거나 잘못된 환경변수 이름 (값은 넣지 않음)"""
        issues = []
        if not self.login_enabled:
            issues.append('RHYTHM_LINK_SECRET')
        if len(self.db_secret) < MIN_SECRET:
            issues.append('RHYTHM_DB_SECRET')
        if not self.supabase_url:
            issues.append('SUPABASE_URL')
        if not self.publishable_key:
            issues.append('SUPABASE_PUBLISHABLE_KEY')
        return issues


def load_config(env=None):
    env = os.environ if env is None else env
    hours = env.get('RHYTHM_SESSION_HOURS', '').strip()
    try:
        session_hours = min(max(int(hours), 1), 24 * 30) if hours else 168
    except ValueError:
        session_hours = 168
    phone = (env.get('WONY_PHONE_URL') or '').strip()
    phone_ok = _https_origin(phone) and not re.search(r'[\s"<>]', phone)
    key = (env.get('SUPABASE_PUBLISHABLE_KEY') or '').strip()
    if key.startswith('sb_secret_'):
        key = ''  # 비밀 키는 쓰지 않음 (공개 키만 허용)
    return RhythmConfig(
        link_secret=(env.get('RHYTHM_LINK_SECRET') or '').strip(),
        db_secret=(env.get('RHYTHM_DB_SECRET') or '').strip(),
        supabase_url=_https_origin(env.get('SUPABASE_URL')),
        publishable_key=key,
        phone_url=phone if phone_ok else None,
        session_seconds=session_hours * 3600,
    )


def load_local_env_file(path=None, env=None):
    """로컬 개발용: 저장소 루트의 .env 를 읽어 아직 없는 환경변수만 채운다 (Render 에서는 쓰지 않음).
    .env 는 git 에 올라가지 않으며(.gitignore), 값은 출력하지 않는다. 반환: 채운 변수 이름 목록."""
    env = os.environ if env is None else env
    if env.get('RENDER'):
        return []
    from pathlib import Path
    path = Path(path) if path else Path(__file__).resolve().parents[3] / '.env'
    if not path.is_file():
        return []
    loaded = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in env:
            env[key] = value
            loaded.append(key)
    return loaded
