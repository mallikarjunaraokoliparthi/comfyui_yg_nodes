// ── YG ZIP Nodes JS ────────────────────────────────────────────────────────────
// Adds custom UI to:
//   • YGZipImageLoader  → Upload ZIP button (OS file picker), progress bar, Run All
//   • YGZipImageSaver   → Download ZIP button (appears when ZIP is ready)
// ──────────────────────────────────────────────────────────────────────────────

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

function showToast(msg, color = "#2ecc71", duration = 7000) {
    let t = document.getElementById("yg-zip-toast");
    if (!t) {
        t = document.createElement("div");
        t.id = "yg-zip-toast";
        Object.assign(t.style, {
            position: "fixed", bottom: "24px", right: "24px",
            zIndex: "99999", padding: "12px 18px", borderRadius: "10px",
            fontSize: "13px", fontWeight: "600", color: "#fff",
            maxWidth: "400px", lineHeight: "1.55",
            boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
            display: "none", whiteSpace: "pre-line",
            transition: "opacity 0.3s",
        });
        document.body.appendChild(t);
    }
    t.style.background = color;
    t.textContent = msg;
    t.style.display = "block";
    t.style.opacity = "1";
    clearTimeout(t._ygTimer);
    t._ygTimer = setTimeout(() => { t.style.opacity = "0"; setTimeout(() => { t.style.display = "none"; }, 300); }, duration);
}

function getJobId(node) {
    return node.widgets?.find(w => w.name === "job_id")?.value?.trim() || "my_zip_job";
}

// Stop auto-queue helper — only disables the toggle, does NOT interrupt execution.
// IMPORTANT: never call api.interrupt() here — it would kill in-progress Saver executions
// and prevent ZIP creation.
function stopAutoQueue() {
    try {
        if (typeof app.ui?.autoQueueEnabled !== "undefined") app.ui.autoQueueEnabled = false;
        if (typeof app.autoQueueEnabled     !== "undefined") app.autoQueueEnabled     = false;
    } catch (_) {}
    try {
        for (const el of document.querySelectorAll("button, input[type='checkbox'], label")) {
            const text = (el.textContent || el.value || el.id || "").toLowerCase();
            if (text.includes("auto queue") || text.includes("auto-queue")) {
                if (el.tagName === "INPUT" && el.checked)  { el.click(); break; }
                if (el.tagName === "BUTTON")               { el.click(); break; }
                if (el.tagName === "LABEL") {
                    const cb = el.querySelector("input[type='checkbox']");
                    if (cb?.checked) { cb.click(); break; }
                }
            }
        }
    } catch (_) {}
    // NOTE: intentionally NOT calling api.interrupt() here
}

function waitForPromptDone(promptId, timeoutMs = 60 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const off = () => {
            api.removeEventListener("execution_success",     onOk);
            api.removeEventListener("execution_error",       onErr);
            api.removeEventListener("execution_interrupted", onInt);
            if (timer) clearTimeout(timer);
        };
        const onOk  = e => { if (!promptId || e.detail?.prompt_id === promptId) { off(); resolve("ok"); } };
        const onErr = e => { if (!promptId || e.detail?.prompt_id === promptId) { off(); reject(new Error(e.detail?.exception_message || "error")); } };
        const onInt = e => { if (!promptId || e.detail?.prompt_id === promptId) { off(); reject(new Error("interrupted")); } };
        api.addEventListener("execution_success",     onOk);
        api.addEventListener("execution_error",       onErr);
        api.addEventListener("execution_interrupted", onInt);
        timer = setTimeout(() => { off(); reject(new Error("timeout")); }, timeoutMs);
    });
}

async function freeVram() {
    for (let k = 0; k < 3; k++) {
        try {
            await fetch("/free", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ unload_models: true, free_memory: true }),
            });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1500));
    }
}

// ── Upload ZIP → server ────────────────────────────────────────────────────────

