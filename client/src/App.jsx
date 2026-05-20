import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as faceapi from "face-api.js";
import html2canvas from "html2canvas";
import { io } from "socket.io-client";
import { calculateRizzScore, getTier } from "./score";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
const MODEL_BASE = `${import.meta.env.BASE_URL || "/"}models`.replace(/\/+$/, "");

const socket = io(SERVER_URL, {
  transports: ["websocket"],
  autoConnect: false
});

function formatTier(t) {
  if (!t) return "—";
  return `${t.tier} ${t.division}`;
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const scoreCardRef = useRef(null);
  const scoreIntervalRef = useRef(null);
  const tweenRef = useRef(null);

  const [modelsStatus, setModelsStatus] = useState("loading");
  const [modelsError, setModelsError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");

  const [detected, setDetected] = useState(false);
  const [rawScore, setRawScore] = useState(0);
  const [displayScore, setDisplayScore] = useState(0);

  const [mode, setMode] = useState("solo");

  const [mmr, setMmr] = useState(1000);
  const [rankTier, setRankTier] = useState({ tier: "Silver", division: "II" });

  const [rankPhase, setRankPhase] = useState("idle");
  const [queueHint, setQueueHint] = useState("");
  const [queuePosition, setQueuePosition] = useState(0);
  const [matchEndsAt, setMatchEndsAt] = useState(null);
  const [opponentMeta, setOpponentMeta] = useState(null);
  const [opponentLive, setOpponentLive] = useState(0);
  const [myPeak, setMyPeak] = useState(0);
  const [theirPeak, setTheirPeak] = useState(0);
  const [opponentVisible, setOpponentVisible] = useState(false);

  const [duelResult, setDuelResult] = useState(null);
  const [serverMessage, setServerMessage] = useState("");

  const [countdownMs, setCountdownMs] = useState(null);

  const tier = useMemo(() => getTier(displayScore), [displayScore]);

  const loadModels = useCallback(async () => {
    setModelsStatus("loading");
    setModelsError("");
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_BASE)
      ]);
      setModelsStatus("ready");
    } catch (e) {
      setModelsStatus("error");
      setModelsError(e?.message || "Could not load models");
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (!socket.connected) socket.connect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraReady(true);
        setCameraError("");
      } catch {
        setCameraError("Camera blocked or unavailable.");
      }
    };
    void startCamera();
    return () => {
      cancelled = true;
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  useEffect(() => {
    const animate = () => {
      setDisplayScore((prev) => prev + (rawScore - prev) * 0.22);
      tweenRef.current = requestAnimationFrame(animate);
    };
    tweenRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(tweenRef.current);
  }, [rawScore]);

  useEffect(() => {
    if (rankPhase !== "match" || !matchEndsAt) {
      setCountdownMs(null);
      return;
    }
    const tick = () => setCountdownMs(Math.max(0, matchEndsAt - Date.now()));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [rankPhase, matchEndsAt]);

  useEffect(() => {
    const faceOk = modelsStatus === "ready" && cameraReady;
    if (!faceOk) return;

    scoreIntervalRef.current = setInterval(async () => {
      if (!videoRef.current || !canvasRef.current) return;
      const result = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.45 }))
        .withFaceLandmarks();
      const dims = faceapi.matchDimensions(canvasRef.current, videoRef.current, true);
      const resized = result ? faceapi.resizeResults(result, dims) : null;
      const ctx = canvasRef.current.getContext("2d");
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

      if (resized) {
        setDetected(true);
        faceapi.draw.drawFaceLandmarks(canvasRef.current, resized);
        const score = calculateRizzScore(resized.landmarks.positions);
        if (score !== null) {
          setRawScore(score);
          if (mode === "ranked" && rankPhase === "match" && socket.connected) {
            socket.emit("score:update", { score });
          }
        }
      } else {
        setDetected(false);
      }
    }, 500);

    return () => clearInterval(scoreIntervalRef.current);
  }, [modelsStatus, cameraReady, mode, rankPhase]);

  useEffect(() => {
    const onWelcome = ({ mmr: m, tier: t }) => {
      setMmr(m);
      setRankTier(t);
    };
    const onQueueUpdate = ({ position, hint }) => {
      setQueuePosition(position);
      setQueueHint(hint || "");
      setRankPhase("queued");
    };
    const onMatched = (p) => {
      setRankPhase("match");
      setQueueHint("");
      setQueuePosition(0);
      setMatchEndsAt(p.endsAt);
      setMmr(p.yourMmr);
      setRankTier(p.yourTier);
      setOpponentMeta({ mmr: p.opponentMmr, tier: p.opponentTier });
      setOpponentLive(0);
      setMyPeak(0);
      setTheirPeak(0);
      setOpponentVisible(false);
      requestAnimationFrame(() => setOpponentVisible(true));
    };
    const onScores = ({ theirScore, yourPeak: yp, theirPeak: tp }) => {
      if (typeof theirScore === "number") setOpponentLive(theirScore);
      if (typeof yp === "number") setMyPeak(yp);
      if (typeof tp === "number") setTheirPeak(tp);
    };
    const onResult = (payload) => {
      setRankPhase("result");
      setMatchEndsAt(null);
      setDuelResult(payload);
      setMmr(payload.newMmr);
      setRankTier(payload.newTier);
      setOpponentVisible(false);
    };
    const onConnectErr = (err) => {
      setServerMessage(err.message || "Connection failed");
      setRankPhase("idle");
    };
    const onServerFull = ({ message }) => {
      setServerMessage(message || "Server full");
      socket.disconnect();
    };

    socket.on("ranked:welcome", onWelcome);
    socket.on("ranked:queue-update", onQueueUpdate);
    socket.on("ranked:match-found", onMatched);
    socket.on("ranked:scores", onScores);
    socket.on("ranked:result", onResult);
    socket.on("connect_error", onConnectErr);
    socket.on("server:full", onServerFull);

    return () => {
      socket.off("ranked:welcome", onWelcome);
      socket.off("ranked:queue-update", onQueueUpdate);
      socket.off("ranked:match-found", onMatched);
      socket.off("ranked:scores", onScores);
      socket.off("ranked:result", onResult);
      socket.off("connect_error", onConnectErr);
      socket.off("server:full", onServerFull);
    };
  }, []);

  const ensureSocket = () => {
    if (!socket.connected) socket.connect();
  };

  const enterRanked = () => {
    setMode("ranked");
    setServerMessage("");
    ensureSocket();
  };

  const joinQueue = () => {
    ensureSocket();
    setDuelResult(null);
    setServerMessage("");
    socket.emit("ranked:queue");
  };

  const cancelQueue = () => {
    socket.emit("ranked:cancel-queue");
    setRankPhase("idle");
    setQueueHint("");
    setQueuePosition(0);
  };

  const forfeitMatch = () => {
    socket.emit("ranked:forfeit");
  };

  const switchSolo = () => {
    setMode("solo");
    socket.emit("ranked:cancel-queue");
    setRankPhase("idle");
    setQueueHint("");
    setQueuePosition(0);
    setMatchEndsAt(null);
    setOpponentMeta(null);
  };

  const dismissResult = () => {
    setDuelResult(null);
    setRankPhase("idle");
    setOpponentMeta(null);
    setOpponentLive(0);
    setMyPeak(0);
    setTheirPeak(0);
  };

  const shareScore = async () => {
    if (!scoreCardRef.current) return;
    const canvas = await html2canvas(scoreCardRef.current, {
      backgroundColor: null,
      useCORS: true,
      scale: 2
    });
    const png = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = png;
    link.download = "ogeaked-score.png";
    link.click();
  };

  const initializing = modelsStatus === "loading" || (!cameraReady && !cameraError);
  const modelsBroken = modelsStatus === "error";
  const faceEngineReady = modelsStatus === "ready" && cameraReady && !cameraError;

  return (
    <div className="app">
      <div className="bg-grid" />
      <div className="bg-glow glow-a" />
      <div className="bg-glow glow-b" />
      <div className="scanlines" />

      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <div className="brand-title">oGeaked</div>
            <div className="brand-sub">symmetry engine · ranked duels</div>
          </div>
        </div>
        <div className="rank-pill">
          <span className="pill-label">Ranked</span>
          <span className="pill-mmr">{mmr} MMR</span>
          <span className="pill-tier">{formatTier(rankTier)}</span>
        </div>
      </header>

      <main className="layout">
        <section className="panel panel-video">
          <div className="panel-head">
            <h2>Optical feed</h2>
            <div className={`pill-status ${faceEngineReady ? "ok" : "warn"}`}>
              {modelsBroken ? "models offline" : cameraError ? "camera issue" : initializing ? "booting…" : "live"}
            </div>
          </div>

          <div className="camera-shell">
            <div className="camera-wrap">
              <video ref={videoRef} autoPlay muted playsInline className="video" />
              <canvas ref={canvasRef} className="overlay" width="640" height="480" />
              {!faceEngineReady && (
                <div className="camera-overlay-msg">
                  {cameraError ? (
                    <p>{cameraError}</p>
                  ) : modelsBroken ? (
                    <>
                      <p className="title">Face models missing or blocked</p>
                      <p className="fine">
                        In <code>client/</code> run <code>npm run fetch-models</code> (or reinstall so postinstall runs), then refresh.
                        In DevTools → Network, confirm the four <code>/models/*.json</code> requests succeed (not 404).
                      </p>
                      <button type="button" className="btn-secondary" onClick={() => void loadModels()}>
                        Retry load
                      </button>
                    </>
                  ) : (
                    <p>Calibrating sensors…</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="panel panel-side">
          <div ref={scoreCardRef} className="score-card">
            <div className="score-card-top">
              <p className="eyebrow">Live rizz index</p>
              <div className="score-number">{displayScore.toFixed(2)}</div>
              <p className="tier-line">{detected ? tier : "No face detected 👀"}</p>
            </div>
            <div className="score-card-meta">
              <span>updates / 500ms</span>
              <span>landmark symmetry</span>
            </div>
          </div>

          <div className="mode-toggle">
            <button type="button" className={mode === "solo" ? "tab active" : "tab"} onClick={switchSolo}>
              Solo scan
            </button>
            <button type="button" className={mode === "ranked" ? "tab active" : "tab"} onClick={enterRanked}>
              Ranked duel
            </button>
          </div>

          {mode === "ranked" && (
            <div className="ranked-panel">
              {rankPhase === "idle" && (
                <div className="ranked-block">
                  <p className="blurb">
                    Queue for a <strong>timed duel</strong>. Highest <em>peak</em> score before the clock wins. MMR updates like a
                    ladder — wider matchmaking after you wait.
                  </p>
                  <div className="btn-row">
                    <button type="button" className="btn-primary" onClick={joinQueue}>
                      Find match
                    </button>
                  </div>
                </div>
              )}

              {rankPhase === "queued" && (
                <div className="ranked-block queue">
                  <div className="queue-pulse" />
                  <p className="queue-title">Searching for opponent…</p>
                  <p className="queue-meta">
                    Position ~{queuePosition} · {queueHint}
                  </p>
                  <button type="button" className="btn-secondary" onClick={cancelQueue}>
                    Cancel
                  </button>
                </div>
              )}

              {rankPhase === "match" && (
                <div className="ranked-block duel">
                  <div className="duel-header">
                    <div>
                      <p className="eyebrow">Rated duel</p>
                      <h3>Victory = higher peak</h3>
                    </div>
                    <div className="countdown">
                      <span className="cd-label">TIME</span>
                      <span className="cd-value">
                        {countdownMs != null ? (countdownMs / 1000).toFixed(1) : "—"}s
                      </span>
                    </div>
                  </div>

                  {opponentMeta && (
                    <p className="opp-banner">
                      vs <strong>{formatTier(opponentMeta.tier)}</strong> · {opponentMeta.mmr} MMR
                    </p>
                  )}

                  <div className="versus-row">
                    <div className="duel-card self">
                      <span className="tag">You</span>
                      <div className="big">{displayScore.toFixed(2)}</div>
                      <div className="sub">peak {myPeak.toFixed(2)}</div>
                    </div>
                    <div className="duel-vs">VS</div>
                    <div className={`duel-card opp ${opponentVisible ? "in" : ""}`}>
                      <span className="tag ghost">Opponent</span>
                      <div className="big">{opponentLive.toFixed(2)}</div>
                      <div className="sub">peak {theirPeak.toFixed(2)}</div>
                    </div>
                  </div>

                  <button type="button" className="btn-ghost" onClick={forfeitMatch}>
                    Surrender (loss)
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="actions">
            <button type="button" className="btn-secondary" onClick={shareScore}>
              Share score card
            </button>
          </div>

          {serverMessage && <p className="toast">{serverMessage}</p>}
        </aside>
      </main>

      {duelResult && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <p className={`modal-title ${duelResult.outcome}`}>
              {duelResult.outcome === "win" && "VICTORY"}
              {duelResult.outcome === "loss" && "DEFEAT"}
              {duelResult.outcome === "tie" && "DRAW"}
            </p>
            <p className="modal-sub">
              Peaks you {duelResult.yourPeak.toFixed(2)} · them {duelResult.theirPeak.toFixed(2)}
            </p>
            <p className="modal-mmr">
              MMR {duelResult.mmrDelta >= 0 ? "+" : ""}
              {duelResult.mmrDelta} → <strong>{duelResult.newMmr}</strong> ({formatTier(duelResult.newTier)})
            </p>
            {duelResult.reason && <p className="modal-fine">Reason: {duelResult.reason}</p>}
            <button type="button" className="btn-primary full" onClick={dismissResult}>
              Back to queue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
