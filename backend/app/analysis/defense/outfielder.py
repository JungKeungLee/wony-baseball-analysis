from app.analysis.shared.confidence import missing


def details():
    return missing(['ball_judgment','landing_point_movement','advance_or_retreat','relay_direction'],
                   'Requires ball/field/target tracking; not supported by pose-only analysis')
