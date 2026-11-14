import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export class HandTrackingConfidenceFilter {
  private lastValidLandmarks: NormalizedLandmark[] | null = null;
  private lastAcceptedTime = 0;
  private consecutiveRejections = 0;
  // Minimum per-frame jump allowance and velocity-scaled ceiling (screen widths / sec)
  private readonly MIN_JUMP = 0.08;
  private readonly MAX_JUMP_CAP = 0.35;
  private readonly MAX_SPEED_PER_SEC = 3.0;

  filter(landmarks: NormalizedLandmark[], timestamp = performance.now()): NormalizedLandmark[] | null {
    if (!this.lastValidLandmarks) {
      this.lastValidLandmarks = landmarks;
      this.lastAcceptedTime = timestamp;
      this.consecutiveRejections = 0;
      return landmarks;
    }

    // We mainly care about the index finger tip (8) and thumb tip (4) for interaction
    const curr8 = landmarks[8];
    const prev8 = this.lastValidLandmarks[8];
    
    if (curr8 && prev8) {
      const dx = curr8.x - prev8.x;
      const dy = curr8.y - prev8.y;
      const distSq = dx * dx + dy * dy;

      const dtSec = Math.max(0.001, (timestamp - this.lastAcceptedTime) / 1000);
      const allowedJump = Math.min(
        this.MAX_JUMP_CAP,
        Math.max(this.MIN_JUMP, this.MAX_SPEED_PER_SEC * dtSec)
      );

      if (distSq > allowedJump * allowedJump) {
        this.consecutiveRejections += 1;
        // Reject single-frame outlier spikes, but recover quickly if the hand genuinely moved fast
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
