"""
YG Clean VRAM — clear GPU memory before (or anywhere inside) a workflow.

Triggers the same internal calls as the dashboard's "Clean VRAM" button:
  • comfy.model_management.unload_all_models()
  • comfy.model_management.soft_empty_cache(force=True)
  • torch.cuda.empty_cache() + ipc_collect() + synchronize()
  • PromptServer queue flags  free_memory / unload_models   (so any *other*
    queued prompts on this server also get a clean slate)
  • Optional retry loop that re-cleans until GPU VRAM (read from nvidia-smi,
    the same source the dashboard uses) drops below a threshold or stops
    falling.

NOTE: This frees VRAM held by THIS ComfyUI process only. If multiple ComfyUI
servers share the same GPU, the dashboard top bar can still show high usage
because OTHER processes still hold their models. That's normal — use the
dashboard's "Clean All VRAM" to free every process at once.
"""

from __future__ import annotations

import gc
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request

# ── Optional accelerator imports ─────────────────────────────────────────────
try:
    import torch
    _HAS_TORCH = True
except Exception:
    _HAS_TORCH = False

try:
    import comfy.model_management as mm
    _HAS_MM = True
except Exception:
    _HAS_MM = False

try:
    import server as _comfy_server
    _HAS_SERVER = True
except Exception:
    _HAS_SERVER = False


# ── Wildcard "*" type for passthrough ────────────────────────────────────────
class _AnyType(str):
    def __ne__(self, _other): return False
    def __eq__(self, _other): return True
    def __hash__(self):       return hash("*")


_ANY = _AnyType("*")


# ── GPU readers ──────────────────────────────────────────────────────────────

def _torch_mem_mb() -> tuple[float, float]:
    """(allocated, reserved) MB for the current CUDA device. Per-process."""
    if not _HAS_TORCH or not torch.cuda.is_available():
        return 0.0, 0.0
    try:
        return (torch.cuda.memory_allocated() / 1048576.0,
                torch.cuda.memory_reserved()  / 1048576.0)
    except Exception:
        return 0.0, 0.0


def _nvsmi_gpu_used_mb(device_index: int | None = None) -> float | None:
    """Real GPU memory used (across ALL processes) via nvidia-smi."""
    if not shutil.which("nvidia-smi"):
        return None
    if device_index is None:
        try:
            device_index = (torch.cuda.current_device()
                            if _HAS_TORCH and torch.cuda.is_available() else 0)
        except Exception:
            device_index = 0
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                f"--id={device_index}",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            timeout=5,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return float(out.strip().splitlines()[0])
    except Exception:
        return None


def _gpu_index() -> int:
    if _HAS_TORCH and torch.cuda.is_available():
        try:
            return int(torch.cuda.current_device())
        except Exception:
            pass
    env = os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",")[0]
    try:
        return int(env)
    except Exception:
        return 0


# ── The actual cleanup ──────────────────────────────────────────────────────

def _do_one_pass(unload_models: bool, aggressive: bool) -> None:
    if unload_models and _HAS_MM:
        try:
            mm.unload_all_models()
        except Exception:
            pass

    for _ in range(2):
        gc.collect()

    if _HAS_MM:
        try:
            try:
                mm.soft_empty_cache(force=True)
            except TypeError:
                mm.soft_empty_cache()
        except Exception:
            pass

    if _HAS_TORCH and torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
            if aggressive:
                torch.cuda.ipc_collect()
                torch.cuda.synchronize()
        except Exception:
            pass


def _signal_queue_flags(unload_models: bool) -> None:
    """Same flags the /free endpoint sets — used between queued prompts."""
    if not _HAS_SERVER:
        return
    try:
        srv = _comfy_server.PromptServer.instance
        if hasattr(srv, "prompt_queue") and srv.prompt_queue is not None:
            srv.prompt_queue.set_flag("free_memory", True)
            if unload_models:
                srv.prompt_queue.set_flag("unload_models", True)
    except Exception:
        pass


# ── Dashboard / cross-server cleaner ────────────────────────────────────────

