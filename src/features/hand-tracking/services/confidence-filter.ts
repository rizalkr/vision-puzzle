import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export class HandTrackingConfidenceFilter {
  private lastValidLandmarks: NormalizedLandmark[] | null = null;
  private lastAcceptedTime = 0;
  private consecutiveRejections = 0;
  // Minimum per-frame jump allowance and velocity-scaled ceiling (screen widths / sec)
  private readonly MIN_JUMP = 0.08;
  private readonly MAX_JUMP_CAP = 0.35;
  private readonly MAX_SPEED_PER_SEC = 3.5;

  filter(landmarks: NormalizedLandmark[], timestamp = performance.now()): NormalizedLandmark[] | null {
    if (!this.lastValidLandmarks) {
      this.lastValidLandmarks = landmarks;
      this.lastAcceptedTime = timestamp;
      this.consecutiveRejections = 0;
      return landmarks;
    }

    // Landmark 0: wrist, Landmark 5: index MCP (knuckle), Landmark 8: index tip, Landmark 9: middle MCP
    const curr0 = landmarks[0];
    const curr5 = landmarks[5];
    const curr8 = landmarks[8];
    const prev8 = this.lastValidLandmarks[8];
    const curr9 = landmarks[9];

    if (curr8 && prev8) {
      const tipJump = Math.hypot(curr8.x - prev8.x, curr8.y - prev8.y);
      const palmSize = curr0 && curr9
        ? Math.max(0.04, Math.hypot(curr9.x - curr0.x, curr9.y - curr0.y))
        : 0.15;

      // 1. Extreme anatomical sanity: reject impossible single-frame finger elongation hallucinations
      if (curr5) {
        const fingerLen = Math.hypot(curr8.x - curr5.x, curr8.y - curr5.y);
        if (fingerLen > palmSize * 2.6) {
          this.consecutiveRejections += 1;
          if (this.consecutiveRejections < 2) {
            return null;
          }
        }
      }

      // 2. Velocity cap scaled by elapsed time (allows normal pinching curls and fast hand moves, filters 1-frame spikes)
      const dtSec = Math.max(0.001, (timestamp - this.lastAcceptedTime) / 1000);
      const allowedJump = Math.min(
        this.MAX_JUMP_CAP,
        Math.max(this.MIN_JUMP, this.MAX_SPEED_PER_SEC * dtSec)
      );

      if (tipJump > allowedJump) {
        this.consecutiveRejections += 1;
        if (this.consecutiveRejections < 2) {
          return null;
        }
      }
    }

    this.lastValidLandmarks = landmarks;
    this.lastAcceptedTime = timestamp;
    this.consecutiveRejections = 0;
    return landmarks;
  }

  reset() {
    this.lastValidLandmarks = null;
    this.lastAcceptedTime = 0;
    this.consecutiveRejections = 0;
  }
}
