# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["mlx-audio>=0.2", "misaki[en]", "mlx-whisper", "soundfile", "numpy", "fastembed", "pocket-tts"]
# ///
"""Vesper local sidecar.

Speech-to-text with Whisper (MLX), text-to-speech with Kokoro (MLX) and small
CPU text embeddings for vault retrieval (fastembed, bge-small), served on
localhost only. Models load lazily on first use (or via POST /warm) and stay
resident. Started and stopped by the Electron main process.
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

STT_MODEL = os.environ.get("BLUEVIS_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
TTS_MODEL = os.environ.get("BLUEVIS_TTS_MODEL", "mlx-community/Kokoro-82M-bf16")
EMBED_MODEL = os.environ.get("BLUEVIS_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
SAMPLE_RATE = 24000
# Bump when endpoints change so the app replaces an older running sidecar.
VERSION = 5

# MLX is not thread-safe; serialize all model work.
lock = threading.Lock()
state = {"tts": None, "stt_ready": False, "embed": None, "pocket": None, "pocket_voices": {}}
# Pocket TTS runs on CPU (PyTorch), separately from MLX.
pocket_lock = threading.Lock()
# Embeddings run on CPU (onnxruntime), so they do not contend with MLX for the lock.
embed_lock = threading.Lock()


def log(*args):
    print("[voice]", *args, file=sys.stderr, flush=True)


def get_tts():
    if state["tts"] is None:
        from mlx_audio.tts.utils import load_model

        t = time.time()
        state["tts"] = load_model(TTS_MODEL)
        log(f"tts loaded in {time.time() - t:.1f}s")
    return state["tts"]


def embed(texts, query):
    if state["embed"] is None:
        from fastembed import TextEmbedding

        t = time.time()
        state["embed"] = TextEmbedding(EMBED_MODEL)
        log(f"embeddings loaded in {time.time() - t:.1f}s")
    model = state["embed"]
    vectors = model.query_embed(texts) if query else model.embed(texts, batch_size=64)
    return [[round(float(x), 5) for x in v] for v in vectors]


def transcribe(path):
    import mlx_whisper

    t = time.time()
    # Names Whisper would otherwise mishear; it biases spelling, not content.
    vocab = "Vesper, Codex, Claude, Opus, Sonnet, Haiku, Gemini, GPT, Luna, Sol, Astra, Yonder, Devpost, Canvas, Rutgers, Anuj, Obsidian, repo, npm, TypeScript."
    result = mlx_whisper.transcribe(path, path_or_hf_repo=STT_MODEL, language="en", initial_prompt=vocab)
    state["stt_ready"] = True
    log(f"stt {time.time() - t:.2f}s")
    return result["text"].strip()


def synthesize_pocket(text, voice):
    if state["pocket"] is None:
        from pocket_tts import TTSModel

        t = time.time()
        state["pocket"] = TTSModel.load_model()
        log(f"pocket tts loaded in {time.time() - t:.1f}s")
    model = state["pocket"]
    if voice not in state["pocket_voices"]:
        state["pocket_voices"][voice] = model.get_state_for_audio_prompt(voice)
    audio = model.generate_audio(state["pocket_voices"][voice], text).numpy()
    buf = io.BytesIO()
    sf.write(buf, audio, model.sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def synthesize(text, voice, speed):
    """Voices are "pocket:<name>" (Kyutai Pocket TTS) or a Kokoro voice id like "bm_george"."""
    if voice.startswith("pocket:"):
        with pocket_lock:
            return synthesize_pocket(text, voice.split(":", 1)[1])
    model = get_tts()
    lang = "b" if voice.startswith("b") else "a"
    chunks = [np.array(r.audio) for r in model.generate(text=text, voice=voice, speed=speed, lang_code=lang)]
    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "version": VERSION, "tts": state["tts"] is not None, "stt": state["stt_ready"], "embed": state["embed"] is not None})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/stt":
                data = self.body()
                tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"bluevis-stt-{os.getpid()}.wav")
                with open(tmp, "wb") as f:
                    f.write(data)
                with lock:
                    text = transcribe(tmp)
                return self.reply(200, {"text": text})
            if self.path == "/tts":
                req = json.loads(self.body() or b"{}")
                voice = req.get("voice", "bm_george")
                if voice.startswith("pocket:"):
                    wav = synthesize(req.get("text", ""), voice, 1.0)
                else:
                    with lock:
                        wav = synthesize(req.get("text", ""), voice, float(req.get("speed", 1.0)))
                return self.reply(200, wav, "audio/wav")
            if self.path == "/shutdown":
                self.reply(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path == "/embed":
                req = json.loads(self.body() or b"{}")
                with embed_lock:
                    vectors = embed(req.get("texts", []), bool(req.get("query")))
                return self.reply(200, {"model": EMBED_MODEL, "vectors": vectors})
            if self.path == "/warm":
                voice = json.loads(self.body() or b"{}").get("voice", "bm_george")
                if voice.startswith("pocket:"):
                    synthesize("Ready.", voice, 1.0)
                with lock:
                    get_tts()
                    synthesize("Ready.", "bm_george", 1.0)
                    silent = os.path.join(os.environ.get("TMPDIR", "/tmp"), "bluevis-warm.wav")
                    sf.write(silent, np.zeros(16000, dtype=np.float32), 16000)
                    transcribe(silent)
                return self.reply(200, {"ok": True})
            self.reply(404, {"error": "not found"})
        except Exception as e:  # surfaced to the UI as a voice error
            log("error", repr(e))
            self.reply(500, {"error": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("BLUEVIS_VOICE_PORT", "47821"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log(f"listening on 127.0.0.1:{port}")
    server.serve_forever()
