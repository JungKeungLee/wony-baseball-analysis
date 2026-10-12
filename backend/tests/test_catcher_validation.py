"""Catcher checks driven by the real WONY catcher clips (Windows validation, 2026-10-13).

Real findings these guard: the tracker drops WONY at the catch / dirt-ball moment and must not
pick anyone else; crouching alone produced blocking candidates on every clip; mitt_* values are
glove-side wrist observations; no throw/release evidence; PLAYER TOOLS stay null.
"""
import numpy as np
import pytest
from app.analysis.engine import analyze_role
from app.analysis.shared.role_classifier import classify_role
from app.analysis.shared.pose_metrics import pose_rows
from app.validation.quality import restrict_3d
from app.validation.target import ManualTargetTracker, TargetSelection


def crouch(n=8, hip_y=.7, hand=1.0, vis=.95, hip_path=None, wrist_vis=None):
    """Catcher-like 2D pose; hip_y .65-.7 = deep crouch (~78-102 deg knee flexion), .6 = shallow (~63 deg)."""
    samples = []
    for k in range(n):
        p = [dict(x=.5, y=.5, z=0, visibility=vis) for _ in range(33)]
        y = hip_path[k] if hip_path else hip_y
        for i, (x, yy) in {0: (.5, .35), 11: (.44, .45), 12: (.56, .45), 13: (.42, .55), 14: (.58, .55),
                           15: (.46 + hand * k * .01, .62), 16: (.54, .62), 23: (.46, y), 24: (.54, y),
                           25: (.36, .72), 26: (.64, .72), 27: (.42, .86), 28: (.58, .86)}.items():
            p[i].update(x=x, y=yy)
        if wrist_vis is not None:
            p[15]['visibility'] = wrist_vis[k]  # glove hand hidden by the mitt
        samples.append(dict(time_seconds=k * .1, aspect_ratio=1, landmarks=p))
    return samples


# ---- catcher role context ----
def test_deep_crouch_can_be_catcher_but_shallow_stays_unknown():
    assert classify_role(crouch(hip_y=.68))['value'] == 'catcher'
    shallow = classify_role(crouch(hip_y=.6))  # like catcher-003 (45-69 deg): never forced to catcher
    assert shallow['value'] == 'unknown'


def test_low_visibility_crouch_is_not_promoted():
    # catcher-002: catcher candidate 0.77 but joint visibility caps confidence below 0.7 -> unknown
    result = classify_role(crouch(hip_y=.68, vis=.7))
    assert result['value'] == 'unknown' and result['candidates'][0]['role'] == 'catcher'


def test_sbo_pitcher_context_never_yields_catcher():
    context = {'sbo_pitcher': {'value': 'pitcher', 'confidence': .8, 'evidence_families': ['scene', 'pose_motion']}}
    assert classify_role(crouch(hip_y=.68), context)['value'] == 'unknown'  # conflicting evidence is withheld


def test_manual_hint_is_separate_from_automatic_role():
    samples = crouch(hip_y=.6)
    assert analyze_role(samples, 'catcher')['role'] == 'catcher'
    assert classify_role(samples)['value'] == 'unknown'


# ---- tracking: brief overlay grace, never switch to another avatar ----
class FakeTracker:
    def __init__(self, boxes): self.boxes = iter(boxes)
    def init(self, frame, bbox): pass
    def update(self, frame): return True, next(self.boxes)


