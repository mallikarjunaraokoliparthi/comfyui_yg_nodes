"""
YG Video Collector
==================

Pass-through node placed between (Image to Video) and (Save Video).
Every time a prompt produces a video, this node copies it into a per-collection
folder and exposes a grid UI to preview / select / download / delete.

Wiring:
    Image to Video (Wan2.2)  ──video──▶  YG Video Collector  ──video──▶  Save Video

Storage:
    output/yg_collector/<collection_id>/  ← copied videos (mp4)
    output/yg_collector/<collection_id>/_index.json  ← metadata
    output/yg_collector/<collection_id>/_thumbs/    ← cached jpg thumbs
"""

import os
import io
import json
import time
import shutil
import asyncio
import zipfile
import hashlib
import threading
import subprocess
from pathlib import Path

import folder_paths
from aiohttp import web
import server

# --------------------------------------------------------------------- helpers

_LOCK = threading.Lock()


def _safe_id(s: str) -> str:
    s = (s or "default").strip() or "default"
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in s)[:64]


def _coll_dir(cid: str) -> str:
    base = os.path.join(folder_paths.get_output_directory(), "yg_collector", _safe_id(cid))
    os.makedirs(base, exist_ok=True)
    os.makedirs(os.path.join(base, "_thumbs"), exist_ok=True)
    return base


def _index_path(cid: str) -> str:
    return os.path.join(_coll_dir(cid), "_index.json")


def _load_index(cid: str) -> list:
    p = _index_path(cid)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r") as f:
            return json.load(f) or []
    except Exception:
        return []


def _save_index(cid: str, items: list) -> None:
    p = _index_path(cid)
    tmp = p + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(items, f, indent=2)
        os.replace(tmp, p)
    except Exception:
        pass


def _extract_video_path(video_obj) -> str:
    """Best-effort: get a filesystem path from a ComfyUI VIDEO object."""
    if video_obj is None:
        return ""
    if isinstance(video_obj, str):
        return video_obj if os.path.isfile(video_obj) else ""
    # VideoFromFile / similar
    for attr in ("file", "filename", "path", "_path", "source", "_file"):
        v = getattr(video_obj, attr, None)
        if isinstance(v, (str, os.PathLike)) and os.path.isfile(str(v)):
            return str(v)
    # method-based
    for meth in ("get_stream_source", "get_path", "get_filename"):
        fn = getattr(video_obj, meth, None)
        if callable(fn):
            try:
                v = fn()
                if isinstance(v, (str, os.PathLike)) and os.path.isfile(str(v)):
                    return str(v)
            except Exception:
                pass
    return ""


def _save_video_via_object(video_obj, dst_path: str) -> bool:
    """If VIDEO object has a save_to(path) method, use it. Returns True on success."""
    try:
        for meth in ("save_to", "save", "write_to"):
            fn = getattr(video_obj, meth, None)
            if callable(fn):
                fn(dst_path)
                if os.path.isfile(dst_path) and os.path.getsize(dst_path) > 0:
                    return True
    except Exception:
        pass
    return False


