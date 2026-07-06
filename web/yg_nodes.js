import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Toast notification ─────────────────────────────────────────────────────────

function showToast(message, color = "#2ecc71", duration = 6000) {
    let toast = document.getElementById("yg-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "yg-toast";
        Object.assign(toast.style, {
            position:     "fixed",
            bottom:       "30px",
            right:        "30px",
            zIndex:       "99999",
            padding:      "14px 20px",
            borderRadius: "8px",
            fontSize:     "14px",
            fontWeight:   "600",
            color:        "#fff",
            maxWidth:     "420px",
            lineHeight:   "1.5",
            boxShadow:    "0 4px 20px rgba(0,0,0,0.35)",
            display:      "none",
            whiteSpace:   "pre-line",
        });
        document.body.appendChild(toast);
    }
    toast.style.background = color;
    toast.textContent = message;
    toast.style.display = "block";
    clearTimeout(toast._ygTimer);
    toast._ygTimer = setTimeout(() => { toast.style.display = "none"; }, duration);
}

// ── Auto-stop Auto Queue ─────────────────────────────────────────────────────

function _stopAutoQueue() {
    // Method 1: ComfyUI internal app flags (varies by version)
    try {
        if (typeof app.ui?.autoQueueEnabled !== "undefined") app.ui.autoQueueEnabled = false;
        if (typeof app.autoQueueEnabled     !== "undefined") app.autoQueueEnabled     = false;
    } catch (_) {}

    // Method 2: Find the Auto Queue toggle button/checkbox in the DOM
    try {
        // Newer ComfyUI: queue-mode button that is "active" with text containing 'instant' or 'change'
        // The run-mode buttons (Run / Run On Change / Run Instant) — clicking the plain 'Run' button
        // while auto-queue is active effectively stops it in some versions.
        // More reliably: find any toggle labelled "Auto Queue" and turn it off.
        for (const el of document.querySelectorAll("button, input[type='checkbox'], label")) {
            const text = (el.textContent || el.value || el.id || "").toLowerCase();
            if (text.includes("auto queue") || text.includes("auto-queue")) {
                if (el.tagName === "INPUT" && el.checked)  { el.click(); break; }
                if (el.tagName === "BUTTON")                { el.click(); break; }
                if (el.tagName === "LABEL") {
                    const cb = el.querySelector("input[type='checkbox']");
                    if (cb?.checked) { cb.click(); break; }
                }
            }
        }
    } catch (_) {}

    // Method 3: Interrupt any running execution
    try { api.interrupt(); } catch (_) {}
}

// ── Batch-complete event from server ──────────────────────────────────────────

api.addEventListener("yg_batch_complete", (event) => {
    const { batch_id, total } = event.detail ?? {};

    // Stop the auto-queue so it doesn't loop
    _stopAutoQueue();

    // Final gallery refresh
    setTimeout(_refreshAllGalleries, 800);

    showToast(
        `✅ Batch "${batch_id ?? "?"}" complete!\n${total ?? "?"} videos generated.\n\nAuto Queue stopped automatically.`,
        "#27ae60",
        12000
    );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBatchId(node) {
    return node.widgets?.find(w => w.name === "batch_id")?.value?.trim() || "my_batch";
}

async function uploadImages(node, files) {
    const batchId = getBatchId(node);
    const sw = node._ygStatusWidget;

    const imageFiles = Array.from(files)
        .filter(f => f.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    if (imageFiles.length === 0) {
        showToast("⚠️ No image files found in the dropped items.", "#e67e22");
        return;
    }

    if (sw) { sw.value = `Uploading 0 / ${imageFiles.length}…`; }
    app.graph.setDirtyCanvas(true);

    let failed = 0;
    for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        if (sw) {
            sw.value = `Uploading ${i + 1} / ${imageFiles.length}: ${file.name}`;
            app.graph.setDirtyCanvas(true);
        }
        try {
            const fd = new FormData();
            fd.append("image", file, file.name);
            fd.append("subfolder", `yg_bulk/${batchId}`);
            fd.append("overwrite", "true");
            fd.append("type", "input");
            const resp = await fetch("/upload/image", { method: "POST", body: fd });
            if (!resp.ok) failed++;
        } catch {
            failed++;
        }
    }

    // Auto-reset index to 0 after a fresh upload
    await callReset(batchId);

    const ok = imageFiles.length - failed;
    const msg = failed > 0
        ? `⚠️ ${ok}/${imageFiles.length} uploaded (${failed} failed)\nbatch: "${batchId}"`
        : `✅ ${ok} images ready — batch: "${batchId}"`;

    if (sw) { sw.value = msg; }
    await refreshStatus(node);   // updates thumbnails + status
    showToast(msg, failed > 0 ? "#e67e22" : "#2ecc71");
}

async function callReset(batchId) {
    try {
        await fetch("/yg/reset_batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batch_id: batchId }),
        });
    } catch { /* ignore */ }
}

// ── Run All: queue images ONE AT A TIME (wait + free VRAM between each) ────
//
// Why not just queuePrompt(0, N)?  Because that fills ComfyUI's queue with
// N prompts back-to-back. Even though the executor runs them sequentially,
// the previous run's models stay resident across runs → VRAM accumulates and
// heavy workflows OOM on prompt #2.
//
// Instead we:
//   1. queuePrompt(0, 1)  for image #i
//   2. wait for "execution_success" (or "execution_error") for THAT prompt
//   3. POST /free  → unload models, free CUDA cache
//   4. small settle pause, then loop for image #(i+1)
//
// Result: each image generates fully, VRAM is freed, then the next starts.
// No "started 2 prompts → second OOMs" anymore.

let _ygRunAllAbort = false;

function _waitForPromptDone(promptId, timeoutMs = 30 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const off = () => {
            api.removeEventListener("execution_success", onOk);
            api.removeEventListener("execution_error",   onErr);
            api.removeEventListener("execution_interrupted", onInt);
            if (timer) clearTimeout(timer);
        };
        const onOk = (e) => {
            if (!promptId || e.detail?.prompt_id === promptId) { off(); resolve("ok"); }
        };
        const onErr = (e) => {
            if (!promptId || e.detail?.prompt_id === promptId) { off(); reject(new Error(e.detail?.exception_message || "execution error")); }
        };
        const onInt = (e) => {
            if (!promptId || e.detail?.prompt_id === promptId) { off(); reject(new Error("interrupted")); }
        };
        api.addEventListener("execution_success",     onOk);
        api.addEventListener("execution_error",       onErr);
        api.addEventListener("execution_interrupted", onInt);
        timer = setTimeout(() => { off(); reject(new Error("timeout")); }, timeoutMs);
    });
}

async function _freeServerVram() {
    // Hammer it like a manual user: 3 calls + long settle.
    // Wan2.2 holds ~13 GB UNet that doesn't drop on a single /free.
    for (let k = 0; k < 3; k++) {
        try {
            await fetch("/free", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ unload_models: true, free_memory: true }),
            });
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 1500));
    }
}

