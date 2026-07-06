import { app } from "/scripts/app.js";

const HEADER_RE = /^\s*\[(.+?)\]\s*$/i;

function countItems(text) {
    let n = 0;
    for (const raw of (text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (HEADER_RE.test(line)) continue;
        n++;
    }
    return n;
}

app.registerExtension({
    name: "YG.PromptListByCategory.Buttons",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "YGPromptListByCategory") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;

            const getWidget = (name) => this.widgets.find(w => w.name === name);

            this.addWidget("button", "▶ Run All", null, async () => {
                const textWidget = getWidget("text");
                const total = countItems(textWidget?.value || "");
                if (total < 1) {
                    alert("No items found in the list.");
                    return;
                }

                const saveNodes = (app.graph?._nodes || []).filter(n => n.type === "YGSaveAllImages");
                for (const n of saveNodes) {
                    const folder = n.widgets?.find(w => w.name === "output_folder")?.value?.trim();
                    if (!folder) continue;
                    try {
                        const resp = await fetch("/yg_save_all_images/reset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ folder }),
                        });
                        if (!resp.ok) {
                            const msg = await resp.text();
                            console.warn("[YGPromptListByCategory] reset failed:", msg);
                        }
                    } catch (e) {
                        console.warn("[YGPromptListByCategory] reset error:", e);
                    }
                }

                // List-output mode: one queued execution iterates over all items
                // internally, so we only need to queue once (not `total` times).
                try {
                    await app.queuePrompt(0, 1);
                } catch (e) {
                    alert("Queue failed: " + e.message);
                }
            });

            this.addWidget("button", "Count Items", null, () => {
                const textWidget = getWidget("text");
                const total = countItems(textWidget?.value || "");
                alert(`Total items: ${total}\n(Set queue Run count to ${total})`);
            });

            return r;
        };
    },
});
