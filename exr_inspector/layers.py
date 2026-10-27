# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""Group EXR channel names into layers (Nuke and Blender naming).

Nuke   : R G B A, Z, layer.red / layer.R, depth.Z, N.X ...
Blender: ViewLayer.Combined.R, ViewLayer.Depth.Z, ViewLayer.Normal.X ...
"""

import re

# Channel suffix -> sort rank inside a layer (and RGBA slot for colour layers)
_RANK = {
    "r": 0, "red": 0, "x": 0, "u": 0,
    "g": 1, "green": 1, "y": 1, "v": 1,
    "b": 2, "blue": 2, "z": 2, "w": 3,
    "a": 3, "alpha": 3,
}
_COLOR_SUFFIXES = {"r", "g", "b", "a", "red", "green", "blue", "alpha"}

# Layer names (last component, lower case, no spaces) that hold data, not colour
_DATA_NAMES = {
    "depth", "z", "zdepth", "zbuffer", "deep", "mist",
    "n", "normal", "normals", "nworld", "ncam", "denoisingnormal", "denoisingdepth",
    "p", "position", "pworld", "pref", "pcam", "worldposition",
    "vector", "vectors", "motion", "motionvector", "motionvectors", "mv", "velocity",
    "forward", "backward", "smotion",
    "uv", "st", "indexob", "indexma", "objectid", "materialid", "id",
}
_CRYPTO = re.compile(r"crypto", re.I)


def split_channel(name):
    """'ViewLayer.Combined.R' -> ('ViewLayer.Combined', 'R'); 'R' -> ('', 'R')."""
    if "." in name:
        layer, suffix = name.rsplit(".", 1)
        return layer, suffix
    return "", name


def layer_kind(layer, suffixes):
    """'color' or 'data'. Cryptomatte is reported as 'data' (not decoded in v1)."""
    last = layer.rsplit(".", 1)[-1].lower().replace(" ", "").replace("_", "")
    if _CRYPTO.search(layer):
        return "data"
    if last in _DATA_NAMES:
        return "data"
    low = [s.lower() for s in suffixes]
    if low and not any(s in _COLOR_SUFFIXES for s in low):
        return "data"           # X/Y/Z/W, U/V... with no colour channel
    return "color"


def layer_label(layer):
    """Short name for menus. Blender 'ViewLayer.Combined' -> 'Combined (ViewLayer)'."""
    if not layer:
        return "rgba"
    if "." in layer:
        head, last = layer.rsplit(".", 1)
        return "%s (%s)" % (last, head)
    return layer


def _sort_key(channel):
    suf = split_channel(channel)[1].lower()
    return (_RANK.get(suf, 10), suf)


def group_layers(channel_names):
    """Channel names (file order) -> list of layer dicts, in first-seen order:
    {"id", "label", "channels": [names, RGBA/XYZW order], "kind"}.

    Bare R/G/B/A form the 'rgba' layer. A bare Z is Nuke's depth.Z. Any other
    bare name (Y, AR...) is a single-channel layer of its own."""
    groups, order = {}, []
    for ch in channel_names:
        layer, suf = split_channel(ch)
        if not layer:
            low = suf.lower()
            if low in _COLOR_SUFFIXES:
                layer = ""
            elif low == "z":
                layer = "depth"
            else:
                layer = suf
        if layer not in groups:
            groups[layer] = []
            order.append(layer)
        groups[layer].append(ch)

    out = []
    for layer in order:
        chans = sorted(groups[layer], key=_sort_key)
        suffixes = [split_channel(c)[1] for c in chans]
        lid = layer or "rgba"
        out.append({
            "id": lid,
            "label": layer_label(layer),
            "channels": chans,
            "suffixes": suffixes,
            "kind": layer_kind(lid, suffixes),
        })
    # The main colour layer first: rgba, then Blender's Combined / Nuke's beauty
    def main_rank(l):
        last = l["id"].rsplit(".", 1)[-1].lower()
        if l["id"] == "rgba":
            return 0
        if last in ("combined", "beauty", "image"):
            return 1
        return 2
    out.sort(key=main_rank)            # stable: keeps file order otherwise
    return out


def find_layer(layers, layer_id):
    """Layer by id; '' or None -> first colour layer (or the first layer)."""
    if layer_id:
        for l in layers:
            if l["id"] == layer_id:
                return l
        raise KeyError("Layer not found: %s" % layer_id)
    for l in layers:
        if l["kind"] == "color":
            return l
    if not layers:
        raise KeyError("The image has no channels.")
    return layers[0]
