"use client";

import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGlobalPointer } from "../providers/global-pointer-provider";
import { useHandTracking } from "../providers/hand-tracking-provider";
import { useHandTrackingDiagnostics } from "../store/hand-tracking-diagnostics-store";
import { FpsTracker } from "../services/fps-tracker";
import { motionPresets, motionTokens } from "@/lib/motion";

interface TrailPoint {
  x: number;
  y: number;
  timestamp: number;
}

const TRAIL_POOL_SIZE = 6;
const TRAIL_MAX_AGE_MS = 120;
const TRAIL_INDICES = Array.from({ length: TRAIL_POOL_SIZE }, (_, i) => i);

export function PointerOverlay() {
  const { handState } = useHandTracking();
  const { pointerState, subscribePointer, getPointerState } = useGlobalPointer();
  const [ripple, setRipple] = useState<{ id: number; x: number; y: number } | null>(null);

  const renderFpsTracker = useRef(new FpsTracker());
  const pointerContainerRef = useRef<HTMLDivElement | null>(null);
  const trailRefs = useRef<(HTMLDivElement | null)[]>([]);
  const trailPointsRef = useRef<TrailPoint[]>([]);

  // Update pointer transform immediately on high-frequency pointer ticks (zero React re-renders)
  useEffect(() => {
    const applyTransform = (x: number, y: number) => {
      const el = pointerContainerRef.current;
      if (!el) return;
      const px = x * window.innerWidth;
      const py = y * window.innerHeight;
      el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    };

    const current = getPointerState();
    applyTransform(current.x, current.y);

    return subscribePointer((state) => {
      if (state.source === "hand" && state.phase !== "hidden") {
        applyTransform(state.x, state.y);
      }
    });
  }, [subscribePointer, getPointerState, handState.detected, pointerState.phase]);

  // Track Render FPS and drive GPU-composited trail pool
  useEffect(() => {
    let animationFrameId: number;
    
    const renderLoop = (timestamp: number) => {
      renderFpsTracker.current.recordFrame(timestamp);
      
      if (renderFpsTracker.current.shouldUpdateStore(timestamp)) {
        const metrics = renderFpsTracker.current.getMetrics();
        if (metrics) {
          useHandTrackingDiagnostics.getState().setRenderFps(metrics);
        }
      }

      const current = getPointerState();
      if (current.source === "hand" && current.phase !== "hidden") {
        const px = current.x * window.innerWidth;
        const py = current.y * window.innerHeight;

        const points = trailPointsRef.current.filter(
          (p) => timestamp - p.timestamp < TRAIL_MAX_AGE_MS
        );
        points.push({ x: px, y: py, timestamp });
        if (points.length > TRAIL_POOL_SIZE) {
          points.splice(0, points.length - TRAIL_POOL_SIZE);
        }
        trailPointsRef.current = points;

        const isGrab = current.phase === "pressed" || current.phase === "dragging";
        const baseOpacity = isGrab ? 0.8 : 0.5;

        for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
          const el = trailRefs.current[i];
          if (!el) continue;
          const pt = points[i];
          if (pt) {
            const ratio = (i + 1) / points.length;
            el.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;
            el.style.opacity = String(ratio * baseOpacity);
          } else {
            el.style.opacity = "0";
          }
        }
      } else if (trailPointsRef.current.length > 0) {
        trailPointsRef.current = [];
        for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
          const el = trailRefs.current[i];
          if (el) el.style.opacity = "0";
        }
      }
      
      animationFrameId = requestAnimationFrame(renderLoop);
    };
    
    animationFrameId = requestAnimationFrame(renderLoop);
    
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [getPointerState]);

  // Manage global cursor hiding
  useEffect(() => {
    if (pointerState.source === "hand") {
      document.body.style.cursor = "none";
    } else {
      document.body.style.cursor = "auto";
    }
  }, [pointerState.source]);

  const wasPressed = useRef(false);
  // Handle Drop Ripple on discrete phase release
  useEffect(() => {
    if (pointerState.phase === "pressed" || pointerState.phase === "dragging") {
      wasPressed.current = true;
    } else if (wasPressed.current && (pointerState.phase === "idle" || pointerState.phase === "hover")) {
      wasPressed.current = false;
      const latest = getPointerState();
      setRipple({
        id: Date.now(),
        x: latest.x,
        y: latest.y
      });
    }
  }, [pointerState.phase, getPointerState]);

  if (pointerState.phase === "hidden") return null;

  const cursorState = pointerState.phase === "pressed" || pointerState.phase === "dragging" ? "grab" :
                      pointerState.phase === "hover" ? "hover" : "idle";

  return (
    <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
      <AnimatePresence>
        {handState.detected && (
          <>
            {/* Trail Pool (GPU-composited via transform) */}
            {TRAIL_INDICES.map((index) => (
              <div
                key={index}
                ref={(el) => {
                  trailRefs.current[index] = el;
                }}
                className="absolute top-0 left-0 rounded-full bg-cyan-200/40 blur-[2px] w-4 h-4 -ml-2 -mt-2 pointer-events-none will-change-transform"
                style={{ opacity: 0 }}
              />
            ))}

            {/* Main Pointer (GPU-composited via transform) */}
            <div
              ref={pointerContainerRef}
              className="absolute top-0 left-0 pointer-events-none z-50 will-change-transform"
            >
              <motion.div
                initial="hidden"
                animate="visible"
                exit="exit"
                variants={motionPresets.overlay}
                className="flex items-center justify-center relative -translate-x-1/2 -translate-y-1/2"
              >
                <motion.div 
                  className="rounded-full bg-cyan-400 absolute inset-0 blur-md"
                  animate={{
                     scale: cursorState === "hover" ? 1.5 : cursorState === "grab" ? 1.7 : 1,
                     opacity: cursorState === "idle" ? 0.5 : 0.8
                  }}
                  transition={motionTokens.springs.pointer}
                />
                <motion.div 
                  className="rounded-full bg-cyan-200 relative" 
                  style={{ width: 24, height: 24 }} // Base size
                  variants={motionPresets.pointer}
                  initial="idle"
                  animate={cursorState}
                />
              </motion.div>
            </div>
            
            {/* Drop Ripple */}
            <AnimatePresence>
              {ripple && (
                <motion.div
                  key={ripple.id}
                  initial={{ opacity: 1, scale: 0 }}
                  animate={{ opacity: 0, scale: 4 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: motionTokens.durations.slow, ease: motionTokens.easings.exit }}
                  className="absolute -ml-6 -mt-6 w-12 h-12 rounded-full border-2 border-white pointer-events-none"
                  style={{
                    left: `${ripple.x * 100}%`,
                    top: `${ripple.y * 100}%`,
                  }}
                />
              )}
            </AnimatePresence>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
