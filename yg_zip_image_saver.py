"""
YG ZIP Image Saver
──────────────────
• Receives each background-removed image + folder_name + filename from YG ZIP Image Loader
• Saves each image as PNG (lossless) preserving original sub-folder structure
• On is_last=True → packages everything into a downloadable ZIP
• "Create ZIP Now" button also works if run was interrupted (packages whatever is saved)
• Frontend shows a "⬇ Download ZIP" button that triggers browser download
"""

import os
import zipfile

import torch
import numpy as np
from PIL import Image
import folder_paths

try:
    import server
    from aiohttp import web
    _HAS_SERVER = True
except Exception:
    _HAS_SERVER = False


class YGZipImageSaver:
    """
    Saves background-removed images maintaining original folder structure.
    On is_last=True → creates a downloadable ZIP file.

    Connect:
      YG ZIP Image Loader → [BG Remove] → YG ZIP Image Saver
    Make sure job_id matches the Loader node.
    """

    # {job_id: {"zip_path": str, "zip_ready": bool}}
    _state = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images":      ("IMAGE",),
                "folder_name": ("STRING", {"forceInput": True}),
                "filename":    ("STRING", {"forceInput": True}),
                "is_last":     ("BOOLEAN", {"forceInput": True}),
                "job_id":      ("STRING", {
                    "default": "my_zip_job",
                    "multiline": False,
                    "tooltip": "Must match the job_id in YG ZIP Image Loader.",
                }),
            },
            "optional": {
                "current_index": ("INT",  {"forceInput": True, "default": 0}),
                "total_count":   ("INT",  {"forceInput": True, "default": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION     = "save_image"
    CATEGORY     = "YG Custom Nodes"
    OUTPUT_NODE  = True

    def save_image(self, images, folder_name, filename, is_last, job_id,
                   current_index=0, total_count=1):

        output_dir     = folder_paths.get_output_directory()
        job_output_dir = os.path.join(output_dir, "yg_zip_output", job_id)

        # ── Determine save path (mirror original folder structure) ────────
        if folder_name:
            save_dir = os.path.join(job_output_dir, folder_name)
        else:
            save_dir = job_output_dir
        os.makedirs(save_dir, exist_ok=True)

        # ── Convert tensor → PIL and save as PNG ──────────────────────────
        # Use the exact same conversion as ComfyUI's built-in SaveImage node
        i         = 255.0 * images[0].cpu().numpy()
        pil_img   = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

        base, _   = os.path.splitext(filename)
        save_path = os.path.join(save_dir, base + ".png")
        pil_img.save(save_path)  # PIL infers PNG from extension

        # ── If last image → build ZIP ──────────────────────────────────────
        zip_path = None
        if is_last:
            zip_dir  = os.path.join(output_dir, "yg_zip_output")
            os.makedirs(zip_dir, exist_ok=True)
            zip_path = os.path.join(zip_dir, f"{job_id}_bg_removed.zip")

            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for root, dirs, files in os.walk(job_output_dir):
                    dirs.sort()
                    for f in sorted(files):
                        if f.endswith(".png"):
                            abs_f = os.path.join(root, f)
                            rel_f = os.path.relpath(abs_f, job_output_dir)
                            zf.write(abs_f, rel_f)

            YGZipImageSaver._state[job_id] = {
                "zip_path":  zip_path,
                "zip_ready": True,
            }

            # Notify frontend → show Download button
            if _HAS_SERVER:
                try:
                    server.PromptServer.instance.send_sync(
                        "yg_zip_ready",
                        {
                            "job_id":   job_id,
                            "filename": f"{job_id}_bg_removed.zip",
                            "total":    total_count,
                        }
                    )
                except Exception:
                    pass

            status = f"✅ ZIP ready! {total_count} images → {job_id}_bg_removed.zip"
        else:
            status = f"💾 Saved {current_index + 1}/{total_count} — {folder_name + '/' if folder_name else ''}{filename}"

            # Send real-time progress to frontend for each saved image
            if _HAS_SERVER:
                try:
                    server.PromptServer.instance.send_sync(
                        "yg_zip_save_progress",
                        {
                            "job_id":        job_id,
                            "current_index": current_index,
                            "total_count":   total_count,
                            "folder_name":   folder_name,
                            "filename":      filename,
                        }
                    )
                except Exception:
                    pass

        return {"ui": {"text": [status]}}


# ── REST API endpoints ─────────────────────────────────────────────────────────

def _build_zip(job_id):
    """Package all PNGs in the job output folder into a ZIP. Returns (zip_path, count)."""
    output_dir     = folder_paths.get_output_directory()
    job_output_dir = os.path.join(output_dir, "yg_zip_output", job_id)
    zip_dir        = os.path.join(output_dir, "yg_zip_output")
    os.makedirs(zip_dir, exist_ok=True)
    zip_path = os.path.join(zip_dir, f"{job_id}_bg_removed.zip")

    count = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(job_output_dir):
            dirs.sort()
            for f in sorted(files):
                if f.lower().endswith(".png"):
                    abs_f = os.path.join(root, f)
                    rel_f = os.path.relpath(abs_f, job_output_dir)
                    zf.write(abs_f, rel_f)
                    count += 1

    return zip_path, count


if _HAS_SERVER:

    @server.PromptServer.instance.routes.get("/yg/zip_download")
    async def yg_zip_download(request):
        """Stream the output ZIP as a file download."""
        try:
            job_id = request.rel_url.query.get("job_id", "my_zip_job")
            state  = YGZipImageSaver._state.get(job_id)

            if not state or not state.get("zip_ready"):
                return web.Response(status=404, text="ZIP not ready yet — run all images first")

            zip_path = state["zip_path"]
            if not os.path.isfile(zip_path):
                return web.Response(status=404, text="ZIP file missing on disk")

            fname = os.path.basename(zip_path)
            return web.FileResponse(
                zip_path,
                headers={
                    "Content-Disposition": f'attachment; filename="{fname}"',
                    "Content-Type":        "application/zip",
                },
            )
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    @server.PromptServer.instance.routes.post("/yg/zip_create_now")
    async def yg_zip_create_now(request):
        """
        Manually build the output ZIP from whatever images are already saved.
        Works even if the run was interrupted before the last image.
        """
        try:
            data   = await request.json()
            job_id = data.get("job_id", "my_zip_job")

            output_dir     = folder_paths.get_output_directory()
            job_output_dir = os.path.join(output_dir, "yg_zip_output", job_id)

            if not os.path.isdir(job_output_dir):
                return web.json_response(
                    {"status": "error", "message": f"No saved images found for job '{job_id}'"},
                    status=404,
                )

            zip_path, count = _build_zip(job_id)

            if count == 0:
                return web.json_response(
                    {"status": "error", "message": "No PNG images found to zip"},
                    status=400,
                )

            YGZipImageSaver._state[job_id] = {
                "zip_path":  zip_path,
                "zip_ready": True,
            }

            return web.json_response({
                "status":   "ok",
                "job_id":   job_id,
                "count":    count,
                "filename": os.path.basename(zip_path),
            })
        except Exception as exc:
            import traceback
            return web.json_response(
                {"status": "error", "message": str(exc), "trace": traceback.format_exc()},
                status=500,
            )

    @server.PromptServer.instance.routes.get("/yg/zip_output_status")
    async def yg_zip_output_status(request):
        """Return whether the output ZIP is ready."""
        try:
            job_id = request.rel_url.query.get("job_id", "my_zip_job")
            state  = YGZipImageSaver._state.get(job_id)
            if state and state.get("zip_ready"):
                return web.json_response({
                    "ready":    True,
                    "job_id":   job_id,
                    "filename": os.path.basename(state["zip_path"]),
                })
            return web.json_response({"ready": False, "job_id": job_id})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)

    @server.PromptServer.instance.routes.post("/yg/zip_output_clear")
    async def yg_zip_output_clear(request):
        """Clear the output state AND saved images for a job (fresh start)."""
        import shutil
        try:
            data        = await request.json()
            job_id      = data.get("job_id", "my_zip_job")
            also_delete = data.get("delete_images", True)

            YGZipImageSaver._state.pop(job_id, None)

            if also_delete:
                output_dir     = folder_paths.get_output_directory()
                job_output_dir = os.path.join(output_dir, "yg_zip_output", job_id)
                old_zip        = os.path.join(output_dir, "yg_zip_output", f"{job_id}_bg_removed.zip")
                if os.path.isdir(job_output_dir):
                    shutil.rmtree(job_output_dir)
                if os.path.isfile(old_zip):
                    os.remove(old_zip)

            return web.json_response({"status": "ok", "job_id": job_id})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)
