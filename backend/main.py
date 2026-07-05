"""
main.py

API do editor de efeito binario. Roda local:
  uvicorn main:app --reload --port 8000

Endpoints:
  POST  /api/videos                            -> upload de video
  POST  /api/videos/{id}/segment                -> extrai frames do trecho [start,end]
  POST  /api/videos/{id}/masks                   -> gera mascaras (IA ou fallback) pro trecho
  PUT   /api/videos/{id}/masks/{frame_index}     -> sobrescreve uma mascara (edicao manual)
  GET   /api/videos/{id}/preview/{frame_index}   -> PNG do frame renderizado com os parametros atuais
  POST  /api/videos/{id}/export                  -> monta o video final (partes normais + trecho com efeito)
  GET   /storage/...                             -> arquivos estaticos (frames, mascaras, videos)
"""

import io
import json
import math
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from segmentation import segment_frames
from render import RainRenderer

STORAGE = Path(__file__).parent / "storage"
STORAGE.mkdir(exist_ok=True)

app = FastAPI(title="ascii-binary-tool")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/storage", StaticFiles(directory=str(STORAGE)), name="storage")


def video_dir(video_id: str) -> Path:
    d = STORAGE / video_id
    if not d.exists():
        raise HTTPException(404, "video nao encontrado")
    return d


# ---------------------------------------------------------------- upload

@app.post("/api/videos")
async def upload_video(file: UploadFile = File(...)):
    video_id = uuid.uuid4().hex[:12]
    d = STORAGE / video_id
    d.mkdir(parents=True)
    src_path = d / "original.mp4"

    with open(src_path, "wb") as f:
        f.write(await file.read())

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration",
         "-of", "json", str(src_path)],
        capture_output=True, text=True,
    )
    info = json.loads(probe.stdout)
    streams = info.get("streams", [{}])
    fmt = info.get("format", {})
    width = streams[0].get("width")
    height = streams[0].get("height")
    fr = streams[0].get("r_frame_rate", "30/1")
    num, den = fr.split("/")
    fps = float(num) / float(den)
    duration = float(fmt.get("duration", 0))

    meta = {"width": width, "height": height, "fps": fps, "duration": duration}
    (d / "meta.json").write_text(json.dumps(meta))

    return {"video_id": video_id, **meta}


# ---------------------------------------------------------------- segment (extrai frames do trecho)

class SegmentRequest(BaseModel):
    start: Optional[float] = None
    end: Optional[float] = None
    segments: Optional[list[dict[str, float]]] = None


def _normalize_segments(req: SegmentRequest, duration: float) -> list[dict[str, float]]:
    raw_segments = req.segments if req.segments else [{"start": req.start, "end": req.end}]
    segments = []
    for raw in raw_segments:
        start = raw.get("start")
        end = raw.get("end")
        if start is None or end is None:
            raise HTTPException(400, "inicio/fim do trecho sao obrigatorios")
        start = float(start)
        end = float(end)
        if start < 0 or end <= start or end > duration:
            raise HTTPException(400, "trecho invalido")
        segments.append({"start": start, "end": end})
    segments.sort(key=lambda s: s["start"])
    for prev, cur in zip(segments, segments[1:]):
        if cur["start"] < prev["end"]:
            raise HTTPException(400, "trechos nao podem se sobrepor")
    return segments


def _extract_segments_to_frames(d: Path, meta: dict[str, Any],
                                segments: list[dict[str, float]]) -> dict[str, Any]:
    frames_dir = d / "frames"
    frames_dir.mkdir(exist_ok=True)
    for f in frames_dir.glob("*.png"):
        f.unlink()

    frame_count = 0
    normalized = []
    temp_root = d / "segment_frames"
    if temp_root.exists():
        shutil.rmtree(temp_root)
    temp_root.mkdir(exist_ok=True)

    for seg_idx, seg in enumerate(segments, start=1):
        temp_dir = temp_root / f"s_{seg_idx:02d}"
        temp_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y",
            "-ss", str(seg["start"]), "-i", str(d / "original.mp4"),
            "-t", str(seg["end"] - seg["start"]),
            str(temp_dir / "f_%03d.png"),
        ], check=True, capture_output=True)

        extracted = sorted(temp_dir.glob("*.png"))
        first_frame = frame_count + 1
        for src in extracted:
            frame_count += 1
            shutil.copyfile(src, frames_dir / f"f_{frame_count:03d}.png")
        normalized.append({
            "start": seg["start"],
            "end": seg["end"],
            "first_frame": first_frame,
            "frame_count": len(extracted),
        })

    meta["segments"] = normalized
    meta["segment_start"] = normalized[0]["start"]
    meta["segment_end"] = normalized[-1]["end"]
    (d / "meta.json").write_text(json.dumps(meta))

    return {"frame_count": frame_count,
            "segments": normalized}


