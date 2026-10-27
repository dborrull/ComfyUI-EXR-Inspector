# ComfyUI-EXR-Inspector

Float A/B viewer for ComfyUI, made by a VFX compositor for checking renders, AOVs and
generated plates the way you would in a compositing viewer.

> **Status: work in progress.** The backend (EXR reading, layers, routes, node) is done;
> the WebGL viewer is next.

## Planned v1

- Wipe and blink between A and B, synced zoom and pan.
- Exposure in stops and gamma shared by A and B; R / G / B / A / luminance.
- Eyedropper with the raw values of A, B and their difference at the same pixel.
- Difference with gain, false colour, clipping warning.
- Input space sRGB / linear and a simple view transform.
- Data layers (depth, normals, position, vectors) shown with min/max remap and invert,
  without view transform. The eyedropper always shows the real value.

## EXR support

Files are decoded on the server with OpenImageIO and sent to the browser as float16,
one layer at a time:

- every OpenEXR compression (NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB),
  scanline and tiled, multipart;
- Nuke and Blender layer names (`depth.Z`, `ViewLayer.Combined.R`...);
- data and display windows (overscan) and chromaticities (converted to Rec.709 for display);
- huge images are read in strips and box-filtered to a proxy (4096 px by default); the
  eyedropper still reads the exact float value from the file.

Deep EXR, full OCIO, sequences and Cryptomatte decoding are out of scope for v1.

## Install

Clone into `ComfyUI/custom_nodes` and install the requirements with ComfyUI's Python:

```
python -m pip install -r requirements.txt
```

## Paths and settings

By default the node only reads files inside ComfyUI's `input`, `output` and `temp` folders.
Relative paths are looked up in `input`, then `output`.

To change that, copy `config.example.json` to `config.json`:

| key | default | |
|---|---|---|
| `allow_any_path` | `false` | read any path on the machine |
| `extra_roots` | `[]` | extra folders that are allowed |
| `cache_mb` | `2048` | RAM for decoded layers |
| `max_texture` | `4096` | longest side sent to the browser |

`EXR_INSPECTOR_ALLOW_ANY_PATH=1` also turns free paths on. This is a server setting on
purpose: a workflow you download cannot switch it on.

## Tests

```
python -m unittest discover -s tests -v
```

## License

MIT, © 2026 David Borrull.
