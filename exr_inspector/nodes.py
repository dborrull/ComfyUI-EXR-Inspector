# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""The "EXR A/B Inspector" node. It only hands sources to the viewer: graph
images are saved to temp as float32, paths are checked and passed through.
Layer, input space and every viewer setting live in the browser."""

import os

SPACES = ["auto", "sRGB", "linear"]


def make_node(inspector):
    class EXRInspector(object):
        CATEGORY = "image/EXR Inspector"
        FUNCTION = "inspect"
        RETURN_TYPES = ()
        OUTPUT_NODE = True
        DESCRIPTION = ("Float A/B viewer: wipe / blink / diff, exposure, channels, eyedropper "
                       "with raw values. A path (EXR, multilayer, any compression) overrides "
                       "the image input on that side.")

        @classmethod
        def INPUT_TYPES(cls):
            side = lambda s: {
                "tooltip": "EXR or image path for %s. Relative paths are looked up in input/, "
                           "then output/. When set, it overrides image_%s." % (s.upper(), s)}
            return {
                "required": {
                    "path_a": ("STRING", dict(default="", **side("a"))),
                    "path_b": ("STRING", dict(default="", **side("b"))),
                    "layer_a": ("STRING", {"default": "", "tooltip": "Layer id (empty = main colour layer)."}),
                    "layer_b": ("STRING", {"default": "", "tooltip": "Layer id (empty = main colour layer)."}),
                    "space_a": (SPACES, {"default": "auto", "tooltip": "auto: EXR/HDR linear, graph images and 8-bit files sRGB."}),
                    "space_b": (SPACES, {"default": "auto"}),
                },
                "optional": {
                    "image_a": ("IMAGE",),
                    "image_b": ("IMAGE",),
                },
            }

        def inspect(self, path_a="", path_b="", layer_a="", layer_b="", space_a="auto",
                    space_b="auto", image_a=None, image_b=None):
            sides = {}
            for name, path, image, layer, space in (("a", path_a, image_a, layer_a, space_a),
                                                    ("b", path_b, image_b, layer_b, space_b)):
                if path and path.strip():
                    src = "file:" + inspector.policy.resolve(path)
                elif image is not None and len(image) > 0:
                    src = inspector.save_tensor(image)
                else:
                    continue
                sides[name] = {"src": src, "layer": layer, "space": space}
            return {"ui": {"exr_inspector": [sides]}}

        @classmethod
        def IS_CHANGED(cls, path_a="", path_b="", **kwargs):
            stamp = []
            for p in (path_a, path_b):
                try:
                    real = inspector.policy.resolve(p) if p and p.strip() else ""
                    stamp.append("%s:%s" % (real, os.stat(real).st_mtime_ns if real else ""))
                except (OSError, PermissionError):
                    stamp.append("missing:" + (p or ""))
            return "|".join(stamp)

        @classmethod
        def VALIDATE_INPUTS(cls, path_a="", path_b="", **kwargs):
            for p in (path_a, path_b):
                if p and p.strip():
                    try:
                        inspector.policy.resolve(p)
                    except (OSError, PermissionError) as e:
                        return str(e)
            return True

    return EXRInspector
