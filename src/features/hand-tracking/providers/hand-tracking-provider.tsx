"use client";

import React, { createContext, useContext, useEffect, useState, useRef } from "react";
import { usePuzzleCameraContext } from "@/features/puzzle/providers/puzzle-camera-provider";
import { handTrackingService } from "../services/hand-tracking-service";
import { PointerSmoothing } from "../services/pointer-smoothing";
import { GestureRecognizer } from "../services/gesture-recognizer";
import { HandTrackingConfidenceFilter } from "../services/confidence-filter";
import { InteractionConfig } from "../constants/interaction-config";
import { useHandTrackingDiagnostics } from "../store/hand-tracking-diagnostics-store";
import { FpsTracker } from "../services/fps-tracker";
import { trackingDiagnostics } from "../services/diagnostics-service";
import type { HandTrackingResultPayload } from "../workers/hand-tracking.worker";
import type { HandState } from "../types/hand-state";
import type { GestureState, HitTester, NormalizedPointerEvent } from "../types/gesture-state";

interface HandTrackingContextType {
  isReady: boolean;
  handState: HandState;
  gestureState: GestureState;
  registerGestureCallbacks: (onEvent: (e: NormalizedPointerEvent) => void, hitTester: HitTester) => void;
  subscribeFrame: (listener: (hand: HandState, gesture: GestureState) => void) => () => void;
}

interface VideoFrameMetadataLike {
  presentationTime: number;
}

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLike) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const initialHandState: HandState = {
  detected: false,
  pointer: { x: 0, y: 0 },
  landmarks: [],
  handedness: "right",
  confidence: 0,
  pinch: false,
};

const initialGestureState: GestureState = {
  hovering: false,
  pinching: false,
  phase: "idle",
};

const HandTrackingContext = createContext<HandTrackingContextType | null>(null);

