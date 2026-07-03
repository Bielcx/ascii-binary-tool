import { useEffect, useRef, useState } from "react";

const DEFAULT_CHARS = " .,:;irsXA253hMHGS#9B&@";
const EXAMPLE_VIDEO = "/examples/motion-blocks.mp4";

type AsciiMode = "green" | "gray" | "source";
type PlayerSkin = "terminal" | "clean";
type FitMode = "fit" | "fill";

export default function AsciiPlayer({ onBack }: { onBack: () => void }) {
  const [fileName, setFileName] = useState("motion-blocks.mp4");
  const [videoUrl, setVideoUrl] = useState(EXAMPLE_VIDEO);
  const [chars, setChars] = useState(DEFAULT_CHARS);
  const [cellSize, setCellSize] = useState(9);
  const [contrast, setContrast] = useState(1.15);
  const [mode, setMode] = useState<AsciiMode>("green");
  const [skin, setSkin] = useState<PlayerSkin>("terminal");
  const [fitMode, setFitMode] = useState<FitMode>("fit");
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [charSpeed, setCharSpeed] = useState(1);
  const [frameSkip, setFrameSkip] = useState(1);
  const [lastText, setLastText] = useState("");
  const [recording, setRecording] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
    if (playing) {
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, [playing, videoUrl, playbackRate]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      const video = videoRef.current;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((value) => !value);
      } else if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        setMode((value) => value === "green" ? "gray" : value === "gray" ? "source" : "green");
      } else if (e.key === "ArrowLeft" && video) {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (e.key === "ArrowRight" && video) {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      } else if (e.key === "[") {
        e.preventDefault();
        setPlaybackRate((value) => Math.max(0.25, value - 0.25));
      } else if (e.key === "]") {
        e.preventDefault();
        setPlaybackRate((value) => Math.min(2, value + 0.25));
      } else if (e.key === "\\") {
        e.preventDefault();
        setPlaybackRate(1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function render() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      tickRef.current += 1;
      if (tickRef.current % frameSkip !== 0) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const stageRect = stageRef.current?.getBoundingClientRect();
      const terminalChrome = skin === "terminal" ? 34 : 0;
      const availableW = Math.max(320, Math.floor(stageRect?.width ?? width));
      const availableH = Math.max(240, Math.floor((stageRect?.height ?? height) - terminalChrome));
      const cols = fitMode === "fill"
        ? Math.max(24, Math.floor(availableW / cellSize))
        : Math.max(24, Math.floor(width / cellSize));
      const rows = fitMode === "fill"
        ? Math.max(12, Math.floor(availableH / (cellSize * 1.65)))
        : Math.max(12, Math.floor(height / (cellSize * 1.65)));
      const work = workRef.current;
      work.width = cols;
      work.height = rows;
      const wctx = work.getContext("2d", { willReadFrequently: true });
      const ctx = canvas.getContext("2d");
      if (!wctx || !ctx) return;

      if (fitMode === "fill") {
        const targetRatio = cols / rows;
        const videoRatio = width / height;
        let sx = 0;
        let sy = 0;
        let sw = width;
        let sh = height;
        if (videoRatio > targetRatio) {
          sw = height * targetRatio;
          sx = (width - sw) / 2;
        } else {
          sh = width / targetRatio;
          sy = (height - sh) / 2;
        }
        wctx.drawImage(video, sx, sy, sw, sh, 0, 0, cols, rows);
      } else {
        wctx.drawImage(video, 0, 0, cols, rows);
      }
      const pixels = wctx.getImageData(0, 0, cols, rows).data;
      const displayW = cols * cellSize;
      const displayH = rows * cellSize * 1.65;
      canvas.width = displayW;
      canvas.height = displayH;
      ctx.fillStyle = skin === "terminal" ? "#050705" : "#000";
      ctx.fillRect(0, 0, displayW, displayH);
      ctx.font = `${cellSize}px JetBrains Mono, monospace`;
      ctx.textBaseline = "top";

      const safeChars = chars.length > 1 ? chars : ` ${chars || "@"}`;
      const lines: string[] = [];
      for (let y = 0; y < rows; y += 1) {
        let line = "";
        for (let x = 0; x < cols; x += 1) {
          const p = (y * cols + x) * 4;
          const r = pixels[p];
          const g = pixels[p + 1];
          const b = pixels[p + 2];
          const lum = Math.max(0, Math.min(255, (0.299 * r + 0.587 * g + 0.114 * b - 128) * contrast + 128));
          const offset = Math.floor(tickRef.current * charSpeed * 0.08 + x * 0.09 + y * 0.05);
          const idx = Math.min(safeChars.length - 1, Math.floor((lum / 256) * safeChars.length));
          const shiftedIdx = (idx + offset) % safeChars.length;
          const ch = safeChars[shiftedIdx];
          line += ch;
          if (mode === "source") {
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          } else if (mode === "gray") {
            ctx.fillStyle = `rgb(${lum}, ${lum}, ${lum})`;
          } else {
            ctx.fillStyle = `rgb(${Math.floor(lum * 0.25)}, ${Math.min(255, Math.floor(lum * 1.25))}, ${Math.floor(lum * 0.35)})`;
          }
          ctx.fillText(ch, x * cellSize, y * cellSize * 1.65);
        }
        lines.push(line.trimEnd());
      }
      setLastText(lines.join("\n"));
      rafRef.current = requestAnimationFrame(render);
    }

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [cellSize, chars, contrast, frameSkip, mode, skin, charSpeed, fitMode]);

  function handleFile(file: File) {
    if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    setFileName(file.name);
    setVideoUrl(URL.createObjectURL(file));
    setPlaying(true);
  }

  function downloadText() {
    const blob = new Blob([lastText + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, "") || "frame"}-ascii.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportVideo() {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      alert("export de video nao suportado neste navegador");
      return;
    }
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      setRecording(false);
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName.replace(/\.[^.]+$/, "") || "ascii"}-terminal.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    setRecording(true);
    setPlaying(true);
    video.currentTime = 0;
    recorder.start();
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8;
    window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, Math.min(20, duration) * 1000);
  }

  return (
    <div className="ascii-player">
      <div className="tool-header">
        <button className="ghost" onClick={onBack}>voltar ao lobby</button>
        <div>
          <div className="section-title">ASCII Player</div>
          <p className="status-line">modo inspirado no tplay: video inteiro convertido em ASCII no navegador</p>
        </div>
      </div>

      <div className="ascii-layout">
        <div ref={stageRef} className={`ascii-stage ${skin === "terminal" ? "terminal-skin" : ""}`}>
          {skin === "terminal" && (
            <div className="terminal-bar">
              <span></span><span></span><span></span>
              <strong>gabriel@ascii:~/tplay</strong>
            </div>
          )}
          <video
            ref={videoRef}
            src={videoUrl}
            muted
            loop={loop}
            playsInline
            onEnded={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <canvas ref={canvasRef} />
        </div>

        <div className="card ascii-controls">
          <label className="field">video</label>
          <input type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
          <button className="ghost" onClick={() => { setVideoUrl(EXAMPLE_VIDEO); setFileName("motion-blocks.mp4"); setPlaying(true); }}>
            usar exemplo do lobby
          </button>

          <div className="icon-row">
            <button title="voltar 5s" onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 5); }}>-5s</button>
            <button className="icon-btn" title={playing ? "pausar" : "play"} onClick={() => setPlaying((p) => !p)}>
              {playing ? "||" : ">"}
            </button>
            <button title="avancar 5s" onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }}>+5s</button>
            <button className={loop ? "active" : ""} title="loop" onClick={() => setLoop((value) => !value)}>loop</button>
          </div>

          <label className="field">visual</label>
          <div className="segmented-control">
            <button className={skin === "terminal" ? "active" : ""} onClick={() => setSkin("terminal")}>terminal</button>
            <button className={skin === "clean" ? "active" : ""} onClick={() => setSkin("clean")}>canvas</button>
          </div>

          <label className="field">encaixe</label>
          <div className="segmented-control">
            <button className={fitMode === "fit" ? "active" : ""} onClick={() => setFitMode("fit")}>proporcao</button>
            <button className={fitMode === "fill" ? "active" : ""} onClick={() => setFitMode("fill")}>preencher terminal</button>
          </div>

          <label className="field">cor</label>
          <div className="segmented-control">
            <button className={mode === "green" ? "active" : ""} onClick={() => setMode("green")}>matrix</button>
            <button className={mode === "gray" ? "active" : ""} onClick={() => setMode("gray")}>gray</button>
            <button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>source</button>
          </div>

          <div className="control-stack">
            <div>
              <div className="row"><label className="field">tamanho</label><span className="value">{cellSize}px</span></div>
              <input type="range" min={5} max={18} value={cellSize} onChange={(e) => setCellSize(+e.target.value)} />
            </div>
            <div>
              <div className="row"><label className="field">contraste</label><span className="value">{contrast.toFixed(1)}x</span></div>
              <input type="range" min={0.6} max={2.2} step={0.1} value={contrast} onChange={(e) => setContrast(+e.target.value)} />
            </div>
            <div>
              <div className="row"><label className="field">velocidade video</label><span className="value">{playbackRate.toFixed(1)}x</span></div>
              <input type="range" min={0.25} max={2} step={0.25} value={playbackRate} onChange={(e) => setPlaybackRate(+e.target.value)} />
            </div>
            <div>
              <div className="row"><label className="field">velocidade chars</label><span className="value">{charSpeed.toFixed(1)}x</span></div>
              <input type="range" min={0} max={4} step={0.25} value={charSpeed} onChange={(e) => setCharSpeed(+e.target.value)} />
            </div>
            <div>
              <div className="row"><label className="field">frame skip</label><span className="value">1/{frameSkip}</span></div>
              <input type="range" min={1} max={6} value={frameSkip} onChange={(e) => setFrameSkip(+e.target.value)} />
            </div>
          </div>

          <label className="field">mapa de caracteres</label>
          <input type="text" value={chars} maxLength={48} onChange={(e) => setChars(e.target.value || "01")} />

          <button className="primary" onClick={downloadText}>exportar frame .txt</button>
          <button className="primary" disabled={recording} onClick={exportVideo}>
            {recording ? "gravando..." : "exportar video .webm"}
          </button>
        </div>
      </div>
    </div>
  );
}
