import { FilesetResolver, HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface WorkerInitOptions {
  wasmBaseUrl: string;
  modelAssetPath: string;
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
}

export type HandTrackingWorkerInMessage =
  | { type: "INIT"; options: WorkerInitOptions }
  | { type: "DETECT"; frame: ImageBitmap; timestamp: number }
  | { type: "CLOSE" };

export interface HandTrackingResultPayload {
  landmarks: NormalizedLandmark[][];
  handedness: { categoryName: string; score: number }[][];
}

export type HandTrackingWorkerOutMessage =
  | { type: "READY"; delegate: "GPU" | "CPU" }
  | { type: "ERROR"; message: string }
  | { type: "RESULT"; result: HandTrackingResultPayload | null; timestamp: number; inferenceMs: number };

interface WorkerScopeLike {
  postMessage: (message: HandTrackingWorkerOutMessage) => void;
  onmessage: ((event: MessageEvent<HandTrackingWorkerInMessage>) => void) | null;
}

const workerScope = self as unknown as WorkerScopeLike;

let landmarker: HandLandmarker | null = null;
let lastTimestamp = -1;

async function createLandmarkerWithDelegate(
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  options: WorkerInitOptions,
  delegate: "GPU" | "CPU"
) {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: options.modelAssetPath,
      delegate,
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: options.minHandDetectionConfidence,
    minHandPresenceConfidence: options.minHandPresenceConfidence,
    minTrackingConfidence: options.minTrackingConfidence,
  });
}

workerScope.onmessage = async (event: MessageEvent<HandTrackingWorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === "INIT") {
    try {
      const vision = await FilesetResolver.forVisionTasks(msg.options.wasmBaseUrl);
      let activeDelegate: "GPU" | "CPU" = "GPU";

      try {
        landmarker = await createLandmarkerWithDelegate(vision, msg.options, "GPU");
      } catch {
        activeDelegate = "CPU";
        landmarker = await createLandmarkerWithDelegate(vision, msg.options, "CPU");
      }

      lastTimestamp = -1;
      workerScope.postMessage({ type: "READY", delegate: activeDelegate });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to initialize HandLandmarker in worker";
      workerScope.postMessage({ type: "ERROR", message });
    }
    return;
  }

  if (msg.type === "DETECT") {
    const { frame, timestamp } = msg;
    const t0 = performance.now();

    try {
      if (!landmarker) {
        workerScope.postMessage({ type: "RESULT", result: null, timestamp, inferenceMs: 0 });
        return;
      }

      const safeTimestamp = timestamp > lastTimestamp ? timestamp : lastTimestamp + 1;
      lastTimestamp = safeTimestamp;

      const raw = landmarker.detectForVideo(frame, safeTimestamp);
      const payload: HandTrackingResultPayload = {
        landmarks: raw.landmarks,
        handedness: raw.handedness.map((cats) =>
          cats.map((c) => ({ categoryName: c.categoryName, score: c.score }))
        ),
      };

      workerScope.postMessage({
        type: "RESULT",
        result: payload,
        timestamp,
        inferenceMs: performance.now() - t0,
      });
    } catch {
      workerScope.postMessage({
        type: "RESULT",
        result: null,
        timestamp,
        inferenceMs: performance.now() - t0,
      });
    } finally {
      frame.close();
    }
    return;
  }

  if (msg.type === "CLOSE") {
    if (landmarker) {
      landmarker.close();
      landmarker = null;
    }
    lastTimestamp = -1;
  }
};