export function HandTrackingProvider({ children }: { children: React.ReactNode }) {
  const camera = usePuzzleCameraContext();
  const [isReady, setIsReady] = useState(false);
  const [handState, setHandState] = useState<HandState>(initialHandState);
  const [gestureState, setGestureState] = useState<GestureState>(initialGestureState);
  
  const animationFrameRef = useRef<number | null>(null);
  const videoFrameHandleRef = useRef<number | null>(null);
  const pointerSmoothing = useRef(new PointerSmoothing());
  const gestureRecognizer = useRef(new GestureRecognizer());
  const confidenceFilter = useRef(new HandTrackingConfidenceFilter());
  const inferenceFpsTracker = useRef(new FpsTracker());
  const lastDetectedTime = useRef<number>(0);
  const lastValidState = useRef<HandState | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const isInPersistenceRef = useRef<boolean>(false);
  const cameraDiagnosticsRecordedRef = useRef<boolean>(false);

  const frameListenersRef = useRef<Set<(hand: HandState, gesture: GestureState) => void>>(new Set());
  const lastCommittedHandRef = useRef<HandState>(initialHandState);
  const lastCommittedGestureRef = useRef<GestureState>(initialGestureState);

  const registerGestureCallbacks = React.useCallback((
    onEvent: (e: NormalizedPointerEvent) => void,
    hitTester: HitTester
  ) => {
    gestureRecognizer.current.setCallbacks(onEvent, hitTester);
  }, []);

  const subscribeFrame = React.useCallback(
    (listener: (hand: HandState, gesture: GestureState) => void) => {
      frameListenersRef.current.add(listener);
      return () => {
        frameListenersRef.current.delete(listener);
      };
    },
    []
  );

  const publishFrame = React.useCallback((nextHand: HandState, nextGesture: GestureState) => {
    frameListenersRef.current.forEach((listener) => listener(nextHand, nextGesture));

    if (nextHand.detected !== lastCommittedHandRef.current.detected) {
      lastCommittedHandRef.current = nextHand;
      setHandState(nextHand);
    }

    const prevGesture = lastCommittedGestureRef.current;
    if (
      nextGesture.phase !== prevGesture.phase ||
      nextGesture.pinching !== prevGesture.pinching ||
      nextGesture.hovering !== prevGesture.hovering ||
      nextGesture.hoveredPieceId !== prevGesture.hoveredPieceId
    ) {
      lastCommittedGestureRef.current = nextGesture;
      setGestureState(nextGesture);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function initService() {
      try {
        await handTrackingService.initialize();
        if (active) {
          setIsReady(true);
        }
      } catch (err) {
        console.error("Failed to initialize hand tracking", err);
      }
    }
    
    initService();

    return () => {
      active = false;
      handTrackingService.close();
    };
  }, []);

  useEffect(() => {
    if (!isReady) return;

    const video = camera.getVideoElement() as VideoWithRVFC | null;
    if (!video) return;

    const recordCameraDiagnostics = () => {
      if (cameraDiagnosticsRecordedRef.current || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }
      const stream = video.srcObject as MediaStream;
      if (stream) {
        const track = stream.getVideoTracks()[0];
        if (track) {
          const settings = track.getSettings();
          useHandTrackingDiagnostics.getState().setCameraDiagnostics({
            width: settings.width || video.videoWidth,
            height: settings.height || video.videoHeight,
            frameRate: settings.frameRate || 0,
            facingMode: settings.facingMode,
            deviceId: settings.deviceId,
          });
          cameraDiagnosticsRecordedRef.current = true;
        }
      }
    };

    recordCameraDiagnostics();

    const handleMissingFrame = (reason: string, now: number) => {
      const timeSinceLastDetection = now - lastDetectedTime.current;
      
      if (lastValidState.current && timeSinceLastDetection < InteractionConfig.trackingPersistenceMs) {
        isInPersistenceRef.current = true;
      } else {
        trackingDiagnostics.recordTrackingLoss(reason);
        pointerSmoothing.current.reset();
        confidenceFilter.current.reset();
        isInPersistenceRef.current = false;
        const emptyState = { ...initialHandState, detected: false };
        lastValidState.current = null;
        const gState = gestureRecognizer.current.process(emptyState, now);
        publishFrame(emptyState, gState);
      }
    };

    const handleInferenceResult = (result: HandTrackingResultPayload | null) => {
      const now = performance.now();

      inferenceFpsTracker.current.recordFrame(now);
      if (inferenceFpsTracker.current.shouldUpdateStore(now)) {
        const metrics = inferenceFpsTracker.current.getMetrics();
        if (metrics) {
          useHandTrackingDiagnostics.getState().setInferenceFps(metrics);
        }
      }

      if (result && result.landmarks && result.landmarks.length > 0) {
        const rawLandmarks = result.landmarks[0];
        const landmarks = confidenceFilter.current.filter(rawLandmarks, now);
        
        if (landmarks) {
          const handedness = (result.handedness[0]?.[0]?.categoryName === "Left" ? "left" : "right") as "left" | "right";
          const confidence = result.handedness[0]?.[0]?.score ?? 0;
          
          trackingDiagnostics.recordConfidence(confidence);
          trackingDiagnostics.recordTrackingRecovery();
          
          // Smart Pointer Position: Landmark 4 (Thumb tip), Landmark 8 (Index tip)
          const indexFingertip = landmarks[8];
          const thumbFingertip = landmarks[4];
          const isPinching = gestureRecognizer.current.getIsPinching();
          
          let rawX: number;
          let rawY: number;
          if (isPinching) {
            rawX = 1 - (indexFingertip.x + thumbFingertip.x) / 2;
            rawY = (indexFingertip.y + thumbFingertip.y) / 2;
          } else {
            rawX = 1 - indexFingertip.x;
            rawY = indexFingertip.y;
          }
          
          isInPersistenceRef.current = false;
          const smoothed = pointerSmoothing.current.updateTarget(rawX, rawY, now);

          const newState: HandState = {
            detected: true,
            pointer: smoothed,
            landmarks,
            handedness,
            confidence,
            pinch: false,
          };
          
          lastDetectedTime.current = now;
          lastValidState.current = newState;

          const aspectRatio =
            video.videoWidth > 0 && video.videoHeight > 0
              ? video.videoWidth / video.videoHeight
              : 16 / 9;
          const gState = gestureRecognizer.current.process(newState, now, aspectRatio);
          publishFrame(newState, gState);
        } else {
          handleMissingFrame("Impossible landmark jump (Confidence Filter)", now);
        }
      } else {
        handleMissingFrame("No landmarks detected", now);
      }
    };

    const supportsRVFC = typeof video.requestVideoFrameCallback === "function";
    let active = true;

    const onVideoFrame = (_now: number, metadata: VideoFrameMetadataLike) => {
      if (!active) return;
      recordCameraDiagnostics();
      handTrackingService.processFrame(video, metadata.presentationTime, handleInferenceResult);
      videoFrameHandleRef.current = video.requestVideoFrameCallback!(onVideoFrame);
    };

    if (supportsRVFC) {
      videoFrameHandleRef.current = video.requestVideoFrameCallback!(onVideoFrame);
    }

    // Display-rate loop (60-120Hz) drives smooth 1 Euro sub-frame interpolation independently of camera FPS
    const displayLoop = () => {
      const now = performance.now();

      if (!supportsRVFC && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        recordCameraDiagnostics();
        if (video.currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          handTrackingService.processFrame(video, now, handleInferenceResult);
        }
      }

      if (lastValidState.current) {
        if (isInPersistenceRef.current && now - lastDetectedTime.current >= InteractionConfig.trackingPersistenceMs) {
          handleMissingFrame("Persistence timeout", now);
        } else if (!isInPersistenceRef.current) {
          const sampled = pointerSmoothing.current.sample(now);
          if (sampled) {
            const interpolatedState: HandState = {
              ...lastValidState.current,
              pointer: sampled,
            };
            lastValidState.current = interpolatedState;
            const aspectRatio =
              video.videoWidth > 0 && video.videoHeight > 0
                ? video.videoWidth / video.videoHeight
                : 16 / 9;
            const gState = gestureRecognizer.current.process(interpolatedState, now, aspectRatio);
            publishFrame(interpolatedState, gState);
          }
        }
      }

      animationFrameRef.current = requestAnimationFrame(displayLoop);
    };

    animationFrameRef.current = requestAnimationFrame(displayLoop);

    return () => {
      active = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (supportsRVFC && videoFrameHandleRef.current !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrameHandleRef.current);
      }
    };
  }, [isReady, camera, publishFrame]);

  const contextValue = React.useMemo(
    () => ({ isReady, handState, gestureState, registerGestureCallbacks, subscribeFrame }),
    [isReady, handState, gestureState, registerGestureCallbacks, subscribeFrame]
  );

  return (
    <HandTrackingContext.Provider value={contextValue}>
      {children}
    </HandTrackingContext.Provider>
  );
}

export function useHandTracking() {
  const ctx = useContext(HandTrackingContext);
  if (!ctx) throw new Error("useHandTracking must be used within a HandTrackingProvider");
  return ctx;
}