@app.post("/api/videos/{video_id}/segment")
def extract_segment(video_id: str, req: SegmentRequest):
    d = video_dir(video_id)
    meta = json.loads((d / "meta.json").read_text())
    segments = _normalize_segments(req, float(meta.get("duration", 0)))
    result = _extract_segments_to_frames(d, meta, segments)

    return {"frame_count": result["frame_count"],
            "frame_urls": [f"/storage/{video_id}/frames/f_{i+1:03d}.png" for i in range(result["frame_count"])]}


# ---------------------------------------------------------------- masks (geracao automatica)

@app.post("/api/videos/{video_id}/masks")
def generate_masks(video_id: str):
    d = video_dir(video_id)
    frames_dir = d / "frames"
    masks_dir = d / "masks"
    masks_dir.mkdir(exist_ok=True)

    frame_paths = sorted(frames_dir.glob("*.png"))
    if not frame_paths:
        raise HTTPException(400, "extraia o trecho (/segment) antes de gerar mascaras")

    frames = [cv2.imread(str(p)) for p in frame_paths]
    masks = segment_frames(frames)

    for i, m in enumerate(masks):
        cv2.imwrite(str(masks_dir / f"f_{i+1:03d}.png"), m)

    return {"mask_urls": [f"/storage/{video_id}/masks/f_{i+1:03d}.png" for i in range(len(masks))]}


# ---------------------------------------------------------------- edicao manual de uma mascara

class MaskCopyRequest(BaseModel):
    source_frame: int
    target: str = "next"  # next | previous | forward | backward | all

@app.put("/api/videos/{video_id}/masks/{frame_index}")
async def update_mask(video_id: str, frame_index: int, file: UploadFile = File(...)):
    d = video_dir(video_id)
    masks_dir = d / "masks"
    masks_dir.mkdir(exist_ok=True)
    out_path = masks_dir / f"f_{frame_index:03d}.png"
    with open(out_path, "wb") as f:
        f.write(await file.read())
    return {"ok": True}


@app.post("/api/videos/{video_id}/masks/copy")
def copy_mask(video_id: str, req: MaskCopyRequest):
    d = video_dir(video_id)
    masks_dir = d / "masks"
    source = masks_dir / f"f_{req.source_frame:03d}.png"
    if not source.exists():
        raise HTTPException(404, "mascara de origem nao encontrada")

    mask_paths = sorted(masks_dir.glob("f_*.png"))
    total = len(mask_paths)
    if total == 0:
        raise HTTPException(400, "gere as mascaras antes de propagar")
    if req.source_frame < 1 or req.source_frame > total:
        raise HTTPException(400, "frame de origem fora do trecho")

    if req.target == "next":
        targets = [req.source_frame + 1] if req.source_frame < total else []
    elif req.target == "previous":
        targets = [req.source_frame - 1] if req.source_frame > 1 else []
    elif req.target == "forward":
        targets = list(range(req.source_frame + 1, total + 1))
    elif req.target == "backward":
        targets = list(range(1, req.source_frame))
    elif req.target == "all":
        targets = [i for i in range(1, total + 1) if i != req.source_frame]
    else:
        raise HTTPException(400, "destino invalido")

    for frame_index in targets:
        shutil.copyfile(source, masks_dir / f"f_{frame_index:03d}.png")

    return {"ok": True, "updated_frames": targets}


@app.post("/api/videos/{video_id}/background")
async def upload_background(video_id: str, file: UploadFile = File(...)):
    d = video_dir(video_id)
    data = await file.read()
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "imagem de fundo invalida")
    cv2.imwrite(str(d / "background.png"), img)
    return {"ok": True, "background_url": f"/storage/{video_id}/background.png"}


# ---------------------------------------------------------------- preview de um frame renderizado

