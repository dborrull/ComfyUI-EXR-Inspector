# -*- coding: utf-8 -*-
"""Backend tests. Run with ComfyUI's Python, from the repo root:
    python -m unittest discover -s tests -v
Test EXRs are written with OpenImageIO into tests/_data (git-ignored)."""

import os
import sys
import tempfile
import threading
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import OpenImageIO as oiio  # noqa: E402

from exr_inspector import color, exr_io, layers  # noqa: E402
from exr_inspector.cache import ByteLRU  # noqa: E402
from exr_inspector.paths import PathPolicy  # noqa: E402
from exr_inspector.service import Inspector, parse_pixels  # noqa: E402

DATA = os.path.join(ROOT, "tests", "_data")
ACESCG = color.NAMED["ACEScg AP1"]


def ramp(h, w, c, seed=0):
    rng = np.random.default_rng(seed)
    base = np.linspace(0, 4, w, dtype=np.float32)[None, :, None]
    return (base + rng.random((h, w, c), dtype=np.float32)).astype(np.float32)


def write_exr(path, parts):
    """parts: list of dicts {pixels (H,W,C), names, compression, x, y, full, tile, half, name, chroma}."""
    specs = []
    for p in parts:
        h, w, c = p["pixels"].shape
        s = oiio.ImageSpec(w, h, c, "half" if p.get("half", True) else "float")
        s.channelnames = tuple(p["names"])
        s.x, s.y = p.get("x", 0), p.get("y", 0)
        fw, fh = p.get("full", (w, h))
        s.full_x, s.full_y, s.full_width, s.full_height = 0, 0, fw, fh
        s.attribute("compression", p.get("compression", "zip"))
        if p.get("tile"):
            s.tile_width = s.tile_height = p["tile"]
        if p.get("chroma"):
            s.attribute("chromaticities", "float[8]", tuple(p["chroma"]))
        if p.get("name"):
            s.attribute("oiio:subimagename", p["name"])
        specs.append(s)
    out = oiio.ImageOutput.create(path)
    if not out.open(path, specs):
        raise RuntimeError(out.geterror())
    for i, p in enumerate(parts):
        if i:
            out.open(path, specs[i], "AppendSubimage")
        if not out.write_image(p["pixels"]):
            raise RuntimeError(out.geterror())
    out.close()


def setUpModule():
    os.makedirs(DATA, exist_ok=True)
    global NUKE, BLENDER, MULTIPART, TILED
    # Nuke-style: rgba + depth + N + diffuse, overscan data window, ACEScg
    NUKE = os.path.join(DATA, "nuke_layers.exr")
    px = ramp(40, 70, 10)
    write_exr(NUKE, [{"pixels": px, "x": -5, "y": -3, "full": (60, 34), "compression": "zip",
                      "names": ["R", "G", "B", "A", "Z", "N.X", "N.Y", "N.Z",
                                "diffuse.red", "diffuse.green"], "chroma": ACESCG}])
    # Blender-style names, depth with inf-like background, float
    BLENDER = os.path.join(DATA, "blender_layers.exr")
    px = ramp(32, 48, 7, seed=1)
    px[:, 40:, 4] = 1.0e10
    write_exr(BLENDER, [{"pixels": px, "half": False, "compression": "piz", "names": [
        "ViewLayer.Combined.R", "ViewLayer.Combined.G", "ViewLayer.Combined.B",
        "ViewLayer.Combined.A", "ViewLayer.Depth.Z", "ViewLayer.Vector.X", "ViewLayer.Vector.Y"]}])
    MULTIPART = os.path.join(DATA, "multipart_dwab.exr")
    write_exr(MULTIPART, [
        {"pixels": ramp(64, 64, 3, 2), "names": ["R", "G", "B"], "compression": "dwab", "name": "beauty"},
        {"pixels": ramp(64, 64, 1, 3), "names": ["depth.Z"], "compression": "zips", "name": "depth"}])
    TILED = os.path.join(DATA, "tiled_big.exr")
    write_exr(TILED, [{"pixels": ramp(700, 1000, 4, 4), "names": ["R", "G", "B", "A"],
                       "compression": "piz", "tile": 64}])


