"""
YG Direct Image Zipper
──────────────────────
• Takes images directly (no loader needed)
• Saves all images to a ZIP file
• Simple one-click download
"""

import os
import zipfile
import uuid
from datetime import datetime

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


class YGDirectImageZipper:
    """
    Simple image-to-ZIP converter.
    Takes any images and packages them into a downloadable ZIP.

    Connect:
      [Any Image Source] → YG Direct Image Zipper
    """

    _state = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images":    ("IMAGE",),
                "zip_name":  ("STRING", {
                    "default": "images",
                    "multiline": False,
                    "tooltip": "Name for the ZIP file (without .zip extension)",
                }),
            },
            "optional": {
                "create_zip": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "zip_images"
    CATEGORY = "YG Custom Nodes"
    OUTPUT_NODE = True

    def zip_images(self, images, zip_name="images", create_zip=True):
        """
        Takes a batch of images and packages them into a ZIP.
        """
        # Generate unique job ID
        job_id = f"{zip_name}_{uuid.uuid4().hex[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        output_dir = folder_paths.get_output_directory()
        job_output_dir = os.path.join(output_dir, "yg_zip_output", job_id)
        os.makedirs(job_output_dir, exist_ok=True)

        # ── Save all images ──────────────────────────────────────────────
        num_images = images.shape[0]

        for idx, img_tensor in enumerate(images):
            # Convert tensor → PIL
            i = 255.0 * img_tensor.cpu().numpy()
            pil_img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            # Save as PNG
            filename = f"image_{idx:04d}.png"
            save_path = os.path.join(job_output_dir, filename)
            pil_img.save(save_path)

        # ── Create ZIP ──────────────────────────────────────────────────
        zip_dir = os.path.join(output_dir, "yg_zip_output")
        os.makedirs(zip_dir, exist_ok=True)

        zip_filename = f"{zip_name}.zip"
        zip_path = os.path.join(zip_dir, zip_filename)

        if create_zip:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for root, dirs, files in os.walk(job_output_dir):
                    for f in sorted(files):
                        if f.endswith(".png"):
                            abs_f = os.path.join(root, f)
                            rel_f = os.path.relpath(abs_f, job_output_dir)
                            zf.write(abs_f, rel_f)

            YGDirectImageZipper._state[job_id] = {
                "zip_path": zip_path,
                "zip_ready": True,
                "count": num_images,
            }

            # Notify frontend
            if _HAS_SERVER:
                try:
                    server.PromptServer.instance.send_sync(
                        "yg_zip_ready",
                        {
                            "job_id": job_id,
                            "filename": zip_filename,
                            "total": num_images,
                        }
                    )
                except Exception:
                    pass

            status = f"✅ ZIP ready! {num_images} images → {zip_filename}"
        else:
            status = f"💾 Saved {num_images} images (ready to zip)"

        return {"ui": {"text": [status]}}


# ── REST API endpoints ─────────────────────────────────────────────────────

if _HAS_SERVER:

    @server.PromptServer.instance.routes.get("/yg/direct_zip_download")
    async def yg_direct_zip_download(request):
        """Stream the ZIP as a file download."""
        try:
            job_id = request.rel_url.query.get("job_id", "")
            state = YGDirectImageZipper._state.get(job_id)

            if not state or not state.get("zip_ready"):
                return web.Response(status=404, text="ZIP not ready — run the node first")

            zip_path = state["zip_path"]
            if not os.path.isfile(zip_path):
                return web.Response(status=404, text="ZIP file missing on disk")

            fname = os.path.basename(zip_path)
            return web.FileResponse(
                zip_path,
                headers={
                    "Content-Disposition": f'attachment; filename="{fname}"',
                    "Content-Type": "application/zip",
                },
            )
        except Exception as exc:
            return web.Response(status=500, text=str(exc))
