import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { uploadVideo } from "./api";
import type { SegmentRange, VideoMeta } from "./api";

const LOBBY_VIDEO = "/examples/motion-blocks.mp4";

const EXAMPLES = [
  {
    name: "Terminal ASCII",
    src: LOBBY_VIDEO,
    hint: "player estilo tplay",
    presetId: "ascii-terminal",
    sample: "$ tplay video.mp4\nASCII STREAM",
    tool: "ascii",
  },
  {
    name: "Tracking box",
    src: LOBBY_VIDEO,
    hint: "label e caixa de deteccao",
    presetId: "tracking",
    sample: "[REPROGRAMMING]",
    tool: "editor",
  },
  {
    name: "Mesh lines",
    src: LOBBY_VIDEO,
    hint: "pontos conectados",
    presetId: "mesh",
    sample: "*--*--*",
    tool: "editor",
  },
  {
    name: "Glitch panel",
    src: LOBBY_VIDEO,
    hint: "recortes digitais",
    presetId: "glitch",
    sample: "01#$%",
    tool: "editor",
  },
];

export default function UploadTrim({
  initialFile,
  initialMeta,
  onReady,
  onClear,
  onOpenAscii,
}: {
  initialFile?: File | null;
  initialMeta?: VideoMeta | null;
  onReady: (meta: VideoMeta, file: File, segments: SegmentRange[]) => void;
  onClear?: () => void;
  onOpenAscii?: () => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [meta, setMeta] = useState<VideoMeta | null>(initialMeta ?? null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(0.5, initialMeta?.duration ?? 0.5));
  const [segments, setSegments] = useState<SegmentRange[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setVideoUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function handleFile(f: File) {
    setFile(f);
    setBusy(true);
    try {
      const m = await uploadVideo(f);
      setMeta(m);
      setStart(0);
      setEnd(Math.min(0.5, m.duration));
      setSegments([]);
      setVideoPlaying(false);
    } catch (e) {
      alert("Erro no upload: " + e);
    } finally {
      setBusy(false);
    }
  }

  async function handleExample(src: string, name: string) {
    setBusy(true);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error("exemplo nao encontrado");
      const blob = await res.blob();
      await handleFile(new File([blob], name, { type: "video/mp4" }));
    } catch (e) {
      alert("Erro ao carregar exemplo: " + e);
      setBusy(false);
    }
  }

  const segmentValid = meta
    ? Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= meta.duration
    : false;
  const selectedSegments = segments.length ? segments : [{ start, end }];
  const playbackSegments = selectedSegments
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start);
  const totalDuration = selectedSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);

  function addSegment() {
    if (!segmentValid) return;
    const next = [...segments, { start, end }].sort((a, b) => a.start - b.start);
    for (let i = 1; i < next.length; i += 1) {
      if (next[i].start < next[i - 1].end) {
        alert("Os intervalos nao podem se sobrepor.");
        return;
      }
    }
    setSegments(next);
  }

  function removeSegment(index: number) {
    setSegments((prev) => prev.filter((_, i) => i !== index));
  }

  function clampTime(value: number) {
    const duration = meta?.duration ?? 0;
    return Math.min(duration, Math.max(0, Number(value.toFixed(2))));
  }

  function setRangeStart(value: number) {
    const duration = meta?.duration ?? 0;
    const minGap = 0.01;
    const next = Math.min(clampTime(value), Math.max(0, duration - minGap));
    if (next >= end) {
      setStart(next);
      setEnd(Math.min(duration, next + minGap));
      return;
    }
    setStart(next);
  }

  function setRangeEnd(value: number) {
    const minGap = 0.01;
    const next = Math.max(clampTime(value), minGap);
    if (next <= start) {
      setStart(Math.max(0, next - minGap));
      setEnd(next);
      return;
    }
    setEnd(next);
  }

  function seekTo(value: number) {
    const next = clampTime(value);
    const video = videoRef.current;
    if (video) video.currentTime = next;
    setCurrentTime(next);
  }

  function segmentIndexAt(time: number) {
    return playbackSegments.findIndex((seg) => time >= seg.start && time < seg.end);
  }

  function firstSegmentIndexAfter(time: number) {
    const index = playbackSegments.findIndex((seg) => seg.start > time);
    return index === -1 ? 0 : index;
  }

  function handleVideoPlay(video: HTMLVideoElement) {
    setVideoPlaying(true);
    if (playbackSegments.length === 0) return;
    if (segmentIndexAt(video.currentTime) === -1) {
      const next = playbackSegments[firstSegmentIndexAfter(video.currentTime)];
      video.currentTime = next.start;
      setCurrentTime(next.start);
    }
  }

  function toggleSelectedPlayback() {
    const video = videoRef.current;
    if (!video || playbackSegments.length === 0) return;
    if (!video.paused) {
      video.pause();
      setVideoPlaying(false);
      return;
    }
    if (segmentIndexAt(video.currentTime) === -1) {
      video.currentTime = playbackSegments[0].start;
      setCurrentTime(playbackSegments[0].start);
    }
    void video.play().catch(() => setVideoPlaying(false));
  }

  function handleVideoTimeUpdate(video: HTMLVideoElement) {
    const time = video.currentTime;
    setCurrentTime(time);
    if (video.paused || playbackSegments.length === 0) return;

    const currentIndex = segmentIndexAt(time);
    if (currentIndex === -1) {
      const next = playbackSegments[firstSegmentIndexAfter(time)];
      video.currentTime = next.start;
      setCurrentTime(next.start);
      return;
    }

    const currentSegment = playbackSegments[currentIndex];
    if (time >= currentSegment.end - 0.03) {
      const next = playbackSegments[(currentIndex + 1) % playbackSegments.length];
      video.currentTime = next.start;
      setCurrentTime(next.start);
    }
  }

  function timelineTime(clientX: number, element: HTMLElement) {
    const duration = meta?.duration ?? 0;
    const rect = element.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return clampTime(ratio * duration);
  }

  function setRangeHandle(handle: "start" | "end", value: number) {
    if (handle === "start") setRangeStart(value);
    else setRangeEnd(value);
  }

  function beginTimelineDrag(handle: "start" | "end", e: ReactPointerEvent<HTMLElement>) {
    if (!meta) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget.closest(".video-timeline") as HTMLElement | null;
    if (!track) return;
    setRangeHandle(handle, timelineTime(e.clientX, track));
    track.setPointerCapture?.(e.pointerId);

    const onMove = (event: PointerEvent) => {
      setRangeHandle(handle, timelineTime(event.clientX, track));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleTimelinePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!meta) return;
    const time = timelineTime(e.clientX, e.currentTarget);
    const handle = Math.abs(time - start) <= Math.abs(time - end) ? "start" : "end";
    beginTimelineDrag(handle, e);
  }

  const timelineStyle = meta ? ({
    "--start": `${(start / meta.duration) * 100}%`,
    "--end": `${(end / meta.duration) * 100}%`,
    "--playhead": `${(currentTime / meta.duration) * 100}%`,
  } as CSSProperties) : undefined;

  return (
    <div className="card">
      {!file && (
        <div className="upload-lobby">
          <div
            className={`dropzone ${dragOver ? "active" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
            }}
          >
            [ arraste um video aqui, ou clique pra escolher ]
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>

          <div className="example-grid">
            {EXAMPLES.map((example) => (
              <button
                key={example.presetId}
                className={`example-card example-${example.presetId}`}
                type="button"
                onClick={() => {
                  if (example.tool === "ascii") {
                    onOpenAscii?.();
                  } else {
                    handleExample(example.src, example.src.split("/").pop() ?? "example.mp4");
                  }
                }}
              >
                <video src={example.src} muted playsInline preload="metadata" />
                <div className={`example-overlay preset-${example.presetId}`}>
                  {example.sample}
                </div>
                <span>{example.name}</span>
                <small>{example.hint}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {file && busy && <p className="status-line">enviando e lendo metadados...</p>}

      {file && meta && videoUrl && (
        <div>
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            muted
            playsInline
            onLoadedMetadata={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onPlay={(e) => handleVideoPlay(e.currentTarget)}
            onPause={() => setVideoPlaying(false)}
            onEnded={() => setVideoPlaying(false)}
            onTimeUpdate={(e) => handleVideoTimeUpdate(e.currentTarget)}
            onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
            style={{ width: "100%", maxHeight: 420, background: "#000", borderRadius: 4 }}
          />
          <p className="status-line">
            {meta.width}x{meta.height} - {meta.fps.toFixed(0)}fps - {meta.duration.toFixed(2)}s
          </p>
          <p className="status-line">
            tempo atual: {currentTime.toFixed(2)}s
          </p>
          <p className="status-line">
            playback limitado aos intervalos selecionados
          </p>

          <div className="timeline-panel">
            <div className="timeline-head">
              <span>trecho do efeito</span>
              <strong>{start.toFixed(2)}s - {end.toFixed(2)}s</strong>
            </div>
            <div
              className="video-timeline"
              style={timelineStyle}
              onPointerDown={handleTimelinePointerDown}
            >
              <div className="timeline-fill" />
              <div className="timeline-playhead" />
              <button
                className="timeline-handle start"
                type="button"
                style={{ left: `${(start / meta.duration) * 100}%` }}
                aria-label="arrastar inicio do trecho"
                onPointerDown={(e) => beginTimelineDrag("start", e)}
              >
                <span>inicio</span>
              </button>
              <button
                className="timeline-handle end"
                type="button"
                style={{ left: `${(end / meta.duration) * 100}%` }}
                aria-label="arrastar fim do trecho"
                onPointerDown={(e) => beginTimelineDrag("end", e)}
              >
                <span>fim</span>
              </button>
            </div>
            <div className="timeline-actions">
              <button className="ghost" onClick={() => setRangeStart(currentTime)}>marcar inicio</button>
              <button className="ghost" onClick={() => setRangeEnd(currentTime)}>marcar fim</button>
              <button className="ghost" onClick={() => seekTo(start)}>ir inicio</button>
              <button className="ghost" onClick={() => seekTo(end)}>ir fim</button>
              <button className="ghost" disabled={playbackSegments.length === 0} onClick={toggleSelectedPlayback}>
                {videoPlaying ? "pausar preview" : "preview intervalos"}
              </button>
              <button className="ghost" disabled={!segmentValid} onClick={addSegment}>adicionar intervalo</button>
            </div>
          </div>

          <details className="trim-fine-panel">
            <summary>ajuste fino do trecho</summary>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
            <div>
              <label className="field">Inicio do trecho (s)</label>
              <input
                type="number"
                step={0.01}
                min={0}
                max={meta.duration}
                value={start}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  setStart(Number.isFinite(next) ? next : 0);
                }}
              />
              <button className="ghost" style={{ marginTop: 8, width: "100%" }} onClick={() => setStart(Number(currentTime.toFixed(2)))}>
                usar tempo atual
              </button>
            </div>
            <div>
              <label className="field">Fim do trecho (s)</label>
              <input
                type="number"
                step={0.01}
                min={0}
                max={meta.duration}
                value={end}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  setEnd(Number.isFinite(next) ? next : 0);
                }}
              />
              <button className="ghost" style={{ marginTop: 8, width: "100%" }} onClick={() => setEnd(Number(currentTime.toFixed(2)))}>
                usar tempo atual
              </button>
            </div>
            </div>
          </details>

          <p className="status-line" style={{ marginTop: 8 }}>
            duracao do efeito: {totalDuration.toFixed(2)}s (~{Math.round(totalDuration * meta.fps)} frames)
          </p>

          <div className="segment-list">
            <div className="row">
              <span className="section-title compact">intervalos</span>
            </div>
            {segments.length === 0 && (
              <p className="status-line">nenhum intervalo fixado; o trecho atual sera usado.</p>
            )}
            {segments.map((seg, index) => (
              <div className="segment-pill" key={`${seg.start}-${seg.end}-${index}`}>
                <span>{seg.start.toFixed(2)}s -&gt; {seg.end.toFixed(2)}s</span>
                <button className="ghost" onClick={() => removeSegment(index)}>remover</button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
            <button
              className="primary"
              disabled={!segmentValid && segments.length === 0}
              onClick={() => onReady(meta, file, selectedSegments)}
            >
              usar intervalo(s) -&gt;
            </button>
            <button className="ghost" onClick={() => { setFile(null); setMeta(null); setSegments([]); onClear?.(); }}>
              trocar video
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
