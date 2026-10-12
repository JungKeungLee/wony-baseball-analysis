import cv2
import mediapipe as mp


def extract_pose(frames, *, model_complexity=1):
    samples = []
    with mp.solutions.pose.Pose(
        static_image_mode=False, model_complexity=model_complexity,
        min_detection_confidence=0.5, min_tracking_confidence=0.5,
    ) as detector:
        for timestamp, frame in frames:
            result = detector.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if result.pose_landmarks:
                samples.append({
                    'estimated': True,
                    'source': 'mediapipe_pose',
                    'time_seconds': timestamp,
                    'aspect_ratio': frame.shape[1] / frame.shape[0],
                    'landmarks': [
                        {'x': p.x, 'y': p.y, 'z': p.z, 'visibility': p.visibility}
                        for p in result.pose_landmarks.landmark
                    ],
                })
    return samples
