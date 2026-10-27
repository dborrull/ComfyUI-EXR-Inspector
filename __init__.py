# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull, VFX compositor
# https://github.com/dborrull/ComfyUI-EXR-Inspector
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""
ComfyUI-EXR-Inspector
=====================
Float A/B viewer for ComfyUI. EXR files (multilayer, multipart, every
compression) are decoded on the server with OpenImageIO and sent to the
browser as float16, one layer at a time.
"""

import os

import folder_paths
from server import PromptServer

from .exr_inspector import nodes, routes
from .exr_inspector.paths import PathPolicy, load_config
from .exr_inspector.service import Inspector

__version__ = "0.1.1"

_HERE = os.path.dirname(os.path.abspath(__file__))
_config = load_config(_HERE)
_temp = folder_paths.get_temp_directory()
_policy = PathPolicy(
    roots=[folder_paths.get_input_directory(), folder_paths.get_output_directory(), _temp]
    + list(_config.get("extra_roots") or []),
    allow_any=_config.get("allow_any_path"),
    base_dirs=[folder_paths.get_input_directory(), folder_paths.get_output_directory()],
)
INSPECTOR = Inspector(_policy, os.path.join(_temp, "exr_inspector"),
                      cache_mb=_config.get("cache_mb", 2048),
                      max_texture=_config.get("max_texture", 4096))
routes.register(PromptServer.instance.routes, INSPECTOR, _config)

NODE_CLASS_MAPPINGS = {"EXRInspector": nodes.make_node(INSPECTOR)}
NODE_DISPLAY_NAME_MAPPINGS = {"EXRInspector": "EXR A/B Inspector"}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
