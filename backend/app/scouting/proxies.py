"""Image-plane observations only; no physical speed, contact, force or grades."""
import numpy as np
from app.analysis.shared.pose_metrics import pose_rows
from app.analysis.shared.confidence import metric

VERSION='tools-image-proxies-v1'


def calculate(result, rows=None):
    if rows is None:
        rows=pose_rows(result.get('pose',[]),result.get('throwing_hand','right'))
    if result.get('status')!='completed' or len(rows)<5 or rows[-1]['t']-rows[0]['t']<.4:
        return {}
    t=np.array([r['t'] for r in rows]);dt=np.diff(t)
    # A derivative across an occlusion gap is not a meaningful motion estimate.
    continuous=np.max(dt)<=.25
    torso=float(np.median([r['torso'] for r in rows]))
    hips=np.array([r['hips'] for r in rows]);xy=np.array([r['xy'] for r in rows])
    visibility=min(r['visibility'] for r in rows);output={}
    def put(key,value,unit,method,cap=.3):
        output[key]=metric(float(value),unit,VERSION+': '+method,min(visibility*.6,cap))
    offsets=np.array([r['balance'] for r in rows])
    put('balance_variability_proxy',np.std(offsets),'torso_lengths','SD of hip offset from ankle midpoint; image balance, not force',.45)
    put('body_control_proxy',np.max(np.linalg.norm(hips-hips[0],axis=1))/torso,'torso_lengths','Maximum projected hip travel; camera-sensitive')
    put('range_proxy',np.linalg.norm(np.ptp(hips,axis=0))/torso,'torso_lengths','Diagonal extent of projected hip positions; not ground coverage',.25)
    put('stride_width_proxy',np.median(np.linalg.norm(xy[:,27]-xy[:,28],axis=1))/torso,'torso_lengths','Median projected ankle separation; not physical stride length',.25)
    put('footwork_path_proxy',np.sum(np.linalg.norm(np.diff(xy[:,[27,28]],axis=0),axis=2))/torso,'torso_lengths','Sum of ankle path lengths; not step count',.3)
    arm=xy[:,16 if result.get('throwing_hand','right')=='right' else 15]-xy[:,12 if result.get('throwing_hand','right')=='right' else 11]
    put('arm_elevation_proxy',np.median(np.degrees(np.arctan2(-arm[:,1],np.abs(arm[:,0])))),
        'degrees','Median declared throwing-side wrist elevation from shoulder in image; throw unverified',.3)
    for name, key in [('elbow_mechanics_proxy','elbow'), ('shoulder_mechanics_proxy','shoulder')]:
        angles=[r[key] for r in rows if r.get(key) is not None]
        if angles:
            put(name,np.median(angles),'degrees','Median 2D arm joint geometry; throw and release unverified',.3)
    hips_line=xy[:,24]-xy[:,23];shoulder_line=xy[:,12]-xy[:,11]
    if np.all(np.linalg.norm(hips_line,axis=1)>.01*torso) and np.all(np.linalg.norm(shoulder_line,axis=1)>.01*torso):
        a=np.arctan2(hips_line[:,1],hips_line[:,0]);b=np.arctan2(shoulder_line[:,1],shoulder_line[:,0])
        difference=np.arctan2(np.sin(b-a),np.cos(b-a))
        put('hip_shoulder_separation_proxy',np.max(np.abs(np.degrees(difference))),'degrees','Projected shoulder/hip line separation; not axial 3D separation',.2)
    if continuous:
        hands=(xy[:,15]+xy[:,16])/2
        relative=(hands-hips)/torso
        speed=np.linalg.norm(np.diff(relative,axis=0),axis=1)/dt
        put('hand_speed_proxy',np.max(speed),'torso_lengths_per_second','Peak body-relative hand-center speed; not bat or ball speed',.25)
        if len(speed)>=3:
            acceleration=np.diff(speed)/((dt[:-1]+dt[1:])/2)
            put('hand_acceleration_proxy',np.max(np.abs(acceleration)),'torso_lengths_per_second_squared','Peak change of projected hand speed; sampling/noise sensitive',.2)
        wrist=xy[:,16 if result.get('throwing_hand','right')=='right' else 15]
        put('arm_path_proxy',np.sum(np.linalg.norm(np.diff((wrist-hips)/torso,axis=0),axis=1)),
            'torso_lengths','Total throwing-side wrist path relative to hip; not verified throwing arc',.25)
        wrist_speed=np.linalg.norm(np.diff((wrist-hips)/torso,axis=0),axis=1)/dt
        put('arm_speed_proxy',np.max(wrist_speed),'torso_lengths_per_second','Throwing-side wrist speed relative to hip; throw/ball release unverified',.25)
        torso_axis=np.array([r['shoulders']-r['hips'] for r in rows])
        orientation=np.unwrap(np.arctan2(torso_axis[:,1],torso_axis[:,0]))
        put('trunk_orientation_speed_proxy',np.max(np.abs(np.diff(np.degrees(orientation))/dt)),'degrees_per_second','Projected torso-axis angular speed; not axial trunk rotation',.2)
    if result.get('role')=='baserunning' and continuous:
        velocity=np.diff(hips,axis=0)/torso/dt[:,None]
        speed=np.linalg.norm(velocity,axis=1)
        displacement=float(np.linalg.norm(hips[-1]-hips[0])/torso)
        if displacement>.2:
            put('running_speed_proxy',np.median(speed),'torso_lengths_per_second','Median projected hip speed; camera-sensitive, no distance calibration',.25)
            if np.mean(speed)>.05:
                put('running_consistency_proxy',np.std(speed)/np.mean(speed),'ratio',
                    'Coefficient of variation of projected hip speed within clip; not multi-run consistency',.2)
            if len(speed)>=3:
                acceleration=np.diff(speed)/((dt[:-1]+dt[1:])/2)
                put('running_acceleration_proxy',np.max(acceleration),'torso_lengths_per_second_squared','Projected hip speed change, not physical acceleration',.2)
                put('deceleration_proxy',max(0,-np.min(acceleration)),'torso_lengths_per_second_squared','Projected slowdown only',.2)
            eligible=np.linalg.norm(velocity,axis=1)>.2
            directions=np.arctan2(velocity[eligible,1],velocity[eligible,0])
            if len(directions)>=3:
                put('direction_change_proxy',np.ptp(np.degrees(np.unwrap(directions))),'degrees','Image-plane travel direction range; not calibrated field direction',.2)
        # Alternating foot oscillations must have amplitude and two full cycles.
        signal=(xy[:,27,1]-xy[:,28,1])/torso
        peaks=[i for i in range(1,len(signal)-1) if signal[i]>signal[i-1] and signal[i]>=signal[i+1] and signal[i]>.1]
        troughs=[i for i in range(1,len(signal)-1) if signal[i]<signal[i-1] and signal[i]<=signal[i+1] and signal[i]<-.1]
        if len(peaks)>=3 and all(any(a<j<b for j in troughs) for a,b in zip(peaks,peaks[1:])):
            periods=np.diff(t[peaks])
            if np.all((periods>=.25)&(periods<=2.5)):
                frequency=1/float(np.mean(periods))
                put('stride_frequency_proxy',frequency,'cycles_per_second','Alternating projected ankle cycle frequency; foot contact unverified',.3)
                put('cadence_proxy',frequency*120,'estimated_steps_per_minute','Two steps per observed alternating ankle cycle; foot contacts unverified',.3)
    return output
