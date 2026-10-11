from app.analysis.shared.confidence import missing


def details():
    return missing(['ground_ball','double_play_preparation','first_base_throw_preparation','base_cover'],
                   'Requires ball/field/base tracking; not supported by pose-only analysis')
