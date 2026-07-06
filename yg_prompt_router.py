class YGPromptRouter:
    """
    Routes the correct prompt to each image based on current_index.

    Modes:
      Single Prompt  — one prompt used for ALL images
      Per Image      — one prompt per line; line N → image N (cycles if fewer prompts)
      Grouped        — set group_size; every N images share one prompt
                       e.g. group_size=10 → images 1-10 use prompt 1,
                                            images 11-20 use prompt 2, etc.

    Connect current_index from YG Bulk Image Loader.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["Single Prompt", "Per Image", "Grouped"],),
                "prompts": ("STRING", {
                    "multiline": True,
                    "default": (
                        "a cinematic scene, motion blur, professional lighting\n"
                        "slow motion close-up, shallow depth of field\n"
                        "aerial drone shot, wide angle, golden hour"
                    ),
                    "tooltip": (
                        "Single Prompt: only first line is used.\n"
                        "Per Image: one line per image (cycles if fewer lines than images).\n"
                        "Grouped: one line per group of images (set group_size below)."
                    ),
                }),
                "group_size": ("INT", {
                    "default": 10,
                    "min": 1,
                    "max": 1000,
                    "tooltip": "Only used in Grouped mode. How many images share each prompt."
                }),
                "current_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 99999,
                    "forceInput": True,
                    "tooltip": "Connect to current_index output of YG Bulk Image Loader."
                }),
            }
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("prompt", "prompt_index")
    FUNCTION = "route_prompt"
    CATEGORY = "YG Custom Nodes"

    def route_prompt(self, mode, prompts, group_size, current_index):
        lines = [line.strip() for line in prompts.splitlines() if line.strip()]

        if not lines:
            return ("", 0)

        if mode == "Single Prompt":
            return (lines[0], 0)

        elif mode == "Per Image":
            prompt_idx = current_index % len(lines)
            return (lines[prompt_idx], prompt_idx)

        else:  # Grouped
            group_idx = current_index // max(group_size, 1)
            prompt_idx = group_idx % len(lines)
            return (lines[prompt_idx], prompt_idx)
