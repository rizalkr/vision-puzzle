import { InteractionConfig } from "../constants/interaction-config";

class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  filter(value: number, alpha: number): number {
    if (this.y === null || this.s === null) {
      this.s = value;
    } else {
      this.s = alpha * value + (1 - alpha) * this.s;
    }
    this.y = value;
    return this.s;
  }

  lastRaw(): number | null {
    return this.y;
  }

  reset() {
    this.y = null;
    this.s = null;
  }
}

class OneEuroFilter1D {
  private xFilter = new LowPassFilter();
  private dxFilter = new LowPassFilter();
  private lastTimeMs: number | null = null;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff: number
  ) {}

  private alpha(cutoffHz: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / dtSec);
  }

  filter(value: number, timestampMs: number): number {
    if (this.lastTimeMs === null) {
      this.lastTimeMs = timestampMs;
      this.dxFilter.filter(0, 1);
      return this.xFilter.filter(value, 1);
    }

    const dtSec = Math.max(0.001, Math.min((timestampMs - this.lastTimeMs) / 1000, 0.2));
    this.lastTimeMs = timestampMs;

    const prevRaw = this.xFilter.lastRaw();
    const dValue = prevRaw === null ? 0 : (value - prevRaw) / dtSec;
    const edValue = this.dxFilter.filter(dValue, this.alpha(this.dCutoff, dtSec));

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.xFilter.filter(value, this.alpha(cutoff, dtSec));
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimeMs = null;
  }
}

/**
 * Two-stage pointer smoother:
 * 1) 1 Euro Filter on true camera detections (eliminates stationary jitter with near-zero fast-motion lag)
 * 2) Sub-frame exponential chase at display refresh rate (60-120Hz) between 30Hz camera frames
 */
export class PointerSmoothing {
  private filterX: OneEuroFilter1D;
  private filterY: OneEuroFilter1D;
  private targetX: number | null = null;
  private targetY: number | null = null;
  private displayX: number | null = null;
  private displayY: number | null = null;
  private lastSampleTimeMs: number | null = null;

  constructor() {
    const { minCutoff, beta, dCutoff } = InteractionConfig.oneEuroFilter;
    this.filterX = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter1D(minCutoff, beta, dCutoff);
  }

  /**
   * Updates the 1 Euro Filter with a new camera detection at `timestampMs`.
   */
  updateTarget(rawX: number, rawY: number, timestampMs = performance.now()): { x: number; y: number } {
    this.targetX = this.filterX.filter(rawX, timestampMs);
    this.targetY = this.filterY.filter(rawY, timestampMs);

    if (this.displayX === null || this.displayY === null) {
      this.displayX = this.targetX;
      this.displayY = this.targetY;
      this.lastSampleTimeMs = timestampMs;
    }

    return { x: this.displayX, y: this.displayY };
  }

  /**
   * Advances sub-frame display interpolation toward the latest 1 Euro target.
   */
  sample(nowMs = performance.now()): { x: number; y: number } | null {
    if (this.targetX === null || this.targetY === null) return null;

    if (this.displayX === null || this.displayY === null || this.lastSampleTimeMs === null) {
      this.displayX = this.targetX;
      this.displayY = this.targetY;
      this.lastSampleTimeMs = nowMs;
      return { x: this.displayX, y: this.displayY };
    }

    const dtSec = Math.max(0.001, Math.min((nowMs - this.lastSampleTimeMs) / 1000, 0.1));
    this.lastSampleTimeMs = nowMs;

    const alpha = 1 - Math.exp(-InteractionConfig.oneEuroFilter.followSpeed * dtSec);
    this.displayX += (this.targetX - this.displayX) * alpha;
    this.displayY += (this.targetY - this.displayY) * alpha;

    return { x: this.displayX, y: this.displayY };
  }

  /**
   * Convenience single-call method combining target update + immediate sample.
   */
  smooth(rawX: number, rawY: number, dtMs = 16.6667): { x: number; y: number } {
    const now = performance.now();
    this.updateTarget(rawX, rawY, now);
    const sampled = this.sample(now + dtMs * 0.001);
    return sampled ?? { x: rawX, y: rawY };
  }

  /**
   * Resets the filter state (e.g. when hand tracking is lost).
   */
  reset() {
    this.filterX.reset();
    this.filterY.reset();
    this.targetX = null;
    this.targetY = null;
    this.displayX = null;
    this.displayY = null;
    this.lastSampleTimeMs = null;
  }
}
