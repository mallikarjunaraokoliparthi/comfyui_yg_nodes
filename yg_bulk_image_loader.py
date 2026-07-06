import os
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


class YGBulkImageLoader:
    """
    Loads images one-by-one from a bulk upload batch.
    Use with ComfyUI's Auto Queue to process all images sequentially.
    Each run outputs the NEXT image in the batch automatically.

    Workflow:
      1. Drag & drop images onto this node (or click Upload button)
      2. Connect outputs to your pipeline
      3. Enable Extra Options > Auto Queue in ComfyUI
      4. Click Run — every image is processed automatically
    """

    # In-memory index per batch_id. Persists while ComfyUI is running.
    _state = {}  # {batch_id: current_index}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "batch_id": ("STRING", {
                    "default": "my_batch",
                    "multiline": False,
                    "tooltip": "Unique name for this image batch. Use different names for different jobs."
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT", "BOOLEAN")
    RETURN_NAMES = ("image", "mask", "filename", "current_index", "total_count", "batch_complete")
    FUNCTION = "load_next_image"
    CATEGORY = "YG Custom Nodes"

    @classmethod
    def IS_CHANGED(cls, batch_id):
        # Always re-execute — index advances each run
        return float("nan")

    def load_next_image(self, batch_id):
        input_dir = folder_paths.get_input_directory()
        batch_dir = os.path.join(input_dir, "yg_bulk", batch_id)

        if not os.path.isdir(batch_dir):
            raise FileNotFoundError(
                f"Batch '{batch_id}' not found.\n"
                f"Drag & drop images onto the node, or click the Upload button."
            )

        valid_ext = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}
        images = sorted([
            f for f in os.listdir(batch_dir)
            if os.path.splitext(f)[1].lower() in valid_ext
        ])

        if not images:
            raise ValueError(
                f"No images found in batch '{batch_id}'.\n"
                f"Supported formats: PNG, JPG, WEBP, BMP, TIFF"
            )

        total = len(images)
        idx = YGBulkImageLoader._state.get(batch_id, 0)
        idx = max(0, min(idx, total - 1))

        filename = images[idx]
        image_path = os.path.join(batch_dir, filename)

        # Load image — same logic as ComfyUI's built-in LoadImage
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)

        if img.mode == 'I':
            img = img.point(lambda i: i * (1 / 255))

        has_alpha = 'A' in img.getbands()
        img_rgb = img.convert("RGB")
        img_array = np.array(img_rgb).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array)[None,]  # [1, H, W, 3]

        if has_alpha:
            mask_array = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(mask_array)[None,]
        else:
            mask = torch.zeros(
                (1, img_tensor.shape[1], img_tensor.shape[2]),
                dtype=torch.float32
            )

        # Advance state AFTER loading
        next_idx = idx + 1
        batch_complete = next_idx >= total
        YGBulkImageLoader._state[batch_id] = 0 if batch_complete else next_idx

        # Notify frontend when all images are done
        if batch_complete and _HAS_SERVER:
            try:
                server.PromptServer.instance.send_sync(
                    "yg_batch_complete",
                    {"batch_id": batch_id, "total": total}
                )
            except Exception:
                pass

        if batch_complete:
            status_text = f"✅ DONE  {total}/{total} — {filename}"
        else:
            status_text = f"{idx + 1} / {total} — {filename}"

        return {
            "ui": {"text": [status_text]},
            "result": (img_tensor, mask, filename, idx, total, batch_complete),
        }


# ── Custom REST API endpoints ──────────────────────────────────────────────────

if _HAS_SERVER:

    @server.PromptServer.instance.routes.post("/yg/reset_batch")
    async def yg_reset_batch(request):
        """Reset a batch's index back to 0 (first image)."""
        try:
            data = await request.json()
            batch_id = data.get("batch_id", "my_batch")
            YGBulkImageLoader._state[batch_id] = 0
            return web.json_response({"status": "ok", "batch_id": batch_id})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)

    @server.PromptServer.instance.routes.post("/yg/delete_batch_images")
    async def yg_delete_batch_images(request):
        """Delete specific images from a batch folder."""
        try:
            data      = await request.json()
            batch_id  = data.get("batch_id", "my_batch")
            filenames = data.get("filenames", [])  # list of bare filenames

            input_dir = folder_paths.get_input_directory()
            batch_dir = os.path.join(input_dir, "yg_bulk", batch_id)
            real_batch = os.path.realpath(batch_dir)

            deleted = []
            errors  = []
            for fname in filenames:
                # Strip any path separators — only bare filenames allowed
                fname = os.path.basename(fname)
                if not fname:
                    continue
                target = os.path.realpath(os.path.join(batch_dir, fname))
                # Safety: must stay inside batch dir
                if not target.startswith(real_batch + os.sep):
                    errors.append(fname)
                    continue
                try:
                    os.remove(target)
                    deleted.append(fname)
                except FileNotFoundError:
                    errors.append(fname)

            # Reset index if it's now out of range
            valid_ext = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}
            remaining = sorted([
                f for f in os.listdir(batch_dir)
                if os.path.splitext(f)[1].lower() in valid_ext
            ]) if os.path.isdir(batch_dir) else []
            current = YGBulkImageLoader._state.get(batch_id, 0)
            if current >= len(remaining):
                YGBulkImageLoader._state[batch_id] = max(0, len(remaining) - 1)

            return web.json_response({
                "deleted": deleted,
                "errors":  errors,
                "remaining": len(remaining),
            })
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)

    @server.PromptServer.instance.routes.get("/yg/batch_info")
    async def yg_batch_info(request):
        """Return image count and current index for a batch."""
        try:
            batch_id = request.rel_url.query.get("batch_id", "my_batch")
            input_dir = folder_paths.get_input_directory()
            batch_dir = os.path.join(input_dir, "yg_bulk", batch_id)

            valid_ext = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}

            if not os.path.isdir(batch_dir):
                return web.json_response({"count": 0, "current_index": 0, "batch_id": batch_id, "filenames": []})

            images = sorted([
                f for f in os.listdir(batch_dir)
                if os.path.splitext(f)[1].lower() in valid_ext
            ])
            current = YGBulkImageLoader._state.get(batch_id, 0)

            return web.json_response({
                "count": len(images),
                "current_index": current,
                "batch_id": batch_id,
                "filenames": images,
            })
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)

    @server.PromptServer.instance.routes.get("/yg/batch_thumbnail")
    async def yg_batch_thumbnail(request):
        """Return a single thumbnail image (JPEG, max 120px) for quick preview."""
        import io, base64
        try:
            batch_id  = request.rel_url.query.get("batch_id", "my_batch")
            filename  = request.rel_url.query.get("filename", "")
            max_size  = int(request.rel_url.query.get("max_size", "120"))

            input_dir = folder_paths.get_input_directory()
            image_path = os.path.join(input_dir, "yg_bulk", batch_id, filename)

            # Safety: keep path inside input dir
            real_path  = os.path.realpath(image_path)
            real_input = os.path.realpath(input_dir)
            if not real_path.startswith(real_input):
                return web.Response(status=403, text="Forbidden")

            if not os.path.isfile(real_path):
                return web.Response(status=404, text="Not found")

            img = Image.open(real_path).convert("RGB")
            img.thumbnail((max_size, max_size), Image.LANCZOS)

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=75)
            buf.seek(0)

            return web.Response(
                body=buf.read(),
                content_type="image/jpeg",
                headers={"Cache-Control": "max-age=3600"},
            )
        except Exception as exc:
            return web.Response(status=500, text=str(exc))
