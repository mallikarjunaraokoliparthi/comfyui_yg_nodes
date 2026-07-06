"""
Z Save All Images - saves every generated image into one user-chosen folder.
'Run All' on the Prompt List node clears the folder first, so only the
current batch ends up in the zip. One Download button appears after the
first image is saved.
"""

import os
import json
import re
import zipfile
import shutil

import numpy as np
from PIL import Image, PngImagePlugin

import folder_paths

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/yg_save_all_images/download")
    async def _z_save_all_download(request):
        folder   = request.query.get("folder", "").strip()
        zip_name = request.query.get("zip", "all_images.zip").strip()
        if not folder:
            return web.Response(status=400, text="missing folder")
        if not zip_name.lower().endswith(".zip"):
            zip_name += ".zip"
        folder   = os.path.abspath(os.path.expanduser(folder))
        zip_path = os.path.join(folder, zip_name)
        if not os.path.isfile(zip_path):
            return web.Response(status=404,
                text=f"Zip not found: {zip_path}\nRun the workflow first.")
        return web.FileResponse(zip_path, headers={
            "Content-Disposition": f'attachment; filename="{zip_name}"',
            "Content-Type": "application/zip",
        })

    @PromptServer.instance.routes.post("/yg_save_all_images/reset")
    async def _z_save_all_reset(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        folder = (data.get("folder") or "").strip()
        if not folder:
            return web.Response(status=400, text="missing folder")
        folder = os.path.abspath(os.path.expanduser(folder))
        if os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)
        os.makedirs(folder, exist_ok=True)
        YGSaveAllImages._reset_done.discard(folder)
        print(f"[YGSaveAllImages] folder cleared: {folder}")
        return web.json_response({"ok": True, "folder": folder})

except Exception as e:
    print(f"[YGSaveAllImages] could not register routes: {e}")


_SAFE_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def _safe_name(name: str) -> str:
    cleaned = _SAFE_NAME_RE.sub("_", (name or "").strip()).strip(". ")
    return cleaned or "uncategorized"


class YGSaveAllImages:
    """Save images per category and download them all as one zip."""

    def __init__(self):
        self.type = "output"

    _reset_done = set()

    @classmethod
    def INPUT_TYPES(cls):
        default_dir = os.path.join(folder_paths.get_output_directory(), "z_save_all")
        return {
            "required": {
                "images":          ("IMAGE",),
                "output_folder":   ("STRING", {"default": default_dir, "multiline": False}),
                "filename_prefix": ("STRING", {"default": "image", "multiline": False}),
                "format":          (["png", "jpg", "webp"], {"default": "png"}),
                "quality":         ("INT", {"default": 95, "min": 1, "max": 100}),
                "zip_filename":    ("STRING", {"default": "all_images.zip", "multiline": False}),
            },
            "optional": {
                "subfolder": ("STRING", {"default": "", "forceInput": True}),
                "filename":  ("STRING", {"default": "", "forceInput": True}),
            },
            "hidden": {
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION     = "save_all"
    OUTPUT_NODE  = True
    CATEGORY     = "YG/IO"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def save_all(self, images, output_folder, filename_prefix, format, quality,
                 zip_filename, subfolder="", filename="", prompt=None, extra_pnginfo=None):

        root = os.path.abspath(os.path.expanduser(output_folder.strip()))
        os.makedirs(root, exist_ok=True)

        sub        = _safe_name(subfolder) if (subfolder or "").strip() else ""
        target_dir = os.path.join(root, sub) if sub else root
        os.makedirs(target_dir, exist_ok=True)

        ext             = format.lower()
        use_prompt_name = bool((filename or "").strip())

        if use_prompt_name:
            name_base = _safe_name(filename)[:100]
        else:
            existing    = [f for f in os.listdir(target_dir)
                           if f.lower().startswith(filename_prefix.lower())
                           and f.lower().endswith(f".{ext}")]
            start_index = self._next_index(existing, filename_prefix, ext)

        saved_files = []
        ui_images   = []

        for i, image_tensor in enumerate(images):
            arr = (np.clip(image_tensor.cpu().numpy(), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            img = Image.fromarray(arr)

            if use_prompt_name:
                candidate = f"{name_base}.{ext}"
                counter   = 2
                while os.path.exists(os.path.join(target_dir, candidate)):
                    candidate = f"{name_base}_{counter}.{ext}"
                    counter  += 1
                out_name = candidate
            else:
                out_name = f"{filename_prefix}_{start_index + i:05d}.{ext}"

            full_path   = os.path.join(target_dir, out_name)
            save_kwargs = {}

            if ext == "png":
                pnginfo = PngImagePlugin.PngInfo()
                if prompt is not None:
                    pnginfo.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo:
                    for k, v in extra_pnginfo.items():
                        pnginfo.add_text(k, json.dumps(v))
                save_kwargs = {"pnginfo": pnginfo, "compress_level": 4}
            elif ext == "jpg":
                if img.mode != "RGB":
                    img = img.convert("RGB")
                save_kwargs = {"quality": int(quality), "optimize": True}
            elif ext == "webp":
                save_kwargs = {"quality": int(quality)}

            img.save(full_path, **save_kwargs)
            saved_files.append(full_path)
            ui_images.append({"filename": out_name, "subfolder": sub, "type": "output"})
            print(f"[YGSaveAllImages] saved -> {full_path}")

        # Append only the newly saved files to the zip.
        # Never rebuild from scratch (that is O(n²) → hours for large batches).
        if not zip_filename.lower().endswith(".zip"):
            zip_filename += ".zip"
        zip_path = os.path.join(root, zip_filename)
        self._append_to_zip(root, zip_path, saved_files)

        total = self._count_files(root, ext, exclude=zip_filename)
        print(f"[YGSaveAllImages] folder total={total}  zip={zip_path}")

        return {"ui": {
            "images": [],
            "text": [
                f"Saved {len(saved_files)} image(s) to {target_dir}",
                f"Folder total: {total} {ext} file(s)",
                f"Zip: {zip_path}",
            ],
        }}

    @staticmethod
    def _append_to_zip(root, zip_path, new_files):
        """Append only the newly saved files to the zip (O(n) total, not O(n²))."""
        mode = "a" if os.path.exists(zip_path) else "w"
        with zipfile.ZipFile(zip_path, mode, zipfile.ZIP_DEFLATED) as zf:
            existing = set(zf.namelist())
            added = 0
            for full in new_files:
                arc = os.path.relpath(full, root).replace(os.sep, "/")
                if arc not in existing:
                    zf.write(full, arcname=arc)
                    added += 1
        total_in_zip = len(zipfile.ZipFile(zip_path).namelist())
        print(f"[YGSaveAllImages] zip updated: +{added} file(s), total={total_in_zip}")

    @staticmethod
    def _next_index(existing, prefix, ext):
        max_idx = -1
        for name in existing:
            stem = name[:-(len(ext) + 1)]
            tail = stem[len(prefix):].lstrip("_")
            try:
                max_idx = max(max_idx, int(tail))
            except ValueError:
                pass
        return max_idx + 1

    @staticmethod
    def _count_files(root, ext, exclude=""):
        count = 0
        for _, _, files in os.walk(root):
            for f in files:
                if f == exclude:
                    continue
                if f.lower().endswith(f".{ext}"):
                    count += 1
        return count


NODE_CLASS_MAPPINGS = {"YGSaveAllImages": YGSaveAllImages}
NODE_DISPLAY_NAME_MAPPINGS = {"YGSaveAllImages": "YG Download Images By Category"}
