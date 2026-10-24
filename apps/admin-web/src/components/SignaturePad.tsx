"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** Called after every stroke with the drawing as a PNG data URL, or null once cleared. */
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
  /** Internal drawing resolution (the exported PNG size). The element scales to its container. */
  width?: number;
  height?: number;
}

/**
 * Draw-a-signature canvas for mouse, finger or stylus (Pointer Events + touch-action: none so the page does not
 * scroll while signing). It only produces an image: WHO signed is established by the signer's login, and the server
 * re-checks the PNG (type, size, not empty) - nothing here is trusted.
 */
export default function SignaturePad({ onChange, disabled = false, width = 600, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const point = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * canvas.width, y: ((e.clientY - rect.top) / rect.height) * canvas.height };
  }, []);

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    // A tap leaves a dot.
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setHasInk(true);
    onChange(canvasRef.current!.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        data-testid="signature-canvas"
        aria-label="Signature area: draw your signature with your finger, a stylus or the mouse"
        className={`w-full rounded-lg border-2 border-dashed ${disabled ? "border-gray-200 bg-gray-50" : "border-gray-400 bg-white"}`}
        style={{ touchAction: "none", aspectRatio: `${width} / ${height}`, cursor: disabled ? "not-allowed" : "crosshair" }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
      />
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{hasInk ? "Signature captured. Clear it to draw again." : "Sign inside the box."}</span>
        <button type="button" onClick={clear} disabled={disabled || !hasInk} className="font-medium text-[var(--theme-accent)] disabled:text-gray-400">
          Clear
        </button>
      </div>
    </div>
  );
}
