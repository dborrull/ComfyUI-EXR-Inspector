# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""Image sources for the viewer.

FileSource  : EXR (and any still OpenImageIO reads) on disk. Reads the header
              only to list parts and layers, then one layer at a time, in
              strips, box-filtered down to a proxy size so huge images never
              sit in memory at full resolution as float.
TensorSource: an IMAGE batch from the graph, saved by the node as float32 .npy.
              Each batch item is shown as a part ("frame N").

Coordinates follow OpenEXR: windows are [x0, y0, x1, y1] inclusive, y down.
"""

import math
import os
import warnings

import numpy as np

from . import color, layers

STRIP_BYTES = 256 * 1024 * 1024      # float32 working buffer per strip
LINEAR_EXT = {".exr", ".hdr", ".pfm"}
IMAGE_EXT = LINEAR_EXT | {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".webp", ".dpx", ".tga", ".bmp"}


class SourceError(Exception):
    pass


def _oiio():
    try:
        import OpenImageIO as oiio
    except ImportError:
        raise SourceError("OpenImageIO is not installed: pip install OpenImageIO")
    return oiio


# Proxy and stats
def downsample(arr, f):
    """Box filter by an integer factor. arr: (H, W, C) float32. Edge blocks
    average only the pixels they have; NaN pixels are ignored."""
    if f <= 1:
        return arr
    h, w, c = arr.shape
    ph, pw = -(-h // f), -(-w // f)
    pad = np.full((ph * f, pw * f, c), np.nan, np.float32)
    pad[:h, :w] = arr
    nan = np.isnan(pad)
    pad[nan] = 0.0
    total = pad.reshape(ph, f, pw * f, c).sum(axis=1).reshape(ph, pw, f, c).sum(axis=2)
    count = (~nan).reshape(ph, f, pw * f, c).sum(axis=1, dtype=np.int32) \
        .reshape(ph, pw, f, c).sum(axis=2)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return (total / count).astype(np.float32)        # 0 / 0 -> NaN where all were NaN


def proxy_factor(width, height, max_size):
    if not max_size or max(width, height) <= max_size:
        return 1
    return int(math.ceil(max(width, height) / float(max_size)))


_DEPTH_NAMES = {"depth", "z", "zdepth", "zbuffer"}


def auto_range(values, depth=False, lo_pct=0.5, hi_pct=99.5):
    """Robust (low, high) for remapping data layers. Depth ignores the
    background: inf / NaN, half max (65504) and anything absurdly far."""
    v = values[np.isfinite(values)]
    if depth:
        v = v[np.abs(v) < 6.0e4]
        pos = v[v > 0]
        if pos.size:
            v = v[v < np.median(pos) * 1.0e3]
    if v.size == 0:
        return 0.0, 1.0
    if v.size > 4_000_000:
        v = v[:: v.size // 4_000_000 + 1]
    lo, hi = np.percentile(v, [lo_pct, hi_pct])
    if hi <= lo:
        lo, hi = float(v.min()), float(v.max())
        if hi <= lo:
            hi = lo + 1.0
    return float(lo), float(hi)


def layer_stats(arr, layer_id):
    """Per-channel and whole-layer stats of a (H, W, C) proxy."""
    depth = layer_id.rsplit(".", 1)[-1].lower() in _DEPTH_NAMES
    chans = []
    for i in range(arr.shape[2]):
        a = arr[:, :, i]
        fin = np.isfinite(a)
        chans.append({
            "min": float(a[fin].min()) if fin.any() else None,
            "max": float(a[fin].max()) if fin.any() else None,
            "nan": int(np.isnan(a).sum()),
            "inf": int(np.isinf(a).sum()),
        })
    lo, hi = auto_range(arr, depth=depth)
    return {"channels": chans, "auto_range": [lo, hi]}


# Sources
class FileSource(object):
    def __init__(self, path):
        self.path = path
        ext = os.path.splitext(path)[1].lower()
        if ext not in IMAGE_EXT:
            raise SourceError("Not an image type the viewer reads: %s" % ext)
        self.ext = ext

    def stamp(self):
        st = os.stat(self.path)
        return (st.st_mtime_ns, st.st_size)

    def _open(self):
        oiio = _oiio()
        inp = oiio.ImageInput.open(self.path)
        if inp is None:
            raise SourceError("Cannot read %s: %s" % (os.path.basename(self.path), oiio.geterror()))
        return inp

    def header(self):
        inp = self._open()
        try:
            parts, i = [], 0
            while inp.seek_subimage(i, 0):
                parts.append(self._part_info(i, inp.spec()))
                i += 1
        finally:
            inp.close()
        return {
            "kind": "file",
            "name": os.path.basename(self.path),
            "default_space": "linear" if self.ext in LINEAR_EXT else "sRGB",
            "parts": parts,
        }

    @staticmethod
    def _part_info(index, s):
        chroma = s.getattribute("chromaticities")
        name = s.getattribute("oiio:subimagename") or s.getattribute("name") or ""
        info = {
            "index": index,
            "name": name or ("part %d" % index if index else ""),
            "data_window": [s.x, s.y, s.x + s.width - 1, s.y + s.height - 1],
            "display_window": [s.full_x, s.full_y, s.full_x + s.full_width - 1,
                               s.full_y + s.full_height - 1],
            "pixel_aspect": float(s.getattribute("PixelAspectRatio") or 1.0),
            "compression": s.getattribute("compression") or "",
            "tiled": bool(s.tile_width),
            "deep": bool(s.deep),
            "format": str(s.format),
            "chromaticities": list(chroma) if chroma else None,
            "primaries": color.primaries_name(chroma),
            "to_rec709": color.to_rec709_matrix(chroma),
            "layers": layers.group_layers(list(s.channelnames)),
        }
        return info

    def _spec(self, inp, part):
        if not inp.seek_subimage(part, 0):
            raise SourceError("Part %d not found." % part)
        s = inp.spec()
        if s.deep:
            raise SourceError("Deep images are not supported.")
        return s

    @staticmethod
    def _runs(indices):
        """[4, 5, 6, 9] -> [(4, 7), (9, 10)]: contiguous channel ranges."""
        runs = []
        for i in sorted(indices):
            if runs and runs[-1][1] == i:
                runs[-1][1] = i + 1
            else:
                runs.append([i, i + 1])
        return [tuple(r) for r in runs]

    def _read_rows(self, inp, part, s, y0, y1, chb, che):
        """Rows [y0, y1) (absolute coords) of channels [chb, che) as float32."""
        if not s.tile_width:
            a = inp.read_scanlines(part, 0, y0, y1, s.z, chb, che, "float")
        else:
            th = s.tile_height
            ty0 = s.y + ((y0 - s.y) // th) * th
            ty1 = min(s.y + s.height, s.y + -(-(y1 - s.y) // th) * th)
            a = inp.read_tiles(part, 0, s.x, s.x + s.width, ty0, ty1, s.z, s.z + max(s.depth, 1),
                               chb, che, "float")
            if a is not None:
                a = np.asarray(a).reshape(ty1 - ty0, s.width, che - chb)[y0 - ty0:y1 - ty0]
        if a is None:
            raise SourceError("Read error in %s: %s" % (os.path.basename(self.path), inp.geterror()))
        return np.asarray(a, np.float32).reshape(y1 - y0, s.width, che - chb)

    def _channel_order(self, s, layer):
        names = list(s.channelnames)
        try:
            idx = [names.index(c) for c in layer["channels"]]
        except ValueError as e:
            raise SourceError("Channel missing: %s" % e)
        return idx

    def _read_layer_rows(self, inp, part, s, idx, y0, y1):
        cols = []
        for chb, che in self._runs(idx):
            block = self._read_rows(inp, part, s, y0, y1, chb, che)
            for ch in range(chb, che):
                if ch in idx:
                    cols.append((ch, block[:, :, ch - chb]))
        by_ch = dict(cols)
        return np.stack([by_ch[i] for i in idx], axis=-1)

    def read_layer(self, part, layer_id, max_size):
        """-> (proxy float32 (H, W, C), meta dict)."""
        inp = self._open()
        try:
            s = self._spec(inp, part)
            info = self._part_info(part, s)
            layer = layers.find_layer(info["layers"], layer_id)
            idx = self._channel_order(s, layer)
            f = proxy_factor(s.width, s.height, max_size)
            rows = max(f, (STRIP_BYTES // max(1, s.width * len(idx) * 4)) // f * f)
            strips = []
            for y0 in range(s.y, s.y + s.height, rows):
                y1 = min(y0 + rows, s.y + s.height)
                strips.append(downsample(self._read_layer_rows(inp, part, s, idx, y0, y1), f))
            arr = np.concatenate(strips, axis=0) if strips else np.zeros((0, 0, len(idx)), np.float32)
        finally:
            inp.close()
        return arr, self._meta(info, layer, f, arr)

    @staticmethod
    def _meta(info, layer, f, arr):
        return {
            "part": info["index"],
            "layer": layer["id"],
            "channels": layer["suffixes"],
            "kind": layer["kind"],
            "width": int(arr.shape[1]),
            "height": int(arr.shape[0]),
            "factor": f,
            "data_window": info["data_window"],
            "display_window": info["display_window"],
            "pixel_aspect": info["pixel_aspect"],
            "to_rec709": info["to_rec709"],
            "stats": layer_stats(arr, layer["id"]),
        }

    def sample(self, part, layer_id, x, y):
        """Exact float32 values of one pixel (absolute coords), None outside
        the data window."""
        inp = self._open()
        try:
            s = self._spec(inp, part)
            layer = layers.find_layer(layers.group_layers(list(s.channelnames)), layer_id)
            if not (s.x <= x < s.x + s.width and s.y <= y < s.y + s.height):
                return {"channels": layer["suffixes"], "values": None}
            idx = self._channel_order(s, layer)
            row = self._read_layer_rows(inp, part, s, idx, y, y + 1)
        finally:
            inp.close()
        return {"channels": layer["suffixes"], "values": [float(v) for v in row[0, x - s.x]]}


class TensorSource(object):
    """(B, H, W, C) float32 .npy written by the node from an IMAGE input."""

    CHANNELS = {1: ["Y"], 3: ["R", "G", "B"], 4: ["R", "G", "B", "A"]}

    def __init__(self, path, label="graph image"):
        self.path = path
        self.label = label

    def stamp(self):
        st = os.stat(self.path)
        return (st.st_mtime_ns, st.st_size)

    def _array(self):
        return np.load(self.path, mmap_mode="r")

    def _part_info(self, index, shape):
        _, h, w, c = shape
        return {
            "index": index,
            "name": "frame %d" % index,
            "data_window": [0, 0, w - 1, h - 1],
            "display_window": [0, 0, w - 1, h - 1],
            "pixel_aspect": 1.0,
            "compression": "",
            "tiled": False,
            "deep": False,
            "format": "float",
            "chromaticities": None,
            "primaries": color.primaries_name(None),
            "to_rec709": color.to_rec709_matrix(None),
            "layers": layers.group_layers(self.CHANNELS[c]),
        }

    def header(self):
        shape = self._array().shape
        return {
            "kind": "tensor",
            "name": self.label,
            "default_space": "sRGB",
            "parts": [self._part_info(i, shape) for i in range(shape[0])],
        }

    def read_layer(self, part, layer_id, max_size):
        a = self._array()
        if not 0 <= part < a.shape[0]:
            raise SourceError("Frame %d not found." % part)
        info = self._part_info(part, a.shape)
        layer = layers.find_layer(info["layers"], layer_id)
        f = proxy_factor(a.shape[2], a.shape[1], max_size)
        arr = downsample(np.asarray(a[part], np.float32), f)
        return arr, FileSource._meta(info, layer, f, arr)

    def sample(self, part, layer_id, x, y):
        a = self._array()
        c = a.shape[3]
        if not (0 <= part < a.shape[0] and 0 <= x < a.shape[2] and 0 <= y < a.shape[1]):
            return {"channels": self.CHANNELS[c], "values": None}
        return {"channels": self.CHANNELS[c], "values": [float(v) for v in a[part, y, x]]}
