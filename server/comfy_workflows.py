"""ComfyUI workflows (API format) built from the templates the project uses.

Each builder returns (prompt, output_node_id). Model file names come from config.json ("comfyui" section) so a
different checkpoint only needs a config change.
"""
from __future__ import annotations

import random
from typing import Callable

DEFAULT_SEEDVR2 = {
    "unet": "seedvr2_7b_int8_convrot.safetensors",
    "vae": "seedvr2_ema_vae_fp16.safetensors",
    "steps": 1,
    "color_correction": "lab",    # lab (closest to the original) / wavelet / adain / none
    "tile": 512,
}
DEFAULT_PID = {
    "unet": "pid_flux1_1024_to_4096_4step_bf16.safetensors",
    "clip": "gemma_2_2b_it_elm_fp8_scaled.safetensors",
    "vae": "ae.safetensors",
    "latent_long": 1024,          # the picture is resized to this long edge, the result is 4x that
    "latent_format": "flux",
}


def _seed() -> int:
    return random.randint(1, 2**48)


def seedvr2_upscale(image: str, src_w: int, src_h: int, target_long: int, cfg: dict, prompt: str = "") -> tuple[dict, str]:
    """SeedVR2 7B (utility_seedvr2_7b_int8_upscale_image): resize by a multiplier, one diffusion step, tiled VAE."""
    c = {**DEFAULT_SEEDVR2, **cfg}
    mult = round(min(8.0, max(1.0, target_long / max(src_w, src_h))), 3)
    tile = int(c["tile"])
    p = {
        "1": {"class_type": "LoadImage", "inputs": {"image": image}},
        "2": {"class_type": "JoinImageWithAlpha", "inputs": {"image": ["1", 0], "alpha": ["1", 1]}},
        "10": {"class_type": "ResizeImageMaskNode", "inputs": {
            "input": ["2", 0], "resize_type": "scale by multiplier", "resize_type.multiplier": mult, "scale_method": "lanczos"}},
        "11": {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": ["10", 0]}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": c["vae"]}},
        "13": {"class_type": "UNETLoader", "inputs": {"unet_name": c["unet"], "weight_dtype": "default"}},
        "14": {"class_type": "VAEEncodeTiled", "inputs": {
            "pixels": ["11", 0], "vae": ["12", 0], "tile_size": tile, "overlap": 128, "temporal_size": 4096, "temporal_overlap": 8}},
        "15": {"class_type": "SeedVR2Conditioning", "inputs": {"model": ["13", 0], "vae_conditioning": ["14", 0]}},
        "16": {"class_type": "KSampler", "inputs": {
            "model": ["13", 0], "positive": ["15", 0], "negative": ["15", 1], "latent_image": ["14", 0],
            "seed": _seed(), "steps": int(c["steps"]), "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1}},
        "17": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["16", 0], "vae": ["12", 0], "tile_size": tile, "overlap": 128, "temporal_size": 4096, "temporal_overlap": 8}},
        "18": {"class_type": "SeedVR2PostProcessing", "inputs": {
            "images": ["17", 0], "original_resized_images": ["10", 0], "color_correction_method": c["color_correction"]}},
        "19": {"class_type": "SaveImage", "inputs": {"images": ["18", 0], "filename_prefix": "terryflow/upscale"}},
    }
    return p, "19"


def pid_upscale(image: str, src_w: int, src_h: int, target_long: int, cfg: dict, prompt: str = "") -> tuple[dict, str]:
    """PiD (utility_pid_latent_upscale_dit): encode the picture to a Flux latent, decode it 4x larger in 4 steps."""
    c = {**DEFAULT_PID, **cfg}
    long_px = int(c["latent_long"])
    k = long_px / max(src_w, src_h)
    w = max(64, round(src_w * k / 16) * 16)
    h = max(64, round(src_h * k / 16) * 16)
    p = {
        "1": {"class_type": "LoadImage", "inputs": {"image": image}},
        "2": {"class_type": "ImageScale", "inputs": {"image": ["1", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "disabled"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": c["vae"]}},
        "4": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0], "vae": ["3", 0]}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": c["clip"], "type": "pixeldit", "device": "default"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 0], "text": prompt or ""}},
        "7": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["6", 0]}},
        "8": {"class_type": "PiDConditioning", "inputs": {
            "positive": ["6", 0], "latent": ["4", 0], "latent_format": c["latent_format"], "degrade_sigma": 0}},
        "9": {"class_type": "UNETLoader", "inputs": {"unet_name": c["unet"], "weight_dtype": "default"}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "lcm"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["9", 0], "scheduler": "simple", "steps": 4, "denoise": 1}},
        "12": {"class_type": "EmptyChromaRadianceLatentImage", "inputs": {"width": w * 4, "height": h * 4, "batch_size": 1}},
        "13": {"class_type": "SamplerCustom", "inputs": {
            "model": ["9", 0], "add_noise": True, "noise_seed": _seed(), "cfg": 1, "positive": ["8", 0], "negative": ["7", 0],
            "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["12", 0]}},
        "14": {"class_type": "VAELoader", "inputs": {"vae_name": "pixel_space"}},
        "15": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["14", 0]}},
        "16": {"class_type": "SaveImage", "inputs": {"images": ["15", 0], "filename_prefix": "terryflow/upscale"}},
    }
    return p, "16"


# name shown in the console -> builder
UPSCALERS: dict[str, tuple[str, Callable]] = {
    "seedvr2": ("SeedVR2 7B（任意倍数，细节强）", seedvr2_upscale),
    "pid": ("PiD（固定 4 倍，速度快）", pid_upscale),
}