async function runAllImages(node) {
    const batchId = getBatchId(node);
    const btnW    = node._ygRunAllWidget;
    const origLbl = btnW?.name;

    // Toggle: if already running, treat second click as Stop
    if (node._ygRunAllRunning) {
        _ygRunAllAbort = true;
        showToast("⏹ Stop requested — finishing current image then halting.", "#e67e22", 4000);
        if (btnW) { btnW.name = "⏹  Stopping…"; app.graph.setDirtyCanvas(true); }
        return;
    }

    try {
        // 1. How many images are loaded?
        const resp = await fetch(`/yg/batch_info?batch_id=${encodeURIComponent(batchId)}`);
        const data = await resp.json();
        const count = data.count ?? 0;
        if (count === 0) {
            showToast(`⚠️ Batch "${batchId}" has no images. Upload first.`, "#e67e22");
            return;
        }

        // 2. Confirm
        if (!confirm(
            `Run ${count} image(s) for batch "${batchId}" sequentially?\n\n` +
            `Each image runs fully, then VRAM is freed, then the next starts.\n` +
            `Click the button again to Stop after the current image.`
        )) return;

        // 3. Reset index → start at image #1
        await callReset(batchId);
        await refreshStatus(node);

        node._ygRunAllRunning = true;
        _ygRunAllAbort = false;

        let ok = 0, fail = 0;
        for (let i = 1; i <= count; i++) {
            if (_ygRunAllAbort) break;

            if (btnW) { btnW.name = `⏹  Stop  (running ${i}/${count}…)`; app.graph.setDirtyCanvas(true); }

            // a. Queue exactly ONE prompt
            let promptId = null;
            try {
                const res = await app.queuePrompt(0, 1);
                // app.queuePrompt resolves with the server response in newer versions
                promptId = res?.prompt_id ?? res?.[1]?.prompt_id ?? null;
            } catch (e) {
                showToast(`⚠️ Queue failed at #${i}: ${e?.message ?? e}`, "#e74c3c");
                fail++;
                break;
            }

            // b. Wait for THAT prompt to finish
            try {
                await _waitForPromptDone(promptId);
                ok++;
            } catch (e) {
                fail++;
                if (e.message === "interrupted") break;   // user pressed stop in UI
                showToast(`⚠️ Image #${i} failed: ${e.message}`, "#e74c3c", 6000);
                // Don't break on per-image errors — try to continue
            }

            // c. Free VRAM before next image (3× /free + long settle = same as manual)
            if (i < count && !_ygRunAllAbort) {
                if (btnW) { btnW.name = `🧹  Freeing VRAM after ${i}/${count}…`; app.graph.setDirtyCanvas(true); }
                await _freeServerVram();   // already does 3× /free with 1.5s waits
                // extra 5s settle to let allocator release pages and reach steady state
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        const msg = _ygRunAllAbort
            ? `⏹ Stopped: ${ok} done, ${fail} failed, ${count - ok - fail} skipped`
            : (fail > 0
                ? `⚠️ Finished: ${ok}/${count} ok, ${fail} failed`
                : `✅ All ${count} images finished — batch "${batchId}"`);
        showToast(msg, fail > 0 ? "#e67e22" : "#27ae60", 8000);

    } catch (e) {
        showToast(`⚠️ Run All failed: ${e?.message ?? e}`, "#e74c3c");
    } finally {
        node._ygRunAllRunning = false;
        _ygRunAllAbort = false;
        // Restore button label
        setTimeout(() => {
            if (btnW && origLbl) { btnW.name = origLbl; app.graph.setDirtyCanvas(true); }
        }, 1200);
    }
}

async function refreshStatus(node) {
    const sw = node._ygStatusWidget;
    try {
        const batchId = getBatchId(node);
        const resp = await fetch(`/yg/batch_info?batch_id=${encodeURIComponent(batchId)}`);
        const data = await resp.json();
        if (sw) {
            sw.value = data.count === 0
                ? "No images uploaded yet"
                : `✅ ${data.count} images — processing: ${data.current_index + 1} / ${data.count}`;
        }
        await refreshThumbnails(node, data.filenames ?? [], data.current_index ?? 0, batchId);
        app.graph.setDirtyCanvas(true);
    } catch { /* ignore */ }
}

async function refreshThumbnails(node, filenames, currentIndex, batchId) {
    const el = node._ygThumbContainer;
    if (!el) return;

    // Keep selection state on the node
    if (!node._ygImgSelected) node._ygImgSelected = new Set();
    // Remove stale selections
    for (const s of node._ygImgSelected) {
        if (!filenames.includes(s)) node._ygImgSelected.delete(s);
    }

    el.innerHTML = "";

    if (!filenames || filenames.length === 0) {
        el.innerHTML = `<div style="color:#888;font-size:12px;text-align:center;padding:12px;">
            No images yet — drag & drop or use Upload button</div>`;
        return;
    }

    // ── Header bar ─────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:5px;padding:2px 2px 6px;flex-wrap:wrap;";

    const countLabel = document.createElement("span");
    countLabel.style.cssText = "font-size:12px;color:#aaa;font-weight:600;flex:1;";
    countLabel.textContent = `${filenames.length} images  •  Next: ${currentIndex + 1}`;

    // Select All toggle
    const selAllBtn = document.createElement("button");
    selAllBtn.style.cssText = `
        background:#444; color:#fff; border:none; border-radius:4px;
        padding:3px 8px; font-size:10px; cursor:pointer;
    `;
    selAllBtn.textContent = "☑ All";
    selAllBtn.onclick = () => {
        const allSel = node._ygImgSelected.size === filenames.length;
        if (allSel) node._ygImgSelected.clear();
        else filenames.forEach(f => node._ygImgSelected.add(f));
        refreshThumbnails(node, filenames, currentIndex, batchId);
    };

    // Delete Selected button
    const delBtn = document.createElement("button");
    const selCount = node._ygImgSelected.size;
    delBtn.textContent = `🗑 Remove (${selCount})`;
    delBtn.style.cssText = `
        background: #c0392b; color:#fff; border:none; border-radius:4px;
        padding:3px 8px; font-size:10px; font-weight:700; cursor:pointer;
        display: ${selCount > 0 ? "inline-block" : "none"};
    `;
    delBtn.onclick = async () => {
        const toDelete = [...node._ygImgSelected];
        if (!toDelete.length) return;
        if (!confirm(`Remove ${toDelete.length} image(s) from batch "${batchId}"?\nThis cannot be undone.`)) return;
        try {
            const resp = await fetch("/yg/delete_batch_images", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ batch_id: batchId, filenames: toDelete }),
            });
            const data = await resp.json();
            node._ygImgSelected.clear();
            await refreshStatus(node);
            showToast(
                `🗑 Removed ${data.deleted?.length ?? 0} image(s) from batch "${batchId}".`,
                "#c0392b", 4000
            );
        } catch (e) {
            showToast("⚠️ Delete failed: " + e.message, "#e74c3c");
        }
    };

    header.appendChild(countLabel);
    header.appendChild(selAllBtn);
    header.appendChild(delBtn);
    el.appendChild(header);

    // ── Scrollable thumbnail grid ───────────────────────────────────────────
    const grid = document.createElement("div");
    grid.style.cssText = `
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        max-height: 340px;
        overflow-y: auto;
        padding: 4px;
        background: #1a1a1a;
        border-radius: 6px;
    `;
    el.appendChild(grid);

    filenames.forEach((name, idx) => {
        const isSelected = node._ygImgSelected.has(name);
        const isNext     = idx === currentIndex;

        const wrapper = document.createElement("div");
        wrapper.style.cssText = `
            position: relative;
            width: 64px;
            height: 64px;
            border-radius: 4px;
            overflow: hidden;
            border: 2px solid ${isSelected ? "#e74c3c" : isNext ? "#3498db" : "#333"};
            flex-shrink: 0;
            cursor: pointer;
            background: #2a2a2a;
        `;
        wrapper.title = `#${idx + 1}: ${name}\nClick checkbox to select / remove`;

        const img = document.createElement("img");
        img.src = `/yg/batch_thumbnail?batch_id=${encodeURIComponent(batchId)}&filename=${encodeURIComponent(name)}&max_size=64`;
        img.style.cssText = "width:100%;height:100%;object-fit:cover;";
        img.onerror = () => { img.style.display = "none"; };

        // ☑ Checkbox top-left
        const cb = document.createElement("div");
        cb.style.cssText = `
            position: absolute; top: 2px; left: 2px;
            width: 16px; height: 16px;
            border-radius: 3px;
            background: ${isSelected ? "#e74c3c" : "rgba(0,0,0,0.55)"};
            border: 1.5px solid ${isSelected ? "#ff6b6b" : "rgba(255,255,255,0.3)"};
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; color: #fff; z-index: 5;
        `;
        cb.textContent = isSelected ? "✓" : "";

        // Red tint overlay when selected
        const tint = document.createElement("div");
        tint.style.cssText = `
            position:absolute; inset:0;
            background: ${isSelected ? "rgba(231,76,60,0.22)" : "transparent"};
            pointer-events: none;
        `;

        // Number badge
        const badge = document.createElement("div");
        badge.style.cssText = `
            position: absolute;
            bottom: 0; left: 0; right: 0;
            background: rgba(0,0,0,0.65);
            color: #fff; font-size: 9px; text-align: center; padding: 1px 0;
        `;
        badge.textContent = `${idx + 1}`;

        // NEXT badge
        if (isNext) {
            const next = document.createElement("div");
            next.style.cssText = `
                position: absolute; top: 2px; right: 2px;
                background: #3498db; color: #fff;
                font-size: 8px; font-weight: 700;
                padding: 1px 3px; border-radius: 3px;
            `;
            next.textContent = "NEXT";
            wrapper.appendChild(next);
        }

        // Hover
        wrapper.onmouseenter = () => {
            if (!node._ygImgSelected.has(name))
                wrapper.style.border = `2px solid ${isNext ? "#2980b9" : "#888"}`;
        };
        wrapper.onmouseleave = () => {
            wrapper.style.border = `2px solid ${node._ygImgSelected.has(name) ? "#e74c3c" : isNext ? "#3498db" : "#333"}`;
        };

        // Click top-left area → toggle selection; click elsewhere → nothing (or future: preview)
        wrapper.onclick = (e) => {
            const rect = wrapper.getBoundingClientRect();
            const lx = e.clientX - rect.left;
            const ly = e.clientY - rect.top;
            // Top-left 22×22 = checkbox zone; or anywhere toggles selection
            if (node._ygImgSelected.has(name)) {
                node._ygImgSelected.delete(name);
            } else {
                node._ygImgSelected.add(name);
            }
            refreshThumbnails(node, filenames, currentIndex, batchId);
        };

        wrapper.appendChild(img);
        wrapper.appendChild(cb);
        wrapper.appendChild(tint);
        wrapper.appendChild(badge);
        grid.appendChild(wrapper);
    });

    // Auto-scroll to current image
    setTimeout(() => {
        const items = grid.querySelectorAll("div");
        if (items[currentIndex]) {
            items[currentIndex].scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    }, 100);
}