# Default = the dashboard's clean-vram-all endpoint on this host.
DEFAULT_DASHBOARD_URL   = os.environ.get("YG_DASHBOARD_URL",   "http://127.0.0.1:8194")
DEFAULT_DASHBOARD_TOKEN = os.environ.get("YG_DASHBOARD_TOKEN", "")

# Fallback list of ComfyUI servers to /free directly when the dashboard is
# unreachable. Override with YG_CLEAN_PORTS="8188,8189,8190,..." if needed.
_DEFAULT_PORTS = (8188, 8189, 8190, 8191, 8192, 8193, 8675)


def _http_get(url: str, timeout: float = 8.0) -> tuple[int, str]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(2048).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return 0, str(e)


def _http_post_json(url: str, payload: dict, timeout: float = 6.0) -> int:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def _clean_all_servers(dashboard_url: str, token: str) -> dict:
    """
    Try the dashboard's /clean-vram-all first (one HTTP call cleans all
    servers). If that fails, fall back to POSTing /free to each known port
    directly so cleanup still works when the dashboard is offline.
    """
    info = {"method": None, "ok": 0, "fail": 0, "ports": [], "error": None}

    # 1) Preferred: dashboard endpoint
    if dashboard_url and token:
        url = f"{dashboard_url.rstrip('/')}/clean-vram-all?token={token}"
        status, body = _http_get(url, timeout=20.0)
        if 200 <= status < 400:
            info["method"] = "dashboard"
            info["ok"] = 1
            return info
        info["error"] = f"dashboard HTTP {status}"

    # 2) Fallback: hit /free on each known port directly
    info["method"] = "direct"
    ports_env = os.environ.get("YG_CLEAN_PORTS", "")
    if ports_env:
        try:
            ports = tuple(int(p) for p in ports_env.split(",") if p.strip())
        except ValueError:
            ports = _DEFAULT_PORTS
    else:
        ports = _DEFAULT_PORTS

    for port in ports:
        code = _http_post_json(
            f"http://127.0.0.1:{port}/free",
            {"unload_models": True, "free_memory": True},
            timeout=4.0,
        )
        if 200 <= code < 400:
            info["ok"] += 1
            info["ports"].append(port)
        elif code != 0:
            info["fail"] += 1
    return info


def _clean_vram(unload_models: bool, aggressive: bool,
                max_passes: int, target_mb: int) -> dict:
    gpu = _gpu_index()
    before_alloc, before_resv = _torch_mem_mb()
    before_gpu = _nvsmi_gpu_used_mb(gpu)

    last_gpu = before_gpu
    passes = 0
    for i in range(max(1, max_passes)):
        passes = i + 1
        _do_one_pass(unload_models, aggressive)
        time.sleep(0.10)

        cur_gpu = _nvsmi_gpu_used_mb(gpu)
        if cur_gpu is None:
            break
        if target_mb > 0 and cur_gpu <= target_mb:
            break
        if last_gpu is not None and cur_gpu >= last_gpu - 5:
            # < 5 MB freed in this pass → no point continuing
            break
        last_gpu = cur_gpu

    _signal_queue_flags(unload_models)

    after_alloc, after_resv = _torch_mem_mb()
    after_gpu = _nvsmi_gpu_used_mb(gpu)

    return {
        "gpu_index":    gpu,
        "passes":       passes,
        "torch_before": round(before_alloc, 1),
        "torch_after":  round(after_alloc,  1),
        "resv_before":  round(before_resv,  1),
        "resv_after":   round(after_resv,   1),
        "torch_freed":  round(before_alloc - after_alloc, 1),
        "gpu_before":   None if before_gpu is None else round(before_gpu, 1),
        "gpu_after":    None if after_gpu  is None else round(after_gpu,  1),
        "gpu_freed":    (None if (before_gpu is None or after_gpu is None)
                         else round(before_gpu - after_gpu, 1)),
    }


# ── Node ─────────────────────────────────────────────────────────────────────

