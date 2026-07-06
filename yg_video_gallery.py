"""
YG Video Gallery — ComfyUI custom node.

Server side:
  • Scans the output directory for videos matching a filename_prefix.
  • Serves cached JPEG thumbnails (extracted via ffmpeg, async, on-disk cache).
  • Streams ZIPs of all / selected videos.
  • Supports deleting selected videos.
  • Pushes a `yg_gallery_updated` event to the frontend after every run.

Designed to be safe (path traversal protection), fast (thumb cache + async
ffmpeg), and friendly to large batches (streaming ZIP, hard-capped scan).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import shutil
import tempfile
import time
import zipfile
from typing import Iterable

import folder_paths

try:
    import server
    from aiohttp import web
    _HAS_SERVER = True
except Exception:
    _HAS_SERVER = False


# ─── Constants ────────────────────────────────────────────────────────────────

_VIDEO_EXT = {".mp4", ".webm", ".avi", ".mov", ".mkv", ".m4v"}
_MAX_SCAN_FILES = 5000   # guard against massive output dirs
_THUMB_DIR = os.path.join(tempfile.gettempdir(), "yg_video_thumbs")
_THUMB_SIZES = (96, 160, 240)
os.makedirs(_THUMB_DIR, exist_ok=True)


# ─── Path helpers ─────────────────────────────────────────────────────────────

def _safe_subpath(base: str, rel: str) -> str | None:
    """Return absolute path only if it stays inside base. None otherwise."""
    if not rel or "\x00" in rel:
        return None
    real_base = os.path.realpath(base)
    real_path = os.path.realpath(os.path.join(base, rel))
    try:
        common = os.path.commonpath([real_base, real_path])
    except ValueError:
        return None
    return real_path if common == real_base else None


def _scan_videos(output_dir: str, prefix: str) -> list[str]:
    """
    Find video files under output_dir whose path begins with `prefix`.

    `prefix` may include directory components, e.g. "video/Wan2.2_i2v".
    Search is recursive (date sub-folders included).
    Returns relative paths sorted by mtime (oldest first).
    """
    prefix = (prefix or "").replace("\\", "/").strip("/")
    parts = prefix.split("/") if prefix else []
    file_prefix = parts[-1] if parts else ""
    sub_dirs = parts[:-1]
    search_dir = os.path.join(output_dir, *sub_dirs) if sub_dirs else output_dir

    if not os.path.isdir(search_dir):
        return []

    rows: list[tuple[float, str]] = []
    seen = 0
    for dirpath, _dirs, fnames in os.walk(search_dir):
        for fname in fnames:
            seen += 1
            if seen > _MAX_SCAN_FILES:
                break
            if os.path.splitext(fname)[1].lower() not in _VIDEO_EXT:
                continue
            if file_prefix and not fname.startswith(file_prefix):
                continue
            full = os.path.join(dirpath, fname)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            rel = os.path.relpath(full, output_dir).replace("\\", "/")
            rows.append((mtime, rel))
        if seen > _MAX_SCAN_FILES:
            break

    rows.sort(key=lambda r: r[0])
    return [r[1] for r in rows]


def _signature(output_dir: str, prefix: str) -> str:
    """Lightweight cache key — names + mtimes joined."""
    rels = _scan_videos(output_dir, prefix)
    h = hashlib.sha1()
    for rel in rels:
        h.update(rel.encode("utf-8", "replace"))
        try:
            h.update(str(os.path.getmtime(os.path.join(output_dir, rel))).encode())
        except OSError:
            pass
    return h.hexdigest()


# ─── Thumbnail cache ──────────────────────────────────────────────────────────

def _thumb_cache_path(full_path: str, size: int) -> str:
    """Stable cache filename based on absolute path + mtime + size."""
    try:
        mtime = int(os.path.getmtime(full_path))
    except OSError:
        mtime = 0
    key = f"{full_path}|{mtime}|{size}".encode("utf-8", "replace")
    digest = hashlib.sha1(key).hexdigest()
    return os.path.join(_THUMB_DIR, f"{digest}.jpg")


async def _extract_thumb_async(full_path: str, size: int, dest: str) -> bool:
    """Run ffmpeg asynchronously; return True if `dest` was created."""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", "0",
        "-i", full_path,
        "-frames:v", "1",
        "-vf", f"scale='min({size},iw)':'min({size},ih)':"
               f"force_original_aspect_ratio=decrease",
        "-q:v", "5",
        dest,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(proc.wait(), timeout=20)
        except asyncio.TimeoutError:
            proc.kill()
            return False
        return proc.returncode == 0 and os.path.isfile(dest) and os.path.getsize(dest) > 0
    except FileNotFoundError:
        # ffmpeg not installed
        return False
    except Exception:
        return False


def _placeholder_jpeg(size: int, label: str = "VIDEO") -> bytes:
    """Grey placeholder when ffmpeg is missing or fails."""
    try:
        from PIL import Image, ImageDraw  # lazy
        img = Image.new("RGB", (size, size), "#262626")
        d = ImageDraw.Draw(img)
        # Centered text without a specific font (default bitmap font)
        try:
            tw, th = d.textbbox((0, 0), label)[2:]
        except Exception:
            tw, th = (len(label) * 6, 11)
        d.text(((size - tw) // 2, (size - th) // 2), label, fill="#888")
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=70)
        return buf.getvalue()
    except Exception:
        # Ultra-fallback: 1×1 grey JPEG bytes
        return (
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
            b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08"
            b"\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e"
            b"\x1d\x1a\x1c\x1c $.' \",#\x1c\x1c(7),01444\x1f'9=82<.342\xff"
            b"\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f"
            b"\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00"
            b"\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xc4\x00\xb5"
            b"\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01"
            b"}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07\"q\x142\x81"
            b"\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\t\n\x16\x17\x18\x19"
            b"\x1a%&'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85"
            b"\x86\x87\x88\x89\x8a\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2"
            b"\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8"
            b"\xb9\xba\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5"
            b"\xd6\xd7\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea"
            b"\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00\x08\x01"
            b"\x01\x00\x00?\x00\xfb\xd0\xff\xd9"
        )


# ─── Node ─────────────────────────────────────────────────────────────────────

class YGVideoGallery:
    """
    Visual gallery of generated videos for a batch.

    Place this node anywhere in your workflow.
    Set `filename_prefix` to the SAME value as your Save Video node
    (e.g. `video/Wan2.2_i2v`).
    """

    # batch_id -> [rel_path, ...]
    _manifests: dict[str, list[str]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "batch_id": ("STRING", {
                    "default": "my_batch",
                    "tooltip": "Used for ZIP filenames and event filtering. "
                               "Pair with YG Bulk Image Loader if used.",
                }),
                "filename_prefix": ("STRING", {
                    "default": "video/Wan2.2_i2v",
                    "tooltip": "Same prefix as your Save Video node. "
                               "May include sub-folder, e.g. 'video/Wan2.2_i2v'.",
                }),
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE  = True
    FUNCTION     = "update_gallery"
    CATEGORY     = "YG Custom Nodes"

    @classmethod
    def IS_CHANGED(cls, batch_id, filename_prefix):
        # Re-run only when the on-disk state actually changes.
        try:
            return _signature(folder_paths.get_output_directory(), filename_prefix)
        except Exception:
            return time.time()

    def update_gallery(self, batch_id, filename_prefix):
        output_dir = folder_paths.get_output_directory()
        videos = _scan_videos(output_dir, filename_prefix)
        YGVideoGallery._manifests[batch_id] = videos

        if _HAS_SERVER:
            try:
                server.PromptServer.instance.send_sync(
                    "yg_gallery_updated",
                    {"batch_id": batch_id, "prefix": filename_prefix,
                     "count": len(videos)},
                )
            except Exception:
                pass

        return {"ui": {"text": [f"{len(videos)} videos found"]}}


# ─── HTTP API ─────────────────────────────────────────────────────────────────

if _HAS_SERVER:

    routes = server.PromptServer.instance.routes

    # ---- list ----------------------------------------------------------------

    @routes.get("/yg/batch_video_list")
    async def yg_batch_video_list(request):
        try:
            batch_id = request.rel_url.query.get("batch_id", "my_batch")
            prefix   = request.rel_url.query.get("prefix", "")
            output_dir = folder_paths.get_output_directory()
            videos = _scan_videos(output_dir, prefix)
            YGVideoGallery._manifests[batch_id] = videos

            # Enrich with size + mtime so the UI can show file info
            items = []
            for rel in videos:
                full = os.path.join(output_dir, rel)
                try:
                    st = os.stat(full)
                    items.append({
                        "rel_path": rel,
                        "filename": os.path.basename(rel),
                        "size":     st.st_size,
                        "mtime":    st.st_mtime,
                    })
                except OSError:
                    continue
            return web.json_response({
                "videos": videos,        # back-compat (list of strings)
                "items":  items,
                "count":  len(items),
            })
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    # ---- thumbnail (cached) --------------------------------------------------

    @routes.get("/yg/video_thumb")
    async def yg_video_thumb(request):
        try:
            rel = request.rel_url.query.get("rel_path", "")
            if not rel:
                return web.Response(status=400, text="rel_path required")

            try:
                size = int(request.rel_url.query.get("max_size", "120"))
            except ValueError:
                size = 120
            # Snap to a small set of sizes so the cache stays bounded
            size = min(_THUMB_SIZES, key=lambda s: abs(s - size))

            output_dir = folder_paths.get_output_directory()
            full = _safe_subpath(output_dir, rel)
            if not full or not os.path.isfile(full):
                return web.Response(status=404, text="Not found")

            cache = _thumb_cache_path(full, size)
            if not os.path.isfile(cache) or os.path.getsize(cache) == 0:
                ok = await _extract_thumb_async(full, size, cache)
                if not ok:
                    return web.Response(
                        body=_placeholder_jpeg(size),
                        content_type="image/jpeg",
                        headers={"Cache-Control": "max-age=60"},
                    )

            return web.FileResponse(
                cache,
                headers={
                    "Content-Type":  "image/jpeg",
                    "Cache-Control": "max-age=86400",
                },
            )
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    # ---- delete --------------------------------------------------------------

    @routes.post("/yg/delete_videos")
    async def yg_delete_videos(request):
        try:
            data = await request.json()
            rel_paths: Iterable[str] = data.get("rel_paths", []) or []
            output_dir = folder_paths.get_output_directory()

            deleted, failed = [], []
            for rel in rel_paths:
                full = _safe_subpath(output_dir, rel)
                if not full or not os.path.isfile(full):
                    failed.append(rel)
                    continue
                try:
                    os.remove(full)
                    deleted.append(rel)
                    # Drop any cached thumbs for this file
                    for s in _THUMB_SIZES:
                        cp = _thumb_cache_path(full, s)
                        if os.path.isfile(cp):
                            try:
                                os.remove(cp)
                            except OSError:
                                pass
                except OSError as e:
                    failed.append(f"{rel}: {e}")

            return web.json_response({"deleted": deleted, "failed": failed})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    # ---- ZIP download (all matching prefix) ----------------------------------

    def _build_zip(output_dir: str, rels: list[str]) -> tuple[str, int]:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="yg_videos_")
        os.close(tmp_fd)
        added = 0
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            used = set()
            for rel in rels:
                full = _safe_subpath(output_dir, rel)
                if not full or not os.path.isfile(full):
                    continue
                # De-duplicate filenames inside the zip
                arcname = os.path.basename(full)
                base, ext = os.path.splitext(arcname)
                i = 1
                while arcname in used:
                    arcname = f"{base}_{i}{ext}"
                    i += 1
                used.add(arcname)
                zf.write(full, arcname)
                added += 1
        return tmp_path, added

    async def _zip_response(tmp_path: str, zip_name: str) -> web.FileResponse:
        async def _cleanup():
            await asyncio.sleep(120)
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        asyncio.create_task(_cleanup())
        return web.FileResponse(
            tmp_path,
            headers={
                "Content-Disposition": f'attachment; filename="{zip_name}"',
                "Content-Type": "application/zip",
            },
        )

    @routes.get("/yg/download_videos_zip")
    async def yg_download_videos_zip(request):
        try:
            prefix   = request.rel_url.query.get("prefix", "")
            batch_id = request.rel_url.query.get("batch_id", "my_batch")
            output_dir = folder_paths.get_output_directory()
            videos = _scan_videos(output_dir, prefix)
            if not videos:
                return web.Response(status=404, text="No videos found.")

            tmp_path, added = await asyncio.get_event_loop().run_in_executor(
                None, _build_zip, output_dir, videos,
            )
            if added == 0:
                try: os.unlink(tmp_path)
                except OSError: pass
                return web.Response(status=404, text="No valid files.")
            return await _zip_response(tmp_path, f"batch_{batch_id}_{added}videos.zip")
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    @routes.post("/yg/download_selected_zip")
    async def yg_download_selected_zip(request):
        try:
            data = await request.json()
            batch_id  = data.get("batch_id", "my_batch")
            rel_paths = data.get("rel_paths", []) or []
            if not rel_paths:
                return web.Response(status=400, text="No files selected.")
            output_dir = folder_paths.get_output_directory()
            tmp_path, added = await asyncio.get_event_loop().run_in_executor(
                None, _build_zip, output_dir, list(rel_paths),
            )
            if added == 0:
                try: os.unlink(tmp_path)
                except OSError: pass
                return web.Response(status=404, text="No valid files.")
            return await _zip_response(tmp_path, f"selected_{batch_id}_{added}videos.zip")
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    # ---- thumb-cache maintenance --------------------------------------------

    @routes.post("/yg/clear_thumb_cache")
    async def yg_clear_thumb_cache(_request):
        try:
            shutil.rmtree(_THUMB_DIR, ignore_errors=True)
            os.makedirs(_THUMB_DIR, exist_ok=True)
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