def scene(box, glow=False):
    """Static background with a dark avatar at box; glow = catch flash / SBO overlay covering the body."""
    frame = np.full((300, 400, 3), 90, np.uint8)
    x, y, w, h = (int(round(v)) for v in box)
    frame[y:y+h, x:x+w] = (40, 40, 40)
    if glow:
        frame[y+h//6:y+5*h//6, x+w//6:x+5*w//6] = (255, 180, 0)
    return frame


def run(boxes, glows):
    selection = TargetSelection(confirmed_by_user=True, viewpoint='third_person', source_width=400, source_height=300, bbox=boxes[0])
    tracker = ManualTargetTracker(selection, factory=lambda: FakeTracker(boxes[1:]))
    return tracker, [tracker.update(scene(b, g), k * .1) for k, (b, g) in enumerate(zip(boxes, glows))]


BOX = (100, 50, 60, 120)


def test_short_overlay_occlusion_recovers_same_target():
    tracker, states = run([BOX] * 6, [False, False, True, True, False, False])
    assert [s['status'] for s in states] == ['confirmed', 'tracking', 'temporary_occlusion', 'temporary_occlusion', 'tracking', 'tracking']
    for s in states[2:4]:  # held, never confirmed: no bbox, no pose, zero confidence, candidate only
        assert s['bbox'] is None and not s['analysis_allowed'] and s['confidence'] == 0 and s['candidate_bbox']
    assert tracker.lost_at is None and states[-1]['analysis_allowed']


def test_overlay_never_switches_to_another_candidate():
    other = (180, 50, 60, 120)  # a different avatar's box (IoU 0 with WONY)
    tracker, states = run([BOX, BOX, other, other, other], [False, False, True, False, False])
    assert states[2]['status'] == 'tracking_lost'
    assert all(s['bbox'] is None and not s['analysis_allowed'] for s in states[2:])  # good appearance later is ignored
    tracker.require_reidentification()
    assert tracker.status == 'reidentification_required'


def test_long_occlusion_is_lost():
    tracker, states = run([BOX] * 8, [False, False, True, True, True, True, True, False])
    assert [s['status'] for s in states[2:6]] == ['temporary_occlusion'] * 4  # 0.2..0.5s held (<= 0.35s grace)
    assert states[6]['status'] == 'tracking_lost' and 'grace' in states[6]['reason'] and states[7]['bbox'] is None


def test_target_crossing_during_overlay_is_not_followed():
    shifted = (112, 50, 60, 120)  # candidate slides toward a crossing avatar (> 5% of the diagonal)
    tracker, states = run([BOX, BOX, shifted, shifted], [False, False, True, False])
    assert states[2]['status'] == 'tracking_lost' and states[3]['bbox'] is None


@pytest.mark.parametrize('direction,status', [(1, 'temporary_occlusion'), (-1, 'tracking_lost')])
def test_prediction_limits_the_search_region(direction, status):
    step = 6  # WONY moving right ~4.5% of the diagonal per sample
    path = [(100 + k * step, 50, 60, 120) for k in range(4)]
    candidate = (path[-1][0] + direction * step, 50, 60, 120)  # follows vs. reverses the motion during the overlay
    tracker, states = run(path + [candidate], [False] * 4 + [True])
    assert states[4]['status'] == status


# ---- catcher pose profile ----
def test_glove_hand_hidden_frames_are_not_used():
    hidden = [.9, .9, .3, .3, .3, .3, .9, .9]
    rows = pose_rows(crouch(wrist_vis=hidden))
    assert len(rows) == 4  # frames with the mitt-covered wrist below 0.6 are excluded, not filled
    result = analyze_role(crouch(n=8, wrist_vis=[.3] * 8), 'catcher')
    assert result['usable_pose_frames'] == 0 and result['metrics']['knee_flexion']['value'] is None


# ---- glove / hand separation ----
def test_mitt_values_are_wrist_observations_not_glove_tracking():
    metrics = analyze_role(crouch(), 'catcher')['metrics']
    assert metrics['glove_tracking']['value'] is None and 'detector' in metrics['glove_tracking']['reason']
    for key in ('mitt_start_position', 'mitt_movement'):
        assert 'wrist' in metrics[key]['method'].lower()


# ---- blocking candidate false positive ----
@pytest.mark.parametrize('hip_path', [
    None,                                        # steady deep crouch (catcher-001/002)
    [.6, .6, .62, .64, .66, .68, .7, .7],        # settling into the stance from higher (catcher-003)
])
def test_crouch_is_not_a_blocking_candidate(hip_path):
    blocking = analyze_role(crouch(hip_path=hip_path), 'catcher')['blocking']
    assert blocking['low_blocking_posture']['value'] is None and blocking['blocking_success']['value'] is None


# ---- throwing / release ----
def test_throw_and_release_stay_unverified():
    result = analyze_role(crouch(hip_path=[.7, .7, .68, .64, .6, .56, .52, .5]), 'catcher')  # standing up after a catch
    for key in ('throwing_preparation', 'transition_time', 'throw_start_time', 'second_base_preparation'):
        assert result['throwing_transition'][key]['value'] is None
    assert all(e['type'] != 'release' for e in result['events'])


# ---- low-quality pose -> 3D limited ----
def test_low_quality_frames_get_no_3d():
    samples = crouch(wrist_vis=[.9, .3, .9, .3, .9, .3, .9, .3])
    visualization = {'pose3d': {'frames': [{'frame': i, 'timestamp': s['time_seconds'], 'confidence': .3,
                                            'joints': {'head': [0, 1, 0]}, 'joint_confidence': {}} for i, s in enumerate(samples)]}}
    available = restrict_3d(visualization, samples)
    assert available == 4 and all(not f['joints'] for f in visualization['pose3d']['frames'][1::2])


# ---- PLAYER TOOLS stay null ----
def test_catcher_player_tools_and_assessments_have_no_score(tmp_path, monkeypatch):
    # Full pipeline (synthetic catcher clip): observations may exist, scores must not.
    monkeypatch.setenv('WONY_DATA_DIR', str(tmp_path / 'results'))
    from fastapi.testclient import TestClient
    from app.main import app
    report = TestClient(app).post('/api/demo/catcher').json()['scouting_report']
    assert all(tool['score'] is None for tool in report['player_tools'].values())
    assessments = report.get('role_summary', {}).get('assessments', {})
    assert assessments and all(item.get('score') is None for item in assessments.values())