async function uploadZip(node, file) {
    const jobId  = getJobId(node);
    const sw     = node._ygZipStatus;
    const btnW   = node._ygUploadBtn;

    if (btnW) { btnW.name = "⏳ Uploading…"; app.graph.setDirtyCanvas(true); }
    if (sw)   { sw.value = `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`; }

    try {
        const fd = new FormData();
        fd.append("zip_file", file, file.name);

        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `/yg/zip_upload?job_id=${encodeURIComponent(jobId)}`, true);
            
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    if (pct < 100) {
                        if (sw) sw.value = `Uploading ${file.name} (${pct}%)…`;
                        if (node._ygProgressBar && node._ygProgressLabel) {
                            node._ygProgressBar.style.width = pct + "%";
                            node._ygProgressBar.style.background = "linear-gradient(90deg, #3498db, #2980b9)";
                            node._ygProgressLabel.textContent = `Uploading: ${pct}%`;
                        }
                    } else {
                        if (sw) sw.value = `Extracting ${file.name}… please wait.`;
                        if (node._ygProgressBar && node._ygProgressLabel) {
                            node._ygProgressBar.style.width = "100%";
                            node._ygProgressBar.style.background = "linear-gradient(90deg, #f39c12, #f1c40f)";
                            node._ygProgressLabel.textContent = `Extracting images on server…`;
                        }
                    }
                    app.graph.setDirtyCanvas(true);
                }
            };
            
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (err) {
                        reject(new Error("Invalid JSON response"));
                    }
                } else {
                    try {
                        const errData = JSON.parse(xhr.responseText);
                        reject(new Error(errData.message || "Upload failed"));
                    } catch (err) {
                        reject(new Error(`Upload failed with status ${xhr.status}`));
                    }
                }
            };
            
            xhr.onerror = () => reject(new Error("Network error during upload"));
            xhr.send(fd);
        });

        if (data.status === "extracting") {
            // Backend is extracting in the background. Websocket events will handle the rest.
            showToast(`📦 Upload complete!\nServer is now extracting files...`, "#3498db");
            return;
        }

        const msg = `✅ ${data.total} images loaded\nFolders: ${data.folders.join(", ") || "(root)"}`;
        if (sw) { sw.value = msg; }
        updateProgress(node, 0, data.total);
        showToast(`📦 ZIP ready!\n${data.total} images in job "${jobId}"\nClick ▶ Run All Images to start.`, "#27ae60");

    } catch (err) {
        const errMsg = `❌ Upload failed: ${err.message}`;
        if (sw) { sw.value = errMsg; }
        showToast(errMsg, "#e74c3c");
    } finally {
        if (btnW) { btnW.name = "📂  Upload ZIP File"; app.graph.setDirtyCanvas(true); }
    }
}

// ── Progress bar update ────────────────────────────────────────────────────────

function updateProgress(node, index, total) {
    const bar = node._ygProgressBar;
    const lbl = node._ygProgressLabel;
    if (!bar || !lbl) return;

    bar.style.background = "linear-gradient(90deg, #27ae60, #2ecc71)";
    const pct = total > 0 ? Math.round(((index) / total) * 100) : 0;
    bar.style.width = pct + "%";
    lbl.textContent = total > 0 ? `${index} / ${total} (${pct}%)` : "No ZIP loaded";
    app.graph.setDirtyCanvas(true);
}

// ── Create ZIP manually (for interrupted runs) ────────────────────────────────

async function createZipNow(node) {
    const jobId = getJobId(node);
    const btn   = node._ygCreateZipBtn;

    if (btn) { btn.name = "⏳ Creating ZIP…"; app.graph.setDirtyCanvas(true); }

    try {
        const resp = await fetch("/yg/zip_create_now", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ job_id: jobId }),
        });
        const data = await resp.json();

        if (data.status !== "ok") {
            throw new Error(data.message || "Failed to create ZIP");
        }

        activateDownloadButton(node, jobId, data.filename, data.count);
        if (node._ygSaverStatusBox) {
            node._ygSaverStatusBox.innerHTML = `
                ✅ ZIP ready: <b style="color:#2ecc71">${data.filename}</b><br>
                <span style="font-size:10px;color:#888">${data.count} images packaged</span>
            `;
        }
        showToast(`✅ ZIP created! ${data.count} images\nClick "⬇ Download ZIP" to save.`, "#27ae60", 10000);

    } catch (err) {
        showToast(`❌ Create ZIP failed: ${err.message}`, "#e74c3c");
    } finally {
        if (btn) { btn.name = "🗜️  Create ZIP Now"; app.graph.setDirtyCanvas(true); }
    }
}

// ── Run All sequentially (one image per queue run + free VRAM between) ─────────

let _zipRunAllAbort = false;

