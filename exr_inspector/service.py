# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""What the HTTP routes call. No ComfyUI imports, so it can be tested alone.

Sources are named by a string:
  file:<path>   a file; relative paths are looked up in input/, then output/
  tmp:<32 hex>  an IMAGE batch the node saved to temp/exr_inspector/
"""

import json
import os
import struct
import uuid
import warnings

import numpy as np

from .cache import ByteLRU
from .exr_io import FileSource, SourceError, TensorSource
from .paths import TMP_ID

MAGIC = b"EXRI"


def _json_safe(v):
    """NaN / inf are not valid JSON: send them as strings."""
    if isinstance(v, float) and not np.isfinite(v):
        return "nan" if np.isnan(v) else ("inf" if v > 0 else "-inf")
    return v


class Inspector(object):
    def __init__(self, policy, tmp_dir, cache_mb=2048, max_texture=4096):
        self.policy = policy
        self.tmp_dir = tmp_dir
        self.max_texture = int(max_texture)
        self.pixels_cache = ByteLRU(int(cache_mb) * 1024 * 1024)
        self.header_cache = ByteLRU(64 * 1024 * 1024)

    # Sources
    def source(self, src):
        kind, _, rest = (src or "").partition(":")
        if kind == "file":
            return FileSource(self.policy.resolve(rest))
        if kind == "tmp":
            if not TMP_ID.match(rest):
                raise ValueError("Bad temp id.")
            path = os.path.join(self.tmp_dir, rest + ".npy")
            if not os.path.isfile(path):
                raise FileNotFoundError("Graph image expired (run the workflow again).")
            return TensorSource(path)
        raise ValueError("Unknown source: %r" % src)

    def save_tensor(self, images):
        """IMAGE batch (torch or numpy, B H W C) -> 'tmp:<id>'."""
        arr = images.detach().cpu().numpy() if hasattr(images, "detach") else np.asarray(images)
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        if arr.ndim == 3:
            arr = arr[None]
        os.makedirs(self.tmp_dir, exist_ok=True)
        tid = uuid.uuid4().hex
        np.save(os.path.join(self.tmp_dir, tid + ".npy"), arr)
        return "tmp:" + tid

    @staticmethod
    def _key(source):
        return (type(source).__name__, source.path, source.stamp())

    # Requests
    def header(self, src):
        s = self.source(src)
        return self.header_cache.get_or_build(
            self._key(s), s.header, lambda h: len(json.dumps(h)))

    def pixels(self, src, part=0, layer="", max_size=None):
        """-> bytes: MAGIC, uint32 meta length, JSON meta (padded to 8 bytes),
        then float16 pixels (H, W, C), top row first."""
        s = self.source(src)
        max_size = min(int(max_size or self.max_texture), self.max_texture)

        def build():
            arr, meta = s.read_layer(int(part), layer, max_size)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)   # > 65504 -> inf
                half = np.ascontiguousarray(arr, dtype="<f2")
            meta["dtype"] = "float16"
            blob = json.dumps(meta).encode("utf-8")
            blob += b" " * (-(len(blob) + 8) % 8)
            return MAGIC + struct.pack("<I", len(blob)) + blob + half.tobytes()

        key = self._key(s) + (int(part), layer or "", max_size)
        return self.pixels_cache.get_or_build(key, build, len)

    def sample(self, src, part, layer, x, y):
        s = self.source(src)
        out = s.sample(int(part), layer, int(x), int(y))
        if out["values"] is not None:
            out["values"] = [_json_safe(v) for v in out["values"]]
        return out


def parse_pixels(blob):
    """Inverse of Inspector.pixels (for tests and the v2 loader)."""
    if blob[:4] != MAGIC:
        raise SourceError("Bad pixel payload.")
    n = struct.unpack_from("<I", blob, 4)[0]
    meta = json.loads(blob[8:8 + n].decode("utf-8"))
    arr = np.frombuffer(blob, "<f2", offset=8 + n)
    return meta, arr.reshape(meta["height"], meta["width"], len(meta["channels"]))
