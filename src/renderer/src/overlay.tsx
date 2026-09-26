import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_ACCENT, type Accent } from "../../core/color";
import { Orb } from "./orb/Orb";
import "./overlay.css";

// The pill at the bottom of the screen: Vesper's own orb (live, reacting to the mic or to its own
// voice), a glowing waveform, and a timer. It shows what was heard, then tucks away.

type State =
  "listening" | "dictating" | "transcribing" | "heard" | "speaking" | "hidden";
type Payload = {
  state: State;
  text?: string;
  startedAt?: number;
  accent?: Accent;
};

const LABEL: Partial<Record<State, string>> = {
  listening: "Listening",
  dictating: "Dictating",
  transcribing: "Transcribing",
};

function Pill() {
  const [p, setP] = useState<Payload>({ state: "hidden" });
  const [, tick] = useState(0);
  const level = useRef(0);
  const levels = useRef<number[]>(Array(48).fill(0));
  const wave = useRef<HTMLCanvasElement>(null);
  const state = useRef<State>("hidden");
  state.current = p.state;
  const hue = useRef(DEFAULT_ACCENT.hue);
  hue.current = (p.accent ?? DEFAULT_ACCENT).hue;

  useEffect(() => {
    const offs = [
      window.bluevis.on("overlay", (x) =>
        setP((prev) => ({
          ...prev,
          ...(x as Payload),
          text: (x as Payload).text,
        })),
      ),
      window.bluevis.on("overlay:level", (l) => (level.current = l as number)),
    ];
    window.bluevis.overlay.ready();
    return () => offs.forEach((off) => void off());
  }, []);

  // Timer text.
  useEffect(() => {
    if (p.state !== "listening" && p.state !== "dictating") return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [p.state]);

  // Waveform: a smoothed history of the level, drawn as a mirrored ribbon with a soft glow.
  useEffect(() => {
    const c = wave.current!;
    const g = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    g.scale(dpr, dpr);
    let raf = 0;
    let t = 0;
    let smooth = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const w = c.clientWidth;
      const h = c.clientHeight;
      const s = state.current;
      t += 1 / 60;
      const target =
        s === "transcribing"
          ? 0.18
          : s === "hidden" || s === "heard"
            ? 0
            : Math.min(1, level.current * 1.7);
      smooth += (target - smooth) * 0.25;
      levels.current.push(smooth);
      levels.current.shift();
      g.clearRect(0, 0, w, h);
      const grad = g.createLinearGradient(0, 0, w, 0);
      const edge = `oklch(0.7 0.15 ${hue.current})`;
      const core = `oklch(0.9 0.1 ${hue.current + 30})`;
      grad.addColorStop(0, edge);
      grad.addColorStop(0.5, core);
      grad.addColorStop(1, edge);
      const n = levels.current.length;
      for (const layer of [0, 1]) {
        g.beginPath();
        for (let i = 0; i <= n; i++) {
          const x = (i / n) * w;
          // Edges taper to zero so the ribbon floats; the transcribing shimmer travels left to right.
          const taper = Math.sin((i / n) * Math.PI);
          const amp =
            (levels.current[Math.min(n - 1, i)] * 0.85 + 0.06) *
            taper *
            (h / 2 - 2);
          const y =
            h / 2 +
            Math.sin(
              i * 0.55 - t * (s === "transcribing" ? 9 : 6) + layer * 1.7,
            ) *
              amp *
              (layer ? 0.55 : 1);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = grad;
        g.globalAlpha = layer ? 0.45 : 1;
        g.lineWidth = layer ? 1.2 : 2;
        g.shadowColor = core;
        g.shadowBlur = layer ? 0 : 10;
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const accent = p.accent ?? DEFAULT_ACCENT;
  useEffect(() => {
    document.documentElement.style.setProperty("--hue", String(accent.hue));
  }, [accent.hue]);

  const secs = Math.max(
    0,
    Math.floor((Date.now() - (p.startedAt ?? Date.now())) / 1000),
  );
  const live =
    p.state === "listening" ||
    p.state === "dictating" ||
    p.state === "speaking";
  const api = window.bluevis.overlay;
  return (
    <div className="pill-row" data-state={p.state}>
      <button
        className="pill-close"
        data-show={live}
        aria-label="Stop"
        onMouseEnter={() => api.hover(true)}
        onMouseLeave={() => api.hover(false)}
        onClick={() => {
          api.hover(false);
          api.close();
        }}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path
            d="M2.5 2.5l7 7M9.5 2.5l-7 7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <div className="pill" data-state={p.state} data-live={live}>
        <div className="pill-glow" />
        <div className="pill-orb">
          <Orb
            mode={
              p.state === "speaking"
                ? "speaking"
                : p.state === "transcribing"
                  ? "thinking"
                  : "listening"
            }
            level={() => level.current}
            moons={0}
            size={52}
            radius={0.6}
            accent={accent}
          />
        </div>
        {LABEL[p.state] && <span className="pill-label">{LABEL[p.state]}</span>}
        <canvas className="pill-wave" ref={wave} />
        <span className="pill-text">{p.text}</span>
        {(p.state === "listening" || p.state === "dictating") && (
          <span className="pill-time">
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Pill />);
