import type { HandLandmarker, HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type {
  HandTrackingResultPayload,
  HandTrackingWorkerInMessage,
  HandTrackingWorkerOutMessage,
} from "../workers/hand-tracking.worker";

const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_ASSET_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const INFERENCE_MAX_WIDTH = 480;

const MODEL_OPTIONS = {
  minHandDetectionConfidence: 0.55,
  minHandPresenceConfidence: 0.55,
  minTrackingConfidence: 0.55,
};

export type FrameResultCallback = (
  result: HandTrackingResultPayload | null,
  timestamp: number,
  inferenceMs: number
) => void;

export class HandTrackingService {
  private landmarker: HandLandmarker | null = null;
  private worker: Worker | null = null;
  private useWorker = false;
  private isInitializing = false;
  private isReady = false;
  private isProcessing = false;
  private sessionToken = 0;
  private initPromise: Promise<void> | null = null;
  private lastMainThreadTimestamp = -1;

  private offscreenCanvas: OffscreenCanvas | null = null;
  private offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;

  private pendingCallback: FrameResultCallback | null = null;

  async initialize(): Promise<void> {
    if (this.isReady) return;
    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    const token = ++this.sessionToken;

    this.initPromise = (async () => {
      try {
        const workerReady = await this.tryInitializeWorker(token);
        if (token !== this.sessionToken) return;

        if (workerReady) {
          this.useWorker = true;
          this.isReady = true;
          return;
        }

        // Graceful fallback to main-thread MediaPipe when Worker/OffscreenCanvas is unavailable
        await this.initializeMainThread(token);
        if (token !== this.sessionToken) return;

        this.useWorker = false;
        this.isReady = true;
      } catch (err) {
        if (token === this.sessionToken) {
          console.error("Failed to initialize HandTrackingService:", err);
        }
        throw err;
      } finally {
        if (token === this.sessionToken) {
          this.isInitializing = false;
          this.initPromise = null;
        }
      }
    })();

    return this.initPromise;
  }

  private async tryInitializeWorker(token: number): Promise<boolean> {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      try {
        const worker = new Worker(
          new URL("../workers/hand-tracking.worker.ts", import.meta.url),
          { type: "module" }
        );

        const timeoutId = window.setTimeout(() => {
          worker.terminate();
          finish(false);
        }, 15000);

        worker.onmessage = (event: MessageEvent<HandTrackingWorkerOutMessage>) => {
          if (token !== this.sessionToken) {
            window.clearTimeout(timeoutId);
            worker.terminate();
            finish(false);
            return;
          }

          const msg = event.data;
          if (msg.type === "READY") {
            window.clearTimeout(timeoutId);
            this.worker = worker;
            this.attachRuntimeWorkerHandler(worker, token);
            finish(true);
            return;
          }

          if (msg.type === "ERROR") {
            window.clearTimeout(timeoutId);
            worker.terminate();
            finish(false);
          }
        };

        worker.onerror = () => {
          window.clearTimeout(timeoutId);
          worker.terminate();
          finish(false);
        };

        const initMsg: HandTrackingWorkerInMessage = {
          type: "INIT",
          options: {
            wasmBaseUrl: WASM_BASE_URL,
            modelAssetPath: MODEL_ASSET_PATH,
            ...MODEL_OPTIONS,
          },
        };
        worker.postMessage(initMsg);
      } catch {
        finish(false);
      }
    });
  }

  private attachRuntimeWorkerHandler(worker: Worker, token: number) {
    worker.onmessage = (event: MessageEvent<HandTrackingWorkerOutMessage>) => {
      if (token !== this.sessionToken) return;
      const msg = event.data;
      if (msg.type === "RESULT") {
        this.isProcessing = false;
        const cb = this.pendingCallback;
        this.pendingCallback = null;
        cb?.(msg.result, msg.timestamp, msg.inferenceMs);
      }
    };

    worker.onerror = () => {
      if (token !== this.sessionToken) return;
      this.isProcessing = false;
      const cb = this.pendingCallback;
      this.pendingCallback = null;
      cb?.(null, performance.now(), 0);
    };
  }

  private async initializeMainThread(token: number) {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    if (token !== this.sessionToken) return;

    const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    if (token !== this.sessionToken) return;

    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_ASSET_PATH,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      ...MODEL_OPTIONS,
    });
    this.lastMainThreadTimestamp = -1;
  }

  private getDownscaledSize(video: HTMLVideoElement): { width: number; height: number } {
    const width = Math.min(INFERENCE_MAX_WIDTH, video.videoWidth);
    const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
    return { width, height };
  }

  /**
   * Submits a video frame for inference if no frame is currently in flight.
   * Returns true if the frame was accepted, false if skipped due to backpressure.
   */
  processFrame(
    video: HTMLVideoElement,
    timestamp: number,
    onResult: FrameResultCallback
  ): boolean {
    if (!this.isReady || this.isProcessing) return false;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return false;
    }

    if (this.useWorker && this.worker) {
      const { width, height } = this.getDownscaledSize(video);
      if (
        !this.offscreenCanvas ||
        this.offscreenCanvas.width !== width ||
        this.offscreenCanvas.height !== height
      ) {
        this.offscreenCanvas = new OffscreenCanvas(width, height);
        this.offscreenCtx = this.offscreenCanvas.getContext("2d", {
          alpha: false,
          desynchronized: true,
        });
      }

      if (this.offscreenCtx && this.offscreenCanvas) {
        this.offscreenCtx.drawImage(video, 0, 0, width, height);
        const bitmap = this.offscreenCanvas.transferToImageBitmap();
        this.isProcessing = true;
        this.pendingCallback = onResult;

        const msg: HandTrackingWorkerInMessage = {
          type: "DETECT",
          frame: bitmap,
          timestamp,
        };
        this.worker.postMessage(msg, [bitmap]);
        return true;
      }
    }

    if (!this.landmarker) return false;

    const t0 = performance.now();
    const safeTimestamp =
      timestamp > this.lastMainThreadTimestamp ? timestamp : this.lastMainThreadTimestamp + 1;
    this.lastMainThreadTimestamp = safeTimestamp;

    const { width, height } = this.getDownscaledSize(video);
    if (!this.fallbackCanvas) {
      this.fallbackCanvas = document.createElement("canvas");
    }
    if (this.fallbackCanvas.width !== width || this.fallbackCanvas.height !== height) {
      this.fallbackCanvas.width = width;
      this.fallbackCanvas.height = height;
      this.fallbackCtx = this.fallbackCanvas.getContext("2d", { alpha: false });
    }

    let rawResult: HandLandmarkerResult | null = null;
    if (this.fallbackCtx) {
      this.fallbackCtx.drawImage(video, 0, 0, width, height);
      rawResult = this.landmarker.detectForVideo(this.fallbackCanvas, safeTimestamp);
    } else {
      rawResult = this.landmarker.detectForVideo(video, safeTimestamp);
    }

    const payload: HandTrackingResultPayload | null = rawResult
      ? {
          landmarks: rawResult.landmarks,
          handedness: rawResult.handedness.map((cats) =>
            cats.map((c) => ({ categoryName: c.categoryName, score: c.score }))
          ),
        }
      : null;

    onResult(payload, timestamp, performance.now() - t0);
    return true;
  }

  detectForVideo(video: HTMLVideoElement, timestamp: number): HandLandmarkerResult | null {
    if (!this.isReady || !this.landmarker) return null;
    const safeTimestamp =
      timestamp > this.lastMainThreadTimestamp ? timestamp : this.lastMainThreadTimestamp + 1;
    this.lastMainThreadTimestamp = safeTimestamp;
    return this.landmarker.detectForVideo(video, safeTimestamp);
  }

  close() {
    this.sessionToken++;
    this.isInitializing = false;
    this.isReady = false;
    this.isProcessing = false;
    this.pendingCallback = null;
    this.initPromise = null;

    if (this.worker) {
      const closeMsg: HandTrackingWorkerInMessage = { type: "CLOSE" };
      this.worker.postMessage(closeMsg);
      this.worker.terminate();
      this.worker = null;
    }

    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }

    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.fallbackCanvas = null;
    this.fallbackCtx = null;
    this.lastMainThreadTimestamp = -1;
  }
}

export const handTrackingService = new HandTrackingService();
