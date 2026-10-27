# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""HTTP routes on ComfyUI's server. Decoding runs in a worker thread so the
server loop never blocks.

GET /exr_inspector/config                         -> limits the viewer needs
GET /exr_inspector/header?src=                    -> parts, layers, windows (header only)
GET /exr_inspector/pixels?src=&part=&layer=&max=  -> float16 proxy (see service.pixels)
GET /exr_inspector/sample?src=&part=&layer=&x=&y= -> exact float32 values of one pixel
"""

import asyncio
import logging

from aiohttp import web

from .exr_io import SourceError

log = logging.getLogger("EXR-Inspector")


def _error(e):
    if isinstance(e, PermissionError):
        status = 403
    elif isinstance(e, FileNotFoundError):
        status = 404
    elif isinstance(e, (ValueError, KeyError, SourceError)):
        status = 400
    else:
        status = 500
        log.exception("EXR Inspector request failed")
    msg = e.args[0] if isinstance(e, KeyError) and e.args else str(e)
    return web.json_response({"error": msg}, status=status)


def register(routes, inspector, config):
    async def run(fn, *args):
        return await asyncio.to_thread(fn, *args)

    @routes.get("/exr_inspector/config")
    async def get_config(request):
        return web.json_response({
            "allow_any_path": bool(config.get("allow_any_path")),
            "max_texture": inspector.max_texture,
        })

    @routes.get("/exr_inspector/header")
    async def get_header(request):
        try:
            return web.json_response(await run(inspector.header, request.query.get("src", "")))
        except Exception as e:
            return _error(e)

    @routes.get("/exr_inspector/pixels")
    async def get_pixels(request):
        q = request.query
        try:
            blob = await run(inspector.pixels, q.get("src", ""), int(q.get("part", 0)),
                             q.get("layer", ""), int(q.get("max", 0)) or None)
        except Exception as e:
            return _error(e)
        return web.Response(body=blob, content_type="application/octet-stream",
                            headers={"Cache-Control": "no-store"})

    @routes.get("/exr_inspector/sample")
    async def get_sample(request):
        q = request.query
        try:
            out = await run(inspector.sample, q.get("src", ""), int(q.get("part", 0)),
                            q.get("layer", ""), int(q["x"]), int(q["y"]))
            return web.json_response(out)
        except Exception as e:
            return _error(e)
