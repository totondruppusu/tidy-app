import { useEffect, useMemo, useState } from "react";
import {
  getTextPreviewDescriptor,
  highlightCodeLine,
} from "../lib/codePreview";
import { isDesktopRuntime } from "../lib/desktopBridge";
import { readTextPreview } from "../services/previewService";

type TextPreviewProps = {
  fileId: string;
  fileName: string;
};

export const TextPreview = ({ fileId, fileName }: TextPreviewProps) => {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let isActive = true;
    setContent("");
    setStatus("loading");

    if (!isDesktopRuntime()) {
      setStatus("error");
      return;
    }

    readTextPreview(fileId)
      .then((text) => {
        if (!isActive) {
          return;
        }
        setContent(text);
        setStatus("ready");
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        console.warn("Failed to load text preview.", error);
        setStatus("error");
      });

    return () => {
      isActive = false;
    };
  }, [fileId]);

  const descriptor = useMemo(() => getTextPreviewDescriptor(fileName), [fileName]);
  const codeHtml = useMemo(() => {
    if (descriptor.kind !== "code" || content.length === 0) {
      return "";
    }
    return content
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => (line.length === 0 ? " " : highlightCodeLine(line, descriptor.language)))
      .join("\n");
  }, [content, descriptor.kind, descriptor.language]);

  if (status === "loading") {
    return <div className="preview-text-status">Loading text preview...</div>;
  }

  if (status === "error") {
    return <div className="preview-text-status">Preview unavailable for this file.</div>;
  }

  return (
    <section className="preview-text" aria-label={`${descriptor.kind === "code" ? "Code" : "Text"} preview of ${fileName}`}>
      <header className="preview-text-header">
        <span className="preview-text-badge">{descriptor.label}</span>
      </header>
      {descriptor.kind === "code" ? (
        <article className="preview-text-panel is-code">
          {content.length === 0 ? (
            <div className="preview-text-empty">File is empty.</div>
          ) : (
            <pre className="preview-text-code-scroll">
              <code
                className="preview-text-code"
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </pre>
          )}
        </article>
      ) : (
        <pre className="preview-text-panel is-plain">{content}</pre>
      )}
    </section>
  );
};