async function runAllZipImages(node) {
    const jobId  = getJobId(node);
    const btnW   = node._ygRunAllBtn;

    // Toggle: second click = stop
    if (node._ygRunAllRunning) {
        _zipRunAllAbort = true;
        showToast("⏹ Stop requested — finishing current image.", "#e67e22", 4000);
        if (btnW) { btnW.name = "⏹  Stopping…"; app.graph.setDirtyCanvas(true); }
        return;
    }

    try {
        // Get job info
        const resp = await fetch(`/yg/zip_job_info?job_id=${encodeURIComponent(jobId)}`);
        const info = await resp.json();
        const count = info.total ?? 0;

        if (count === 0) {
            showToast(`⚠️ No ZIP loaded for job "${jobId}".\nClick "📂 Upload ZIP File" first.`, "#e67e22");
            return;
        }

        if (!confirm(
            `Run ${count} image(s) for job "${jobId}"?\n\n` +
            `• Each image is processed one at a time\n` +
            `• VRAM is freed between images\n` +
            `• Background removed images saved to output ZIP\n\n` +
            `Click the button again to stop after current image.`
        )) return;

        // Reset index to 0
        await fetch("/yg/zip_reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: jobId }),
        });

        // Also clear any old output ZIP state + saved images
        await fetch("/yg/zip_output_clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: jobId, delete_images: true }),
        });

        node._ygRunAllRunning = true;
        _zipRunAllAbort       = false;
        updateProgress(node, 0, count);

        // Clear stale saver node UI so old zip name doesn't show
        for (const n of app.graph._nodes ?? []) {
            if (n.type !== "YGZipImageSaver") continue;
            if (getJobId(n) !== jobId) continue;
            n._ygZipDownloadReady = false;
            if (n._ygDownloadBtn)    { n._ygDownloadBtn.name = "⬇  Download ZIP  (waiting…)"; }
            if (n._ygSaverStatusBox) {
                n._ygSaverStatusBox.innerHTML = `
                    ⏳ Running job "${jobId}"…<br>
                    <span style="font-size:10px;color:#555">Saving images…</span>
                `;
            }
            app.graph.setDirtyCanvas(true);
            break;
        }

        let ok = 0, fail = 0;

        for (let i = 1; i <= count; i++) {
            if (_zipRunAllAbort) break;

            if (btnW) { btnW.name = `⏹  Stop  (${i}/${count} running…)`; app.graph.setDirtyCanvas(true); }

            // Start listening BEFORE queuing to prevent race conditions on very fast GPU inference
            const donePromise = waitForPromptDone(null);

            try {
                await app.queuePrompt(0, 1);
            } catch (e) {
                showToast(`⚠️ Queue failed at #${i}: ${e?.message}`, "#e74c3c");
                fail++;
                break;
            }

            // Wait for it to finish
            try {
                await donePromise;
                ok++;
                updateProgress(node, i, count);
            } catch (e) {
                fail++;
                if (e.message === "interrupted") break;
                showToast(`⚠️ Image #${i} failed: ${e.message}`, "#e74c3c", 5000);
            }


        }

        const msg = _zipRunAllAbort
            ? `⏹ Stopped: ${ok} done, ${fail} failed`
            : fail > 0
                ? `⚠️ Finished: ${ok}/${count} ok, ${fail} failed`
                : `✅ All ${count} images done for "${jobId}"!\nCheck the Saver node for the Download button.`;

        showToast(msg, fail > 0 || _zipRunAllAbort ? "#e67e22" : "#27ae60", 10000);

    } catch (e) {
        showToast(`⚠️ Run All failed: ${e?.message ?? e}`, "#e74c3c");
    } finally {
        node._ygRunAllRunning = false;
        _zipRunAllAbort       = false;
        if (btnW) {
            setTimeout(() => {
                btnW.name = "▶  Run All Images";
                app.graph.setDirtyCanvas(true);
            }, 1500);
        }
    }
}

// ── Server events ──────────────────────────────────────────────────────────────

// Server extraction progress (during ZIP upload/extract phase)
api.addEventListener("yg_zip_extract_progress", (event) => {
    const { job_id, index, total, filename } = event.detail ?? {};
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageLoader" && node.type !== "YGLocalZipImageLoader") continue;
        if (getJobId(node) !== job_id) continue;
        
        if (node._ygProgressBar && node._ygProgressLabel) {
            const pct = total > 0 ? Math.round((index / total) * 100) : 0;
            node._ygProgressBar.style.width = pct + "%";
            node._ygProgressBar.style.background = "linear-gradient(90deg, #f39c12, #f1c40f)";
            node._ygProgressLabel.textContent = `Extracting: ${index} / ${total} (${pct}%)`;
        }
        if (node._ygZipStatus) {
            node._ygZipStatus.value = `Extracting: ${filename}`;
        }
        app.graph.setDirtyCanvas(true);
        break;
    }
});

