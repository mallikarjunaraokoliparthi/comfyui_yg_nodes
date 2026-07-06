"""
YG Local ZIP Image Loader
───────────────────
• User selects a .zip file from the ComfyUI input folder via dropdown.
• Click "Extract Selected ZIP" to extract it (preserves sub-folder structure).
• Each ComfyUI queue run outputs ONE image at a time (avoids OOM).
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

from .yg_zip_image_loader import YGZipImageLoader

class YGLocalZipImageLoader:
    """
    Loads images one-by-one from a ZIP file in the ComfyUI input folder.
    """

    # Share in-memory state with the regular loader so UI endpoints work correctly
    _state = YGZipImageLoader._state

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        try:
            zip_files = [f for f in os.listdir(input_dir) if f.lower().endswith('.zip')]
        except Exception:
            zip_files = []
        if not zip_files:
            zip_files = ["(No ZIP files in input folder)"]

        return {
            "required": {
                "zip_file": (zip_files, ),
                "job_id": ("STRING", {
                    "default": "my_local_zip_job",
                    "multiline": False,
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
    def IS_CHANGED(cls, zip_file, job_id):
        # Always re-execute so the index advances each queue run
        return float("nan")

    def load_next_image(self, zip_file, job_id):
        state = YGLocalZipImageLoader._state.get(job_id)

        if not state or not state.get("images"):
            # Auto-extract fallback if user forgot to click the Extract button
            input_dir = folder_paths.get_input_directory()
            zip_path = os.path.join(input_dir, zip_file)
            if not os.path.exists(zip_path):
                raise ValueError(f"ZIP file not found: {zip_file}")

            extract_base = os.path.join(input_dir, "yg_zip_jobs")
            extract_dir  = os.path.join(extract_base, job_id)

            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)

            print(f"Auto-extracting local ZIP: {zip_file}...")
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(extract_dir)

            images = []
            for root, dirs, files in os.walk(extract_dir):
                dirs.sort()
                for fname in sorted(files):
                    if os.path.splitext(fname)[1].lower() in VALID_EXT:
                        abs_path = os.path.join(root, fname)
                        rel_path = os.path.relpath(abs_path, extract_dir)
                        images.append((rel_path, abs_path))

            if not images:
                raise ValueError(f"No valid images (PNG/JPG/WEBP) found in {zip_file}.")

            YGLocalZipImageLoader._state[job_id] = {
                "images":      images,
                "index":       0,
                "extract_dir": extract_dir,
            }
            state = YGLocalZipImageLoader._state[job_id]

        images = state["images"]
        total  = len(images)
        idx    = state.get("index", 0)
        idx    = max(0, min(idx, total - 1))

        rel_path, abs_path = images[idx]
        folder_name = os.path.dirname(rel_path)   # sub-folder inside zip (may be empty)
        filename    = os.path.basename(rel_path)

        # ── Load image ──────────────
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
                    "yg_zip_progress", # Reuse same event as regular zip loader
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

    @server.PromptServer.instance.routes.post("/yg/local_zip_extract")
    async def yg_local_zip_extract(request):
        """
        Extract a local zip file from the input directory.
        """
        try:
            data = await request.json()
            job_id = data.get("job_id", "my_local_zip_job")
            zip_filename = data.get("zip_file")

            if not zip_filename:
                return web.json_response({"status": "error", "message": "Missing zip_file parameter"}, status=400)

            input_dir = folder_paths.get_input_directory()
            zip_path = os.path.join(input_dir, zip_filename)

            if not os.path.exists(zip_path):
                return web.json_response({"status": "error", "message": f"File not found: {zip_filename}"}, status=404)

            if not zipfile.is_zipfile(zip_path):
                return web.json_response({"status": "error", "message": "Selected file is not a valid ZIP"}, status=400)

            # ── Extract to jobs dir ───────────────────────────────────────
            extract_base = os.path.join(input_dir, "yg_zip_jobs")
            extract_dir  = os.path.join(extract_base, job_id)

            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)

            # ── Background extraction task ─────────────────────────────────
            async def extract_and_notify():
                try:
                    with zipfile.ZipFile(zip_path) as zf:
                        members = zf.infolist()
                        total_members = len(members)
                        for i, member in enumerate(members):
                            member_path = os.path.realpath(
                                os.path.join(extract_dir, member.filename)
                            )
                            if not member_path.startswith(os.path.realpath(extract_dir)):
                                continue
                            zf.extract(member, extract_dir)
                            
                            await asyncio.sleep(0.001)

                            if i % 2 == 0 or i == total_members - 1:
                                try:
                                    # Reuse the exact same event name so the JS UI works
                                    server.PromptServer.instance.send_sync(
                                        "yg_zip_extract_progress",
                                        {
                                            "job_id": job_id,
                                            "index": i + 1,
                                            "total": total_members,
                                            "filename": member.filename[-40:],
                                        }
                                    )
                                except Exception:
                                    pass

                    # ── Collect images ──────────────────
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

                    YGLocalZipImageLoader._state[job_id] = {
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

                except Exception as e:
                    import traceback
                    print(f"ZIP Extraction Error: {traceback.format_exc()}")
                    server.PromptServer.instance.send_sync("yg_zip_extract_error", {
                        "job_id": job_id,
                        "message": str(e)
                    })

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
