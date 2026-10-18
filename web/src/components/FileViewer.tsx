import { useEffect, useState, type ReactNode } from "react";
import { fetchFileMeta, rawFileUrl, type FileMeta } from "@/lib/paths";

type Props = { path: string | null; onClose: () => void };

/** Bytes as the transcript writes them: "12 KB", not "12288 B". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit]}`;
}

/** The last segment of a path, for a title before the bridge has answered. */
function pathName(path: string): string {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name === "" ? path : name;
}

/**
 * What a clicked path contains. The transcript is text, so the panel is a
 * plain reader: one request per path, and the bridge decides what the file is.
 * A path that 404s is not an error to apologise for — the pane may be running
 * on another machine, where the file does exist.
 */
export function FileViewer({ path, onClose }: Props) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  // One read per path, and a response that lands after the selection moved on
  // is dropped: the panel must never show another file's bytes.
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setImageFailed(false);
    if (path !== null) {
      void fetchFileMeta(path).then((result) => {
        if (!cancelled) {
          setMeta(result);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (path === null) {
      return;
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [path, onClose]);

  if (path === null) {
    return null;
  }

  // Only these three kinds carry a name and a size; the other two are prose.
  const sized = meta !== null && meta.kind !== "missing" && meta.kind !== "error" ? meta : null;
  const name = sized !== null ? sized.name : pathName(path);

  function preview(): ReactNode {
    if (meta === null) {
      return <p className="viewer__note">reading…</p>;
    }
    if (meta.kind === "image") {
      if (imageFailed) {
        return <p className="viewer__note viewer__note--failed">the image could not be loaded</p>;
      }
      return (
        <img
          id="herdr-viewer-image"
          className="viewer__image"
          src={rawFileUrl(meta.path)}
          alt={meta.name}
          onError={() => setImageFailed(true)}
        />
      );
    }
    if (meta.kind === "text") {
      return (
        <>
          <pre id="herdr-viewer-text" className="viewer__text">
            {meta.text}
          </pre>
          {meta.truncated && (
            <p className="viewer__note">preview cut — the file is longer than the bridge returns</p>
          )}
        </>
      );
    }
    if (meta.kind === "other") {
      return (
        <p className="viewer__note">not previewable — {formatBytes(meta.bytes)} of binary data</p>
      );
    }
    if (meta.kind === "missing") {
      return (
        <p className="viewer__note">
          this file is not on this host — the pane may be running on another machine
        </p>
      );
    }
    return <p className="viewer__note viewer__note--failed">{meta.message}</p>;
  }

  return (
    <section
      className="viewer"
      role="dialog"
      aria-label={`Preview of ${name}`}
      data-kind={meta?.kind ?? "loading"}
    >
      <header className="viewer__head">
        <span className="viewer__name">{name}</span>
        {sized !== null && <span className="viewer__size">{formatBytes(sized.bytes)}</span>}
        <button
          type="button"
          id="herdr-viewer-close"
          className="viewer__close"
          aria-label="Close the preview"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <p className="viewer__path">{meta !== null ? meta.path : path}</p>
      <div className="viewer__body">{preview()}</div>
    </section>
  );
}