// Extraction complete
api.addEventListener("yg_zip_extract_done", (event) => {
    const { job_id, total, folders } = event.detail ?? {};
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageLoader" && node.type !== "YGLocalZipImageLoader") continue;
        if (getJobId(node) !== job_id) continue;
        
        const msg = `✅ ${total} images loaded\nFolders: ${folders.join(", ") || "(root)"}`;
        if (node._ygZipStatus) { node._ygZipStatus.value = msg; }
        updateProgress(node, 0, total);
        if (node._ygUploadBtn) { node._ygUploadBtn.name = "📂  Upload ZIP File"; }
        showToast(`📦 ZIP extraction complete!\n${total} images ready in job "${job_id}".\nClick ▶ Run All Images to start.`, "#27ae60");
        app.graph.setDirtyCanvas(true);
        break;
    }
});

// Extraction error
api.addEventListener("yg_zip_extract_error", (event) => {
    const { job_id, message } = event.detail ?? {};
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageLoader" && node.type !== "YGLocalZipImageLoader") continue;
        if (getJobId(node) !== job_id) continue;
        
        if (node._ygZipStatus) { node._ygZipStatus.value = `❌ Extract failed: ${message}`; }
        if (node._ygUploadBtn) { node._ygUploadBtn.name = "📂  Upload ZIP File"; }
        showToast(`❌ ZIP extraction failed: ${message}`, "#e74c3c");
        app.graph.setDirtyCanvas(true);
        break;
    }
});

// Progress update from loader node
api.addEventListener("yg_zip_progress", (event) => {
    const { job_id, index, total, is_last, status } = event.detail ?? {};
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageLoader" && node.type !== "YGLocalZipImageLoader") continue;
        if (getJobId(node) !== job_id) continue;
        updateProgress(node, index + 1, total);
        if (node._ygZipStatus) { node._ygZipStatus.value = status ?? ""; }
        // NOTE: do NOT call stopAutoQueue() or api.interrupt() here!
        // The Saver node is still running — interrupting would kill the ZIP creation.
        // The runAllZipImages loop handles stopping naturally after waitForPromptDone resolves.
        break;
    }
});

// Real-time save progress from saver node (fires for each saved image)
api.addEventListener("yg_zip_save_progress", (event) => {
    const { job_id, current_index, total_count, folder_name, filename } = event.detail ?? {};
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageSaver") continue;
        if (getJobId(node) !== job_id) continue;
        if (node._ygSaverStatusBox) {
            const pct = total_count > 0 ? Math.round(((current_index + 1) / total_count) * 100) : 0;
            node._ygSaverStatusBox.innerHTML = `
                💾 Saving ${current_index + 1} / ${total_count} &nbsp;(${pct}%)<br>
                <span style="font-size:10px;color:#888">${folder_name ? folder_name + "/" : ""}${filename}</span>
            `;
            app.graph.setDirtyCanvas(true);
        }
        break;
    }
});

// ZIP ready from saver
api.addEventListener("yg_zip_ready", (event) => {
    const { job_id, filename, total } = event.detail ?? {};

    // Find the saver node with matching job_id and activate download button
    for (const node of app.graph._nodes ?? []) {
        if (node.type !== "YGZipImageSaver") continue;
        if (getJobId(node) !== job_id) continue;
        activateDownloadButton(node, job_id, filename, total);
        break;
    }

    showToast(
        `🎉 All done! "${filename}" is ready.\nClick "⬇ Download ZIP" on the Saver node.`,
        "#27ae60", 15000
    );
});

function activateDownloadButton(node, jobId, filename, total) {
    const btn = node._ygDownloadBtn;
    if (!btn) return;
    btn.name = `⬇  Download ZIP  (${total} images)`;
    node._ygZipDownloadReady = true;
    node._ygZipJobId         = jobId;
    node._ygZipFilename      = filename;

    // ── Update status box to show ZIP ready ──────────────────────────
    if (node._ygSaverStatusBox) {
        node._ygSaverStatusBox.innerHTML = `
            ✅ ZIP ready: <b style="color:#2ecc71">${filename}</b><br>
            <span style="font-size:10px;color:#888">${total} images · Click Download button above</span>
        `;
    }

    // Flash the button to draw attention
    let flash = 0;
    const interval = setInterval(() => {
        if (flash++ > 6) { clearInterval(interval); app.graph.setDirtyCanvas(true); return; }
        app.graph.setDirtyCanvas(true);
    }, 400);
}

