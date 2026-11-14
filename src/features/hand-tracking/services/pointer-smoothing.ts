import { InteractionConfig } from "../constants/interaction-config";

/**
 * Exponential Moving Average (EMA) implementation to reduce jitter
 * in hand tracking coordinates. Uses Adaptive Smoothing based on speed.
 */
export class PointerSmoothing {
  private currentX: number | null = null;
  private currentY: number | null = null;

  constructor() {}

  /**
   * Applies a frame-rate-independent EMA filter to the incoming raw coordinates.
   */
  smooth(rawX: number, rawY: number, dtMs = 16.6667): { x: number; y: number } {
    if (this.currentX === null || this.currentY === null) {
      this.currentX = rawX;
      this.currentY = rawY;
    } else {
      const dx = rawX - this.currentX;
      const dy = rawY - this.currentY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Map distance to a smoothing factor (alpha)
      // distance ~ 0.005 is very slow (jitter), distance ~ 0.05 is fast movement
      const t = Math.max(0, Math.min(1, (dist - 0.005) / 0.045));
      // baseSmoothing represents how much of the OLD value to keep at 60Hz (~16.67ms)
      const baseSmoothing = InteractionConfig.adaptiveSmoothing.slow * (1 - t) + InteractionConfig.adaptiveSmoothing.fast * t;
      // Scale exponent by elapsed frame time so 30fps cameras do not feel sluggish
      const clampedDt = Math.max(1, Math.min(dtMs, 100));
      const smoothing = Math.pow(baseSmoothing, clampedDt / 16.6667);
      
      this.currentX = (1 - smoothing) * rawX + smoothing * this.currentX;
      this.currentY = (1 - smoothing) * rawY + smoothing * this.currentY;
    }
    
    return { x: this.currentX, y: this.currentY };
  }

  /**
   * Resets the filter state (e.g. when hand tracking is lost).
   */
  reset() {
    this.currentX = null;
    this.currentY = null;
  }
}
