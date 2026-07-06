"""
Z Prompt List By Category - one multiline text box with Catagiry_XX /
Category_XX header lines. Emits the whole list in one workflow
execution using ComfyUI's OUTPUT_IS_LIST mechanism so downstream nodes
(CLIP Text Encode, KSampler, VAE Decode, Save) run once per item
without reloading the diffusion / text-encoder models between items.
"""

import re


_HEADER_RE = re.compile(
    r'^\s*\[(.+?)\]\s*$',
    re.IGNORECASE,
)


class YGPromptListByCategory:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "[animals]\napple\nbanana\n\n[food]\nmango\ngrapes\n",
                    "multiline": True,
                    "placeholder": "[category_name]\nitem\nitem\n\n[another_category]\nitem\nitem",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("prompt", "category", "index", "total")
    # Every output is a list — ComfyUI will loop downstream nodes once
    # per element, keeping heavy models (diffusion, text encoder) loaded
    # across iterations.
    OUTPUT_IS_LIST = (True, True, True, True)
    FUNCTION = "emit_list"
    CATEGORY = "YG/IO"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-emit so each queue press runs the full list again.
        return float("NaN")

    def emit_list(self, text):
        flat = self._parse(text)
        if not flat:
            print("[YGPromptListByCategory] no items found")
            return ([""], ["uncategorized"], [0], [0])

        prompts = [p for _, p in flat]
        categories = [c for c, _ in flat]
        indices = list(range(len(flat)))
        total = len(flat)
        totals = [total] * total

        print(f"[YGPromptListByCategory] emitting batch of {total} item(s)")
        for i, (c, p) in enumerate(flat, 1):
            print(f"  [{i}/{total}] {c} :: {p}")
        return (prompts, categories, indices, totals)

    @staticmethod
    def _parse(text):
        """Return a flat list of (category, item) pairs in the order the user typed them."""
        flat = []
        current = "uncategorized"
        for raw in (text or "").splitlines():
            line = raw.strip()
            if not line:
                continue
            match = _HEADER_RE.match(line)
            if match:
                current = match.group(1).strip()
                continue
            flat.append((current, line))
        return flat
