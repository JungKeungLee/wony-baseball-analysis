"""Seed-locked bat detection with short optical flow and temporal association.

The manual seed identifies the rendered bat.  Later detections may only be
associated while that seed-locked track is alive.  Wrist hints can rank image
detections, but never create or replace a bat location.
"""
from __future__ import annotations

import cv2
import numpy as np


SOURCE = "manual_bat_seed_detection_flow_association_v2"


def _polygon(axis, width):
    delta = axis[0] - axis[1]
    length = float(np.linalg.norm(delta))
    normal = np.array([-delta[1], delta[0]], dtype=np.float32) / length
    return np.array([
        axis[0] + normal * width / 2,
        axis[1] + normal * width / 3,
        axis[1] - normal * width / 3,
        axis[0] - normal * width / 2,
    ], dtype=np.float32)


def _angle_distance(a, b):
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    denominator = max(float(np.linalg.norm(a) * np.linalg.norm(b)), 1e-6)
    return float(np.degrees(np.arccos(np.clip(abs(float(np.dot(a, b))) / denominator, 0, 1))))


def _circular_hue_distance(values, center):
    difference = np.abs(values.astype(np.float32) - float(center))
    return np.minimum(difference, 180 - difference)


class HybridBatTracker:
    """Track one manually identified rendered bat without automatic re-ID."""

    def __init__(self, tip, handle, width, *, max_flow_only=1):
        self.axis = np.asarray([tip, handle], dtype=np.float32)
        self.length = float(np.linalg.norm(self.axis[0] - self.axis[1]))
        self.width = float(width)
        if self.length < 20 or not 2 <= self.width <= self.length * .3:
            raise ValueError("Nondegenerate manual rendered-bat axis/width required")
        self.polygon = _polygon(self.axis, self.width)
        self.status = "uninitialized"
        self.reason = None
        self.previous_gray = None
        self.previous_frame = None
        self.previous_points = None
        self.velocity = np.zeros((2, 2), dtype=np.float32)
        self.hue = None
        self.hue_tolerance = None
        self.saturation_floor = None
        self.value_floor = None
        self.missing = 0
        self.flow_only = 0
        self.max_flow_only = int(max_flow_only)

    def _record(self, confidence=0, *, method=None, candidate_count=0,
                motion_support=None, wrist_used=False, detected=False,
                detection_source=None):
        visible = self.status in ("tracking", "low_confidence")
        orientation = None
        if visible:
            vector = self.axis[0] - self.axis[1]
            orientation = float(np.degrees(np.arctan2(vector[1], vector[0])))
        return {
            "status": self.status,
            "reason": self.reason,
            "estimated": True,
            "confidence": round(float(min(.85, max(0, confidence))), 3),
            "confidence_grade": "medium" if confidence >= .6 else "low",
            "tip_xy": self.axis[0].tolist() if visible else None,
            "handle_xy": self.axis[1].tolist() if visible else None,
            "shaft_reference_xy": self.axis[1].tolist() if visible else None,
            "path_point_xy": self.axis[0].tolist() if visible else None,
            "orientation_degrees_image": orientation,
            "polygon": self.polygon.tolist() if visible else None,
            "tracking_method": method,
            "detection_source": detection_source,
            "image_detection_supported": bool(detected),
            "candidate_count": int(candidate_count),
            "motion_support": None if motion_support is None else round(float(motion_support), 3),
            "wrist_constraint_used": bool(wrist_used),
            "wrist_fallback_used": False,
            "automatic_reidentification": False,
            "source": SOURCE,
            "coordinate_space": "source_pixels",
            "bat_speed": None,
            "accuracy_verified": False,
        }

    def lose(self, reason):
        self.status = "tracking_lost"
        self.reason = reason
        return self._record()

    def _learn_appearance(self, frame):
        mask = np.zeros(frame.shape[:2], dtype=np.uint8)
        cv2.fillConvexPoly(mask, np.int32(self.polygon), 255)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        pixels = hsv[mask > 0]
        usable = pixels[(pixels[:, 1] >= 25) & (pixels[:, 2] >= 35)]
        if len(usable) < 20:
            raise ValueError("Manual bat seed has insufficient visible color support")
        histogram = np.bincount(usable[:, 0], weights=(usable[:, 1] / 255) * (usable[:, 2] / 255), minlength=180)
        self.hue = int(np.argmax(histogram))
        near = usable[_circular_hue_distance(usable[:, 0], self.hue) <= 18]
        if len(near) < 20:
            raise ValueError("Manual bat seed appearance is ambiguous")
        spread = float(np.percentile(_circular_hue_distance(near[:, 0], self.hue), 90))
        self.hue_tolerance = float(np.clip(spread + 5, 7, 20))
        self.saturation_floor = float(max(20, np.percentile(near[:, 1], 8) - 35))
        self.value_floor = float(max(28, np.percentile(near[:, 2], 8) - 45))

    def _mask(self, frame, search_bbox):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hue, saturation, value = cv2.split(hsv)
        mask = ((_circular_hue_distance(hue, self.hue) <= self.hue_tolerance) &
                (saturation >= self.saturation_floor) & (value >= self.value_floor)).astype(np.uint8) * 255
        allowed = np.zeros_like(mask)
        x, y, w, h = search_bbox
        allowed[y:y + h, x:x + w] = 255
        mask = cv2.bitwise_and(mask, allowed)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        return mask

    def _flow_prediction(self, gray):
        if self.previous_gray is None:
            return self.axis.copy(), None
        mask = np.zeros(self.previous_gray.shape, dtype=np.uint8)
        cv2.fillConvexPoly(mask, np.int32(self.polygon), 255)
        points = cv2.goodFeaturesToTrack(self.previous_gray, 60, .008, 3, mask=mask, blockSize=3)
        if points is None or len(points) < 4:
            return self.axis + self.velocity, None
        current, ok, _ = cv2.calcOpticalFlowPyrLK(
            self.previous_gray, gray, points, None, winSize=(41, 41), maxLevel=4,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
        if current is None:
            return self.axis + self.velocity, None
        back, back_ok, _ = cv2.calcOpticalFlowPyrLK(
            gray, self.previous_gray, current, None, winSize=(41, 41), maxLevel=4,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
        if back is None:
            return self.axis + self.velocity, None
        error = np.linalg.norm(points.reshape(-1, 2) - back.reshape(-1, 2), axis=1)
        valid = ok.ravel().astype(bool) & back_ok.ravel().astype(bool) & (error <= 3)
        if valid.sum() < 4:
            return self.axis + self.velocity, None
        old = points.reshape(-1, 2)[valid]
        new = current.reshape(-1, 2)[valid]
        matrix, inliers = cv2.estimateAffinePartial2D(old, new, method=cv2.RANSAC, ransacReprojThreshold=3)
        if matrix is None or inliers is None or inliers.sum() < 4:
            return self.axis + self.velocity, None
        predicted = self.axis @ matrix[:, :2].T + matrix[:, 2]
        quality = float(inliers.mean() * np.clip(1 - np.median(error[valid]) / 3, 0, 1))
        return predicted.astype(np.float32), quality

    def _candidates(self, frame, mask, predicted, wrist_hint):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        candidates = []
        previous_vector = predicted[0] - predicted[1]
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < max(10, self.length * self.width * .06) or len(contour) < 5:
                continue
            points = contour.reshape(-1, 2).astype(np.float32)
            line = cv2.fitLine(points, cv2.DIST_L2, 0, .01, .01).reshape(-1)
            direction = line[:2] / max(float(np.linalg.norm(line[:2])), 1e-6)
            center = line[2:]
            projection = (points - center) @ direction
            endpoints = np.array([center + direction * projection.max(), center + direction * projection.min()])
            long = float(projection.max() - projection.min())
            thickness = max(area / max(long, 1), 1)
            if not self.length * .38 <= long <= self.length * 1.8 or long / thickness < 1.8:
                continue
            # A visible wrist may choose between two detected endpoints.  It can
            # never create an endpoint or rescue a missing image candidate.
            handle_anchor = np.asarray(wrist_hint,dtype=np.float32) if wrist_hint is not None else predicted[1]
            if np.linalg.norm(endpoints[0] - handle_anchor) < np.linalg.norm(endpoints[1] - handle_anchor):
                endpoints = endpoints[::-1]
            handle_distance = float(np.linalg.norm(endpoints[1] - predicted[1]) / self.length)
            wrist_distance = (float(np.linalg.norm(endpoints[1] - handle_anchor) / self.length)
                              if wrist_hint is not None else None)
            if wrist_distance is not None and wrist_distance > 1.25:
                continue
            center_distance = float(np.linalg.norm(endpoints.mean(axis=0) - predicted.mean(axis=0)) / self.length)
            orientation_distance = _angle_distance(endpoints[0] - endpoints[1], previous_vector)
            shape = float(np.clip(1 - abs(long / self.length - 1) / .8, 0, 1))
            association = float(np.clip(1 - handle_distance / 1.25, 0, 1) * .55 +
                                np.clip(1 - center_distance / 1.5, 0, 1) * .25 +
                                np.clip(1 - orientation_distance / 90, 0, 1) * .2)
            candidates.append({"axis": endpoints.astype(np.float32), "area": area, "length": long,
                               "shape": shape, "association": association,
                               "wrist": float(np.clip(1-wrist_distance/1.25,0,1)) if wrist_distance is not None else 0,
                               "detection_source":"seed_appearance_component"})
        return candidates

    def _edge_candidates(self, frame, search_bbox, predicted, wrist_hint):
        gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
        edges=cv2.Canny(gray,60,160)
        allowed=np.zeros_like(edges);x,y,w,h=search_bbox;allowed[y:y+h,x:x+w]=255
        edges=cv2.bitwise_and(edges,allowed)
        lines=cv2.HoughLinesP(edges,1,np.pi/180,max(12,int(self.length*.16)),
                              minLineLength=max(12,int(self.length*.34)),maxLineGap=max(4,int(self.width*2.5)))
        if lines is None:return []
        candidates=[];anchor=np.asarray(wrist_hint,dtype=np.float32) if wrist_hint is not None else predicted[1]
        for line in lines[:,0]:
            endpoints=np.asarray([line[:2],line[2:]],dtype=np.float32)
            long=float(np.linalg.norm(endpoints[0]-endpoints[1]))
            if not self.length*.34<=long<=self.length*1.85:continue
            if np.linalg.norm(endpoints[0]-anchor)<np.linalg.norm(endpoints[1]-anchor):endpoints=endpoints[::-1]
            wrist_distance=(float(np.linalg.norm(endpoints[1]-anchor)/self.length) if wrist_hint is not None else None)
            if wrist_distance is not None and wrist_distance>1.0:continue
            handle_distance=float(np.linalg.norm(endpoints[1]-predicted[1])/self.length)
            center_distance=float(np.linalg.norm(endpoints.mean(axis=0)-predicted.mean(axis=0))/self.length)
            orientation_distance=_angle_distance(endpoints[0]-endpoints[1],predicted[0]-predicted[1])
            association=float(np.clip(1-handle_distance/1.5,0,1)*.5+
                              np.clip(1-center_distance/1.75,0,1)*.25+
                              np.clip(1-orientation_distance/90,0,1)*.25)
            shape=float(np.clip(1-abs(long/self.length-1),0,1))
            candidates.append({"axis":endpoints,"area":long*self.width*.5,"length":long,"shape":shape,
                "association":association,"wrist":float(np.clip(1-wrist_distance,0,1)) if wrist_distance is not None else 0,
                "detection_source":"edge_line_near_visible_wrist"})
        candidates.sort(key=lambda item:item['association']*.35+item['shape']*.2+item['wrist']*.45,reverse=True)
        # Parallel bat edges are one object candidate, not independent votes.
        unique=[]
        for candidate in candidates:
            if any(np.linalg.norm(candidate['axis'].mean(axis=0)-other['axis'].mean(axis=0))<self.width*1.5 and
                   _angle_distance(candidate['axis'][0]-candidate['axis'][1],other['axis'][0]-other['axis'][1])<12
                   for other in unique):continue
            unique.append(candidate)
        return unique

    def update(self, frame, *, search_bbox=None, wrist_hint=None):
        if self.status == "tracking_lost":
            return self._record()
        height, width = frame.shape[:2]
        if search_bbox is None:
            search_bbox = (0, 0, width, height)
        x, y, w, h = map(int, search_bbox)
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
            return self.lose("Expanded bat search ROI outside source")
        if np.any(self.polygon < 0) or np.any(self.polygon[:, 0] >= width) or np.any(self.polygon[:, 1] >= height):
            return self.lose("Seed polygon outside source")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if self.hue is None:
            try:
                self._learn_appearance(frame)
            except ValueError as error:
                return self.lose(str(error))
        initializing=self.previous_gray is None
        predicted, flow_quality = self._flow_prediction(gray)
        mask = self._mask(frame, search_bbox)
        candidates = self._candidates(frame, mask, predicted, None if initializing else wrist_hint)
        if initializing:
            candidates=[candidate for candidate in candidates
                        if np.linalg.norm(candidate['axis'].mean(axis=0)-predicted.mean(axis=0))<=self.length*.5 and
                        _angle_distance(candidate['axis'][0]-candidate['axis'][1],predicted[0]-predicted[1])<=35]
        else:
            candidates=[candidate for candidate in candidates
                        if np.linalg.norm(candidate['axis'].mean(axis=0)-self.axis.mean(axis=0))<=self.length*.7]
        for candidate in candidates:
            candidate["score"] = (candidate["association"]*(.35 if wrist_hint is not None and not initializing else .7)+
                                  candidate["shape"]*.3+candidate["wrist"]*(.35 if wrist_hint is not None and not initializing else 0))
        candidates.sort(key=lambda item: item["score"], reverse=True)
        accepted = candidates and candidates[0]["score"] >= .38
        if not accepted and wrist_hint is not None:
            candidates=self._edge_candidates(frame,search_bbox,predicted,wrist_hint)
            candidates=[candidate for candidate in candidates
                        if np.linalg.norm(candidate['axis'].mean(axis=0)-self.axis.mean(axis=0))<=self.length*.7]
            for candidate in candidates:
                candidate['score']=candidate['association']*.35+candidate['shape']*.2+candidate['wrist']*.45
            candidates.sort(key=lambda item:item['score'],reverse=True)
            accepted=bool(candidates and candidates[0]['score']>=.42)
        ambiguous = len(candidates) > 1 and candidates[0]["score"] - candidates[1]["score"] < .04
        motion_support = None
        if accepted:
            axis = candidates[0]["axis"]
            if self.previous_frame is not None:
                difference = cv2.absdiff(frame, self.previous_frame)
                support = np.zeros(frame.shape[:2], np.uint8)
                candidate_polygon = _polygon(axis, max(self.width, candidates[0]["area"] / max(candidates[0]["length"], 1)))
                cv2.fillConvexPoly(support, np.int32(candidate_polygon), 255)
                pixels = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)[support > 0]
                motion_support = float(np.mean(pixels >= 12)) if len(pixels) else 0
            old_axis = self.axis.copy()
            self.axis = axis
            observed_width = float(np.clip(candidates[0]["area"] / max(candidates[0]["length"], 1), 2, self.width * 2))
            self.polygon = _polygon(self.axis, observed_width)
            self.velocity = np.clip(self.axis - old_axis, -self.length * 1.5, self.length * 1.5)
            self.status = "low_confidence" if ambiguous else "tracking"
            self.reason = "Multiple appearance candidates similarly associated" if ambiguous else None
            self.missing = 0
            self.flow_only = 0
            confidence = .3 + candidates[0]["score"] * .45
            if motion_support is not None:
                confidence += min(.1, motion_support * .1)
            method=("appearance_detection_temporal_association" if candidates[0]['detection_source']=='seed_appearance_component'
                    else "edge_detection_temporal_association")
            record = self._record(confidence, method=method,
                                  candidate_count=len(candidates), motion_support=motion_support,
                                  wrist_used=wrist_hint is not None, detected=True,
                                  detection_source=candidates[0]['detection_source'])
        elif flow_quality is not None and flow_quality >= .35 and self.flow_only < self.max_flow_only:
            old_axis = self.axis.copy()
            self.axis = predicted
            self.polygon = _polygon(self.axis, self.width)
            self.velocity = np.clip(self.axis - old_axis, -self.length * 1.5, self.length * 1.5)
            self.status = "low_confidence"
            self.reason = "Appearance detection absent; one-frame optical-flow support only"
            self.missing += 1
            self.flow_only += 1
            record = self._record(.25 + flow_quality * .25, method="short_term_optical_flow",
                                  candidate_count=len(candidates), wrist_used=False, detected=False)
        else:
            reason = "Appearance candidate ambiguous or absent after short optical-flow limit"
            if flow_quality is None:
                reason += "; motion blur/texture support insufficient"
            return self.lose(reason)
        self.previous_gray = gray
        self.previous_frame = frame.copy()
        return record


def expanded_search_bbox(target_bbox, frame_shape, margin):
    """Expand a WONY target lock for bat reach while staying in source bounds."""
    x, y, w, h = map(float, target_bbox)
    height, width = frame_shape[:2]
    horizontal = w * float(margin)
    vertical = h * min(float(margin), .5)
    left = max(0, int(np.floor(x - horizontal)))
    top = max(0, int(np.floor(y - vertical)))
    right = min(width, int(np.ceil(x + w + horizontal)))
    bottom = min(height, int(np.ceil(y + h + vertical)))
    return left, top, right - left, bottom - top
