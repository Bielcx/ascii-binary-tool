import { useEffect, useRef, useState, useCallback } from "react";
import {
  extractSegment,
  generateMasks,
  updateMask,
  copyMask,
  fetchPreview,
  exportVideo,
  storageUrl,
  uploadBackgroundImage,
  fetchAsciiFrame,
} from "./api";
import type { SegmentRange, VideoMeta, RenderParams } from "./api";
import type { MaskCopyTarget } from "./api";
import { EFFECT_PRESETS } from "./presets";
import type { EffectPreset, EffectType } from "./presets";

function hexToBgrString(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${b},${g},${r}`;
}

export default function Editor({
  meta,
  segments,
  onBack,
}: {
  meta: VideoMeta;
  segments: SegmentRange[];
  onBack: () => void;
}) {
  const [status, setStatus] = useState("extraindo frames do trecho...");
  const [frameUrls, setFrameUrls] = useState<string[]>([]);
  const [maskUrls, setMaskUrls] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState(1); // 1-based
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"mask" | "preview">("preview");
  const [brush, setBrush] = useState<"add" | "erase">("add");
  const [brushSize, setBrushSize] = useState(24);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);

  const [cellSize, setCellSize] = useState(14);
  const [scrollSpeed, setScrollSpeed] = useState(2);
  const [trailLen, setTrailLen] = useState(14);
  const [color, setColor] = useState("#46ff00");
  const [backgroundColor, setBackgroundColor] = useState("#000000");
  const [backgroundMode, setBackgroundMode] = useState<"color" | "video" | "image">("color");
  const [backgroundFit, setBackgroundFit] = useState<"cover" | "contain" | "stretch">("cover");
  const [charMap, setCharMap] = useState("01");
  const [colorMode, setColorMode] = useState<"solid" | "source" | "grayscale">("solid");
  const [effectTypes, setEffectTypes] = useState<EffectType[]>(["rain"]);
  const [intensity, setIntensity] = useState(1);
  const [effectLabel, setEffectLabel] = useState("REPROGRAMMING");
  const [labelBackground, setLabelBackground] = useState(false);
  const [sfxType, setSfxType] = useState<RenderParams["sfx_type"]>("none");
  const [sfxVolume, setSfxVolume] = useState(0.45);
  const [previewStep, setPreviewStep] = useState(1);
  const [backgroundImageName, setBackgroundImageName] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fullPreviewUrl, setFullPreviewUrl] = useState<string | null>(null);
  const [asciiDownloadUrl, setAsciiDownloadUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskDirty = useRef(false);
  const drawing = useRef(false);
  const setupStarted = useRef(false);
  const currentRef = useRef(current);
  // contador incrementado a cada troca de frame/modo - usado pra descartar
  // desenhos assincronos que ficaram "presos" atras de uma troca mais recente
  // (evita o frame/mascara errado aparecer se o usuario trocar rapido no filmstrip)
  const drawToken = useRef(0);

  const params: RenderParams = {
    cell_size: cellSize,
    scroll_speed: scrollSpeed,
    trail_len: trailLen,
    color: hexToBgrString(color),
    background_color: hexToBgrString(backgroundColor),
    background_mode: backgroundMode,
    background_fit: backgroundFit,
    char_map: charMap,
    color_mode: colorMode,
    effect_type: effectTypes[0] ?? "rain",
    effect_types: effectTypes,
    intensity,
    label: effectLabel,
    label_background: labelBackground,
    sfx_type: sfxType,
    sfx_volume: sfxVolume,
  };

  // ---- setup inicial: extrai frames + gera mascaras ----
  useEffect(() => {
    if (setupStarted.current) return;
    setupStarted.current = true;

    (async () => {
      try {
        setStatus("extraindo frames do trecho...");
        const seg = await extractSegment(meta.video_id, segments);
        setFrameUrls(seg.frame_urls);
        setStatus(`gerando mascaras (${seg.frame_count} frames, pode levar um tempo)...`);
        const m = await generateMasks(meta.video_id);
        setMaskUrls(m.mask_urls);
        setStatus("");
        setReady(true);
      } catch (e) {
        setStatus("erro: " + e);
      }
    })();
  }, [meta.video_id, segments]);

  // ---- desenha o frame atual no canvas (modo mascara ou preview) ----
  const drawMaskMode = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const myToken = ++drawToken.current;
    const frameImg = new Image();
    const maskImg = new Image();
    frameImg.crossOrigin = "anonymous";
    maskImg.crossOrigin = "anonymous";
    frameImg.src = storageUrl(frameUrls[current - 1]);
    maskImg.src = storageUrl(maskUrls[current - 1]) + `?t=${Date.now()}`;
    await Promise.all([
      new Promise((r) => (frameImg.onload = r)),
      new Promise((r) => (maskImg.onload = r)),
    ]);
    // se o usuario ja trocou de frame/modo enquanto essas imagens carregavam,
    // descarta esse desenho desatualizado
    if (myToken !== drawToken.current) return;
    canvas.width = frameImg.width;
    canvas.height = frameImg.height;
    const ctx = canvas.getContext("2d")!;
    ctx.globalAlpha = 0.45;
    ctx.drawImage(frameImg, 0, 0);
    ctx.globalAlpha = 1;

    // mascara em vermelho semi-transparente por cima
    const off = document.createElement("canvas");
    off.width = maskImg.width;
    off.height = maskImg.height;
    const offCtx = off.getContext("2d")!;
    offCtx.drawImage(maskImg, 0, 0);
    const imgData = offCtx.getImageData(0, 0, off.width, off.height);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = imgData.data[i];
      imgData.data[i] = 255;
      imgData.data[i + 1] = 40;
      imgData.data[i + 2] = 40;
      imgData.data[i + 3] = v > 30 ? 140 : 0;
    }
    offCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(off, 0, 0);
  }, [frameUrls, maskUrls, current]);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const drawPreviewFrame = useCallback(async (frameIndex: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const myToken = ++drawToken.current;
    const url = await fetchPreview(meta.video_id, frameIndex, params);
    if (myToken !== drawToken.current) { URL.revokeObjectURL(url); return false; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await new Promise((r) => (img.onload = r));
    if (myToken !== drawToken.current) { URL.revokeObjectURL(url); return false; }
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return true;
  }, [meta.video_id, cellSize, scrollSpeed, trailLen, color, backgroundColor, backgroundMode, backgroundFit, charMap, colorMode, effectTypes, intensity, effectLabel, labelBackground, sfxType, sfxVolume]);

  const drawPreviewMode = useCallback(async () => {
    await drawPreviewFrame(current);
  }, [current, drawPreviewFrame]);

  useEffect(() => {
    if (!ready) return;
    if (playing) return;
    if (mode === "mask") drawMaskMode();
    else drawPreviewMode();
  }, [ready, mode, current, playing, drawMaskMode, drawPreviewMode]);

  // ---- play: renderiza um frame por vez; nao dispara requisicoes em paralelo ----
  useEffect(() => {
    if (!playing || !ready || frameUrls.length === 0) return;
    let cancelled = false;
    setMode("preview");

    async function loop() {
      while (!cancelled) {
        const next = currentRef.current + previewStep > frameUrls.length
          ? 1
          : currentRef.current + previewStep;
        currentRef.current = next;
        setCurrent(next);
        await drawPreviewFrame(next);
        await new Promise((resolve) => window.setTimeout(resolve, Math.max(80, 1000 / meta.fps)));
      }
    }

    void loop();
    return () => { cancelled = true; };
  }, [playing, ready, frameUrls.length, meta.fps, previewStep, drawPreviewFrame]);

  function changeZoom(delta: number) {
    setZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + delta) * 100) / 100)));
  }

  function applyPreset(preset: EffectPreset) {
    setEffectTypes([preset.effectType]);
    setCharMap(preset.charMap);
    setColor(preset.color);
    setColorMode(preset.colorMode);
    setBackgroundMode(preset.backgroundMode === "image" && !backgroundImageName ? "color" : preset.backgroundMode);
    setCellSize(preset.cellSize);
    setTrailLen(preset.trailLen);
    setIntensity(preset.intensity);
  }

  function toggleEffectType(nextEffectType: EffectType) {
    setEffectTypes((current) => {
      const next = current.includes(nextEffectType)
        ? current.filter((effect) => effect !== nextEffectType)
        : [...current, nextEffectType];
      return next.length ? next : ["rain"];
    });
  }

  function presetIsActive(preset: EffectPreset) {
    return effectTypes.length === 1
      && effectTypes[0] === preset.effectType
      && charMap === preset.charMap
      && color === preset.color
      && colorMode === preset.colorMode
      && backgroundMode === preset.backgroundMode
      && cellSize === preset.cellSize
      && trailLen === preset.trailLen
      && intensity === preset.intensity;
  }

  const activePreset = EFFECT_PRESETS.find((preset) => presetIsActive(preset));

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.ctrlKey) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          changeZoom(0.25);
        } else if (e.key === "-") {
          e.preventDefault();
          changeZoom(-0.25);
        } else if (e.key === "0") {
          e.preventDefault();
          setZoom(1);
        }
        return;
      }
      if (isTyping || !ready) return;

      if (e.key === " ") {
        e.preventDefault();
        void saveMask(current).then(() => {
          setMode("preview");
          setPlaying((p) => !p);
        });
      } else if (e.key === "ArrowRight" || e.key.toLowerCase() === "l") {
        e.preventDefault();
        void selectFrame(current >= frameUrls.length ? 1 : current + 1);
      } else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "j") {
        e.preventDefault();
        void selectFrame(current <= 1 ? frameUrls.length : current - 1);
      } else if (e.key === "]") {
        e.preventDefault();
        setScrollSpeed((speed) => Math.min(8, speed + 1));
      } else if (e.key === "[") {
        e.preventDefault();
        setScrollSpeed((speed) => Math.max(0, speed - 1));
      } else if (/^[1-9]$/.test(e.key)) {
        const preset = EFFECT_PRESETS[Number(e.key) - 1];
        if (preset) {
          e.preventDefault();
          applyPreset(preset);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ready, current, frameUrls.length]);

  // ---- pintura de mascara ----
  function paintAt(x: number, y: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(x, y, brushSize, 0, Math.PI * 2);
    ctx.fillStyle = brush === "add" ? "rgba(255,40,40,0.9)" : "rgba(0,0,0,1)";
    if (brush === "erase") ctx.globalCompositeOperation = "destination-out";
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    maskDirty.current = true;
  }

  function toCanvasCoords(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  async function saveMask(frameIndex = current) {
    const canvas = canvasRef.current;
    if (!canvas || !maskDirty.current) return;
    maskDirty.current = false;
    // extrai so o canal de mascara (onde pintamos vermelho) como PNG grayscale
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const outCtx = out.getContext("2d")!;
    const outData = outCtx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
      // pixels vermelhos pintados/marcados viram branco na mascara.
      // so' o alpha discrimina de forma confiavel: o frame de fundo (desenhado
      // com globalAlpha=0.45) sempre fica com alpha ~115, independente de
      // quao claro o video seja - por isso nao da' pra usar o canal R aqui
      // (um frame claro sozinho passava de R>180 e virava mascara por engano).
      // mascara/pintura sempre resultam em alpha bem mais alto (~190-240).
      const isMasked = data.data[i + 3] > 160;
      const v = isMasked ? 255 : 0;
      outData.data[i] = v; outData.data[i + 1] = v; outData.data[i + 2] = v; outData.data[i + 3] = 255;
    }
    outCtx.putImageData(outData, 0, 0);
    const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), "image/png"));
    await updateMask(meta.video_id, frameIndex, blob);
    maskDirty.current = false;
    setStatus("mascara salva");
    setTimeout(() => setStatus(""), 1200);
  }

  async function selectFrame(idx: number) {
    if (idx === current) return;
    setPlaying(false);
    await saveMask(current);
    setCurrent(idx);
  }

  async function handleCopyMask(target: MaskCopyTarget) {
    try {
      await saveMask(current);
      const result = await copyMask(meta.video_id, current, target);
      const count = result.updated_frames.length;
      if (count === 0) {
        setStatus("nao ha frames nesse sentido");
      } else {
        setStatus(`mascara aplicada em ${count} frame(s)`);
      }
      setTimeout(() => setStatus(""), 1400);
    } catch (e) {
      alert("erro ao propagar mascara: " + e);
    }
  }

  function toggleExclude(i: number) {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  async function handleBackgroundImage(file: File) {
    try {
      setStatus("enviando imagem de fundo...");
      await uploadBackgroundImage(meta.video_id, file);
      setBackgroundImageName(file.name);
      setBackgroundMode("image");
      setStatus("imagem de fundo pronta");
      setTimeout(() => setStatus(""), 1200);
    } catch (e) {
      alert("erro ao enviar imagem de fundo: " + e);
      setStatus("");
    }
  }

  async function handleExport() {
    setExporting(true);
    setDownloadUrl(null);
    setFullPreviewUrl(null);
    try {
      await saveMask(current);
      const url = await exportVideo(meta.video_id, params, Array.from(excluded));
      setFullPreviewUrl(url);
      setDownloadUrl(url);
    } catch (e) {
      alert("erro no export: " + e);
    } finally {
      setExporting(false);
    }
  }

  async function handleAsciiExport() {
    try {
      await saveMask(current);
      const text = await fetchAsciiFrame(meta.video_id, current, params);
      if (asciiDownloadUrl) URL.revokeObjectURL(asciiDownloadUrl);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      setAsciiDownloadUrl(URL.createObjectURL(blob));
      setStatus("ASCII do frame pronto");
      setTimeout(() => setStatus(""), 1200);
    } catch (e) {
      alert("erro no export ASCII: " + e);
    }
  }

  if (!ready) {
    return (
      <div className="card">
        <p className="status-line">{status}</p>
      </div>
    );
  }

  return (
    <div>
      <button className="ghost" onClick={onBack} style={{ marginBottom: 16 }}>
        voltar para trecho
      </button>

      <div className="editor-layout">
        <div>
          <div className="stage">
            <canvas
              ref={canvasRef}
              style={{
                width: `${zoom * 100}%`,
                maxWidth: zoom === 1 ? "100%" : "none",
                maxHeight: zoom === 1 ? "100%" : "none",
              }}
              onMouseDown={(e) => {
                if (mode !== "mask") return;
                drawing.current = true;
                const { x, y } = toCanvasCoords(e);
                paintAt(x, y);
              }}
              onMouseMove={(e) => {
                if (mode !== "mask" || !drawing.current) return;
                const { x, y } = toCanvasCoords(e);
                paintAt(x, y);
              }}
              onMouseUp={() => { drawing.current = false; saveMask(); }}
              onMouseLeave={() => { if (drawing.current) { drawing.current = false; saveMask(); } }}
            />
          </div>

          <div className="editor-toolbar">
            <div className="toolbar-group">
            <button
              className={mode === "mask" ? "primary" : ""}
              onClick={async () => {
                if (mode !== "mask") await saveMask(current);
                setMode("mask");
              }}
            >
              editar mascara
            </button>
            <button
              className={mode === "preview" ? "primary" : ""}
              onClick={async () => {
                await saveMask(current);
                setMode("preview");
              }}
            >
              preview do efeito
            </button>
            <button onClick={async () => {
              await saveMask(current);
              setPlaying((p) => !p);
            }}>
              {playing ? "pausar" : "play"}
            </button>
            </div>
            <div className="zoom-controls">
              <button title="Ctrl -" onClick={() => changeZoom(-0.25)}>-</button>
              <span className="value">{Math.round(zoom * 100)}%</span>
              <button title="Ctrl +" onClick={() => changeZoom(0.25)}>+</button>
              <button title="Ctrl 0" onClick={() => setZoom(1)}>100%</button>
            </div>
            <div className="zoom-controls">
              <button title="frame anterior" onClick={() => selectFrame(current <= 1 ? frameUrls.length : current - 1)}>J</button>
              <span className="value">{current}/{frameUrls.length}</span>
              <button title="proximo frame" onClick={() => selectFrame(current >= frameUrls.length ? 1 : current + 1)}>L</button>
            </div>
          </div>

          {mode === "mask" && (
            <div className="mask-tools">
              <div className="brush-row">
                <button className={`brush-btn ${brush === "add" ? "active" : ""}`} onClick={() => setBrush("add")}>
                  + pincel (incluir)
                </button>
                <button className={`brush-btn ${brush === "erase" ? "active" : ""}`} onClick={() => setBrush("erase")}>
                  - borracha (remover)
                </button>
                <input
                  type="range" min={4} max={80} value={brushSize}
                  onChange={(e) => setBrushSize(parseInt(e.target.value))}
                  style={{ width: 120 }}
                />
              </div>
              <div className="propagate-row">
                <span>propagar mascara atual</span>
                <button onClick={() => handleCopyMask("previous")} disabled={current <= 1}>
                  frame anterior
                </button>
                <button onClick={() => handleCopyMask("next")} disabled={current >= frameUrls.length}>
                  proximo frame
                </button>
                <button onClick={() => handleCopyMask("backward")} disabled={current <= 1}>
                  anteriores
                </button>
                <button onClick={() => handleCopyMask("forward")} disabled={current >= frameUrls.length}>
                  proximos
                </button>
                <button onClick={() => handleCopyMask("all")} disabled={frameUrls.length <= 1}>
                  todos
                </button>
              </div>
            </div>
          )}

          <p className="status-line" style={{ textAlign: "center" }}>{status}</p>

          <div className="filmstrip">
            {frameUrls.map((url, i) => {
              const idx = i + 1;
              return (
                <div
                  key={idx}
                  className={`filmstrip-frame ${current === idx ? "active" : ""} ${excluded.has(idx) ? "excluded" : ""}`}
                  onClick={() => { selectFrame(idx); }}
                >
                  <img src={storageUrl(url)} />
                  <span className="idx">{idx}</span>
                  <span
                    className="remove-badge"
                    onClick={(e) => { e.stopPropagation(); toggleExclude(idx); }}
                  >
                    {excluded.has(idx) ? "x" : "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="sidebar">
          <div className="card">
            <div className="section-title">parametros do efeito</div>
            <p className="helper-text">Fluxo recomendado: escolha um estilo base ou combine camadas, ajuste intensidade/cor, defina o fundo e deixe o resto no ajuste fino.</p>

            <div className="effect-group">
              <div className="panel-step">1. escolha um estilo base</div>
              <label className="field">preset rapido</label>
              <select
                value={activePreset?.id ?? ""}
                onChange={(e) => {
                  const preset = EFFECT_PRESETS.find((item) => item.id === e.target.value);
                  if (preset) applyPreset(preset);
                }}
              >
                {!activePreset && <option value="">customizado</option>}
                {EFFECT_PRESETS.map((preset, index) => (
                  <option key={preset.id} value={preset.id}>
                    {index + 1}. {preset.name} - {preset.hint}
                  </option>
                ))}
              </select>
            </div>

            <div className="effect-group">
              <div className="panel-step">2. combine camadas</div>
              <label className="field">efeitos ativos</label>
              <div className="effect-type-grid">
                <button className={effectTypes.includes("rain") ? "active" : ""} onClick={() => toggleEffectType("rain")}>
                  binary rain
                </button>
                <button className={effectTypes.includes("tracking") ? "active" : ""} onClick={() => toggleEffectType("tracking")}>
                  tracking box
                </button>
                <button className={effectTypes.includes("mesh") ? "active" : ""} onClick={() => toggleEffectType("mesh")}>
                  mesh lines
                </button>
                <button className={effectTypes.includes("blink") ? "active" : ""} onClick={() => toggleEffectType("blink")}>
                  blink pulse
                </button>
                <button className={effectTypes.includes("reveal") ? "active" : ""} onClick={() => toggleEffectType("reveal")}>
                  scan reveal
                </button>
                <button className={effectTypes.includes("glitch") ? "active" : ""} onClick={() => toggleEffectType("glitch")}>
                  glitch panel
                </button>
              </div>
            </div>

            <div className="effect-group">
              <div className="panel-step">3. ajuste a forca</div>
              <div className="row">
                <label className="field">intensidade</label>
                <span className="value">{intensity.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={intensity}
                onChange={(e) => setIntensity(+e.target.value)}
              />
              {(effectTypes.includes("tracking") || effectTypes.includes("mesh") || effectTypes.includes("glitch")) && (
                <>
                  <input
                    type="text"
                    value={effectLabel}
                    maxLength={18}
                    onChange={(e) => setEffectLabel(e.target.value)}
                    placeholder="label"
                    style={{ marginTop: 8 }}
                  />
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={labelBackground}
                      onChange={(e) => setLabelBackground(e.target.checked)}
                    />
                    fundo do label
                  </label>
                </>
              )}
            </div>

            <div className="effect-group">
              <div className="panel-step">4. som local no trecho</div>
              <label className="field">efeito sonoro</label>
              <select value={sfxType} onChange={(e) => setSfxType(e.target.value as RenderParams["sfx_type"])}>
                <option value="none">sem som extra</option>
                <option value="tech">tech hum</option>
                <option value="spatial">espacial</option>
                <option value="zap">raio / energia</option>
                <option value="glitch">glitch digital</option>
              </select>
              {sfxType !== "none" && (
                <div style={{ marginTop: 10 }}>
                  <div className="row">
                    <label className="field">volume do SFX</label>
                    <span className="value">{Math.round(sfxVolume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={1.2}
                    step={0.05}
                    value={sfxVolume}
                    onChange={(e) => setSfxVolume(+e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="effect-group">
              <div className="panel-step">5. cor dos caracteres</div>
              <label className="field">aparencia dos caracteres</label>
              <div className="segmented-control">
                <button className={colorMode === "solid" ? "active" : ""} onClick={() => setColorMode("solid")}>
                  cor fixa
                </button>
                <button className={colorMode === "source" ? "active" : ""} onClick={() => setColorMode("source")}>
                  cor do video
                </button>
                <button className={colorMode === "grayscale" ? "active" : ""} onClick={() => setColorMode("grayscale")}>
                  cinza
                </button>
              </div>
              {colorMode === "solid" && (
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="color-input"
                />
              )}
            </div>

            <div className="effect-group">
              <div className="panel-step">6. fundo do efeito</div>
              <label className="field">fundo</label>
              <div className="segmented-control">
                <button
                  className={backgroundMode === "color" ? "active" : ""}
                  onClick={() => setBackgroundMode("color")}
                >
                  cor solida
                </button>
                <button
                  className={backgroundMode === "video" ? "active" : ""}
                  onClick={() => setBackgroundMode("video")}
                >
                  video original
                </button>
                <button
                  className={backgroundMode === "image" ? "active" : ""}
                  onClick={() => setBackgroundMode("image")}
                  disabled={!backgroundImageName}
                >
                  imagem
                </button>
              </div>
              {backgroundMode === "color" && (
                <input
                  type="color"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  className="color-input"
                />
              )}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && handleBackgroundImage(e.target.files[0])}
                style={{ marginTop: 8, width: "100%" }}
              />
              {backgroundImageName && (
                <p className="status-line">imagem: {backgroundImageName}</p>
              )}
            </div>

            <details className="advanced-panel">
              <summary>ajuste fino</summary>
              <div className="control-stack">
                <div>
                  <div className="row">
                    <label className="field">detalhe</label>
                    <span className="value">{cellSize}px</span>
                  </div>
                  <input type="range" min={8} max={28} value={cellSize} onChange={(e) => setCellSize(+e.target.value)} />
                </div>

                <div>
                  <div className="row">
                    <label className="field">velocidade</label>
                    <span className="value">{scrollSpeed}</span>
                  </div>
                  <input type="range" min={0} max={8} value={scrollSpeed} onChange={(e) => setScrollSpeed(+e.target.value)} />
                </div>

                <div>
                  <div className="row">
                    <label className="field">onda</label>
                    <span className="value">{trailLen}</span>
                  </div>
                  <input type="range" min={4} max={40} value={trailLen} onChange={(e) => setTrailLen(+e.target.value)} />
                </div>

                <div>
                  <div className="row">
                    <label className="field">preview leve</label>
                    <span className="value">1/{previewStep}</span>
                  </div>
                  <input type="range" min={1} max={5} value={previewStep} onChange={(e) => setPreviewStep(+e.target.value)} />
                </div>

                <div>
                  <label className="field">mapa de caracteres</label>
                  <input
                    type="text"
                    value={charMap}
                    maxLength={32}
                    onChange={(e) => setCharMap(e.target.value || "01")}
                  />
                </div>

                <div>
                  <label className="field">encaixe da imagem de fundo</label>
                  <div className="segmented-control">
                    <button className={backgroundFit === "cover" ? "active" : ""} onClick={() => setBackgroundFit("cover")}>
                      cover
                    </button>
                    <button className={backgroundFit === "contain" ? "active" : ""} onClick={() => setBackgroundFit("contain")}>
                      contain
                    </button>
                    <button className={backgroundFit === "stretch" ? "active" : ""} onClick={() => setBackgroundFit("stretch")}>
                      stretch
                    </button>
                  </div>
                </div>
              </div>
            </details>
          </div>
          <div className="card">
            <div className="section-title">frames excluidos</div>
            <p className="status-line">
              {excluded.size === 0 ? "nenhum" : `${excluded.size} frame(s) removido(s) do trecho`}
            </p>
          </div>

          <div className="card">
            <div className="section-title">exportar</div>
            <button className="primary" style={{ width: "100%" }} disabled={exporting} onClick={handleExport}>
              {exporting ? "renderizando..." : "gerar preview completo"}
            </button>
            {fullPreviewUrl && (
              <video
                src={fullPreviewUrl}
                controls
                style={{ width: "100%", marginTop: 12, background: "#000", borderRadius: 4 }}
              />
            )}
            {downloadUrl && (
              <p style={{ marginTop: 12 }}>
                <a className="download-link" href={downloadUrl} target="_blank" rel="noreferrer">
                  baixar resultado
                </a>
              </p>
            )}
            <button className="ghost" style={{ width: "100%", marginTop: 10 }} onClick={handleAsciiExport}>
              exportar frame ASCII
            </button>
            {asciiDownloadUrl && (
              <p style={{ marginTop: 12 }}>
                <a className="download-link" href={asciiDownloadUrl} download={`frame_${current}_ascii.txt`}>
                  baixar .txt
                </a>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

