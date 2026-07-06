"""
YG ZIP Image Loader
───────────────────
• User clicks "Upload ZIP" → OS file picker opens (browser native popup)
• ZIP is uploaded to the server and extracted (preserves sub-folder structure)
• Each ComfyUI queue run outputs ONE image at a time (avoids OOM)
• Outputs: image, mask, folder_name, filename, current_index, total_count, is_last
"""

import os
import io
import zipfile
import shutil
import asyncio
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths

try:
    import server
    from aiohttp import web
    _HAS_SERVER = True
except Exception:
    _HAS_SERVER = False

VALID_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}


class YGZipImageLoader:
    """
    Loads images one-by-one from an uploaded ZIP file.
    ZIP can contain multiple sub-folders with images.
    Processes ONE image per queue run — no OOM from batch loading.

    Workflow:
      1. Click "📂 Upload ZIP File" button on the node
      2. Pick your .zip from the file chooser dialog
      3. Connect outputs to your pipeline (→ BG Remove → YG ZIP Saver)
      4. Click "▶ Run All Images" — processes every image sequentially
    """

    # In-memory state per job_id. Survives as long as ComfyUI is running.
    _state = {}  # { job_id: { "images": [(rel_path, abs_path), …], "index": int, "extract_dir": str } }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "job_id": ("STRING", {
                    "default": "my_zip_job",
                    "multiline": False,
                    "tooltip": (
                        "Unique job name. Must match the job_id in YG ZIP Image Saver. "
                        "Use different names for different ZIP files."
                    ),
                }),
            }
        }

    RETURN_TYPES  = ("IMAGE", "MASK", "STRING", "STRING", "INT", "INT", "BOOLEAN")
    RETURN_NAMES  = ("image", "mask", "folder_name", "filename",
                     "current_index", "total_count", "is_last")
    FUNCTION      = "load_next_image"
    CATEGORY      = "YG Custom Nodes"
    OUTPUT_NODE   = False

    @classmethod
    def IS_CHANGED(cls, job_id):
        # Always re-execute so the index advances each queue run
        return float("nan")

    def load_next_image(self, job_id):
        state = YGZipImageLoader._state.get(job_id)

        if not state or not state.get("images"):
            raise ValueError(
                f"No ZIP loaded for job '{job_id}'.\n"
                f"Click the '📂 Upload ZIP File' button on the node first."
            )

        images = state["images"]
        total  = len(images)
        idx    = state.get("index", 0)
        idx    = max(0, min(idx, total - 1))

        rel_path, abs_path = images[idx]
        folder_name = os.path.dirname(rel_path)   # sub-folder inside zip (may be empty)
        filename    = os.path.basename(rel_path)

        # ── Load image (mirrors ComfyUI's built-in LoadImage) ──────────────
        img = Image.open(abs_path)
        img = ImageOps.exif_transpose(img)

        if img.mode == 'I':
            img = img.point(lambda i: i * (1 / 255))

        has_alpha = 'A' in img.getbands()
        img_rgb   = img.convert("RGB")
        img_array = np.array(img_rgb).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array)[None,]  # [1, H, W, 3]

        if has_alpha:
            mask_array = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(mask_array)[None,]
        else:
            mask = torch.zeros(
                (1, img_tensor.shape[1], img_tensor.shape[2]),
                dtype=torch.float32,
            )

        # ── Advance index ──────────────────────────────────────────────────
        next_idx = idx + 1
        is_last  = next_idx >= total
        state["index"] = 0 if is_last else next_idx

        if is_last:
            status = f"✅ DONE  {total}/{total} — {rel_path}"
        else:
            status = f"{idx + 1} / {total} — {rel_path}"

        # ── Notify frontend ────────────────────────────────────────────────
        if _HAS_SERVER:
            try:
                server.PromptServer.instance.send_sync(
                    "yg_zip_progress",
                    {
                        "job_id":  job_id,
                        "index":   idx,
                        "total":   total,
                        "is_last": is_last,
                        "status":  status,
                    }
                )
            except Exception:
                pass

        return {
            "ui":     {"text": [status]},
            "result": (img_tensor, mask, folder_name, filename, idx, total, is_last),
        }


# ── REST API endpoints ─────────────────────────────────────────────────────────

