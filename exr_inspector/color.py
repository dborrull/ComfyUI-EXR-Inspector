# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""EXR chromaticities -> 3x3 matrix to linear Rec.709 / sRGB primaries (D65)."""

import numpy as np

REC709 = (0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290)

# Named primaries, for labels in the viewer
NAMED = {
    "Rec.709 / sRGB": REC709,
    "ACES AP0": (0.7347, 0.2653, 0.0, 1.0, 0.0001, -0.077, 0.32168, 0.33767),
    "ACEScg AP1": (0.713, 0.293, 0.165, 0.830, 0.128, 0.044, 0.32168, 0.33767),
    "Rec.2020": (0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290),
    "P3-D65": (0.680, 0.320, 0.265, 0.690, 0.150, 0.060, 0.3127, 0.3290),
}

_BRADFORD = np.array([[0.8951, 0.2664, -0.1614],
                      [-0.7502, 1.7135, 0.0367],
                      [0.0389, -0.0685, 1.0296]])


def _xyz(x, y):
    return np.array([x / y, 1.0, (1.0 - x - y) / y])


def rgb_to_xyz(c):
    rx, ry, gx, gy, bx, by, wx, wy = c
    m = np.stack([_xyz(rx, ry), _xyz(gx, gy), _xyz(bx, by)], axis=1)
    s = np.linalg.solve(m, _xyz(wx, wy))
    return m * s


def _adapt(src_white, dst_white):
    a = _BRADFORD @ _xyz(*src_white)
    b = _BRADFORD @ _xyz(*dst_white)
    return np.linalg.inv(_BRADFORD) @ np.diag(b / a) @ _BRADFORD


def to_rec709_matrix(chroma):
    """3x3 row-major matrix (list of 9 floats) taking linear RGB with these
    chromaticities to linear Rec.709 (Bradford adaptation to D65)."""
    if chroma is None:
        return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    chroma = tuple(float(v) for v in chroma)
    m = rgb_to_xyz(chroma)
    if not np.allclose(chroma[6:], REC709[6:], atol=1e-4):
        m = _adapt(chroma[6:], REC709[6:]) @ m
    m = np.linalg.inv(rgb_to_xyz(REC709)) @ m
    return [float(v) for v in m.reshape(-1)]


def primaries_name(chroma):
    if chroma is None:
        return "Rec.709 / sRGB (assumed)"
    for name, ref in NAMED.items():
        if np.allclose(chroma, ref, atol=2e-3):
            return name
    return "custom"
