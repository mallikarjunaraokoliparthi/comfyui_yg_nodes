"""
YG Auto Image Cycler
====================

Drop-in replacement for ComfyUI's `Load Image` when you want to run a workflow
N times back-to-back and have a different image used on every run.

Usage:
    1. Add this node, click "📁 Upload Images" → pick files from your PC.
       (Or set `folder` to a server-side absolute path if you prefer.)
    2. Connect IMAGE / MASK outputs the same way as Load Image.
    3. In ComfyUI top bar: set "Batch count" = 100, click Run.
    4. Each of the 100 runs uses the next image in the folder.
"""

import os
import json
import time
import shutil
import hashlib
import threading
import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths  # ComfyUI builtin
from aiohttp import web
import server  # ComfyUI's PromptServer

# ----------------------------------------------------------------------- paths

_VALID_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff")

_STATE_PATH = "/tmp/yg_auto_cycler_state.json"
_STATE_LOCK = threading.Lock()


def _safe_id(s: str) -> str:
    s = (s or "default").strip() or "default"
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in s)[:64]


def _upload_dir(cycle_id: str) -> str:
    """Server-side folder where uploaded images live."""
    base = os.path.join(folder_paths.get_input_directory(), "yg_cycler", _safe_id(cycle_id))
    os.makedirs(base, exist_ok=True)
    return base


def _resolve_folder(folder: str, cycle_id: str) -> str:
    """If `folder` is empty or 'upload', use the per-cycle upload dir."""
    f = (folder or "").strip()
    if not f or f.lower() in ("upload", "uploads", "auto"):
        return _upload_dir(cycle_id)
    return f


# ----------------------------------------------------------------------- state

def _load_state() -> dict:
    if not os.path.isfile(_STATE_PATH):
        return {}
    try:
        with open(_STATE_PATH, "r") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    try:
        tmp = _STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, _STATE_PATH)
    except Exception:
        pass


def _list_images(folder: str) -> list:
    if not folder or not os.path.isdir(folder):
        return []
    try:
        names = [
            n for n in os.listdir(folder)
            if n.lower().endswith(_VALID_EXT)
            and os.path.isfile(os.path.join(folder, n))
        ]
    except Exception:
        return []
    names.sort()
    return [os.path.join(folder, n) for n in names]


def _read_image(path: str):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if getattr(img, "is_animated", False):
        img = next(ImageSequence.Iterator(img))
    if img.mode == "I":
        img = img.point(lambda i: i * (1 / 255))
    rgb = img.convert("RGB")
    arr = np.array(rgb).astype(np.float32) / 255.0
    img_t = torch.from_numpy(arr)[None, ...]
    if "A" in img.getbands():
        a = np.array(img.getchannel("A")).astype(np.float32) / 255.0
        mask = 1.0 - torch.from_numpy(a)
    else:
        mask = torch.zeros((rgb.size[1], rgb.size[0]), dtype=torch.float32)
    return img_t, mask[None, ...]


# ----------------------------------------------------------------------- HTTP

_routes = server.PromptServer.instance.routes