// ── YG ZIP Image Loader extension ─────────────────────────────────────────────

app.registerExtension({
    name: "YG.ZipImageLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGZipImageLoader") return;

        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            orig?.apply(this, arguments);

            // ── 1. Upload ZIP button ─────────────────────────────────────
            this._ygUploadBtn = this.addWidget("button", "📂  Upload ZIP File", null, () => {
                // Create hidden file input and trigger click (OS file picker popup)
                const input    = document.createElement("input");
                input.type     = "file";
                input.accept   = ".zip,application/zip";
                input.style.display = "none";
                document.body.appendChild(input);

                input.onchange = (e) => {
                    document.body.removeChild(input);
                    const file = e.target.files?.[0];
                    if (file) uploadZip(this, file);
                };

                // Small delay so ComfyUI doesn't capture the click
                setTimeout(() => { input.click(); }, 50);
            });

            // ── 2. Reset button ──────────────────────────────────────────
            this.addWidget("button", "🔄  Reset to Image 1", null, async () => {
                const jobId = getJobId(this);
                await fetch("/yg/zip_reset", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ job_id: jobId }),
                });
                updateProgress(this, 0, null);
                const resp = await fetch(`/yg/zip_job_info?job_id=${encodeURIComponent(jobId)}`);
                const info = await resp.json();
                updateProgress(this, 0, info.total ?? 0);
                showToast(`🔄 Job "${jobId}" reset to image 1`, "#3498db", 3000);
            });

            // ── 3. Run All button ────────────────────────────────────────
            this._ygRunAllBtn = this.addWidget(
                "button", "▶  Run All Images", null,
                () => runAllZipImages(this)
            );

            // ── 4. Status text (read-only) ───────────────────────────────
            this._ygZipStatus = this.addWidget(
                "text", "_yg_zip_status", "No ZIP uploaded yet", null,
                { serialize: false }
            );
            this._ygZipStatus.disabled = true;

            // ── 5. Progress bar (DOM widget) ─────────────────────────────
            const progressContainer = document.createElement("div");
            progressContainer.style.cssText = `
                padding: 6px 8px 8px;
                width: 100%;
                box-sizing: border-box;
            `;

            // Label
            const progLabel = document.createElement("div");
            progLabel.style.cssText = `
                font-size: 11px; color: #aaa; margin-bottom: 4px;
                font-family: monospace; letter-spacing: 0.5px;
            `;
            progLabel.textContent = "No ZIP loaded";

            // Bar background
            const barBg = document.createElement("div");
            barBg.style.cssText = `
                width: 100%; height: 10px; background: #2a2a2a;
                border-radius: 5px; overflow: hidden;
                border: 1px solid #444;
            `;

            // Bar fill
            const barFill = document.createElement("div");
            barFill.style.cssText = `
                height: 100%; width: 0%; background: linear-gradient(90deg, #27ae60, #2ecc71);
                border-radius: 5px;
                transition: width 0.4s ease;
            `;

            barBg.appendChild(barFill);
            progressContainer.appendChild(progLabel);
            progressContainer.appendChild(barBg);

            this.addDOMWidget("_yg_zip_progress", "div", progressContainer, {
                serialize: false,
                hideOnZoom: false,
            });

            this._ygProgressBar   = barFill;
            this._ygProgressLabel = progLabel;

            // ── 6. Folder info DOM widget ─────────────────────────────────
            const folderContainer = document.createElement("div");
            folderContainer.style.cssText = `
                padding: 4px 8px 8px;
                width: 100%;
                box-sizing: border-box;
            `;
            folderContainer.innerHTML = `
                <div style="
                    font-size: 11px; color: #888;
                    background: #1c1c1c; border-radius: 6px;
                    padding: 8px 10px; min-height: 32px;
                    border: 1px solid #333; line-height: 1.6;
                " id="yg-zip-folder-info-${this.id}">
                    Upload a ZIP to see folder structure
                </div>
            `;
            this.addDOMWidget("_yg_zip_folders", "div", folderContainer, {
                serialize: false, hideOnZoom: false,
            });
            this._ygFolderInfo = folderContainer.querySelector(`#yg-zip-folder-info-${this.id}`);

            if (!this.size || (this.size[0] < 300 && this.size[1] < 300)) {
                this.setSize([400, 380]);
            }

            // On load, restore status from server if job still exists
            setTimeout(async () => {
                try {
                    const jobId = getJobId(this);
                    const resp  = await fetch(`/yg/zip_job_info?job_id=${encodeURIComponent(jobId)}`);
                    const info  = await resp.json();
                    if (info.total > 0) {
                        updateProgress(this, info.index, info.total);
                        if (this._ygZipStatus) {
                            this._ygZipStatus.value = `✅ ${info.total} images loaded (job: "${jobId}")`;
                        }
                        if (this._ygFolderInfo && info.folders?.length) {
                            this._ygFolderInfo.innerHTML =
                                `<b style="color:#aaa">📁 Folders:</b><br>` +
                                info.folders.map(f => `&nbsp;• ${f || "(root)"}`).join("<br>");
                        }
                    }
                } catch (_) {}
            }, 800);
        };
    },
});

