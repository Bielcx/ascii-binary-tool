import { useEffect, useState } from "react";
import UploadTrim from "./UploadTrim";
import Editor from "./Editor";
import AsciiPlayer from "./AsciiPlayer";
import type { VideoMeta, SegmentRange } from "./api";
import "./styles.css";

type Stage =
  | { step: "upload" }
  | { step: "ascii" }
  | { step: "edit"; meta: VideoMeta; segments: SegmentRange[] };

export default function App() {
  const [stage, setStage] = useState<Stage>(() => (
    window.location.hash === "#ascii" ? { step: "ascii" } : { step: "upload" }
  ));
  const [loadedVideo, setLoadedVideo] = useState<{ meta: VideoMeta; file: File } | null>(null);

  useEffect(() => {
    function syncHash() {
      if (window.location.hash === "#ascii") setStage({ step: "ascii" });
      else if (window.location.hash === "" || window.location.hash === "#upload") setStage({ step: "upload" });
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  return (
    <div>
      <div className="brand">ascii-binary-tool // local</div>
      <h1>editor de efeito binario</h1>

      {stage.step === "upload" && (
        <>
          <div className="tool-switch">
            <button className="active">editor de mascara</button>
            <button onClick={() => { window.location.hash = "ascii"; setStage({ step: "ascii" }); }}>ASCII Player</button>
          </div>
          <UploadTrim
            initialMeta={loadedVideo?.meta ?? null}
            initialFile={loadedVideo?.file ?? null}
            onReady={(meta, file, segments) => {
              setLoadedVideo({ meta, file });
              setStage({ step: "edit", meta, segments });
            }}
            onClear={() => setLoadedVideo(null)}
            onOpenAscii={() => { window.location.hash = "ascii"; setStage({ step: "ascii" }); }}
          />
        </>
      )}

      {stage.step === "ascii" && <AsciiPlayer onBack={() => { window.location.hash = "upload"; setStage({ step: "upload" }); }} />}

      {stage.step === "edit" && (
        <Editor
          meta={stage.meta}
          segments={stage.segments}
          onBack={() => setStage({ step: "upload" })}
        />
      )}
    </div>
  );
}