class RenderParams(BaseModel):
    cell_size: int = 14
    scroll_speed: int = 1
    trail_len: int = 10
    color: str = "70,255,0"  # BGR
    background_color: str = "0,0,0"  # BGR
    background_mode: str = "color"  # color | video | image
    background_fit: str = "cover"  # cover | contain | stretch
    char_map: str = "01"
    color_mode: str = "solid"  # solid | source | grayscale
    effect_type: str = "rain"  # rain | blink | tracking | mesh | reveal | glitch
    effect_types: Optional[list[str]] = None
    intensity: float = 1.0
    label: str = "REPROGRAMMING"
    label_background: bool = False
    sfx_type: str = "none"  # none | tech | spatial | zap | glitch
    sfx_volume: float = 0.45


def _parse_bgr(value: str) -> tuple[int, int, int]:
    return tuple(int(v) for v in value.split(","))


def _fit_image(img: np.ndarray, width: int, height: int, fit: str = "cover") -> np.ndarray:
    ih, iw = img.shape[:2]
    if iw == 0 or ih == 0:
        return np.zeros((height, width, 3), dtype=np.uint8)
    if fit == "stretch":
        return cv2.resize(img, (width, height), interpolation=cv2.INTER_AREA)
    scale = min(width / iw, height / ih) if fit == "contain" else max(width / iw, height / ih)
    new_w = max(1, int(round(iw * scale)))
    new_h = max(1, int(round(ih * scale)))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    if fit == "contain":
        out = np.zeros((height, width, 3), dtype=np.uint8)
        x = max(0, (width - new_w) // 2)
        y = max(0, (height - new_h) // 2)
        out[y:y + new_h, x:x + new_w] = resized
        return out
    x = max(0, (new_w - width) // 2)
    y = max(0, (new_h - height) // 2)
    return resized[y:y + height, x:x + width].copy()


def _background_frame(d: Path, params: RenderParams, frame_path: Path,
                      width: int, height: int, background_color: tuple[int, int, int]) -> np.ndarray:
    if params.background_mode == "video":
        frame = cv2.imread(str(frame_path))
        if frame is not None:
            return cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    if params.background_mode == "image":
        bg = cv2.imread(str(d / "background.png"))
        if bg is not None:
            return _fit_image(bg, width, height, params.background_fit)
    return np.full((height, width, 3), background_color, dtype=np.uint8)


def _mask_bbox(mask: np.ndarray) -> Optional[tuple[int, int, int, int]]:
    pts = cv2.findNonZero((mask > 40).astype(np.uint8))
    if pts is None:
        return None
    x, y, w, h = cv2.boundingRect(pts)
    return x, y, x + w, y + h


def _draw_tracking_box(out: np.ndarray, mask: np.ndarray, color: tuple[int, int, int],
                       label: str, frame_index: int, intensity: float,
                       label_background: bool = False) -> None:
    bbox = _mask_bbox(mask)
    if bbox is None:
        return
    x1, y1, x2, y2 = bbox
    pad = max(4, int(8 * intensity))
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(out.shape[1] - 1, x2 + pad)
    y2 = min(out.shape[0] - 1, y2 + pad)
    pulse = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(frame_index * 0.55))
    box_color = tuple(min(255, int(c * (0.65 + pulse * intensity))) for c in color)
    cv2.rectangle(out, (x1, y1), (x2, y2), box_color, 1 + int(intensity))
    corner = max(10, int(min(x2 - x1, y2 - y1) * 0.16))
    for sx, sy in [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]:
        dx = corner if sx == x1 else -corner
        dy = corner if sy == y1 else -corner
        cv2.line(out, (sx, sy), (sx + dx, sy), box_color, 2)
        cv2.line(out, (sx, sy), (sx, sy + dy), box_color, 2)
    text = (label or "REPROGRAMMING")[:18].upper()
    font_scale = max(0.35, min(0.7, out.shape[1] / 900))
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1)
    ty = max(th + 4, y1 - 5)
    if label_background:
        cv2.rectangle(out, (x1, ty - th - 6), (min(out.shape[1] - 1, x1 + tw + 8), ty + 3), (0, 0, 0), -1)
    cv2.putText(out, text, (x1 + 4, ty), cv2.FONT_HERSHEY_SIMPLEX, font_scale, box_color, 1, cv2.LINE_AA)


def _draw_mesh(out: np.ndarray, mask: np.ndarray, color: tuple[int, int, int],
               frame_index: int, intensity: float) -> None:
    bbox = _mask_bbox(mask)
    if bbox is None:
        return
    x1, y1, x2, y2 = bbox
    points = []
    step = max(18, int(42 / max(0.35, intensity)))
    t = frame_index * 7
    for y in range(y1, y2, step):
        for x in range(x1, x2, step):
            yy = min(mask.shape[0] - 1, max(0, y + int(math.sin((x + t) * 0.04) * step * 0.24)))
            xx = min(mask.shape[1] - 1, max(0, x + int(math.cos((y + t) * 0.04) * step * 0.24)))
            if mask[yy, xx] > 40:
                points.append((xx, yy))
    if len(points) < 2:
        return
    max_dist = step * 2.35
    overlay = out.copy()
    for i, p in enumerate(points):
        for q in points[i + 1:i + 6]:
            dist = math.hypot(p[0] - q[0], p[1] - q[1])
            if dist <= max_dist:
                cv2.line(overlay, p, q, color, 1, cv2.LINE_AA)
    for p in points:
        cv2.circle(overlay, p, max(2, int(2 * intensity)), color, -1, cv2.LINE_AA)
    cv2.addWeighted(overlay, min(0.85, 0.35 + intensity * 0.35), out, 0.45, 0, out)


def _apply_reveal_mask(mask: np.ndarray, frame_index: int, intensity: float) -> np.ndarray:
    h, w = mask.shape
    span = max(1, int(w * 1.25))
    head = int((frame_index * (12 + 12 * intensity)) % (span + w)) - span
    width = max(24, int(w * (0.18 + 0.18 * intensity)))
    gate = np.zeros_like(mask)
    x1 = max(0, head)
    x2 = min(w, head + width)
    if x2 > x1:
        gate[:, x1:x2] = 255
    return cv2.bitwise_and(mask, gate)


def _active_effects(params) -> list[str]:
    allowed = {"rain", "blink", "tracking", "mesh", "reveal", "glitch"}
    order = ["rain", "reveal", "blink", "tracking", "mesh", "glitch"]
    raw = getattr(params, "effect_types", None) or [getattr(params, "effect_type", "rain")]
    active = [effect for effect in raw if effect in allowed]
    if not active:
        active = ["rain"]
    return [effect for effect in order if effect in active]


def _draw_glitch_panels(out: np.ndarray, source: Optional[np.ndarray], mask: np.ndarray,
                        color: tuple[int, int, int], frame_index: int, intensity: float) -> None:
    bbox = _mask_bbox(mask)
    if bbox is None:
        return
    x1, y1, x2, y2 = bbox
    rng = np.random.default_rng(frame_index * 97 + 11)
    count = 2 + int(3 * intensity)
    for i in range(count):
        bw = max(24, int((x2 - x1) * rng.uniform(0.28, 0.55)))
        bh = max(24, int((y2 - y1) * rng.uniform(0.20, 0.42)))
        sx = int(rng.integers(max(0, x1 - bw // 4), max(1, x2 - bw // 2)))
        sy = int(rng.integers(max(0, y1 - bh // 4), max(1, y2 - bh // 2)))
        sx2 = min(out.shape[1], sx + bw)
        sy2 = min(out.shape[0], sy + bh)
        if sx2 <= sx or sy2 <= sy:
            continue
        dx = int(np.clip(sx + rng.integers(-50, 51), 0, out.shape[1] - (sx2 - sx)))
        dy = int(np.clip(sy + rng.integers(-38, 39), 0, out.shape[0] - (sy2 - sy)))
        panel = out[sy:sy2, sx:sx2].copy() if source is None else source[sy:sy2, sx:sx2].copy()
        tint = np.zeros_like(panel)
        tint[:, :] = color
        panel = cv2.addWeighted(panel, 0.35, tint, 0.65, 0)
        out[dy:dy + panel.shape[0], dx:dx + panel.shape[1]] = panel
        cv2.rectangle(out, (dx, dy), (dx + panel.shape[1] - 1, dy + panel.shape[0] - 1), color, 1)


def _render_effect_frame(d: Path, renderer: RainRenderer, mask: np.ndarray, frame_index: int,
                         frame_path: Path, params: RenderParams,
                         color: tuple[int, int, int],
                         background_color: tuple[int, int, int]) -> np.ndarray:
    h, w = mask.shape
    source = cv2.imread(str(frame_path))
    active_effects = _active_effects(params)
    render_mask = mask
    if "reveal" in active_effects:
        render_mask = _apply_reveal_mask(mask, frame_index, params.intensity)

    render_rain = "rain" in active_effects
    if not render_rain:
        out = _background_frame(d, params, frame_path, w, h, background_color)
    elif params.background_mode == "color":
        out = renderer.render(render_mask, frame_index, scroll_speed=params.scroll_speed,
                              trail_len=params.trail_len, color_bgr=color,
                              background_bgr=background_color,
                              color_mode=params.color_mode,
                              source_frame=source)
    else:
        effect = renderer.render(render_mask, frame_index, scroll_speed=params.scroll_speed,
                                 trail_len=params.trail_len, color_bgr=color,
                                 background_bgr=(0, 0, 0),
                                 color_mode=params.color_mode,
                                 source_frame=source)
        effect_mask = (effect != 0).any(axis=2)
        out = _background_frame(d, params, frame_path, w, h, background_color)
        out[effect_mask] = effect[effect_mask]

    if "blink" in active_effects:
        pulse = 0.18 + 0.82 * (0.5 + 0.5 * math.sin(frame_index * (0.6 + params.intensity * 0.5)))
        m = (mask > 40)
        out[m] = np.clip(out[m].astype(np.float32) * (0.25 + pulse * 1.35), 0, 255).astype(np.uint8)
    if "tracking" in active_effects:
        _draw_tracking_box(out, mask, color, params.label, frame_index, params.intensity, params.label_background)
    if "mesh" in active_effects:
        _draw_mesh(out, mask, color, frame_index, params.intensity)
    if "glitch" in active_effects:
        _draw_glitch_panels(out, source, mask, color, frame_index, params.intensity)

    return out


def _get_renderer(video_id: str, width: int, height: int, cell_size: int, char_map: str = "01") -> RainRenderer:
    # cacheia o renderer (o buffer de caracteres) por video+cell_size
    key = (video_id, cell_size, char_map)
    if key not in _renderer_cache:
        _renderer_cache[key] = RainRenderer(width, height, cell_size=cell_size,
                                            seed=hash(video_id + char_map) % (2**31),
                                            char_map=char_map)
    return _renderer_cache[key]


_renderer_cache = {}


@app.post("/api/videos/{video_id}/preview/{frame_index}")
def render_preview(video_id: str, frame_index: int, params: RenderParams):
    d = video_dir(video_id)
    mask_path = d / "masks" / f"f_{frame_index:03d}.png"
    frame_path = d / "frames" / f"f_{frame_index:03d}.png"
    if not mask_path.exists():
        raise HTTPException(404, "mascara nao encontrada - gere as mascaras primeiro")

    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    h, w = mask.shape
    renderer = _get_renderer(video_id, w, h, params.cell_size, params.char_map)
    color = _parse_bgr(params.color)
    background_color = _parse_bgr(params.background_color)

    out = _render_effect_frame(d, renderer, mask, frame_index, frame_path, params, color, background_color)
    ok, buf = cv2.imencode(".png", out)
    return Response(content=buf.tobytes(), media_type="image/png")


@app.post("/api/videos/{video_id}/ascii/{frame_index}")
def render_ascii_frame(video_id: str, frame_index: int, params: RenderParams):
    d = video_dir(video_id)
    mask_path = d / "masks" / f"f_{frame_index:03d}.png"
    frame_path = d / "frames" / f"f_{frame_index:03d}.png"
    if not mask_path.exists() or not frame_path.exists():
        raise HTTPException(404, "frame ou mascara nao encontrados")

    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    frame = cv2.imread(str(frame_path), cv2.IMREAD_GRAYSCALE)
    if mask is None or frame is None:
        raise HTTPException(400, "frame ou mascara invalidos")

    h, w = mask.shape
    cell = max(4, params.cell_size)
    cols = max(1, w // cell)
    rows = max(1, h // cell)
    mask_small = cv2.resize(mask, (cols, rows), interpolation=cv2.INTER_AREA)
    gray_small = cv2.resize(frame, (cols, rows), interpolation=cv2.INTER_AREA)
    chars = list(params.char_map or "01")
    if len(chars) == 1:
        chars = [" ", chars[0]]

    lines = []
    offset = frame_index * params.scroll_speed
    for y in range(rows):
        line = []
        for x in range(cols):
            if mask_small[y, x] < 60:
                line.append(" ")
                continue
            level = int(gray_small[y, x] / 256 * len(chars))
            idx = (level + offset + x + y) % len(chars)
            line.append(chars[min(idx, len(chars) - 1)])
        lines.append("".join(line).rstrip())

    return Response(content="\n".join(lines) + "\n", media_type="text/plain; charset=utf-8")


# ---------------------------------------------------------------- export final

def _has_audio_stream(path: Path) -> bool:
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=index", "-of", "json", str(path)
    ], capture_output=True, text=True)
    if probe.returncode != 0:
        return False
    info = json.loads(probe.stdout or "{}")
    return bool(info.get("streams"))


def _sfx_source(sfx_type: str) -> str:
    sources = {
        "tech": "sine=frequency=180:sample_rate=48000",
        "spatial": "sine=frequency=520:sample_rate=48000",
        "zap": "anoisesrc=color=white:sample_rate=48000",
        "glitch": "anoisesrc=color=pink:sample_rate=48000",
    }
    return sources.get(sfx_type, "")


def _build_sfx_track(d: Path, sfx_type: str, sfx_volume: float,
                     segments: list[dict], duration: float,
                     filename: str = "sfx.wav") -> Optional[Path]:
    source = _sfx_source(sfx_type)
    if not source:
        return None

    active_segments = [
        (float(seg["start"]), max(0.05, float(seg["end"]) - float(seg["start"])))
        for seg in segments
        if float(seg["end"]) > float(seg["start"])
    ]
    if not active_segments:
        return None

    volume = max(0.0, min(float(sfx_volume), 1.5))
    out = d / filename
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-t", str(duration), "-i", "anullsrc=r=48000:cl=stereo"]
    for _, seg_duration in active_segments:
        cmd.extend(["-f", "lavfi", "-t", f"{seg_duration:.3f}", "-i", source])

    chains = []
    labels = ["[0:a]"]
    for idx, (start, seg_duration) in enumerate(active_segments, start=1):
        delay_ms = max(0, int(round(start * 1000)))
        fade_out_start = max(0.0, seg_duration - 0.08)
        label = f"[s{idx}]"
        chains.append(
            f"[{idx}:a]aformat=channel_layouts=stereo,"
            f"volume={volume:.3f},"
            "afade=t=in:st=0:d=0.03,"
            f"afade=t=out:st={fade_out_start:.3f}:d=0.08,"
            f"adelay={delay_ms}|{delay_ms}{label}"
        )
        labels.append(label)

    filter_complex = ";".join(chains)
    filter_complex += f";{''.join(labels)}amix=inputs={len(labels)}:duration=first:dropout_transition=0[a]"
    cmd.extend(["-filter_complex", filter_complex, "-map", "[a]", "-c:a", "pcm_s16le", str(out)])
    subprocess.run(cmd, check=True, capture_output=True)
    return out


class ExportRequest(BaseModel):
    cell_size: int = 14
    scroll_speed: int = 1
    trail_len: int = 10
    color: str = "70,255,0"
    background_color: str = "0,0,0"
    background_mode: str = "color"  # color | video | image
    background_fit: str = "cover"
    char_map: str = "01"
    color_mode: str = "solid"
    effect_type: str = "rain"
    effect_types: Optional[list[str]] = None
    intensity: float = 1.0
    label: str = "REPROGRAMMING"
    label_background: bool = False
    sfx_type: str = "none"
    sfx_volume: float = 0.45
    excluded_frames: list[int] = []  # indices (1-based) a remover do trecho


class TimelineClipRequest(BaseModel):
    id: str
    type: str
    track: str
    start: float
    end: float
    name: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


class TimelineTrackRequest(BaseModel):
    id: str
    clips: list[TimelineClipRequest] = Field(default_factory=list)


class TimelineExportRequest(BaseModel):
    duration: Optional[float] = None
    tracks: list[TimelineTrackRequest] = Field(default_factory=list)


def _timeline_clips(req: TimelineExportRequest, clip_type: str) -> list[TimelineClipRequest]:
    clips = [clip for track in req.tracks for clip in track.clips if clip.type == clip_type]
    return sorted(clips, key=lambda clip: clip.start)


def _validate_clip_segments(clips: list[TimelineClipRequest], duration: float) -> list[dict[str, float]]:
    segments = []
    for clip in clips:
        start = float(clip.start)
        end = float(clip.end)
        if start < 0 or end <= start or end > duration:
            raise HTTPException(400, "clip de timeline invalido")
        segments.append({"start": start, "end": end})
    for prev, cur in zip(segments, segments[1:]):
        if cur["start"] < prev["end"]:
            raise HTTPException(400, "clips de efeito ainda nao podem se sobrepor")
    return segments


def _hex_to_bgr_string(value: str, fallback: str = "0,255,70") -> str:
    if not value.startswith("#") or len(value) != 7:
        return fallback
    try:
        r = int(value[1:3], 16)
        g = int(value[3:5], 16)
        b = int(value[5:7], 16)
    except ValueError:
        return fallback
    return f"{b},{g},{r}"


def _render_request_from_clip(clip: TimelineClipRequest) -> ExportRequest:
    params = clip.params or {}
    effects = params.get("effects", "rain,tracking")
    if isinstance(effects, str):
        effect_types = [effect.strip() for effect in effects.split(",") if effect.strip()]
    elif isinstance(effects, list):
        effect_types = [str(effect) for effect in effects]
    else:
        effect_types = ["rain"]

    color = str(params.get("color", "#46ff00"))
    return ExportRequest(
        color=_hex_to_bgr_string(color),
        effect_type=effect_types[0] if effect_types else "rain",
        effect_types=effect_types or ["rain"],
        background_mode=str(params.get("background_mode", "color")),
        background_color=_hex_to_bgr_string(str(params.get("background_color", "#000000")), "0,0,0"),
        sfx_type="none",
    )


def _copy_or_mix_sfx(d: Path, base_video: Path, sfx_track: Optional[Path], out: Path) -> None:
    if not sfx_track:
        shutil.copyfile(base_video, out)
        return
    if _has_audio_stream(base_video):
        subprocess.run([
            "ffmpeg", "-y", "-i", str(base_video), "-i", str(sfx_track),
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(out),
        ], check=True, capture_output=True)
    else:
        subprocess.run([
            "ffmpeg", "-y", "-i", str(base_video), "-i", str(sfx_track),
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(out),
        ], check=True, capture_output=True)


@app.post("/api/videos/{video_id}/export")
def export_video(video_id: str, req: ExportRequest):
    d = video_dir(video_id)
    meta = json.loads((d / "meta.json").read_text())
    frames_dir = d / "frames"
    masks_dir = d / "masks"

    frame_paths = sorted(frames_dir.glob("*.png"))
    if not frame_paths:
        raise HTTPException(400, "extraia o trecho antes de exportar")

    rendered_dir = d / "rendered"
    rendered_dir.mkdir(exist_ok=True)
    for f in rendered_dir.glob("*.png"):
        f.unlink()

    color = _parse_bgr(req.color)
    background_color = _parse_bgr(req.background_color)
    renderer = None
    excluded = set(req.excluded_frames)
    for out_idx, p in enumerate(frame_paths):
        frame_num = int(p.stem.split("_")[1])
        mask_path = masks_dir / f"f_{frame_num:03d}.png"
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise HTTPException(400, "gere as mascaras antes de exportar")
        h, w = mask.shape
        if renderer is None:
            renderer = _get_renderer(video_id, w, h, req.cell_size, req.char_map)
        rendered = _render_effect_frame(d, renderer, mask, frame_num, p, req, color, background_color)
        cv2.imwrite(str(rendered_dir / f"f_{out_idx+1:03d}.png"), rendered)

    fps = meta["fps"]
    segments = meta.get("segments") or [{
        "start": meta["segment_start"],
        "end": meta["segment_end"],
        "first_frame": 1,
        "frame_count": len(frame_paths),
    }]
    duration = meta.get("duration", segments[-1]["end"])

    EPS = 1e-3
    parts = []
    cursor = 0.0

    def make_normal_clip(start: float, end: float, name: str) -> Optional[Path]:
        if end <= start + EPS:
            return None
        out = d / name
        subprocess.run([
            "ffmpeg", "-y", "-ss", str(start), "-i", str(d / "original.mp4"),
            "-t", str(end - start), "-c:v", "libx264", "-crf", "15", "-an", str(out)
        ], check=True, capture_output=True)
        return out

    for seg_idx, seg in enumerate(segments, start=1):
        normal = make_normal_clip(cursor, seg["start"], f"normal_{seg_idx:02d}.mp4")
        if normal:
            parts.append(normal)

        seq_dir = d / f"rendered_segment_{seg_idx:02d}"
        if seq_dir.exists():
            shutil.rmtree(seq_dir)
        seq_dir.mkdir(exist_ok=True)
        written = 0
        first = int(seg["first_frame"])
        count = int(seg["frame_count"])
        for frame_num in range(first, first + count):
            if frame_num in excluded:
                continue
            src = rendered_dir / f"f_{frame_num:03d}.png"
            if src.exists():
                written += 1
                shutil.copyfile(src, seq_dir / f"f_{written:03d}.png")

        if written:
            segment_video = d / f"segment_rendered_{seg_idx:02d}.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-framerate", str(fps), "-i", str(seq_dir / "f_%03d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(segment_video),
            ], check=True, capture_output=True)
            parts.append(segment_video)
        cursor = seg["end"]

    tail = make_normal_clip(cursor, duration, "normal_tail.mp4")
    if tail:
        parts.append(tail)

    if not parts:
        raise HTTPException(400, "nenhum trecho para exportar")

    concat_list = d / "concat.txt"
    concat_list.write_text("".join(f"file '{p.name}'\n" for p in parts))
    video_only = d / "video_only.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(video_only),
    ], check=True, capture_output=True, cwd=str(d))

    original_video = d / "original.mp4"
    final_video = d / "final.mp4"
    sfx_track = _build_sfx_track(d, req.sfx_type, req.sfx_volume, segments, duration)
    if sfx_track and _has_audio_stream(original_video):
        subprocess.run([
            "ffmpeg", "-y", "-i", str(original_video), "-i", str(video_only), "-i", str(sfx_track),
            "-filter_complex", "[0:a][2:a]amix=inputs=2:duration=first:dropout_transition=0[a]",
            "-map", "1:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(final_video),
        ], check=True, capture_output=True)
    elif sfx_track:
        subprocess.run([
            "ffmpeg", "-y", "-i", str(video_only), "-i", str(sfx_track),
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(final_video),
        ], check=True, capture_output=True)
    else:
        subprocess.run([
            "ffmpeg", "-y", "-i", str(original_video), "-i", str(video_only),
            "-map", "1:v", "-map", "0:a?", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(final_video),
        ], check=True, capture_output=True)

    return {"download_url": f"/storage/{video_id}/final.mp4"}


@app.post("/api/videos/{video_id}/timeline/export")
def export_timeline(video_id: str, req: TimelineExportRequest):
    d = video_dir(video_id)
    meta = json.loads((d / "meta.json").read_text())
    duration = float(meta.get("duration") or req.duration or 0)
    if duration <= 0:
        raise HTTPException(400, "duracao do video invalida")

    effect_clips = _timeline_clips(req, "effect")
    audio_clips = _timeline_clips(req, "audio")

    if effect_clips:
        effect_segments = _validate_clip_segments(effect_clips, duration)
        _extract_segments_to_frames(d, meta, effect_segments)
        generate_masks(video_id)
        render_req = _render_request_from_clip(effect_clips[0])
        export_video(video_id, render_req)
        base_video = d / "final.mp4"
    else:
        base_video = d / "original.mp4"

    audio_segments = []
    for clip in audio_clips:
        start = float(clip.start)
        end = float(clip.end)
        if start < 0 or end <= start or end > duration:
            raise HTTPException(400, "clip de audio invalido")
        audio_segments.append({"start": start, "end": end})

    sfx_track = None
    if audio_segments:
        audio_params = audio_clips[0].params or {}
        sfx_track = _build_sfx_track(
            d,
            str(audio_params.get("sfx", "tech")),
            float(audio_params.get("volume", 0.45)),
            audio_segments,
            duration,
            filename="timeline_sfx.wav",
        )

    final_layers = d / "final_layers.mp4"
    _copy_or_mix_sfx(d, base_video, sfx_track, final_layers)
    return {"download_url": f"/storage/{video_id}/final_layers.mp4"}


@app.get("/api/videos/{video_id}/download")
def download(video_id: str):
    d = video_dir(video_id)
    return FileResponse(str(d / "final.mp4"), filename=f"skate_binario_{video_id}.mp4")