class YGCleanVRAM:
    """
    Clears VRAM held by THIS ComfyUI process.

    Place at the start of a workflow. Connect any value into `passthrough`
    and route the `passthrough` output to your next node's input — this
    guarantees the cleanup runs FIRST. The node also has OUTPUT_NODE=True
    so it always runs even when nothing is wired.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unload_models": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Unload all loaded models from VRAM. Disable to keep "
                               "the model cache (faster next run, more VRAM used).",
                }),
                "aggressive": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Adds cuda.ipc_collect + synchronize after empty_cache.",
                }),
                "max_passes": ("INT", {
                    "default": 3, "min": 1, "max": 10,
                    "tooltip": "Number of clean-then-measure passes. "
                               "Stops early once VRAM stops dropping.",
                }),
                "target_free_mb": ("INT", {
                    "default": 0, "min": 0, "max": 200000, "step": 256,
                    "tooltip": "Optional: keep cleaning until GPU 'used' "
                               "drops to this many MB or below. 0 disables.",
                }),
                "trigger_every_run": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Re-execute on every workflow run (no caching).",
                }),
                "clean_all_servers": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Also clean VRAM on ALL ComfyUI servers via the "
                               "dashboard (or by POSTing /free to each port). "
                               "Use this if other ComfyUI instances on the same "
                               "GPU are holding memory.",
                }),
                "dashboard_url": ("STRING", {
                    "default": DEFAULT_DASHBOARD_URL,
                    "tooltip": "Server Status Dashboard base URL (e.g. http://127.0.0.1:8194).",
                }),
                "dashboard_token": ("STRING", {
                    "default": DEFAULT_DASHBOARD_TOKEN,
                    "tooltip": "Dashboard SECRET_TOKEN.",
                }),
            },
            "optional": {
                "passthrough": (_ANY, {"tooltip": "Optional value forwarded to the output."}),
            },
        }

    RETURN_TYPES = (_ANY,)
    RETURN_NAMES = ("passthrough",)
    FUNCTION     = "clean"
    CATEGORY     = "YG_Nodes"
    OUTPUT_NODE  = True

    @classmethod
    def IS_CHANGED(cls, trigger_every_run, **_kwargs):
        return time.time() if trigger_every_run else "static"

    def clean(self, unload_models, aggressive, max_passes, target_free_mb,
              trigger_every_run, clean_all_servers, dashboard_url,
              dashboard_token, passthrough=None):
        # 1) Cross-server cleanup first so /free runs in parallel with our
        #    own model unload. We measure GPU usage *after* both finish.
        cross = None
        if clean_all_servers:
            cross = _clean_all_servers(dashboard_url, dashboard_token)
            # Brief settle time for the other servers
            time.sleep(0.3)

        # 2) Local cleanup + measurement
        s = _clean_vram(unload_models, aggressive, max_passes, target_free_mb)

        lines = [f"🧹 VRAM cleaned in {s['passes']} pass(es)  ·  GPU {s['gpu_index']}"]
        if cross is not None:
            if cross["method"] == "dashboard" and cross["ok"]:
                lines.append("All servers: cleaned via dashboard ✓")
            elif cross["method"] == "direct":
                lines.append(
                    f"All servers (direct): {cross['ok']} ok, {cross['fail']} fail"
                    + (f" — ports {cross['ports']}" if cross["ports"] else "")
                )
            else:
                lines.append(f"All servers: failed ({cross.get('error')})")
        if s["gpu_before"] is not None:
            lines.append(
                f"GPU (nvidia-smi):  {s['gpu_before']} → {s['gpu_after']} MB  "
                f"(freed {s['gpu_freed']} MB)"
            )
        else:
            lines.append("GPU (nvidia-smi):  not available")
        lines.append(
            f"Process (torch):   {s['torch_before']} → {s['torch_after']} MB  "
            f"(freed {s['torch_freed']} MB)"
        )
        lines.append(
            f"Reserved:          {s['resv_before']} → {s['resv_after']} MB"
        )
        if (not clean_all_servers
                and s["gpu_after"] is not None and s["gpu_after"] > 1024
                and s["torch_after"] < 200):
            lines.append("⚠ GPU still holds memory from OTHER processes — "
                         "enable 'clean_all_servers' to free them too.")

        return {"ui": {"text": ["\n".join(lines)]}, "result": (passthrough,)}