class TestLayers(unittest.TestCase):
    def test_nuke(self):
        ls = layers.group_layers(["A", "B", "G", "R", "Z", "N.X", "N.Y", "N.Z",
                                  "diffuse.blue", "diffuse.green", "diffuse.red"])
        ids = [l["id"] for l in ls]
        self.assertEqual(ids, ["rgba", "depth", "N", "diffuse"])
        self.assertEqual(ls[0]["channels"], ["R", "G", "B", "A"])
        self.assertEqual(ls[3]["channels"], ["diffuse.red", "diffuse.green", "diffuse.blue"])
        self.assertEqual([l["kind"] for l in ls], ["color", "data", "data", "color"])

    def test_blender(self):
        ls = layers.group_layers(["ViewLayer.Depth.Z", "ViewLayer.Combined.A", "ViewLayer.Combined.B",
                                  "ViewLayer.Combined.G", "ViewLayer.Combined.R", "ViewLayer.Normal.X",
                                  "ViewLayer.Normal.Y", "ViewLayer.Normal.Z", "ViewLayer.CryptoObject00.R"])
        self.assertEqual(ls[0]["id"], "ViewLayer.Combined")
        self.assertEqual(ls[0]["label"], "Combined (ViewLayer)")
        self.assertEqual(ls[0]["suffixes"], ["R", "G", "B", "A"])
        kinds = {l["id"]: l["kind"] for l in ls}
        self.assertEqual(kinds["ViewLayer.Depth"], "data")
        self.assertEqual(kinds["ViewLayer.Normal"], "data")
        self.assertEqual(kinds["ViewLayer.CryptoObject00"], "data")
        self.assertEqual(layers.find_layer(ls, "")["id"], "ViewLayer.Combined")


class TestColor(unittest.TestCase):
    def test_identity(self):
        np.testing.assert_allclose(color.to_rec709_matrix(color.REC709), np.eye(3).ravel(), atol=1e-6)

    def test_acescg(self):
        m = color.to_rec709_matrix(ACESCG)
        np.testing.assert_allclose(m[:3], [1.70505, -0.62179, -0.08326], atol=2e-3)
        self.assertEqual(color.primaries_name(ACESCG), "ACEScg AP1")


class TestFileSource(unittest.TestCase):
    def test_header(self):
        h = exr_io.FileSource(NUKE).header()
        p = h["parts"][0]
        self.assertEqual(h["default_space"], "linear")
        self.assertEqual(p["data_window"], [-5, -3, 64, 36])
        self.assertEqual(p["display_window"], [0, 0, 59, 33])
        self.assertEqual(p["primaries"], "ACEScg AP1")
        self.assertEqual([l["id"] for l in p["layers"]], ["rgba", "depth", "N", "diffuse"])

    def test_read_matches_written(self):
        src = exr_io.FileSource(NUKE)
        written = ramp(40, 70, 10).astype(np.float16).astype(np.float32)
        arr, meta = src.read_layer(0, "N", 0)
        np.testing.assert_array_equal(arr, written[:, :, 5:8])
        self.assertEqual(meta["channels"], ["X", "Y", "Z"])
        arr, _ = src.read_layer(0, "diffuse", 0)       # non-contiguous with rgba
        np.testing.assert_array_equal(arr, written[:, :, 8:10])
        arr, _ = src.read_layer(0, "depth", 0)
        np.testing.assert_array_equal(arr[:, :, 0], written[:, :, 4])

    def test_sample_absolute_coords(self):
        src = exr_io.FileSource(NUKE)
        written = ramp(40, 70, 10).astype(np.float16).astype(np.float32)
        out = src.sample(0, "", -5, -3)                  # first data pixel, outside display
        np.testing.assert_array_equal(out["values"], written[0, 0, :4])
        out = src.sample(0, "N", 10, 7)
        np.testing.assert_array_equal(out["values"], written[10, 15, 5:8])
        self.assertIsNone(src.sample(0, "", 100, 0)["values"])

    def test_float_depth_exact_and_auto_range(self):
        src = exr_io.FileSource(BLENDER)
        arr, meta = src.read_layer(0, "ViewLayer.Depth", 0)
        self.assertEqual(src.sample(0, "ViewLayer.Depth", 45, 0)["values"][0], 1.0e10)
        lo, hi = meta["stats"]["auto_range"]
        self.assertLess(hi, 10.0)                       # background excluded
        self.assertEqual(meta["kind"], "data")

    def test_multipart_dwab(self):
        src = exr_io.FileSource(MULTIPART)
        h = src.header()
        self.assertEqual([p["name"] for p in h["parts"]], ["beauty", "depth"])
        arr, _ = src.read_layer(0, "", 0)
        np.testing.assert_allclose(arr, ramp(64, 64, 3, 2), rtol=0.05, atol=0.05)   # lossy
        arr, _ = src.read_layer(1, "depth", 0)
        np.testing.assert_allclose(arr, ramp(64, 64, 1, 3), rtol=1e-3)

    def test_tiled_proxy_and_strips(self):
        src = exr_io.FileSource(TILED)
        full = ramp(700, 1000, 4, 4).astype(np.float16).astype(np.float32)
        arr, meta = src.read_layer(0, "", 256)
        self.assertEqual(meta["factor"], 4)
        self.assertEqual((meta["width"], meta["height"]), (250, 175))
        np.testing.assert_allclose(arr, exr_io.downsample(full, 4), rtol=1e-5)
        old = exr_io.STRIP_BYTES
        exr_io.STRIP_BYTES = 1000 * 4 * 4 * 50           # force ~14 strips
        try:
            arr2, _ = src.read_layer(0, "", 256)
        finally:
            exr_io.STRIP_BYTES = old
        np.testing.assert_array_equal(arr, arr2)
        self.assertEqual(src.sample(0, "", 999, 699)["values"], [float(v) for v in full[699, 999]])

    def test_all_compressions(self):
        px = ramp(37, 53, 4, 5)
        for comp in ("none", "rle", "zips", "zip", "piz", "pxr24", "b44", "b44a", "dwaa", "dwab"):
            path = os.path.join(DATA, "comp_%s.exr" % comp)
            write_exr(path, [{"pixels": px, "names": ["R", "G", "B", "A"], "compression": comp}])
            arr, _ = exr_io.FileSource(path).read_layer(0, "", 0)
            tol = 0.08 if comp in ("pxr24", "b44", "b44a", "dwaa", "dwab") else 1e-3
            np.testing.assert_allclose(arr, px, rtol=tol, atol=tol, err_msg=comp)

    def test_downsample_edges(self):
        a = np.arange(5 * 3, dtype=np.float32).reshape(5, 3, 1)
        d = exr_io.downsample(a, 2)
        self.assertEqual(d.shape, (3, 2, 1))
        self.assertEqual(d[2, 1, 0], a[4, 2, 0])           # lone corner pixel


