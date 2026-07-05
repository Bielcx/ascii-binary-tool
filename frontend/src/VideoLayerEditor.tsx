import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { exportTimeline, uploadVideo } from "./api";
import type { SegmentRange, TimelineClip, TimelineLayerType, TimelineProject, VideoMeta } from "./api";

type LayerType = TimelineLayerType;

const TRACKS = [
  { id: "base", label: "video base", type: "video" },
  { id: "effects", label: "efeitos", type: "effect" },
  { id: "overlays", label: "texto / imagem", type: "overlay" },
  { id: "audio", label: "audio / SFX", type: "audio" },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function makeClipId() {
  return Math.random().toString(36).slice(2, 10);
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
  const [selectedType, setSelectedType] = useState<LayerType>("effect");
  const [clipName, setClipName] = useState("binary rain");
  const [clips, setClips] = useState<TimelineClip[]>([]);
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

  function addClip(type: LayerType = selectedType) {
    if (!meta || rangeEnd <= rangeStart) return;
    const track = type === "audio" ? "audio" : type === "effect" ? "effects" : "overlays";
    const defaultNames: Record<LayerType, string> = {
      effect: "binary rain",
      text: "texto",
      image: "imagem",
      audio: "tech SFX",
    };
    setClips((current) => [
      ...current,
      {
        id: makeClipId(),
        type,
        track,
        start: rangeStart,
        end: rangeEnd,
        name: clipName.trim() || defaultNames[type],
        params: type === "effect"
          ? { effects: "rain,tracking", color: "#46ff00" }
          : type === "audio"
            ? { sfx: "tech", volume: 0.45 }
            : {},
      },
    ]);
  }

  function removeClip(id: string) {
    setClips((current) => current.filter((clip) => clip.id !== id));
  }

  function seekTo(time: number) {
    const video = videoRef.current;
    if (video) video.currentTime = time;
    setCurrentTime(time);
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
          <p className="helper-text">MVP da timeline: escolha um intervalo, adicione camadas e mande um trecho para o editor de mascara quando precisar refinar a silhueta.</p>
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
              onTimeUpdate={(e) => setCurrentTime(Number(e.currentTarget.currentTime.toFixed(2)))}
              onSeeked={(e) => setCurrentTime(Number(e.currentTarget.currentTime.toFixed(2)))}
              className="layer-preview"
            />

            <div className="timeline-panel layer-timeline-panel">
              <div className="timeline-head">
                <span>{meta.width}x{meta.height} - {meta.fps.toFixed(0)}fps - {meta.duration.toFixed(2)}s</span>
                <strong>{rangeStart.toFixed(2)}s - {rangeEnd.toFixed(2)}s</strong>
              </div>

              <div className="layer-time-ruler" style={timelineStyle} onPointerDown={beginRangeDrag}>
                <div className="layer-draft-range" />
                <div className="timeline-playhead" />
              </div>

              <div className="layer-tracks">
                {TRACKS.map((track) => (
                  <div className="layer-track-row" key={track.id}>
                    <div className="layer-track-label">{track.label}</div>
                    <div className="layer-track">
                      {clips.filter((clip) => clip.track === track.id).map((clip) => (
                        <button
                          key={clip.id}
                          className={`layer-clip clip-${clip.type}`}
                          style={{
                            left: `${(clip.start / meta.duration) * 100}%`,
                            width: `${Math.max(1.5, ((clip.end - clip.start) / meta.duration) * 100)}%`,
                          }}
                          onClick={() => {
                            setDraftRange(clip.start, clip.end);
                            seekTo(clip.start);
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
                <button className="ghost" onClick={() => seekTo(rangeStart)}>ir inicio</button>
                <button className="ghost" onClick={() => seekTo(rangeEnd)}>ir fim</button>
                <button className="ghost" onClick={() => setRangeStart(Number(currentTime.toFixed(2)))}>marcar inicio</button>
                <button className="ghost" onClick={() => setRangeEnd(Number(currentTime.toFixed(2)))}>marcar fim</button>
              </div>
            </div>
          </div>

          <div className="card layer-sidebar">
            <div className="section-title">nova camada</div>
            <label className="field">tipo</label>
            <select value={selectedType} onChange={(e) => setSelectedType(e.target.value as LayerType)}>
              <option value="effect">efeito</option>
              <option value="text">texto</option>
              <option value="image">imagem</option>
              <option value="audio">audio / SFX</option>
            </select>

            <label className="field">nome</label>
            <input value={clipName} onChange={(e) => setClipName(e.target.value)} />

            <button className="primary" style={{ width: "100%", marginTop: 12 }} onClick={() => addClip()}>
              adicionar camada
            </button>

            <div className="quick-layer-buttons">
              <button className="ghost" onClick={() => { setClipName("binary rain"); addClip("effect"); }}>binary</button>
              <button className="ghost" onClick={() => { setClipName("tracking label"); addClip("effect"); }}>tracking</button>
              <button className="ghost" onClick={() => { setClipName("tech SFX"); addClip("audio"); }}>SFX</button>
            </div>

            <div className="section-title compact">camadas</div>
            <div className="clip-list">
              {clips.length === 0 && <p className="status-line">nenhuma camada criada ainda.</p>}
              {clips.map((clip) => (
                <div className="clip-list-item" key={clip.id}>
                  <div>
                    <strong>{clip.name}</strong>
                    <span>{clip.type} - {clip.start.toFixed(2)}s ate {clip.end.toFixed(2)}s</span>
                  </div>
                  <button className="ghost" onClick={() => removeClip(clip.id)}>remover</button>
                </div>
              ))}
            </div>

            <div className="section-title compact">exportar timeline</div>
            <p className="status-line">Neste MVP, clips de efeito e audio/SFX renderizam. Texto/imagem ficam salvos no modelo para a proxima etapa.</p>
            <button
              className="primary"
              style={{ width: "100%" }}
              disabled={!meta || exporting}
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
