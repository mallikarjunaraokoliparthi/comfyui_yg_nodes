# YG Custom Nodes - Shared across all ComfyUI instances via symlink
#
# Active nodes (6): YG Auto Image Cycler, YG Video Collector, YG Clean VRAM,
#                   YG ZIP Image Loader, YG ZIP Image Saver, YG Direct Image Zipper
# Older nodes (Bulk Image Loader, Prompt Router, Video Gallery) are kept on
# disk but no longer registered — re-add to the mappings below to enable.

from .yg_clean_vram        import YGCleanVRAM
from .yg_auto_image_cycler import YGAutoImageCycler
from .yg_video_collector   import YGVideoCollector
from .yg_zip_image_loader  import YGZipImageLoader
from .yg_local_zip_loader  import YGLocalZipImageLoader
from .yg_zip_image_saver   import YGZipImageSaver
from .yg_direct_image_zipper import YGDirectImageZipper

# Category pack (merged from ZCategoryPack so it loads on all instances)
from .category_prompt_list_node import YGPromptListByCategory
from .save_all_images_node      import YGSaveAllImages

NODE_CLASS_MAPPINGS = {
    "YGAutoImageCycler":  YGAutoImageCycler,
    "YGVideoCollector":   YGVideoCollector,
    "YGCleanVRAM":        YGCleanVRAM,
    "YGZipImageLoader":   YGZipImageLoader,
    "YGLocalZipImageLoader": YGLocalZipImageLoader,
    "YGZipImageSaver":    YGZipImageSaver,
    "YGDirectImageZipper": YGDirectImageZipper,
    "YGPromptListByCategory": YGPromptListByCategory,
    "YGSaveAllImages":        YGSaveAllImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "YGAutoImageCycler":  "YG Auto Image Cycler",
    "YGVideoCollector":   "YG Video Collector",
    "YGCleanVRAM":        "YG Clean VRAM",
    "YGZipImageLoader":   "YG ZIP Image Loader",
    "YGLocalZipImageLoader": "YG Local ZIP Image Loader",
    "YGZipImageSaver":    "YG ZIP Image Saver",
    "YGDirectImageZipper": "YG Direct Image Zipper",
    "YGPromptListByCategory": "YG Prompt List By Category",
    "YGSaveAllImages":        "YG Download Images By Category",
}

# JS drag-drop UI, gallery thumbnails, batch-complete notifications
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
