import { useState } from "react";
import UploadTrim from "./UploadTrim";
import Editor from "./Editor";
import AsciiPlayer from "./AsciiPlayer";
import type { VideoMeta, SegmentRange } from "./api";
import type { EffectPreset } from "./presets";
import "./styles.css";

type Stage =
  | { step: "upload" }
  | { step: "ascii" }
  | { step: "edit"; meta: VideoMeta; segments: SegmentRange[]; preset?: EffectPreset };

export default function App() {
  const [stage, setStage] = useState<Stage>({ step: "upload" });
  const [loadedVideo, setLoadedVideo] = useState<{ meta: VideoMeta; file: File } | null>(null);

  return (
    <div>
      <div className="brand">ascii-binary-tool // local</div>
      <h1>editor de efeito binario</h1>

      {stage.step === "upload" && (
        <>
          <div className="tool-switch">
            <button className="active">editor de mascara</button>
            <button onClick={() => setStage({ step: "ascii" })}>ASCII Player</button>
          </div>
          <UploadTrim
            initialMeta={loadedVideo?.meta ?? null}
            initialFile={loadedVideo?.file ?? null}
            onReady={(meta, file, segments, preset) => {
              setLoadedVideo({ meta, file });
              setStage({ step: "edit", meta, segments, preset });
            }}
            onClear={() => setLoadedVideo(null)}
            onOpenAscii={() => setStage({ step: "ascii" })}
          />
        </>
      )}

      {stage.step === "ascii" && <AsciiPlayer onBack={() => setStage({ step: "upload" })} />}

      {stage.step === "edit" && (
        <Editor
          meta={stage.meta}
          segments={stage.segments}
          initialPreset={stage.preset}
          onBack={() => setStage({ step: "upload" })}
        />
      )}
    </div>
  );
}