// ── Draw rounded rect (safe fallback) ────────────────────────────────────────

function drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

// ── YG Bulk Image Loader extension ───────────────────────────────────────────

app.registerExtension({
    name: "YG.BulkImageLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGBulkImageLoader") return;

        // ── onNodeCreated ────────────────────────────────────────────────
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            // Upload button
            this.addWidget("button", "📤  Upload Images  (or drag & drop)", null, () => {
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = true;
                input.accept = "image/png,image/jpeg,image/webp,image/bmp,image/tiff,image/*";
                input.onchange = (e) => {
                    if (e.target.files.length > 0) uploadImages(this, e.target.files);
                };
                input.click();
            });

            // Reset button
            this.addWidget("button", "🔄  Reset — Start from Image 1", null, async () => {
                const batchId = getBatchId(this);
                await callReset(batchId);
                await refreshStatus(this);
                showToast(`🔄 Batch "${batchId}" reset to image 1`, "#3498db", 3000);
            });

            // ▶ Run All button — queues N prompts (N = number of images in batch)
            this._ygRunAllWidget = this.addWidget(
                "button",
                "▶  Run All Images",
                null,
                () => runAllImages(this),
            );

            // Read-only status text
            this._ygStatusWidget = this.addWidget(
                "text", "_yg_status", "No images uploaded yet", null, { serialize: false }
            );
            this._ygStatusWidget.disabled = true;

            // DOM widget: thumbnail gallery (flex column — fills node height)
            const container = document.createElement("div");
            container.style.cssText = "padding: 4px 6px 8px; width: 100%; height: 100%;"
                                    + "box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;";
            container.innerHTML = `<div style="color:#888;font-size:12px;text-align:center;padding:12px;">
                No images yet — drag & drop or use Upload button</div>`;

            const domWidget = this.addDOMWidget("_yg_thumbs", "div", container, {
                serialize: false,
                hideOnZoom: false,
            });
            this._ygThumbContainer = container;
            this._ygDomWidget = domWidget;

            // Initial size only on first creation — respect any saved size on reload
            if (!this.size || (this.size[0] < 300 && this.size[1] < 300)) this.setSize([420, 420]);

            // Populate on load
            setTimeout(() => refreshStatus(this), 800);
        };

        // ── Drag over node: show highlight ───────────────────────────────
        nodeType.prototype.onDragOver = function (e) {
            if (e.dataTransfer?.types?.includes("Files")) {
                this._ygDragOver = true;
                app.graph.setDirtyCanvas(true);
                return true; // consume event
            }
        };

        // ── Drag leave ───────────────────────────────────────────────────
        nodeType.prototype.onDragLeave = function () {
            this._ygDragOver = false;
            app.graph.setDirtyCanvas(true);
        };

        // ── Drop: upload files ───────────────────────────────────────────
        nodeType.prototype.onDrop = function (e) {
            this._ygDragOver = false;
            app.graph.setDirtyCanvas(true);
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                uploadImages(this, files);
                return true; // consume event — prevent ComfyUI's default drop handler
            }
        };

        // ── Draw drop-zone highlight overlay ─────────────────────────────
        const origOnDrawBg = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            origOnDrawBg?.apply(this, arguments);
            if (!this._ygDragOver) return;

            const titleH = LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
            const pad = 6;
            const x = pad;
            const y = titleH + pad;
            const w = this.size[0] - pad * 2;
            const h = this.size[1] - titleH - pad * 2;

            ctx.save();
            ctx.fillStyle   = "rgba(52, 152, 219, 0.22)";
            ctx.strokeStyle = "#3498db";
            ctx.lineWidth   = 2.5;
            ctx.setLineDash([7, 4]);
            drawRoundRect(ctx, x, y, w, h, 8);
            ctx.fill();
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.fillStyle  = "#3498db";
            ctx.font       = "bold 18px sans-serif";
            ctx.textAlign  = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("⬇  Drop images here!", this.size[0] / 2, this.size[1] / 2);
            ctx.restore();
        };
    },
});

// ── YG Prompt Router extension ────────────────────────────────────────────────

app.registerExtension({
    name: "YG.PromptRouter",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGPromptRouter") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            const syncVisibility = () => {
                const modeW      = this.widgets?.find(w => w.name === "mode");
                const groupSizeW = this.widgets?.find(w => w.name === "group_size");
                if (!modeW || !groupSizeW) return;
                const isGrouped = modeW.value === "Grouped";
                groupSizeW.disabled = !isGrouped;
                // Visual dimming
                groupSizeW.element && (groupSizeW.element.style.opacity = isGrouped ? "1" : "0.35");
                app.graph.setDirtyCanvas(true);
            };

            // Intercept mode widget changes
            const modeW = this.widgets?.find(w => w.name === "mode");
            if (modeW) {
                const origCb = modeW.callback;
                modeW.callback = (...args) => {
                    origCb?.(...args);
                    syncVisibility();
                };
            }

            syncVisibility();
        };
    },
});


// ─── YG Video Gallery (rewritten) ───────────────────────────────────────────
//
// Fixes vs. previous version:
//   • Robust subfolder split (lastIndexOf, not String.replace)
//   • Targeted DOM updates on selection toggle (no full re-render)
//   • Refresh debounced; suppressed while video is playing or user is hovering
//   • Player has mute toggle, native fullscreen, open-in-new-tab, error message
//   • Delete-selected with confirmation
//   • Sort (newest/oldest/name) + thumb-size slider — persisted per node
//   • Polling/`progress` event throttled, no longer kills playback
//   • Cleanup of polling interval on extension reload

