const host = window.location.hostname || "localhost";
const BASE = `http://${host}:8000`;

export interface VideoMeta {
  video_id: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

export interface SegmentRange {
  start: number;
  end: number;
}

export interface RenderParams {
  cell_size: number;
  scroll_speed: number;
  trail_len: number;
  color: string; // "B,G,R"
  background_color: string; // "B,G,R"
  background_mode: "color" | "video" | "image";
  background_fit: "cover" | "contain" | "stretch";
  char_map: string;
  color_mode: "solid" | "source" | "grayscale";
  effect_type: "rain" | "blink" | "tracking" | "mesh" | "reveal" | "glitch";
  intensity: number;
  label: string;
  label_background: boolean;
}

export async function uploadVideo(file: File): Promise<VideoMeta> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/api/videos`, { method: "POST", body: form });
  if (!res.ok) throw new Error("falha no upload");
  return res.json();
}

export async function extractSegment(videoId: string, segments: SegmentRange[]) {
  const res = await fetch(`${BASE}/api/videos/${videoId}/segment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) throw new Error("falha ao extrair o trecho");
  return res.json() as Promise<{ frame_count: number; frame_urls: string[] }>;
}

export async function generateMasks(videoId: string) {
  const res = await fetch(`${BASE}/api/videos/${videoId}/masks`, { method: "POST" });
  if (!res.ok) throw new Error("falha ao gerar mascaras");
  return res.json() as Promise<{ mask_urls: string[] }>;
}

export async function updateMask(videoId: string, frameIndex: number, blob: Blob) {
  const form = new FormData();
  form.append("file", blob, "mask.png");
  const res = await fetch(`${BASE}/api/videos/${videoId}/masks/${frameIndex}`, {
    method: "PUT",
    body: form,
  });
  if (!res.ok) throw new Error("falha ao salvar mascara editada");
  return res.json();
}

export type MaskCopyTarget = "next" | "previous" | "forward" | "backward" | "all";

export async function copyMask(videoId: string, sourceFrame: number, target: MaskCopyTarget) {
  const res = await fetch(`${BASE}/api/videos/${videoId}/masks/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_frame: sourceFrame, target }),
  });
  if (!res.ok) throw new Error("falha ao propagar mascara");
  return res.json() as Promise<{ ok: boolean; updated_frames: number[] }>;
}

export async function uploadBackgroundImage(videoId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/api/videos/${videoId}/background`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("falha ao enviar imagem de fundo");
  return res.json() as Promise<{ ok: boolean; background_url: string }>;
}

export function previewUrl(videoId: string, frameIndex: number, params: RenderParams) {
  return { videoId, frameIndex, params };
}

export async function fetchPreview(videoId: string, frameIndex: number, params: RenderParams): Promise<string> {
  const res = await fetch(`${BASE}/api/videos/${videoId}/preview/${frameIndex}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error("falha no preview");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function fetchAsciiFrame(videoId: string, frameIndex: number, params: RenderParams): Promise<string> {
  const res = await fetch(`${BASE}/api/videos/${videoId}/ascii/${frameIndex}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error("falha ao exportar ASCII");
  return res.text();
}

export async function exportVideo(
  videoId: string,
  params: RenderParams,
  excludedFrames: number[]
): Promise<string> {
  const res = await fetch(`${BASE}/api/videos/${videoId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, excluded_frames: excludedFrames }),
  });
  if (!res.ok) throw new Error("falha no export");
  const data = await res.json();
  return `${BASE}${data.download_url}`;
}

export function storageUrl(path: string) {
  return `${BASE}${path}`;
}