if _HAS_SERVER:

    @server.PromptServer.instance.routes.post("/yg/zip_upload")
    async def yg_zip_upload(request):
        """
        Accept a multipart ZIP upload, extract it server-side, register job state.
        Query param: job_id (default: my_zip_job)
        Form field:  zip_file
        """
        try:
            job_id = request.rel_url.query.get("job_id", "my_zip_job")

            reader = await request.multipart()
            field  = await reader.next()

            if field is None or field.name != "zip_file":
                return web.json_response(
                    {"status": "error", "message": "Expected multipart field 'zip_file'"},
                    status=400,
                )

            # ── Create extract dir ─────────────────────────────────────────
            input_dir    = folder_paths.get_input_directory()
            extract_base = os.path.join(input_dir, "yg_zip_jobs")
            extract_dir  = os.path.join(extract_base, job_id)

            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)

            # ── Read uploaded bytes to disk ────────────────────────────────
            zip_path = os.path.join(extract_dir, "_uploaded.zip")
            with open(zip_path, "wb") as f:
                while True:
                    chunk = await field.read_chunk(65536)
                    if not chunk:
                        break
                    f.write(chunk)

            # ── Validate it's actually a ZIP ───────────────────────────────
            if not zipfile.is_zipfile(zip_path):
                os.remove(zip_path)
                return web.json_response(
                    {"status": "error", "message": "Uploaded file is not a valid ZIP"},
                    status=400,
                )

            # ── Background extraction task ─────────────────────────────────
            async def extract_and_notify():
                try:
                    with zipfile.ZipFile(zip_path) as zf:
                        # Safety: skip absolute paths and path traversal entries
                        members = zf.infolist()
                        total_members = len(members)
                        for i, member in enumerate(members):
                            member_path = os.path.realpath(
                                os.path.join(extract_dir, member.filename)
                            )
                            if not member_path.startswith(os.path.realpath(extract_dir)):
                                continue
                            zf.extract(member, extract_dir)
                            
                            await asyncio.sleep(0.001)  # Yield to event loop on EVERY file to prevent server hang

                            # Send progress update every 2 files or on the last file to keep UI responsive
                            if i % 2 == 0 or i == total_members - 1:
                                try:
                                    server.PromptServer.instance.send_sync(
                                        "yg_zip_extract_progress",
                                        {
                                            "job_id": job_id,
                                            "index": i + 1,
                                            "total": total_members,
                                            "filename": member.filename[-40:], # Shorten filename if too long
                                        }
                                    )
                                except Exception:
                                    pass

                    # ── Collect images (sorted, sub-folder aware) ──────────────────
                    images = []
                    for root, dirs, files in os.walk(extract_dir):
                        dirs.sort()
                        for fname in sorted(files):
                            if os.path.splitext(fname)[1].lower() in VALID_EXT:
                                abs_path = os.path.join(root, fname)
                                rel_path = os.path.relpath(abs_path, extract_dir)
                                images.append((rel_path, abs_path))

                    if not images:
                        server.PromptServer.instance.send_sync("yg_zip_extract_error", {
                            "job_id": job_id, 
                            "message": "No images found in ZIP (PNG/JPG/WEBP/BMP/TIFF)"
                        })
                        return

                    YGZipImageLoader._state[job_id] = {
                        "images":      images,
                        "index":       0,
                        "extract_dir": extract_dir,
                    }

                    folders = sorted(set(os.path.dirname(r) for r, _ in images))
                    
                    server.PromptServer.instance.send_sync("yg_zip_extract_done", {
                        "job_id": job_id,
                        "total": len(images),
                        "folders": folders
                    })
                    
                    # Clean up the original zip file
                    try:
                        os.remove(zip_path)
                    except OSError:
                        pass

                except Exception as e:
                    import traceback
                    print(f"ZIP Extraction Error: {traceback.format_exc()}")
                    server.PromptServer.instance.send_sync("yg_zip_extract_error", {
                        "job_id": job_id,
                        "message": str(e)
                    })

            # Start extraction in background and return immediately
            asyncio.create_task(extract_and_notify())

            return web.json_response({
                "status":  "extracting",
                "job_id":  job_id
            })

        except Exception as exc:
            import traceback
            return web.json_response(
                {"status": "error", "message": str(exc), "trace": traceback.format_exc()},
                status=500,
            )

    @server.PromptServer.instance.routes.post("/yg/zip_reset")
    async def yg_zip_reset(request):
        """Reset job index back to image 0."""
        try:
            data   = await request.json()
            job_id = data.get("job_id", "my_zip_job")
            if job_id in YGZipImageLoader._state:
                YGZipImageLoader._state[job_id]["index"] = 0
            return web.json_response({"status": "ok", "job_id": job_id})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)

    @server.PromptServer.instance.routes.get("/yg/zip_job_info")
    async def yg_zip_job_info(request):
        """Return current job progress info."""
        try:
            job_id = request.rel_url.query.get("job_id", "my_zip_job")
            state  = YGZipImageLoader._state.get(job_id)
            if not state:
                return web.json_response(
                    {"status": "no_job", "job_id": job_id, "total": 0, "index": 0}
                )
            return web.json_response({
                "status": "ok",
                "job_id": job_id,
                "total":  len(state["images"]),
                "index":  state["index"],
                "folders": sorted(set(os.path.dirname(r) for r, _ in state["images"])),
            })
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)
