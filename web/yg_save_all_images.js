import { app } from "/scripts/app.js";

app.registerExtension({
    name: "YG.SaveAllImages.Buttons",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGSaveAllImages") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            const getWidget = (name) => this.widgets.find(w => w.name === name);

            // Add download button - hidden until workflow runs
            const downloadBtn = this.addWidget("button", "⬇ Download Images", null, async () => {
                const folder  = getWidget("output_folder")?.value?.trim();
                const zipName = getWidget("zip_filename")?.value?.trim() || "all_images.zip";
                if (!folder) { alert("output_folder is empty."); return; }

                const url = `/yg_save_all_images/download?folder=${encodeURIComponent(folder)}&zip=${encodeURIComponent(zipName)}`;
                try {
                    const resp = await fetch(url);
                    if (!resp.ok) { alert("Download failed:\n\n" + await resp.text()); return; }
                    const blob = await resp.blob();
                    const a    = document.createElement("a");
                    a.href     = URL.createObjectURL(blob);
                    a.download = zipName.toLowerCase().endsWith(".zip") ? zipName : zipName + ".zip";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                } catch (err) {
                    alert("Download error:\n\n" + err);
                }
            });

            // Hide button until the node has executed at least once
            downloadBtn.disabled = true;
            downloadBtn.hidden   = true;
            const origLabel = downloadBtn.name;

            const onExecuted = this.onExecuted;
            this.onExecuted = function (message) {
                downloadBtn.disabled = false;
                downloadBtn.hidden   = false;
                if (onExecuted) onExecuted.apply(this, arguments);
            };

            return r;
        };
    },
});
