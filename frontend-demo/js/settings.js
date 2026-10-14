// 설정 화면. 게임 화면에는 설정 UI가 없고, 게임은 시작할 때 저장된 값을 한 번 읽는다 (플레이 중 변경 불가).
import { DEFAULT_LANE_COUNT, NOTE_SPEEDS, OFFSET_RANGE, laneColors } from './config.js';
import { assignKey, keyLabel } from './keys.js';
import { keysFor, loadSettings, resetSettings, saveSettings, withKeysFor } from './storage.js';
import { EQUIP_ERRORS, SKIN_TYPES, createLocalSkinRepository, equipSkin, equippedSkins, getSkin, ownedSkinIds } from './skins.js';
import { requireMember } from './session.js';
import { applyUiSkin } from './theme.js';

applyUiSkin();
requireMember();   // 로그인 필수 (세션이 만료됐으면 로그인 안내로)

// 지금은 4키 설정만 화면에 보인다. 6키/8키 선택 UI 를 붙이면 이 값만 바꾸면 된다.
const laneCount = DEFAULT_LANE_COUNT;
const colors = laneColors(laneCount);

let settings = loadSettings();
let listening = -1;
const rows = document.getElementById('keyRows');
const status = document.getElementById('keyStatus');
const buttons = [];

function say(message, kind = '') {
  status.textContent = message;
  status.className = `status ${kind ? `is-${kind}` : ''}`;
}

function renderKeys() {
  buttons.forEach((btn, lane) => {
    const on = lane === listening;
    btn.textContent = on ? '키를 누르세요' : keyLabel(keysFor(settings, laneCount)[lane]);
    btn.classList.toggle('is-listening', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', `${lane + 1}레인 키: ${keyLabel(keysFor(settings, laneCount)[lane])}. 눌러서 변경`);
  });
}

function stopListening(message, kind) {
  listening = -1;
  renderKeys();
  if (message) say(message, kind);
}

for (let lane = 0; lane < laneCount; lane++) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn key-btn';
  btn.addEventListener('click', () => {
    listening = listening === lane ? -1 : lane;
    renderKeys();
    say(listening === -1 ? '' : `${lane + 1}레인에 쓸 키를 누르세요 (Esc: 취소)`);
  });
  btn.addEventListener('blur', () => { if (listening === lane) stopListening('변경을 취소했어요.'); });
  buttons.push(btn);
  const row = document.createElement('div');
  row.className = 'key-row';
  const name = document.createElement('span');
  name.className = 'lane-name';
  name.innerHTML = `<span class="lane-dot" style="background:${colors[lane]}"></span>${lane + 1}레인`;
  row.append(name, btn);
  rows.append(row);
}

document.addEventListener('keydown', e => {
  if (listening === -1 || e.repeat) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    stopListening('변경을 취소했어요.');
    return;
  }
  const lane = listening;
  const result = assignKey(keysFor(settings, laneCount), lane, e.code);
  if (!result.ok) {
    say(result.reason === 'duplicate'
      ? `${keyLabel(e.code)} 키는 이미 ${result.lane + 1}레인에서 쓰고 있어요. 다른 키를 눌러주세요.`
      : `${keyLabel(e.code)} 키는 사용할 수 없어요. 다른 키를 눌러주세요.`, 'error');
    return; // 계속 입력 대기
  }
  settings = withKeysFor(settings, laneCount, result.keys);
  const saved = saveSettings(settings);
  stopListening(saved ? `${lane + 1}레인 → ${keyLabel(e.code)} 저장했어요.` : '이 브라우저에서는 설정을 저장할 수 없어요.', saved ? 'ok' : 'error');
  buttons[lane].focus();
}, true);

// ---------- 속도 / 보정 / 터치 ----------
const speedGroup = document.getElementById('speedGroup');
const showVideo = document.getElementById('showVideo');
const noFail = document.getElementById('noFail');
const offset = document.getElementById('offset');
const touchMode = document.getElementById('touchMode');
Object.assign(offset, { min: OFFSET_RANGE.min, max: OFFSET_RANGE.max, step: OFFSET_RANGE.step });
speedGroup.replaceChildren(...NOTE_SPEEDS.map(s => {
  const label = document.createElement('label');
  label.className = 'diff-option';
  label.innerHTML = `<input type="radio" name="speed" value="${s}"><span>${s}x</span>`;
  return label;
}));

function renderPlay() {
  for (const input of speedGroup.querySelectorAll('input')) input.checked = Number(input.value) === settings.noteSpeed;
  showVideo.checked = settings.showVideo;
  noFail.checked = settings.noFail;
  offset.value = settings.offsetMs;
  touchMode.value = settings.touchControls;
  document.getElementById('offsetOut').textContent = `${settings.offsetMs > 0 ? '+' : ''}${settings.offsetMs}ms`;
}

function savePlay() {
  const speed = speedGroup.querySelector('input:checked');
  settings = {
    ...settings, noteSpeed: Number(speed?.value ?? settings.noteSpeed), showVideo: showVideo.checked, noFail: noFail.checked,
    offsetMs: Number(offset.value), touchControls: touchMode.value,
  };
  saveSettings(settings);
  settings = loadSettings();
  renderPlay();
}

speedGroup.addEventListener('change', savePlay);
showVideo.addEventListener('change', savePlay);
noFail.addEventListener('change', savePlay);
offset.addEventListener('input', savePlay);
touchMode.addEventListener('change', savePlay);

document.getElementById('resetBtn').addEventListener('click', () => {
  settings = resetSettings();
  stopListening('기본값(← ↓ ↑ →)으로 되돌렸어요.', 'ok');
  renderPlay();
});

// ── 스킨 장착 (보유한 스킨만 목록에. 기본 스킨은 항상 보유) ──
const skinRepo = createLocalSkinRepository();
const skinSelects = [[SKIN_TYPES.UI, 'uiSkin', 'uiSkinId'], [SKIN_TYPES.RHYTHM_BAR, 'rhythmSkin', 'rhythmBarSkinId']];

function renderSkins() {
  const equipped = equippedSkins(skinRepo);
  const owned = ownedSkinIds(skinRepo).map(id => getSkin(id));
  for (const [type, id, field] of skinSelects) {
    const select = document.getElementById(id);
    select.replaceChildren(...owned.filter(s => s.type === type).map(s => Object.assign(document.createElement('option'), { value: s.id, textContent: s.name })));
    select.value = equipped[field];
  }
}

for (const [type, id] of skinSelects) {
  document.getElementById(id).addEventListener('change', e => {
    const out = equipSkin(type, e.target.value, skinRepo);
    document.getElementById('skinStatus').textContent = out.ok ? '장착했어요. 다음 화면부터 적용돼요.' : EQUIP_ERRORS[out.error];
    if (out.ok) applyUiSkin();
    renderSkins();
  });
}

renderKeys();
renderPlay();
renderSkins();
