import { useEffect, useMemo, useState } from "react";
import { renderMarkdownToHtml } from "../lib/markdown";
import { isDesktopRuntime } from "../lib/desktopBridge";
import { readTextPreview } from "../services/previewService";

type MarkdownPreviewProps = {
  fileId: string;
  fileName: string;
};

export const MarkdownPreview = ({ fileId, fileName }: MarkdownPreviewProps) => {
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
        console.warn("Failed to load markdown preview.", error);
        setStatus("error");
      });

    return () => {
      isActive = false;
    };
  }, [fileId, fileName]);

  const html = useMemo(() => renderMarkdownToHtml(content), [content]);

  if (status === "loading") {
    return <div className="preview-markdown-status">Loading markdown preview...</div>;
  }

  if (status === "error") {
    return <div className="preview-markdown-status">Preview unavailable for this file.</div>;
  }

  return (
    <article
      className="preview-markdown"
      aria-label={`Markdown preview of ${fileName}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
