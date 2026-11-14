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
import type { HandState } from "../types/hand-state";
import type { GestureState, HitTester, NormalizedPointerEvent } from "../types/gesture-state";

interface HandTrackingContextType {
  isReady: boolean;
  handState: HandState;
  gestureState: GestureState;
  registerGestureCallbacks: (onEvent: (e: NormalizedPointerEvent) => void, hitTester: HitTester) => void;
  subscribeFrame: (listener: (hand: HandState, gesture: GestureState) => void) => () => void;
}

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
  const pointerSmoothing = useRef(new PointerSmoothing());
  const gestureRecognizer = useRef(new GestureRecognizer());
  const confidenceFilter = useRef(new HandTrackingConfidenceFilter());
  const inferenceFpsTracker = useRef(new FpsTracker());
  const lastDetectedTime = useRef<number>(0);
  const lastValidState = useRef<HandState | null>(null);
  const latestRawPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const lastRafTimeRef = useRef<number>(0);
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

    const video = camera.getVideoElement();
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
        const gState = gestureRecognizer.current.process(lastValidState.current, now);
        publishFrame(lastValidState.current, gState);
      } else {
        trackingDiagnostics.recordTrackingLoss(reason);
        pointerSmoothing.current.reset();
        confidenceFilter.current.reset();
        latestRawPointerRef.current = null;
        isInPersistenceRef.current = false;
        const emptyState = { ...initialHandState, detected: false };
        lastValidState.current = null;
        const gState = gestureRecognizer.current.process(emptyState, now);
        publishFrame(emptyState, gState);
      }
    };

    const loop = () => {
      const now = performance.now();
      const rafDt = lastRafTimeRef.current > 0 ? now - lastRafTimeRef.current : 16.6667;
      lastRafTimeRef.current = now;

      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        recordCameraDiagnostics();

        const hasNewVideoFrame = video.currentTime !== lastVideoTimeRef.current;

        if (hasNewVideoFrame) {
          lastVideoTimeRef.current = video.currentTime;
          const result = handTrackingService.detectForVideo(video, now);
          const t1 = performance.now();
          
          inferenceFpsTracker.current.recordFrame(t1);
          if (inferenceFpsTracker.current.shouldUpdateStore(t1)) {
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
              
              // Smart Pointer Position
              // Landmark 4: Thumb tip, Landmark 8: Index tip
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
              
              latestRawPointerRef.current = { x: rawX, y: rawY };
              isInPersistenceRef.current = false;
              const smoothed = pointerSmoothing.current.smooth(rawX, rawY, rafDt);

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

              const gState = gestureRecognizer.current.process(newState, now);
              publishFrame(newState, gState);
            } else {
              handleMissingFrame("Impossible landmark jump (Confidence Filter)", now);
            }
          } else {
            handleMissingFrame("No landmarks detected", now);
          }
        } else if (lastValidState.current && latestRawPointerRef.current && !isInPersistenceRef.current) {
          // Interpolate smoothing at display refresh rate between 30fps camera frames
          const smoothed = pointerSmoothing.current.smooth(
            latestRawPointerRef.current.x,
            latestRawPointerRef.current.y,
            rafDt
          );
          const interpolatedState: HandState = {
            ...lastValidState.current,
            pointer: smoothed,
          };
          lastValidState.current = interpolatedState;
          const gState = gestureRecognizer.current.process(interpolatedState, now);
          publishFrame(interpolatedState, gState);
        }
      }
      
      animationFrameRef.current = requestAnimationFrame(loop);
    };

    animationFrameRef.current = requestAnimationFrame(loop);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
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
