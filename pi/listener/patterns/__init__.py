"""The board's idle patterns (pi/README.md, "Idle patterns").

Each pattern is a module here with one Pattern subclass (common.py has the
interface and the shared grid, gamma and palette); idle.py registers them in
PATTERNS and has Idle, which the renderer draws from. To add one: write the
module, add its class to PATTERNS in idle.py, and pi/tests/test_patterns.py
checks it like the others.
"""
from .idle import CROSSFADE, NAMES, PATTERNS, TOUR_S, Idle, Plan, config_plans  # noqa: F401