(function () {
"use strict";

const galW = (node, name) =>
    node.widgets?.find(w => w.name === name)?.value?.toString().trim() ?? "";
const getGalleryPrefix  = node => galW(node, "filename_prefix");
const getGalleryBatchId = node => galW(node, "batch_id") || "my_batch";

function fmtBytes(n) {
    if (!Number.isFinite(n)) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(t) {
    if (!t) return "";
    const d = new Date(t * 1000);
    return d.toLocaleString();
}

function splitRel(rel) {
    const i = rel.lastIndexOf("/");
    return i < 0
        ? { subfolder: "", filename: rel }
        : { subfolder: rel.slice(0, i), filename: rel.slice(i + 1) };
}

function viewUrl(rel) {
    const { subfolder, filename } = splitRel(rel);
    return `/view?filename=${encodeURIComponent(filename)}`
         + `&type=output&subfolder=${encodeURIComponent(subfolder)}`;
}

// ── Refresh manager ────────────────────────────────────────────────────────

async function fetchVideoList(batchId, prefix) {
    const url = `/yg/batch_video_list?batch_id=${encodeURIComponent(batchId)}`
              + `&prefix=${encodeURIComponent(prefix)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return data.items?.length
        ? data.items
        : (data.videos ?? []).map(rel => ({ rel_path: rel, filename: splitRel(rel).filename, size: 0, mtime: 0 }));
}

function shouldSuppressRefresh(node) {
    // Don't yank the DOM out from under the user
    if (node._ygPlayerOpen) return true;
    if (node._ygUserActive && Date.now() - node._ygUserActive < 4000) return true;
    return false;
}

async function refreshVideoGallery(node, { force = false } = {}) {
    const root = node._ygRoot;
    if (!root) return;
    if (!force && shouldSuppressRefresh(node)) {
        node._ygRefreshPending = true;
        return;
    }
    node._ygRefreshPending = false;

    const batchId = getGalleryBatchId(node);
    const prefix  = getGalleryPrefix(node);

    if (!node._ygItems) {
        renderShell(node);
        node._ygStatusEl.textContent = "Loading…";
    }

    try {
        const items = await fetchVideoList(batchId, prefix);
        applyItems(node, items);
    } catch (e) {
        node._ygStatusEl && (node._ygStatusEl.textContent = `Error: ${e.message}`);
    }
}

function debouncedRefresh(node, delay = 250) {
    clearTimeout(node._ygDebounce);
    node._ygDebounce = setTimeout(() => refreshVideoGallery(node), delay);
}

// ── Sorting ────────────────────────────────────────────────────────────────

function sortItems(items, mode) {
    const a = items.slice();
    switch (mode) {
        case "name":     a.sort((x, y) => x.filename.localeCompare(y.filename, undefined, { numeric: true })); break;
        case "oldest":   a.sort((x, y) => (x.mtime || 0) - (y.mtime || 0)); break;
        case "newest":
        default:         a.sort((x, y) => (y.mtime || 0) - (x.mtime || 0));
    }
    return a;
}

// ── Shell (built once) ─────────────────────────────────────────────────────

function renderShell(node) {
    const root = node._ygRoot;
    root.innerHTML = "";

    // Toolbar row 1: status + refresh + sort + thumb size
    const bar1 = document.createElement("div");
    bar1.style.cssText = "display:flex;align-items:center;gap:6px;padding:0 0 6px;flex-wrap:wrap;";

    const status = document.createElement("span");
    status.style.cssText = "font-size:12px;color:#aaa;font-weight:600;flex:1;min-width:120px;";
    status.textContent = "—";
    node._ygStatusEl = status;

    const sortSel = document.createElement("select");
    sortSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:2px 4px;font-size:11px;";
    for (const [v, label] of [["newest", "Newest"], ["oldest", "Oldest"], ["name", "Name"]]) {
        const o = document.createElement("option"); o.value = v; o.textContent = label; sortSel.appendChild(o);
    }
    sortSel.value = node._ygSort ?? "newest";
    sortSel.onchange = () => { node._ygSort = sortSel.value; rerenderGrid(node); };

    const sizeSel = document.createElement("select");
    sizeSel.style.cssText = sortSel.style.cssText;
    for (const s of [80, 110, 150, 200]) {
        const o = document.createElement("option"); o.value = s; o.textContent = `${s}px`; sizeSel.appendChild(o);
    }
    sizeSel.value = String(node._ygThumbSize ?? 110);
    sizeSel.onchange = () => { node._ygThumbSize = +sizeSel.value; rerenderGrid(node); };

    const refreshBtn = btn("🔄", "#444", () => refreshVideoGallery(node, { force: true }));
    refreshBtn.title = "Refresh";

    bar1.appendChild(status);
    bar1.appendChild(sortSel);
    bar1.appendChild(sizeSel);
    bar1.appendChild(refreshBtn);
    root.appendChild(bar1);

    // Toolbar row 2: select + download + delete
    const bar2 = document.createElement("div");
    bar2.style.cssText = "display:flex;align-items:center;gap:6px;padding:0 0 6px;flex-wrap:wrap;";

    const selAllBtn = btn("☑ All",   "#444",    () => toggleSelectAll(node));
    const dlAllBtn  = btn("⬇ All",   "#27ae60", () => downloadAll(node));
    const dlSelBtn  = btn("⬇ Sel",   "#2980b9", () => downloadSelected(node));
    const delBtn    = btn("🗑 Sel",  "#c0392b", () => deleteSelected(node));
    dlSelBtn.style.display = "none";
    delBtn.style.display   = "none";

    node._ygSelAllBtn = selAllBtn;
    node._ygDlSelBtn  = dlSelBtn;
    node._ygDelBtn    = delBtn;

    bar2.appendChild(selAllBtn);
    bar2.appendChild(dlAllBtn);
    bar2.appendChild(dlSelBtn);
    bar2.appendChild(delBtn);
    root.appendChild(bar2);

    // Player panel (built once, hidden)
    const player = buildPlayer(node);
    root.appendChild(player);

    // Grid — expands to fill remaining DOM-widget height; scrolls only when overflowing
    const grid = document.createElement("div");
    grid.style.cssText = `
        display:flex; flex-wrap:wrap; align-content:flex-start; gap:6px;
        flex:1 1 auto; min-height:80px; overflow-y:auto;
        padding:5px; background:#1a1a1a; border-radius:6px;
    `;
    grid.onmouseenter = () => { node._ygUserActive = Date.now(); };
    grid.onmousemove  = () => { node._ygUserActive = Date.now(); };
    root.appendChild(grid);
    node._ygGridEl = grid;

    // Empty placeholder
    const empty = document.createElement("div");
    empty.style.cssText = "color:#888;font-size:12px;text-align:center;padding:18px;display:none;";
    empty.innerHTML = `No videos yet.<br>
        <span style="font-size:11px;color:#555;">
            Make sure <code>filename_prefix</code> matches your Save Video node.
        </span>`;
    root.appendChild(empty);
    node._ygEmptyEl = empty;
}

function btn(label, bg, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `
        background:${bg}; color:#fff; border:none; border-radius:4px;
        padding:3px 9px; font-size:11px; font-weight:600; cursor:pointer;
    `;
    b.onclick = onClick;
    return b;
}

// ── Player ─────────────────────────────────────────────────────────────────

function buildPlayer(node) {
    const panel = document.createElement("div");
    panel.style.cssText = `
        display:none; background:#0c0c0c; border-radius:7px;
        margin-bottom:8px; position:relative; overflow:hidden;
    `;

    const video = document.createElement("video");
    video.controls = true;
    video.muted    = true;          // browsers block unmuted autoplay
    video.playsInline = true;
    video.preload  = "metadata";
    // Caps to viewport so the player never blows out the node when it grows
    video.style.cssText = "width:100%;max-height:60vh;display:block;background:#000;";
    video.onplay   = () => { node._ygPlayerOpen = true; };
    video.onpause  = () => { node._ygPlayerOpen = false; if (node._ygRefreshPending) refreshVideoGallery(node); };
    video.onended  = () => { node._ygPlayerOpen = false; if (node._ygRefreshPending) refreshVideoGallery(node); };
    video.onerror  = () => {
        node._ygPlayerErrEl.textContent = "⚠ Could not load video. File may have been moved or deleted.";
        node._ygPlayerErrEl.style.display = "block";
    };

    const err = document.createElement("div");
    err.style.cssText = "display:none;color:#e74c3c;font-size:11px;padding:4px 6px;";
    node._ygPlayerErrEl = err;

    const title = document.createElement("div");
    title.style.cssText = "font-size:11px;color:#aaa;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:4px;padding:0 6px 6px;flex-wrap:wrap;";

    const fsBtn   = btn("⛶ Fullscreen", "#444", () => video.requestFullscreen?.().catch(()=>{}));
    const tabBtn  = btn("↗ New tab",    "#444", () => window.open(video.src, "_blank", "noopener"));
    const muteBtn = btn("🔊 Unmute",    "#444", () => {
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? "🔊 Unmute" : "🔇 Mute";
    });
    const closeBtn = btn("✕ Close", "#555", () => {
        video.pause(); video.removeAttribute("src"); video.load();
        panel.style.display = "none";
        node._ygPlayerOpen = false;
        err.style.display = "none";
    });

    controls.appendChild(muteBtn);
    controls.appendChild(fsBtn);
    controls.appendChild(tabBtn);
    controls.appendChild(closeBtn);

    panel.appendChild(video);
    panel.appendChild(err);
    panel.appendChild(title);
    panel.appendChild(controls);

    node._ygPlayerEl    = panel;
    node._ygPlayerVideo = video;
    node._ygPlayerTitle = title;
    return panel;
}

function openInPlayer(node, item) {
    const panel = node._ygPlayerEl;
    const video = node._ygPlayerVideo;
    node._ygPlayerErrEl.style.display = "none";
    video.src = viewUrl(item.rel_path);
    node._ygPlayerTitle.textContent = `▶ ${item.filename}`
        + (item.size ? `   ·   ${fmtBytes(item.size)}` : "")
        + (item.mtime ? `   ·   ${fmtTime(item.mtime)}` : "");
    panel.style.display = "block";
    node._ygPlayerOpen = true;
    video.play().catch(() => {/* user gesture not yet — controls remain */});
}

// ── Grid (incremental updates) ─────────────────────────────────────────────

function applyItems(node, items) {
    const old = node._ygItems ?? [];
    node._ygItems = items;

    // Drop stale selections
    if (!node._ygSelected) node._ygSelected = new Set();
    const live = new Set(items.map(i => i.rel_path));
    for (const p of [...node._ygSelected]) if (!live.has(p)) node._ygSelected.delete(p);

    rerenderGrid(node);

    // Update status line
    node._ygStatusEl.textContent = `${items.length} video${items.length === 1 ? "" : "s"}`;

    // Show/hide empty placeholder
    node._ygEmptyEl.style.display = items.length === 0 ? "block" : "none";
    node._ygGridEl.style.display  = items.length === 0 ? "none"  : "flex";
}

function rerenderGrid(node) {
    const grid  = node._ygGridEl;
    const items = sortItems(node._ygItems ?? [], node._ygSort ?? "newest");
    const size  = node._ygThumbSize ?? 110;
    grid.innerHTML = "";

    items.forEach((item, idx) => {
        grid.appendChild(buildThumb(node, item, idx, size));
    });
    updateSelectionUi(node);
    app.graph.setDirtyCanvas(true);
}

function buildThumb(node, item, idx, size) {
    const isSelected = node._ygSelected.has(item.rel_path);
    const wrap = document.createElement("div");
    wrap.dataset.rel = item.rel_path;
    wrap.style.cssText = `
        position:relative; width:${size}px; height:${size}px;
        border-radius:5px; overflow:hidden;
        border:2px solid ${isSelected ? "#2980b9" : "#333"};
        flex-shrink:0; cursor:pointer; background:#222;
    `;
    wrap.title = `#${idx + 1} ${item.filename}`
        + (item.size ? `\n${fmtBytes(item.size)}` : "")
        + (item.mtime ? `\n${fmtTime(item.mtime)}` : "");

    const reqSize = size <= 96 ? 96 : (size <= 160 ? 160 : 240);
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = `/yg/video_thumb?rel_path=${encodeURIComponent(item.rel_path)}&max_size=${reqSize}`;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    img.onerror = () => { img.style.opacity = "0.2"; };

    const play = document.createElement("div");
    play.style.cssText = `
        position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        font-size:${Math.round(size * 0.22)}px; color:#fff; opacity:0.7;
        pointer-events:none; text-shadow:0 1px 4px rgba(0,0,0,0.8);
    `;
    play.textContent = "▶";

    const cb = document.createElement("div");
    cb.dataset.role = "cb";
    cb.style.cssText = `
        position:absolute; top:3px; left:3px; width:18px; height:18px;
        border-radius:4px;
        background:${isSelected ? "#2980b9" : "rgba(0,0,0,0.55)"};
        border:1.5px solid ${isSelected ? "#3498db" : "rgba(255,255,255,0.35)"};
        display:flex; align-items:center; justify-content:center;
        font-size:11px; color:#fff; z-index:5;
    `;
    cb.textContent = isSelected ? "✓" : "";

    const badge = document.createElement("div");
    badge.style.cssText = `
        position:absolute; bottom:0; left:0; right:0;
        background:rgba(0,0,0,0.7); color:#fff;
        font-size:9px; text-align:center; padding:1px 0;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    `;
    badge.textContent = `${idx + 1}  ${item.filename}`;

    wrap.appendChild(img);
    wrap.appendChild(play);
    wrap.appendChild(cb);
    wrap.appendChild(badge);

    wrap.onclick = (e) => {
        node._ygUserActive = Date.now();
        const rect = wrap.getBoundingClientRect();
        const onCb = (e.clientX - rect.left) <= 26 && (e.clientY - rect.top) <= 26;
        if (onCb || e.shiftKey || e.ctrlKey || e.metaKey) {
            toggleSelection(node, item.rel_path);
        } else {
            openInPlayer(node, item);
        }
    };

    return wrap;
}

function toggleSelection(node, rel) {
    if (node._ygSelected.has(rel)) node._ygSelected.delete(rel);
    else node._ygSelected.add(rel);
    // Targeted UI update — find the thumb and patch only it
    const el = node._ygGridEl.querySelector(`[data-rel="${CSS.escape(rel)}"]`);
    if (el) {
        const sel = node._ygSelected.has(rel);
        el.style.border = `2px solid ${sel ? "#2980b9" : "#333"}`;
        const cb = el.querySelector('[data-role="cb"]');
        if (cb) {
            cb.style.background = sel ? "#2980b9" : "rgba(0,0,0,0.55)";
            cb.style.borderColor = sel ? "#3498db" : "rgba(255,255,255,0.35)";
            cb.textContent = sel ? "✓" : "";
        }
    }
    updateSelectionUi(node);
}

function updateSelectionUi(node) {
    const n     = node._ygSelected?.size ?? 0;
    const total = node._ygItems?.length ?? 0;
    node._ygDlSelBtn.textContent = `⬇ Sel (${n})`;
    node._ygDelBtn.textContent   = `🗑 Sel (${n})`;
    node._ygDlSelBtn.style.display = n > 0 ? "inline-block" : "none";
    node._ygDelBtn.style.display   = n > 0 ? "inline-block" : "none";
    node._ygSelAllBtn.textContent = (n === total && total > 0) ? "☐ None" : "☑ All";
}

function toggleSelectAll(node) {
    const items = node._ygItems ?? [];
    if (node._ygSelected.size === items.length) {
        node._ygSelected.clear();
    } else {
        node._ygSelected = new Set(items.map(i => i.rel_path));
    }
    rerenderGrid(node);
}

// ── Actions ────────────────────────────────────────────────────────────────

function downloadAll(node) {
    const batchId = getGalleryBatchId(node);
    const prefix  = getGalleryPrefix(node);
    const total   = node._ygItems?.length ?? 0;
    if (!total) { showToast("No videos to download.", "#e67e22"); return; }
    const url = `/yg/download_videos_zip?batch_id=${encodeURIComponent(batchId)}&prefix=${encodeURIComponent(prefix)}`;
    const a = document.createElement("a");
    a.href = url; a.download = `batch_${batchId}_videos.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    showToast(`📦 Preparing ZIP of ${total} videos…`, "#27ae60", 4000);
}

async function downloadSelected(node) {
    const batchId  = getGalleryBatchId(node);
    const selected = [...(node._ygSelected ?? [])];
    if (!selected.length) return;
    try {
        const r = await fetch("/yg/download_selected_zip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batch_id: batchId, rel_paths: selected }),
        });
        if (!r.ok) { showToast(`Download failed: ${await r.text()}`, "#e74c3c"); return; }
        const blob = await r.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = `selected_${batchId}_${selected.length}videos.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast(`📦 Downloading ${selected.length} videos…`, "#2980b9", 4000);
    } catch (e) {
        showToast(`Download error: ${e.message}`, "#e74c3c");
    }
}

async function deleteSelected(node) {
    const selected = [...(node._ygSelected ?? [])];
    if (!selected.length) return;
    if (!confirm(`Delete ${selected.length} video file(s) from disk?\nThis cannot be undone.`)) return;
    try {
        const r = await fetch("/yg/delete_videos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rel_paths: selected }),
        });
        const data = await r.json();
        const ok = (data.deleted ?? []).length;
        const bad = (data.failed ?? []).length;
        node._ygSelected.clear();
        await refreshVideoGallery(node, { force: true });
        showToast(
            bad > 0 ? `🗑 Deleted ${ok}, failed ${bad}` : `🗑 Deleted ${ok} video(s)`,
            bad > 0 ? "#e67e22" : "#c0392b",
            4000,
        );
    } catch (e) {
        showToast(`Delete error: ${e.message}`, "#e74c3c");
    }
}

// ── Extension registration ─────────────────────────────────────────────────

app.registerExtension({
    name: "YG.VideoGallery",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGVideoGallery") return;

        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            orig?.apply(this, arguments);

            // DOM widget host — flex column so the grid can stretch to fill node height
            const root = document.createElement("div");
            root.style.cssText = "padding:4px 6px 8px;width:100%;height:100%;"
                               + "box-sizing:border-box;display:flex;flex-direction:column;min-height:0;";
            root.innerHTML = `<div style="color:#888;font-size:12px;text-align:center;padding:18px;">
                Loading gallery…</div>`;
            this.addDOMWidget("_yg_gallery", "div", root, {
                serialize: false, hideOnZoom: false,
            });
            this._ygRoot = root;
            this._ygSort = "newest";
            this._ygThumbSize = 110;

            // React to widget edits
            for (const w of this.widgets ?? []) {
                if (w.name === "filename_prefix" || w.name === "batch_id") {
                    const cb = w.callback;
                    w.callback = (...a) => { cb?.(...a); debouncedRefresh(this, 400); };
                }
            }

            // Initial size only on first creation — respect any saved size on reload
            if (!this.size || (this.size[0] < 320 && this.size[1] < 320)) this.setSize([480, 460]);
            setTimeout(() => refreshVideoGallery(this, { force: true }), 600);
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._ygPlayerVideo?.pause(); } catch {}
            clearTimeout(this._ygDebounce);
            origRemoved?.apply(this, arguments);
        };
    },
});

