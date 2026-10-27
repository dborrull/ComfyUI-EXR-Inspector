# -*- coding: utf-8 -*-
"""Write two demo EXRs to try the viewer.
A: overscan, DWAA, float, layers rgba + depth.Z + N.
B: Blender names, multipart DWAB, graded, with a red patch.

    python tests/make_demo.py [output folder]     (default: tests/_data/demo)
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_backend import write_exr  # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "_data", "demo")
os.makedirs(out, exist_ok=True)

W, H, O = 960, 540, 20
y, x = np.mgrid[-O:H + O, -O:W + O].astype(np.float32)

# Background: ramp from -8 to +4 stops, colour bars at the bottom
bg = np.stack([2 ** ((x / W) * 12 - 8)] * 3, -1)
bars = np.array([(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 1, 1), (1, 0, 1), (1, 1, 1)], np.float32)
bg = np.where((y > H * 0.8)[..., None], bars[np.clip((x / W * 7).astype(int), 0, 6)] * 0.5, bg)

# Lit sphere with depth and normals; background depth = 1e10
cx, cy, r = W * 0.5, H * 0.42, H * 0.3
dx, dy = (x - cx) / r, (y - cy) / r
inside = dx * dx + dy * dy < 1
dz = np.sqrt(np.clip(1 - dx * dx - dy * dy, 0, 1))
N = np.stack([dx, -dy, dz], -1)
light = np.clip(N @ np.array([0.5, 0.6, 0.62], np.float32), 0, None)
rgb = np.where(inside[..., None], light[..., None] * np.array([1.6, 0.9, 0.5], np.float32) + 0.03, bg)
alpha = inside.astype(np.float32)
depth = np.where(inside, 5.0 - dz, np.float32(1e10))
N = np.where(inside[..., None], N, 0)
A = np.concatenate([rgb, alpha[..., None], depth[..., None], N], -1).astype(np.float32)
write_exr(os.path.join(out, "scene_a.exr"), [{
    "pixels": A, "names": ["R", "G", "B", "A", "depth.Z", "N.X", "N.Y", "N.Z"],
    "compression": "dwaa", "half": False, "x": -O, "y": -O, "full": (W, H)}])

B = A[O:-O, O:-O].copy()
B[..., :3] *= np.array([1.05, 1.0, 0.95], np.float32)
patch = (np.abs(x[O:-O, O:-O] - W * 0.7) < 30) & (np.abs(y[O:-O, O:-O] - H * 0.3) < 30)
B[patch, :3] = [4.0, 0.2, 0.2]
combined = ["ViewLayer.Combined." + c for c in "RGBA"]
write_exr(os.path.join(out, "scene_b.exr"), [
    {"pixels": np.ascontiguousarray(B[..., :4]), "names": combined, "compression": "dwab",
     "name": "beauty", "full": (W, H)},
    {"pixels": np.ascontiguousarray(B[..., 4:5]), "names": ["ViewLayer.Depth.Z"], "compression": "zip",
     "name": "depth", "half": False, "full": (W, H)}])
print("Wrote", os.path.join(out, "scene_a.exr"), "and scene_b.exr")
