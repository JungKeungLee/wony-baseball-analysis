import cv2
from .joints import JOINTS, EDGES


def draw_overlay(frame, sample, timestamp, labels=(), angles=None, highlights=()):
    image = cv2.resize(frame, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
    height, width = image.shape[:2]
    danger = {joint for h in highlights if h['confidence'] >= .75 for joint in h['joints']}
    if sample is not None:
        positions = {}
        for name, i in JOINTS.items():
            p = sample['landmarks'][i]
            if p['visibility'] >= .5:
                positions[name] = (int(p['x'] * width), int(p['y'] * height))
        for a, b in EDGES:
            if a in positions and b in positions:
                cv2.line(image, positions[a], positions[b], (188, 217, 55), 3, cv2.LINE_AA)
        for name, point in positions.items():
            color = (65, 75, 235) if name in danger else (210, 255, 90)
            cv2.circle(image, point, 5, color, -1, cv2.LINE_AA)
            cv2.circle(image, point, 7, (35, 45, 30), 1, cv2.LINE_AA)
    text = [f'{timestamp:.2f}s | 2D ESTIMATED']
    text.extend(labels)
    if sample is None:
        text.append('No visible pose - skeleton unavailable')
    for name, m in (angles or {}).items():
        if m['value'] is not None:
            text.append(f"{name}: {m['value']:.1f} deg  ({m['confidence_grade']})")
    panel_height = min(height, 18 * len(text) + 10)
    panel_width = min(width, max(cv2.getTextSize(line, cv2.FONT_HERSHEY_SIMPLEX, .38, 1)[0][0] for line in text)+16)
    area = image[:panel_height, :panel_width].copy()
    image[:panel_height, :panel_width] = cv2.addWeighted(area, .3, area * 0, .7, 0)
    for index, line in enumerate(text):
        cv2.putText(image, line, (8, 16+index*18), cv2.FONT_HERSHEY_SIMPLEX,
                    .38, (230, 243, 242), 1, cv2.LINE_AA)
    return image