// ── Global event handling ──────────────────────────────────────────────────

function _forEachGallery(fn) {
    if (!app.graph) return;
    for (const n of app.graph._nodes ?? []) {
        if (n.type === "YGVideoGallery") fn(n);
    }
}

function _refreshAllGalleries() {
    _forEachGallery(n => debouncedRefresh(n, 200));
}

const _VIDEO_EXTS = new Set([".mp4", ".webm", ".avi", ".mov", ".mkv", ".m4v"]);
function _isVideoOutput(output) {
    if (!output || typeof output !== "object") return false;
    if (Array.isArray(output.videos) && output.videos.length) return true;
    if (Array.isArray(output.gifs)   && output.gifs.length)   return true;
    for (const v of Object.values(output)) {
        if (!Array.isArray(v)) continue;
        for (const it of v) {
            const name = typeof it === "string" ? it : (it?.filename ?? "");
            const dot  = name.lastIndexOf(".");
            if (dot >= 0 && _VIDEO_EXTS.has(name.slice(dot).toLowerCase())) return true;
        }
    }
    return false;
}

api.addEventListener("executed", (event) => {
    if (_isVideoOutput(event.detail?.output)) _refreshAllGalleries();
});

api.addEventListener("execution_success", () => {
    _refreshAllGalleries();
    setTimeout(_refreshAllGalleries, 2500);   // catch slow video writers
});

// Server push from the YGVideoGallery Python node
api.addEventListener("yg_gallery_updated", (event) => {
    const { batch_id } = event.detail ?? {};
    _forEachGallery(n => {
        if (!batch_id || getGalleryBatchId(n) === batch_id) {
            debouncedRefresh(n, 100);
        }
    });
});