class TestServiceAndPolicy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.insp = Inspector(PathPolicy([DATA, self.tmp]), self.tmp, cache_mb=64, max_texture=512)

    def test_pixels_roundtrip(self):
        blob = self.insp.pixels("file:nuke_layers.exr", 0, "N")
        meta, arr = parse_pixels(blob)
        self.assertEqual(arr.shape, (40, 70, 3))
        self.assertEqual(meta["data_window"], [-5, -3, 64, 36])
        self.assertIs(self.insp.pixels("file:nuke_layers.exr", 0, "N"), blob)   # cached

    def test_half_overflow_and_json(self):
        meta, arr = parse_pixels(self.insp.pixels("file:blender_layers.exr", 0, "ViewLayer.Depth"))
        self.assertTrue(np.isinf(arr[0, 45, 0]))
        s = self.insp.sample("file:blender_layers.exr", 0, "ViewLayer.Depth", 45, 0)
        self.assertEqual(s["values"], [1.0e10])

    def test_tensor(self):
        img = np.random.rand(2, 20, 30, 3).astype(np.float32)
        src = self.insp.save_tensor(img)
        h = self.insp.header(src)
        self.assertEqual(len(h["parts"]), 2)
        self.assertEqual(h["default_space"], "sRGB")
        meta, arr = parse_pixels(self.insp.pixels(src, 1, ""))
        np.testing.assert_allclose(arr, img[1], atol=1e-3)
        self.assertEqual(self.insp.sample(src, 1, "", 3, 4)["values"], [float(v) for v in img[1, 4, 3]])

    def test_policy(self):
        with self.assertRaises(PermissionError):
            self.insp.header("file:" + os.path.join(ROOT, "tests", "test_backend.py"))
        with self.assertRaises(PermissionError):
            self.insp.header("file:" + os.path.join(DATA, "..", "..", "LICENSE"))
        with self.assertRaises(FileNotFoundError):
            self.insp.header("file:nope.exr")
        with self.assertRaises(ValueError):
            self.insp.header("tmp:../../x")
        free = PathPolicy([DATA], allow_any=True)
        self.assertTrue(free.resolve(os.path.join(ROOT, "LICENSE")))


class TestCache(unittest.TestCase):
    def test_budget_and_single_build(self):
        c = ByteLRU(10)
        calls = []

        def build():
            calls.append(1)
            threading.Event().wait(0.05)
            return b"12345"
        ts = [threading.Thread(target=c.get_or_build, args=("k", build, len)) for _ in range(5)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(calls), 1)
        c.get_or_build("k2", lambda: b"123456", len)       # evicts k
        self.assertEqual(c.used, 6)


if __name__ == "__main__":
    unittest.main()
