import numpy as np


def angle(a, b, c):
    u, v = a - b, c - b
    denominator = np.linalg.norm(u) * np.linalg.norm(v)
    if denominator < 1e-8:
        return None
    return float(np.degrees(np.arccos(np.clip(np.dot(u, v) / denominator, -1, 1))))


def inclination(vector):
    return float(np.degrees(np.arctan2(vector[0], -vector[1])))