// ── YG ZIP Image Saver extension ───────────────────────────────────────────────

app.registerExtension({
    name: "YG.ZipImageSaver",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGZipImageSaver") return;

        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            orig?.apply(this, arguments);

            // ── 1. Create ZIP Now button (manual trigger for interrupted runs) ──
            this._ygCreateZipBtn = this.addWidget(
                "button", "🗜️  Create ZIP Now", null,
                () => createZipNow(this)
            );

            // ── 2. Download button (starts inactive, activates when ZIP is ready) ──
            this._ygDownloadBtn = this.addWidget(
                "button",
                "⬇  Download ZIP  (waiting…)",
                null,
                () => {
                    if (!this._ygZipDownloadReady) {
                        showToast("⏳ ZIP not ready yet.\nRun all images first via the Loader node.", "#e67e22", 4000);
                        return;
                    }
                    const jobId = this._ygZipJobId || getJobId(this);
                    const url   = `/yg/zip_download?job_id=${encodeURIComponent(jobId)}`;

                    // Trigger browser file download
                    const a    = document.createElement("a");
                    a.href     = url;
                    a.download = this._ygZipFilename || `${jobId}_bg_removed.zip`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    showToast(`⬇ Downloading ${a.download}…`, "#3498db", 5000);
                }
            );

            // ── Status indicator (DOM) ────────────────────────────────────
            const statusContainer = document.createElement("div");
            statusContainer.style.cssText = `
                padding: 6px 8px 10px;
                width: 100%; box-sizing: border-box;
            `;

            const statusBox = document.createElement("div");
            statusBox.style.cssText = `
                font-size: 12px; color: #888;
                background: #1c1c1c; border-radius: 8px;
                padding: 10px 12px;
                border: 1px solid #333;
                text-align: center; line-height: 1.6;
                min-height: 40px;
            `;
            statusBox.innerHTML = `
                ⏳ Waiting for images…<br>
                <span style="font-size:10px;color:#555">
                    Connect YG ZIP Loader → BG Remove → this node
                </span>
            `;
            statusContainer.appendChild(statusBox);

            this.addDOMWidget("_yg_zip_saver_status", "div", statusContainer, {
                serialize: false, hideOnZoom: false,
            });
            this._ygSaverStatusBox = statusBox;

            if (!this.size || (this.size[0] < 280 && this.size[1] < 200)) {
                this.setSize([360, 220]);
            }

            // On load: check if ZIP is already ready (ComfyUI restart survival)
            setTimeout(async () => {
                try {
                    const jobId = getJobId(this);
                    const resp  = await fetch(`/yg/zip_output_status?job_id=${encodeURIComponent(jobId)}`);
                    const data  = await resp.json();
                    if (data.ready) {
                        activateDownloadButton(this, jobId, data.filename, "?");
                        if (this._ygSaverStatusBox) {
                            this._ygSaverStatusBox.innerHTML = `
                                ✅ ZIP ready: <b style="color:#2ecc71">${data.filename}</b><br>
                                <span style="font-size:10px;color:#888">Click Download button above</span>
                            `;
                        }
                    }
                } catch (_) {}
            }, 900);
        };
    },
});