@_routes.post("/yg_cycler/upload")
async def yg_cycler_upload(request):
    """Multipart upload of one or many images for a given cycle_id."""
    try:
        reader = await request.multipart()
        cycle_id = "default"
        clear_first = False
        saved = []

        async for part in reader:
            if part.name == "cycle_id":
                cycle_id = (await part.text()).strip() or "default"
            elif part.name == "clear":
                clear_first = (await part.text()).strip().lower() in ("1", "true", "yes", "on")
            elif part.name in ("file", "files", "image", "images"):
                fname = part.filename or ""
                if not fname or not fname.lower().endswith(_VALID_EXT):
                    continue
                # postpone saving until we know clear flag — buffer to memory
                data = await part.read(decode=False)
                saved.append((os.path.basename(fname), data))

        dest = _upload_dir(cycle_id)
        if clear_first:
            for n in os.listdir(dest):
                p = os.path.join(dest, n)
                try:
                    if os.path.isfile(p):
                        os.remove(p)
                except Exception:
                    pass
            # reset counter for this cycle
            with _STATE_LOCK:
                state = _load_state()
                state.pop(cycle_id, None)
                _save_state(state)

        names = []
        for fname, data in saved:
            # avoid collision with existing files
            target = os.path.join(dest, fname)
            stem, ext = os.path.splitext(fname)
            i = 1
            while os.path.exists(target):
                target = os.path.join(dest, f"{stem}_{i}{ext}")
                i += 1
            with open(target, "wb") as f:
                f.write(data)
            names.append(os.path.basename(target))

        total = len(_list_images(dest))
        return web.json_response({
            "ok": True,
            "uploaded": names,
            "folder": dest,
            "total": total,
            "cycle_id": cycle_id,
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@_routes.get("/yg_cycler/info")
async def yg_cycler_info(request):
    cycle_id = request.query.get("cycle_id", "default")
    folder_q = request.query.get("folder", "")
    folder = _resolve_folder(folder_q, cycle_id)
    files = _list_images(folder)
    with _STATE_LOCK:
        state = _load_state()
    counter = int(state.get(cycle_id, {}).get("counter", 0))
    return web.json_response({
        "ok": True,
        "folder": folder,
        "total": len(files),
        "files": [os.path.basename(f) for f in files[:200]],
        "next_index": (counter % len(files)) if files else 0,
        "counter": counter,
        "cycle_id": cycle_id,
    })


@_routes.post("/yg_cycler/reset")
async def yg_cycler_reset(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    cycle_id = body.get("cycle_id", "default")
    with _STATE_LOCK:
        state = _load_state()
        state.pop(cycle_id, None)
        _save_state(state)
    return web.json_response({"ok": True, "cycle_id": cycle_id})


@_routes.post("/yg_cycler/clear")
async def yg_cycler_clear(request):
    """Delete all uploaded images for a cycle_id and reset counter."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    cycle_id = body.get("cycle_id", "default")
    dest = _upload_dir(cycle_id)
    removed = 0
    for n in os.listdir(dest):
        p = os.path.join(dest, n)
        try:
            if os.path.isfile(p):
                os.remove(p)
                removed += 1
        except Exception:
            pass
    with _STATE_LOCK:
        state = _load_state()
        state.pop(cycle_id, None)
        _save_state(state)
    return web.json_response({"ok": True, "cycle_id": cycle_id, "removed": removed})


@_routes.get("/yg_cycler/thumb")
async def yg_cycler_thumb(request):
    """Return a small JPEG thumbnail of one uploaded image."""
    cycle_id = request.query.get("cycle_id", "default")
    name = request.query.get("name", "")
    size = max(48, min(256, int(request.query.get("size", "128"))))
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return web.Response(status=400, text="bad name")
    folder = _upload_dir(cycle_id)
    src = os.path.join(folder, name)
    real = os.path.realpath(src)
    if os.path.commonpath([real, os.path.realpath(folder)]) != os.path.realpath(folder):
        return web.Response(status=403, text="forbidden")
    if not os.path.isfile(real):
        return web.Response(status=404, text="not found")
    try:
        im = Image.open(real)
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        import io
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=80)
        return web.Response(
            body=buf.getvalue(),
            content_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception as e:
        return web.Response(status=500, text=str(e))


@_routes.post("/yg_cycler/delete")
async def yg_cycler_delete(request):
    """Delete one or more named images for a cycle_id."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    cycle_id = body.get("cycle_id", "default")
    names = body.get("names") or []
    if isinstance(names, str):
        names = [names]
    folder = _upload_dir(cycle_id)
    folder_real = os.path.realpath(folder)
    removed = []
    errors = []
    for n in names:
        if not n or "/" in n or "\\" in n or n.startswith("."):
            errors.append({"name": n, "error": "bad name"})
            continue
        path = os.path.join(folder, n)
        real = os.path.realpath(path)
        if os.path.commonpath([real, folder_real]) != folder_real:
            errors.append({"name": n, "error": "outside folder"})
            continue
        try:
            if os.path.isfile(real):
                os.remove(real)
                removed.append(n)
        except Exception as e:
            errors.append({"name": n, "error": str(e)})
    total = len(_list_images(folder))
    return web.json_response({
        "ok": True,
        "cycle_id": cycle_id,
        "removed": removed,
        "errors": errors,
        "total": total,
    })


# ----------------------------------------------------------------------- node

class YGAutoImageCycler:
    """One image per queue run — auto-advances. Pair with Comfy's batch-count."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cycle_id": ("STRING", {
                    "default": "default",
                    "multiline": False,
                    "placeholder": "unique name (use different ones for multiple cyclers)",
                }),
                "folder": ("STRING", {
                    "default": "upload",
                    "multiline": False,
                    "placeholder": "'upload' = use Upload button, or absolute server path",
                }),
                "mode": (["sequential", "random"], {"default": "sequential"}),
                "start_index": ("INT", {
                    "default": 0, "min": 0, "max": 99999, "step": 1,
                }),
                "wrap": ("BOOLEAN", {"default": True}),
                "reset_now": ("BOOLEAN", {
                    "default": False,
                    "label_on": "↻ Reset on next run",
                    "label_off": "no reset",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename", "current_index", "total_count")
    FUNCTION = "next_image"
    CATEGORY = "YG_Nodes"

    @classmethod
    def IS_CHANGED(cls, folder, cycle_id, mode, start_index, wrap, reset_now):
        # Force re-execution on every queued prompt
        return hashlib.sha1(
            f"{cycle_id}|{folder}|{mode}|{start_index}|{wrap}|{reset_now}|{time.time_ns()}".encode()
        ).hexdigest()

    def next_image(self, folder, cycle_id, mode, start_index, wrap, reset_now):
        resolved = _resolve_folder(folder, cycle_id)
        files = _list_images(resolved)
        total = len(files)
        if total == 0:
            raise RuntimeError(
                f"[YGAutoImageCycler] No images found in: {resolved!r}\n"
                f"Click '📁 Upload Images' to add some, or set `folder` to an absolute server path."
            )

        with _STATE_LOCK:
            state = _load_state()
            entry = state.get(cycle_id, {"counter": int(start_index)})

            if reset_now:
                entry["counter"] = int(start_index)

            counter = int(entry.get("counter", start_index))

            if mode == "random":
                idx = int(hashlib.sha1(
                    f"{cycle_id}|{counter}|{time.time_ns()}".encode()
                ).hexdigest(), 16) % total
            else:
                idx = (counter % total) if wrap else min(counter, total - 1)

            entry["counter"] = counter + 1
            state[cycle_id] = entry
            _save_state(state)

        path = files[idx]
        img_t, mask_t = _read_image(path)
        fname = os.path.basename(path)
        print(f"[YGAutoImageCycler] cycle={cycle_id!r}  {idx + 1}/{total}  ->  {fname}")
        return (img_t, mask_t, fname, idx, total)


NODE_CLASS_MAPPINGS = {"YGAutoImageCycler": YGAutoImageCycler}
NODE_DISPLAY_NAME_MAPPINGS = {"YGAutoImageCycler": "YG Auto Image Cycler"}

