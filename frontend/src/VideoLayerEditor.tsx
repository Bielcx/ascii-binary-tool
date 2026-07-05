import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { exportTimeline, uploadVideo } from "./api";
import type { SegmentRange, TimelineClip, TimelineLayerType, TimelineProject, VideoMeta } from "./api";

type LayerType = TimelineLayerType;

interface LayerPreset {
  id: string;
  name: string;
  hint: string;
  type: LayerType;
  track: string;
  params: TimelineClip["params"];
}

const TRACKS = [
  { id: "base", label: "video base", type: "video" },
  { id: "effects", label: "efeitos", type: "effect" },
  { id: "overlays", label: "texto / imagem", type: "overlay" },
  { id: "audio", label: "audio / SFX", type: "audio" },
];

const EFFECT_OPTIONS = [
  { id: "rain", label: "binary" },
  { id: "tracking", label: "tracking" },
  { id: "mesh", label: "mesh" },
  { id: "blink", label: "blink" },
  { id: "reveal", label: "scan" },
  { id: "glitch", label: "glitch" },
];

const SFX_OPTIONS = [
  { id: "tech", label: "tech hum" },
  { id: "spatial", label: "espacial" },
  { id: "zap", label: "raio / energia" },
  { id: "glitch", label: "glitch digital" },
];