// ── YG Local ZIP Image Loader extension ───────────────────────────────────────

app.registerExtension({
    name: "YG.LocalZipImageLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGLocalZipImageLoader") return;

        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            orig?.apply(this, arguments);

            // ── 1. Extract Selected ZIP button ───────────────────────────
            this._ygUploadBtn = this.addWidget("button", "📦  Extract Selected ZIP", null, async () => {
                const jobId = getJobId(this);
                const zipFile = this.widgets?.find(w => w.name === "zip_file")?.value;
                if (!zipFile) {
                    showToast("⚠️ No ZIP file selected.", "#e67e22");
                    return;
                }

                const sw = this._ygZipStatus;
                if (this._ygUploadBtn) { this._ygUploadBtn.name = "⏳ Extracting…"; app.graph.setDirtyCanvas(true); }
                if (sw) { sw.value = `Requesting extraction of ${zipFile}…`; }

                try {
                    const resp = await fetch("/yg/local_zip_extract", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ job_id: jobId, zip_file: zipFile }),
                    });
                    const data = await resp.json();

                    if (data.status === "extracting") {
                        showToast(`📦 Extraction started in background...`, "#3498db");
                    } else {
                        throw new Error(data.message || "Failed to trigger extraction");
                    }
                } catch (err) {
                    if (sw) { sw.value = `❌ Extract failed: ${err.message}`; }
                    showToast(`❌ Extract failed: ${err.message}`, "#e74c3c");
                    if (this._ygUploadBtn) { this._ygUploadBtn.name = "📦  Extract Selected ZIP"; app.graph.setDirtyCanvas(true); }
                }
            });

            // ── 2. Reset button ──────────────────────────────────────────
            this.addWidget("button", "🔄  Reset to Image 1", null, async () => {
                const jobId = getJobId(this);
                await fetch("/yg/zip_reset", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ job_id: jobId }),
                });
                updateProgress(this, 0, null);
                const resp = await fetch(`/yg/zip_job_info?job_id=${encodeURIComponent(jobId)}`);
                const info = await resp.json();
                updateProgress(this, 0, info.total ?? 0);
                showToast(`🔄 Job "${jobId}" reset to image 1`, "#3498db", 3000);
            });

            // ── 3. Run All button ────────────────────────────────────────
            this._ygRunAllBtn = this.addWidget(
                "button", "▶  Run All Images", null,
                () => runAllZipImages(this)
            );

            // ── 4. Status text (read-only) ───────────────────────────────
            this._ygZipStatus = this.addWidget(
                "text", "_yg_zip_status", "No ZIP extracted yet", null,
                { serialize: false }
            );
            this._ygZipStatus.disabled = true;

            // ── 5. Progress bar (DOM widget) ─────────────────────────────
            const progressContainer = document.createElement("div");
            progressContainer.style.cssText = `
                padding: 6px 8px 8px;
                width: 100%;
                box-sizing: border-box;
            `;

            const progLabel = document.createElement("div");
            progLabel.style.cssText = `
                font-size: 11px; color: #aaa; margin-bottom: 4px;
                font-family: monospace; letter-spacing: 0.5px;
            `;
            progLabel.textContent = "No ZIP loaded";

            const barBg = document.createElement("div");
            barBg.style.cssText = `
                width: 100%; height: 10px; background: #2a2a2a;
                border-radius: 5px; overflow: hidden;
                border: 1px solid #444;
            `;

            const barFill = document.createElement("div");
            barFill.style.cssText = `
                height: 100%; width: 0%; background: linear-gradient(90deg, #27ae60, #2ecc71);
                border-radius: 5px;
                transition: width 0.4s ease;
            `;

            barBg.appendChild(barFill);
            progressContainer.appendChild(progLabel);
            progressContainer.appendChild(barBg);

            this.addDOMWidget("_yg_zip_progress", "div", progressContainer, {
                serialize: false, hideOnZoom: false,
            });

            this._ygProgressBar   = barFill;
            this._ygProgressLabel = progLabel;

            // ── 6. Folder info DOM widget ─────────────────────────────────
            const folderContainer = document.createElement("div");
            folderContainer.style.cssText = `
                padding: 4px 8px 8px;
                width: 100%; box-sizing: border-box;
            `;
            folderContainer.innerHTML = `
                <div style="
                    font-size: 11px; color: #888;
                    background: #1c1c1c; border-radius: 6px;
                    padding: 8px 10px; min-height: 32px;
                    border: 1px solid #333; line-height: 1.6;
                " id="yg-zip-folder-info-${this.id}">
                    Select a ZIP and click Extract
                </div>
            `;
            this.addDOMWidget("_yg_zip_folders", "div", folderContainer, {
                serialize: false, hideOnZoom: false,
            });
            this._ygFolderInfo = folderContainer.querySelector(`#yg-zip-folder-info-${this.id}`);

            if (!this.size || (this.size[0] < 300 && this.size[1] < 300)) {
                this.setSize([400, 380]);
            }

            // On load restore status
            setTimeout(async () => {
                try {
                    const jobId = getJobId(this);
                    const resp  = await fetch(`/yg/zip_job_info?job_id=${encodeURIComponent(jobId)}`);
                    const info  = await resp.json();
                    if (info.total > 0) {
                        updateProgress(this, info.index, info.total);
                        if (this._ygZipStatus) {
                            this._ygZipStatus.value = `✅ ${info.total} images loaded (job: "${jobId}")`;
                        }
                        if (this._ygFolderInfo && info.folders?.length) {
                            this._ygFolderInfo.innerHTML =
                                `<b style="color:#aaa">📁 Folders:</b><br>` +
                                info.folders.map(f => `&nbsp;• ${f || "(root)"}`).join("<br>");
                        }
                    }
                } catch (_) {}
            }, 800);
        };
    },
});


