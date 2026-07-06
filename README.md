# ComfyUI YG Nodes

A collection of utility custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — image cycling, ZIP-based image loading/saving, video collection, and VRAM cleanup.

## Nodes

| Node | Description |
|------|-------------|
| **YG Auto Image Cycler** | Cycles through images in a folder automatically across queue runs. |
| **YG Video Collector** | Collects generated videos into a gallery folder. |
| **YG Clean VRAM** | Frees VRAM/RAM using ComfyUI's `/free` API. Optionally cleans multiple local ComfyUI instances at once. |
| **YG ZIP Image Loader** | Loads images directly from an uploaded ZIP file. |
| **YG Local ZIP Image Loader** | Loads images from a ZIP file on local disk. |
| **YG ZIP Image Saver** | Saves output images into a ZIP archive. |
| **YG Direct Image Zipper** | Zips images directly from the workflow output. |
| **YG Prompt List By Category** | Provides prompt lists organized by category. |
| **YG Download Images By Category** | Saves/downloads all images grouped by category. |

Includes web extensions (drag-drop UI, gallery thumbnails, batch-complete notifications) in the `web/` folder.

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/mallikarjunaraokoliparthi/comfyui_yg_nodes.git
```

Restart ComfyUI. No extra Python dependencies are required.

## Notes on YG Clean VRAM

- By default it calls ComfyUI's built-in `/free` endpoint on `127.0.0.1` — your own machine only.
- The **dashboard integration is optional**: it is meant for setups running a custom server-status dashboard. If you don't have one, leave the dashboard URL/token empty and the node will clean local ComfyUI ports directly.
- Configurable via environment variables: `YG_DASHBOARD_URL`, `YG_DASHBOARD_TOKEN`, `YG_CLEAN_PORTS`.

## License

MIT