// Polling fallback while queue is active — but only every 6 s, and skipped
// for any gallery that is currently playing a video.
let _ygPollTimer = null;
api.addEventListener("status", (event) => {
    const remaining = event.detail?.status?.exec_info?.queue_remaining ?? 0;
    if (remaining > 0 && !_ygPollTimer) {
        _ygPollTimer = setInterval(_refreshAllGalleries, 6000);
    } else if (remaining === 0 && _ygPollTimer) {
        clearInterval(_ygPollTimer); _ygPollTimer = null;
        setTimeout(_refreshAllGalleries, 800);
    }
});

})();

// =============================================================================
// YG Auto Image Cycler — frontend (Upload / Status / Reset / Clear)
// =============================================================================
(() => {
    const { app } = window.comfyAPI?.app  ? window.comfyAPI.app  : (window.app  ? { app: window.app } : {});
    if (!app) return;

    function getCycleId(node) {
        const w = node.widgets?.find(w => w.name === "cycle_id");
        return (w?.value || "default").toString().trim() || "default";
    }
    function getFolder(node) {
        const w = node.widgets?.find(w => w.name === "folder");
        return (w?.value || "upload").toString();
    }

    function _toast(msg, color = "#27ae60", ms = 4000) {
        const d = document.createElement("div");
        d.textContent = msg;
        Object.assign(d.style, {
            position: "fixed", bottom: "24px", right: "24px",
            padding: "10px 16px", background: color, color: "#fff",
            fontFamily: "sans-serif", fontSize: "13px", borderRadius: "6px",
            zIndex: 999999, whiteSpace: "pre-line",
            boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
        });
        document.body.appendChild(d);
        setTimeout(() => d.remove(), ms);
    }

    async function refreshStatus(node) {
        const sw = node._ygCyclerStatus;
        if (!sw) return;
        try {
            const cid = encodeURIComponent(getCycleId(node));
            const f   = encodeURIComponent(getFolder(node));
            const r = await fetch(`/yg_cycler/info?cycle_id=${cid}&folder=${f}`);
            const j = await r.json();
            if (j.ok) {
                sw.value = `📂 ${j.total} images   ▶ next: #${(j.next_index ?? 0) + 1}   counter=${j.counter}`;
            } else {
                sw.value = `⚠ ${j.error ?? "info failed"}`;
            }
        } catch (e) {
            sw.value = `⚠ ${e.message}`;
        }
        app.graph.setDirtyCanvas(true);
    }

    async function uploadImages(node, clearFirst) {
        return new Promise((resolve) => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.multiple = true;
            inp.accept = "image/*";
            // some browsers fire neither change nor cancel until focus returns
            const cleanup = () => { window.removeEventListener("focus", focusBack); };
            const focusBack = () => setTimeout(() => { if (!inp.files || !inp.files.length) { cleanup(); resolve(false); } }, 500);
            window.addEventListener("focus", focusBack, { once: true });

            inp.onchange = async () => {
                cleanup();
                const files = Array.from(inp.files || []);
                if (!files.length) { resolve(false); return; }
                const cid = getCycleId(node);
                const CHUNK = 50;
                let total = 0, lastFolder = "";
                const btn = node._ygCyclerUploadBtn;
                const orig = btn?.name;
                try {
                    for (let i = 0; i < files.length; i += CHUNK) {
                        const slice = files.slice(i, i + CHUNK);
                        if (btn) { btn.name = `📁 Uploading ${i + slice.length}/${files.length}…`; app.graph.setDirtyCanvas(true); }
                        const fd = new FormData();
                        fd.append("cycle_id", cid);
                        fd.append("clear", (clearFirst && i === 0) ? "1" : "0");
                        for (const f of slice) fd.append("files", f, f.name);
                        const r = await fetch("/yg_cycler/upload", { method: "POST", body: fd });
                        const j = await r.json();
                        if (!j.ok) throw new Error(j.error || "upload failed");
                        total = j.total;
                        lastFolder = j.folder;
                    }
                    _toast(`✅ Uploaded ${files.length} file(s)\nTotal in batch: ${total}\n${lastFolder}`, "#27ae60", 6000);
                    await refreshStatus(node);
                    resolve(true);
                } catch (e) {
                    _toast(`⚠ Upload failed: ${e.message}`, "#e74c3c", 6000);
                    resolve(false);
                } finally {
                    if (btn && orig) { btn.name = orig; app.graph.setDirtyCanvas(true); }
                }
            };
            inp.click();
        });
    }

    async function clearAll(node) {
        if (!confirm(`Delete ALL uploaded images for cycle "${getCycleId(node)}" and reset counter?`)) return;
        try {
            const r = await fetch("/yg_cycler/clear", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cycle_id: getCycleId(node) }),
            });
            const j = await r.json();
            if (j.ok) _toast(`🗑 Cleared ${j.removed} file(s)`, "#e67e22");
            else      _toast(`⚠ ${j.error}`, "#e74c3c");
        } catch (e) { _toast(`⚠ ${e.message}`, "#e74c3c"); }
        await refreshStatus(node);
    }

    async function resetCounter(node) {
        try {
            const r = await fetch("/yg_cycler/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cycle_id: getCycleId(node) }),
            });
            const j = await r.json();
            if (j.ok) _toast(`↻ Counter reset for "${j.cycle_id}"`, "#3498db");
        } catch (e) { _toast(`⚠ ${e.message}`, "#e74c3c"); }
        await refreshStatus(node);
    }

    // ── Thumbnail grid: list+select+delete uploaded images ─────────────────
    function buildGrid(node) {
        const root = document.createElement("div");
        Object.assign(root.style, {
            display: "flex", flexDirection: "column",
            width: "100%", height: "100%",
            minHeight: "0", overflow: "hidden",
            fontFamily: "sans-serif",
            background: "#1a1a1a", borderRadius: "4px",
            padding: "4px", boxSizing: "border-box",
        });

        // toolbar
        const bar = document.createElement("div");
        Object.assign(bar.style, {
            display: "flex", gap: "4px", marginBottom: "4px",
            fontSize: "11px", color: "#ddd", alignItems: "center",
            flexShrink: "0",
        });
        const info = document.createElement("span");
        info.style.flex = "1";
        info.textContent = "loading…";
        const selBtn = document.createElement("button");
        selBtn.textContent = "Select all";
        const delBtn = document.createElement("button");
        delBtn.textContent = "🗑 Delete selected (0)";
        const refBtn = document.createElement("button");
        refBtn.textContent = "🔄";
        for (const b of [selBtn, delBtn, refBtn]) {
            Object.assign(b.style, {
                fontSize: "11px", padding: "2px 8px",
                background: "#333", color: "#eee",
                border: "1px solid #555", borderRadius: "3px",
                cursor: "pointer",
            });
        }
        delBtn.style.background = "#5c2020";
        delBtn.style.borderColor = "#a33";
        bar.append(info, selBtn, delBtn, refBtn);

        // size selector
        const sizeSel = document.createElement("select");
        Object.assign(sizeSel.style, {
            fontSize: "11px", padding: "1px 4px",
            background: "#333", color: "#eee", border: "1px solid #555",
            borderRadius: "3px",
        });
        for (const v of [64, 96, 128, 160]) {
            const o = document.createElement("option");
            o.value = v; o.textContent = `${v}px`;
            if (v === 96) o.selected = true;
            sizeSel.appendChild(o);
        }
        bar.insertBefore(sizeSel, refBtn);

        // grid container
        const grid = document.createElement("div");
        Object.assign(grid.style, {
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(96px, 1fr))`,
            gap: "4px",
            overflowY: "auto", flex: "1 1 auto", minHeight: "0",
            padding: "2px",
        });

        root.append(bar, grid);

        const state = {
            files: [],          // [{name}]
            selected: new Set(),
            thumbSize: 96,
        };

        function updateDelLabel() {
            delBtn.textContent = `🗑 Delete selected (${state.selected.size})`;
        }

        function setThumbSize(n) {
            state.thumbSize = n;
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${n}px, 1fr))`;
            render();
        }

        sizeSel.addEventListener("change", () => setThumbSize(parseInt(sizeSel.value, 10)));

        async function reload() {
            const cid = getCycleId(node);
            try {
                const r = await fetch(`/yg_cycler/info?cycle_id=${encodeURIComponent(cid)}&folder=${encodeURIComponent(getFolder(node))}`);
                const j = await r.json();
                state.files = (j.files || []).map(n => ({ name: n }));
                state.selected.clear();
                info.textContent = `📂 ${j.total ?? 0} images   ▶ next #${(j.next_index ?? 0) + 1}`;
                render();
                updateDelLabel();
            } catch (e) {
                info.textContent = `⚠ ${e.message}`;
            }
        }

        function render() {
            grid.innerHTML = "";
            const cid = getCycleId(node);
            const sz = state.thumbSize;
            state.files.forEach((f, i) => {
                const cell = document.createElement("div");
                Object.assign(cell.style, {
                    position: "relative",
                    width: `${sz}px`, height: `${sz}px`,
                    border: "2px solid transparent",
                    borderRadius: "3px",
                    cursor: "pointer", overflow: "hidden",
                    background: "#222",
                });
                const img = document.createElement("img");
                img.src = `/yg_cycler/thumb?cycle_id=${encodeURIComponent(cid)}&name=${encodeURIComponent(f.name)}&size=${sz * 2}`;
                Object.assign(img.style, {
                    width: `${sz}px`, height: `${sz}px`,
                    objectFit: "contain", display: "block",
                    background: "#111",
                });
                img.loading = "lazy";
                img.title = `#${i + 1}  ${f.name}`;

                const idx = document.createElement("div");
                idx.textContent = `${i + 1}`;
                Object.assign(idx.style, {
                    position: "absolute", top: "2px", left: "2px",
                    background: "rgba(0,0,0,0.7)", color: "#fff",
                    fontSize: "10px", padding: "1px 4px",
                    borderRadius: "2px",
                });

                const x = document.createElement("button");
                x.textContent = "×";
                Object.assign(x.style, {
                    position: "absolute", top: "1px", right: "1px",
                    width: "18px", height: "18px", padding: "0",
                    background: "rgba(180,30,30,0.85)", color: "#fff",
                    border: "none", borderRadius: "3px",
                    fontSize: "14px", lineHeight: "16px",
                    cursor: "pointer",
                });
                x.title = "Delete this image";
                x.addEventListener("click", async (ev) => {
                    ev.stopPropagation();
                    if (!confirm(`Delete "${f.name}"?`)) return;
                    await deleteNames(node, [f.name]);
                    await reload();
                });

                const setSel = (on) => {
                    if (on) {
                        cell.style.borderColor = "#3498db";
                        cell.style.boxShadow = "0 0 0 1px #3498db inset";
                    } else {
                        cell.style.borderColor = "transparent";
                        cell.style.boxShadow = "none";
                    }
                };
                if (state.selected.has(f.name)) setSel(true);

                cell.addEventListener("click", () => {
                    if (state.selected.has(f.name)) {
                        state.selected.delete(f.name); setSel(false);
                    } else {
                        state.selected.add(f.name); setSel(true);
                    }
                    updateDelLabel();
                });

                cell.append(img, idx, x);
                grid.appendChild(cell);
            });
        }

        selBtn.addEventListener("click", () => {
            if (state.selected.size === state.files.length) {
                state.selected.clear();
                selBtn.textContent = "Select all";
            } else {
                state.files.forEach(f => state.selected.add(f.name));
                selBtn.textContent = "Select none";
            }
            render(); updateDelLabel();
        });

        delBtn.addEventListener("click", async () => {
            if (state.selected.size === 0) {
                _toast("Select images first (click thumbnails)", "#e67e22", 3000);
                return;
            }
            if (!confirm(`Delete ${state.selected.size} selected image(s)?`)) return;
            await deleteNames(node, [...state.selected]);
            await reload();
        });

        refBtn.addEventListener("click", reload);

        node._ygCyclerGridReload = reload;
        return root;
    }

    async function deleteNames(node, names) {
        try {
            const r = await fetch("/yg_cycler/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cycle_id: getCycleId(node), names }),
            });
            const j = await r.json();
            if (j.ok) _toast(`🗑 Deleted ${j.removed.length} of ${names.length}`, "#e67e22", 3500);
            else      _toast(`⚠ ${j.error || "delete failed"}`, "#e74c3c");
        } catch (e) {
            _toast(`⚠ ${e.message}`, "#e74c3c");
        }
        await refreshStatus(node);
    }

    app.registerExtension({
        name: "yg.auto_image_cycler",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== "YGAutoImageCycler") return;
            const orig = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = orig?.apply(this, arguments);

                this._ygCyclerUploadBtn = this.addWidget("button", "📁 Upload Images (add to batch)", null,
                    () => uploadImages(this, false).then(() => this._ygCyclerGridReload?.()));
                this.addWidget("button", "📁 Upload Images (REPLACE batch)", null,
                    () => uploadImages(this, true).then(() => this._ygCyclerGridReload?.()));
                this.addWidget("button", "↻ Reset counter (start at #1)", null,
                    () => resetCounter(this));
                this.addWidget("button", "🗑 Clear all uploaded images", null,
                    () => clearAll(this).then(() => this._ygCyclerGridReload?.()));
                this._ygCyclerStatus = this.addWidget("text", "status", "📂 (no images yet)", () => {});
                this._ygCyclerStatus.disabled = true;

                // DOM widget: thumbnail grid
                const gridEl = buildGrid(this);
                this.addDOMWidget("preview_grid", "div", gridEl, {
                    serialize: false,
                    hideOnZoom: false,
                });

                // initial load
                setTimeout(() => {
                    refreshStatus(this);
                    this._ygCyclerGridReload?.();
                }, 300);

                if (this.size) {
                    if (this.size[0] < 380) this.size[0] = 380;
                    if (this.size[1] < 560) this.size[1] = 560;
                }
                return r;
            };
        },
    });
})();