def _make_thumb(src_video: str, dst_jpg: str, size: int = 200) -> bool:
    if os.path.isfile(dst_jpg) and os.path.getsize(dst_jpg) > 0:
        return True
    try:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", "0.5", "-i", src_video,
            "-frames:v", "1",
            "-vf", f"scale='min({size},iw)':-2",
            "-q:v", "5",
            dst_jpg,
        ]
        subprocess.run(cmd, timeout=20, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return os.path.isfile(dst_jpg) and os.path.getsize(dst_jpg) > 0
    except Exception:
        return False


def _add_video(cid: str, src_path: str, video_obj=None) -> dict:
    """Copy src_path into the collection. Returns the new index entry."""
    folder = _coll_dir(cid)
    ts = time.strftime("%Y%m%d_%H%M%S")
    n = len(_load_index(cid)) + 1
    base = f"{ts}_{n:04d}"
    ext = os.path.splitext(src_path)[1].lower() if src_path else ".mp4"
    if ext not in (".mp4", ".webm", ".mkv", ".mov", ".gif"):
        ext = ".mp4"
    dst = os.path.join(folder, base + ext)

    ok = False
    if src_path and os.path.isfile(src_path):
        try:
            shutil.copy2(src_path, dst)
            ok = True
        except Exception:
            ok = False
    if not ok and video_obj is not None:
        ok = _save_video_via_object(video_obj, dst)

    if not ok:
        return {}

    entry = {
        "name": os.path.basename(dst),
        "size": os.path.getsize(dst),
        "mtime": int(os.path.getmtime(dst)),
        "source": src_path,
        "added_at": int(time.time()),
    }
    with _LOCK:
        items = _load_index(cid)
        items.append(entry)
        _save_index(cid, items)
    return entry


# --------------------------------------------------------------------- HTTP

_routes = server.PromptServer.instance.routes


@_routes.get("/yg_collector/list")
async def list_collection(request):
    cid = request.query.get("collection_id", "default")
    folder = _coll_dir(cid)
    items = _load_index(cid)
    # filter to existing files
    items = [it for it in items if os.path.isfile(os.path.join(folder, it["name"]))]
    return web.json_response({"ok": True, "collection_id": cid, "folder": folder,
                              "total": len(items), "items": items})


@_routes.get("/yg_collector/thumb")
async def thumb(request):
    cid = request.query.get("collection_id", "default")
    name = request.query.get("name", "")
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return web.Response(status=400, text="bad name")
    folder = _coll_dir(cid)
    src = os.path.join(folder, name)
    if not os.path.isfile(src):
        return web.Response(status=404, text="not found")
    thumb_path = os.path.join(folder, "_thumbs", name + ".jpg")
    loop = asyncio.get_event_loop()
    ok = await loop.run_in_executor(None, _make_thumb, src, thumb_path, 240)
    if not ok or not os.path.isfile(thumb_path):
        return web.Response(status=500, text="thumb failed")
    with open(thumb_path, "rb") as f:
        return web.Response(body=f.read(), content_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=3600"})


@_routes.get("/yg_collector/video")
async def get_video(request):
    cid = request.query.get("collection_id", "default")
    name = request.query.get("name", "")
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return web.Response(status=400, text="bad name")
    folder = _coll_dir(cid)
    src = os.path.join(folder, name)
    if not os.path.isfile(src):
        return web.Response(status=404, text="not found")
    return web.FileResponse(src, headers={"Cache-Control": "public, max-age=3600"})


@_routes.post("/yg_collector/delete")
async def delete_videos(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    cid = body.get("collection_id", "default")
    names = body.get("names") or []
    if isinstance(names, str):
        names = [names]
    folder = _coll_dir(cid)
    folder_real = os.path.realpath(folder)
    removed = []
    for n in names:
        if not n or "/" in n or "\\" in n or n.startswith("."):
            continue
        path = os.path.join(folder, n)
        real = os.path.realpath(path)
        if os.path.commonpath([real, folder_real]) != folder_real:
            continue
        try:
            if os.path.isfile(real):
                os.remove(real)
                removed.append(n)
            tp = os.path.join(folder, "_thumbs", n + ".jpg")
            if os.path.isfile(tp):
                os.remove(tp)
        except Exception:
            pass
    with _LOCK:
        items = _load_index(cid)
        items = [it for it in items if it["name"] not in set(removed)]
        _save_index(cid, items)
    return web.json_response({"ok": True, "removed": removed, "total": len(items)})


@_routes.post("/yg_collector/clear")
async def clear_collection(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    cid = body.get("collection_id", "default")
    folder = _coll_dir(cid)
    removed = 0
    for n in os.listdir(folder):
        p = os.path.join(folder, n)
        if os.path.isfile(p):
            try:
                os.remove(p)
                removed += 1
            except Exception:
                pass
    tdir = os.path.join(folder, "_thumbs")
    if os.path.isdir(tdir):
        for n in os.listdir(tdir):
            try: os.remove(os.path.join(tdir, n))
            except Exception: pass
    _save_index(cid, [])
    return web.json_response({"ok": True, "removed": removed})


@_routes.post("/yg_collector/download_zip")
async def download_zip(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    cid = body.get("collection_id", "default")
    names = body.get("names")  # optional list
    folder = _coll_dir(cid)
    items = _load_index(cid)
    if names:
        sel = set(names)
        items = [it for it in items if it["name"] in sel]
    if not items:
        return web.Response(status=404, text="no files")

    def _build():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for it in items:
                p = os.path.join(folder, it["name"])
                if os.path.isfile(p):
                    zf.write(p, arcname=it["name"])
        return buf.getvalue()

    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _build)
    fname = f"{_safe_id(cid)}_{int(time.time())}.zip"
    return web.Response(
        body=data, content_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# --------------------------------------------------------------------- node

class YGVideoCollector:
    """Pass-through: copies every produced video into a collection for review."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO",),
                "collection_id": ("STRING", {
                    "default": "default", "multiline": False,
                    "placeholder": "section / batch name (e.g. wan22_run1)",
                }),
                "enabled": ("BOOLEAN", {"default": True,
                                        "label_on": "✅ collecting",
                                        "label_off": "⏸ paused (passthrough only)"}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "collect"
    CATEGORY = "YG_Nodes"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, video, collection_id, enabled):
        # Re-execute every run so we capture every video
        return hashlib.sha1(f"{collection_id}|{enabled}|{time.time_ns()}".encode()).hexdigest()

    def collect(self, video, collection_id, enabled):
        if enabled:
            try:
                src = _extract_video_path(video)
                entry = _add_video(collection_id, src, video_obj=video)
                if entry:
                    print(f"[YGVideoCollector] +{entry['name']}  "
                          f"({entry['size']/1024:.0f} KB)  collection={collection_id!r}")
                else:
                    print(f"[YGVideoCollector] WARN: could not extract/save video for collection {collection_id!r}")
            except Exception as e:
                print(f"[YGVideoCollector] error: {e}")
        return (video,)


NODE_CLASS_MAPPINGS = {"YGVideoCollector": YGVideoCollector}
NODE_DISPLAY_NAME_MAPPINGS = {"YGVideoCollector": "YG Video Collector"}