const LAYER_PRESETS: LayerPreset[] = [
  {
    id: "matrix-silhouette",
    name: "Matrix silhouette",
    hint: "binario verde na mascara com tracking",
    type: "effect",
    track: "effects",
    params: { effects: "rain,tracking", color: "#46ff00", background_mode: "color", background_color: "#000000" },
  },
  {
    id: "tracking-hud",
    name: "Tracking HUD",
    hint: "caixa e label de deteccao",
    type: "effect",
    track: "effects",
    params: { effects: "tracking,mesh", color: "#46ff00", background_mode: "video" },
  },
  {
    id: "glitch-scan",
    name: "Glitch scan",
    hint: "painel digital com cortes",
    type: "effect",
    track: "effects",
    params: { effects: "rain,glitch,blink", color: "#46ff00", background_mode: "video" },
  },
  {
    id: "tech-sfx",
    name: "Tech SFX",
    hint: "som sintetico no trecho",
    type: "audio",
    track: "audio",
    params: { sfx: "tech", volume: 0.45 },
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function makeClipId() {
  return Math.random().toString(36).slice(2, 10);
}

function paramString(value: TimelineClip["params"][string] | undefined, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function paramNumber(value: TimelineClip["params"][string] | undefined, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function effectList(clip: TimelineClip) {
  const effects = clip.params.effects;
  if (Array.isArray(effects)) return effects.map(String);
  if (typeof effects === "string") return effects.split(",").map((effect) => effect.trim()).filter(Boolean);
  return ["rain"];
}

export default function VideoLayerEditor({
  initialMeta,
  initialFile,
  onVideoLoaded,
  onBack,
  onOpenMaskEditor,
}: {
  initialMeta?: VideoMeta | null;
  initialFile?: File | null;
  onVideoLoaded?: (meta: VideoMeta, file: File) => void;
  onBack: () => void;
  onOpenMaskEditor: (meta: VideoMeta, file: File, segments: SegmentRange[]) => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [meta, setMeta] = useState<VideoMeta | null>(initialMeta ?? null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(Math.min(1, initialMeta?.duration ?? 1));
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [segmentPlaying, setSegmentPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!file) {
      setVideoUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setVideoUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  async function handleFile(nextFile: File) {
    setFile(nextFile);
    setBusy(true);
    try {
      const nextMeta = await uploadVideo(nextFile);
      setMeta(nextMeta);
      setRangeStart(0);
      setRangeEnd(Math.min(1, nextMeta.duration));
      setCurrentTime(0);
      setClips([]);
      setSelectedClipId(null);
      onVideoLoaded?.(nextMeta, nextFile);
    } catch (e) {
      alert("Erro no upload: " + e);
    } finally {
      setBusy(false);
    }
  }

  function timeFromPointer(clientX: number, element: HTMLElement) {
    const duration = meta?.duration ?? 0;
    const rect = element.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Number(clamp(ratio * duration, 0, duration).toFixed(2));
  }

  function setDraftRange(start: number, end: number) {
    const duration = meta?.duration ?? 0;
    const a = clamp(Number(start.toFixed(2)), 0, duration);
    const b = clamp(Number(end.toFixed(2)), 0, duration);
    if (Math.abs(a - b) < 0.03) {
      setRangeStart(Math.max(0, Math.min(a, duration - 0.03)));
      setRangeEnd(Math.min(duration, Math.max(b, a + 0.03)));
      return;
    }
    setRangeStart(Math.min(a, b));
    setRangeEnd(Math.max(a, b));
  }

  function beginRangeDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!meta) return;
    e.preventDefault();
    const track = e.currentTarget;
    const start = timeFromPointer(e.clientX, track);
    setDraftRange(start, start + 0.03);

    const onMove = (event: PointerEvent) => {
      setDraftRange(start, timeFromPointer(event.clientX, track));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function beginHandleDrag(handle: "start" | "end", e: ReactPointerEvent<HTMLButtonElement>) {
    if (!meta) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget.closest(".layer-time-ruler") as HTMLElement | null;
    if (!track) return;

    const onMove = (event: PointerEvent) => {
      const time = timeFromPointer(event.clientX, track);
      if (handle === "start") setDraftRange(time, rangeEnd);
      else setDraftRange(rangeStart, time);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function addPreset(preset: LayerPreset) {
    if (!meta || rangeEnd <= rangeStart) return;
    const id = makeClipId();
    setClips((current) => [
      ...current,
      {
        id,
        type: preset.type,
        track: preset.track,
        start: rangeStart,
        end: rangeEnd,
        name: preset.name,
        params: preset.params,
      },
    ]);
    setSelectedClipId(id);
  }

  function removeClip(id: string) {
    setClips((current) => current.filter((clip) => clip.id !== id));
    setSelectedClipId((current) => current === id ? null : current);
  }

  function updateClip(id: string, patch: Partial<TimelineClip>) {
    setClips((current) => current.map((clip) => (
      clip.id === id ? { ...clip, ...patch } : clip
    )));
  }

  function updateClipParams(id: string, params: TimelineClip["params"]) {
    setClips((current) => current.map((clip) => (
      clip.id === id ? { ...clip, params: { ...clip.params, ...params } } : clip
    )));
  }

  function toggleEffect(clip: TimelineClip, effectId: string) {
    const current = effectList(clip);
    const next = current.includes(effectId)
      ? current.filter((effect) => effect !== effectId)
      : [...current, effectId];
    updateClipParams(clip.id, { effects: (next.length ? next : ["rain"]).join(",") });
  }

  function seekTo(time: number) {
    const video = videoRef.current;
    if (video) video.currentTime = time;
    setCurrentTime(time);
  }

  function playSelectedRange() {
    const video = videoRef.current;
    if (!video || !meta) return;
    if (segmentPlaying) {
      video.pause();
      setSegmentPlaying(false);
      return;
    }
    video.currentTime = rangeStart;
    setCurrentTime(rangeStart);
    setSegmentPlaying(true);
    void video.play().catch(() => setSegmentPlaying(false));
  }

  function handleVideoTime(video: HTMLVideoElement) {
    const time = Number(video.currentTime.toFixed(2));
    setCurrentTime(time);
    if (segmentPlaying && time >= rangeEnd - 0.02) {
      video.pause();
      video.currentTime = rangeStart;
      setCurrentTime(rangeStart);
      setSegmentPlaying(false);
    }
  }

  const timelineStyle = meta ? ({
    "--range-start": `${(rangeStart / meta.duration) * 100}%`,
    "--range-end": `${(rangeEnd / meta.duration) * 100}%`,
    "--playhead": `${(currentTime / meta.duration) * 100}%`,
  } as CSSProperties) : undefined;

  const project: TimelineProject | null = meta ? {
    video_id: meta.video_id,
    duration: meta.duration,
    tracks: TRACKS.map((track) => ({
      id: track.id,
      clips: clips.filter((clip) => clip.track === track.id),
    })),
  } : null;

  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

  async function handleTimelineExport() {
    if (!meta || !project) return;
    setExporting(true);
    setDownloadUrl(null);
    try {
      const url = await exportTimeline(meta.video_id, project);
      setDownloadUrl(url);
    } catch (e) {
      alert("Erro no export da timeline: " + e);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="layer-editor">
      <div className="layer-header">
        <div>
          <button className="ghost" onClick={onBack}>voltar ao lobby</button>
          <h2>editor de video / camadas</h2>
          <p className="helper-text">Fluxo rapido: carregue um video, selecione o trecho na timeline, escolha um preset e exporte.</p>
        </div>
        {meta && file && (
          <button
            className="primary"
            onClick={() => onOpenMaskEditor(meta, file, [{ start: rangeStart, end: rangeEnd }])}
          >
            editar mascara do intervalo
          </button>
        )}
      </div>

      {!file && (
        <div
          className={`dropzone ${dragOver ? "active" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files[0]) void handleFile(e.dataTransfer.files[0]);
          }}
        >
          [ arraste um video aqui para montar camadas ]
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
          />
        </div>
      )}

      {busy && <p className="status-line">lendo metadados do video...</p>}

      {file && meta && videoUrl && (
        <div className="layer-layout">
          <div className="layer-main">
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              onTimeUpdate={(e) => handleVideoTime(e.currentTarget)}
              onSeeked={(e) => setCurrentTime(Number(e.currentTarget.currentTime.toFixed(2)))}
              onPause={() => setSegmentPlaying(false)}
              className="layer-preview"
            />

            <div className="timeline-panel layer-timeline-panel">
              <div className="timeline-head">
                <span>1. selecione o trecho</span>
                <strong>{rangeStart.toFixed(2)}s - {rangeEnd.toFixed(2)}s</strong>
              </div>

              <div className="layer-time-ruler" style={timelineStyle} onPointerDown={beginRangeDrag}>
                <div className="layer-draft-range" />
                <div className="timeline-playhead" />
                <button
                  className="layer-range-handle start"
                  type="button"
                  style={{ left: `${(rangeStart / meta.duration) * 100}%` }}
                  onPointerDown={(e) => beginHandleDrag("start", e)}
                  aria-label="inicio do trecho"
                >
                  inicio
                </button>
                <button
                  className="layer-range-handle end"
                  type="button"
                  style={{ left: `${(rangeEnd / meta.duration) * 100}%` }}
                  onPointerDown={(e) => beginHandleDrag("end", e)}
                  aria-label="fim do trecho"
                >
                  fim
                </button>
              </div>

              <div className="layer-tracks">
                {TRACKS.map((track) => (
                  <div className="layer-track-row" key={track.id}>
                    <div className="layer-track-label">{track.label}</div>
                    <div className="layer-track">
                      {clips.filter((clip) => clip.track === track.id).map((clip) => (
                        <button
                          key={clip.id}
                          className={`layer-clip clip-${clip.type} ${selectedClipId === clip.id ? "active" : ""}`}
                          style={{
                            left: `${(clip.start / meta.duration) * 100}%`,
                            width: `${Math.max(1.5, ((clip.end - clip.start) / meta.duration) * 100)}%`,
                          }}
                          onClick={() => {
                            setDraftRange(clip.start, clip.end);
                            seekTo(clip.start);
                            setSelectedClipId(clip.id);
                          }}
                          title={`${clip.start.toFixed(2)}s - ${clip.end.toFixed(2)}s`}
                        >
                          {clip.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="timeline-actions">
                <button className="ghost" onClick={playSelectedRange}>{segmentPlaying ? "pausar trecho" : "play do trecho"}</button>
                <button className="ghost" onClick={() => seekTo(rangeStart)}>ir inicio</button>
                <button className="ghost" onClick={() => seekTo(rangeEnd)}>ir fim</button>
                <button className="ghost" onClick={() => setRangeStart(Number(currentTime.toFixed(2)))}>marcar inicio</button>
                <button className="ghost" onClick={() => setRangeEnd(Number(currentTime.toFixed(2)))}>marcar fim</button>
              </div>
            </div>
          </div>

          <div className="card layer-sidebar">
            <div className="section-title">2. aplique um preset</div>
            <p className="status-line">Use o trecho selecionado na timeline. Depois clique no clip para revisar ou remover.</p>
            <div className="layer-preset-list">
              {LAYER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`layer-preset preset-${preset.type}`}
                  type="button"
                  onClick={() => addPreset(preset)}
                >
                  <span>{preset.name}</span>
                  <small>{preset.hint}</small>
                </button>
              ))}
            </div>

            <div className="section-title compact">camadas</div>
            <div className="clip-list">
              {clips.length === 0 && (
                <div className="empty-layer-state">
                  <strong>Nenhum efeito aplicado</strong>
                  <span>Selecione um trecho e clique em um preset acima.</span>
                </div>
              )}
              {clips.map((clip) => (
                <button
                  className={`clip-list-item ${selectedClipId === clip.id ? "active" : ""}`}
                  key={clip.id}
                  onClick={() => {
                    setSelectedClipId(clip.id);
                    setDraftRange(clip.start, clip.end);
                    seekTo(clip.start);
                  }}
                >
                  <div>
                    <strong>{clip.name}</strong>
                    <span>{clip.type} - {clip.start.toFixed(2)}s ate {clip.end.toFixed(2)}s</span>
                  </div>
                </button>
              ))}
            </div>

            {selectedClip && (
              <div className="selected-layer-card">
                <div className="section-title compact">clip selecionado</div>
                <label className="field">nome</label>
                <input
                  value={selectedClip.name}
                  onChange={(e) => updateClip(selectedClip.id, { name: e.target.value })}
                />
                <span>{selectedClip.start.toFixed(2)}s ate {selectedClip.end.toFixed(2)}s</span>

                {selectedClip.type === "effect" && (
                  <div className="clip-editor-panel">
                    <label className="field">efeitos ativos</label>
                    <div className="clip-effect-grid">
                      {EFFECT_OPTIONS.map((effect) => (
                        <button
                          key={effect.id}
                          className={effectList(selectedClip).includes(effect.id) ? "active" : ""}
                          type="button"
                          onClick={() => toggleEffect(selectedClip, effect.id)}
                        >
                          {effect.label}
                        </button>
                      ))}
                    </div>

                    <div className="row">
                      <label className="field">cor</label>
                      <input
                        type="color"
                        value={paramString(selectedClip.params.color, "#46ff00")}
                        onChange={(e) => updateClipParams(selectedClip.id, { color: e.target.value })}
                        className="compact-color-input"
                      />
                    </div>

                    <label className="field">fundo</label>
                    <div className="segmented-control compact">
                      <button
                        className={paramString(selectedClip.params.background_mode, "color") === "color" ? "active" : ""}
                        onClick={() => updateClipParams(selectedClip.id, { background_mode: "color" })}
                      >
                        cor
                      </button>
                      <button
                        className={paramString(selectedClip.params.background_mode, "color") === "video" ? "active" : ""}
                        onClick={() => updateClipParams(selectedClip.id, { background_mode: "video" })}
                      >
                        video
                      </button>
                    </div>

                    {paramString(selectedClip.params.background_mode, "color") === "color" && (
                      <div className="row">
                        <label className="field">cor do fundo</label>
                        <input
                          type="color"
                          value={paramString(selectedClip.params.background_color, "#000000")}
                          onChange={(e) => updateClipParams(selectedClip.id, { background_color: e.target.value })}
                          className="compact-color-input"
                        />
                      </div>
                    )}
                  </div>
                )}

                {selectedClip.type === "audio" && (
                  <div className="clip-editor-panel">
                    <label className="field">som</label>
                    <select
                      value={paramString(selectedClip.params.sfx, "tech")}
                      onChange={(e) => updateClipParams(selectedClip.id, { sfx: e.target.value })}
                    >
                      {SFX_OPTIONS.map((sfx) => (
                        <option key={sfx.id} value={sfx.id}>{sfx.label}</option>
                      ))}
                    </select>
                    <div className="row">
                      <label className="field">volume</label>
                      <span className="value">{Math.round(paramNumber(selectedClip.params.volume, 0.45) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={1.2}
                      step={0.05}
                      value={paramNumber(selectedClip.params.volume, 0.45)}
                      onChange={(e) => updateClipParams(selectedClip.id, { volume: +e.target.value })}
                    />
                  </div>
                )}

                <div className="selected-layer-actions">
                  {selectedClip.type === "effect" && meta && file && (
                    <button className="ghost" onClick={() => onOpenMaskEditor(meta, file, [{ start: selectedClip.start, end: selectedClip.end }])}>
                      editar mascara
                    </button>
                  )}
                  <button className="ghost danger" onClick={() => removeClip(selectedClip.id)}>remover</button>
                </div>
              </div>
            )}

            <div className="section-title compact">3. exporte</div>
            <button
              className="primary"
              style={{ width: "100%" }}
              disabled={!meta || exporting || clips.length === 0}
              onClick={handleTimelineExport}
            >
              {exporting ? "renderizando..." : "exportar camadas"}
            </button>
            {downloadUrl && (
              <>
                <video src={downloadUrl} controls className="layer-export-preview" />
                <a className="download-link" href={downloadUrl} target="_blank" rel="noreferrer">
                  baixar timeline
                </a>
              </>
            )}

            <details className="advanced-panel">
              <summary>modelo do projeto</summary>
              <pre className="project-json">{JSON.stringify(project, null, 2)}</pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