// ── YG Direct Image Zipper ──────────────────────────────────────────────────────

app.registerExtension({
    name: "YG.DirectImageZipper",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGDirectImageZipper") return;

        // Wrap onNodeCreated if it exists, otherwise create it
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (orig) orig.apply(this, arguments);

            let _downloadReady = false;
            let _zipJobId = null;
            let _zipFilename = null;
            const self = this;

            // Listen for ZIP ready event from server
            const onZipReady = (e) => {
                if (e.detail?.job_id) {
                    _zipJobId = e.detail.job_id;
                    _zipFilename = e.detail.filename;
                    _downloadReady = true;

                    if (self._ygDownloadBtn) {
                        self._ygDownloadBtn.name = `⬇  Download ZIP  (${e.detail.total} images)`;
                    }

                    if (self._ygStatusBox) {
                        self._ygStatusBox.innerHTML = `
                            ✅ ZIP Ready!<br>
                            <span style="font-size:10px;color:#0f0">${_zipFilename}</span>
                        `;
                    }

                    showToast(`✅ ZIP created! ${e.detail.total} images\nClick "⬇ Download ZIP" to save.`, "#27ae60", 10000);
                }
            };

            api.addEventListener("yg_zip_ready", onZipReady);

            // ── Download button ──────────────────────────────────────────────
            self._ygDownloadBtn = self.addWidget(
                "button",
                "⬇  Download ZIP  (waiting…)",
                null,
                () => {
                    if (!_downloadReady || !_zipJobId) {
                        showToast("⏳ ZIP not ready yet.\nRun the node first.", "#e67e22", 4000);
                        return;
                    }

                    const url = `/yg/direct_zip_download?job_id=${encodeURIComponent(_zipJobId)}`;

                    // Trigger browser file download
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = _zipFilename || "images.zip";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    showToast(`⬇ Downloading ${a.download}…`, "#3498db", 5000);
                }
            );

            // ── Status indicator (DOM) ───────────────────────────────────────
            const statusContainer = document.createElement("div");
            statusContainer.style.cssText = `
                padding: 6px 8px 10px;
                width: 100%; box-sizing: border-box;
            `;

            const statusBox = document.createElement("div");
            statusBox.style.cssText = `
                font-size: 12px; color: #888;
                background: #1c1c1c; border-radius: 8px;
                padding: 10px 12px;
                border: 1px solid #333;
                text-align: center; line-height: 1.6;
                min-height: 40px;
            `;
            statusBox.innerHTML = `
                ⏳ Waiting…<br>
                <span style="font-size:10px;color:#555">Run the workflow to create ZIP</span>
            `;
            statusContainer.appendChild(statusBox);

            self._ygStatusBox = statusBox;
            self.addDOMWidget("_yg_direct_zipper_status", "div", statusContainer, {
                serialize: false,
                hideOnZoom: false,
            });

            console.log("✅ YG Direct Image Zipper UI initialized");
        };
    },
});
