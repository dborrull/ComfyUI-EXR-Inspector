# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""Which files the viewer may read.

By default only ComfyUI's input, output and temp folders. Free paths are a
server-side setting (config.json next to the package, or the environment
variable EXR_INSPECTOR_ALLOW_ANY_PATH=1), never a node widget: a downloaded
workflow must not be able to turn it on.
"""

import json
import os
import re

DEFAULTS = {"allow_any_path": False, "extra_roots": [], "cache_mb": 2048, "max_texture": 4096}
TMP_ID = re.compile(r"^[0-9a-f]{32}$")


def load_config(package_dir):
    cfg = dict(DEFAULTS)
    path = os.path.join(package_dir, "config.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    env = os.environ.get("EXR_INSPECTOR_ALLOW_ANY_PATH")
    if env is not None:
        cfg["allow_any_path"] = env.strip().lower() in ("1", "true", "yes", "on")
    return cfg


class PathPolicy(object):
    def __init__(self, roots, allow_any=False, base_dirs=None):
        """roots: folders reads are limited to. base_dirs: where relative paths
        are looked up, in order (default: roots)."""
        self.roots = [self._real(r) for r in roots if r]
        self.base_dirs = [self._real(r) for r in (base_dirs or roots) if r]
        self.allow_any = bool(allow_any)

    @staticmethod
    def _real(p):
        return os.path.normcase(os.path.realpath(os.path.expanduser(p)))

    def allowed(self, path):
        if self.allow_any:
            return True
        real = self._real(path)
        for root in self.roots:
            try:
                if os.path.commonpath([real, root]) == root:
                    return True
            except ValueError:                # different drives on Windows
                pass
        return False

    def resolve(self, text):
        """User text -> existing absolute path. Relative paths are looked up in
        the base folders (input first). Raises PermissionError / FileNotFoundError."""
        text = (text or "").strip().strip('"').strip("'")
        if not text:
            raise FileNotFoundError("Empty path.")
        if os.path.isabs(os.path.expanduser(text)):
            candidates = [os.path.expanduser(text)]
        else:
            candidates = [os.path.join(b, text) for b in self.base_dirs]
        for c in candidates:
            if os.path.isfile(c):
                real = os.path.realpath(c)
                if not self.allowed(real):
                    raise PermissionError(
                        "Path outside ComfyUI's input/output folders: %s. Free paths are off "
                        "(set allow_any_path in config.json)." % text)
                return real
        raise FileNotFoundError("File not found: %s" % text)