// =============================================================================
// YG Video Collector — frontend (grid + select + download + delete)
// =============================================================================
(() => {
    const { app } = window.comfyAPI?.app ? window.comfyAPI.app : (window.app ? { app: window.app } : {});
    const { api } = window.comfyAPI?.api ? window.comfyAPI.api : (window.api ? { api: window.api } : {});
    if (!app) return;

    const _toast = (msg, color = "#27ae60", ms = 4000) => {
        const d = document.createElement("div");
        d.textContent = msg;
        Object.assign(d.style, {
            position: "fixed", bottom: "24px", right: "24px",
            padding: "10px 16px", background: color, color: "#fff",
            fontFamily: "sans-serif", fontSize: "13px", borderRadius: "6px",
            zIndex: 999999, whiteSpace: "pre-line",
            boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
        });
        document.body.appendChild(d);
        setTimeout(() => d.remove(), ms);
    };

    function getCollectionId(node) {
        const w = node.widgets?.find(w => w.name === "collection_id");
        return (w?.value || "default").toString().trim() || "default";
    }

    function buildCollectorUI(node) {
        const root = document.createElement("div");
        Object.assign(root.style, {
            display: "flex", flexDirection: "column",
            width: "100%", height: "100%",
            minHeight: "0", overflow: "hidden",
            fontFamily: "sans-serif",
            background: "#1a1a1a", borderRadius: "4px",
            padding: "4px", boxSizing: "border-box",
        });

        // toolbar
        const bar = document.createElement("div");
        Object.assign(bar.style, {
            display: "flex", gap: "4px", marginBottom: "4px",
            fontSize: "11px", color: "#ddd", alignItems: "center",
            flexShrink: "0", flexWrap: "wrap",
        });
        const info = document.createElement("span");
        info.style.flex = "1";
        info.style.minWidth = "120px";
        info.textContent = "loading…";

        const sizeSel = document.createElement("select");
        for (const v of [120, 160, 200, 280]) {
            const o = document.createElement("option");
            o.value = v; o.textContent = `${v}px`;
            if (v === 160) o.selected = true;
            sizeSel.appendChild(o);
        }

        const sortSel = document.createElement("select");
        for (const [val, lbl] of [["new", "Newest"], ["old", "Oldest"], ["name", "Name"]]) {
            const o = document.createElement("option");
            o.value = val; o.textContent = lbl;
            sortSel.appendChild(o);
        }

        const selBtn = document.createElement("button"); selBtn.textContent = "Select all";
        const dlBtn  = document.createElement("button"); dlBtn.textContent  = "⬇ Download selected (0)";
        const dlAllBtn = document.createElement("button"); dlAllBtn.textContent = "⬇ Download ALL";
        const delBtn = document.createElement("button"); delBtn.textContent = "🗑 Delete selected (0)";
        const clrBtn = document.createElement("button"); clrBtn.textContent = "🗑 Clear all";
        const refBtn = document.createElement("button"); refBtn.textContent = "🔄";

        for (const el of [sizeSel, sortSel, selBtn, dlBtn, dlAllBtn, delBtn, clrBtn, refBtn]) {
            Object.assign(el.style, {
                fontSize: "11px", padding: "2px 8px",
                background: "#333", color: "#eee",
                border: "1px solid #555", borderRadius: "3px",
                cursor: "pointer",
            });
        }
        dlBtn.style.background = "#1c4a2a"; dlBtn.style.borderColor = "#2a7";
        dlAllBtn.style.background = "#1c4a2a"; dlAllBtn.style.borderColor = "#2a7";
        delBtn.style.background = "#5c2020"; delBtn.style.borderColor = "#a33";
        clrBtn.style.background = "#5c2020"; clrBtn.style.borderColor = "#a33";

        bar.append(info, sizeSel, sortSel, selBtn, dlBtn, dlAllBtn, delBtn, clrBtn, refBtn);

        const grid = document.createElement("div");
        Object.assign(grid.style, {
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(160px, 1fr))`,
            gap: "6px",
            overflowY: "auto", flex: "1 1 auto", minHeight: "0",
            padding: "2px",
        });

        root.append(bar, grid);

        const state = { items: [], selected: new Set(), thumb: 160, sort: "new" };

        const updDl = () => {
            dlBtn.textContent = `⬇ Download selected (${state.selected.size})`;
            delBtn.textContent = `🗑 Delete selected (${state.selected.size})`;
        };

        function setThumb(n) {
            state.thumb = n;
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${n}px, 1fr))`;
            render();
        }
        sizeSel.onchange = () => setThumb(parseInt(sizeSel.value, 10));
        sortSel.onchange = () => { state.sort = sortSel.value; render(); };

        async function reload() {
            const cid = getCollectionId(node);
            try {
                const r = await fetch(`/yg_collector/list?collection_id=${encodeURIComponent(cid)}`);
                const j = await r.json();
                state.items = j.items || [];
                state.selected.clear();
                info.textContent = `🎬 ${j.total ?? 0} videos · ${cid}`;
                render(); updDl();
            } catch (e) {
                info.textContent = `⚠ ${e.message}`;
            }
        }
        node._ygCollectorReload = reload;

        function sortedItems() {
            const arr = [...state.items];
            if (state.sort === "new") arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            else if (state.sort === "old") arr.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
            else arr.sort((a, b) => a.name.localeCompare(b.name));
            return arr;
        }

        function render() {
            grid.innerHTML = "";
            const cid = getCollectionId(node);
            const tn = state.thumb;
            const items = sortedItems();
            items.forEach((it, i) => {
                const cell = document.createElement("div");
                Object.assign(cell.style, {
                    position: "relative", width: "100%",
                    height: `${Math.round(tn * 9 / 16) + 24}px`,
                    border: "2px solid transparent", borderRadius: "3px",
                    background: "#222", cursor: "pointer", overflow: "hidden",
                });
                const img = document.createElement("img");
                img.src = `/yg_collector/thumb?collection_id=${encodeURIComponent(cid)}&name=${encodeURIComponent(it.name)}`;
                Object.assign(img.style, {
                    width: "100%", height: `${Math.round(tn * 9 / 16)}px`,
                    objectFit: "contain", display: "block",
                    background: "#111",
                });
                img.loading = "lazy";

                const label = document.createElement("div");
                label.textContent = `${i + 1}. ${it.name}`;
                Object.assign(label.style, {
                    position: "absolute", bottom: "0", left: "0", right: "0",
                    padding: "2px 4px", fontSize: "10px", color: "#ddd",
                    background: "rgba(0,0,0,0.7)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                });

                const playBtn = document.createElement("button");
                playBtn.textContent = "▶";
                Object.assign(playBtn.style, {
                    position: "absolute", top: "2px", left: "2px",
                    width: "22px", height: "22px", padding: "0",
                    background: "rgba(40,120,200,0.9)", color: "#fff",
                    border: "none", borderRadius: "3px", fontSize: "12px",
                    cursor: "pointer",
                });
                playBtn.title = "Play in popup";
                playBtn.onclick = (e) => {
                    e.stopPropagation();
                    openPlayer(cid, it.name);
                };

                const dl = document.createElement("a");
                dl.textContent = "⬇";
                dl.href = `/yg_collector/video?collection_id=${encodeURIComponent(cid)}&name=${encodeURIComponent(it.name)}`;
                dl.download = it.name;
                Object.assign(dl.style, {
                    position: "absolute", top: "2px", right: "26px",
                    width: "22px", height: "22px", lineHeight: "22px",
                    textAlign: "center", textDecoration: "none",
                    background: "rgba(40,160,80,0.9)", color: "#fff",
                    borderRadius: "3px", fontSize: "12px",
                });
                dl.title = "Download this video";
                dl.onclick = (e) => e.stopPropagation();

                const x = document.createElement("button");
                x.textContent = "×";
                Object.assign(x.style, {
                    position: "absolute", top: "2px", right: "2px",
                    width: "22px", height: "22px", padding: "0",
                    background: "rgba(180,30,30,0.9)", color: "#fff",
                    border: "none", borderRadius: "3px",
                    fontSize: "14px", cursor: "pointer",
                });
                x.title = "Delete";
                x.onclick = async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete "${it.name}"?`)) return;
                    await deleteNames(node, [it.name]);
                    await reload();
                };

                const setSel = (on) => {
                    cell.style.borderColor = on ? "#3498db" : "transparent";
                    cell.style.boxShadow = on ? "0 0 0 1px #3498db inset" : "none";
                };
                if (state.selected.has(it.name)) setSel(true);

                cell.onclick = () => {
                    if (state.selected.has(it.name)) { state.selected.delete(it.name); setSel(false); }
                    else { state.selected.add(it.name); setSel(true); }
                    updDl();
                };

                cell.append(img, label, playBtn, dl, x);
                grid.appendChild(cell);
            });
        }

        function openPlayer(cid, name) {
            const ov = document.createElement("div");
            Object.assign(ov.style, {
                position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
                background: "rgba(0,0,0,0.85)", zIndex: "999999",
                display: "flex", alignItems: "center", justifyContent: "center",
            });
            const v = document.createElement("video");
            v.src = `/yg_collector/video?collection_id=${encodeURIComponent(cid)}&name=${encodeURIComponent(name)}`;
            v.controls = true; v.autoplay = true;
            v.style.maxWidth = "90vw"; v.style.maxHeight = "90vh";
            ov.appendChild(v);
            ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
            document.body.appendChild(ov);
        }

        selBtn.onclick = () => {
            if (state.selected.size === state.items.length) state.selected.clear();
            else state.items.forEach(it => state.selected.add(it.name));
            render(); updDl();
        };

        dlBtn.onclick = async () => {
            if (state.selected.size === 0) { _toast("Select videos first", "#e67e22"); return; }
            await downloadZip(getCollectionId(node), [...state.selected]);
        };
        dlAllBtn.onclick = async () => {
            if (state.items.length === 0) { _toast("No videos to download", "#e67e22"); return; }
            await downloadZip(getCollectionId(node), null);
        };

        delBtn.onclick = async () => {
            if (state.selected.size === 0) { _toast("Select videos first", "#e67e22"); return; }
            if (!confirm(`Delete ${state.selected.size} video(s)?`)) return;
            await deleteNames(node, [...state.selected]);
            await reload();
        };
        clrBtn.onclick = async () => {
            if (!confirm(`Delete ALL videos in collection "${getCollectionId(node)}"?`)) return;
            try {
                const r = await fetch("/yg_collector/clear", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ collection_id: getCollectionId(node) }),
                });
                const j = await r.json();
                if (j.ok) _toast(`🗑 Cleared ${j.removed} videos`, "#e67e22");
            } catch (e) { _toast(`⚠ ${e.message}`, "#e74c3c"); }
            await reload();
        };
        refBtn.onclick = reload;

        return root;
    }

    async function deleteNames(node, names) {
        try {
            const r = await fetch("/yg_collector/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ collection_id: getCollectionId(node), names }),
            });
            const j = await r.json();
            if (j.ok) _toast(`🗑 Deleted ${j.removed.length}`, "#e67e22");
        } catch (e) { _toast(`⚠ ${e.message}`, "#e74c3c"); }
    }

    async function downloadZip(cid, names) {
        try {
            const r = await fetch("/yg_collector/download_zip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ collection_id: cid, names }),
            });
            if (!r.ok) throw new Error(await r.text());
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = (r.headers.get("Content-Disposition") || "").match(/filename="?([^"]+)"?/)?.[1] || `${cid}.zip`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            _toast(`✅ Download started`, "#27ae60");
        } catch (e) { _toast(`⚠ ${e.message}`, "#e74c3c"); }
    }

    // global: refresh every collector node when a prompt finishes
    if (api && !window._ygCollectorListenerInstalled) {
        window._ygCollectorListenerInstalled = true;
        const refreshAll = () => {
            for (const n of (app.graph?._nodes || [])) {
                if (n.comfyClass === "YGVideoCollector" && n._ygCollectorReload) {
                    setTimeout(() => n._ygCollectorReload(), 600);
                }
            }
        };
        api.addEventListener("execution_success", refreshAll);
        api.addEventListener("executed", refreshAll);
    }

    app.registerExtension({
        name: "yg.video_collector",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== "YGVideoCollector") return;
            const orig = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = orig?.apply(this, arguments);
                const ui = buildCollectorUI(this);
                this.addDOMWidget("video_collector_grid", "div", ui, {
                    serialize: false, hideOnZoom: false,
                });
                setTimeout(() => this._ygCollectorReload?.(), 400);
                if (this.size) {
                    if (this.size[0] < 520) this.size[0] = 520;
                    if (this.size[1] < 480) this.size[1] = 480;
                }
                return r;
            };
        },
    });
})();
